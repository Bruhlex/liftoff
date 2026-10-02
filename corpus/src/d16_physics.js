// d16: 2D physics: fixed-step accumulator loop, integrator strategies,
// spatial-hash broadphase, circle/box narrowphase, impulse resolution,
// springs, charges, breakable crates, sleeping, checksums and async worlds.

const r3 = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};
const MASK64 = (1n << 64n) - 1n;

function makeRng(seed) {
  let s = seed >>> 0;
  return {
    next() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; },
    unit() { return this.next() / 4294967296; },
    range(a, b) { return a + (b - a) * this.unit(); },
    int(n) { return this.next() % n; },
  };
}

class Vec2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  static of(...a) { return new Vec2(...a); }
  add(v) { return new Vec2(this.x + v.x, this.y + v.y); }
  sub(v) { return new Vec2(this.x - v.x, this.y - v.y); }
  scale(k) { return new Vec2(this.x * k, this.y * k); }
  dot(v) { return this.x * v.x + this.y * v.y; }
  cross(v) { return this.x * v.y - this.y * v.x; }
  perp() { return new Vec2(-this.y, this.x); }
  get len() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  norm() { const l = this.len; return l > 1e-12 ? this.scale(1 / l) : new Vec2(0, 0); }
  clampLen(max) { const l = this.len; return l > max ? this.scale(max / l) : this; }
  *[Symbol.iterator]() { yield this.x; yield this.y; }
  [Symbol.toPrimitive](hint) { return hint === 'number' ? this.len : `(${r3(this.x)},${r3(this.y)})`; }
  toJSON() { return [r3(this.x), r3(this.y)]; }
  get [Symbol.toStringTag]() { return 'Vec2'; }
}

class TunnelError extends Error {
  constructor(body, speed) { super(`body ${body.id} too fast: ${r3(speed)}`); this.body = body; }
}
class BreakSignal extends Error {
  constructor(crate) { super('crate broke ' + crate.id); this.crate = crate; }
}

