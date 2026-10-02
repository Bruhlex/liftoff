// Tiny single-page-application framework: an `html` tagged template compiles markup with holes into
// virtual nodes (cached per template strings array), a keyed reconciler patches the real DOM and
// counts DOM operations, a Proxy-based deep reactive store batches change notifications into
// requestAnimationFrame frames, components are classes with #private fields and lifecycle hooks,
// and a regex router drives history.pushState / popstate. A scripted user session is replayed
// through delegated click / input events and the resulting DOM is printed after every frame.
'use strict';

// ---------------------------------------------------------------- logging helpers
const out = [];
function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  out.push(line);
  console.log(line);
}
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const microtask = () => Promise.resolve();

// ---------------------------------------------------------------- tagged template compiler
const HOLE = '\u0001';
const templateCache = new WeakMap();
let compileCount = 0;

function tokenize(src) {
  const tokens = [];
  const re = /<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[@:\w-]+(?:=(?:"[^"]*"|\u0001\d+\u0001|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gy;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) tokens.push({ kind: 'close', tag: m[1] });
    else if (m[2]) tokens.push({ kind: 'open', tag: m[2], attrs: m[3], selfClose: m[4] === '/' });
    else if (m[5] !== undefined) tokens.push({ kind: 'text', text: m[5] });
    if (re.lastIndex >= src.length) break;
  }
  if (re.lastIndex !== 0 && re.lastIndex < src.length) throw new Error('template parse error at ' + re.lastIndex);
  return tokens;
}

function parseAttrs(str) {
  const attrs = [];
  const re = /([@:\w-]+)(?:=(?:"([^"]*)"|\u0001(\d+)\u0001|([^\s>]+)))?/g;
  for (const m of str.matchAll(re)) {
    const [, attrName, quoted, hole, bare] = m;
    if (hole !== undefined) attrs.push({ name: attrName, hole: Number(hole) });
    else attrs.push({ name: attrName, value: quoted ?? bare ?? '' });
  }
  return attrs;
}

function compile(strings) {
  compileCount++;
  let src = strings[0];
  for (let i = 1; i < strings.length; i++) src += HOLE + (i - 1) + HOLE + strings[i];
  const tokens = tokenize(src.trim());
  const root = { tag: '#root', attrs: [], children: [] };
  const stack = [root];
  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    switch (tok.kind) {
      case 'open': {
        const node = { tag: tok.tag, attrs: parseAttrs(tok.attrs), children: [] };
        top.children.push(node);
        if (!tok.selfClose && !/^(br|hr|input|img)$/.test(tok.tag)) stack.push(node);
        break;
      }
      case 'close':
        if (top.tag !== tok.tag) throw new Error('mismatched </' + tok.tag + '> inside <' + top.tag + '>');
        stack.pop();
        break;
      default: {
        const parts = tok.text.split(/\u0001(\d+)\u0001/);
        parts.forEach((p, i) => {
          if (i % 2 === 1) top.children.push({ hole: Number(p) });
          else if (p.trim() !== '') top.children.push({ text: p.replace(/\s+/g, ' ') });
        });
      }
    }
  }
  if (stack.length !== 1) throw new Error('unclosed <' + stack[stack.length - 1].tag + '>');
  return root.children;
}

function instantiate(tpl, values) {
  const result = [];
  for (const n of tpl) {
    if (n.hole !== undefined) {
      const v = values[n.hole];
      const flat = Array.isArray(v) ? v.flat(Infinity) : [v];
      for (const item of flat) {
        if (item == null || item === false) continue;
        result.push(typeof item === 'object' ? item : { text: String(item) });
      }
    } else if (n.text !== undefined) {
      result.push({ text: n.text });
    } else {
      const props = {};
      const on = {};
      let key = null;
      for (const a of n.attrs) {
        const val = a.hole !== undefined ? values[a.hole] : a.value;
        if (a.name === 'key') key = String(val);
        else if (a.name[0] === '@') on[a.name.slice(1)] = val;
        else if (a.name[0] === ':') { if (val) props[a.name.slice(1)] = ''; }
        else props[a.name] = val;
      }
      result.push({ tag: n.tag, props, on, key, children: instantiate(n.children, values) });
    }
  }
  return result;
}

function html(strings, ...values) {
  let tpl = templateCache.get(strings);
  if (!tpl) { tpl = compile(strings); templateCache.set(strings, tpl); }
  const nodes = instantiate(tpl, values);
  return nodes.length === 1 ? nodes[0] : { fragment: true, children: nodes };
}

