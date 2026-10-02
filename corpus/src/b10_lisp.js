// Tiny Lisp interpreter: tokenizer, parser, evaluator with environments, lambdas, recursion
'use strict';

class LispError extends Error {
  constructor(message, form) {
    super(message);
    this.name = 'LispError';
    this.form = form;
  }
}

class Sym {
  static #table = new Map();
  #name;
  constructor(name) { this.#name = name; }
  static intern(name) {
    let s = Sym.#table.get(name);
    if (!s) { s = new Sym(name); Sym.#table.set(name, s); }
    return s;
  }
  static get count() { return Sym.#table.size; }
  get name() { return this.#name; }
  toString() { return this.#name; }
}

const NIL = Object.freeze([]);
const S = (n) => Sym.intern(n);

function tokenize(src) {
  const re = /\s*(;[^\n]*|,@|[()'`,]|"(?:\\.|[^"\\])*"|[^\s()'"`,;]+)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const t = m[1];
    if (t === undefined || t === '') break;
    if (t.startsWith(';')) continue;
    tokens.push(t);
  }
  return tokens;
}

function parseAtom(tok) {
  if (/^-?\d+$/.test(tok)) {
    const n = Number(tok);
    return Number.isSafeInteger(n) ? n : BigInt(tok);
  }
  if (/^-?\d*\.\d+$/.test(tok)) return parseFloat(tok);
  if (tok.startsWith('"')) return JSON.parse(tok);
  if (tok === '#t') return true;
  if (tok === '#f') return false;
  return S(tok);
}

function* readAll(tokens) {
  let i = 0;
  function read() {
    if (i >= tokens.length) throw new LispError('unexpected EOF');
    const t = tokens[i++];
    if (t === '(') {
      const list = [];
      while (tokens[i] !== ')') {
        if (i >= tokens.length) throw new LispError('missing )');
        list.push(read());
      }
      i++;
      return list;
    }
    if (t === ')') throw new LispError('unexpected )');
    if (t === "'") return [S('quote'), read()];
    return parseAtom(t);
  }
  while (i < tokens.length) yield read();
}

class Env {
  constructor(parent = null, bindings = {}) {
    this.parent = parent;
    this.vars = new Map(Object.entries(bindings));
  }
  lookup(name) {
    for (let e = this; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name);
    throw new LispError(`unbound symbol: ${name}`);
  }
  set(name, value) {
    for (let e = this; e; e = e.parent) {
      if (e.vars.has(name)) { e.vars.set(name, value); return value; }
    }
    throw new LispError(`set! on unbound: ${name}`);
  }
  define(name, value) { this.vars.set(name, value); return value; }
  get depth() { let d = 0; for (let e = this.parent; e; e = e.parent) d++; return d; }
}

class Lambda {
  constructor(params, body, env, name = 'lambda') {
    this.params = params;
    this.body = body;
    this.env = env;
    this.name = name;
  }
  toString() { return `#<${this.name}/${this.params.length}>`; }
}

const stats = { evals: 0, calls: 0, tailCalls: 0, maxDepth: 0 };

function show(x) {
  if (Array.isArray(x)) {
    if (x.length === 2 && x[0] === S('quote')) return "'" + show(x[1]);
    return `(${x.map(show).join(' ')})`;
  }
  if (x === true) return '#t';
  if (x === false) return '#f';
  if (typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'bigint') return `${x}n`;
  if (typeof x === 'function') return `#<builtin ${x.lispName ?? x.name}>`;
  return String(x);
}

function truthy(v) { return v !== false && v !== NIL && !(Array.isArray(v) && v.length === 0); }

function evaluate(x, env, depth = 0) {
  for (;;) {
    stats.evals++;
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    if (x instanceof Sym) return env.lookup(x.name);
    if (!Array.isArray(x)) return x;
    if (x.length === 0) return NIL;
    const [op, ...args] = x;
    switch (op instanceof Sym ? op.name : null) {
      case 'quote':
        return args[0];
      case 'if': {
        const [test, conseq, alt = false] = args;
        x = truthy(evaluate(test, env, depth + 1)) ? conseq : alt;
        continue;
      }
      case 'define': {
        let [target, ...body] = args;
        if (Array.isArray(target)) {
          const [fname, ...params] = target;
          return env.define(fname.name, new Lambda(params.map((p) => p.name), body, env, fname.name));
        }
        return env.define(target.name, evaluate(body[0], env, depth + 1));
      }
      case 'set!':
        return env.set(args[0].name, evaluate(args[1], env, depth + 1));
      case 'lambda':
        return new Lambda(args[0].map((p) => p.name), args.slice(1), env);
      case 'begin': {
        for (let i = 0; i < args.length - 1; i++) evaluate(args[i], env, depth + 1);
        x = args[args.length - 1];
        continue;
      }
      case 'let': {
        const [bindings, ...body] = args;
        const inner = new Env(env);
        for (const [name, expr] of bindings) inner.define(name.name, evaluate(expr, env, depth + 1));
        for (let i = 0; i < body.length - 1; i++) evaluate(body[i], inner, depth + 1);
        x = body[body.length - 1];
        env = inner;
        continue;
      }
      case 'cond': {
        let found = null;
        for (const [test, ...body] of args) {
          if ((test instanceof Sym && test.name === 'else') || truthy(evaluate(test, env, depth + 1))) {
            found = [S('begin'), ...body];
            break;
          }
        }
        if (!found) return false;
        x = found;
        continue;
      }
      case 'and': {
        let v = true;
        for (const a of args) { v = evaluate(a, env, depth + 1); if (!truthy(v)) return v; }
        return v;
      }
      case 'or': {
        for (const a of args) { const v = evaluate(a, env, depth + 1); if (truthy(v)) return v; }
        return false;
      }
      default: {
        const fn = evaluate(op, env, depth + 1);
        const vals = args.map((a) => evaluate(a, env, depth + 1));
        stats.calls++;
        if (typeof fn === 'function') return fn(...vals);
        if (fn instanceof Lambda) {
          if (vals.length !== fn.params.length) {
            throw new LispError(`${fn.name}: expected ${fn.params.length} args, got ${vals.length}`, x);
          }
          const frame = new Env(fn.env);
          fn.params.forEach((p, i) => frame.define(p, vals[i]));
          for (let i = 0; i < fn.body.length - 1; i++) evaluate(fn.body[i], frame, depth + 1);
          x = fn.body[fn.body.length - 1];
          env = frame;
          stats.tailCalls++;
          continue;
        }
        throw new LispError(`not callable: ${show(fn)}`, x);
      }
    }
  }
}

function numeric(name, f, init) {
  const fn = function (...xs) {
    if (xs.length === 0) return init;
    if (xs.some((v) => typeof v === 'bigint')) xs = xs.map((v) => BigInt(v));
    return xs.reduce((a, b) => f(a, b));
  };
  fn.lispName = name;
  return fn;
}

function makeGlobal(out) {
  const g = new Env(null, {
    '+': numeric('+', (a, b) => a + b, 0),
    '-': numeric('-', (a, b) => a - b, 0),
    '*': numeric('*', (a, b) => a * b, 1),
    '/': numeric('/', (a, b) => (typeof a === 'bigint' ? a / b : a / b), 1),
    mod: (a, b) => a % b,
    '<': (a, b) => a < b,
    '>': (a, b) => a > b,
    '=': (a, b) => a == b,
    '<=': (a, b) => a <= b,
    car: (l) => l[0],
    cdr: (l) => (l.length > 1 ? l.slice(1) : NIL),
    cons: (a, l) => [a, ...l],
    list: (...xs) => xs,
    'null?': (l) => Array.isArray(l) && l.length === 0,
    length: (l) => l.length,
    not: (v) => !truthy(v),
    display: (...xs) => { out.push(xs.map((v) => (typeof v === 'string' ? v : show(v))).join(' ')); return NIL; },
    bigint: (n) => BigInt(n),
    'string-append': (...ss) => ss.join(''),
    'number->string': (n) => String(n),
    apply: (f, l) => (typeof f === 'function' ? f(...l) : evaluate([f, ...l.map((v) => [S('quote'), v])], g)),
  });
  g.define('map', function map(f, l) {
    return l.map((v) => (typeof f === 'function' ? f(v) : evaluate([f, [S('quote'), v]], g)));
  });
  g.define('filter', (f, l) => l.filter((v) => truthy(typeof f === 'function' ? f(v) : evaluate([f, [S('quote'), v]], g))));
  return g;
}

function run(program, env, out) {
  let last;
  for (const form of readAll(tokenize(program))) {
    try {
      last = evaluate(form, env);
      if (!(Array.isArray(form) && form[0] === S('define'))) console.log(`> ${show(form).slice(0, 60)}\n  ${show(last)}`);
    } catch (e) {
      console.log(`> ${show(form).slice(0, 60)}\n  error: ${e.message}`);
    } finally {
      while (out.length) console.log(`  | ${out.shift()}`);
    }
  }
  return last;
}

const PROGRAM = `
; basic arithmetic
(+ 1 2 3)
(* 2 (- 10 4) (/ 9 3))
(define (fact n) (if (<= n 1) 1 (* n (fact (- n 1)))))
(fact 10)
(fact (bigint 25))
(define (fib n) (cond ((< n 2) n) (else (+ (fib (- n 1)) (fib (- n 2))))))
(map fib (list 0 1 2 3 4 5 6 7 8 9 10))
(define (sum-to n acc) (if (= n 0) acc (sum-to (- n 1) (+ acc n))))
(sum-to 5000 0)
(define (make-counter)
  (let ((n 0))
    (lambda () (set! n (+ n 1)) n)))
(define c1 (make-counter))
(define c2 (make-counter))
(c1) (c1) (c2) (c1)
(define (compose f g) (lambda (x) (f (g x))))
((compose (lambda (x) (* x x)) (lambda (x) (+ x 1))) 6)
(filter (lambda (x) (= (mod x 3) 0)) (list 1 2 3 4 5 6 7 8 9 12))
(define (reverse l) (if (null? l) l (append1 (reverse (cdr l)) (car l))))
(define (append1 l x) (if (null? l) (list x) (cons (car l) (append1 (cdr l) x))))
(reverse (list 1 2 3 4 5))
(define (range a b) (if (>= a b) '() (cons a (range (+ a 1) b))))
(define (range a b) (if (< a b) (cons a (range (+ a 1) b)) '()))
(range 0 8)
(define (foldl f acc l) (if (null? l) acc (foldl f (f acc (car l)) (cdr l))))
(foldl + 0 (range 1 101))
(and 1 2 #f 3)
(or #f #f 7)
(display "hello" (list 1 2) (fact 5))
(let ((x 2) (y 3)) (let ((x 7) (z (+ x y))) (* z x)))
(define (ackermann m n)
  (cond ((= m 0) (+ n 1))
        ((= n 0) (ackermann (- m 1) 1))
        (else (ackermann (- m 1) (ackermann m (- n 1))))))
(ackermann 2 3)
(undefined-thing 1)
(fact 1 2)
(car '(a b c))
(string-append "n=" (number->string (fib 15)))
(apply + (list 1 2 3 4))
("notfn" 1)
`;

function main() {
  const out = [];
  const env = makeGlobal(out);
  console.log(`tokens: ${tokenize('(define (f x) (+ x 1)) ; comment\n\'(a "b c")').join(' | ')}`);
  run(PROGRAM, env, out);
  try {
    [...readAll(tokenize('(+ 1 2'))];
  } catch (e) {
    console.log(`read error: ${e.name}: ${e.message}`);
  }
  try {
    [...readAll(tokenize(')'))];
  } catch (e) {
    console.log(`read error: ${e.message}`);
  }
  const userFns = [...env.vars].filter(([, v]) => v instanceof Lambda).map(([k, v]) => `${k}${v}`);
  console.log(`user functions: ${userFns.join(' ')}`);
  console.log(`symbols interned: ${Sym.count}`);
  const { evals, calls, tailCalls, maxDepth } = stats;
  console.log(`stats: evals=${evals} calls=${calls} tail=${tailCalls} maxDepth=${maxDepth}`);
}

main();
