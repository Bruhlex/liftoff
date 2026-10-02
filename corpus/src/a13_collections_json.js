// a13: Map/Set/WeakMap, JSON with replacer/reviver

function mapBasics() {
  const m = new Map();
  const objKey = { id: 1 };
  const fnKey = function () {};
  m.set('str', 'string key').set(42, 'number key').set(objKey, 'object key').set(fnKey, 'function key').set(NaN, 'nan key');
  console.log('size', m.size, m.get('str'), m.get(42), m.get('42'), m.get(objKey), m.get({ id: 1 }), m.get(NaN));
  console.log('has', m.has(fnKey), m.has('nope'), m.delete(42), m.delete(42), m.size);
  const order = [];
  m.forEach((v, k) => order.push(typeof k));
  console.log('insertion order', order.join(','));
  m.set('str', 'overwritten');
  console.log('overwrite keeps position', [...m.keys()].map((k) => typeof k).join(','), m.get('str'));
  m.set(-0, 'zero');
  console.log('-0 == +0 key', m.get(0));
  m.clear();
  console.log('cleared', m.size);
}

function wordIndex(text) {
  const idx = new Map();
  text.split(/\W+/).filter(Boolean).forEach((w, pos) => {
    const k = w.toLowerCase();
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(pos);
  });
  return idx;
}

function mapUsage() {
  const idx = wordIndex('To be or not to be, that is the question. To be!');
  const top = [...idx.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, 4);
  console.log('index', top.map(([w, ps]) => w + '@' + ps.join('/')).join(' '));
  const inverted = new Map([...idx].map(([k, v]) => [v.length, k]));
  console.log('inverted', JSON.stringify([...inverted]));
  const lru = new LRU(3);
  ['a', 'b', 'c', 'a', 'd', 'b', 'e'].forEach((k) => lru.put(k, k.toUpperCase()));
  console.log('lru', lru.keys().join(','), lru.get('a'), lru.get('e'));
}

class LRU {
  constructor(cap) {
    this.cap = cap;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  put(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);
  }
  keys() {
    return [...this.map.keys()];
  }
}

function setOps() {
  const a = new Set([1, 2, 3, 4, 5]);
  const b = new Set([4, 5, 6, 7]);
  const union = new Set([...a, ...b]);
  const inter = new Set([...a].filter((x) => b.has(x)));
  const diff = new Set([...a].filter((x) => !b.has(x)));
  const sym = new Set([...union].filter((x) => !inter.has(x)));
  console.log('union', [...union].join(','), 'inter', [...inter].join(','), 'diff', [...diff].join(','), 'sym', [...sym].join(','));
  const s = new Set();
  s.add(1).add('1').add(1).add(NaN).add(NaN).add({}).add({});
  console.log('set dedupe size', s.size);
  console.log('delete', s.delete('1'), s.delete('1'), s.has(NaN));
  const seen = new Set();
  const dups = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5].filter((x) => (seen.has(x) ? true : (seen.add(x), false)));
  console.log('dups', dups.join(','));
  const entries = [...new Set(['x', 'y']).entries()];
  console.log('set entries', JSON.stringify(entries));
}

function weakCollections() {
  const privateData = new WeakMap();
  class Person {
    constructor(name, ssn) {
      this.name = name;
      privateData.set(this, { ssn });
    }
    maskedSsn() {
      return '***-' + privateData.get(this).ssn.slice(-4);
    }
  }
  const p = new Person('Kim', '123-45-6789');
  console.log('weakmap private', p.maskedSsn(), privateData.has(p), JSON.stringify(p));
  const visited = new WeakSet();
  const node = { v: 1 };
  node.self = node;
  function walk(o, depth) {
    if (visited.has(o)) return 'cycle@' + depth;
    visited.add(o);
    return walk(o.self, depth + 1);
  }
  console.log('weakset cycle', walk(node, 0));
  try {
    privateData.set('str', 1);
  } catch (e) {
    console.log('weakmap primitive key', e.constructor.name);
  }
  const cache = new WeakMap();
  function area(rect) {
    if (cache.has(rect)) return 'cached ' + cache.get(rect);
    const a = rect.w * rect.h;
    cache.set(rect, a);
    return 'computed ' + a;
  }
  const r = { w: 3, h: 7 };
  console.log(area(r), area(r), area({ w: 3, h: 7 }));
}

