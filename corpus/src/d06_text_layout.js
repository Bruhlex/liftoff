// d06_text_layout.js - text layout engine: tokenizer, Liang hyphenation, greedy and
// optimal (minimum raggedness) line breaking, justification, columns, tables, pagination.

const SAMPLE = {
  intro: "Typesetting is the composition of text by means of arranging physical type or its digital equivalents. Stored letters and other symbols are retrieved and ordered according to a language's orthography for visual display. Hyphenation algorithms determine where words may be broken; justification distributes whitespace so that both margins align.",
  fox: 'The quick brown fox jumps over the lazy dog. Extraordinarily long words like incomprehensibilities, internationalization and characterization challenge naive line-breaking strategies!',
  unicode: 'Naïve café owners in Straße über-optimize their menus — résumé writers, too. Ünïcödé should be measured by code points, not UTF-16 units: 𝒳 and 𝒴 count once.',
  raw: 'Short line.\nAnother short line with a tab\there and trailing spaces   \n\nNew paragraph after blank line.',
};

const PATTERNS = ['hy3ph', 'he2n', 'hena4', 'hen5at', '1na', 'n2at', '1tio', '2io', 'o2n', '1ca', '2ct', 'c1t', '1pr',
  '1ter', 'ter1a', '2ly', '1ble', 'a1bi', '1ty', '1ti', 'i1za', 'za2', '1za', '2iza', '1iz', 'al1i', '1li', '1en', '1er',
  '1est', 'in1c', '1com', 'co2m', 'mp1', '1pre', 'ex1', '1tra', 'ra1', 'or1d', '1di', '1bi', '1si', 'ng1', '2ng', '1gu',
  'g1g', '1ve', 'ov1', '2ai', 'ss1', '1sti', 's1ti', 'ph1', '1gor', 'go2', '1rith', 'ju1', '1fi', 'fi1c', '1tu', 'st1r',
  '1me', 'ra2t', 'rac1', 'ar1a', '2ble', '1sib', 'hen1s', 're1h', 'pre1h', 'on1a', 'o1na', '1ter1n'];
const EXCEPTIONS = ['ta-ble', 'pro-ject', 'present', 'every-thing'];

// ---------- measurement ----------
const NARROW = new Set([...'iljtf.,;:!\'|']);
const WIDE = new Set([...'mwMW@—']);
const Metrics = {
  mono: { name: 'mono', space: 1, hyphen: 1, width(s) { return [...s].length; } },
  prop: {
    name: 'prop',
    space: 2,
    hyphen: 2,
    width(s) {
      let w = 0;
      for (const ch of s) w += NARROW.has(ch) ? 1 : WIDE.has(ch) ? 4 : /\p{Lu}/u.test(ch) ? 3 : 2;
      return w;
    },
  },
};

// ---------- styles with Proxy inheritance ----------
function makeStyle(own, parent = null) {
  return new Proxy(own, {
    get(t, k, r) {
      if (k === '__parent') return parent;
      if (Reflect.has(t, k)) return Reflect.get(t, k, r);
      return parent ? parent[k] : undefined;
    },
    has(t, k) { return Reflect.has(t, k) || (parent != null && k in parent); },
    set(t, k, v) {
      if (k === 'width' && (typeof v !== 'number' || v < 4)) throw new RangeError('width too small: ' + v);
      return Reflect.set(t, k, v);
    },
  });
}
const BASE_STYLE = makeStyle({ width: 40, align: 'justify', metrics: 'mono', hyphenate: true, indent: 0 });

