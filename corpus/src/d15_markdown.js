// d15: Markdown-to-HTML converter: block parser (nested lists, blockquotes,
// fences, tables, setext/ATX headings, ref defs, footnotes), inline parser with
// delimiter-stack emphasis, generator-based renderers, AST JSON round trip.

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
function html(strings, ...vals) {
  let outS = strings[0];
  vals.forEach((v, i) => {
    const piece = v instanceof Raw ? v.s
      : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : escapeHtml(x))).join('')
      : escapeHtml(v ?? '');
    outS += piece + strings[i + 1];
  });
  return new Raw(outS);
}
const normLabel = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------- AST ----------------
class Node {
  static #count = 0;
  #id;
  constructor(kind) {
    if (new.target === Node) throw new TypeError('Node is abstract');
    this.kind = kind;
    this.#id = ++Node.#count;
  }
  get id() { return this.#id; }
  static get created() { return Node.#count; }
  *walk(depth = 0) { yield [this, depth]; }
  get [Symbol.toStringTag]() { return 'md:' + this.kind; }
  static isNode(o) { return typeof o === 'object' && o !== null && #id in o; }
}
class Leaf extends Node {
  constructor(kind, text = '') { super(kind); this.text = text; }
}
class Container extends Node {
  children = [];
  append(...nodes) { this.children.push(...nodes.filter(Boolean)); return this; }
  *walk(depth = 0) {
    yield* super.walk(depth);
    for (const c of this.children) yield* c.walk(depth + 1);
  }
  *[Symbol.iterator]() { yield* this.children; }
}
class Document extends Container {
  constructor() { super('document'); this.refs = new Map(); this.footnotes = new Map(); }
}
class BlockQuote extends Container { constructor() { super('blockquote'); } }
class List extends Container {
  #loose = false;
  constructor(ordered, start) { super('list'); this.ordered = ordered; this.start = start; }
  get loose() { return this.#loose; }
  set loose(v) { this.#loose ||= !!v; }
}
class ListItem extends Container {
  constructor() { super('item'); this.task = null; }
}
class Heading extends Container {
  constructor(level, raw) { super('heading'); this.level = level; this.raw = raw; }
}
class Paragraph extends Container {
  constructor(raw) { super('paragraph'); this.raw = raw; }
}
class TableNode extends Container {
  constructor(aligns) { super('table'); this.aligns = aligns; this.head = []; this.rows = []; }
  *walk(depth = 0) {
    yield [this, depth];
    for (const row of [this.head, ...this.rows]) for (const cell of row) yield* cell.walk(depth + 1);
  }
}
class Cell extends Container {
  constructor(raw) { super('cell'); this.raw = raw; }
}
class CodeBlock extends Leaf {
  constructor(text, info = '') { super('code', text); this.info = info; }
}
class Rule extends Leaf { constructor() { super('rule'); } }
class Text extends Leaf { constructor(t) { super('text', t); } }
class CodeSpan extends Leaf { constructor(t) { super('codespan', t); } }
class Break extends Leaf { constructor() { super('break'); } }
class FootRef extends Leaf { constructor(id) { super('footref', id); } }
class Emph extends Container { constructor() { super('emph'); } }
class Strong extends Container { constructor() { super('strong'); } }
class Strike extends Container { constructor() { super('strike'); } }
class Link extends Container {
  constructor(href, title) { super('link'); this.href = href; this.title = title; }
}
class Image extends Leaf {
  constructor(src, title, alt) { super('image', alt); this.src = src; this.title = title; }
}

// ---------------- block parser ----------------
const RE = {
  blank: /^[ \t]*$/,
  fence: /^(?<ind> {0,3})(?<fence>`{3,}|~{3,})[ \t]*(?<info>[^`\s]*)[^`]*$/,
  atx: /^ {0,3}(?<hashes>#{1,6})(?:[ \t]+(?<text>.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  quote: /^ {0,3}> ?/,
  item: /^(?<ind> {0,3})(?<marker>[-+*]|(?<num>\d{1,9})(?<delim>[.)]))(?<sp>[ \t]+|$)(?<rest>.*)$/,
  indented: /^(?: {4}|\t)/,
  refdef: /^ {0,3}\[(?<label>[^\]^][^\]]*)\]:[ \t]*<?(?<url>[^\s>]+)>?(?:[ \t]+(?:"(?<t1>[^"]*)"|'(?<t2>[^']*)'))?[ \t]*$/,
  footdef: /^\[\^(?<id>[^\]]+)\]:[ \t]*(?<text>.*)$/,
  setext: /^ {0,3}(?<ch>=+|-+)[ \t]*$/,
  tableDelim: /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/,
};
const startsBlock = (ln) => RE.fence.test(ln) || RE.atx.test(ln) || RE.hr.test(ln) || RE.quote.test(ln) || RE.item.test(ln);
const splitRow = (ln) => ln.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const alignOf = (c) => (c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null);

class BlockParser {
  #doc; #maxDepth = 0;
  constructor(doc) { this.#doc = doc; }
  get maxDepth() { return this.#maxDepth; }
  parseBlocks(lines, depth = 0) {
    this.#maxDepth = Math.max(this.#maxDepth, depth);
    const outB = [];
    let i = 0;
    blocks: while (i < lines.length) {
      const line = lines[i];
      if (RE.blank.test(line)) { i++; continue; }
      let m;
      if ((m = RE.fence.exec(line))) {
        const { fence, info, ind } = m.groups;
        const body = [];
        i++;
        while (i < lines.length) {
          const close = new RegExp('^ {0,3}' + fence[0].replace('`', '\\`') + '{' + fence.length + ',}[ \\t]*$');
          if (close.test(lines[i])) { i++; break; }
          body.push(lines[i].replace(new RegExp('^ {0,' + ind.length + '}'), ''));
          i++;
        }
        outB.push(new CodeBlock(body.join('\n'), info));
        continue blocks;
      }
      if ((m = RE.atx.exec(line))) {
        outB.push(new Heading(m.groups.hashes.length, m.groups.text ?? ''));
        i++;
        continue;
      }
      if (RE.hr.test(line)) { outB.push(new Rule()); i++; continue; }
      if (RE.quote.test(line)) {
        const inner = [];
        for (let lazyOk = false; i < lines.length; i++) {
          const q = RE.quote.exec(lines[i]);
          if (q) { inner.push(lines[i].slice(q[0].length)); lazyOk = !RE.blank.test(inner[inner.length - 1]); continue; }
          if (lazyOk && !RE.blank.test(lines[i]) && !startsBlock(lines[i])) { inner.push(lines[i]); continue; }
          break;
        }
        const bq = new BlockQuote();
        bq.append(...this.parseBlocks(inner, depth + 1));
        outB.push(bq);
        continue;
      }
      if ((m = RE.item.exec(line))) {
        const [list, next] = this.#parseList(lines, i, m, depth);
        outB.push(list);
        i = next;
        continue;
      }
      if (RE.indented.test(line)) {
        const body = [];
        while (i < lines.length && (RE.indented.test(lines[i]) || RE.blank.test(lines[i]))) {
          body.push(lines[i].replace(/^(?: {4}|\t)/, ''));
          i++;
        }
        while (body.length && RE.blank.test(body[body.length - 1])) body.pop();
        outB.push(new CodeBlock(body.join('\n')));
        continue;
      }
      if ((m = RE.refdef.exec(line))) {
        const { label, url, t1, t2 } = m.groups;
        const key = normLabel(label);
        if (!this.#doc.refs.has(key)) this.#doc.refs.set(key, { url, title: t1 ?? t2 ?? null });
        i++;
        continue;
      }
      if ((m = RE.footdef.exec(line))) {
        this.#doc.footnotes.set(m.groups.id, m.groups.text);
        i++;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1])) {
        const head = splitRow(line), delims = splitRow(lines[i + 1]);
        if (head.length === delims.length) {
          const t = new TableNode(delims.map(alignOf));
          t.head = head.map((c) => new Cell(c));
          i += 2;
          while (i < lines.length && lines[i].includes('|') && !RE.blank.test(lines[i])) {
            const cells = splitRow(lines[i]);
            t.rows.push(head.map((_, k) => new Cell(cells[k] ?? '')));
            i++;
          }
          outB.push(t);
          continue;
        }
      }
      // paragraph (with setext detection)
      const para = [line.trim()];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        const st = RE.setext.exec(ln);
        if (st) {
          outB.push(new Heading(st.groups.ch[0] === '=' ? 1 : 2, para.join('\n')));
          i++;
          continue blocks;
        }
        if (RE.blank.test(ln) || startsBlock(ln)) break;
        para.push(ln.replace(/^[ \t]+/, ''));
        i++;
      }
      outB.push(new Paragraph(para.join('\n')));
    }
    return outB;
  }
  #parseList(lines, i, first, depth) {
    const ordered = first.groups.num !== undefined;
    const key = ordered ? first.groups.delim : first.groups.marker;
    const list = new List(ordered, ordered ? parseInt(first.groups.num, 10) : 1);
    items: while (i < lines.length) {
      const m = RE.item.exec(lines[i]);
      if (!m || RE.hr.test(lines[i])) break;
      if ((m.groups.num !== undefined) !== ordered || (ordered ? m.groups.delim : m.groups.marker) !== key) break;
      const spLen = m.groups.sp.length;
      const contentCol = m.groups.ind.length + m.groups.marker.length + (spLen >= 5 || spLen === 0 ? 1 : spLen);
      const body = [spLen >= 5 ? m.groups.sp.slice(1) + m.groups.rest : m.groups.rest];
      i++;
      let blankRun = 0;
      collect: for (; i < lines.length; i++) {
        const ln = lines[i];
        if (RE.blank.test(ln)) { blankRun++; body.push(''); continue collect; }
        const indent = /^ */.exec(ln)[0].length;
        if (indent >= contentCol) { body.push(ln.slice(contentCol)); blankRun = 0; continue; }
        if (blankRun === 0 && !startsBlock(ln) && !RE.blank.test(body[body.length - 1])) { body.push(ln.trimStart()); continue; }
        break collect;
      }
      let trailing = 0;
      while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
      const item = new ListItem();
      const task = /^\[(?<mark>[ xX])\][ \t]+/.exec(body[0]);
      if (task) { item.task = task.groups.mark !== ' '; body[0] = body[0].slice(task[0].length); }
      const inner = this.parseBlocks(body, depth + 1);
      item.append(...inner);
      if (inner.length > 1 && body.includes('')) list.loose = true;
      list.append(item);
      if (trailing > 0) {
        const nx = i < lines.length ? RE.item.exec(lines[i]) : null;
        if (nx && (nx.groups.num !== undefined) === ordered && (ordered ? nx.groups.delim : nx.groups.marker) === key) list.loose = true;
        else break items;
      }
    }
    return [list, i];
  }
}

// ---------------- inline parser ----------------
function matchAt(re, s, pos) {
  re.lastIndex = pos;
  return re.exec(s);
}
function findClose(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') { k++; continue; }
    if (c === '`') {
      const run = matchAt(/`+/y, src, k)[0];
      const end = src.indexOf(run, k + run.length);
      if (end > 0) { k = end + run.length - 1; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return k;
  }
  return -1;
}
const isWs = (c) => /\s/.test(c);
const isAlnum = (c) => /[A-Za-z0-9]/.test(c);
const isPunct = (c) => /[!-\/:-@\[-`{-~]/.test(c);

class InlineParser {
  #refs; #notes; stats = { links: 0, delims: 0, unresolved: 0 };
  constructor(doc) { this.#refs = doc.refs; this.#notes = doc.footnotes; }
  parse(src) {
    const items = [];
    let pos = 0, buf = '';
    const flush = () => { if (buf) { items.push(new Text(buf)); buf = ''; } };
    scan: while (pos < src.length) {
      const ch = src[pos];
      switch (ch) {
        case '\\': {
          const nx = src[pos + 1];
          if (nx === '\n') { flush(); items.push(new Break()); pos += 2; continue scan; }
          if (nx !== undefined && isPunct(nx)) { buf += nx; pos += 2; continue scan; }
          buf += ch; pos++;
          continue scan;
        }
        case '`': {
          const m = matchAt(/(?<ticks>`+)(?<body>[\s\S]*?[^`])\k<ticks>(?!`)/y, src, pos);
          if (m) {
            flush();
            items.push(new CodeSpan(m.groups.body.replace(/\n/g, ' ').replace(/^ (.+) $/, '$1')));
            pos += m[0].length;
            continue scan;
          }
          const run = matchAt(/`+/y, src, pos)[0];
          buf += run; pos += run.length;
          continue scan;
        }
        case '<': {
          const m = matchAt(/<(?<url>[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y, src, pos) ?? matchAt(/<(?<email>[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/y, src, pos);
          if (m) {
            flush();
            const link = new Link(m.groups.url ?? 'mailto:' + m.groups.email, null);
            link.append(new Text(m.groups.url ?? m.groups.email));
            items.push(link);
            pos += m[0].length;
            this.stats.links++;
            continue scan;
          }
          buf += ch; pos++;
          continue scan;
        }
        case '!':
          if (src[pos + 1] !== '[') { buf += ch; pos++; continue scan; }
        // fallthrough
        case '[': {
          const isImage = ch === '!';
          const start = isImage ? pos + 1 : pos;
          if (!isImage) {
            const fn = matchAt(/\[\^(?<id>[^\]\s]+)\]/y, src, pos);
            if (fn && this.#notes.has(fn.groups.id)) { flush(); items.push(new FootRef(fn.groups.id)); pos += fn[0].length; continue scan; }
          }
          const close = findClose(src, start);
          if (close < 0) { buf += src.slice(pos, start + 1); pos = start + 1; continue scan; }
          const inner = src.slice(start + 1, close);
          let after = close + 1, dest = null, title = null;
          const inl = matchAt(/\(\s*(?<dest><[^>]*>|[^\s()]+)?(?:\s+(?<q>"[^"]*"|'[^']*'))?\s*\)/y, src, after);
          if (inl) {
            dest = (inl.groups.dest ?? '').replace(/^<|>$/g, '');
            title = inl.groups.q?.slice(1, -1) ?? null;
            after += inl[0].length;
          } else {
            const ref = matchAt(/\[(?<label>[^\]]*)\]/y, src, after);
            const def = this.#refs.get(normLabel(ref?.groups.label || inner));
            if (def) { ({ url: dest, title } = def); if (ref) after += ref[0].length; }
          }
          if (dest === null) { this.stats.unresolved++; buf += src.slice(pos, start + 1); pos = start + 1; continue scan; }
          flush();
          this.stats.links++;
          if (isImage) items.push(new Image(dest, title, plainText(this.parse(inner))));
          else items.push(new Link(dest, title).append(...this.parse(inner)));
          pos = after;
          continue scan;
        }
        case '*': case '_': case '~': {
          const run = matchAt(/\*+|_+|~+/y, src, pos)[0];
          if (ch === '~' && run.length !== 2) { buf += run; pos += run.length; continue scan; }
          const before = pos === 0 ? ' ' : src[pos - 1];
          const afterC = src[pos + run.length] ?? ' ';
          let canOpen = !isWs(afterC), canClose = !isWs(before);
          if (ch === '_') { canOpen &&= !isAlnum(before); canClose &&= !isAlnum(afterC); }
          flush();
          items.push({ delim: true, ch, count: ch === '~' ? 1 : run.length, canOpen, canClose });
          this.stats.delims++;
          pos += run.length;
          continue scan;
        }
        case '\n':
          if (buf.endsWith('  ')) { buf = buf.replace(/ +$/, ''); flush(); items.push(new Break()); }
          else buf = buf.replace(/ +$/, '') + '\n';
          pos++;
          continue scan;
        default:
          buf += ch;
          pos++;
      }
    }
    flush();
    return this.#resolve(items);
  }
  #resolve(items) {
    const fin = (it) => (it && it.delim ? new Text(it.ch.repeat(it.ch === '~' ? 2 * it.count : it.count)) : it);
    let i = 0;
    outer: while (i < items.length) {
      const closer = items[i];
      if (!closer?.delim || !closer.canClose) { i++; continue; }
      for (let j = i - 1; j >= 0; j--) {
        const opener = items[j];
        if (!opener?.delim || opener.ch !== closer.ch || !opener.canOpen) continue;
        const use = closer.ch === '~' ? 1 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
        const wrapped = closer.ch === '~' ? new Strike() : use === 2 ? new Strong() : new Emph();
        wrapped.append(...items.slice(j + 1, i).map(fin));
        opener.count -= use;
        closer.count -= use;
        const repl = [...(opener.count > 0 ? [opener] : []), wrapped, ...(closer.count > 0 ? [closer] : [])];
        items.splice(j, i - j + 1, ...repl);
        i = j + repl.indexOf(wrapped) + 1;
        continue outer;
      }
      i++;
    }
    return items.map(fin);
  }
}

function plainText(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n instanceof Container) s += plainText(n.children);
    else if (n.kind === 'break') s += ' ';
    else s += n.text ?? '';
  }
  return s;
}

function parseMarkdown(src) {
  const doc = new Document();
  const bp = new BlockParser(doc);
  doc.append(...bp.parseBlocks(src.replace(/\r\n?/g, '\n').split('\n')));
  const ip = new InlineParser(doc);
  const targets = [];
  for (const [node] of doc.walk()) {
    if (node instanceof Paragraph || node instanceof Heading || node instanceof Cell) targets.push(node);
  }
  for (const t of targets) t.append(...ip.parse(t.raw));
  doc.maxDepth = bp.maxDepth;
  doc.inlineStats = ip.stats;
  return doc;
}

// ---------------- renderers ----------------
class Renderer {
  constructor() {
    if (new.target === Renderer) throw new TypeError('Renderer is abstract');
    this.depth = 0;
    this.maxDepth = 0;
  }
  *render(node) {
    const fn = this[node.kind];
    if (typeof fn !== 'function') throw new Error('no renderer for ' + node.kind);
    this.depth++;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    try {
      yield* fn.call(this, node);
    } finally {
      this.depth--;
    }
  }
  *children(node) { for (const c of node.children) yield* this.render(c); }
  renderToString(node) { return [...this.render(node)].join(''); }
}

class HtmlRenderer extends Renderer {
  tight = false;
  notes = [];
  *document(n) {
    this.doc = n;
    yield* this.children(n);
    if (this.notes.length) {
      yield '<section class="footnotes">\n<ol>\n';
      for (const [k, id] of this.notes.entries()) {
        yield html`<li id="fn-${id}">`.s;
        yield* new InlineParser(n).parse(n.footnotes.get(id)).flatMap((c) => [...this.render(c)]);
        yield html` <a href="#fnref-${id}">&#8617;${k > 8 ? '' : ''}</a></li>\n`.s;
      }
      yield '</ol>\n</section>\n';
    }
  }
  *heading(n, id = null) {
    const attr = id ? html` id="${id}"` : '';
    yield `<h${n.level}${attr}>`;
    yield* this.children(n);
    yield `</h${n.level}>\n`;
  }
  *paragraph(n) {
    if (this.tight) { yield* this.children(n); return; }
    yield '<p>';
    yield* this.children(n);
    yield '</p>\n';
  }
  *blockquote(n) {
    const prev = this.tight;
    this.tight = false;
    try {
      yield '<blockquote>\n';
      yield* this.children(n);
      yield '</blockquote>\n';
    } finally {
      this.tight = prev;
    }
  }
  *list(n) {
    const tag = n.ordered ? 'ol' : 'ul';
    const prev = this.tight;
    this.tight = !n.loose;
    yield n.ordered && n.start !== 1 ? `<${tag} start="${n.start}">\n` : `<${tag}>\n`;
    for (const item of n) yield* this.render(item);
    this.tight = prev;
    yield `</${tag}>\n`;
  }
  *item(n) {
    const box = n.task === null ? '' : `<input type="checkbox" disabled${n.task ? ' checked' : ''}> `;
    const parts = n.children.map((c) => this.renderToString(c));
    if (this.tight) yield `<li>${box}${parts.map((p) => p.replace(/\n$/, '')).join('\n')}</li>\n`;
    else yield `<li>\n${box}${parts.join('')}</li>\n`;
  }
  *code(n) {
    const cls = n.info ? html` class="language-${n.info}"` : '';
    yield html`<pre><code${cls}>${n.text}${n.text ? '\n' : ''}</code></pre>\n`.s;
  }
  *rule() { yield '<hr />\n'; }
  *table(n) {
    const al = (k) => (n.aligns[k] ? ` style="text-align:${n.aligns[k]}"` : '');
    yield '<table>\n<thead>\n<tr>\n';
    for (const [k, c] of n.head.entries()) yield `<th${al(k)}>${this.renderToString(c)}</th>\n`;
    yield '</tr>\n</thead>\n';
    if (n.rows.length) {
      yield '<tbody>\n';
      for (const row of n.rows) {
        yield '<tr>\n';
        for (let k = 0; k < row.length; k++) yield `<td${al(k)}>${this.renderToString(row[k])}</td>\n`;
        yield '</tr>\n';
      }
      yield '</tbody>\n';
    }
    yield '</table>\n';
  }
  *cell(n) { yield* this.children(n); }
  *text(n) { yield escapeHtml(n.text); }
  *codespan(n) { yield html`<code>${n.text}</code>`.s; }
  *break() { yield '<br />\n'; }
  *emph(n) { yield '<em>'; yield* this.children(n); yield '</em>'; }
  *strong(n) { yield '<strong>'; yield* this.children(n); yield '</strong>'; }
  *strike(n) { yield '<del>'; yield* this.children(n); yield '</del>'; }
  *link(n) {
    yield html`<a href="${n.href}"${n.title !== null ? html` title="${n.title}"` : ''}>`.s;
    yield* this.children(n);
    yield '</a>';
  }
  *image(n) { yield html`<img src="${n.src}" alt="${n.text}"${n.title ? html` title="${n.title}"` : ''} />`.s; }
  *footref(n) {
    if (!this.notes.includes(n.text)) this.notes.push(n.text);
    const k = this.notes.indexOf(n.text) + 1;
    yield html`<sup id="fnref-${n.text}"><a href="#fn-${n.text}">${k}</a></sup>`.s;
  }
}

class SlugHtmlRenderer extends HtmlRenderer {
  #seen = new Map();
  toc = [];
  static slugify(s) { return s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'section'; }
  *heading(n) {
    const base = SlugHtmlRenderer.slugify(plainText(n.children));
    const count = this.#seen.get(base) ?? 0;
    this.#seen.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    this.toc.push({ level: n.level, id });
    yield* super.heading(n, id);
  }
}

class TextRenderer extends Renderer {
  *document(n) { for (const c of n) { yield* this.render(c); yield '\n'; } }
  *heading(n) { yield '#'.repeat(n.level) + ' '; yield* this.children(n); }
  *paragraph(n) { yield* this.children(n); }
  *blockquote(n) { for (const c of n) { yield '> '; yield* this.render(c); } }
  *list(n) { let k = n.start; for (const it of n) { yield (n.ordered ? `${k++}. ` : '* '); yield* this.render(it); yield ';'; } }
  *item(n) { if (n.task !== null) yield n.task ? '[x] ' : '[ ] '; yield* this.children(n); }
  *code(n) { yield `<${n.text.split('\n').length} lines>`; }
  *rule() { yield '----'; }
  *table(n) { yield `[table ${n.head.length}x${n.rows.length}]`; }
  *text(n) { yield n.text.replace(/\n/g, ' '); }
  *codespan(n) { yield n.text; }
  *break() { yield ' / '; }
  *emph(n) { yield* this.children(n); }
  *footref(n) { yield `[${n.text}]`; }
  *image(n) { yield `{img:${n.text}}`; }
}
Object.assign(TextRenderer.prototype, { strong: TextRenderer.prototype.emph, strike: TextRenderer.prototype.emph, link: TextRenderer.prototype.emph });

function toHtml(src, R = HtmlRenderer) {
  const doc = parseMarkdown(src);
  const r = new R();
  return { html: r.renderToString(doc), doc, r };
}

// ---------------- AST JSON round trip ----------------
function astToJson(doc) {
  return JSON.stringify(doc, function (key, value) {
    if (value instanceof Map) return { $map: [...value] };
    if (key === 'maxDepth' || key === 'inlineStats') return undefined;
    return value;
  });
}
const CTORS = {
  document: () => new Document(), blockquote: () => new BlockQuote(), list: (o) => { const l = new List(o.ordered, o.start); return l; },
  item: () => new ListItem(), heading: (o) => new Heading(o.level, o.raw), paragraph: (o) => new Paragraph(o.raw),
  table: (o) => new TableNode(o.aligns), cell: (o) => new Cell(o.raw), code: (o) => new CodeBlock(o.text, o.info),
  rule: () => new Rule(), text: (o) => new Text(o.text), codespan: (o) => new CodeSpan(o.text), break: () => new Break(),
  footref: (o) => new FootRef(o.text), emph: () => new Emph(), strong: () => new Strong(), strike: () => new Strike(),
  link: (o) => new Link(o.href, o.title), image: (o) => new Image(o.src, o.title, o.text),
};
function jsonToAst(text, looseLists) {
  let listIdx = 0;
  return JSON.parse(text, (key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$map' in value) return new Map(value.$map);
      const make = CTORS[value.kind];
      if (make) {
        const n = make(value);
        if (n instanceof Container) n.append(...(value.children ?? []));
        if (n instanceof List) n.loose = looseLists[listIdx++];
        for (const k of ['task', 'head', 'rows', 'refs', 'footnotes']) if (k in value) n[k] = value[k];
        return n;
      }
    }
    return value;
  });
}

// ---------------- sample documents ----------------
const FENCE = '`'.repeat(3);
const DOCS = {
  basics: [
    'Title Here', '==========', '',
    'Some *emphasis*, **strong**, ***both***, and ~~struck~~ text with `code` and a',
    'second line with trailing spaces  ', 'forced break. Escaped \\*stars\\* and snake_case_word.', '',
    '## Links & <Images> ##', '',
    'Inline [link](http://example.com "Example") and [ref link][ex] and [Ex] shortcut,',
    'an ![alt *text*](/img.png "pic") and <https://auto.link/x?a=1&b=2> or <me@example.org>.',
    'Broken [link] stays, and [nested [brackets]](/n) work.', '',
    '[ex]: http://example.com/ref  "Ref Title"', '',
    '---', '',
    'Sub heading', '-----------',
    'Footnote here[^1] and again[^1], plus another[^two].', '',
    '[^1]: First *note*.', '[^two]: Second note with `code`.',
  ].join('\n'),
  lists: [
    '- alpha', '- beta', '  - beta.one', '  - beta.two', '    1. deep one', '    2. deep two', '- gamma', '',
    '3. three', '4. four', '', '   continued para in four', '5) other delimiter', '',
    '* [ ] todo item', '* [x] done item', '* plain', '',
    '+ loose one', '', '+ loose two', '  > quoted inside item', '  > still quoted', '',
    '- a', 'lazy continuation', '- b', '---', '- after rule',
  ].join('\n'),
  blocks: [
    '> # Quote heading', '> quote para with *em*', 'lazy line', '>', '> > nested quote', '> > > deeper', '',
    FENCE + 'js title', 'function f(a) {', '  return a < 1 && "x";', '}', FENCE, '',
    '~~~~', 'tilde fence ``` inside', '~~~~', '',
    '    indented code', '    <tag> & more', '', '        extra indent', '',
    'Para then', '# heading interrupts', 'text', '***', '___',
  ].join('\n'),
  tables: [
    '| Name | Qty | Price | Note |', '|:-----|:---:|------:|------|',
    '| apple | 3 | 1.20 | *fresh* |', '| pear | 10 | 0.5 | a \\| pipe |', '| `kiwi` | 1 |', '',
    'a | b', '--- | ---', 'no | outer', 'pipes | here', '',
    'Not | a table', 'just text',
  ].join('\n'),
  tricky: [
    '*unclosed emphasis and **strong*', '_not_emphasis_inside_word_ but _this_ is.', '**a *b* c** d*e*f',
    '``code with ` tick`` and `` `edge` ``', '[![img](/a.png)](/target) [empty]()', '<not a link> & "quotes"',
    '*   spaced bullet', '10. ten', '11. eleven',
    '#no heading', '####### seven hashes', '# closed #####', '#',
  ].join('\n'),
};

function printHtml(label, text) {
  const lines = text.replace(/\n$/, '').split('\n');
  console.log(`--- ${label} (${lines.length} lines) ---`);
  for (const l of lines) console.log('| ' + l);
}

function sectionRender() {
  console.log('== render ==');
  for (const key of Object.keys(DOCS)) {
    const R = key === 'basics' || key === 'blocks' ? SlugHtmlRenderer : HtmlRenderer;
    const { html: h, doc, r } = toHtml(DOCS[key], R);
    printHtml(key, h);
    console.log(`meta ${key}: blocks=${doc.children.length} refs=${JSON.stringify([...doc.refs.keys()])} notes=${doc.footnotes.size} stats=${JSON.stringify(doc.inlineStats)} parseDepth=${doc.maxDepth} renderDepth=${r.maxDepth}`);
    if (r.toc) console.log('toc ' + r.toc.map(({ level, id }) => '  '.repeat(level - 1) + id).join(' | '));
  }
}

function sectionAnalysis() {
  console.log('== analysis ==');
  const doc = parseMarkdown(DOCS.lists);
  const counts = new Proxy({}, { get: (t, k) => (typeof k === 'string' && !(k in t) ? 0 : Reflect.get(t, k)) });
  let deepest = 0;
  for (const [node, depth] of doc.walk()) {
    counts[node.kind] = counts[node.kind] + 1;
    if (depth > deepest) deepest = depth;
  }
  console.log('kinds ' + JSON.stringify(counts) + ' deepest=' + deepest + ' missing=' + counts.nonexistent);
  const lists = [...doc.walk()].filter(([n]) => n instanceof List).map(([n, d]) => `${n.ordered ? 'ol' : 'ul'}@${d}:${n.children.length}${n.loose ? 'L' : 'T'}${n.start !== 1 ? '#' + n.start : ''}`);
  console.log('lists ' + lists.join(' '));
  const tr = new TextRenderer();
  for (const key of ['basics', 'lists', 'tricky']) console.log(`text ${key}: ${tr.renderToString(parseMarkdown(DOCS[key])).replace(/\n/g, ' ~ ')}`);
  const tag = Object.prototype.toString.call(doc.children[0]);
  console.log(`tag=${tag} isNode=${Node.isNode(doc)},${Node.isNode({ kind: 'x' })} created>0=${Node.created > 0}`);
  try { new Node('x'); } catch (e) { console.log('abstract: ' + e.message); }
  try { new Renderer(); } catch (e) { console.log('abstract: ' + e.message); }
  const bogus = new Document();
  bogus.append(Object.assign(new Paragraph('x'), { kind: 'mystery' }));
  try { new HtmlRenderer().renderToString(bogus); } catch ({ message }) { console.log('render error: ' + message); }
  const lst = new List(false, 1);
  lst.loose = true; lst.loose = false;
  console.log('loose sticky ' + lst.loose);
}

function sectionRoundTrip() {
  console.log('== json round trip ==');
  for (const key of ['basics', 'lists', 'tables']) {
    const doc = parseMarkdown(DOCS[key]);
    const text = astToJson(doc);
    const loose = [...doc.walk()].filter(([n]) => n instanceof List).map(([n]) => n.loose);
    const back = jsonToAst(text, loose);
    const a = new HtmlRenderer().renderToString(doc);
    const b = new HtmlRenderer().renderToString(back);
    console.log(`${key}: json=${text.length} chars same=${a === b} backIsDoc=${back instanceof Document} refs=${back.refs instanceof Map ? back.refs.size : 'x'}`);
  }
  const small = astToJson(parseMarkdown('# Hi *there*\n\n- a\n- b'));
  console.log('small ' + small);
}

function quoteDepth(line) {
  const m = RE.quote.exec(line);
  return m ? 1 + quoteDepth(line.slice(m[0].length)) : 0;
}
function nestedOutline(n, k = 0) { return k === n ? '' : `<ul><li>${k}` + nestedOutline(n, k + 1) + '</li></ul>'; }
function isEvenLevel(n) { return n === 0 || isOddLevel(n - 1); }
function isOddLevel(n) { return n !== 0 && isEvenLevel(n - 1); }

function sectionDeep() {
  console.log('== deep ==');
  const line = '>'.repeat(3000) + ' bottom';
  console.log('quoteDepth ' + quoteDepth(line) + ' even=' + isEvenLevel(3000) + ' odd=' + isOddLevel(2999));
  const outline = nestedOutline(3000);
  console.log('outline length ' + outline.length + ' tail ' + outline.slice(-22));
  const nested = Array.from({ length: 40 }, (_, k) => '>'.repeat(k + 1) + ' level ' + k).join('\n');
  const { html: h, doc } = toHtml(nested);
  console.log(`nested quotes parseDepth=${doc.maxDepth} bq=${(h.match(/<blockquote>/g) || []).length} last=${JSON.stringify(h.slice(h.lastIndexOf('<p>'), h.lastIndexOf('<p>') + 18))}`);
  let md = '';
  for (let k = 0; k < 12; k++) md += '  '.repeat(k) + '- item ' + k + '\n';
  const lh = toHtml(md).html;
  console.log('nested list ul=' + (lh.match(/<ul>/g) || []).length + ' li=' + (lh.match(/<li>/g) || []).length);
}

function sectionMisc() {
  console.log('== misc ==');
  const closures = [];
  for (const [i, key] of Object.keys(DOCS).entries()) closures.push(() => `${i}:${key}:${DOCS[key].length}`);
  const byKey = {};
  for (const k in DOCS) byKey[k] = () => DOCS[k].split('\n').length;
  console.log('closures ' + closures.map((f) => f()).join(' ') + ' | ' + Object.keys(byKey).map((k) => k + '=' + byKey[k]()).join(','));
  const esc = { base() { return 'b'; }, run(s) { return escapeHtml(s); } };
  const loud = {
    run(s) { return super.run(s).toUpperCase(); },
    base() { return 'loud>' + super.base(); },
  };
  Object.setPrototypeOf(loud, esc);
  console.log('super literal ' + loud.run('<a & b>') + ' ' + loud.base());
  const opts = { gfm: undefined, sanitize: 0, title: 'x' };
  opts.gfm ??= true;
  opts.sanitize ||= 'strict';
  opts.title &&= opts.title.repeat(3);
  console.log('opts ' + JSON.stringify(opts) + ' ' + (opts.plugins?.length ?? 'none') + ' ' + (opts.hook?.() ?? 'nohook'));
  const tpl = html`<p title="${'a"b'}">${[new Raw('<b>'), 'x<y', new Raw('</b>')]}</p>`;
  console.log('html tag ' + tpl + ' ' + (tpl instanceof Raw));
  const words = 'The **quick** brown _fox_ jumps'.match(/(?<=\*\*)\w+(?=\*\*)|(?<=_)\w+(?=_)/g);
  console.log('lookaround ' + words.join(','));
  const sticky = /(?<word>\w+)\s*/y;
  const tokens = [];
  let m;
  while ((m = sticky.exec('alpha beta  gamma!delta'))) tokens.push(m.groups.word);
  console.log('sticky ' + tokens.join('|') + ' stoppedAt=' + sticky.lastIndex);
  let n = 0, seen = [];
  do {
    n++;
    if (n % 2) continue;
    seen.push(n);
  } while (n < 9);
  let cm = (n++, n * 2);
  console.log('dowhile ' + seen.join('') + ' comma ' + cm + ' void=' + (void 0 === undefined) + ' typeof=' + typeof Raw);
  const holder = {};
  Object.defineProperty(holder, 'html', { get() { return toHtml('*x*').html.trim(); }, enumerable: true });
  console.log('accessor ' + holder.html + ' keys=' + Object.keys(holder) + ' del=' + delete holder.html);
}

async function* streamHtml(src, chunk = 8) {
  const r = new HtmlRenderer();
  let batch = [];
  for (const piece of r.render(parseMarkdown(src))) {
    batch.push(piece);
    if (batch.length >= chunk) { await null; yield batch.join(''); batch = []; }
  }
  if (batch.length) yield batch.join('');
}

async function sectionAsync() {
  console.log('== async ==');
  const order = [];
  const results = await Promise.all(Object.keys(DOCS).map(async (key, i) => {
    order.push('start ' + key);
    let outS = '', chunks = 0;
    for await (const c of streamHtml(DOCS[key], 4 + i)) { outS += c; chunks++; }
    order.push('end ' + key);
    return { key, chunks, same: outS === toHtml(DOCS[key]).html };
  }));
  console.log('stream ' + JSON.stringify(results));
  console.log('order ' + order.join(', '));
  const broken = new Document();
  broken.append(new Paragraph('x'), Object.assign(new Rule(), { kind: 'weird' }));
  const settled = await Promise.allSettled([
    (async () => { let s = ''; for await (const c of streamHtml('ok *fine*')) s += c; return s.trim(); })(),
    (async () => { await null; return new HtmlRenderer().renderToString(broken); })(),
  ]);
  console.log('settled ' + settled.map((s) => s.status + ':' + (s.value ?? s.reason.message)).join(' | '));
  const first = await Promise.race([(async () => { await null; await null; return 'slow'; })(), (async () => { await null; return 'fast'; })()]);
  const micro = [];
  const pa = (async () => { micro.push('a1'); await null; micro.push('a2'); })();
  Promise.resolve().then(() => micro.push('t1')).then(() => micro.push('t2'));
  micro.push('sync');
  await pa;
  await null;
  console.log('race ' + first + ' micro ' + micro.join(','));
}

function main() {
  sectionRender();
  sectionAnalysis();
  sectionRoundTrip();
  sectionDeep();
  sectionMisc();
  return sectionAsync().then(() => console.log('== done ==')).catch((e) => console.log('FAILED ' + e.message));
}

main();
