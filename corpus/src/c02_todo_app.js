// Todo-list app: builds its UI into #app with document.createElement, uses event delegation on
// the <ul> for toggle/delete/edit clicks, supports all/active/completed filters, keeps counts in
// a footer and persists the list to localStorage (JSON) so a second "session" can restore it.
'use strict';

const STORAGE_KEY = 'todos-v2';
const FILTERS = ['all', 'active', 'completed'];

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (key === 'className') node.className = val;
      else if (key === 'text') node.textContent = val;
      else if (key.startsWith('data-')) node.setAttribute(key, val);
      else if (key === 'checked') node.checked = !!val;
      else node.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function pluralize(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

class TodoStore {
  constructor(storage) {
    this.storage = storage;
    this.items = [];
    this.nextId = 1;
    this.listeners = [];
  }

  load() {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      this.items = data.items.map((it) => ({ id: it.id, title: it.title, done: !!it.done, tags: it.tags || [] }));
      this.nextId = data.nextId;
      return true;
    } catch (e) {
      console.log('store: corrupt data, resetting (' + e.name + ')');
      this.items = [];
      return false;
    }
  }

  save() {
    const payload = JSON.stringify({ nextId: this.nextId, items: this.items });
    this.storage.setItem(STORAGE_KEY, payload);
    return payload.length;
  }

  subscribe(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  emit(action) {
    const bytes = this.save();
    for (const l of this.listeners) l(action, bytes);
  }

  add(title) {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const tags = (trimmed.match(/#\w+/g) || []).map((t) => t.slice(1));
    const item = { id: this.nextId++, title: trimmed.replace(/\s*#\w+/g, ''), done: false, tags };
    this.items.push(item);
    this.emit({ type: 'add', id: item.id });
    return item;
  }

  toggle(id) {
    const item = this.find(id);
    if (!item) return;
    item.done = !item.done;
    this.emit({ type: 'toggle', id, done: item.done });
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.id !== id);
    if (this.items.length !== before) this.emit({ type: 'remove', id });
  }

  rename(id, title) {
    const item = this.find(id);
    if (item && title.trim()) {
      item.title = title.trim();
      this.emit({ type: 'rename', id });
    }
  }

  clearCompleted() {
    const removed = this.items.filter((it) => it.done).map((it) => it.id);
    this.items = this.items.filter((it) => !it.done);
    this.emit({ type: 'clear', removed });
    return removed;
  }

  toggleAll() {
    const allDone = this.items.every((it) => it.done);
    for (const it of this.items) it.done = !allDone;
    this.emit({ type: 'toggleAll', done: !allDone });
  }

  find(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  visible(filter) {
    if (filter === 'active') return this.items.filter((it) => !it.done);
    if (filter === 'completed') return this.items.filter((it) => it.done);
    return this.items.slice();
  }

  counts() {
    const done = this.items.filter((it) => it.done).length;
    return { total: this.items.length, done, left: this.items.length - done };
  }
}

class TodoView {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.filter = 'all';
    this.renders = 0;
    this.list = el('ul', { className: 'todo-list', id: 'todo-list' });
    this.footer = el('footer', { className: 'todo-footer' });
    this.input = el('input', { className: 'new-todo', placeholder: 'What needs to be done?' });
    root.appendChild(el('section', { className: 'todoapp' }, el('h1', { text: 'todos' }), this.input, this.list, this.footer));
    this.list.addEventListener('click', (ev) => this.onListClick(ev));
    this.list.addEventListener('dblclick', (ev) => this.onListDblClick(ev));
    this.footer.addEventListener('click', (ev) => this.onFooterClick(ev));
    this.input.addEventListener('keydown', (ev) => this.onInputKey(ev));
  }

  onInputKey(ev) {
    if (ev.key !== 'Enter') return;
    const item = this.store.add(this.input.value);
    console.log('  input Enter -> ' + (item ? 'added #' + item.id + ' "' + item.title + '" tags=' + item.tags.join('|') : 'ignored empty'));
    this.input.value = '';
  }

  onListClick(ev) {
    const li = ev.target.closest('li[data-id]');
    if (!li) return;
    const id = Number(li.dataset.id);
    const action = ev.target.dataset.action;
    console.log('  delegated click on <' + ev.target.localName + '> action=' + action + ' id=' + id + ' phase=' + ev.eventPhase);
    if (action === 'toggle') this.store.toggle(id);
    else if (action === 'destroy') this.store.remove(id);
  }

  onListDblClick(ev) {
    const li = ev.target.closest('li[data-id]');
    if (!li) return;
    const id = Number(li.dataset.id);
    const item = this.store.find(id);
    this.store.rename(id, item.title.toUpperCase() + '!');
  }

  onFooterClick(ev) {
    const f = ev.target.dataset.filter;
    if (f) {
      this.filter = f;
      console.log('  filter -> ' + f);
      this.render();
    } else if (ev.target.classList.contains('clear-completed')) {
      const removed = this.store.clearCompleted();
      console.log('  cleared ids ' + JSON.stringify(removed));
    }
  }

  renderItem(item) {
    const li = el('li', { 'data-id': String(item.id), className: item.done ? 'completed' : 'active' },
      el('input', { type: 'checkbox', className: 'toggle', 'data-action': 'toggle', checked: item.done }),
      el('label', { text: item.title, for: 'todo-' + slugify(item.title) }),
      item.tags.length ? el('span', { className: 'tags', text: item.tags.map((t) => '#' + t).join(' ') }) : null,
      el('button', { className: 'destroy', 'data-action': 'destroy', text: 'x' }));
    return li;
  }

  render() {
    this.renders++;
    this.list.textContent = '';
    const items = this.store.visible(this.filter);
    for (const item of items) this.list.appendChild(this.renderItem(item));
    const c = this.store.counts();
    this.footer.textContent = '';
    this.footer.appendChild(el('span', { className: 'todo-count', text: pluralize(c.left, 'item') + ' left' }));
    const ul = el('ul', { className: 'filters' });
    for (const f of FILTERS) ul.appendChild(el('li', null, el('a', { 'data-filter': f, className: f === this.filter ? 'selected' : '', text: f })));
    this.footer.appendChild(ul);
    if (c.done > 0) this.footer.appendChild(el('button', { className: 'clear-completed', text: 'Clear completed (' + c.done + ')' }));
    return items.length;
  }

  snapshot() {
    const rows = [];
    for (const li of this.list.children) {
      const box = li.querySelector('.toggle');
      rows.push((box.checked ? '[x] ' : '[ ] ') + li.querySelector('label').textContent);
    }
    return rows;
  }
}

function typeTodo(view, text) {
  view.input.value = text;
  view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function clickIn(view, id, selector) {
  const li = view.list.querySelector('li[data-id="' + id + '"]');
  if (!li) { console.log('  (no li for ' + id + ')'); return; }
  li.querySelector(selector).click();
}

function dump(view, label) {
  const c = view.store.counts();
  console.log(label + ' filter=' + view.filter + ' total=' + c.total + ' done=' + c.done + ' left=' + c.left + ' renders=' + view.renders);
  for (const row of view.snapshot()) console.log('    ' + row);
}

function main() {
  localStorage.clear();
  const app = document.getElementById('app');
  console.log('mount point:', app.id, app.dataset.page);

  const store = new TodoStore(localStorage);
  console.log('restored from storage:', store.load());
  const view = new TodoView(app, store);
  const log = [];
  store.subscribe((action, bytes) => { log.push(action.type); view.render(); console.log('  saved ' + bytes + ' bytes after ' + action.type); });
  view.render();

  ['Buy milk #shopping', 'Write thesis chapter #uni #writing', '   ', 'Call plumber', 'Refactor router #code'].forEach((t) => typeTodo(view, t));
  dump(view, 'after adds:');

  clickIn(view, 2, '.toggle');
  clickIn(view, 4, '.toggle');
  dump(view, 'after toggles:');

  const footerLink = view.footer.querySelector('a[data-filter="active"]');
  footerLink.click();
  dump(view, 'active view:');
  view.footer.querySelector('a[data-filter="completed"]').click();
  dump(view, 'completed view:');
  view.footer.querySelector('a[data-filter="all"]').click();

  const label = view.list.querySelector('li[data-id="3"] label');
  label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  clickIn(view, 1, '.destroy');
  dump(view, 'after rename+destroy:');

  view.footer.querySelector('.clear-completed').click();
  dump(view, 'after clear:');
  store.toggleAll();
  dump(view, 'after toggleAll:');

  console.log('action log:', log.join(','));
  const saved = localStorage.getItem(STORAGE_KEY);
  console.log('storage keys:', localStorage.length, 'raw length:', saved.length);

  const store2 = new TodoStore(localStorage);
  console.log('second session restored:', store2.load(), 'nextId=' + store2.nextId);
  console.log('restored titles:', store2.items.map((i) => i.title + (i.done ? '*' : '')).join(' / '));
  localStorage.setItem(STORAGE_KEY, '{broken');
  const store3 = new TodoStore(localStorage);
  console.log('third session restored:', store3.load(), 'items=' + store3.items.length);
  console.log('html size:', app.innerHTML.length, 'li count:', app.querySelectorAll('li[data-id]').length);
}

main();
