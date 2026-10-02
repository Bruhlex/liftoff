// a11: objects

function literalAccessors() {
  const temp = {
    _c: 25,
    get f() {
      return this._c * 9 / 5 + 32;
    },
    set f(v) {
      this._c = (v - 32) * 5 / 9;
    },
    get description() {
      return this._c + 'C / ' + this.f + 'F';
    },
  };
  console.log(temp.description);
  temp.f = 212;
  console.log(temp.description);
  console.log('keys', Object.keys(temp).join(','));
}

function defineProperty() {
  const o = {};
  Object.defineProperty(o, 'ro', { value: 1, writable: false, enumerable: true, configurable: false });
  Object.defineProperty(o, 'hidden', { value: 'h', enumerable: false });
  let backing = 10;
  Object.defineProperty(o, 'computed', {
    get() {
      return backing * 2;
    },
    set(v) {
      backing = v;
    },
    enumerable: true,
  });
  o.ro = 999;
  o.computed = 21;
  console.log('ro', o.ro, 'computed', o.computed, 'hidden', o.hidden);
  console.log('keys', Object.keys(o).join(','), 'own names', Object.getOwnPropertyNames(o).join(','));
  const d = Object.getOwnPropertyDescriptor(o, 'ro');
  console.log('desc', JSON.stringify(d));
  try {
    Object.defineProperty(o, 'ro', { value: 2 });
  } catch (e) {
    console.log('redefine non-configurable', e.constructor.name);
  }
  (function () {
    'use strict';
    try {
      o.ro = 5;
    } catch (e) {
      console.log('strict write readonly', e.constructor.name);
    }
  })();
  Object.defineProperties(o, { a: { value: 'A', enumerable: true }, b: { value: 'B' } });
  console.log('defineProperties', Object.keys(o).join(','));
}

function freezeSeal() {
  const f = Object.freeze({ x: 1, nested: { y: 2 } });
  f.x = 100;
  f.z = 3;
  delete f.x;
  f.nested.y = 200;
  console.log('frozen', JSON.stringify(f), Object.isFrozen(f), Object.isFrozen(f.nested));
  const s = Object.seal({ a: 1 });
  s.a = 2;
  s.b = 3;
  delete s.a;
  console.log('sealed', JSON.stringify(s), Object.isSealed(s));
  const p = Object.preventExtensions({ k: 1 });
  p.k2 = 2;
  delete p.k;
  console.log('preventExtensions', JSON.stringify(p), Object.isExtensible(p));
}

function entriesFromEntries() {
  const prices = { apple: 1.2, bread: 2.5, milk: 0.99, cheese: 5 };
  const doubled = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k.toUpperCase(), +(v * 2).toFixed(2)]));
  console.log('fromEntries', JSON.stringify(doubled));
  console.log('values sum', Object.values(prices).reduce((a, b) => a + b, 0).toFixed(2));
  const filtered = Object.fromEntries(Object.entries(prices).filter(([, v]) => v > 1));
  console.log('filtered', Object.keys(filtered).join(','));
  console.log('fromEntries map', JSON.stringify(Object.fromEntries(new Map([['m', 1], ['n', 2]]))));
  const merged = Object.assign({}, { a: 1 }, null, { b: 2 }, { a: 3 });
  console.log('assign', JSON.stringify(merged));
}

function prototypeChains() {
  const animal = {
    type: 'animal',
    speak() {
      return this.name + ' makes a ' + this.sound();
    },
    sound() {
      return 'noise';
    },
  };
  const dog = Object.create(animal, { name: { value: 'Rex', enumerable: true } });
  dog.sound = function () {
    return 'woof (was ' + Object.getPrototypeOf(dog).sound.call(this) + ')';
  };
  const puppy = Object.create(dog);
  puppy.name = 'Bit';
  console.log(dog.speak());
  console.log(puppy.speak());
  console.log('chain', Object.getPrototypeOf(puppy) === dog, animal.isPrototypeOf(puppy), puppy.hasOwnProperty('type'), 'type' in puppy);
  const bare = Object.create(null);
  bare.key = 'v';
  console.log('null proto', typeof bare.toString, 'key' in bare, Object.keys(bare).join(','), Object.getPrototypeOf(bare));
  const withSuper = {
    __proto__: animal,
    sound() {
      return 'meow+' + super.sound();
    },
    name: 'Tom',
  };
  console.log(withSuper.speak());
  Object.setPrototypeOf(withSuper, { sound: () => 'swapped', speak: animal.speak });
  console.log('after setPrototypeOf', withSuper.speak());
}

