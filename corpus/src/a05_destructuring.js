// a05: destructuring

function basicArrays() {
  const [a, b, c] = [1, 2, 3];
  console.log('basic', a, b, c);
  const [, second, , fourth] = [10, 20, 30, 40, 50];
  console.log('holes', second, fourth);
  const [x = 'dx', y = 'dy', z = x + y] = [undefined, null];
  console.log('defaults', x, y, z);
  const [head, ...tail] = 'hello';
  console.log('string rest', head, tail.join(''));
  const [p, [q, [r, s = 'S']]] = [1, [2, [3]]];
  console.log('nested arr', p, q, r, s);
}

function basicObjects() {
  const obj = { name: 'widget', size: { w: 10, h: 20 }, tags: ['a', 'b'], meta: null };
  const { name, size: { w, h: height }, tags: [firstTag] } = obj;
  console.log('nested obj', name, w, height, firstTag);
  const { missing = 'default', meta = 'not used since null' } = obj;
  console.log('defaults', missing, meta);
  const { name: renamed = 'nope', color: c = 'blue' } = obj;
  console.log('rename+default', renamed, c);
  const { size, ...others } = obj;
  console.log('rest', JSON.stringify(size), Object.keys(others).join(','));
}

function swapping() {
  let a = 1;
  let b = 2;
  [a, b] = [b, a];
  console.log('swap', a, b);
  const arr = [1, 2, 3, 4, 5];
  [arr[0], arr[4]] = [arr[4], arr[0]];
  console.log('swap in array', arr.join(''));
  let x = 'x', y = 'y', z = 'z';
  [x, y, z] = [z, x, y];
  console.log('rotate', x, y, z);
  const o = {};
  ({ a: o.first, b: o.second } = { a: 'A', b: 'B' });
  console.log('assign to members', o.first, o.second);
}

function params({ id, label = 'L' + id, opts: { verbose = false, depth = 1 } = {} } = {}) {
  return 'id=' + id + ' label=' + label + ' verbose=' + verbose + ' depth=' + depth;
}

function arrayParams([first, second = first * 2, ...rest]) {
  return first + ',' + second + ' rest=' + rest.length;
}

function paramTests() {
  console.log(params({ id: 1 }));
  console.log(params({ id: 2, label: 'two', opts: { verbose: true } }));
  console.log(params({ id: 3, opts: { depth: 9 } }));
  console.log(params());
  console.log(arrayParams([5]));
  console.log(arrayParams([5, 6, 7, 8]));
  const points = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ];
  console.log('arrow param destr', points.map(({ x, y }) => x * y).join(','));
  const entries = Object.entries({ a: 1, b: 2 });
  console.log('entries destr', entries.map(([k, v]) => k + '=' + v).join('&'));
}

function computedKeys() {
  const key = 'dyn';
  const idx = 2;
  const { [key]: val, ['k' + idx]: val2, [`t${idx * 2}`]: val3 = 'def' } = { dyn: 'D', k2: 'K2' };
  console.log('computed destr', val, val2, val3);
  const fields = ['alpha', 'beta'];
  const src = { alpha: 1, beta: 2, gamma: 3 };
  const picked = fields.map((f) => {
    const { [f]: v } = src;
    return v;
  });
  console.log('picked', picked.join(','));
}

function loopDestructuring() {
  const users = [
    { id: 1, info: { first: 'Ann', langs: ['js', 'py'] } },
    { id: 2, info: { first: 'Bo', langs: ['go'] } },
    { id: 3, info: { first: 'Cy', langs: [] } },
  ];
  for (const { id, info: { first, langs: [main = 'none', ...others] } } of users) {
    console.log('user', id, first, main, others.length);
  }
  const m = new Map([
    ['one', 1],
    ['two', 2],
  ]);
  for (const [k, v] of m) console.log('map entry', k, v);
}

function iterableDestructuring() {
  function* gen() {
    let i = 0;
    while (true) yield i++;
  }
  const [a, b, , d] = gen();
  console.log('from generator', a, b, d);
  const [s1, s2] = new Set(['x', 'y', 'z']);
  console.log('from set', s1, s2);
  const log = [];
  const iterable = {
    [Symbol.iterator]() {
      let n = 0;
      return {
        next() {
          log.push('next' + n);
          return { value: n++, done: n > 5 };
        },
        return() {
          log.push('return');
          return { done: true };
        },
      };
    },
  };
  const [i1, i2] = iterable;
  console.log('iter close', i1, i2, log.join(','));
}

function defaultsEvaluation() {
  let calls = 0;
  const def = () => {
    calls++;
    return 'computed';
  };
  const { a = def(), b = def() } = { a: 'given' };
  console.log('lazy default', a, b, 'calls', calls);
  const [c = def(), d = def()] = [0, undefined];
  console.log('arr lazy default', c, d, 'calls', calls);
}

function returnMultiple() {
  function stats(nums) {
    const sum = nums.reduce((s, n) => s + n, 0);
    return { min: Math.min(...nums), max: Math.max(...nums), mean: sum / nums.length, sum };
  }
  const { min, max, mean } = stats([4, 8, 15, 16, 23, 42]);
  console.log('stats', min, max, mean.toFixed(3));
  function divmod(a, b) {
    return [Math.floor(a / b), a % b];
  }
  const [qq, rr] = divmod(47, 5);
  console.log('divmod', qq, rr);
}

function destructuringErrors() {
  try {
    const { a } = null;
    console.log(a);
  } catch (e) {
    console.log('null destr', e.constructor.name);
  }
  try {
    const [x] = {};
    console.log(x);
  } catch (e) {
    console.log('non-iterable destr', e.constructor.name);
  }
  const { length } = 'abcdef';
  console.log('primitive destr', length);
  const { toFixed } = 5;
  console.log('number method destr', typeof toFixed);
}

basicArrays();
basicObjects();
swapping();
paramTests();
computedKeys();
loopDestructuring();
iterableDestructuring();
defaultsEvaluation();
returnMultiple();
destructuringErrors();
console.log('done a05');
