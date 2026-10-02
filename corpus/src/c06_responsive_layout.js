// Responsive layout calculator: reads innerWidth/innerHeight/devicePixelRatio/screen, maps the
// viewport to named breakpoints, computes grid column widths with gutters, masonry placement of
// cards, image srcset selection per DPR, and re-lays out on simulated resize events (with a
// requestAnimationFrame-based throttle).
'use strict';

const BREAKPOINTS = [
  { label: 'xs', min: 0, cols: 4, gutter: 12, margin: 16 },
  { label: 'sm', min: 576, cols: 6, gutter: 16, margin: 24 },
  { label: 'md', min: 768, cols: 8, gutter: 20, margin: 32 },
  { label: 'lg', min: 1024, cols: 12, gutter: 24, margin: 48 },
  { label: 'xl', min: 1440, cols: 12, gutter: 32, margin: 'auto', maxWidth: 1320 },
];

const IMAGE_WIDTHS = [320, 480, 640, 960, 1280, 1920, 2560];

function round2(x) {
  return Math.round(x * 100) / 100;
}

function viewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    screenW: screen.width,
    screenH: screen.height,
    availH: screen.availHeight,
  };
}

function pickBreakpoint(width) {
  let bp = BREAKPOINTS[0];
  for (const b of BREAKPOINTS) if (width >= b.min) bp = b;
  return bp;
}

function containerWidth(bp, vw) {
  if (bp.margin === 'auto') return Math.min(bp.maxWidth, vw - 2 * 48);
  return vw - 2 * bp.margin;
}

function columnWidth(bp, container) {
  return (container - bp.gutter * (bp.cols - 1)) / bp.cols;
}

function spanWidth(bp, colW, span) {
  const s = Math.min(span, bp.cols);
  return colW * s + bp.gutter * (s - 1);
}

function orientationOf(vp) {
  const ratio = vp.width / vp.height;
  return { name: ratio >= 1 ? 'landscape' : 'portrait', ratio: round2(ratio) };
}

class GridLayout {
  constructor(spec) {
    this.spec = spec;
    this.history = [];
  }

  compute(vp) {
    const bp = pickBreakpoint(vp.width);
    const container = containerWidth(bp, vp.width);
    const colW = columnWidth(bp, container);
    const offset = (vp.width - container) / 2;
    const placed = [];
    let x = 0, row = 0;
    for (const item of this.spec) {
      const span = Math.min(typeof item.span === 'object' ? item.span[bp.label] || item.span.default : item.span, bp.cols);
      if (x + span > bp.cols) { x = 0; row++; }
      placed.push({ id: item.id, row, col: x, span, left: round2(offset + x * (colW + bp.gutter)), width: round2(spanWidth(bp, colW, span)) });
      x += span;
    }
    const result = { bp: bp.label, container: round2(container), colW: round2(colW), rows: row + 1, placed };
    this.history.push(bp.label);
    return result;
  }
}

function masonry(cards, columns, colW, gap) {
  const heights = new Array(columns).fill(0);
  const out = [];
  for (const c of cards) {
    let best = 0;
    for (let i = 1; i < columns; i++) if (heights[i] < heights[best]) best = i;
    const h = Math.round(colW * c.aspect);
    out.push({ id: c.id, col: best, top: heights[best], h });
    heights[best] += h + gap;
  }
  return { out, height: Math.max(...heights) - gap };
}

function chooseImage(cssWidth, dpr) {
  const needed = Math.ceil(cssWidth * dpr);
  const pick = IMAGE_WIDTHS.find((w) => w >= needed) || IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
  return { needed, pick, srcset: IMAGE_WIDTHS.map((w) => 'img-' + w + '.jpg ' + w + 'w').join(', '), sizes: '(min-width: 1024px) 33vw, 100vw' };
}

function fluidType(minPx, maxPx, minVw, maxVw, vw) {
  const slope = (maxPx - minPx) / (maxVw - minVw);
  const size = Math.max(minPx, Math.min(maxPx, minPx + slope * (vw - minVw)));
  return { size: round2(size), clamp: 'clamp(' + minPx + 'px, ' + round2(minPx - slope * minVw) + 'px + ' + round2(slope * 100) + 'vw, ' + maxPx + 'px)' };
}

function applyToDom(root, layout) {
  root.textContent = '';
  root.setAttribute('data-bp', layout.bp);
  for (const p of layout.placed) {
    const cell = document.createElement('div');
    cell.className = 'cell span-' + p.span;
    cell.style.left = p.left + 'px';
    cell.style.width = p.width + 'px';
    cell.style.top = p.row * 100 + 'px';
    cell.style.height = '90px';
    cell.dataset.id = p.id;
    root.appendChild(cell);
  }
}

class ResizeObserverLite {
  constructor(onLayout) {
    this.onLayout = onLayout;
    this.pending = false;
    this.events = 0;
    this.frames = 0;
    this.handler = () => this.schedule();
    window.addEventListener('resize', this.handler);
  }

