// Plugin host for a small web app: an AMD-like module loader with lazy, promise-based fetching
// (simulated latency via requestAnimationFrame), dependency resolution with cycle detection,
// per-plugin sandboxes built from Proxy objects (allow-listed globals, namespaced localStorage,
// DOM access scoped to the plugin's mount point), feature detection on window/navigator, a
// tapable-style hook bus, a tagged-template DOM builder and delegated toolbar events.
'use strict';

const say = (...a) => console.log(...a);
const frame = () => new Promise((r) => requestAnimationFrame(r));
async function wait(frames) { for (let i = 0; i < frames; i++) await frame(); }

// ------------------------------------------------------------------ feature detection
async function detectFeatures() {
  const f = {};
  f.raf = typeof window.requestAnimationFrame === 'function';
  f.idle = 'requestIdleCallback' in window;
  f.intersectionObserver = 'IntersectionObserver' in window;
  f.resizeObserver = typeof window.ResizeObserver === 'function';
  f.customEvent = (() => { try { return new CustomEvent('x', { detail: 1 }).detail === 1; } catch { return false; } })();
  f.localStorage = (() => {
    const k = '__probe__';
    try { localStorage.setItem(k, k); return localStorage.getItem(k) === k; } catch { return false; } finally { localStorage.removeItem(k); }
  })();
  f.canvas2d = !!document.createElement('canvas').getContext?.('2d');
  f.webgl = !!document.createElement('canvas').getContext?.('webgl');
  f.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  f.darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  f.wide = window.matchMedia('(min-width: 1200px)').matches;
  f.onLine = navigator.onLine === true;
  f.clipboardWrite = await navigator.permissions?.query({ name: 'clipboard-write' }).then((s) => s.state, () => 'unknown');
  f.notificationsPerm = await navigator.permissions?.query({ name: 'notifications' }).then((s) => s.state, () => 'unknown');
  f.bogusPerm = await navigator.permissions?.query({ name: 'teleport' }).then((s) => s.state, () => 'rejected');
  f.cores = navigator.hardwareConcurrency >= 4 ? 'many' : 'few';
  f.langs = navigator.languages?.length ?? 0;
  f.uuid = typeof crypto.randomUUID === 'function';
  return f;
}

// ------------------------------------------------------------------ tagged-template DOM builder
const TOKEN_RE = /<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[\w-]+(?:="[^"]*"|=\u0001\d+\u0001)?)*)\s*(\/?)>|\u0001(\d+)\u0001|([^<\u0001]+)/g;
const ATTR_RE = /([\w-]+)(?:="([^"]*)"|=(\u0001\d+\u0001))?/g;

function html(strings, ...values) {
  let src = '';
  strings.forEach((s, i) => { src += s; if (i < values.length) src += '\u0001' + i + '\u0001'; });
  const frag = document.createDocumentFragment();
  const stack = [frag];
  const top = () => stack[stack.length - 1];
  const handlers = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    const [, close, open, attrs, selfClose, slot, text] = m;
    if (close) {
      if (top().localName !== close) throw new SyntaxError('mismatched </' + close + '>');
      stack.pop();
    } else if (open) {
      const el = document.createElement(open);
      let a;
      ATTR_RE.lastIndex = 0;
      while ((a = ATTR_RE.exec(attrs))) {
        const [, name, quoted, bare] = a;
        const raw = quoted ?? bare ?? '';
        const vm = /^\u0001(\d+)\u0001$/.exec(raw);
        const val = vm ? values[+vm[1]] : raw.replace(/\u0001(\d+)\u0001/g, (_, n) => String(values[+n]));
        if (name.startsWith('on-') && typeof val === 'function') handlers.push([el, name.slice(3), val]);
        else if (val === true || val === '') el.setAttribute(name, '');
        else if (val !== false && val != null) el.setAttribute(name, String(val));
      }
      top().appendChild(el);
      if (!selfClose && !['input', 'br', 'img', 'hr'].includes(open)) stack.push(el);
    } else if (slot !== undefined) {
      const v = values[+slot];
      const items = Array.isArray(v) ? v : [v];
      for (const it of items) {
        if (it == null || it === false) continue;
        top().appendChild(it instanceof window.Node ? it : document.createTextNode(String(it)));
      }
    } else if (text && text.trim()) {
      top().appendChild(document.createTextNode(text.replace(/\s+/g, ' ')));
    }
  }
  if (stack.length !== 1) throw new SyntaxError('unclosed <' + top().localName + '>');
  for (const [el, type, fn] of handlers) el.addEventListener(type, fn);
  return frag;
}

