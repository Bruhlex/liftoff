// Keyboard shortcut manager + undo/redo text editor model: KeyboardEvents dispatched on a focused
// element are normalised into chords ("Ctrl+Shift+Z"), matched against a keymap (including
// two-step sequences like "Ctrl+K Ctrl+U"), and executed as commands on a text buffer with a
// selection. Commands implement do/undo; typing is coalesced into single undo steps.
'use strict';

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function chordOf(ev) {
  const mods = [];
  if (ev.ctrlKey) mods.push('Ctrl');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey && ev.key.length > 1) mods.push('Shift');
  if (ev.shiftKey && ev.key.length === 1 && /[a-z]/i.test(ev.key)) mods.push('Shift');
  if (ev.metaKey) mods.push('Meta');
  return mods.concat(normalizeKey(ev.key)).join('+');
}

function canonical(chord) {
  const parts = chord.split('+');
  const key = parts.pop();
  parts.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return parts.concat(normalizeKey(key)).join('+');
}

class TextBuffer {
  constructor(text) {
    this.text = text;
    this.anchor = 0;
    this.head = 0;
  }
  get start() { return Math.min(this.anchor, this.head); }
  get end() { return Math.max(this.anchor, this.head); }
  get selected() { return this.text.slice(this.start, this.end); }
  select(a, h) {
    const clamp = (x) => Math.max(0, Math.min(this.text.length, x));
    this.anchor = clamp(a);
    this.head = clamp(h === undefined ? a : h);
  }
  view() {
    const s = this.start, e = this.end;
    if (s === e) return this.text.slice(0, s) + '|' + this.text.slice(s);
    return this.text.slice(0, s) + '[' + this.text.slice(s, e) + ']' + this.text.slice(e);
  }
}

class Command {
  constructor(label) { this.label = label; }
  canMerge() { return false; }
}

class ReplaceCommand extends Command {
  constructor(label, from, to, insert) {
    super(label);
    this.from = from;
    this.to = to;
    this.insert = insert;
    this.removed = '';
    this.selBefore = null;
  }
  apply(buf) {
    this.selBefore = [buf.anchor, buf.head];
    this.removed = buf.text.slice(this.from, this.to);
    buf.text = buf.text.slice(0, this.from) + this.insert + buf.text.slice(this.to);
    buf.select(this.from + this.insert.length);
  }
  revert(buf) {
    buf.text = buf.text.slice(0, this.from) + this.removed + buf.text.slice(this.from + this.insert.length);
    buf.select(this.selBefore[0], this.selBefore[1]);
  }
  canMerge(next) {
    return this.label === 'type' && next.label === 'type' && next.from === this.from + this.insert.length && this.from === this.to && next.from === next.to && !/\s/.test(next.insert);
  }
  merge(next) {
    this.insert += next.insert;
  }
}

class CaseCommand extends Command {
  constructor(upper) { super(upper ? 'upper' : 'lower'); this.upper = upper; }
  apply(buf) {
    this.range = [buf.start, buf.end];
    this.before = buf.selected;
    const after = this.upper ? this.before.toUpperCase() : this.before.toLowerCase();
    buf.text = buf.text.slice(0, this.range[0]) + after + buf.text.slice(this.range[1]);
  }
  revert(buf) {
    buf.text = buf.text.slice(0, this.range[0]) + this.before + buf.text.slice(this.range[1]);
    buf.select(this.range[0], this.range[1]);
  }
}

class UndoHistory {
  constructor(limit) {
    this.done = [];
    this.undone = [];
    this.limit = limit;
  }
  push(cmd, buf) {
    cmd.apply(buf);
    const last = this.done[this.done.length - 1];
    if (last && last.canMerge(cmd)) last.merge(cmd);
    else {
      this.done.push(cmd);
      if (this.done.length > this.limit) this.done.shift();
    }
    this.undone.length = 0;
  }
  undo(buf) {
    const cmd = this.done.pop();
    if (!cmd) return null;
    cmd.revert(buf);
    this.undone.push(cmd);
    return cmd.label;
  }
  redo(buf) {
    const cmd = this.undone.pop();
    if (!cmd) return null;
    cmd.apply(buf);
    this.done.push(cmd);
    return cmd.label;
  }
}

