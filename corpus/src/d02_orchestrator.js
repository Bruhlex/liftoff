'use strict';
// d02: async job orchestrator — dependency graph, retries, cancellation tokens,
// virtual clock driven purely by microtasks (no timers).

const out = [];
const log = (...xs) => { const line = xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); out.push(line); console.log(line); };

// ------------------------------------------------------------------ virtual clock
class VirtualClock {
  #now = 0;
  #timers = [];
  #seq = 0;
  static FLUSH = 12;
  get now() { return this.#now; }
  delay(ticks, token) {
    return new Promise((resolve, reject) => {
      const t = { at: this.#now + Math.max(0, ticks), seq: this.#seq++, resolve, reject, dead: false };
      this.#timers.push(t);
      token?.onCancel((reason) => { if (!t.dead) { t.dead = true; reject(reason); } });
    });
  }
  get pending() { return this.#timers.filter((t) => !t.dead).length; }
  async flush() { for (let i = 0; i < VirtualClock.FLUSH; i++) await null; }
  async runUntilIdle(limit = 10000) {
    let steps = 0;
    await this.flush();
    while (this.pending && steps++ < limit) {
      this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#timers.find((t) => !t.dead);
      this.#now = next.at;
      const due = this.#timers.filter((t) => !t.dead && t.at <= this.#now);
      for (const t of due) { t.dead = true; t.resolve(this.#now); }
      this.#timers = this.#timers.filter((t) => !t.dead);
      await this.flush();
    }
    return steps;
  }
}

// ------------------------------------------------------------------ cancellation
class CancelledError extends Error {
  constructor(reason) { super(`cancelled: ${reason}`); this.reason = reason; }
  get [Symbol.toStringTag]() { return 'CancelledError'; }
}
class CancellationToken {
  #source;
  constructor(source) { this.#source = source; }
  get cancelled() { return this.#source.isCancelled; }
  get reason() { return this.#source.reasonText; }
  onCancel(fn) { return this.#source.subscribe(fn); }
  throwIfCancelled() { if (this.cancelled) throw new CancelledError(this.reason); }
  static get none() { return CancellationToken.#NONE ??= new CancellationSource().token; }
  static #NONE = null;
  static [Symbol.hasInstance](x) { return x != null && typeof x.throwIfCancelled === 'function' && typeof x.onCancel === 'function'; }
}
class CancellationSource {
  #subs = new Set();
  #reason = null;
  #token = new CancellationToken(this);
  get token() { return this.#token; }
  get isCancelled() { return this.#reason !== null; }
  get reasonText() { return this.#reason; }
  subscribe(fn) {
    if (this.#reason !== null) { fn(new CancelledError(this.#reason)); return () => {}; }
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }
  cancel(reason = 'requested') {
    if (this.#reason !== null) return false;
    this.#reason = reason;
    const err = new CancelledError(reason);
    for (const fn of [...this.#subs]) { try { fn(err); } catch { /* swallow */ } }
    this.#subs.clear();
    return true;
  }
  static link(...tokens) {
    const src = new CancellationSource();
    for (const t of tokens) t?.onCancel((e) => src.cancel(`linked(${e.reason})`));
    return src;
  }
}

// ------------------------------------------------------------------ jobs
let jobIdCounter = 0;
class Job {
  static #registry = new Map();
  static kinds;
  static {
    Job.kinds = Object.freeze({ compute: 'C', io: 'I', flaky: 'F', composite: 'X' });
  }
  #id;
  #attempts = 0;
  constructor(name, { deps = [], priority = 0, tags = [] } = {}) {
    if (new.target === Job) throw new TypeError('Job is abstract');
    this.#id = ++jobIdCounter;
    this.name = name;
    this.deps = [...deps];
    this.priority = priority;
    this.tags = new Set(tags);
    Job.#registry.set(name, this);
  }
  get id() { return this.#id; }
  get attempts() { return this.#attempts; }
  get kind() { return 'job'; }
  static lookup(name) { return Job.#registry.get(name); }
  static get size() { return Job.#registry.size; }
  static reset() { Job.#registry.clear(); jobIdCounter = 0; }
  async execute(ctx) {
    this.#attempts++;
    ctx.token.throwIfCancelled();
    return this.run(ctx);
  }
  // eslint-disable-next-line no-unused-vars
  async run(ctx) { throw new Error('not implemented'); }
  describe() { return `${this.kind}:${this.name}${this.deps.length ? '<-' + this.deps.join('+') : ''}`; }
}
class TimedJob extends Job {
  #cost;
  constructor(name, cost, opts) { super(name, opts); this.#cost = cost; }
  get cost() { return this.#cost; }
  get kind() { return 'timed'; }
  async spend(ctx, fraction = 1) {
    await ctx.clock.delay(Math.round(this.#cost * fraction), ctx.token);
  }
}
class ComputeJob extends TimedJob {
  #fn;
  constructor(name, cost, fn, opts) { super(name, cost, opts); this.#fn = fn; }
  get kind() { return `compute/${super.kind}`; }
  async run(ctx) {
    await this.spend(ctx, 0.5);
    const inputs = this.deps.map((d) => ctx.results.get(d));
    const r = this.#fn(...inputs);
    await this.spend(ctx, 0.5);
    return r;
  }
}
class FlakyJob extends ComputeJob {
  #failPattern;
  constructor(name, cost, fn, failPattern, opts) { super(name, cost, fn, opts); this.#failPattern = failPattern; }
  get kind() { return 'flaky/' + super.kind.split('/')[0]; }
  async run(ctx) {
    const willFail = this.#failPattern[(this.attempts - 1) % this.#failPattern.length] === 'x';
    if (willFail) {
      await this.spend(ctx, 0.25);
      throw Object.assign(new Error(`${this.name} transient failure #${this.attempts}`), { transient: true });
    }
    return super.run(ctx);
  }
}
class CompositeJob extends TimedJob {
  #steps;
  constructor(name, steps, opts) { super(name, steps.length, opts); this.#steps = steps; }
  get kind() { return 'composite'; }
  async run(ctx) {
    const collected = [];
    const it = this.#pipeline(ctx);
    try {
      for await (const v of it) {
        collected.push(v);
        if (v === 'STOP') break;
      }
    } finally {
      collected.push('#closed');
    }
    return collected;
  }
  async *#pipeline(ctx) {
    let i = 0;
    try {
      for (const step of this.#steps) {
        await ctx.clock.delay(1, ctx.token);
        yield typeof step === 'function' ? step(i++) : step;
      }
      return 'done';
    } finally {
      ctx.note(`${this.name}:pipeline-finally@${i}`);
    }
  }
}

// ------------------------------------------------------------------ dependency graph
class Graph {
  #nodes = new Map();
  add(job) {
    if (this.#nodes.has(job.name)) throw new Error(`duplicate ${job.name}`);
    this.#nodes.set(job.name, job);
    return this;
  }
  get(name) { return this.#nodes.get(name); }
  *[Symbol.iterator]() { yield* this.#nodes.values(); }
  get size() { return this.#nodes.size; }
  dependents(name) { return [...this].filter((j) => j.deps.includes(name)).map((j) => j.name); }
  validate() {
    const missing = [];
    for (const j of this) for (const d of j.deps) if (!this.#nodes.has(d)) missing.push(`${j.name}->${d}`);
    return missing;
  }
  topo() {
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map([...this.#nodes.keys()].map((k) => [k, WHITE]));
    const order = [];
    const stack = [];
    const visit = (name, path) => {
      switch (color.get(name)) {
        case BLACK: return;
        case GREY: throw Object.assign(new Error('cycle'), { cycle: [...path.slice(path.indexOf(name)), name] });
        case WHITE:
        default:
          color.set(name, GREY);
          for (const d of [...this.#nodes.get(name).deps].sort()) visit(d, [...path, name]);
          color.set(name, BLACK);
          order.push(name);
      }
    };
    for (const name of [...this.#nodes.keys()].sort()) { stack.push(name); visit(name, []); stack.pop(); }
    return order;
  }
  levels() {
    const lvl = new Map();
    for (const n of this.topo()) lvl.set(n, Math.max(-1, ...this.#nodes.get(n).deps.map((d) => lvl.get(d))) + 1);
    const byLevel = [];
    for (const [n, l] of lvl) (byLevel[l] ??= []).push(n);
    return byLevel;
  }
  criticalPath() {
    const best = new Map();
    for (const n of this.topo()) {
      const job = this.#nodes.get(n);
      let from = null, cost = 0;
      for (const d of job.deps) { const b = best.get(d); if (b.cost > cost || (b.cost === cost && from !== null && d < from)) [cost, from] = [b.cost, d]; }
      best.set(n, { cost: cost + (job.cost ?? 1), from });
    }
    let [end, top] = [null, -1];
    for (const [n, { cost }] of best) if (cost > top) [end, top] = [n, cost];
    const path = [];
    for (let n = end; n !== null; n = best.get(n).from) path.unshift(n);
    return { path, cost: top };
  }
}

// ------------------------------------------------------------------ event channel (async iterator)
class Channel {
  #buf = [];
  #waiters = [];
  #closed = false;
  push(v) {
    if (this.#closed) return false;
    const w = this.#waiters.shift();
    if (w) w({ value: v, done: false }); else this.#buf.push(v);
    return true;
  }
  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#buf.length) return Promise.resolve({ value: this.#buf.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.#waiters.push(r));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

// ------------------------------------------------------------------ orchestrator
const STATES = ['pending', 'ready', 'running', 'retrying', 'done', 'failed', 'skipped', 'cancelled'];
class Orchestrator {
  #graph;
  #clock;
  #concurrency;
  #maxRetries;
  #state = new Map();
  #results = new Map();
  #errors = new Map();
  #timeline = [];
  #notes = [];
  #running = 0;
  #peak = 0;
  events = new Channel();
  constructor(graph, { clock = new VirtualClock(), concurrency = 2, maxRetries = 2, backoff = (n) => 2 ** n } = {}) {
    this.#graph = graph;
    this.#clock = clock;
    this.#concurrency = concurrency;
    this.#maxRetries = maxRetries;
    this.backoff = backoff;
    for (const j of graph) this.#setState(j.name, 'pending');
  }
  get clock() { return this.#clock; }
  get peak() { return this.#peak; }
  get notes() { return [...this.#notes]; }
  #setState(name, s) {
    if (!STATES.includes(s)) throw new RangeError(s);
    const prev = this.#state.get(name);
    this.#state.set(name, s);
    if (prev !== undefined) this.#timeline.push(`${this.#clock.now}:${name}:${prev[0]}>${s[0]}`);
    this.events.push({ t: this.#clock.now, name, s });
  }
  #ready() {
    const out = [];
    for (const j of this.#graph) {
      if (this.#state.get(j.name) !== 'pending') continue;
      let ok = true;
      check: for (const d of j.deps) {
        switch (this.#state.get(d)) {
          case 'done': continue check;
          case 'failed':
          case 'skipped':
          case 'cancelled':
            this.#setState(j.name, 'skipped');
            this.#errors.set(j.name, `dep ${d} ${this.#state.get(d)}`);
            ok = false;
            break check;
          default:
            ok = false;
            break check;
        }
      }
      if (ok) out.push(j);
    }
    return out.sort((a, b) => b.priority - a.priority || (a.name < b.name ? -1 : 1));
  }
  async #runOne(job, token) {
    this.#running++;
    this.#peak = Math.max(this.#peak, this.#running);
    this.#setState(job.name, 'running');
    const ctx = { clock: this.#clock, token, results: this.#results, note: (s) => this.#notes.push(s) };
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await job.execute(ctx);
          this.#results.set(job.name, r);
          this.#setState(job.name, 'done');
          return r;
        } catch (e) {
          if (e instanceof CancelledError) { this.#setState(job.name, 'cancelled'); this.#errors.set(job.name, e.message); return undefined; }
          if (e.transient && attempt < this.#maxRetries) {
            this.#setState(job.name, 'retrying');
            await this.#clock.delay(this.backoff(attempt), token).catch((ce) => { throw ce; });
            continue;
          }
          this.#setState(job.name, 'failed');
          this.#errors.set(job.name, e.message);
          return undefined;
        }
      }
    } catch (outer) {
      this.#setState(job.name, 'cancelled');
      this.#errors.set(job.name, outer.message);
    } finally {
      this.#running--;
    }
  }
  async run(token = CancellationToken.none) {
    const inflight = new Map();
    const pump = () => {
      if (token.cancelled) {
        for (const j of this.#graph) if (this.#state.get(j.name) === 'pending') this.#setState(j.name, 'cancelled');
        return;
      }
      for (const j of this.#ready()) {
        if (this.#running >= this.#concurrency) break;
        const p = this.#runOne(j, token).then(() => { inflight.delete(j.name); pump(); });
        inflight.set(j.name, p);
      }
    };
    pump();
    const idle = this.#clock.runUntilIdle();
    while (inflight.size) await Promise.race(inflight.values());
    await idle;
    this.events.close();
    return this.summary();
  }
  summary() {
    const counts = {};
    for (const s of this.#state.values()) counts[s] = (counts[s] ?? 0) + 1;
    return { counts, results: Object.fromEntries(this.#results), errors: Object.fromEntries(this.#errors), end: this.#clock.now };
  }
  get timeline() { return this.#timeline.slice(); }
}

// ------------------------------------------------------------------ helpers
const replacer = (k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Set ? [...v].sort() : v instanceof Map ? Object.fromEntries(v) : v);
const show = (x) => JSON.stringify(x, replacer);
function fibBig(n) { let [a, b] = [0n, 1n]; while (n-- > 0) [a, b] = [b, a + b]; return a; }
function collatzLen(n) { let c = 0; for (; n !== 1; c++) n = n % 2 ? 3 * n + 1 : n / 2; return c; }

function buildPipeline(variant) {
  Job.reset();
  const g = new Graph();
  const add = (j) => (g.add(j), j);
  add(new ComputeJob('fetch', 3, () => [5, 3, 8, 1, 9, 2], { priority: 2, tags: ['io'] }));
  add(new ComputeJob('config', 1, () => ({ scale: 3, offset: -1 }), { priority: 5 }));
  add(new ComputeJob('parse', 2, (xs) => xs.map((x) => x * 2), { deps: ['fetch'] }));
  add(new FlakyJob('enrich', 2, (xs, { scale, offset } = {}) => xs.map((x) => x * scale + offset), variant.flaky, { deps: ['parse', 'config'] }));
  add(new ComputeJob('stats', 2, (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const [min, , ...rest] = sorted;
    return { min, max: rest.at(-1), sum: xs.reduce((a, b) => a + b, 0), median: sorted[sorted.length >> 1] };
  }, { deps: ['enrich'], tags: ['report'] }));
  add(new ComputeJob('bigfib', 4, (s) => String(fibBig(s.sum)), { deps: ['stats'] }));
  add(new ComputeJob('collatz', 3, (xs) => xs.map(collatzLen), { deps: ['parse'], priority: 1 }));
  add(new CompositeJob('report', [
    (i) => `step${i}`,
    'mid',
    ...(variant.stopEarly ? ['STOP'] : []),
    (i) => `step${i}`,
    'tail',
  ], { deps: ['stats', 'collatz'] }));
  if (variant.brokenDep) add(new ComputeJob('orphan', 1, () => 0, { deps: ['ghost'] }));
  if (variant.hardFail) add(new FlakyJob('doomed', 1, () => 1, 'xxxxx', { deps: ['config'] }));
  if (variant.hardFail) add(new ComputeJob('afterDoomed', 1, (d) => d + 1, { deps: ['doomed'] }));
  return g;
}

// ------------------------------------------------------------------ scenarios
async function scenario(label, variant, opts = {}) {
  log(`=== scenario ${label}`);
  const g = buildPipeline(variant);
  const missing = g.validate();
  if (missing.length) { log('  missing deps', missing); return null; }
  log('  topo', g.topo().join(' > '));
  log('  levels', g.levels());
  const cp = g.criticalPath();
  log(`  critical ${cp.path.join('->')} cost=${cp.cost}`);
  const clock = new VirtualClock();
  const orch = new Orchestrator(g, { clock, concurrency: opts.concurrency ?? 2, maxRetries: opts.maxRetries ?? 2 });
  const src = new CancellationSource();
  const evLog = [];
  const consumer = (async () => {
    let n = 0;
    for await (const { t, name, s } of orch.events) {
      n++;
      if (s === 'running' || s === 'done') evLog.push(`${name}@${t}`);
      if (opts.cancelAt !== undefined && t >= opts.cancelAt && !src.token.cancelled) src.cancel(`t>=${opts.cancelAt}`);
    }
    return n;
  })();
  const summary = await orch.run(src.token);
  const evCount = await consumer;
  log('  counts', summary.counts, 'end', summary.end, 'peak', orch.peak, 'events', evCount);
  log('  results', show(summary.results));
  if (Object.keys(summary.errors).length) log('  errors', summary.errors);
  log('  ev', evLog.join(' '));
  const tl = orch.timeline;
  for (let i = 0; i < tl.length; i += 8) log('  tl', tl.slice(i, i + 8).join(' '));
  if (orch.notes.length) log('  notes', orch.notes);
  return summary;
}

// ------------------------------------------------------------------ microtask ordering probes
async function orderingProbes() {
  log('=== ordering probes');
  const seq = [];
  const mk = (name, n) => (async () => { for (let i = 0; i < n; i++) { seq.push(`${name}${i}`); await null; } return name; })();
  const r = await Promise.all([mk('a', 3), mk('b', 2), mk('c', 4)]);
  log('  all', r, seq.join(','));
  seq.length = 0;
  const race = await Promise.race([mk('x', 3), mk('y', 1), mk('z', 2)]);
  log('  race', race, seq.join(','));
  const settled = await Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(new Error('nope')),
    (async () => { throw new TypeError('bad'); })(),
    new Promise((res) => res(Promise.resolve('nested'))),
  ]);
  log('  settled', settled.map((s) => (s.status === 'fulfilled' ? `ok:${s.value}` : `err:${s.reason.constructor === TypeError ? 'T' : 'E'}:${s.reason.message}`)).join(' '));
  try {
    await Promise.any([Promise.reject(new Error('e1')), Promise.reject(new Error('e2'))]);
  } catch (e) {
    log('  any-agg', e instanceof AggregateError, e.errors.map((x) => x.message));
  }
  const order = [];
  const p = Promise.resolve();
  p.then(() => order.push('then1')).then(() => order.push('then1b'));
  queueLike(() => order.push('q'));
  p.then(() => order.push('then2'));
  await null; await null; await null;
  log('  interleave', order.join(','));
}
function queueLike(fn) { Promise.resolve().then(fn); }

// ------------------------------------------------------------------ generator control probes
function* worker(id, token) {
  let processed = 0;
  try {
    while (true) {
      let job;
      try {
        job = yield { id, processed };
      } catch (e) {
        if (e instanceof CancelledError) return `w${id}:cancelled@${processed}`;
        yield { id, error: e.message };
        continue;
      }
      if (job === undefined) continue;
      if (token.cancelled) return `w${id}:token@${processed}`;
      processed += job;
    }
  } finally {
    log(`  worker ${id} finally processed=${processed}`);
  }
}
function* supervisor(tokens) {
  const results = [];
  for (const [i, t] of tokens.entries()) {
    const w = worker(i, t);
    w.next();
    const r = yield* delegateSome(w, i + 2);
    results.push(r);
  }
  return results;
}
function* delegateSome(w, n) {
  let last;
  for (let k = 0; k < n; k++) {
    const got = yield `feed${k}`;
    last = w.next(got ?? k).value;
  }
  const ret = w.return(`closed-after-${last.processed}`);
  return ret.value;
}
function generatorProbes() {
  log('=== generator probes');
  const s1 = new CancellationSource();
  const s2 = new CancellationSource();
  const sup = supervisor([s1.token, s2.token, CancellationToken.none]);
  const feeds = [];
  let r = sup.next();
  let i = 0;
  while (!r.done) { feeds.push(r.value); r = sup.next(i++ * 3); }
  log('  feeds', feeds.join(','), 'result', r.value);
  const w = worker(9, s1.token);
  w.next();
  log('  w9 step', w.next(4).value);
  log('  w9 throw', w.throw(new Error('boom')).value);
  log('  w9 after', w.next(5).value);
  log('  w9 cancel', w.throw(new CancelledError('stop')));
  log('  w9 done', w.next(1));
  const w2 = worker(10, s2.token);
  w2.next();
  w2.next(7);
  s2.cancel('manual');
  log('  w10 token', w2.next(1));
}

// ------------------------------------------------------------------ cancellation probes
async function cancellationProbes() {
  log('=== cancellation probes');
  const root = new CancellationSource();
  const child = CancellationSource.link(root.token);
  const grand = CancellationSource.link(child.token, CancellationToken.none);
  const seen = [];
  grand.token.onCancel((e) => seen.push(`grand:${e.reason}`));
  child.token.onCancel((e) => seen.push(`child:${e.reason}`));
  const unsub = root.token.onCancel(() => seen.push('root-unsubscribed?'));
  unsub();
  log('  instanceof token', grand.token instanceof CancellationToken, {} instanceof CancellationToken, { throwIfCancelled() {}, onCancel() {} } instanceof CancellationToken);
  root.cancel('shutdown');
  log('  cascade', seen, root.cancel('again'));
  const late = [];
  grand.token.onCancel((e) => late.push(e.message));
  log('  late subscriber', late);
  const clock = new VirtualClock();
  const src = new CancellationSource();
  const results = [];
  const tasks = [3, 6, 9].map((d) => clock.delay(d, src.token).then((t) => results.push(`ok${d}@${t}`), (e) => results.push(`x${d}:${e.reason}`)));
  const canceller = clock.delay(5).then(() => src.cancel('deadline'));
  await clock.runUntilIdle();
  await Promise.all([...tasks, canceller]);
  log('  delays', results.join(' '), 'now', clock.now, 'pending', clock.pending);
  try { src.token.throwIfCancelled(); } catch (e) { log('  throwIf', Object.prototype.toString.call(e), e.message); }
}

// ------------------------------------------------------------------ retry policy table
function retryTable() {
  log('=== retry policies');
  const policies = {
    exp: (n) => 2 ** n,
    lin: (n) => n + 1,
    fib: (n, memo = [1, 1]) => { for (let i = 2; i <= n; i++) memo[i] = memo[i - 1] + memo[i - 2]; return memo[n]; },
    capped: (n) => Math.min(5, 3 * n || 1),
  };
  for (const [name, f] of Object.entries(policies)) {
    const seq = Array.from({ length: 6 }, (_, i) => f(i));
    log(`  ${name.padEnd(7)}`, seq.join(' '), 'total', seq.reduce((a, b) => a + b));
  }
}

// ------------------------------------------------------------------ proxy-wrapped metrics
function metricsProbe() {
  log('=== metrics proxy');
  const hits = new Map();
  const target = { jobs: 0, retries: 0, nested: { depth: 1 } };
  const handler = {
    get(t, k, r) {
      if (typeof k === 'string') hits.set(k, (hits.get(k) ?? 0) + 1);
      const v = Reflect.get(t, k, r);
      return v && typeof v === 'object' ? new Proxy(v, handler) : v;
    },
    set(t, k, v, r) {
      if (typeof v === 'number' && v < 0) return false;
      return Reflect.set(t, k, v, r);
    },
    has(t, k) { return k.startsWith('_') ? false : Reflect.has(t, k); },
    deleteProperty(t, k) { hits.set(`del:${k}`, 1); return Reflect.deleteProperty(t, k); },
    ownKeys(t) { return Reflect.ownKeys(t).filter((k) => k !== 'secret'); },
  };
  const m = new Proxy(target, handler);
  m.jobs += 5;
  m.retries ||= 2;
  m.nested.depth **= 3;
  m.missing ??= 'dflt';
  m._hidden = 1;
  m.secret = 's';
  let refused = 'none';
  try { m.jobs = -1; } catch (e) { refused = e instanceof TypeError ? 'TypeError' : 'other'; }
  delete m.missing;
  log('  values', m.jobs, m.retries, m.nested.depth, '_hidden' in m, 'jobs' in m, refused);
  log('  keys', Object.keys(m), 'hits', [...hits].sort().map(([k, v]) => `${k}=${v}`).join(','));
}

// ------------------------------------------------------------------ main
(async function main() {
  generatorProbes();
  retryTable();
  metricsProbe();
  await orderingProbes();
  await cancellationProbes();
  const base = await scenario('happy', { flaky: '.' });
  await scenario('flaky-retry', { flaky: 'xx.' });
  await scenario('flaky-exhaust', { flaky: 'xxxx' }, { maxRetries: 1 });
  await scenario('stop-early+hardfail', { flaky: 'x.', stopEarly: true, hardFail: true }, { concurrency: 3 });
  await scenario('broken', { flaky: '.', brokenDep: true });
  await scenario('cancel-mid', { flaky: 'x.' }, { cancelAt: 6, concurrency: 1 });
  await scenario('wide', { flaky: '.', hardFail: true }, { concurrency: 8 });
  try {
    Job.reset();
    const g = new Graph();
    g.add(new ComputeJob('a', 1, () => 1, { deps: ['c'] })).add(new ComputeJob('b', 1, () => 1, { deps: ['a'] })).add(new ComputeJob('c', 1, () => 1, { deps: ['b'] }));
    g.topo();
  } catch (e) {
    log('=== cycle detected', e.message, e.cycle?.join('>'));
  }
  try { new Job('x'); } catch (e) { log('abstract', e.message); }
  log('registry size', Job.size, 'kinds', Object.values(Job.kinds).join(''));
  const digest = out.reduce((h, line) => { for (const ch of line) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; return h; }, 7);
  log('base results sum', base ? Object.keys(base.results).length : -1, 'lines', out.length, 'digest', (digest >>> 0).toString(16));
})().catch((e) => { console.log('FATAL', e && e.message); });
