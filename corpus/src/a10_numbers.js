// a10: numbers, bit ops, BigInt, Math

function bitOps() {
  const a = 0b1100;
  const b = 0b1010;
  console.log('and/or/xor', a & b, a | b, a ^ b, ~a);
  console.log('shifts', 1 << 10, -16 >> 2, -16 >>> 28, 1 << 31, (1 << 31) >>> 0);
  console.log('>>> 0', -1 >>> 0, (-1 >>> 0).toString(16), 4294967296 >>> 0, 4294967297 | 0);
  console.log('int32 wrap', 2147483647 + 1 | 0, ~~3.7, ~~-3.7, 5.9 | 0);
  let flags = 0;
  const READ = 1, WRITE = 2, EXEC = 4;
  flags |= READ | EXEC;
  console.log('flags', flags, !!(flags & WRITE), !!(flags & EXEC));
  flags &= ~READ;
  flags ^= WRITE;
  console.log('flags after', flags.toString(2));
  let x = 0xdeadbeef;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  console.log('xorshift', x >>> 0);
}

function popcount(n) {
  let c = 0;
  n >>>= 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bitAlgorithms() {
  console.log('popcount', [0, 1, 255, 0xffffffff, 12345].map(popcount).join(','));
  console.log('fnv1a', hash32('hello').toString(16), hash32('world').toString(16), hash32(''));
  console.log('clz32', Math.clz32(1), Math.clz32(0), Math.clz32(0x80000000));
  console.log('isPow2', [1, 2, 3, 64, 100, 1024].map((n) => (n & (n - 1)) === 0).join(','));
}

function exponent() {
  console.log('**', 2 ** 10, 2 ** -1, (-2) ** 3, 2 ** 3 ** 2, 10 ** 21);
  let v = 3;
  v **= 4;
  console.log('**=', v);
  console.log('Math.pow', Math.pow(2, 0.5).toFixed(6), Math.pow(0, 0), Math.pow(NaN, 0));
}

function bigints() {
  const a = 2n ** 64n;
  const b = 12345678901234567890n;
  console.log('bigint', a.toString(), (a - 1n).toString(16), (b * b).toString());
  console.log('div/mod', (b / 7n).toString(), (b % 7n).toString(), (-7n / 2n).toString(), (-7n % 2n).toString());
  console.log('bitwise', (0xffn & 0x0fn).toString(), (1n << 100n).toString(), (-1n >> 3n).toString());
  let f = 1n;
  for (let i = 1n; i <= 30n; i++) f *= i;
  console.log('30!', f.toString());
  console.log('compare', 10n > 9, 10n == 10, 10n === 10, typeof 10n, BigInt('0x1f'), BigInt.asUintN(8, 257n), BigInt.asIntN(8, 255n));
  try {
    console.log(1n + 1);
  } catch (e) {
    console.log('mixing', e.constructor.name);
  }
  console.log('Number(big)', Number(2n ** 53n + 1n), String(123n), 5n + BigInt(3));
}

function edgeCases() {
  console.log('NaN', NaN === NaN, Object.is(NaN, NaN), isNaN('abc'), Number.isNaN('abc'), [NaN].includes(NaN), [NaN].indexOf(NaN));
  const negZero = -0;
  console.log('-0', negZero === 0, Object.is(negZero, 0), Object.is(negZero, -0), 1 / negZero, String(negZero), JSON.stringify(negZero));
  console.log('-0 from math', Object.is(Math.round(-0.4), -0), Object.is(0 * -1, -0), Object.is(-0 + 0, 0));
  console.log('Infinity', 1 / 0, -1 / 0, Infinity - Infinity, Infinity * 0, isFinite('12'), Number.isFinite('12'));
  console.log('limits', Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.EPSILON > 0, Number.MAX_VALUE > 1e308, Number.MIN_VALUE > 0);
  console.log('safe', Number.isSafeInteger(2 ** 53), Number.isSafeInteger(2 ** 53 - 1), 2 ** 53 === 2 ** 53 + 1);
  console.log('float', 0.1 + 0.2, 0.1 + 0.2 === 0.3, Math.abs(0.1 + 0.2 - 0.3) < Number.EPSILON);
  console.log('isInteger', Number.isInteger(5.0), Number.isInteger(5.1), Number.isInteger('5'));
}

function formatting() {
  const n = 1234.5678;
  console.log('toFixed', n.toFixed(0), n.toFixed(2), (0.000001234).toFixed(8), (1.005).toFixed(2), (-1.5).toFixed(0));
  console.log('toPrecision', n.toPrecision(3), n.toPrecision(6), (0.00012345).toPrecision(2));
  console.log('toExponential', n.toExponential(2), (123456789).toExponential());
  console.log('toString radix', (255).toString(2), (255).toString(36), (-255).toString(16), (0.5).toString(2));
  console.log('big/small', 1e21, 1e-7, 123e-20, 2 ** 70, 0.000001);
}

function parsing() {
  console.log('parseInt', parseInt('42px'), parseInt('0x1F'), parseInt('1F', 16), parseInt('z', 36), parseInt('101', 2), parseInt('08'), parseInt(''), parseInt('  -12.9'));
  console.log('parseInt radix map', ['10', '10', '10'].map(parseInt).join(','));
  console.log('parseFloat', parseFloat('3.14abc'), parseFloat('.5'), parseFloat('-.5e2x'), parseFloat('abc'));
  console.log('Number()', Number(''), Number(' 12 '), Number('12px'), Number('0b101'), Number('0o17'), Number(null), Number(undefined), Number([]), Number([7]), Number([1, 2]), Number(true));
  console.log('unary +', +'3', +'', +'1e3', +{}, +[], +[[5]], +true);
}

function mathFunctions() {
  const vals = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 2.4, 2.6];
  console.log('round', vals.map(Math.round).join(','));
  console.log('floor', vals.map(Math.floor).join(','));
  console.log('ceil', vals.map(Math.ceil).join(','));
  console.log('trunc', vals.map(Math.trunc).join(','));
  console.log('sign', [-3, 0, 5, -0].map((v) => Math.sign(v)).join(','));
  console.log('minmax', Math.max(), Math.min(), Math.max(1, 'x'), Math.min(3, 1, 2));
  console.log('sqrt/cbrt/hypot', Math.sqrt(144), Math.cbrt(27), Math.hypot(3, 4), Math.sqrt(-1));
  console.log('trig', Math.sin(0), Math.cos(Math.PI).toFixed(3), Math.atan2(1, 1).toFixed(6), Math.tan(Math.PI / 4).toFixed(6));
  console.log('log/exp', Math.log(Math.E), Math.log2(1024), Math.log10(1e5), Math.exp(0), Math.expm1(0), Math.log1p(0));
  console.log('fround/abs', Math.fround(5.5), Math.fround(5.05).toFixed(10), Math.abs(-7.25));
}

