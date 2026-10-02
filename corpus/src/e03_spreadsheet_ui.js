// Spreadsheet UI: a <table> of DOM cells bound to a formula engine. Formulas are tokenized with a
// sticky regex, parsed by a Pratt parser into an AST, evaluated with ranges and built-in functions,
// and recalculated in topological order over a dependency graph with cycle detection. Cell edits go
// through command objects (set / paste / clear / composite) for undo and redo. The UI supports
// delegated click selection, keyboard navigation and editing, TSV paste via a custom event, and
// repaints dirty cells once per animation frame. A scripted session is replayed and the grid printed.
'use strict';

const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const waitFrame = () => new Promise((r) => requestAnimationFrame(r));

const COLS = 6, ROWS = 8;
const colName = (i) => String.fromCharCode(65 + i);
const refOf = (c, r) => colName(c) + (r + 1);
function parseRef(ref) {
  const m = /^([A-Z])(\d+)$/.exec(ref);
  if (!m) return null;
  const c = m[1].charCodeAt(0) - 65, r = Number(m[2]) - 1;
  return c < COLS && r >= 0 && r < ROWS ? { c, r } : null;
}
function* rangeRefs(a, b) {
  const p = parseRef(a), q = parseRef(b);
  if (!p || !q) throw new SheetError('#REF!');
  for (let r = Math.min(p.r, q.r); r <= Math.max(p.r, q.r); r++) {
    for (let c = Math.min(p.c, q.c); c <= Math.max(p.c, q.c); c++) yield refOf(c, r);
  }
}

class SheetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------- tokenizer + Pratt parser
const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Z]\d+(?::[A-Z]\d+)?)|([A-Z]{2,}(?=\())|("(?:[^"]|"")*")|(<=|>=|<>|[-+*/^&=<>(),%]))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN_RE.lastIndex))) break;
    const start = TOKEN_RE.lastIndex;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new SheetError('#NAME?');
    const [, num, ref, fn, str, op] = m;
    if (num !== undefined) tokens.push({ t: 'num', v: Number(num) });
    else if (ref !== undefined) tokens.push(ref.includes(':') ? { t: 'range', v: ref.split(':') } : { t: 'ref', v: ref });
    else if (fn !== undefined) tokens.push({ t: 'fn', v: fn });
    else if (str !== undefined) tokens.push({ t: 'str', v: str.slice(1, -1).replace(/""/g, '"') });
    else tokens.push({ t: 'op', v: op, at: start });
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

const BINARY = { '=': [1, 'l'], '<>': [1, 'l'], '<': [1, 'l'], '>': [1, 'l'], '<=': [1, 'l'], '>=': [1, 'l'], '&': [2, 'l'], '+': [3, 'l'], '-': [3, 'l'], '*': [4, 'l'], '/': [4, 'l'], '^': [6, 'r'] };

function parseFormula(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (v) => { const t = next(); if (t.t !== 'op' || t.v !== v) throw new SheetError('#NAME?'); };
  function prefix() {
    const t = next();
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'ref': return { k: 'ref', v: t.v };
      case 'range': return { k: 'range', a: t.v[0], b: t.v[1] };
      case 'fn': {
        expect('(');
        const args = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          do { args.push(expr(0)); } while (peek().t === 'op' && peek().v === ',' && next());
        }
        expect(')');
        return { k: 'call', name: t.v, args };
      }
      case 'op':
        if (t.v === '-') return { k: 'neg', e: expr(5) };
        if (t.v === '+') return expr(5);
        if (t.v === '(') { const e = expr(0); expect(')'); return e; }
    }
    throw new SheetError('#NAME?');
  }
  function expr(minPrec) {
    let left = prefix();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && t.v === '%') { next(); left = { k: 'bin', op: '/', l: left, r: { k: 'num', v: 100 } }; continue; }
      const info = t.t === 'op' ? BINARY[t.v] : null;
      if (!info || info[0] < minPrec) break;
      next();
      const right = expr(info[1] === 'l' ? info[0] + 1 : info[0]);
      left = { k: 'bin', op: t.v, l: left, r: right };
    }
    return left;
  }
  const ast = expr(0);
  if (peek().t !== 'eof') throw new SheetError('#NAME?');
  return ast;
}

function collectDeps(ast, out = new Set()) {
  switch (ast.k) {
    case 'ref': out.add(ast.v); break;
    case 'range': for (const r of rangeRefs(ast.a, ast.b)) out.add(r); break;
    case 'bin': collectDeps(ast.l, out); collectDeps(ast.r, out); break;
    case 'neg': collectDeps(ast.e, out); break;
    case 'call': for (const a of ast.args) collectDeps(a, out); break;
  }
  return out;
}

