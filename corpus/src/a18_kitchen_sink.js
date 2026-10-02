'use strict';
// a18: kitchen sink (strict mode)

function makeRange(start, end = start + 10, step = end > start ? 1 : -1, label = `${start}..${end}/${step}`) {
  const out = [];
  for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
  return { label, values: out };
}

function defaultParams() {
  console.log(JSON.stringify(makeRange(3)));
  console.log(JSON.stringify(makeRange(5, 0)));
  console.log(JSON.stringify(makeRange(0, 10, 3)));
  console.log(JSON.stringify(makeRange(0, 4, undefined, 'custom')));
  let calls = 0;
  function withSideEffect(a, b = ++calls, c = a + b) {
    return [a, b, c].join(',');
  }
  console.log('defaults eval', withSideEffect(1), withSideEffect(1, 5), withSideEffect(2), 'calls', calls);
  function scopeOfDefaults(x = 1, f = () => x) {
    let x2 = 2;
    x = 10;
    return f() + x2;
  }
  console.log('default closure sees param', scopeOfDefaults());
}

// four levels of nested functions
function level1(seed) {
  const trail = ['L1:' + seed];
  function level2(mult) {
    const base = seed * mult;
    trail.push('L2:' + base);
    function level3(offset) {
      const mid = base + offset;
      trail.push('L3:' + mid);
      function level4(pow) {
        const res = mid ** pow;
        trail.push('L4:' + res);
        return { res, depthSum: seed + mult + offset + pow };
      }
      return [level4(2), level4(3)];
    }
    return level3(1).concat(level3(-1));
  }
  const r = level2(3);
  return { results: r.map((x) => x.res), sums: r.map((x) => x.depthSum), trail };
}

