// a17: typeof/void/delete/instanceof/in, equality tables, truthiness, conversions

function describe(v) {
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'bigint') return v + 'n';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return 'fn';
  if (Array.isArray(v)) return '[' + v.map(describe).join(',') + ']';
  if (v && typeof v === 'object') return '{obj}';
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

function typeofTable() {
  const vals = [undefined, null, true, 0, NaN, '', 'x', 1n, Symbol('s'), {}, [], function () {}, () => {}, class {}, new Number(1), new String('s'), /re/];
  console.log('typeof', vals.map((v) => describe(v) + ':' + typeof v).join(' '));
  console.log('typeof undeclared', typeof notDeclaredAnywhere);
  console.log('Object.prototype.toString', vals.map((v) => Object.prototype.toString.call(v).slice(8, -1)).join(','));
}

function voidOp() {
  let x = 1;
  const r = void x++;
  console.log('void', r, x, void 0 === undefined, typeof void 'anything');
  const noop = () => void console.log('  side effect inside void arrow');
  console.log('void arrow returns', noop());
}

function deleteOp() {
  const o = { a: 1, b: { c: 2 } };
  console.log('delete prop', delete o.a, 'a' in o);
  console.log('delete nested', delete o.b.c, JSON.stringify(o));
  console.log('delete missing', delete o.zz);
  var v = 1;
  console.log('delete non-prop value', delete o[Symbol.iterator]);
  const frozen = Object.freeze({ k: 1 });
  console.log('delete frozen (sloppy)', delete frozen.k, frozen.k);
  const arr = [1, 2, 3];
  console.log('delete arr', delete arr[0], arr.length, arr[0], 0 in arr);
  console.log('delete literal', delete 42, v);
}

function instanceofAndIn() {
  class A {}
  class B extends A {}
  const b = new B();
  console.log('instanceof', b instanceof B, b instanceof A, b instanceof Object, [] instanceof Array, [] instanceof Object);
  console.log('primitives', 'str' instanceof String, new String('s') instanceof String, 5 instanceof Number, null instanceof Object);
  const Even = {
    [Symbol.hasInstance](n) {
      return typeof n === 'number' && n % 2 === 0;
    },
  };
  console.log('hasInstance', 4 instanceof Even, 5 instanceof Even);
  const nullProto = Object.create(null);
  console.log('null proto instanceof Object', nullProto instanceof Object);
  console.log('in', 'length' in [], 0 in [5], 1 in [5], 'x' in { x: undefined }, 'toString' in {}, 'constructor' in nullProto);
  try {
    console.log('x' in 'string');
  } catch (e) {
    console.log('in on primitive', e.constructor.name);
  }
}

function equalityTable() {
  const vals = [0, -0, 1, '', '0', '1', ' ', 'a', true, false, null, undefined, NaN, [], [0], [1], {}, Infinity];
  const header = vals.map(describe);
  console.log('== table (rows vs cols)');
  console.log('      ' + header.map((h) => h.slice(0, 4).padEnd(5)).join(''));
  vals.forEach((a, i) => {
    let row = header[i].slice(0, 5).padEnd(6);
    vals.forEach((b) => {
      row += (a == b ? 'T' : '.').padEnd(5);
    });
    console.log(row);
  });
  let strictSame = 0, looseSame = 0, objIsSame = 0;
  for (const a of vals) for (const b of vals) {
    if (a === b) strictSame++;
    if (a == b) looseSame++;
    if (Object.is(a, b)) objIsSame++;
  }
  console.log('counts === / == / Object.is', strictSame, looseSame, objIsSame);
  console.log('famous', null == 0, null >= 0, undefined == null, NaN != NaN, [] == ![], '' == 0, '0' == false, [1, 2] == '1,2');
}

