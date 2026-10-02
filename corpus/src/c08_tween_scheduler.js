// Animation/tween scheduler: a single requestAnimationFrame loop drives many tweens, each with an
// easing function, delay, repeat/yoyo and a completion promise. Timelines chain tweens with
// async/await; element styles are written each frame and sampled for the log. Timing comes from
// the rAF timestamp (deterministic in the shim) and performance.now() for bookkeeping.
'use strict';

const Easing = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1;
    return n1 * t * t + 0.984375;
  },
  steps: (n) => (t) => Math.min(1, Math.floor(t * n) / (n - 1 || 1)),
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function fmt(x) {
  return (Math.round(x * 1000) / 1000).toString();
}

function parseColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixColor(a, b, t) {
  const ca = parseColor(a), cb = parseColor(b);
  return '#' + ca.map((v, i) => Math.round(lerp(v, cb[i], t)).toString(16).padStart(2, '0')).join('');
}

let tweenSeq = 0;

class Tween {
  constructor(target, prop, from, to, opts) {
    this.id = ++tweenSeq;
    this.target = target;
    this.prop = prop;
    this.from = from;
    this.to = to;
    this.duration = opts.duration;
    this.delay = opts.delay || 0;
    this.ease = opts.ease || Easing.linear;
    this.repeat = opts.repeat || 0;
    this.yoyo = !!opts.yoyo;
    this.unit = opts.unit === undefined ? 'px' : opts.unit;
    this.label = opts.label || prop;
    this.onDone = opts.onDone || null;
    this.start = null;
    this.cycle = 0;
    this.frames = 0;
    this.state = 'idle';
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }

  value(p) {
    const e = this.ease(p);
    if (typeof this.from === 'string') return mixColor(this.from, this.to, e);
    return lerp(this.from, this.to, e);
  }

  write(v) {
    this.target.style[this.prop] = typeof v === 'number' ? fmt(v) + this.unit : v;
  }

  step(now) {
    if (this.start === null) this.start = now + this.delay;
    if (now < this.start) { this.state = 'delayed'; return false; }
    this.state = 'running';
    this.frames++;
    let p = Math.min(1, (now - this.start) / this.duration);
    const reverse = this.yoyo && this.cycle % 2 === 1;
    this.write(this.value(reverse ? 1 - p : p));
    if (p < 1) return false;
    if (this.cycle < this.repeat) {
      this.cycle++;
      this.start = now;
      return false;
    }
    this.state = 'done';
    return true;
  }
}

class Scheduler {
  constructor() {
    this.tweens = [];
    this.frameId = 0;
    this.frameCount = 0;
    this.lastTs = 0;
    this.deltas = [];
    this.samplers = [];
  }

  add(tween) {
    this.tweens.push(tween);
    this.ensureLoop();
    return tween;
  }

  ensureLoop() {
    if (!this.frameId) this.frameId = requestAnimationFrame((ts) => this.tick(ts));
  }

  cancel(tween, reason) {
    const i = this.tweens.indexOf(tween);
    if (i < 0) return false;
    this.tweens.splice(i, 1);
    tween.state = 'cancelled';
    tween.reject(new Error('cancelled: ' + reason));
    console.log('  [frame ' + this.frameCount + '] cancelled tween #' + tween.id + ' ' + tween.label);
    return true;
  }

  tick(ts) {
    this.frameId = 0;
    this.frameCount++;
    if (this.lastTs) this.deltas.push(fmt(ts - this.lastTs));
    this.lastTs = ts;
    const finished = [];
    for (const tw of this.tweens.slice()) {
      if (tw.step(ts)) finished.push(tw);
    }
    for (const s of this.samplers) s(this.frameCount, ts);
    for (const tw of finished) {
      this.tweens.splice(this.tweens.indexOf(tw), 1);
      console.log('  [frame ' + this.frameCount + ' @' + fmt(ts) + '] done #' + tw.id + ' ' + tw.label + ' frames=' + tw.frames + ' final=' + tw.target.style[tw.prop]);
      tw.resolve({ id: tw.id, frames: tw.frames, at: ts });
      if (tw.onDone) tw.onDone(tw);
    }
    if (this.tweens.length) this.ensureLoop();
  }
}