// ---------------------------------------------------------------- engine
const num = (v) => {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new SheetError('#VALUE!');
  return n;
};
const flatNums = (vals) => vals.flat().filter((v) => typeof v === 'number');

const FUNCS = {
  SUM: (...a) => flatNums(a).reduce((s, x) => s + x, 0),
  AVG: (...a) => { const n = flatNums(a); if (!n.length) throw new SheetError('#DIV/0!'); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (...a) => Math.min(...flatNums(a)),
  MAX: (...a) => Math.max(...flatNums(a)),
  COUNT: (...a) => flatNums(a).length,
  IF: (c, a, b = false) => (num(c) ? a : b),
  ROUND: (x, d = 0) => { const f = 10 ** num(d); return Math.round(num(x) * f) / f; },
  CONCAT: (...a) => a.flat().map((v) => (v === '' ? '' : String(v))).join(''),
  LEN: (s) => String(s).length,
  ABS: (x) => Math.abs(num(x)),
};

class Engine extends EventTarget {
  #raw = new Map();
  #ast = new Map();
  #values = new Map();
  #deps = new Map();
  #rdeps = new Map();
  #evalStack = [];
  #recalcs = 0;
  get recalcs() { return this.#recalcs; }
  raw(ref) { return this.#raw.get(ref) ?? ''; }
  value(ref) { return this.#values.has(ref) ? this.#values.get(ref) : ''; }
  set(ref, input) {
    const text = String(input);
    const old = this.#deps.get(ref) || new Set();
    for (const d of old) this.#rdeps.get(d)?.delete(ref);
    this.#ast.delete(ref);
    this.#deps.delete(ref);
    if (text === '') this.#raw.delete(ref); else this.#raw.set(ref, text);
    if (text.startsWith('=')) {
      try {
        const ast = parseFormula(text.slice(1).replace(/"(?:[^"]|"")*"|[^"]+/g, (s) => (s[0] === '"' ? s : s.toUpperCase())));
        this.#ast.set(ref, ast);
        const deps = collectDeps(ast);
        this.#deps.set(ref, deps);
        for (const d of deps) { if (!this.#rdeps.has(d)) this.#rdeps.set(d, new Set()); this.#rdeps.get(d).add(ref); }
      } catch (e) {
        if (!(e instanceof SheetError)) throw e;
        this.#ast.set(ref, { k: 'err', code: e.code });
      }
    }
    return this.recalc(ref);
  }
  #affected(start) {
    // DFS post-order over reverse deps; nodes on the current path mark cycles
    const order = [], state = new Map(), cyclic = new Set();
    const visit = (ref, path) => {
      const s = state.get(ref);
      if (s === 'done') return;
      if (s === 'active') { for (let k = path.indexOf(ref); k < path.length; k++) cyclic.add(path[k]); return; }
      state.set(ref, 'active');
      path.push(ref);
      for (const r of this.#rdeps.get(ref) || []) visit(r, path);
      path.pop();
      state.set(ref, 'done');
      order.push(ref);
    };
    visit(start, []);
    return { order: order.reverse(), cyclic };
  }
  recalc(start) {
    const { order, cyclic } = this.#affected(start);
    const changed = [];
    for (const ref of order) {
      const before = this.#values.get(ref);
      let v;
      if (cyclic.has(ref)) v = '#CYCLE!';
      else v = this.#compute(ref);
      this.#recalcs++;
      if (v === '' ) this.#values.delete(ref); else this.#values.set(ref, v);
      if (before !== v) changed.push(ref);
    }
    if (changed.length) this.dispatchEvent(new CustomEvent('values', { detail: changed }));
    return changed;
  }
  #compute(ref) {
    const ast = this.#ast.get(ref);
    if (!ast) {
      const raw = this.#raw.get(ref);
      if (raw === undefined) return '';
      return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    if (ast.k === 'err') return ast.code;
    this.#evalStack.push(ref);
    try {
      const v = this.#eval(ast);
      if (typeof v === 'number' && !Number.isFinite(v)) return '#DIV/0!';
      return typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v;
    } catch (e) {
      if (e instanceof SheetError) return e.code;
      throw e;
    } finally {
      this.#evalStack.pop();
    }
  }
  #cell(ref) {
    const v = this.value(ref);
    if (typeof v === 'string' && v.startsWith('#')) throw new SheetError(v);
    return v;
  }
  #eval(n) {
    switch (n.k) {
      case 'num': case 'str': return n.v;
      case 'ref': if (!parseRef(n.v)) throw new SheetError('#REF!'); return this.#cell(n.v);
      case 'range': return [...rangeRefs(n.a, n.b)].map((r) => this.#cell(r));
      case 'neg': return -num(this.#eval(n.e));
      case 'call': {
        const fn = FUNCS[n.name];
        if (!fn) throw new SheetError('#NAME?');
        if (n.name === 'IF') {
          const c = this.#eval(n.args[0]);
          return num(c) ? this.#eval(n.args[1]) : n.args[2] ? this.#eval(n.args[2]) : false;
        }
        return fn(...n.args.map((a) => this.#eval(a)));
      }
      case 'bin': {
        const l = this.#eval(n.l), r = this.#eval(n.r);
        switch (n.op) {
          case '+': return num(l) + num(r);
          case '-': return num(l) - num(r);
          case '*': return num(l) * num(r);
          case '/': if (num(r) === 0) throw new SheetError('#DIV/0!'); return num(l) / num(r);
          case '^': return num(l) ** num(r);
          case '&': return String(l) + String(r);
          case '=': return l === r;
          case '<>': return l !== r;
          case '<': return num(l) < num(r);
          case '>': return num(l) > num(r);
          case '<=': return num(l) <= num(r);
          case '>=': return num(l) >= num(r);
        }
      }
    }
    throw new SheetError('#VALUE!');
  }
  dependents(ref) { return [...(this.#rdeps.get(ref) || [])].sort(); }
}

// ---------------------------------------------------------------- commands
class Command {
  constructor(label) { this.label = label; }
  apply() {}
  revert() {}
}
class SetCellCommand extends Command {
  #ref; #next; #prev = null;
  constructor(ref, next) { super('set ' + ref); this.#ref = ref; this.#next = next; }
  apply(engine) { this.#prev = engine.raw(this.#ref); engine.set(this.#ref, this.#next); }
  revert(engine) { engine.set(this.#ref, this.#prev); }
}
class CompositeCommand extends Command {
  #parts;
  constructor(label, parts) { super(label); this.#parts = parts; }
  apply(engine) { for (const p of this.#parts) p.apply(engine); }
  revert(engine) { for (let i = this.#parts.length - 1; i >= 0; i--) this.#parts[i].revert(engine); }
  get size() { return this.#parts.length; }
}
class PasteCommand extends CompositeCommand {
  constructor(anchor, tsv) {
    const { c, r } = parseRef(anchor);
    const parts = [];
    tsv.split('\n').forEach((line, dr) => line.split('\t').forEach((val, dc) => {
      if (c + dc < COLS && r + dr < ROWS) parts.push(new SetCellCommand(refOf(c + dc, r + dr), val));
    }));
    super('paste@' + anchor, parts);
  }
}
class ClearRangeCommand extends CompositeCommand {
  constructor(a, b) { super('clear ' + a + ':' + b, [...rangeRefs(a, b)].map((ref) => new SetCellCommand(ref, ''))); }
}

class History2 {
  #done = [];
  #undone = [];
  constructor(engine) { this.engine = engine; }
  run(cmd) { cmd.apply(this.engine); this.#done.push(cmd); this.#undone.length = 0; return cmd; }
  undo() { const c = this.#done.pop(); if (!c) return null; c.revert(this.engine); this.#undone.push(c); return c.label; }
  redo() { const c = this.#undone.pop(); if (!c) return null; c.apply(this.engine); this.#done.push(c); return c.label; }
  get depth() { return [this.#done.length, this.#undone.length]; }
}

// ---------------------------------------------------------------- view / controller
function fmt(strings, ...vals) {
  return strings.reduce((acc, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    const shown = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    return acc + shown + s;
  }, '');
}

class SheetView {
  #table;
  #cells = new Map();
  #dirty = new Set();
  #scheduled = false;
  #paints = 0;
  #engine;
  constructor(host, engine) {
    this.#engine = engine;
    this.#table = document.createElement('table');
    this.#table.className = 'sheet';
    for (let r = 0; r < ROWS; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < COLS; c++) {
        const td = document.createElement('td');
        const ref = refOf(c, r);
        td.dataset.cell = ref;
        tr.appendChild(td);
        this.#cells.set(ref, td);
      }
      this.#table.appendChild(tr);
    }
    host.appendChild(this.#table);
    engine.addEventListener('values', (e) => this.invalidate(e.detail));
  }
  get table() { return this.#table; }
  get paints() { return this.#paints; }
  td(ref) { return this.#cells.get(ref); }
  invalidate(refs) {
    for (const r of refs) this.#dirty.add(r);
    if (this.#scheduled) return;
    this.#scheduled = true;
    requestAnimationFrame(() => this.#flush());
  }
  #flush() {
    this.#scheduled = false;
    this.#paints++;
    const refs = [...this.#dirty];
    this.#dirty.clear();
    for (const ref of refs) {
      const td = this.#cells.get(ref);
      const v = this.#engine.value(ref);
      td.textContent = v === '' ? '' : fmt`${v}`;
      td.classList.toggle('error', typeof v === 'string' && v.startsWith('#'));
      td.classList.toggle('num', typeof v === 'number');
      td.dispatchEvent(new CustomEvent('cellpaint', { bubbles: true, detail: { ref, v } }));
    }
  }
  select(ref, prev) {
    if (prev) this.#cells.get(prev)?.classList.remove('selected');
    this.#cells.get(ref).classList.add('selected');
  }
  render() {
    const w = 12;
    const lines = ['    ' + Array.from({ length: COLS }, (_, c) => colName(c).padEnd(w)).join('')];
    for (let r = 0; r < ROWS; r++) {
      let row = String(r + 1).padStart(2) + '  ';
      let any = false;
      for (let c = 0; c < COLS; c++) {
        const td = this.#cells.get(refOf(c, r));
        const t = td.textContent;
        if (t) any = true;
        const mark = td.classList.contains('selected') ? '*' : ' ';
        row += (mark + t).slice(0, w - 1).padEnd(w);
      }
      if (any || row.includes('*')) lines.push(row.trimEnd());
    }
    return lines;
  }
}

class SheetController {
  #view; #history; #sel = 'A1'; #editing = null; #keyLog = [];
  constructor(view, history) {
    this.#view = view;
    this.#history = history;
    const table = view.table;
    view.select(this.#sel);
    table.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (td) this.select(td.dataset.cell);
    });
    table.addEventListener('dblclick', (e) => { const td = e.target.closest('td'); if (td) { this.select(td.dataset.cell); this.beginEdit(history.engine.raw(td.dataset.cell)); } });
    document.addEventListener('keydown', (e) => this.#onKey(e));
    table.addEventListener('sheet:paste', (e) => {
      e.stopPropagation();
      const cmd = this.#history.run(new PasteCommand(this.#sel, e.detail.text));
      say('  pasted', cmd.size, 'cells at', this.#sel);
    });
  }
  get selection() { return this.#sel; }
  get keyLog() { return this.#keyLog; }
  select(ref) { const prev = this.#sel; this.#sel = ref; this.#view.select(ref, prev); }
  beginEdit(initial) { this.#editing = { ref: this.#sel, text: initial }; }
  #move(dc, dr) {
    const { c, r } = parseRef(this.#sel);
    const nc = Math.max(0, Math.min(COLS - 1, c + dc)), nr = Math.max(0, Math.min(ROWS - 1, r + dr));
    this.select(refOf(nc, nr));
  }
  #onKey(e) {
    this.#keyLog.push((e.ctrlKey ? '^' : '') + e.key);
    if (this.#editing) {
      switch (e.key) {
        case 'Enter': {
          const { ref, text } = this.#editing;
          this.#editing = null;
          this.#history.run(new SetCellCommand(ref, text));
          this.#move(0, 1);
          return;
        }
        case 'Tab': {
          const { ref, text } = this.#editing;
          this.#editing = null;
          this.#history.run(new SetCellCommand(ref, text));
          this.#move(e.shiftKey ? -1 : 1, 0);
          e.preventDefault();
          return;
        }
        case 'Escape': this.#editing = null; return;
        case 'Backspace': this.#editing.text = this.#editing.text.slice(0, -1); return;
        default: if (e.key.length === 1) this.#editing.text += e.key; return;
      }
    }
    if (e.ctrlKey) {
      if (e.key === 'z') say('  undo ->', this.#history.undo());
      else if (e.key === 'y') say('  redo ->', this.#history.redo());
      return;
    }
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[e.key]) { this.#move(...arrows[e.key]); return; }
    if (e.key === 'Delete') { this.#history.run(new SetCellCommand(this.#sel, '')); return; }
    if (e.key === 'F2') { this.beginEdit(this.#history.engine.raw(this.#sel)); return; }
    if (e.key.length === 1) this.beginEdit(e.key);
  }
}

// ---------------------------------------------------------------- scripted session
function keysFor(text) {
  const out = [];
  for (const ch of text) out.push(ch === '\n' ? 'Enter' : ch === '\t' ? 'Tab' : ch);
  return out;
}

async function* script() {
  yield { label: 'enter item table', keys: keysFor('Item\tQty\tPrice\tTotal\n') };
  yield { label: 'rows', click: 'A2', keys: keysFor('Apples\t4\t0.5\t=B2*C2\n') };
  yield { label: 'row 3', click: 'A3', keys: keysFor('Pears\t6\t0.75\t=B3*C3\n') };
  yield { label: 'paste rows 4-5', click: 'A4', paste: 'Plums\t10\t0.3\t=B4*C4\nKiwis\t3\t1.2\t=B5*C5' };
  yield { label: 'totals', click: 'C7', keys: keysFor('Sum\t=SUM(D2:D6)\n') };
  yield { label: 'stats', click: 'E2', keys: keysFor('=AVG(B2:B5)\n=MAX(C2:C5)-MIN(C2:C5)\n=IF(D7>10,"big","small")\n=CONCAT(A2," & ",A3)\n=ROUND(D7/3,2)\n') };
  yield { label: 'change qty', click: 'B2', keys: keysFor('20\n') };
  yield { label: 'errors', click: 'F2', keys: keysFor('=1/0\n=FOO(1)\n=a2+1\n=F6\n=F5+1\n=f6*2\n') };
  yield { label: 'undo twice', keys: [['z', true], ['z', true]] };
  yield { label: 'redo once', keys: [['y', true]] };
  yield { label: 'escape edit + F2 append', click: 'B3', keys: ['9', '9', 'Escape', 'F2', '0', 'Enter'] };
  yield { label: 'delete + arrows', click: 'E5', keys: ['Delete', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'Delete'] };
  yield { label: 'clear range cmd', clear: ['F2', 'F6'] };
  yield { label: 'undo clear', keys: [['z', true]] };
}

async function main() {
  const host = document.getElementById('app');
  const engine = new Engine();
  const view = new SheetView(host, engine);
  const history = new History2(engine);
  const ctrl = new SheetController(view, history);
  let paintEvents = 0;
  host.addEventListener('cellpaint', () => paintEvents++);

  const cellInput = new Proxy({}, {
    get: (_, ref) => engine.value(String(ref)),
    set: (_, ref, v) => { history.run(new SetCellCommand(String(ref), v)); return true; },
    has: (_, ref) => engine.raw(String(ref)) !== '',
  });

  for await (const step of script()) {
    say('>> ' + step.label);
    if (step.click) view.td(step.click).click();
    if (step.paste) view.td(ctrl.selection).dispatchEvent(new CustomEvent('sheet:paste', { bubbles: true, detail: { text: step.paste } }));
    if (step.clear) history.run(new ClearRangeCommand(...step.clear));
    for (const k of step.keys || []) {
      const [key, ctrlKey] = Array.isArray(k) ? k : [k, false];
      document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
    }
    await waitFrame();
    await waitFrame();
    say('   sel', ctrl.selection, 'history', history.depth);
  }
  say('== final grid');
  for (const l of view.render()) say(l);

  say('== proxy access');
  cellInput.A8 = '=D7*2';
  say('A8 =', cellInput.A8, 'has A8', 'A8' in cellInput, 'has F8', 'F8' in cellInput);
  say('dependents of B2', engine.dependents('B2'), 'of D7', engine.dependents('D7'));

  say('== parser checks');
  const exprs = ['1+2*3', '2^3^2', '-2^2', '(1+2)*3', '50%', '"a"&"b"&1', '1<2', '3>=3', '1<>1', 'SUM(1,2,3)+ABS(-4)', 'LEN("hello")', '1+', 'SUM(1', '1 2'];
  for (const src of exprs) {
    try {
      const ast = parseFormula(src);
      const scratch = new Engine();
      scratch.set('A1', '=' + src);
      say(fmt`${src.padEnd(20)} -> ${scratch.value('A1')}  deps=${collectDeps(ast).size}`);
    } catch (e) {
      say(src.padEnd(20), '-> parse error', e instanceof SheetError ? e.code : '?');
    }
  }
  await waitFrame();
  say('paints', view.paints, 'cellpaint events', paintEvents, 'recalcs', engine.recalcs);
  say('keys typed', ctrl.keyLog.length, 'last', ctrl.keyLog.slice(-5).join(' '));
  let errors = 0, numbers = 0, texts = 0;
  rows: for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = engine.value(refOf(c, r));
      if (v === '') continue;
      if (typeof v === 'string' && v.startsWith('#')) { errors++; if (errors > 20) break rows; } else if (typeof v === 'number') numbers++; else texts++;
    }
  }
  say('census', { errors, numbers, texts });
}

main().catch((e) => say('FATAL', e && e.message));
