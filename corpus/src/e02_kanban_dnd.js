// Drag-and-drop kanban board driven entirely by synthetic PointerEvents. Cards and columns are laid out
// absolutely (style.left/top/width/height) so getBoundingClientRect works for hit testing. A drag
// controller with a private state machine handles press / threshold / drag / drop, a placeholder
// follows the pointer, WIP limits reject drops through cancelable custom events, a keyboard mode
// offers the same moves, a hand-written child-list watcher reports DOM mutations per frame, and all
// moves are undoable. Gestures are replayed frame by frame through requestAnimationFrame.
'use strict';

const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const frame = () => new Promise((r) => requestAnimationFrame(r));

// ---------------------------------------------------------------- layout constants
const COL_W = 200, COL_GAP = 20, HEADER_H = 40, CARD_H = 60, CARD_GAP = 8, BOARD_X = 20, BOARD_Y = 100;
const DRAG_THRESHOLD = 6;

function cls(strings, ...vals) {
  // tagged template producing a normalised class list: falsy holes vanish, arrays spread
  const parts = [];
  strings.forEach((s, i) => {
    parts.push(...s.split(/\s+/));
    if (i < vals.length) {
      const v = vals[i];
      if (Array.isArray(v)) parts.push(...v.filter(Boolean));
      else if (v) parts.push(String(v));
    }
  });
  return [...new Set(parts.filter(Boolean))].join(' ');
}

// ---------------------------------------------------------------- reactive board model
function observable(target, onChange, path = []) {
  return new Proxy(target, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      return v && typeof v === 'object' && typeof k === 'string' ? observable(v, onChange, path.concat(k)) : v;
    },
    set(t, k, v, r) {
      const had = Object.prototype.hasOwnProperty.call(t, k);
      const old = t[k];
      const ok = Reflect.set(t, k, v, r);
      if (!had || old !== v) onChange({ op: had ? 'set' : 'add', path: path.concat(String(k)).join('/') });
      return ok;
    },
    deleteProperty(t, k) {
      const ok = Reflect.deleteProperty(t, k);
      onChange({ op: 'del', path: path.concat(String(k)).join('/') });
      return ok;
    },
  });
}

