// a12: arrays & higher-order functions

const people = [
  { name: 'Ann', age: 31, dept: 'eng', salary: 120 },
  { name: 'Bob', age: 25, dept: 'ops', salary: 80 },
  { name: 'Cid', age: 45, dept: 'eng', salary: 150 },
  { name: 'Dee', age: 25, dept: 'hr', salary: 70 },
  { name: 'Eve', age: 38, dept: 'ops', salary: 95 },
  { name: 'Fay', age: 29, dept: 'eng', salary: 110 },
];

function basicsHOF() {
  const nums = [5, 3, 8, 1, 9, 2];
  console.log('map', nums.map((n, i) => n * i).join(','));
  console.log('filter', nums.filter((n) => n % 2).join(','));
  console.log('reduce', nums.reduce((a, b) => a + b), nums.reduce((acc, n) => acc + n, 100));
  console.log('reduceRight', ['a', 'b', 'c'].reduceRight((acc, s) => acc + s, ''));
  console.log('find', nums.find((n) => n > 5), nums.findIndex((n) => n > 5), nums.find((n) => n > 100));
  console.log('findLast', nums.findLast((n) => n < 5), nums.findLastIndex((n) => n < 5));
  console.log('every/some', nums.every((n) => n > 0), nums.some((n) => n > 8), [].every(() => false), [].some(() => true));
  console.log('at', nums.at(0), nums.at(-1), nums.at(-3), nums.at(100));
  console.log('includes/indexOf', nums.includes(8), nums.indexOf(9), nums.lastIndexOf(42));
}

function flatten() {
  const nested = [1, [2, [3, [4, [5]]]], 6];
  console.log('flat()', JSON.stringify(nested.flat()));
  console.log('flat(2)', JSON.stringify(nested.flat(2)));
  console.log('flat(Inf)', JSON.stringify(nested.flat(Infinity)));
  const sentences = ['hello world', 'foo bar baz'];
  console.log('flatMap', JSON.stringify(sentences.flatMap((s) => s.split(' '))));
  console.log('flatMap filter', [1, 2, 3, 4].flatMap((n) => (n % 2 ? [n, n * 10] : [])).join(','));
}

function sorting() {
  const nums = [10, 1, 5, 100, 25, -3];
  console.log('default sort (string)', [...nums].sort().join(','));
  console.log('numeric asc', [...nums].sort((a, b) => a - b).join(','));
  console.log('numeric desc', [...nums].sort((a, b) => b - a).join(','));
  const byAgeThenName = [...people].sort((a, b) => a.age - b.age || a.name.localeCompare(b.name));
  console.log('multi-key', byAgeThenName.map((p) => p.name + p.age).join(' '));
  const stable = [...people].sort((a, b) => (a.dept < b.dept ? -1 : a.dept > b.dept ? 1 : 0));
  console.log('stable by dept', stable.map((p) => p.dept + ':' + p.name).join(' '));
  console.log('toSorted exists', typeof [].toSorted === 'function' ? [3, 1, 2].toSorted().join('') : '123');
  const words = ['banana', 'Apple', 'cherry', 'apple'];
  console.log('case-insens', [...words].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0).join(','));
  console.log('reverse', [1, 2, 3].reverse().join(''));
}

function grouping() {
  const byDept = people.reduce((acc, p) => {
    (acc[p.dept] = acc[p.dept] || []).push(p.name);
    return acc;
  }, {});
  console.log('group', JSON.stringify(byDept));
  const stats = Object.entries(
    people.reduce((acc, p) => {
      const s = (acc[p.dept] ||= { n: 0, total: 0, max: -Infinity });
      s.n++;
      s.total += p.salary;
      s.max = Math.max(s.max, p.salary);
      return acc;
    }, {})
  ).map(([d, s]) => d + ':avg=' + (s.total / s.n).toFixed(1) + ',max=' + s.max);
  console.log('stats', stats.join(' | '));
  const oldestPerDept = people.reduce((m, p) => (!m[p.dept] || m[p.dept].age < p.age ? { ...m, [p.dept]: p } : m), {});
  console.log('oldest', Object.values(oldestPerDept).map((p) => p.name).join(','));
}

function sparseArrays() {
  const sp = [1, , 3, , 5];
  console.log('sparse length', sp.length, 1 in sp, sp[1]);
  console.log('forEach skips holes', (() => {
    let c = 0;
    sp.forEach(() => c++);
    return c;
  })());
  console.log('map keeps holes', JSON.stringify(sp.map((x) => x * 2)), sp.map((x) => x * 2).length);
  console.log('for-of visits holes', [...sp].map(String).join(','));
  const big = [];
  big[5] = 'five';
  console.log('assign far index', big.length, Object.keys(big).join(','));
  big.length = 2;
  console.log('truncate', big.length, JSON.stringify(big));
  const filled = new Array(3).fill(0);
  console.log('fill', filled.join(','), new Array(3).join('-'), Array(3).length, Array.of(3).length);
  console.log('join holes', [1, , null, undefined, 2].join('|'));
}

