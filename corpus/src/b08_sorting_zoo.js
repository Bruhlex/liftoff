// Sorting algorithm zoo with comparison and swap counters
'use strict';

class Counter {
  #cmp = 0;
  #swp = 0;
  #writes = 0;
  constructor(name) { this.name = name; }
  compare(a, b) {
    this.#cmp++;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  swap(arr, i, j) {
    this.#swp++;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  write(arr, i, v) {
    this.#writes++;
    arr[i] = v;
  }
  get stats() { return { cmp: this.#cmp, swp: this.#swp, writes: this.#writes }; }
  toString() {
    const { cmp, swp, writes } = this.stats;
    return `${this.name.padEnd(10)} cmp=${String(cmp).padStart(4)} swp=${String(swp).padStart(4)} wr=${String(writes).padStart(4)}`;
  }
}

// deterministic LCG
function* lcg(seed) {
  let s = seed >>> 0;
  while (true) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    yield s;
  }
}

function makeData(n, seed, max = 1000) {
  const g = lcg(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(g.next().value % max);
  return out;
}

function isSorted(arr, cmp = (a, b) => a - b) {
  for (let i = 1; i < arr.length; i++) if (cmp(arr[i - 1], arr[i]) > 0) return false;
  return true;
}

function insertionSort(arr, c) {
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && c.compare(arr[j], v) > 0) {
      c.write(arr, j + 1, arr[j]);
      j--;
    }
    c.write(arr, j + 1, v);
  }
  return arr;
}

function quickSort(arr, c, lo = 0, hi = arr.length - 1) {
  if (lo >= hi) return arr;
  const mid = lo + ((hi - lo) >> 1);
  // median of three
  if (c.compare(arr[mid], arr[lo]) < 0) c.swap(arr, mid, lo);
  if (c.compare(arr[hi], arr[lo]) < 0) c.swap(arr, hi, lo);
  if (c.compare(arr[mid], arr[hi]) < 0) c.swap(arr, mid, hi);
  const pivot = arr[hi];
  let i = lo;
  for (let j = lo; j < hi; j++) {
    if (c.compare(arr[j], pivot) < 0) {
      c.swap(arr, i, j);
      i++;
    }
  }
  c.swap(arr, i, hi);
  quickSort(arr, c, lo, i - 1);
  quickSort(arr, c, i + 1, hi);
  return arr;
}

function mergeSort(arr, c) {
  if (arr.length <= 1) return arr;
  const mid = arr.length >>> 1;
  const left = mergeSort(arr.slice(0, mid), c);
  const right = mergeSort(arr.slice(mid), c);
  let i = 0, j = 0, k = 0;
  while (i < left.length && j < right.length) {
    if (c.compare(left[i], right[j]) <= 0) c.write(arr, k++, left[i++]);
    else c.write(arr, k++, right[j++]);
  }
  while (i < left.length) c.write(arr, k++, left[i++]);
  while (j < right.length) c.write(arr, k++, right[j++]);
  return arr;
}

function heapSort(arr, c) {
  const n = arr.length;
  function sift(start, end) {
    let root = start;
    for (;;) {
      const child = 2 * root + 1;
      if (child > end) break;
      let sw = root;
      if (c.compare(arr[sw], arr[child]) < 0) sw = child;
      if (child + 1 <= end && c.compare(arr[sw], arr[child + 1]) < 0) sw = child + 1;
      if (sw === root) return;
      c.swap(arr, root, sw);
      root = sw;
    }
  }
  for (let s = (n >> 1) - 1; s >= 0; s--) sift(s, n - 1);
  for (let end = n - 1; end > 0; end--) {
    c.swap(arr, 0, end);
    sift(0, end - 1);
  }
  return arr;
}

function countingSort(arr, c, max = Math.max(...arr)) {
  const counts = new Array(max + 1).fill(0);
  for (const v of arr) counts[v]++;
  let k = 0;
  counts.forEach((cnt, v) => {
    while (cnt-- > 0) c.write(arr, k++, v);
  });
  return arr;
}

function radixSort(arr, c, base = 10) {
  let max = 0;
  for (const v of arr) if (v > max) max = v;
  for (let exp = 1; Math.floor(max / exp) > 0; exp *= base) {
    const buckets = Array.from({ length: base }, () => []);
    for (const v of arr) buckets[Math.floor(v / exp) % base].push(v);
    let k = 0;
    for (const b of buckets) for (const v of b) c.write(arr, k++, v);
  }
  return arr;
}

function shellSort(arr, c) {
  const gaps = [];
  let h = 1;
  do {
    gaps.unshift(h);
    h = h * 3 + 1;
  } while (h < arr.length);
  for (const gap of gaps) {
    for (let i = gap; i < arr.length; i++) {
      const tmp = arr[i];
      let j = i;
      while (j >= gap && c.compare(arr[j - gap], tmp) > 0) {
        c.write(arr, j, arr[j - gap]);
        j -= gap;
      }
      c.write(arr, j, tmp);
    }
  }
  return arr;
}

