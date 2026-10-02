// BigInt crypto toys: modpow, gcd/ext-gcd, RSA with small primes, CRC32, simple hashes
'use strict';

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function extGcd(a, b) {
  let [oldR, r] = [a, b];
  let [oldS, s] = [1n, 0n];
  let [oldT, t] = [0n, 1n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return { g: oldR, x: oldS, y: oldT };
}

function mod(a, m) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modInverse(a, m) {
  const { g, x } = extGcd(mod(a, m), m);
  if (g !== 1n) throw new RangeError(`${a} has no inverse mod ${m}`);
  return mod(x, m);
}

function modPow(base, exp, m) {
  if (m === 1n) return 0n;
  let result = 1n;
  base = mod(base, m);
  let squarings = 0;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    exp >>= 1n;
    base = (base * base) % m;
    squarings++;
  }
  modPow.lastSquarings = squarings;
  return result;
}

function isProbablePrime(n, bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n]) {
  if (n < 2n) return false;
  for (const p of bases) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n, r = 0;
  while ((d & 1n) === 0n) { d >>= 1n; r++; }
  witness: for (const a of bases) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < r; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witness;
    }
    return false;
  }
  return true;
}

function* primesFrom(start) {
  let n = start | 1n;
  for (;;) {
    if (isProbablePrime(n)) yield n;
    n += 2n;
  }
}

function crt(residues, moduli) {
  const M = moduli.reduce((a, b) => a * b, 1n);
  let x = 0n;
  residues.forEach((r, i) => {
    const mi = moduli[i];
    const Mi = M / mi;
    x += r * Mi * modInverse(Mi, mi);
  });
  return mod(x, M);
}

