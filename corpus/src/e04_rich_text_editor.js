// Rich text editor model: a block/run document (paragraphs, headings, list items with inline marks),
// a selection model, a command registry with undo/redo transactions (coalesced typing), a keymap
// driven by synthetic KeyboardEvents, a simulated clipboard with copy/cut/paste events serialising
// to HTML (tagged templates) and parsing HTML / markdown-ish text back, a keyed DOM renderer with a
// hand-written mutation watcher, a Proxy-backed toolbar state and an async-generator autosave.
'use strict';

const MARK_ORDER = ['bold', 'italic', 'underline', 'code'];
const MARK_TAG = { bold: 'strong', italic: 'em', underline: 'u', code: 'code' };
const TAG_MARK = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline', code: 'code' };
const MARK_SHORT = { bold: 'b', italic: 'i', underline: 'u', code: 'c' };

const out = (...parts) => console.log(parts.join(' '));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

class EditorError extends Error {
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; }
}

// ---------------------------------------------------------------- tagged-template HTML
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: String(s) });
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const piece = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(piece).join('') : typeof v === 'object' && RAW in v ? v[RAW] : escapeHtml(v));
function html(strings, ...values) {
  return raw(values.reduce((acc, v, i) => acc + piece(v) + strings[i + 1], strings[0]));
}
const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' })[e]);

// ---------------------------------------------------------------- runs
const sortMarks = (marks) => MARK_ORDER.filter((m) => marks.includes(m));
function normalizeRuns(runs) {
  const res = [];
  for (const r of runs) {
    if (!r?.text) continue;
    const marks = sortMarks(r.marks || []), last = res[res.length - 1];
    if (last && last.marks.join() === marks.join()) last.text += r.text; else res.push({ text: r.text, marks });
  }
  return res;
}
function splitRuns(runs, offset) {
  const left = [], right = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (end <= offset) left.push(r);
    else if (pos >= offset) right.push(r);
    else { left.push({ text: r.text.slice(0, offset - pos), marks: r.marks }); right.push({ text: r.text.slice(offset - pos), marks: r.marks }); }
    pos = end;
  }
  return [left, right];
}
const sliceRuns = (runs, from, to) => splitRuns(splitRuns(runs, from)[1], to - from)[0];
function marksAt(runs, offset) {
  let pos = 0;
  for (const r of runs) {
    if (offset > pos && offset <= pos + r.text.length) return r.marks.slice();
    pos += r.text.length;
  }
  return runs[0] && offset === 0 ? runs[0].marks.slice() : [];
}

// ---------------------------------------------------------------- blocks
const blockIds = (function* ids() { let n = 0; for (;;) yield 'blk' + (++n).toString(36); })();