function numericAlgorithms() {
  function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
  }
  function isPrime(n) {
    if (n < 2) return false;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
    return true;
  }
  function modpow(base, exp, mod) {
    let r = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) r = (r * base) % mod;
      base = (base * base) % mod;
      exp >>= 1n;
    }
    return r;
  }
  console.log('gcd', gcd(1071, 462), gcd(17, 5), 'lcm', (12 * 18) / gcd(12, 18));
  console.log('primes<60', Array.from({ length: 60 }, (_, i) => i).filter(isPrime).join(' '));
  console.log('modpow', modpow(2n, 1000n, 1000000007n).toString(), modpow(3n, 200n, 13n).toString());
  let s = 0;
  for (let k = 0; k < 1000; k++) s += (k % 2 ? -1 : 1) / (2 * k + 1);
  console.log('leibniz pi', (4 * s).toFixed(5));
  const toRoman = (n) => {
    const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [v, sym] of map) while (n >= v) (out += sym), (n -= v);
    return out;
  };
  console.log('roman', [1994, 2024, 3999, 4].map(toRoman).join(' '));
  let inc = 5;
  const post = inc++;
  const pre = ++inc;
  console.log('inc/dec', post, pre, inc--, --inc, inc);
  console.log('modulo neg', -7 % 3, 7 % -3, ((-7 % 3) + 3) % 3, 5.5 % 2);
}

bitOps();
bitAlgorithms();
exponent();
bigints();
edgeCases();
formatting();
parsing();
mathFunctions();
numericAlgorithms();
console.log('done a10');