  schedule() {
    this.events++;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame((ts) => {
      this.pending = false;
      this.frames++;
      this.onLayout(viewport(), ts);
    });
  }

  disconnect() {
    window.removeEventListener('resize', this.handler);
  }
}

function simulateResize(w, h) {
  window.innerWidth = w;
  window.innerHeight = h;
  window.dispatchEvent(new Event('resize'));
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function describe(layout) {
  const rows = [];
  for (let r = 0; r < layout.rows; r++) {
    rows.push(layout.placed.filter((p) => p.row === r).map((p) => p.id + '(' + p.span + ')@' + p.left).join(' '));
  }
  return rows;
}

async function main() {
  const vp = viewport();
  console.log('viewport:', JSON.stringify(vp));
  console.log('orientation:', JSON.stringify(orientationOf(vp)), 'chrome height:', vp.availH - vp.height);
  console.log('screen share: ' + round2((vp.width * vp.height * 100) / (vp.screenW * vp.screenH)) + '%');

  const spec = [
    { id: 'hero', span: 12 },
    { id: 'nav', span: { xs: 4, md: 2, lg: 3, default: 3 } },
    { id: 'main', span: { xs: 4, md: 6, lg: 6, default: 6 } },
    { id: 'aside', span: { xs: 4, sm: 6, md: 8, lg: 3, default: 3 } },
    { id: 'foot', span: 12 },
  ];
  const grid = new GridLayout(spec);
  const root = document.getElementById('app');

  for (const w of [360, 600, 800, 1100, 1920, 2560]) {
    const layout = grid.compute({ width: w, height: 800 });
    console.log('w=' + w + ' bp=' + layout.bp + ' container=' + layout.container + ' colW=' + layout.colW + ' rows=' + layout.rows);
    for (const line of describe(layout)) console.log('    ' + line);
  }

  const current = grid.compute(vp);
  applyToDom(root, current);
  const cells = root.querySelectorAll('.cell');
  console.log('dom cells:', cells.length, 'bp attr:', root.getAttribute('data-bp'));
  for (const c of cells) {
    const r = c.getBoundingClientRect();
    console.log('  ' + c.dataset.id.padEnd(5) + ' x=' + r.left + ' y=' + r.top + ' w=' + r.width + ' right=' + round2(r.right) + ' offsetW=' + c.offsetWidth);
  }
  console.log('computed display:', getComputedStyle(cells[0]).display, 'width:', getComputedStyle(cells[0]).width);

  console.log('-- images');
  for (const dpr of [1, 1.5, 2, 3]) {
    const img = chooseImage(current.placed[2].width, dpr);
    console.log('  dpr ' + dpr + ': need ' + img.needed + 'px -> ' + img.pick + 'w');
  }
  console.log('  srcset:', chooseImage(300, vp.dpr).srcset);

  console.log('-- fluid type');
  for (const w of [320, 768, 1200, 1920]) {
    const t = fluidType(16, 24, 320, 1280, w);
    console.log('  vw=' + w + ' size=' + t.size + 'px');
  }
  console.log('  css:', fluidType(16, 24, 320, 1280, 0).clamp);

  console.log('-- masonry');
  const cards = [1.2, 0.6, 0.9, 1.5, 0.75, 1.0, 0.5, 1.33, 0.8].map((aspect, i) => ({ id: 'c' + i, aspect }));
  for (const cols of [2, 3, 4]) {
    const colW = columnWidth(pickBreakpoint(1100), 1004) * (12 / cols);
    const m = masonry(cards, cols, round2(colW), 16);
    console.log('  cols=' + cols + ' height=' + m.height + ' ' + m.out.map((o) => o.id + ':' + o.col + '/' + o.top).join(' '));
  }

  console.log('-- resize simulation');
  const observer = new ResizeObserverLite((v, ts) => {
    const l = grid.compute(v);
    applyToDom(root, l);
    console.log('  layout @' + ts + 'ms ' + v.width + 'x' + v.height + ' -> ' + l.bp + ' (' + orientationOf(v).name + ') cells=' + root.children.length);
  });
  simulateResize(1280, 720);
  simulateResize(1000, 720);
  simulateResize(700, 900);
  await frame();
  simulateResize(420, 860);
  await frame();
  simulateResize(1600, 900);
  simulateResize(1600, 900);
  await frame();
  observer.disconnect();
  simulateResize(300, 500);
  await frame();
  console.log('resize events:', observer.events, 'layout frames:', observer.frames);
  console.log('bp history:', grid.history.join(' '));
  console.log('matchMedia min-width 1024:', window.matchMedia('(min-width: 1024px)').matches, 'orientation landscape:', window.matchMedia('(orientation: landscape)').matches);
  console.log('perf now:', performance.now());
}

main();