class Body {
  static #nextId = 1;
  static #registry = new Map();
  #id; #sleepTicks = 0;
  constructor({ pos, vel = new Vec2(), mass = 1, restitution = 0.5, friction = 0.1, fixed = false } = {}) {
    if (new.target === Body) throw new TypeError('abstract body');
    this.#id = Body.#nextId++;
    this.pos = pos;
    this.vel = vel;
    this.force = new Vec2();
    this.mass = fixed ? Infinity : mass;
    this.invMass = fixed ? 0 : 1 / mass;
    this.restitution = restitution;
    this.friction = friction;
    Body.#registry.set(this.#id, this);
  }
  get id() { return this.#id; }
  get sleeping() { return this.#sleepTicks > 30; }
  tickSleep(threshold) {
    if (this.invMass !== 0 && this.vel.len < threshold) this.#sleepTicks++;
    else this.#sleepTicks = 0;
    return this.sleeping;
  }
  wake() { this.#sleepTicks = 0; }
  get kinetic() { return this.invMass === 0 ? 0 : 0.5 * this.mass * this.vel.dot(this.vel); }
  get minExtent() { return 1; }
  aabb() { throw new Error('abstract aabb'); }
  static byId(id) { return Body.#registry.get(id); }
  static reset() { Body.#nextId = 1; Body.#registry.clear(); }
  static get count() { return Body.#registry.size; }
  describe() { return `#${this.#id} ${this.shape} p=${this.pos} v=${this.vel}`; }
}

class Circle extends Body {
  constructor(opts) { super(opts); this.r = opts.r ?? 0.5; }
  get shape() { return 'circle'; }
  get minExtent() { return this.r; }
  aabb() { return { minX: this.pos.x - this.r, minY: this.pos.y - this.r, maxX: this.pos.x + this.r, maxY: this.pos.y + this.r }; }
}

class Ball extends Circle {
  static #bounces = 0;
  static KIND;
  static { Ball.KIND = 'ball'; }
  #hits = 0;
  onHit() { this.#hits++; Ball.#bounces++; }
  get hits() { return this.#hits; }
  static get totalBounces() { return Ball.#bounces; }
  static isBall(o) { return #hits in o; }
  get shape() { return Ball.KIND; }
  describe() { return super.describe() + ` hits=${this.#hits}`; }
}

class ChargedBall extends Ball {
  constructor(opts) { super(opts); this.charge = opts.charge ?? 1; }
  get shape() { return 'charged'; }
  describe() { return `${super.describe()} q=${this.charge}`; }
}

class Box extends Body {
  constructor(opts) { super(opts); this.half = opts.half ?? new Vec2(0.5, 0.5); }
  get shape() { return 'box'; }
  get minExtent() { return Math.min(this.half.x, this.half.y); }
  aabb() { return { minX: this.pos.x - this.half.x, minY: this.pos.y - this.half.y, maxX: this.pos.x + this.half.x, maxY: this.pos.y + this.half.y }; }
}

class Crate extends Box {
  #durability;
  static #broken = [];
  constructor(opts) { super(opts); this.#durability = opts.durability ?? 10; }
  get shape() { return 'crate'; }
  get durability() { return r3(this.#durability); }
  impact(j) {
    if (j < 1) return;
    this.#durability -= j;
    if (this.#durability <= 0) { Crate.#broken.push(this.id); throw new BreakSignal(this); }
  }
  static get broken() { return [...Crate.#broken]; }
}

// ---------- integrators (object-literal super) ----------
const Euler = {
  label: 'euler',
  step(b, dt, g) {
    if (b.invMass === 0) return;
    const acc = b.force.scale(b.invMass).add(g);
    b.vel = b.vel.add(acc.scale(dt));
    b.pos = b.pos.add(b.vel.scale(dt));
  },
  describe() { return 'semi-implicit ' + this.label; },
};
const Damped = {
  label: 'damped',
  damping: 0.5,
  step(b, dt, g) {
    super.step(b, dt, g);
    b.vel = b.vel.scale(1 / (1 + this.damping * dt));
  },
  describe() { return super.describe() + ' with damping ' + this.damping; },
};
Object.setPrototypeOf(Damped, Euler);
const Verlet = {
  label: 'verlet',
  prev: new WeakMap(),
  step(b, dt, g) {
    if (b.invMass === 0) return;
    const acc = b.force.scale(b.invMass).add(g);
    const prev = this.prev.get(b) ?? b.pos.sub(b.vel.scale(dt));
    const next = b.pos.scale(2).sub(prev).add(acc.scale(dt * dt));
    this.prev.set(b, b.pos);
    b.vel = next.sub(b.pos).scale(1 / dt);
    b.pos = next;
  },
  describe() { return 'position ' + this.label; },
};

// ---------- broadphase ----------
class SpatialHash {
  #cell; #map = new Map(); #inserts = 0;
  constructor(cell) { this.#cell = cell; }
  #key(ix, iy) { return ix + ',' + iy; }
  clear() { this.#map.clear(); this.#inserts = 0; }
  insert(body) {
    const bb = body.aabb();
    const c = this.#cell;
    for (let ix = Math.floor(bb.minX / c); ix <= Math.floor(bb.maxX / c); ix++) {
      for (let iy = Math.floor(bb.minY / c); iy <= Math.floor(bb.maxY / c); iy++) {
        const k = this.#key(ix, iy);
        let bucket = this.#map.get(k);
        if (!bucket) this.#map.set(k, (bucket = []));
        bucket.push(body);
        this.#inserts++;
      }
    }
  }
  *pairs() {
    const seen = new Set();
    for (const bucket of this.#map.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          let a = bucket[i], b = bucket[j];
          if (a.id > b.id) [a, b] = [b, a];
          if (a.invMass === 0 && b.invMass === 0) continue;
          const key = a.id * 100000 + b.id;
          if (seen.has(key)) continue;
          seen.add(key);
          yield [a, b];
        }
      }
    }
  }
  get stats() {
    let max = 0;
    for (const b of this.#map.values()) max = Math.max(max, b.length);
    return { cells: this.#map.size, inserts: this.#inserts, maxBucket: max };
  }
}

// ---------- narrowphase ----------
const isRound = (b) => b instanceof Circle;
function collideCircles(a, b) {
  const d = b.pos.sub(a.pos);
  const dist = d.len;
  const pen = a.r + b.r - dist;
  if (pen <= 0) return null;
  return { a, b, normal: dist > 1e-9 ? d.scale(1 / dist) : new Vec2(1, 0), pen };
}
function collideCircleBox(c, box) {
  const lo = box.pos.sub(box.half), hi = box.pos.add(box.half);
  const cx = Math.min(Math.max(c.pos.x, lo.x), hi.x);
  const cy = Math.min(Math.max(c.pos.y, lo.y), hi.y);
  const closest = new Vec2(cx, cy);
  const d = closest.sub(c.pos);
  const dist = d.len;
  if (dist > 1e-9) {
    if (dist >= c.r) return null;
    return { a: c, b: box, normal: d.scale(1 / dist), pen: c.r - dist };
  }
  // center inside box: push out along minimal axis
  const dx = [c.pos.x - lo.x, hi.x - c.pos.x], dy = [c.pos.y - lo.y, hi.y - c.pos.y];
  const m = Math.min(...dx, ...dy);
  switch (m) {
    case dx[0]: return { a: c, b: box, normal: new Vec2(1, 0), pen: m + c.r };
    case dx[1]: return { a: c, b: box, normal: new Vec2(-1, 0), pen: m + c.r };
    case dy[0]: return { a: c, b: box, normal: new Vec2(0, 1), pen: m + c.r };
    default: return { a: c, b: box, normal: new Vec2(0, -1), pen: m + c.r };
  }
}
function collideBoxes(a, b) {
  const d = b.pos.sub(a.pos);
  const ox = a.half.x + b.half.x - Math.abs(d.x);
  if (ox <= 0) return null;
  const oy = a.half.y + b.half.y - Math.abs(d.y);
  if (oy <= 0) return null;
  return ox < oy
    ? { a, b, normal: new Vec2(Math.sign(d.x) || 1, 0), pen: ox }
    : { a, b, normal: new Vec2(0, Math.sign(d.y) || 1), pen: oy };
}
function collide(a, b) {
  const key = (isRound(a) ? 'c' : 'b') + (isRound(b) ? 'c' : 'b');
  switch (key) {
    case 'cc': return collideCircles(a, b);
    case 'cb': return collideCircleBox(a, b);
    case 'bc': {
      const m = collideCircleBox(b, a);
      return m && { a, b, normal: m.normal.scale(-1), pen: m.pen };
    }
    default: return collideBoxes(a, b);
  }
}

// ---------- world ----------
class World {
  #bodies = []; #springs = []; #time = 0; #steps = 0; #hash;
  static #worlds = 0;
  constructor({ gravity = new Vec2(0, -9.81), bounds = { w: 20, h: 20 }, integrator = Euler, cell = 2, iterations = 6, coulomb = 0 } = {}) {
    Object.assign(this, { gravity, bounds, integrator, iterations, coulomb });
    this.#hash = new SpatialHash(cell);
    this.contacts = new Map();
    this.tunnelFixes = 0;
    this.removed = [];
    this.pairChecks = 0;
    World.#worlds++;
  }
  static get created() { return World.#worlds; }
  get bodies() { return [...this.#bodies]; }
  get time() { return this.#time; }
  get steps() { return this.#steps; }
  add(...bodies) { this.#bodies.push(...bodies); return this; }
  remove(body) {
    const i = this.#bodies.indexOf(body);
    if (i >= 0) this.#bodies.splice(i, 1);
    this.#springs = this.#springs.filter((s) => s.a !== body && s.b !== body);
    this.removed.push(body.id);
  }
  spring(a, b, k, rest = a.pos.sub(b.pos).len, damping = 0.2) { this.#springs.push({ a, b, k, rest, damping }); return this; }
  #applyForces() {
    for (const b of this.#bodies) b.force = new Vec2();
    for (const { a, b, k, rest, damping } of this.#springs) {
      const d = b.pos.sub(a.pos);
      const len = d.len || 1e-9;
      const n = d.scale(1 / len);
      const relV = b.vel.sub(a.vel).dot(n);
      const f = n.scale(k * (len - rest) + damping * relV);
      a.force = a.force.add(f);
      b.force = b.force.sub(f);
    }
    if (this.coulomb) {
      const charged = this.#bodies.filter((b) => b instanceof ChargedBall);
      for (let i = 0; i < charged.length; i++) {
        for (let j = i + 1; j < charged.length; j++) {
          const a = charged[i], b = charged[j];
          const d = b.pos.sub(a.pos);
          const r2 = Math.max(d.dot(d), 0.25);
          const f = d.norm().scale((this.coulomb * a.charge * b.charge) / r2);
          a.force = a.force.sub(f);
          b.force = b.force.add(f);
        }
      }
    }
  }
  #resolve(m) {
    const { a, b, normal: n, pen } = m;
    const rv = b.vel.sub(a.vel);
    const van = rv.dot(n);
    const invSum = a.invMass + b.invMass;
    if (invSum === 0) return 0;
    const slop = 0.005, percent = 0.8;
    const corr = n.scale((Math.max(pen - slop, 0) / invSum) * percent);
    a.pos = a.pos.sub(corr.scale(a.invMass));
    b.pos = b.pos.add(corr.scale(b.invMass));
    if (van > 0) return 0;
    const e = Math.min(a.restitution, b.restitution);
    const j = (-(1 + e) * van) / invSum;
    a.vel = a.vel.sub(n.scale(j * a.invMass));
    b.vel = b.vel.add(n.scale(j * b.invMass));
    const t = rv.sub(n.scale(van)).norm();
    const jt = Math.max(-j * Math.sqrt(a.friction * b.friction), Math.min(j * Math.sqrt(a.friction * b.friction), -rv.dot(t) / invSum));
    a.vel = a.vel.sub(t.scale(jt * a.invMass));
    b.vel = b.vel.add(t.scale(jt * b.invMass));
    for (const body of [a, b]) {
      if (Ball.isBall(body)) body.onHit();
      body.wake?.();
      if (body instanceof Crate) body.impact(j);
    }
    return j;
  }
  #walls(b) {
    if (b.invMass === 0) return;
    const bb = b.aabb();
    const { w, h } = this.bounds;
    let hit = false;
    if (bb.minX < 0) { b.pos = b.pos.add(new Vec2(-bb.minX, 0)); b.vel = new Vec2(-b.vel.x * b.restitution, b.vel.y); hit = true; }
    else if (bb.maxX > w) { b.pos = b.pos.add(new Vec2(w - bb.maxX, 0)); b.vel = new Vec2(-b.vel.x * b.restitution, b.vel.y); hit = true; }
    if (bb.minY < 0) { b.pos = b.pos.add(new Vec2(0, -bb.minY)); b.vel = new Vec2(b.vel.x * (1 - b.friction), -b.vel.y * b.restitution); hit = true; }
    else if (bb.maxY > h) { b.pos = b.pos.add(new Vec2(0, h - bb.maxY)); b.vel = new Vec2(b.vel.x, -b.vel.y * b.restitution); hit = true; }
    if (hit && Ball.isBall(b)) b.onHit();
  }
  step(dt, forced = false) {
    for (const b of this.#bodies) {
      const travel = b.vel.len * dt;
      if (travel > b.minExtent * 1.5) {
        if (!forced) throw new TunnelError(b, b.vel.len);
        b.vel = b.vel.clampLen((b.minExtent * 1.5) / dt);
      }
    }
    this.#applyForces();
    for (const b of this.#bodies) if (!b.sleeping) this.integrator.step(b, dt, this.gravity);
    let broke = null;
    iterations: for (let it = 0; it < this.iterations; it++) {
      this.#hash.clear();
      for (const b of this.#bodies) this.#hash.insert(b);
      let maxPen = 0;
      for (const [a, b] of this.#hash.pairs()) {
        this.pairChecks++;
        const m = collide(a, b);
        if (!m) continue;
        maxPen = Math.max(maxPen, m.pen);
        const key = `${a.id}-${b.id}`;
        if (it === 0) this.contacts.set(key, (this.contacts.get(key) ?? 0) + 1);
        try {
          this.#resolve(m);
        } catch (sig) {
          if (!(sig instanceof BreakSignal)) throw sig;
          broke = sig.crate;
          break iterations;
        }
      }
      if (maxPen < 0.01) break iterations;
    }
    if (broke) this.remove(broke);
    for (const b of this.#bodies) { this.#walls(b); b.tickSleep(0.05); }
    this.#time += dt;
    this.#steps++;
  }
  energy() {
    let e = 0;
    for (const b of this.#bodies) if (b.invMass !== 0) e += b.kinetic - b.mass * this.gravity.y * b.pos.y;
    for (const { a, b, k, rest } of this.#springs) { const x = a.pos.sub(b.pos).len - rest; e += 0.5 * k * x * x; }
    return e;
  }
  *simulate(frameTimes, dt) {
    let acc = 0, frame = 0;
    for (const ft of frameTimes) {
      acc += Math.min(ft, 0.25);
      let sub = 0;
      substeps: while (acc >= dt) {
        try {
          this.step(dt);
        } catch (e) {
          if (!(e instanceof TunnelError)) throw e;
          this.tunnelFixes++;
          this.step(dt / 2, true);
          this.step(dt / 2, true);
        } finally {
          acc -= dt;
          sub++;
        }
        if (sub >= 8) { acc = 0; break substeps; }
      }
      frame++;
      const cmd = yield { frame, sub, alpha: r3(acc / dt), energy: r3(this.energy()) };
      if (cmd === 'stop') return { frames: frame, steps: this.#steps, stopped: true };
    }
    return { frames: frame, steps: this.#steps, stopped: false };
  }
  get hashStats() { return this.#hash.stats; }
}

function checksum(bodies) {
  let h = 0xcbf29ce484222325n;
  for (const b of bodies) {
    for (const v of [...b.pos, ...b.vel]) {
      h ^= BigInt.asUintN(64, BigInt(Math.round(v * 1e6)));
      h = (h * 0x100000001b3n) & MASK64;
    }
  }
  return h.toString(16).padStart(16, '0');
}

function frameTimes(seed, n) {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => (i === 7 ? 0.4 : (14 + rng.int(8)) / 1000));
}

function stateLine(w) {
  return w.bodies.map((b) => `${b.id}:${b.pos}`).join(' ');
}

// ---------- scenarios ----------
function scenarioDrop() {
  console.log('== drop ==');
  Body.reset();
  const w = new World({ bounds: { w: 10, h: 50 } });
  const ball = new Ball({ pos: new Vec2(5, 10), r: 0.5, restitution: 0.7, friction: 0.05 });
  w.add(ball);
  const dt = 1 / 120;
  let peak = ball.pos.y, prevVy = 0, apexes = [];
  for (let i = 1; i <= 600; i++) {
    w.step(dt);
    if (prevVy > 0 && ball.vel.y <= 0) apexes.push(r3(ball.pos.y));
    prevVy = ball.vel.y;
    peak = Math.max(peak, ball.pos.y);
    if (i % 60 === 0) console.log(`t=${r3(w.time)} y=${r3(ball.pos.y)} vy=${r3(ball.vel.y)} E=${r3(w.energy())} hits=${ball.hits} sleep=${ball.sleeping}`);
  }
  console.log('apexes ' + apexes.slice(0, 6).join(','));
  console.log(`drop checksum ${checksum(w.bodies)} total bounces ${Ball.totalBounces}`);
}

function scenarioBreak() {
  console.log('== pool break ==');
  Body.reset();
  const w = new World({ gravity: new Vec2(0, 0), bounds: { w: 16, h: 10 }, cell: 1.2, iterations: 4 });
  const balls = [];
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      balls.push(new Ball({ pos: new Vec2(10 + row * 0.87, 5 + (k - row / 2) * 1.0), r: 0.5, restitution: 0.95, friction: 0.02 }));
    }
  }
  const cue = new Ball({ pos: new Vec2(3, 5.05), vel: new Vec2(30, 0), r: 0.5, restitution: 0.95, friction: 0.02 });
  w.add(cue, ...balls);
  const sim = w.simulate(frameTimes(11, 90), 1 / 120);
  let r;
  let n = 0;
  while (!(r = sim.next()).done) {
    n++;
    if (n % 15 === 0 || n === 8) console.log(`frame ${r.value.frame} sub=${r.value.sub} alpha=${r.value.alpha} E=${r.value.energy} tunnels=${w.tunnelFixes}`);
  }
  console.log('result ' + JSON.stringify(r.value));
  console.log('positions ' + stateLine(w));
  const moving = w.bodies.filter((b) => b.vel.len > 0.1).length;
  console.log(`moving=${moving} contacts=${w.contacts.size} pairChecks=${w.pairChecks} hash=${JSON.stringify(w.hashStats)} sum=${checksum(w.bodies)}`);
  const top = [...w.contacts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
  console.log('top contacts ' + JSON.stringify(top));
}

function scenarioStack() {
  console.log('== stack & crates ==');
  Body.reset();
  const w = new World({ bounds: { w: 12, h: 30 }, iterations: 10, integrator: Damped });
  console.log('integrator ' + w.integrator.describe());
  const ground = new Box({ pos: new Vec2(6, 0.25), half: new Vec2(6, 0.25), fixed: true, restitution: 0.1, friction: 0.6 });
  const boxes = [0, 1, 2, 3].map((k) => new Box({ pos: new Vec2(3 + k * 0.05, 1 + k * 1.0), half: new Vec2(0.5, 0.5), restitution: 0.1, friction: 0.5 }));
  const crate = new Crate({ pos: new Vec2(8, 1), half: new Vec2(0.6, 0.5), durability: 6, restitution: 0.1, friction: 0.5 });
  const hammer = new Ball({ pos: new Vec2(8, 12), r: 0.6, mass: 5, restitution: 0.2, friction: 0.3 });
  w.add(ground, ...boxes, crate, hammer);
  const dt = 1 / 120;
  for (let i = 1; i <= 480; i++) {
    try {
      w.step(dt);
    } catch (e) {
      console.log('tunnel at step ' + i + ': ' + e.message);
      w.step(dt, true);
    }
    if (i % 80 === 0) {
      console.log(`t=${r3(w.time)} boxes=${boxes.map((b) => r3(b.pos.y)).join('/')} crate=${w.bodies.includes(crate) ? crate.durability : 'broken'} hammer=${hammer.pos}`);
    }
  }
  console.log(`removed=${JSON.stringify(w.removed)} broken=${JSON.stringify(Crate.broken)} sleeping=${w.bodies.filter((b) => b.sleeping).map((b) => b.id).join(',')}`);
  console.log('stack checksum ' + checksum(w.bodies));
}

function scenarioRope() {
  console.log('== rope ==');
  Body.reset();
  const w = new World({ bounds: { w: 30, h: 30 }, cell: 3 });
  const anchor = new Ball({ pos: new Vec2(15, 25), r: 0.2, fixed: true });
  w.add(anchor);
  let prev = anchor;
  const links = [];
  for (let i = 1; i <= 8; i++) {
    const link = new Ball({ pos: new Vec2(15 + i * 1.0, 25), r: 0.2, mass: 0.5, restitution: 0.3 });
    w.add(link);
    w.spring(prev, link, 400, 1.0, 1.5);
    links.push(link);
    prev = link;
  }
  const dt = 1 / 240;
  for (let i = 1; i <= 720; i++) {
    w.step(dt);
    if (i % 120 === 0) console.log(`t=${r3(w.time)} tip=${links[links.length - 1].pos} mid=${links[3].pos} E=${r3(w.energy())}`);
  }
  const stretch = links.map((l, i) => r3(l.pos.sub(i === 0 ? anchor.pos : links[i - 1].pos).len));
  console.log('link lengths ' + stretch.join(','));
}

function scenarioCharges() {
  console.log('== charges ==');
  Body.reset();
  const w = new World({ gravity: new Vec2(0, 0), bounds: { w: 10, h: 10 }, coulomb: 2, integrator: Damped });
  const rng = makeRng(99);
  for (let i = 0; i < 6; i++) {
    w.add(new ChargedBall({ pos: new Vec2(rng.range(4, 6), rng.range(4, 6)), r: 0.3, charge: i % 3 === 0 ? -1 : 1, restitution: 0.5 }));
  }
  for (let i = 1; i <= 400; i++) {
    w.step(1 / 100);
    if (i % 100 === 0) console.log(`t=${r3(w.time)} ${w.bodies.map((b) => (b.charge > 0 ? '+' : '-') + b.pos).join(' ')}`);
  }
  console.log('describe ' + w.bodies[0].describe());
  console.log(`isBall ${Ball.isBall(w.bodies[0])} instanceof Circle ${w.bodies[0] instanceof Circle} shape=${w.bodies[0].shape}`);
}

function scenarioIntegrators() {
  console.log('== integrators ==');
  const dt = 1 / 30, T = 2;
  const exact = (t) => 10 * t - 0.5 * 9.81 * t * t;
  for (const integ of [Euler, Damped, Verlet]) {
    Body.reset();
    const w = new World({ bounds: { w: 1000, h: 1000 }, integrator: integ });
    const b = new Ball({ pos: new Vec2(1, 100), vel: new Vec2(3, 10), r: 0.5 });
    w.add(b);
    const samples = [];
    for (let i = 1; i * dt <= T + 1e-9; i++) {
      w.step(dt, true);
      if (i % 15 === 0) samples.push(r3(b.pos.y - 100 - exact(i * dt)));
    }
    console.log(`${integ.describe()}: x=${r3(b.pos.x)} y=${r3(b.pos.y)} err=${samples.join(',')}`);
  }
}

function scenarioProxy() {
  console.log('== proxy ==');
  Body.reset();
  const target = new Ball({ pos: new Vec2(2, 5), r: 0.5 });
  const writes = {};
  const guarded = new Proxy(target, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (v instanceof Vec2 && (Number.isNaN(v.x) || Number.isNaN(v.y))) throw new RangeError('NaN ' + String(k));
      writes[k] = (writes[k] ?? 0) + 1;
      return Reflect.set(t, k, v, t);
    },
  });
  const w = new World({ bounds: { w: 10, h: 10 } });
  w.add(guarded);
  for (let i = 0; i < 120; i++) w.step(1 / 60);
  console.log('writes ' + JSON.stringify(writes) + ' pos=' + guarded.pos + ' id=' + guarded.id + ' hits=' + guarded.hits);
  console.log('private via proxy: ' + Ball.isBall(guarded) + ' raw: ' + Ball.isBall(target));
  const naive = new Proxy(target, {});
  try {
    naive.describe();
  } catch (e) {
    console.log('naive proxy private access -> ' + (e instanceof TypeError));
  }
  try {
    guarded.vel = new Vec2(NaN, 0);
  } catch (e) {
    console.log('guard ' + e.message);
  }
  try { new Body({ pos: new Vec2() }); } catch (e) { console.log('abstract ' + e.message); }
  const v = new Vec2(3, 4);
  const [vx, vy] = v;
  console.log(`vec str=${String(v)} num=${+v} spread=${[...v]} destr=${vx}/${vy} tag=${Object.prototype.toString.call(v)} json=${JSON.stringify({ v })}`);
}

// ---------- deep recursion ----------
function buildRope(n) { return n === 0 ? null : { stretch: (n % 7) * 0.01, next: buildRope(n - 1) }; }
function ropeEnergy(node, k) { return node === null ? 0 : 0.5 * k * node.stretch * node.stretch + ropeEnergy(node.next, k); }
function pingDepth(n) { return n <= 0 ? 0 : 1 + pongDepth(n - 1); }
function pongDepth(n) { return n <= 0 ? 0 : 1 + pingDepth(n - 1); }

function scenarioMisc() {
  console.log('== misc ==');
  const rope = buildRope(3000);
  console.log(`rope energy ${r3(ropeEnergy(rope, 100))} ping ${pingDepth(3000)}`);
  const snapshot = JSON.stringify({ t: 1.23456, bodies: [{ id: 1, pos: new Vec2(1.23456, -0.0001), vel: new Vec2(0, 2) }] }, (k, v) => (typeof v === 'number' ? r3(v) : v));
  const restored = JSON.parse(snapshot, (k, v) => (Array.isArray(v) && v.length === 2 && (k === 'pos' || k === 'vel') ? new Vec2(...v) : v));
  console.log('snapshot ' + snapshot + ' restoredVec=' + (restored.bodies[0].pos instanceof Vec2) + ' len=' + r3(+restored.bodies[0].vel));
  const later = [];
  for (let i = 0; i < 3; i++) later.push(() => i * 10);
  const kinds = {};
  for (const kind of ['circle', 'box']) kinds[kind] = () => kind.length;
  const cfg = { a: 1, b: 2 };
  const keyFns = [];
  for (const k in cfg) keyFns.push(() => k + cfg[k]);
  cfg.a = 100;
  console.log('closures ' + later.map((f) => f()).join(',') + ' ' + kinds.circle() + kinds.box() + ' ' + keyFns.map((f) => f()).join(','));
  const opts = { cell: 0, name: null, iter: 3 };
  opts.cell ||= 2;
  opts.name ??= 'default';
  opts.iter &&= opts.iter * 2;
  console.log(`opts ${JSON.stringify(opts)} ${opts.extra?.value ?? 'none'} ${typeof opts.fn?.()}`);
  const fn = function () { return Array.prototype.map.call(arguments, (a) => typeof a).join('/') + ':' + arguments.length; };
  console.log('arguments ' + fn(1, 'x', null, undefined, new Vec2()));
  let i = 0, log = [];
  do {
    i++;
    if (i === 3) continue;
    log.push(i);
  } while (i < 6);
  const c = (i += 10, i * 2);
  console.log('dowhile ' + log.join('') + ' comma ' + c + ' delete=' + delete opts.iter + ' in=' + ('iter' in opts) + ' void=' + void 0);
  lbl: {
    if (c > 10) break lbl;
    console.log('unreached');
  }
  const obj = {};
  Object.defineProperty(obj, 'area', { get() { return r3(Math.PI * this.r * this.r); }, enumerable: false, configurable: true });
  obj.r = 2;
  console.log('area ' + obj.area + ' keys=' + Object.keys(obj).join(','));
}

async function* worldFrames(label, seed, frames) {
  Body.reset();
  const w = new World({ bounds: { w: 10, h: 10 }, gravity: new Vec2(0, -9.81) });
  const rng = makeRng(seed);
  for (let i = 0; i < 4; i++) w.add(new Ball({ pos: new Vec2(rng.range(1, 9), rng.range(3, 9)), vel: new Vec2(rng.range(-2, 2), 0), r: 0.4, restitution: 0.6 }));
  const bodies = w.bodies;
  for (let f = 0; f < frames; f++) {
    await null;
    for (let s = 0; s < 4; s++) w.step(1 / 240);
    yield { label, f, sum: checksum(bodies).slice(0, 8), y: r3(bodies[0].pos.y) };
  }
}

async function scenarioAsync() {
  console.log('== async ==');
  const order = [];
  const run = async (label, seed) => {
    let last = null, n = 0;
    for await (const fr of worldFrames(label, seed, 30)) {
      if (fr.f % 10 === 0) order.push(`${label}${fr.f}`);
      last = fr;
      if (++n >= 25) break;
    }
    return last;
  };
  const results = await Promise.all([run('A', 1), run('B', 2), run('C', 3)]);
  console.log('order ' + order.join(' '));
  console.log('results ' + JSON.stringify(results));
  const settled = await Promise.allSettled([
    (async () => { const w = new World(); w.add(new Ball({ pos: new Vec2(5, 5), vel: new Vec2(500, 0), r: 0.1 })); w.step(0.1); return 'no tunnel?'; })(),
    (async () => 'ok'),
  ].map((p) => (typeof p === 'function' ? p() : p)));
  console.log('settled ' + settled.map((s) => s.status + ':' + (s.value ?? s.reason.message)).join(' | '));
  const winner = await Promise.race([run('R', 9).then((r) => 'sim ' + r.f), Promise.resolve().then(() => 'tick')]);
  const any = await Promise.any([Promise.reject(new Error('no')), (async () => { await null; return 'yes'; })()]);
  console.log(`race=${winner} any=${any} worlds=${World.created > 5}`);
}

function main() {
  scenarioDrop();
  scenarioBreak();
  scenarioStack();
  scenarioRope();
  scenarioCharges();
  scenarioIntegrators();
  scenarioProxy();
  scenarioMisc();
  return scenarioAsync().then(() => console.log('== done ==')).catch((e) => console.log('FAILED ' + e.stack));
}

main();
