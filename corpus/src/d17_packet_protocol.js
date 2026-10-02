// d17: packet protocol - framing, varints, CRC, fragmentation/reassembly over a lossy channel
'use strict';

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift32) and a BigInt-based splitmix for seeds
// ---------------------------------------------------------------------------
class Xorshift32 {
  #state;
  static #instances = 0;
  static {
    Xorshift32.DEFAULT_SEED = 0x9e3779b9;
  }
  constructor(seed = Xorshift32.DEFAULT_SEED) {
    this.#state = (seed >>> 0) || 1;
    Xorshift32.#instances++;
  }
  static get count() { return Xorshift32.#instances; }
  next() {
    let x = this.#state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.#state = x;
    return x;
  }
  float() { return this.next() / 4294967296; }
  int(lo, hi) { return lo + (this.next() % (hi - lo + 1)); }
  static isRng(o) { return #state in o; }
  *[Symbol.iterator]() { for (;;) yield this.next(); }
}

function splitmix64(seedBig) {
  let z = (seedBig + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  return z ^ (z >> 31n);
}

// ---------------------------------------------------------------------------
// CRC32 (table-driven) + CRC16-CCITT
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function crc16(bytes) {
  let crc = 0xffff;
  outer: for (const b of bytes) {
    crc ^= b << 8;
    let bit = 0;
    do {
      if (crc & 0x8000) { crc = ((crc << 1) ^ 0x1021) & 0xffff; bit++; continue; }
      crc = (crc << 1) & 0xffff;
      bit++;
      if (bit > 8) break outer;
    } while (bit < 8);
  }
  return crc;
}

const hex = (n, w = 8) => (n >>> 0).toString(16).padStart(w, '0');
const bytesHex = (arr) => Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// Varints: unsigned LEB128, zigzag, BigInt varints
// ---------------------------------------------------------------------------
function encodeVarint(n, out = []) {
  if (n < 0) throw new RangeError('negative varint ' + n);
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function decodeVarint(bytes, pos = 0) {
  let result = 0, mul = 1, i = pos;
  for (;;) {
    if (i >= bytes.length) throw new SyntaxError('truncated varint at ' + pos);
    const b = bytes[i++];
    result += (b & 0x7f) * mul;
    if (!(b & 0x80)) break;
    mul *= 128;
    if (i - pos > 8) throw new SyntaxError('varint too long');
  }
  return { value: result, next: i };
}

const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function encodeBigVarint(big) {
  const out = [];
  let v = BigInt.asUintN(64, big);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
function decodeBigVarint(bytes, pos = 0) {
  let v = 0n, shift = 0n, i = pos;
  while (true) {
    const b = bytes[i++];
    v |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) break;
  }
  return [BigInt.asIntN(64, v), i];
}

// ---------------------------------------------------------------------------
// Text encoding (UTF-8 by hand, to avoid TextEncoder differences)
// ---------------------------------------------------------------------------
function utf8Encode(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    switch (true) {
      case cp < 0x80: out.push(cp); break;
      case cp < 0x800: out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63)); break;
      case cp < 0x10000:
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        break;
      default:
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return out;
}
function utf8Decode(bytes) {
  let s = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp, len;
    if (b < 0x80) { cp = b; len = 1; }
    else if (b >> 5 === 6) { cp = b & 31; len = 2; }
    else if (b >> 4 === 14) { cp = b & 15; len = 3; }
    else { cp = b & 7; len = 4; }
    for (let k = 1; k < len; k++) cp = (cp << 6) | (bytes[i + k] & 63);
    s += String.fromCodePoint(cp);
    i += len;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Message schema: tagged fields (protobuf-ish)
// ---------------------------------------------------------------------------
const WIRE = Object.freeze({ VARINT: 0, BYTES: 2, SINT: 5, BIG: 6 });

const schemaTag = (strings, ...keys) => {
  // tagged template: `id:${0} name:${2}` -> build field list
  const fields = [];
  strings.forEach((s, i) => {
    const m = /(?<name>\w+):(?<kind>[a-z]*)\s*$/.exec(s);
    if (m && i < keys.length) fields.push({ name: m.groups.name, kind: m.groups.kind || 'uint', no: keys[i] });
  });
  return fields;
};

const MSG_SCHEMA = schemaTag`seq:uint ${1} user:str ${2} delta:sint ${3} token:big ${4} tags:list ${5}`;

function encodeMessage(msg, schema = MSG_SCHEMA) {
  const out = [];
  for (const { name, kind, no } of schema) {
    const v = msg[name];
    if (v === undefined || v === null) continue;
    switch (kind) {
      case 'uint':
        encodeVarint((no << 3) | WIRE.VARINT, out);
        encodeVarint(v, out);
        break;
      case 'sint':
        encodeVarint((no << 3) | WIRE.SINT, out);
        encodeVarint(zigzag(v), out);
        break;
      case 'big':
        encodeVarint((no << 3) | WIRE.BIG, out);
        out.push(...encodeBigVarint(v));
        break;
      case 'list':
        for (const item of v) {
          const b = utf8Encode(String(item));
          encodeVarint((no << 3) | WIRE.BYTES, out);
          encodeVarint(b.length, out);
          out.push(...b);
        }
        break;
      case 'str':
      default: {
        const b = utf8Encode(v);
        encodeVarint((no << 3) | WIRE.BYTES, out);
        encodeVarint(b.length, out);
        out.push(...b);
      }
    }
  }
  return out;
}

function decodeMessage(bytes, schema = MSG_SCHEMA) {
  const byNo = new Map(schema.map((f) => [f.no, f]));
  const msg = {};
  let pos = 0;
  while (pos < bytes.length) {
    const { value: key, next } = decodeVarint(bytes, pos);
    pos = next;
    const no = key >>> 3, wire = key & 7;
    const field = byNo.get(no) ?? { name: 'unk' + no, kind: '?' };
    let val;
    switch (wire) {
      case WIRE.VARINT: ({ value: val, next: pos } = decodeVarint(bytes, pos)); break;
      case WIRE.SINT: {
        const r = decodeVarint(bytes, pos);
        val = unzigzag(r.value); pos = r.next;
        break;
      }
      case WIRE.BIG: [val, pos] = decodeBigVarint(bytes, pos); break;
      case WIRE.BYTES: {
        const r = decodeVarint(bytes, pos);
        val = utf8Decode(bytes.slice(r.next, r.next + r.value));
        pos = r.next + r.value;
        break;
      }
      default:
        throw new TypeError(`bad wire type ${wire} at ${pos}`);
    }
    if (field.kind === 'list') (msg[field.name] ||= []).push(val);
    else msg[field.name] = val;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Framing: SLIP-like with escape, header {type, streamId, fragIdx, fragCount, len}, CRC32 trailer
// ---------------------------------------------------------------------------
const END = 0xc0, ESC = 0xdb, ESC_END = 0xdc, ESC_ESC = 0xdd;

class FrameError extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
  get [Symbol.toStringTag]() { return 'FrameError'; }
}
class CrcError extends FrameError {
  constructor(expected, actual) {
    super(`crc mismatch ${hex(expected)} != ${hex(actual)}`, 'CRC');
    this.expected = expected;
    this.actual = actual;
  }
}
class TruncatedError extends FrameError {
  constructor(what) { super('truncated ' + what, 'TRUNC'); }
}

function escapeBytes(bytes) {
  const out = [END];
  for (const b of bytes) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return out;
}

function* deframe(stream) {
  let buf = [], inFrame = false, esc = false, stats = { frames: 0, junk: 0 };
  for (const b of stream) {
    if (b === END) {
      if (inFrame && buf.length) { stats.frames++; yield buf; }
      buf = []; inFrame = true; esc = false;
      continue;
    }
    if (!inFrame) { stats.junk++; continue; }
    if (esc) {
      esc = false;
      if (b === ESC_END) buf.push(END);
      else if (b === ESC_ESC) buf.push(ESC);
      else { buf = []; inFrame = false; stats.junk++; }
      continue;
    }
    if (b === ESC) { esc = true; continue; }
    buf.push(b);
  }
  return stats;
}

function buildFrame({ type = 1, streamId, fragIdx = 0, fragCount = 1, payload = [] }) {
  const body = [type];
  encodeVarint(streamId, body);
  encodeVarint(fragIdx, body);
  encodeVarint(fragCount, body);
  encodeVarint(payload.length, body);
  body.push(...payload);
  const c = crc32(body);
  body.push((c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255);
  return escapeBytes(body);
}

function parseFrame(body) {
  if (body.length < 5) throw new TruncatedError('frame');
  const n = body.length;
  const expected = ((body[n - 4] << 24) | (body[n - 3] << 16) | (body[n - 2] << 8) | body[n - 1]) >>> 0;
  const actual = crc32(body, 0, n - 4);
  if (expected !== actual) throw new CrcError(expected, actual);
  let pos = 1;
  const fields = [];
  for (let k = 0; k < 4; k++) {
    const r = decodeVarint(body, pos);
    fields.push(r.value);
    pos = r.next;
  }
  const [streamId, fragIdx, fragCount, len] = fields;
  if (pos + len !== n - 4) throw new TruncatedError(`payload ${pos + len} vs ${n - 4}`);
  return { type: body[0], streamId, fragIdx, fragCount, payload: body.slice(pos, pos + len) };
}

// ---------------------------------------------------------------------------
// Lossy channel: drop, corrupt, duplicate, reorder
// ---------------------------------------------------------------------------
class Channel {
  #rng;
  #log = [];
  constructor(seed, { drop = 0.1, corrupt = 0.05, dup = 0.05, reorder = 0.1 } = {}) {
    this.#rng = new Xorshift32(seed);
    Object.assign(this, { drop, corrupt, dup, reorder });
    this.delivered = 0;
  }
  get log() { return [...this.#log]; }
  transmit(frames) {
    const out = [];
    let held = null;
    frames.forEach((f, i) => {
      const r = this.#rng.float();
      let frame = f.slice();
      if (r < this.drop) { this.#log.push(`drop#${i}`); return; }
      if (this.#rng.float() < this.corrupt) {
        const at = 1 + this.#rng.int(0, frame.length - 3);
        frame[at] ^= 1 << this.#rng.int(0, 7);
        this.#log.push(`flip#${i}@${at}`);
      }
      if (this.#rng.float() < this.reorder && held === null) {
        held = frame;
        this.#log.push(`hold#${i}`);
        return;
      }
      out.push(frame);
      if (held) { out.push(held); held = null; }
      if (this.#rng.float() < this.dup) { out.push(frame.slice()); this.#log.push(`dup#${i}`); }
    });
    if (held) out.push(held);
    this.delivered += out.length;
    return out.flat();
  }
}

// ---------------------------------------------------------------------------
// Fragmenter / Reassembler
// ---------------------------------------------------------------------------
class Fragmenter {
  constructor(mtu = 16) { this.mtu = mtu; }
  *fragments(streamId, bytes) {
    const count = Math.max(1, Math.ceil(bytes.length / this.mtu));
    for (let i = 0; i < count; i++) {
      yield buildFrame({ type: 1, streamId, fragIdx: i, fragCount: count, payload: bytes.slice(i * this.mtu, (i + 1) * this.mtu) });
    }
    return count;
  }
}

class Reassembler {
  #streams = new Map();
  #done = new Set();
  static #errorCounts = Object.create(null);
  constructor() { this.errors = []; this.duplicates = 0; }
  static errorSummary() { return JSON.stringify(Reassembler.#errorCounts); }
  feed(wire) {
    const completed = [];
    const it = deframe(wire);
    let step;
    while (!(step = it.next()).done) {
      const body = step.value;
      let frame;
      try {
        frame = parseFrame(body);
      } catch (e) {
        const code = e instanceof FrameError ? e.code : 'OTHER';
        Reassembler.#errorCounts[code] = (Reassembler.#errorCounts[code] ?? 0) + 1;
        this.errors.push(code);
        continue;
      }
      const { streamId, fragIdx, fragCount, payload } = frame;
      if (this.#done.has(streamId)) { this.duplicates++; continue; }
      let st = this.#streams.get(streamId);
      st ??= (this.#streams.set(streamId, { parts: new Array(fragCount), have: 0 }), this.#streams.get(streamId));
      if (st.parts[fragIdx]) { this.duplicates++; continue; }
      st.parts[fragIdx] = payload;
      if (++st.have === fragCount) {
        this.#done.add(streamId);
        this.#streams.delete(streamId);
        completed.push({ streamId, bytes: st.parts.flat() });
      }
    }
    this.lastStats = step.value;
    return completed;
  }
  missing() {
    const res = {};
    for (const [id, st] of this.#streams) {
      const miss = [];
      for (let i = 0; i < st.parts.length; i++) if (!st.parts[i]) miss.push(i);
      res[id] = miss;
    }
    return res;
  }
  isDone(id) { return this.#done.has(id); }
}

// ---------------------------------------------------------------------------
// Selective-repeat ARQ session, driven by a generator protocol
// ---------------------------------------------------------------------------
function* arqSession(messages, channel, { mtu = 12, maxRounds = 12 } = {}) {
  const frag = new Fragmenter(mtu);
  const rx = new Reassembler();
  const encoded = messages.map((m, id) => ({ id, bytes: encodeMessage(m) }));
  const pending = new Map(encoded.map((e) => [e.id, [...frag.fragments(e.id, e.bytes)]]));
  const delivered = [];
  let round = 0;
  rounds: while (pending.size && round < maxRounds) {
    round++;
    const toSend = [];
    for (const [id, frames] of pending) {
      const miss = rx.missing()[id];
      frames.forEach((f, i) => {
        if (!miss || miss.includes(i)) toSend.push(f);
      });
    }
    const wire = channel.transmit(toSend);
    let completed;
    try {
      completed = rx.feed(wire);
    } finally {
      yield { round, sent: toSend.length, wireLen: wire.length, errors: rx.errors.length };
    }
    for (const c of completed) {
      pending.delete(c.streamId);
      delivered.push(c);
      if (c.streamId === -1) break rounds; // never true
    }
  }
  return { rounds: round, delivered, duplicates: rx.duplicates, unfinished: [...pending.keys()] };
}

// ---------------------------------------------------------------------------
// Proxy-based stats counter + Reflect
// ---------------------------------------------------------------------------
function makeCounter() {
  const counts = {};
  return new Proxy(counts, {
    get(target, key, recv) {
      if (typeof key === 'symbol') return Reflect.get(target, key, recv);
      if (key === 'toJSON') return () => ({ ...target });
      return Reflect.has(target, key) ? Reflect.get(target, key, recv) : 0;
    },
    set(target, key, value) {
      if (typeof value !== 'number') return false;
      return Reflect.set(target, key, value);
    },
    deleteProperty(t, k) { return k in t ? (delete t[k], true) : true; },
  });
}

// ---------------------------------------------------------------------------
// Async transport layer with Promise combinators (microtasks only)
// ---------------------------------------------------------------------------
class AsyncPipe {
  constructor(label) { this.label = label; this.queue = []; this.waiters = []; this.closed = false; }
  push(v) {
    const w = this.waiters.shift();
    w ? w({ value: v, done: false }) : this.queue.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: async () => { this.close(); return { done: true, value: undefined }; },
    };
  }
}

async function* chunked(pipe, size) {
  let acc = [];
  for await (const b of pipe) {
    acc.push(b);
    if (acc.length === size) { yield acc; acc = []; }
  }
  if (acc.length) yield acc;
}

async function runAsyncTransport(order) {
  const pipe = new AsyncPipe('bytes');
  const payload = utf8Encode('async→transport ✓ ok');
  const producer = (async () => {
    for (const [i, b] of payload.entries()) {
      pipe.push(b);
      if (i % 5 === 4) { order.push('p' + i); await null; }
    }
    pipe.close();
    return payload.length;
  })();
  const consumer = (async () => {
    const chunks = [];
    for await (const c of chunked(pipe, 4)) {
      chunks.push(crc16(c).toString(16));
      order.push('c' + chunks.length);
    }
    return chunks;
  })();
  const [n, chunks] = await Promise.all([producer, consumer]);
  const settled = await Promise.allSettled([
    Promise.reject(new CrcError(1, 2)),
    Promise.resolve(n),
    (async () => { throw new TruncatedError('async'); })(),
  ]);
  const first = await Promise.any([Promise.reject(new Error('x')), Promise.resolve('any-ok')]);
  const race = await Promise.race([new Promise((r) => r('race-a')), Promise.resolve('race-b')]);
  return {
    n, chunks,
    settled: settled.map((s) => s.status + ':' + (s.value ?? s.reason?.code)),
    first, race,
  };
}

// ---------------------------------------------------------------------------
// Utilities using sloppy-ish features via Function-free code
// ---------------------------------------------------------------------------
function checksumAll() {
  // use arguments-like rest
  let acc = 0;
  for (let i = 0; i < arguments.length; i++) acc = (acc * 31 + crc32(arguments[i])) >>> 0;
  return acc;
}

const toPrimitiveId = {
  id: 42,
  [Symbol.toPrimitive](hint) { return hint === 'number' ? this.id : `stream-${this.id}`; },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('== d17 packet protocol ==');

// CRC checks
const abc = utf8Encode('123456789');
console.log('crc32(123456789) = ' + hex(crc32(abc)));
console.log('crc16(123456789) = ' + hex(crc16(abc), 4));
console.log('crc32(empty) = ' + hex(crc32([])));

// Varints
const varintCases = [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 40 + 7];
for (const v of varintCases) {
  const enc = encodeVarint(v);
  const { value, next } = decodeVarint(enc);
  console.log(`varint ${v} -> ${bytesHex(enc)} -> ${value} (${next} bytes) ok=${value === v}`);
}
for (const s of [-1, 1, -64, 63, -1000000]) {
  console.log(`zigzag ${s} -> ${zigzag(s)} -> ${unzigzag(zigzag(s))}`);
}
for (const b of [0n, -1n, 123456789012345678n, -(2n ** 63n)]) {
  const e = encodeBigVarint(b);
  const [d, p] = decodeBigVarint(e);
  console.log(`bigvarint ${b} len=${p} back=${d} eq=${d === b}`);
}
try {
  decodeVarint([0x80, 0x80]);
} catch (e) {
  console.log('varint error: ' + (e instanceof SyntaxError) + ' ' + e.message);
}

// UTF-8
for (const s of ['hi', 'grüß', '日本', '😀x']) {
  const e = utf8Encode(s);
  console.log(`utf8 ${JSON.stringify(s)} -> ${bytesHex(e)} -> ${utf8Decode(e) === s}`);
}

// Schema & messages
console.log('schema: ' + JSON.stringify(MSG_SCHEMA));
const messages = [
  { seq: 1, user: 'alice', delta: -5, token: 0x1234567890abcdefn, tags: ['a', 'b'] },
  { seq: 2, user: 'bøb', delta: 300, tags: [] },
  { seq: 3, user: 'carol the long named user', delta: -99999, token: -7n, tags: ['x', 'yy', 'zzz'] },
  { seq: 4, user: '', delta: 0 },
  { seq: 5, user: 'eve'.repeat(10), token: 1n << 62n, tags: ['🔥'] },
];
for (const m of messages) {
  const enc = encodeMessage(m);
  const dec = decodeMessage(enc);
  console.log(`msg ${m.seq}: ${enc.length}B crc=${hex(crc32(enc))} dec=${JSON.stringify(dec, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v))}`);
}

// Frames
const f0 = buildFrame({ streamId: 7, payload: [END, ESC, 1, 2, 3] });
console.log('frame escaped: ' + bytesHex(f0));
const g0 = deframe(f0);
const body0 = g0.next().value;
console.log('deframed: ' + bytesHex(body0) + ' parsed=' + JSON.stringify(parseFrame(body0)));
const tail0 = g0.next();
console.log('deframe stats: ' + JSON.stringify(tail0.value) + ' done=' + tail0.done);

// Corruption detection
{
  const bad = f0.slice();
  bad[3] ^= 0x10;
  const it = deframe(bad);
  for (const body of it) {
    try {
      parseFrame(body);
      console.log('corrupted frame unexpectedly parsed');
    } catch (err) {
      const { code, message } = err;
      console.log(`detected ${code}: ${message} tag=${Object.prototype.toString.call(err)}`);
    }
  }
}

// Channel simulation via ARQ generator
const channel = new Channel(12345, { drop: 0.2, corrupt: 0.1, dup: 0.1, reorder: 0.15 });
const session = arqSession(messages, channel, { mtu: 10 });
let r;
while (!(r = session.next()).done) {
  const { round, sent, wireLen, errors } = r.value;
  console.log(`round ${round}: sent=${sent} wire=${wireLen} errs=${errors}`);
}
const { rounds, delivered, duplicates, unfinished } = r.value;
console.log(`arq done rounds=${rounds} delivered=${delivered.length} dups=${duplicates} unfinished=${JSON.stringify(unfinished)}`);
for (const { streamId, bytes } of delivered.sort((a, b) => a.streamId - b.streamId)) {
  const m = decodeMessage(bytes);
  console.log(`  stream ${streamId}: user=${JSON.stringify(m.user)} delta=${m.delta ?? 'none'} tags=${(m.tags ?? []).join('|')}`);
}
console.log('channel log head: ' + channel.log.slice(0, 12).join(','));
console.log('channel log size: ' + channel.log.length + ' delivered frames=' + channel.delivered);
console.log('reassembler errors: ' + Reassembler.errorSummary());

// Early termination of a session with .return() and .throw()
{
  const ch2 = new Channel(99, { drop: 0.5 });
  const s2 = arqSession(messages.slice(0, 2), ch2, { mtu: 4 });
  const first = s2.next();
  console.log('s2 first: ' + JSON.stringify(first.value));
  const ret = s2.return('stopped');
  console.log('s2 return: ' + JSON.stringify(ret));
  const s3 = arqSession(messages.slice(0, 1), new Channel(5), { mtu: 4 });
  s3.next();
  try {
    s3.throw(new FrameError('injected', 'INJ'));
  } catch (e) {
    console.log('s3 throw propagated: ' + e.code + ' ' + e.message);
  }
  console.log('s3 after: ' + JSON.stringify(s3.next()));
}

// Many seeds: robustness sweep with labeled loops
const counter = makeCounter();
sweep: for (let seed = 1; seed <= 8; seed++) {
  const ch = new Channel(seed * 7919, { drop: 0.25, corrupt: 0.1, dup: 0.2, reorder: 0.2 });
  const gen = arqSession(messages, ch, { mtu: 8, maxRounds: 6 });
  let res;
  for (;;) {
    res = gen.next();
    if (res.done) break;
    if (res.value.round > 5) { counter.aborted++; continue sweep; }
  }
  counter.total++;
  counter.rounds += res.value.rounds;
  if (res.value.unfinished.length) counter.incomplete++;
  console.log(`seed ${seed}: rounds=${res.value.rounds} ok=${res.value.delivered.length}/${messages.length}`);
}
console.log('sweep counter: ' + JSON.stringify(counter) + ' missing=' + counter.nothing);
delete counter.aborted;
console.log('after delete: ' + JSON.stringify(counter));

// RNG checks
const rng = new Xorshift32(1);
const firstFive = [];
for (const v of rng) { firstFive.push(v); if (firstFive.length === 5) break; }
console.log('rng first5: ' + firstFive.join(','));
console.log('isRng: ' + Xorshift32.isRng(rng) + ' ' + Xorshift32.isRng({}) + ' instances>0=' + (Xorshift32.count > 0));
console.log('splitmix: ' + [1n, 2n, 3n].map((s) => splitmix64(s).toString(16)).join(' '));

console.log('checksumAll: ' + hex(checksumAll([1, 2], [3], utf8Encode('zz'))));
console.log(`toPrimitive: ${toPrimitiveId} num=${+toPrimitiveId} add=${toPrimitiveId + ''}`);

// Frame-level fuzz: parse random junk, classify errors (exceptions as control flow)
{
  const fz = new Xorshift32(2024);
  const classes = new Map();
  for (let i = 0; i < 40; i++) {
    const len = fz.int(0, 12);
    const junk = Array.from({ length: len }, () => fz.int(0, 255));
    let cls;
    try {
      parseFrame(junk);
      cls = 'ok';
    } catch (e) {
      cls = e?.code ?? e?.constructor?.prototype === SyntaxError.prototype ? 'SYNTAX' : 'OTHER';
      cls = e instanceof FrameError ? e.code : cls;
    } finally {
      classes.set(cls, (classes.get(cls) || 0) + 1);
    }
  }
  console.log('fuzz classes: ' + JSON.stringify([...classes].sort()));
}

// Async transport
const order = [];
runAsyncTransport(order)
  .then((res) => {
    console.log('async result: ' + JSON.stringify(res));
    console.log('async order: ' + order.join(','));
    return Promise.resolve().then(() => 'chained');
  })
  .then((v) => console.log('async chain: ' + v))
  .catch((e) => console.log('async failed: ' + e.message))
  .finally(() => console.log('== d17 end =='));
console.log('sync part finished');
