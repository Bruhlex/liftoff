// a06: spread/rest/arguments, call/apply/bind, this binding

function argsInfo() {
  const arr = Array.prototype.slice.call(arguments);
  return 'len=' + arguments.length + ' args=' + JSON.stringify(arr) + ' isArray=' + Array.isArray(arguments);
}

function argsMutation(a, b) {
  arguments[0] = 'changed';
  return a + ',' + b + ',' + arguments.length;
}

function argsStrict(a) {
  'use strict';
  arguments[0] = 'changed';
  return a;
}

function fnLengths() {
  function f0() {}
  function f2(a, b) {}
  function fDef(a, b = 1, c) {}
  function fRest(a, ...r) {}
  const arrow = (x, y, z) => x;
  function fDestr({ a }, [b]) {}
  console.log('fn.length', f0.length, f2.length, fDef.length, fRest.length, arrow.length, fDestr.length);
  console.log('fn.name', f2.name, arrow.name, (function () {}).name === '' ? 'anon' : 'named', fDef.bind(null).name);
}

function sum(...nums) {
  return nums.reduce((a, b) => a + b, 0);
}

function spreadTests() {
  const a = [1, 2, 3];
  const b = [4, 5];
  console.log('spread call', sum(...a, ...b, 100));
  console.log('spread array', JSON.stringify([0, ...a, ...b, 6]));
  console.log('spread string', [...'héllo'].join('|'));
  console.log('spread set', [...new Set([3, 1, 3, 2, 1])].join(','));
  console.log('Math.max spread', Math.max(...a, ...b));
  const o1 = { x: 1, y: 2 };
  const o2 = { y: 20, z: 30 };
  console.log('spread obj', JSON.stringify({ ...o1, ...o2, w: 0 }));
  console.log('spread override order', JSON.stringify({ y: 'first', ...o1 }));
  const copy = [...a];
  copy.push(4);
  console.log('copy independent', a.length, copy.length);
  console.log('spread null obj', JSON.stringify({ ...null, ...undefined, ...'ab' }));
}

function restParams(first, ...rest) {
  return first + ' + [' + rest.join(',') + '] (' + rest.length + ')';
}

const person = {
  name: 'Ada',
  greet(greeting, punct) {
    return greeting + ', ' + this.name + (punct || '.');
  },
  arrowGreet: () => typeof this,
  delayedArrow() {
    const inner = () => this.name + ' via arrow';
    return inner();
  },
  delayedFunction() {
    const self = this;
    function inner() {
      return (this === undefined || this === globalThisRef() ? 'global/undefined' : 'other') + ' / self=' + self.name;
    }
    return inner();
  },
};

function globalThisRef() {
  return typeof globalThis !== 'undefined' ? globalThis : undefined;
}

function callApplyBind() {
  const other = { name: 'Grace' };
  console.log('call', person.greet.call(other, 'Hi', '!'));
  console.log('apply', person.greet.apply(other, ['Hello']));
  const bound = person.greet.bind(other, 'Hey');
  console.log('bind', bound('?'));
  const rebound = bound.bind({ name: 'Nope' });
  console.log('bind twice keeps first', rebound('!!'));
  console.log('bound name/length', bound.name, bound.length);
  console.log('method', person.greet('Yo'));
  const detached = person.greet;
  try {
    const r = detached('Detached');
    console.log('detached', r.indexOf('Detached') === 0);
  } catch (e) {
    console.log('detached threw', e.constructor.name);
  }
  console.log('arrow this', person.delayedArrow());
  console.log('inner fn this', person.delayedFunction());
  console.log('arrow on obj literal: typeof this', person.arrowGreet());
}

function strictThis() {
  'use strict';
  function whoAmI() {
    return this === undefined ? 'undefined' : typeof this;
  }
  console.log('strict plain call', whoAmI());
  console.log('strict call(5)', whoAmI.call(5));
  console.log('strict call(null)', whoAmI.call(null) === 'undefined' ? 'undef' : 'null-ish:' + whoAmI.call(null));
  function sloppy() {
    return typeof this;
  }
  console.log('sloppy call(5)', sloppy.call(5));
}

class Timer {
  constructor(label) {
    this.label = label;
    this.ticks = 0;
  }
  runCallbacks(fns) {
    fns.forEach(function (fn) {
      fn.call(this);
    }, this);
    [1, 2].forEach(() => {
      this.ticks += 10;
    });
    return this.label + ':' + this.ticks;
  }
}

function thisInCallbacks() {
  const t = new Timer('T');
  const out = t.runCallbacks([
    function () {
      this.ticks++;
    },
    function () {
      this.ticks += 2;
    },
  ]);
  console.log('callbacks this', out);
  const mapped = [1, 2, 3].map(function (x) {
    return x * this.factor;
  }, { factor: 7 });
  console.log('map thisArg', mapped.join(','));
}

function constructorThis() {
  function Point(x, y) {
    this.x = x;
    this.y = y;
    return undefined;
  }
  function Weird() {
    this.a = 1;
    return { b: 2 };
  }
  function Prim() {
    this.c = 3;
    return 42;
  }
  console.log('ctor', JSON.stringify(new Point(1, 2)), JSON.stringify(new Weird()), JSON.stringify(new Prim()));
  const BoundPoint = Point.bind(null, 100);
  const bp = new BoundPoint(200);
  console.log('new bound', bp.x, bp.y, bp instanceof Point);
}

function applyWithArrayLike() {
  const arrayLike = { 0: 'a', 1: 'b', 2: 'c', length: 3 };
  console.log('apply arraylike', argsInfo.apply(null, arrayLike));
  console.log('Array.from arraylike', Array.from(arrayLike).reverse().join(''));
  console.log('concat via apply', Array.prototype.concat.apply([], [[1], [2, 3], 4]).join(','));
  const max = Function.prototype.apply.call(Math.max, null, [3, 9, 2]);
  console.log('apply.call', max);
}

function argumentsCallee() {
  const fact = function (n) {
    return n <= 1 ? 1 : n * arguments.callee(n - 1);
  };
  console.log('arguments.callee fact(6)', fact(6));
  function outer() {
    const arrow = () => arguments.length + ':' + arguments[0];
    return arrow('ignored');
  }
  console.log('arrow sees outer arguments', outer('X', 'Y'));
}

console.log(argsInfo());
console.log(argsInfo(1, 'two', null, undefined));
console.log('mutation sloppy', argsMutation(1, 2), argsMutation(1));
console.log('strict arguments', argsStrict('orig'));
fnLengths();
spreadTests();
console.log(restParams(1, 2, 3, 4));
console.log(restParams('solo'));
callApplyBind();
strictThis();
thisInCallbacks();
constructorThis();
applyWithArrayLike();
argumentsCallee();
console.log('done a06');