class Block {
  #id;
  constructor(runs = [], id) { this.#id = id ?? blockIds.next().value; this.runs = normalizeRuns(runs); }
  get id() { return this.#id; }
  get type() { return 'paragraph'; }
  get tag() { return 'p'; }
  get text() { return this.runs.map((r) => r.text).join(''); }
  get length() { return this.text.length; }
  attrs() { return {}; }
  label() { return 'p'; }
  toJSON() { return { type: this.type, id: this.#id, runs: this.runs.map((r) => ({ text: r.text, marks: r.marks.slice() })), ...this.attrs() }; }
  static create(type, runs, attrs = {}, id) {
    return type === 'heading' ? new Heading(runs, attrs.level ?? 1, id) : type === 'listItem' ? new ListItem(runs, attrs.depth ?? 0, id) : new Paragraph(runs, id);
  }
  static fromJSON(j) { return Block.create(j.type, j.runs, j, j.id); }
}
class Paragraph extends Block {}
class Heading extends Block {
  #level;
  constructor(runs, level, id) { super(runs, id); this.#level = Math.min(3, Math.max(1, level | 0)); }
  get type() { return 'heading'; }
  get tag() { return 'h' + this.#level; }
  get level() { return this.#level; }
  attrs() { return { level: this.#level }; }
  label() { return 'h' + this.#level; }
}
class ListItem extends Block {
  #depth;
  constructor(runs, depth, id) { super(runs, id); this.#depth = Math.max(0, depth | 0); }
  get type() { return 'listItem'; }
  get tag() { return 'li'; }
  get depth() { return this.#depth; }
  attrs() { return { depth: this.#depth }; }
  label() { return 'li' + (this.#depth ? ':' + this.#depth : ''); }
}

// ---------------------------------------------------------------- selection
class EdSelection {
  constructor(anchor, focus = anchor) { this.anchor = { ...anchor }; this.focus = { ...focus }; }
  static cmp(a, b) { return a.b - b.b || a.o - b.o; }
  static caret(b, o) { return new EdSelection({ b, o }); }
  get collapsed() { return EdSelection.cmp(this.anchor, this.focus) === 0; }
  get from() { return EdSelection.cmp(this.anchor, this.focus) <= 0 ? this.anchor : this.focus; }
  get to() { return EdSelection.cmp(this.anchor, this.focus) <= 0 ? this.focus : this.anchor; }
  toJSON() { return { anchor: this.anchor, focus: this.focus }; }
}

// ---------------------------------------------------------------- undo history
class UndoHistory {
  #done = []; #undone = []; #limit;
  constructor(limit = 40) { this.#limit = limit; }
  record(snapshot, label, key) {
    const top = this.#done[this.#done.length - 1];
    this.#undone.length = 0;
    if (key && top?.key === key) return false;
    this.#done.push({ snapshot, label, key });
    if (this.#done.length > this.#limit) this.#done.shift();
    return true;
  }
  #shift(src, dst, current) {
    const e = src.pop();
    if (e) dst.push({ snapshot: current, label: e.label, key: null });
    return e ?? null;
  }
  undo(current) { return this.#shift(this.#done, this.#undone, current); }
  redo(current) { return this.#shift(this.#undone, this.#done, current); }
  get depth() { return this.#done.length + '/' + this.#undone.length; }
}

// ---------------------------------------------------------------- commands
class Command {
  constructor(name) { this.name = name; }
  coalesceKey() { return null; }
  canRun() { return true; }
  run() { throw new EditorError('abstract', this.name); }
}
class FnCommand extends Command {
  #fn; #key;
  constructor(name, fn, key = null) { super(name); this.#fn = fn; this.#key = key; }
  coalesceKey(ed, args) { return typeof this.#key === 'function' ? this.#key(ed, ...args) : this.#key; }
  run(ed, ...args) { return this.#fn(ed, ...args); }
}
class MarkCommand extends Command {
  #mark;
  constructor(mark) { super('mark:' + mark); this.#mark = mark; }
  canRun(ed) { return !(this.#mark !== 'code' && ed.activeMarks().includes('code')); }
  run(ed) { return ed.toggleMark(this.#mark); }
}
class BlockTypeCommand extends Command {
  #type; #attrs;
  constructor(type, attrs = {}) { super('block:' + type + (attrs.level ?? attrs.depth ?? '')); this.#type = type; this.#attrs = attrs; }
  run(ed) { return ed.setBlockType(this.#type, this.#attrs); }
}

// ---------------------------------------------------------------- clipboard simulation
class DataTransferSim {
  #items = new Map();
  setData(type, value) { this.#items.set(type, String(value)); }
  getData(type) { return this.#items.get(type) ?? ''; }
  get types() { return [...this.#items.keys()]; }
}
class EditorClipboardEvent extends CustomEvent {
  #data;
  constructor(type, data) { super(type, { bubbles: true, cancelable: true, detail: { kind: type } }); this.#data = data; }
  get clipboardData() { return this.#data; }
}
const systemClipboard = { data: new DataTransferSim(), writes: 0 };

function sliceToHTML(slice) {
  const runHtml = (r) => r.marks.reduce((acc, m) => html`<${raw(MARK_TAG[m])}>${acc}</${raw(MARK_TAG[m])}>`, r.text);
  return piece(slice.map((b) => {
    const tag = b.type === 'heading' ? 'h' + b.level : b.type === 'listItem' ? 'li' : 'p';
    return html`<${raw(tag)}>${b.runs.map(runHtml)}</${raw(tag)}>`;
  }));
}
function sliceToText(slice) {
  return slice.map((b) => (b.type === 'heading' ? '#'.repeat(b.level) + ' ' : b.type === 'listItem' ? '  '.repeat(b.depth) + '- ' : '') + b.runs.map((r) => r.text).join('')).join('\n');
}
function parseHTML(src) {
  const blocks = [], marks = [], re = /<(\/?)([a-z][a-z0-9]*)>|([^<]+)/gi;
  let current = null, m;
  while ((m = re.exec(src)) !== null) {
    const [, close, tagRaw, text] = m;
    if (text !== undefined) {
      if (!current) { current = { type: 'paragraph', runs: [] }; blocks.push(current); }
      current.runs.push({ text: unescapeHtml(text), marks: marks.slice() });
      continue;
    }
    const tag = tagRaw.toLowerCase();
    const hm = /^h([1-3])$/.exec(tag);
    if (hm || tag === 'p' || tag === 'li') {
      if (close) current = null;
      else { current = hm ? { type: 'heading', level: +hm[1], runs: [] } : tag === 'li' ? { type: 'listItem', depth: 0, runs: [] } : { type: 'paragraph', runs: [] }; blocks.push(current); }
    } else if (TAG_MARK[tag]) {
      if (close) { const i = marks.lastIndexOf(TAG_MARK[tag]); if (i >= 0) marks.splice(i, 1); } else marks.push(TAG_MARK[tag]);
    }
  }
  return blocks.map((b) => ({ ...b, runs: normalizeRuns(b.runs) }));
}
function parseInline(text) {
  const runs = [], re = /\*\*(.+?)\*\*|_(.+?)_|`(.+?)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), marks: [] });
    runs.push(m[1] ? { text: m[1], marks: ['bold'] } : m[2] ? { text: m[2], marks: ['italic'] } : { text: m[3], marks: ['code'] });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last), marks: [] });
  return normalizeRuns(runs);
}
function parsePlain(text) {
  return text.split(/\r?\n/).map((line) => {
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) return { type: 'heading', level: m[1].length, runs: parseInline(m[2]) };
    if ((m = /^(\s*)[-*]\s+(.*)$/.exec(line))) return { type: 'listItem', depth: m[1].length >> 1, runs: parseInline(m[2]) };
    return { type: 'paragraph', runs: parseInline(line) };
  });
}

// ---------------------------------------------------------------- reactive toolbar state
function reactive(target, onChange) {
  return new Proxy(target, {
    set(t, key, value, receiver) {
      const old = t[key];
      if (Object.is(old, value)) return true;
      try { return Reflect.set(t, key, value, receiver); } finally { onChange(key, old, value); }
    },
  });
}

// ---------------------------------------------------------------- mutation watcher (hand-written)
class DomWatcher {
  #root; #last; #cb; #pending = null;
  constructor(root, cb) { this.#root = root; this.#cb = cb; this.#last = this.#snap(); }
  #snap() {
    const map = new Map();
    let order = 0;
    for (const el of this.#root.querySelectorAll('[data-id]')) map.set(el.getAttribute('data-id'), { tag: el.localName, text: el.textContent, order: order++ });
    return map;
  }
  check() {
    const now = this.#snap();
    const records = [];
    for (const [id, info] of now) {
      const prev = this.#last.get(id);
      if (!prev) { records.push({ type: 'added', id }); continue; }
      for (const [field, type] of [['tag', 'retagged'], ['text', 'text'], ['order', 'moved']]) if (prev[field] !== info[field]) records.push({ type, id });
    }
    for (const id of this.#last.keys()) if (!now.has(id)) records.push({ type: 'removed', id });
    this.#last = now;
    if (records.length) {
      this.#pending = (this.#pending || []).concat(records);
      queueMicrotask(() => { const r = this.#pending; this.#pending = null; if (r) this.#cb(r); });
    }
  }
}

// ---------------------------------------------------------------- keymap
const IS_MAC = /Mac|iP(hone|ad)/.test(navigator.platform ?? '');
const MOD_ORDER = ['Alt', 'Ctrl', 'Meta', 'Shift'];
function normalizeKeySpec(spec) {
  const parts = spec.split(/-(?!$)/), key = parts.pop();
  const mods = new Set(parts.map((p) => (p === 'Mod' ? (IS_MAC ? 'Meta' : 'Ctrl') : p)));
  return [...MOD_ORDER.filter((m) => mods.has(m)), key.length === 1 ? key.toLowerCase() : key].join('-');
}
function eventKeyName(ev) {
  const mods = ['Alt', 'Ctrl', 'Meta'].filter((m) => ev[m.toLowerCase() + 'Key']);
  if (ev.shiftKey && (ev.key.length > 1 || mods.length)) mods.push('Shift');
  return [...mods, ev.key.length === 1 ? ev.key.toLowerCase() : ev.key].join('-');
}

// ---------------------------------------------------------------- the editor
class RichEditor {
  #blocks = [new Paragraph([])];
  #changes = []; #word = 0; #commands = new Map(); #keymap = new Map();
  constructor(root) {
    Object.assign(this, { root, sel: EdSelection.caret(0, 0), storedMarks: null, history: new UndoHistory(), readOnly: false, destroyed: false, renderCount: 0 });
    this.registerDefaults();
    for (const [k, v] of [['contenteditable', 'true'], ['tabindex', '0']]) root.setAttribute(k, v);
    root.addEventListener('keydown', (ev) => this.onKeyDown(ev));
  }
  get blocks() { return this.#blocks; }
  snapshot() { return JSON.stringify({ blocks: this.#blocks, sel: this.sel, stored: this.storedMarks }); }
  restore(snap) {
    const s = JSON.parse(snap);
    this.#blocks = s.blocks.map((j) => Block.fromJSON(j));
    this.sel = new EdSelection(s.sel.anchor, s.sel.focus);
    this.storedMarks = s.stored;
  }
  drainChanges() { return this.#changes.splice(0); }
  register(cmd) { this.#commands.set(cmd.name, cmd); return this; }
  bindKey(spec, name, ...args) { this.#keymap.set(normalizeKeySpec(spec), { name, args }); }
  registerDefaults() {
    for (const mark of MARK_ORDER) this.register(new MarkCommand(mark));
    for (const level of [1, 2, 3]) this.register(new BlockTypeCommand('heading', { level })).bindKey(`Mod-Alt-${level}`, 'block:heading' + level);
    this.register(new BlockTypeCommand('paragraph')).register(new BlockTypeCommand('listItem', { depth: 0 }));
    const self = this;
    const simple = {
      insertText: [(ed, t) => ed.insertText(t), (ed, t) => (/\s/.test(t) ? null : 'type' + self.#word)],
      deleteBackward: [(ed) => ed.deleteBy(-1), () => 'del' + self.#word],
      deleteForward: [(ed) => ed.deleteBy(1), null],
      splitBlock: [(ed) => ed.splitBlock(), null],
      indent: [(ed, d) => ed.indent(d), null],
      insertSlice: [(ed, s) => ed.insertSlice(s), null],
      deleteSelection: [(ed) => ed.deleteRange(ed.sel.from, ed.sel.to), null],
    };
    for (const [name, [fn, key]] of Object.entries(simple)) this.register(new FnCommand(name, fn, key));
    const keys = [['Mod-b', 'mark:bold'], ['Mod-i', 'mark:italic'], ['Mod-u', 'mark:underline'], ['Mod-e', 'mark:code'],
      ['Mod-Alt-0', 'block:paragraph'], ['Mod-Shift-8', 'block:listItem0'], ['Enter', 'splitBlock'], ['Backspace', 'deleteBackward'],
      ['Delete', 'deleteForward']];
    for (const [spec, name] of keys) this.bindKey(spec, name);
    for (const [spec, d] of [['Tab', 1], ['Shift-Tab', -1]]) this.bindKey(spec, 'indent', d);
    const actions = { 'Mod-z': () => this.undo(), 'Mod-Shift-z': () => this.redo(), 'Mod-y': () => this.redo(), 'Mod-a': () => this.selectAll(),
      'Mod-c': () => this.copy(false), 'Mod-x': () => this.copy(true), 'Mod-v': () => this.paste() };
    for (const [spec, fn] of Object.entries(actions)) this.#keymap.set(normalizeKeySpec(spec), { fn });
    for (const dir of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      this.#keymap.set(dir, { fn: () => this.move(dir, false) });
      this.#keymap.set('Shift-' + dir, { fn: () => this.move(dir, true) });
    }
  }
  run(name, ...args) {
    const cmd = this.#commands.get(name);
    if (!cmd) throw new EditorError('unknown-command', name);
    if (this.readOnly || !cmd.canRun(this, args)) return false;
    const key = cmd.coalesceKey(this, args);
    if (!key) this.#word++;
    return this.transact(name, () => cmd.run(this, ...args), key);
  }
  transact(label, fn, key = null) {
    const before = this.snapshot();
    let ok = false;
    try {
      return (ok = fn()) ;
    } catch (err) {
      this.restore(before);
      out('  ! ' + label + ' rolled back (' + (err instanceof EditorError ? err.code : 'error') + ')');
      return false;
    } finally {
      if (ok) { this.history.record(before, label, key); this.#changed(label); }
    }
  }
  #changed(label) {
    this.#changes.push(label);
    this.render();
    this.root.dispatchEvent(new CustomEvent('editor:change', { bubbles: true, detail: { label, depth: this.history.depth } }));
  }
  activeMarks() { return this.storedMarks ?? marksAt(this.#blocks[this.sel.focus.b].runs, this.sel.focus.o); }
  // ---- primitive edits
  insertText(text) {
    if (!this.sel.collapsed) this.deleteRange(this.sel.from, this.sel.to);
    const { b, o } = this.sel.focus, blk = this.#blocks[b], marks = this.activeMarks(), [l, r] = splitRuns(blk.runs, o);
    blk.runs = normalizeRuns([...l, { text, marks }, ...r]);
    this.sel = EdSelection.caret(b, o + text.length);
    this.storedMarks = null;
    return true;
  }
  deleteRange(from, to) {
    if (EdSelection.cmp(from, to) === 0) return false;
    const a = this.#blocks[from.b], z = this.#blocks[to.b];
    a.runs = normalizeRuns([...splitRuns(a.runs, from.o)[0], ...splitRuns(z.runs, to.o)[1]]);
    this.#blocks.splice(from.b + 1, to.b - from.b);
    this.sel = EdSelection.caret(from.b, from.o);
    return true;
  }
  deleteBy(dir) {
    if (!this.sel.collapsed) return this.deleteRange(this.sel.from, this.sel.to);
    const { b, o } = this.sel.focus, blk = this.#blocks[b];
    if (dir < 0) {
      if (o > 0) return this.deleteRange({ b, o: o - 1 }, { b, o });
      if (b === 0) return false;
      if (blk instanceof ListItem || blk instanceof Heading) { this.#blocks[b] = new Paragraph(blk.runs, blk.id); return true; }
      return this.deleteRange({ b: b - 1, o: this.#blocks[b - 1].length }, { b, o: 0 });
    }
    if (o < blk.length) return this.deleteRange({ b, o }, { b, o: o + 1 });
    if (b + 1 >= this.#blocks.length) return false;
    return this.deleteRange({ b, o }, { b: b + 1, o: 0 });
  }
  splitBlock() {
    if (!this.sel.collapsed) this.deleteRange(this.sel.from, this.sel.to);
    const { b, o } = this.sel.focus, blk = this.#blocks[b];
    if (blk instanceof ListItem && blk.length === 0) return !!(this.#blocks[b] = new Paragraph([], blk.id));
    const [l, r] = splitRuns(blk.runs, o);
    blk.runs = normalizeRuns(l);
    const nb = blk instanceof ListItem ? new ListItem(r, blk.depth) : new Paragraph(r);
    this.#blocks.splice(b + 1, 0, nb);
    this.sel = EdSelection.caret(b + 1, 0);
    return true;
  }
  setBlockType(type, attrs) {
    const { from, to } = this.sel;
    for (let i = from.b; i <= to.b; i++) {
      const cur = this.#blocks[i];
      const same = cur.type === type && JSON.stringify(cur.attrs()) === JSON.stringify(attrs);
      this.#blocks[i] = same ? new Paragraph(cur.runs, cur.id) : Block.create(type, cur.runs, attrs, cur.id);
    }
    return true;
  }
  indent(delta) {
    let changed = 0;
    for (let i = this.sel.from.b; i <= this.sel.to.b; i++) {
      const cur = this.#blocks[i], depth = cur.depth + delta;
      if (!(cur instanceof ListItem) || depth < 0 || depth > 3) continue;
      this.#blocks[i] = new ListItem(cur.runs, depth, cur.id);
      changed++;
    }
    return changed > 0;
  }
  toggleMark(mark) {
    if (this.sel.collapsed) {
      const cur = this.activeMarks();
      this.storedMarks = cur.includes(mark) ? cur.filter((m) => m !== mark) : sortMarks([...cur, mark]);
      return true;
    }
    const { from, to } = this.sel;
    const ranges = [];
    for (let i = from.b; i <= to.b; i++) ranges.push([i, i === from.b ? from.o : 0, i === to.b ? to.o : this.#blocks[i].length]);
    let all = true;
    scan: for (const [i, s, e] of ranges) for (const r of sliceRuns(this.#blocks[i].runs, s, e)) if (!r.marks.includes(mark)) { all = false; break scan; }
    for (const [i, s, e] of ranges) {
      const blk = this.#blocks[i], [head, rest] = splitRuns(blk.runs, s), [mid, tail] = splitRuns(rest, e - s);
      const mapped = mid.map((r) => ({ text: r.text, marks: all ? r.marks.filter((m) => m !== mark) : [...r.marks, mark] }));
      blk.runs = normalizeRuns([...head, ...mapped, ...tail]);
    }
    return true;
  }
  selectedSlice() {
    const { from, to } = this.sel;
    return this.#blocks.slice(from.b, to.b + 1).map((blk, k, arr) => ({ ...blk.toJSON(), runs: sliceRuns(blk.runs, k === 0 ? from.o : 0, k === arr.length - 1 ? to.o : blk.length) }));
  }
  insertSlice(slice) {
    if (!slice.length) return false;
    if (!this.sel.collapsed) this.deleteRange(this.sel.from, this.sel.to);
    const { b, o } = this.sel.focus, blk = this.#blocks[b], [l, r] = splitRuns(blk.runs, o);
    const textLen = (runs) => runs.reduce((n, x) => n + x.text.length, 0);
    if (slice.length === 1) {
      blk.runs = normalizeRuns([...l, ...slice[0].runs, ...r]);
      return !!(this.sel = EdSelection.caret(b, o + textLen(slice[0].runs)));
    }
    const [first, ...others] = slice, lastSlice = others.pop();
    blk.runs = normalizeRuns([...l, ...first.runs]);
    const middle = others.map((j) => Block.create(j.type, j.runs, j));
    this.#blocks.splice(b + 1, 0, ...middle, Block.create(lastSlice.type, [...lastSlice.runs, ...r], lastSlice));
    this.sel = EdSelection.caret(b + 1 + middle.length, textLen(lastSlice.runs));
    return true;
  }
  // ---- non-document actions
  move(dir, extend) {
    let { b, o } = this.sel.focus;
    if (!extend && !this.sel.collapsed && /^Arrow/.test(dir)) {
      const p = dir === 'ArrowLeft' ? this.sel.from : this.sel.to;
      return !!(this.sel = EdSelection.caret(p.b, p.o));
    }
    switch (dir) {
      case 'ArrowLeft': if (o > 0) o--; else if (b > 0) { b--; o = this.#blocks[b].length; } break;
      case 'ArrowRight': if (o < this.#blocks[b].length) o++; else if (b + 1 < this.#blocks.length) { b++; o = 0; } break;
      case 'Home': o = 0; break;
      case 'End': o = this.#blocks[b].length; break;
    }
    this.sel = extend ? new EdSelection(this.sel.anchor, { b, o }) : EdSelection.caret(b, o);
    this.storedMarks = null;
    return !!++this.#word;
  }
  selectAll() {
    const last = this.#blocks.length - 1;
    this.sel = new EdSelection({ b: 0, o: 0 }, { b: last, o: this.#blocks[last].length });
    return true;
  }
  undo() { return this.#travel((cur) => this.history.undo(cur), 'undo'); }
  redo() { return this.#travel((cur) => this.history.redo(cur), 'redo'); }
  #travel(step, label) {
    const e = step(this.snapshot());
    if (!e) return false;
    this.restore(e.snapshot);
    this.#word++;
    return this.#changed(label + ':' + e.label) ?? true;
  }
  copy(cut) {
    if (this.sel.collapsed) return false;
    const slice = this.selectedSlice(), dt = new DataTransferSim();
    dt.setData('text/html', sliceToHTML(slice));
    dt.setData('text/plain', sliceToText(slice));
    const ev = new EditorClipboardEvent(cut ? 'cut' : 'copy', dt);
    if (!this.root.dispatchEvent(ev)) return false;
    systemClipboard.data = dt; systemClipboard.writes++;
    if (cut) this.run('deleteSelection');
    return true;
  }
  paste() {
    const ev = new EditorClipboardEvent('paste', systemClipboard.data);
    if (!this.root.dispatchEvent(ev)) return false;
    const htmlSrc = ev.clipboardData.getData('text/html');
    const slice = htmlSrc ? parseHTML(htmlSrc) : parsePlain(ev.clipboardData.getData('text/plain'));
    return this.run('insertSlice', slice);
  }
  onKeyDown(ev) {
    const binding = this.#keymap.get(eventKeyName(ev));
    const typed = !binding && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey;
    if (binding || typed) ev.preventDefault();
    return binding ? (binding.fn ? binding.fn() : this.run(binding.name, ...binding.args)) : typed ? this.run('insertText', ev.key) : false;
  }
  // ---- rendering
  render() {
    this.renderCount++;
    const existing = new Map();
    for (const el of [...this.root.children]) existing.set(el.getAttribute('data-id'), el);
    const frag = document.createDocumentFragment();
    for (const blk of this.#blocks) {
      const sig = blk.tag + '|' + JSON.stringify(blk.runs);
      let el = existing.get(blk.id);
      if (!el || el.getAttribute('data-sig') !== sig) {
        el = document.createElement(blk.tag);
        for (const [k, v] of Object.entries({ 'data-id': blk.id, 'data-sig': sig })) el.setAttribute(k, v);
        for (const r of blk.runs) {
          const span = document.createElement('span');
          if (r.marks.length) span.className = r.marks.map((m) => 'mk-' + m).join(' ');
          span.textContent = r.text;
          el.appendChild(span);
        }
      }
      frag.appendChild(el);
    }
    this.root.replaceChildren(frag);
  }
  markup() {
    const { from, to, collapsed } = this.sel;
    return this.#blocks.map((blk, b) => {
      const marker = (o) => (collapsed ? (from.b === b && from.o === o ? '|' : '') : (from.b === b && from.o === o ? '[' : '') + (to.b === b && to.o === o ? ']' : ''));
      let s = '', pos = 0;
      for (const r of blk.runs) {
        let body = '';
        for (const ch of r.text) { body += marker(pos) + ch; pos++; }
        s += r.marks.length ? '{' + r.marks.map((m) => MARK_SHORT[m]).join('') + ':' + body + '}' : body;
      }
      return '[' + blk.label() + '] ' + s + marker(pos);
    }).join(' / ');
  }
}

// ---------------------------------------------------------------- page wiring
function el(tag, cls, attrs = {}, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
const shell = el('div', 'editor-shell'), toolbar = el('div', 'toolbar', { role: 'toolbar' }), editable = el('div', 'editable');
shell.append(toolbar, editable);
document.getElementById('app').appendChild(shell);

const editor = new RichEditor(editable);

const TOOLBAR_BUTTONS = [['bold', 'mark:bold'], ['italic', 'mark:italic'], ['code', 'mark:code'], ['h1', 'block:heading1'], ['list', 'block:listItem0'], ['undo', 'undo']];
for (const [label, cmd] of TOOLBAR_BUTTONS) {
  const btn = el('button', null, { 'data-cmd': cmd, 'aria-pressed': 'false' });
  btn.appendChild(el('span', 'icon icon-' + label, {}, label));
  toolbar.appendChild(btn);
}

const toolbarLog = [], pendingKeys = new Set();
let toolbarFlushScheduled = false;
const toolbarState = reactive({ bold: false, italic: false, code: false, block: 'p', canUndo: false }, (key) => {
  pendingKeys.add(key);
  if (toolbarFlushScheduled) return;
  toolbarFlushScheduled = true;
  requestAnimationFrame(() => {
    toolbarFlushScheduled = false;
    const keys = [...pendingKeys].sort();
    pendingKeys.clear();
    for (const btn of toolbar.querySelectorAll('button')) {
      const cmd = btn.getAttribute('data-cmd');
      const m = /^mark:(\w+)$/.exec(cmd);
      const pressed = m ? !!toolbarState[m[1]] : cmd === 'block:heading1' ? toolbarState.block === 'h1' : cmd === 'block:listItem0' ? toolbarState.block.startsWith('li') : false;
      btn.setAttribute('aria-pressed', String(pressed));
      if (cmd === 'undo') btn.toggleAttribute('disabled', !toolbarState.canUndo);
    }
    toolbarLog.push(keys.join(','));
    out('  toolbar frame:', keys.join(','), '->', [...toolbar.querySelectorAll('[aria-pressed=true]')].map((b) => b.getAttribute('data-cmd')).join(' ') || '(none)');
  });
});
function syncToolbar() {
  const marks = editor.activeMarks();
  for (const m of ['bold', 'italic', 'code']) toolbarState[m] = marks.includes(m);
  toolbarState.block = editor.blocks[editor.sel.focus.b].label();
  toolbarState.canUndo = editor.history.depth.split('/')[0] !== '0';
}

// capture-phase guard: disabled buttons swallow clicks before delegation sees them
toolbar.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('button');
  if (btn?.hasAttribute('disabled')) {
    ev.stopPropagation();
    out('  toolbar: blocked click on disabled', btn.getAttribute('data-cmd'));
  }
}, true);
toolbar.addEventListener('click', (ev) => {
  const cmd = ev.target.closest('[data-cmd]')?.getAttribute('data-cmd');
  if (!cmd) return;
  const r = cmd === 'undo' ? editor.undo() : editor.run(cmd);
  out('  toolbar click', cmd, '=>', r);
});

let docChangeEvents = 0;
let verbose = true;
document.addEventListener('editor:change', (ev) => {
  docChangeEvents++;
  syncToolbar();
  if (verbose && (ev.detail.label.startsWith('undo') || ev.detail.label.startsWith('redo'))) out('  change event:', ev.detail.label, 'history', ev.detail.depth);
});
let keydownsSeen = 0;
document.addEventListener('keydown', () => { keydownsSeen++; }, true);
shell.addEventListener('keydown', (ev) => {
  if (shell.classList.contains('locked')) { ev.stopPropagation(); ev.preventDefault(); out('  locked: swallowed', eventKeyName(ev)); }
}, true);

editable.addEventListener('copy', ({ clipboardData: dt }) => dt.setData('text/plain', dt.getData('text/plain') + '\n-- copied from notes'));
editable.addEventListener('paste', (ev) => {
  if (/forbidden/i.test(ev.clipboardData.getData('text/plain'))) { ev.preventDefault(); out('  paste rejected by policy'); }
});

const mutationLog = [];
const watcher = new DomWatcher(editable, (records) => {
  const counts = records.reduce((acc, { type }) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {});
  mutationLog.push(counts);
});

function key(k, mods = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
  editable.dispatchEvent(ev);
  watcher.check();
  return ev.defaultPrevented;
}
// press('Mod-Shift-z', 'Enter', ...) -> synthetic keydowns; returns defaultPrevented of the last one
function press(...specs) {
  let prevented = false;
  for (const spec of specs) {
    const parts = spec.split(/-(?!$)/), k = parts.pop(), mods = {};
    for (const p of parts) mods[{ Mod: IS_MAC ? 'metaKey' : 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey' }[p]] = true;
    prevented = key(k, mods);
  }
  return prevented;
}
const repeat = (n, spec) => press(...Array(n).fill(spec));
async function typeText(text) {
  let i = 0;
  for (const ch of text) {
    key(ch, ch !== ch.toLowerCase() ? { shiftKey: true } : {});
    if (++i % 6 === 0) await nextFrame();
  }
}
const show = (label) => out(label.padEnd(18), editor.markup());
function clip(type, text) { systemClipboard.data = new DataTransferSim(); systemClipboard.data.setData(type, text); }

async function* changeBatches(ed) {
  try {
    while (!ed.destroyed) {
      await nextFrame();
      const batch = ed.drainChanges();
      if (batch.length) yield batch;
    }
  } finally {
    out('  autosave stream closed');
  }
}
async function autosave(ed) {
  let saves = 0;
  for await (const batch of changeBatches(ed)) {
    saves++;
    const counts = {};
    for (const label of batch) counts[label] = (counts[label] || 0) + 1;
    for (const [k, v] of [['draft', ed.snapshot()], ['draft:rev', String(saves)]]) localStorage.setItem(k, v);
    if (saves % 4 === 1) out('  autosave #' + saves + ':', Object.entries(counts).map(([k, v]) => k + 'x' + v).join(' '));
    if (saves >= 40) break;
  }
  return saves;
}

function searchAll(ed, pattern, limit) {
  const hits = [];
  outer: for (let b = 0; b < ed.blocks.length; b++) {
    for (const m of ed.blocks[b].text.matchAll(pattern)) {
      hits.push(b + ':' + m.index);
      if (hits.length >= limit) break outer;
    }
  }
  return hits;
}
async function main() {
  out('platform mod =', IS_MAC ? 'Meta' : 'Ctrl', '| keymap Mod-Shift-z ->', normalizeKeySpec('Mod-Shift-Z'));
  const saver = autosave(editor);
  editor.render();
  watcher.check();
  show('initial');
  press('Mod-Alt-2');
  await typeText('Meeting Notes');
  show('heading');
  press('Enter');
  await typeText('Agenda for ');
  press('Mod-b');
  await typeText('Monday');
  press('Mod-b');
  await typeText(' sync.');
  show('bold stored');
  await nextFrame();
  press('Enter', 'Mod-Shift-8');
  await typeText('budget');
  press('Enter', 'Tab');
  await typeText('hiring');
  press('Enter', 'Enter');
  show('list');
  press('Enter', 'Enter', 'Backspace');
  await typeText('Action items follow');
  show('paragraph');
  repeat(6, 'Shift-ArrowLeft');
  show('shift-select');
  press('Mod-i');
  show('italic range');
  press('Mod-e');
  show('code on italic');
  press('Mod-b');
  show('bold blocked');
  press('Home', 'Shift-End', 'Mod-c');
  out('  clipboard html:', systemClipboard.data.getData('text/html'));
  out('  clipboard text:', JSON.stringify(systemClipboard.data.getData('text/plain')));
  press('End', 'Enter', 'Mod-v');
  show('pasted');
  await nextFrame();
  repeat(4, 'Mod-z');
  show('undo x4');
  press('Mod-Shift-z', 'Mod-y');
  show('redo x2');
  editor.sel = new EdSelection({ b: 1, o: 4 }, { b: 3, o: 2 });
  press('Mod-x');
  show('cut across');
  out('  clipboard text:', JSON.stringify(systemClipboard.data.getData('text/plain')));
  press('Mod-z');
  show('undo cut');
  clip('text/plain', '## Imported\n- first **strong** item\n  - nested _soft_ item\nplain `tail`');
  press('End', 'Enter', 'Mod-v');
  show('markdown paste');
  clip('text/plain', 'FORBIDDEN content');
  out('  paste result prevented =', press('Mod-v'));
  clip('text/html', '<p>A &amp; B &lt;ok&gt;</p><h3><em>Deep</em> dive</h3><li>x<u>y</u>z</li>');
  press('Mod-v');
  show('html paste');
  await nextFrame();
  shell.classList.add('locked');
  out('  locked keydown prevented =', press('q'));
  shell.classList.remove('locked');
  editor.readOnly = true;
  out('  readonly insert =', editor.run('insertText', 'zzz'));
  editor.readOnly = false;
  out('  unknown command guarded:', (() => { try { editor.run('nope'); return 'ran'; } catch (e) { return e instanceof EditorError ? e.code : 'other'; } })());
  const rolled = editor.transact('explode', () => { editor.insertText('!!!'); throw new EditorError('boom'); });
  out('  transact result', rolled, 'text still', JSON.stringify(editor.blocks[0].text));
  await nextFrame();
  verbose = false;
  let undos = 0;
  for (let i = 0; i < 60; i++) if (press('Mod-z') && editor.history.depth !== '0/0') undos++;
  show('undo to bottom');
  out('  history depth', editor.history.depth, 'after', undos, 'undo keys');
  const disabledBtn = toolbar.querySelector('[data-cmd=undo]');
  await nextFrame();
  out('  undo button disabled =', disabledBtn.hasAttribute('disabled'));
  disabledBtn.querySelector('span').click();
  repeat(60, 'Mod-Shift-z');
  verbose = true;
  show('redo all');
  out('  history depth', editor.history.depth);
  toolbar.querySelector('[data-cmd="mark:bold"]').click();
  toolbar.querySelector('[data-cmd=block:heading1]')?.click();
  show('toolbar h1');
  out('  search /e\\w/g:', searchAll(editor, /e\w/g, 7).join(' '));
  await nextFrame();
  await nextFrame();
  editor.destroyed = true;
  const saves = await saver;
  out('dom blocks:', [...editable.children].map((el) => el.localName + '(' + el.children.length + ')').join(' '));
  out('dom text[0]:', JSON.stringify(editable.firstElementChild.textContent));
  out('marked spans:', editable.querySelectorAll('span[class]').length, 'bold spans:', editable.getElementsByClassName('mk-bold').length);
  const totals = mutationLog.reduce((acc, c) => { for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] || 0) + v; return acc; }, {});
  out('mutation batches:', mutationLog.length, JSON.stringify(totals));
  out('renders:', editor.renderCount, 'change events:', docChangeEvents, 'keydowns:', keydownsSeen, 'toolbar frames:', toolbarLog.length);
  out('autosaves:', saves, 'stored rev:', localStorage.getItem('draft:rev'), 'draft bytes:', localStorage.getItem('draft').length);
  out('clipboard writes:', systemClipboard.writes, 'history', editor.history.depth);
}

main().then(() => out('done'));
