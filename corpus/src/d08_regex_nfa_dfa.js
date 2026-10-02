// d08: regex engine — parser, Thompson NFA, subset construction, Hopcroft
// minimisation, cross-checked against native RegExp.
'use strict';

const out = (...xs) => console.log(xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

// ---------------------------------------------------------------- char sets
class CharSet {
  #ranges; // sorted, disjoint [lo, hi]
  constructor(ranges = []) {
    this.#ranges = CharSet.normalize(ranges);
  }
  static normalize(ranges) {
    const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const res = [];
    for (const [lo, hi] of sorted) {
      const last = res[res.length - 1];
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else res.push([lo, hi]);
    }
    return res;
  }
  static of(str) {
    return new CharSet([...str].map((c) => [c.codePointAt(0), c.codePointAt(0)]));
  }
  static get digit() { return new CharSet([[48, 57]]); }
  static get word() { return new CharSet([[48, 57], [65, 90], [95, 95], [97, 122]]); }
  static get space() { return new CharSet([[9, 13], [32, 32]]); }
  static get any() { return new CharSet([[0, 9], [11, 12], [14, 0x2027], [0x202a, 0x10ffff]]); }
  get ranges() { return this.#ranges.map((r) => r.slice()); }
  has(cp) {
    let lo = 0, hi = this.#ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = this.#ranges[mid];
      if (cp < a) hi = mid - 1;
      else if (cp > b) lo = mid + 1;
      else return true;
    }
    return false;
  }
  union(other) {
    return new CharSet([...this.#ranges, ...other.ranges]);
  }
  negate() {
    const res = [];
    let next = 0;
    for (const [a, b] of this.#ranges) {
      if (a > next) res.push([next, a - 1]);
      next = b + 1;
    }
    if (next <= 0x10ffff) res.push([next, 0x10ffff]);
    return new CharSet(res);
  }
  static isCharSet(x) { return x != null && #ranges in x; }
  toString() {
    const show = (cp) => (cp >= 33 && cp < 127 ? String.fromCharCode(cp) : `\\u{${cp.toString(16)}}`);
    return '[' + this.#ranges.map(([a, b]) => (a === b ? show(a) : `${show(a)}-${show(b)}`)).join('') + ']';
  }
}

// ---------------------------------------------------------------- AST
class Node {
  constructor(kind) {
    if (new.target === Node) throw new TypeError('Node is abstract');
    this.kind = kind;
  }
  get nullable() { return false; }
  toString() { return this.kind; }
}
class Empty extends Node {
  constructor() { super('empty'); }
  get nullable() { return true; }
  toString() { return 'ε'; }
}
class Chars extends Node {
  constructor(set, src) {
    super('chars');
    this.set = set;
    this.src = src;
  }
  toString() { return this.src; }
}
class Concat extends Node {
  constructor(parts) {
    super('concat');
    this.parts = parts;
  }
  get nullable() { return this.parts.every((p) => p.nullable); }
  toString() { return this.parts.map(String).join(''); }
}
class Alt extends Node {
  constructor(options) {
    super('alt');
    this.options = options;
  }
  get nullable() { return this.options.some((o) => o.nullable); }
  toString() { return '(' + this.options.map(String).join('|') + ')'; }
}
class Repeat extends Node {
  constructor(child, min, max) {
    super('repeat');
    Object.assign(this, { child, min, max });
  }
  get nullable() { return this.min === 0 || this.child.nullable; }
  toString() {
    const { min, max } = this;
    const q = min === 0 && max === Infinity ? '*' : min === 1 && max === Infinity ? '+' : min === 0 && max === 1 ? '?' : `{${min},${max === Infinity ? '' : max}}`;
    return `${this.child}${q}`;
  }
}
class Group extends Node {
  constructor(child, name) {
    super('group');
    this.child = child;
    this.name = name ?? null;
  }
  get nullable() { return this.child.nullable; }
  toString() { return `(${this.name ? `?<${this.name}>` : ''}${this.child})`; }
}

// ---------------------------------------------------------------- parser
class RegexSyntaxError extends SyntaxError {
  constructor(msg, pos) {
    super(`${msg} at ${pos}`);
    this.pos = pos;
  }
}

class Parser {
  #src;
  #pos = 0;
  #groups = 0;
  #names = new Set();
  constructor(src) {
    this.#src = [...src];
  }
  get groupCount() { return this.#groups; }
  get names() { return [...this.#names]; }
  #peek(k = 0) { return this.#src[this.#pos + k]; }
  #eat(ch) {
    if (this.#src[this.#pos] !== ch) throw new RegexSyntaxError(`expected '${ch}' got '${this.#peek() ?? 'EOF'}'`, this.#pos);
    this.#pos++;
  }
  parse() {
    const node = this.#alt();
    if (this.#pos < this.#src.length) throw new RegexSyntaxError(`unexpected '${this.#peek()}'`, this.#pos);
    return node;
  }
  #alt() {
    const options = [this.#concat()];
    while (this.#peek() === '|') {
      this.#pos++;
      options.push(this.#concat());
    }
    return options.length === 1 ? options[0] : new Alt(options);
  }
  #concat() {
    const parts = [];
    loop: while (this.#pos < this.#src.length) {
      switch (this.#peek()) {
        case '|':
        case ')':
          break loop;
        default:
          parts.push(this.#repeat());
      }
    }
    return parts.length === 0 ? new Empty() : parts.length === 1 ? parts[0] : new Concat(parts);
  }
  #repeat() {
    let atom = this.#atom();
    for (;;) {
      const c = this.#peek();
      if (c === '*') atom = new Repeat(atom, 0, Infinity);
      else if (c === '+') atom = new Repeat(atom, 1, Infinity);
      else if (c === '?') atom = new Repeat(atom, 0, 1);
      else if (c === '{') {
        const m = /^\{(?<min>\d+)(?<comma>,(?<max>\d*))?\}/.exec(this.#src.slice(this.#pos).join(''));
        if (!m) throw new RegexSyntaxError('bad quantifier', this.#pos);
        const { min, comma, max } = m.groups;
        const lo = +min;
        const hi = comma === undefined ? lo : max === '' ? Infinity : +max;
        if (hi < lo) throw new RegexSyntaxError('numbers out of order', this.#pos);
        atom = new Repeat(atom, lo, hi);
        this.#pos += m[0].length - 1;
      } else return atom;
      this.#pos++;
    }
  }
  #atom() {
    const c = this.#peek();
    switch (c) {
      case '(': {
        this.#pos++;
        let name;
        if (this.#peek() === '?') {
          if (this.#peek(1) === ':') this.#pos += 2;
          else if (this.#peek(1) === '<') {
            this.#pos += 2;
            name = '';
            while (this.#peek() !== '>') {
              if (this.#peek() === undefined) throw new RegexSyntaxError('unterminated name', this.#pos);
              name += this.#src[this.#pos++];
            }
            this.#pos++;
            if (this.#names.has(name)) throw new RegexSyntaxError('duplicate group ' + name, this.#pos);
            this.#names.add(name);
            this.#groups++;
          } else throw new RegexSyntaxError('unsupported group', this.#pos);
        } else this.#groups++;
        const inner = this.#alt();
        this.#eat(')');
        return new Group(inner, name);
      }
      case '[':
        return this.#klass();
      case '.':
        this.#pos++;
        return new Chars(CharSet.any, '.');
      case '\\': {
        this.#pos++;
        const [set, src] = this.#escape();
        return new Chars(set, src);
      }
      case '*':
      case '+':
      case '?':
      case '{':
        throw new RegexSyntaxError('nothing to repeat', this.#pos);
      case undefined:
        throw new RegexSyntaxError('unexpected end', this.#pos);
      default:
        this.#pos++;
        return new Chars(CharSet.of(c), c);
    }
  }
  #escape() {
    const e = this.#src[this.#pos++];
    const table = { d: CharSet.digit, w: CharSet.word, s: CharSet.space };
    if (e in table) return [table[e], '\\' + e];
    if (e?.toLowerCase() in table && e !== e.toLowerCase()) return [table[e.toLowerCase()].negate(), '\\' + e];
    if (e === 'n') return [CharSet.of('\n'), '\\n'];
    if (e === 't') return [CharSet.of('\t'), '\\t'];
    if (e === undefined) throw new RegexSyntaxError('trailing backslash', this.#pos);
    return [CharSet.of(e), '\\' + e];
  }
  #klass() {
    const start = this.#pos;
    this.#eat('[');
    let negated = false;
    if (this.#peek() === '^') {
      negated = true;
      this.#pos++;
    }
    let set = new CharSet();
    let first = true;
    while (this.#peek() !== ']' || first) {
      first = false;
      let ch = this.#src[this.#pos++];
      if (ch === undefined) throw new RegexSyntaxError('unterminated class', start);
      let piece;
      if (ch === '\\') {
        [piece] = this.#escape();
        set = set.union(piece);
        continue;
      }
      if (this.#peek() === '-' && this.#peek(1) !== ']' && this.#peek(1) !== undefined) {
        this.#pos++;
        let hi = this.#src[this.#pos++];
        if (hi === '\\') hi = this.#src[this.#pos++];
        const [a, b] = [ch.codePointAt(0), hi.codePointAt(0)];
        if (a > b) throw new RegexSyntaxError('range out of order', this.#pos);
        piece = new CharSet([[a, b]]);
      } else piece = CharSet.of(ch);
      set = set.union(piece);
    }
    this.#eat(']');
    const src = this.#src.slice(start, this.#pos).join('');
    return new Chars(negated ? set.negate() : set, src);
  }
}

// ---------------------------------------------------------------- Thompson NFA
class Nfa {
  constructor() {
    this.states = []; // {eps: [], edges: [[CharSet, to]]}
    this.start = -1;
    this.accept = -1;
  }
  add() {
    this.states.push({ eps: [], edges: [] });
    return this.states.length - 1;
  }
  static build(ast) {
    const nfa = new Nfa();
    const frag = (node) => {
      switch (node.kind) {
        case 'empty': {
          const s = nfa.add(), e = nfa.add();
          nfa.states[s].eps.push(e);
          return [s, e];
        }
        case 'chars': {
          const s = nfa.add(), e = nfa.add();
          nfa.states[s].edges.push([node.set, e]);
          return [s, e];
        }
        case 'group':
          return frag(node.child);
        case 'concat': {
          let [s, e] = frag(node.parts[0]);
          for (const p of node.parts.slice(1)) {
            const [s2, e2] = frag(p);
            nfa.states[e].eps.push(s2);
            e = e2;
          }
          return [s, e];
        }
        case 'alt': {
          const s = nfa.add(), e = nfa.add();
          for (const o of node.options) {
            const [os, oe] = frag(o);
            nfa.states[s].eps.push(os);
            nfa.states[oe].eps.push(e);
          }
          return [s, e];
        }
        case 'repeat': {
          const { child, min, max } = node;
          const s = nfa.add();
          let cur = s;
          for (let i = 0; i < min; i++) {
            const [cs, ce] = frag(child);
            nfa.states[cur].eps.push(cs);
            cur = ce;
          }
          const e = nfa.add();
          if (max === Infinity) {
            const [cs, ce] = frag(child);
            nfa.states[cur].eps.push(cs, e);
            nfa.states[ce].eps.push(cs, e);
          } else {
            for (let i = min; i < max; i++) {
              const [cs, ce] = frag(child);
              nfa.states[cur].eps.push(cs, e);
              cur = ce;
            }
            nfa.states[cur].eps.push(e);
          }
          return [s, e];
        }
        default:
          throw new Error('bad node ' + node.kind);
      }
    };
    [nfa.start, nfa.accept] = frag(ast);
    return nfa;
  }
  closure(set) {
    const stack = [...set];
    const seen = new Set(set);
    while (stack.length) {
      const s = stack.pop();
      for (const t of this.states[s].eps) if (!seen.has(t)) {
        seen.add(t);
        stack.push(t);
      }
    }
    return seen;
  }
  step(set, cp) {
    const next = new Set();
    for (const s of set) for (const [cs, to] of this.states[s].edges) if (cs.has(cp)) next.add(to);
    return this.closure(next);
  }
  matches(str) {
    let cur = this.closure([this.start]);
    for (const ch of str) {
      cur = this.step(cur, ch.codePointAt(0));
      if (cur.size === 0) return false;
    }
    return cur.has(this.accept);
  }
  *trace(str) {
    let cur = this.closure([this.start]);
    yield cur.size;
    for (const ch of str) {
      cur = this.step(cur, ch.codePointAt(0));
      const cmd = yield cur.size;
      if (cmd === 'abort') return 'aborted';
    }
    return cur.has(this.accept) ? 'accept' : 'reject';
  }
}

// ---------------------------------------------------------------- DFA
class Dfa {
  #alphabet;
  constructor(alphabet) {
    this.#alphabet = alphabet;
    this.trans = []; // array of Map(symbol -> state)
    this.accepting = new Set();
    this.start = 0;
  }
  get alphabet() { return this.#alphabet; }
  get size() { return this.trans.length; }
  static fromNfa(nfa, alphabet) {
    const dfa = new Dfa(alphabet);
    const key = (set) => [...set].sort((a, b) => a - b).join(',');
    const start = nfa.closure([nfa.start]);
    const index = new Map([[key(start), 0]]);
    const work = [start];
    dfa.trans.push(new Map());
    if (start.has(nfa.accept)) dfa.accepting.add(0);
    for (let i = 0; i < work.length; i++) {
      const set = work[i];
      for (const sym of alphabet) {
        const next = nfa.step(set, sym.codePointAt(0));
        if (!next.size) continue;
        const k = key(next);
        let id = index.get(k);
        if (id === undefined) {
          id = work.length;
          index.set(k, id);
          work.push(next);
          dfa.trans.push(new Map());
          if (next.has(nfa.accept)) dfa.accepting.add(id);
        }
        dfa.trans[i].set(sym, id);
      }
    }
    return dfa;
  }
  matches(str) {
    let s = this.start;
    for (const ch of str) {
      s = this.trans[s].get(ch);
      if (s === undefined) return false;
    }
    return this.accepting.has(s);
  }
  complete() {
    // add explicit dead state
    const dead = this.trans.length;
    let used = false;
    for (const row of this.trans) for (const sym of this.#alphabet) if (!row.has(sym)) {
      row.set(sym, dead);
      used = true;
    }
    if (used) this.trans.push(new Map(this.#alphabet.map((s) => [s, dead])));
    return this;
  }
  minimize() {
    this.complete();
    const n = this.trans.length;
    const acc = [...this.accepting];
    const rej = [...Array(n).keys()].filter((s) => !this.accepting.has(s));
    let partition = [acc, rej].filter((p) => p.length);
    const work = partition.map((p) => new Set(p));
    const inverse = this.#alphabet.map((sym) => {
      const inv = Array.from({ length: n }, () => []);
      this.trans.forEach((row, s) => inv[row.get(sym)].push(s));
      return inv;
    });
    let splits = 0;
    while (work.length) {
      const A = work.pop();
      for (const inv of inverse) {
        const X = new Set();
        for (const q of A) for (const p of inv[q]) X.add(p);
        if (!X.size) continue;
        const nextPartition = [];
        for (const Y of partition) {
          const inter = Y.filter((s) => X.has(s));
          const diff = Y.filter((s) => !X.has(s));
          if (inter.length && diff.length) {
            splits++;
            nextPartition.push(inter, diff);
            const idx = work.findIndex((w) => w.size === Y.length && Y.every((s) => w.has(s)));
            if (idx >= 0) work.splice(idx, 1, new Set(inter), new Set(diff));
            else work.push(new Set(inter.length <= diff.length ? inter : diff));
          } else nextPartition.push(Y);
        }
        partition = nextPartition;
      }
    }
    // renumber: BFS order from start for canonical form
    const blockOf = new Map();
    partition.forEach((b, i) => b.forEach((s) => blockOf.set(s, i)));
    const order = new Map([[blockOf.get(this.start), 0]]);
    const queue = [blockOf.get(this.start)];
    const min = new Dfa(this.#alphabet);
    while (queue.length) {
      const b = queue.shift();
      const rep = partition[b][0];
      const row = new Map();
      for (const sym of this.#alphabet) {
        const tb = blockOf.get(this.trans[rep].get(sym));
        if (!order.has(tb)) {
          order.set(tb, order.size);
          queue.push(tb);
        }
        row.set(sym, order.get(tb));
      }
      min.trans[order.get(b)] = row;
      if (this.accepting.has(rep)) min.accepting.add(order.get(b));
    }
    min.splits = splits;
    return min;
  }
  signature() {
    return fnv(this.trans.map((row, i) => (this.accepting.has(i) ? '*' : '') + this.#alphabet.map((s) => row.get(s)).join('.')).join('|'));
  }
  *enumerate(maxLen) {
    // BFS over strings, shortest first, lexicographic by alphabet
    let frontier = [['', this.start]];
    for (let len = 0; len <= maxLen; len++) {
      const next = [];
      for (const [str, s] of frontier) {
        if (this.accepting.has(s)) yield str;
        if (len < maxLen) for (const sym of this.#alphabet) {
          const t = this.trans[s]?.get(sym);
          if (t !== undefined) next.push([str + sym, t]);
        }
      }
      frontier = next;
    }
  }
}

// ---------------------------------------------------------------- compile facade
const cache = new Map();
function compile(pattern, alphabet) {
  const key = pattern + '\u0000' + alphabet.join('');
  if (cache.has(key)) return cache.get(key);
  const parser = new Parser(pattern);
  const ast = parser.parse();
  const nfa = Nfa.build(ast);
  const dfa = Dfa.fromNfa(nfa, alphabet);
  const min = Dfa.fromNfa(nfa, alphabet).minimize();
  const res = { ast, nfa, dfa, min, groups: parser.groupCount, names: parser.names };
  cache.set(key, res);
  return res;
}

function allStrings(alphabet, maxLen) {
  const res = [''];
  let layer = [''];
  for (let l = 1; l <= maxLen; l++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    res.push(...layer);
  }
  return res;
}

// ---------------------------------------------------------------- section 1: charsets
out('== charsets ==');
{
  const cs = CharSet.of('dcba').union(new CharSet([[120, 122]]));
  out('set', String(cs), cs.has(98), cs.has(119));
  out('negate twice', String(cs.negate().negate()) === String(cs), 'isCharSet', CharSet.isCharSet(cs), CharSet.isCharSet({}));
  out('digit/word', String(CharSet.digit), String(CharSet.word), String(CharSet.space));
  out('not digit has x', CharSet.digit.negate().has(120), CharSet.digit.negate().has(53));
}

// ---------------------------------------------------------------- section 2: parse / print
out('== parser ==');
const patterns = [
  'a',
  'ab|cd',
  'a*b+c?',
  '(ab)*',
  '(a|b)*abb',
  'a{2,3}',
  'a{2,}b{0,1}',
  '[a-c]+x',
  '[^ab]*',
  '(?:ab|a)(?<tail>b|)c?',
  '\\d+(\\.\\d*)?',
  '(a|ab)(c|bcd)(d*)',
  '((a|b)(a|b))*',
  '.b.',
  '(a*)*b',
  '[a\\-c]x|\\w\\W',
  '',
];
for (const p of patterns) {
  try {
    const parser = new Parser(p);
    const ast = parser.parse();
    out(`/${p}/`, '->', String(ast), 'nullable', ast.nullable, 'groups', parser.groupCount, parser.names);
  } catch (e) {
    out('parse error', p, e.message);
  }
}
for (const bad of ['a**', '(ab', 'a{3,1}', '[z-a]', '*a', '(?<n>a)(?<n>b)', 'a\\', '(?=x)', '[ab']) {
  try {
    new Parser(bad).parse();
    out('lenient accept', bad);
  } catch (err) {
    const { name, pos = -1 } = err;
    out('bad', JSON.stringify(bad), name, err instanceof RegexSyntaxError, 'pos', pos, err.message);
  }
}
try {
  new Node('x');
} catch ({ message }) {
  out('abstract', message);
}

// ---------------------------------------------------------------- section 3: exhaustive equivalence
out('== equivalence vs native ==');
const ALPHA = ['a', 'b', 'c', 'd', 'x', '1', '.', '-'];
let totalChecked = 0;
let mismatches = [];
for (const p of patterns) {
  const { nfa, dfa, min } = compile(p, ALPHA);
  const native = new RegExp(`^(?:${p})$`, 'u');
  let agree = 0;
  const strings = allStrings(ALPHA.slice(0, p.includes('\\d') || p.includes('.') ? 8 : 5), 4);
  check: for (const s of strings) {
    const expected = native.test(s);
    const got = [nfa.matches(s), dfa.matches(s), min.matches(s)];
    totalChecked++;
    for (let k = 0; k < got.length; k++) {
      if (got[k] !== expected) {
        mismatches.push({ p, s, k, expected });
        if (mismatches.length > 5) break check;
        continue check;
      }
    }
    agree++;
  }
  out(`/${p}/`.padEnd(24), 'nfa', String(nfa.states.length).padStart(3), 'dfa', String(dfa.size).padStart(3), 'min', String(min.size).padStart(2), 'splits', min.splits, 'agree', `${agree}/${strings.length}`, 'sig', min.signature());
}
out('checked', totalChecked, 'mismatches', mismatches);

// ---------------------------------------------------------------- section 4: language equality via minimal DFA signature
out('== language equality ==');
const pairs = [
  ['(a|b)*', '(a*b*)*'],
  ['a(ba)*', '(ab)*a'],
  ['a+', 'aa*'],
  ['(a|b)*abb', '(a|b)*ab(b)'],
  ['a{2,3}', 'aaa?'],
  ['a*b', 'a+b'],
  ['(ab|a)*', '(a|ab)*'],
  ['[a-c]', 'a|b|c'],
];
for (const [x, y] of pairs) {
  const sx = compile(x, ALPHA.slice(0, 4)).min.signature();
  const sy = compile(y, ALPHA.slice(0, 4)).min.signature();
  out(`${x} == ${y}`, sx === sy);
}

// ---------------------------------------------------------------- section 5: enumeration
out('== enumeration ==');
for (const p of ['(a|b)*abb', 'a{2,3}|c', '(ab)*c?']) {
  const { min } = compile(p, ['a', 'b', 'c']);
  const words = [];
  for (const w of min.enumerate(5)) {
    if (words.length >= 8) break;
    words.push(w || 'ε');
  }
  out(p, words);
}

// ---------------------------------------------------------------- section 6: NFA trace generator
out('== nfa trace ==');
{
  const { nfa } = compile('(a|b)*abb', ALPHA);
  const sizes = [];
  const it = nfa.trace('ababb');
  let r;
  while (!(r = it.next()).done) sizes.push(r.value);
  out('trace sizes', sizes, 'result', r.value);
  const it2 = nfa.trace('aaaa');
  it2.next();
  it2.next();
  out('abort', JSON.stringify(it2.next('abort')), JSON.stringify(it2.next()));
  const it3 = nfa.trace('ab');
  it3.next();
  out('early return', JSON.stringify(it3.return('stopped')));
}

// ---------------------------------------------------------------- section 7: native regex feature showcase
out('== native features ==');
{
  const log = 'id=17;user=ann;amt=$42.50|id=18;user=bob;amt=$7.05|id=19;user=cy;amt=€3.00';
  const re = /id=(?<id>\d+);user=(?<user>\w+);amt=(?<cur>[$€])(?<amt>\d+\.\d\d)/gu;
  const rows = [];
  for (const { groups: { id, user, cur, amt } } of log.matchAll(re)) rows.push(`${user}#${id}:${cur}${amt}`);
  out('named groups', rows);
  out('lookbehind', '$10 €20 $30'.match(/(?<=\$)\d+/g), 'neg lookbehind', '$10 €20 $30'.match(/(?<!\$)\b\d+/g));
  const sticky = /[a-z]+|\d+|\s+|./y;
  const toks = [];
  let m;
  while ((m = sticky.exec('abc 12+de')) !== null) toks.push(`${m[0]}@${sticky.lastIndex}`);
  out('sticky', toks);
  out('unicode', /^.$/u.test('😀'), /^.$/.test('😀'), '😀x'.length, [...'😀x'].length);
  out('replace fn', 'a-b_c d'.replace(/[-_ ](\w)/g, (_, c, off) => c.toUpperCase() + off));
  out('replace named', '2026-09-29'.replace(/(?<y>\d+)-(?<m>\d+)-(?<d>\d+)/, '$<d>.$<m>.$<y>'));
  out('split limit', 'a1b22c333d'.split(/\d+/, 3), 'raw', String.raw`\d+\.${1 + 1}`);
  const flags = /x/dgimsuy.flags;
  out('flags', flags, /(?<w>b)/d.exec('abc').indices.groups.w);
}

// ---------------------------------------------------------------- section 8: tokenizer built on the DFA engine
out('== dfa tokenizer ==');
class Lexer {
  #rules;
  static #instances = 0;
  static {
    Lexer.DEFAULT = [
      ['num', '\\d+(\\.\\d+)?'],
      ['id', '[a-c][a-c1]*'],
      ['op', '\\+|-|\\*|\\*\\*'],
      ['ws', ' +'],
    ];
  }
  constructor(rules = Lexer.DEFAULT, alphabet) {
    Lexer.#instances++;
    this.#rules = rules.map(([name, pat]) => ({ name, dfa: compile(pat, alphabet).min }));
  }
  static get instances() { return Lexer.#instances; }
  *tokens(src) {
    let pos = 0;
    while (pos < src.length) {
      let best = null;
      for (const { name, dfa } of this.#rules) {
        let s = dfa.start, last = -1;
        for (let i = pos; i < src.length; i++) {
          s = dfa.trans[s]?.get(src[i]);
          if (s === undefined) break;
          if (dfa.accepting.has(s)) last = i + 1;
        }
        if (last > pos && (!best || last > best.end)) best = { name, end: last };
      }
      if (!best) throw new SyntaxError(`lex error at ${pos}: '${src[pos]}'`);
      if (best.name !== 'ws') yield [best.name, src.slice(pos, best.end)];
      pos = best.end;
    }
  }
}
{
  const alphabet = [...'0123456789.abc+-* '];
  const lx = new Lexer(undefined, alphabet);
  out('tokens', [...lx.tokens('ab1 + 3.25 ** c - 10')].map(([t, v]) => `${t}:${v}`));
  try {
    [...lx.tokens('a + d')];
  } catch (e) {
    out('lex fail', e.message);
  }
  out('instances', Lexer.instances, 'cache', cache.size);
}

// ---------------------------------------------------------------- section 9: random regex fuzzing
out('== fuzz ==');
function rng(seed) {
  let x = seed;
  return () => ((x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff), x / 0x80000000);
}
function genRegex(r, depth) {
  const roll = r();
  if (depth <= 0 || roll < 0.25) return ['a', 'b', 'c', '[ab]', '.', '[^a]'][Math.floor(r() * 6)];
  if (roll < 0.5) return genRegex(r, depth - 1) + genRegex(r, depth - 1);
  if (roll < 0.65) return `(${genRegex(r, depth - 1)}|${genRegex(r, depth - 1)})`;
  if (roll < 0.8) return `(${genRegex(r, depth - 1)})${['*', '+', '?'][Math.floor(r() * 3)]}`;
  return `(${genRegex(r, depth - 1)}){${Math.floor(r() * 2)},${2 + Math.floor(r() * 2)}}`;
}
{
  const r = rng(2024);
  const alpha = ['a', 'b', 'c'];
  const strs = allStrings(alpha, 5);
  let ok = 0, bad = 0, sizes = [];
  for (let i = 0; i < 25; i++) {
    const p = genRegex(r, 3);
    const { min, dfa } = compile(p, alpha);
    const native = new RegExp(`^(?:${p})$`);
    const good = strs.every((s) => native.test(s) === min.matches(s) && dfa.matches(s) === min.matches(s));
    good ? ok++ : (bad++, out('FUZZ MISMATCH', p));
    sizes.push(min.size);
    if (i % 5 === 0) out('fuzz', i, p, 'min', min.size, 'dfa', dfa.size);
  }
  out('fuzz ok', ok, 'bad', bad, 'sizes', sizes.join(','));
}

// ---------------------------------------------------------------- section 10: proxies, reflect, misc
out('== proxy memo ==');
{
  let hits = 0, misses = 0;
  const memo = new Proxy(Object.create(null), {
    get(target, pat) {
      if (typeof pat !== 'string') return undefined;
      if (Reflect.has(target, pat)) {
        hits++;
        return Reflect.get(target, pat);
      }
      misses++;
      const c = compile(pat, ['a', 'b']);
      Reflect.defineProperty(target, pat, { value: c.min.size, enumerable: true });
      return c.min.size;
    },
    ownKeys: (t) => Reflect.ownKeys(t).sort(),
  });
  const q = ['a*', 'b*', 'a*', '(ab)*', 'b*', 'a*'].map((p) => memo[p]);
  out('memo', q, 'hits', hits, 'misses', misses, 'keys', Object.keys(memo));
  const summary = { patterns: patterns.length, ...{ checked: totalChecked }, mismatches: mismatches.length || null };
  summary.mismatches ??= 0;
  summary.flag ||= 'set';
  summary.checked &&= summary.checked > 0 ? 'positive' : 'zero';
  out('summary', summary, typeof summary.flag, 'patterns' in summary, delete summary.flag, summary.flag === void 0);
}

// ---------------------------------------------------------------- section 11: async matching pipeline
out('== async ==');
async function* stream(words) {
  for (const w of words) {
    await null;
    yield w;
  }
}
async function classify(words, pats) {
  const compiled = pats.map((p) => [p, compile(p, ['a', 'b', 'c']).min]);
  const buckets = Object.fromEntries(pats.map((p) => [p, []]));
  buckets.none = [];
  for await (const w of stream(words)) {
    let placed = false;
    for (const [p, dfa] of compiled) {
      if (!dfa.matches(w)) continue;
      buckets[p].push(w);
      placed = true;
      break;
    }
    placed || buckets.none.push(w);
  }
  return buckets;
}
(async () => {
  const res = await classify(['abb', 'aabb', 'c', 'abc', '', 'ccc', 'babb'], ['(a|b)*abb', 'c*', 'a.c']);
  out('buckets', res);
  const checks = await Promise.all(
    ['ab', 'ba', 'abab'].map(async (s, i) => {
      for (let k = 0; k < i; k++) await null;
      return `${s}:${compile('(ab)*', ['a', 'b']).min.matches(s)}`;
    })
  );
  out('parallel', checks);
  const first = await Promise.race([
    stream(['x']).next().then(() => 'stream'),
    Promise.resolve('resolved'),
  ]);
  out('race', first);
})().then(() => out('done'));
