'use strict';
// d03: relational query engine over in-memory tables — SQL subset parser (tagged template),
// iterator-model operators (scan/filter/hash+nested-loop+merge join/aggregate/sort/limit),
// window functions, three-valued NULL logic, and a JS reference implementation for checking.

const log = (...xs) => console.log(xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ------------------------------------------------------------------ data generation
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const rnd = lcg(20240601);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const FIRST = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lu', 'Mo', 'Ned', 'Oz', 'Pia'];
const DEPTS = [
  { id: 1, name: 'eng', floor: 3, budget: 900 },
  { id: 2, name: 'ops', floor: 1, budget: 300 },
  { id: 3, name: 'sales', floor: 2, budget: 500 },
  { id: 4, name: 'legal', floor: 5, budget: 200 },
  { id: 5, name: 'void', floor: null, budget: 0 },
];
const EMP = FIRST.map((name, i) => ({
  id: 100 + i,
  name,
  dept_id: i === 15 ? null : 1 + Math.floor(rnd() * 4),
  salary: 40 + Math.floor(rnd() * 80) + (i % 3) * 5,
  manager: i < 3 ? null : 100 + Math.floor(rnd() * 3),
  hired: 2010 + Math.floor(rnd() * 12),
}));
const PROJ = ['atlas', 'borealis', 'cygnus', 'draco', 'eridanus', 'fornax'].map((p, i) => ({ id: i + 1, title: p, dept_id: 1 + (i % 4), cost: 100 + i * 37 }));
const ASSIGN = [];
for (const e of EMP) {
  const n = Math.floor(rnd() * 3);
  const used = new Set();
  for (let k = 0; k < n; k++) {
    const p = pick(PROJ);
    if (used.has(p.id)) continue;
    used.add(p.id);
    ASSIGN.push({ emp_id: e.id, proj_id: p.id, hours: 5 + Math.floor(rnd() * 30) });
  }
}
const SALES = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, emp_id: pick(EMP).id, month: 1 + (i % 6), amount: Math.floor(rnd() * 1000) / 10 }));