class Editor {
  constructor(el, text) {
    this.el = el;
    this.buf = new TextBuffer(text);
    this.history = new UndoHistory(50);
    this.clipboard = '';
    this.log = [];
  }
  type(ch) {
    this.history.push(new ReplaceCommand('type', this.buf.start, this.buf.end, ch), this.buf);
  }
  backspace() {
    const s = this.buf.start, e = this.buf.end;
    if (s === e && s === 0) return;
    this.history.push(new ReplaceCommand('delete', s === e ? s - 1 : s, e, ''), this.buf);
  }
  cut() {
    this.clipboard = this.buf.selected;
    if (this.clipboard) this.history.push(new ReplaceCommand('cut', this.buf.start, this.buf.end, ''), this.buf);
  }
  copy() { this.clipboard = this.buf.selected; }
  paste() {
    if (this.clipboard) this.history.push(new ReplaceCommand('paste', this.buf.start, this.buf.end, this.clipboard), this.buf);
  }
  duplicateLine() {
    const t = this.buf.text;
    const ls = t.lastIndexOf('\n', this.buf.start - 1) + 1;
    let le = t.indexOf('\n', this.buf.start);
    if (le < 0) le = t.length;
    this.history.push(new ReplaceCommand('dupline', le, le, '\n' + t.slice(ls, le)), this.buf);
  }
  moveWord(dir, extend) {
    const t = this.buf.text;
    let i = this.buf.head;
    if (dir > 0) { while (i < t.length && /\w/.test(t[i])) i++; while (i < t.length && !/\w/.test(t[i])) i++; } else { while (i > 0 && !/\w/.test(t[i - 1])) i--; while (i > 0 && /\w/.test(t[i - 1])) i--; }
    this.buf.select(extend ? this.buf.anchor : i, i);
  }
}

class ShortcutManager {
  constructor(target) {
    this.bindings = new Map();
    this.pending = null;
    this.unhandled = [];
    target.addEventListener('keydown', (ev) => this.onKey(ev));
  }
  bind(seq, handler) {
    const key = seq.split(' ').map(canonical).join(' ');
    this.bindings.set(key, handler);
    return this;
  }
  onKey(ev) {
    const chord = chordOf(ev);
    const seq = this.pending ? this.pending + ' ' + chord : chord;
    if (this.bindings.has(seq)) {
      this.pending = null;
      ev.preventDefault();
      this.bindings.get(seq)(ev, seq);
      return;
    }
    const prefix = Array.from(this.bindings.keys()).some((k) => k.startsWith(seq + ' '));
    if (prefix) { this.pending = seq; ev.preventDefault(); console.log('  (waiting after ' + seq + ')'); return; }
    this.pending = null;
    this.unhandled.push(seq);
  }
}

function press(el, spec) {
  const parts = spec.split('+');
  const key = parts.pop();
  const init = { key: key === 'Space' ? ' ' : key, bubbles: true, cancelable: true };
  for (const m of parts) init[m.toLowerCase() + 'Key'] = true;
  return el.dispatchEvent(new KeyboardEvent('keydown', init));
}

function typeText(el, text) {
  for (const ch of text) press(el, ch === ch.toUpperCase() && /[A-Z]/.test(ch) ? 'Shift+' + ch : ch);
}