// ---------------------------------------------------------------- keyed reconciler
const domOps = { create: 0, remove: 0, move: 0, text: 0, attr: 0 };
const vnodeOf = new WeakMap();
const handlersOf = new WeakMap();

function createDom(v) {
  domOps.create++;
  if (v.text !== undefined) return document.createTextNode(v.text);
  const el = document.createElement(v.tag);
  for (const [k, val] of Object.entries(v.props)) el.setAttribute(k, String(val));
  handlersOf.set(el, Object.assign({}, v.on));
  for (const c of v.children) el.appendChild(createDom(c));
  vnodeOf.set(el, v);
  return el;
}

function sameKind(a, b) {
  if (!a || !b) return false;
  if ((a.text !== undefined) !== (b.text !== undefined)) return false;
  return a.text !== undefined || (a.tag === b.tag && a.key === b.key);
}

function patchProps(el, oldV, newV) {
  const oldP = oldV.props, newP = newV.props;
  for (const k of Object.keys(oldP)) if (!(k in newP)) { el.removeAttribute(k); domOps.attr++; }
  for (const [k, v] of Object.entries(newP)) {
    if (oldP[k] !== v) { el.setAttribute(k, String(v)); domOps.attr++; }
  }
  handlersOf.set(el, Object.assign({}, newV.on));
}

function patchChildren(parent, oldKids, newKids) {
  const domKids = [...parent.childNodes];
  const keyed = new Map();
  oldKids.forEach((k, i) => { if (k.key != null) keyed.set(k.key, { v: k, dom: domKids[i] }); });
  const used = new Set();
  const nextDom = [];
  outer: for (let i = 0; i < newKids.length; i++) {
    const nv = newKids[i];
    if (nv.key != null && keyed.has(nv.key)) {
      const hit = keyed.get(nv.key);
      if (hit.v.tag === nv.tag) {
        used.add(hit.dom);
        nextDom.push(patch(hit.dom, hit.v, nv));
        continue outer;
      }
    }
    for (let j = 0; j < oldKids.length; j++) {
      if (used.has(domKids[j]) || oldKids[j].key != null) continue;
      if (sameKind(oldKids[j], nv)) {
        used.add(domKids[j]);
        nextDom.push(patch(domKids[j], oldKids[j], nv));
        continue outer;
      }
    }
    nextDom.push(createDom(nv));
  }
  for (const d of domKids) if (!used.has(d)) { parent.removeChild(d); domOps.remove++; }
  let cursor = parent.firstChild;
  for (const d of nextDom) {
    if (d === cursor) { cursor = cursor.nextSibling; continue; }
    if (d.parentNode === parent) domOps.move++;
    parent.insertBefore(d, cursor);
  }
}

function patch(dom, oldV, newV) {
  if (!sameKind(oldV, newV)) {
    const fresh = createDom(newV);
    dom.parentNode.replaceChild(fresh, dom);
    domOps.remove++;
    return fresh;
  }
  if (newV.text !== undefined) {
    if (oldV.text !== newV.text) { dom.data = newV.text; domOps.text++; }
    return dom;
  }
  patchProps(dom, oldV, newV);
  patchChildren(dom, oldV.children, newV.children);
  vnodeOf.set(dom, newV);
  return dom;
}

