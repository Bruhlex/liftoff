// Accessibility tree builder + keyboard focus manager. The page is declared with an indentation
// based `view` tagged template (emmet-like lines -> DOM). Widget state lives in an auto-tracking
// Proxy store whose effects write ARIA attributes. A hand-written snapshot/diff mutation
// recorder (no MutationObserver in this environment) notices those DOM changes on the next
// animation frame and the accessibility tree is rebuilt and diffed. A focus manager implements
// Tab order, focus traps for modal dialogs, roving tabindex (toolbar, tabs, menu with typeahead,
// tree with expand/collapse) and a polite live region fed through an async generator.
'use strict';

const say = (...a) => console.log(a.join(' '));
const frame = () => new Promise((r) => requestAnimationFrame(r));
async function settle(n = 3) { for (let i = 0; i < n; i++) await frame(); }

// ------------------------------------------------------------------ view`` template
const LINE_RE = /^( *)([a-z][\w-]*)((?:[.#][\w-]+)*)((?:\[[^\]]*\])*)(?: +(.*))?$/;
const BRACKET_RE = /\[([\w-]+)(?:=([^\]]*))?\]/g;
const SHORT_RE = /([.#])([\w-]+)/g;

function view(strings, ...vals) {
  const src = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ''), '');
  const frag = document.createDocumentFragment();
  const stack = [{ indent: -1, el: frag }];
  let lineNo = 0;
  for (const raw of src.split('\n')) {
    lineNo++;
    if (!raw.trim()) continue;
    const m = LINE_RE.exec(raw);
    if (!m) throw new Error('view: bad line ' + lineNo);
    const [, spaces, tag, shorts, brackets, text] = m;
    const el = document.createElement(tag);
    const classes = [];
    for (const [, kind, val] of shorts.matchAll(SHORT_RE)) kind === '#' ? el.setAttribute('id', val) : classes.push(val);
    if (classes.length) el.setAttribute('class', classes.join(' '));
    for (const [, k, v] of brackets.matchAll(BRACKET_RE)) el.setAttribute(k, v ?? '');
    if (text) el.appendChild(document.createTextNode(text));
    while (stack[stack.length - 1].indent >= spaces.length) stack.pop();
    stack[stack.length - 1].el.appendChild(el);
    stack.push({ indent: spaces.length, el });
  }
  return frag;
}

const primaryLabel = 'Primary';
for (const el of [...document.body.children]) if (el.id !== 'app') el.remove();
document.getElementById('app').replaceChildren(view`
header
  nav[aria-label=${primaryLabel}]
    ul
      li
        a[href=/] Home
      li
        a[href=/docs][aria-current=page] Docs
main#main
  h1 Settings
  div#tb[role=toolbar][aria-label=Formatting]
    button[data-cmd=bold][aria-pressed=false] Bold
    button[data-cmd=italic][aria-pressed=false] Italic
    button[data-cmd=underline][disabled] Underline
    button[data-cmd=link] Link
  div.tabs
    div#tablist[role=tablist][aria-label=Sections]
      button#tab-general[role=tab][aria-controls=panel-general] General
      button#tab-privacy[role=tab][aria-controls=panel-privacy] Privacy
      button#tab-advanced[role=tab][aria-controls=panel-advanced] Advanced
    div#panel-general[role=tabpanel][aria-labelledby=tab-general]
      label[for=nick] Nickname
      input#nick[type=text][aria-describedby=nick-hint]
      span#nick-hint Shown to other users
      input#notify[type=checkbox][aria-label=Email notifications]
    div#panel-privacy[role=tabpanel][aria-labelledby=tab-privacy]
      input#tracking[type=checkbox][title=Share usage data]
      a[href=/privacy] Privacy policy
    div#panel-advanced[role=tabpanel][aria-labelledby=tab-advanced]
      button#reset[aria-describedby=reset-warn] Reset all
      span#reset-warn[style=display: none] Cannot be undone
  button#menu-btn[aria-haspopup=menu][aria-controls=menu1] Actions
  ul#menu1[role=menu][aria-label=Actions]
    li[role=menuitem] Duplicate
    li[role=menuitem] Delete
    li[role=menuitem] Download
    li[role=menuitem][aria-disabled=true] Share
  ul#files[role=tree][aria-label=Files]
    li[role=treeitem][data-node=src] src
      ul[role=group]
        li[role=treeitem][data-node=index] index.js
        li[role=treeitem][data-node=lib] lib
          ul[role=group]
            li[role=treeitem][data-node=a] a.js
            li[role=treeitem][data-node=b] b.js
    li[role=treeitem][data-node=readme] README
  button#open-dialog Open dialog
  div#dlg[role=dialog][aria-modal=true][aria-labelledby=dlg-title]
    h2#dlg-title Confirm
    p Discard changes?
    button#dlg-cancel Cancel
    button#dlg-ok[tabindex=0] OK
  div#live[aria-live=polite][aria-label=Announcements]
footer
  a[href=/help][tabindex=1] Help
`);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ auto-tracking reactive store
const depsByKey = new Map();
const proxies = new WeakMap();
let currentEffect = null;
const pendingEffects = new Set();
let flushQueued = false;
let effectRuns = 0;

function track(key) {
  if (!currentEffect) return;
  if (!depsByKey.has(key)) depsByKey.set(key, new Set());
  depsByKey.get(key).add(currentEffect);
}
function trigger(key) {
  for (const eff of depsByKey.get(key) || []) pendingEffects.add(eff);
  if (pendingEffects.size && !flushQueued) { flushQueued = true; queueMicrotask(flushEffects); }
}
function flushEffects() {
  flushQueued = false;
  for (let guard = 0; pendingEffects.size && guard < 10; guard++) {
    const batch = [...pendingEffects];
    pendingEffects.clear();
    for (const eff of batch) eff();
  }
}
function store(obj, prefix = '') {
  if (proxies.has(obj)) return proxies.get(obj);
  const p = new Proxy(obj, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      track(prefix + k);
      const v = t[k];
      return v && typeof v === 'object' ? store(v, prefix + k + '.') : v;
    },
    set(t, k, v) {
      if (t[k] === v) return true;
      t[k] = v;
      trigger(prefix + String(k));
      return true;
    },
  });
  proxies.set(obj, p);
  return p;
}
function effect(fn) {
  const run = () => {
    const prev = currentEffect;
    currentEffect = run;
    effectRuns++;
    try { fn(); } finally { currentEffect = prev; }
  };
  run();
  return run;
}