class Inventory {
  #items = new Map();
  static #instances = 0;
  constructor(owner) {
    this.owner = owner;
    Inventory.#instances++;
  }
  add(name, qty = 1, price = 0) {
    const cur = this.#items.get(name) ?? { qty: 0, price };
    cur.qty += qty;
    cur.price = price || cur.price;
    this.#items.set(name, cur);
    return this;
  }
  remove(name, qty = 1) {
    const cur = this.#items.get(name);
    if (!cur) throw new Error(`no item ${name}`);
    if (cur.qty < qty) throw new RangeError(`not enough ${name}: ${cur.qty} < ${qty}`);
    cur.qty -= qty;
    if (cur.qty === 0) this.#items.delete(name);
    return this;
  }
  get total() {
    let t = 0;
    for (const { qty, price } of this.#items.values()) t += qty * price;
    return t;
  }
  get count() {
    return [...this.#items.values()].reduce((s, i) => s + i.qty, 0);
  }
  get summary() {
    return [...this.#items].map(([n, { qty }]) => `${n}x${qty}`).sort().join(' ');
  }
  static get instances() {
    return Inventory.#instances;
  }
  *[Symbol.iterator]() {
    yield* [...this.#items.keys()].sort();
  }
}

function inventoryTest() {
  const inv = new Inventory('ann');
  inv.add('apple', 5, 0.5).add('pear', 2, 0.75).add('apple', 3).add('melon', 1, 3);
  console.log('inv', inv.summary, 'count', inv.count, 'total', inv.total.toFixed(2));
  inv.remove('pear', 2);
  try {
    inv.remove('melon', 5);
  } catch (e) {
    console.log('caught', e.name, e.message);
  }
  try {
    inv.remove('kiwi');
  } catch (e) {
    console.log('caught', e.name, e.message);
  }
  console.log('after remove', inv.summary, [...inv].join('|'));
  new Inventory('bob');
  console.log('instances', Inventory.instances);
  try {
    inv.total = 5;
  } catch (e) {
    console.log('strict assign to getter-only', e.constructor.name);
  }
}

function loopClosures() {
  const fns = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      fns.push(() => `${i}${j}`);
    }
  }
  console.log('nested loop closures', fns.map((f) => f()).join(' '));
  const timers = [];
  let k = 0;
  while (k < 3) {
    const captured = k;
    timers.push(() => captured * captured);
    k++;
  }
  console.log('while closures', timers.map((f) => f()).join(','), 'k', k);
  const byName = {};
  for (const [idx, name] of ['x', 'y', 'z'].entries()) {
    byName[name] = () => name.repeat(idx + 1);
  }
  console.log('entries closures', Object.values(byName).map((f) => f()).join(' '));
}

function strictModeChecks() {
  try {
    undeclaredStrictVar = 1; // eslint-disable-line no-undef
  } catch (e) {
    console.log('strict implicit global', e.constructor.name);
  }
  try {
    const frozen = Object.freeze({ a: 1 });
    frozen.a = 2;
  } catch (e) {
    console.log('strict frozen write', e.constructor.name);
  }
  try {
    delete Object.prototype;
  } catch (e) {
    console.log('strict delete non-configurable', e.constructor.name);
  }
  function thisIsUndefined() {
    return this;
  }
  console.log('strict this', thisIsUndefined(), typeof thisIsUndefined.call(7));
  try {
    (function () {
      return arguments.callee;
    })();
  } catch (e) {
    console.log('strict callee', e.constructor.name);
  }
}

const utils = {
  compose: (...fns) => (x) => fns.reduceRight((v, f) => f(v), x),
  debounceSim(fn) {
    let pending = null;
    return {
      call: (...a) => {
        pending = a;
      },
      flush: () => (pending ? fn(...pending) : 'nothing'),
    };
  },
  deepFreeze(o) {
    Object.values(o).forEach((v) => typeof v === 'object' && v !== null && utils.deepFreeze(v));
    return Object.freeze(o);
  },
};

function utilsTest() {
  const slugify = utils.compose(
    (s) => s.replace(/^-+|-+$/g, ''),
    (s) => s.replace(/[^a-z0-9]+/g, '-'),
    (s) => s.toLowerCase(),
    (s) => s.trim()
  );
  console.log('slug', slugify('  Hello, World! JS & You  '));
  const d = utils.debounceSim((a, b) => `flushed ${a}+${b}`);
  console.log(d.flush());
  d.call(1, 2);
  d.call(3, 4);
  console.log(d.flush());
  const cfg = utils.deepFreeze({ db: { host: 'h', ports: [1, 2] } });
  try {
    cfg.db.ports.push(3);
  } catch (e) {
    console.log('deepFreeze push', e.constructor.name, cfg.db.ports.length);
  }
}

function miscFeatures() {
  const { a = 1, ...rest } = { b: 2, c: 3 };
  const [x, , y = 'Y', ...others] = [10, 20, undefined, 40, 50];
  console.log('destr', a, JSON.stringify(rest), x, y, others.join(','));
  const tag = (s, ...v) => s.reduce((acc, str, i) => acc + str + (i < v.length ? `<${v[i]}>` : ''), '');
  console.log(tag`sum ${1 + 2} of ${'parts'}!`);
  const opt = { deep: { fn: () => 'called' } };
  console.log('optional', opt?.deep?.fn?.(), opt.missing?.fn(), opt.deep.nope ?? 'dflt');
  const big = 2n ** 70n;
  console.log('bigint', big.toString(), (big % 1000n).toString());
  label: for (const i of [1, 2, 3]) {
    switch (i) {
      case 2:
        continue label;
      default:
        console.log('label/switch', i);
    }
  }
  const gen = (function* () {
    const got = yield 'first';
    yield 'got ' + got;
  })();
  console.log(gen.next().value, gen.next('sent').value, gen.next().done);
  const counts = [...'abracadabra'].reduce((m, ch) => ((m[ch] = (m[ch] ?? 0) + 1), m), {});
  console.log('counts', JSON.stringify(counts));
  console.log('exp/bit', 2 ** 8 - 1, (255 >>> 4) & 0xf, ~5, -17 >>> 28);
}

function main() {
  defaultParams();
  const r = level1(2);
  console.log('nested results', r.results.join(','), 'sums', r.sums.join(','));
  console.log('trail', r.trail.join(' '));
  inventoryTest();
  loopClosures();
  strictModeChecks();
  utilsTest();
  miscFeatures();
  console.log('done a18');
}

main();
