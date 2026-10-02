// a01: classes - inheritance, super, static, accessors, private members, static blocks, new.target

class Shape {
  static count = 0;
  static registry = [];
  static {
    Shape.initialized = true;
    Shape.registry.push('boot');
  }

  constructor(name) {
    if (new.target === Shape) {
      throw new TypeError('Shape is abstract');
    }
    this.name = name;
    Shape.count++;
    Shape.registry.push(name);
    this.kind = new.target.name;
  }

  area() {
    return 0;
  }

  describe() {
    return this.name + '(' + this.kind + ') area=' + this.area().toFixed(2);
  }

  static total() {
    return 'shapes=' + Shape.count;
  }

  toString() {
    return '[Shape ' + this.name + ']';
  }
}

class Rect extends Shape {
  #w;
  #h;
  static #created = 0;

  constructor(w, h, name) {
    super(name || 'rect');
    this.#w = w;
    this.#h = h;
    Rect.#created++;
  }

  get width() {
    return this.#w;
  }

  set width(v) {
    if (v <= 0) throw new RangeError('width must be positive: ' + v);
    this.#w = v;
  }

  get height() {
    return this.#h;
  }

  #perimeter() {
    return 2 * (this.#w + this.#h);
  }

  perimeter() {
    return this.#perimeter();
  }

  area() {
    return this.#w * this.#h;
  }

  static created() {
    return Rect.#created;
  }

  static isRect(o) {
    return #w in o;
  }
}

class Square extends Rect {
  constructor(s) {
    super(s, s, 'square');
  }

  describe() {
    return 'SQ:' + super.describe();
  }

  static total() {
    return 'squares-via-' + super.total();
  }
}

class Circle extends Shape {
  #r = 1;
  constructor(r) {
    super('circle');
    this.#r = r;
  }
  get radius() {
    return this.#r;
  }
  area() {
    return Math.PI * this.#r * this.#r;
  }
}

class Counter {
  #value = 0;
  static instances = 0;
  static #secret = 'hidden';
  static {
    this.label = 'Counter-' + Counter.#secret.length;
  }
  constructor() {
    Counter.instances++;
  }
  inc() {
    this.#value++;
    return this;
  }
  dec() {
    this.#value--;
    return this;
  }
  get value() {
    return this.#value;
  }
  static peekSecret() {
    return Counter.#secret;
  }
}

function Legacy(x) {
  if (!new.target) {
    return 'called without new: ' + x;
  }
  this.x = x;
}
Legacy.prototype.getX = function () {
  return this.x;
};

class FromLegacy extends Legacy {
  constructor(x) {
    super(x * 2);
    this.y = x;
  }
  sum() {
    return this.getX() + this.y;
  }
}

function testAbstract() {
  try {
    new Shape('x');
    console.log('no error?!');
  } catch (e) {
    console.log('abstract:', e instanceof TypeError, e.message);
  }
}

function testShapes() {
  const shapes = [new Rect(3, 4), new Square(5), new Circle(2), new Rect(1.5, 2, 'small')];
  for (const s of shapes) {
    console.log(s.describe());
  }
  console.log(Shape.total(), Square.total());
  console.log('registry', Shape.registry.join(','));
  console.log('initialized', Shape.initialized);
  console.log('Rect created', Rect.created());
  return shapes;
}

function testInstanceof(shapes) {
  const [r, sq, c] = shapes;
  console.log('sq instanceof Square', sq instanceof Square);
  console.log('sq instanceof Rect', sq instanceof Rect);
  console.log('sq instanceof Shape', sq instanceof Shape);
  console.log('c instanceof Rect', c instanceof Rect);
  console.log('r instanceof Square', r instanceof Square);
  console.log('isRect r/c/plain', Rect.isRect(r), Rect.isRect(c), Rect.isRect({}));
  console.log('proto chain', Object.getPrototypeOf(Square) === Rect, Object.getPrototypeOf(Square.prototype) === Rect.prototype);
  console.log('String(r)', String(r), `${sq}`);
}

function testAccessors() {
  const r = new Rect(2, 3);
  console.log('w,h', r.width, r.height, 'perim', r.perimeter());
  r.width = 10;
  console.log('after set', r.width, r.area());
  try {
    r.width = -1;
  } catch (e) {
    console.log(e.name, e.message);
  }
  const desc = Object.getOwnPropertyDescriptor(Rect.prototype, 'width');
  console.log('desc get/set', typeof desc.get, typeof desc.set, desc.enumerable);
  console.log('own keys', Object.keys(r).join(','));
  const c = new Circle(3);
  console.log('radius', c.radius);
  c.radius = 99; // no setter: ignored in sloppy mode
  console.log('radius still', c.radius);
}

function testCounter() {
  const a = new Counter();
  const b = new Counter();
  a.inc().inc().inc().dec();
  b.dec();
  console.log('a,b', a.value, b.value, 'instances', Counter.instances);
  console.log('label', Counter.label, Counter.peekSecret());
}

function testLegacy() {
  console.log(Legacy(5));
  const l = new Legacy(7);
  console.log('legacy x', l.getX());
  const f = new FromLegacy(4);
  console.log('fromLegacy', f.x, f.y, f.sum(), f instanceof Legacy);
}

function testClassExpressions() {
  const Mixin = (Base) =>
    class extends Base {
      hello() {
        return 'hello from ' + this.name;
      }
    };
  class Named {
    constructor(n) {
      this.name = n;
    }
  }
  const Mixed = Mixin(Named);
  const m = new Mixed('mixed');
  console.log(m.hello(), Mixed.name === '' ? 'anon' : 'named:' + Mixed.name);
  const Anon = class Inner {
    who() {
      return Inner.name;
    }
  };
  console.log('inner name', new Anon().who());
  const key = 'dyn' + 'Method';
  class Computed {
    [key]() {
      return 'computed ok';
    }
    static ['s' + 1]() {
      return 's1';
    }
    *gen() {
      yield 1;
      yield 2;
    }
  }
  const cc = new Computed();
  console.log(cc.dynMethod(), Computed.s1(), [...cc.gen()].join('|'));
}

function testTypeofClass() {
  console.log('typeof class', typeof Shape, typeof Rect.prototype.area);
  try {
    Rect(1, 2);
  } catch (e) {
    console.log('call class without new ->', e instanceof TypeError);
  }
  class Acc {
    static #n = 0;
    static next() {
      return ++Acc.#n;
    }
  }
  console.log('static private seq', Acc.next(), Acc.next(), Acc.next());
}

testAbstract();
const allShapes = testShapes();
testInstanceof(allShapes);
testAccessors();
testCounter();
testLegacy();
testClassExpressions();
testTypeofClass();
console.log('done a01');