function arrayFrom() {
  console.log('from length', Array.from({ length: 5 }, (_, i) => i * i).join(','));
  console.log('from string', Array.from('abc', (c) => c.charCodeAt(0)).join(','));
  console.log('from set', Array.from(new Set([1, 1, 2, 3, 3])).join(','));
  console.log('from map', JSON.stringify(Array.from(new Map([['a', 1]]))));
  const matrix = Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => r * 3 + c));
  console.log('matrix', JSON.stringify(matrix));
  const transposed = matrix[0].map((_, c) => matrix.map((row) => row[c]));
  console.log('transpose', JSON.stringify(transposed));
  console.log('keys/entries', [...['x', 'y'].keys()].join(','), JSON.stringify([...['x', 'y'].entries()]));
}

function mutation() {
  const a = [1, 2, 3, 4, 5];
  console.log('splice remove', JSON.stringify(a.splice(1, 2)), JSON.stringify(a));
  console.log('splice insert', JSON.stringify(a.splice(1, 0, 'x', 'y')), JSON.stringify(a));
  console.log('push/pop/shift/unshift', a.push(9), a.pop(), a.shift(), a.unshift('s'), JSON.stringify(a));
  console.log('slice', JSON.stringify(a.slice(1, 3)), JSON.stringify(a.slice(-2)));
  console.log('concat', JSON.stringify([1].concat(2, [3, [4]])));
  console.log('copyWithin', JSON.stringify([1, 2, 3, 4, 5].copyWithin(0, 3)));
  console.log('fill range', JSON.stringify([0, 0, 0, 0].fill(7, 1, 3)));
}

function typedArrays() {
  const u8 = new Uint8Array([250, 5, 300, -1]);
  console.log('Uint8Array wrap', Array.from(u8).join(','));
  const clamped = new Uint8ClampedArray([300, -5, 12.5, 13.5]);
  console.log('clamped', Array.from(clamped).join(','));
  const i16 = new Int16Array(4);
  i16[0] = 40000;
  i16[1] = -40000;
  console.log('Int16', Array.from(i16).join(','));
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, 0xdeadbeef);
  view.setFloat32(4, 1.5, true);
  const bytes = new Uint8Array(buf);
  console.log('DataView bytes', Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  console.log('getUint16 LE/BE', view.getUint16(0, true).toString(16), view.getUint16(0).toString(16));
  const f64 = new Float64Array([1.1, 2.2, 3.3]);
  console.log('Float64 map/reduce', f64.map((x) => x * 2).reduce((a, b) => a + b).toFixed(2));
  const sub = bytes.subarray(2, 6);
  sub[0] = 0;
  console.log('subarray shares', bytes[2], sub.length, bytes.byteLength);
  const sorted = new Int32Array([5, -2, 10, 1]).sort();
  console.log('typed sort numeric', Array.from(sorted).join(','));
}

function pipeline() {
  const compose = (...fns) => (x) => fns.reduceRight((v, f) => f(v), x);
  const pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);
  const inc = (x) => x + 1;
  const dbl = (x) => x * 2;
  const sq = (x) => x * x;
  console.log('compose', compose(inc, dbl, sq)(3), 'pipe', pipe(inc, dbl, sq)(3));
  const result = people
    .filter((p) => p.age < 40)
    .map((p) => ({ ...p, bonus: p.salary * 0.1 }))
    .sort((a, b) => b.bonus - a.bonus)
    .slice(0, 3)
    .map((p) => p.name + '=' + p.bonus.toFixed(1));
  console.log('pipeline', result.join(', '));
  const uniqBy = (arr, fn) => [...new Map(arr.map((x) => [fn(x), x])).values()];
  console.log('uniqBy age', uniqBy(people, (p) => p.age).map((p) => p.name).join(','));
  const zipped = ['a', 'b', 'c'].map((k, i) => [k, [1, 2, 3][i]]);
  console.log('zip', JSON.stringify(zipped));
  const range = (n) => [...Array(n).keys()];
  console.log('sum of squares', range(11).map(sq).reduce((a, b) => a + b));
}

basicsHOF();
flatten();
sorting();
grouping();
sparseArrays();
arrayFrom();
mutation();
typedArrays();
pipeline();
console.log('done a12');