class RSAKey {
  #d;
  #p;
  #q;
  constructor(p, q, e = 65537n) {
    if (!isProbablePrime(p) || !isProbablePrime(q)) throw new Error('p and q must be prime');
    const phi = (p - 1n) * (q - 1n);
    if (gcd(e, phi) !== 1n) throw new Error(`e=${e} not coprime with phi`);
    this.n = p * q;
    this.e = e;
    this.#d = modInverse(e, phi);
    this.#p = p;
    this.#q = q;
  }
  get bits() { return this.n.toString(2).length; }
  get publicKey() { return { n: this.n, e: this.e }; }
  encrypt(m) {
    if (m >= this.n) throw new RangeError('message too large');
    return modPow(m, this.e, this.n);
  }
  decrypt(c) { return modPow(c, this.#d, this.n); }
  decryptCRT(c) {
    const p = this.#p, q = this.#q;
    const mp = modPow(c, this.#d % (p - 1n), p);
    const mq = modPow(c, this.#d % (q - 1n), q);
    return crt([mp, mq], [p, q]);
  }
  sign(h) { return this.decrypt(h % this.n); }
  verify(h, sig) { return this.encrypt(sig) === h % this.n; }
  toJSON() { return { n: this.n.toString(16), e: Number(this.e), bits: this.bits }; }
}

function textToBigInt(s) {
  let n = 0n;
  for (const ch of s) n = (n << 8n) | BigInt(ch.charCodeAt(0) & 0xff);
  return n;
}

function bigIntToText(n) {
  const chars = [];
  while (n > 0n) {
    chars.unshift(String.fromCharCode(Number(n & 0xffn)));
    n >>= 8n;
  }
  return chars.join('');
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(str) {
  let crc = -1;
  for (let i = 0; i < str.length; i++) crc = CRC_TABLE[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function djb2(str) {
  let h = 5381;
  for (const ch of str) h = (Math.imul(h, 33) + ch.charCodeAt(0)) | 0;
  return h >>> 0;
}

function murmur3(key, seed = 0) {
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  let i = 0;
  const len = key.length;
  for (; i + 4 <= len; i += 4) {
    let k = (key.charCodeAt(i) & 0xff) | ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) | ((key.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (len & 3) {
    case 3: k ^= (key.charCodeAt(i + 2) & 0xff) << 16; // fallthrough
    case 2: k ^= (key.charCodeAt(i + 1) & 0xff) << 8; // fallthrough
    case 1:
      k ^= key.charCodeAt(i) & 0xff;
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= len;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hex(n, width = 8) {
  return n.toString(16).padStart(width, '0');
}

const HASHES = { crc32, fnv1a, djb2, murmur3 };

function hashTable(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + (i > 0 ? hex(values[i - 1]) : '') + s, '');
}

function diffieHellman(p, g, a, b) {
  const A = modPow(g, a, p);
  const B = modPow(g, b, p);
  const s1 = modPow(B, a, p), s2 = modPow(A, b, p);
  return { A, B, shared: s1, agree: s1 === s2 };
}

function main() {
  console.log(`gcd(462,1071)=${gcd(462n, 1071n)} gcd(-48,18)=${gcd(-48n, 18n)}`);
  const eg = extGcd(240n, 46n);
  console.log(`extGcd(240,46): g=${eg.g} x=${eg.x} y=${eg.y} check=${240n * eg.x + 46n * eg.y}`);
  console.log(`inverse 3 mod 11 = ${modInverse(3n, 11n)}, 17 mod 3120 = ${modInverse(17n, 3120n)}`);
  try {
    modInverse(6n, 9n);
  } catch (e) {
    console.log(`${e.name}: ${e.message}`);
  }
  console.log(`2^100 mod 1e9+7 = ${modPow(2n, 100n, 1000000007n)} (squarings=${modPow.lastSquarings})`);
  console.log(`3^(2^64) mod 97 = ${modPow(3n, 2n ** 64n, 97n)}`);

  const small = [];
  for (let n = 1n; n < 60n; n++) if (isProbablePrime(n)) small.push(n);
  console.log(`primes<60: ${small.join(' ')}`);
  const gen = primesFrom(1000000n);
  const big = [gen.next().value, gen.next().value, gen.next().value];
  console.log(`primes after 1e6: ${big.join(', ')}`);
  console.log(`561 carmichael prime? ${isProbablePrime(561n)}, 2^61-1 prime? ${isProbablePrime(2n ** 61n - 1n)}`);

  console.log(`crt x=2 mod 3, 3 mod 5, 2 mod 7 => ${crt([2n, 3n, 2n], [3n, 5n, 7n])}`);

  const key = new RSAKey(61n, 53n, 17n);
  console.log(`toy rsa: ${JSON.stringify(key)}`);
  for (const m of [65n, 42n, 3000n]) {
    const c = key.encrypt(m);
    console.log(`  m=${m} c=${c} d=${key.decrypt(c)} crt=${key.decryptCRT(c)}`);
  }
  try { key.encrypt(99999n); } catch (e) { console.log(`  ${e.message}`); }
  try { new RSAKey(61n, 55n); } catch (e) { console.log(`  keygen: ${e.message}`); }
  try { new RSAKey(7n, 11n, 3n); } catch (e) { console.log(`  keygen: ${e.message}`); }

  const pg = primesFrom(2n ** 40n);
  const p = pg.next().value;
  const q = primesFrom(2n ** 41n + 12345n).next().value;
  const rsa = new RSAKey(p, q);
  console.log(`rsa ${rsa.bits} bits, n=${rsa.n}`);
  const msg = 'Hi VM!';
  const mInt = textToBigInt(msg);
  const cInt = rsa.encrypt(mInt);
  console.log(`  msg int=${mInt} cipher=${cInt.toString(36)}`);
  console.log(`  decrypted: ${bigIntToText(rsa.decrypt(cInt))} / crt: ${bigIntToText(rsa.decryptCRT(cInt))}`);
  const h = BigInt(fnv1a(msg));
  const sig = rsa.sign(h);
  console.log(`  sig ok=${rsa.verify(h, sig)} tampered=${rsa.verify(h + 1n, sig)}`);

  const dh = diffieHellman(2147483647n, 7n, 123456789n, 987654321n);
  console.log(`dh: A=${dh.A} B=${dh.B} shared=${dh.shared} agree=${dh.agree}`);

  console.log(`crc table[1]=${hex(CRC_TABLE[1] >>> 0)} table[255]=${hex(CRC_TABLE[255] >>> 0)}`);
  const inputs = ['', 'a', 'abc', 'hello world', 'The quick brown fox jumps over the lazy dog', '123456789'];
  for (const s of inputs) {
    const parts = Object.entries(HASHES).map(([name, f]) => `${name}=${hex(f(s))}`);
    console.log(`${JSON.stringify(s).padEnd(46)} ${parts.join(' ')}`);
  }
  console.log(hashTable`murmur seeds: ${murmur3('seed', 0)} ${murmur3('seed', 1)} ${murmur3('seed', 0xdeadbeef)}`);

  // avalanche check: bits flipped between neighbouring inputs
  const popcount = (x) => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
  for (const [name, f] of Object.entries(HASHES)) {
    let total = 0;
    for (let i = 0; i < 16; i++) total += popcount((f('key' + i) ^ f('key' + (i + 1))) >>> 0);
    console.log(`avalanche ${name}: avg bits flipped=${(total / 16).toFixed(2)}`);
  }
  const collisions = new Map();
  for (let i = 0; i < 500; i++) {
    const b = djb2('item' + i) % 64;
    collisions.set(b, (collisions.get(b) ?? 0) + 1);
  }
  const maxBucket = Math.max(...collisions.values());
  console.log(`djb2 buckets used=${collisions.size}/64 max=${maxBucket}`);
  console.log(`bigint ops: ${(2n ** 128n - 1n).toString(16)} ${-7n / 2n} ${-7n % 2n} ${BigInt.asUintN(8, 257n)} ${BigInt.asIntN(8, 255n)}`);
}

main();
