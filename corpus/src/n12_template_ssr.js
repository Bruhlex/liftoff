'use strict';
// Template engine (lexer -> parser -> AST -> renderer) with layouts, blocks,
// partials, filters, escaping and a content-hash compile cache, served by an
// http server that the program queries itself.
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter, once } = require('events');
const { Readable, Transform } = require('stream');

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---------------------------------------------------------------- escaping
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]); }
class SafeString {
  #value;
  constructor(v) { this.#value = String(v); }
  toString() { return this.#value; }
  get length() { return this.#value.length; }
}

// ---------------------------------------------------------------- lexer
class TemplateSyntaxError extends Error {
  constructor(msg, name, line) { super(`${name}:${line}: ${msg}`); this.name = 'TemplateSyntaxError'; }
}

function* lex(src, name) {
  const re = /\{\{(\{)?(-)?\s*([\s\S]*?)\s*(-)?\}\}(\})?/g;
  let last = 0, m, line = 1, trimNext = false;
  while ((m = re.exec(src))) {
    let text = src.slice(last, m.index);
    if (trimNext) text = text.replace(/^\s+/, '');
    if (m[2]) text = text.replace(/\s+$/, '');
    if (text) yield { t: 'text', v: text, line };
    line += (src.slice(last, m.index).match(/\n/g) || []).length;
    const raw = !!m[1];
    if (raw !== !!m[5]) throw new TemplateSyntaxError('unbalanced triple mustache', name, line);
    const body = m[3];
    trimNext = !!m[4];
    const head = body[0];
    if (raw) yield { t: 'raw', v: body, line };
    else if (head === '!') { /* comment */ }
    else if (head === '#') { const [kw, ...rest] = body.slice(1).trim().split(/\s+/); yield { t: 'open', kw, arg: rest.join(' '), line }; }
    else if (head === '/') yield { t: 'close', kw: body.slice(1).trim(), line };
    else if (head === '>') yield { t: 'partial', v: body.slice(1).trim(), line };
    else if (body === 'else') yield { t: 'else', line };
    else yield { t: 'var', v: body, line };
    line += (m[0].match(/\n/g) || []).length;
    last = re.lastIndex;
  }
  let tail = src.slice(last);
  if (trimNext) tail = tail.replace(/^\s+/, '');
  if (tail) yield { t: 'text', v: tail, line };
}

// ---------------------------------------------------------------- parser
const BLOCK_KWS = new Set(['if', 'unless', 'each', 'with', 'block', 'extends']);

function parse(src, name) {
  const root = { type: 'root', children: [], extends: null, blocks: {} };
  const stack = [root];
  let target = root.children;
  for (const tok of lex(src, name)) {
    const top = stack[stack.length - 1];
    switch (tok.t) {
      case 'text': target.push({ type: 'text', v: tok.v }); break;
      case 'var': target.push({ type: 'var', expr: parseExpr(tok.v, name, tok.line), escape: true }); break;
      case 'raw': target.push({ type: 'var', expr: parseExpr(tok.v, name, tok.line), escape: false }); break;
      case 'partial': {
        const [pname, ...kv] = tok.v.split(/\s+/);
        const params = Object.fromEntries(kv.map((p) => p.split('=')).map(([k, v]) => [k, parseExpr(v, name, tok.line)]));
        target.push({ type: 'partial', name: pname.replace(/^"|"$/g, ''), params });
        break;
      }
      case 'open': {
        if (!BLOCK_KWS.has(tok.kw)) throw new TemplateSyntaxError('unknown block #' + tok.kw, name, tok.line);
        if (tok.kw === 'extends') { root.extends = tok.arg.replace(/^"|"$/g, ''); stack.push({ type: 'extends', kw: 'extends', children: [], line: tok.line }); target = stack[stack.length - 1].children; break; }
        const node = { type: tok.kw, kw: tok.kw, arg: tok.arg, expr: tok.kw === 'block' ? null : parseExpr(tok.arg, name, tok.line), children: [], alt: null, line: tok.line };
        if (tok.kw === 'block') root.blocks[tok.arg] = node;
        target.push(node);
        stack.push(node);
        target = node.children;
        break;
      }
      case 'else':
        if (!top.kw || top.kw === 'block' || top.kw === 'extends') throw new TemplateSyntaxError('else outside conditional', name, tok.line);
        top.alt = [];
        target = top.alt;
        break;
      case 'close': {
        if (top.kw !== tok.kw) throw new TemplateSyntaxError(`expected {{/${top.kw || 'EOF'}}} got {{/${tok.kw}}}`, name, tok.line);
        stack.pop();
        const parent = stack[stack.length - 1];
        target = parent.type === 'root' || parent.type === 'extends' ? parent.children : (parent.alt || parent.children);
        break;
      }
    }
  }
  if (stack.length > 1) throw new TemplateSyntaxError('unclosed {{#' + stack[stack.length - 1].kw + '}}', name, stack[stack.length - 1].line);
  return root;
}

// expression: path ( | filter(:arg)* )*   path: a.b.c | "literal" | number | this | @index
function parseExpr(src, name, line) {
  const parts = src.split('|').map((s) => s.trim());
  const head = parts.shift();
  if (!head) throw new TemplateSyntaxError('empty expression', name, line);
  const filters = parts.map((p) => {
    const [fname, ...args] = p.split(':');
    return { name: fname.trim(), args: args.map((a) => literalOrPath(a.trim())) };
  });
  return { value: literalOrPath(head), filters };
}
function literalOrPath(s) {
  if (/^"(.*)"$/.test(s)) return { lit: s.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { lit: Number(s) };
  if (s === 'true' || s === 'false') return { lit: s === 'true' };
  if (s === 'this') return { path: [] };
  const segs = [];
  while (s.startsWith('../')) { segs.push('..'); s = s.slice(3); }
  return { path: segs.concat(s.split('.')) };
}

// ---------------------------------------------------------------- filters
const FILTERS = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  title: (v) => String(v).replace(/\b\w/g, (c) => c.toUpperCase()),
  truncate: (v, n = 10) => { const s = String(v); return s.length > n ? s.slice(0, n - 1) + '…' : s; },
  default: (v, d) => (v === undefined || v === null || v === '' ? d : v),
  join: (v, sep = ', ') => (Array.isArray(v) ? v.join(sep) : v),
  length: (v) => (v?.length ?? 0),
  money: (v, cur = 'EUR') => { const cents = BigInt(Math.round(Number(v) * 100)); const s = (cents < 0n ? -cents : cents).toString().padStart(3, '0'); return `${cents < 0n ? '-' : ''}${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${s.slice(-2)} ${cur}`; },
  json: (v) => new SafeString(JSON.stringify(v)),
  safe: (v) => new SafeString(v),
  plural: (v, one, many) => `${v} ${v === 1 ? one : many}`,
  sortBy: (v, key) => [...v].sort((a, b) => cmpStr(String(a[key]), String(b[key]))),
  pad: (v, n) => String(v).padStart(n, '0'),
};

// ---------------------------------------------------------------- engine
class Frame {
  constructor(data, parent, locals = {}) { this.data = data; this.parent = parent; this.locals = locals; }
  lookup(p) {
    if (!p.length) return this.data;
    const [first, ...rest] = p;
    let f = this;
    let base;
    if (first.startsWith('@')) { while (f && !(first in f.locals)) f = f.parent; base = f?.locals[first]; }
    else if (first === '..') { return this.parent ? this.parent.lookup(rest) : undefined; }
    else { while (f && !(f.data !== null && typeof f.data === 'object' && first in f.data)) f = f.parent; base = f?.data[first]; }
    return rest.reduce((acc, k) => acc?.[k], base);
  }
}

class Engine extends EventEmitter {
  #loader;
  #cache = new Map();
  #stats = { compiles: 0, hits: 0, renders: 0 };
  static #MAX_DEPTH = 8;
  static { Engine.version = 'tmpl/' + [2, 1, 0].join('.'); }
  constructor(loader, { cacheSize = 6 } = {}) { super(); this.#loader = loader; this.cacheSize = cacheSize; }
  get stats() { return { ...this.#stats, cached: this.#cache.size }; }

  async compile(name) {
    const src = await this.#loader(name);
    const key = name + '@' + sha1(src).slice(0, 12);
    const hit = this.#cache.get(key);
    if (hit) {
      this.#stats.hits++;
      this.#cache.delete(key); this.#cache.set(key, hit); // LRU bump
      return hit;
    }
    for (const k of [...this.#cache.keys()]) if (k.startsWith(name + '@')) { this.#cache.delete(k); this.emit('invalidate', name); }
    const ast = parse(src, name);
    this.#stats.compiles++;
    this.#cache.set(key, ast);
    while (this.#cache.size > this.cacheSize) { const oldest = this.#cache.keys().next().value; this.#cache.delete(oldest); this.emit('evict', oldest.split('@')[0]); }
    return ast;
  }

  evalExpr(expr, frame) {
    let v = 'lit' in expr.value ? expr.value.lit : frame.lookup(expr.value.path);
    for (const f of expr.filters) {
      const fn = FILTERS[f.name];
      if (!fn) throw new Error('unknown filter ' + f.name);
      v = fn(v, ...f.args.map((a) => ('lit' in a ? a.lit : frame.lookup(a.path))));
    }
    return v;
  }

  async render(name, data) {
    this.#stats.renders++;
    let ast = await this.compile(name);
    const chain = [ast];
    let depth = 0;
    while (ast.extends) {
      if (++depth > Engine.#MAX_DEPTH) throw new Error('extends chain too deep at ' + name);
      ast = await this.compile(ast.extends);
      chain.push(ast);
    }
    // child blocks override parent blocks: resolve from most-derived first
    const blocks = {};
    for (const a of chain) for (const [k, v] of Object.entries(a.blocks)) if (!(k in blocks)) blocks[k] = v;
    const base = chain[chain.length - 1];
    const out = [];
    await this.#renderNodes(base.children, new Frame(data, null, { '@template': name }), out, blocks, 0);
    return out.join('');
  }

  async #renderNodes(nodes, frame, out, blocks, depth) {
    for (const n of nodes) {
      switch (n.type) {
        case 'text': out.push(n.v); break;
        case 'var': {
          const v = this.evalExpr(n.expr, frame);
          out.push(v instanceof SafeString || !n.escape ? String(v ?? '') : escapeHtml(v));
          break;
        }
        case 'if':
        case 'unless': {
          let v = this.evalExpr(n.expr, frame);
          if (Array.isArray(v)) v = v.length > 0;
          const truthy = n.type === 'if' ? !!v : !v;
          await this.#renderNodes(truthy ? n.children : n.alt || [], frame, out, blocks, depth);
          break;
        }
        case 'each': {
          const v = this.evalExpr(n.expr, frame);
          const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : v && typeof v === 'object' ? Object.entries(v) : [];
          if (!entries.length) { await this.#renderNodes(n.alt || [], frame, out, blocks, depth); break; }
          for (const [i, [k, item]] of entries.entries()) {
            const locals = { '@index': i, '@key': k, '@first': i === 0, '@last': i === entries.length - 1, '@number': i + 1 };
            await this.#renderNodes(n.children, new Frame(item, frame, locals), out, blocks, depth);
          }
          break;
        }
        case 'with': await this.#renderNodes(n.children, new Frame(this.evalExpr(n.expr, frame), frame), out, blocks, depth); break;
        case 'block': await this.#renderNodes((blocks[n.arg] || n).children, frame, out, blocks, depth); break;
        case 'partial': {
          if (depth > Engine.#MAX_DEPTH) throw new Error('partial recursion too deep: ' + n.name);
          const ast = await this.compile('partials/' + n.name);
          const params = Object.fromEntries(Object.entries(n.params).map(([k, e]) => [k, this.evalExpr({ value: e.value, filters: e.filters }, frame)]));
          const data = Object.keys(params).length ? { ...(typeof frame.data === 'object' ? frame.data : {}), ...params } : frame.data;
          await this.#renderNodes(ast.children, new Frame(data, frame, frame.locals), out, blocks, depth + 1);
          break;
        }
        default: throw new Error('bad node ' + n.type);
      }
    }
  }
}

// ---------------------------------------------------------------- templates on disk
const TEMPLATES = {
  'layout.html': `<!doctype html>
<html><head><title>{{#block title}}Site{{/block}}</title></head>
<body>
{{> nav}}
<main>{{#block content}}(empty){{/block}}</main>
<footer>{{#block footer}}(c) {{site.name}} - {{site.year}}{{/block}}</footer>
</body></html>
`,
  'base_admin.html': `{{#extends "layout.html"}}{{/extends}}
{{#block title}}Admin :: {{#block subtitle}}Home{{/block}}{{/block}}
{{#block footer}}admin area{{/block}}`,
  'partials/nav': `<nav>{{#each site.links}}{{#if @first}}[{{/if}}<a href="{{url}}">{{label | upper}}</a>{{#unless @last}} | {{/unless}}{{#if @last}}]{{/if}}{{/each}}</nav>`,
  'partials/item': `<li class="{{#if active}}on{{else}}off{{/if}}">{{@number | pad:2}}. {{name | title}} &mdash; {{price | money:currency}}{{#if tags}} ({{tags | join:"/"}}){{/if}}</li>`,
  'partials/tree': `<ul>{{#each children}}<li>{{label}}{{#if children}}{{> tree}}{{/if}}</li>{{/each}}</ul>`,
  'home.html': `{{#extends "layout.html"}}{{/extends}}
{{#block title}}Welcome, {{user.name | default:"guest"}}{{/block}}
{{#block content}}
{{!-- this comment disappears --}}
<h1>Hello {{user.name}}</h1>
<p>{{{user.bio}}}</p>
<p>escaped: {{user.bio}}</p>
<p>{{cart.count | plural:"item":"items"}} in cart</p>
{{/block}}`,
  'products.html': `{{#extends "layout.html"}}{{/extends}}
{{#block title}}Products ({{products | length}}){{/block}}
{{#block content}}
<ul>
{{#each products}}  {{> item currency=../currency}}
{{else}}  <li>none</li>
{{/each}}</ul>
{{#with stats}}<p>min={{min}} max={{max}} of {{../currency}}</p>{{/with}}
{{/block}}`,
  'dashboard.html': `{{#extends "base_admin.html"}}{{/extends}}
{{#block subtitle}}Dashboard{{/block}}
{{#block content}}
<table>{{#each metrics}}
<tr><td>{{@key}}</td><td>{{this}}</td></tr>{{/each}}
</table>
<pre>{{config | json}}</pre>
{{/block}}`,
  'tree.html': `{{#extends "layout.html"}}{{/extends}}{{#block content}}{{> tree}}{{/block}}`,
  'trim.html': `A   {{- " B " -}}   C {{- missing | default:"-"}}`,
  'broken.html': `{{#if x}}open without close`,
  'mismatch.html': `{{#each a}}{{/if}}`,
  'badfilter.html': `{{ name | shout }}`,
};

// ---------------------------------------------------------------- http layer
class Router {
  #routes = [];
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.#routes.push({ method, re, keys, handler });
    return this;
  }
  match(method, url) {
    for (const r of this.#routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

function makeData(overrides = {}) {
  return {
    site: { name: 'Corp & Co', year: 2024, links: [{ url: '/', label: 'home' }, { url: '/products', label: 'shop' }, { url: '/admin?a=1&b=2', label: 'admin' }] },
    user: { name: 'Ada <Lovelace>', bio: '<em>first programmer</em>' },
    cart: { count: 3 },
    currency: 'CHF',
    products: [
      { name: 'widget deluxe', price: 1234.5, active: true, tags: ['new', 'hot'] },
      { name: 'gadget', price: 0.99, active: false, tags: [] },
      { name: 'gizmo "pro"', price: 1000000, active: true },
    ],
    stats: { min: 0.99, max: 1000000 },
    metrics: { users: 42, errors: 0, latency_p99: '12ms' },
    config: { theme: 'dark', flags: ['a', 'b'], nested: { ok: true } },
    children: [{ label: 'root', children: [{ label: 'a', children: [{ label: 'a1', children: [] }, { label: 'a2', children: [] }] }, { label: 'b', children: [] }] }],
    ...overrides,
  };
}

class ChunkCounter extends Transform {
  constructor() { super(); this.chunks = 0; this.bytes = 0; }
  _transform(c, _e, cb) { this.chunks++; this.bytes += c.length; cb(null, c); }
}

async function startServer(engine) {
  const router = new Router();
  const renderCount = new Map();
  const page = (tpl, dataFn) => async (req, params, query) => {
    renderCount.set(tpl, (renderCount.get(tpl) || 0) + 1);
    return { status: 200, type: 'text/html', body: await engine.render(tpl, dataFn(params, query)) };
  };
  router
    .add('GET', '/', page('home.html', () => makeData()))
    .add('GET', '/u/:name', page('home.html', (p) => makeData({ user: { name: p.name, bio: 'visitor' }, cart: { count: 1 } })))
    .add('GET', '/products', page('products.html', (_p, q) => makeData(q.get('empty') ? { products: [] } : {})))
    .add('GET', '/admin', page('dashboard.html', () => makeData()))
    .add('GET', '/tree', page('tree.html', () => makeData()))
    .add('GET', '/t/:tpl', async (req, p) => ({ status: 200, type: 'text/plain', body: await engine.render(p.tpl + '.html', makeData()) }))
    .add('POST', '/preview', async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { template, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ast = parse(template, 'inline');
      const out = [];
      const e = new Engine(async () => template);
      return { status: 200, type: 'text/plain', body: await e.render('inline', data) + ` [nodes=${ast.children.length}]` };
    })
    .add('GET', '/stats', async () => ({ status: 200, type: 'application/json', body: JSON.stringify({ engine: engine.stats, renders: Object.fromEntries([...renderCount].sort(([a], [b]) => cmpStr(a, b))) }) }));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://local');
    let result;
    try {
      const m = router.match(req.method, u.pathname);
      result = m ? await m.handler(req, m.params, u.searchParams) : { status: 404, type: 'text/plain', body: 'no route ' + u.pathname };
    } catch (e) {
      result = { status: e.name === 'TemplateSyntaxError' ? 422 : 500, type: 'text/plain', body: `${e.name}: ${e.message}` };
    }
    const body = Buffer.from(result.body, 'utf8');
    const etag = '"' + sha1(body).slice(0, 16) + '"';
    const headers = { 'content-type': result.type + '; charset=utf-8', etag, connection: 'close' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 200) {
      const gz = zlib.gzipSync(body, { level: 9 });
      res.writeHead(result.status, { ...headers, 'content-encoding': 'gzip', 'x-raw-length': String(body.length) });
      const counter = new ChunkCounter();
      Readable.from([gz.subarray(0, 64), gz.subarray(64)]).pipe(counter).pipe(res);
      return;
    }
    res.writeHead(result.status, { ...headers, 'content-length': body.length });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), wire: Buffer.concat(chunks).length });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- main
function printBody(text, max = 40) {
  const lines = text.split('\n').filter((l) => l.trim());
  for (const l of lines.slice(0, max)) console.log('  | ' + l);
  if (lines.length > max) console.log(`  | ... ${lines.length - max} more`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcorp-'));
  const events = [];
  let server;
  try {
    for (const [name, src] of Object.entries(TEMPLATES)) {
      const full = path.join(dir, ...name.split('/'));
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, src);
    }
    const loads = { count: 0 };
    const loader = async (name) => {
      loads.count++;
      try { return await fsp.readFile(path.join(dir, ...name.split('/')), 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') throw new Error('template not found: ' + name); throw e; }
    };
    const engine = new Engine(loader, { cacheSize: 7 });
    engine.on('evict', (n) => events.push('evict ' + n));
    engine.on('invalidate', (n) => events.push('invalidate ' + n));
    console.log('engine ' + Engine.version);

    console.log('== lexer ==');
    for (const tok of lex('a{{x}}b{{{y}}}{{#if z}}c{{else}}d{{/if}}{{!note}}{{> p}}', 'demo')) console.log('  ' + JSON.stringify(tok));
    console.log('== filters ==');
    for (const [f, v, args] of [['money', 1234567.891, []], ['money', -5, ['USD']], ['truncate', 'abcdefghijklmnop', [6]], ['title', 'hello big world', []], ['plural', 1, ['cat', 'cats']], ['pad', 7, [3]]])
      console.log(`  ${f}(${JSON.stringify(v)}${args.length ? ', ' + args.map((a) => JSON.stringify(a)).join(', ') : ''}) = ${JSON.stringify(String(FILTERS[f](v, ...args)))}`);
    console.log('  escape: ' + escapeHtml(`<a href="x">'&'</a>`));

    server = await startServer(engine);
    const port = server.address().port;
    const etags = {};
    const routes = [
      ['GET', '/'], ['GET', '/products'], ['GET', '/products?empty=1'], ['GET', '/admin'], ['GET', '/tree'],
      ['GET', '/u/' + encodeURIComponent('Bob & <Eve>')], ['GET', '/t/trim'], ['GET', '/t/broken'], ['GET', '/t/mismatch'],
      ['GET', '/t/badfilter'], ['GET', '/t/nonexistent'], ['GET', '/nowhere'], ['DELETE', '/'],
    ];
    for (const [method, url] of routes) {
      const r = await request(port, method, url);
      etags[url] = r.headers.etag;
      console.log(`== ${method} ${url} -> ${r.status} ${r.headers['content-type'].split(';')[0]} etag=${r.headers.etag} len=${Buffer.byteLength(r.text)}`);
      printBody(r.text, 14);
    }

    console.log('== conditional + gzip ==');
    const c1 = await request(port, 'GET', '/products', { headers: { 'if-none-match': etags['/products'] } });
    console.log(`  if-none-match same -> ${c1.status} body=${c1.text.length}`);
    const c2 = await request(port, 'GET', '/products', { headers: { 'if-none-match': '"stale"' } });
    console.log(`  if-none-match stale -> ${c2.status} same-etag=${c2.headers.etag === etags['/products']}`);
    const g = await request(port, 'GET', '/admin', { headers: { 'accept-encoding': 'gzip, br' } });
    console.log(`  gzip -> ${g.status} enc=${g.headers['content-encoding']} raw=${g.headers['x-raw-length']} decoded=${Buffer.byteLength(g.text)} smaller=${g.wire < Number(g.headers['x-raw-length'])} etag-match=${g.headers.etag === etags['/admin']}`);

    console.log('== cache invalidation by content hash ==');
    const before = engine.stats;
    await fsp.writeFile(path.join(dir, 'partials', 'nav'), TEMPLATES['partials/nav'].replace('<nav>', '<nav class="v2">'));
    const r2 = await request(port, 'GET', '/');
    console.log(`  after nav edit: etag changed=${r2.headers.etag !== etags['/']} has v2=${r2.text.includes('class="v2"')}`);
    const after = engine.stats;
    console.log(`  compiles ${before.compiles} -> ${after.compiles}, hits ${before.hits} -> ${after.hits}`);

    console.log('== inline preview (POST) ==');
    const previews = [
      { template: '{{#each items}}{{@index}}:{{this | upper}}{{#unless @last}},{{/unless}}{{/each}}', data: { items: ['x', 'y', 'z'] } },
      { template: '{{#with a.b}}{{c}}-{{../top}}{{/with}} {{missing.deep.path | default:"n/a"}}', data: { a: { b: { c: 'C' } }, top: 'T' } },
      { template: '{{#each obj}}{{@key}}={{this}};{{/each}}{{#each none}}x{{else}}empty{{/each}}', data: { obj: { b: 2, a: 1 } } },
      { template: '{{{raw}}} vs {{raw}} vs {{raw | safe}}', data: { raw: '<b>&</b>' } },
      { template: '{{#if}}', data: {} },
    ];
    for (const p of previews) {
      const r = await request(port, 'POST', '/preview', { body: JSON.stringify(p), headers: { 'content-type': 'application/json' } });
      console.log(`  ${r.status} ${r.text}`);
    }

    console.log('== stats ==');
    const s = JSON.parse((await request(port, 'GET', '/stats')).text);
    for (const [k, v] of Object.entries(s.engine)) console.log(`  engine.${k} = ${v}`);
    for (const [k, v] of Object.entries(s.renders)) console.log(`  renders[${k}] = ${v}`);
    console.log('  loader calls ' + loads.count);
    console.log('== cache events ==');
    for (const e of events) console.log('  ' + e);
    const digest = sha1(Object.values(etags).join('|'));
    console.log('etag digest ' + digest.slice(0, 20));
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    await fsp.rm(dir, { recursive: true, force: true });
    console.log('cleanup done, dir gone=' + !fs.existsSync(dir));
  }
}

process.on('exit', (code) => console.log('exit ' + code));
main().catch((e) => { console.log('fatal ' + e.stack.split('\n')[0]); process.exitCode = 1; });