// ------------------------------------------------------------------ hook bus
class HookBus {
  #hooks = new Map();
  #trace = [];
  tap(name, pluginId, fn, stage = 0) {
    const list = this.#hooks.get(name) ?? [];
    list.push({ pluginId, fn, stage });
    list.sort((a, b) => a.stage - b.stage || (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
    this.#hooks.set(name, list);
  }
  untapAll(pluginId) {
    for (const [name, list] of this.#hooks) this.#hooks.set(name, list.filter((t) => t.pluginId !== pluginId));
  }
  waterfall(name, initial) {
    let acc = initial;
    for (const { pluginId, fn } of this.#hooks.get(name) ?? []) {
      const next = fn(acc);
      if (next !== undefined) acc = next;
      this.#trace.push(name + ':' + pluginId);
    }
    return acc;
  }
  async series(name, ...args) {
    const results = [];
    for (const { pluginId, fn } of this.#hooks.get(name) ?? []) {
      results.push([pluginId, await fn(...args)]);
      this.#trace.push(name + ':' + pluginId);
    }
    return results;
  }
  async parallelBail(name, ...args) {
    const list = this.#hooks.get(name) ?? [];
    const settled = await Promise.all(list.map(async ({ pluginId, fn }) => {
      try { return [pluginId, await fn(...args)]; } catch { return [pluginId, undefined]; }
    }));
    for (const [pluginId, v] of settled) if (v !== undefined) return { pluginId, v };
    return null;
  }
  get trace() { return this.#trace.slice(); }
}

// ------------------------------------------------------------------ module loader
const REMOTE = {
  'lib/format': { deps: [], latency: 2, factory: () => ({ pad: (s, n) => String(s).padStart(n, '0'), title: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()) }) },
  'lib/events': { deps: [], latency: 1, factory: () => ({ emit: (el, type, detail) => el.dispatchEvent(new CustomEvent(type, { bubbles: true, detail })) }) },
  'lib/store': { deps: ['lib/events'], latency: 3, factory: (ev) => ({ create: (init, el) => reactive(init, (k, v) => ev.emit(el, 'store:set', { k, v })) }) },
  'plugin/wordcount': { deps: ['lib/format'], latency: 2, factory: (fmt) => wordCountPlugin(fmt) },
  'plugin/theme': { deps: ['lib/store'], latency: 4, factory: (store) => themePlugin(store) },
  'plugin/export': { deps: ['lib/format', 'lib/events'], latency: 1, factory: (fmt, ev) => exportPlugin(fmt, ev) },
  'plugin/greedy': { deps: [], latency: 1, factory: () => greedyPlugin() },
  'plugin/cyc-a': { deps: ['plugin/cyc-b'], latency: 1, factory: () => ({}) },
  'plugin/cyc-b': { deps: ['plugin/cyc-a'], latency: 1, factory: () => ({}) },
  'plugin/broken': { deps: ['lib/missing'], latency: 1, factory: () => ({}) },
};

class LoadError extends Error {
  constructor(id, reason) { super(reason + ': ' + id); this.id = id; this.reason = reason; }
}

class ModuleLoader {
  #cache = new Map();
  #fetches = 0;
  #log = [];
  async #fetch(id) {
    const rec = REMOTE[id];
    this.#fetches++;
    this.#log.push('fetch ' + id);
    await wait(rec ? rec.latency : 1);
    if (!rec) throw new LoadError(id, 'not found');
    return rec;
  }
  load(id, path = []) {
    if (path.includes(id)) return Promise.reject(new LoadError([...path, id].join(' -> '), 'cycle'));
    const cached = this.#cache.get(id);
    if (cached) return cached;
    const p = (async () => {
      const rec = await this.#fetch(id);
      const deps = await Promise.all(rec.deps.map((d) => this.load(d, [...path, id])));
      this.#log.push('init ' + id);
      return rec.factory(...deps);
    })();
    this.#cache.set(id, p);
    p.catch(() => this.#cache.delete(id));
    return p;
  }
  get fetches() { return this.#fetches; }
  get log() { return this.#log.slice(); }
}

// ------------------------------------------------------------------ reactive helper
function reactive(init, onSet) {
  return new Proxy({ ...init }, {
    set(t, k, v) { const old = t[k]; t[k] = v; if (old !== v) onSet(k, v, old); return true; },
    deleteProperty(t, k) { if (k in t) { delete t[k]; onSet(k, undefined); } return true; },
  });
}

// ------------------------------------------------------------------ sandbox
const ALLOWED_GLOBALS = new Set(['requestAnimationFrame', 'CustomEvent', 'matchMedia', 'performance', 'JSON', 'Math', 'Intl']);

function createSandbox(pluginId, mount, perms, audit) {
  const deny = (what) => { audit.push(`${pluginId} denied ${what}`); return undefined; };
  const prefix = 'plugin:' + pluginId + ':';
  const storage = new Proxy({}, {
    get(_, k) {
      if (!perms.includes('storage')) return deny('storage.' + String(k));
      if (k === 'keys') return () => { const ks = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key.startsWith(prefix)) ks.push(key.slice(prefix.length)); } return ks.sort(); };
      const v = localStorage.getItem(prefix + String(k));
      return v === null ? undefined : JSON.parse(v);
    },
    set(_, k, v) {
      if (!perms.includes('storage')) { deny('storage.' + String(k) + '='); return true; }
      localStorage.setItem(prefix + String(k), JSON.stringify(v));
      return true;
    },
    deleteProperty(_, k) { localStorage.removeItem(prefix + String(k)); return true; },
  });
  const scopedDoc = new Proxy({}, {
    get(_, k) {
      switch (k) {
        case 'querySelector': return (sel) => mount.querySelector(sel);
        case 'querySelectorAll': return (sel) => [...mount.querySelectorAll(sel)];
        case 'createElement': return (tag) => {
          if (/^(script|iframe|object|embed)$/i.test(tag)) { deny('createElement(' + tag + ')'); return document.createElement('span'); }
          return document.createElement(tag);
        };
        case 'createTextNode': return (t) => document.createTextNode(t);
        case 'root': return mount;
        case 'cookie': return deny('document.cookie');
        case 'body': case 'documentElement': return deny('document.' + k);
        default: return deny('document.' + String(k));
      }
    },
    set(_, k) { deny('document.' + String(k) + '='); return true; },
  });
  const nav = Object.freeze({ language: navigator.language, onLine: navigator.onLine, languages: [...navigator.languages] });
  const target = Object.create(null);
  return new Proxy(target, {
    get(_, k) {
      if (k === 'document') return scopedDoc;
      if (k === 'storage') return storage;
      if (k === 'navigator') return nav;
      if (k === Symbol.toStringTag) return 'Sandbox';
      if (typeof k === 'string' && ALLOWED_GLOBALS.has(k)) { const v = globalThis[k]; return typeof v === 'function' && /^[a-z]/.test(k) ? v.bind(window) : v; }
      if (k in target) return target[k];
      return deny(String(k));
    },
    set(_, k, v) {
      if (k in globalThis && !(k in target)) { deny('overwrite ' + String(k)); return true; }
      target[k] = v;
      return true;
    },
    has(_, k) { return k === 'document' || k === 'storage' || k === 'navigator' || ALLOWED_GLOBALS.has(k) || k in target; },
    ownKeys() { return ['document', 'storage', 'navigator', ...ALLOWED_GLOBALS, ...Reflect.ownKeys(target)]; },
    getOwnPropertyDescriptor(_, k) { return { value: this.get(_, k), enumerable: true, configurable: true, writable: true }; },
  });
}

// ------------------------------------------------------------------ plugin base classes
class PluginBase {
  #state = 'created';
  #transitions = [];
  constructor(meta) { this.meta = meta; }
  get state() { return this.#state; }
  get history() { return this.#transitions.join('>'); }
  _to(s) {
    const allowed = { created: ['active', 'failed'], active: ['disposed', 'failed'], failed: ['disposed'], disposed: [] };
    if (!allowed[this.#state].includes(s)) throw new Error('illegal transition');
    this.#transitions.push(s);
    this.#state = s;
  }
  activate() { return undefined; }
  dispose() { return undefined; }
}

class UiPlugin extends PluginBase {
  #buttons = [];
  addButton(g, label, action) {
    const b = g.document.createElement('button');
    b.setAttribute('data-plugin', this.meta.id);
    b.setAttribute('data-action', action);
    b.textContent = label;
    g.document.root.appendChild(b);
    this.#buttons.push(b);
    return b;
  }
  dispose() {
    for (const b of this.#buttons) b.remove();
    const n = this.#buttons.length;
    this.#buttons = [];
    return n;
  }
}

// plugin factories (module bodies)
function wordCountPlugin(fmt) {
  return class WordCount extends UiPlugin {
    activate(g, bus) {
      this.addButton(g, 'Count', 'count');
      bus.tap('text:transform', this.meta.id, (t) => t.replace(/\s{2,}/g, ' '), 5);
      bus.tap('toolbar:action', this.meta.id, (action, text) => {
        if (action !== 'count') return undefined;
        const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
        const n = (g.storage.total ?? 0) + words.length;
        g.storage.total = n;
        return `words=${fmt.pad(words.length, 3)} total=${n}`;
      });
      return 'wordcount ready';
    }
  };
}

function themePlugin(store) {
  return class Theme extends UiPlugin {
    activate(g, bus) {
      const st = store.create({ mode: g.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }, g.document.root);
      this.st = st;
      this.addButton(g, 'Theme', 'theme');
      bus.tap('toolbar:action', this.meta.id, async (action) => {
        if (action !== 'theme') return undefined;
        await new Promise((r) => g.requestAnimationFrame(r));
        st.mode = st.mode === 'dark' ? 'light' : 'dark';
        g.storage.mode = st.mode;
        return 'mode=' + st.mode;
      });
      bus.tap('text:transform', this.meta.id, (t) => (st.mode === 'dark' ? t.toUpperCase() : t), 10);
      return 'theme ' + st.mode;
    }
  };
}

function exportPlugin(fmt, ev) {
  return class Exporter extends UiPlugin {
    activate(g, bus) {
      const btn = this.addButton(g, 'Export', 'export');
      btn.setAttribute('data-disabled', '1');
      bus.tap('toolbar:action', this.meta.id, (action, text) => {
        if (action !== 'export') return undefined;
        const lines = text.split(/(?<=[.!?])\s+/);
        const md = lines.map((l, i) => `${fmt.pad(i + 1, 2)}. ${fmt.title(l)}`).join(' / ');
        ev.emit(g.document.root, 'export:done', { lines: lines.length });
        return md;
      });
      bus.tap('text:transform', this.meta.id, (t) => t.trim(), 1);
      return 'export ready (disabled)';
    }
  };
}

function greedyPlugin() {
  return class Greedy extends PluginBase {
    activate(g) {
      const probes = [g.fetch, g.document.cookie, g.document.body, g.localStorage, g.eval];
      g.document.createElement('script');
      g.alert = () => 1;
      g.myFlag = 42;
      const keys = Object.keys(g).filter((k) => k !== 'storage');
      if (g.storage.x === undefined) g.storage.x = 1;
      if (probes.some((p) => p !== undefined)) throw new Error('escaped sandbox');
      return `greedy keys=${keys.length} myFlag=${g.myFlag} has(document)=${'document' in g} has(fetch)=${'fetch' in g}`;
    }
  };
}

// ------------------------------------------------------------------ host
class PluginHost extends EventTarget {
  #loader = new ModuleLoader();
  #bus = new HookBus();
  #plugins = new Map();
  #audit = [];
  constructor(toolbar) { super(); this.toolbar = toolbar; }
  get bus() { return this.#bus; }
  get audit() { return this.#audit.slice(); }
  get loader() { return this.#loader; }
  get plugins() { return this.#plugins; }

  async *install(manifests, features) {
    next: for (const man of manifests) {
      for (const req of man.requires ?? []) {
        if (!features[req]) { yield { id: man.id, status: 'skipped', info: 'missing feature ' + req }; continue next; }
      }
      let Cls;
      try {
        Cls = await this.#loader.load(man.module);
      } catch (e) {
        yield { id: man.id, status: 'load-failed', info: e instanceof LoadError ? e.reason + ' ' + e.id : 'unknown' };
        continue;
      }
      const mount = document.createElement('div');
      mount.className = 'plugin-slot';
      mount.setAttribute('data-slot', man.id);
      this.toolbar.appendChild(mount);
      const inst = new Cls(man);
      const g = createSandbox(man.id, mount, man.perms ?? [], this.#audit);
      let info;
      try {
        info = await inst.activate(g, this.#bus);
        inst._to('active');
      } catch (e) {
        inst._to('failed');
        info = 'activate threw: ' + (e instanceof Error && /sandbox/.test(e.message) ? 'sandbox violation' : 'error');
        this.#bus.untapAll(man.id);
      } finally {
        this.#plugins.set(man.id, inst);
      }
      this.dispatchEvent(new CustomEvent('installed', { detail: { id: man.id, state: inst.state } }));
      yield { id: man.id, status: inst.state, info };
    }
  }

  async uninstall(id) {
    const p = this.#plugins.get(id);
    if (!p) return 'absent';
    try {
      const removed = p.dispose();
      this.#bus.untapAll(id);
      this.toolbar.querySelector(`[data-slot="${id}"]`)?.remove();
      return 'removed buttons=' + (removed ?? 0);
    } finally {
      p._to('disposed');
      this.#plugins.delete(id);
    }
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const features = await detectFeatures();
  say('features:');
  for (const [k, v] of Object.entries(features)) say(`  ${k.padEnd(20)} ${v}`);

  const app = document.getElementById('app');
  let clicksSeen = 0;
  const shell = html`
    <section class="editor" data-ready="${true}">
      <h2>${'Notes & Plugins'}</h2>
      <div class="toolbar" id="toolbar" role="toolbar"></div>
      <textarea id="text" rows="${4}"></textarea>
      <p class="status" id="status">${['booting', ' ', '…']}</p>
      <button id="probe" on-click=${() => { clicksSeen++; }}>probe</button>
    </section>`;
  app.appendChild(shell);
  say('shell:', app.innerHTML.length, 'chars,', app.querySelectorAll('*').length, 'elements');
  say('outer h2:', app.querySelector('h2').outerHTML);
  document.getElementById('probe').click();
  document.getElementById('probe').click();
  say('probe handler clicks', clicksSeen);
  for (const bad of [['<div><span>', '</div>'], ['<p>', '']]) {
    try { html(bad, 'x'); say('no error?'); } catch (e) { say('template error:', e instanceof SyntaxError ? e.message : 'other'); }
  }

  const toolbar = document.getElementById('toolbar');
  const host = new PluginHost(toolbar);
  const installedEvents = [];
  host.addEventListener('installed', ({ detail: { id, state } }) => installedEvents.push(id + ':' + state));

  const manifests = [
    { id: 'wordcount', module: 'plugin/wordcount', perms: ['storage'] },
    { id: 'theme', module: 'plugin/theme', perms: ['storage'], requires: ['raf', 'localStorage'] },
    { id: 'export', module: 'plugin/export', perms: [] },
    { id: 'greedy', module: 'plugin/greedy', perms: [] },
    { id: 'observer', module: 'plugin/wordcount', requires: ['intersectionObserver'] },
    { id: 'cyclic', module: 'plugin/cyc-a' },
    { id: 'broken', module: 'plugin/broken' },
    { id: 'ghost', module: 'plugin/ghost' },
  ];
  say('install:');
  for await (const { id, status, info } of host.install(manifests, features)) say(`  ${id.padEnd(10)} ${status.padEnd(12)} ${info}`);
  say('loader fetches', host.loader.fetches);
  say('loader log', host.loader.log.join(' | '));
  say('installed events', installedEvents.join(' '));
  say('audit:');
  for (const line of host.audit) say('  ' + line);

  // delegated toolbar clicks: capture-phase guard blocks disabled buttons
  const results = [];
  const status = document.getElementById('status');
  const textArea = document.getElementById('text');
  textArea.value = '  hello   world.  Plugins are fun!   really fun?  ';
  toolbar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (btn?.getAttribute('data-disabled') === '1') {
      ev.stopPropagation();
      results.push('blocked ' + btn.dataset.action);
    }
  }, true);
  const pending = [];
  toolbar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const text = host.bus.waterfall('text:transform', textArea.value);
    pending.push(host.bus.parallelBail('toolbar:action', btn.dataset.action, text).then((r) => {
      results.push(`${btn.dataset.action} -> ${r ? r.pluginId + ': ' + r.v : 'no handler'}`);
      status.textContent = r ? String(r.v) : '';
    }));
  });
  const storeEvents = [];
  const exportEvents = [];
  app.addEventListener('store:set', (ev) => storeEvents.push(ev.detail.k + '=' + ev.detail.v));
  document.addEventListener('export:done', (ev) => exportEvents.push(ev.detail.lines));

  const clickAction = async (action) => {
    const b = toolbar.querySelector(`button[data-action="${action}"]`);
    if (!b) { results.push('no button ' + action); return; }
    b.click();
    await Promise.all(pending.splice(0));
  };
  say('actions:');
  for (const a of ['count', 'theme', 'count', 'export', 'theme']) await clickAction(a);
  toolbar.querySelector('button[data-action="export"]').removeAttribute('data-disabled');
  await clickAction('export');
  await clickAction('theme');
  await clickAction('export');
  for (const r of results) say('  ' + r);
  say('status text:', JSON.stringify(status.textContent));
  say('store events', storeEvents.join(','), 'export events', exportEvents.join(','));
  say('hook trace', host.bus.trace.length, host.bus.trace.slice(0, 6).join(' '));

  say('storage keys:');
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  for (const k of keys.sort()) say(`  ${k} = ${localStorage.getItem(k)}`);

  // plugin states + uninstall
  say('states:', [...host.plugins].map(([id, p]) => id + '=' + p.state).join(' '));
  for (const id of ['theme', 'greedy', 'nope', 'export']) say('uninstall', id, '->', await host.uninstall(id));
  say('buttons left:', [...toolbar.querySelectorAll('button')].map((b) => b.dataset.action).join(','));
  say('slots left:', [...toolbar.querySelectorAll('.plugin-slot')].map((s) => s.getAttribute('data-slot')).join(','));
  await clickAction('theme');
  await clickAction('count');
  say('after uninstall:', results.slice(-2).join(' ; '));

  // lazy re-load hits cache: second load of same module shares the promise
  const [a, b] = await Promise.all([host.loader.load('lib/format'), host.loader.load('lib/format')]);
  say('cached module identity', a === b, 'fetches', host.loader.fetches);
  const lazy = await host.loader.load('plugin/export');
  say('late load is class', typeof lazy === 'function', 'fetches', host.loader.fetches);

  // install again, streaming with an early break
  const again = host.install([
    { id: 'theme2', module: 'plugin/theme', perms: ['storage'] },
    { id: 'wc2', module: 'plugin/wordcount', perms: ['storage'] },
  ], features);
  for await (const r of again) { say('reinstall first only:', r.id, r.status, r.info); break; }
  say('final plugins:', [...host.plugins.keys()].join(','));
  say('final toolbar buttons:', toolbar.querySelectorAll('button').length);
}

main().then(() => say('done'), (e) => say('fatal', e instanceof Error ? e.message : String(e)));