function computedAndShorthand() {
  const x = 1, y = 2;
  let i = 0;
  const key = 'dyn';
  const o = {
    x,
    y,
    [key + '_' + ++i]: 'first',
    [key + '_' + ++i]: 'second',
    [`t${x + y}`]: 'template',
    method() {
      return 'method:' + this.x;
    },
    ['comp' + 'Method']() {
      return 'computed method';
    },
    'quoted-key': 'q',
    42: 'num',
    get [key]() {
      return 'dyn getter';
    },
  };
  console.log(JSON.stringify(o));
  console.log(o.method(), o.compMethod(), o.dyn, o[42], o['42'], o['quoted-key']);
}

function symbolKeys() {
  const id = Symbol('id');
  const hidden = Symbol.for('app.hidden');
  const o = { [id]: 123, visible: true, [hidden]: 'h' };
  console.log('symbol access', o[id], o[Symbol.for('app.hidden')], Symbol.for('app.hidden') === hidden, Symbol('id') === id);
  console.log('keys', Object.keys(o).join(','), JSON.stringify(o), Object.getOwnPropertySymbols(o).length);
  console.log('symbol desc', id.toString(), id.description, Symbol.keyFor(hidden), Symbol.keyFor(id));
  console.log('Reflect.ownKeys', Reflect.ownKeys(o).map(String).join(','));
  const tagged = { [Symbol.toStringTag]: 'Custom' };
  console.log('toStringTag', Object.prototype.toString.call(tagged));
}

function deleteAndIn() {
  const o = { a: 1, b: undefined, c: null };
  console.log('in', 'a' in o, 'b' in o, 'z' in o, 'toString' in o, o.b === undefined);
  console.log('delete', delete o.a, delete o.zzz, 'a' in o, JSON.stringify(Object.keys(o)));
  const arr = [1, 2, 3];
  delete arr[1];
  console.log('delete array', arr.length, 1 in arr, JSON.stringify(arr));
  console.log('hasOwn', Object.hasOwn(o, 'b'), Object.hasOwn(o, 'toString'));
}

function optionalChaining() {
  const data = { user: { profile: { name: 'Zed', tags: ['x'] }, getAge() { return 40; } }, list: null };
  console.log('?.', data.user?.profile?.name, data.nope?.profile.name, data.list?.[0], data.user.profile.tags?.[0]);
  console.log('?.()', data.user.getAge?.(), data.user.missing?.(), data.nope?.fn());
  console.log('??', null ?? 'd1', undefined ?? 'd2', 0 ?? 'd3', '' ?? 'd4', false ?? 'd5');
  console.log('|| vs ??', 0 || 'or', 0 ?? 'nullish');
  const cfg = { a: null, b: 0, c: 'set', d: 1 };
  cfg.a ??= 'filled';
  cfg.b ??= 'not filled';
  cfg.b ||= 'or-filled';
  cfg.c &&= cfg.c.toUpperCase();
  cfg.d &&= 0;
  cfg.e ||= [];
  console.log('logical assign', JSON.stringify(cfg));
  let calls = 0;
  const lazy = { v: 1 };
  lazy.v ||= ++calls;
  lazy.v ??= ++calls;
  console.log('short-circuit assign calls', calls);
}

function objectIteration() {
  const inventory = { swords: 3, shields: 1, potions: 12 };
  const lines = [];
  for (const [item, qty] of Object.entries(inventory)) lines.push(item + ':' + qty);
  console.log(lines.join(' '));
  const grouped = {};
  ['apple', 'avocado', 'banana', 'blueberry', 'cherry'].forEach((f) => {
    (grouped[f[0]] ||= []).push(f);
  });
  console.log('grouped', JSON.stringify(grouped));
  const deepClone = JSON.parse(JSON.stringify({ a: [1, { b: 2 }] }));
  deepClone.a[1].b = 99;
  console.log('clone', JSON.stringify(deepClone));
  console.log('structuredClone', typeof structuredClone === 'function' ? JSON.stringify(structuredClone({ q: [1] })) : '{"q":[1]}');
}

function equalityOfObjects() {
  const a = { v: 1 };
  const b = { v: 1 };
  const c = a;
  console.log('identity', a === b, a === c, a == b, Object.is(a, c));
  const shallowEqual = (x, y) => {
    const kx = Object.keys(x), ky = Object.keys(y);
    return kx.length === ky.length && kx.every((k) => x[k] === y[k]);
  };
  console.log('shallowEqual', shallowEqual(a, b), shallowEqual(a, { v: 2 }));
}

literalAccessors();
defineProperty();
freezeSeal();
entriesFromEntries();
prototypeChains();
computedAndShorthand();
symbolKeys();
deleteAndIn();
optionalChaining();
objectIteration();
equalityOfObjects();
console.log('done a11');