const ui = store({ tab: 0, pressed: { bold: false, italic: false }, menuOpen: false, dialogOpen: false, expanded: { src: true, lib: false } });

effect(() => {
  $$('[role=tab]').forEach((tab, i) => {
    const sel = i === ui.tab;
    tab.setAttribute('aria-selected', String(sel));
    $('#' + tab.getAttribute('aria-controls')).hidden = !sel;
  });
});
effect(() => {
  for (const b of $$('#tb [aria-pressed]')) b.setAttribute('aria-pressed', String(!!ui.pressed[b.dataset.cmd]));
});
effect(() => {
  $('#menu1').hidden = !ui.menuOpen;
  $('#menu-btn').setAttribute('aria-expanded', String(ui.menuOpen));
});
effect(() => { $('#dlg').hidden = !ui.dialogOpen; });
effect(() => {
  for (const item of $$('[role=treeitem]')) {
    const key = item.dataset.node;
    if ($('[role=group]', item)) item.setAttribute('aria-expanded', String(!!ui.expanded[key]));
  }
});

// ------------------------------------------------------------------ manual mutation recorder
let nodeSeq = 0;
const nodeIds = new WeakMap();
const idOf = (n) => { if (!nodeIds.has(n)) nodeIds.set(n, ++nodeSeq); return nodeIds.get(n); };

