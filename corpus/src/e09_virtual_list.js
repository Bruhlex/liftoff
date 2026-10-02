// Infinite, virtualized list. Items stream in page by page from an async-generator "API". Only the
// rows inside the viewport (plus overscan) exist in the DOM; row elements are recycled through a
// pool. A fake layout engine sizes rows from canvas text metrics, the list measures them back via
// getBoundingClientRect, keeps offsets in a Fenwick tree and anchors the scroll position when
// measured heights differ from estimates. Scroll and wheel events are coalesced to one update per
// animation frame. A hand-written size watcher plays the role of ResizeObserver. Selection,
// favourites (stopPropagation), keyboard navigation and a Proxy-backed filter drive the scenario.
'use strict';

const say = (...a) => console.log(a.join(' '));
const frame = () => new Promise((r) => requestAnimationFrame(r));
async function waitFrames(n) { for (let i = 0; i < n; i++) await frame(); }
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ tagged templates
function css(strings, ...vals) {
  const text = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? vals[i] : ''), '');
  const out = {};
  for (const [, k, v] of text.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v.trim();
  return out;
}
const trunc = (max) => (strings, ...vals) =>
  strings.reduce((acc, s, i) => {
    if (i >= vals.length) return acc + s;
    const v = String(vals[i]);
    return acc + s + (v.length > max ? v.slice(0, max - 1) + '~' : v);
  }, '');
const short = trunc(18);

// ------------------------------------------------------------------ data
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
  'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
function* wordStream(seed) {
  let s = seed >>> 0 || 1;
  while (true) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    yield WORDS[(s >>> 16) % WORDS.length];
  }
}
function makeItem(id) {
  const it = wordStream(id * 7919 + 13);
  const n = 2 + ((id * 37) % 29);
  const words = [];
  for (let i = 0; i < n; i++) words.push(it.next().value);
  return { id, group: String.fromCharCode(65 + Math.floor(id / 15)), title: `Item #${id}`, body: words.join(' '), fav: false };
}
let apiCalls = 0;
async function* pagedApi(pageSize, maxPages) {
  for (let page = 0; page < maxPages; page++) {
    apiCalls++;
    await waitFrames(2);
    yield { page, items: Array.from({ length: pageSize }, (_, i) => makeItem(page * pageSize + i)), last: page === maxPages - 1 };
  }
}

// ------------------------------------------------------------------ fake layout engine
const measureCanvas = document.createElement('canvas');
const mctx = measureCanvas.getContext('2d');
mctx.font = '14px sans-serif';
const CONTENT_WIDTH = 280;
const LayoutEngine = {
  reflows: 0,
  lineCount(text) {
    let lines = 1, width = 0;
    const space = mctx.measureText(' ').width;
    for (const w of text.split(' ')) {
      const ww = mctx.measureText(w).width;
      if (width > 0 && width + space + ww > CONTENT_WIDTH) { lines++; width = ww; } else width += (width > 0 ? space : 0) + ww;
    }
    return lines;
  },
  reflow(row) {
    this.reflows++;
    const body = row.querySelector('.body').textContent;
    const h = 16 + 18 + this.lineCount(body) * 20;
    Object.assign(row.style, css`height: ${h}px; width: ${CONTENT_WIDTH + 20}px`);
  },
};