function jsonStringify() {
  const data = {
    name: 'Widget',
    price: 9.99,
    tags: ['a', 'b'],
    nested: { deep: { deeper: [1, { x: null }] } },
    skipFn() {},
    undef: undefined,
    sym: Symbol('s'),
    nan: NaN,
    inf: -Infinity,
    date: { toJSON() { return 'custom-toJSON'; } },
    secret: 'hide-me',
  };
  console.log(JSON.stringify(data));
  console.log(JSON.stringify(data, ['name', 'tags', 'nested', 'deep']));
  console.log(JSON.stringify(data, (k, v) => (k === 'secret' ? undefined : typeof v === 'number' ? Math.round(v) : v)));
  console.log(JSON.stringify({ a: [1, 2], b: { c: 3 } }, null, 2));
  console.log(JSON.stringify({ a: [1], b: 'x' }, null, '--'));
  console.log(JSON.stringify([undefined, function () {}, Symbol('q')]));
  console.log(JSON.stringify('he said "hi"\n'), JSON.stringify(null), JSON.stringify(undefined), JSON.stringify(42n === 42n));
  const replLog = [];
  JSON.stringify({ p: { q: 1 }, r: [2] }, function (k, v) {
    replLog.push((k === '' ? '<root>' : k) + ':' + (Array.isArray(this) ? 'arr' : typeof this));
    return v;
  });
  console.log('replacer visit order', replLog.join(' '));
  const circ = { name: 'c' };
  circ.me = circ;
  try {
    JSON.stringify(circ);
  } catch (e) {
    console.log('circular', e.constructor.name);
  }
  const m = new Map([['k1', { v: 1 }], ['k2', [1, 2]]]);
  const s = new Set([1, 2]);
  console.log('map/set naive', JSON.stringify({ m, s }));
  console.log('map/set replacer', JSON.stringify({ m, s }, (k, v) => (v instanceof Map ? { __map: [...v] } : v instanceof Set ? { __set: [...v] } : v)));
}

function jsonParse() {
  const text = '{"a":1,"b":[true,false,null],"c":{"d":"2024-01-02","e":"x"},"n":-1.5e2}';
  const obj = JSON.parse(text);
  console.log('parse', obj.a, obj.b.length, obj.c.d, obj.n);
  const order = [];
  const revived = JSON.parse(text, (k, v) => {
    order.push(k === '' ? '<root>' : k);
    if (typeof v === 'number') return v * 10;
    if (k === 'e') return undefined;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { dateParts: v.split('-').map(Number) };
    return v;
  });
  console.log('reviver order', order.join(','));
  console.log('revived', JSON.stringify(revived));
  const roundtrip = JSON.parse(
    JSON.stringify({ m: new Map([['z', 1]]) }, (k, v) => (v instanceof Map ? { __map: [...v] } : v)),
    (k, v) => (v && v.__map ? new Map(v.__map) : v)
  );
  console.log('map roundtrip', roundtrip.m instanceof Map, roundtrip.m.get('z'));
  ['{bad}', '[1,]', "{'a':1}", '', '01'].forEach((t) => {
    try {
      JSON.parse(t);
      console.log('parsed?!', t);
    } catch (e) {
      console.log('parse error for', JSON.stringify(t), e.constructor.name);
    }
  });
  console.log('primitives', JSON.parse('"s"'), JSON.parse('3'), JSON.parse('null'), JSON.parse(' [ ] ').length);
  console.log('unicode escape', JSON.parse('"\\u00e9\\n"').length);
}

function mapObjectConversion() {
  const obj = { x: 1, y: 2 };
  const m = new Map(Object.entries(obj));
  m.set('z', 3);
  console.log('obj->map->obj', JSON.stringify(Object.fromEntries(m)));
  const counts = new Map();
  for (const ch of 'mississippi') counts.set(ch, (counts.get(ch) ?? 0) + 1);
  console.log('char counts', [...counts].map(([k, v]) => k + v).join(''));
  const sortedByCount = new Map([...counts].sort((a, b) => b[1] - a[1]));
  console.log('sorted map', [...sortedByCount.keys()].join(''));
  const groupBy = (arr, f) => arr.reduce((mm, x) => mm.set(f(x), [...(mm.get(f(x)) || []), x]), new Map());
  const g = groupBy([1, 2, 3, 4, 5, 6, 7], (n) => (n % 3 === 0 ? 'fizz' : n % 2 ? 'odd' : 'even'));
  console.log('groupBy map', JSON.stringify([...g]));
}

mapBasics();
mapUsage();
setOps();
weakCollections();
jsonStringify();
jsonParse();
mapObjectConversion();
console.log('done a13');
