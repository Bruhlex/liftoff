// d07: CRDT collaborative editing simulation (RGA sequence, LWW register/map,
// counters, OR-set) with vector clocks, deterministic network and async sync.
'use strict';

// ---------------------------------------------------------------- utilities
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function stable(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stable).join(',') + ']';
  if (obj instanceof Map) return stable(Object.fromEntries([...obj.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));
  if (obj instanceof Set) return stable([...obj].sort());
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(obj[k])).join(',') + '}';
}

function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const log = (...parts) => console.log(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));

function tag(strings, ...values) {
  let out = '';
  strings.raw.forEach((raw, i) => {
    out += raw;
    if (i < values.length) {
      const v = values[i];
      out += v instanceof VectorClock ? `<${v}>` : typeof v === 'object' ? stable(v) : String(v);
    }
  });
  return out;
}

// ---------------------------------------------------------------- vector clock
class VectorClock {
  #entries = new Map();
  static #created = 0;
  static {
    VectorClock.ZERO = Object.freeze({ kind: 'zero' });
  }
  constructor(init) {
    VectorClock.#created++;
    if (init) for (const [k, v] of Object.entries(init)) if (v) this.#entries.set(k, v);
  }
  static get created() { return VectorClock.#created; }
  get(id) { return this.#entries.get(id) ?? 0; }
  tick(id) {
    this.#entries.set(id, this.get(id) + 1);
    return this;
  }
  merge(other) {
    for (const [k, v] of other.entries()) { if (v > this.get(k)) this.#entries.set(k, v); }
    return this;
  }
  *entries() {
    yield* [...this.#entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  clone() { return new VectorClock(Object.fromEntries(this.entries())); }
  compare(other) {
    let less = false, greater = false;
    const keys = new Set([...this.#entries.keys(), ...[...other.entries()].map(([k]) => k)]);
    for (const k of keys) {
      const a = this.get(k), b = other.get(k);
      if (a < b) less = true;
      else if (a > b) greater = true;
      if (less && greater) return 'concurrent';
    }
    return less ? 'before' : greater ? 'after' : 'equal';
  }
  static isClock(o) { return #entries in o; }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') {
      let sum = 0;
      for (const [, v] of this.entries()) sum += v;
      return sum;
    }
    return [...this.entries()].map(([k, v]) => `${k}:${v}`).join(',');
  }
  toJSON() { return Object.fromEntries(this.entries()); }
}

// ---------------------------------------------------------------- base CRDT hierarchy
class Crdt {
  constructor(replicaId) {
    if (new.target === Crdt) throw new TypeError('abstract Crdt');
    this.replicaId = replicaId;
    this.ops = 0;
  }
  describe() { return `crdt(${this.replicaId})`; }
  static [Symbol.hasInstance](inst) {
    return inst != null && typeof inst.merge === 'function' && typeof inst.value === 'function';
  }
}

class StateCrdt extends Crdt {
  describe() { return 'state:' + super.describe(); }
}

class Counter extends StateCrdt {
  #p = Object.create(null);
  increment(n = 1) {
    this.ops++;
    this.#p[this.replicaId] = (this.#p[this.replicaId] || 0) + n;
    return this;
  }
  merge(other) {
    for (const k in other.snapshot()) {
      const v = other.snapshot()[k];
      this.#p[k] = Math.max(this.#p[k] || 0, v);
    }
    return this;
  }
  snapshot() { return { ...this.#p }; }
  value() { return Object.values(this.#p).reduce((a, b) => a + b, 0); }
  describe() { return 'gcounter/' + super.describe(); }
}

class PNCounter extends Counter {
  #neg;
  constructor(id) {
    super(id);
    this.#neg = new Counter(id);
  }
  decrement(n = 1) {
    this.#neg.increment(n);
    return this;
  }
  merge(other) {
    super.merge(other);
    this.#neg.merge(other.negative);
    return this;
  }
  get negative() { return this.#neg; }
  value() { return super.value() - this.#neg.value(); }
  describe() { return 'pn/' + super.describe(); }
}

class LWWRegister extends StateCrdt {
  constructor(id, value = undefined, ts = [0, '']) {
    super(id);
    this.v = value;
    this.ts = ts;
  }
  set(value, lamport) {
    this.ops++;
    const ts = [lamport, this.replicaId];
    if (LWWRegister.newer(ts, this.ts)) {
      this.v = value;
      this.ts = ts;
    }
    return this;
  }
  static newer([l1, r1], [l2, r2]) { return l1 > l2 || (l1 === l2 && r1 > r2); }
  merge(other) {
    if (LWWRegister.newer(other.ts, this.ts)) ({ v: this.v, ts: this.ts } = other);
    return this;
  }
  value() { return this.v; }
}

class LWWMap extends StateCrdt {
  #regs = new Map();
  set(key, value, lamport) {
    let r = this.#regs.get(key);
    r ??= (this.#regs.set(key, new LWWRegister(this.replicaId)), this.#regs.get(key));
    r.replicaId = this.replicaId;
    r.set(value, lamport);
    return this;
  }
  delete(key, lamport) { return this.set(key, undefined, lamport); }
  merge(other) {
    for (const [k, reg] of other.registers()) {
      const mine = this.#regs.get(k);
      if (!mine) this.#regs.set(k, new LWWRegister(reg.replicaId, reg.v, reg.ts));
      else mine.merge(reg);
    }
    return this;
  }
  *registers() { yield* this.#regs; }
  value() {
    const out = {};
    for (const [k, r] of [...this.#regs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { if (r.value() !== undefined) out[k] = r.value(); }
    return out;
  }
}

class ORSet extends StateCrdt {
  #adds = new Map(); // elem -> Set(tags)
  #removes = new Set();
  #seq = 0;
  add(elem) {
    const t = `${this.replicaId}#${++this.#seq}`;
    if (!this.#adds.has(elem)) this.#adds.set(elem, new Set());
    this.#adds.get(elem).add(t);
    return t;
  }
  remove(elem) {
    const tags = this.#adds.get(elem);
    if (!tags) return 0;
    let n = 0;
    tags.forEach((t) => {
      if (!this.#removes.has(t)) {
        this.#removes.add(t);
        n++;
      }
    });
    return n;
  }
  merge(other) {
    const [adds, removes] = other.raw();
    for (const [e, tags] of adds) {
      const mine = this.#adds.get(e) ?? new Set();
      for (const t of tags) mine.add(t);
      this.#adds.set(e, mine);
    }
    removes.forEach((t) => this.#removes.add(t));
    return this;
  }
  raw() { return [this.#adds, this.#removes]; }
  has(e) {
    const tags = this.#adds.get(e);
    if (!tags) return false;
    for (const t of tags) if (!this.#removes.has(t)) return true;
    return false;
  }
  value() { return [...this.#adds.keys()].filter((e) => this.has(e)).sort(); }
}

// ---------------------------------------------------------------- RGA sequence
class RgaNode {
  constructor(id, ch, after) {
    this.id = id; // [counter, replica]
    this.ch = ch;
    this.after = after;
    this.deleted = false;
    this.children = [];
  }
  get key() { return this.id ? `${this.id[0]}@${this.id[1]}` : 'ROOT'; }
}

function idGreater(a, b) {
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

class Rga extends Crdt {
  #nodes = new Map();
  #root = new RgaNode(null, '', null);
  #counter = 0;
  #pending = [];
  constructor(id) {
    super(id);
    this.#nodes.set('ROOT', this.#root);
  }
  get counter() { return this.#counter; }
  *#walk(node = this.#root) {
    for (const child of node.children) {
      yield child;
      yield* this.#walk(child);
    }
  }
  visibleNodes() {
    const out = [];
    for (const n of this.#walk()) if (!n.deleted) out.push(n);
    return out;
  }
  value() { return this.visibleNodes().map((n) => n.ch).join(''); }
  insertAt(index, ch) {
    const vis = this.visibleNodes();
    const after = index === 0 ? 'ROOT' : vis[index - 1]?.key ?? (vis.length ? vis[vis.length - 1].key : 'ROOT');
    const op = { type: 'ins', id: [++this.#counter, this.replicaId], ch, after };
    this.apply(op);
    return op;
  }
  deleteAt(index) {
    const target = this.visibleNodes()[index];
    if (!target) return null;
    const op = { type: 'del', target: target.key };
    this.apply(op);
    return op;
  }
  apply(op) {
    this.ops++;
    switch (op.type) {
      case 'ins': {
        if (this.#nodes.has(`${op.id[0]}@${op.id[1]}`)) return 'dup';
        const parent = this.#nodes.get(op.after);
        if (!parent) {
          this.#pending.push(op);
          return 'pending';
        }
        this.#counter = Math.max(this.#counter, op.id[0]);
        const node = new RgaNode(op.id, op.ch, op.after);
        let i = 0;
        while (i < parent.children.length && idGreater(parent.children[i].id, op.id)) i++;
        parent.children.splice(i, 0, node);
        this.#nodes.set(node.key, node);
        this.#drain();
        return 'ok';
      }
      case 'del': {
        const n = this.#nodes.get(op.target);
        if (!n) {
          this.#pending.push(op);
          return 'pending';
        }
        const was = n.deleted;
        n.deleted = true;
        return was ? 'dup' : 'ok';
      }
      default:
        throw new Error('unknown op ' + op.type);
    }
  }
  #drain() {
    let progress = true;
    while (progress) {
      progress = false;
      const queue = this.#pending;
      this.#pending = [];
      for (const op of queue) {
        const r = this.apply(op);
        if (r !== 'pending') progress = true;
      }
    }
  }
  get pendingCount() { return this.#pending.length; }
  merge(other) {
    for (const op of other.exportOps()) this.apply(op);
    return this;
  }
  *exportOps() {
    for (const n of this.#walk()) {
      yield { type: 'ins', id: n.id, ch: n.ch, after: n.after };
    }
    for (const n of this.#walk()) if (n.deleted) yield { type: 'del', target: n.key };
  }
  tombstones() {
    let t = 0;
    for (const n of this.#walk()) t += n.deleted ? 1 : 0;
    return t;
  }
}

// ---------------------------------------------------------------- replica + network
class Replica {
  #clock;
  #lamport = 0;
  #log = [];
  #seen = new Set();
  constructor(id) {
    this.id = id;
    this.#clock = new VectorClock();
    this.doc = new Rga(id);
    this.meta = new LWWMap(id);
    this.likes = new PNCounter(id);
    this.tags = new ORSet(id);
  }
  get clock() { return this.#clock; }
  get lamport() { return this.#lamport; }
  #stamp(payload) {
    this.#clock.tick(this.id);
    this.#lamport++;
    const msg = { from: this.id, seq: this.#clock.get(this.id), clock: this.#clock.toJSON(), lamport: this.#lamport, payload };
    this.#log.push(msg);
    this.#seen.add(`${msg.from}:${msg.seq}`);
    return msg;
  }
  type(index, text) {
    const msgs = [];
    let i = index;
    for (const ch of text) msgs.push(this.#stamp(this.doc.insertAt(i++, ch)));
    return msgs;
  }
  erase(index, count) {
    const msgs = [];
    for (let k = 0; k < count; k++) {
      const op = this.doc.deleteAt(index);
      if (op) msgs.push(this.#stamp(op));
    }
    return msgs;
  }
  setMeta(key, value) {
    this.meta.set(key, value, this.#lamport + 1);
    return this.#stamp({ type: 'meta', key, value, lamport: this.#lamport + 1 });
  }
  receive(msg) {
    const key = `${msg.from}:${msg.seq}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    this.#clock.merge(new VectorClock(msg.clock));
    this.#lamport = Math.max(this.#lamport, msg.lamport) + 1;
    const p = msg.payload;
    if (p.type === 'meta') {
      const reg = new LWWMap(msg.from);
      reg.set(p.key, p.value, p.lamport);
      this.meta.merge(reg);
    } else this.doc.apply(p);
    this.#log.push(msg);
    return true;
  }
  history() { return this.#log.slice(); }
  fingerprint() { return hashStr(this.doc.value() + '|' + stable(this.meta.value()) + '|' + this.likes.value() + '|' + this.tags.value().join()); }
}

class Network {
  constructor(rng, { dropRate = 0.1, dupRate = 0.1 } = {}) {
    this.rng = rng;
    this.queue = [];
    this.stats = { sent: 0, dropped: 0, duplicated: 0, delivered: 0 };
    Object.assign(this, { dropRate, dupRate });
  }
  broadcast(from, msgs, peers) {
    for (const m of [].concat(msgs)) {
      for (const p of peers) {
        if (p.id === from.id) continue;
        this.stats.sent++;
        if (this.rng() < this.dropRate) {
          this.stats.dropped++;
          continue;
        }
        this.queue.push({ to: p, msg: m });
        if (this.rng() < this.dupRate) {
          this.stats.duplicated++;
          this.queue.push({ to: p, msg: m });
        }
      }
    }
  }
  shuffle() {
    const q = this.queue;
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
  }
  deliverAll() {
    this.shuffle();
    let n = 0;
    while (this.queue.length) {
      const { to, msg } = this.queue.shift();
      if (to.receive(msg)) n++;
    }
    this.stats.delivered += n;
    return n;
  }
}

// anti-entropy: full log exchange
function antiEntropy(replicas) {
  let moved = 0;
  for (const a of replicas) for (const b of replicas) {
    if (a === b) continue;
    for (const m of a.history()) if (b.receive(m)) moved++;
  }
  return moved;
}

// ---------------------------------------------------------------- scenario 1: vector clocks
function section(title) {
  console.log('== ' + title + ' ==');
}

section('vector clocks');
{
  const a = new VectorClock({ A: 1 });
  const b = new VectorClock({ B: 2 });
  log('a vs b', a.compare(b));
  const c = a.clone().merge(b).tick('A');
  log('c', String(c), 'sum', +c);
  log('a vs c', a.compare(c), 'c vs a', c.compare(a), 'c vs c', c.compare(c.clone()));
  log('isClock', VectorClock.isClock(c), VectorClock.isClock({}));
  log(tag`tagged ${c} and ${{ z: 1, a: [2] }} done`);
  log('zero frozen', Object.isFrozen(VectorClock.ZERO), VectorClock.ZERO.kind);
}

// ---------------------------------------------------------------- scenario 2: counters/sets
section('counters and sets');
{
  const reps = ['x', 'y', 'z'].map((id) => new PNCounter(id));
  reps[0].increment(5).decrement(2);
  reps[1].increment(3);
  reps[2].decrement(4).increment();
  for (const r of reps) for (const o of reps) r.merge(o);
  log('pn values', reps.map((r) => r.value()));
  log('describe', reps[0].describe());
  log('instanceof Crdt (hasInstance)', reps[0] instanceof Crdt, {} instanceof Crdt, { merge() {}, value() {} } instanceof Crdt);
  try {
    new Crdt('q');
  } catch ({ name, message }) { log('abstract error', name, message); }
  const s1 = new ORSet('s1'), s2 = new ORSet('s2');
  s1.add('red');
  s1.add('blue');
  s2.merge(s1);
  s2.remove('red');
  s1.add('red'); // concurrent add wins
  s2.add('green');
  s1.remove('blue');
  s1.merge(s2);
  s2.merge(s1);
  log('orset', s1.value(), s2.value(), s1.has('blue'), s2.has('red'));
  const m1 = new LWWMap('m1'), m2 = new LWWMap('m2');
  m1.set('title', 'Draft', 1).set('owner', 'ann', 2);
  m2.set('title', 'Final', 1).set('lang', 'de', 3);
  m2.delete('owner', 5);
  m1.merge(m2);
  m2.merge(m1);
  log('lww maps', m1.value(), stable(m1.value()) === stable(m2.value()));
}

// ---------------------------------------------------------------- scenario 3: RGA basics
section('rga basics');
{
  const a = new Rga('A'), b = new Rga('B');
  const opsA = [];
  for (const [i, ch] of [...'HELLO'].entries()) opsA.push(a.insertAt(i, ch));
  opsA.forEach((op) => b.apply(op));
  const x = a.insertAt(5, '!');
  const y = b.insertAt(5, '?');
  a.apply(y);
  b.apply(x);
  log('concurrent tail', a.value(), b.value(), a.value() === b.value());
  const d1 = a.deleteAt(0);
  const d2 = b.deleteAt(0);
  a.apply(d2);
  b.apply(d1);
  log('double delete', a.value(), b.value(), 'tomb', a.tombstones());
  // out of order delivery
  const c = new Rga('C');
  const ops = [...a.exportOps()].reverse();
  const results = ops.map((op) => c.apply(op));
  log('reverse apply results', results.join(','), 'pending', c.pendingCount, 'value', c.value());
  log('dup apply', c.apply(ops[0]));
  try {
    c.apply({ type: 'bogus' });
  } catch (e) { log('bad op', e.message); }
}

// ---------------------------------------------------------------- scenario 4: simulation
section('editing simulation');
function simulate(seed, rounds, names) {
  const rng = makeRng(seed);
  const replicas = names.map((n) => new Replica(n));
  const net = new Network(rng, { dropRate: 0.15, dupRate: 0.2 });
  const words = ['crdt', ' ', 'merge', 'clock', 'lww', 'x', 'yz', 'été'];
  outer: for (let r = 0; r < rounds; r++) {
    for (const rep of replicas) {
      const roll = rng();
      let msgs;
      try {
        switch (true) {
          case roll < 0.5: {
            const len = rep.doc.value().length;
            msgs = rep.type(Math.floor(rng() * (len + 1)), pick(rng, words));
            break;
          }
          case roll < 0.7: {
            const len = rep.doc.value().length;
            if (!len) continue;
            msgs = rep.erase(Math.floor(rng() * len), 1 + Math.floor(rng() * 3));
            break;
          }
          case roll < 0.85:
            msgs = [rep.setMeta(pick(rng, ['title', 'color', 'font']), pick(rng, ['a', 'b', 'c', 'd']))];
            break;
          case roll < 0.9:
            if (r === rounds - 1) break outer;
          // fallthrough
          default:
            rep.likes.increment(1 + Math.floor(rng() * 3));
            rep.tags.add(pick(rng, ['draft', 'review', 'final']));
            msgs = [];
        }
      } finally { if (msgs && msgs.length) net.broadcast(rep, msgs, replicas); }
    }
    if (r % 3 === 2) net.deliverAll();
  }
  net.deliverAll();
  const beforeAE = replicas.map((r) => r.fingerprint());
  const moved = antiEntropy(replicas);
  for (const a of replicas) for (const b of replicas) {
    a.likes.merge(b.likes);
    a.tags.merge(b.tags);
  }
  return { replicas, net, beforeAE, moved };
}

for (const [seed, rounds, names] of [
  [7, 12, ['ann', 'bob']],
  [42, 20, ['ann', 'bob', 'cy']],
  [1234, 30, ['p', 'q', 'r', 's']],
]) {
  const { replicas, net, beforeAE, moved } = simulate(seed, rounds, names);
  const fps = replicas.map((r) => r.fingerprint());
  log(`seed=${seed}`, 'stats', net.stats);
  log('  before AE', beforeAE.join(' '), 'moved', moved);
  log('  after AE ', fps.join(' '), 'converged', new Set(fps).size === 1);
  log('  doc', replicas[0].doc.value());
  log('  meta', replicas[0].meta.value(), 'likes', replicas[0].likes.value(), 'tags', replicas[0].tags.value());
  log('  clock', String(replicas[0].clock), 'lamport', replicas.map((r) => r.lamport));
  const causal = replicas.map((a, i) => replicas.map((b) => a.clock.compare(b.clock)[0]).join('')).join('/');
  log('  causal matrix', causal);
}

// ---------------------------------------------------------------- scenario 5: closures over loops
section('closures and deferred checks');
{
  const checks = [];
  for (let i = 0; i < 3; i++) {
    const r = new Replica('L' + i);
    r.type(0, 'abc'.slice(0, i + 1));
    checks.push(() => `${i}:${r.doc.value()}`);
  }
  const byName = {};
  for (const k in { alpha: 1, beta: 2 }) byName[k] = () => k.toUpperCase();
  const fromOf = [];
  for (const [idx, word] of ['one', 'two'].entries()) fromOf.push(() => word.repeat(idx + 1));
  log('deferred', checks.map((f) => f()), Object.values(byName).map((f) => f()), fromOf.map((f) => f()));

  var legacyVar = [];
  for (var v = 0; v < 3; v++) legacyVar.push(() => v);
  log('var capture', legacyVar.map((f) => f()));
}

// ---------------------------------------------------------------- scenario 6: proxy-observed document
section('proxy observer');
{
  const events = [];
  const rep = new Replica('P');
  const observed = new Proxy(rep, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, target);
      if (typeof val === 'function' && ['type', 'erase', 'setMeta'].includes(prop)) {
        return function (...args) {
          events.push(`${String(prop)}(${args.map((a) => JSON.stringify(a)).join(',')})`);
          return val.apply(target, args);
        };
      }
      return val;
    },
    has(target, prop) {
      return prop === 'secret' ? false : Reflect.has(target, prop);
    },
  });
  observed.type(0, 'proxy');
  observed.erase(1, 2);
  observed.setMeta('mode', 'edit');
  log('events', events);
  log('doc', observed.doc.value(), 'in', 'doc' in observed, 'secret' in observed, 'id' in observed);
  const frozenView = Object.freeze({ ...observed.meta.value(), extra: observed?.missing?.deep ?? 'none' });
  log('view', frozenView, Object.isFrozen(frozenView));
}

// ---------------------------------------------------------------- scenario 7: generators over history
section('generators');
function* opsByType(history) {
  const counts = { ins: 0, del: 0, meta: 0 };
  for (const m of history) {
    counts[m.payload.type]++;
    const cmd = yield m.payload.type;
    if (cmd === 'stop') break;
  }
  return counts;
}
function* delegating(history) {
  const res = yield* opsByType(history);
  yield 'summary:' + stable(res);
  try {
    yield 'tail';
  } finally { yield 'cleanup'; }
}
{
  const r = new Replica('G');
  r.type(0, 'gen');
  r.erase(0, 1);
  r.setMeta('k', 'v');
  const seen = [];
  for (const t of delegating(r.history())) seen.push(t);
  log('gen all', seen);
  const g = delegating(r.history());
  const early = [g.next().value, g.next('stop').value, g.next().value];
  log('gen stop', early);
  const g2 = delegating(r.history());
  let step;
  do {
    step = g2.next();
  } while (step.value !== 'tail' && !step.done);
  log('return during finally', JSON.stringify(g2.return('R')), JSON.stringify(g2.next()));
  const g3 = opsByType(r.history());
  g3.next();
  try {
    g3.throw(new Error('injected'));
  } catch (e) { log('thrown out', e.message, JSON.stringify(g3.next())); }
}

// ---------------------------------------------------------------- scenario 8: async sync sessions
section('async sync');
class AsyncChannel {
  #buffer = [];
  #waiters = [];
  #closed = false;
  push(v) {
    const w = this.#waiters.shift();
    if (w) w({ value: v, done: false });
    else this.#buffer.push(v);
  }
  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#buffer.length) return Promise.resolve({ value: this.#buffer.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.#waiters.push(res));
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    };
  }
}

async function* batches(history, size) {
  for (let i = 0; i < history.length; i += size) {
    await null;
    yield history.slice(i, i + size);
  }
}

async function syncPair(a, b, order) {
  const chan = new AsyncChannel();
  const producer = (async () => {
    for await (const batch of batches(a.history(), 3)) {
      order.push(`prod:${a.id}:${batch.length}`);
      chan.push(batch);
    }
    chan.close();
    return 'produced';
  })();
  let applied = 0;
  const consumer = (async () => {
    for await (const batch of chan) {
      for (const m of batch) applied += b.receive(m) ? 1 : 0;
      order.push(`cons:${b.id}:${applied}`);
    }
    return applied;
  })();
  const [p, c] = await Promise.all([producer, consumer]);
  return { p, c };
}

async function main() {
  const a = new Replica('AA'), b = new Replica('BB'), c = new Replica('CC');
  a.type(0, 'async ');
  b.type(0, 'world');
  c.setMeta('title', 'sync');
  const order = [];
  const r1 = await syncPair(a, b, order);
  const r2 = await syncPair(b, a, order);
  log('sync results', r1, r2);
  log('order', order.join(' '));
  log('docs', a.doc.value(), '|', b.doc.value(), a.fingerprint() === b.fingerprint());

  const tick = [];
  const settled = await Promise.allSettled([
    syncPair(c, a, tick),
    Promise.reject(new RangeError('link down')),
    (async () => {
      await 0;
      throw { code: 503 };
    })(),
  ]);
  log('settled', settled.map((s) => s.status + ':' + (s.status === 'fulfilled' ? stable(s.value) : s.reason?.message ?? stable(s.reason))));
  const winner = await Promise.race([
    (async () => {
      await null;
      await null;
      return 'slow';
    })(),
    (async () => {
      await null;
      return 'fast';
    })(),
  ]);
  const anyRes = await Promise.any([Promise.reject(new Error('x')), Promise.resolve('any-ok')]);
  try {
    await Promise.any([Promise.reject(new Error('e1')), Promise.reject(new Error('e2'))]);
  } catch (e) {
    log('aggregate', e.constructor === AggregateError, e.errors.map((x) => x.message));
  }
  log('race', winner, 'any', anyRes);

  // microtask ordering trace
  const trace = [];
  const p1 = Promise.resolve().then(() => trace.push('then1')).then(() => trace.push('then2'));
  const p2 = (async () => {
    trace.push('async-start');
    await undefined;
    trace.push('async-after1');
    await p1;
    trace.push('async-after-p1');
  })();
  trace.push('sync-end');
  await Promise.all([p1, p2]);
  log('trace', trace.join(','));

  // final convergence of three replicas via async anti-entropy rounds
  let round = 0;
  do {
    round++;
    const tasks = [];
    for (const x of [a, b, c]) for (const y of [a, b, c]) if (x !== y) tasks.push(syncPair(x, y, []));
    const res = await Promise.all(tasks);
    const moved = res.reduce((s, r) => s + r.c, 0);
    log('round', round, 'moved', moved);
    if (moved === 0) break;
  } while (round < 5);
  log('final', [a, b, c].map((r) => r.fingerprint()), a.doc.value(), a.meta.value());
  log('clocks created', VectorClock.created > 10);
}

// ---------------------------------------------------------------- scenario 9: JSON persistence
section('persistence');
{
  const r = new Replica('J');
  r.type(0, 'persist me');
  r.erase(0, 3);
  r.setMeta('saved', true);
  const text = JSON.stringify(
    { history: r.history(), clock: r.clock, big: 12345678901234567890n },
    (k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : k === 'lamport' ? undefined : v)
  );
  log('saved bytes', text.length, 'hash', hashStr(text));
  const restored = JSON.parse(text, function (k, v) {
    if (v && typeof v === 'object' && '$big' in v) return BigInt(v.$big);
    if (k === 'lamport') return 0;
    return v;
  });
  log('big restored', typeof restored.big, (restored.big * 2n).toString());
  const r2 = new Replica('K');
  let applied = 0;
  for (const m of restored.history) applied += r2.receive({ ...m, lamport: m.lamport ?? 0 }) ? 1 : 0;
  log('restored doc', r2.doc.value(), 'applied', applied, 'eq', r2.doc.value() === r.doc.value());
  const obj = { a: 1, b: 2 };
  Object.defineProperty(obj, 'computed', { get() { return this.a + this.b; }, enumerable: true });
  delete obj.a;
  log('define/delete', JSON.stringify(obj), typeof obj.a, void 0 === obj.a, 'b' in obj);
}

// ---------------------------------------------------------------- scenario 10: deep recursion over nodes
section('deep chain');
{
  const r = new Rga('D');
  let prev = 'ROOT';
  for (let i = 1; i <= 3000; i++) {
    r.apply({ type: 'ins', id: [i, 'D'], ch: String.fromCharCode(97 + (i % 26)), after: prev });
    prev = `${i}@D`;
  }
  const v = r.value();
  log('deep length', v.length, 'head', v.slice(0, 10), 'hash', hashStr(v));
  function countEven(n) { return n === 0 ? 0 : (n % 2 === 0 ? 1 : 0) + countOdd(n - 1); }
  function countOdd(n) { return n === 0 ? 0 : countEven(n - 1); }
  log('mutual recursion', countEven(3000));
}

main()
  .then(() => log('done'))
  .catch((e) => {
    log('FAILED', e && e.message);
    throw e;
  });
