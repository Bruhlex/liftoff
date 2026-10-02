// Canvas charting library: linear / log / band scales with "nice" ticks, a Chart base class with a
// layout pass (title, legend rows measured with measureText, tick-label margins), line / bar / pie /
// scatter subclasses, eased entrance animations driven by an async generator over animation frames,
// Proxy-backed options that batch redraws per frame, pointer hit-testing that emits bubbling custom
// events, a delegated DOM legend, collision-avoiding label placement, and a canvas hash per chart.
'use strict';

const out = (...a) => console.log(a.join(' '));
const frame = () => new Promise((r) => requestAnimationFrame(r));
const r2 = (n) => Math.round(n * 100) / 100;
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
// tagged template for accessible descriptions: numbers are locale-formatted, arrays joined
function describe(strings, ...values) {
  return strings.reduce((acc, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const txt = typeof v === 'number' ? nf.format(v) : Array.isArray(v) ? v.join(', ') : String(v);
    return acc + txt + s;
  }, '');
}

// ---------------------------------------------------------------- scales
class Scale {
  #domain; #range;
  constructor(domain, range) { this.#domain = domain.slice(); this.#range = range.slice(); }
  get domain() { return this.#domain.slice(); }
  get range() { return this.#range.slice(); }
  set domain(d) { this.#domain = d.slice(); }
  map() { throw new TypeError('abstract scale'); }
  *ticks() {}
}
function niceStep(span, count) {
  const rawStep = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}
class LinearScale extends Scale {
  nice(count = 5) {
    const [lo, hi] = this.domain;
    const step = niceStep(hi - lo || 1, count);
    this.domain = [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
    this.step = step;
    return this;
  }
  map(v) {
    const [d0, d1] = this.domain, [r0, r1] = this.range;
    return r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
  }
  invert(px) {
    const [d0, d1] = this.domain, [r0, r1] = this.range;
    return d0 + ((px - r0) / (r1 - r0)) * (d1 - d0);
  }
  *ticks() {
    const [lo, hi] = this.domain;
    const step = this.step ?? niceStep(hi - lo, 5);
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    for (let v = lo; v <= hi + step / 1e6; v += step) yield { value: v, label: (Math.round(v / step) * step).toFixed(decimals) };
  }
}
class LogScale extends LinearScale {
  map(v) { const [d0, d1] = this.domain.map(Math.log10), [r0, r1] = this.range; return r0 + ((Math.log10(v) - d0) / (d1 - d0)) * (r1 - r0); }
  nice() { const [lo, hi] = this.domain; this.domain = [10 ** Math.floor(Math.log10(lo)), 10 ** Math.ceil(Math.log10(hi))]; return this; }
  *ticks() {
    const [lo, hi] = this.domain;
    for (let v = lo; v <= hi * 1.0001; v *= 10) yield { value: v, label: v >= 1000 ? v / 1000 + 'k' : String(v) };
  }
}
class BandScale extends Scale {
  constructor(domain, range, padding = 0.2) { super(domain, range); this.padding = padding; }
  get bandwidth() { const [r0, r1] = this.range; return ((r1 - r0) / this.domain.length) * (1 - this.padding); }
  map(v) {
    const [r0, r1] = this.range;
    const slot = (r1 - r0) / this.domain.length;
    return r0 + slot * this.domain.indexOf(v) + (slot * this.padding) / 2;
  }
  *ticks() { for (const v of this.domain) yield { value: v, label: String(v), center: this.map(v) + this.bandwidth / 2 }; }
}

// ---------------------------------------------------------------- recording context wrapper
function recordingContext(ctx, counts) {
  return new Proxy(ctx, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== 'function') return v;
      return (...args) => { counts[k] = (counts[k] || 0) + 1; return v.apply(t, args); };
    },
    set(t, k, v) { counts['=' + String(k)] = (counts['=' + String(k)] || 0) + 1; t[k] = v; return true; },
  });
}

// ---------------------------------------------------------------- reactive options
function reactiveOptions(obj, onChange) {
  return new Proxy(obj, {
    set(t, k, v) {
      if (t[k] === v) return true;
      t[k] = v;
      onChange(k);
      return true;
    },
  });
}

// ---------------------------------------------------------------- charts
const THEMES = {
  light: { bg: '#ffffff', fg: '#222222', grid: '#e5e5e5', palette: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'] },
  dark: { bg: '#111111', fg: '#eeeeee', grid: '#333333', palette: ['#4e9ee6', '#ffa347', '#5fd35f', '#f06363', '#b594dd'] },
};
const theme = THEMES[matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'];

let chartSeq = 0;
class Chart {
  #canvas; #counts = {}; #pendingKeys = new Set(); #scheduled = false;
  constructor(canvas, { title, series, labels = [], ...opts }) {
    this.id = 'chart' + ++chartSeq;
    this.#canvas = canvas;
    this.ctx = recordingContext(canvas.getContext('2d'), this.#counts);
    this.title = title;
    this.series = series;
    this.labels = labels;
    this.hidden = new Set();
    this.redraws = 0;
    this.geometry = [];
    this.options = reactiveOptions({ font: '12px Arial', legend: 'bottom', ...opts }, (key) => this.#schedule(key));
  }
  get canvas() { return this.#canvas; }
  get width() { return this.#canvas.width; }
  get height() { return this.#canvas.height; }
  get visibleSeries() { return this.series.filter((s) => !this.hidden.has(s.name)); }
  #schedule(key) {
    this.#pendingKeys.add(key);
    if (this.#scheduled) return;
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      const keys = [...this.#pendingKeys].join(',');
      this.#pendingKeys.clear();
      this.draw();
      this.#canvas.dispatchEvent(new CustomEvent('chart:redraw', { bubbles: true, detail: { chart: this.id, keys } }));
    });
  }
  invalidate(reason) { this.#schedule(reason); }
  opCount() { return Object.values(this.#counts).reduce((a, b) => a + b, 0); }
  topOps(n = 4) { return Object.entries(this.#counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => k + ':' + v).join(' '); }
  hash() { const url = this.#canvas.toDataURL(); return hashString(url) + '/' + url.length; }
  layoutLegend(maxWidth) {
    const { ctx } = this;
    ctx.font = this.options.font;
    const rows = [[]];
    let x = 0;
    for (const [i, name] of this.legendNames().entries()) {
      const w = 18 + ctx.measureText(name).width + 12;
      if (x + w > maxWidth && rows[rows.length - 1].length) { rows.push([]); x = 0; }
      rows[rows.length - 1].push({ name, x, w: r2(w), color: theme.palette[i % theme.palette.length] });
      x += w;
    }
    return rows;
  }
  layout() {
    const pad = 10;
    const titleH = this.title ? 22 : 0;
    const legendRows = this.options.legend === 'none' ? [] : this.layoutLegend(this.width - 2 * pad);
    const legendH = legendRows.length * 18;
    const margins = this.axisMargins();
    const plot = {
      x: pad + margins.left,
      y: pad + titleH + (this.options.legend === 'top' ? legendH : 0),
      w: this.width - 2 * pad - margins.left - margins.right,
      h: this.height - 2 * pad - titleH - legendH - margins.bottom,
    };
    this.layoutInfo = { plot, legendRows, legendY: this.options.legend === 'top' ? pad + titleH : plot.y + plot.h + margins.bottom + 4, titleH };
    return this.layoutInfo;
  }
  axisMargins() { return { left: 0, right: 0, bottom: 0 }; }
  legendNames() { return this.series.map((s) => s.name); }
  draw(progress = 1) {
    const { ctx } = this;
    this.redraws++;
    this.geometry = [];
    const L = this.layout();
    ctx.save();
    try {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, this.width, this.height);
      if (this.title) {
        ctx.font = 'bold 14px Arial';
        ctx.fillStyle = theme.fg;
        ctx.textAlign = 'center';
        ctx.fillText(this.title, this.width / 2, 24);
      }
      this.prepare(L.plot);
      this.drawAxes(L.plot);
      if (progress <= 0) return false;
      this.drawSeries(L.plot, Math.min(1, progress));
      this.drawLegend(L);
      return true;
    } finally {
      ctx.restore();
    }
  }
  prepare() {}
  drawAxes() {}
  drawSeries() {}
  drawLegend({ legendRows, legendY }) {
    const { ctx } = this;
    ctx.font = this.options.font;
    ctx.textAlign = 'left';
    legendRows.forEach((row, ri) => {
      const rowW = row.reduce((a, it) => a + it.w, 0);
      const x0 = (this.width - rowW) / 2;
      for (const it of row) {
        ctx.globalAlpha = this.hidden.has(it.name) ? 0.3 : 1;
        ctx.fillStyle = it.color;
        ctx.fillRect(x0 + it.x, legendY + ri * 18, 12, 12);
        ctx.fillStyle = theme.fg;
        ctx.fillText(it.name, x0 + it.x + 16, legendY + ri * 18 + 10);
      }
    });
    ctx.globalAlpha = 1;
  }
  hitTest(x, y) {
    let best = null;
    for (const g of this.geometry) {
      const d = g.contains(x, y);
      if (d !== false && (best === null || d < best.d)) best = { ...g.info, d };
    }
    return best;
  }
  describe() { return describe`${this.title}: ${this.visibleSeries.length} series (${this.visibleSeries.map((s) => s.name)})`; }
}

class CartesianChart extends Chart {
  axisMargins() {
    this.ctx.font = this.options.font;
    const probe = this.makeY([0, this.maxValue()]);
    let widest = 0;
    for (const t of probe.ticks()) widest = Math.max(widest, this.ctx.measureText(t.label).width);
    return { left: Math.ceil(widest) + 8, right: 6, bottom: 20 };
  }
  maxValue() { return Math.max(1, ...this.visibleSeries.flatMap((s) => s.values)); }
  makeY(domain, range = [1, 0]) { return (this.options.logY ? new LogScale([Math.max(1, domain[0] || 1), domain[1]], range) : new LinearScale(domain, range)).nice(5); }
  prepare(plot) {
    this.x = new BandScale(this.labels, [plot.x, plot.x + plot.w], this.options.bandPadding ?? 0.2);
    this.y = this.makeY([0, this.maxValue()], [plot.y + plot.h, plot.y]);
  }
  drawAxes(plot) {
    const { ctx } = this;
    ctx.strokeStyle = theme.grid;
    ctx.fillStyle = theme.fg;
    ctx.font = this.options.font;
    ctx.textAlign = 'right';
    const yTicks = [...this.y.ticks()];
    for (const t of yTicks) {
      const py = r2(this.y.map(t.value));
      ctx.beginPath();
      ctx.moveTo(plot.x, py);
      ctx.lineTo(plot.x + plot.w, py);
      ctx.stroke();
      ctx.fillText(t.label, plot.x - 6, py + 4);
    }
    ctx.textAlign = 'center';
    for (const t of this.x.ticks()) ctx.fillText(t.label, t.center, plot.y + plot.h + 14);
    this.tickSummary = yTicks.map((t) => t.label).join(',');
  }
}

function* catmullRom(points, tension = 0.5) {
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] ?? p2;
    yield {
      c1: [p1[0] + ((p2[0] - p0[0]) * tension) / 3, p1[1] + ((p2[1] - p0[1]) * tension) / 3],
      c2: [p2[0] - ((p3[0] - p1[0]) * tension) / 3, p2[1] - ((p3[1] - p1[1]) * tension) / 3],
      to: p2,
    };
  }
}

class LineChart extends CartesianChart {
  drawSeries(plot, progress) {
    const { ctx } = this;
    for (const [si, s] of this.series.entries()) {
      if (this.hidden.has(s.name)) continue;
      const color = theme.palette[si % theme.palette.length];
      const pts = s.values.map((v, i) => [r2(this.x.map(this.labels[i]) + this.x.bandwidth / 2), r2(this.y.map(Math.max(v, this.options.logY ? 1 : 0)) * progress + (plot.y + plot.h) * (1 - progress))]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      for (const seg of this.options.smooth ? catmullRom(pts) : pts.slice(1).map((p) => ({ to: p }))) {
        if (seg.c1) ctx.bezierCurveTo(...seg.c1, ...seg.c2, ...seg.to); else ctx.lineTo(...seg.to);
      }
      ctx.stroke();
      pts.forEach(([px, py], i) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        this.geometry.push({ info: { series: s.name, index: i, value: s.values[i] }, contains: (x, y) => { const d = Math.hypot(x - px, y - py); return d <= 8 ? d : false; } });
      });
    }
  }
}

class BarChart extends CartesianChart {
  maxValue() {
    if (!this.options.stacked) return super.maxValue();
    return Math.max(1, ...this.labels.map((_, i) => this.visibleSeries.reduce((a, s) => a + s.values[i], 0)));
  }
  drawSeries(plot, progress) {
    const { ctx } = this;
    const vis = this.visibleSeries;
    const bw = this.x.bandwidth;
    this.labels.forEach((label, i) => {
      let stackBase = 0;
      vis.forEach((s, k) => {
        const color = theme.palette[this.series.indexOf(s) % theme.palette.length];
        const v = s.values[i] * progress;
        let x, w, y0, y1;
        if (this.options.stacked) { x = this.x.map(label); w = bw; y0 = this.y.map(stackBase); y1 = this.y.map(stackBase + v); stackBase += v; }
        else { w = bw / vis.length; x = this.x.map(label) + k * w; y0 = this.y.map(0); y1 = this.y.map(v); }
        const rect = [r2(x), r2(y1), r2(w - 1), r2(y0 - y1)];
        ctx.fillStyle = color;
        ctx.fillRect(...rect);
        this.geometry.push({ info: { series: s.name, index: i, value: s.values[i] }, contains: (px, py) => (px >= rect[0] && px <= rect[0] + rect[2] && py >= rect[1] && py <= rect[1] + rect[3] ? 0 : false) });
      });
    });
  }
}

class PieChart extends Chart {
  legendNames() { return this.labels.slice(); }
  describe() { return super.describe() + describe` covering ${this.series[0].values.reduce((a, b) => a + b, 0)} units`; }
  drawSeries(plot, progress) {
    const { ctx } = this;
    const s = this.series[0];
    const items = s.values.map((v, i) => ({ v, label: this.labels[i], i })).filter((it) => !this.hidden.has(it.label));
    const total = items.reduce((a, it) => a + it.v, 0);
    const cx = r2(plot.x + plot.w / 2), cy = r2(plot.y + plot.h / 2), radius = r2(Math.min(plot.w, plot.h) / 2 - 20);
    let angle = -Math.PI / 2;
    const labelBoxes = [];
    for (const it of items) {
      const sweep = (it.v / total) * Math.PI * 2 * progress;
      const a0 = angle, a1 = angle + sweep;
      ctx.fillStyle = theme.palette[it.i % theme.palette.length];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, r2(a0), r2(a1));
      ctx.closePath();
      ctx.fill();
      this.geometry.push({ info: { series: it.label, index: it.i, value: it.v }, contains: (x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        let a = Math.atan2(y - cy, x - cx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        return d <= radius && a >= a0 && a < a1 ? 0 : false;
      } });
      labelBoxes.push(this.placeLabel(labelBoxes, cx, cy, radius, (a0 + a1) / 2, it.label + ' ' + Math.round((it.v / total) * 100) + '%'));
      angle = a1;
    }
    ctx.fillStyle = theme.fg;
    ctx.textAlign = 'center';
    for (const b of labelBoxes) ctx.fillText(b.text, b.x + b.w / 2, b.y + 10);
    this.labelPlacement = labelBoxes.map((b) => b.text + '@' + b.x + ',' + b.y + (b.nudged ? '*' : ''));
  }
  placeLabel(placed, cx, cy, radius, mid, text) {
    this.ctx.font = this.options.font;
    const w = r2(this.ctx.measureText(text).width), h = 12;
    const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    let candidate = null;
    place: for (let ring = 0; ring < 6; ring++) {
      candidates: for (const shift of [0, -1, 1]) {
        const rr = radius + 12 + ring * 10;
        const box = { text, w, h, x: r2(cx + Math.cos(mid) * rr - w / 2 + shift * 8), y: r2(cy + Math.sin(mid) * rr - h / 2 + shift * 6), nudged: ring > 0 || shift !== 0 };
        for (const other of placed) if (overlaps(box, other)) continue candidates;
        candidate = box;
        break place;
      }
    }
    return candidate ?? { text, w, h, x: cx, y: cy, nudged: true };
  }
}

class ScatterChart extends CartesianChart {
  prepare(plot) {
    const xs = this.series.flatMap((s) => s.points.map((p) => p[0]));
    this.xLin = new LinearScale([Math.min(...xs), Math.max(...xs)], [plot.x, plot.x + plot.w]).nice(6);
    this.y = this.makeY([1, Math.max(...this.series.flatMap((s) => s.points.map((p) => p[1])))], [plot.y + plot.h, plot.y]);
    this.x = { ticks: function* ticks(xl) { for (const t of xl.ticks()) yield { ...t, center: xl.map(t.value) }; }.bind(null, this.xLin) };
  }
  maxValue() { return Math.max(...this.series.flatMap((s) => s.points.map((p) => p[1]))); }
  drawSeries(plot, progress) {
    const { ctx } = this;
    for (const [si, s] of this.series.entries()) {
      ctx.fillStyle = theme.palette[si];
      for (const [px, py] of s.points) {
        ctx.beginPath();
        ctx.arc(r2(this.xLin.map(px)), r2(this.y.map(py)), 2 + 2 * progress, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// ---------------------------------------------------------------- animation
const easings = { linear: (t) => t, easeOutCubic: (t) => 1 - (1 - t) ** 3, easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) };
async function* tween(frameCount, easing) {
  let start = null;
  for (let i = 0; i <= frameCount; i++) {
    const ts = await frame();
    start ??= ts;
    yield { i, p: r2(easings[easing](i / frameCount)), elapsed: r2(ts - start) };
  }
}
async function animate(chart, frameCount, easing) {
  const trail = [];
  let last;
  try {
    for await (const { i, p, elapsed } of tween(frameCount, easing)) {
      chart.draw(p);
      trail.push(p);
      last = elapsed;
      if (chart.cancelAnimation) { trail.push('cancel'); break; }
    }
  } finally {
    chart.cancelAnimation = false;
  }
  return { trail, last };
}

// ---------------------------------------------------------------- page
const container = document.createElement('section');
container.className = 'dashboard';
document.getElementById('app').appendChild(container);
function makeCanvas(id, w, h, left, top) {
  const c = document.createElement('canvas');
  c.id = id;
  c.width = w * devicePixelRatio;
  c.height = h * devicePixelRatio;
  Object.assign(c.style, { position: 'absolute', left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
  const wrap = document.createElement('figure');
  wrap.className = 'chart';
  wrap.appendChild(c);
  const legend = document.createElement('div');
  legend.className = 'legend';
  wrap.appendChild(legend);
  container.appendChild(wrap);
  return c;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const sales = [
  { name: 'Bread', values: [120, 132, 101, 134, 90, 230] },
  { name: 'Pastries', values: [220, 182, 191, 234, 290, 330] },
  { name: 'Coffee', values: [150, 232, 201, 154, 190, 330] },
  { name: 'Seasonal specials', values: [20, 32, 51, 94, 60, 12] },
];
const charts = {
  line: new LineChart(makeCanvas('c-line', 480, 300, 0, 0), { title: 'Monthly sales', series: sales, labels: months, smooth: true }),
  bar: new BarChart(makeCanvas('c-bar', 420, 280, 0, 320), { title: 'Sales by product', series: sales.slice(0, 3), labels: months, legend: 'top' }),
  pie: new PieChart(makeCanvas('c-pie', 320, 320, 500, 0), { title: 'Share (Jun)', series: [{ name: 'Jun', values: sales.map((s) => s.values[5]) }], labels: sales.map((s) => s.name) }),
  scatter: new ScatterChart(makeCanvas('c-scatter', 360, 240, 500, 340), { title: 'Order size vs count', logY: true, legend: 'none',
    series: [{ name: 'orders', points: Array.from({ length: 24 }, (_, i) => [i * 2.5 + 1, Math.round(3 * 1.45 ** i)]) }] }),
};

// DOM legends (delegated clicks) built per chart; closures capture each chart
for (const [key, chart] of Object.entries(charts)) {
  const legend = chart.canvas.parentElement.querySelector('.legend');
  for (const name of chart.legendNames()) {
    const b = document.createElement('button');
    b.setAttribute('data-series', name);
    b.textContent = name;
    legend.appendChild(b);
  }
  legend.addEventListener('click', (ev) => {
    const name = ev.target.closest('[data-series]')?.getAttribute('data-series');
    if (!name) return;
    ev.stopPropagation();
    chart.hidden.has(name) ? chart.hidden.delete(name) : chart.hidden.add(name);
    ev.target.setAttribute('aria-pressed', String(!chart.hidden.has(name)));
    chart.invalidate('legend:' + name);
    out('  legend toggle', key, name, '-> hidden', [...chart.hidden].join('|') || '-');
  });
  chart.canvas.addEventListener('pointermove', (ev) => {
    const rect = chart.canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) * chart.width) / rect.width, y = ((ev.clientY - rect.top) * chart.height) / rect.height;
    const hit = chart.hitTest(x, y);
    chart.canvas.dispatchEvent(new CustomEvent('chart:hover', { bubbles: true, detail: { chart: key, x: r2(x), y: r2(y), hit } }));
  });
}
container.addEventListener('click', () => out('  container click (should not appear for legend)'));
container.addEventListener('chart:hover', ({ detail: { chart, x, y, hit } }) => {
  out('  hover', chart, '(' + x + ',' + y + ')', hit ? `${hit.series}[${hit.index}] = ${nf.format(hit.value)}` : 'nothing');
});
const redrawLog = [];
container.addEventListener('chart:redraw', ({ detail }) => redrawLog.push(detail.chart + ':' + detail.keys));

function report(key) {
  const c = charts[key];
  const { plot, legendRows } = c.layoutInfo;
  out(`[${key}] plot x=${r2(plot.x)} y=${r2(plot.y)} w=${r2(plot.w)} h=${r2(plot.h)} legend=${legendRows.map((r) => r.length).join('+') || 0}`);
  if (c.tickSummary) out(`[${key}] y ticks ${c.tickSummary}`);
  out(`[${key}] ops=${c.opCount()} top: ${c.topOps()}`);
  out(`[${key}] hash ${c.hash()}`);
}
function hover(key, px, py) {
  const c = charts[key];
  const rect = c.canvas.getBoundingClientRect();
  c.canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + px, clientY: rect.top + py, pointerType: 'mouse', isPrimary: true }));
}

async function main() {
  out('theme:', theme === THEMES.dark ? 'dark' : 'light', '| dpr', devicePixelRatio, '| font check', document.fonts.check('12px Arial'));
  for (const key of Object.keys(charts)) { charts[key].draw(); report(key); }
  out('pie labels:', charts.pie.labelPlacement.join(' '));
  out('scatter x ticks:', [...charts.scatter.xLin.ticks()].map((t) => t.label).join(','));
  for (const k of Object.keys(charts)) out('a11y:', charts[k].describe());

  const lineGeo = charts.line.geometry;
  const target = lineGeo.find((g) => g.info.series === 'Coffee' && g.info.index === 1);
  out('coffee[1] geometry probe:', target.contains(0, 0) === false ? 'far' : 'near');
  const plot = charts.line.layoutInfo.plot;
  const px = charts.line.x.map('Feb') + charts.line.x.bandwidth / 2, py = charts.line.y.map(232);
  hover('line', r2(px), r2(py));
  hover('line', r2(px + 3), r2(py - 2));
  hover('line', plot.x + 1, plot.y + 1);
  const barPlot = charts.bar.layoutInfo.plot;
  hover('bar', r2(charts.bar.x.map('Jun') + 2), r2(barPlot.y + barPlot.h - 5));
  hover('pie', 160, 120);
  hover('pie', 200, 220);
  hover('pie', 5, 5);

  const res = await animate(charts.bar, 8, 'easeOutCubic');
  out('bar entrance:', res.trail.join(' '), '| elapsed', res.last, 'ms');
  report('bar');
  const cancelled = animate(charts.line, 10, 'easeInOutQuad');
  await frame(); await frame(); await frame();
  charts.line.cancelAnimation = true;
  const r = await cancelled;
  out('line animation cancelled after', r.trail.length, 'entries:', r.trail.join(' '));

  charts.bar.options.stacked = true;
  charts.bar.options.bandPadding = 0.1;
  charts.bar.options.stacked = true;
  await frame();
  out('stacked bar redraws:', charts.bar.redraws, '| y ticks', charts.bar.tickSummary);
  report('bar');

  for (const name of ['Pastries', 'Coffee']) document.getElementById('c-line').parentElement.querySelector(`.legend [data-series="${name}"]`)?.click();
  container.querySelectorAll('.legend')[0].querySelector('[data-series=Coffee]').click();
  await frame();
  out('line after toggles: y ticks', charts.line.tickSummary, '| legend pressed', [...container.querySelectorAll('[aria-pressed=false]')].map((b) => b.getAttribute('data-series')).join(','));
  report('line');
  container.querySelectorAll('.legend')[2].querySelector('[data-series=Coffee]').click();
  await frame();
  out('pie labels:', charts.pie.labelPlacement.join(' '));
  report('pie');

  charts.line.options.legend = 'top';
  charts.line.options.font = '14px Arial';
  charts.line.options.smooth = false;
  charts.scatter.options.logY = false;
  await frame();
  report('line');
  report('scatter');
  out('redraw events:', redrawLog.join(' '));
  const img = charts.pie.ctx.getImageData(0, 0, 4, 1);
  out('pie pixel sample:', Array.from(img.data.slice(0, 8)).join(','));
  out('total ops:', Object.values(charts).reduce((a, c) => a + c.opCount(), 0), '| total redraws:', Object.values(charts).reduce((a, c) => a + c.redraws, 0));
}

main().then(() => out('done'));