function bubbleSort(arr, c) {
  let n = arr.length;
  let swapped;
  do {
    swapped = false;
    for (let i = 1; i < n; i++) {
      if (c.compare(arr[i - 1], arr[i]) > 0) {
        c.swap(arr, i - 1, i);
        swapped = true;
      }
    }
    n--;
  } while (swapped);
  return arr;
}

const ALGORITHMS = new Map([
  ['insertion', insertionSort],
  ['quick', quickSort],
  ['merge', mergeSort],
  ['heap', heapSort],
  ['counting', countingSort],
  ['radix', radixSort],
  ['shell', shellSort],
  ['bubble', bubbleSort],
]);

function checksum(arr) {
  let h = 0x811c9dc5;
  for (const v of arr) {
    h ^= v;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function runSuite(label, data) {
  console.log(`== suite ${label} (n=${data.length}) ==`);
  const expected = [...data].sort((a, b) => a - b);
  const expSum = checksum(expected);
  const table = [];
  for (const [name, fn] of ALGORITHMS) {
    const c = new Counter(name);
    const copy = data.slice();
    const out = fn(copy, c);
    const ok = isSorted(out) && checksum(out) === expSum;
    console.log(`${c} ${ok ? 'OK' : 'FAIL'}`);
    table.push({ name, ...c.stats, ok });
  }
  const best = table.filter((r) => r.cmp > 0).reduce((a, b) => (b.cmp < a.cmp ? b : a));
  console.log(`fewest comparisons: ${best.name} (${best.cmp})`);
  return table;
}

function stableSortDemo() {
  const people = [
    { name: 'ann', age: 30 }, { name: 'bob', age: 25 }, { name: 'cat', age: 30 },
    { name: 'dan', age: 25 }, { name: 'eve', age: 35 }, { name: 'fay', age: 30 },
  ];
  function mergeBy(list, key) {
    if (list.length < 2) return list;
    const m = list.length >> 1;
    const l = mergeBy(list.slice(0, m), key), r = mergeBy(list.slice(m), key);
    const res = [];
    while (l.length && r.length) res.push(key(l[0]) <= key(r[0]) ? l.shift() : r.shift());
    return [...res, ...l, ...r];
  }
  const sorted = mergeBy(people, (p) => p.age);
  console.log('stable by age: ' + sorted.map(({ name, age }) => `${name}:${age}`).join(' '));
  const byNameDesc = [...people].sort((a, b) => b.name.localeCompare(a.name));
  console.log('by name desc: ' + byNameDesc.map((p) => p.name).join(','));
}

function topK(arr, k) {
  // partial selection via heap of size k
  const heap = [];
  const c = new Counter('topk');
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c.compare(heap[p], heap[i]) <= 0) break;
      c.swap(heap, p, i);
      i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      let s = i;
      const l = 2 * i + 1, r = l + 1;
      if (l < heap.length && c.compare(heap[l], heap[s]) < 0) s = l;
      if (r < heap.length && c.compare(heap[r], heap[s]) < 0) s = r;
      if (s === i) break;
      c.swap(heap, i, s);
      i = s;
    }
  };
  for (const v of arr) {
    if (heap.length < k) { heap.push(v); up(heap.length - 1); }
    else if (v > heap[0]) { heap[0] = v; down(0); }
  }
  return { top: heap.sort((a, b) => b - a), stats: c.stats };
}

function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1, steps = 0;
  while (lo <= hi) {
    steps++;
    const mid = (lo + hi) >>> 1;
    if (arr[mid] === target) return { index: mid, steps };
    if (arr[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return { index: -1, steps, insertAt: lo };
}

function main() {
  const small = makeData(12, 7, 100);
  console.log('small input: ' + small.join(' '));
  const c = new Counter('demo');
  console.log('quick sorted: ' + quickSort(small.slice(), c).join(' '));
  console.log('demo stats: ' + JSON.stringify(c.stats));

  const results = {};
  results.random = runSuite('random', makeData(64, 42));
  results.sorted = runSuite('sorted', [...Array(40).keys()].map((i) => i * 3));
  results.reversed = runSuite('reversed', [...Array(40).keys()].map((i) => 200 - i * 5));
  results.dupes = runSuite('dupes', makeData(50, 3, 5));

  outer: for (const [suite, rows] of Object.entries(results)) {
    for (const r of rows) {
      if (!r.ok) {
        console.log(`suite ${suite} has failure in ${r.name}`);
        break outer;
      }
    }
    console.log(`suite ${suite}: all ok, total cmp=${rows.reduce((a, r) => a + r.cmp, 0)}`);
  }

  stableSortDemo();

  const big = makeData(200, 99, 10000);
  const { top, stats } = topK(big, 5);
  console.log(`top5: ${top.join(',')} cmp=${stats.cmp}`);

  const sortedBig = mergeSort(big.slice(), new Counter('m'));
  for (const t of [sortedBig[17], sortedBig[150], 5, 9999]) {
    const r = binarySearch(sortedBig, t);
    console.log(`search ${t}: idx=${r.index} steps=${r.steps}${r.insertAt !== undefined ? ' insertAt=' + r.insertAt : ''}`);
  }
  console.log('checksum big: ' + checksum(sortedBig));
}

main();
