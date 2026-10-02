'use strict';
// d01: compiler pipeline — lexer, Pratt parser, AST optimizer, bytecode emitter, VM
// plus a tree-walking reference evaluator that uses exceptions as control flow.
const log = (...xs) => console.log(xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ---------------------------------------------------------------- tokens
const KEYWORDS = new Set(['let', 'fn', 'if', 'else', 'while', 'return', 'print', 'break', 'continue', 'true', 'false', 'nil', 'for', 'in']);
class Token {
  #kind;
  #text;
  constructor(kind, text, pos) { [this.#kind, this.#text, this.pos] = [kind, text, pos]; }
  get kind() { return this.#kind; }
  get text() { return this.#text; }
  is(kind, text) { return this.#kind === kind && (text === undefined || this.#text === text); }
  static #count = 0;
  static make(kind, text, pos) {
    Token.#count++;
    return new Token(kind, text, pos);
  }
  static get created() { return Token.#count; }
  [Symbol.toPrimitive](hint) {
    return hint === 'number' ? this.pos : `${this.#kind}(${this.#text})`;
  }
}
const TOKEN_RE = /(?<ws>\s+)|(?<comment>#[^\n]*)|(?<num>\d+(?:\.\d+)?)|(?<str>"(?:[^"\\]|\\.)*")|(?<id>[A-Za-z_]\w*)|(?<op>\*\*|==|!=|<=|>=|&&|\|\||\?\?|[-+*\/%<>=!(){},;?:\[\]])/y;
function* lex(src) {
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  scan: while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new SyntaxError(`bad char ${JSON.stringify(src[pos])} at ${pos}`);
    pos = TOKEN_RE.lastIndex;
    const g = m.groups;
    for (const [name, text] of Object.entries(g)) {
      if (text === undefined) continue;
      switch (name) {
        case 'ws':
        case 'comment':
          continue scan;
        case 'num':
          yield Token.make('num', text, m.index);
          continue scan;
        case 'str':
          yield Token.make('str', JSON.parse(text), m.index);
          continue scan;
        case 'id':
          yield Token.make(KEYWORDS.has(text) ? 'kw' : 'id', text, m.index);
          continue scan;
        default:
          yield Token.make('op', text, m.index);
          continue scan;
      }
    }
  }
  return Token.make('eof', '<eof>', pos);
}
function tokenize(src) {
  const out = [];
  const it = lex(src);
  let r;
  while (!(r = it.next()).done) out.push(r.value);
  out.push(r.value);
  return out;
}

// ---------------------------------------------------------------- AST
class Node {
  constructor(type) {
    if (new.target === Node) throw new TypeError('abstract Node');
    this.type = type;
  }
  children() { return []; }
  *walk(depth = 0) {
    yield [this, depth];
    for (const c of this.children()) if (c) yield* c.walk(depth + 1);
  }
}
class Expr extends Node {
  get isConst() { return false; }
}
class Lit extends Expr {
  constructor(value) { super('Lit'); this.value = value; }
  get isConst() { return true; }
}
class Var extends Expr { constructor(name) { super('Var'); this.name = name; } }
class Unary extends Expr { constructor(op, arg) { super('Unary'); Object.assign(this, { op, arg }); } children() { return [this.arg]; } }
class Binary extends Expr { constructor(op, left, right) { super('Binary'); Object.assign(this, { op, left, right }); } children() { return [this.left, this.right]; } }
class Logical extends Binary { constructor(op, left, right) { super(op, left, right); this.type = 'Logical'; } }
class Cond extends Expr { constructor(test, then, other) { super('Cond'); Object.assign(this, { test, then, other }); } children() { return [this.test, this.then, this.other]; } }
class Call extends Expr { constructor(callee, args) { super('Call'); Object.assign(this, { callee, args }); } children() { return [this.callee, ...this.args]; } }
class ArrayLit extends Expr { constructor(items) { super('Array'); this.items = items; } children() { return this.items; } }
class Index extends Expr { constructor(obj, idx) { super('Index'); Object.assign(this, { obj, idx }); } children() { return [this.obj, this.idx]; } }
class Assign extends Expr { constructor(name, value) { super('Assign'); Object.assign(this, { name, value }); } children() { return [this.value]; } }
class Stmt extends Node {}
class Block extends Stmt { constructor(body) { super('Block'); this.body = body; } children() { return this.body; } }
class LetS extends Stmt { constructor(name, init) { super('Let'); Object.assign(this, { name, init }); } children() { return [this.init]; } }
class ExprS extends Stmt { constructor(expr) { super('ExprS'); this.expr = expr; } children() { return [this.expr]; } }
class PrintS extends Stmt { constructor(args) { super('Print'); this.args = args; } children() { return this.args; } }
class IfS extends Stmt { constructor(test, then, other) { super('If'); Object.assign(this, { test, then, other }); } children() { return [this.test, this.then, this.other]; } }
class WhileS extends Stmt { constructor(test, body) { super('While'); Object.assign(this, { test, body }); } children() { return [this.test, this.body]; } }
class ForInS extends Stmt { constructor(name, iter, body) { super('ForIn'); Object.assign(this, { name, iter, body }); } children() { return [this.iter, this.body]; } }
class FnS extends Stmt { constructor(name, params, body) { super('Fn'); Object.assign(this, { name, params, body }); } children() { return [this.body]; } }
class ReturnS extends Stmt { constructor(value) { super('Return'); this.value = value; } children() { return [this.value]; } }
class JumpS extends Stmt { constructor(kind) { super(kind); } }

// ---------------------------------------------------------------- Pratt parser
const PREC = { '||': 1, '??': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '**': 7 };
const RIGHT = new Set(['**']);
class Parser {
  #toks;
  #i = 0;
  constructor(tokens) { this.#toks = tokens; }
  get #cur() { return this.#toks[this.#i]; }
  #next() { return this.#toks[this.#i++]; }
  #eat(kind, text) {
    const t = this.#cur;
    if (!t.is(kind, text)) throw new SyntaxError(`expected ${text ?? kind} got ${String(t)} @${+t}`);
    this.#i++;
    return t;
  }
  #maybe(kind, text) { return this.#cur.is(kind, text) ? (this.#i++, true) : false; }
  #list(close, item) {
    const xs = [];
    if (!this.#maybe('op', close)) {
      do xs.push(item()); while (this.#maybe('op', ','));
      this.#eat('op', close);
    }
    return xs;
  }
  #paren() { this.#eat('op', '('); const e = this.expr(0); this.#eat('op', ')'); return e; }
  #end(v) { this.#eat('op', ';'); return v; }
  program() {
    const body = [];
    while (!this.#cur.is('eof')) body.push(this.statement());
    return new Block(body);
  }
  block() {
    this.#eat('op', '{');
    const body = [];
    while (!this.#maybe('op', '}')) body.push(this.statement());
    return new Block(body);
  }
  statement() {
    const t = this.#cur;
    if (t.kind === 'kw') {
      switch ((this.#next(), t.text)) {
        case 'let': {
          const name = this.#eat('id').text;
          this.#eat('op', '=');
          return this.#end(new LetS(name, this.expr(0)));
        }
        case 'print': {
          const args = [this.expr(0)];
          while (this.#maybe('op', ',')) args.push(this.expr(0));
          return this.#end(new PrintS(args));
        }
        case 'if': {
          const test = this.#paren(), then = this.block();
          const other = this.#maybe('kw', 'else') ? (this.#cur.is('kw', 'if') ? this.statement() : this.block()) : null;
          return new IfS(test, then, other);
        }
        case 'while': return new WhileS(this.#paren(), this.block());
        case 'for': {
          const name = this.#eat('id').text;
          this.#eat('kw', 'in');
          return new ForInS(name, this.expr(0), this.block());
        }
        case 'fn': {
          const name = this.#eat('id').text;
          this.#eat('op', '(');
          return new FnS(name, this.#list(')', () => this.#eat('id').text), this.block());
        }
        case 'return': return this.#end(new ReturnS(this.#cur.is('op', ';') ? new Lit(null) : this.expr(0)));
        case 'break':
        case 'continue': return this.#end(new JumpS(t.text === 'break' ? 'Break' : 'Continue'));
        default: this.#i--;
      }
    }
    return this.#end(new ExprS(this.expr(0)));
  }
  prefix() {
    const t = this.#next();
    switch (t.kind) {
      case 'num': return new Lit(Number(t.text));
      case 'str': return new Lit(t.text);
      case 'kw':
        if (t.text === 'true' || t.text === 'false') return new Lit(t.text === 'true');
        if (t.text === 'nil') return new Lit(null);
        break;
      case 'id':
        if (this.#cur.is('op', '=') ) {
          this.#next();
          return new Assign(t.text, this.expr(0));
        }
        return new Var(t.text);
      case 'op':
        if (t.text === '(') { const e = this.expr(0); this.#eat('op', ')'); return e; }
        if (t.text === '-' || t.text === '!') return new Unary(t.text, this.expr(8));
        if (t.text === '[') return new ArrayLit(this.#list(']', () => this.expr(0)));
    }
    throw new SyntaxError(`unexpected ${String(t)}`);
  }
  expr(minPrec) {
    let left = this.prefix();
    for (;;) {
      const t = this.#cur;
      if (t.is('op', '(')) {
        this.#next();
        left = new Call(left, this.#list(')', () => this.expr(0)));
        continue;
      }
      if (t.is('op', '[')) {
        this.#next();
        const idx = this.expr(0);
        this.#eat('op', ']');
        left = new Index(left, idx);
        continue;
      }
      if (t.is('op', '?') && minPrec === 0) {
        this.#next();
        const a = this.expr(0);
        this.#eat('op', ':');
        const b = this.expr(0);
        left = new Cond(left, a, b);
        continue;
      }
      const p = t.kind === 'op' ? PREC[t.text] : undefined;
      if (p === undefined || p < minPrec) break;
      this.#next();
      const right = this.expr(RIGHT.has(t.text) ? p : p + 1);
      left = ['&&', '||', '??'].includes(t.text) ? new Logical(t.text, left, right) : new Binary(t.text, left, right);
    }
    return left;
  }
}

// ---------------------------------------------------------------- printer (tagged template)
function sx(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += (v instanceof Node ? show(v) : String(v)) + strings[i + 1]; });
  return out;
}
function show(n) {
  switch (n?.type) {
    case 'Lit': return typeof n.value === 'string' ? JSON.stringify(n.value) : String(n.value);
    case 'Var': return n.name;
    case 'Unary': return sx`(${n.op}${n.arg})`;
    case 'Binary':
    case 'Logical': return sx`(${n.left} ${n.op} ${n.right})`;
    case 'Cond': return sx`(${n.test} ? ${n.then} : ${n.other})`;
    case 'Call': return `${show(n.callee)}(${n.args.map(show).join(', ')})`;
    case 'Array': return `[${n.items.map(show).join(', ')}]`;
    case 'Index': return sx`${n.obj}[${n.idx}]`;
    case 'Assign': return sx`${n.name} = ${n.value}`;
    case undefined: return 'nil?';
    default: return `<${n.type}>`;
  }
}

// ---------------------------------------------------------------- optimizer
const FOLD = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b,
  '/': (a, b) => (b === 0 ? NaN : a / b), '%': (a, b) => a % b, '**': (a, b) => a ** b,
  '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};
const stats = new Proxy({}, {
  get(t, k) { return k in t ? t[k] : 0; },
  set(t, k, v) { t[k] = v; return true; },
});
function optimize(node) {
  if (!node) return node;
  switch (node.type) {
    case 'Block': {
      const body = [];
      outer: for (const s of node.body) {
        const o = optimize(s);
        if (o === null) { stats.deadStmt++; continue; }
        body.push(o);
        switch (o.type) {
          case 'Return': case 'Break': case 'Continue':
            stats.unreachable += node.body.length - node.body.indexOf(s) - 1;
            break outer;
        }
      }
      return new Block(body);
    }
    case 'Binary': {
      const l = optimize(node.left), r = optimize(node.right);
      if (l.isConst && r.isConst && typeof l.value === typeof r.value) {
        stats.folded++;
        return new Lit(FOLD[node.op](l.value, r.value));
      }
      // algebraic identities
      if (node.op === '*' && (r.isConst && r.value === 1)) { stats.ident++; return l; }
      if (node.op === '+' && r.isConst && r.value === 0 && typeof r.value === 'number') { stats.ident++; return l; }
      if (node.op === '*' && l.isConst && l.value === 2) { stats.strength++; return new Binary('+', r, r); }
      return new Binary(node.op, l, r);
    }
    case 'Logical': {
      const l = optimize(node.left), r = optimize(node.right);
      if (l.isConst) {
        stats.folded++;
        switch (node.op) {
          case '&&': return l.value ? r : l;
          case '||': return l.value ? l : r;
          default: return l.value !== null && l.value !== undefined ? l : r;
        }
      }
      return new Logical(node.op, l, r);
    }
    case 'Unary': {
      const a = optimize(node.arg);
      if (a.isConst) { stats.folded++; return new Lit(node.op === '-' ? -a.value : !a.value); }
      if (a.type === 'Unary' && a.op === node.op && node.op === '!') { stats.ident++; return new Unary('!', new Unary('!', a.arg)); }
      return new Unary(node.op, a);
    }
    case 'Cond': {
      const t = optimize(node.test);
      if (t.isConst) { stats.branch++; return optimize(t.value ? node.then : node.other); }
      return new Cond(t, optimize(node.then), optimize(node.other));
    }
    case 'If': {
      const t = optimize(node.test);
      if (t.isConst) {
        stats.branch++;
        return t.value ? optimize(node.then) : (node.other ? optimize(node.other) : null);
      }
      return new IfS(t, optimize(node.then), node.other && optimize(node.other));
    }
    case 'While': {
      const t = optimize(node.test);
      if (t.isConst && !t.value) { stats.branch++; return null; }
      return new WhileS(t, optimize(node.body));
    }
    case 'Call': return new Call(optimize(node.callee), node.args.map(optimize));
    case 'Array': return new ArrayLit(node.items.map(optimize));
    case 'Index': return new Index(optimize(node.obj), optimize(node.idx));
    case 'Assign': return new Assign(node.name, optimize(node.value));
    case 'Let': return new LetS(node.name, optimize(node.init));
    case 'ExprS': return new ExprS(optimize(node.expr));
    case 'Print': return new PrintS(node.args.map(optimize));
    case 'ForIn': return new ForInS(node.name, optimize(node.iter), optimize(node.body));
    case 'Fn': return new FnS(node.name, node.params, optimize(node.body));
    case 'Return': return new ReturnS(optimize(node.value));
    default: return node;
  }
}

// ---------------------------------------------------------------- tree-walking evaluator
class ControlSignal { constructor(kind, value) { this.kind = kind; this.value = value; } }
const BREAK = new ControlSignal('break');
const CONTINUE = new ControlSignal('continue');
class Env {
  constructor(parent = null) { this.vars = new Map(); this.parent = parent; }
  lookup(name) { for (let e = this; e; e = e.parent) if (e.vars.has(name)) return e; return null; }
  get(name) { const e = this.lookup(name); if (!e) throw new ReferenceError(`undefined ${name}`); return e.vars.get(name); }
  set(name, v) { (this.lookup(name) ?? this).vars.set(name, v); return v; }
  def(name, v) { this.vars.set(name, v); }
}
function fmt(v) {
  if (v === null || v === undefined) return 'nil';
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (typeof v === 'object' && v.kind === 'closure') return `<fn/${v.params.length}>`;
  if (typeof v === 'function') return '<native>';
  return String(v);
}
function makeBuiltins(out) {
  return {
    len: (a) => a.length,
    push: (a, v) => (a.push(v), a),
    range: (n, m) => { const r = []; for (let i = m === undefined ? 0 : n, e = m ?? n; i < e; i++) r.push(i); return r; },
    str: (v) => fmt(v),
    floor: Math.floor,
    emit: (...xs) => { out.push('emit:' + xs.map(fmt).join('|')); return xs.length; },
  };
}
function evalTree(prog) {
  const out = [];
  const g = new Env();
  for (const [k, v] of Object.entries(makeBuiltins(out))) g.def(k, v);
  let steps = 0;
  function call(fn, args) {
    if (typeof fn === 'function') return fn(...args);
    const env = new Env(fn.env);
    fn.params.forEach((p, i) => env.def(p, args[i] ?? null));
    try {
      exec(fn.body, env);
    } catch (sig) {
      if (sig instanceof ControlSignal && sig.kind === 'return') return sig.value;
      throw sig;
    }
    return null;
  }
  function ev(n, env) {
    steps++;
    switch (n.type) {
      case 'Lit': return n.value;
      case 'Var': return env.get(n.name);
      case 'Assign': return env.set(n.name, ev(n.value, env));
      case 'Unary': { const a = ev(n.arg, env); return n.op === '-' ? -a : !a; }
      case 'Logical': {
        const l = ev(n.left, env);
        return n.op === '&&' ? (l ? ev(n.right, env) : l) : n.op === '||' ? (l ? l : ev(n.right, env)) : (l ?? ev(n.right, env));
      }
      case 'Binary': return FOLD[n.op](ev(n.left, env), ev(n.right, env));
      case 'Cond': return ev(n.test, env) ? ev(n.then, env) : ev(n.other, env);
      case 'Array': return n.items.map((x) => ev(x, env));
      case 'Index': return ev(n.obj, env)[ev(n.idx, env)] ?? null;
      case 'Call': return call(ev(n.callee, env), n.args.map((a) => ev(a, env)));
    }
    throw new Error('ev ' + n.type);
  }
  function exec(s, env) {
    if (!s) return;
    switch (s.type) {
      case 'Block': { const e = new Env(env); for (const x of s.body) exec(x, e); return; }
      case 'Let': env.def(s.name, ev(s.init, env)); return;
      case 'ExprS': ev(s.expr, env); return;
      case 'Print': out.push(s.args.map((a) => fmt(ev(a, env))).join(' ')); return;
      case 'If': if (ev(s.test, env)) exec(s.then, env); else exec(s.other, env); return;
      case 'While':
        loop: while (ev(s.test, env)) {
          try { exec(s.body, env); } catch (sig) {
            switch (sig) { case BREAK: break loop; case CONTINUE: continue loop; default: throw sig; }
          }
        }
        return;
      case 'ForIn': {
        loop: for (const item of ev(s.iter, env)) {
          const e = new Env(env);
          e.def(s.name, item);
          try { exec(s.body, e); } catch (sig) {
            switch (sig) { case CONTINUE: continue loop; case BREAK: break loop; default: throw sig; }
          } finally { e.def(s.name, null); }
        }
        return;
      }
      case 'Fn': env.def(s.name, { kind: 'closure', params: s.params, body: s.body, env }); return;
      case 'Return': throw new ControlSignal('return', ev(s.value, env));
      case 'Break': throw BREAK;
      case 'Continue': throw CONTINUE;
    }
    throw new Error('exec ' + s.type);
  }
  exec(prog, g);
  return { out, steps };
}

// ---------------------------------------------------------------- bytecode emitter
const OP = Object.freeze({
  CONST: 1, LOAD: 2, STORE: 3, DEF: 4, POP: 5, BIN: 6, NEG: 7, NOT: 8, JMP: 9, JF: 10, JT: 11,
  CALL: 12, RET: 13, PRINT: 14, ARR: 15, IDX: 16, CLOS: 17, DUP: 18, ENTER: 19, LEAVE: 20, ITER: 21, NEXT: 22, JNN: 23, HALT: 0,
});
const OPNAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));
class Chunk {
  constructor(name, params = []) { Object.assign(this, { name, params, code: [], consts: [] }); }
  emit(op, ...args) { this.code.push(op, ...args); return this.code.length - args.length - 1; }
  k(v) { const i = this.consts.findIndex((c) => Object.is(c, v)); return i < 0 ? this.consts.push(v) - 1 : i; }
  patch(at, target) { this.code[at + 1] = target; }
  get here() { return this.code.length; }
}
class Emitter {
  constructor() { [this.chunks, this.loops, this.depth] = [[], [], 0]; }
  compile(prog) {
    const main = new Chunk('main');
    this.chunks.push(main);
    this.block(prog, main, false);
    main.emit(OP.HALT);
    return this.chunks;
  }
  block(b, c, scoped = true) {
    if (scoped) { c.emit(OP.ENTER); this.depth++; }
    try {
      for (const s of b.body) this.stmt(s, c);
    } finally {
      if (scoped) { c.emit(OP.LEAVE, 1); this.depth--; }
    }
  }
  stmt(s, c) {
    switch (s.type) {
      case 'Block': return this.block(s, c);
      case 'Let': this.expr(s.init, c); c.emit(OP.DEF, c.k(s.name)); return;
      case 'ExprS': this.expr(s.expr, c); c.emit(OP.POP); return;
      case 'Print': for (const a of s.args) this.expr(a, c); c.emit(OP.PRINT, s.args.length); return;
      case 'If': {
        this.expr(s.test, c);
        const jf = c.emit(OP.JF, 0);
        this.stmt(s.then, c);
        const j = s.other ? c.emit(OP.JMP, 0) : -1;
        c.patch(jf, c.here);
        if (~j) { this.stmt(s.other, c); c.patch(j, c.here); }
        return;
      }
      case 'While': {
        const top = c.here;
        this.expr(s.test, c);
        const jf = c.emit(OP.JF, 0);
        const loop = { breaks: [], conts: [], depth: this.depth, contDepth: this.depth };
        this.loops.push(loop);
        this.stmt(s.body, c);
        this.loops.pop();
        c.emit(OP.JMP, top);
        c.patch(jf, c.here);
        loop.breaks.forEach((b) => c.patch(b, c.here));
        loop.conts.forEach((j) => c.patch(j, top));
        return;
      }
      case 'ForIn': {
        this.expr(s.iter, c);
        c.emit(OP.ITER);
        const top = c.here;
        const nx = c.emit(OP.NEXT, 0);
        const loop = { breaks: [], conts: [], depth: this.depth, contDepth: this.depth + 1 };
        c.emit(OP.ENTER);
        this.depth++;
        c.emit(OP.DEF, c.k(s.name));
        this.loops.push(loop);
        this.stmt(s.body, c);
        this.loops.pop();
        const contTarget = c.here;
        c.emit(OP.LEAVE, 1);
        this.depth--;
        c.emit(OP.JMP, top);
        const end = c.here;
        c.patch(nx, end);
        loop.conts.forEach((j) => c.patch(j, contTarget));
        loop.breaks.forEach((b) => c.patch(b, end));
        c.emit(OP.POP);
        return;
      }
      case 'Fn': {
        const fc = new Chunk(s.name, s.params);
        const idx = this.chunks.push(fc) - 1;
        const [savedLoops, savedDepth] = [this.loops, this.depth];
        this.loops = [];
        this.depth = 0;
        this.block(s.body, fc, false);
        fc.emit(OP.CONST, fc.k(null));
        fc.emit(OP.RET);
        [this.loops, this.depth] = [savedLoops, savedDepth];
        c.emit(OP.CLOS, idx);
        c.emit(OP.DEF, c.k(s.name));
        return;
      }
      case 'Return': this.expr(s.value, c); c.emit(OP.RET); return;
      case 'Break': case 'Continue': {
        const loop = this.loops.at(-1);
        if (!loop) throw new SyntaxError(`${s.type.toLowerCase()} outside loop`);
        const isBreak = s.type === 'Break';
        const pops = this.depth - (isBreak ? loop.depth : loop.contDepth);
        if (pops > 0) c.emit(OP.LEAVE, pops);
        (isBreak ? loop.breaks : loop.conts).push(c.emit(OP.JMP, 0));
        return;
      }
    }
    throw new Error('emit ' + s.type);
  }
  expr(e, c) {
    switch (e.type) {
      case 'Lit': c.emit(OP.CONST, c.k(e.value)); return;
      case 'Var': c.emit(OP.LOAD, c.k(e.name)); return;
      case 'Assign': this.expr(e.value, c); c.emit(OP.DUP); c.emit(OP.STORE, c.k(e.name)); return;
      case 'Unary': this.expr(e.arg, c); c.emit(e.op === '-' ? OP.NEG : OP.NOT); return;
      case 'Binary': this.expr(e.left, c); this.expr(e.right, c); c.emit(OP.BIN, c.k(e.op)); return;
      case 'Logical': {
        this.expr(e.left, c);
        c.emit(OP.DUP);
        const j = c.emit(e.op === '&&' ? OP.JF : e.op === '||' ? OP.JT : OP.JNN, 0);
        c.emit(OP.POP);
        this.expr(e.right, c);
        c.patch(j, c.here);
        return;
      }
      case 'Cond': {
        this.expr(e.test, c);
        const jf = c.emit(OP.JF, 0);
        this.expr(e.then, c);
        const j = c.emit(OP.JMP, 0);
        c.patch(jf, c.here);
        this.expr(e.other, c);
        c.patch(j, c.here);
        return;
      }
      case 'Array': e.items.forEach((x) => this.expr(x, c)); c.emit(OP.ARR, e.items.length); return;
      case 'Index': this.expr(e.obj, c); this.expr(e.idx, c); c.emit(OP.IDX); return;
      case 'Call': this.expr(e.callee, c); e.args.forEach((a) => this.expr(a, c)); c.emit(OP.CALL, e.args.length); return;
    }
    throw new Error('emit expr ' + e.type);
  }
}
function disasm(chunk, limit = 40) {
  const lines = [];
  const ARGC = { [OP.CONST]: 1, [OP.LOAD]: 1, [OP.STORE]: 1, [OP.DEF]: 1, [OP.BIN]: 1, [OP.JMP]: 1, [OP.JF]: 1, [OP.JT]: 1, [OP.JNN]: 1, [OP.CALL]: 1, [OP.PRINT]: 1, [OP.ARR]: 1, [OP.CLOS]: 1, [OP.NEXT]: 1, [OP.LEAVE]: 1 };
  let pc = 0;
  while (pc < chunk.code.length && lines.length < limit) {
    const op = chunk.code[pc];
    let n = ARGC[op] ?? 0;
    const args = chunk.code.slice(pc + 1, pc + 1 + n);
    const pretty = args.map((a) => ([OP.CONST, OP.LOAD, OP.STORE, OP.DEF, OP.BIN].includes(op) ? JSON.stringify(chunk.consts[a]) : a));
    lines.push(`${String(pc).padStart(4, '0')} ${OPNAME[op]}${pretty.length ? ' ' + pretty.join(',') : ''}`);
    pc += 1 + n;
  }
  return lines;
}

// ---------------------------------------------------------------- VM
function runVM(chunks) {
  const out = [];
  const builtins = makeBuiltins(out);
  const globals = new Env();
  for (const [k, v] of Object.entries(builtins)) globals.def(k, v);
  const frames = [];
  let frame = { chunk: chunks[0], pc: 0, env: globals, stack: [], scopes: [] };
  let cycles = 0;
  run: for (;;) {
    cycles++;
    if (cycles > 5e6) throw new RangeError('cycle limit');
    const { chunk } = frame;
    const code = chunk.code;
    const op = code[frame.pc++];
    const st = frame.stack;
    switch (op) {
      case OP.HALT:
        break run;
      case OP.CONST: st.push(chunk.consts[code[frame.pc++]]); break;
      case OP.LOAD: st.push(frame.env.get(chunk.consts[code[frame.pc++]])); break;
      case OP.STORE: frame.env.set(chunk.consts[code[frame.pc++]], st.pop()); break;
      case OP.DEF: frame.env.def(chunk.consts[code[frame.pc++]], st.pop()); break;
      case OP.DUP: st.push(st[st.length - 1]); break;
      case OP.POP: st.pop(); break;
      case OP.BIN: { const b = st.pop(), a = st.pop(); st.push(FOLD[chunk.consts[code[frame.pc++]]](a, b)); break; }
      case OP.NEG: st.push(-st.pop()); break;
      case OP.NOT: st.push(!st.pop()); break;
      case OP.JNN: {
        const t = code[frame.pc++];
        const v = st.pop();
        if (v !== null && v !== undefined) frame.pc = t;
        break;
      }
      case OP.JT:
      case OP.JF: {
        const t = code[frame.pc++];
        const v = st.pop();
        if (op === OP.JT) { if (v) frame.pc = t; }
        else if (!v) frame.pc = t;
        break;
      }
      case OP.JMP: frame.pc = code[frame.pc]; break;
      case OP.ENTER: frame.scopes.push(frame.env); frame.env = new Env(frame.env); break;
      case OP.LEAVE: {
        let n = code[frame.pc++];
        do frame.env = frame.scopes.pop(); while (--n > 0);
        break;
      }
      case OP.ARR: { const n = code[frame.pc++]; st.push(st.splice(st.length - n, n)); break; }
      case OP.IDX: { const i = st.pop(), a = st.pop(); st.push(a[i] ?? null); break; }
      case OP.ITER: st.push({ arr: st.pop(), i: 0 }); break;
      case OP.NEXT: {
        const t = code[frame.pc++];
        const it = st[st.length - 1];
        if (it.i >= it.arr.length) { frame.pc = t; break; }
        st.push(it.arr[it.i++]);
        break;
      }
      case OP.CLOS: st.push({ kind: 'closure', chunkIdx: code[frame.pc++], env: frame.env, params: chunks[code[frame.pc - 1]].params }); break;
      case OP.CALL: {
        const n = code[frame.pc++];
        const args = st.splice(st.length - n, n);
        const fn = st.pop();
        if (typeof fn === 'function') { st.push(fn(...args)); break; }
        const env = new Env(fn.env);
        fn.params.forEach((p, i) => env.def(p, args[i] ?? null));
        frames.push(frame);
        if (frames.length > 4000) throw new RangeError('stack overflow');
        frame = { chunk: chunks[fn.chunkIdx], pc: 0, env, stack: [], scopes: [] };
        break;
      }
      case OP.RET: {
        const v = st.pop();
        frame = frames.pop();
        frame.stack.push(v);
        break;
      }
      case OP.PRINT: {
        const n = code[frame.pc++];
        out.push(st.splice(st.length - n, n).map(fmt).join(' '));
        break;
      }
      default:
        throw new Error(`bad opcode ${op} at ${frame.pc - 1}`);
    }
  }
  return { out, cycles };
}

// ---------------------------------------------------------------- test programs
const PROGRAMS = {
  arith: `let a = 2 + 3 * 4; let b = 2 ** 3 ** 2;
    print a, b, (a - b) % 7, -a + 10;
    print 1 < 2 && 3 > 4 || 5 == 5, nil ?? "dflt", 0 ?? 9;
    print true ? 1 + 1 : 0, false ? 1 : 2 * 1, 2 * a;`,
  fib: `fn fib(n) { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }
    let i = 0; let acc = [];
    while (i < 15) { acc = push(acc, fib(i)); i = i + 1; }
    print acc; print len(acc), acc[14], acc[99] ?? "none";`,
  loops: `let total = 0;
    for x in range(1, 20) {
      if (x % 3 == 0) { continue; } if (x > 16) { break; }
      total = total + x; let sq = x * x;
      if (sq % 5 == 1) { emit(x, sq); }
    }
    print "total", total; let n = 0; let k = 0;
    while (true) { n = n + 1; if (n % 2 == 0) { continue; } k = k + n; if (n > 21) { break; } }
    print n, k;`,
  closures: `fn counter(start) { let c = start; fn inc(by) { c = c + by; return c; } return inc; }
    let c1 = counter(10); let c2 = counter(100);
    print c1(1), c1(2), c2(5), c1(3), c2(0);
    fn compose(f, g) { fn h(x) { return f(g(x)); } return h; }
    fn dbl(x) { return 2 * x; } fn inc(x) { return x + 1; }
    let h = compose(dbl, inc); let hh = compose(h, h);
    print h(5), hh(5), compose(inc, dbl)(5);`,
  deadcode: `if (1 + 1 == 3) { print "never"; } else { print "folded-else"; }
    while (false) { print "no"; }
    fn early(x) { return x * 1 + 0; print "dead"; }
    print early(42), 3 * 4 - 2 ** 2, "a" + "b"; let z = 5;
    print (true && z) || 7, !!z, !(z > 3);`,
  mutual: `fn isEven(n) { if (n == 0) { return true; } return isOdd(n - 1); }
    fn isOdd(n) { if (n == 0) { return false; } return isEven(n - 1); }
    print isEven(10), isOdd(7), isEven(301);
    fn ack(m, n) { if (m == 0) { return n + 1; } if (n == 0) { return ack(m - 1, 1); } return ack(m - 1, ack(m, n - 1)); }
    print ack(2, 3), ack(1, 5);`,
  nested: `let grid = [];
    for r in range(4) {
      let row = [];
      for c in range(5) { if (c == r) { continue; } if (c > 3) { break; } row = push(row, r * 10 + c); }
      grid = push(grid, row);
    }
    print grid; let found = nil;
    for row in grid { for v in row { if (v % 7 == 0 && v > 0) { found = found ?? v; } } }
    print "found", found;`,
};

// ---------------------------------------------------------------- driver
function pipeline(name, src) {
  const toks = tokenize(src);
  const ast = new Parser(toks).program();
  let nodes = 0, maxDepth = 0;
  for (const [, d] of ast.walk()) { nodes++; maxDepth = Math.max(maxDepth, d); }
  const before = { ...stats };
  const opt = optimize(ast);
  let optNodes = 0;
  for (const _ of opt.walk()) optNodes++;
  const ref = evalTree(ast);
  const refOpt = evalTree(opt);
  const chunks = new Emitter().compile(opt);
  const vm = runVM(chunks);
  const same = JSON.stringify(ref.out) === JSON.stringify(vm.out) && JSON.stringify(ref.out) === JSON.stringify(refOpt.out);
  log(`== ${name}: tokens=${toks.length} nodes=${nodes}->${optNodes} depth=${maxDepth} chunks=${chunks.length} code=${chunks.reduce((s, c) => s + c.code.length, 0)}`);
  const delta = Object.keys(stats).filter((k) => stats[k] !== (before[k] ?? 0)).map((k) => `${k}+${stats[k] - (before[k] ?? 0)}`);
  log(`   opt: ${delta.join(' ') || '(none)'}`);
  for (const line of vm.out) log(`   | ${line}`);
  log(`   agree=${same} steps(tree)=${ref.steps} steps(opt)=${refOpt.steps}`);
  if (!same) { log('   REF', ref.out); log('   VM ', vm.out); }
  return { chunks, opt, vm };
}
const results = {};
for (const [name, src] of Object.entries(PROGRAMS)) {
  try {
    results[name] = pipeline(name, src);
  } catch (e) {
    log(`!! ${name} failed: ${e.constructor === SyntaxError ? 'SyntaxError' : e.constructor === RangeError ? 'RangeError' : 'Error'}: ${e.message}`);
  } finally {
    log(`   tokens created so far: ${Token.created}`);
  }
}
// disassembly excerpts
log('--- disasm fib.fib');
const fibChunks = results.fib?.chunks ?? [];
for (const line of disasm(fibChunks[1] ?? fibChunks[0], 24)) log('  ' + line);
log('--- disasm arith.main (first 16)');
for (const line of disasm(results.arith.chunks[0], 16)) log('  ' + line);
// pretty-print expressions after optimisation
log('--- expressions');
const exprSrcs = ['1 + 2 * x', '(1 + 2) * x', 'a ?? b || c && d', '2 * (y + 0) * 1', '-(-3) + !false', 'f(1, g(2), [3, 4][1])', 'x ? y ? 1 : 2 : 3', '2 ** 3 ** 2 == 512'];
for (const s of exprSrcs) {
  const e = new Parser(tokenize(s)).expr(0);
  log(`  ${s.padEnd(26)} => ${show(e).padEnd(34)} opt ${show(optimize(e))}`);
}
// error handling paths
log('--- errors');
const bad = ['let = 3;', 'print 1 +;', 'fn (x) {}', 'let s = "unterminated;', 'break;', 'print undefinedVar;', 'fn r(n) { return r(n + 1); } r(0);'];
bad.forEach((src, i) => {
  let stage = 'lex';
  try {
    const t = tokenize(src);
    stage = 'parse';
    const a = new Parser(t).program();
    stage = 'emit';
    const ch = new Emitter().compile(optimize(a));
    stage = 'run';
    runVM(ch);
    log(`  #${i} ok?!`);
  } catch (err) {
    const kind = err instanceof SyntaxError ? 'Syntax' : err instanceof ReferenceError ? 'Reference' : err instanceof RangeError ? 'Range' : 'Other';
    log(`  #${i} ${stage}: ${kind} ${err.message.replace(/@\d+/, '@N')}`);
  }
});
// token primitives & abstract checks
log('--- misc');
const tk = tokenize('let q = 1;');
log(`  ${tk.map((t) => `${t}`).join(' ')}`, `pos-sum=${tk.reduce((s, t) => s + +t, 0)}`);
try { new Node('x'); } catch (e) { log('  abstract:', e.message); }
log('  instanceof chain:', [new Logical('&&', new Lit(1), new Lit(2))].map((l) => [l instanceof Binary, l instanceof Expr, l instanceof Node, l instanceof Stmt]));
log('  keyword count', KEYWORDS.size, 'ops', Object.keys(OP).length, 'stats', JSON.stringify(stats));
// Big generated program stress: generate nested arithmetic
function genExpr(depth, seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const go = (d) => {
    if (d === 0 || rnd() < 0.2) return rnd() < 0.5 ? String(Math.floor(rnd() * 9) + 1) : 'v';
    const ops = ['+', '-', '*', '%'];
    const op = ops[Math.floor(rnd() * ops.length)];
    return `(${go(d - 1)} ${op} ${op === '%' ? String(Math.floor(rnd() * 5) + 2) : go(d - 1)})`;
  };
  return go(depth);
}
let agreeCount = 0;
for (let seed = 1; seed <= 12; seed++) {
  const e = genExpr(5, seed * 7919);
  const src = `let v = ${seed}; let r = ${e}; print r;`;
  const tree = evalTree(new Parser(tokenize(src)).program()).out[0];
  const vm = runVM(new Emitter().compile(optimize(new Parser(tokenize(src)).program()))).out[0];
  const js = String(new Function('v', `return ${e};`)(seed));
  if (tree === vm && vm === js) agreeCount++;
  else log(`  mismatch seed=${seed}: ${tree} ${vm} ${js}`);
  if (seed % 4 === 0) log(`  gen seed=${seed} len=${e.length} value=${vm}`);
}
log('  generated agree', agreeCount, '/ 12');
// deep recursion in the VM (~3000 frames)
const deep = runVM(new Emitter().compile(new Parser(tokenize('fn d(n) { if (n == 0) { return 0; } return 1 + d(n - 1); } print d(3000);')).program()));
log('  deep recursion', deep.out[0], 'cycles', deep.cycles);

// ---------------------------------------------------------------- async batch compile + bytecode analytics
class InstrStream {
  #chunk;
  constructor(chunk) { this.#chunk = chunk; }
  *[Symbol.iterator]() {
    const ARGLESS = new Set([OP.POP, OP.NEG, OP.NOT, OP.RET, OP.IDX, OP.DUP, OP.ENTER, OP.ITER, OP.HALT]);
    for (let pc = 0; pc < this.#chunk.code.length;) {
      const op = this.#chunk.code[pc];
      const arg = ARGLESS.has(op) ? undefined : this.#chunk.code[pc + 1];
      yield { pc, op: OPNAME[op], arg };
      pc += arg === undefined ? 1 : 2;
    }
  }
  static histogram(chunks) {
    const h = new Map();
    for (const c of chunks) for (const { op } of new InstrStream(c)) h.set(op, (h.get(op) ?? 0) + 1);
    return [...h].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  }
}
function checksum() {
  let h = 0xcbf29ce484222325n;
  for (const arr of arguments) for (const v of arr) {
    h ^= BigInt(typeof v === 'number' ? v >>> 0 : String(v).length);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
async function compileAsync(name, src, delayTicks) {
  for (let i = 0; i < delayTicks; i++) await null;
  const { chunks, opt } = pipelineQuiet(src);
  return { name, chunks, size: chunks.reduce((s, { code }) => s + code.length, 0), stmts: opt.body.length };
}
function pipelineQuiet(src) {
  const opt = optimize(new Parser(tokenize(src)).program());
  return { opt, chunks: new Emitter().compile(opt) };
}
(async () => {
  const order = [];
  const jobs = Object.entries(PROGRAMS).map(([name, src], i) => compileAsync(name, src, (i * 5) % 7).then((r) => (order.push(name), r)));
  const all = await Promise.all(jobs);
  log('--- async compile order', order.join(','));
  for (const { name, size, stmts, chunks: [main, ...fns] } of all) {
    log(`  ${name.padEnd(9)} size=${String(size).padStart(4)} stmts=${stmts} fns=${fns.length} sum=${checksum(main.code, ...fns.map((f) => f.code))}`);
  }
  const hist = InstrStream.histogram(all.flatMap((r) => r.chunks));
  log('  top ops', hist.slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' '));
  const settled = await Promise.allSettled(['print 1;', 'print (;', 'let x = 1; print x + y;'].map(async (src) => runVM(pipelineQuiet(src).chunks).out));
  settled.forEach(({ status, value, reason }, i) => log(`  settled#${i} ${status} ${value ? JSON.stringify(value) : reason.message}`));
  const first = await Promise.any([Promise.reject(new Error('x')), compileAsync('late', 'print 2;', 3), compileAsync('early', 'print 3;', 1)]);
  log('  any ->', first.name);
})();
