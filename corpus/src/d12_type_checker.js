'use strict';
// d12: Hindley-Milner type inference for a tiny lambda language

// ---------- lexer (sticky regex, named groups) ----------
const TOKEN_RE = /(?<ws>\s+|--[^\n]*)|(?<num>\d+)|(?<str>"(?:[^"\\]|\\.)*")|(?<id>[a-zA-Z_][a-zA-Z0-9_']*)|(?<op>->|=>|==|<=|>=|&&|\|\||::|[\\\.()\[\],=+\-*<>;:{}|])/y;
const KEYWORDS = new Set(['let', 'rec', 'in', 'if', 'then', 'else', 'fun', 'true', 'false', 'match', 'with', 'and']);

class Token {
  constructor(kind, text, pos) { this.kind = kind; this.text = text; this.pos = pos; }
  is(kind, text) { return this.kind === kind && (text === undefined || this.text === text); }
  toString() { return `${this.kind}(${this.text})@${this.pos}`; }
}

function* lex(src) {
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    const pos = TOKEN_RE.lastIndex;
    const m = TOKEN_RE.exec(src);
    if (m === null) throw new SyntaxError(`unexpected ${JSON.stringify(src[pos])} at ${pos}`);
    const g = m.groups;
    if (g.ws !== undefined) continue;
    if (g.num !== undefined) yield new Token('num', g.num, pos);
    else if (g.str !== undefined) yield new Token('str', JSON.parse(g.str), pos);
    else if (g.id !== undefined) yield new Token(KEYWORDS.has(g.id) ? 'kw' : 'id', g.id, pos);
    else yield new Token('op', g.op, pos);
  }
  yield new Token('eof', '', src.length);
}

// ---------- AST (class hierarchy, 3+ deep) ----------
class Node {
  static count = 0;
  constructor() { Node.count++; }
  *children() {}
  *walk(depth = 0) {
    yield [this, depth];
    for (const c of this.children()) yield* c.walk(depth + 1);
  }
  get size() { let n = 0; for (const _ of this.walk()) n++; return n; }
}
class Lit extends Node {
  constructor(value) { super(); this.value = value; }
  get tag() { return 'Lit'; }
}
class Var extends Node {
  constructor(name) { super(); this.name = name; }
  get tag() { return 'Var'; }
}
class Lam extends Node {
  constructor(param, body) { super(); this.param = param; this.body = body; }
  *children() { yield this.body; }
  get tag() { return 'Lam'; }
}
class App extends Node {
  constructor(fn, arg) { super(); this.fn = fn; this.arg = arg; }
  *children() { yield this.fn; yield this.arg; }
  get tag() { return 'App'; }
}
class If extends Node {
  constructor(c, t, e) { super(); Object.assign(this, { c, t, e }); }
  *children() { yield* [this.c, this.t, this.e]; }
  get tag() { return 'If'; }
}
class Binding extends Node {
  constructor(name, value, body) { super(); this.name = name; this.value = value; this.body = body; }
  *children() { yield this.value; yield this.body; }
  get recursive() { return false; }
  get tag() { return 'Let'; }
}
class LetRec extends Binding {
  get recursive() { return true; }
  get tag() { return 'LetRec' + super.tag.slice(3); }
}
class LetRecAnd extends LetRec {
  constructor(binds, body) { super(binds[0][0], binds[0][1], body); this.binds = binds; }
  *children() { for (const [, v] of this.binds) yield v; yield this.body; }
  get tag() { return super.tag + 'And'; }
}
class ListLit extends Node {
  constructor(items) { super(); this.items = items; }
  *children() { yield* this.items; }
  get tag() { return 'List'; }
}
class Tuple extends Node {
  constructor(items) { super(); this.items = items; }
  *children() { yield* this.items; }
  get tag() { return 'Tuple'; }
}
class Annot extends Node {
  constructor(expr, type) { super(); this.expr = expr; this.type = type; }
  *children() { yield this.expr; }
  get tag() { return 'Annot'; }
}

// ---------- parser (Pratt for binary ops) ----------
const BINOPS = {
  '||': [1, 'or'], '&&': [2, 'and'],
  '==': [3, 'eq'], '<': [3, 'lt'], '<=': [3, 'le'], '>': [3, 'gt'], '>=': [3, 'ge'],
  '::': [4, 'cons', true],
  '+': [5, 'add'], '-': [5, 'sub'], '*': [6, 'mul'],
};