class MutationRecorder {
  #root;
  #snap = new Map();
  #callback;
  #scheduled = false;
  #batches = 0;
  constructor(callback) { this.#callback = callback; }
  static snapshotOf(el) {
    const attrs = new Map(el.getAttributeNames().map((n) => [n, el.getAttribute(n)]));
    const kids = [...el.childNodes].filter((k) => k.nodeType === 1).map(idOf);
    const text = [...el.childNodes].filter((k) => k.nodeType === 3).map((k) => k.data).join('');
    return { el, attrs, kids, text };
  }
  #collect() {
    const snap = new Map();
    const walk = (el) => { snap.set(idOf(el), MutationRecorder.snapshotOf(el)); for (const c of el.children) walk(c); };
    walk(this.#root);
    return snap;
  }
  observe(root) { this.#root = root; this.#snap = this.#collect(); }
  get batches() { return this.#batches; }
  schedule() {
    if (this.#scheduled || !this.#root) return;
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      const recs = this.takeRecords();
      if (recs.length) { this.#batches++; this.#callback(recs); }
    });
  }
  takeRecords() {
    const next = this.#collect();
    const records = [];
    for (const [id, now] of next) {
      const before = this.#snap.get(id);
      if (!before) continue;
      for (const [name, value] of now.attrs) if (before.attrs.get(name) !== value) records.push({ type: 'attributes', target: now.el, name, oldValue: before.attrs.get(name) ?? null });
      for (const name of before.attrs.keys()) if (!now.attrs.has(name)) records.push({ type: 'attributes', target: now.el, name, oldValue: before.attrs.get(name) });
      if (before.text !== now.text) records.push({ type: 'characterData', target: now.el, oldValue: before.text });
      const added = now.kids.filter((k) => !before.kids.includes(k));
      const removed = before.kids.filter((k) => !now.kids.includes(k));
      if (added.length || removed.length) records.push({ type: 'childList', target: now.el, added: added.length, removed: removed.length });
    }
    this.#snap = next;
    return records;
  }
}

// ------------------------------------------------------------------ accessibility tree
const IMPLICIT = { nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', ul: 'list', ol: 'list', li: 'listitem',
  p: 'paragraph', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading', form: 'form', table: 'table' };
const NAME_FROM_CONTENT = new Set(['button', 'link', 'tab', 'menuitem', 'treeitem', 'heading', 'listitem', 'paragraph', 'checkbox']);
const LANDMARKS = new Set(['navigation', 'main', 'banner', 'contentinfo', 'dialog']);

function roleOf(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0];
  if (el.localName === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (el.localName === 'input') return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider' })[el.type] || 'textbox';
  return IMPLICIT[el.localName] || 'generic';
}
function isHidden(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden || n.getAttribute('aria-hidden') === 'true' || getComputedStyle(n).display === 'none') return true;
  }
  return false;
}
function textOf(el, skipGroups) {
  let out = '';
  for (const k of el.childNodes) {
    if (k.nodeType === 3) out += ' ' + k.data;
    else if (k.nodeType === 1) {
      if (skipGroups && k.getAttribute('role') === 'group') continue;
      if (getComputedStyle(k).display === 'none') continue;
      out += ' ' + textOf(k, skipGroups);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}
function accessibleName(el) {
  const ids = el.getAttribute('aria-labelledby');
  if (ids) return ids.split(/\s+/).map((id) => { const t = document.getElementById(id); return t ? textOf(t) : ''; }).join(' ').trim();
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  if (/^(input|select|textarea)$/.test(el.localName)) {
    const lbl = el.id ? $(`label[for=${el.id}]`) : null;
    const wrap = lbl || el.closest('label');
    if (wrap) return textOf(wrap);
  }
  if (NAME_FROM_CONTENT.has(roleOf(el))) { const t = textOf(el, true); if (t) return t; }
  return el.getAttribute('title') || el.getAttribute('placeholder') || '';
}
function describedBy(el) {
  const ids = el.getAttribute('aria-describedby');
  return ids ? ids.split(/\s+/).map((id) => document.getElementById(id)).filter((d) => d && getComputedStyle(d).display !== 'none').map((d) => textOf(d)).join(' ') : '';
}

class AXNode {
  #el; #children = [];
  constructor(el, role, name) { this.#el = el; this.role = role; this.name = name; }
  get el() { return this.#el; }
  get children() { return this.#children; }
  add(child) { this.#children.push(child); child.parent = this; }
  states() {
    const el = this.#el;
    const s = [];
    for (const attr of ['expanded', 'selected', 'pressed', 'current', 'disabled', 'haspopup', 'modal']) {
      const v = el.getAttribute('aria-' + attr);
      if (v !== null && v !== 'false') s.push(v === 'true' ? attr : `${attr}=${v}`);
    }
    if (el.hasAttribute('disabled') && !s.includes('disabled')) s.push('disabled');
    if (el.localName === 'input' && el.type === 'checkbox') s.push(el.checked ? 'checked' : 'unchecked');
    if (/^h(\d)$/.test(el.localName)) s.push('level=' + el.localName[1]);
    if (document.activeElement === el) s.push('focused');
    const d = describedBy(el);
    if (d) s.push(`desc="${d}"`);
    return s;
  }
  line() {
    const st = this.states();
    return `${this.role}${this.name ? ` "${this.name}"` : ''}${st.length ? ' [' + st.join(', ') + ']' : ''}`;
  }
  *walk(depth = 0) {
    yield [this, depth];
    for (const c of this.#children) yield* c.walk(depth + 1);
  }
}
class AXLandmark extends AXNode { line() { return super.line() + ' (landmark)'; } }
class AXText extends AXNode {
  constructor(text) { super(null, 'text', text); }
  states() { return []; }
}

function* axChildrenOf(el) {
  const role = roleOf(el);
  const leafish = NAME_FROM_CONTENT.has(role) && role !== 'listitem' && role !== 'treeitem';
  for (const k of el.childNodes) {
    if (k.nodeType === 3) {
      if (!leafish && k.data.trim()) yield new AXText(k.data.trim());
      continue;
    }
    if (k.nodeType !== 1 || isHidden(k)) continue;
    if (el.getAttribute('aria-expanded') === 'false' && k.getAttribute('role') === 'group') continue;
    if (k.localName === 'label' && k.hasAttribute('for')) continue;
    if (k.id && $(`[aria-describedby~=${k.id}]`)) continue;
    const r = roleOf(k);
    if (r === 'generic' || r === 'none' || r === 'presentation') { yield* axChildrenOf(k); continue; }
    const node = LANDMARKS.has(r) ? new AXLandmark(k, r, accessibleName(k)) : new AXNode(k, r, accessibleName(k));
    if (r === 'treeitem' || !NAME_FROM_CONTENT.has(r) || r === 'listitem') for (const c of axChildrenOf(k)) node.add(c);
    yield node;
  }
}
function buildAXTree() {
  const root = new AXNode(document.body, 'RootWebArea', document.title);
  for (const c of axChildrenOf(document.body)) root.add(c);
  return root;
}
function renderTree(root) {
  const lines = [];
  for (const [n, depth] of root.walk()) lines.push('  '.repeat(depth) + n.line());
  return lines;
}
function describe(el) {
  if (!el || el === document.body) return 'body';
  return `${roleOf(el)} "${accessibleName(el)}"`;
}

// ------------------------------------------------------------------ live region announcer
const announcements = [];
let wakeAnnouncer = null;
function announce(msg) { announcements.push(msg); wakeAnnouncer?.(); }
async function* announcementStream() {
  while (true) {
    if (!announcements.length) {
      const more = await new Promise((resolve) => { wakeAnnouncer = resolve; });
      wakeAnnouncer = null;
      if (more === 'stop') return;
    }
    await frame();
    const batch = announcements.splice(0);
    if (batch.length) yield batch.join(' / ');
  }
}
const spoken = [];
const announcerDone = (async () => {
  for await (const text of announcementStream()) {
    $('#live').textContent = text;
    spoken.push(text);
  }
})();

// ------------------------------------------------------------------ focus management
const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';

class FocusManager {
  #traps = [];
  #history = [];
  #moves = 0;
  get moves() { return this.#moves; }
  get trapDepth() { return this.#traps.length; }
  scope() { return this.#traps[this.#traps.length - 1]?.container ?? document.body; }
  tabbables() {
    const all = $$(TABBABLE, this.scope()).filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !isHidden(el));
    const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return positive.concat(all.filter((el) => el.tabIndex === 0));
  }
  focus(el, reason) {
    if (!el) return false;
    const prev = document.activeElement;
    el.focus();
    this.#moves++;
    this.#history.push(el);
    el.dispatchEvent(new CustomEvent('focus-moved', { bubbles: true, detail: { from: prev, reason } }));
    return true;
  }
  move(dir) {
    const list = this.tabbables();
    if (!list.length) return null;
    const idx = list.indexOf(document.activeElement);
    const next = idx < 0 ? (dir > 0 ? list[0] : list[list.length - 1]) : list[(idx + dir + list.length) % list.length];
    this.focus(next, dir > 0 ? 'tab' : 'shift-tab');
    return next;
  }
  pushTrap(container, invoker) {
    this.#traps.push({ container, invoker });
    this.focus(this.tabbables()[0], 'trap');
  }
  popTrap() {
    const t = this.#traps.pop();
    if (t?.invoker) this.focus(t.invoker, 'restore');
    return t;
  }
  guard(fn) {
    const before = this.#moves;
    try {
      return fn();
    } finally {
      const trap = this.#traps[this.#traps.length - 1];
      if (trap && !trap.container.contains(document.activeElement)) {
        say('    guard: focus escaped trap, pulling back');
        this.focus(this.tabbables()[0], 'guard');
      }
      if (this.#moves - before > 1) say('    guard: multiple focus moves', this.#moves - before);
    }
  }
}
const fm = new FocusManager();

class RovingGroup {
  #container; #selector; #keys; #wrap;
  constructor(container, selector, { vertical = false, wrap = true } = {}) {
    this.#container = container;
    this.#selector = selector;
    this.#keys = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    this.#wrap = wrap;
    this.items().forEach((it, i) => it.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    container.addEventListener('keydown', (ev) => {
      if (this.onKey(ev)) { ev.preventDefault(); ev.stopPropagation(); }
    });
  }
  get container() { return this.#container; }
  items() { return $$(this.#selector, this.#container).filter((el) => !isHidden(el)); }
  enabled(el) { return !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true'; }
  current() { return this.items().indexOf(document.activeElement); }
  activate(i, reason) {
    const items = this.items();
    items.forEach((it, j) => it.setAttribute('tabindex', j === i ? '0' : '-1'));
    fm.focus(items[i], reason);
  }
  step(dir) {
    const items = this.items();
    let i = this.current();
    for (let n = 0; n < items.length; n++) {
      i += dir;
      if (i < 0 || i >= items.length) { if (!this.#wrap) return false; i = (i + items.length) % items.length; }
      if (this.enabled(items[i])) { this.activate(i, 'arrow'); return true; }
    }
    return false;
  }
  onKey(ev) {
    const [prevKey, nextKey] = this.#keys;
    switch (ev.key) {
      case prevKey: return this.step(-1);
      case nextKey: return this.step(1);
      case 'Home': this.activate(0, 'home'); return true;
      case 'End': this.activate(this.items().length - 1, 'end'); return true;
      default: return false;
    }
  }
}

class ToolbarGroup extends RovingGroup {
  onKey(ev) {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.hasAttribute('aria-pressed')) {
      const cmd = ev.target.dataset.cmd;
      ui.pressed[cmd] = !ui.pressed[cmd];
      announce(`${cmd} ${ui.pressed[cmd] ? 'on' : 'off'}`);
      return true;
    }
    return super.onKey(ev);
  }
}
class TabsGroup extends RovingGroup {
  activate(i, reason) {
    super.activate(i, reason);
    ui.tab = i;
    announce('tab ' + accessibleName(this.items()[i]));
  }
}
class MenuGroup extends RovingGroup {
  #buffer = '';
  #misses = 0;
  open() {
    ui.menuOpen = true;
    flushEffects();
    this.activate(0, 'open');
  }
  close(restore) {
    ui.menuOpen = false;
    flushEffects();
    this.#buffer = '';
    if (restore) fm.focus($('#menu-btn'), 'menu-close');
  }
  onKey(ev) {
    if (ev.key === 'Escape' || ev.key === 'Tab') { this.close(true); return true; }
    if (ev.key === 'Enter') {
      const item = ev.target;
      if (!this.enabled(item)) { announce(accessibleName(item) + ' unavailable'); return true; }
      announce('ran ' + accessibleName(item));
      this.close(true);
      return true;
    }
    if (/^[a-z]$/i.test(ev.key)) return this.typeahead(ev.key.toLowerCase());
    this.#buffer = '';
    return super.onKey(ev);
  }
  typeahead(ch) {
    this.#buffer += ch;
    const items = this.items();
    const start = this.current();
    let found = -1;
    search: for (let pass = 0; pass < 2; pass++) {
      for (let off = pass === 0 && this.#buffer.length > 1 ? 0 : 1; off <= items.length; off++) {
        const i = (start + off) % items.length;
        if (accessibleName(items[i]).toLowerCase().startsWith(this.#buffer)) { found = i; break search; }
      }
      this.#buffer = ch;
    }
    if (found < 0) { this.#misses++; this.#buffer = ''; return true; }
    this.activate(found, 'typeahead:' + this.#buffer);
    return true;
  }
  get misses() { return this.#misses; }
}
class TreeGroup extends RovingGroup {
  items() { return $$('[role=treeitem]', this.container).filter((el) => !this.collapsedAncestor(el)); }
  collapsedAncestor(el) {
    for (let n = el.parentElement; n && n !== this.container; n = n.parentElement) {
      if (n.getAttribute('role') === 'treeitem' && n.getAttribute('aria-expanded') === 'false') return true;
    }
    return false;
  }
  onKey(ev) {
    const item = ev.target;
    const key = item.dataset.node;
    const expandable = item.hasAttribute('aria-expanded');
    if (ev.key === 'ArrowRight' && expandable) {
      if (!ui.expanded[key]) { ui.expanded[key] = true; flushEffects(); announce(accessibleName(item) + ' expanded'); }
      else this.step(1);
      return true;
    }
    if (ev.key === 'ArrowLeft') {
      if (expandable && ui.expanded[key]) { ui.expanded[key] = false; flushEffects(); announce(accessibleName(item) + ' collapsed'); return true; }
      const parentItem = item.parentElement?.closest('[role=treeitem]');
      if (parentItem) this.activate(this.items().indexOf(parentItem), 'parent');
      return true;
    }
    return super.onKey(ev);
  }
}

const groups = {
  toolbar: new ToolbarGroup($('#tb'), 'button'),
  tabs: new TabsGroup($('#tablist'), '[role=tab]'),
  menu: new MenuGroup($('#menu1'), '[role=menuitem]', { vertical: true }),
  tree: new TreeGroup($('#files'), '[role=treeitem]', { vertical: true, wrap: false }),
};
flushEffects();

// ------------------------------------------------------------------ delegation
document.addEventListener('keydown', (ev) => {
  if (fm.trapDepth && ev.key === 'Escape') {
    ev.stopPropagation();
    ev.preventDefault();
    ui.dialogOpen = false;
    flushEffects();
    fm.popTrap();
    announce('dialog closed');
  }
}, true);
document.addEventListener('keydown', (ev) => {
  if (ev.defaultPrevented) return;
  if (ev.key === 'Tab') { ev.preventDefault(); fm.guard(() => fm.move(ev.shiftKey ? -1 : 1)); }
  else if (ev.key === 'Escape') announce('nothing to close');
});
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.id === 'menu-btn') { ui.menuOpen ? groups.menu.close(false) : groups.menu.open(); }
  else if (t.id === 'open-dialog') { ui.dialogOpen = true; flushEffects(); fm.pushTrap($('#dlg'), t); announce('dialog opened'); }
  else if (t.id === 'dlg-ok' || t.id === 'dlg-cancel') {
    ui.dialogOpen = false; flushEffects(); fm.popTrap(); announce(t.id === 'dlg-ok' ? 'discarded' : 'kept');
  }
});
let focusLog = [];
document.addEventListener('focus-moved', (ev) => { focusLog.push(ev.detail.reason); });

// ------------------------------------------------------------------ scenario
let prevTree = renderTree(buildAXTree());
const recorder = new MutationRecorder((records) => {
  const kinds = {};
  for (const r of records) { const k = r.type === 'attributes' ? 'attr:' + r.name : r.type; kinds[k] = (kinds[k] || 0) + 1; }
  const tree = renderTree(buildAXTree());
  const removed = prevTree.filter((l) => !tree.includes(l));
  const added = tree.filter((l) => !prevTree.includes(l));
  say(`    mutations: ${Object.entries(kinds).map(([k, v]) => k + 'x' + v).join(' ')} | ax -${removed.length} +${added.length}`);
  for (const l of added.slice(0, 3)) say('      +', l.trim());
  prevTree = tree;
});
recorder.observe(document.body);

async function press(k, mods = {}) {
  const target = document.activeElement;
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
  const notCancelled = target.dispatchEvent(ev);
  if (notCancelled && (k === 'Enter' || k === ' ') && target.localName === 'button') target.click();
  recorder.schedule();
  await settle();
  say(`  ${(mods.shiftKey ? 'Shift+' : '') + (k === ' ' ? 'Space' : k)}`.padEnd(16), '->', describe(document.activeElement));
}
async function tabUntil(pred) {
  for (let steps = 0; steps < 20; steps++) {
    if (pred(document.activeElement)) return steps;
    await press('Tab');
  }
  say('  target unreachable');
  return -1;
}
async function run(label, keys) {
  say('== ' + label);
  for (const k of keys) {
    if (Array.isArray(k)) await press(k[0], k[1]);
    else await press(k);
  }
}

async function main() {
  say('== initial accessibility tree');
  for (const l of prevTree) say('  ' + l);
  say('tabbables:', fm.tabbables().map((el) => accessibleName(el) || el.id).join(' | '));

  await run('tab through page', ['Tab', 'Tab', 'Tab', 'Tab']);
  await tabUntil((el) => el.closest('#tb'));
  await run('toolbar roving', ['ArrowRight', 'Enter', 'ArrowRight', 'ArrowRight', 'End', 'Home', ' ', 'ArrowLeft']);
  await run('into tabs', ['Tab', 'ArrowRight', 'ArrowRight', 'ArrowRight', ['Tab', { shiftKey: true }], 'Tab', 'Tab']);
  await tabUntil((el) => el.id === 'menu-btn');
  await run('menu', ['Enter', 'ArrowDown', 'd', 'o', 'x', 's', 'Enter', 'End', 'ArrowUp', 'Enter', 'Escape']);
  await run('menu again + tab closes', ['Enter', 'ArrowUp', 'Tab']);
  await run('tree', ['Tab', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowDown', 'ArrowDown', 'End']);
  await run('dialog trap', ['Tab', 'Enter', 'Tab', 'Tab', 'Tab', ['Tab', { shiftKey: true }], 'Escape']);
  await run('dialog via buttons', ['Enter', 'Tab', 'Enter']);
  await run('stray escape', ['Escape']);

  say('== final accessibility tree');
  const finalTree = renderTree(buildAXTree());
  for (const l of finalTree) say('  ' + l);
  wakeAnnouncer?.('stop');
  await announcerDone;
  say('== announcements (' + spoken.length + ')');
  for (const s of spoken) say('  live:', s);
  const reasons = focusLog.reduce((m, r) => ((m[r.split(':')[0]] = (m[r.split(':')[0]] || 0) + 1), m), {});
  say('focus moves:', fm.moves, JSON.stringify(reasons));
  say('effects run:', effectRuns, '| mutation batches:', recorder.batches, '| typeahead misses:', groups.menu.misses);
  say('ui:', JSON.stringify({ tab: ui.tab, pressed: { ...ui.pressed }, menuOpen: ui.menuOpen, dialogOpen: ui.dialogOpen, expanded: { ...ui.expanded } }));
}

main().catch((e) => say('FAILED', e instanceof Error ? e.message : String(e)));
