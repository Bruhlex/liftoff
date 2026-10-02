// LRU cache (doubly linked list + Map), memoization helpers, fibonacci, prime sieve,
// and cache statistics.
'use strict';

class Node {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

class LRUCache {
  #map = new Map();
  #head = new Node(null, null);
  #tail = new Node(null, null);
  #capacity;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  onEvict = null;

  constructor(capacity = 4) {
    if (capacity < 1) throw new RangeError('capacity must be >= 1');
    this.#capacity = capacity;
    this.#head.next = this.#tail;
    this.#tail.prev = this.#head;
  }

  get size() {
    return this.#map.size;
  }
  get capacity() {
    return this.#capacity;
  }
  set capacity(c) {
    this.#capacity = c;
    while (this.#map.size > c) this.#evict();
  }
  get stats() {
    const total = this.#hits + this.#misses;
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      ratio: total ? Math.round((this.#hits / total) * 1000) / 10 : 0,
    };
  }

  #unlink(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }
  #pushFront(node) {
    node.next = this.#head.next;
    node.prev = this.#head;
    this.#head.next.prev = node;
    this.#head.next = node;
  }
  #evict() {
    const lru = this.#tail.prev;
    if (lru === this.#head) return;
    this.#unlink(lru);
    this.#map.delete(lru.key);
    this.#evictions++;
    this.onEvict?.(lru.key, lru.value);
  }

  has(key) {
    return this.#map.has(key);
  }
  get(key) {
    const node = this.#map.get(key);
    if (!node) {
      this.#misses++;
      return undefined;
    }
    this.#hits++;
    this.#unlink(node);
    this.#pushFront(node);
    return node.value;
  }
  peek(key) {
    return this.#map.get(key)?.value;
  }
  set(key, value) {
    let node = this.#map.get(key);
    if (node) {
      node.value = value;
      this.#unlink(node);
    } else {
      node = new Node(key, value);
      this.#map.set(key, node);
      if (this.#map.size > this.#capacity) this.#evict();
    }
    this.#pushFront(node);
    return this;
  }
  delete(key) {
    const node = this.#map.get(key);
    if (!node) return false;
    this.#unlink(node);
    this.#map.delete(key);
    return true;
  }
  *keys() {
    for (let n = this.#head.next; n !== this.#tail; n = n.next) yield n.key;
  }
  *entries() {
    for (let n = this.#head.next; n !== this.#tail; n = n.next) yield [n.key, n.value];
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  toString() {
    return `LRU(${this.size}/${this.#capacity})[${[...this.keys()].join(' ')}]`;
  }
}

const counters = new Map();
function count(name, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

function memoize(fn, { cache = new Map(), key = (...args) => args.join('|'), name = fn.name } = {}) {
  const wrapped = function (...args) {
    const k = key(...args);
    const cached = cache.get(k);
    if (cached !== undefined) {
      count(`${name}.hit`);
      return cached;
    }
    count(`${name}.miss`);
    const result = fn.apply(this, args);
    cache.set(k, result);
    return result;
  };
  wrapped.cache = cache;
  return wrapped;
}

function fibNaive(n) {
  count('fibNaive.call');
  return n < 2 ? n : fibNaive(n - 1) + fibNaive(n - 2);
}

const fibMemo = memoize(
  function fibRaw(n) {
    return n < 2 ? BigInt(n) : fibMemo(n - 1) + fibMemo(n - 2);
  },
  { name: 'fibMemo' }
);

function fibIter(n) {
  let [a, b] = [0n, 1n];
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

function* fibGen(limit) {
  let a = 0, b = 1;
  while (a <= limit) {
    yield a;
    [a, b] = [b, a + b];
  }
}

function sieve(limit) {
  const isComposite = new Uint8Array(limit + 1);
  const primes = [];
  for (let i = 2; i <= limit; i++) {
    if (isComposite[i]) continue;
    primes.push(i);
    for (let j = i * i; j <= limit; j += i) isComposite[j] = 1;
  }
  count('sieve.run');
  return primes;
}

const primeCache = new LRUCache(3);
primeCache.onEvict = (k) => count('primeCache.evict') || console.log(`    (evicted sieve ${k})`);
const primesUpTo = memoize(sieve, { cache: primeCache, name: 'sieve' });

function isPrime(n) {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}

function factorize(n) {
  const out = new Map();
  let d = 2;
  while (n > 1) {
    while (n % d === 0) {
      out.set(d, (out.get(d) ?? 0) + 1);
      n /= d;
    }
    d = d === 2 ? 3 : d + 2;
    if (d * d > n && n > 1) {
      out.set(n, (out.get(n) ?? 0) + 1);
      break;
    }
  }
  return out;
}

function formatFactors(m) {
  return [...m].map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(' * ');
}

function collatzLength(n, cache) {
  const path = [];
  while (n !== 1 && !cache.has(n)) {
    path.push(n);
    n = n % 2 === 0 ? n / 2 : 3 * n + 1;
  }
  let len = n === 1 ? 1 : cache.peek(n);
  if (n !== 1) cache.get(n);
  for (let i = path.length - 1; i >= 0; i--) {
    len++;
    cache.set(path[i], len);
  }
  return len;
}

function lruDemo() {
  const cache = new LRUCache(3);
  const evicted = [];
  cache.onEvict = (k, v) => evicted.push(`${k}=${v}`);
  const ops = [
    ['set', 'a', 1], ['set', 'b', 2], ['set', 'c', 3], ['get', 'a'], ['set', 'd', 4],
    ['get', 'b'], ['get', 'c'], ['set', 'e', 5], ['peek', 'a'], ['del', 'd'], ['set', 'f', 6], ['get', 'z'],
  ];
  for (const [op, k, v] of ops) {
    let res;
    switch (op) {
      case 'set': cache.set(k, v); res = 'ok'; break;
      case 'get': res = cache.get(k); break;
      case 'peek': res = cache.peek(k); break;
      case 'del': res = cache.delete(k); break;
    }
    console.log(`  ${op}(${k}${v !== undefined ? ',' + v : ''}) -> ${res ?? 'undefined'}  ${cache}`);
  }
  console.log('  evicted:', evicted.join(', '));
  console.log('  stats:', JSON.stringify(cache.stats));
  cache.capacity = 1;
  console.log('  after shrink:', String(cache), 'evicted now', evicted.length);
  try {
    new LRUCache(0);
  } catch (e) {
    console.log('  error:', e.name, e.message);
  }
}

function main() {
  console.log('LRU demo');
  lruDemo();

  console.log('Fibonacci');
  console.log('  naive fib(20) =', fibNaive(20), 'calls', counters.get('fibNaive.call'));
  console.log('  memo  fib(90) =', String(fibMemo(90)));
  console.log('  iter  fib(90) =', String(fibIter(90)));
  console.log('  memo  fib(95) =', String(fibMemo(95)), `(hits ${counters.get('fibMemo.hit')}, misses ${counters.get('fibMemo.miss')})`);
  console.log('  fib <= 1000:', [...fibGen(1000)].join(' '));
  console.log('  fib(200) digits:', fibIter(200).toString().length);

  console.log('Primes');
  for (const lim of [30, 100, 30, 50, 1000, 100, 30]) {
    const ps = primesUpTo(lim);
    console.log(`  primes<=${lim}: count=${ps.length} last=${ps.at(-1)} ${String(primeCache)}`);
  }
  console.log('  first 15:', primesUpTo(1000).slice(0, 15).join(','));
  const twins = [];
  const ps = primesUpTo(1000);
  for (let i = 1; i < ps.length && twins.length < 8; i++) if (ps[i] - ps[i - 1] === 2) twins.push(`(${ps[i - 1]},${ps[i]})`);
  console.log('  twin primes:', twins.join(' '));
  console.log('  isPrime check agrees:', ps.every(isPrime) && ps.length === Array.from({ length: 1001 }, (_, i) => i).filter(isPrime).length);

  for (const n of [360, 97, 1001, 65536, 123456, 999983 * 2]) {
    console.log(`  ${n} = ${formatFactors(factorize(n))}`);
  }

  console.log('Collatz with LRU');
  const cc = new LRUCache(64);
  let best = { n: 0, len: 0 };
  for (let n = 1; n <= 300; n++) {
    const len = collatzLength(n, cc);
    if (len > best.len) best = { n, len };
  }
  console.log(`  longest under 300: n=${best.n} len=${best.len}`);
  console.log('  collatz cache:', JSON.stringify(cc.stats), 'size', cc.size);

  const memoPow = memoize((b, e) => b ** e, { key: (b, e) => `${b}^${e}`, name: 'pow' });
  const powResults = [];
  for (const [b, e] of [[2, 10], [3, 4], [2, 10], [5, 3], [3, 4], [2n, 64n]]) powResults.push(String(memoPow(b, e)));
  console.log('  pow results:', powResults.join(' '), 'cache keys:', [...memoPow.cache.keys()].join(','));

  console.log('Counters');
  const sorted = [...counters].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [k, v] of sorted) console.log(`  ${k.padEnd(20, '.')} ${v}`);
}

main();