class Parser {
  #toks; #i = 0;
  constructor(src) { this.#toks = [...lex(src)]; }
  get #peek() { return this.#toks[this.#i]; }
  #next() { return this.#toks[this.#i++]; }
  #accept(kind, text) { if (this.#peek.is(kind, text)) return this.#next(); return null; }
  #expect(kind, text) {
    const t = this.#accept(kind, text);
    if (!t) throw new SyntaxError(`expected ${text ?? kind} but got ${this.#peek}`);
    return t;
  }
  parseProgram() {
    const e = this.expr();
    this.#expect('eof');
    return e;
  }
  expr() {
    const t = this.#peek;
    if (t.is('kw', 'let')) return this.#let();
    if (t.is('kw', 'if')) {
      this.#next();
      const c = this.expr(); this.#expect('kw', 'then');
      const a = this.expr(); this.#expect('kw', 'else');
      return new If(c, a, this.expr());
    }
    if (t.is('op', '\\') || t.is('kw', 'fun')) {
      this.#next();
      const params = [];
      while (this.#peek.is('id')) params.push(this.#next().text);
      if (!params.length) throw new SyntaxError('lambda needs params at ' + t.pos);
      this.#accept('op', '.') ?? this.#expect('op', '->');
      const body = this.expr();
      return params.reduceRight((b, p) => new Lam(p, b), body);
    }
    return this.binary(0);
  }
  #let() {
    this.#next();
    const rec = !!this.#accept('kw', 'rec');
    const binds = [];
    do {
      const name = this.#expect('id').text;
      const params = [];
      while (this.#peek.is('id')) params.push(this.#next().text);
      this.#expect('op', '=');
      const value = params.reduceRight((b, p) => new Lam(p, b), this.expr());
      binds.push([name, value]);
    } while (rec && this.#accept('kw', 'and'));
    this.#expect('kw', 'in');
    const body = this.expr();
    if (!rec) return new Binding(binds[0][0], binds[0][1], body);
    return binds.length > 1 ? new LetRecAnd(binds, body) : new LetRec(binds[0][0], binds[0][1], body);
  }
  binary(minPrec) {
    let left = this.application();
    for (;;) {
      const t = this.#peek;
      const info = t.kind === 'op' ? BINOPS[t.text] : undefined;
      if (!info) break;
      const [prec, name, rightAssoc = false] = info;
      if (prec < minPrec) break;
      this.#next();
      const right = this.binary(rightAssoc ? prec : prec + 1);
      left = new App(new App(new Var(name), left), right);
    }
    return left;
  }
  application() {
    let fn = this.atom();
    while (this.#startsAtom()) fn = new App(fn, this.atom());
    return fn;
  }
  #startsAtom() {
    const t = this.#peek;
    return t.kind === 'num' || t.kind === 'str' || t.kind === 'id' || t.is('kw', 'true') || t.is('kw', 'false') || t.is('op', '(') || t.is('op', '[');
  }
  atom() {
    const t = this.#next();
    switch (t.kind) {
      case 'num': return new Lit(Number(t.text));
      case 'str': return new Lit(t.text);
      case 'id': return new Var(t.text);
      case 'kw':
        if (t.text === 'true' || t.text === 'false') return new Lit(t.text === 'true');
        break;
      case 'op':
        if (t.text === '(') {
          if (this.#accept('op', ')')) return new Lit(null);
          const first = this.expr();
          if (this.#accept('op', ':')) {
            const ty = this.#typeExpr();
            this.#expect('op', ')');
            return new Annot(first, ty);
          }
          const items = [first];
          while (this.#accept('op', ',')) items.push(this.expr());
          this.#expect('op', ')');
          return items.length === 1 ? first : new Tuple(items);
        }
        if (t.text === '[') {
          const items = [];
          if (!this.#accept('op', ']')) {
            do items.push(this.expr()); while (this.#accept('op', ','));
            this.#expect('op', ']');
          }
          return new ListLit(items);
        }
    }
    throw new SyntaxError('unexpected token ' + t);
  }
  #typeExpr() {
    const left = this.#typeAtom();
    if (this.#accept('op', '->')) return fnT(left, this.#typeExpr());
    return left;
  }
  #typeAtom() {
    const t = this.#next();
    if (t.is('op', '(')) { const ty = this.#typeExpr(); this.#expect('op', ')'); return ty; }
    if (t.is('op', '[')) { const ty = this.#typeExpr(); this.#expect('op', ']'); return listT(ty); }
    if (t.kind === 'id') {
      if (/^[a-z]$/.test(t.text)) return this.#tyvar(t.text);
      return new TCon(t.text, []);
    }
    throw new SyntaxError('bad type at ' + t);
  }
  #tvars = new Map();
  #tyvar(name) {
    return this.#tvars.get(name) ?? (this.#tvars.set(name, new TVar()), this.#tvars.get(name));
  }
}

// ---------- types ----------
class Type {
  toString() { return showType(this); }
}
class TVar extends Type {
  static #next = 0;
  #instance = null;
  constructor() { super(); this.id = TVar.#next++; this.level = currentLevel; }
  get instance() { return this.#instance; }
  set instance(t) {
    if (this.#instance !== null) throw new Error('tvar already bound');
    this.#instance = t;
  }
  static reset() { TVar.#next = 0; }
  static isTVar(x) { return x instanceof Object && #instance in x; }
}
class TCon extends Type {
  constructor(name, args) { super(); this.name = name; this.args = args; }
}
const fnT = (a, b) => new TCon('->', [a, b]);
const listT = a => new TCon('List', [a]);
const tupleT = ts => new TCon('*', ts);
const INT = new TCon('Int', []), BOOL = new TCon('Bool', []), STR = new TCon('String', []), UNIT = new TCon('Unit', []);

let currentLevel = 0;

function prune(t) {
  while (t instanceof TVar && t.instance) t = t.instance;
  return t;
}
function occursAdjust(v, t) {
  t = prune(t);
  if (t === v) return true;
  if (t instanceof TVar) { if (t.level > v.level) t.level = v.level; return false; }
  return t.args.some(a => occursAdjust(v, a));
}

class TypeError_ extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
  get name() { return 'TypeError_'; }
}

function unify(a, b, trail = []) {
  a = prune(a); b = prune(b);
  if (a === b) return trail;
  if (a instanceof TVar) {
    if (occursAdjust(a, b)) throw new TypeError_(`infinite type: ${showType(a)} ~ ${showType(b)}`, { kind: 'occurs' });
    a.instance = b;
    trail.push(a.id);
    return trail;
  }
  if (b instanceof TVar) return unify(b, a, trail);
  if (a.name !== b.name || a.args.length !== b.args.length)
    throw new TypeError_(`cannot unify ${showType(a)} with ${showType(b)}`, { kind: 'mismatch', a: a.name, b: b.name });
  a.args.forEach((x, i) => unify(x, b.args[i], trail));
  return trail;
}

// ---------- schemes ----------
class Scheme {
  constructor(vars, type) { this.vars = vars; this.type = type; }
  instantiate() {
    const sub = new Map(this.vars.map(v => [v, new TVar()]));
    const go = t => {
      t = prune(t);
      if (t instanceof TVar) return sub.get(t) ?? t;
      return t.args.length ? new TCon(t.name, t.args.map(go)) : t;
    };
    return go(this.type);
  }
  static mono(t) { return new Scheme([], t); }
}
function generalize(t) {
  const vars = [];
  const seen = new Set();
  (function collect(t) {
    t = prune(t);
    if (t instanceof TVar) {
      if (t.level > currentLevel && !seen.has(t)) { seen.add(t); vars.push(t); }
      return;
    }
    for (const a of t.args) collect(a);
  })(t);
  return new Scheme(vars, t);
}

// ---------- pretty printing ----------
function showType(t, names = new Map(), prec = 0) {
  t = prune(t);
  if (t instanceof TVar) {
    if (!names.has(t)) {
      const i = names.size;
      names.set(t, "'" + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''));
    }
    return names.get(t);
  }
  switch (t.name) {
    case '->': {
      const s = `${showType(t.args[0], names, 1)} -> ${showType(t.args[1], names, 0)}`;
      return prec > 0 ? `(${s})` : s;
    }
    case 'List': return `[${showType(t.args[0], names, 0)}]`;
    case '*': return '(' + t.args.map(a => showType(a, names, 0)).join(', ') + ')';
    default: return t.args.length ? `${t.name} ${t.args.map(a => showType(a, names, 2)).join(' ')}` : t.name;
  }
}
const showScheme = s => showType(s.type);

// ---------- environment with Proxy (lookup tracing) ----------
class Env {
  #map; #parent;
  constructor(parent = null, entries = []) { this.#parent = parent; this.#map = new Map(entries); }
  extend(name, scheme) { return new Env(this, [[name, scheme]]); }
  extendMany(pairs) { return new Env(this, pairs); }
  lookup(name) {
    for (let e = this; e; e = e.#parent) if (e.#map.has(name)) return e.#map.get(name);
    return undefined;
  }
  *names() {
    const seen = new Set();
    for (let e = this; e; e = e.#parent) for (const k of e.#map.keys()) if (!seen.has(k)) { seen.add(k); yield k; }
  }
}
const lookupStats = {};
function tracedEnv(env) {
  return new Proxy(env, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === 'lookup') return name => { lookupStats[name] = (lookupStats[name] || 0) + 1; return v.call(target, name); };
      if (prop === 'extend' || prop === 'extendMany') return (...args) => tracedEnv(v.apply(target, args));
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
  });
}

function builtinEnv() {
  const a = () => new TVar();
  const poly = f => { currentLevel++; const t = f(); currentLevel--; return generalize(t); };
  const entries = [
    ['add', Scheme.mono(fnT(INT, fnT(INT, INT)))],
    ['sub', Scheme.mono(fnT(INT, fnT(INT, INT)))],
    ['mul', Scheme.mono(fnT(INT, fnT(INT, INT)))],
    ['lt', Scheme.mono(fnT(INT, fnT(INT, BOOL)))],
    ['le', Scheme.mono(fnT(INT, fnT(INT, BOOL)))],
    ['gt', Scheme.mono(fnT(INT, fnT(INT, BOOL)))],
    ['ge', Scheme.mono(fnT(INT, fnT(INT, BOOL)))],
    ['and', Scheme.mono(fnT(BOOL, fnT(BOOL, BOOL)))],
    ['or', Scheme.mono(fnT(BOOL, fnT(BOOL, BOOL)))],
    ['not', Scheme.mono(fnT(BOOL, BOOL))],
    ['eq', poly(() => { const x = a(); return fnT(x, fnT(x, BOOL)); })],
    ['cons', poly(() => { const x = a(); return fnT(x, fnT(listT(x), listT(x))); })],
    ['head', poly(() => { const x = a(); return fnT(listT(x), x); })],
    ['tail', poly(() => { const x = a(); return fnT(listT(x), listT(x)); })],
    ['null', poly(() => { const x = a(); return fnT(listT(x), BOOL); })],
    ['fst', poly(() => { const x = a(), y = a(); return fnT(tupleT([x, y]), x); })],
    ['snd', poly(() => { const x = a(), y = a(); return fnT(tupleT([x, y]), y); })],
    ['concat', Scheme.mono(fnT(STR, fnT(STR, STR)))],
    ['show', poly(() => fnT(a(), STR))],
    ['fix', poly(() => { const x = a(); return fnT(fnT(x, x), x); })],
  ];
  return new Env(null, entries);
}

// ---------- inference ----------
const inferStats = { nodes: 0, unifications: 0, maxDepth: 0 };
function infer(node, env, depth = 0) {
  inferStats.nodes++;
  if (depth > inferStats.maxDepth) inferStats.maxDepth = depth;
  const u = (x, y) => { inferStats.unifications++; unify(x, y); };
  switch (node.tag) {
    case 'Lit': {
      const v = node.value;
      return v === null ? UNIT : typeof v === 'number' ? INT : typeof v === 'boolean' ? BOOL : STR;
    }
    case 'Var': {
      const s = env.lookup(node.name);
      if (s === undefined) throw new TypeError_('unbound variable ' + node.name, { kind: 'unbound' });
      return s.instantiate();
    }
    case 'Lam': {
      const p = new TVar();
      const bt = infer(node.body, env.extend(node.param, Scheme.mono(p)), depth + 1);
      return fnT(p, bt);
    }
    case 'App': {
      const ft = infer(node.fn, env, depth + 1);
      const at = infer(node.arg, env, depth + 1);
      const rt = new TVar();
      u(ft, fnT(at, rt));
      return rt;
    }
    case 'If': {
      u(infer(node.c, env, depth + 1), BOOL);
      const t = infer(node.t, env, depth + 1);
      u(t, infer(node.e, env, depth + 1));
      return t;
    }
    case 'Let': {
      currentLevel++;
      let vt;
      try { vt = infer(node.value, env, depth + 1); } finally { currentLevel--; }
      return infer(node.body, env.extend(node.name, generalize(vt)), depth + 1);
    }
    case 'LetRec':
    case 'LetRecAnd': {
      const binds = node.binds ?? [[node.name, node.value]];
      currentLevel++;
      const tvs = binds.map(() => new TVar());
      const recEnv = env.extendMany(binds.map(([n], i) => [n, Scheme.mono(tvs[i])]));
      try {
        binds.forEach(([, v], i) => u(tvs[i], infer(v, recEnv, depth + 1)));
      } finally {
        currentLevel--;
      }
      const bodyEnv = env.extendMany(binds.map(([n], i) => [n, generalize(tvs[i])]));
      return infer(node.body, bodyEnv, depth + 1);
    }
    case 'List': {
      const el = new TVar();
      for (const it of node.items) u(el, infer(it, env, depth + 1));
      return listT(el);
    }
    case 'Tuple': return tupleT(node.items.map(it => infer(it, env, depth + 1)));
    case 'Annot': {
      const t = infer(node.expr, env, depth + 1);
      u(t, node.type);
      return node.type;
    }
    default:
      throw new Error('unknown node ' + node.tag);
  }
}

function typeOf(src, { traced = false } = {}) {
  currentLevel = 0;
  const ast = new Parser(src).parseProgram();
  const env = traced ? tracedEnv(builtinEnv()) : builtinEnv();
  currentLevel = 0;
  const t = infer(ast, env);
  return { ast, type: t, str: showType(t) };
}

// ---------- evaluator (to cross-check programs that typecheck) ----------
class Closure {
  constructor(param, body, env) { this.param = param; this.body = body; this.env = env; }
}
const curry2 = f => a => b => f(a, b);
const PRIMS = {
  add: curry2((a, b) => a + b), sub: curry2((a, b) => a - b), mul: curry2((a, b) => a * b),
  lt: curry2((a, b) => a < b), le: curry2((a, b) => a <= b), gt: curry2((a, b) => a > b), ge: curry2((a, b) => a >= b),
  and: curry2((a, b) => a && b), or: curry2((a, b) => a || b), not: a => !a,
  eq: curry2((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  cons: curry2((a, b) => [a, ...b]),
  head: l => { if (!l.length) throw new RangeError('head of empty'); return l[0]; },
  tail: l => l.slice(1), null: l => l.length === 0,
  fst: t => t[0], snd: t => t[1],
  concat: curry2((a, b) => a + b),
  show: v => (typeof v === 'function' || v instanceof Closure ? '<fun>' : JSON.stringify(v)),
};
PRIMS.fix = f => { const self = x => apply(apply(f, self), x); return self; };

function apply(f, x) {
  if (f instanceof Closure) return evaluate(f.body, { __proto__: f.env, [f.param]: x });
  if (typeof f === 'function') return f(x);
  throw new TypeError('not a function');
}
function evaluate(node, env) {
  switch (node.tag) {
    case 'Lit': return node.value;
    case 'Var': {
      if (node.name in env) return env[node.name];
      if (Object.hasOwn(PRIMS, node.name)) return PRIMS[node.name];
      throw new ReferenceError(node.name);
    }
    case 'Lam': return new Closure(node.param, node.body, env);
    case 'App': {
      // short-circuit and/or
      if (node.fn.tag === 'App' && node.fn.fn.tag === 'Var' && (node.fn.fn.name === 'and' || node.fn.fn.name === 'or') && !(node.fn.fn.name in env)) {
        const l = evaluate(node.fn.arg, env);
        return node.fn.fn.name === 'and' ? (l ? evaluate(node.arg, env) : false) : (l ? true : evaluate(node.arg, env));
      }
      return apply(evaluate(node.fn, env), evaluate(node.arg, env));
    }
    case 'If': return evaluate(node.c, env) ? evaluate(node.t, env) : evaluate(node.e, env);
    case 'Let': return evaluate(node.body, { __proto__: env, [node.name]: evaluate(node.value, env) });
    case 'LetRec':
    case 'LetRecAnd': {
      const recEnv = Object.create(env);
      for (const [n, v] of node.binds ?? [[node.name, node.value]]) recEnv[n] = evaluate(v, recEnv);
      return evaluate(node.body, recEnv);
    }
    case 'List': return node.items.map(i => evaluate(i, env));
    case 'Tuple': return node.items.map(i => evaluate(i, env));
    case 'Annot': return evaluate(node.expr, env);
  }
  throw new Error('eval: ' + node.tag);
}
const showVal = v => (v instanceof Closure || typeof v === 'function' ? '<fun>' : JSON.stringify(v));

// ---------- test programs ----------
const PROGRAMS = [
  ['id', '\\x. x'],
  ['const', 'fun x y -> x'],
  ['compose', '\\f g x. f (g x)'],
  ['let-poly', 'let id = \\x. x in (id 1, id true)'],
  ['lambda-mono', '(\\id. (id 1, id true)) (\\x. x)'],
  ['arith', '1 + 2 * 3 - 4'],
  ['cmp', 'if 1 < 2 && true then "yes" else "no"'],
  ['list', '[1, 2, 3]'],
  ['cons', '0 :: 1 :: [2]'],
  ['badlist', '[1, true]'],
  ['fact', 'let rec fact n = if n <= 1 then 1 else n * fact (n - 1) in fact 10'],
  ['map', 'let rec map f xs = if null xs then [] else f (head xs) :: map f (tail xs) in map'],
  ['map-use', 'let rec map f xs = if null xs then [] else f (head xs) :: map f (tail xs) in map (\\x. x * x) [1,2,3,4]'],
  ['foldl', 'let rec foldl f acc xs = if null xs then acc else foldl f (f acc (head xs)) (tail xs) in foldl (\\a b. a + b) 0 [1,2,3,4,5]'],
  ['even-odd', 'let rec even n = if n == 0 then true else odd (n - 1) and odd n = if n == 0 then false else even (n - 1) in (even 10, odd 7)'],
  ['omega', '\\x. x x'],
  ['unbound', 'let f = \\x. y in f'],
  ['fix-fact', 'fix (\\f n. if n == 0 then 1 else n * f (n - 1)) 6'],
  ['pairs', 'let swap p = (snd p, fst p) in swap (1, "a")'],
  ['annot-ok', '(\\x. x : Int -> Int)'],
  ['annot-bad', '(\\x. x + 1 : Bool -> Bool)'],
  ['show', 'concat (show 42) (concat " " (show [true]))'],
  ['nested-let', 'let a = 1 in let b = a + 1 in let c = \\x. x + b in c a'],
  ['s-comb', '\\x y z. x z (y z)'],
  ['church', 'let two = \\f x. f (f x) in let three = \\f x. f (f (f x)) in let mul = \\m n f. m (n f) in mul two three (\\n. n + 1) 0'],
  ['unit', 'let u = () in (u, u)'],
  ['syntax-err', 'let x = in x'],
  ['if-mismatch', 'if true then 1 else "one"'],
  ['cond-not-bool', 'if 1 then 2 else 3'],
  ['string', '"a\\"b" == "c"'],
];

console.log('lex sample', [...lex('let f x = x + 1 -- comment\n in f 2')].map(String).join(' '));
try { [...lex('1 $ 2')]; } catch (e) { console.log('lex error', e.message); }

const results = [];
for (const [name, src] of PROGRAMS) {
  let line;
  try {
    const { ast, str } = typeOf(src);
    let value = '';
    if (!/->/.test(str)) {
      try { value = ' = ' + showVal(evaluate(ast, Object.create(null))); }
      catch (e) { value = ' ! ' + e.message; }
    }
    line = `${name.padEnd(13)} : ${str}${value}  [nodes=${ast.size}]`;
    results.push([name, 'ok']);
  } catch (e) {
    const kind = e instanceof TypeError_ ? `type(${e.detail.kind})` : e instanceof SyntaxError ? 'syntax' : 'other';
    line = `${name.padEnd(13)} ! ${kind}: ${e.message}`;
    results.push([name, kind]);
  }
  console.log(line);
}
console.log('summary', JSON.stringify(results.reduce((acc, [, k]) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {})));
console.log('infer stats', JSON.stringify(inferStats));

// ---------- AST walking via generators ----------
{
  const { ast } = typeOf(PROGRAMS[13][1]);
  const tags = new Map();
  let deepest = 0;
  for (const [n, d] of ast.walk()) {
    tags.set(n.tag, (tags.get(n.tag) ?? 0) + 1);
    deepest = Math.max(deepest, d);
  }
  console.log('foldl ast tags', JSON.stringify([...tags].sort()), 'depth', deepest);
  const vars = [];
  outer: for (const [n] of ast.walk()) {
    if (n.tag !== 'Var') continue;
    for (const v of vars) if (v === n.name) continue outer;
    vars.push(n.name);
  }
  console.log('distinct vars', vars.join(','));
  console.log('instanceof chain', new LetRecAnd([['a', new Lit(1)]], new Lit(2)) instanceof Binding, new LetRec('a', new Lit(1), new Lit(1)).tag, new LetRecAnd([['a', new Lit(1)]], new Lit(1)).tag);
}

// ---------- unifier unit tests ----------
{
  currentLevel = 0;
  const a = new TVar(), b = new TVar(), c = new TVar();
  const trail = unify(fnT(a, listT(b)), fnT(INT, c));
  console.log('unify trail len', trail.length, 'a=', showType(a), 'c=', showType(c));
  unify(b, tupleT([BOOL, a]));
  console.log('c now', showType(c));
  const tests = [
    () => unify(a, BOOL),
    () => { const d = new TVar(); unify(d, listT(d)); },
    () => unify(fnT(INT, INT), tupleT([INT, INT])),
    () => unify(tupleT([INT]), tupleT([INT, INT])),
  ];
  tests.forEach((t, i) => {
    try { t(); console.log('  unify test', i, 'ok'); }
    catch ({ message, detail: { kind } = {} }) { console.log('  unify test', i, kind, message); }
  });
  console.log('isTVar', TVar.isTVar(a), TVar.isTVar(INT), TVar.isTVar({}));
  try { a.instance = INT; } catch (e) { console.log('rebind', e.message); }
}

// ---------- traced lookups ----------
{
  for (const k of Object.keys(lookupStats)) delete lookupStats[k];
  const { str } = typeOf('let rec len xs = if null xs then 0 else 1 + len (tail xs) in len [1,2,3]', { traced: true });
  console.log('traced type', str, 'lookups', JSON.stringify(Object.entries(lookupStats).sort()));
}

// ---------- deep programs (recursion stress) ----------
{
  let src = 'x';
  for (let i = 0; i < 300; i++) src = `(\\y${i}. ${src}) ${i}`;
  src = `let x = 7 in ${src}`;
  const { str, ast } = typeOf(src);
  console.log('deep app chain', str, 'size', ast.size, 'value', showVal(evaluate(ast, Object.create(null))));
  let lst = '[]';
  for (let i = 0; i < 400; i++) lst = `${i} :: ${lst}`;
  const r = typeOf(`let rec sum xs = if null xs then 0 else head xs + sum (tail xs) in sum (${lst})`);
  console.log('deep cons', r.str, showVal(evaluate(r.ast, Object.create(null))));
  const sumTo = typeOf('let rec go n acc = if n == 0 then acc else go (n - 1) (acc + n) in go 250 0');
  console.log('go 250', sumTo.str, showVal(evaluate(sumTo.ast, Object.create(null))));
}

// ---------- closures capturing loop variables ----------
{
  const checkers = [];
  for (let i = 0; i < 4; i++) {
    const tyName = ['Int', 'Bool', 'String', 'Unit'][i];
    checkers.push(src => { try { return typeOf(src).str === tyName; } catch { return false; } });
  }
  const inputs = { '1 + 1': 0, 'true || false': 1, '"s"': 2, '()': 3 };
  for (const src in inputs) {
    const hits = checkers.map(c => +c(src)).join('');
    console.log('checker', JSON.stringify(src), hits);
  }
  const perKey = {};
  for (const [k, v] of Object.entries({ id: '\\x.x', k: '\\x y.x' })) perKey[k] = () => `${k}:${typeOf(v).str}`;
  console.log(perKey.id(), perKey.k());
}

// ---------- type printer via tagged template ----------
function T(strings, ...types) {
  const names = new Map();
  return strings.reduce((out, s, i) => out + (i ? showType(types[i - 1], names) : '') + s, '');
}
{
  currentLevel = 0;
  const x = new TVar(), y = new TVar();
  console.log(T`map : ${fnT(fnT(x, y), fnT(listT(x), listT(y)))} ; same names ${x} ${y}`);
  const letters = [];
  for (let i = 0; i < 28; i++) letters.push(new TVar());
  console.log('many vars', showType(tupleT(letters.slice(24))), showType(tupleT(letters), new Map()).length);
}

// ---------- object-literal methods: this vs arrow, super in object literal ----------
const baseReporter = {
  prefix: 'base',
  fmt(msg) { return `[${this.prefix}] ${msg}`; },
};
const reporter = {
  __proto__: baseReporter,
  prefix: 'hm',
  count: 0,
  fmt(msg) { this.count++; return super.fmt(msg.toUpperCase()); },
  arrowFmt: msg => `[arrow:${typeof this === 'undefined' || this !== reporter}] ${msg}`,
  get countLabel() { return `count=${this.count}`; },
  [`type${'Of'}`](src) { try { return this.fmt(typeOf(src).str); } catch (e) { return this.fmt('error'); } },
};
console.log(reporter.typeOf('\\f. f 1'));
console.log(reporter.typeOf('1 1'));
console.log(reporter.arrowFmt('x'), reporter.countLabel);

// ---------- JSON serialisation of types with replacer / reviver ----------
{
  const { type } = typeOf('\\f xs. (f (head xs), xs)');
  const ids = new Map();
  const toJ = t => {
    t = prune(t);
    if (t instanceof TVar) { if (!ids.has(t)) ids.set(t, ids.size); return { tv: ids.get(t) }; }
    return { con: t.name, args: t.args };
  };
  const json = JSON.stringify(type, function (k, v) {
    return v instanceof Type ? toJ(v) : v;
  });
  console.log('type json', json);
  const cache = new Map();
  const back = JSON.parse(json, (k, v) => {
    if (v && typeof v === 'object' && 'tv' in v) return cache.get(v.tv) ?? (cache.set(v.tv, new TVar()), cache.get(v.tv));
    if (v && typeof v === 'object' && 'con' in v) return new TCon(v.con, v.args);
    return v;
  });
  console.log('revived', showType(back), 'equal', showType(back) === showType(type));
}

// ---------- async batch checking with microtask ordering ----------
async function checkAsync(name, src, yields) {
  for (let i = 0; i < yields; i++) await null;
  const { str } = typeOf(src);
  return `${name}:${str}`;
}
async function* programStream() {
  for (const [name, src] of PROGRAMS.slice(0, 8)) { await Promise.resolve(); yield { name, src }; }
}
const asyncLines = [];
(async () => {
  const settled = await Promise.allSettled(PROGRAMS.slice(14, 18).map(([n, s], i) => checkAsync(n, s, 4 - i)));
  settled.forEach(r => asyncLines.push(r.status === 'fulfilled' ? r.value : 'rejected ' + r.reason.message));
  asyncLines.push('race ' + await Promise.race([checkAsync('slow', '1', 5), checkAsync('fast', 'true', 1)]));
  asyncLines.push('any ' + await Promise.any([checkAsync('bad', '1 1', 0), checkAsync('good', '[[1]]', 2)]));
  let n = 0;
  for await (const { name, src } of programStream()) {
    try {
      if (name === 'lambda-mono') throw new TypeError_('skip', { kind: 'skip' });
      asyncLines.push('stream ' + (await checkAsync(name, src, n % 3)));
    } catch ({ detail }) {
      asyncLines.push('stream skipped ' + detail?.kind);
      continue;
    } finally {
      n++;
    }
  }
  asyncLines.push('streamed ' + n);
})().then(() => {
  asyncLines.forEach(l => console.log('async', l));
  console.log('ast nodes created', Node.count > 1000);
});
console.log('sync done');