// ------------------------------------------------------------------ catalog
class Table {
  #rows;
  #indexes = new Map();
  constructor(name, rows) {
    this.name = name;
    this.#rows = rows.map((r) => Object.freeze({ ...r }));
    this.columns = Object.keys(rows[0] ?? {});
  }
  get rows() { return this.#rows; }
  get size() { return this.#rows.length; }
  index(col) {
    if (!this.#indexes.has(col)) {
      const idx = new Map();
      for (const r of this.#rows) { const k = r[col]; if (k !== null) (idx.get(k) ?? idx.set(k, []).get(k)).push(r); }
      this.#indexes.set(col, idx);
    }
    return this.#indexes.get(col);
  }
  *[Symbol.iterator]() { yield* this.#rows; }
}
const catalog = new Map([
  ['emp', new Table('emp', EMP)], ['dept', new Table('dept', DEPTS)], ['proj', new Table('proj', PROJ)],
  ['assign', new Table('assign', ASSIGN)], ['sales', new Table('sales', SALES)],
]);

// ------------------------------------------------------------------ SQL lexer + parser
const SQL_RE = /(?<ws>\s+)|(?<num>\d+(?:\.\d+)?)|(?<str>'(?:[^']|'')*')|(?<param>\u0000\d+\u0000)|(?<id>[A-Za-z_][\w]*(?:\.[A-Za-z_*][\w]*)?)|(?<op><>|!=|<=|>=|\|\||[-+*\/%(),=<>])/gy;
const KW = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT', 'ON', 'AS', 'AND', 'OR', 'NOT', 'ASC', 'DESC', 'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'TRUE', 'FALSE']);
const AGGS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG']);

function sql(strings, ...params) {
  const text = String.raw({ raw: strings.raw.map((s) => s) }, ...params.map((_, i) => `\u0000${i}\u0000`));
  const toks = [];
  SQL_RE.lastIndex = 0;
  let m;
  while (SQL_RE.lastIndex < text.length && (m = SQL_RE.exec(text))) {
    const { ws, num, str, param, id, op } = m.groups;
    if (ws) continue;
    if (num) toks.push({ t: 'num', v: Number(num) });
    else if (str) toks.push({ t: 'str', v: str.slice(1, -1).replace(/''/g, "'") });
    else if (param) toks.push({ t: 'lit', v: params[Number(param.slice(1, -1))] });
    else if (id) toks.push(KW.has(id.toUpperCase()) ? { t: 'kw', v: id.toUpperCase() } : { t: 'id', v: id });
    else toks.push({ t: 'op', v: op });
  }
  if (SQL_RE.lastIndex !== text.length && text.slice(SQL_RE.lastIndex).trim()) throw new SyntaxError(`sql lex error near ${text.slice(SQL_RE.lastIndex, SQL_RE.lastIndex + 8)}`);
  return new SqlParser(toks).query();
}

class SqlParser {
  constructor(toks) { this.toks = toks; this.i = 0; this.aggs = []; }
  peek(t, v) { const x = this.toks[this.i]; return x && x.t === t && (v === undefined || x.v === v); }
  take(t, v) { if (this.peek(t, v)) return this.toks[this.i++]; return null; }
  need(t, v) { const x = this.take(t, v); if (!x) throw new SyntaxError(`expected ${v ?? t} at token ${this.i} (${JSON.stringify(this.toks[this.i] ?? 'EOF')})`); return x; }
  query() {
    this.need('kw', 'SELECT');
    const distinct = !!this.take('kw', 'DISTINCT');
    const select = [];
    do {
      if (this.take('op', '*')) { select.push({ star: true }); continue; }
      const expr = this.expr();
      const alias = this.take('kw', 'AS') ? this.need('id').v : expr.k === 'col' ? expr.name.split('.').pop() : `c${select.length}`;
      select.push({ expr, alias });
    } while (this.take('op', ','));
    this.need('kw', 'FROM');
    const from = this.tableRef();
    const joins = [];
    for (;;) {
      const left = !!this.take('kw', 'LEFT');
      if (!this.take('kw', 'JOIN')) { if (left) throw new SyntaxError('LEFT without JOIN'); break; }
      const ref = this.tableRef();
      this.need('kw', 'ON');
      joins.push({ ...ref, on: this.expr(), left });
    }
    const where = this.take('kw', 'WHERE') ? this.expr() : null;
    let groupBy = [];
    if (this.take('kw', 'GROUP')) { this.need('kw', 'BY'); groupBy = this.list(() => this.expr()); }
    const having = this.take('kw', 'HAVING') ? this.expr() : null;
    let orderBy = [];
    if (this.take('kw', 'ORDER')) {
      this.need('kw', 'BY');
      orderBy = this.list(() => ({ expr: this.expr(), desc: !!this.take('kw', 'DESC') || (this.take('kw', 'ASC'), false) }));
    }
    const limit = this.take('kw', 'LIMIT') ? this.need('num').v : Infinity;
    const offset = this.take('kw', 'OFFSET') ? this.need('num').v : 0;
    if (this.i !== this.toks.length) throw new SyntaxError(`trailing tokens at ${this.i}`);
    return { distinct, select, from, joins, where, groupBy, having, orderBy, limit, offset, aggs: this.aggs };
  }
  list(f) { const xs = [f()]; while (this.take('op', ',')) xs.push(f()); return xs; }
  tableRef() {
    const name = this.need('id').v;
    const alias = this.peek('id') ? this.need('id').v : name;
    if (!catalog.has(name)) throw new ReferenceError(`no table ${name}`);
    return { name, alias };
  }
  expr() { return this.or(); }
  or() { let l = this.and(); while (this.take('kw', 'OR')) l = { k: 'or', l, r: this.and() }; return l; }
  and() { let l = this.not(); while (this.take('kw', 'AND')) l = { k: 'and', l, r: this.not() }; return l; }
  not() { return this.take('kw', 'NOT') ? { k: 'not', e: this.not() } : this.cmp(); }
  cmp() {
    const l = this.add();
    if (this.take('kw', 'IS')) { const neg = !!this.take('kw', 'NOT'); this.need('kw', 'NULL'); return { k: 'isnull', e: l, neg }; }
    const negated = !!this.take('kw', 'NOT');
    if (this.take('kw', 'IN')) { this.need('op', '('); const items = this.list(() => this.add()); this.need('op', ')'); return { k: 'in', e: l, items, neg: negated }; }
    if (this.take('kw', 'BETWEEN')) { const lo = this.add(); this.need('kw', 'AND'); return { k: 'between', e: l, lo, hi: this.add(), neg: negated }; }
    if (this.take('kw', 'LIKE')) return { k: 'like', e: l, pat: this.add(), neg: negated };
    if (negated) throw new SyntaxError('dangling NOT');
    for (const op of ['=', '<>', '!=', '<=', '>=', '<', '>']) if (this.take('op', op)) return { k: 'bin', op: op === '!=' ? '<>' : op, l, r: this.add() };
    return l;
  }
  add() { let l = this.mul(); for (let t; (t = this.take('op', '+') || this.take('op', '-') || this.take('op', '||'));) l = { k: 'bin', op: t.v, l, r: this.mul() }; return l; }
  mul() { let l = this.unary(); for (let t; (t = this.take('op', '*') || this.take('op', '/') || this.take('op', '%'));) l = { k: 'bin', op: t.v, l, r: this.unary() }; return l; }
  unary() { return this.take('op', '-') ? { k: 'neg', e: this.unary() } : this.primary(); }
  primary() {
    let t;
    if ((t = this.take('num')) || (t = this.take('str')) || (t = this.take('lit'))) return { k: 'lit', v: t.v };
    if (this.take('kw', 'NULL')) return { k: 'lit', v: null };
    if (this.take('kw', 'TRUE')) return { k: 'lit', v: true };
    if (this.take('kw', 'FALSE')) return { k: 'lit', v: false };
    if (this.take('op', '(')) { const e = this.expr(); this.need('op', ')'); return e; }
    if (this.take('kw', 'CASE')) {
      const whens = [];
      while (this.take('kw', 'WHEN')) { const c = this.expr(); this.need('kw', 'THEN'); whens.push([c, this.expr()]); }
      const other = this.take('kw', 'ELSE') ? this.expr() : { k: 'lit', v: null };
      this.need('kw', 'END');
      return { k: 'case', whens, other };
    }
    const id = this.need('id').v;
    if (this.take('op', '(')) {
      const fn = id.toUpperCase();
      const distinct = !!this.take('kw', 'DISTINCT');
      const arg = this.take('op', '*') ? null : this.expr();
      const extra = this.take('op', ',') ? this.expr() : null;
      this.need('op', ')');
      if (AGGS.has(fn)) { const a = { k: 'agg', fn, arg, distinct, extra, slot: this.aggs.length }; this.aggs.push(a); return a; }
      return { k: 'call', fn, args: [arg, extra].filter(Boolean) };
    }
    return { k: 'col', name: id };
  }
}

// ------------------------------------------------------------------ expression evaluation (3-valued)
const SCALAR = {
  UPPER: (s) => s?.toUpperCase() ?? null,
  LOWER: (s) => s?.toLowerCase() ?? null,
  LENGTH: (s) => (s == null ? null : String(s).length),
  COALESCE: (a, b) => a ?? b,
  ABS: (x) => (x == null ? null : Math.abs(x)),
  ROUND: (x, d = 0) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d),
};
function likeToRegex(p) {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/(?<!\\)%/g, '.*').replace(/(?<!\\)_/g, '.') + '$', 's');
}
function resolveCol(row, name) {
  if (name in row) return row[name];
  const tail = name.includes('.') ? name.split('.').pop() : name;
  const hits = Object.keys(row).filter((k) => k.endsWith('.' + tail) || k === tail);
  if (hits.length === 1) return row[hits[0]];
  if (hits.length > 1 && !name.includes('.')) throw new ReferenceError(`ambiguous column ${name}`);
  if (hits.length > 1) return row[hits.find((h) => h === name)] ?? null;
  throw new ReferenceError(`unknown column ${name}`);
}
function ev(e, row, aggVals) {
  switch (e.k) {
    case 'lit': return e.v;
    case 'col': return resolveCol(row, e.name);
    case 'agg':
      if (!aggVals) throw new SyntaxError('aggregate in row context');
      return aggVals[e.slot];
    case 'neg': { const v = ev(e.e, row, aggVals); return v == null ? null : -v; }
    case 'not': { const v = ev(e.e, row, aggVals); return v == null ? null : !v; }
    case 'and': {
      const l = ev(e.l, row, aggVals);
      if (l === false) return false;
      const r = ev(e.r, row, aggVals);
      if (r === false) return false;
      return l == null || r == null ? null : true;
    }
    case 'or': {
      const l = ev(e.l, row, aggVals);
      if (l === true) return true;
      const r = ev(e.r, row, aggVals);
      if (r === true) return true;
      return l == null || r == null ? null : false;
    }
    case 'isnull': { const v = ev(e.e, row, aggVals) == null; return e.neg ? !v : v; }
    case 'in': {
      const v = ev(e.e, row, aggVals);
      if (v == null) return null;
      let sawNull = false;
      for (const it of e.items) { const x = ev(it, row, aggVals); if (x == null) sawNull = true; else if (x === v) return !e.neg; }
      return sawNull ? null : e.neg;
    }
    case 'between': {
      const [v, lo, hi] = [e.e, e.lo, e.hi].map((x) => ev(x, row, aggVals));
      if (v == null || lo == null || hi == null) return null;
      return (v >= lo && v <= hi) !== e.neg;
    }
    case 'like': {
      const v = ev(e.e, row, aggVals), p = ev(e.pat, row, aggVals);
      return v == null || p == null ? null : likeToRegex(p).test(v) !== e.neg;
    }
    case 'case': {
      for (const [c, r] of e.whens) if (ev(c, row, aggVals) === true) return ev(r, row, aggVals);
      return ev(e.other, row, aggVals);
    }
    case 'call': {
      const f = SCALAR[e.fn];
      if (!f) throw new ReferenceError(`no function ${e.fn}`);
      return f(...e.args.map((a) => ev(a, row, aggVals)));
    }
    case 'bin': {
      const l = ev(e.l, row, aggVals), r = ev(e.r, row, aggVals);
      if (l == null || r == null) return null;
      switch (e.op) {
        case '=': return l === r;
        case '<>': return l !== r;
        case '<': return l < r;
        case '>': return l > r;
        case '<=': return l <= r;
        case '>=': return l >= r;
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return l % r;
        case '||': return String(l) + String(r);
      }
    }
  }
  throw new Error(`bad expr ${e.k}`);
}

