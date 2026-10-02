// Offline-first notes app: notes live in localStorage (with a schema migration from a legacy format),
// every mutation goes into a persisted sync queue that coalesces operations per note; a simulated
// remote server (latency in animation frames, offline/transient failures) receives the queue with
// optimistic-concurrency revisions, and 409 conflicts are resolved by a three-way merge (title by
// Lamport clock, body line-by-line with conflict markers, tags as set operations). Remote changes are
// pulled through an async generator; another tab is simulated with StorageEvents. The UI is rendered
// from a Proxy-based store through a tagged-template DOM builder, with delegated click handling.
'use strict';

const out = (...a) => console.log(a.join(' '));
const frame = () => new Promise((r) => requestAnimationFrame(r));
async function waitFrames(n) { for (let i = 0; i < n; i++) await frame(); }

class NetError extends Error {
  constructor(code) { super('network ' + code); this.code = code; }
}

// ---------------------------------------------------------------- tagged template -> DOM
const tplCache = new WeakMap();
function parseTemplate(strings) {
  let src = strings[0];
  for (let i = 1; i < strings.length; i++) src += '\u0001' + (i - 1) + '\u0002' + strings[i];
  const root = { children: [] };
  const stack = [root];
  const re = /<(\/?)([a-z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const [, close, tag, attrSrc, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      for (const part of text.split(/(\u0001\d+\u0002)/)) {
        const hole = /^\u0001(\d+)\u0002$/.exec(part);
        if (hole) top.children.push({ hole: +hole[1] });
        else if (part.trim()) top.children.push({ text: part.replace(/\s+/g, ' ') });
      }
    } else if (close) stack.pop();
    else {
      const attrs = [...attrSrc.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, k, v = '']) => [k, v]);
      const node = { tag, attrs, children: [] };
      top.children.push(node);
      if (!selfClose && !['input', 'br', 'hr'].includes(tag)) stack.push(node);
    }
  }
  return root.children;
}
function view(strings, ...values) {
  let parsed = tplCache.get(strings);
  if (!parsed) { parsed = parseTemplate(strings); tplCache.set(strings, parsed); }
  const fill = (s) => s.replace(/\u0001(\d+)\u0002/g, (_, i) => String(values[+i] ?? ''));
  const build = (spec, parent) => {
    if (spec.text !== undefined) return parent.appendChild(document.createTextNode(spec.text));
    if (spec.hole !== undefined) {
      const v = values[spec.hole];
      for (const item of [v].flat(Infinity)) {
        if (item == null || item === false) continue;
        parent.appendChild(item instanceof Node ? item : document.createTextNode(String(item)));
      }
      return null;
    }
    const el = document.createElement(spec.tag);
    for (const [k, v] of spec.attrs) {
      const val = fill(v);
      if (/^\u0001\d+\u0002$/.test(v) && (values[+v.slice(1, -1)] === false || values[+v.slice(1, -1)] == null)) continue;
      el.setAttribute(k, val);
    }
    for (const c of spec.children) build(c, el);
    return parent.appendChild(el);
  };
  const frag = document.createDocumentFragment();
  for (const spec of parsed) build(spec, frag);
  return frag.childNodes.length === 1 ? frag.firstChild : frag;
}