// ---------- hyphenation (Liang) ----------
class Hyphenator {
  #patterns = new Map();
  #exceptions = new Map();
  #left;
  #right;
  #cache = new Map();
  static #instances = 0;
  static { Hyphenator.SOFT = '­'; }
  constructor(patterns, exceptions = [], { left = 2, right = 3 } = {}) {
    Hyphenator.#instances++;
    this.#left = left;
    this.#right = right;
    for (const p of patterns) this.#addPattern(p);
    for (const e of exceptions) this.#exceptions.set(e.replace(/-/g, ''), e.split('-'));
  }
  static get instances() { return Hyphenator.#instances; }
  #addPattern(p) {
    const letters = p.replace(/\d/g, '');
    const points = new Array(letters.length + 1).fill(0);
    let idx = 0;
    for (const ch of p) {
      if (ch >= '0' && ch <= '9') points[idx] = +ch;
      else idx++;
    }
    this.#patterns.set(letters, points);
  }
  get cacheSize() { return this.#cache.size; }
  syllables(word) {
    const key = word.toLowerCase();
    if (this.#cache.has(key)) return this.#cache.get(key).map((s, i, a) => word.substr(a.slice(0, i).join('').length, s.length));
    let pieces;
    exc: {
      if (this.#exceptions.has(key)) { pieces = this.#exceptions.get(key); break exc; }
      if (word.length < this.#left + this.#right || /[^\p{L}]/u.test(word)) { pieces = [key]; break exc; }
      const work = '.' + key + '.';
      const points = new Array(work.length + 1).fill(0);
      for (let i = 0; i < work.length; i++) {
        for (let j = i + 1; j <= work.length; j++) {
          const pat = this.#patterns.get(work.slice(i, j));
          if (!pat) continue;
          pat.forEach((v, k) => { if (v > points[i + k]) points[i + k] = v; });
        }
      }
      pieces = [''];
      [...key].forEach((c, i) => {
        pieces[pieces.length - 1] += c;
        const after = i + 1;
        if (points[i + 2] % 2 === 1 && after >= this.#left && key.length - after >= this.#right) pieces.push('');
      });
    }
    this.#cache.set(key, pieces);
    let pos = 0;
    return pieces.map((s) => word.substr((pos += s.length) - s.length, s.length));
  }
  hyphenate(word, sep = '-') { return this.syllables(word).join(sep); }
}

// ---------- items (Knuth-Plass flavoured) ----------
class Item {
  static #count = 0;
  constructor(width) {
    if (new.target === Item) throw new TypeError('Item is abstract');
    this.width = width;
    Item.#count++;
  }
  static get count() { return Item.#count; }
  get kind() { return 'item'; }
}
class Box extends Item {
  constructor(text, width) { super(width); this.text = text; }
  get kind() { return 'box'; }
  toString() { return this.text; }
}
class Glue extends Item {
  constructor(width, stretch = 1, shrink = 0) { super(width); this.stretch = stretch; this.shrink = shrink; }
  get kind() { return 'glue'; }
}
class Penalty extends Item {
  constructor(width, cost, flagged = false) { super(width); this.cost = cost; this.flagged = flagged; }
  get kind() { return 'penalty'; }
}
class HyphenPenalty extends Penalty {
  #explicit;
  constructor(width, explicit = false) { super(explicit ? 0 : width, explicit ? 10 : 50, true); this.#explicit = explicit; }
  get kind() { return this.#explicit ? 'explicit-' + super.kind : 'hyphen-' + super.kind; }
  get explicit() { return this.#explicit; }
  static isHyphen(x) { return x != null && typeof x === 'object' && #explicit in x; }
}

// ---------- tokenizer ----------
const TOKEN_RE = /(?<word>[\p{L}\p{N}\p{M}'’]+(?:-[\p{L}\p{N}]+)*)|(?<space>[ \t]+)|(?<nl>\n)|(?<punct>[^\s\p{L}\p{N}])/uy;
function* tokenize(text) {
  TOKEN_RE.lastIndex = 0;
  let m;
  let count = 0;
  while (TOKEN_RE.lastIndex < text.length && (m = TOKEN_RE.exec(text))) {
    const { word, space, nl, punct } = m.groups;
    count++;
    if (word !== undefined) yield { type: 'word', value: word };
    else if (space !== undefined) yield { type: 'space', value: space.replace(/\t/g, '    ') };
    else if (nl !== undefined) yield { type: 'nl', value: '\n' };
    else yield { type: 'punct', value: punct };
  }
  return count;
}

// words with attached punctuation, paragraphs split on blank lines
function paragraphs(text) {
  const out = [];
  let current = [];
  let lastNl = false;
  const gen = tokenize(text);
  let step;
  while (!(step = gen.next()).done) {
    const tok = step.value;
    switch (tok.type) {
      case 'nl':
        if (lastNl) { if (current.length) out.push(current); current = []; lastNl = false; continue; }
        lastNl = true;
        continue;
      case 'punct':
        if (current.length && !/[(“"‘]/u.test(tok.value)) { current[current.length - 1] += tok.value; break; }
      // fallthrough: opening punctuation starts a new word
      case 'word':
        if (current.length && current.at(-1).endsWith('(')) current[current.length - 1] += tok.value;
        else current.push(tok.value);
        break;
      default:
        break;
    }
    lastNl = false;
  }
  if (current.length) out.push(current);
  return { paras: out, tokens: step.value };
}

// ---------- atoms ----------
function toAtoms(words, metrics, hyph) {
  const atoms = [];
  words.forEach((w, wi) => {
    const last = wi === words.length - 1;
    const core = w.match(/^(?<lead>[^\p{L}]*)(?<body>[\p{L}\p{M}'’]*)(?<trail>.*)$/su).groups;
    let parts;
    if (w.includes('-') && !/^-|-$/.test(w)) {
      parts = w.split(/(?<=-)/u).map((p) => ({ text: p, explicit: true }));
    } else if (hyph && core.body.length >= 6) {
      const syl = hyph.syllables(core.body);
      parts = syl.map((s, i) => ({ text: (i === 0 ? core.lead : '') + s + (i === syl.length - 1 ? core.trail : ''), explicit: false }));
    } else {
      parts = [{ text: w, explicit: false }];
    }
    parts.forEach(({ text, explicit }, pi) => {
      const lastPart = pi === parts.length - 1;
      atoms.push({
        text,
        width: metrics.width(text),
        spaceAfter: lastPart && !last,
        hyphenAfter: !lastPart && !explicit,
        breakAfter: lastPart || !!explicit || true,
      });
    });
  });
  return atoms;
}

function lineWidth(atoms, i, j, metrics) {
  let w = 0;
  for (let k = i; k < j; k++) {
    w += atoms[k].width;
    if (k < j - 1 && atoms[k].spaceAfter) w += metrics.space;
  }
  if (atoms[j - 1].hyphenAfter) w += metrics.hyphen;
  return w;
}
function lineText(atoms, i, j) {
  let s = '';
  for (let k = i; k < j; k++) s += atoms[k].text + (k < j - 1 && atoms[k].spaceAfter ? ' ' : '');
  return s + (atoms[j - 1].hyphenAfter ? '-' : '');
}

function greedyBreaks(atoms, width, metrics) {
  const breaks = [];
  let start = 0;
  while (start < atoms.length) {
    let end = start + 1;
    let lastSpace = -1;
    for (let j = start + 1; j <= atoms.length; j++) {
      if (lineWidth(atoms, start, j, metrics) > width && j > start + 1) break;
      end = j;
      if (atoms[j - 1].spaceAfter || j === atoms.length) lastSpace = j;
    }
    if (end < atoms.length && lastSpace > start && !atoms[end - 1].spaceAfter) {
      const hyphenGain = end - lastSpace;
      if (hyphenGain <= 0) end = lastSpace;
    }
    breaks.push([start, end]);
    start = end;
  }
  return breaks;
}

function optimalBreaks(atoms, width, metrics) {
  const n = atoms.length;
  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (best[i] === Infinity) continue;
      const w = lineWidth(atoms, i, j, metrics);
      if (w > width && j - i > 1) break;
      const slack = width - w;
      let cost = j === n ? 0 : slack * slack;
      if (w > width) cost = 1e6;
      if (atoms[j - 1].hyphenAfter) cost += 50;
      if (i > 0 && atoms[i - 1].hyphenAfter && atoms[j - 1].hyphenAfter) cost += 3000;
      if (best[i] + cost < best[j]) { best[j] = best[i] + cost; from[j] = i; }
    }
  }
  const breaks = [];
  for (let j = n; j > 0; j = from[j]) breaks.unshift([from[j], j]);
  return { breaks, cost: best[n] };
}

// ---------- alignment ----------
function justify(text, width, lineNo, metrics) {
  const words = text.split(' ');
  const gaps = words.length - 1;
  const natural = metrics.width(text);
  let extra = width - natural;
  if (gaps <= 0 || extra <= 0) return text;
  if (metrics.space > 1) extra = Math.floor(extra / metrics.space);
  const base = Math.floor(extra / gaps);
  let rem = extra % gaps;
  const ltr = lineNo % 2 === 0;
  const spaces = new Array(gaps).fill(1 + base);
  for (let g = 0; rem > 0; g++, rem--) spaces[ltr ? g : gaps - 1 - g]++;
  return words.reduce((acc, w, i) => acc + (i ? ' '.repeat(spaces[i - 1]) : '') + w, '');
}
function align(text, width, mode, lineNo, isLast, metrics) {
  const pad = Math.max(0, width - metrics.width(text));
  switch (mode) {
    case 'justify':
      if (!isLast) return justify(text, width, lineNo, metrics);
    // last line of justified text falls back to left
    case 'left':
      return text;
    case 'right':
      return ' '.repeat(pad) + text;
    case 'center': {
      const l = pad >> 1;
      return ' '.repeat(l) + text;
    }
    default:
      throw new TypeError('bad align ' + mode);
  }
}

// ---------- layout engine ----------
class Layout {
  #hyph;
  #style;
  #stats = { lines: 0, hyphens: 0, overfull: 0 };
  static #layouts = 0;
  constructor(style, hyph) {
    this.#style = style;
    this.#hyph = hyph;
    Layout.#layouts++;
  }
  static get layouts() { return Layout.#layouts; }
  get stats() { return { ...this.#stats }; }
  get style() { return this.#style; }
  set width(w) { this.#style.width = w; }
  layoutWords(words, { algorithm = 'optimal' } = {}) {
    const { width, align: mode, metrics: mName, hyphenate, indent = 0 } = this.#style;
    const metrics = Metrics[mName] ?? Metrics.mono;
    const lead = ' '.repeat(indent);
    const atoms = toAtoms(indent ? [lead.replace(/ /g, ' '), ...words] : words, metrics, hyphenate ? this.#hyph : null);
    const breaks = algorithm === 'greedy' ? greedyBreaks(atoms, width, metrics) : optimalBreaks(atoms, width, metrics).breaks;
    return breaks.map(([i, j], n) => {
      const raw = lineText(atoms, i, j).replace(/ /g, ' ');
      this.#stats.lines++;
      if (atoms[j - 1].hyphenAfter) this.#stats.hyphens++;
      if (metrics.width(raw) > width) this.#stats.overfull++;
      return align(raw, width, mode, n, n === breaks.length - 1, metrics);
    });
  }
  *layoutText(text, opts) {
    const { paras } = paragraphs(text);
    let total = 0;
    for (const [pi, words] of paras.entries()) {
      if (pi) yield '';
      const lines = this.layoutWords(words, opts);
      total += lines.length;
      yield* lines;
    }
    return total;
  }
}

function frame(lines, width, title = '') {
  const top = '+' + (title ? `-[${title}]`.padEnd(width + 2, '-') : '-'.repeat(width + 2)) + '+';
  return [top, ...lines.map((l) => `| ${l.padEnd(width)} |`), '+' + '-'.repeat(width + 2) + '+'];
}
function columns(lines, gutter = 3) {
  const half = Math.ceil(lines.length / 2);
  const left = lines.slice(0, half), right = lines.slice(half);
  const w = Math.max(0, ...left.map((l) => [...l].length));
  return left.map((l, i) => l.padEnd(w) + ' '.repeat(gutter) + (right[i] ?? '')).map((s) => s.trimEnd());
}

// ---------- table layout ----------
function tableLayout(rows, total, hyph) {
  const cols = rows[0].length;
  const minW = new Array(cols).fill(1), maxW = new Array(cols).fill(1);
  for (const row of rows) {
    row.forEach((cell, c) => {
      const words = String(cell).split(/\s+/);
      minW[c] = Math.max(minW[c], ...words.map((w) => [...w].length));
      maxW[c] = Math.max(maxW[c], [...String(cell)].length);
    });
  }
  const avail = total - (cols * 3 + 1);
  let widths;
  const sumMax = maxW.reduce((a, b) => a + b, 0), sumMin = minW.reduce((a, b) => a + b, 0);
  if (sumMax <= avail) widths = maxW.slice();
  else if (sumMin >= avail) widths = minW.slice();
  else {
    const spare = avail - sumMin, range = sumMax - sumMin;
    widths = minW.map((m, c) => m + Math.floor((spare * (maxW[c] - minW[c])) / range));
    let left = avail - widths.reduce((a, b) => a + b, 0);
    for (let c = 0; left > 0; c = (c + 1) % cols) if (widths[c] < maxW[c]) { widths[c]++; left--; }
  }
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const out = [sep];
  rows.forEach((row, r) => {
    const cells = row.map((cell, c) => {
      const style = makeStyle({ width: Math.max(4, widths[c]), align: typeof cell === 'number' ? 'right' : 'left', hyphenate: false }, BASE_STYLE);
      return new Layout(style, hyph).layoutWords(String(cell).split(/\s+/), { algorithm: 'greedy' });
    });
    const h = Math.max(...cells.map((c) => c.length));
    for (let k = 0; k < h; k++) out.push('| ' + cells.map((c, ci) => (c[k] ?? '').padEnd(widths[ci])).join(' | ') + ' |');
    if (r === 0) out.push(sep.replace(/-/g, '='));
  });
  out.push(sep);
  return { out, widths };
}

// ---------- pagination with widow/orphan control ----------
class FlushPage extends Error {}
function* paginate(paraLines, height, { minTop = 2, minBottom = 2 } = {}) {
  let page = [];
  let pages = 0;
  paras: for (let p = 0; p < paraLines.length; p++) {
    const lines = paraLines[p];
    let i = 0;
    while (i < lines.length) {
      const room = height - page.length;
      const remaining = lines.length - i;
      try {
        if (remaining <= room) {
          page.push(...lines.slice(i));
          if (page.length < height && p < paraLines.length - 1) page.push('');
          continue paras;
        }
        let take = room;
        if (i === 0 && take < minBottom) take = 0;
        if (remaining - take < minTop) take = Math.max(0, remaining - minTop);
        if (i === 0 && take < minBottom) take = 0;
        page.push(...lines.slice(i, i + take));
        i += take;
        pages++;
        yield page;
        page = [];
      } catch (e) {
        if (!(e instanceof FlushPage)) throw e;
        pages++;
        yield ['<flushed ' + page.length + ' lines>', ...page];
        page = [];
      } finally {
        if (page.length > height) throw new RangeError('page overflow');
      }
    }
  }
  if (page.length) { pages++; yield page; }
  return pages;
}

// ---------- checksum ----------
function fnv64(lines) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const line of lines) {
    for (const ch of line) {
      h ^= BigInt(ch.codePointAt(0));
      h = BigInt.asUintN(64, h * prime);
    }
    h ^= 10n;
    h = BigInt.asUintN(64, h * prime);
  }
  return h.toString(16).padStart(16, '0');
}

function report(strings, ...vals) {
  return String.raw({ raw: strings.raw }, ...vals.map((v) => (Array.isArray(v) ? v.join('/') : typeof v === 'object' && v ? JSON.stringify(v) : v)));
}

// sloppy arguments helper
function widest() {
  var best = 0;
  for (var i = 0; i < arguments.length; i++) {
    var len = typeof arguments[i] === 'string' ? [...arguments[i]].length : 0;
    if (len > best) best = len;
  }
  return best;
}

// deep mutual recursion: counts characters alternately
function countA(s, i) { return i >= s.length ? 0 : (s.charCodeAt(i) & 1) + countB(s, i + 1); }
function countB(s, i) { return i >= s.length ? 0 : (s.charCodeAt(i) & 2 ? 1 : 0) + countA(s, i + 1); }

class Cursor {
  #pos = 0;
  #moves = 0;
  constructor(text) { this.text = text; }
  get pos() { this.#moves++; return this.#pos; }
  set pos(v) { this.#pos = Math.max(0, Math.min(this.text.length, v)); }
  get moves() { return this.#moves; }
  nextWord() {
    const re = /\p{L}+/gu;
    re.lastIndex = this.#pos;
    const m = re.exec(this.text);
    if (!m) return null;
    this.#pos = m.index + m[0].length;
    return m[0];
  }
  [Symbol.toPrimitive](hint) { return hint === 'number' ? this.#pos : `Cursor@${this.#pos}/${this.text.length}`; }
  *[Symbol.iterator]() { let w; while ((w = this.nextWord()) !== null) yield w; }
}

class TextStream {
  constructor(text, chunk) { this.text = text; this.chunk = chunk; }
  async *[Symbol.asyncIterator]() {
    for (let i = 0; i < this.text.length; i += this.chunk) {
      await null;
      yield this.text.slice(i, i + this.chunk);
    }
  }
}

async function streamLayout(stream, layout) {
  let buffer = '';
  const out = [];
  for await (const chunk of stream) {
    buffer += chunk;
    const lastSpace = buffer.lastIndexOf(' ');
    if (lastSpace > 30) {
      const ready = buffer.slice(0, lastSpace);
      buffer = buffer.slice(lastSpace + 1);
      out.push(ready.split(' ').length);
    }
  }
  const all = layout.layoutWords((out.length, stream.text.split(/\s+/)));
  return { chunks: out, lines: all };
}

function main() {
  const hyph = new Hyphenator(PATTERNS, EXCEPTIONS);
  console.log('== hyphenation ==');
  const words = ['hyphenation', 'algorithms', 'computer', 'table', 'present', 'internationalization', 'characterization',
    'incomprehensibilities', 'justification', 'Typesetting', 'extraordinarily', 'everything', 'naïve', 'strategies'];
  for (let i = 0; i < words.length; i += 3) console.log('  ' + words.slice(i, i + 3).map((w) => hyph.hyphenate(w, '·')).join('  '));
  console.log('cache', hyph.cacheSize, 'repeat', hyph.hyphenate('Hyphenation'), 'instances', Hyphenator.instances, 'soft', Hyphenator.SOFT.length);

  console.log('== tokenizer ==');
  const { paras, tokens } = paragraphs(SAMPLE.raw);
  console.log('tokens', tokens, 'paras', paras.length, JSON.stringify(paras));
  const kinds = {};
  for (const t of tokenize(SAMPLE.unicode)) kinds[t.type] = (kinds[t.type] ?? 0) + 1;
  console.log('unicode kinds', JSON.stringify(kinds));
  const sentences = SAMPLE.intro.split(/(?<=[.!?;])\s+(?=[A-Z])/u);
  console.log('sentences', sentences.length, sentences.map((s) => s.length).join(','));
  const quotes = [...SAMPLE.intro.matchAll(/(?<![\p{L}])(?<w>[a-z]+)'s\b/gu)].map((m) => m.groups.w);
  console.log('possessives', quotes.join(','));

  console.log('== widths ==');
  for (const s of ['illicit', 'MAMMOTH', 'café', '𝒳𝒴', 'Straße—ok']) console.log(`  ${s}: mono=${Metrics.mono.width(s)} prop=${Metrics.prop.width(s)} utf16=${s.length}`);
  console.log('widest', widest('a', 'naïve', 42, '𝒳𝒳𝒳𝒳𝒳𝒳', null));

  console.log('== greedy vs optimal (width 36) ==');
  const style = makeStyle({ width: 36, align: 'left' }, BASE_STYLE);
  const layout = new Layout(style, hyph);
  const g = layout.layoutWords(paragraphs(SAMPLE.intro).paras[0], { algorithm: 'greedy' });
  const o = layout.layoutWords(paragraphs(SAMPLE.intro).paras[0], { algorithm: 'optimal' });
  const ragged = (ls) => ls.slice(0, -1).reduce((s, l) => s + (36 - [...l].length) ** 2, 0);
  const rows = Math.max(g.length, o.length);
  for (let i = 0; i < rows; i++) console.log(`  ${(g[i] ?? '').padEnd(36)} | ${o[i] ?? ''}`);
  console.log(report`raggedness greedy=${ragged(g)} optimal=${ragged(o)} lines=${[g.length, o.length]}`);
  console.log('style chain', style.width, style.metrics, 'hyphenate' in style, 'bogus' in style, style.__parent === BASE_STYLE);
  try { style.width = 2; } catch (e) { console.log('style guard', e.name, e.message); }

  console.log('== justified box ==');
  const jstyle = makeStyle({ width: 42, align: 'justify', indent: 2 }, BASE_STYLE);
  const jl = new Layout(jstyle, hyph);
  const jlines = [...jl.layoutText(SAMPLE.intro + '\n\n' + SAMPLE.fox)];
  for (const l of frame(jlines, 42, 'justify')) console.log(l);
  console.log('stats', JSON.stringify(jl.stats), 'checksum', fnv64(jlines));

  console.log('== alignments ==');
  for (const mode of ['right', 'center']) {
    const lay = new Layout(makeStyle({ width: 30, align: mode, hyphenate: false }, BASE_STYLE), hyph);
    for (const l of lay.layoutWords(paragraphs(SAMPLE.fox).paras[0]).slice(0, 3)) console.log(`  [${l.padEnd(30)}]`);
  }
  try { new Layout(makeStyle({ align: 'diagonal' }, BASE_STYLE), hyph).layoutWords(['x', 'y']); } catch (e) { console.log('bad align:', e.message); }

  console.log('== proportional ==');
  const pl = new Layout(makeStyle({ width: 60, metrics: 'prop', align: 'justify' }, BASE_STYLE), hyph);
  const plines = pl.layoutWords(paragraphs(SAMPLE.unicode).paras[0]);
  plines.forEach((l, i) => console.log(`  ${String(Metrics.prop.width(l)).padStart(3)} ${l}`));

  console.log('== columns ==');
  const narrow = new Layout(makeStyle({ width: 24, align: 'justify' }, BASE_STYLE), hyph);
  const col = columns([...narrow.layoutText(SAMPLE.fox)]);
  col.forEach((l) => console.log('  ' + l));

  console.log('== table ==');
  const { out: table, widths } = tableLayout([
    ['Algorithm', 'Complexity', 'Notes'],
    ['greedy', 'O(n)', 'fast but ragged right margins'],
    ['Knuth-Plass', 'O(n^2)', 'minimizes total badness across the paragraph'],
    ['balanced', 42, 'placeholder numeric cell'],
  ], 56, hyph);
  table.forEach((l) => console.log('  ' + l));
  console.log('col widths', widths.join(','));

  console.log('== pagination ==');
  const paraLines = [SAMPLE.intro, SAMPLE.fox, SAMPLE.unicode].map((t) => new Layout(makeStyle({ width: 32 }, BASE_STYLE), hyph).layoutWords(paragraphs(t).paras[0]));
  console.log('para line counts', paraLines.map((p) => p.length).join(','));
  const pager = paginate(paraLines, 7);
  let res, pageNo = 0;
  while (!(res = pageNo === 2 ? pager.throw(new FlushPage('flush')) : pager.next()).done) {
    pageNo++;
    console.log(`  page ${pageNo}: ${res.value.length} lines, first="${(res.value[0] ?? '').trim().slice(0, 20)}"`);
  }
  console.log('pages returned', res.value);
  const pager2 = paginate(paraLines, 5);
  pager2.next();
  console.log('early return', JSON.stringify(pager2.return(-1)), JSON.stringify(pager2.next()));

  console.log('== items ==');
  const items = [new Box('word', 4), new Glue(1, 2, 1), new HyphenPenalty(1), new HyphenPenalty(1, true), new Penalty(0, -1000)];
  console.log(items.map((it) => `${it.kind}:${it.width}${it instanceof Penalty ? '/' + it.cost : ''}`).join(' '));
  console.log('isHyphen', items.map((x) => HyphenPenalty.isHyphen(x)).join(','), 'count', Item.count);
  try { new Item(1); } catch (e) { console.log('abstract item', e.message); }

  console.log('== cursor ==');
  const cur = new Cursor(SAMPLE.fox);
  const firstFive = [];
  for (const w of cur) { firstFive.push(w); if (firstFive.length === 5) break; }
  console.log(firstFive.join(' '), +cur, `${cur}`, cur.pos, cur.pos, cur.moves);
  cur.pos = 1e9;
  console.log('clamped', +cur, cur.nextWord());

  console.log('== misc ==');
  const long = SAMPLE.intro.repeat(10).slice(0, 3000);
  console.log('mutual recursion', countA(long, 0));
  const fns = [];
  for (const [k, v] of Object.entries(Metrics)) fns.push(() => k + v.space);
  for (let w = 10; w <= 30; w += 10) fns.push(() => new Layout(makeStyle({ width: w }, BASE_STYLE), hyph).layoutWords(['alpha', 'beta', 'gamma', 'delta', 'epsilon']).length);
  console.log('closures', fns.map((f) => f()).join(' '), 'layouts', Layout.layouts > 5);
  const tpl = String.raw`\n is not a newline, ${1 + 1} is two`;
  console.log(tpl, tpl.length);
  const obj = { a: 1, get b() { this.a++; return this.a; } };
  const { b, a = 0, ...rest } = obj;
  console.log('getter side effect', a, b, JSON.stringify(rest), void 'x', typeof undefined, delete obj.a, 'a' in obj);
}

async function mainAsync() {
  console.log('== async ==');
  const hyph = new Hyphenator(PATTERNS, EXCEPTIONS);
  const lay = new Layout(makeStyle({ width: 28, align: 'left' }, BASE_STYLE), hyph);
  const { chunks, lines } = await streamLayout(new TextStream(SAMPLE.fox, 17), lay);
  console.log('stream chunks', chunks.join(','), 'lines', lines.length);
  lines.forEach((l) => console.log('  > ' + l));
  const jobs = Object.entries(SAMPLE).map(async ([key, text], i) => {
    for (let t = 0; t < 4 - i; t++) await null;
    const ls = [...new Layout(makeStyle({ width: 50 }, BASE_STYLE), hyph).layoutText(text)];
    return [key, ls.length, fnv64(ls).slice(0, 8)];
  });
  const first = await Promise.race(jobs);
  const all = await Promise.all(jobs);
  const settled = await Promise.allSettled([Promise.reject(new SyntaxError('nope')), ...jobs.slice(0, 1)]);
  const any = await Promise.any([Promise.reject(new Error('a')), jobs[3]]);
  console.log('race', first.join(':'), 'any', any[0]);
  all.forEach(([k, n, h]) => console.log(`  ${k.padEnd(8)} ${n} ${h}`));
  console.log('settled', settled.map(({ status, reason }) => status + (reason ? ':' + reason.name : '')).join(' '));
}

main();
mainAsync().then(() => console.log('done'), (e) => console.log('async error', e.message));