// ------------------------------------------------------------------ operators (iterator model)
const trace = [];
class Operator {
  constructor(label) {
    if (new.target === Operator) throw new TypeError('abstract');
    this.label = label;
    this.produced = 0;
  }
  *rows() { throw new Error('abstract rows'); }
  *[Symbol.iterator]() {
    try {
      for (const r of this.rows()) { this.produced++; yield r; }
    } finally {
      trace.push(`${this.label}:${this.produced}`);
    }
  }
  explain(depth = 0) { return ['  '.repeat(depth) + this.label, ...this.inputs().flatMap((i) => i.explain(depth + 1))]; }
  inputs() { return []; }
}
class Scan extends Operator {
  constructor(table, alias) { super(`Scan(${table.name} ${alias})`); this.table = table; this.alias = alias; }
  *rows() {
    for (const r of this.table) {
      const o = {};
      for (const k in r) o[`${this.alias}.${k}`] = r[k];
      yield o;
    }
  }
}
class Unary extends Operator {
  constructor(label, input) { super(label); this.input = input; }
  inputs() { return [this.input]; }
}
class Filter extends Unary {
  constructor(input, pred) { super('Filter', input); this.pred = pred; }
  *rows() { for (const r of this.input) if (ev(this.pred, r) === true) yield r; }
}
class Limit extends Unary {
  constructor(input, n, off) { super(`Limit(${n},${off})`, input); this.n = n; this.off = off; }
  *rows() {
    if (this.n <= 0) return;
    let i = 0;
    for (const r of this.input) {
      if (i++ < this.off) continue;
      yield r;
      if (i - this.off >= this.n) return;
    }
  }
}
class Sort extends Unary {
  constructor(input, keys) { super('Sort', input); this.keys = keys; }
  *rows() {
    const all = [...this.input].map((r, i) => ({ r, i, k: this.keys.map(({ expr, agg }) => ev(expr, r, agg ? r.__agg : undefined)) }));
    all.sort((a, b) => {
      for (let j = 0; j < this.keys.length; j++) {
        const [x, y] = [a.k[j], b.k[j]];
        if (x === y) continue;
        const c = x == null ? 1 : y == null ? -1 : x < y ? -1 : 1; // NULLS LAST ascending
        return this.keys[j].desc ? -c : c;
      }
      return a.i - b.i;
    });
    for (const { r } of all) yield r;
  }
}
class Join extends Operator {
  constructor(label, left, right, on, isLeft) { super(label); Object.assign(this, { left, right, on, isLeft }); }
  inputs() { return [this.left, this.right]; }
  nullRow(sample) { return Object.fromEntries(Object.keys(sample).map((k) => [k, null])); }
}
class NestedLoopJoin extends Join {
  constructor(l, r, on, isLeft) { super(`NLJoin${isLeft ? '[L]' : ''}`, l, r, on, isLeft); }
  *rows() {
    const right = [...this.right];
    const pad = right.length ? this.nullRow(right[0]) : {};
    outer: for (const lr of this.left) {
      let matched = false;
      for (const rr of right) {
        const row = { ...lr, ...rr };
        switch (ev(this.on, row)) {
          case true: matched = true; yield row; break;
          case null: case false: default: continue;
        }
      }
      if (!matched && this.isLeft) { yield { ...lr, ...pad }; continue outer; }
    }
  }
}
class HashJoin extends Join {
  constructor(l, r, on, isLeft, lk, rk) { super(`HashJoin${isLeft ? '[L]' : ''}(${lk}=${rk})`, l, r, on, isLeft); this.lk = lk; this.rk = rk; }
  *rows() {
    const table = new Map();
    let sample = null;
    for (const rr of this.right) {
      sample ??= rr;
      const k = rr[this.rk];
      if (k == null) continue;
      (table.get(k) ?? table.set(k, []).get(k)).push(rr);
    }
    const pad = sample ? this.nullRow(sample) : {};
    for (const lr of this.left) {
      const bucket = lr[this.lk] == null ? undefined : table.get(lr[this.lk]);
      if (bucket) for (const rr of bucket) yield { ...lr, ...rr };
      else if (this.isLeft) yield { ...lr, ...pad };
    }
  }
}
class Aggregate extends Unary {
  constructor(input, groupBy, aggs) { super(`Aggregate(${groupBy.length})`, input); this.groupBy = groupBy; this.aggs = aggs; }
  *rows() {
    const groups = new Map();
    for (const r of this.input) {
      const keyVals = this.groupBy.map((g) => ev(g, r));
      const key = JSON.stringify(keyVals);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { first: r, states: this.aggs.map(() => ({ n: 0, sum: 0, min: null, max: null, seen: new Set(), list: [] })) }));
      this.aggs.forEach((a, i) => {
        const st = g.states[i];
        const v = a.arg ? ev(a.arg, r) : 1;
        if (v == null) return;
        if (a.distinct) { if (st.seen.has(v)) return; st.seen.add(v); }
        st.n++;
        if (typeof v === 'number') st.sum += v;
        st.min = st.min === null || v < st.min ? v : st.min;
        st.max = st.max === null || v > st.max ? v : st.max;
        st.list.push(v);
      });
    }
    if (groups.size === 0 && this.groupBy.length === 0) groups.set('[]', { first: {}, states: this.aggs.map(() => ({ n: 0, sum: 0, min: null, max: null, list: [] })) });
    for (const { first, states } of groups.values()) {
      const vals = this.aggs.map((a, i) => {
        const s = states[i];
        switch (a.fn) {
          case 'COUNT': return s.n;
          case 'SUM': return s.n ? Math.round(s.sum * 100) / 100 : null;
          case 'AVG': return s.n ? Math.round((s.sum / s.n) * 100) / 100 : null;
          case 'MIN': return s.min;
          case 'MAX': return s.max;
          case 'STRING_AGG': return s.n ? s.list.join(a.extra ? ev(a.extra, {}) : ',') : null;
        }
        return undefined;
      });
      yield Object.defineProperty({ ...first }, '__agg', { value: vals, enumerable: false });
    }
  }
}
class Project extends Unary {
  constructor(input, select, grouped, distinct) { super(`Project${distinct ? '[D]' : ''}`, input); Object.assign(this, { select, grouped, distinct }); }
  *rows() {
    const seen = new Set();
    for (const r of this.input) {
      const o = {};
      for (const s of this.select) {
        if (s.star) { for (const k of Object.keys(r)) o[k.split('.').pop()] ??= r[k]; continue; }
        o[s.alias] = ev(s.expr, r, this.grouped ? r.__agg : undefined);
      }
      if (this.distinct) { const k = JSON.stringify(o); if (seen.has(k)) continue; seen.add(k); }
      Object.defineProperty(o, '__src', { value: r, enumerable: false });
      yield o;
    }
  }
}