class BoardModel extends EventTarget {
  #raw;
  #changes = [];
  #undo = [];
  #redo = [];
  constructor(data) {
    super();
    this.#raw = data;
    this.state = observable(data, (c) => this.#changes.push(c));
  }
  drainChanges() {
    const summary = {};
    for (const { op, path } of this.#changes) {
      const key = op + ':' + path.replace(/\/\d+/g, '/#');
      summary[key] = (summary[key] || 0) + 1;
    }
    this.#changes.length = 0;
    return summary;
  }
  column(id) { return this.state.columns.find((c) => c.id === id); }
  locate(cardId) {
    const cols = this.state.columns;
    for (let ci = 0; ci < cols.length; ci++) {
      const idx = cols[ci].cards.indexOf(cardId);
      if (idx !== -1) return { col: cols[ci].id, index: idx };
    }
    return null;
  }
  canAccept(colId, cardId) {
    const col = this.column(colId);
    if (!col) return false;
    const from = this.locate(cardId);
    if (from?.col === colId) return true;
    return col.limit == null || col.cards.length < col.limit;
  }
  move(cardId, toCol, toIndex, record = true) {
    const from = this.locate(cardId);
    if (!from) throw new Error('unknown card ' + cardId);
    const src = this.column(from.col).cards;
    const dst = this.column(toCol).cards;
    src.splice(from.index, 1);
    const clamped = Math.max(0, Math.min(toIndex, dst.length));
    dst.splice(clamped, 0, cardId);
    if (record) { this.#undo.push({ cardId, from, to: { col: toCol, index: clamped } }); this.#redo.length = 0; }
    this.dispatchEvent(new CustomEvent('moved', { detail: { cardId, from, to: { col: toCol, index: clamped } } }));
    return { from, to: { col: toCol, index: clamped } };
  }
  undo() {
    const m = this.#undo.pop();
    if (!m) return false;
    this.move(m.cardId, m.from.col, m.from.index, false);
    this.#redo.push(m);
    return true;
  }
  redo() {
    const m = this.#redo.pop();
    if (!m) return false;
    this.move(m.cardId, m.to.col, m.to.index, false);
    this.#undo.push(m);
    return true;
  }
  get history() { return { undo: this.#undo.length, redo: this.#redo.length }; }
  summary() {
    return this.#raw.columns.map((c) => c.id + '[' + c.cards.join(',') + ']').join(' ');
  }
}

// ---------------------------------------------------------------- DOM view
class BoardView {
  #root;
  #model;
  #cardEls = new Map();
  #colEls = new Map();
  constructor(root, model) {
    this.#root = root;
    this.#model = model;
    root.className = 'board';
    Object.assign(root.style, { position: 'relative', left: '0px', top: '0px', width: '900px', height: '600px' });
    const { columns, cards } = model.state;
    columns.forEach((col, i) => {
      const el = document.createElement('div');
      el.className = cls`column ${col.limit != null && 'limited'}`;
      el.dataset.col = col.id;
      const h = document.createElement('h2');
      h.textContent = col.title;
      el.appendChild(h);
      this.#colEls.set(col.id, el);
      root.appendChild(el);
      Object.assign(el.style, { left: BOARD_X + i * (COL_W + COL_GAP) + 'px', top: BOARD_Y + 'px', width: COL_W + 'px', height: '480px' });
    });
    for (const [id, card] of Object.entries(cards)) {
      const el = document.createElement('div');
      el.className = cls`card ${'p' + card.points} ${card.blocked && 'blocked'}`;
      el.dataset.card = id;
      el.setAttribute('tabindex', '0');
      el.textContent = card.title;
      this.#cardEls.set(id, el);
    }
    this.layout();
  }
  get root() { return this.#root; }
  cardEl(id) { return this.#cardEls.get(id); }
  colEl(id) { return this.#colEls.get(id); }
  layout(placeholder = null, dragging = null) {
    const cols = this.#model.state.columns;
    cols.forEach((col, ci) => {
      const colEl = this.#colEls.get(col.id);
      const x = BOARD_X + ci * (COL_W + COL_GAP);
      let slot = 0;
      const ids = col.cards.filter((c) => c !== dragging);
      for (let i = 0; i <= ids.length; i++) {
        if (placeholder && placeholder.col === col.id && placeholder.index === i) slot++;
        if (i === ids.length) break;
        const el = this.#cardEls.get(ids[i]);
        if (el.parentNode !== colEl || colEl.children[i + 1] !== el) colEl.insertBefore(el, colEl.children[i + 1] || null);
        Object.assign(el.style, { left: x + 8 + 'px', top: BOARD_Y + HEADER_H + slot * (CARD_H + CARD_GAP) + 'px', width: COL_W - 16 + 'px', height: CARD_H + 'px' });
        slot++;
      }
    });
  }
  hitColumn(x, y) {
    for (const [id, el] of this.#colEls) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return id;
    }
    return null;
  }
  insertionIndex(colId, y, dragging) {
    const ids = this.#model.column(colId).cards.filter((c) => c !== dragging);
    let index = ids.length;
    scan: for (let i = 0; i < ids.length; i++) {
      const r = this.#cardEls.get(ids[i]).getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (y < mid) { index = i; break scan; }
    }
    return index;
  }
}

// ---------------------------------------------------------------- manual child-list watcher
class ChildListWatcher {
  #targets = new Map();
  #callback;
  constructor(callback) { this.#callback = callback; }
  observe(el, label) { this.#targets.set(el, { label, snapshot: [...el.children] }); }
  takeRecords() {
    const records = [];
    for (const [el, info] of this.#targets) {
      const now = [...el.children];
      const added = now.filter((n) => !info.snapshot.includes(n));
      const removed = info.snapshot.filter((n) => !now.includes(n));
      const reordered = !added.length && !removed.length && now.some((n, i) => n !== info.snapshot[i]);
      if (added.length || removed.length || reordered) {
        records.push({ target: info.label, added: added.map((n) => n.dataset.card), removed: removed.map((n) => n.dataset.card), reordered });
      }
      info.snapshot = now;
    }
    return records;
  }
  flush() { const r = this.takeRecords(); if (r.length) this.#callback(r); return r.length; }
}

// ---------------------------------------------------------------- drag controller
class DragController {
  #view;
  #model;
  #phase = 'idle';
  #pointerId = null;
  #cardId = null;
  #origin = null;
  #grab = null;
  #target = null;
  #ghost = null;
  #moves = 0;
  #stats = { started: 0, dropped: 0, cancelled: 0, rejected: 0, clicks: 0 };
  constructor(view, model) {
    this.#view = view;
    this.#model = model;
    const root = view.root;
    root.addEventListener('pointerdown', (e) => this.#onDown(e));
    document.addEventListener('pointermove', (e) => this.#onMove(e), true);
    document.addEventListener('pointerup', (e) => this.#onUp(e), true);
    document.addEventListener('pointercancel', () => this.#cancel('pointercancel'), true);
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.#phase === 'dragging') { e.stopPropagation(); this.#cancel('escape'); } }, true);
  }
  get phase() { return this.#phase; }
  get stats() { return { ...this.#stats }; }
  #onDown(e) {
    if (this.#phase !== 'idle' || e.button !== 0) return;
    const cardEl = e.target.closest?.('.card');
    if (!cardEl) return;
    if (cardEl.classList.contains('blocked')) { say('  press ignored: card', cardEl.dataset.card, 'is blocked'); return; }
    this.#phase = 'pressed';
    this.#pointerId = e.pointerId;
    this.#cardId = cardEl.dataset.card;
    this.#origin = { x: e.clientX, y: e.clientY };
    const r = cardEl.getBoundingClientRect();
    this.#grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    this.#moves = 0;
  }
  #onMove(e) {
    if (e.pointerId !== this.#pointerId) return;
    this.#moves++;
    if (this.#phase === 'pressed') {
      const dist = Math.hypot(e.clientX - this.#origin.x, e.clientY - this.#origin.y);
      if (dist < DRAG_THRESHOLD) return;
      this.#phase = 'dragging';
      this.#stats.started++;
      this.#ghost = this.#view.cardEl(this.#cardId).cloneNode(true);
      this.#ghost.classList.add('ghost');
      this.#view.root.appendChild(this.#ghost);
      this.#view.root.dispatchEvent(new CustomEvent('drag:start', { bubbles: true, detail: { card: this.#cardId } }));
    }
    if (this.#phase !== 'dragging') return;
    Object.assign(this.#ghost.style, { left: e.clientX - this.#grab.dx + 'px', top: e.clientY - this.#grab.dy + 'px' });
    const col = this.#view.hitColumn(e.clientX, e.clientY);
    const next = col ? { col, index: this.#view.insertionIndex(col, e.clientY, this.#cardId) } : null;
    if (next?.col !== this.#target?.col || next?.index !== this.#target?.index) {
      this.#target = next;
      this.#view.layout(next, this.#cardId);
    }
  }
  #onUp(e) {
    if (e.pointerId !== this.#pointerId) return;
    try {
      if (this.#phase === 'pressed') {
        this.#stats.clicks++;
        this.#view.root.dispatchEvent(new CustomEvent('card:open', { bubbles: true, detail: { card: this.#cardId } }));
        return;
      }
      if (this.#phase !== 'dragging') return;
      if (!this.#target) { this.#stats.cancelled++; say('  drop outside board -> cancelled'); return; }
      const { col, index } = this.#target;
      const ok = this.#view.root.dispatchEvent(new CustomEvent('card:beforedrop', { bubbles: true, cancelable: true, detail: { card: this.#cardId, col, index } }));
      if (!ok || !this.#model.canAccept(col, this.#cardId)) {
        this.#stats.rejected++;
        this.#view.root.dispatchEvent(new CustomEvent('card:rejected', { bubbles: true, detail: { card: this.#cardId, col, vetoed: !ok } }));
        return;
      }
      this.#model.move(this.#cardId, col, index);
      this.#stats.dropped++;
    } finally {
      this.#cleanup();
    }
  }
  #cancel(reason) {
    if (this.#phase === 'idle') return;
    this.#stats.cancelled++;
    say('  drag cancelled by', reason);
    this.#cleanup();
  }
  #cleanup() {
    this.#ghost?.remove();
    this.#ghost = null;
    this.#phase = 'idle';
    this.#pointerId = null;
    this.#target = null;
    this.#cardId = null;
    this.#view.layout();
  }
}

// ---------------------------------------------------------------- keyboard mover
class KeyboardMover {
  #picked = null;
  constructor(view, model) {
    view.root.addEventListener('keydown', (e) => {
      const cardEl = e.target.closest?.('.card');
      if (!cardEl) return;
      const id = cardEl.dataset.card;
      if (e.key === ' ') { this.#picked = this.#picked === id ? null : id; say('  kbd', this.#picked ? 'picked' : 'dropped', id); e.preventDefault(); return; }
      if (this.#picked !== id) return;
      const pos = model.locate(id);
      const colIds = model.state.columns.map((c) => c.id);
      const ci = colIds.indexOf(pos.col);
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir) return;
      const [dc, di] = dir;
      const targetCol = colIds[ci + dc];
      if (!targetCol) { say('  kbd edge reached'); return; }
      const index = dc ? Math.min(pos.index, model.column(targetCol).cards.length) : pos.index + di;
      if (index < 0 || (!dc && index >= model.column(targetCol).cards.length)) { say('  kbd bounds'); return; }
      if (!model.canAccept(targetCol, id)) { say('  kbd wip limit on', targetCol); return; }
      model.move(id, targetCol, index);
      view.layout();
    });
  }
}

// ---------------------------------------------------------------- gesture driver
function* interpolate(from, to, steps) {
  for (let i = 1; i <= steps; i++) {
    yield { x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: Math.round(from.y + ((to.y - from.y) * i) / steps) };
  }
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

let pointerSeq = 1;
async function* gesture(view, spec) {
  const pid = pointerSeq++;
  const startEl = spec.card ? view.cardEl(spec.card) : null;
  const start = startEl ? centerOf(startEl) : spec.from;
  const fire = (type, p, target = document.body) => {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    target.dispatchEvent(ev);
  };
  fire('pointerdown', start, startEl || view.root);
  yield 'down@' + start.x + ',' + start.y;
  let last = start;
  for (const wp of spec.waypoints) {
    for (const p of interpolate(last, wp, spec.steps ?? 4)) {
      fire('pointermove', p);
      last = p;
    }
    await frame();
    yield 'move@' + last.x + ',' + last.y;
  }
  if (spec.escape) {
    view.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    yield 'escape';
  }
  fire(spec.cancel ? 'pointercancel' : 'pointerup', last);
  yield (spec.cancel ? 'cancel@' : 'up@') + last.x + ',' + last.y;
}

function slotPoint(colIndex, slot) {
  return { x: BOARD_X + colIndex * (COL_W + COL_GAP) + COL_W / 2, y: BOARD_Y + HEADER_H + slot * (CARD_H + CARD_GAP) + 10 };
}

// ---------------------------------------------------------------- main scenario
async function main() {
  const host = document.getElementById('app');
  host.textContent = '';
  const boardEl = document.createElement('div');
  host.appendChild(boardEl);

  const model = new BoardModel({
    columns: [
      { id: 'todo', title: 'To do', limit: null, cards: ['k1', 'k2', 'k3', 'k4'] },
      { id: 'doing', title: 'Doing', limit: 2, cards: ['k5'] },
      { id: 'review', title: 'Review', limit: 2, cards: ['k6', 'k7'] },
      { id: 'done', title: 'Done', limit: null, cards: [] },
    ],
    cards: {
      k1: { title: 'Login form', points: 3 }, k2: { title: 'Password reset', points: 2 }, k3: { title: 'Avatar upload', points: 5, blocked: true },
      k4: { title: 'Dark mode', points: 1 }, k5: { title: 'Search API', points: 8 }, k6: { title: 'Pagination', points: 2 }, k7: { title: 'Error pages', points: 1 },
    },
  });
  const view = new BoardView(boardEl, model);
  const drag = new DragController(view, model);
  new KeyboardMover(view, model);
  const watcher = new ChildListWatcher((records) => {
    for (const r of records) say('  mutation', r.target, 'added=' + r.added.join(',') + ' removed=' + r.removed.join(',') + (r.reordered ? ' reordered' : ''));
  });
  for (const col of model.state.columns) watcher.observe(view.colEl(col.id), col.id);
  watcher.takeRecords();
  model.drainChanges();

  const eventsSeen = [];
  boardEl.addEventListener('drag:start', (e) => eventsSeen.push('start:' + e.detail.card));
  boardEl.addEventListener('card:open', (e) => say('  open card', e.detail.card, model.state.cards[e.detail.card].title));
  boardEl.addEventListener('card:rejected', (e) => { say('  rejected', e.detail.card, 'into', e.detail.col, e.detail.vetoed ? '(vetoed)' : '(wip limit)'); e.stopPropagation(); });
  host.addEventListener('card:rejected', () => say('  !! rejection leaked to host'));
  host.addEventListener('card:beforedrop', (e) => {
    const { card, col } = e.detail;
    if (col === 'done' && model.state.cards[card].points > 5) e.preventDefault();
  });
  model.addEventListener('moved', ({ detail: { cardId, from, to } }) => eventsSeen.push(`${cardId}:${from.col}/${from.index}->${to.col}/${to.index}`));

  const scenarios = [
    { label: 'drag k1 todo -> doing top', card: 'k1', waypoints: [slotPoint(0, 0), slotPoint(1, 0)] },
    { label: 'click k2 (below threshold)', card: 'k2', waypoints: [{ x: 122, y: 172 }], steps: 1 },
    { label: 'drag blocked k3', card: 'k3', waypoints: [slotPoint(2, 0)] },
    { label: 'drag k4 -> doing (wip full)', card: 'k4', waypoints: [slotPoint(1, 2)] },
    { label: 'drag k6 review -> done', card: 'k6', waypoints: [slotPoint(2, 3), slotPoint(3, 0)], steps: 3 },
    { label: 'drag k5 -> done (vetoed, 8 pts)', card: 'k5', waypoints: [slotPoint(3, 1)] },
    { label: 'drag k2 outside board', card: 'k2', waypoints: [{ x: 880, y: 20 }] },
    { label: 'drag k7 then escape', card: 'k7', waypoints: [slotPoint(3, 0)], escape: true },
    { label: 'drag k4 reorder within todo', card: 'k4', waypoints: [slotPoint(0, 0)] },
    { label: 'drag k7 -> done bottom via cancel', card: 'k7', waypoints: [slotPoint(3, 2)], cancel: true },
    { label: 'drag k7 -> done bottom', card: 'k7', waypoints: [slotPoint(3, 1), slotPoint(3, 2)] },
  ];

  let n = 0;
  for (const sc of scenarios) {
    n++;
    say(`#${n} ${sc.label}`);
    const trace = [];
    for await (const step of gesture(view, sc)) trace.push(step);
    say('  trace', trace.join(' '));
    say('  phase', drag.phase, 'board', model.summary());
    await frame();
    watcher.flush();
    const changes = model.drainChanges();
    const keys = Object.keys(changes).sort();
    if (keys.length) say('  model changes', keys.map((k) => k + 'x' + changes[k]).join(' '));
  }

  say('keyboard session');
  const k1 = view.cardEl('k1');
  const keys = [' ', 'ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowLeft', ' ', 'ArrowLeft'];
  for (const key of keys) {
    k1.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await frame();
  }
  say('  board', model.summary());
  watcher.flush();

  say('undo / redo');
  let undone = 0;
  while (model.undo()) {
    undone++;
    if (undone === 3) { say('  after 3 undos', model.summary()); }
  }
  say('  undone', undone, model.summary(), model.history);
  for (let i = 0; i < 2; i++) model.redo();
  view.layout();
  say('  redo x2', model.summary(), model.history);
  watcher.flush();

  say('layout report');
  for (const col of model.state.columns) {
    const rows = col.cards.map((id) => {
      const r = view.cardEl(id).getBoundingClientRect();
      return `${id}@${r.left},${r.top}`;
    });
    say(' ', col.id.padEnd(6), rows.join(' ') || '(empty)');
  }
  say('events', eventsSeen.join(' | '));
  say('stats', drag.stats);
  const points = model.state.columns.map(({ id, cards }) => [id, cards.reduce((s, c) => s + model.state.cards[c].points, 0)]);
  say('points per column', Object.fromEntries(points));
  say('ghosts left', boardEl.querySelectorAll('.ghost').length, 'cards in DOM', boardEl.querySelectorAll('.card').length);
}

main().then(() => say('done'), (e) => say('FATAL', e && e.message));