function truthiness() {
  const vals = [0, -0, 0n, '', ' ', '0', 'false', null, undefined, NaN, [], {}, function () {}, Infinity, -1, new Boolean(false)];
  console.log('truthy', vals.map((v) => describe(v) + '=' + (v ? 'T' : 'F')).join(' '));
  console.log('!!', !!'', !!'x', !!0, !!{}, !![], !!null);
  console.log('Boolean()', Boolean(0), Boolean('0'), Boolean(NaN), Boolean(Symbol()));
  console.log('&& || values', 0 && 'x', 1 && 'x', '' || 'fallback', 'set' || 'fallback', null || undefined, undefined && 1);
}

function implicitConversions() {
  console.log('+ string', 1 + '2', '3' + 4 + 5, 3 + 4 + '5', 1 + null, 1 + undefined, 'a' + null, true + true, [] + [], [] + {}, [1, 2] + [3]);
  console.log('- * /', '10' - 3, '6' * '7', '8' / '2', 'x' - 1, true * 5, null * 3, [5] * 2, '  12 ' - 0);
  console.log('compare', '10' < '9', 10 < '9', 'a' < 'b', 'B' < 'a', null < 1, undefined < 1, [2] > 1, '' < 1);
  console.log('String()', String(null), String([1, [2, 3]]), String({}), String(Symbol('q')), String(-0), `${[]}`);
  console.log('template coercion', `${1 + 1}${'x'}${true}${null}${undefined}`);
}

class Money {
  constructor(amount, cur) {
    this.amount = amount;
    this.cur = cur;
  }
  valueOf() {
    return this.amount;
  }
  toString() {
    return this.amount.toFixed(2) + ' ' + this.cur;
  }
}

class Temperature {
  constructor(c) {
    this.c = c;
  }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.c;
    if (hint === 'string') return this.c + 'C';
    return 'temp(' + this.c + ')';
  }
}

function customConversions() {
  const a = new Money(5, 'EUR');
  const b = new Money(7.5, 'EUR');
  console.log('valueOf arithmetic', a + b, a * 2, b - a, a > b, a < b);
  console.log('toString via template/String', `${a}`, String(b), [a, b].join(' & '));
  console.log('+ with string uses valueOf', a + '', 'total: ' + b);
  const t = new Temperature(21);
  console.log('toPrimitive', +t, `${t}`, t + '', t + 1, t * 2, String(t), t == 'temp(21)');
  const order = [];
  const tricky = {
    valueOf() {
      order.push('valueOf');
      return {};
    },
    toString() {
      order.push('toString');
      return '99';
    },
  };
  console.log('fallback to toString', tricky * 1, order.join(','));
  const bad = { valueOf: () => ({}), toString: () => ({}) };
  try {
    console.log(bad + 1);
  } catch (e) {
    console.log('no primitive', e.constructor.name);
  }
  let counter = 0;
  const magic = { valueOf: () => ++counter };
  console.log('magic == chain', magic == 1 && magic == 2 && magic == 3);
  const dateLike = { toString: () => 'S', valueOf: () => 42 };
  console.log('default hint', dateLike + '', `${dateLike}`, dateLike * 1, [dateLike] + '');
  console.log('array toString', [1, [2, [3]]] + '', [null, undefined] + '', [[]] == 0);
}

function wrapperObjects() {
  const s = 'hello';
  s.custom = 1;
  console.log('prop on primitive', s.custom, s.length, s.toUpperCase());
  const ns = new String('hi');
  ns.custom = 2;
  console.log('wrapper', typeof ns, ns.custom, ns == 'hi', ns === 'hi', ns.valueOf() === 'hi');
  const nb = new Boolean(false);
  console.log('Boolean wrapper truthy', nb ? 'truthy' : 'falsy', nb.valueOf());
  console.log('Number methods on literal', (255).toString(16), 3.14159.toFixed(2), Number.prototype.toFixed.call(1.5, 1));
  console.log('Object(primitive)', typeof Object(1), Object('s') instanceof String, Object(null) instanceof Object);
}

typeofTable();
voidOp();
deleteOp();
instanceofAndIn();
equalityTable();
truthiness();
implicitConversions();
customConversions();
wrapperObjects();
console.log('done a17');
