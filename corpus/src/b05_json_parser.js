// Hand-written recursive-descent JSON(-like) parser with comments, trailing commas,
// single-quoted strings, plus a pretty printer and a path query helper.
'use strict';

class ParseError extends SyntaxError {
  constructor(message, pos, line, col) {
    super(`${message} at ${line}:${col}`);
    this.name = 'ParseError';
    this.pos = pos;
    this.line = line;
    this.col = col;
  }
}

const TOKEN = {
  LBRACE: '{', RBRACE: '}', LBRACK: '[', RBRACK: ']', COLON: ':', COMMA: ',',
  STRING: 'string', NUMBER: 'number', IDENT: 'ident', EOF: 'eof',
};

class Lexer {
  #src;
  #pos = 0;
  #line = 1;
  #col = 1;
  static stats = { tokens: 0, comments: 0 };

  constructor(src, { allowComments = true } = {}) {
    this.#src = src;
    this.allowComments = allowComments;
  }

  get position() {
    return { pos: this.#pos, line: this.#line, col: this.#col };
  }

  error(msg) {
    const { pos, line, col } = this.position;
    return new ParseError(msg, pos, line, col);
  }

  #peekChar(o = 0) {
    return this.#src[this.#pos + o];
  }

  #advance() {
    const ch = this.#src[this.#pos++];
    if (ch === '\n') {
      this.#line++;
      this.#col = 1;
    } else {
      this.#col++;
    }
    return ch;
  }

  #skipTrivia() {
    for (;;) {
      const ch = this.#peekChar();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.#advance();
      } else if (ch === '/' && this.allowComments && this.#peekChar(1) === '/') {
        Lexer.stats.comments++;
        while (this.#pos < this.#src.length && this.#peekChar() !== '\n') this.#advance();
      } else if (ch === '/' && this.allowComments && this.#peekChar(1) === '*') {
        Lexer.stats.comments++;
        this.#advance();
        this.#advance();
        while (!(this.#peekChar() === '*' && this.#peekChar(1) === '/')) {
          if (this.#pos >= this.#src.length) throw this.error('unterminated comment');
          this.#advance();
        }
        this.#advance();
        this.#advance();
      } else {
        return;
      }
    }
  }

  #readString(quote) {
    this.#advance();
    let out = '';
    for (;;) {
      if (this.#pos >= this.#src.length) throw this.error('unterminated string');
      const ch = this.#advance();
      if (ch === quote) return out;
      if (ch === '\n') throw this.error('newline in string');
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const esc = this.#advance();
      switch (esc) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '/': out += '/'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case 'u': {
          let hex = '';
          for (let i = 0; i < 4; i++) hex += this.#advance();
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error(`bad unicode escape \\u${hex}`);
          out += String.fromCharCode(parseInt(hex, 16));
          break;
        }
        default:
          throw this.error(`bad escape \\${esc}`);
      }
    }
  }

  #readNumber() {
    const rest = this.#src.slice(this.#pos);
    const m = /^-?(?:0x[0-9a-fA-F]+|(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!m) throw this.error('bad number');
    for (let i = 0; i < m[0].length; i++) this.#advance();
    const text = m[0];
    const value = /0x/i.test(text) ? (text.startsWith('-') ? -parseInt(text.slice(3), 16) : parseInt(text.slice(2), 16)) : Number(text);
    return { text, value };
  }

  next() {
    this.#skipTrivia();
    Lexer.stats.tokens++;
    const start = this.position;
    const ch = this.#peekChar();
    if (ch === undefined) return { type: TOKEN.EOF, ...start };
    if ('{}[]:,'.includes(ch)) {
      this.#advance();
      return { type: ch, ...start };
    }
    if (ch === '"' || ch === "'") return { type: TOKEN.STRING, value: this.#readString(ch), ...start };
    if (ch === '-' || (ch >= '0' && ch <= '9')) return { type: TOKEN.NUMBER, ...this.#readNumber(), ...start };
    if (/[A-Za-z_$]/.test(ch)) {
      let id = '';
      while (/[\w$]/.test(this.#peekChar() ?? '')) id += this.#advance();
      return { type: TOKEN.IDENT, value: id, ...start };
    }
    throw this.error(`unexpected character '${ch}'`);
  }

  *[Symbol.iterator]() {
    for (;;) {
      const t = this.next();
      yield t;
      if (t.type === TOKEN.EOF) return;
    }
  }
}

class Parser {
  constructor(src, options = {}) {
    this.lexer = new Lexer(src, options);
    this.options = { allowTrailingComma: true, allowUnquotedKeys: true, maxDepth: 32, ...options };
    this.tok = this.lexer.next();
    this.depth = 0;
    this.nodes = 0;
  }

  fail(msg, tok = this.tok) {
    return new ParseError(msg, 0, tok.line, tok.col);
  }

  eat(type) {
    if (this.tok.type !== type) throw this.fail(`expected '${type}' but got '${this.tok.type}'`);
    const t = this.tok;
    this.tok = this.lexer.next();
    return t;
  }

  parse() {
    const v = this.value();
    if (this.tok.type !== TOKEN.EOF) throw this.fail('trailing content');
    return v;
  }

  value() {
    this.nodes++;
    const t = this.tok;
    switch (t.type) {
      case TOKEN.LBRACE: return this.guard(() => this.object());
      case TOKEN.LBRACK: return this.guard(() => this.array());
      case TOKEN.STRING: this.eat(TOKEN.STRING); return t.value;
      case TOKEN.NUMBER: this.eat(TOKEN.NUMBER); return t.value;
      case TOKEN.IDENT:
        this.eat(TOKEN.IDENT);
        if (t.value === 'true') return true;
        if (t.value === 'false') return false;
        if (t.value === 'null') return null;
        if (t.value === 'Infinity') return Infinity;
        if (t.value === 'NaN') return NaN;
        throw this.fail(`unknown literal ${t.value}`, t);
      default:
        throw this.fail(`unexpected token '${t.type}'`);
    }
  }

  guard(fn) {
    if (++this.depth > this.options.maxDepth) throw this.fail('nesting too deep');
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  object() {
    this.eat(TOKEN.LBRACE);
    const obj = {};
    while (this.tok.type !== TOKEN.RBRACE) {
      let key;
      if (this.tok.type === TOKEN.STRING) key = this.eat(TOKEN.STRING).value;
      else if (this.tok.type === TOKEN.IDENT && this.options.allowUnquotedKeys) key = this.eat(TOKEN.IDENT).value;
      else throw this.fail('expected key');
      this.eat(TOKEN.COLON);
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw this.fail(`duplicate key "${key}"`);
      obj[key] = this.value();
      if (this.tok.type === TOKEN.COMMA) {
        this.eat(TOKEN.COMMA);
        if (this.tok.type === TOKEN.RBRACE && !this.options.allowTrailingComma) throw this.fail('trailing comma');
      } else break;
    }
    this.eat(TOKEN.RBRACE);
    return obj;
  }

  array() {
    this.eat(TOKEN.LBRACK);
    const arr = [];
    while (this.tok.type !== TOKEN.RBRACK) {
      arr.push(this.value());
      if (this.tok.type === TOKEN.COMMA) this.eat(TOKEN.COMMA);
      else break;
    }
    this.eat(TOKEN.RBRACK);
    return arr;
  }
}

function quote(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || (code > 0x7e && code < 0x10000)) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function pretty(value, indent = 2, level = 0, opts = {}) {
  const { sortKeys = false, maxInline = 40 } = opts;
  const pad = ' '.repeat(indent * (level + 1));
  const padEnd = ' '.repeat(indent * level);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return quote(value);
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const parts = value.map((v) => pretty(v, indent, level + 1, opts));
        const inline = `[${parts.join(', ')}]`;
        if (inline.length <= maxInline && !inline.includes('\n')) return inline;
        return `[\n${parts.map((p) => pad + p).join(',\n')}\n${padEnd}]`;
      }
      let keys = Object.keys(value);
      if (sortKeys) keys = keys.sort();
      if (keys.length === 0) return '{}';
      const parts = keys.map((k) => `${pad}${quote(k)}: ${pretty(value[k], indent, level + 1, opts)}`);
      return `{\n${parts.join(',\n')}\n${padEnd}}`;
    }
    default:
      return 'null';
  }
}

function query(obj, path) {
  const segs = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur = obj;
  for (const seg of segs) {
    const idx = /^\[(\d+)\]$/.exec(seg);
    cur = idx ? cur?.[Number(idx[1])] : cur?.[seg];
  }
  return cur;
}

function stats(value, acc = { objects: 0, arrays: 0, strings: 0, numbers: 0, other: 0, maxDepth: 0 }, depth = 0) {
  acc.maxDepth = Math.max(acc.maxDepth, depth);
  if (Array.isArray(value)) {
    acc.arrays++;
    for (const v of value) stats(v, acc, depth + 1);
  } else if (value && typeof value === 'object') {
    acc.objects++;
    for (const k in value) stats(value[k], acc, depth + 1);
  } else if (typeof value === 'string') acc.strings++;
  else if (typeof value === 'number') acc.numbers++;
  else acc.other++;
  return acc;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

const SAMPLE = `
// application config
{
  name: 'vm-corpus',
  "version": "1.4.2",
  /* nested
     block comment */
  build: {
    targets: ["node", "browser", ],
    minify: true,
    level: 3,
    ratio: 0.75,
    big: 1.5e3,
    mask: 0xFF,
  },
  "authors": [
    { "name": "Ada", "roles": ["dev", "ops"] },
    { name: "Linus", roles: [], active: false },
  ],
  "escapes": "tab\\there \\"quoted\\" \\u00e9\\u4e2d",
  "nothing": null,
  "neg": -42,
}
`;

const BAD_INPUTS = [
  '{"a": 1,, "b": 2}',
  '[1, 2',
  '{"a" 1}',
  '"unterminated',
  '{"x": tru}',
  '{"k": 1, "k": 2}',
  '[1] 2',
  '{"s": "bad \\q escape"}',
  '@',
  '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]',
];

function main() {
  const parser = new Parser(SAMPLE);
  const data = parser.parse();
  console.log('parsed nodes:', parser.nodes);
  console.log('top keys:', Object.keys(data).join(', '));
  console.log('pretty:');
  for (const line of pretty(data).split('\n')) console.log('  ' + line);

  const paths = ['name', 'build.targets[1]', 'build.mask', 'authors[0].roles[1]', 'authors[1].active', 'authors[5].name', 'escapes'];
  for (const p of paths) console.log(`query ${p} => ${JSON.stringify(query(data, p)) ?? 'undefined'}`);

  const st = stats(data);
  console.log('stats:', Object.entries(st).map(([k, v]) => `${k}=${v}`).join(' '));

  const roundTrip = new Parser(pretty(data, 4, 0, { sortKeys: true })).parse();
  console.log('roundtrip equal:', deepEqual(data, roundTrip));
  console.log('matches native JSON:', deepEqual(JSON.parse(JSON.stringify(data)), roundTrip));

  const native = JSON.parse('{"x":[1,2,{"y":"z"}],"w":true}');
  const mine = new Parser('{"x":[1,2,{"y":"z"}],"w":true}', { allowComments: false }).parse();
  console.log('native vs mine:', deepEqual(native, mine));

  console.log('special literals:', JSON.stringify(new Parser('[Infinity, NaN, -0x10, 1e-3]').parse().map(String)));

  const strict = { allowTrailingComma: false, allowUnquotedKeys: false };
  for (const src of ['{"a": [1,2,],}', '{a: 1}', '{"a": 1}']) {
    try {
      console.log(`strict ${src} -> ${JSON.stringify(new Parser(src, strict).parse())}`);
    } catch (e) {
      console.log(`strict ${src} -> ${e.name}: ${e.message}`);
    }
  }

  let ok = 0;
  let failed = 0;
  for (const src of BAD_INPUTS) {
    try {
      new Parser(src).parse();
      ok++;
    } catch (e) {
      failed++;
      console.log(`bad #${failed}: ${e instanceof ParseError ? 'ParseError' : e.name} ${e.message}`);
    }
  }
  console.log(`bad inputs: ${failed} rejected, ${ok} accepted`);

  const tokens = [...new Lexer('{a: [1, "two", true]} // end')].map((t) => (t.value !== undefined ? `${t.type}(${t.value})` : t.type));
  console.log('tokens:', tokens.join(' '));
  console.log(`lexer stats: tokens=${Lexer.stats.tokens} comments=${Lexer.stats.comments}`);
  console.log('quote test:', quote('line1\nline2\t"q" \\ ü'));
}

main();
