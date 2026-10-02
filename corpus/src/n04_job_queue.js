'use strict';
// Job queue with a worker pool built from EventEmitter + an async concurrency limiter.
// All "work" is simulated with setImmediate ticks so the interleaving is deterministic.
const { EventEmitter, once } = require('events');
const { Readable, Transform, Writable, pipeline } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');

const pipelineAsync = promisify(pipeline);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function tick(n) {
  return new Promise((resolve) => {
    if (!n || n <= 0) { queueMicrotask(resolve); return; }
    let i = 0;
    const step = () => { if (++i >= n) resolve(); else setImmediate(step); };
    setImmediate(step);
  });
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

class Rng {
  #state;
  constructor(seed) { this.#state = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn; }
  nextU32() {
    this.#state = (this.#state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
    return Number(this.#state >> 33n);
  }
  int(lo, hi) { return lo + (this.nextU32() % (hi - lo + 1)); }
  pick(arr) { return arr[this.nextU32() % arr.length]; }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
class JobError extends Error {
  constructor(message, code) { super(message); this.code = code ?? 'EJOB'; }
  describe() { return `${this.code}: ${this.message}`; }
}
class RouteError extends JobError {
  constructor(type) { super(`no handler for "${type}"`, 'ENOROUTE'); this.type = type; }
}
class TransientError extends JobError {
  constructor(message) { super(message, 'ETRANSIENT'); }
}
class StateError extends JobError {
  constructor(from, to) { super(`illegal transition ${from} -> ${to}`, 'ESTATE'); }
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------
class Job {
  static #seq = 0;
  static PRIORITIES;
  static TRANSITIONS;
  static {
    Job.PRIORITIES = Object.freeze({ high: 0, normal: 1, low: 2 });
    Job.TRANSITIONS = Object.freeze({
      pending: ['queued', 'blocked', 'cancelled'],
      blocked: ['queued', 'cancelled'],
      queued: ['running', 'cancelled'],
      running: ['done', 'failed', 'queued'],
      done: [],
      failed: [],
      cancelled: [],
    });
  }
  #id; #attempts = 0; #state = 'pending'; #history = [];
  constructor(type, payload, opts = {}) {
    this.#id = ++Job.#seq;
    this.type = type;
    this.payload = payload;
    this.priority = Job.PRIORITIES[opts.priority ?? 'normal'] ?? 1;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.deps = opts.deps ?? [];
    this.cost = opts.cost ?? 1;
    this.label = opts.label ?? `${type}#${this.#id}`;
    this.result = undefined;
    this.error = null;
  }
  get id() { return this.#id; }
  get attempts() { return this.#attempts; }
  get state() { return this.#state; }
  get history() { return this.#history.join('>'); }
  get finished() { return ['done', 'failed', 'cancelled'].includes(this.#state); }
  transition(to) {
    const allowed = Job.TRANSITIONS[this.#state];
    if (!allowed.includes(to)) throw new StateError(this.#state, to);
    this.#history.push(to);
    this.#state = to;
  }
  recordAttempt() { return ++this.#attempts; }
  static resetSequence() { Job.#seq = 0; }
  toJSON() {
    return { id: this.#id, label: this.label, state: this.#state, attempts: this.#attempts, result: this.result ?? null };
  }
}

// ---------------------------------------------------------------------------
// binary heap priority queue
// ---------------------------------------------------------------------------
class MinHeap {
  #items = []; #cmp;
  constructor(cmp) { this.#cmp = cmp; }
  get size() { return this.#items.length; }
  push(v) {
    const a = this.#items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.#cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.#items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.#cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.#cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  *drain() { while (this.size) yield this.pop(); }
}

// ---------------------------------------------------------------------------
// concurrency limiter
// ---------------------------------------------------------------------------
class ConcurrencyLimiter {
  #max; #active = 0; #waiters = []; #peak = 0;
  constructor(max) { this.#max = max; }
  get active() { return this.#active; }
  get pending() { return this.#waiters.length; }
  get peak() { return this.#peak; }
  async run(fn) {
    await this.#acquire();
    try { return await fn(); } finally { this.#release(); }
  }
  #acquire() {
    if (this.#active < this.#max) {
      this.#active++;
      this.#peak = Math.max(this.#peak, this.#active);
      return Promise.resolve();
    }
    return new Promise((r) => this.#waiters.push(r));
  }
  #release() {
    const next = this.#waiters.shift();
    if (next) next(); else this.#active--;
  }
}

// ---------------------------------------------------------------------------
// handler registry with regex routing
// ---------------------------------------------------------------------------
class HandlerRegistry {
  #routes = [];
  add(pattern, fn) { this.#routes.push({ re: pattern, fn }); return this; }
  resolve(type) {
    for (const { re, fn } of this.#routes) {
      const m = re.exec(type);
      if (m) return { fn, params: { ...(m.groups ?? {}) } };
    }
    return null;
  }
  get count() { return this.#routes.length; }
}

function fibBig(n) {
  let a = 0n, b = 1n;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}
function factBig(n) { let r = 1n; for (let i = 2n; i <= BigInt(n); i++) r *= i; return r; }
function countPrimes(n) {
  const sieve = new Uint8Array(n + 1);
  let c = 0;
  for (let i = 2; i <= n; i++) {
    if (sieve[i]) continue;
    c++;
    for (let j = i * i; j <= n; j += i) sieve[j] = 1;
  }
  return c;
}

function buildRegistry() {
  const reg = new HandlerRegistry();
  reg.add(/^math\.(?<op>fib|fact|primes)$/, async (payload, { params }) => {
    switch (params.op) {
      case 'fib': return fibBig(payload.n).toString();
      case 'fact': { const s = factBig(payload.n).toString(); return s.length > 24 ? `${s.slice(0, 10)}..${s.slice(-6)}(${s.length}d)` : s; }
      case 'primes': return countPrimes(payload.n);
      default: throw new JobError('unreachable');
    }
  });
  reg.add(/^text\.(?<op>reverse|upper|words)$/, async (payload, { params, tick: t }) => {
    await t(1);
    const s = payload.text;
    if (params.op === 'reverse') return [...s].reverse().join('');
    if (params.op === 'upper') return s.toUpperCase();
    const counts = {};
    for (const w of s.toLowerCase().match(/[a-z]+/g) ?? []) counts[w] = (counts[w] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([w, c]) => `${w}:${c}`).join(',');
  });
  reg.add(/^hash\.(?<algo>sha1|sha256|md5)$/, async (payload, { params }) =>
    crypto.createHash(params.algo).update(payload.data).digest('hex').slice(0, 16));
  reg.add(/^buf\.pack$/, async (payload) => {
    const buf = Buffer.alloc(payload.values.length * 4);
    payload.values.forEach((v, i) => buf.writeUInt32BE(v >>> 0, i * 4));
    let sum = 0;
    for (let off = 0; off < buf.length; off += 4) sum = (sum + buf.readUInt32BE(off)) >>> 0;
    const head = buf.subarray(0, 8).toString('hex');
    return `${head}|sum=${sum}|len=${buf.length}`;
  });
  reg.add(/^flaky\.(?<name>\w+)$/, async (payload, { attempt, params }) => {
    if (attempt < payload.failUntil) throw new TransientError(`${params.name} not ready (attempt ${attempt})`);
    return `${params.name} ok after ${attempt}`;
  });
  reg.add(/^fatal\./, async () => { throw new JobError('boom', 'EFATAL'); });
  reg.add(/^sum\.deps$/, async (payload) => payload.values.reduce((a, b) => a + b, 0));
  return reg;
}

// ---------------------------------------------------------------------------
// worker pool
// ---------------------------------------------------------------------------
class WorkerPool extends EventEmitter {
  static DEFAULT_SIZE;
  static { WorkerPool.DEFAULT_SIZE = 3; }
  #workers = []; #queue; #blocked = []; #jobs = new Map(); #inflight = 0;
  #registry; #pumpScheduled = false; #closed = false; #drained = true;
  constructor(registry, size = WorkerPool.DEFAULT_SIZE) {
    super();
    this.#registry = registry;
    for (let i = 0; i < size; i++) this.#workers.push({ id: `w${i + 1}`, busy: false, processed: 0 });
    this.#queue = new MinHeap((a, b) => a.priority - b.priority || a.id - b.id);
  }
  get size() { return this.#workers.length; }
  get idle() { return this.#workers.filter((w) => !w.busy).length; }
  get queued() { return this.#queue.size; }
  get workerStats() { return this.#workers.map((w) => `${w.id}=${w.processed}`).join(' '); }
  job(id) { return this.#jobs.get(id); }
  submit(job) {
    if (this.#closed) throw new JobError('pool closed', 'ECLOSED');
    this.#drained = false;
    this.#jobs.set(job.id, job);
    this.emit('submit', job);
    this.#place(job);
    this.#schedulePump();
    return job;
  }
  #depsState(job) {
    let ready = true;
    for (const d of job.deps) {
      const dj = this.#jobs.get(d);
      if (!dj) return 'wait';
      if (dj.state === 'failed' || dj.state === 'cancelled') return 'broken';
      if (dj.state !== 'done') ready = false;
    }
    return ready ? 'ready' : 'wait';
  }
  #place(job) {
    const s = this.#depsState(job);
    if (s === 'ready') { job.transition('queued'); this.#queue.push(job); }
    else if (s === 'wait') { job.transition('blocked'); this.#blocked.push(job); this.emit('blocked', job); }
    else { job.transition('cancelled'); this.emit('cancelled', job, 'dependency failed'); }
  }
  #resolveBlocked() {
    let changed = true;
    while (changed) {
      changed = false;
      const still = [];
      for (const job of this.#blocked) {
        const s = this.#depsState(job);
        if (s === 'ready') { job.transition('queued'); this.#queue.push(job); changed = true; this.emit('unblocked', job); }
        else if (s === 'broken') { job.transition('cancelled'); changed = true; this.emit('cancelled', job, 'dependency failed'); }
        else still.push(job);
      }
      this.#blocked = still;
    }
  }
  #schedulePump() {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    process.nextTick(() => { this.#pumpScheduled = false; this.#pump(); });
  }
  #pump() {
    for (const w of this.#workers) {
      if (w.busy) continue;
      const job = this.#queue.pop();
      if (!job) break;
      this.#execute(w, job);
    }
    this.#checkDrain();
  }
  #checkDrain() {
    if (this.#drained || this.#inflight > 0 || this.#queue.size > 0) return;
    for (const job of this.#blocked) { job.transition('cancelled'); this.emit('cancelled', job, 'orphaned'); }
    this.#blocked = [];
    this.#drained = true;
    this.emit('drain');
  }
  async #execute(worker, job) {
    worker.busy = true;
    this.#inflight++;
    job.transition('running');
    const attempt = job.recordAttempt();
    this.emit('start', job, worker.id, attempt);
    const route = this.#registry.resolve(job.type);
    let retry = false;
    try {
      if (!route) throw new RouteError(job.type);
      await tick(job.cost);
      job.result = await route.fn(job.payload, { attempt, params: route.params, tick });
      job.transition('done');
      worker.processed++;
      this.emit('done', job, worker.id);
    } catch (err) {
      job.error = err;
      if (err instanceof TransientError && attempt < job.maxAttempts) {
        retry = true;
        this.emit('retry', job, worker.id, err);
      } else {
        job.transition('failed');
        this.emit('failed', job, worker.id, err);
        if (err instanceof RouteError && this.listenerCount('error') > 0) this.emit('error', err);
      }
    } finally {
      worker.busy = false;
    }
    if (retry) {
      await tick(attempt * 2);
      job.transition('queued');
      this.#queue.push(job);
    }
    this.#inflight--;
    this.#resolveBlocked();
    this.#schedulePump();
  }
  close() { this.#closed = true; this.emit('close'); }
}

// ---------------------------------------------------------------------------
// statistics via Proxy (missing counters read as 0)
// ---------------------------------------------------------------------------
function makeCounters() {
  const store = {};
  return new Proxy(store, {
    get(target, key) { return typeof key === 'string' ? (target[key] ?? 0) : undefined; },
    set(target, key, value) { target[key] = value; return true; },
    ownKeys(target) { return Reflect.ownKeys(target).sort(); },
  });
}

function attachLogger(pool, counters, lines) {
  pool.on('submit', (job) => { counters.submitted++; });
  pool.on('start', (job, wid, attempt) => { counters.started++; lines.push(`[${wid}] start ${job.label}${attempt > 1 ? ` (attempt ${attempt})` : ''}`); });
  pool.on('done', (job, wid) => { counters.done++; lines.push(`[${wid}] done  ${job.label} => ${JSON.stringify(job.result)}`); });
  pool.on('retry', (job, wid, err) => { counters.retried++; lines.push(`[${wid}] retry ${job.label}: ${err.describe()}`); });
  pool.on('failed', (job, wid, err) => { counters.failed++; lines.push(`[${wid}] FAIL  ${job.label}: ${err.describe?.() ?? err.message}`); });
  pool.on('blocked', (job) => { counters.blocked++; lines.push(`[--] blocked ${job.label} on ${job.deps.join(',')}`); });
  pool.on('unblocked', (job) => { lines.push(`[--] unblocked ${job.label}`); });
  pool.on('cancelled', (job, why) => { counters.cancelled++; lines.push(`[--] cancel ${job.label}: ${why}`); });
}

function flush(lines) { for (const l of lines.splice(0)) console.log(l); }

// ---------------------------------------------------------------------------
// scenario 1: static batch with priorities, retries and failures
// ---------------------------------------------------------------------------
async function scenarioBatch(registry) {
  console.log('== scenario 1: batch ==');
  const pool = new WorkerPool(registry, 3);
  const counters = makeCounters();
  const lines = [];
  attachLogger(pool, counters, lines);
  const specs = [
    ['math.fib', { n: 50 }, { priority: 'low', cost: 3 }],
    ['math.fact', { n: 30 }, { cost: 2 }],
    ['text.words', { text: 'the cat and the hat and the bat' }, { priority: 'high' }],
    ['hash.sha256', { data: 'hello world' }, {}],
    ['flaky.net', { failUntil: 3 }, { priority: 'high', maxAttempts: 4 }],
    ['flaky.disk', { failUntil: 5 }, { maxAttempts: 2 }],
    ['fatal.explode', {}, { priority: 'low' }],
    ['buf.pack', { values: [1, 2, 0xdeadbeef, 0xffffffff, 42] }, {}],
    ['math.primes', { n: 10000 }, { cost: 4 }],
    ['text.reverse', { text: 'stressed desserts' }, { priority: 'high' }],
  ];
  const jobs = specs.map(([t, p, o]) => pool.submit(new Job(t, p, o)));
  await once(pool, 'drain');
  flush(lines);
  for (const j of jobs) console.log(`  ${pad(j.label, 18)} ${pad(j.state, 9)} tries=${j.attempts} path=${j.history}`);
  console.log(`  counters: ${JSON.stringify(Object.fromEntries(Object.keys(counters).map((k) => [k, counters[k]])))}`);
  console.log(`  never-set counter reads as ${counters.nonexistent}`);
  console.log(`  workers: ${pool.workerStats}`);
  pool.close();
}

// ---------------------------------------------------------------------------
// scenario 2: async generator job source consumed with for await
// ---------------------------------------------------------------------------
const KINDS = ['math.fib', 'math.primes', 'hash.md5', 'hash.sha1', 'text.upper', 'buf.pack'];

function makeRandomJob(rng) {
  const kind = rng.pick(KINDS);
  switch (kind) {
    case 'math.fib': return new Job(kind, { n: rng.int(10, 90) }, { cost: rng.int(1, 4) });
    case 'math.primes': return new Job(kind, { n: rng.int(100, 5000) }, { cost: rng.int(1, 4) });
    case 'hash.md5':
    case 'hash.sha1': return new Job(kind, { data: `payload-${rng.int(0, 999)}` }, { priority: rng.pick(['high', 'normal', 'low']) });
    case 'text.upper': return new Job(kind, { text: `msg ${rng.int(0, 99)} ok` }, {});
    default: return new Job(kind, { values: [rng.nextU32(), rng.nextU32(), rng.int(0, 9)] }, { cost: 2 });
  }
}

async function* jobSource(rng, count) {
  for (let i = 0; i < count; i++) {
    await tick(1);
    yield makeRandomJob(rng);
  }
}

async function scenarioGenerator(registry) {
  console.log('== scenario 2: async generator source ==');
  const pool = new WorkerPool(registry, 2);
  const counters = makeCounters();
  const lines = [];
  attachLogger(pool, counters, lines);
  const rng = new Rng(20240229);
  const submitted = [];
  for await (const job of jobSource(rng, 12)) submitted.push(pool.submit(job));
  await once(pool, 'drain');
  flush(lines);
  const byKind = {};
  for (const j of submitted) (byKind[j.type] ??= []).push(j.id);
  for (const k of Object.keys(byKind).sort()) console.log(`  ${pad(k, 12)} ids=${byKind[k].join(',')}`);
  console.log(`  done=${counters.done} failed=${counters.failed} workers: ${pool.workerStats}`);
}

// ---------------------------------------------------------------------------
// scenario 3: stream pipeline of textual job specs
// ---------------------------------------------------------------------------
class JobSpecParser extends Transform {
  #lineNo = 0; #rejected = [];
  constructor() { super({ objectMode: true }); }
  get rejected() { return this.#rejected; }
  _transform(line, _enc, cb) {
    this.#lineNo++;
    const text = String(line).trim();
    if (!text || text.startsWith('#')) return cb();
    const m = /^(?<type>[a-z]+\.[a-z0-9]+)\s+(?<arg>\S+)(?:\s+(?<prio>high|normal|low))?$/.exec(text);
    if (!m) { this.#rejected.push(this.#lineNo); return cb(); }
    const { type, arg, prio = 'normal' } = m.groups;
    let payload;
    if (/^\d+$/.test(arg)) payload = { n: Number(arg), failUntil: Number(arg), values: [Number(arg)] };
    else payload = { text: arg.replace(/_/g, ' '), data: arg };
    cb(null, new Job(type, payload, { priority: prio, maxAttempts: 3 }));
  }
}

class PoolSink extends Writable {
  constructor(pool) { super({ objectMode: true }); this.pool = pool; this.accepted = []; }
  _write(job, _enc, cb) { this.accepted.push(this.pool.submit(job)); setImmediate(cb); }
}

async function scenarioStream(registry) {
  console.log('== scenario 3: stream pipeline ==');
  const pool = new WorkerPool(registry, 3);
  const counters = makeCounters();
  const lines = [];
  attachLogger(pool, counters, lines);
  let routeErrors = 0;
  pool.on('error', (err) => { routeErrors++; lines.push(`[!!] pool error ${err.code} ${err.type}`); });
  const spec = [
    '# job spec file',
    'math.fib 30 high',
    'text.words the_quick_fox_the_lazy_dog_the_end',
    'hash.sha1 abc low',
    'unknown.kind 7',
    'this line is garbage!',
    'flaky.cache 2 high',
    'math.primes 2000',
    '',
    'text.upper shout_this normal',
  ];
  const parser = new JobSpecParser();
  const sink = new PoolSink(pool);
  await pipelineAsync(Readable.from(spec), parser, sink);
  console.log(`  parsed ${sink.accepted.length} jobs, rejected lines ${JSON.stringify(parser.rejected)}`);
  if (pool.queued || !sink.accepted.every((j) => j.finished)) await once(pool, 'drain');
  flush(lines);
  console.log(`  route errors=${routeErrors} done=${counters.done} failed=${counters.failed}`);
}

// ---------------------------------------------------------------------------
// scenario 4: DAG with dependencies and cascading cancellation
// ---------------------------------------------------------------------------
async function scenarioDag(registry) {
  console.log('== scenario 4: dependency DAG ==');
  const pool = new WorkerPool(registry, 2);
  const counters = makeCounters();
  const lines = [];
  attachLogger(pool, counters, lines);
  const a = new Job('math.fib', { n: 20 }, { label: 'A', cost: 2 });
  const b = new Job('math.primes', { n: 100 }, { label: 'B', cost: 3 });
  const bad = new Job('fatal.x', {}, { label: 'BAD' });
  const c = new Job('sum.deps', { values: [] }, { label: 'C', deps: [a.id, b.id] });
  const d = new Job('text.reverse', { text: 'dag' }, { label: 'D', deps: [c.id] });
  const e = new Job('text.upper', { text: 'never' }, { label: 'E', deps: [bad.id] });
  const f = new Job('text.upper', { text: 'also never' }, { label: 'F', deps: [e.id, d.id] });
  // submit dependents first so they start blocked
  for (const j of [f, d, e, c, a, b, bad]) pool.submit(j);
  // payload for C is filled in when its deps finish
  pool.on('unblocked', (job) => {
    if (job === c) c.payload.values = [Number(a.result), b.result];
  });
  await once(pool, 'drain');
  flush(lines);
  const order = [a, b, bad, c, d, e, f].map((j) => `${j.label}:${j.state}`).join(' ');
  console.log(`  final: ${order}`);
  console.log(`  C result=${c.result} D result=${d.result}`);
}

// ---------------------------------------------------------------------------
// scenario 5: raw limiter usage, closures in loops, error emitter semantics
// ---------------------------------------------------------------------------
async function scenarioLimiter() {
  console.log('== scenario 5: limiter + closures ==');
  const limiter = new ConcurrencyLimiter(2);
  const trace = [];
  const tasks = [];
  for (let i = 0; i < 6; i++) {
    const cost = (i * 7) % 4 + 1;
    tasks.push(() => limiter.run(async () => {
      trace.push(`+${i}(a${limiter.active})`);
      await tick(cost);
      trace.push(`-${i}`);
      if (i === 4) throw new JobError(`task ${i} rejected`, 'ELIMIT');
      return i * i;
    }));
  }
  const settled = await Promise.allSettled(tasks.map((t) => t()));
  console.log(`  trace: ${trace.join(' ')}`);
  console.log(`  results: ${settled.map((s) => (s.status === 'fulfilled' ? s.value : `err(${s.reason.code})`)).join(',')}`);
  console.log(`  peak concurrency=${limiter.peak} active now=${limiter.active} pending=${limiter.pending}`);

  const em = new EventEmitter();
  try { em.emit('error', new JobError('unhandled on bare emitter', 'EBARE')); } catch (err) { console.log(`  caught thrown emitter error: ${err.code}`); }
  const p = once(em, 'ready');
  process.nextTick(() => em.emit('error', new JobError('once rejects', 'EONCE')));
  try { await p; } catch (err) { console.log(`  once() rejected with ${err.code}`); }
  const q = once(em, 'ready');
  process.nextTick(() => em.emit('ready', 1, 2, 3));
  const args = await q;
  console.log(`  once() resolved with ${JSON.stringify(args)}`);
}

// ---------------------------------------------------------------------------
// scenario 6: result analysis with generators and labeled loops
// ---------------------------------------------------------------------------
function* chunked(arr, n) { for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n); }
function* fibNumbers() { let [x, y] = [1, 2]; for (;;) { yield x; [x, y] = [y, x + y]; } }

async function scenarioAnalysis(registry) {
  console.log('== scenario 6: analysis ==');
  const pool = new WorkerPool(registry, 4);
  const jobs = [];
  for (const n of [12, 25, 37, 50, 63, 75, 88, 99]) jobs.push(pool.submit(new Job('math.primes', { n: n * 10 }, { cost: n % 3 + 1 })));
  await once(pool, 'drain');
  const results = jobs.map((j) => j.result);
  let batchNo = 0;
  for (const batch of chunked(results, 3)) console.log(`  batch ${++batchNo}: ${batch.join(' ')} sum=${batch.reduce((a, b) => a + b, 0)}`);
  let found = null;
  outer: for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if ((results[i] + results[j]) % 10 === 0) { found = [i, j]; break outer; }
      if (results[j] - results[i] > 100) continue outer;
    }
  }
  console.log(`  first pair summing to multiple of 10: ${JSON.stringify(found)}`);
  const fibs = [];
  for (const f of fibNumbers()) { if (f > 200) break; if (results.includes(f)) fibs.push(f); fibs.length; }
  console.log(`  prime counts that are fibonacci: ${JSON.stringify(fibs)}`);
  const hist = new Map();
  for (const r of results) { const bucket = Math.floor(r / 50) * 50; hist.set(bucket, (hist.get(bucket) ?? 0) + 1); }
  for (const [k, v] of [...hist].sort((x, y) => x[0] - y[0])) console.log(`  ${lpad(k, 4)}+ ${'#'.repeat(v)}`);
  const digest = crypto.createHmac('sha256', 'pool-key').update(JSON.stringify(jobs)).digest('hex');
  console.log(`  results hmac=${digest.slice(0, 32)}`);
  const { id: firstId, state: firstState, ...rest } = jobs[0].toJSON();
  console.log(`  first job id=${firstId} state=${firstState} rest=${JSON.stringify(rest)}`);
  console.log(`  missing job lookup: ${pool.job(99999)?.label ?? 'none'}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const registry = buildRegistry();
  console.log(`registry has ${registry.count} routes`);
  try {
    const j = new Job('x.y', {});
    j.transition('done');
  } catch (err) {
    console.log(`state guard: ${err.describe()}`);
  }
  Job.resetSequence();
  await scenarioBatch(registry);
  await scenarioGenerator(registry);
  await scenarioStream(registry);
  await scenarioDag(registry);
  await scenarioLimiter();
  await scenarioAnalysis(registry);
  const closed = new WorkerPool(registry, 1);
  closed.close();
  try { closed.submit(new Job('text.upper', { text: 'x' })); } catch (err) { console.log(`closed pool: ${err.describe()}`); }
}

process.on('exit', (code) => { console.log(`exit code ${code}`); });
main().catch((err) => { console.log(`fatal: ${err.message}`); process.exitCode = 1; });