function main() {
  const area = document.createElement('textarea');
  document.body.appendChild(area);
  const ed = new Editor(area, 'hello world\nsecond line');
  const km = new ShortcutManager(document);
  const show = (label) => console.log(label.padEnd(18) + JSON.stringify(ed.buf.view()) + '  undo=' + ed.history.done.length + ' redo=' + ed.history.undone.length);

  km.bind('Ctrl+Z', () => ed.log.push('undo:' + ed.history.undo(ed.buf)))
    .bind('Shift+Ctrl+Z', () => ed.log.push('redo:' + ed.history.redo(ed.buf)))
    .bind('Ctrl+Y', () => ed.log.push('redo:' + ed.history.redo(ed.buf)))
    .bind('Ctrl+A', () => ed.buf.select(0, ed.buf.text.length))
    .bind('Ctrl+C', () => ed.copy())
    .bind('Ctrl+X', () => ed.cut())
    .bind('Ctrl+V', () => ed.paste())
    .bind('Ctrl+D', () => ed.duplicateLine())
    .bind('Ctrl+ArrowRight', () => ed.moveWord(1, false))
    .bind('Ctrl+Shift+ArrowRight', () => ed.moveWord(1, true))
    .bind('Ctrl+ArrowLeft', () => ed.moveWord(-1, false))
    .bind('Ctrl+K Ctrl+U', () => ed.history.push(new CaseCommand(true), ed.buf))
    .bind('Ctrl+K Ctrl+L', () => ed.history.push(new CaseCommand(false), ed.buf))
    .bind('Home', () => ed.buf.select(ed.buf.text.lastIndexOf('\n', ed.buf.head - 1) + 1))
    .bind('End', () => { const i = ed.buf.text.indexOf('\n', ed.buf.head); ed.buf.select(i < 0 ? ed.buf.text.length : i); })
    .bind('Backspace', () => ed.backspace());

  area.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key.length === 1) ed.type(ev.key);
    else if (ev.key === 'Enter') ed.type('\n');
  });

  console.log('canonical:', canonical('Shift+Ctrl+z'), canonical('Meta+Alt+ '), chordOf(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true })));
  show('initial');
  ed.buf.select(5);
  typeText(area, ', dear');
  show('typed');
  press(area, 'Space');
  typeText(area, 'big');
  show('typed more');
  press(area, 'Ctrl+z');
  show('undo 1');
  press(area, 'Ctrl+z');
  show('undo 2');
  press(area, 'Ctrl+Shift+Z');
  show('redo');
  press(area, 'Ctrl+ArrowRight');
  press(area, 'Ctrl+Shift+ArrowRight');
  show('word select');
  press(area, 'Ctrl+K');
  press(area, 'Ctrl+U');
  show('uppercase');
  press(area, 'Ctrl+x');
  show('cut');
  press(area, 'End');
  press(area, 'Ctrl+v');
  show('paste at end');
  press(area, 'Ctrl+D');
  show('dup line');
  press(area, 'Backspace');
  press(area, 'Backspace');
  show('backspace x2');
  press(area, 'Ctrl+K');
  press(area, 'Ctrl+Q');
  press(area, 'F5');
  press(area, 'Alt+Tab');
  show('unbound keys');
  press(area, 'Ctrl+A');
  press(area, 'Ctrl+K');
  press(area, 'Ctrl+L');
  show('lowercase all');
  press(area, 'Home');
  typeText(area, 'Top');
  press(area, 'Enter');
  show('insert line');

  let n = 0;
  while (ed.history.done.length) { press(area, 'Ctrl+Z'); n++; }
  show('undo all (' + n + ')');
  console.log('back to original:', ed.buf.text === 'hello world\nsecond line');
  for (let i = 0; i < 3; i++) press(area, 'Ctrl+Y');
  show('redo x3');
  typeText(area, 'X');
  press(area, 'Ctrl+Y');
  show('redo cleared');
  console.log('unhandled:', km.unhandled.join(' '));
  console.log('log:', ed.log.slice(0, 6).join(' '), '... total', ed.log.length);
  console.log('clipboard:', JSON.stringify(ed.clipboard), 'bindings:', km.bindings.size);
  const lines = ed.buf.text.split('\n');
  lines.forEach((l, i) => console.log('  ' + String(i + 1).padStart(2) + ' | ' + l));
}

main();
