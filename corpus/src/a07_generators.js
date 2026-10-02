// a07: generators & iterators

function* range(start, end, step = 1) {
  for (let i = start; i < end; i += step) yield i;
}

function* naturals() {
  let n = 1;
  while (true) yield n++;
}

function* take(iter, n) {
  if (n <= 0) return;
  let i = 0;
  for (const v of iter) {
    yield v;
    if (++i >= n) return;
  }
}

function* mapGen(iter, fn) {
  for (const v of iter) yield fn(v);
}

function* filterGen(iter, pred) {
  for (const v of iter) if (pred(v)) yield v;
}

function* primes() {
  const found = [];
  for (const n of naturals()) {
    if (n < 2) continue;
    if (found.every((p) => n % p !== 0)) {
      found.push(n);
      yield n;
    }
  }
}

function basics() {
  console.log('range', [...range(0, 10, 3)].join(','));
  console.log('take naturals', [...take(naturals(), 7)].join(','));
  const squaresOfOdd = mapGen(filterGen(naturals(), (x) => x % 2 === 1), (x) => x * x);
  console.log('lazy pipeline', [...take(squaresOfOdd, 6)].join(','));
  console.log('primes', [...take(primes(), 15)].join(' '));
  const g = range(0, 2);
  console.log('manual next', JSON.stringify(g.next()), JSON.stringify(g.next()), JSON.stringify(g.next()), JSON.stringify(g.next()));
}

function* inner() {
  const x = yield 'inner-1';
  console.log('  inner received', x);
  yield 'inner-2';
  return 'inner-result';
}

function* outer() {
  yield 'outer-start';
  const r = yield* inner();
  console.log('  yield* returned', r);
  yield* [10, 20];
  yield* 'ab';
  yield 'outer-end';
}

function delegation() {
  const g = outer();
  const out = [];
  let res = g.next();
  let i = 0;
  while (!res.done) {
    out.push(res.value);
    res = g.next('sent' + i++);
  }
  console.log('delegation', out.join(','));
}

function* twoWay() {
  let total = 0;
  while (true) {
    const v = yield total;
    if (v === undefined) break;
    total += v;
  }
  return 'final:' + total;
}

function sendValues() {
  const g = twoWay();
  g.next();
  console.log('send', g.next(5).value, g.next(10).value, g.next(-3).value);
  console.log('finish', JSON.stringify(g.next()));
}

function* withCleanup(label) {
  try {
    yield label + '1';
    yield label + '2';
    yield label + '3';
  } finally {
    console.log('  cleanup', label);
  }
}

function returnAndThrow() {
  const g = withCleanup('R');
  console.log('first', g.next().value);
  console.log('return()', JSON.stringify(g.return('early')));
  console.log('after return', JSON.stringify(g.next()));

  const g2 = withCleanup('B');
  for (const v of g2) {
    console.log('loop', v);
    if (v === 'B2') break;
  }

  function* catcher() {
    let errors = 0;
    while (true) {
      try {
        yield 'ready' + errors;
      } catch (e) {
        errors++;
        console.log('  caught inside gen:', e.message || e);
        if (errors >= 2) return 'gave up';
      }
    }
  }
  const c = catcher();
  console.log(c.next().value);
  console.log(JSON.stringify(c.throw(new Error('boom1'))));
  console.log(JSON.stringify(c.throw(new Error('boom2'))));
  try {
    c.throw(new Error('boom3'));
  } catch (e) {
    console.log('thrown out of finished gen', e.message);
  }

  const g3 = withCleanup('T');
  g3.next();
  try {
    g3.throw(new Error('uncaught in gen'));
  } catch (e) {
    console.log('propagated', e.message);
  }
}

class Matrix {
  constructor(rows) {
    this.rows = rows;
  }
  *[Symbol.iterator]() {
    for (const row of this.rows) yield* row;
  }
  *rowsIter() {
    for (let i = 0; i < this.rows.length; i++) yield [i, this.rows[i]];
  }
}

class Countdown {
  constructor(from) {
    this.from = from;
  }
  [Symbol.iterator]() {
    let cur = this.from;
    return {
      next: () => (cur >= 0 ? { value: cur--, done: false } : { value: undefined, done: true }),
      [Symbol.iterator]() {
        return this;
      },
    };
  }
}

function customIterables() {
  const m = new Matrix([
    [1, 2, 3],
    [4, 5],
    [6],
  ]);
  console.log('matrix flat', [...m].join(','));
  for (const [i, row] of m.rowsIter()) console.log('row', i, row.length);
  console.log('countdown', [...new Countdown(5)].join(' '));
  const [a, b] = new Countdown(9);
  console.log('destructure countdown', a, b);
  console.log('Array.from countdown', Array.from(new Countdown(3), (x) => x * x).join(','));
  const it = new Countdown(2)[Symbol.iterator]();
  console.log('manual', it.next().value, it.next().value, it.next().value, it.next().done);
}

function* fibGen() {
  let [a, b] = [0n, 1n];
  while (true) {
    yield a;
    [a, b] = [b, a + b];
  }
}

function* zip(...iters) {
  const its = iters.map((i) => i[Symbol.iterator]());
  while (true) {
    const rs = its.map((i) => i.next());
    if (rs.some((r) => r.done)) return;
    yield rs.map((r) => r.value);
  }
}

function* chunk(iter, size) {
  let buf = [];
  for (const v of iter) {
    buf.push(v);
    if (buf.length === size) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}

function combinators() {
  const fibs = [...take(fibGen(), 90)];
  console.log('fib bigint 89', fibs[89].toString());
  console.log('zip', JSON.stringify([...zip('abc', range(0, 10), [true, false, null, 1])]));
  console.log('chunk', JSON.stringify([...chunk(range(0, 11), 4)]));
  const entries = Object.entries({ x: 1, y: 2, z: 3 });
  const gen = (function* () {
    for (const [k, v] of entries) yield k.repeat(v);
  })();
  console.log('gen expr', [...gen].join('-'));
}

function generatorObjects() {
  const g = range(0, 3);
  console.log('typeof', typeof g, typeof g.next, typeof g[Symbol.iterator]);
  console.log('self iter', g[Symbol.iterator]() === g);
  console.log('toString tag', Object.prototype.toString.call(g));
  const GenFn = Object.getPrototypeOf(function* () {}).constructor;
  console.log('GeneratorFunction name', GenFn.name);
  const obj = {
    *items() {
      yield 'm1';
      yield 'm2';
    },
  };
  console.log('method gen', [...obj.items()].join(''));
  const iter = [1, 2, 3][Symbol.iterator]();
  iter.next();
  console.log('array iterator rest', [...iter].join(','));
  const mapIter = new Map([['k', 'v']]).entries();
  console.log('map iterator', JSON.stringify(mapIter.next()));
}

basics();
delegation();
sendValues();
returnAndThrow();
customIterables();
combinators();
generatorObjects();
console.log('done a07');
