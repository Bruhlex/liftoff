// d22: interpreter for a stack-based Forth-like language.
// User words, IF/ELSE/THEN, DO/LOOP, BEGIN/UNTIL/WHILE/REPEAT, CATCH/THROW,
// variables, constants, strings, recursion, a compiler to closures and a tracer.

'use strict';

const lines = [];
function say(...parts) {
  const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  lines.push(s);
  console.log(s);
}

// ---------- errors ----------
class ForthError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
  get [Symbol.toStringTag]() { return 'ForthError'; }
}
class StackUnderflow extends ForthError {
  constructor(word) { super(-4, `stack underflow in ${word}`); }
}
class UndefinedWord extends ForthError {
  constructor(word) { super(-13, `undefined word ${word}`); }
}
class UserThrow extends ForthError {
  constructor(code) { super(code, `throw ${code}`); }
}
class ExitSignal {
  constructor() { this.exit = true; }
}
class LeaveSignal {}

// ---------- tokenizer with sticky regex ----------
const TOKEN_RE = /\s*(?:(?<comment>\\[^\n]*|\(\s[^)]*\))|(?<str>(?:\.|s)"\s[^"]*")|(?<num>-?\d+n?(?![^\s]))|(?<word>\S+))/y;

function* tokenize(src) {
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src))) {
    const { comment, str, num, word } = m.groups;
    if (comment !== undefined) continue;
    if (str !== undefined) {
      const kind = str[0] === '.' ? 'print' : 'string';
      yield { t: kind, v: str.slice(3, -1) };
    } else if (num !== undefined) {
      yield num.endsWith('n') ? { t: 'num', v: BigInt(num.slice(0, -1)) } : { t: 'num', v: Number(num) };
    } else if (word !== undefined) {
      yield { t: 'word', v: word.toLowerCase() };
    } else {
      break;
    }
  }
}

