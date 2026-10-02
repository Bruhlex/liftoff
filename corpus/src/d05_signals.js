// d05_signals.js - reactive signals / computed / effects with batching, glitch-free
// pull evaluation, cycle detection, reactive Proxy stores, async resources and a tiny spreadsheet.

const EFFECT_QUEUE = new Set();
const computeStack = [];
let batchDepth = 0;
let flushing = false;
let currentObserver = null;
let globalVersion = 0;
const stats = { writes: 0, flushes: 0, rounds: 0, errors: [] };

class CycleError extends Error {
  constructor(path) {
    super('cycle: ' + path.join(' -> '));
    this.name = 'CycleError';
    this.path = path;
  }
}
class ReactiveWriteError extends Error {
  get name() { return 'ReactiveWriteError'; }
}

// marker class: duck-typed instanceof for anything reactive
class Reactive {
  static [Symbol.hasInstance](x) {
    return x != null && typeof x === 'object' && typeof x.id === 'number' && x.observers instanceof Set;
  }
}

class ReactiveNode {
  static #nextId = 0;
  static KIND = 'node';
  #id;
  observers = new Set();
  version = 0;
  constructor(label) {
    if (new.target === ReactiveNode) throw new TypeError('ReactiveNode is abstract');
    this.#id = ++ReactiveNode.#nextId;
    this.label = label ?? `${new.target.KIND}${this.#id}`;
  }
  get id() { return this.#id; }
  static get count() { return ReactiveNode.#nextId; }
  *dependents(depth = Infinity, seen = new Set()) {
    if (depth <= 0) return 0;
    let n = 0;
    for (const o of [...this.observers].sort((a, b) => a.id - b.id)) {
      if (seen.has(o)) continue;
      seen.add(o);
      yield [depth, o.label];
      n += 1 + (yield* o.dependents(depth - 1, seen));
    }
    return n;
  }
}

class Producer extends ReactiveNode {
  static { this.KIND = 'prod'; }
  [Symbol.toPrimitive](hint) {
    const v = this.peek();
    if (hint === 'string') return `${this.label}=${JSON.stringify(v)}`;
    return typeof v === 'number' ? v : NaN;
  }
}

function track(node) {
  if (currentObserver && currentObserver !== node) {
    currentObserver.sources.set(node, node.version);
    node.observers.add(currentObserver);
  }
}

function markDownstream(root) {
  const stack = [root];
  const visited = new Set();
  walk: while (stack.length) {
    const node = stack.pop();
    for (const o of node.observers) {
      if (visited.has(o)) continue;
      visited.add(o);
      if (o instanceof Effect) { EFFECT_QUEUE.add(o); continue; }
      if (o instanceof Computed) stack.push(o);
      else break walk;
    }
  }
  return visited.size;
}

class Signal extends Producer {
  static { this.KIND = 'sig'; }
  #value;
  #equals;
  constructor(value, { label, equals = Object.is } = {}) {
    super(label);
    this.#value = value;
    this.#equals = equals;
  }
  get value() { track(this); return this.#value; }
  set value(v) { this.set(v); }
  peek() { return this.#value; }
  set(v) {
    const top = computeStack[computeStack.length - 1];
    if (top && !(top instanceof Effect)) throw new ReactiveWriteError(`write to ${this.label} inside ${top.label}`);
    if (this.#equals(this.#value, v)) return false;
    this.#value = v;
    this.version++;
    globalVersion++;
    stats.writes++;
    markDownstream(this);
    maybeFlush();
    return true;
  }
  update(fn) { return this.set(fn(this.#value)); }
}

class Computed extends Producer {
  static { this.KIND = 'comp'; }
  #fn;
  #value;
  #state = 'dirty';
  #seen = -1;
  #equals;
  #error = null;
  sources = new Map();
  evaluations = 0;
  constructor(fn, opts = {}) {
    super(opts.label);
    this.#fn = fn;
    this.#equals = opts.equals ?? Object.is;
  }
  get value() {
    this.refresh();
    track(this);
    if (this.#error) throw this.#error;
    return this.#value;
  }
  get error() { return this.#error; }
  get state() { return this.#state; }
  peek() {
    try { this.refresh(); } catch (e) { if (!(e instanceof CycleError)) throw e; }
    return this.#value;
  }
  #needsRecompute() {
    if (this.#state === 'dirty') return true;
    for (const [src, ver] of this.sources) {
      if (src instanceof Computed) src.refresh();
      if (src.version !== ver) return true;
    }
    return false;
  }
  refresh() {
    if (this.#state === 'computing') throw new CycleError([...computeStack.map((n) => n.label), this.label]);
    const at = globalVersion;
    if (this.#seen === at) return false;
    if (!this.#needsRecompute()) { this.#seen = at; return false; }
    this.#recompute();
    this.#seen = at;
    return true;
  }
  #recompute() {
    for (const src of this.sources.keys()) src.observers.delete(this);
    this.sources.clear();
    const prevObserver = currentObserver;
    currentObserver = this;
    this.#state = 'computing';
    computeStack.push(this);
    this.evaluations++;
    let next, err = null;
    try {
      next = this.run(this.#fn, this.#value);
    } catch (e) {
      err = e;
    } finally {
      computeStack.pop();
      currentObserver = prevObserver;
      this.#state = 'clean';
    }
    if (err instanceof CycleError) { this.#state = 'dirty'; throw err; }
    const changed = err ? true : !(this.#error === null && this.#equals(this.#value, next));
    this.#error = err;
    if (!err) this.#value = next;
    if (changed) this.version++;
  }
  run(fn, prev) { return fn(prev); }
}

class Effect extends Computed {
  static { this.KIND = 'fx'; }
  #cleanups = [];
  #children = [];
  #disposed = false;
  runs = 0;
  constructor(fn, opts = {}) {
    super(fn, opts);
    if (currentObserver instanceof Effect) currentObserver.#children.push(this);
    EFFECT_QUEUE.add(this);
    maybeFlush();
  }
  run(fn, prev) {
    this.#flushCleanups();
    this.runs++;
    const onCleanup = (c) => void this.#cleanups.push(c);
    const ret = super.run((p) => fn.call(this, onCleanup, p), prev);
    if (typeof ret === 'function') this.#cleanups.push(ret);
    return this.runs;
  }
  #flushCleanups() {
    for (const child of this.#children.splice(0)) child.dispose();
    const list = this.#cleanups.splice(0).reverse();
    for (const c of list) {
      try { c(); } catch (e) { stats.errors.push(`cleanup(${this.label}): ${e.message}`); }
    }
  }
  dispose() {
    if (this.#disposed) return false;
    this.#disposed = true;
    this.#flushCleanups();
    for (const s of this.sources.keys()) s.observers.delete(this);
    this.sources.clear();
    EFFECT_QUEUE.delete(this);
    return true;
  }
  get disposed() { return this.#disposed; }
  static isEffect(x) { return x != null && typeof x === 'object' && #children in x; }
  execute() {
    if (this.#disposed) return false;
    const ran = this.refresh();
    if (ran && this.error) stats.errors.push(`effect(${this.label}): ${this.error.message}`);
    return ran;
  }
}

function maybeFlush() { if (batchDepth === 0 && !flushing) flush(); }
function flush() {
  flushing = true;
  stats.flushes++;
  let rounds = 0;
  try {
    while (EFFECT_QUEUE.size) {
      if (++rounds > 25) {
        const stuck = [...EFFECT_QUEUE].map((e) => e.label).join(',');
        EFFECT_QUEUE.clear();
        throw new Error('effect loop limit: ' + stuck);
      }
      stats.rounds++;
      const list = [...EFFECT_QUEUE].sort((a, b) => a.id - b.id);
      EFFECT_QUEUE.clear();
      for (const fx of list) {
        if (fx.disposed) continue;
        fx.execute();
      }
    }
  } finally {
    flushing = false;
  }
}
function batch(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}
function untrack(fn) {
  const prev = currentObserver;
  currentObserver = null;
  try { return fn(); } finally { currentObserver = prev; }
}
const signal = (v, o) => new Signal(v, o);
const computed = (f, o) => new Computed(f, o);
const effect = (f, o) => new Effect(f, o);

// sloppy helper using arguments
function signalsOf() {
  return Array.prototype.map.call(arguments, (v, i) => signal(v, { label: 'arg' + i }));
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// ---- reactive store via Proxy ----
const RAW = Symbol('raw');
const ITERATE = Symbol('iterate');
const storeSignals = new WeakMap();
const proxyCache = new WeakMap();
const inc = (n) => n + 1;
function sigFor(target, key) {
  let m = storeSignals.get(target);
  if (!m) storeSignals.set(target, (m = new Map()));
  let s = m.get(key);
  if (!s) m.set(key, (s = signal(0, { label: 'store.' + String(key) })));
  return s;
}
function reactive(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (proxyCache.has(obj)) return proxyCache.get(obj);
  const p = new Proxy(obj, {
    get(t, k, r) {
      if (k === RAW) return t;
      if (typeof k !== 'symbol') sigFor(t, k).value;
      return reactive(Reflect.get(t, k, r));
    },
    set(t, k, v, r) {
      const had = Object.prototype.hasOwnProperty.call(t, k);
      const old = t[k];
      const raw = v?.[RAW] ?? v;
      const ok = Reflect.set(t, k, raw, r);
      if (!had || !Object.is(old, raw)) {
        batch(() => {
          sigFor(t, k).update(inc);
          if (!had) sigFor(t, ITERATE).update(inc);
        });
      }
      return ok;
    },
    has(t, k) { if (typeof k !== 'symbol') sigFor(t, k).value; return Reflect.has(t, k); },
    deleteProperty(t, k) {
      const had = Object.prototype.hasOwnProperty.call(t, k);
      const ok = Reflect.deleteProperty(t, k);
      if (had) batch(() => { sigFor(t, k).update(inc); sigFor(t, ITERATE).update(inc); });
      return ok;
    },
    ownKeys(t) { sigFor(t, ITERATE).value; return Reflect.ownKeys(t); },
  });
  proxyCache.set(obj, p);
  return p;
}

// ---- async resource ----
function resource(source, fetcher, label = 'res') {
  const state = signal('idle', { label: label + '.state' });
  const data = signal(undefined, { label: label + '.data' });
  const error = signal(null, { label: label + '.error' });
  let token = 0;
  const inflight = [];
  const fx = effect(() => {
    const input = source.value;
    const my = ++token;
    untrack(() => state.set('loading'));
    const p = Promise.resolve()
      .then(() => fetcher(input))
      .then(
        (v) => {
          if (my !== token) return `stale(${input})`;
          batch(() => { data.set(v); error.set(null); state.set('ready'); });
          return `ok(${input})`;
        },
        (e) => {
          if (my !== token) return `stale!(${input})`;
          batch(() => { error.set(e.message); state.set('error'); });
          return `err(${input})`;
        },
      );
    inflight.push(p);
  }, { label: label + '.fx' });
  return { state, data, error, fx, settle: () => Promise.all(inflight.splice(0)) };
}

async function* changes(sig, count) {
  const queue = [];
  let wake = null;
  const fx = effect(() => {
    queue.push(sig.value);
    if (wake) { const w = wake; wake = null; w(); }
  }, { label: 'changes.' + sig.label });
  try {
    while (count-- > 0) {
      while (!queue.length) await new Promise((r) => (wake = r));
      yield queue.shift();
    }
    return 'exhausted';
  } finally {
    fx.dispose();
    console.log('  changes generator finalized, fx disposed:', fx.disposed);
  }
}

// ---- spreadsheet on top of computeds ----
const CELL_RE = /(?<col>[A-Z])(?<row>\d+)/gu;
class Sheet {
  #cells = new Map();
  #formulas = new Map();
  static #sheets = 0;
  static { Sheet.#sheets = 0; }
  constructor(name) { this.name = name; Sheet.#sheets++; }
  static get sheets() { return Sheet.#sheets; }
  #cell(ref) {
    let c = this.#cells.get(ref);
    if (!c) {
      const input = signal(0, { label: ref + '.in' });
      const self = this;
      const out = computed(function () {
        const f = self.#formulas.get(ref);
        if (f == null) return input.value;
        return self.#evaluate(f);
      }, { label: ref });
      this.#cells.set(ref, (c = { input, out }));
    }
    return c;
  }
  #evaluate(formula) {
    const expr = formula.slice(1).replace(CELL_RE, (_, col, row) => `(${this.get(col + row)})`);
    if (!/^[\d\s+\-*/().]*$/.test(expr)) throw new SyntaxError('bad formula ' + formula);
    return evalArith(expr);
  }
  set(ref, v) {
    const c = this.#cell(ref);
    if (typeof v === 'string' && v.startsWith('=')) {
      this.#formulas.set(ref, v);
      globalVersion++;
      c.out.observers.forEach((o) => o instanceof Effect && EFFECT_QUEUE.add(o));
      c.input.update(inc);
    } else {
      this.#formulas.delete(ref);
      c.input.set(v);
    }
    return this;
  }
  get(ref) {
    const v = this.#cell(ref).out.value;
    return v;
  }
  *[Symbol.iterator]() {
    for (const ref of [...this.#cells.keys()].sort()) yield [ref, this.#cells.get(ref).out];
  }
}

// small recursive-descent arithmetic evaluator (no eval)
function evalArith(src) {
  const toks = src.match(/\d+(?:\.\d+)?|[-+*/()]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = toks[i++] === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') v = toks[i++] === '*' ? v * factor() : v / factor();
    return v;
  }
  function factor() {
    const t = toks[i++];
    switch (t) {
      case '-': return -factor();
      case '(': { const v = expr(); if (toks[i++] !== ')') throw new SyntaxError('missing )'); return v; }
      case undefined: throw new SyntaxError('unexpected end');
      default:
        if (/^\d/.test(t)) return parseFloat(t);
        throw new SyntaxError('unexpected ' + t);
    }
  }
  const v = expr();
  if (i !== toks.length) throw new SyntaxError('trailing ' + toks[i]);
  return v;
}

function fmt(strings, ...vals) {
  return strings.raw.reduce((acc, s, i) => {
    const v = vals[i - 1];
    const shown = v instanceof Reactive ? `<${v.label}:${JSON.stringify(v.peek())}>` : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return acc + shown + s;
  });
}

function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
function isOdd(n) { return n === 0 ? false : isEven(n - 1); }

function demoBasics() {
  console.log('== basics ==');
  const count = signal(1, { label: 'count' });
  const double = computed(() => count.value * 2, { label: 'double' });
  const seen = [];
  const fx = effect(() => { seen.push(double.value); }, { label: 'logDouble' });
  count.value = 2;
  count.set(2);
  count.update((n) => n + 5);
  console.log(fmt`count ${count} double ${double} seen ${seen} runs ${fx.runs} evals ${double.evaluations}`);
  console.log('primitive', +count, `${double}`, count + 1);
  const [a, b, c = signal(99)] = signalsOf(10, 20);
  console.log('signalsOf', a.peek(), b.peek(), c.peek(), a instanceof Reactive, {} instanceof Reactive, Effect.isEffect(fx), Effect.isEffect(a));
  fx.dispose();
  count.value = 100;
  console.log('after dispose', seen.length, fx.disposed, fx.dispose());
}

function demoDiamond() {
  console.log('== diamond ==');
  const a = signal(1, { label: 'a' });
  const b = computed(() => a.value * 2, { label: 'b' });
  const c = computed(() => a.value + 1, { label: 'c' });
  const d = computed(() => b.value + c.value, { label: 'd' });
  const e = computed(() => (d.value % 2 === 0 ? 'even' : 'odd'), { label: 'e' });
  const log = [];
  effect(() => log.push(`${d.value}/${e.value}`), { label: 'fxD' });
  for (const v of [2, 3, 3, 10]) a.value = v;
  console.log('log', log.join(' '), 'evals', [b, c, d, e].map((n) => n.label + n.evaluations).join(','));
  const walked = [];
  const gen = a.dependents(3);
  let step;
  while (!(step = gen.next()).done) walked.push(step.value.join(':'));
  console.log('dependents', walked.join(' '), 'total', step.value);
  const early = a.dependents();
  early.next();
  console.log('early return', JSON.stringify(early.return('stop')), JSON.stringify(early.next()));
}

function demoDynamic() {
  console.log('== dynamic deps ==');
  const flag = signal(true, { label: 'flag' });
  const x = signal('x0', { label: 'x' });
  const y = signal('y0', { label: 'y' });
  const pick = computed(() => (flag.value ? x.value : y.value), { label: 'pick' });
  const runs = [];
  effect(() => runs.push(pick.value), { label: 'fxPick' });
  y.value = 'y1';
  x.value = 'x1';
  flag.value = false;
  x.value = 'x2';
  y.value = 'y2';
  console.log('runs', runs.join(','), 'pick evals', pick.evaluations, 'sources', [...pick.sources.keys()].map((s) => s.label).join('+'));
  const probe = {
    hits: 0,
    get tracked() { this.hits++; return x.value; },
  };
  const viaProbe = computed(() => probe.tracked + '/' + untrack(() => y.value), { label: 'probe' });
  console.log('probe', viaProbe.value, probe.hits);
  y.value = 'y3';
  console.log('probe after untracked write', viaProbe.value, probe.hits);
  x.value = 'x3';
  console.log('probe after tracked write', viaProbe.value, probe.hits);
}

function demoBatch() {
  console.log('== batch ==');
  const first = signal('Ada', { label: 'first' });
  const last = signal('Lovelace', { label: 'last' });
  const full = computed(() => `${first.value} ${last.value}`, { label: 'full' });
  const out = [];
  effect(() => out.push(full.value), { label: 'fxFull' });
  const ret = batch(() => {
    first.value = 'Grace';
    batch(() => { last.value = 'Hopper'; });
    out.push('inside:' + full.value);
    return 'batched';
  });
  console.log(ret, out.join(' | '));
  try {
    batch(() => {
      first.value = 'Alan';
      last.value = 'Turing';
      throw new Error('boom mid-batch');
    });
  } catch ({ message }) {
    console.log('caught', message, 'flushed anyway:', out[out.length - 1]);
  }
  console.log('flushes', stats.flushes > 0, 'batchDepth', batchDepth);
}

function demoCycles() {
  console.log('== cycles & errors ==');
  const holder = {};
  holder.p = computed(() => holder.q.value + 1, { label: 'p' });
  holder.q = computed(() => holder.r.value + 1, { label: 'q' });
  holder.r = computed(() => holder.p.value + 1, { label: 'r' });
  try {
    console.log('no cycle?', holder.p.value);
  } catch (e) {
    console.log(e.name, e.message, e instanceof CycleError, e.path.length);
  }
  const s = signal(1, { label: 's' });
  const bad = computed(() => { s.value = 5; return 1; }, { label: 'badWriter' });
  try { bad.value; } catch (e) { console.log('write guard', e.name, e.message); }
  const thrower = computed(() => { if (s.value > 2) throw new RangeError('too big ' + s.peek()); return s.value; }, { label: 'thrower' });
  const results = [];
  effect(() => {
    try { results.push(thrower.value); } catch (e) { results.push(e.name); }
  }, { label: 'fxThrower' });
  s.value = 3;
  s.value = 2;
  s.value = 7;
  console.log('thrower results', results.join(','), 'error prop', thrower.error?.message ?? 'none');
  const loopy = signal(0, { label: 'loopy' });
  try {
    effect(() => { if (loopy.value < 1000) loopy.value = loopy.peek() + 1; }, { label: 'fxLoop' });
    console.log('no loop error?');
  } catch (e) {
    console.log('loop guard', e.message.split(':')[0], loopy.peek());
  }
  const failing = effect(() => { if (s.value === 9) throw new TypeError('fx failed'); }, { label: 'fxFail' });
  s.value = 9;
  console.log('effect errors', stats.errors.slice(-1).join(';'), failing.runs);
}

function demoCleanup() {
  console.log('== cleanup & nesting ==');
  const events = [];
  const topic = signal('news', { label: 'topic' });
  const verbose = signal(false, { label: 'verbose' });
  const parent = effect((onCleanup) => {
    const t = topic.value;
    events.push('sub:' + t);
    onCleanup(() => events.push('unsub:' + t));
    effect((inner) => {
      const v = verbose.value;
      events.push(`child(${t},${v})`);
      inner(() => events.push(`childDone(${t},${v})`));
    }, { label: 'child-' + t });
    return () => events.push('ret-cleanup:' + t);
  }, { label: 'parent' });
  verbose.value = true;
  topic.value = 'sports';
  verbose.value = false;
  parent.dispose();
  verbose.value = true;
  for (let i = 0; i < events.length; i += 4) console.log('  ' + events.slice(i, i + 4).join(' '));
  const list = signal([1, 2, 3], { label: 'list', equals: shallowEqual });
  let listRuns = 0;
  effect(() => { list.value; listRuns++; }, { label: 'fxList' });
  list.value = [1, 2, 3];
  list.value = [1, 2, 3, 4];
  console.log('shallowEqual runs', listRuns);
}

function demoStore() {
  console.log('== store ==');
  const state = reactive({ user: { name: 'kim', tags: ['a'] }, count: 0 });
  const log = [];
  effect(() => log.push('name=' + state.user.name), { label: 'fxName' });
  effect(() => log.push('keys=' + Object.keys(state).join('/')), { label: 'fxKeys' });
  effect(() => log.push('tags=' + state.user.tags.join('')), { label: 'fxTags' });
  effect(() => log.push('hasExtra=' + ('extra' in state)), { label: 'fxHas' });
  state.user.name = 'lee';
  state.user.name = 'lee';
  state.count++;
  state.user.tags.push('b');
  state.extra = { deep: 1 };
  batch(() => { state.user.tags.push('c'); state.user.name = 'park'; });
  delete state.extra;
  state.user = { name: 'new', tags: [] };
  for (let i = 0; i < log.length; i += 5) console.log('  ' + log.slice(i, i + 5).join(', '));
  console.log('raw', JSON.stringify(state[RAW]), state.user === state.user, reactive(5));
}

function demoJSON() {
  console.log('== json ==');
  const g = { a: signal(1, { label: 'ja' }), nested: { b: signal([1, 2], { label: 'jb' }), plain: 3 }, fn: () => 1, u: undefined };
  const text = JSON.stringify(g, function (key, value) {
    if (value instanceof Signal) return { $signal: value.label, v: value.peek() };
    if (typeof value === 'function') return '[fn]';
    return value;
  });
  console.log(text);
  const revived = JSON.parse(text, (key, value) => (value && typeof value === 'object' && '$signal' in value ? signal(value.v, { label: value.$signal + "'" }) : value));
  const sum = computed(() => revived.a.value + revived.nested.b.value.length + revived.nested.plain, { label: 'jsum' });
  console.log('revived', sum.value, revived.a.label, revived.fn, 'u' in revived);
  revived.a.value = 10;
  console.log('revived after write', sum.value);
}

function demoSheet() {
  console.log('== sheet ==');
  const sh = new Sheet('main');
  sh.set('A1', 2).set('A2', 3).set('B1', '=A1*A2').set('B2', '=B1+A1*10').set('C1', '=(B2-B1)/2');
  const history = [];
  effect(() => history.push(`C1=${sh.get('C1')} B2=${sh.get('B2')}`), { label: 'fxSheet' });
  sh.set('A1', 5);
  batch(() => { sh.set('A1', 1); sh.set('A2', 1); });
  sh.set('B1', '=A2+100');
  history.forEach((h, i) => console.log(`  ${i}: ${h}`));
  const snapshot = {};
  for (const [ref, node] of sh) snapshot[ref] = node.peek();
  console.log('snapshot', JSON.stringify(snapshot), 'sheets', Sheet.sheets);
  sh.set('D1', '=D2+1').set('D2', '=D1+1');
  try { sh.get('D1'); } catch (e) { console.log('sheet cycle', e.name, e.path.join('>')); }
  for (const f of ['1+2*3', '(1+2)*3', '-4+10/4', '2*(3+(4-1))']) console.log(`  arith ${f} = ${evalArith(f)}`);
  try { evalArith('2+'); } catch (e) { console.log('arith error', e.message); }
}

function demoDeep() {
  console.log('== deep ==');
  const root = signal(0, { label: 'root' });
  let prev = root;
  const chain = [];
  for (let i = 0; i < 600; i++) {
    const p = prev;
    const node = computed(() => p.value + 1, { label: 'c' + i });
    chain.push(node);
    prev = node;
  }
  console.log('chain end', prev.value, 'evals', chain.reduce((s, n) => s + n.evaluations, 0));
  root.value = 10;
  console.log('chain end after', prev.value, chain[299].value);
  console.log('mutual recursion', isEven(3000), isOdd(2999), isEven(2501));
  const fns = [];
  const data = { alpha: 1, beta: 2, gamma: 3 };
  for (const k in data) fns.push(computed(() => k + ':' + data[k]));
  for (const [i, k] of Object.keys(data).entries()) fns.push(computed(() => i + k[0]));
  let jj = 0;
  do {
    jj++;
    if (jj % 2) continue;
    fns.push(computed(() => 'jj' + jj));
  } while (jj < 5);
  console.log('closures', fns.map((f) => f.value).join(' '), 'nodes', ReactiveNode.count > 600);
}

async function demoAsync() {
  console.log('== async ==');
  const query = signal(1, { label: 'query' });
  const fetches = [];
  const res = resource(query, async (n) => {
    fetches.push(n);
    for (let i = 0; i < (n % 3) + 1; i++) await null;
    if (n === 4) throw new Error('not found: ' + n);
    return { n, sq: n * n };
  }, 'user');
  const states = [];
  effect(() => states.push(res.state.value + (res.data.value ? '#' + res.data.value.sq : '')), { label: 'fxRes' });
  query.value = 2;
  query.value = 3;
  console.log('settle1', (await res.settle()).join(' '));
  query.value = 4;
  console.log('settle2', (await res.settle()).join(' '), 'error', res.error.peek());
  query.value = 5;
  await res.settle();
  console.log('states', states.join(' > '), 'fetches', fetches.join(','));

  const ticker = signal(0, { label: 'ticker' });
  const producer = (async () => {
    for (let i = 1; i <= 6; i++) { await null; await null; ticker.value = i * 10; }
    return 'produced';
  })();
  const got = [];
  for await (const v of changes(ticker, 10)) {
    got.push(v);
    if (v >= 40) break;
  }
  console.log('consumed', got.join(','), await producer);

  const it = changes(ticker, 2)[Symbol.asyncIterator]();
  const r1 = await it.next();
  ticker.value = 999;
  const r2 = await it.next();
  const r3 = await it.next();
  console.log('manual', JSON.stringify([r1, r2, r3]));

  const order = [];
  const tasks = ['a', 'b', 'c'].map((name, i) => (async () => {
    for (let k = 0; k < 3 - i; k++) await null;
    order.push(name);
    return name.toUpperCase();
  })());
  const [all, race, settled, any] = await Promise.all([
    Promise.all(tasks),
    Promise.race(tasks),
    Promise.allSettled([tasks[0], Promise.reject(new Error('x'))]),
    Promise.any([Promise.reject(new Error('y')), tasks[2]]),
  ]);
  console.log('combinators', all.join(''), race, settled.map((s) => s.status[0]).join(''), any, order.join(''));
}

function main() {
  demoBasics();
  demoDiamond();
  demoDynamic();
  demoBatch();
  demoCycles();
  demoCleanup();
  demoStore();
  demoJSON();
  demoSheet();
  demoDeep();
  return demoAsync();
}

main().then(
  () => console.log('done', 'writes>0', stats.writes > 0, 'errors', stats.errors.length, 'queue', EFFECT_QUEUE.size),
  (e) => console.log('FAILED', e.name, e.message),
);
