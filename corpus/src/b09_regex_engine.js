// Mini regex engine (Thompson NFA) + glob matcher, cross-checked against native RegExp
'use strict';

class ParseError extends Error {
  constructor(msg, pos) {
    super(`${msg} at ${pos}`);
    this.pos = pos;
  }
}

// AST node kinds
const K = Object.freeze({ CHAR: 'char', ANY: 'any', CLASS: 'class', CAT: 'cat', ALT: 'alt', STAR: 'star', PLUS: 'plus', OPT: 'opt', EMPTY: 'empty' });

class RegexParser {
  #src;
  #pos = 0;
  constructor(src) { this.#src = src; }
  get #peek() { return this.#src[this.#pos]; }
  #eat(ch) {
    if (this.#src[this.#pos] !== ch) throw new ParseError(`expected '${ch}'`, this.#pos);
    this.#pos++;
  }
  parse() {
    const node = this.#alt();
    if (this.#pos < this.#src.length) throw new ParseError(`unexpected '${this.#peek}'`, this.#pos);
    return node;
  }
  #alt() {
    let left = this.#cat();
    while (this.#peek === '|') {
      this.#pos++;
      const right = this.#cat();
      left = { k: K.ALT, a: left, b: right };
    }
    return left;
  }
  #cat() {
    const parts = [];
    while (this.#pos < this.#src.length && this.#peek !== '|' && this.#peek !== ')') parts.push(this.#repeat());
    if (parts.length === 0) return { k: K.EMPTY };
    return parts.reduce((a, b) => ({ k: K.CAT, a, b }));
  }
  #repeat() {
    let atom = this.#atom();
    for (;;) {
      const c = this.#peek;
      if (c === '*') atom = { k: K.STAR, a: atom };
      else if (c === '+') atom = { k: K.PLUS, a: atom };
      else if (c === '?') atom = { k: K.OPT, a: atom };
      else break;
      this.#pos++;
    }
    return atom;
  }
  #atom() {
    const c = this.#peek;
    switch (c) {
      case '(': {
        this.#pos++;
        const inner = this.#alt();
        this.#eat(')');
        return inner;
      }
      case '.':
        this.#pos++;
        return { k: K.ANY };
      case '[':
        return this.#charClass();
      case '\\': {
        this.#pos++;
        const e = this.#src[this.#pos++];
        if (e === undefined) throw new ParseError('dangling escape', this.#pos);
        if (e === 'd') return { k: K.CLASS, neg: false, ranges: [['0', '9']] };
        if (e === 'w') return { k: K.CLASS, neg: false, ranges: [['a', 'z'], ['A', 'Z'], ['0', '9'], ['_', '_']] };
        if (e === 's') return { k: K.CLASS, neg: false, ranges: [[' ', ' '], ['\t', '\t'], ['\n', '\n']] };
        return { k: K.CHAR, c: e };
      }
      case undefined:
        throw new ParseError('unexpected end', this.#pos);
      case '*': case '+': case '?':
        throw new ParseError(`nothing to repeat '${c}'`, this.#pos);
      default:
        this.#pos++;
        return { k: K.CHAR, c };
    }
  }
  #charClass() {
    this.#eat('[');
    let neg = false;
    if (this.#peek === '^') { neg = true; this.#pos++; }
    const ranges = [];
    while (this.#peek !== ']') {
      if (this.#peek === undefined) throw new ParseError('unterminated class', this.#pos);
      const lo = this.#src[this.#pos++];
      if (this.#peek === '-' && this.#src[this.#pos + 1] !== ']') {
        this.#pos++;
        const hi = this.#src[this.#pos++];
        ranges.push([lo, hi]);
      } else ranges.push([lo, lo]);
    }
    this.#eat(']');
    return { k: K.CLASS, neg, ranges };
  }
}

function astToString(n) {
  switch (n.k) {
    case K.CHAR: return JSON.stringify(n.c);
    case K.ANY: return 'ANY';
    case K.EMPTY: return 'EMPTY';
    case K.CLASS: return `[${n.neg ? '^' : ''}${n.ranges.map(([a, b]) => (a === b ? a : a + '-' + b)).join('')}]`;
    case K.CAT: return `(${astToString(n.a)} ${astToString(n.b)})`;
    case K.ALT: return `(${astToString(n.a)} | ${astToString(n.b)})`;
    default: return `${n.k}(${astToString(n.a)})`;
  }
}

// NFA construction
let stateId = 0;
class State {
  constructor(test = null) {
    this.id = stateId++;
    this.test = test; // function(ch) or null for epsilon/accept
    this.out = [];
    this.eps = [];
    this.accept = false;
  }
}

function compile(node) {
  switch (node.k) {
    case K.EMPTY: {
      const s = new State();
      return { start: s, end: s };
    }
    case K.CHAR:
    case K.ANY:
    case K.CLASS: {
      const s = new State(makeTest(node)), e = new State();
      s.out.push(e);
      return { start: s, end: e };
    }
    case K.CAT: {
      const a = compile(node.a), b = compile(node.b);
      a.end.eps.push(b.start);
      return { start: a.start, end: b.end };
    }
    case K.ALT: {
      const s = new State(), e = new State();
      const a = compile(node.a), b = compile(node.b);
      s.eps.push(a.start, b.start);
      a.end.eps.push(e);
      b.end.eps.push(e);
      return { start: s, end: e };
    }
    case K.STAR: case K.PLUS: case K.OPT: {
      const s = new State(), e = new State();
      const a = compile(node.a);
      s.eps.push(a.start);
      if (node.k !== K.PLUS) s.eps.push(e);
      a.end.eps.push(e);
      if (node.k !== K.OPT) a.end.eps.push(a.start);
      return { start: s, end: e };
    }
    default:
      throw new Error('unknown node ' + node.k);
  }
}

function makeTest(node) {
  if (node.k === K.CHAR) return (ch) => ch === node.c;
  if (node.k === K.ANY) return (ch) => ch !== '\n';
  const { neg, ranges } = node;
  return (ch) => ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== neg;
}

function closure(states) {
  const stack = [...states];
  const seen = new Set(states);
  while (stack.length) {
    const s = stack.pop();
    for (const t of s.eps) {
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return seen;
}

class MiniRegex {
  static cache = new Map();
  static hits = 0;
  #nfa;
  constructor(pattern) {
    this.pattern = pattern;
    this.ast = new RegexParser(pattern).parse();
    this.#nfa = compile(this.ast);
    this.#nfa.end.accept = true;
    this.steps = 0;
  }
  static of(pattern) {
    if (MiniRegex.cache.has(pattern)) { MiniRegex.hits++; return MiniRegex.cache.get(pattern); }
    const r = new MiniRegex(pattern);
    MiniRegex.cache.set(pattern, r);
    return r;
  }
  #run(str, from, anchoredEnd) {
    let cur = closure([this.#nfa.start]);
    let lastAccept = [...cur].some((s) => s.accept) ? from : -1;
    for (let i = from; i < str.length; i++) {
      const next = [];
      for (const s of cur) {
        this.steps++;
        if (s.test && s.test(str[i])) next.push(...s.out);
      }
      if (!next.length) break;
      cur = closure(next);
      if ([...cur].some((s) => s.accept)) lastAccept = i + 1;
    }
    if (anchoredEnd) return lastAccept === str.length ? lastAccept : -1;
    return lastAccept;
  }
  fullMatch(str) { return this.#run(str, 0, true) === str.length; }
  search(str) {
    for (let i = 0; i <= str.length; i++) {
      const end = this.#run(str, i, false);
      if (end >= 0) return { index: i, match: str.slice(i, end) };
    }
    return null;
  }
  *findAll(str) {
    let i = 0;
    while (i <= str.length) {
      const end = this.#run(str, i, false);
      if (end > i) { yield { index: i, match: str.slice(i, end) }; i = end; }
      else i++;
    }
  }
}

// Glob matcher: * ? [abc] and ** for path segments, via backtracking with memo
function globMatch(pattern, path) {
  const memo = new Map();
  function m(pi, si) {
    const key = pi * 1000 + si;
    if (memo.has(key)) return memo.get(key);
    let res;
    if (pi === pattern.length) res = si === path.length;
    else {
      const c = pattern[pi];
      if (c === '*' && pattern[pi + 1] === '*') {
        res = false;
        for (let k = si; k <= path.length && !res; k++) res = m(pi + 2, k);
      } else if (c === '*') {
        res = false;
        for (let k = si; k <= path.length; k++) {
          if (m(pi + 1, k)) { res = true; break; }
          if (path[k] === '/') break;
        }
      } else if (c === '?') res = si < path.length && path[si] !== '/' && m(pi + 1, si + 1);
      else if (c === '[') {
        const close = pattern.indexOf(']', pi);
        const set = pattern.slice(pi + 1, close);
        res = si < path.length && set.includes(path[si]) && m(close + 1, si + 1);
      } else res = si < path.length && path[si] === c && m(pi + 1, si + 1);
    }
    memo.set(key, res);
    return res;
  }
  return m(0, 0);
}

function glob(strings, ...vals) {
  return strings.raw.reduce((a, s, i) => a + String(vals[i - 1]) + s);
}

function crossCheck(pattern, inputs) {
  const mine = MiniRegex.of(pattern);
  const native = new RegExp(`^(?:${pattern})$`);
  let agree = 0;
  const row = [];
  for (const s of inputs) {
    const a = mine.fullMatch(s), b = native.test(s);
    if (a === b) agree++;
    row.push(`${JSON.stringify(s)}:${a ? 'Y' : 'n'}${a === b ? '' : '!'}`);
  }
  console.log(`/${pattern}/ ${row.join(' ')} agree=${agree}/${inputs.length}`);
  return agree === inputs.length;
}

function main() {
  const patterns = ['a(b|c)*d', 'x+y?z', '[a-c]+\\d', '(ab)+|c', '.*foo.*', '[^0-9]+', 'h(e|a)llo?', '\\w+@\\w+\\.com'];
  for (const p of patterns) console.log(`ast ${p} => ${astToString(new RegexParser(p).parse())}`);

  const inputs = ['', 'ad', 'abcbd', 'xz', 'xxyz', 'b3', 'abc9', 'abab', 'c', 'barfoo', 'hello', 'hal', 'hall', 'a@b.com', 'x@y.org', '12a'];
  let allOk = true;
  for (const p of patterns) allOk = crossCheck(p, inputs) && allOk;
  console.log(`all agree: ${allOk}`);

  for (const bad of ['(ab', 'a**', '[abc', '*x', 'a\\']) {
    try {
      new RegexParser(bad).parse();
      console.log(`parsed ${bad}?!`);
    } catch (e) {
      console.log(`error for ${JSON.stringify(bad)}: ${e.message} (pos ${e.pos ?? '?'})`);
    }
  }

  const text = 'call 555-1234 or 555-9876; ext 42, room 7b';
  const digits = MiniRegex.of('\\d+(-\\d+)?');
  const found = [...digits.findAll(text)];
  console.log(`findAll: ${found.map(({ index, match }) => `${match}@${index}`).join(', ')}`);
  console.log(`native : ${(text.match(/\d+(-\d+)?/g) ?? []).join(', ')}`);
  const s1 = MiniRegex.of('r[a-z]+m').search(text);
  console.log(`search room: ${s1?.match} at ${s1?.index}`);
  console.log(`search none: ${MiniRegex.of('zzz').search(text) ?? 'null'}`);
  MiniRegex.of('a(b|c)*d');
  console.log(`cache size=${MiniRegex.cache.size} hits=${MiniRegex.hits} states=${stateId}`);

  const files = ['src/main.js', 'src/lib/util.js', 'src/lib/deep/x.ts', 'test/a.test.js', 'README.md', 'docs/b.md', 'src/c1.js', 'src/c22.js'];
  const globs = ['src/*.js', 'src/**/*.js', '**/*.md', 'src/c?.js', '*.md', 'src/[mc]*.js', glob`test/*.${'test'}.js`];
  for (const g of globs) {
    const hits = files.filter((f) => globMatch(g, f));
    console.log(`glob ${g.padEnd(14)} -> ${hits.join(' ') || '-'}`);
  }

  const words = 'the quick brown fox jumps over the lazy dog'.split(' ');
  const counts = new Map();
  for (const w of words) {
    let matched = 'none';
    for (const [name, re] of [['vowel-start', '[aeiou].*'], ['has-o', '.*o.*'], ['short', '...?']]) {
      if (MiniRegex.of(re).fullMatch(w)) { matched = name; break; }
    }
    counts.set(matched, (counts.get(matched) ?? 0) + 1);
  }
  console.log(`classify: ${JSON.stringify(Object.fromEntries(counts))}`);
  let total = 0;
  for (const r of MiniRegex.cache.values()) total += r.steps;
  console.log(`total nfa steps: ${total}`);
}

main();
