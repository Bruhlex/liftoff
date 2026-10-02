'use strict';
// Log processing pipeline: synthetic access logs are written to a temp dir, streamed back
// through Transform stages (line splitting, parsing, filtering), aggregated, gzip round-tripped
// and checksummed. Everything is derived from a fixed seed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable, Transform, Writable, PassThrough, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

// ---------------------------------------------------------------------------
// deterministic generator
// ---------------------------------------------------------------------------
class Lcg {
  #s;
  constructor(seed) { this.#s = seed >>> 0; }
  next() { this.#s = (Math.imul(this.#s, 1664525) + 1013904223) >>> 0; return this.#s; }
  below(n) { return this.next() % n; }
  pick(a) { return a[this.below(a.length)]; }
  weighted(pairs) {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this.below(total);
    for (const [v, w] of pairs) { if (r < w) return v; r -= w; }
    return pairs[pairs.length - 1][0];
  }
}

const SERVICES = ['auth', 'billing', 'catalog', 'search', 'gateway'];
const PATHS = ['/api/login', '/api/logout', '/api/items', '/api/items/:id', '/api/cart', '/api/pay', '/health', '/api/search'];
const METHODS = [['GET', 6], ['POST', 3], ['DELETE', 1]];
const LEVELS = [['INFO', 70], ['WARN', 18], ['ERROR', 9], ['DEBUG', 3]];

function two(n) { return String(n).padStart(2, '0'); }

function* generateLogLines(seed, count) {
  const rng = new Lcg(seed);
  let sec = 0;
  for (let i = 0; i < count; i++) {
    sec += rng.below(4);
    const hh = two(8 + Math.floor(sec / 3600)), mm = two(Math.floor(sec / 60) % 60), ss = two(sec % 60);
    if (rng.below(97) === 0) { yield `### corrupted entry ${i} ###`; continue; }
    const level = rng.weighted(LEVELS);
    const svc = rng.pick(SERVICES);
    const method = rng.weighted(METHODS);
    let p = rng.pick(PATHS).replace(':id', String(rng.below(500)));
    let status = level === 'ERROR' ? rng.pick([500, 502, 503]) : level === 'WARN' ? rng.pick([400, 401, 404, 429]) : rng.pick([200, 200, 200, 201, 204, 304]);
    const latency = level === 'ERROR' ? 200 + rng.below(1800) : 2 + rng.below(level === 'WARN' ? 400 : 120);
    const user = `u${rng.below(40)}`;
    const bytes = rng.below(20000);
    yield `2024-03-01T${hh}:${mm}:${ss}Z ${level} [${svc}] ${method} ${p} ${status} ${latency}ms bytes=${bytes} user=${user}`;
  }
}

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

class Crc32 {
  #crc = 0xFFFFFFFF;
  update(buf) {
    let c = this.#crc;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    this.#crc = c;
    return this;
  }
  digest() { return (this.#crc ^ 0xFFFFFFFF) >>> 0; }
  static of(buf) { return new Crc32().update(buf).digest(); }
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  for (const ch of Buffer.from(str)) { h ^= BigInt(ch); h = (h * 0x100000001b3n) & 0xFFFFFFFFFFFFFFFFn; }
  return h;
}

const hex8 = (n) => n.toString(16).padStart(8, '0');

// ---------------------------------------------------------------------------
// stream stages
// ---------------------------------------------------------------------------
class Stage extends Transform {
  static registry = new Map();
  static { Stage.registry.set('base', 'Stage'); }
  #processed = 0; #label;
  constructor(label, opts) { super(opts); this.#label = label; Stage.registry.set(label, this.constructor === Stage ? 'Stage' : 'derived'); }
  get processed() { return this.#processed; }
  get label() { return this.#label; }
  bump() { this.#processed++; }
}

class LineSplitter extends Stage {
  #tail = Buffer.alloc(0);
  constructor() { super('split', { readableObjectMode: true }); }
  _transform(chunk, _enc, cb) {
    let buf = this.#tail.length ? Buffer.concat([this.#tail, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        const line = buf.subarray(start, i).toString('utf8');
        start = i + 1;
        if (line.length) { this.bump(); this.push(line); }
      }
    }
    this.#tail = Buffer.from(buf.subarray(start));
    cb();
  }
  _flush(cb) {
    if (this.#tail.length) { this.bump(); this.push(this.#tail.toString('utf8')); }
    cb();
  }
}

const LINE_RE = /^(?<date>\d{4}-\d{2}-\d{2})T(?<time>\d{2}:\d{2}:\d{2})Z (?<level>[A-Z]+) \[(?<svc>\w+)\] (?<method>GET|POST|DELETE) (?<path>\/\S*) (?<status>\d{3}) (?<lat>\d+)ms bytes=(?<bytes>\d+) user=(?<user>u\d+)$/;

class LogParser extends Stage {
  #malformed = 0;
  constructor(emitter) { super('parse', { objectMode: true }); this.events = emitter; }
  get malformed() { return this.#malformed; }
  _transform(line, _enc, cb) {
    const m = LINE_RE.exec(line);
    if (!m) {
      this.#malformed++;
      this.events?.emit('malformed', line);
      return cb();
    }
    const { date, time, level, svc, method, path: p, status, lat, bytes, user } = m.groups;
    const [h, mi, s] = time.split(':').map(Number);
    this.bump();
    cb(null, { date, t: h * 3600 + mi * 60 + s, time, level, svc, method, path: p.replace(/\/\d+$/, '/:id'), rawPath: p, status: +status, lat: +lat, bytes: +bytes, user });
  }
}

class Filter extends Stage {
  #pred;
  constructor(label, pred) { super(label, { objectMode: true }); this.#pred = pred; }
  _transform(rec, _enc, cb) { if (this.#pred(rec)) { this.bump(); cb(null, rec); } else cb(); }
}

class Serializer extends Stage {
  constructor() { super('serialize', { writableObjectMode: true }); }
  _transform(rec, _enc, cb) { this.bump(); cb(null, `${rec.time} ${rec.level} ${rec.svc} ${rec.status} ${rec.rawPath} ${rec.lat}\n`); }
}

class HashTap extends Stage {
  #hash = crypto.createHash('sha256'); #crc = new Crc32(); #bytes = 0;
  constructor(label) { super(label); }
  _transform(chunk, _enc, cb) { this.#hash.update(chunk); this.#crc.update(chunk); this.#bytes += chunk.length; this.bump(); cb(null, chunk); }
  result() { return { sha256: this.#hash.digest('hex'), crc: hex8(this.#crc.digest()), bytes: this.#bytes }; }
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------
function defaultingCounter() {
  return new Proxy({}, {
    get: (t, k) => (typeof k === 'string' && !(k in t) ? 0 : t[k]),
  });
}

class Aggregator extends Writable {
  constructor() {
    super({ objectMode: true });
    this.levels = defaultingCounter();
    this.services = new Map();
    this.statusClasses = defaultingCounter();
    this.paths = new Map();
    this.users = new Map();
    this.latencies = [];
    this.totalBytes = 0n;
    this.perMinute = new Map();
    this.count = 0;
  }
  _write(r, _enc, cb) {
    this.count++;
    this.levels[r.level] = this.levels[r.level] + 1;
    this.statusClasses[`${Math.floor(r.status / 100)}xx`] += 1;
    const s = this.services.get(r.svc) ?? { n: 0, errors: 0, lat: 0, max: 0 };
    s.n++; s.lat += r.lat; s.max = Math.max(s.max, r.lat); if (r.status >= 500) s.errors++;
    this.services.set(r.svc, s);
    const key = `${r.method} ${r.path}`;
    this.paths.set(key, (this.paths.get(key) ?? 0) + 1);
    const u = this.users.get(r.user) ?? { n: 0, bytes: 0, events: [] };
    u.n++; u.bytes += r.bytes; u.events.push(r.t);
    this.users.set(r.user, u);
    this.latencies.push(r.lat);
    this.totalBytes += BigInt(r.bytes);
    const minute = r.time.slice(0, 5);
    const pm = this.perMinute.get(minute) ?? { n: 0, err: 0 };
    pm.n++; if (r.level === 'ERROR') pm.err++;
    this.perMinute.set(minute, pm);
    cb();
  }
  percentile(p) {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  }
}

function sessionize(events, gap) {
  const sessions = [];
  let cur = null;
  for (const t of events) {
    if (!cur || t - cur.end > gap) { cur = { start: t, end: t, n: 1 }; sessions.push(cur); }
    else { cur.end = t; cur.n++; }
  }
  return sessions;
}

function bar(n, max, width) { return '#'.repeat(Math.max(n ? 1 : 0, Math.round((n / max) * width))); }

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------
async function writeLogFile(file, seed, count) {
  async function* source() {
    let n = 0;
    for (const line of generateLogLines(seed, count)) {
      if (++n % 250 === 0) await new Promise((r) => setImmediate(r));
      yield line + '\n';
    }
  }
  await pipelineAsync(Readable.from(source()), fs.createWriteStream(file));
  return fs.statSync(file).size;
}

async function analyse(file) {
  const events = new EventEmitter();
  const malformedSamples = [];
  events.on('malformed', (line) => { if (malformedSamples.length < 3) malformedSamples.push(line); });
  const splitter = new LineSplitter();
  const parser = new LogParser(events);
  const agg = new Aggregator();
  const tap = new HashTap('raw-tap');
  await pipelineAsync(fs.createReadStream(file, { highWaterMark: 1000 }), tap, splitter, parser, agg);
  return { splitter, parser, agg, tap: tap.result(), malformedSamples };
}

function report(res) {
  const { splitter, parser, agg, tap, malformedSamples } = res;
  console.log('== parse ==');
  console.log(`lines=${splitter.processed} parsed=${parser.processed} malformed=${parser.malformed}`);
  for (const l of malformedSamples) console.log(`  malformed: ${l}`);
  console.log(`raw sha256=${tap.sha256.slice(0, 24)} crc32=${tap.crc} bytes=${tap.bytes}`);

  console.log('== levels ==');
  const maxLevel = Math.max(...LEVELS.map(([l]) => agg.levels[l]));
  for (const [l] of LEVELS) console.log(`  ${l.padEnd(6)} ${String(agg.levels[l]).padStart(5)} ${bar(agg.levels[l], maxLevel, 30)}`);
  console.log(`  TRACE  ${String(agg.levels.TRACE).padStart(5)} (proxy default)`);

  console.log('== status classes ==');
  for (const k of Object.keys(agg.statusClasses).sort()) console.log(`  ${k} ${agg.statusClasses[k]}`);

  console.log('== services ==');
  for (const [svc, s] of [...agg.services].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const avg = (s.lat / s.n).toFixed(1);
    const errRate = ((s.errors / s.n) * 100).toFixed(2);
    console.log(`  ${svc.padEnd(8)} n=${String(s.n).padStart(4)} avg=${avg.padStart(6)}ms max=${String(s.max).padStart(4)}ms err=${errRate}%`);
  }

  console.log('== top endpoints ==');
  const top = [...agg.paths].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
  top.forEach(([k, v], i) => console.log(`  ${i + 1}. ${k.padEnd(22)} ${v}`));

  console.log('== latency ==');
  for (const p of [50, 90, 95, 99, 100]) console.log(`  p${String(p).padEnd(3)} ${agg.percentile(p)}ms`);
  console.log(`  total bytes=${agg.totalBytes} (bigint) avg=${agg.totalBytes / BigInt(agg.count)}`);

  console.log('== users ==');
  const users = [...agg.users].sort((a, b) => b[1].bytes - a[1].bytes || (a[0] < b[0] ? -1 : 1));
  for (const [u, info] of users.slice(0, 5)) {
    const sessions = sessionize(info.events, 120);
    const longest = sessions.reduce((m, s) => (s.end - s.start > m.end - m.start ? s : m), sessions[0]);
    console.log(`  ${u.padEnd(4)} req=${String(info.n).padStart(3)} bytes=${String(info.bytes).padStart(7)} sessions=${sessions.length} longest=${longest.end - longest.start}s/${longest.n}req`);
  }

  console.log('== error spikes ==');
  let spike = null;
  const minutes = [...agg.perMinute].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  scan: for (let i = 0; i + 2 < minutes.length; i++) {
    let errs = 0;
    for (let j = i; j < i + 3; j++) {
      if (minutes[j][1].n < 3) continue scan;
      errs += minutes[j][1].err;
    }
    if (errs >= 6) { spike = { from: minutes[i][0], to: minutes[i + 2][0], errs }; break scan; }
  }
  console.log(`  first 3-minute window with >=6 errors: ${JSON.stringify(spike)}`);
  const worst = minutes.reduce((m, x) => (x[1].err > m[1].err ? x : m), minutes[0]);
  console.log(`  worst minute ${worst[0]} errors=${worst[1].err}/${worst[1].n}`);
  console.log(`  minutes observed=${minutes.length}`);
}

async function extractErrors(file, outGz) {
  const splitter = new LineSplitter();
  const parser = new LogParser(null);
  const filter = new Filter('errors', (r) => r.level === 'ERROR' || r.status >= 500);
  const ser = new Serializer();
  const plainTap = new HashTap('plain');
  await pipelineAsync(fs.createReadStream(file), splitter, parser, filter, ser, plainTap, zlib.createGzip({ level: 6 }), fs.createWriteStream(outGz));
  return { kept: filter.processed, plain: plainTap.result() };
}

async function roundTrip(gzFile) {
  const tap = new HashTap('gunzip');
  const chunks = [];
  const collector = new Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb(); } });
  await pipelineAsync(fs.createReadStream(gzFile), zlib.createGunzip(), tap, collector);
  return { tap: tap.result(), text: Buffer.concat(chunks).toString('utf8') };
}

async function countWithForAwait(gzFile) {
  const stream = fs.createReadStream(gzFile).pipe(zlib.createGunzip()).pipe(new LineSplitter());
  const bySvc = {};
  let n = 0;
  for await (const line of stream) {
    const [, , svc] = line.split(' ');
    bySvc[svc] = (bySvc[svc] ?? 0) + 1;
    n++;
  }
  return { n, bySvc };
}

function bufferCodecs(text) {
  const raw = Buffer.from(text);
  const results = [];
  const codecs = [
    ['deflate', zlib.deflateSync, zlib.inflateSync],
    ['deflateRaw', zlib.deflateRawSync, zlib.inflateRawSync],
    ['gzip', zlib.gzipSync, zlib.gunzipSync],
    ['brotli', zlib.brotliCompressSync, zlib.brotliDecompressSync],
  ];
  for (const [name, enc, dec] of codecs) {
    const packed = enc(raw);
    const back = dec(packed);
    results.push({ name, ok: back.equals(raw), smaller: packed.length < raw.length, crc: hex8(Crc32.of(back)) });
  }
  return results;
}

// framed record file: [u32 len][u32 crc][payload] records
function writeFramed(file, records) {
  const parts = [];
  for (const rec of records) {
    const payload = Buffer.from(JSON.stringify(rec));
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(payload.length, 0);
    hdr.writeUInt32BE(Crc32.of(payload), 4);
    parts.push(hdr, payload);
  }
  const all = Buffer.concat(parts);
  fs.writeFileSync(file, all);
  return all.length;
}

function* readFramed(buf) {
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), crc = buf.readUInt32BE(off + 4);
    const payload = buf.subarray(off + 8, off + 8 + len);
    if (payload.length < len) { yield { error: 'truncated', at: off }; return; }
    if (Crc32.of(payload) !== crc) { yield { error: 'crc', at: off }; off += 8 + len; continue; }
    yield { value: JSON.parse(payload.toString()) };
    off += 8 + len;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcorp-'));
  try {
    console.log('== self-test ==');
    console.log(`crc32("123456789")=${hex8(Crc32.of(Buffer.from('123456789')))} adler32("Wikipedia")=${hex8(adler32(Buffer.from('Wikipedia')))}`);
    console.log(`fnv1a64("hello")=${fnv1a64('hello').toString(16)}`);

    const logFile = path.join(tmp, 'access.log');
    const size = await writeLogFile(logFile, 1337, 2400);
    const content = fs.readFileSync(logFile);
    console.log(`wrote log: ${size} bytes, sha1=${crypto.createHash('sha1').update(content).digest('hex')}`);
    console.log(`adler32=${hex8(adler32(content))} fnv=${fnv1a64(content.toString()).toString(16)}`);

    const res = await analyse(logFile);
    report(res);

    console.log('== error extraction + gzip ==');
    const gz = path.join(tmp, 'errors.log.gz');
    const { kept, plain } = await extractErrors(logFile, gz);
    const gzSize = fs.statSync(gz).size;
    console.log(`kept=${kept} plainBytes=${plain.bytes} compressedSmaller=${gzSize < plain.bytes}`);
    const gzHead = fs.readFileSync(gz).subarray(0, 3);
    console.log(`gzip magic=${gzHead.toString('hex')}`);
    const rt = await roundTrip(gz);
    console.log(`roundtrip sha256 match=${rt.tap.sha256 === plain.sha256} crc match=${rt.tap.crc === plain.crc} crc=${rt.tap.crc}`);
    const firstLines = rt.text.split('\n').slice(0, 4);
    for (const l of firstLines) console.log(`  | ${l}`);
    const fa = await countWithForAwait(gz);
    console.log(`for-await lines=${fa.n} by service=${JSON.stringify(Object.fromEntries(Object.entries(fa.bySvc).sort()))}`);

    console.log('== buffer codecs ==');
    for (const r of bufferCodecs(rt.text)) console.log(`  ${r.name.padEnd(10)} ok=${r.ok} smaller=${r.smaller} crc=${r.crc}`);

    console.log('== framed summary file ==');
    const summary = [...res.agg.services].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([svc, s]) => ({ svc, n: s.n, errors: s.errors }));
    const framedFile = path.join(tmp, 'summary.bin');
    const framedLen = writeFramed(framedFile, summary);
    const framed = fs.readFileSync(framedFile);
    const corrupted = Buffer.from(framed);
    corrupted[12] ^= 0xff;
    const truncated = framed.subarray(0, framed.length - 5);
    console.log(`framed bytes=${framedLen}`);
    for (const [name, buf] of [['clean', framed], ['corrupted', corrupted], ['truncated', truncated]]) {
      const out = [...readFramed(buf)].map((x) => (x.error ? `!${x.error}@${x.at}` : x.value.svc));
      console.log(`  ${name.padEnd(9)} ${out.join(' ')}`);
    }

    console.log('== pass-through fan-out ==');
    const pass = new PassThrough();
    const counts = { a: 0, b: 0 };
    const sinkA = new Writable({ write(c, _e, cb) { counts.a += c.length; cb(); } });
    const sinkB = new Writable({ write(c, _e, cb) { counts.b += c.toString().split('\n').length - 1; cb(); } });
    pass.pipe(sinkA); pass.pipe(sinkB);
    const done = Promise.all([new Promise((r) => sinkA.on('finish', r)), new Promise((r) => sinkB.on('finish', r))]);
    Readable.from(rt.text.split('\n').slice(0, 50).map((l) => l + '\n')).pipe(pass);
    await done;
    console.log(`  fan-out bytes=${counts.a} lines=${counts.b}`);

    console.log('== stage registry ==');
    console.log(`  ${[...Stage.registry.keys()].sort().join(',')}`);

    const errored = new LogParser(null);
    try {
      await pipelineAsync(Readable.from(['ok']), errored, new Writable({ objectMode: true, write(_c, _e, cb) { cb(new Error('sink refused')); } }));
      console.log(`  malformed-only input finished cleanly, malformed=${errored.malformed}`);
    } catch (err) {
      console.log(`  pipeline error propagated: ${err.message}`);
    }
    try {
      await pipelineAsync(Readable.from(['2024-03-01T08:00:00Z INFO [auth] GET /x 200 1ms bytes=1 user=u1']), new LogParser(null), new Writable({ objectMode: true, write(_c, _e, cb) { cb(new Error('sink refused')); } }));
    } catch (err) {
      console.log(`  pipeline error propagated: ${err.message}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`temp dir removed: ${!fs.existsSync(tmp)}`);
  }
}

process.on('exit', (code) => console.log(`exit ${code}`));
main().catch((err) => { console.log(`fatal ${err.message}`); process.exitCode = 1; });