// ------------------------------------------------------------------ Fenwick tree of heights
class Fenwick {
  #tree; #vals;
  constructor(values = []) { this.#rebuild(values); }
  #rebuild(values) {
    this.#vals = values.slice();
    const n = values.length;
    this.#tree = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const j = i + 1;
      this.#tree[j] += values[i];
      const p = j + (j & -j);
      if (p <= n) this.#tree[p] += this.#tree[j];
    }
  }
  get size() { return this.#vals.length; }
  push(...vs) { this.#rebuild(this.#vals.concat(vs)); }
  get(i) { return this.#vals[i]; }
  set(i, v) {
    const d = v - this.#vals[i];
    if (!d) return 0;
    this.#vals[i] = v;
    for (let j = i + 1; j <= this.size; j += j & -j) this.#tree[j] += d;
    return d;
  }
  prefix(i) { let s = 0; for (let j = i; j > 0; j -= j & -j) s += this.#tree[j]; return s; }
  total() { return this.prefix(this.size); }
  lowerBound(target) {
    if (!this.size) return 0;
    let pos = 0, rem = target, step = 1;
    while (step * 2 <= this.size) step *= 2;
    for (; step > 0; step >>= 1) {
      if (pos + step <= this.size && this.#tree[pos + step] <= rem) { pos += step; rem -= this.#tree[pos]; }
    }
    return Math.min(pos, this.size - 1);
  }
}

// ------------------------------------------------------------------ manual ResizeObserver
class SizeWatcher {
  #sizes = new Map();
  #callback;
  constructor(callback) { this.#callback = callback; }
  observe(el) { if (!this.#sizes.has(el)) this.#sizes.set(el, -1); }
  unobserve(el) { this.#sizes.delete(el); }
  check() {
    const entries = [];
    for (const [el, old] of this.#sizes) {
      const h = el.getBoundingClientRect().height;
      if (h !== old) { entries.push({ target: el, oldHeight: old, height: h }); this.#sizes.set(el, h); }
    }
    if (entries.length) this.#callback(entries);
    return entries.length;
  }
}

// ------------------------------------------------------------------ virtual list
class VirtualList extends EventTarget {
  #viewport; #content; #cache = new Fenwick(); #items = []; #indexById = new Map();
  #scrollTop = 0; #viewH; #estimate; #overscan;
  #pool = []; #live = new Map(); #measured = new Map();
  #frameRequested = false;
  #watcher;
  stats = { created: 0, reused: 0, recycled: 0, frames: 0, scrollEvents: 0, anchorShifts: 0, passes: 0 };

  constructor(viewport, { estimate = 40, overscan = 2 } = {}) {
    super();
    this.#viewport = viewport;
    this.#estimate = estimate;
    this.#overscan = overscan;
    this.#viewH = viewport.getBoundingClientRect().height;
    this.#content = document.createElement('div');
    this.#content.className = 'content';
    viewport.appendChild(this.#content);
    this.#watcher = new SizeWatcher((entries) => {
      for (const { target, height } of entries) {
        const idx = this.#indexById.get(Number(target.dataset.id));
        if (idx === undefined) continue;
        this.#measured.set(Number(target.dataset.id), height);
        this.#cache.set(idx, height);
      }
    });
    viewport.addEventListener('scroll', () => { this.stats.scrollEvents++; this.schedule(); });
    viewport.addEventListener('wheel', (ev) => this.scrollTo(this.#scrollTop + ev.deltaY), { passive: true });
  }
  get content() { return this.#content; }
  get items() { return this.#items; }
  get scrollTop() { return this.#scrollTop; }
  get viewportHeight() { return this.#viewH; }
  get totalHeight() { return this.#cache.total(); }
  get liveCount() { return this.#live.size; }
  get poolSize() { return this.#pool.length; }
  offsetOf(i) { return this.#cache.prefix(i); }
  heightOf(i) { return this.#cache.get(i); }
  indexAt(y) { return this.#cache.lowerBound(y); }

  setItems(items) {
    this.#items = items;
    this.#indexById = new Map(items.map((it, i) => [it.id, i]));
    this.#cache = new Fenwick(items.map((it) => this.#measured.get(it.id) ?? this.#estimate));
    this.#scrollTop = Math.min(this.#scrollTop, Math.max(0, this.totalHeight - this.#viewH));
    this.schedule();
  }
  appendItems(items) {
    const base = this.#items.length;
    this.#items = this.#items.concat(items);
    items.forEach((it, i) => this.#indexById.set(it.id, base + i));
    this.#cache.push(...items.map((it) => this.#measured.get(it.id) ?? this.#estimate));
    this.schedule();
  }
  scrollTo(y) {
    const max = Math.max(0, this.totalHeight - this.#viewH);
    const next = Math.round(Math.max(0, Math.min(max, y)));
    if (next === this.#scrollTop) return false;
    this.#scrollTop = next;
    this.#viewport.dispatchEvent(new Event('scroll'));
    return true;
  }
  ensureVisible(i) {
    const top = this.offsetOf(i), bottom = top + this.heightOf(i);
    if (top < this.#scrollTop) return this.scrollTo(top);
    if (bottom > this.#scrollTop + this.#viewH) return this.scrollTo(bottom - this.#viewH);
    return false;
  }
  schedule() {
    if (this.#frameRequested) return;
    this.#frameRequested = true;
    requestAnimationFrame((ts) => { this.#frameRequested = false; this.#flush(ts); });
  }
  range() {
    const n = this.#items.length;
    if (!n) return [0, 0];
    const first = this.#cache.lowerBound(this.#scrollTop);
    let last = first, y = this.#cache.prefix(first);
    const bottom = this.#scrollTop + this.#viewH;
    while (last < n && y < bottom) { y += this.#cache.get(last); last++; }
    return [Math.max(0, first - this.#overscan), Math.min(n, last + this.#overscan)];
  }
  *liveRows() {
    const sorted = [...this.#live.values()].sort((a, b) => a.dataset.index - b.dataset.index);
    yield* sorted;
  }
  #flush(ts) {
    this.stats.frames++;
    const anchorIdx = this.#cache.lowerBound(this.#scrollTop);
    const anchorOffset = this.#scrollTop - this.#cache.prefix(anchorIdx);
    let range = this.range();
    passes: for (let pass = 0; pass < 4; pass++) {
      this.stats.passes++;
      this.#render(...range);
      const changed = this.#watcher.check();
      const wanted = Math.round(Math.min(Math.max(0, this.totalHeight - this.#viewH), this.#cache.prefix(anchorIdx) + anchorOffset));
      if (wanted !== this.#scrollTop && this.#items.length) { this.#scrollTop = wanted; this.stats.anchorShifts++; }
      const next = this.range();
      if (!changed && next[0] === range[0] && next[1] === range[1]) break passes;
      range = next;
    }
    for (const row of this.#live.values()) row.style.top = this.#cache.prefix(Number(row.dataset.index)) + 'px';
    this.#content.style.height = this.totalHeight + 'px';
    this.dispatchEvent(new CustomEvent('rangechange', { detail: { start: range[0], end: range[1], ts, total: this.#items.length } }));
  }
  #render(start, end) {
    for (const [id, row] of this.#live) {
      const idx = this.#indexById.get(id);
      if (idx === undefined || idx < start || idx >= end) {
        row.remove();
        this.#watcher.unobserve(row);
        this.#live.delete(id);
        this.#pool.push(row);
        this.stats.recycled++;
      }
    }
    for (let i = start; i < end; i++) {
      const item = this.#items[i];
      let row = this.#live.get(item.id);
      if (!row) {
        row = this.#pool.pop();
        if (row) this.stats.reused++;
        else { row = this.createRow(); this.stats.created++; }
        this.#content.appendChild(row);
        this.#live.set(item.id, row);
        this.#watcher.observe(row);
      }
      this.fillRow(row, item, i);
    }
  }
  refresh(id) {
    const row = this.#live.get(id);
    if (row) this.fillRow(row, this.#items[this.#indexById.get(id)], this.#indexById.get(id));
    this.schedule();
  }
  createRow() {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'option');
    for (const [tag, cls] of [['span', 'title'], ['p', 'body'], ['button', 'star']]) {
      const el = document.createElement(tag);
      el.className = cls;
      row.appendChild(el);
    }
    return row;
  }
  fillRow(row, item, index) {
    row.dataset.index = index;
    row.dataset.id = item.id;
    row.querySelector('.title').textContent = item.title;
    row.querySelector('.body').textContent = item.body;
    row.querySelector('.star').textContent = item.fav ? '*' : '-';
    LayoutEngine.reflow(row);
  }
}

class GroupedList extends VirtualList {
  #sticky;
  #selected = new Set();
  #anchorSel = -1;
  active = -1;
  constructor(viewport, opts, sticky) {
    super(viewport, opts);
    this.#sticky = sticky;
    this.addEventListener('rangechange', () => {
      const first = this.items[this.indexAt(this.scrollTop)];
      this.#sticky.textContent = first ? `Group ${first.group}` : '';
    });
  }
  get selected() { return [...this.#selected].sort((a, b) => a - b); }
  fillRow(row, item, index) {
    super.fillRow(row, item, index);
    row.classList.toggle('selected', this.#selected.has(item.id));
    row.classList.toggle('active', index === this.active);
    row.setAttribute('aria-selected', String(this.#selected.has(item.id)));
    const prev = this.items[index - 1];
    row.classList.toggle('group-start', !prev || prev.group !== item.group);
  }
  select(index, { shift = false, toggle = false } = {}) {
    const id = this.items[index]?.id;
    if (id === undefined) return;
    if (shift && this.#anchorSel >= 0) {
      const [a, b] = [Math.min(this.#anchorSel, index), Math.max(this.#anchorSel, index)];
      this.#selected.clear();
      for (let i = a; i <= b; i++) this.#selected.add(this.items[i].id);
    } else if (toggle) {
      this.#selected.has(id) ? this.#selected.delete(id) : this.#selected.add(id);
      this.#anchorSel = index;
    } else {
      this.#selected = new Set([id]);
      this.#anchorSel = index;
    }
    this.active = index;
    for (const row of this.liveRows()) this.fillRow(row, this.items[row.dataset.index], Number(row.dataset.index));
    this.schedule();
  }
  get stickyText() { return this.#sticky.textContent; }
}

// ------------------------------------------------------------------ mount
const app = document.getElementById('app');
const viewport = document.createElement('div');
viewport.id = 'viewport';
viewport.setAttribute('tabindex', '0');
Object.assign(viewport.style, css`position: relative; left: 10px; top: 60px; width: 300px; height: 420px; overflow-y: auto`);
const stickyHeader = document.createElement('div');
stickyHeader.className = 'sticky';
app.append(stickyHeader, viewport);

const list = new GroupedList(viewport, { estimate: 60, overscan: 2 }, stickyHeader);
let allItems = [];
const pages = pagedApi(50, 6);
let loading = false, exhausted = false, loads = 0;

const filterState = { text: '', favOnly: false };
let filterQueued = false;
const filter = new Proxy(filterState, {
  set(t, k, v) {
    if (t[k] === v) return true;
    t[k] = v;
    if (!filterQueued) {
      filterQueued = true;
      queueMicrotask(() => { filterQueued = false; applyFilter(); });
    }
    return true;
  },
});
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function applyFilter() {
  const re = filterState.text ? new RegExp('\\b' + escapeRe(filterState.text), 'i') : null;
  const visible = allItems.filter((it) => (!re || re.test(it.body)) && (!filterState.favOnly || it.fav));
  list.setItems(visible);
}

async function loadMore() {
  if (loading || exhausted) return false;
  loading = true;
  try {
    const { value, done } = await pages.next();
    if (done) { exhausted = true; return false; }
    loads++;
    allItems = allItems.concat(value.items);
    if (value.last) exhausted = true;
    if (filterState.text || filterState.favOnly) applyFilter();
    else list.appendItems(value.items);
    return true;
  } finally {
    loading = false;
  }
}

let lastRange = null;
list.addEventListener('rangechange', (ev) => {
  lastRange = ev.detail;
  if (!filterState.text && !filterState.favOnly && ev.detail.end >= ev.detail.total - 4) loadMore();
});

let captureClicks = 0, starToggles = 0;
viewport.addEventListener('click', () => { captureClicks++; }, true);
list.content.addEventListener('click', (ev) => {
  const star = ev.target.closest('.star');
  if (!star) return;
  ev.stopPropagation();
  const id = Number(star.closest('.row').dataset.id);
  const item = allItems.find((it) => it.id === id);
  item.fav = !item.fav;
  starToggles++;
  list.refresh(id);
});
viewport.addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (!row) return;
  list.select(Number(row.dataset.index), { shift: ev.shiftKey, toggle: ev.ctrlKey || ev.metaKey });
});
viewport.addEventListener('keydown', (ev) => {
  const n = list.items.length;
  const perPage = Math.max(1, Math.floor(list.viewportHeight / 60));
  const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: perPage, PageUp: -perPage, Home: -Infinity, End: Infinity };
  if (!(ev.key in moves)) return;
  ev.preventDefault();
  const target = Math.max(0, Math.min(n - 1, (list.active < 0 ? 0 : list.active) + moves[ev.key]));
  list.select(target, { shift: ev.shiftKey });
  list.ensureVisible(target);
});

// ------------------------------------------------------------------ reporting
function report(label) {
  const rows = [...list.liveRows()];
  const text = rows.map((r) => r.dataset.index + ':' + r.querySelector('.title').textContent + r.querySelector('.star').textContent).join('|');
  const [first, last] = [rows[0], rows[rows.length - 1]];
  const firstBody = first ? list.items[first.dataset.index].body : '';
  say(`${label.padEnd(24)} top=${String(list.scrollTop).padStart(6)} range=[${lastRange?.start},${lastRange?.end}) rows=${rows.length} ` +
    `items=${list.items.length} total=${list.totalHeight} ${list.stickyText || '-'} #${fnv(text)}`);
  if (first) say('    first:', short`${list.items[first.dataset.index].title} ${firstBody}`, '| last:', last.querySelector('.title').textContent, '| top px', first.style.top);
}
async function scrollStep(label, y) {
  list.scrollTo(y);
  await waitFrames(2);
  report(label);
}

async function main() {
  say('viewport', JSON.stringify(viewport.getBoundingClientRect().toJSON()));
  say('line counts for samples:', [0, 7, 13, 28].map((id) => LayoutEngine.lineCount(makeItem(id).body)).join(','));
  await loadMore();
  await waitFrames(3);
  report('initial');
  for (const y of [120, 480, 1000, 1600]) await scrollStep('scroll ' + y, y);
  say('-- burst of scrolls in one tick (coalesced)');
  const beforeFrames = list.stats.frames;
  for (let y = 1700; y <= 2300; y += 100) list.scrollTo(y);
  await waitFrames(2);
  report('burst end');
  say('    frames for burst:', list.stats.frames - beforeFrames, 'scroll events so far:', list.stats.scrollEvents);
  say('-- wheel');
  for (let i = 0; i < 5; i++) viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
  await waitFrames(2);
  report('after wheel x5');
  say('-- infinite loading');
  let guard = 0;
  loadLoop: while (!exhausted) {
    if (++guard > 40) { say('    guard tripped'); break; }
    try {
      list.scrollTo(list.totalHeight);
      await waitFrames(4);
      if (loading) continue loadLoop;
    } finally {
      if (guard % 3 === 0) report(`bottom (pass ${guard})`);
    }
  }
  await waitFrames(4);
  report('all loaded');
  say('    pages loaded:', loads, 'api calls:', apiCalls, 'items:', allItems.length);
  say('-- scroll back through measured region');
  for (const y of [0, 2000, 7000, 12000]) await scrollStep('revisit ' + y, y);
  say('-- selection via clicks');
  await scrollStep('to 3000', 3000);
  const rowsNow = [...list.liveRows()];
  rowsNow[3].querySelector('.title').click();
  rowsNow[6].querySelector('.body').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  rowsNow[4].querySelector('.star').click();
  rowsNow[5].querySelector('.star').click();
  rowsNow[8].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  await waitFrames(2);
  report('after clicks');
  say('    selected ids:', list.selected.join(','), '| favs:', allItems.filter((i) => i.fav).map((i) => i.id).join(','));
  say('-- keyboard');
  for (const [k, shift] of [['ArrowDown'], ['ArrowDown'], ['PageDown'], ['PageDown', true], ['End'], ['ArrowUp'], ['Home']]) {
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true, cancelable: true }));
    await waitFrames(2);
    report(`key ${shift ? 'Shift+' : ''}${k} (act ${list.active})`);
  }
  say('    selected count:', list.selected.length);
  say('-- filter');
  filter.text = 'zul';
  filter.text = 'delta';
  await waitFrames(3);
  report('filter "delta"');
  await scrollStep('filtered 1500', 1500);
  filter.favOnly = true;
  await waitFrames(3);
  report('delta + favOnly');
  filter.text = '';
  await waitFrames(3);
  report('favOnly');
  filter.favOnly = false;
  await waitFrames(3);
  report('filter cleared');
  say('-- content edit changes row height (size watcher + anchoring)');
  await scrollStep('to 5000', 5000);
  const target = list.items[list.indexAt(list.scrollTop) - 1];
  const beforeTop = list.offsetOf(list.indexAt(list.scrollTop));
  target.body += ' ' + target.body + ' ' + target.body;
  list.refresh(target.id);
  await waitFrames(3);
  report('after edit above anchor');
  say('    edited', target.id, 'anchor moved by', list.offsetOf(list.indexAt(list.scrollTop)) - beforeTop, 'px; shifts', list.stats.anchorShifts);
  say('stats:', JSON.stringify(list.stats));
  say('pool:', list.poolSize, 'live:', list.liveCount, 'reflows:', LayoutEngine.reflows, 'clicks(capture):', captureClicks, 'stars:', starToggles);
  say('dom rows attached:', list.content.querySelectorAll('.row').length, 'content height:', list.content.style.height);
}

main().catch((e) => say('FAILED', e instanceof Error ? e.message : String(e)));
