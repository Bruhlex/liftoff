// Shape/geometry class hierarchy: polymorphism, Symbol.toPrimitive, static factories, mixins
'use strict';

const round = (x, d = 3) => {
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

class Vec {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  static of(...args) {
    if (args.length === 1 && Array.isArray(args[0])) return new Vec(...args[0]);
    return new Vec(...args);
  }
  add({ x, y }) { return new Vec(this.x + x, this.y + y); }
  sub({ x, y }) { return new Vec(this.x - x, this.y - y); }
  scale(k) { return new Vec(this.x * k, this.y * k); }
  dot(v) { return this.x * v.x + this.y * v.y; }
  cross(v) { return this.x * v.y - this.y * v.x; }
  get length() { return Math.hypot(this.x, this.y); }
  rotate(deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return new Vec(round(this.x * c - this.y * s, 9), round(this.x * s + this.y * c, 9));
  }
  equals(v, eps = 1e-9) { return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps; }
  toString() { return `(${round(this.x)}, ${round(this.y)})`; }
  *[Symbol.iterator]() { yield this.x; yield this.y; }
}

class Shape {
  static #registry = new Map();
  static count = 0;
  #name;

  constructor(name) {
    if (new.target === Shape) throw new TypeError('Shape is abstract');
    this.#name = name;
    Shape.count++;
  }

  static register(kind, factory) {
    Shape.#registry.set(kind, factory);
  }

  static create(spec) {
    const { kind, ...rest } = spec;
    const factory = Shape.#registry.get(kind);
    if (!factory) throw new Error(`unknown shape kind: ${kind}`);
    return factory(rest);
  }

  static get kinds() { return [...Shape.#registry.keys()]; }

  get name() { return this.#name; }
  area() { throw new Error('not implemented'); }
  perimeter() { throw new Error('not implemented'); }
  get centroid() { return new Vec(); }

  describe() {
    return `${this.name} area=${round(this.area())} perim=${round(this.perimeter())} c=${this.centroid}`;
  }

  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.area();
    return `[${this.constructor.name} ${this.name}]`;
  }

  compareTo(other) { return this.area() - other.area(); }
}

class Circle extends Shape {
  #r;
  constructor(center, r, name = 'circle') {
    super(name);
    if (r <= 0) throw new RangeError('radius must be positive');
    this.center = center;
    this.#r = r;
  }
  get radius() { return this.#r; }
  set radius(v) {
    if (v <= 0) throw new RangeError('radius must be positive');
    this.#r = v;
  }
  area() { return Math.PI * this.#r ** 2; }
  perimeter() { return 2 * Math.PI * this.#r; }
  get centroid() { return this.center; }
  contains(p) { return p.sub(this.center).length <= this.#r; }
  toString() { return `Circle(${this.center}, r=${this.#r})`; }
}

class Polygon extends Shape {
  constructor(points, name = 'polygon') {
    super(name);
    if (points.length < 3) throw new RangeError(`polygon needs >= 3 points, got ${points.length}`);
    this.points = points;
  }
  static regular(n, radius, center = new Vec()) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(center.add(new Vec(radius, 0).rotate((360 / n) * i)));
    return new Polygon(pts, `regular-${n}`);
  }
  toString() { return `${this.constructor.name}[${this.points.length}] ${this.points.slice(0, 2).join(' ')}...`; }
  *edges() {
    const { points } = this;
    for (let i = 0; i < points.length; i++) yield [points[i], points[(i + 1) % points.length]];
  }
  signedArea() {
    let s = 0;
    for (const [a, b] of this.edges()) s += a.cross(b);
    return s / 2;
  }
  area() { return Math.abs(this.signedArea()); }
  perimeter() {
    let p = 0;
    for (const [a, b] of this.edges()) p += b.sub(a).length;
    return p;
  }
  get centroid() {
    const A = this.signedArea();
    let cx = 0, cy = 0;
    for (const [a, b] of this.edges()) {
      const f = a.cross(b);
      cx += (a.x + b.x) * f;
      cy += (a.y + b.y) * f;
    }
    return new Vec(cx / (6 * A), cy / (6 * A));
  }
  isConvex() {
    let sign = 0;
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const a = this.points[i], b = this.points[(i + 1) % n], c = this.points[(i + 2) % n];
      const z = b.sub(a).cross(c.sub(b));
      if (z !== 0) {
        if (sign === 0) sign = Math.sign(z);
        else if (Math.sign(z) !== sign) return false;
      }
    }
    return true;
  }
  contains(p) {
    let inside = false;
    for (const [a, b] of this.edges()) {
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
}

class Rect extends Polygon {
  constructor(x, y, w, h, name = 'rect') {
    super([new Vec(x, y), new Vec(x + w, y), new Vec(x + w, y + h), new Vec(x, y + h)], name);
    this.w = w;
    this.h = h;
  }
  static square(side, name = 'square') { return new Rect(0, 0, side, side, name); }
  area() { return this.w * this.h; }
  get isSquare() { return this.w === this.h; }
  toString() { return `Rect ${this.w}x${this.h} @ ${this.points[0]}`; }
}

class Triangle extends Polygon {
  constructor(a, b, c, name = 'triangle') {
    super([a, b, c], name);
  }
  get sides() {
    return [...this.edges()].map(([p, q]) => q.sub(p).length).sort((x, y) => x - y);
  }
  classify() {
    const [a, b, c] = this.sides.map((s) => round(s, 6));
    const kind = a === c ? 'equilateral' : a === b || b === c ? 'isosceles' : 'scalene';
    const d = round(a * a + b * b - c * c, 6);
    const angle = d === 0 ? 'right' : d > 0 ? 'acute' : 'obtuse';
    return `${kind}/${angle}`;
  }
}

const Serializable = {
  serialize() {
    const data = { type: this.constructor.name, name: this.name };
    for (const key of Object.keys(this)) {
      const v = this[key];
      data[key] = Array.isArray(v) ? v.map((p) => [...p]) : v instanceof Vec ? [...v] : v;
    }
    return JSON.stringify(data);
  },
};

const Colored = {
  paint(color) {
    this.color = color;
    return this;
  },
  get hexColor() {
    const named = { red: '#ff0000', green: '#00ff00', blue: '#0000ff' };
    return named[this.color] ?? this.color ?? 'none';
  },
};

Object.assign(Shape.prototype, Serializable);
Object.defineProperties(Shape.prototype, Object.getOwnPropertyDescriptors(Colored));

Shape.register('circle', ({ x = 0, y = 0, r }) => new Circle(new Vec(x, y), r));
Shape.register('rect', ({ x = 0, y = 0, w, h }) => new Rect(x, y, w, h));
Shape.register('square', ({ side }) => Rect.square(side));
Shape.register('tri', ({ pts }) => {
  if (pts?.length !== 3) throw new RangeError(`triangle needs 3 points, got ${pts?.length ?? 0}`);
  return new Triangle(...pts.map((p) => Vec.of(p)));
});
Shape.register('ngon', ({ n, r }) => Polygon.regular(n, r));

function boundingBox(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    const pts = s instanceof Circle
      ? [s.center.add(new Vec(-s.radius, -s.radius)), s.center.add(new Vec(s.radius, s.radius))]
      : s.points;
    for (const { x, y } of pts) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY) };
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => a.sub(o).cross(b.sub(o));
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function rasterize(shape, w, h) {
  const rows = [];
  for (let y = h - 1; y >= 0; y--) {
    let row = '';
    for (let x = 0; x < w; x++) row += shape.contains(new Vec(x + 0.5, y + 0.5)) ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

function main() {
  console.log('--- vectors ---');
  const a = new Vec(3, 4), b = Vec.of([1, -2]);
  console.log(`a=${a} b=${b} a+b=${a.add(b)} a-b=${a.sub(b)} |a|=${a.length}`);
  console.log(`dot=${a.dot(b)} cross=${a.cross(b)} rot90=${a.rotate(90)} rot45=${a.rotate(45)}`);
  const [ax, ay] = a;
  console.log('destructured', ax, ay, 'spread', [...b].join('/'));

  console.log('--- factory ---');
  const specs = [
    { kind: 'circle', x: 1, y: 1, r: 2 },
    { kind: 'rect', x: 0, y: 0, w: 4, h: 3 },
    { kind: 'square', side: 5 },
    { kind: 'tri', pts: [[0, 0], [4, 0], [0, 3]] },
    { kind: 'tri', pts: [[0, 0], [2, 0], [1, Math.sqrt(3)]] },
    { kind: 'ngon', n: 6, r: 2 },
    { kind: 'blob' },
    { kind: 'circle', r: -1 },
    { kind: 'tri', pts: [[0, 0], [1, 1]] },
  ];
  const shapes = [];
  for (const spec of specs) {
    try {
      const s = Shape.create(spec);
      shapes.push(s);
      console.log(`${String(s).padEnd(22)} ${s.describe()}`);
    } catch (e) {
      console.log(`failed ${JSON.stringify(spec)}: ${e.name}: ${e.message}`);
    }
  }
  console.log('kinds', Shape.kinds.join(','), 'count', Shape.count);
  try {
    new Shape('x');
  } catch (e) {
    console.log('abstract:', e.message);
  }

  console.log('--- polymorphism ---');
  const sorted = [...shapes].sort((x, y) => x - y);
  console.log('by area', sorted.map((s) => `${s.name}:${round(+s, 2)}`).join(' < '));
  const total = shapes.reduce((acc, s) => acc + s, 0);
  console.log('string concat of reduce head', String(total).slice(0, 40));
  const totalArea = shapes.reduce((acc, s) => acc + Number(s), 0);
  console.log('total area', round(totalArea));
  for (const s of shapes) {
    const extra = s instanceof Triangle ? s.classify() : s instanceof Rect ? `square=${s.isSquare}` : s instanceof Circle ? `r=${s.radius}` : `convex=${s.isConvex()}`;
    console.log(`  ${s.constructor.name.padEnd(8)} ${s.toString().padEnd(34)} ${extra}`);
  }

  console.log('--- mixins ---');
  const [c0, r0] = shapes;
  c0.paint('red');
  r0.paint('#123456');
  console.log(c0.hexColor, r0.hexColor, shapes[2].hexColor);
  console.log(c0.serialize());
  console.log(r0.serialize());
  c0.radius = 3;
  console.log('after resize', c0.describe());
  try {
    c0.radius = 0;
  } catch (e) {
    console.log('setter error', e.message);
  }

  console.log('--- hit testing ---');
  const probes = [new Vec(1, 1), new Vec(3.9, 2.9), new Vec(4.1, 1), new Vec(-1, -1), new Vec(0.5, 0.5)];
  for (const p of probes) {
    const hits = shapes.filter((s) => s.contains(p)).map((s) => s.name);
    console.log(`${p}: ${hits.join(',') || 'none'}`);
  }
  console.log('bbox', JSON.stringify(boundingBox(shapes)));

  console.log('--- hull ---');
  const cloud = [];
  for (let i = 0; i < 20; i++) cloud.push(new Vec((i * 7) % 11, (i * 5) % 9));
  const hull = convexHull(cloud);
  console.log('hull', hull.map(String).join(' '));
  const hullPoly = new Polygon(hull, 'hull');
  console.log(hullPoly.describe(), 'convex', hullPoly.isConvex());
  const concave = new Polygon([[0, 0], [6, 0], [6, 6], [3, 2], [0, 6]].map((p) => Vec.of(p)), 'arrow');
  console.log(concave.describe(), 'convex', concave.isConvex());

  console.log('--- raster ---');
  rasterize(concave, 6, 6).forEach((r) => console.log('  ' + r));
  rasterize(new Circle(new Vec(5, 3), 2.6), 10, 6).forEach((r) => console.log('  ' + r));
}

main();
