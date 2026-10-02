'use strict';
// d11: Huffman + LZ77 + base85 codec round-trips with checksums

// ---------- byte helpers ----------
function utf8Encode(str) {
  const out = [];
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
function utf8Decode(bytes) {
  let s = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp, n;
    switch (true) {
      case b < 0x80: cp = b; n = 1; break;
      case (b & 0xe0) === 0xc0: cp = b & 31; n = 2; break;
      case (b & 0xf0) === 0xe0: cp = b & 15; n = 3; break;
      case (b & 0xf8) === 0xf0: cp = b & 7; n = 4; break;
      default: throw new Error('bad utf8 lead at ' + i);
    }
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 63);
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}
const hex = (bytes, max = 16) =>
  Array.from(bytes.slice(0, max), b => b.toString(16).padStart(2, '0')).join('') + (bytes.length > max ? '..' : '');

// ---------- checksums ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (const x of bytes) { a = (a + x) % MOD; b = (b + a) % MOD; }
  return ((b << 16) | a) >>> 0;
}
function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n, M = (1n << 64n) - 1n;
  for (const x of bytes) { h ^= BigInt(x); h = (h * P) & M; }
  return h;
}

class Checksummer {
  static #algos = new Map();
  static {
    this.register('crc32', crc32);
    this.register('adler32', adler32);
    this.register('fnv64', b => fnv1a64(b));
  }
  static register(name, fn) { Checksummer.#algos.set(name, fn); }
  static compute(name, bytes) {
    const f = Checksummer.#algos.get(name);
    if (!f) throw new ReferenceError('no algo ' + name);
    const v = f(bytes);
    return typeof v === 'bigint' ? v.toString(16).padStart(16, '0') : v.toString(16).padStart(8, '0');
  }
  static all(bytes) {
    const o = {};
    for (const k of Checksummer.#algos.keys()) o[k] = Checksummer.compute(k, bytes);
    return o;
  }
}

// ---------- bit streams ----------
class BitWriter {
  #bytes = []; #cur = 0; #n = 0;
  write(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.#cur = (this.#cur << 1) | ((value >>> i) & 1);
      if (++this.#n === 8) { this.#bytes.push(this.#cur); this.#cur = 0; this.#n = 0; }
    }
    return this;
  }
  writeBits(str) { for (const c of str) this.write(c === '1' ? 1 : 0, 1); return this; }
  get bitLength() { return this.#bytes.length * 8 + this.#n; }
  finish() {
    const pad = this.#n ? 8 - this.#n : 0;
    if (pad) this.write(0, pad);
    return { bytes: Uint8Array.from(this.#bytes), pad };
  }
}
class BitReader {
  #bytes; #pos = 0;
  constructor(bytes, totalBits = bytes.length * 8) { this.#bytes = bytes; this.total = totalBits; }
  get remaining() { return this.total - this.#pos; }
  bit() {
    if (this.#pos >= this.total) throw new RangeError('eof');
    const b = (this.#bytes[this.#pos >> 3] >> (7 - (this.#pos & 7))) & 1;
    this.#pos++;
    return b;
  }
  read(bits) { let v = 0; while (bits--) v = (v << 1) | this.bit(); return v >>> 0; }
}

// ---------- Huffman ----------
class MinHeap {
  #a = [];
  constructor(cmp) { this.cmp = cmp; }
  get size() { return this.#a.length; }
  push(x) {
    const a = this.#a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.#a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

const Huffman = {
  lengths(freq) {
    let order = 0;
    const heap = new MinHeap((x, y) => x.w - y.w || x.o - y.o);
    for (const [sym, w] of freq) heap.push({ w, o: order++, sym });
    if (heap.size === 1) return new Map([[heap.pop().sym, 1]]);
    while (heap.size > 1) {
      const a = heap.pop(), b = heap.pop();
      heap.push({ w: a.w + b.w, o: order++, kids: [a, b] });
    }
    const out = new Map();
    const walk = (node, d) => node.kids ? node.kids.forEach(k => walk(k, d + 1)) : out.set(node.sym, d);
    walk(heap.pop(), 0);
    return out;
  },
  canonical(lengths) {
    const syms = [...lengths].sort(([s1, l1], [s2, l2]) => l1 - l2 || s1 - s2);
    const codes = new Map();
    let code = 0, prevLen = syms[0][1];
    for (const [i, [sym, len]] of syms.entries()) {
      if (i) { code = (code + 1) << (len - prevLen); }
      else code = 0;
      prevLen = len;
      codes.set(sym, { code, len });
    }
    return codes;
  },
  encode(bytes) {
    const freq = new Map();
    for (const b of bytes) freq.set(b, (freq.get(b) || 0) + 1);
    if (!freq.size) return { bytes: new Uint8Array(0), header: [], bits: 0 };
    const lens = this.lengths(freq);
    const codes = this.canonical(lens);
    const w = new BitWriter();
    for (const b of bytes) { const { code, len } = codes.get(b); w.write(code, len); }
    const bits = w.bitLength;
    const header = [...lens].sort((a, b) => a[0] - b[0]);
    return { ...w.finish(), header, bits };
  },
  decode({ bytes, header, bits }) {
    if (!header.length) return new Uint8Array(0);
    const codes = this.canonical(new Map(header));
    const lookup = new Map();
    for (const [sym, { code, len }] of codes) lookup.set(len + ':' + code, sym);
    const r = new BitReader(bytes, bits);
    const out = [];
    let code = 0, len = 0;
    while (r.remaining > 0) {
      code = (code << 1) | r.bit(); len++;
      const s = lookup.get(len + ':' + code);
      if (s !== undefined) { out.push(s); code = 0; len = 0; }
      else if (len > 24) throw new Error('bad huffman stream');
    }
    return Uint8Array.from(out);
  },
};

// ---------- LZ77 ----------
class LZ77 {
  static WINDOW = 1024;
  static MIN = 3;
  static MAX = 34;
  #stats = { literals: 0, matches: 0, longest: 0 };
  get stats() { return { ...this.#stats }; }
  *tokens(bytes) {
    const head = new Map();
    let i = 0;
    const key = p => bytes[p] << 16 | bytes[p + 1] << 8 | bytes[p + 2];
    while (i < bytes.length) {
      let bestLen = 0, bestDist = 0;
      if (i + LZ77.MIN <= bytes.length) {
        const cands = head.get(key(i)) || [];
        cand: for (let c = cands.length - 1; c >= 0; c--) {
          const j = cands[c];
          if (i - j > LZ77.WINDOW) break cand;
          let l = 0;
          while (l < LZ77.MAX && i + l < bytes.length && bytes[j + l] === bytes[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - j; if (l === LZ77.MAX) break cand; }
        }
      }
      const adv = bestLen >= LZ77.MIN ? bestLen : 1;
      if (bestLen >= LZ77.MIN) {
        this.#stats.matches++;
        this.#stats.longest = Math.max(this.#stats.longest, bestLen);
        yield { dist: bestDist, len: bestLen };
      } else {
        this.#stats.literals++;
        yield { lit: bytes[i] };
      }
      for (let k = 0; k < adv; k++, i++) {
        if (i + 2 < bytes.length) {
          const kk = key(i);
          const arr = head.get(kk);
          arr ? arr.push(i) : head.set(kk, [i]);
        }
      }
    }
    return this.#stats.matches;
  }
  compress(bytes) {
    const out = [];
    let flagPos = -1, bit = 8;
    const it = this.tokens(bytes);
    let res;
    while (!(res = it.next()).done) {
      if (bit === 8) { flagPos = out.length; out.push(0); bit = 0; }
      const t = res.value;
      if ('lit' in t) out.push(t.lit);
      else {
        out[flagPos] |= 1 << bit;
        const d = t.dist - 1, l = t.len - LZ77.MIN;
        out.push((d >> 8) << 5 | l, d & 0xff);
      }
      bit++;
    }
    return { bytes: Uint8Array.from(out), matches: res.value };
  }
  static decompress(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      const flags = bytes[i++];
      for (let bit = 0; bit < 8 && i < bytes.length; bit++) {
        if (flags & (1 << bit)) {
          const b0 = bytes[i++], b1 = bytes[i++];
          const len = (b0 & 31) + LZ77.MIN, dist = ((b0 >> 5) << 8 | b1) + 1;
          const start = out.length - dist;
          if (start < 0) throw new RangeError('bad distance ' + dist);
          for (let k = 0; k < len; k++) out.push(out[start + k]);
        } else out.push(bytes[i++]);
      }
    }
    return Uint8Array.from(out);
  }
}

// ---------- base85 (Ascii85 with z) ----------
const Base85 = {
  encode(bytes) {
    let out = '<~';
    for (let i = 0; i < bytes.length; i += 4) {
      const chunk = [0, 1, 2, 3].map(k => bytes[i + k] ?? 0);
      const n = Math.min(4, bytes.length - i);
      let v = ((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]) >>> 0;
      if (v === 0 && n === 4) { out += 'z'; continue; }
      const digs = new Array(5);
      for (let k = 4; k >= 0; k--) { digs[k] = String.fromCharCode(33 + (v % 85)); v = Math.floor(v / 85); }
      out += digs.slice(0, n + 1).join('');
    }
    return out + '~>';
  },
  decode(str) {
    const m = /^<~(?<body>[\s\S]*)~>$/.exec(str);
    if (!m) throw new SyntaxError('missing delimiters');
    const body = m.groups.body.replace(/\s+/g, '').replace(/z/g, '!!!!!');
    const out = [];
    for (let i = 0; i < body.length; i += 5) {
      const grp = body.slice(i, i + 5);
      const n = grp.length;
      const full = grp.padEnd(5, 'u');
      let v = 0;
      for (const c of full) {
        const d = c.charCodeAt(0) - 33;
        if (d < 0 || d > 84) throw new SyntaxError(`bad char ${JSON.stringify(c)}`);
        v = v * 85 + d;
      }
      const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      out.push(...b.slice(0, n - 1));
    }
    return Uint8Array.from(out);
  },
};

// ---------- container format ----------
const MAGIC = [0x48, 0x4c, 0x42]; // "HLB"
function packU32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
function unpackU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function pack(bytes, { lz = true, huff = true } = {}) {
  const lzOut = lz ? new LZ77().compress(bytes).bytes : bytes;
  const h = huff ? Huffman.encode(lzOut) : { bytes: lzOut, header: [], bits: lzOut.length * 8 };
  const flags = (lz ? 1 : 0) | (huff ? 2 : 0);
  const hdr = [...MAGIC, flags, ...packU32(bytes.length), ...packU32(crc32(bytes)), ...packU32(h.bits), h.header.length & 255, h.header.length >> 8];
  for (const [sym, len] of h.header) hdr.push(sym, len);
  return Uint8Array.from([...hdr, ...h.bytes]);
}

function unpack(buf) {
  for (let i = 0; i < MAGIC.length; i++) if (buf[i] !== MAGIC[i]) throw new TypeError('bad magic');
  const flags = buf[3];
  const origLen = unpackU32(buf, 4), crc = unpackU32(buf, 8), bits = unpackU32(buf, 12);
  const hn = buf[16] | (buf[17] << 8);
  const header = [];
  let o = 18;
  for (let k = 0; k < hn; k++, o += 2) header.push([buf[o], buf[o + 1]]);
  const payload = buf.slice(o);
  let data = flags & 2 ? Huffman.decode({ bytes: payload, header, bits }) : payload;
  data = flags & 1 ? LZ77.decompress(data) : data;
  if (data.length !== origLen) throw new RangeError(`length ${data.length} != ${origLen}`);
  if (crc32(data) !== crc) throw new Error('crc mismatch');
  return data;
}

// ---------- sample corpus (deterministic) ----------
function lcg(seed) { let s = seed; return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16; }
const rnd = lcg(2024);
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'codec', 'huffman', 'window', 'match', 'literal', 'the', 'and', 'of'];
function makeText(n) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(WORDS[rnd() % WORDS.length] + (i % 9 === 8 ? '.\n' : ' '));
  return parts.join('');
}
const samples = {
  empty: '',
  single: 'a',
  repeat: 'ab'.repeat(200),
  text: makeText(400),
  unicode: 'Grüße, 世界! 🎉 naïve café — ' + 'ü🎉'.repeat(20),
  json: JSON.stringify({ list: Array.from({ length: 40 }, (_, i) => ({ id: i, sq: i * i, even: !(i & 1) })) }),
  zeros: '\u0000'.repeat(37),
  binaryish: String.fromCharCode(...Array.from({ length: 300 }, () => rnd() & 127)),
};

console.log('utf8 roundtrip', utf8Decode(utf8Encode(samples.unicode)) === samples.unicode, utf8Encode(samples.unicode).length);
console.log('crc32("123456789")', Checksummer.compute('crc32', utf8Encode('123456789')));
console.log('adler32("Wikipedia")', Checksummer.compute('adler32', utf8Encode('Wikipedia')));
console.log('fnv64("")', Checksummer.compute('fnv64', new Uint8Array(0)));
try { Checksummer.compute('md5', []); } catch (e) { console.log('missing algo', e instanceof ReferenceError, e.message); }

// ---------- round-trip each sample through each stage ----------
const report = [];
for (const [name, str] of Object.entries(samples)) {
  const bytes = utf8Encode(str);
  const sums = Checksummer.all(bytes);
  const lz = new LZ77();
  const { bytes: lzb, matches } = lz.compress(bytes);
  const lzBack = LZ77.decompress(lzb);
  const hf = Huffman.encode(bytes);
  const hfBack = Huffman.decode(hf);
  const b85 = Base85.encode(bytes);
  const b85Back = Base85.decode(b85);
  const packed = pack(bytes);
  const unpacked = unpack(packed);
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const row = {
    name, n: bytes.length, lz: lzb.length, matches, huff: hf.bytes.length, b85: b85.length, packed: packed.length,
    ok: [eq(lzBack, bytes), eq(hfBack, bytes), eq(b85Back, bytes), eq(unpacked, bytes)].map(Number).join(''),
  };
  report.push(row);
  console.log(`${name.padEnd(9)} n=${row.n} lz=${row.lz}/${matches} huff=${row.huff} b85=${row.b85} pack=${row.packed} ok=${row.ok} crc=${sums.crc32}`);
  const st = lz.stats;
  console.log(`  lzstats lit=${st.literals} match=${st.matches} longest=${st.longest} adler=${sums.adler32} fnv=${sums.fnv64}`);
}
console.log('all ok', report.every(r => r.ok === '1111'));

// ---------- specific base85 checks ----------
console.log('b85 hello', Base85.encode(utf8Encode('hello')));
console.log('b85 zeros', Base85.encode(new Uint8Array(8)));
console.log('b85 decode', utf8Decode(Base85.decode('<~87cURD]i,"Ebo80~>')));
for (const bad of ['87cUR', '<~87cÿURD~>', '<~ z z ~>']) {
  try {
    const r = Base85.decode(bad);
    console.log('b85 ok', JSON.stringify(bad), r.length);
  } catch ({ name, message }) {
    console.log('b85 err', name, message);
  }
}

// ---------- Huffman internals ----------
{
  const freq = new Map([[65, 45], [66, 13], [67, 12], [68, 16], [69, 9], [70, 5]]);
  const lens = Huffman.lengths(freq);
  const codes = Huffman.canonical(lens);
  for (const [sym, { code, len }] of [...codes].sort((a, b) => a[0] - b[0]))
    console.log('  huff', String.fromCharCode(sym), len, code.toString(2).padStart(len, '0'));
  const kraft = [...lens.values()].reduce((s, l) => s + 2 ** -l, 0);
  console.log('kraft sum', kraft);
  const avg = [...freq].reduce((s, [k, f]) => s + f * lens.get(k), 0) / 100;
  console.log('avg bits', avg.toFixed(2));
}

// ---------- tampering detection (exceptions as control flow) ----------
function tryUnpack(buf, label) {
  let outcome = 'unknown';
  try {
    const data = unpack(buf);
    outcome = 'ok:' + data.length;
    return outcome;
  } catch (e) {
    outcome = e.constructor.name + ':' + e.message;
    return outcome;
  } finally {
    console.log('  tamper', label, '->', outcome);
  }
}
{
  const base = pack(utf8Encode(samples.text));
  tryUnpack(base, 'none');
  const variants = {
    magic: b => { b[0] ^= 1; },
    length: b => { b[7] ^= 1; },
    crc: b => { b[11] ^= 0x80; },
    payload: b => { b[b.length - 5] ^= 0x10; },
    truncated: b => b.slice(0, b.length - 20),
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const copy = base.slice();
    const res = mutate(copy);
    tryUnpack(res instanceof Uint8Array ? res : copy, label);
  }
}

// ---------- streaming pipeline via generators & yield* ----------
function* chunker(bytes, size) {
  let n = 0;
  for (let i = 0; i < bytes.length; i += size) { yield bytes.slice(i, i + size); n++; }
  return n;
}
function* compressStage(source) {
  const count = yield* (function* () {
    let c = 0;
    for (const chunk of source) {
      const p = pack(chunk);
      c++;
      const cmd = yield { raw: chunk.length, packed: p.length, buf: p };
      if (cmd === 'abort') return -c;
    }
    return c;
  })();
  return { count };
}
function* verifyStage(stage) {
  let r = stage.next();
  let totalRaw = 0, totalPacked = 0;
  while (!r.done) {
    const { raw, packed, buf } = r.value;
    const back = unpack(buf);
    totalRaw += raw; totalPacked += packed;
    yield `${raw}->${packed} ${back.length === raw ? 'ok' : 'BAD'}`;
    r = stage.next(totalRaw > 1500 ? 'abort' : undefined);
  }
  return { ...r.value, totalRaw, totalPacked };
}
{
  const big = utf8Encode(makeText(500));
  const v = verifyStage(compressStage(chunker(big, 512)));
  let r;
  while (!(r = v.next()).done) console.log('  chunk', r.value);
  console.log('stream summary', JSON.stringify(r.value));
}
{
  const g = chunker(utf8Encode('0123456789'), 3);
  console.log('gen first', utf8Decode(g.next().value), 'return', JSON.stringify(g.return(99)), 'after', JSON.stringify(g.next()));
  const g2 = compressStage(chunker(utf8Encode('abcdefgh'), 4));
  g2.next();
  try { g2.throw(new Error('injected')); } catch (e) { console.log('gen throw propagated', e.message); }
}

// ---------- block-level codec registry with Proxy and Symbol.iterator ----------
class CodecChain {
  #stages = [];
  constructor(...names) { names.forEach(n => this.add(n)); }
  add(name) {
    const impl = CODECS[name];
    if (!impl) throw new Error('unknown codec ' + name);
    this.#stages.push({ name, ...impl });
    return this;
  }
  encode(bytes) { return this.#stages.reduce((b, s) => s.enc(b), bytes); }
  decode(data) { return this.#stages.reduceRight((b, s) => s.dec(b), data); }
  *[Symbol.iterator]() { for (const { name } of this.#stages) yield name; }
  get length() { return this.#stages.length; }
}
const codecUsage = {};
const CODECS = new Proxy({
  lz: { enc: b => new LZ77().compress(b).bytes, dec: b => LZ77.decompress(b) },
  huff: {
    enc: b => { const h = Huffman.encode(b); return { h }; },
    dec: ({ h }) => Huffman.decode(h),
  },
  b85: { enc: b => Base85.encode(b.h ? flattenHuff(b.h) : b), dec: s => unflattenHuff(Base85.decode(s)) },
  xor: { enc: b => b.map((x, i) => x ^ ((i * 31 + 7) & 255)), dec: b => b.map((x, i) => x ^ ((i * 31 + 7) & 255)) },
}, {
  get(t, k) {
    if (typeof k === 'string') codecUsage[k] = (codecUsage[k] ?? 0) + 1;
    return Reflect.get(t, k);
  },
});
function flattenHuff({ bytes, header, bits }) {
  return Uint8Array.from([...packU32(bits), header.length, ...header.flat(), ...bytes]);
}
function unflattenHuff(b) {
  const bits = unpackU32(b, 0), n = b[4];
  const header = [];
  for (let i = 0; i < n; i++) header.push([b[5 + 2 * i], b[6 + 2 * i]]);
  return { h: { bits, header, bytes: b.slice(5 + 2 * n) } };
}
{
  const chains = [['lz'], ['xor', 'lz'], ['lz', 'huff', 'b85'], ['xor', 'lz', 'huff', 'b85']];
  const input = utf8Encode(samples.text.slice(0, 600));
  for (const names of chains) {
    const chain = new CodecChain(...names);
    const enc = chain.encode(input);
    const dec = chain.decode(enc);
    const sz = typeof enc === 'string' ? enc.length : enc.bytes?.length ?? enc.length ?? enc.h?.bytes.length;
    console.log('chain', [...chain].join('>'), 'len', chain.length, 'enc', sz, 'rt', utf8Decode(dec) === utf8Decode(input));
  }
  try { new CodecChain('lz', 'rot13'); } catch (e) { console.log('chain err', e.message); }
  console.log('codec usage', JSON.stringify(Object.keys(codecUsage).sort().map(k => [k, codecUsage[k]])));
}

// ---------- run-length + BWT-ish transform with deep recursion ----------
function rle(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let j = i;
    while (j < bytes.length && bytes[j] === bytes[i] && j - i < 255) j++;
    out.push(j - i, bytes[i]);
    i = j;
  }
  return out;
}
function unrle(arr, i = 0, acc = []) {
  if (i >= arr.length) return acc;
  for (let k = 0; k < arr[i]; k++) acc.push(arr[i + 1]);
  return unrle(arr, i + 2, acc);
}
function bwt(s) {
  const t = s + '\u0000';
  const rots = Array.from(t, (_, i) => i).sort((a, b) => {
    for (let k = 0; k < t.length; k++) {
      const x = t[(a + k) % t.length], y = t[(b + k) % t.length];
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  return rots.map(i => t[(i + t.length - 1) % t.length]).join('');
}
function ibwt(r) {
  const n = r.length;
  const sorted = [...r].map((c, i) => [c, i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const next = sorted.map(([, i]) => i);
  let p = sorted.findIndex(([c]) => c === '\u0000');
  let out = '';
  for (let k = 0; k < n - 1; k++) { p = next[p]; out += sorted[p][0]; }
  return out;
}
{
  const s = 'banana_bandana_banana';
  const b = bwt(s);
  console.log('bwt', JSON.stringify(b), 'inverse ok', ibwt(b) === s);
  const r = rle(utf8Encode(b));
  console.log('rle pairs', r.length / 2, 'roundtrip', utf8Decode(Uint8Array.from(unrle(r))) === b);
  const deep = new Uint8Array(3000).map((_, i) => (i * 7) & 3);
  const rd = rle(deep);
  console.log('deep rle recursion', rd.length / 2, unrle(rd).length);
}

// ---------- tagged template hexdump ----------
function hexdump(strings, ...vals) {
  return strings.reduce((acc, s, i) => {
    const v = vals[i - 1];
    const rendered = v instanceof Uint8Array ? `[${hex(v, 8)}|${v.length}]` : typeof v === 'number' ? '0x' + v.toString(16) : String(v);
    return acc + rendered + s;
  });
}
console.log(hexdump`packed ${pack(utf8Encode('hello hello hello'))} crc ${crc32(utf8Encode('hello'))} tag ${'end'}`);
console.log(String.raw`raw\x41 ${1 + 1}B`);

// ---------- sticky regex tokenizer for a tiny "codec spec" language ----------
function parseSpec(spec) {
  const re = /(?<ws>\s+)|(?<name>[a-z][a-z0-9]*)|(?<num>\d+)|(?<op>[|(),=])/y;
  const toks = [];
  re.lastIndex = 0;
  while (re.lastIndex < spec.length) {
    const at = re.lastIndex;
    const m = re.exec(spec);
    if (!m) throw new SyntaxError(`bad spec at ${at}: ${JSON.stringify(spec.slice(at, at + 5))}`);
    const [kind] = Object.entries(m.groups).find(([, v]) => v !== undefined);
    if (kind !== 'ws') toks.push({ kind, text: m[0] });
  }
  const stages = [];
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  while (i < toks.length) {
    const t = take();
    if (t.kind !== 'name') throw new SyntaxError('expected name, got ' + t.text);
    const opts = {};
    if (peek()?.text === '(') {
      take();
      while (peek() && peek().text !== ')') {
        const k = take().text; take(); const v = take();
        opts[k] = v.kind === 'num' ? +v.text : v.text;
        if (peek()?.text === ',') take();
      }
      take();
    }
    stages.push({ name: t.text, opts });
    if (peek()?.text === '|') take();
  }
  return stages;
}
for (const spec of ['lz | huff | b85', 'xor(key=7, rounds=2) | lz', 'lz |  huff(max=15)', 'lz | $bad']) {
  try {
    console.log('spec', JSON.stringify(parseSpec(spec)));
  } catch (e) {
    console.log('spec error', e.message);
  }
}

// ---------- lookbehind / unicode regex over b85 output ----------
{
  const enc = Base85.encode(utf8Encode(samples.text.slice(0, 120)));
  const afterTilde = enc.match(/(?<=<~).{6}/u)?.[0];
  const digitsRuns = [...enc.matchAll(/(?<![0-9])[0-9]{2,}(?![0-9])/g)].map(m => m[0]);
  console.log('b85 head', JSON.stringify(afterTilde), 'digit runs', digitsRuns.length, JSON.stringify(digitsRuns.slice(0, 5)));
  const emoji = samples.unicode.match(/\p{Extended_Pictographic}/gu) ?? [];
  console.log('emoji count', emoji.length, 'letters', (samples.unicode.match(/\p{L}/gu) || []).length);
}

// ---------- async verification with for-await and Promise combinators ----------
async function* asyncChunks(bytes, size) {
  for (let i = 0; i < bytes.length; i += size) {
    await null;
    yield { idx: i / size, data: bytes.slice(i, i + size) };
  }
}
async function verifyAsync(name, bytes) {
  let sum = 0;
  for await (const { idx, data } of asyncChunks(bytes, 97)) {
    const p = pack(data);
    if (idx === 2 && name === 'fail') throw new Error('forced failure in ' + name);
    sum = (sum + crc32(unpack(p))) >>> 0;
  }
  return `${name}:${sum.toString(16)}`;
}
const order = [];
async function mainAsync() {
  const texts = { a: samples.text, b: samples.json, fail: samples.repeat, c: samples.binaryish };
  const settled = await Promise.allSettled(Object.entries(texts).map(([k, v]) => verifyAsync(k, utf8Encode(v))));
  settled.forEach(r => order.push(r.status === 'fulfilled' ? r.value : 'ERR ' + r.reason.message));
  const winner = await Promise.race([verifyAsync('long', utf8Encode(samples.text)), verifyAsync('short', utf8Encode('xy'))]);
  order.push('race ' + winner);
  const any = await Promise.any([verifyAsync('fail', utf8Encode(samples.text)), verifyAsync('ok2', utf8Encode(samples.single))]);
  order.push('any ' + any);
  const all = await Promise.all([1, 2, 3].map(async n => { await null; return crc32(utf8Encode(String(n))) & 0xff; }));
  order.push('all ' + all.join(','));
}
mainAsync().then(() => {
  for (const line of order) console.log('async', line);
  console.log('done');
});
console.log('sync end');