const scheduler = new Scheduler();

function animate(el, prop, from, to, opts) {
  return scheduler.add(new Tween(el, prop, from, to, opts));
}

function makeBox(id) {
  const box = document.createElement('div');
  box.id = id;
  box.className = 'box';
  box.style.left = '0px';
  document.getElementById('app').appendChild(box);
  return box;
}

function sampleCurve(name, fn, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(fmt(fn(i / n)));
  return name.padEnd(10) + pts.join(' ');
}

async function slideIn(box) {
  const t0 = performance.now();
  await animate(box, 'left', -100, 0, { duration: 100, ease: Easing.outQuad, label: 'slide-x' }).promise;
  await animate(box, 'opacity', 0, 1, { duration: 50, unit: '', label: 'fade' }).promise;
  const t1 = performance.now();
  return fmt(t1 - t0);
}

async function main() {
  console.log('-- easing curves');
  for (const name of ['linear', 'inQuad', 'outQuad', 'inOutCubic', 'outBack', 'outBounce']) console.log('  ' + sampleCurve(name, Easing[name], 8));
  console.log('  ' + sampleCurve('steps(4)', Easing.steps(4), 8));
  console.log('  mixColor:', mixColor('#ff0000', '#0000ff', 0.25), mixColor('#123456', '#fedcba', 0.5));

  const a = makeBox('a');
  const b = makeBox('b');
  const c = makeBox('c');
  let sampled = 0;
  scheduler.samplers.push((frame, ts) => {
    if (frame % 3 !== 0) return;
    sampled++;
    console.log('  sample f' + frame + ' @' + fmt(ts) + ' a.left=' + a.style.left + ' b.bg=' + (b.style.backgroundColor || '-') + ' c.w=' + (c.style.width || '-'));
  });

  console.log('-- sequence');
  const took = await slideIn(a);
  console.log('slideIn finished, perf delta=' + took + ' a=' + a.style.cssText);

  console.log('-- parallel');
  const group = [
    animate(a, 'left', 0, 300, { duration: 200, ease: Easing.inOutCubic, label: 'a-move' }),
    animate(b, 'backgroundColor', '#ffffff', '#3366cc', { duration: 120, delay: 40, label: 'b-color' }),
    animate(c, 'width', 10, 60, { duration: 60, repeat: 2, yoyo: true, ease: Easing.outBounce, label: 'c-pulse' }),
  ];
  const results = await Promise.all(group.map((t) => t.promise));
  console.log('parallel results:', results.map((r) => '#' + r.id + ':' + r.frames + 'f@' + fmt(r.at)).join(' '));
  console.log('styles:', a.style.cssText, '|', b.style.cssText, '|', c.style.cssText);

  console.log('-- cancellation');
  const long = animate(c, 'height', 0, 500, { duration: 1000, label: 'c-grow' });
  // cancel synchronously from the completion callback so no further frame can run in between
  const short = animate(b, 'left', 0, 50, { duration: 80, ease: Easing.outBack, label: 'b-nudge', onDone: () => scheduler.cancel(long, 'user navigated') });
  await short.promise;
  try {
    await long.promise;
  } catch (e) {
    console.log('caught:', e.message, 'state=' + long.state, 'c.height=' + c.style.height);
  }
  console.log('b overshoot final:', b.style.left);

  console.log('-- stagger');
  const boxes = [a, b, c];
  const staggered = boxes.map((el, i) => animate(el, 'top', 0, 40 + i * 10, { duration: 60, delay: i * 25, ease: Easing.outQuad, label: 'stagger-' + el.id }));
  await Promise.all(staggered.map((t) => t.promise));
  console.log('tops:', boxes.map((el) => el.id + '=' + el.style.top).join(' '));

  console.log('frames total:', scheduler.frameCount, 'samples:', sampled, 'active:', scheduler.tweens.length);
  const uniq = Array.from(new Set(scheduler.deltas));
  console.log('distinct frame deltas:', uniq.join(','), 'count:', scheduler.deltas.length);
  console.log('perf.now at end:', performance.now(), 'tweens created:', tweenSeq);
}

main().then(() => console.log('all animations settled'));