// ------------------------------------------------------------------ planner
function equiKeys(on, leftCols, rightCols) {
  if (on.k !== 'bin' || on.op !== '=' || on.l.k !== 'col' || on.r.k !== 'col') return null;
  const [a, b] = [on.l.name, on.r.name];
  if (leftCols.has(a) && rightCols.has(b)) return [a, b];
  if (leftCols.has(b) && rightCols.has(a)) return [b, a];
  return null;
}
function plan(q, { forceNL = false } = {}) {
  const cols = (ref) => new Set(catalog.get(ref.name).columns.map((c) => `${ref.alias}.${c}`));
  let op = new Scan(catalog.get(q.from.name), q.from.alias);
  let leftCols = cols(q.from);
  for (const j of q.joins) {
    const right = new Scan(catalog.get(j.name), j.alias);
    const rc = cols(j);
    const keys = forceNL ? null : equiKeys(j.on, leftCols, rc);
    op = keys ? new HashJoin(op, right, j.on, j.left, ...keys) : new NestedLoopJoin(op, right, j.on, j.left);
    leftCols = new Set([...leftCols, ...rc]);
  }
  if (q.where) op = new Filter(op, q.where);
  const grouped = q.groupBy.length > 0 || q.aggs.length > 0;
  if (grouped) {
    op = new Aggregate(op, q.groupBy, q.aggs);
    if (q.having) op = new Filter(op, q.having);
  }
  const aliasMap = new Map(q.select.filter((s) => !s.star).map((s) => [s.alias, s.expr]));
  if (q.orderBy.length) {
    const keys = q.orderBy.map(({ expr, desc }) => ({ expr: expr.k === 'col' && aliasMap.has(expr.name) ? aliasMap.get(expr.name) : expr, desc, agg: grouped }));
    op = new Sort(op, keys);
  }
  if (grouped && q.having) {
    // having may reference aggregates: patch filter predicate evaluation to supply agg values
    const f = op instanceof Sort ? op.input : op;
    const pred = f.pred;
    f.rows = function* () { for (const r of this.input) if (ev(pred, r, r.__agg) === true) yield r; };
  }
  op = new Project(op, q.select, grouped, q.distinct);
  if (q.limit !== Infinity || q.offset) op = new Limit(op, q.limit, q.offset);
  return op;
}
function run(q, opts) {
  trace.length = 0;
  const p = plan(q, opts);
  const rows = [...p];
  return { rows, plan: p, trace: trace.slice() };
}
const fmtRow = (r) => Object.entries(r).map(([k, v]) => `${k}=${v === null ? 'NULL' : v}`).join(' ');

