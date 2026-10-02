// a02: closures & scope

function letPerIteration() {
  const fns = [];
  for (let i = 0; i < 4; i++) {
    fns.push(() => i * 10);
  }
  console.log('let loop', fns.map((f) => f()).join(','));
  const vfns = [];
  for (var j = 0; j < 4; j++) {
    vfns.push(function () {
      return j;
    });
  }
  console.log('var loop', vfns.map((f) => f()).join(','));
  const ofns = [];
  for (const k of ['a', 'b', 'c']) {
    ofns.push(() => k.toUpperCase());
  }
  console.log('for-of const', ofns.map((f) => f()).join(''));
  const ifns = [];
  for (const key in { p: 1, q: 2 }) {
    ifns.push(() => key + '!');
  }
  console.log('for-in const', ifns.map((f) => f()).join(' '));
}

function makeCounter(start, step) {
  let n = start;
  return {
    next() {
      n += step;
      return n;
    },
    reset() {
      n = start;
    },
    get current() {
      return n;
    },
  };
}

function counters() {
  const a = makeCounter(0, 1);
  const b = makeCounter(100, -5);
  a.next();
  a.next();
  b.next();
  console.log('counters', a.current, b.current, a.next(), b.next());
  a.reset();
  console.log('after reset', a.current, b.current);
}

function iifes() {
  const mod = (function () {
    let priv = 0;
    function bump() {
      priv += 3;
      return priv;
    }
    return { bump, peek: () => priv };
  })();
  mod.bump();
  mod.bump();
  console.log('module pattern', mod.peek());
  const r = ((x, y) => x * y)(6, 7);
  console.log('arrow iife', r);
  const v = !(function () {
    return false;
  })();
  console.log('bang iife', v);
  var outer = 'outer';
  (function () {
    var outer = 'inner';
    console.log('shadowed in iife', outer);
  })();
  console.log('outer untouched', outer);
}

function curry(fn) {
  return function curried(...args) {
    if (args.length >= fn.length) {
      return fn.apply(this, args);
    }
    return function (...more) {
      return curried.apply(this, args.concat(more));
    };
  };
}

function currying() {
  const add3 = curry((a, b, c) => a + b + c);
  console.log('curry', add3(1)(2)(3), add3(1, 2)(3), add3(1)(2, 3), add3(1, 2, 3));
  const mul = (a) => (b) => (c) => a * b * c;
  console.log('manual curry', mul(2)(3)(4));
  const partial = add3.bind(null, 10);
  console.log('bind partial', partial(20, 30));
}

function memoize(fn) {
  const cache = new Map();
  let hits = 0;
  const m = function (n) {
    if (cache.has(n)) {
      hits++;
      return cache.get(n);
    }
    const r = fn(n);
    cache.set(n, r);
    return r;
  };
  m.stats = () => 'size=' + cache.size + ' hits=' + hits;
  return m;
}

const fib = memoize(function (n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
});

function memoization() {
  console.log('fib(30)', fib(30));
  console.log('fib(50)', fib(50));
  console.log('memo', fib.stats());
}

function shadowing() {
  let x = 1;
  {
    let x = 2;
    {
      const x = 3;
      console.log('innermost x', x);
    }
    console.log('middle x', x);
  }
  console.log('outer x', x);
  function inner(x) {
    x = x + 100;
    return x;
  }
  console.log('param shadow', inner(5), x);
  const obj = { x: 'prop' };
  with_like(obj);
  function with_like(o) {
    const { x } = o;
    console.log('destructured shadow', x);
  }
}

function hoisting() {
  console.log('var before decl:', typeof hoistedVar, hoistedVar);
  var hoistedVar = 'now set';
  console.log('var after decl:', hoistedVar);
  console.log('fn before decl:', hoistedFn());
  function hoistedFn() {
    return 'hoisted function works';
  }
  console.log('fn expr before:', typeof notYet);
  var notYet = function () {
    return 1;
  };
  console.log('fn expr after:', typeof notYet);
  if (true) {
    var blockVar = 'escapes block';
  }
  console.log(blockVar);
}

function tdz() {
  try {
    console.log(early);
  } catch (e) {
    console.log('TDZ let:', e.name);
  }
  let early = 5;
  try {
    const f = () => constLater;
    f();
  } catch (e) {
    console.log('TDZ const via closure:', e.name);
  }
  const constLater = 1;
  console.log('after tdz', early, constLater);
  try {
    // eslint-disable-next-line no-undef
    undeclaredVariable;
  } catch (e) {
    console.log('undeclared:', e.name);
  }
  console.log('typeof undeclared', typeof someUndeclared);
}

function accumulators() {
  function makeAcc() {
    const items = [];
    return function add(x) {
      if (x === undefined) return items.slice();
      items.push(x);
      return add;
    };
  }
  const acc = makeAcc();
  acc(1)(2)(3);
  acc('four');
  console.log('acc', JSON.stringify(acc()));

  const adders = [1, 2, 3].map((n) => (m) => n + m);
  console.log('adders', adders.map((f) => f(10)).join(','));

  function once(fn) {
    let done = false;
    let result;
    return (...a) => {
      if (!done) {
        done = true;
        result = fn(...a);
      }
      return result;
    };
  }
  const init = once((v) => 'init:' + v);
  console.log(init('A'), init('B'), init('C'));
}

function closureOverLoopWithSetState() {
  const handlers = {};
  const names = ['alpha', 'beta', 'gamma'];
  for (let idx = 0; idx < names.length; idx++) {
    const name = names[idx];
    let clicks = 0;
    handlers[name] = () => {
      clicks += idx + 1;
      return name + ':' + clicks;
    };
  }
  console.log(handlers.alpha(), handlers.alpha(), handlers.beta(), handlers.gamma(), handlers.gamma());
}

function nestedScopes() {
  const level1 = 'L1';
  function a() {
    const level2 = 'L2';
    function b() {
      const level3 = 'L3';
      return function c() {
        return [level1, level2, level3].join('>');
      };
    }
    return b();
  }
  console.log('nested', a()());
}

letPerIteration();
counters();
iifes();
currying();
memoization();
shadowing();
hoisting();
tdz();
accumulators();
closureOverLoopWithSetState();
nestedScopes();
console.log('done a02');