// ---------------------------------------------------------------- local persistence
class LocalStore {
  #ns; #area;
  constructor(ns, area = localStorage) { this.#ns = ns; this.#area = area; }
  key(k) { return this.#ns + ':' + k; }
  read(k, fallback = null) {
    const rawVal = this.#area.getItem(this.key(k));
    if (rawVal === null) return fallback;
    try { return JSON.parse(rawVal); } catch { return fallback; }
  }
  write(k, v) { this.#area.setItem(this.key(k), JSON.stringify(v)); }
  remove(k) { this.#area.removeItem(this.key(k)); }
  *keys(prefix = '') {
    for (let i = 0; i < this.#area.length; i++) {
      const k = this.#area.key(i);
      if (k.startsWith(this.#ns + ':' + prefix)) yield k.slice(this.#ns.length + 1);
    }
  }
}

const MIGRATIONS = {
  1: (store) => {
    const legacy = JSON.parse(localStorage.getItem('notes_legacy') || '[]');
    for (const [i, { t, b, tags = '' }] of legacy.entries()) {
      const id = 'legacy-' + (i + 1);
      store.write('note:' + id, { id, title: t, body: b, tags: tags.split(',').filter(Boolean), rev: 0, clock: 0, device: 'legacy', deleted: false, pinned: false });
    }
    localStorage.removeItem('notes_legacy');
    return legacy.length;
  },
  2: (store) => {
    let n = 0;
    for (const k of [...store.keys('note:')]) {
      const note = store.read(k);
      if (!('pinned' in note)) continue;
      note.flags = note.pinned ? ['pinned'] : [];
      delete note.pinned;
      store.write(k, note);
      n++;
    }
    return n;
  },
};
function migrate(store) {
  let version = store.read('schema', 0);
  const log = [];
  while (MIGRATIONS[version + 1]) {
    const touched = MIGRATIONS[version + 1](store);
    version++;
    log.push('v' + version + '(' + touched + ')');
  }
  store.write('schema', version);
  return log;
}

// ---------------------------------------------------------------- three-way merge
function mergeLines(base, mine, theirs) {
  if (mine === base) return { text: theirs, conflicts: 0 };
  if (theirs === base || mine === theirs) return { text: mine, conflicts: 0 };
  const [b, m, t] = [base, mine, theirs].map((s) => s.split('\n'));
  const outLines = [];
  let conflicts = 0;
  lines: for (let i = 0; i < Math.max(b.length, m.length, t.length); i++) {
    const [bl, ml, tl] = [b[i], m[i], t[i]];
    switch (true) {
      case ml === tl: if (ml !== undefined) outLines.push(ml); continue lines;
      case ml === bl: if (tl !== undefined) outLines.push(tl); continue lines;
      case tl === bl: if (ml !== undefined) outLines.push(ml); continue lines;
    }
    conflicts++;
    outLines.push('<<<<<<< mine', ml ?? '', '=======', tl ?? '', '>>>>>>> theirs');
  }
  return { text: outLines.join('\n'), conflicts };
}
function merge3(base, mine, theirs) {
  const winner = mine.clock > theirs.clock || (mine.clock === theirs.clock && mine.device > theirs.device) ? mine : theirs;
  const title = mine.title === base.title ? theirs.title : theirs.title === base.title ? mine.title : winner.title;
  const { text: body, conflicts } = mergeLines(base.body, mine.body, theirs.body);
  const added = mine.tags.filter((t) => !base.tags.includes(t));
  const removed = base.tags.filter((t) => !mine.tags.includes(t));
  const tags = [...new Set([...theirs.tags, ...added])].filter((t) => !removed.includes(t)).sort();
  return { ...theirs, title, body, tags, clock: Math.max(mine.clock, theirs.clock) + 1, conflicts };
}

// ---------------------------------------------------------------- remote server simulation
class RemoteServer {
  #docs = new Map();
  #log = [];
  #seq = 0;
  constructor() { this.online = true; this.latency = 1; this.failNext = 0; this.requests = 0; }
  async request(method, payload) {
    this.requests++;
    await waitFrames(this.latency);
    if (!this.online) throw new NetError('offline');
    if (this.failNext > 0) { this.failNext--; throw new NetError('transient'); }
    return this[method](structuredClone(payload));
  }
  #record(doc) { this.#log.push({ seq: ++this.#seq, doc: structuredClone(doc) }); }
  put({ note, baseRev }) {
    const cur = this.#docs.get(note.id);
    if (cur && cur.rev !== baseRev) return { status: 409, current: structuredClone(cur) };
    const doc = { ...note, rev: (cur?.rev ?? 0) + 1 };
    this.#docs.set(note.id, doc);
    this.#record(doc);
    return { status: 200, rev: doc.rev };
  }
  remove({ id, baseRev }) {
    const cur = this.#docs.get(id);
    if (!cur) return { status: 404 };
    if (cur.rev !== baseRev) return { status: 409, current: structuredClone(cur) };
    const doc = { ...cur, deleted: true, rev: cur.rev + 1 };
    this.#docs.set(id, doc);
    this.#record(doc);
    return { status: 200, rev: doc.rev };
  }
  changes({ since, limit }) {
    const items = this.#log.filter((e) => e.seq > since).slice(0, limit);
    return { items: items.map((e) => e.doc), next: items.length ? items[items.length - 1].seq : since, more: this.#log.some((e) => e.seq > (items[items.length - 1]?.seq ?? since)) };
  }
  // "another device" editing directly on the server
  externalEdit(id, fn) {
    const cur = this.#docs.get(id);
    const doc = { ...fn(structuredClone(cur)), rev: cur.rev + 1 };
    this.#docs.set(id, doc);
    this.#record(doc);
    return doc.rev;
  }
  externalCreate(note) { const doc = { ...note, rev: 1 }; this.#docs.set(note.id, doc); this.#record(doc); }
  summary() { return [...this.#docs.values()].map((d) => d.title + '@' + d.rev + (d.deleted ? 'x' : '')).sort().join(' '); }
}

// ---------------------------------------------------------------- repository + sync queue
class Repository extends EventTarget {
  #clock = 0;
  constructor(device) { super(); this.device = device; }
  tick(seen = 0) { this.#clock = Math.max(this.#clock, seen) + 1; return this.#clock; }
  get clock() { return this.#clock; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

class NotesRepo extends Repository {
  #store; #queue; #server; #flushing = false; #bases = new Map();
  constructor(store, server, device) {
    super(device);
    this.#store = store;
    this.#server = server;
    this.#queue = store.read('queue', []);
    this.cursor = store.read('cursor', 0);
    this.stats = { pushed: 0, conflicts: 0, retries: 0, coalesced: 0, pulled: 0, skipped: 0 };
  }
  get queue() { return this.#queue; }
  all() { return [...this.#store.keys('note:')].map((k) => this.#store.read(k)).filter((n) => n && !n.deleted); }
  get(id) { return this.#store.read('note:' + id); }
  #save(note) { this.#store.write('note:' + note.id, note); }
  #persistQueue() { this.#store.write('queue', this.#queue); }
  create({ title, body = '', tags = [] }) {
    const id = crypto.randomUUID();
    const note = { id, title, body, tags: [...tags].sort(), rev: 0, clock: this.tick(), device: this.device, deleted: false, flags: [] };
    this.#save(note);
    this.#enqueue({ type: 'put', id, baseRev: 0 });
    this.emit('notes:changed', { id, kind: 'create' });
    return note;
  }
  update(id, patch) {
    const cur = this.get(id);
    if (!cur || cur.deleted) return null;
    if (!this.#bases.has(id)) this.#bases.set(id, structuredClone(cur));
    const next = { ...cur, ...patch, clock: this.tick(cur.clock), device: this.device };
    if (patch.tags) next.tags = [...patch.tags].sort();
    this.#save(next);
    this.#enqueue({ type: 'put', id, baseRev: cur.rev });
    this.emit('notes:changed', { id, kind: 'update' });
    return next;
  }
  remove(id) {
    const cur = this.get(id);
    if (!cur) return false;
    this.#save({ ...cur, deleted: true, clock: this.tick(cur.clock) });
    this.#enqueue({ type: 'remove', id, baseRev: cur.rev });
    this.emit('notes:changed', { id, kind: 'remove' });
    return true;
  }
  #enqueue(op) {
    const idx = this.#queue.findIndex((q) => q.id === op.id);
    if (idx >= 0) {
      const prev = this.#queue[idx];
      this.stats.coalesced++;
      if (op.type === 'remove' && prev.type === 'put' && prev.baseRev === 0) {
        this.#queue.splice(idx, 1);
        this.#store.remove('note:' + op.id);
      } else this.#queue[idx] = { ...op, baseRev: prev.baseRev };
    } else this.#queue.push(op);
    this.#persistQueue();
  }
  async flush() {
    if (this.#flushing) return 'busy';
    this.#flushing = true;
    let pushed = 0;
    try {
      drain: while (this.#queue.length) {
        const op = this.#queue[0];
        const note = this.get(op.id);
        let res;
        for (let attempt = 1; ; attempt++) {
          try {
            res = op.type === 'put' ? await this.#server.request('put', { note, baseRev: op.baseRev }) : await this.#server.request('remove', { id: op.id, baseRev: op.baseRev });
            break;
          } catch (err) {
            if (!(err instanceof NetError) || err.code === 'offline' || attempt >= 3) { out('  flush stopped:', err instanceof NetError ? err.code : 'error', 'attempt', attempt); break drain; }
            this.stats.retries++;
            await waitFrames(2 ** attempt);
          }
        }
        switch (res.status) {
          case 200:
          case 404:
            this.#queue.shift();
            if (note && res.rev) this.#save({ ...this.get(op.id), rev: res.rev });
            this.#bases.delete(op.id);
            pushed++;
            break;
          case 409: {
            this.stats.conflicts++;
            const theirs = res.current;
            const base = this.#bases.get(op.id) ?? { ...theirs, body: '', tags: [], title: '' };
            if (op.type === 'remove') { this.#queue.shift(); this.#save(theirs); out('  conflict: remote edit resurrects', op.id.slice(0, 8)); continue drain; }
            const merged = merge3(base, note, theirs);
            this.tick(merged.clock);
            this.#save({ ...merged, rev: theirs.rev });
            this.#bases.set(op.id, structuredClone(theirs));
            this.#queue[0] = { type: 'put', id: op.id, baseRev: theirs.rev };
            this.emit('notes:conflict', { id: op.id, conflicts: merged.conflicts, title: merged.title });
            continue drain;
          }
        }
      }
    } finally {
      this.#flushing = false;
      this.stats.pushed += pushed;
      this.#persistQueue();
    }
    this.emit('notes:synced', { pushed, pending: this.#queue.length });
    return pushed;
  }
  async *pull(pageSize = 2) {
    let more = true;
    while (more) {
      const page = await this.#server.request('changes', { since: this.cursor, limit: pageSize });
      more = page.more;
      this.cursor = page.next;
      this.#store.write('cursor', this.cursor);
      yield page.items;
    }
  }
  applyRemote(doc) {
    if (this.#queue.some((q) => q.id === doc.id)) { this.stats.skipped++; return 'pending'; }
    const cur = this.get(doc.id);
    if (cur && cur.rev >= doc.rev) return 'stale';
    this.tick(doc.clock);
    this.#save(doc);
    this.stats.pulled++;
    return cur ? (doc.deleted ? 'deleted' : 'updated') : 'new';
  }
}

// ---------------------------------------------------------------- reactive UI store
function createStore(initial, onChange) {
  const handler = (path) => ({
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      return v && typeof v === 'object' ? new Proxy(v, handler(path.concat(String(k)))) : v;
    },
    set(t, k, v, r) {
      const old = t[k];
      const ok = Reflect.set(t, k, v, r);
      if (old !== v) onChange(path.concat(String(k)).join('.'));
      return ok;
    },
    deleteProperty(t, k) { const ok = Reflect.deleteProperty(t, k); onChange(path.concat(String(k)).join('.')); return ok; },
  });
  return new Proxy(initial, handler([]));
}

// ---------------------------------------------------------------- app wiring
localStorage.setItem('notes_legacy', JSON.stringify([
  { t: 'Groceries', b: 'milk\neggs\nbread', tags: 'home,shopping' },
  { t: 'Ideas', b: 'offline sync\nconflict ui' },
]));
const store = new LocalStore('notes');
out('migrations:', migrate(store).join(' ') || 'none', '| schema', store.read('schema'));

const server = new RemoteServer();
const repo = new NotesRepo(store, server, 'laptop');
for (const n of repo.all()) repo.update(n.id, { body: n.body });

const renders = [];
let renderQueued = false;
const dirtyPaths = new Set();
const ui = createStore({ filter: { tag: null, query: '' }, selected: null, status: 'idle', banner: '' }, (path) => {
  dirtyPaths.add(path);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderList([...dirtyPaths].sort()); dirtyPaths.clear(); });
});

const appRoot = document.getElementById('app');
const listEl = view`<ul class="notes" role="list"></ul>`;
const statusEl = view`<p class="status" aria-live="polite">${'idle'}</p>`;
appRoot.append(statusEl, listEl);

function tokens(s) { return (s.toLowerCase().match(/[a-z0-9]+/g) || []); }
function visibleNotes() {
  const { tag, query } = ui.filter;
  const q = tokens(query);
  return repo.all()
    .filter((n) => !tag || n.tags.includes(tag))
    .filter((n) => q.every((w) => tokens(n.title + ' ' + n.body).some((t) => t.startsWith(w))))
    .sort((a, b) => (b.flags?.includes('pinned') ? 1 : 0) - (a.flags?.includes('pinned') ? 1 : 0) || a.title.localeCompare(b.title));
}
function renderList(paths) {
  const notes = visibleNotes();
  const pending = new Set(repo.queue.map((q) => q.id));
  listEl.replaceChildren(...notes.map((n) => view`
    <li class="note" data-id="${n.id}" aria-selected="${ui.selected === n.id}">
      <span class="title">${n.title}</span>
      <span class="tags">${n.tags.map((t) => view`<button class="tag" data-tag="${t}">#${t}</button>`)}</span>
      ${pending.has(n.id) ? view`<em class="dirty">*</em>` : null}
      <button class="pin" data-action="pin">pin</button>
      <button class="del" data-action="del">x</button>
    </li>`));
  statusEl.textContent = ui.status + (ui.banner ? ' - ' + ui.banner : '');
  renders.push(paths.join(','));
  out('  render[' + renders.length + '] (' + paths.join(',') + '):', notes.map((n) => n.title + (pending.has(n.id) ? '*' : '') + (n.flags?.includes('pinned') ? '^' : '')).join(' | ') || '(empty)');
}

// delegated interactions: capture blocks everything while syncing, bubble handles actions
listEl.addEventListener('click', (ev) => {
  if (ui.status === 'syncing') { ev.stopPropagation(); ev.preventDefault(); out('  click ignored while syncing'); }
}, true);
listEl.addEventListener('click', (ev) => {
  const item = ev.target.closest('li.note');
  if (!item) return;
  const id = item.getAttribute('data-id');
  const action = ev.target.closest('[data-action]')?.getAttribute('data-action');
  const tag = ev.target.closest('[data-tag]')?.getAttribute('data-tag');
  if (tag) { ui.filter.tag = ui.filter.tag === tag ? null : tag; return; }
  if (action === 'del') { repo.remove(id); if (ui.selected === id) ui.selected = null; return; }
  if (action === 'pin') {
    const note = repo.get(id);
    const flags = note.flags.includes('pinned') ? note.flags.filter((f) => f !== 'pinned') : [...note.flags, 'pinned'];
    repo.update(id, { flags });
    return;
  }
  ui.selected = id;
});
appRoot.addEventListener('click', () => { out('  app root saw bubbled click'); });

repo.addEventListener('notes:changed', ({ detail }) => { ui.banner = detail.kind + ' ' + repo.get(detail.id)?.title; });
repo.addEventListener('notes:conflict', ({ detail: { id, conflicts, title } }) => out('  conflict merged:', JSON.stringify(title), 'line conflicts', conflicts, 'id', id.slice(0, 8)));
repo.addEventListener('notes:synced', ({ detail }) => out('  synced: pushed', detail.pushed, 'pending', detail.pending));

window.addEventListener('online', () => { server.online = true; ui.status = 'online'; void syncNow(); });
window.addEventListener('offline', () => { server.online = false; ui.status = 'offline'; });
window.addEventListener('storage', (ev) => {
  const m = /^notes:note:(.+)$/.exec(ev.key ?? '');
  if (!m) return;
  const incoming = JSON.parse(ev.newValue);
  out('  storage event from other tab:', incoming.title, 'rev', incoming.rev);
  ui.banner = 'other tab edited ' + incoming.title;
});

async function syncNow() {
  if (ui.status === 'syncing') return 'busy';
  ui.status = 'syncing';
  try {
    const pushed = await repo.flush();
    let pages = 0;
    for await (const items of repo.pull(2)) {
      pages++;
      const results = items.map((doc) => doc.title + ':' + repo.applyRemote(doc));
      out('  pull page', pages, '->', results.join(', ') || '(none)');
      if (pages >= 5) break;
    }
    return pushed;
  } finally {
    ui.status = server.online ? 'online' : 'offline';
  }
}

const clickOn = (selector, noteTitle) => {
  const li = [...listEl.querySelectorAll('li.note')].find((x) => x.querySelector('.title').textContent === noteTitle);
  const target = selector ? li?.querySelector(selector) : li?.querySelector('.title');
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return !!target;
};
const byTitle = (t) => repo.all().find((n) => n.title === t);
const queueSummary = () => repo.queue.map((q) => q.type + ':' + (repo.get(q.id)?.title ?? q.id.slice(0, 6)) + '@' + q.baseRev).join(' ') || '(empty)';

async function waitIdle() {
  let n = 0;
  while (ui.status === 'syncing') { await frame(); n++; }
  out('  (sync settled after', n, 'frames)');
}

async function main() {
  out('booted notes:', repo.all().map((n) => n.title + '[' + n.tags.join(',') + ']').join(' '), '| queue', queueSummary());
  await syncNow();
  out('server:', server.summary());
  await frame();

  window.dispatchEvent(new Event('offline'));
  const todo = repo.create({ title: 'Todo', body: 'call bank\nfix bike', tags: ['home'] });
  const draft = repo.create({ title: 'Draft', body: 'temp' });
  repo.update(todo.id, { body: 'call bank\nfix bike\nwater plants' });
  repo.update(draft.id, { body: 'temp 2' });
  repo.remove(draft.id);
  repo.update(byTitle('Groceries').id, { body: 'milk\noat milk\nbread', tags: ['home', 'shopping', 'weekly'] });
  repo.update(byTitle('Ideas').id, { title: 'Ideas (laptop)', body: 'offline sync\nconflict ui\nexport pdf' });
  out('offline queue:', queueSummary(), '| coalesced', repo.stats.coalesced);
  out('offline flush:', await repo.flush());
  await frame();

  server.externalEdit(byTitle('Groceries').id, (d) => ({ ...d, body: 'milk\nsoy milk\nrye bread', tags: ['shopping', 'bakery'], clock: 50, device: 'phone' }));
  server.externalEdit(byTitle('Ideas (laptop)').id, (d) => ({ ...d, title: 'Ideas (phone)', body: 'offline sync\nconflict ui', clock: 1, device: 'phone' }));
  server.externalCreate({ id: 'phone-note-1', title: 'Phone memo', body: 'from phone', tags: ['mobile'], clock: 60, device: 'phone', deleted: false, flags: [] });
  server.externalCreate({ id: 'phone-note-2', title: 'Parking', body: 'level 3', tags: [], clock: 61, device: 'phone', deleted: false, flags: [] });
  server.failNext = 2;
  window.dispatchEvent(new Event('online'));
  await waitIdle();
  const groceries = byTitle('Groceries');
  out('groceries body:', JSON.stringify(groceries.body), 'tags', groceries.tags.join(','), 'rev', groceries.rev);
  out('ideas title:', byTitle('Ideas (laptop)') ? 'laptop wins' : byTitle('Ideas (phone)') ? 'phone wins' : '?', '| body', JSON.stringify((byTitle('Ideas (laptop)') ?? byTitle('Ideas (phone)')).body));
  out('server:', server.summary());
  out('stats:', JSON.stringify(repo.stats), 'requests', server.requests, 'clock', repo.clock);

  await frame();
  clickOn(null, 'Todo');
  await frame();
  clickOn('.pin', 'Todo');
  await frame();
  clickOn('[data-tag=shopping]', 'Groceries');
  await frame();
  clickOn('[data-tag=shopping]', 'Groceries');
  ui.filter.query = 'ban';
  await frame();
  ui.filter.query = '';
  await frame();
  out('delete clicked:', clickOn('.del', 'Parking'));
  await frame();
  const syncing = syncNow();
  out('click during sync dispatched:', clickOn(null, 'Phone memo'), '| selected', repo.get(ui.selected)?.title);
  out('second sync call:', await syncNow());
  await syncing;
  await waitIdle();

  const memo = byTitle('Phone memo');
  const otherTab = { ...memo, title: 'Phone memo (tab 2)', rev: memo.rev };
  const oldValue = localStorage.getItem(store.key('note:' + memo.id));
  localStorage.setItem(store.key('note:' + memo.id), JSON.stringify(otherTab));
  window.dispatchEvent(new StorageEvent('storage', { key: store.key('note:' + memo.id), oldValue, newValue: JSON.stringify(otherTab), storageArea: localStorage }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: '1' }));
  await frame();
  out('ui status:', statusEl.textContent);
  const keys = [...store.keys()].map((k) => k.replace(/note:[0-9a-f-]{36}/, 'note:<uuid>')).sort();
  out('local keys:', keys.length, [...new Set(keys)].join(' '));
  out('queue after all:', queueSummary(), '| cursor', repo.cursor, '| renders', renders.length);
  out('dom:', listEl.children.length, 'items,', listEl.querySelectorAll('.dirty').length, 'dirty,', listEl.querySelectorAll('button.tag').length, 'tag buttons,',
    listEl.querySelectorAll('[aria-selected=true]').length, 'selected');
  const first = listEl.firstElementChild;
  out('first item:', first.getAttribute('data-id').length, 'char id,', first.querySelector('.title').textContent, first.textContent.replace(/\s+/g, ' ').trim());
}

main().then(() => out('done'));