// ------------------------------------------------------------------ window functions (builder API)
function windowed(rows, { partition = [], order = [], fns }) {
  const parts = new Map();
  rows.forEach((r, i) => {
    const k = JSON.stringify(partition.map((c) => r[c]));
    (parts.get(k) ?? parts.set(k, []).get(k)).push({ r, i });
  });
  const outRows = rows.map((r) => ({ ...r }));
  const cmp = (a, b) => {
    for (const [c, dir = 'asc'] of order) {
      if (a.r[c] === b.r[c]) continue;
      return (a.r[c] < b.r[c] ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return a.i - b.i;
  };
  for (const [, members] of [...parts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    members.sort(cmp);
    let rank = 0, dense = 0, prevKey;
    let running = 0;
    members.forEach((m, pos) => {
      const key = JSON.stringify(order.map(([c]) => m.r[c]));
      if (key !== prevKey) { rank = pos + 1; dense++; prevKey = key; }
      const o = outRows[m.i];
      for (const [alias, spec] of Object.entries(fns)) {
        const [fn, arg, off = 1, frame] = Array.isArray(spec) ? spec : [spec];
        switch (fn) {
          case 'row_number': o[alias] = pos + 1; break;
          case 'rank': o[alias] = rank; break;
          case 'dense_rank': o[alias] = dense; break;
          case 'lag': o[alias] = members[pos - off]?.r[arg] ?? null; break;
          case 'lead': o[alias] = members[pos + off]?.r[arg] ?? null; break;
          case 'running_sum': running += m.r[arg] ?? 0; o[alias] = Math.round(running * 10) / 10; break;
          case 'moving_avg': {
            const win = members.slice(Math.max(0, pos - (frame ?? 2)), pos + 1).map((x) => x.r[arg]);
            o[alias] = Math.round((win.reduce((a, b) => a + b, 0) / win.length) * 10) / 10;
            break;
          }
          case 'ntile': o[alias] = Math.floor((pos * arg) / members.length) + 1; break;
          case 'first_value': o[alias] = members[0].r[arg]; break;
          case 'pct': o[alias] = members.length > 1 ? Math.round(((rank - 1) / (members.length - 1)) * 100) : 0; break;
          default: throw new RangeError(`unknown window fn ${fn}`);
        }
      }
    });
  }
  return outRows;
}

// ------------------------------------------------------------------ reference implementations (plain JS)
const ref = {
  deptHeadcount() {
    const m = new Map();
    for (const e of EMP) { if (e.dept_id == null || e.salary <= 50) continue; const d = DEPTS.find((x) => x.id === e.dept_id); m.set(d.name, (m.get(d.name) ?? 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  },
  projectHours() {
    const byProj = {};
    for (const { proj_id, hours } of ASSIGN) byProj[proj_id] = (byProj[proj_id] ?? 0) + hours;
    return PROJ.map(({ id, title }) => [title, byProj[id] ?? null]);
  },
};

// ------------------------------------------------------------------ queries
const minSalary = 50;
const QUERIES = [
  ['headcount', sql`SELECT d.name AS dept, COUNT(*) AS n, AVG(e.salary) AS avg_sal, MAX(e.salary) AS top
      FROM emp e JOIN dept d ON e.dept_id = d.id WHERE e.salary > ${minSalary}
      GROUP BY d.name ORDER BY n DESC, dept`],
  ['left-join-nulls', sql`SELECT d.name, COUNT(e.id) AS staff, SUM(e.salary) AS payroll FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY staff, d.name`],
  ['project-hours', sql`SELECT p.title, SUM(a.hours) AS hours, COUNT(DISTINCT a.emp_id) AS people
      FROM proj p LEFT JOIN assign a ON a.proj_id = p.id GROUP BY p.title ORDER BY p.title`],
  ['case+like', sql`SELECT e.name, CASE WHEN e.salary >= 100 THEN 'high' WHEN e.salary >= 70 THEN 'mid' ELSE 'low' END AS band,
      UPPER(e.name) || '-' || COALESCE(e.dept_id, 0) AS tag FROM emp e WHERE e.name LIKE '%o%' OR e.name LIKE '_y%' ORDER BY e.name`],
  ['in/between/null', sql`SELECT e.name, e.dept_id, e.manager FROM emp e
      WHERE (e.dept_id IN (1, 3, NULL) OR e.dept_id IS NULL) AND e.hired BETWEEN 2012 AND 2019 AND NOT e.manager IS NULL
      ORDER BY e.hired DESC, e.name LIMIT 6`],
  ['self-join', sql`SELECT e.name AS worker, m.name AS boss, e.salary - m.salary AS diff FROM emp e JOIN emp m ON e.manager = m.id
      WHERE e.salary > m.salary ORDER BY diff DESC LIMIT 5`],
  ['having', sql`SELECT s.emp_id, COUNT(*) AS deals, SUM(s.amount) AS total, STRING_AGG(s.month, '/') AS months
      FROM sales s GROUP BY s.emp_id HAVING COUNT(*) >= 3 AND SUM(s.amount) > 100 ORDER BY total DESC`],
  ['three-way', sql`SELECT d.name AS dept, p.title, SUM(a.hours) AS h FROM assign a JOIN emp e ON a.emp_id = e.id
      JOIN proj p ON p.id = a.proj_id JOIN dept d ON d.id = p.dept_id WHERE d.floor <> 1
      GROUP BY d.name, p.title ORDER BY h DESC, dept LIMIT 5 OFFSET 1`],
  ['distinct', sql`SELECT DISTINCT e.hired % 4 AS bucket, e.dept_id FROM emp e WHERE e.dept_id IS NOT NULL ORDER BY bucket, e.dept_id`],
  ['global-agg', sql`SELECT COUNT(*) AS n, MIN(s.amount) AS lo, MAX(s.amount) AS hi, ROUND(AVG(s.amount), 1) AS mean FROM sales s WHERE s.month <> 3`],
  ['empty-agg', sql`SELECT COUNT(*) AS n, SUM(e.salary) AS s FROM emp e WHERE e.salary > 1000`],
  ['non-equi', sql`SELECT e.name, p.title FROM emp e JOIN proj p ON p.cost < e.salary * 2 AND p.dept_id = e.dept_id ORDER BY e.name, p.title LIMIT 7`],
];

const plansShown = new Set(['headcount', 'three-way', 'non-equi']);
for (const [name, q] of QUERIES) {
  let res;
  try {
    res = run(q);
  } catch (e) {
    log(`!! ${name}: ${e.message}`);
    continue;
  }
  log(`== ${name} (${res.rows.length} rows)`);
  if (plansShown.has(name)) for (const line of res.plan.explain()) log('   plan ' + line);
  for (const r of res.rows.slice(0, 8)) log('   ' + fmtRow(r));
  log('   trace ' + res.trace.join(' '));
  if (q.joins.length) {
    const nl = run(q, { forceNL: true });
    log(`   nl-join agrees: ${JSON.stringify(nl.rows) === JSON.stringify(res.rows)}`);
  }
}

// cross-check against reference implementation
{
  const hc = run(sql`SELECT d.name AS dept, COUNT(*) AS n FROM emp e JOIN dept d ON e.dept_id = d.id WHERE e.salary > ${minSalary} GROUP BY d.name ORDER BY n DESC, dept`).rows.map(({ dept, n }) => [dept, n]);
  log('ref headcount agree', JSON.stringify(hc) === JSON.stringify(ref.deptHeadcount()), hc);
  const ph = run(QUERIES[2][1]).rows.map(({ title, hours }) => [title, hours]);
  log('ref project-hours agree', JSON.stringify(ph) === JSON.stringify(ref.projectHours()));
}

// window functions
{
  const base = run(sql`SELECT e.name, d.name AS dept, e.salary, e.hired FROM emp e JOIN dept d ON d.id = e.dept_id`).rows;
  const w = windowed(base, {
    partition: ['dept'],
    order: [['salary', 'desc'], ['name']],
    fns: { rn: 'row_number', rk: 'rank', drk: 'dense_rank', prev: ['lag', 'salary'], next2: ['lead', 'name', 2], cum: ['running_sum', 'salary'], q: ['ntile', 3], top: ['first_value', 'name'], pct: 'pct' },
  });
  log('== window by dept');
  for (const r of [...w].sort((a, b) => (a.dept < b.dept ? -1 : a.dept > b.dept ? 1 : a.rn - b.rn))) log('   ' + fmtRow(r));
  const sales = run(sql`SELECT s.month, SUM(s.amount) AS total FROM sales s GROUP BY s.month ORDER BY s.month`).rows;
  const ws = windowed(sales, { order: [['month']], fns: { cum: ['running_sum', 'total'], ma3: ['moving_avg', 'total', 1, 2], delta: ['lag', 'total'] } });
  log('== window monthly');
  for (const r of ws) log(`   m${r.month} total=${r.total} cum=${r.cum} ma3=${r.ma3} prev=${r.delta ?? '-'}`);
  try { windowed(sales, { fns: { x: 'median' } }); } catch (e) { log('   window error:', e.message); }
}

// error paths
log('== errors');
const badQueries = [
  () => sql`SELECT x FROM nowhere`,
  () => sql`SELECT e.name FROM emp e WHERE`,
  () => run(sql`SELECT e.nope FROM emp e`),
  () => run(sql`SELECT id FROM emp e JOIN dept d ON e.dept_id = d.id`),
  () => sql`SELECT e.name FROM emp e LEFT dept d`,
  () => run(sql`SELECT FOO(e.name) FROM emp e`),
  () => sql`SELECT e.name FROM emp e WHERE e.id NOT 3`,
];
badQueries.forEach((f, i) => {
  try { f(); log(`   #${i} no error`); } catch (e) { log(`   #${i} ${e instanceof SyntaxError ? 'Syntax' : e instanceof ReferenceError ? 'Ref' : 'Err'}: ${e.message}`); }
});

// three-valued logic truth table
log('== 3VL');
const vals = [true, false, null];
const tv = (v) => (v === null ? 'N' : v ? 'T' : 'F');
for (const a of vals) {
  const row = vals.map((b) => {
    const and = ev({ k: 'and', l: { k: 'lit', v: a }, r: { k: 'lit', v: b } }, {});
    const or = ev({ k: 'or', l: { k: 'lit', v: a }, r: { k: 'lit', v: b } }, {});
    return `${tv(a)}${tv(b)}:and=${tv(and)},or=${tv(or)}`;
  });
  log('   ' + row.join('  ') + `  not=${tv(ev({ k: 'not', e: { k: 'lit', v: a } }, {}))}`);
}

// lazy pipeline: limit closes upstream generators early (finally clauses run)
log('== laziness');
{
  const q = sql`SELECT e.name FROM emp e JOIN assign a ON a.emp_id = e.id WHERE a.hours > 10 LIMIT 2`;
  const r = run(q);
  log('   rows', r.rows.map((x) => x.name), 'trace', r.trace.join(' '));
  const it = plan(q)[Symbol.iterator]();
  trace.length = 0;
  const first = it.next();
  const early = it.return('stop');
  log('   manual', first.value, early, trace.join(' '));
}

// summary with a replacer/reviver roundtrip
const summary = JSON.stringify({ tables: [...catalog.values()].map((t) => [t.name, t.size]), idx: [...catalog.get('emp').index('dept_id')].map(([k, v]) => [k, v.length]) }, (k, v) => (Array.isArray(v) && v.length === 2 && typeof v[1] === 'number' ? `${v[0]}:${v[1]}` : v));
log('summary', summary);
const revived = JSON.parse(summary, (k, v) => (typeof v === 'string' && /^(?<name>\w+):(?<n>\d+)$/.test(v) ? Number(v.split(':')[1]) : v));
log('revived', revived.tables.reduce((a, b) => a + b, 0), revived.idx.reduce((a, b) => a + b, 0));