// ---------------------------------------------------------------- reactive store
class ReactiveStore extends EventTarget {
  #raw;
  #pending = new Set();
  #scheduled = false;
  #proxies = new WeakMap();
  #version = 0;
  constructor(initial) {
    super();
    this.#raw = initial;
    this.state = this.#wrap(initial, '');
  }
  get version() { return this.#version; }
  #wrap(obj, path) {
    if (obj === null || typeof obj !== 'object') return obj;
    const cached = this.#proxies.get(obj);
    if (cached) return cached;
    const store = this;
    const proxy = new Proxy(obj, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof prop === 'symbol') return v;
        return store.#wrap(v, path ? path + '.' + prop : String(prop));
      },
      set(target, prop, value) {
        const old = target[prop];
        if (old === value && prop !== 'length') return true;
        target[prop] = value;
        store.#notify(path ? path + '.' + String(prop) : String(prop));
        return true;
      },
      deleteProperty(target, prop) {
        if (!(prop in target)) return true;
        delete target[prop];
        store.#notify((path ? path + '.' : '') + String(prop));
        return true;
      },
    });
    this.#proxies.set(obj, proxy);
    return proxy;
  }
  #notify(path) {
    this.#pending.add(path.replace(/\.\d+(?=\.|$)/g, '[]'));
    if (this.#scheduled) return;
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      this.#version++;
      const paths = [...this.#pending].sort();
      this.#pending.clear();
      this.dispatchEvent(new CustomEvent('change', { detail: { paths, version: this.#version } }));
    });
  }
  snapshot() { return JSON.parse(JSON.stringify(this.#raw)); }
}

// ---------------------------------------------------------------- components
let componentSeq = 0;
class Component {
  #id;
  #mounted = false;
  #renders = 0;
  constructor(props = {}) {
    this.#id = 'c' + ++componentSeq;
    this.props = props;
  }
  get id() { return this.#id; }
  get renders() { return this.#renders; }
  get mounted() { return this.#mounted; }
  onMount() {}
  onUnmount() {}
  view() { return html`<div></div>`; }
  render() {
    this.#renders++;
    try {
      const v = this.view();
      return v;
    } finally {
      if (!this.#mounted) { this.#mounted = true; this.onMount(); }
    }
  }
  unmount() { if (this.#mounted) { this.#mounted = false; this.onUnmount(); } }
}

class TodoItem extends Component {
  view() {
    const { todo, index } = this.props;
    const cls = 'todo' + (todo.done ? ' done' : '');
    return html`<li key=${todo.id} class=${cls} data-id=${todo.id}>
      <input type="checkbox" :checked=${todo.done} data-action="toggle" />
      <span class="label">${index + 1}. ${todo.title}</span>
      <button data-action="remove">x</button>
    </li>`;
  }
}

class TodoPage extends Component {
  onMount() { log('[mount] TodoPage', this.id); }
  onUnmount() { log('[unmount] TodoPage', this.id); }
  view() {
    const { state } = this.props;
    const filter = state.filter;
    const visible = state.todos.filter((t) => filter === 'all' || (filter === 'done' ? t.done : !t.done));
    const remaining = state.todos.filter((t) => !t.done).length;
    return html`<section class="page todos">
      <h1>Todos (${remaining} left)</h1>
      <input class="new" value=${state.draft} data-action="draft" />
      <button data-action="add">add</button>
      <ul class="list">${visible.map((todo, index) => new TodoItem({ todo, index }).render())}</ul>
      <p class="filters">${['all', 'open', 'done'].map((f) => html`<a key=${f} class=${f === filter ? 'sel' : 'f'} data-action="filter" data-filter=${f}>${f}</a>`)}</p>
    </section>`;
  }
}

class DetailPage extends Component {
  onMount() { log('[mount] DetailPage', this.id, 'todo', this.props.todoId); }
  onUnmount() { log('[unmount] DetailPage', this.id); }
  view() {
    const { state, todoId } = this.props;
    const todo = state.todos.find((t) => t.id === todoId);
    if (!todo) return html`<section class="page missing"><h1>Not found</h1><p>No todo #${todoId}</p></section>`;
    return html`<section class="page detail">
      <h1>${todo.title}</h1>
      <p>status: ${todo.done ? 'done' : 'open'} tags: ${todo.tags?.join(', ') ?? 'none'}</p>
      <a data-action="nav" data-href="/todos">back</a>
    </section>`;
  }
}

class StatsPage extends Component {
  view() {
    const { state } = this.props;
    const byTag = {};
    for (const { tags = [], done } of state.todos) {
      for (const t of tags) {
        const e = (byTag[t] ??= { total: 0, done: 0 });
        e.total++;
        if (done) e.done++;
      }
    }
    const rows = Object.entries(byTag).sort(([a], [b]) => (a < b ? -1 : 1));
    return html`<section class="page stats"><h1>Stats</h1><ul>${rows.map(([tag, { total, done }]) => html`<li key=${tag}>${tag}: ${done}/${total}</li>`)}</ul></section>`;
  }
}

// ---------------------------------------------------------------- router
class Router extends EventTarget {
  #routes = [];
  #current = null;
  add(pattern, factory) {
    const keys = [];
    const src = pattern.replace(/\//g, '\\/').replace(/:(\w+)(\([^)]*\))?/g, (_, key, re) => { keys.push(key); return re || '([^\\/]+)'; });
    this.#routes.push({ pattern, re: new RegExp('^' + src + '\\/?$'), keys, factory });
    return this;
  }
  match(pathname) {
    for (const r of this.#routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = /^\d+$/.test(m[i + 1]) ? Number(m[i + 1]) : decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
  get current() { return this.#current; }
  resolve() {
    const hit = this.match(window.location.pathname);
    const query = Object.fromEntries(new URLSearchParams(window.location.search));
    this.#current = hit ? { pattern: hit.route.pattern, params: hit.params, query } : { pattern: '*', params: {}, query };
    this.dispatchEvent(new CustomEvent('route', { detail: this.#current }));
    return this.#current;
  }
  navigate(path, replace = false) {
    if (replace) window.history.replaceState({ path }, '', path);
    else window.history.pushState({ path }, '', path);
    return this.resolve();
  }
  start() {
    window.addEventListener('popstate', (ev) => { log('[popstate]', ev.state?.path ?? '(null)', window.location.pathname); this.resolve(); });
    return this.resolve();
  }
}

// ---------------------------------------------------------------- application
class App {
  #root;
  #store;
  #router;
  #page = null;
  #vtree = null;
  #frames = 0;
  #eventLog = [];
  constructor(rootEl) {
    this.#root = rootEl;
    this.#store = new ReactiveStore({
      filter: 'all',
      draft: '',
      nextId: 4,
      todos: [
        { id: 1, title: 'Write parser', done: true, tags: ['dev'] },
        { id: 2, title: 'Buy milk', done: false, tags: ['home'] },
        { id: 3, title: 'Review PR', done: false, tags: ['dev', 'team'] },
      ],
    });
    this.#router = new Router()
      .add('/todos', () => new TodoPage({ state: this.#store.state }))
      .add('/todos/:id(\\d+)', ({ id }) => new DetailPage({ state: this.#store.state, todoId: id }))
      .add('/stats', () => new StatsPage({ state: this.#store.state }));
    this.#store.addEventListener('change', (ev) => {
      const { paths, version } = ev.detail;
      log('[store v' + version + ']', paths.join(','));
      this.render('store');
    });
    this.#router.addEventListener('route', (ev) => {
      const { pattern, params, query } = ev.detail;
      log('[route]', pattern, params, query);
      this.#page?.unmount();
      const found = this.#router.match(window.location.pathname);
      this.#page = found ? found.route.factory(found.params) : null;
      this.render('route');
    });
    this.#installDelegation();
  }
  get store() { return this.#store; }
  get router() { return this.#router; }
  #installDelegation() {
    const root = this.#root;
    root.addEventListener('click', (ev) => { this.#eventLog.push('capture:' + (ev.target.dataset?.action ?? ev.target.localName)); }, true);
    root.addEventListener('click', (ev) => {
      const actionEl = ev.target.closest('[data-action]');
      if (!actionEl || !root.contains(actionEl)) return;
      const action = actionEl.dataset.action;
      const item = actionEl.closest('li[data-id]');
      const id = item ? Number(item.dataset.id) : null;
      this.dispatch(action, { id, el: actionEl });
      if (action === 'remove') ev.stopPropagation();
    });
    root.addEventListener('input', (ev) => {
      if (ev.target.dataset.action === 'draft') this.#store.state.draft = ev.target.value;
    });
    document.body.addEventListener('click', (ev) => { this.#eventLog.push('body:' + (ev.target.dataset?.action ?? '-')); });
  }
  dispatch(action, { id, el }) {
    const s = this.#store.state;
    switch (action) {
      case 'toggle': {
        const t = s.todos.find((x) => x.id === id);
        if (t) t.done = !t.done;
        break;
      }
      case 'remove': {
        const idx = s.todos.findIndex((x) => x.id === id);
        if (idx >= 0) s.todos.splice(idx, 1);
        break;
      }
      case 'add': {
        const title = s.draft.trim();
        if (!title) { log('[add] ignored empty draft'); break; }
        const tags = [...title.matchAll(/#(\w+)/g)].map((m) => m[1]);
        s.todos.push({ id: s.nextId++, title: title.replace(/\s*#\w+/g, ''), done: false, tags });
        s.draft = '';
        break;
      }
      case 'filter':
        s.filter = el.dataset.filter;
        break;
      case 'nav':
        this.#router.navigate(el.dataset.href);
        break;
      default:
        log('[dispatch] unknown action', action);
    }
  }
  render(reason) {
    this.#frames++;
    const next = this.#page ? this.#page.render() : html`<section class="page nf"><h1>404</h1></section>`;
    const before = Object.assign({}, domOps);
    if (!this.#vtree) {
      this.#root.appendChild(createDom(next));
    } else {
      patch(this.#root.firstChild, this.#vtree, next);
    }
    this.#vtree = next;
    const delta = Object.keys(domOps).map((k) => k + '=' + (domOps[k] - before[k])).filter((s) => !s.endsWith('=0'));
    log('[render #' + this.#frames + ' ' + reason + ']', delta.join(' ') || 'no-op');
  }
  takeEventLog() { const l = this.#eventLog.slice(); this.#eventLog.length = 0; return l; }
}

// ---------------------------------------------------------------- DOM helpers for the script
function printTree(el, depth = 0, lines = []) {
  const pad = '  '.repeat(depth);
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { const t = n.data.trim(); if (t) lines.push(pad + JSON.stringify(t)); continue; }
    const attrs = n.getAttributeNames().filter((a) => a !== 'data-action').map((a) => a + '=' + n.getAttribute(a)).join(' ');
    lines.push(pad + '<' + n.localName + (attrs ? ' ' + attrs : '') + '>');
    printTree(n, depth + 1, lines);
  }
  return lines;
}
function dumpApp(root, label) {
  log('--- ' + label + ' ---');
  for (const l of printTree(root)) log(l);
}
function clickOn(root, selector) {
  const el = root.querySelector(selector);
  if (!el) { log('[click] missing', selector); return false; }
  el.click();
  return true;
}
function typeInto(root, selector, text) {
  const el = root.querySelector(selector);
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------- scripted session as async generator
async function* sessionSteps(root, app) {
  yield ['initial', () => {}];
  yield ['toggle #2', () => clickOn(root, 'li[data-id="2"] input')];
  yield ['type draft', () => typeInto(root, 'input.new', 'Ship release #dev #ops')];
  yield ['add', () => clickOn(root, 'button[data-action="add"]')];
  yield ['add empty', () => clickOn(root, 'button[data-action="add"]')];
  yield ['filter open', () => clickOn(root, 'a[data-filter="open"]')];
  yield ['remove #3', () => clickOn(root, 'li[data-id="3"] button')];
  yield ['filter all', () => clickOn(root, 'a[data-filter="all"]')];
  yield ['nav detail 4', () => app.router.navigate('/todos/4')];
  yield ['nav back link', () => clickOn(root, 'a[data-action="nav"]')];
  yield ['nav stats', () => app.router.navigate('/stats?sort=tag')];
  yield ['nav unknown', () => app.router.navigate('/nowhere')];
  yield ['history back', () => window.history.back()];
  yield ['history back again', () => window.history.back()];
  yield ['batched edits', () => {
    const s = app.store.state;
    for (let i = 0; i < s.todos.length; i++) {
      const t = s.todos[i];
      if (t.tags.includes('dev')) t.title = t.title.toUpperCase();
    }
    s.todos.reverse();
    s.todos.reverse();
    s.filter = 'done';
    s.filter = 'all';
  }];
  yield ['reorder', () => {
    const s = app.store.state;
    const moved = s.todos.shift();
    s.todos.push(moved);
  }];
}

async function main() {
  const root = document.getElementById('app');
  root.textContent = '';
  log('start url', window.location.pathname + window.location.search);
  const app = new App(root);
  app.router.navigate('/todos', true);
  app.router.start();
  let step = 0;
  for await (const [label, action] of sessionSteps(root, app)) {
    step++;
    log('== step ' + step + ': ' + label);
    action();
    await microtask();
    await nextFrame();
    await nextFrame();
    const evs = app.takeEventLog();
    if (evs.length) log('events', evs.join(' '));
    if (/^(initial|add|remove|nav detail|reorder|batched)/.test(label)) dumpApp(root, label);
  }
  // compiled-template cache: every template literal compiled exactly once
  log('templates compiled', compileCount);
  log('dom ops total', domOps);
  log('store version', app.store.version);
  const snap = app.store.snapshot();
  log('final todos', snap.todos.map(({ id, title, done }) => id + ':' + title + (done ? '*' : '')).join(' | '));
  log('history length', window.history.length, 'url', window.location.pathname);
  // parser error handling
  const bad = [['<div><span></div>'], ['<p>unclosed']];
  for (const strs of bad) {
    try {
      compile(strs);
      log('parse ok?!');
    } catch (e) {
      log('parse error:', e.message);
    }
  }
  let h = 0;
  for (const line of out) for (let i = 0; i < line.length; i++) h = (Math.imul(h, 31) + line.charCodeAt(i)) >>> 0;
  log('output hash', h.toString(16));
}

main().catch((e) => { console.log('FATAL', e && e.message); });
