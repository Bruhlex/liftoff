// d13: DPLL SAT solver with two watched literals, generated instances,
// preprocessing, model enumeration, generators, async batches, BigInt hashing.

function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const rng = function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  rng.int = (n) => rng() % n;
  rng.pick = function (arr) { return arr[this.int(arr.length)]; };
  rng.fork = () => makeRng(rng() ^ 0xa5a5a5a5);
  return rng;
}
const lit = (v, neg) => (v << 1) | (neg ? 1 : 0);
const litVar = (l) => l >> 1;
const litNeg = (l) => (l & 1) === 1;
const fromDimacs = (x) => lit(Math.abs(x) - 1, x < 0);
const toDimacs = (l) => (litNeg(l) ? -1 : 1) * (litVar(l) + 1);
function out(label, obj) {
  console.log(label + ' ' + JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? 'n:' + v.toString(16) : v)));
}
// sloppy-mode arguments aliasing
function aliasProbe(a, b) {
  arguments[0] = a * 10;
  b = 7;
  const extra = arguments.length > 2 ? Array.prototype.slice.call(arguments, 2) : [];
  return [a, arguments[1], arguments.length, extra.join('|')];
}
function sumAll() {
  let t = 0;
  for (let i = 0; i < arguments.length; i++) t += typeof arguments[i] === 'number' ? arguments[i] : 0;
  return t;
}
class Literal {
  #code;
  constructor(code) { this.#code = code; }
  static of(d) { return new Literal(fromDimacs(d)); }
  get code() { return this.#code; }
  negate() { return new Literal(this.#code ^ 1); }
  [Symbol.toPrimitive](hint) {
    switch (hint) {
      case 'number': return toDimacs(this.#code);
      case 'string': return (litNeg(this.#code) ? '~x' : 'x') + (litVar(this.#code) + 1);
      default: return 'L' + toDimacs(this.#code);
    }
  }
  static isLiteral(o) { return o !== null && typeof o === 'object' && #code in o; }
}
class Clause {
  static #nextId = 0;
  static count() { return Clause.#nextId; }
  #id;
  constructor(lits, learnt = false) {
    this.#id = Clause.#nextId++;
    this.lits = [...lits];
    this.learnt = learnt;
  }
  get id() { return this.#id; }
  get size() { return this.lits.length; }
  *[Symbol.iterator]() { yield* this.lits; }
  get [Symbol.toStringTag]() { return 'Clause'; }
  toString() { return '(' + this.lits.map(toDimacs).join(' v ') + ')'; }
  static [Symbol.hasInstance](o) { return o != null && Array.isArray(o.lits) && typeof o.size === 'number'; }
}
class Formula {
  constructor(numVars) {
    if (new.target === Formula) throw new TypeError('Formula is abstract');
    this.numVars = numVars;
    this.clauses = [];
  }
  newVar() { return this.numVars++; }
  get size() { return this.clauses.length; }
  describe() { return `vars=${this.numVars} clauses=${this.size}`; }
  satisfiedBy(model) {
    let idx = 0;
    for (const c of this.clauses) {
      let ok = false;
      for (const l of c) {
        if (model[litVar(l)] !== litNeg(l)) { ok = true; break; }
      }
      if (!ok) return idx;
      idx++;
    }
    return -1;
  }
}
class CNF extends Formula {
  #tautologies = 0;
  static #instances = 0;
  static KIND;
  static {
    CNF.KIND = 'cnf';
    CNF.#instances = 0;
  }
  constructor(numVars, name = 'anon') {
    super(numVars);
    this.name = name;
    CNF.#instances++;
  }
  add(...lits) {
    const flat = lits.flat(Infinity);
    const seen = new Set();
    const outL = [];
    for (const l of flat) {
      if (litVar(l) >= this.numVars) throw new RangeError(`literal ${l} out of range in ${this.name}`);
      if (seen.has(l ^ 1)) { this.#tautologies++; return this; }
      if (!seen.has(l)) { seen.add(l); outL.push(l); }
    }
    this.clauses.push(new Clause(outL));
    return this;
  }
  addDimacs(...ds) { return this.add(ds.map(fromDimacs)); }
  get tautologies() { return this.#tautologies; }
  static get instances() { return CNF.#instances; }
  describe() { return `${CNF.KIND}:${this.name} ${super.describe()} taut=${this.#tautologies}`; }
  clone(name = this.name + "'") {
    const c = new CNF(this.numVars, name);
    for (const cl of this.clauses) c.add([...cl]);
    return c;
  }
}
class WatchedCNF extends CNF {
  #watchCache = null;
  constructor(src) {
    super(src.numVars, src.name + '/w');
    for (const c of src.clauses) this.add([...c]);
  }
  #build() {
    const w = Array.from({ length: this.numVars * 2 }, () => []);
    this.clauses.forEach((c, i) => {
      if (c.size >= 2) { w[c.lits[0]].push(i); w[c.lits[1]].push(i); }
    });
    return w;
  }
  get watches() { return (this.#watchCache ??= this.#build()); }
  describe() { return super.describe() + ' watched=' + (this.#watchCache ? 'built' : 'lazy'); }
}
function makeStats() {
  const target = { decisions: 0, conflicts: 0, props: 0, runs: 0 };
  return new Proxy(target, {
    get(t, k, r) {
      if (k === 'snapshot') return () => ({ ...t });
      return Reflect.get(t, k, r);
    },
    set(t, k, v, r) {
      if (!(k in t)) throw new RangeError('unknown stat ' + String(k));
      return Reflect.set(t, k, v, r);
    },
    has(t, k) { return k !== 'runs' && k in t; },
    deleteProperty() { return false; },
  });
}
class DPLLSolver {
  #clauses; #assign; #trail = []; #lim = []; #decisions = []; #qhead = 0; #watches; #order; #polarity;
  constructor(f) {
    this.numVars = f.numVars;
    this.#clauses = f.clauses.map((c) => [...c.lits]);
    this.#assign = new Int8Array(f.numVars);
    this.#watches = f.watches.map((w) => [...w]);
    this.stats = makeStats();
    const occ = new Array(f.numVars).fill(0);
    const pos = new Array(f.numVars).fill(0);
    for (const c of this.#clauses) for (const l of c) { occ[litVar(l)]++; if (!litNeg(l)) pos[litVar(l)]++; }
    this.#order = [...occ.keys()].sort((a, b) => occ[b] - occ[a] || a - b);
    this.#polarity = occ.map((o, v) => pos[v] * 2 < o);
  }
  value(l) {
    const a = this.#assign[l >> 1];
    if (a === 0) return 0;
    return (l & 1) ? -a : a;
  }
  #enqueue(l) {
    const cur = this.value(l);
    if (cur !== 0) return cur === 1;
    this.#assign[l >> 1] = (l & 1) ? -1 : 1;
    this.#trail.push(l);
    return true;
  }
  #propagate() {
    const clauses = this.#clauses;
    while (this.#qhead < this.#trail.length) {
      const p = this.#trail[this.#qhead++];
      const falseLit = p ^ 1;
      const ws = this.#watches[falseLit];
      let i = 0, j = 0;
      this.stats.props++;
      scan: while (i < ws.length) {
        const ci = ws[i++];
        const lits = clauses[ci];
        if (lits[0] === falseLit) { lits[0] = lits[1]; lits[1] = falseLit; }
        if (this.value(lits[0]) === 1) { ws[j++] = ci; continue scan; }
        for (let k = 2; k < lits.length; k++) {
          if (this.value(lits[k]) !== -1) {
            lits[1] = lits[k]; lits[k] = falseLit;
            this.#watches[lits[1]].push(ci);
            continue scan;
          }
        }
        ws[j++] = ci;
        if (this.value(lits[0]) === -1) {
          while (i < ws.length) ws[j++] = ws[i++];
          ws.length = j;
          this.#qhead = this.#trail.length;
          return ci;
        }
        this.#enqueue(lits[0]);
      }
      ws.length = j;
    }
    return -1;
  }
  #undoLevel() {
    const start = this.#lim.pop();
    while (this.#trail.length > start) this.#assign[this.#trail.pop() >> 1] = 0;
    this.#qhead = this.#trail.length;
  }
  #pickVar() {
    for (const v of this.#order) if (this.#assign[v] === 0) return v;
    return -1;
  }
  get level() { return this.#lim.length; }
  *search(limit = Infinity) {
    let conflicts = 0;
    this.stats.runs++;
    try {
      for (const c of this.#clauses) {
        if (c.length === 0) { yield { type: 'unsat', why: 'empty' }; return { sat: false, conflicts }; }
        if (c.length === 1 && !this.#enqueue(c[0])) { yield { type: 'unsat', why: 'units' }; return { sat: false, conflicts }; }
      }
      outer: for (;;) {
        const confl = this.#propagate();
        if (confl >= 0) {
          conflicts++;
          this.stats.conflicts++;
          yield { type: 'conflict', clause: confl, level: this.level };
          for (;;) {
            if (this.#decisions.length === 0) { yield { type: 'unsat', why: 'exhausted' }; return { sat: false, conflicts }; }
            const d = this.#decisions.pop();
            this.#undoLevel();
            if (!d.flipped) {
              this.#lim.push(this.#trail.length);
              this.#decisions.push({ lit: d.lit ^ 1, flipped: true });
              this.#enqueue(d.lit ^ 1);
              yield { type: 'flip', lit: toDimacs(d.lit ^ 1), level: this.level };
              continue outer;
            }
          }
        }
        if (conflicts > limit) return { sat: null, conflicts };
        const v = this.#pickVar();
        if (v < 0) {
          yield { type: 'sat' };
          return { sat: true, model: Array.from(this.#assign, (a) => a === 1), conflicts };
        }
        const l = lit(v, this.#polarity[v]);
        this.#lim.push(this.#trail.length);
        this.#decisions.push({ lit: l, flipped: false });
        this.#enqueue(l);
        this.stats.decisions++;
        yield { type: 'decide', lit: toDimacs(l), level: this.level };
      }
    } finally {
      this.lastTrail = this.#trail.length;
    }
  }
}
function drive(it, hooks = {}) {
  let step = 0;
  for (;;) {
    const { value, done } = it.next();
    if (done) return value;
    step++;
    hooks.onEvent?.(value, step);
    if (hooks.budget != null && step >= hooks.budget) {
      const r = it.return({ sat: null, aborted: true, steps: step });
      return r.value;
    }
  }
}
function solve(f, hooks) {
  const s = new DPLLSolver(new WatchedCNF(f));
  const r = drive(s.search(), hooks);
  return { ...r, stats: s.stats.snapshot() };
}
// ---------- simple recursive DPLL for cross-checking ----------
function recursiveDPLL(clauses, assign, depth = 0) {
  let changed = true;
  const a = assign.slice();
  while (changed) {
    changed = false;
    for (const c of clauses) {
      let unassigned = -1, count = 0, sat = false;
      for (const l of c) {
        const val = a[litVar(l)];
        if (val === undefined) { count++; unassigned = l; }
        else if (val !== litNeg(l)) { sat = true; break; }
      }
      if (sat) continue;
      if (count === 0) return null;
      if (count === 1) { a[litVar(unassigned)] = !litNeg(unassigned); changed = true; }
    }
  }
  let v = -1;
  for (let i = 0; i < a.length; i++) if (a[i] === undefined) { v = i; break; }
  if (v < 0) return a;
  for (const b of [true, false]) {
    a[v] = b;
    const r = recursiveDPLL(clauses, a, depth + 1);
    if (r) return r;
  }
  a[v] = undefined;
  return null;
}
function bruteCount(f) {
  if (f.numVars > 16) throw new RangeError('too many vars for brute force');
  let count = 0n, hash = 0n;
  const model = new Array(f.numVars).fill(false);
  const total = 1 << f.numVars;
  for (let m = 0; m < total; m++) {
    for (let v = 0; v < f.numVars; v++) model[v] = ((m >> v) & 1) === 1;
    if (f.satisfiedBy(model) === -1) { count++; hash = (hash * 31n + BigInt(m)) & 0xffffffffffffn; }
  }
  return { count, hash };
}
function fnv64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}
function modelMask(model) {
  let m = 0n;
  model.forEach((b, i) => { if (b) m |= 1n << BigInt(i); });
  return m;
}
// ---------- instance generators ----------
function random3SAT(rng, n, m, name) {
  const f = new CNF(n, name);
  while (f.size + f.tautologies < m) {
    const vs = new Set();
    while (vs.size < 3) vs.add(rng.int(n));
    f.add([...vs].map((v) => lit(v, (rng() & 1) === 1)));
  }
  return f;
}
const baseEncoder = {
  atMostOne(f, vars) {
    for (let i = 0; i < vars.length; i++)
      for (let j = i + 1; j < vars.length; j++) f.add(lit(vars[i], true), lit(vars[j], true));
    return vars.length * (vars.length - 1) / 2;
  },
  tag() { return 'pairwise'; },
};
const ladderEncoder = {
  atMostOne(f, vars) {
    if (vars.length <= 4) return super.atMostOne(f, vars);
    // sequential (ladder) encoding with auxiliary vars
    const s = vars.slice(0, -1).map(() => f.newVar());
    let added = 0;
    f.add(lit(vars[0], true), lit(s[0], false)); added++;
    for (let i = 1; i < vars.length - 1; i++) {
      f.add(lit(vars[i], true), lit(s[i], false));
      f.add(lit(s[i - 1], true), lit(s[i], false));
      f.add(lit(vars[i], true), lit(s[i - 1], true));
      added += 3;
    }
    f.add(lit(vars[vars.length - 1], true), lit(s[s.length - 1], true)); added++;
    return added;
  },
  tag() { return 'ladder>' + super.tag(); },
};
Object.setPrototypeOf(ladderEncoder, baseEncoder);
function pigeonhole(p, h, enc = baseEncoder) {
  const f = new CNF(p * h, `php${p}_${h}`);
  const x = (i, j) => i * h + j;
  for (let i = 0; i < p; i++) f.add(Array.from({ length: h }, (_, j) => lit(x(i, j), false)));
  let amo = 0;
  for (let j = 0; j < h; j++) amo += enc.atMostOne(f, Array.from({ length: p }, (_, i) => x(i, j)));
  f.encoding = enc.tag() + ':' + amo;
  return f;
}
function queens(n, enc = baseEncoder) {
  const f = new CNF(n * n, `queens${n}`);
  const q = (r, c) => r * n + c;
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(q(r, c));
    f.add(row.map((v) => lit(v, false)));
    enc.atMostOne(f, row);
  }
  for (let c = 0; c < n; c++) enc.atMostOne(f, Array.from({ length: n }, (_, r) => q(r, c)));
  for (let d = -(n - 2); d <= n - 2; d++) {
    const diag = [], anti = [];
    for (let r = 0; r < n; r++) {
      const c1 = r + d, c2 = n - 1 - r + d;
      if (c1 >= 0 && c1 < n) diag.push(q(r, c1));
      if (c2 >= 0 && c2 < n) anti.push(q(r, c2));
    }
    if (diag.length > 1) baseEncoder.atMostOne(f, diag);
    if (anti.length > 1) baseEncoder.atMostOne(f, anti);
  }
  return f;
}
function coloring(edges, nodes, k, name) {
  const f = new CNF(nodes * k, name);
  const c = (v, col) => v * k + col;
  for (let v = 0; v < nodes; v++) {
    f.add(Array.from({ length: k }, (_, col) => lit(c(v, col), false)));
    baseEncoder.atMostOne(f, Array.from({ length: k }, (_, col) => c(v, col)));
  }
  for (const [a, b] of edges) for (let col = 0; col < k; col++) f.add(lit(c(a, col), true), lit(c(b, col), true));
  return f;
}
// ---------- DIMACS parsing via tagged template ----------
function dimacs(strings, ...vals) {
  const text = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ''), '');
  const header = /^p\s+cnf\s+(?<vars>\d+)\s+(?<clauses>\d+)\s*$/m.exec(text);
  if (!header) throw new SyntaxError('missing header');
  const nameM = /(?<=^c\s+)name=(?<name>\w+)/m.exec(text);
  const { vars, clauses: expected } = header.groups;
  const f = new CNF(+vars, nameM?.groups?.name ?? 'dimacs');
  const body = text.split('\n').filter((line) => !/^\s*[cp]/.test(line)).join(' ');
  const tok = /\s*(?<num>-?\d+)/y;
  let cur = [], m;
  tok.lastIndex = 0;
  while ((m = tok.exec(body)) !== null) {
    const n = Number(m.groups.num);
    if (n === 0) { f.addDimacs(...cur); cur = []; }
    else cur.push(n);
  }
  if (cur.length) f.addDimacs(...cur);
  f.expected = +expected;
  return f;
}
// ---------- preprocessing ----------
function preprocess(src) {
  let clauses = src.clauses.map((c) => [...c.lits].sort((a, b) => a - b));
  const fixed = new Map();
  const log = [];
  let rounds = 0;
  fixpoint: for (;;) {
    rounds++;
    let changed = false;
    try {
      // subsumption
      const keep = new Array(clauses.length).fill(true);
      subs: for (let i = 0; i < clauses.length; i++) {
        if (!keep[i]) continue;
        for (let j = 0; j < clauses.length; j++) {
          if (i === j || !keep[j] || clauses[i].length > clauses[j].length) continue;
          const setJ = new Set(clauses[j]);
          if (clauses[i].every((l) => setJ.has(l))) {
            if (clauses[i].length === clauses[j].length && j < i) { keep[i] = false; changed = true; continue subs; }
            keep[j] = false;
            changed = true;
          }
        }
      }
      clauses = clauses.filter((_, i) => keep[i]);
      // pure literals
      const polarity = new Map();
      for (const c of clauses) for (const l of c) {
        const v = litVar(l), bit = litNeg(l) ? 2 : 1;
        polarity.set(v, (polarity.get(v) ?? 0) | bit);
      }
      for (const [v, bits] of polarity) {
        switch (bits) {
          case 3: continue;
          case 1:
          case 2: {
            const neg = bits === 2;
            fixed.set(v, !neg);
            const before = clauses.length;
            clauses = clauses.filter((c) => !c.includes(lit(v, neg)));
            log.push(`pure x${v + 1}=${!neg} -${before - clauses.length}`);
            changed = true;
            continue fixpoint;
          }
          default:
            throw new Error('impossible polarity ' + bits);
        }
      }
    } finally {
      if (rounds > 200) log.push('round limit');
    }
    if (!changed || rounds > 200) break;
  }
  const f = new CNF(src.numVars, src.name + '/pp');
  clauses.forEach((c) => f.add(c));
  return { f, fixed, log, rounds };
}
// ---------- model enumeration generator ----------
function* enumerateModels(base, projectVars, limit) {
  const f = base.clone(base.name + '+blk');
  let found = 0;
  try {
    while (found < limit) {
      const res = solve(f);
      if (!res.sat) return found;
      found++;
      yield res.model;
      f.add(projectVars.map((v) => lit(v, res.model[v])));
    }
    return found;
  } finally {
    console.log(`enumerate ${base.name}: closed after ${found}`);
  }
}
function* eventSampler(src, every) {
  let idx = 0, skipped = 0;
  while (true) {
    const n = src.next();
    if (n.done) return { result: n.value?.sat, skipped };
    idx++;
    if (idx % every !== 0) continue;
    try {
      const cmd = yield `${idx}:${n.value.type}`;
      if (cmd === 'stop') { src.return({}); return { result: 'stopped', skipped, at: idx }; }
    } catch (e) {
      if (e && e.code === 'SKIP') {
        for (let k = 0; k < e.n; k++) {
          const r = src.next();
          if (r.done) return { result: r.value?.sat, skipped, exhausted: true };
          skipped++;
        }
        continue;
      }
      throw e;
    } finally {
      if (idx % (every * 4) === 0) console.log(`  sampler checkpoint ${idx}`);
    }
  }
}
function* chained(...gens) {
  let total = 0;
  for (const g of gens) total += (yield* g) ?? 0;
  return total;
}
function* counted(label, n) {
  for (let i = 0; i < n; i++) yield `${label}${i}`;
  return n;
}
// ---------- deep recursion ----------
function buildChain(n) { return n === 0 ? null : { size: (n % 3) + 1, next: buildChain(n - 1) }; }
function chainSum(node) { return node === null ? 0 : node.size + chainSum(node.next); }
function isEvenDepth(n) { return n === 0 ? true : isOddDepth(n - 1); }
function isOddDepth(n) { return n === 0 ? false : isEvenDepth(n - 1); }

// ---------- sections ----------
function sectionBasics() {
  console.log('== basics ==');
  out('alias', aliasProbe(3, 4, 'x', 'y'));
  out('alias2', aliasProbe(5));
  console.log('sumAll ' + sumAll(1, 2, 'q', 4, null, 8));
  const L = Literal.of(-3);
  console.log(`literal str=${String(L)} num=${+L} def=${L + ''} neg=${String(L.negate())}`);
  console.log('isLiteral ' + [Literal.isLiteral(L), Literal.isLiteral({ code: 1 }), Literal.isLiteral(null)].join(','));
  try { new Formula(3); } catch (e) { console.log('abstract: ' + (e instanceof TypeError) + ' ' + e.message); }
  const f = new CNF(4, 'tiny');
  f.addDimacs(1, -2).addDimacs(2, 3, -1).addDimacs(1, -1, 4).addDimacs(-3, -4).addDimacs(4);
  console.log(f.describe());
  console.log('clauses ' + f.clauses.map(String).join(' & '));
  console.log('clause instanceof ' + [f.clauses[0] instanceof Clause, { lits: [], size: 0 } instanceof Clause, [] instanceof Clause].join(','));
  console.log('tag ' + Object.prototype.toString.call(f.clauses[0]));
  const w = new WatchedCNF(f);
  console.log(w.describe());
  void w.watches;
  console.log(w.describe());
  const r = solve(f);
  out('tiny', { sat: r.sat, model: r.model, stats: r.stats });
  console.log('tiny check ' + f.satisfiedBy(r.model));
  const st = makeStats();
  st.decisions += 3;
  console.log('stats has ' + ['decisions' in st, 'runs' in st, 'bogus' in st].join(','));
  try { st.bogus = 1; } catch (e) { console.log('stats err ' + (e instanceof RangeError) + ' ' + e.message); }
  console.log('delete stat ' + Reflect.deleteProperty(st, 'decisions') + ' ' + st.decisions);
  try { f.addDimacs(9); } catch (e) { console.log('range ' + e.message); }
}
function sectionRandom() {
  console.log('== random 3-SAT ==');
  const rng = makeRng(12345);
  const results = [];
  for (let n = 6; n <= 12; n += 2) {
    for (const ratio of [3.0, 4.3, 6.0]) {
      const f = random3SAT(rng, n, Math.round(n * ratio), `r${n}_${ratio}`);
      const r = solve(f);
      const bf = bruteCount(f);
      const rec = recursiveDPLL(f.clauses.map((c) => c.lits), new Array(n).fill(undefined));
      const agree = (r.sat === (bf.count > 0n)) && (r.sat === (rec !== null));
      const check = r.sat ? f.satisfiedBy(r.model) : 'n/a';
      results.push({ name: f.name, sat: r.sat, models: bf.count, agree });
      console.log(`${f.name} m=${f.size} sat=${r.sat} models=${bf.count} hash=${bf.hash.toString(36)} agree=${agree} check=${check} dec=${r.stats.decisions} confl=${r.stats.conflicts}`);
    }
  }
  const bigger = [[30, 128], [40, 170], [50, 210]].map(([n, m], i) => {
    const f = random3SAT(rng, n, m, `big${i}`);
    const r = solve(f);
    const tag = r.sat ? modelMask(r.model).toString(16) : '-';
    console.log(`${f.name} n=${n} m=${f.size} sat=${r.sat} valid=${r.sat ? f.satisfiedBy(r.model) === -1 : 'n/a'} mask=${tag} stats=${JSON.stringify(r.stats)}`);
    return r.sat;
  });
  out('summary', { disagreements: results.filter((x) => !x.agree).length, satCount: results.filter((x) => x.sat).length, bigger });
}
function sectionStructured() {
  console.log('== structured ==');
  for (const [p, h] of [[3, 3], [4, 3], [5, 4], [4, 4]]) {
    for (const enc of [baseEncoder, ladderEncoder]) {
      const f = pigeonhole(p, h, enc);
      const r = solve(f);
      console.log(`${f.name} ${f.encoding} vars=${f.numVars} m=${f.size} sat=${r.sat} confl=${r.stats.conflicts} dec=${r.stats.decisions}`);
    }
  }
  for (const n of [4, 5, 6]) {
    const f = queens(n);
    const vars = [...Array(n * n).keys()];
    const boards = [];
    for (const model of enumerateModels(f, vars, 20)) {
      const cols = [];
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (model[r * n + c]) cols.push(c);
      boards.push(cols.join(''));
    }
    boards.sort();
    console.log(`queens${n}: ${boards.length} solutions [${boards.join(',')}]`);
  }
  // early break from enumeration triggers generator return/finally
  const q8 = queens(8);
  let firstThree = [];
  for (const m of enumerateModels(q8, [...Array(64).keys()], 100)) {
    firstThree.push(m.reduce((acc, b, i) => (b ? acc + (i % 8) : acc), ''));
    if (firstThree.length === 3) break;
  }
  console.log('queens8 first three ' + firstThree.join(' '));
  const cycle = (n) => Array.from({ length: n }, (_, i) => [i, (i + 1) % n]);
  const wheel = (n) => [...cycle(n), ...Array.from({ length: n }, (_, i) => [i, n])];
  const cases = [
    ['c5k2', cycle(5), 5, 2], ['c6k2', cycle(6), 6, 2], ['c5k3', cycle(5), 5, 3],
    ['w5k3', wheel(5), 6, 3], ['w6k3', wheel(6), 7, 3], ['w5k4', wheel(5), 6, 4],
  ];
  for (const [name, edges, nodes, k] of cases) {
    const f = coloring(edges, nodes, k, name);
    const r = solve(f);
    let colors = '-';
    if (r.sat) {
      colors = Array.from({ length: nodes }, (_, v) => r.model.slice(v * k, v * k + k).indexOf(true)).join('');
      const bad = edges.filter(([a, b]) => colors[a] === colors[b]).length;
      colors += bad ? '!bad' + bad : '';
    }
    console.log(`color ${name} sat=${r.sat} colors=${colors}`);
  }
}
function sectionParsing() {
  console.log('== dimacs ==');
  const n = 5;
  const f = dimacs`c example
c name=handmade
p cnf ${n} 7
1 -2 0
2 -3 0 3 -4 0
4 -5 0
5 -1 0
1 2 3 4 5 0
-1 -2 0
`;
  console.log(f.describe() + ' expected=' + f.expected);
  const r = solve(f);
  console.log('handmade sat=' + r.sat + ' conflicts=' + r.stats.conflicts);
  const g = dimacs`p cnf 3 4
1 2 0 -1 2 0 1 -2 0 -1 -2`;
  const rg = solve(g);
  console.log(`${g.name} sat=${rg.sat} tail-clause-count=${g.size}`);
  try { dimacs`c nothing here`; } catch ({ name, message }) { console.log(`parse error ${name}: ${message}`); }
  const pp = preprocess(random3SAT(makeRng(99), 10, 30, 'ppsrc'));
  console.log(`preprocess rounds=${pp.rounds} left=${pp.f.size} fixed=${JSON.stringify([...pp.fixed])}`);
  console.log('pp log ' + pp.log.join('; '));
  const src2 = new CNF(4, 'subs');
  src2.addDimacs(1, 2).addDimacs(1, 2, 3).addDimacs(-1, 3).addDimacs(-1, 3, 4).addDimacs(2, 1).addDimacs(-3, -2);
  const pp2 = preprocess(src2);
  console.log('subsumed ' + pp2.f.clauses.map(String).join(' ') + ' | ' + pp2.log.join(','));
  const same = [pp, pp2].map(({ f: pf }, i) => solve(pf).sat === solve(i === 0 ? random3SAT(makeRng(99), 10, 30, 'x') : src2).sat);
  console.log('pp preserves sat ' + same.join(','));
}
function sectionGenerators() {
  console.log('== generators ==');
  const hard = pigeonhole(5, 4);
  const events = { decide: 0, flip: 0, conflict: 0, other: 0 };
  const r = drive(new DPLLSolver(new WatchedCNF(hard)).search(), {
    onEvent(ev) {
      switch (ev.type) {
        case 'decide': events.decide++; break;
        case 'flip': events.flip++;
        // fallthrough: flips count as conflicts too
        default: if (ev.type !== 'flip') { events.other++; break; }
        case 'conflict': events.conflict++;
      }
    },
  });
  out('php events', { events, sat: r.sat });
  const s2 = new DPLLSolver(new WatchedCNF(hard));
  const aborted = drive(s2.search(), { budget: 25 });
  out('aborted', { aborted, trail: s2.lastTrail, stats: s2.stats.snapshot() });
  const samp = eventSampler(new DPLLSolver(new WatchedCNF(pigeonhole(4, 3))).search(), 5);
  const seen = [];
  let res = samp.next();
  let turn = 0;
  loop: while (!res.done) {
    seen.push(res.value);
    turn++;
    switch (turn % 4) {
      case 0: res = samp.next(); break;
      default:
        if (seen.length > 10) { res = samp.next('stop'); break loop; }
      // fallthrough
      case 2: res = samp.throw({ code: 'SKIP', n: 2 }); break;
      case 1: res = samp.next(); break;
    }
  }
  console.log('sampled ' + seen.join(' '));
  out('sampler result', res.value);
  const ch = chained(counted('a', 2), counted('b', 3), (function* () { yield 'z'; })());
  const collected = [];
  let cr;
  while (!(cr = ch.next()).done) collected.push(cr.value);
  console.log(`chained ${collected.join(',')} total=${cr.value}`);
  const g = counted('x', 5);
  g.next();
  const early = g.return(42);
  const after = g.next();
  out('return()', { early, after });
  const thrower = (function* () {
    try { yield 1; yield 2; } catch (e) { yield 'caught ' + e; } finally { yield 'fin'; }
    return 'end';
  })();
  const trace = [thrower.next().value, thrower.throw('boom').value, thrower.next().value, JSON.stringify(thrower.next())];
  console.log('throw() ' + trace.join(' / '));
}
function sectionClosures() {
  console.log('== closures ==');
  const thunks = [];
  for (let i = 0; i < 4; i++) thunks.push(() => i * i);
  const byName = {};
  for (const name of ['alpha', 'beta', 'gamma']) byName[name] = () => name.toUpperCase() + name.length;
  const keyed = [];
  const obj = { p: 1, q: 2, r: 3 };
  for (const k in obj) keyed.push(() => k + '=' + obj[k]);
  obj.q = 20;
  delete obj.r;
  console.log('thunks ' + thunks.map((t) => t()).join(','));
  console.log('byName ' + Object.keys(byName).map((k) => byName[k]()).join(','));
  console.log('keyed ' + keyed.map((t) => t()).join(','));
  const solvers = [];
  for (const [i, ratio] of [2, 4, 8].entries()) {
    const f = random3SAT(makeRng(7 + i), 10, 10 * ratio, 'cl' + i);
    solvers.push(() => ({ i, ratio, sat: solve(f).sat }));
  }
  console.log('late solvers ' + JSON.stringify(solvers.map((s) => s())));
  const counter = {
    n: 0,
    incArrow: () => typeof this,
    inc() { this.n++; return this.n; },
    later() { return [1, 2, 3].map((x) => x + this.n); },
  };
  counter.inc(); counter.inc();
  console.log(`this: ${counter.incArrow()} ${counter.later().join(',')} ${typeof void 0}`);
  const chain = buildChain(3000);
  console.log(`deep chainSum=${chainSum(chain)} even3000=${isEvenDepth(3000)} odd2999=${isOddDepth(2999)}`);
  let x = 0, y = (x++, x += 5, x * 2);
  console.log('comma ' + x + ' ' + y);
  block: {
    if (y > 10) break block;
    console.log('never printed');
  }
  const settings = { limit: 0, name: '', extra: null };
  settings.limit ||= 50;
  settings.name &&= 'renamed';
  settings.extra ??= { depth: 3 };
  settings.missing?.deep?.();
  console.log('assign ops ' + JSON.stringify(settings) + ' ' + (settings.extra?.depth ?? -1) + ' ' + (settings.nope?.() ?? 'nocall'));
  let k = 0, acc = [];
  do {
    k++;
    if (k % 3 === 0) continue;
    acc.push(k);
  } while (k < 10);
  console.log('dowhile ' + acc.join(''));
}
function sectionJson() {
  console.log('== json ==');
  const f = random3SAT(makeRng(2024), 8, 20, 'json');
  const r = solve(f);
  const payload = {
    name: f.name,
    fingerprint: fnv64(f.clauses.map(String).join('')),
    mask: r.sat ? modelMask(r.model) : null,
    clauses: f.clauses.slice(0, 3),
    stats: r.stats,
  };
  const text = JSON.stringify(payload, function (key, value) {
    if (typeof value === 'bigint') return { $big: value.toString(16) };
    if (value instanceof Clause) return { lits: value.lits.map(toDimacs) };
    if (key === 'props') return undefined;
    return value;
  });
  console.log('serialized ' + text);
  const back = JSON.parse(text, (key, value) => (value && typeof value === 'object' && '$big' in value ? BigInt('0x' + value.$big) : value));
  console.log(`revived fp=${typeof back.fingerprint} ${back.fingerprint === payload.fingerprint} mask=${String(back.mask)} props=${'props' in back.stats}`);
  const { name, stats: { decisions = -1, conflicts: c = -1, ...restStats }, clauses: [first, ...others] } = back;
  console.log(`destructured ${name} d=${decisions} c=${c} rest=${JSON.stringify(restStats)} first=${JSON.stringify(first)} others=${others.length}`);
  const computed = { [`k_${f.numVars}`]: f.size, [Symbol.toStringTag]: 'Summary', ['x'.repeat(2)]: typeof f.clauses };
  console.log('computed ' + JSON.stringify(computed) + ' ' + Object.prototype.toString.call(computed));
  const acc = {};
  Object.defineProperty(acc, 'ratio', {
    get() { return Math.round((f.size / f.numVars) * 100) / 100; },
    set(v) { this._r = v * 2; },
    enumerable: false,
  });
  acc.ratio = 4;
  console.log(`accessor ratio=${acc.ratio} _r=${acc._r} keys=${Object.keys(acc)}`);
}
async function solveAsync(f, label, order) {
  order.push('start:' + label);
  await null;
  const res = solve(f);
  order.push('done:' + label);
  if (res.sat === false && label.startsWith('mustsat')) throw new Error('expected sat ' + label);
  return { label, sat: res.sat };
}
async function* instanceStream(seed, count) {
  const rng = makeRng(seed);
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
    const n = 8 + i * 2;
    yield random3SAT(rng, n, Math.round(n * 4.3), 'stream' + i);
  }
}
async function sectionAsync() {
  console.log('== async ==');
  const order = [];
  const rng = makeRng(555);
  const batch = [
    solveAsync(random3SAT(rng, 10, 30, 'a'), 'mustsat-a', order),
    solveAsync(pigeonhole(4, 3), 'mustsat-php', order),
    solveAsync(random3SAT(rng, 10, 60, 'b'), 'b', order),
  ];
  order.push('sync-after-launch');
  const settled = await Promise.allSettled(batch);
  console.log('order ' + order.join(' '));
  console.log('settled ' + JSON.stringify(settled.map((s) => (s.status === 'fulfilled' ? s.value : s.reason.message))));
  const race = await Promise.race([Promise.resolve('first'), solveAsync(queens(4), 'q4', order).then((r) => r.label)]);
  const any = await Promise.any([Promise.reject(new Error('x')), solveAsync(queens(5), 'q5', order)]);
  console.log(`race=${race} any=${any.label}/${any.sat}`);
  try {
    await Promise.any([Promise.reject(new Error('e1')), Promise.reject(new Error('e2'))]);
  } catch (e) {
    console.log('aggregate ' + (e instanceof AggregateError) + ' ' + e.errors.map((x) => x.message).join('+'));
  }
  let idx = 0;
  const summary = [];
  for await (const f of instanceStream(77, 4)) {
    const r = solve(f);
    summary.push(`${f.name}:${f.numVars}:${r.sat ? 'S' : 'U'}`);
    if (++idx === 3) break;
  }
  console.log('stream ' + summary.join(' '));
  const all = await Promise.all([1, 2, 3].map(async (i) => {
    await null;
    const r = solve(queens(i + 3));
    return (i + 3) + (r.sat ? 'Y' : 'N');
  }));
  console.log('all ' + all.join(','));
  const micro = [];
  const p1 = Promise.resolve().then(() => micro.push('p1a')).then(() => micro.push('p1b'));
  const p2 = (async () => { micro.push('p2a'); await undefined; micro.push('p2b'); await undefined; micro.push('p2c'); })();
  queueMicrotaskLike(() => micro.push('q'));
  await Promise.all([p1, p2]);
  console.log('micro ' + micro.join(' '));
}
function queueMicrotaskLike(fn) { Promise.resolve().then(fn); }

function main() {
  sectionBasics();
  sectionRandom();
  sectionStructured();
  sectionParsing();
  sectionGenerators();
  sectionClosures();
  sectionJson();
  console.log('clauses created ' + (Clause.count() > 1000) + ' cnf instances ' + (CNF.instances > 50));
  return sectionAsync().then(() => console.log('== done ==')).catch((e) => console.log('FAILED ' + e.message));
}
main();