// ---------- the data stack ----------
class Stack {
  #items = [];
  #name;
  #maxDepth = 0;
  constructor(name) { this.#name = name; }
  push(...xs) {
    this.#items.push(...xs);
    if (this.#items.length > this.#maxDepth) this.#maxDepth = this.#items.length;
  }
  pop(word = '?') {
    if (this.#items.length === 0) throw new StackUnderflow(word + '@' + this.#name);
    return this.#items.pop();
  }
  popN(n, word) {
    if (this.#items.length < n) throw new StackUnderflow(word + '@' + this.#name);
    return this.#items.splice(this.#items.length - n, n);
  }
  peek(i = 0) { return this.#items[this.#items.length - 1 - i]; }
  get depth() { return this.#items.length; }
  get max() { return this.#maxDepth; }
  clear() { this.#items.length = 0; }
  snapshot() { return this.#items.map((x) => (typeof x === 'bigint' ? x + 'n' : x)); }
  *[Symbol.iterator]() { yield* this.#items; }
  static isStack(o) { return #items in o; }
}

// ---------- dictionary with vocabulary layering ----------
class Dictionary {
  constructor(parent = null) {
    this.parent = parent;
    this.words = new Map();
  }
  define(name, entry) { this.words.set(name, entry); return entry; }
  lookup(name) {
    let d = this;
    while (d) {
      const e = d.words.get(name);
      if (e) return e;
      d = d.parent;
    }
    return undefined;
  }
  *allNames() {
    if (this.parent) yield* this.parent.allNames();
    yield* this.words.keys();
  }
}

// ---------- base VM with primitives ----------
class BaseVM {
  constructor() {
    this.ds = new Stack('data');
    this.rs = new Stack('return');
    this.output = '';
    this.memory = [];
    this.dict = new Dictionary();
    this.steps = 0;
    this.installCore();
  }
  emit(s) { this.output += s; }
  flush() {
    const o = this.output;
    this.output = '';
    return o;
  }
  prim(name, arity, fn) {
    const vm = this;
    this.dict.define(name, {
      kind: 'prim',
      run() {
        const args = vm.ds.popN(arity, name);
        const res = fn.apply(vm, args);
        if (res !== undefined) Array.isArray(res) ? vm.ds.push(...res) : vm.ds.push(res);
      },
    });
  }
  installCore() {
    const numOp = (f) => function (a, b) { return f(a, b); };
    this.prim('+', 2, numOp((a, b) => a + b));
    this.prim('-', 2, numOp((a, b) => a - b));
    this.prim('*', 2, numOp((a, b) => a * b));
    this.prim('/', 2, function (a, b) {
      if (b === 0 || b === 0n) throw new ForthError(-10, 'division by zero');
      return typeof a === 'bigint' ? a / b : Math.trunc(a / b);
    });
    this.prim('mod', 2, (a, b) => a % b);
    this.prim('negate', 1, (a) => -a);
    this.prim('abs', 1, (a) => (a < 0 ? -a : a));
    this.prim('max', 2, (a, b) => (a > b ? a : b));
    this.prim('min', 2, (a, b) => (a < b ? a : b));
    this.prim('=', 2, (a, b) => (a === b ? -1 : 0));
    this.prim('<>', 2, (a, b) => (a !== b ? -1 : 0));
    this.prim('<', 2, (a, b) => (a < b ? -1 : 0));
    this.prim('>', 2, (a, b) => (a > b ? -1 : 0));
    this.prim('0=', 1, (a) => (a === 0 ? -1 : 0));
    this.prim('and', 2, (a, b) => a & b);
    this.prim('or', 2, (a, b) => a | b);
    this.prim('xor', 2, (a, b) => a ^ b);
    this.prim('invert', 1, (a) => ~a);
    this.prim('dup', 1, (a) => [a, a]);
    this.prim('drop', 1, () => undefined);
    this.prim('swap', 2, (a, b) => [b, a]);
    this.prim('over', 2, (a, b) => [a, b, a]);
    this.prim('rot', 3, (a, b, c) => [b, c, a]);
    this.prim('-rot', 3, (a, b, c) => [c, a, b]);
    this.prim('nip', 2, (a, b) => b);
    this.prim('tuck', 2, (a, b) => [b, a, b]);
    this.prim('2dup', 2, (a, b) => [a, b, a, b]);
    this.prim('2drop', 2, () => undefined);
    this.prim('1+', 1, (a) => a + (typeof a === 'bigint' ? 1n : 1));
    this.prim('1-', 1, (a) => a - (typeof a === 'bigint' ? 1n : 1));
    this.prim('2*', 1, (a) => a * (typeof a === 'bigint' ? 2n : 2));
    this.prim('>big', 1, (a) => BigInt(a));
    this.prim('.', 1, function (a) { this.emit(String(a) + ' '); });
    this.prim('emit', 1, function (a) { this.emit(String.fromCharCode(a)); });
    this.prim('cr', 0, function () { this.emit('\n'); });
    this.prim('space', 0, function () { this.emit(' '); });
    this.prim('!', 2, function (v, addr) { this.memory[addr] = v; });
    this.prim('@', 1, function (addr) { return this.memory[addr] ?? 0; });
    this.prim('+!', 2, function (v, addr) { this.memory[addr] = (this.memory[addr] ?? 0) + v; });
    this.prim('>r', 1, function (a) { this.rs.push(a); });
    this.prim('r>', 0, function () { return this.rs.pop('r>'); });
    this.prim('r@', 0, function () { return this.rs.peek(); });
    this.prim('depth', 0, function () { return this.ds.depth; });
    this.prim('throw', 1, function (code) { if (code !== 0) throw new UserThrow(code); });
    this.prim('pick', 1, function (n) { return this.ds.peek(n); });
    this.prim('type', 1, function (s) { this.emit(String(s)); });
    this.prim('strlen', 1, (s) => s.length);
    this.prim('concat', 2, (a, b) => a + b);
  }
}

// ---------- compiler: tokens -> tree -> closures ----------
class Compiler extends BaseVM {
  constructor() {
    super();
    this.here = 100;
  }

  parseBlock(tokens, terminators) {
    const body = [];
    for (;;) {
      const r = tokens.next();
      if (r.done) {
        if (terminators.length) throw new ForthError(-22, 'unterminated ' + terminators.join('/'));
        return { body, end: null };
      }
      const tok = r.value;
      if (tok.t === 'word' && terminators.includes(tok.v)) return { body, end: tok.v };
      if (tok.t !== 'word') { body.push({ op: 'lit', ...tok }); continue; }
      switch (tok.v) {
        case 'if': {
          const a = this.parseBlock(tokens, ['else', 'then']);
          let b = { body: [] };
          if (a.end === 'else') b = this.parseBlock(tokens, ['then']);
          body.push({ op: 'if', then: a.body, else: b.body });
          break;
        }
        case 'do':
        case '?do': {
          const blk = this.parseBlock(tokens, ['loop', '+loop']);
          body.push({ op: 'do', q: tok.v === '?do', step: blk.end === '+loop', body: blk.body });
          break;
        }
        case 'begin': {
          const blk = this.parseBlock(tokens, ['until', 'while', 'again']);
          if (blk.end === 'while') {
            const rest = this.parseBlock(tokens, ['repeat']);
            body.push({ op: 'while', cond: blk.body, body: rest.body });
          } else {
            body.push({ op: blk.end, body: blk.body });
          }
          break;
        }
        case 'case': {
          const arms = [];
          let dflt = [];
          caseLoop: for (;;) {
            const head = this.parseBlock(tokens, ['of', 'endcase']);
            if (head.end === 'endcase') { dflt = head.body; break caseLoop; }
            const arm = this.parseBlock(tokens, ['endof']);
            arms.push({ match: head.body, body: arm.body });
          }
          body.push({ op: 'case', arms, dflt });
          break;
        }
        case "[']": {
          const n = tokens.next().value;
          body.push({ op: 'xt', name: n.v });
          break;
        }
        default:
          body.push({ op: 'call', name: tok.v });
      }
    }
  }

  compile(tree) {
    const vm = this;
    const ops = tree.map((node) => this.compileNode(node));
    const n = ops.length;
    return function run() {
      for (let i = 0; i < n; i++) {
        vm.steps++;
        ops[i]();
      }
    };
  }

  compileNode(node) {
    const vm = this;
    switch (node.op) {
      case 'lit':
        if (node.t === 'print') return () => vm.emit(node.v);
        return () => vm.ds.push(node.v);
      case 'xt':
        return () => vm.ds.push({ xt: node.name });
      case 'call': {
        let cached = null;
        return () => {
          if (node.name === 'exit') throw new ExitSignal();
          if (node.name === 'leave') throw new LeaveSignal();
          if (node.name === 'i') return vm.ds.push(vm.rs.peek());
          if (node.name === 'j') return vm.ds.push(vm.rs.peek(2));
          const e = cached ?? (cached = vm.dict.lookup(node.name));
          if (!e) throw new UndefinedWord(node.name);
          e.run();
        };
      }
      case 'if': {
        const t = this.compile(node.then), f = this.compile(node.else);
        return () => (vm.ds.pop('if') !== 0 ? t() : f());
      }
      case 'do': {
        const body = this.compile(node.body);
        return () => {
          const [limit, start] = vm.ds.popN(2, 'do');
          if (node.q && limit === start) return;
          vm.rs.push(limit, start);
          try {
            loop: for (;;) {
              try {
                body();
              } catch (e) {
                if (e instanceof LeaveSignal) break loop;
                throw e;
              }
              const inc = node.step ? vm.ds.pop('+loop') : 1;
              const idx = vm.rs.pop() + inc;
              vm.rs.push(idx);
              if (inc > 0 ? idx >= limit : idx < limit) break;
            }
          } finally {
            vm.rs.pop(); vm.rs.pop();
          }
        };
      }
      case 'until': {
        const body = this.compile(node.body);
        return () => {
          do { body(); } while (vm.ds.pop('until') === 0);
        };
      }
      case 'again': {
        const body = this.compile(node.body);
        return () => {
          let guard = 0;
          for (;;) {
            body();
            if (++guard > 100000) throw new ForthError(-1, 'runaway again');
          }
        };
      }
      case 'while': {
        const cond = this.compile(node.cond), body = this.compile(node.body);
        return () => {
          for (;;) {
            cond();
            if (vm.ds.pop('while') === 0) break;
            body();
          }
        };
      }
      case 'case': {
        const arms = node.arms.map((a) => ({ m: this.compile(a.match), b: this.compile(a.body) }));
        const dflt = this.compile(node.dflt);
        return () => {
          const sel = vm.ds.pop('case');
          for (const { m, b } of arms) {
            m();
            if (vm.ds.pop('of') === sel) return b();
          }
          vm.ds.push(sel);
          dflt();
          vm.ds.pop('endcase');
        };
      }
      default:
        throw new ForthError(-99, 'bad node ' + node.op);
    }
  }
}

// ---------- full interpreter: defining words, catch, execute ----------
class Forth extends Compiler {
  static #instances = 0;
  static get instances() { return Forth.#instances; }
  #trace = null;
  constructor(opts = {}) {
    super();
    Forth.#instances++;
    const { trace = false, extras: { big = true } = {} } = opts;
    if (trace) this.#trace = [];
    if (big) this.prim('big*', 2, (a, b) => BigInt(a) * BigInt(b));
    this.installMeta();
  }
  get traceLog() { return this.#trace?.slice() ?? null; }
  #record(word) { this.#trace?.push(word + ':' + this.ds.depth); }

  installMeta() {
    const vm = this;
    this.dict.define('execute', {
      kind: 'prim',
      run() {
        const x = vm.ds.pop('execute');
        const e = vm.dict.lookup(x?.xt);
        if (!e) throw new UndefinedWord(String(x?.xt));
        e.run();
      },
    });
    this.dict.define('catch', {
      kind: 'prim',
      run() {
        const x = vm.ds.pop('catch');
        const saved = vm.ds.depth;
        const savedR = vm.rs.depth;
        try {
          vm.dict.lookup(x.xt).run();
          vm.ds.push(0);
        } catch (e) {
          if (!(e instanceof ForthError)) throw e;
          while (vm.ds.depth > saved) vm.ds.pop();
          while (vm.rs.depth > savedR) vm.rs.pop();
          vm.ds.push(e.code);
        }
      },
    });
    this.dict.define('.s', {
      kind: 'prim',
      run() { vm.emit('<' + vm.ds.depth + '> ' + vm.ds.snapshot().join(' ') + ' '); },
    });
  }

  defineColon(name, tree) {
    const vm = this;
    const body = this.compile(tree);
    const entry = this.dict.define(name, {
      kind: 'colon',
      calls: 0,
      run() {
        entry.calls++;
        vm.#record(name);
        try {
          body();
        } catch (e) {
          if (e instanceof ExitSignal) return;
          throw e;
        }
      },
    });
    return entry;
  }

  interpret(src) {
    const tokens = tokenize(src);
    let tok;
    while (!(tok = tokens.next()).done) {
      const { t, v } = tok.value;
      if (t !== 'word') {
        this.compile([{ op: 'lit', t, v }])();
        continue;
      }
      switch (v) {
        case ':': {
          const name = tokens.next().value.v;
          const { body } = this.parseBlock(tokens, [';']);
          this.defineColon(name, body);
          break;
        }
        case 'variable': {
          const name = tokens.next().value.v;
          const addr = this.here++;
          this.dict.define(name, { kind: 'var', run: () => this.ds.push(addr) });
          break;
        }
        case 'constant': {
          const name = tokens.next().value.v;
          const val = this.ds.pop('constant');
          this.dict.define(name, { kind: 'const', run: () => this.ds.push(val) });
          break;
        }
        case 'if': case 'do': case '?do': case 'begin': case 'case': case "[']": {
          // interpret-mode control: re-inject token by parsing a block to end of line
          const { body } = this.parseBlock(
            (function* (first, rest) { yield first; yield* rest; })(tok.value, tokens), []);
          this.compile(body)();
          return;
        }
        default: {
          const e = this.dict.lookup(v);
          if (!e) throw new UndefinedWord(v);
          e.run();
        }
      }
    }
  }

  run(src) {
    let status = 'ok';
    try {
      this.interpret(src);
    } catch (e) {
      if (e instanceof ForthError) {
        status = `err(${e.code}): ${e.message}`;
        this.ds.clear();
        this.rs.clear();
      } else {
        throw e;
      }
    }
    return { out: this.flush(), status, stack: this.ds.snapshot() };
  }
}

// ---------- test harness ----------
function show(label, res) {
  say(`${label} -> out=${JSON.stringify(res.out)} status=${res.status} stack=${JSON.stringify(res.stack)}`);
}

function testArithmetic() {
  say('== arithmetic ==');
  const f = new Forth();
  show('add', f.run('2 3 + .'));
  show('mixed', f.run('10 3 mod 7 2 / * .'));
  show('stack ops', f.run('1 2 3 rot .s'));
  f.run('drop drop drop');
  show('compare', f.run('3 4 < . 4 3 < . 5 5 = .'));
  show('bitwise', f.run('12 10 and . 12 10 or . 12 10 xor . 0 invert .'));
  show('div0', f.run('1 0 /'));
  show('underflow', f.run('1 + '));
  show('undefined', f.run('frobnicate'));
  show('bigint', f.run('123456789012345n 1000000n * .'));
}

function testWords() {
  say('== user words ==');
  const f = new Forth({ trace: true });
  f.run(': square dup * ;');
  f.run(': cube dup square * ;');
  show('square', f.run('7 square .'));
  show('cube', f.run('3 cube .'));
  f.run(': fact dup 1 > if dup 1- fact * else drop 1 then ;');
  show('fact', f.run('10 fact .'));
  f.run(': fib dup 2 < if exit then dup 1- fib swap 2 - fib + ;');
  show('fib', f.run('15 fib .'));
  say('trace len', f.traceLog.length, 'head', f.traceLog.slice(0, 6));
  f.run(': gcd begin dup while tuck mod repeat drop ;');
  show('gcd', f.run('1071 462 gcd .'));
  f.run(': bigfact dup 1 > if dup 1- bigfact big* else drop 1n then ;');
  show('bigfact', f.run('25 bigfact .'));
}

function testLoops() {
  say('== loops ==');
  const f = new Forth();
  show('do-loop', f.run(': t1 10 0 do i . loop ; t1'));
  show('+loop', f.run(': t2 20 0 do i . 5 +loop ; t2'));
  show('nested', f.run(': t3 3 0 do 3 0 do i j * . loop loop ; t3'));
  show('leave', f.run(': t4 100 0 do i dup . 4 = if leave then loop ; t4'));
  show('?do', f.run(': t5 0 0 ?do i . loop 99 . ; t5'));
  show('until', f.run(': t6 1 begin dup . 2* dup 100 > until drop ; t6'));
  show('while', f.run(': t7 5 begin dup 0 > while dup . 1- repeat drop ; t7'));
  show('sum', f.run(': sumto 0 swap 1+ 1 do i + loop ; 100 sumto .'));
  show('interp-do', f.run('5 0 do i 2* . loop'));
}

function testControl() {
  say('== case / catch / throw ==');
  const f = new Forth();
  f.run(': classify case 1 of ." one" endof 2 of ." two" endof 3 of ." three" endof ." other" endcase ;');
  show('case', f.run('1 classify space 2 classify space 3 classify space 9 classify'));
  f.run(': risky dup 0< if -42 throw then 10 swap - ;');
  f.run(': 0< 0 < ;');
  f.run(': risky dup 0< if -42 throw then 10 swap - ;');
  f.run(": try-risky ['] risky catch ;");
  show('catch ok', f.run('3 try-risky'));
  f.run('drop drop');
  show('catch err', f.run('-3 try-risky'));
  f.run('drop');
  f.run(': deep 0 do i 3 = if 99 throw then loop ;');
  f.run(": safe-deep ['] deep catch ;");
  show('catch in loop', f.run('10 safe-deep'));
  f.run('drop');
  show('uncaught', f.run('7 throw'));
  f.run(": dbl 2* ; ' dbl");
  show('execute', f.run(": ex ['] dbl execute ; 21 ex ."));
  show('strings', f.run('s" hello" s"  world" concat dup type space strlen .'));
}

function testVariables() {
  say('== variables ==');
  const f = new Forth();
  f.run('variable counter 0 counter !');
  f.run(': bump counter @ 1+ counter ! ;');
  show('bump', f.run('bump bump bump counter @ .'));
  f.run('42 constant answer');
  show('const', f.run('answer 2 * .'));
  f.run('variable acc');
  f.run(': accumulate 0 do i acc +! loop ;');
  show('acc', f.run('50 accumulate acc @ .'));
  f.run(': collatz 0 swap begin dup 1 <> while dup 2 mod if 3 * 1+ else 2 / then swap 1+ swap repeat drop ;');
  const res = [];
  for (let n = 1; n <= 12; n++) res.push(f.run(`${n} collatz .`).out.trim());
  say('collatz', res.join(','));
}

// ---------- deep recursion and mutual recursion in Forth ----------
function testRecursion() {
  say('== recursion ==');
  const f = new Forth();
  f.run(': countdown dup 0 > if 1- countdown then ;');
  show('countdown 800', f.run('800 countdown .'));
  f.run(': ev dup 0= if drop -1 else 1- od then ;');
  f.run(': od dup 0= if drop 0 else 1- ev then ;');
  show('even 101', f.run('101 ev .'));
  // re-define ev now that od exists (late binding in cache resolves lazily)
  show('ev again', f.run('200 ev .'));
  f.run(': ack over 0= if nip 1+ exit then dup 0= if drop 1- 1 ack exit then over swap 1- ack swap 1- swap ack ;');
  show('ack 2 3', f.run('2 3 ack .'));
  say('max depth', f.ds.max, 'steps>0', f.steps > 0);
}

// ---------- JS-side meta tests on the interpreter ----------
function testMeta() {
  say('== meta ==');
  const f = new Forth({ extras: { big: false } });
  say('big* defined?', f.dict.lookup('big*') !== undefined);
  const names = [...f.dict.allNames()];
  say('word count', names.length, 'first', names.slice(0, 5));
  say('isStack', Stack.isStack(f.ds), Stack.isStack({}));
  say('instances', Forth.instances);
  const kinds = {};
  for (const n of names) {
    const k = f.dict.lookup(n).kind;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  say('kinds', kinds);
  // child vocabulary shadowing
  const child = new Dictionary(f.dict);
  child.define('dup', { kind: 'shadow', run() {} });
  say('shadow', child.lookup('dup').kind, f.dict.lookup('dup').kind);
  // tokens
  const toks = [...tokenize(': x ( comment ) 1 2n ." hi there" \\ trailing\n foo ;')];
  say('tokens', toks.map((t) => t.t + '=' + String(t.v)));
  // proxy logging dictionary lookups
  const seen = [];
  const px = new Proxy(f.dict.words, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, target);
      if (prop === 'get') return (k) => { seen.push(k); return v.call(target, k); };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  f.dict.words = px;
  f.run(': tw 1 2 + dup * ;');
  f.run('tw .');
  f.flush();
  say('proxy seen', seen.length, [...new Set(seen)].sort());
}

// ---------- async driver: run programs through async generator ----------
async function* programFeed(programs) {
  for (const [i, p] of programs.entries()) {
    await null;
    yield { i, p };
  }
  return 'feed-done';
}

async function runFeed() {
  say('== async feed ==');
  const f = new Forth();
  const programs = [
    ': sq dup * ;',
    '5 sq .',
    '1 2 3 + + .',
    'nope',
    ': tri dup 1+ * 2 / ; 10 tri .',
    '3 0 do i sq . loop',
  ];
  const results = [];
  for await (const { i, p } of programFeed(programs)) {
    const r = f.run(p);
    results.push(`${i}:${r.status === 'ok' ? r.out.trim() : 'E'}`);
  }
  say('feed', results.join(' | '));
  const par = await Promise.all(
    [3, 5, 7].map(async (n, idx) => {
      const g = new Forth();
      await Promise.resolve();
      g.run(': fact dup 1 > if dup 1- fact * else drop 1 then ;');
      return idx + ':' + g.run(`${n} fact .`).out.trim();
    })
  );
  say('parallel', par);
  const settled = await Promise.allSettled([
    Promise.resolve(new Forth().run('1 1 + .')),
    Promise.reject(new ForthError(-1, 'rejected')),
  ]);
  say('settled', settled.map((s) => s.status + ':' + (s.value?.out ?? s.reason?.message)));
  const first = await Promise.race([
    (async () => { await null; await null; return 'slow'; })(),
    (async () => { await null; return 'fast'; })(),
  ]);
  say('race', first);
  const any = await Promise.any([Promise.reject(new Error('x')), Promise.resolve('any-ok')]);
  say('any', any);
}

// ---------- microtask ordering demo ----------
async function orderDemo() {
  say('== ordering ==');
  const log = [];
  const p1 = (async () => { log.push('a1'); await null; log.push('a2'); await null; log.push('a3'); })();
  const p2 = Promise.resolve().then(() => log.push('b1')).then(() => log.push('b2'));
  log.push('sync');
  await Promise.all([p1, p2]);
  say('order', log.join(','));
}

// ---------- sloppy helper via Function-free trick: arguments in non-strict nested fn ----------
const sloppy = (0, function () { return this; });
function argsLen() { return arguments.length; }

function main() {
  testArithmetic();
  testWords();
  testLoops();
  testControl();
  testVariables();
  testRecursion();
  testMeta();
  say('argsLen', argsLen(1, 2, 3), 'strict this', String(sloppy()));
  return runFeed().then(orderDemo).then(() => {
    say(`total lines ${lines.length + 1}`);
  });
}

main().catch((e) => { console.log('FATAL ' + e.message); });
