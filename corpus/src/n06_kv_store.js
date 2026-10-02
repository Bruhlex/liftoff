'use strict';
// Key-value store on an append-only log file with CRC-checked binary records, compaction,
// crash-recovery simulation and a line-based TCP protocol (server + client in one process).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { Readable, Transform, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(...bufs) {
  let c = 0xFFFFFFFF;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// record codec
// ---------------------------------------------------------------------------
const MAGIC = 0xA5;
const HEADER = 12;
const OP = Object.freeze({ PUT: 1, DEL: 2 });
const OP_NAMES = { 1: 'PUT', 2: 'DEL' };

function encodeRecord(op, key, value) {
  const k = Buffer.from(key, 'utf8');
  const v = value == null ? Buffer.alloc(0) : Buffer.from(value, 'utf8');
  const hdr = Buffer.alloc(HEADER);
  hdr.writeUInt8(MAGIC, 0);
  hdr.writeUInt8(op, 1);
  hdr.writeUInt16BE(k.length, 2);
  hdr.writeUInt32BE(v.length, 4);
  hdr.writeUInt32BE(crc32(hdr.subarray(1, 8), k, v), 8);
  return Buffer.concat([hdr, k, v]);
}

function* decodeRecords(buf) {
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < HEADER) return yield { corrupt: 'short-header', off };
    if (buf[off] !== MAGIC) return yield { corrupt: 'bad-magic', off };
    const op = buf[off + 1], kl = buf.readUInt16BE(off + 2), vl = buf.readUInt32BE(off + 4), crc = buf.readUInt32BE(off + 8);
    const end = off + HEADER + kl + vl;
    if (end > buf.length) return yield { corrupt: 'short-body', off };
    const k = buf.subarray(off + HEADER, off + HEADER + kl), v = buf.subarray(off + HEADER + kl, end);
    if (crc32(buf.subarray(off + 1, off + 8), k, v) !== crc) return yield { corrupt: 'crc', off };
    yield { op, key: k.toString('utf8'), value: op === OP.PUT ? v.toString('utf8') : null, off, len: end - off, voff: off + HEADER + kl, vlen: vl };
    off = end;
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------
class StoreError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

class KVStore extends EventEmitter {
  static COMPACT_RATIO;
  static { KVStore.COMPACT_RATIO = 0.6; }
  #file; #fd = null; #size = 0; #index = new Map(); #dead = 0; #ops = 0; #versions = new Map();
  constructor(file) { super(); this.#file = file; }
  get size() { return this.#size; }
  get count() { return this.#index.size; }
  get deadBytes() { return this.#dead; }
  get ops() { return this.#ops; }
  get isOpen() { return this.#fd !== null; }

  open() {
    if (!fs.existsSync(this.#file)) fs.writeFileSync(this.#file, Buffer.alloc(0));
    const buf = fs.readFileSync(this.#file);
    let validEnd = 0, replayed = 0, corrupt = null;
    this.#index.clear(); this.#dead = 0;
    for (const rec of decodeRecords(buf)) {
      if (rec.corrupt) { corrupt = rec; break; }
      this.#apply(rec);
      replayed++;
      validEnd = rec.off + rec.len;
    }
    if (corrupt) {
      fs.truncateSync(this.#file, validEnd);
      this.emit('recovered', { reason: corrupt.corrupt, at: corrupt.off, dropped: buf.length - validEnd, replayed });
    }
    this.#fd = fs.openSync(this.#file, 'r+');
    this.#size = validEnd;
    return { replayed, keys: this.#index.size };
  }
  #apply(rec) {
    const prev = this.#index.get(rec.key);
    if (prev) this.#dead += prev.len;
    if (rec.op === OP.PUT) {
      this.#index.set(rec.key, { off: rec.off, len: rec.len, voff: rec.voff, vlen: rec.vlen });
      this.#versions.set(rec.key, (this.#versions.get(rec.key) ?? 0) + 1);
    } else {
      this.#index.delete(rec.key);
      this.#dead += rec.len;
    }
  }
  #append(op, key, value) {
    if (!this.isOpen) throw new StoreError('ECLOSED', 'store closed');
    const rec = encodeRecord(op, key, value);
    fs.writeSync(this.#fd, rec, 0, rec.length, this.#size);
    const kl = Buffer.byteLength(key);
    this.#apply({ op, key, off: this.#size, len: rec.length, voff: this.#size + HEADER + kl, vlen: rec.length - HEADER - kl });
    this.#size += rec.length;
    this.#ops++;
    this.#maybeCompact();
  }
  #maybeCompact() {
    if (this.#size > 2048 && this.#dead / this.#size > KVStore.COMPACT_RATIO) {
      const r = this.compact();
      this.emit('autocompact', r);
    }
  }
  get(key) {
    const e = this.#index.get(key);
    if (!e) return null;
    const buf = Buffer.alloc(e.vlen);
    fs.readSync(this.#fd, buf, 0, e.vlen, e.voff);
    return buf.toString('utf8');
  }
  version(key) { return this.#index.has(key) ? this.#versions.get(key) : 0; }
  set(key, value) { this.#append(OP.PUT, key, String(value)); return true; }
  del(key) { if (!this.#index.has(key)) return false; this.#append(OP.DEL, key, null); return true; }
  incr(key, by = 1n) {
    const cur = this.get(key);
    if (cur !== null && !/^-?\d+$/.test(cur)) throw new StoreError('ENOTINT', 'value is not an integer');
    const next = BigInt(cur ?? '0') + BigInt(by);
    this.set(key, next.toString());
    return next;
  }
  cas(key, expectVersion, value) {
    if (this.version(key) !== expectVersion) return false;
    this.set(key, value);
    return true;
  }
  keys(pattern = '*') {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return [...this.#index.keys()].filter((k) => re.test(k)).sort();
  }
  *entries() { for (const k of [...this.#index.keys()].sort()) yield [k, this.get(k)]; }
  compact() {
    const before = this.#size;
    const tmp = this.#file + '.compact';
    const parts = [];
    for (const [k, v] of this.entries()) parts.push(encodeRecord(OP.PUT, k, v));
    const buf = Buffer.concat(parts);
    fs.writeFileSync(tmp, buf);
    fs.closeSync(this.#fd);
    fs.renameSync(tmp, this.#file);
    const versions = new Map(this.#versions);
    this.#fd = null;
    this.open();
    this.#versions = versions;
    this.emit('compacted', { before, after: this.#size });
    return { before, after: this.#size };
  }
  close() { if (this.#fd !== null) { fs.closeSync(this.#fd); this.#fd = null; } }
}

// ---------------------------------------------------------------------------
// protocol: inline commands, RESP-like replies
// ---------------------------------------------------------------------------
const reply = {
  ok: (s = 'OK') => `+${s}\r\n`,
  err: (code, msg) => `-${code} ${msg}\r\n`,
  int: (n) => `:${n}\r\n`,
  bulk: (s) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`),
  array: (items) => `*${items.length}\r\n` + items.map((x) => reply.bulk(x)).join(''),
};

const KEY_RE = /^[A-Za-z0-9:_\-.]{1,64}$/;

class Session {
  static #nextId = 1;
  #buf = ''; #queue = null;
  constructor(server, socket) {
    this.id = Session.#nextId++;
    this.server = server;
    this.socket = socket;
    this.commands = 0;
    socket.setEncoding('utf8');
    socket.on('data', (d) => this.#onData(d));
    socket.on('error', () => {});
  }
  #onData(d) {
    this.#buf += d;
    let idx;
    while ((idx = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, idx).replace(/\r$/, '');
      this.#buf = this.#buf.slice(idx + 1);
      if (line.length) this.#handle(line);
    }
  }
  #handle(line) {
    this.commands++;
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
    const cmd = m[1].toUpperCase(), rest = m[2] ?? '';
    if (this.#queue && !['EXEC', 'DISCARD', 'MULTI'].includes(cmd)) {
      this.#queue.push([cmd, rest]);
      this.socket.write(reply.ok('QUEUED'));
      return;
    }
    switch (cmd) {
      case 'MULTI':
        if (this.#queue) { this.socket.write(reply.err('ERR', 'nested MULTI')); return; }
        this.#queue = []; this.socket.write(reply.ok()); return;
      case 'DISCARD':
        if (!this.#queue) { this.socket.write(reply.err('ERR', 'DISCARD without MULTI')); return; }
        this.#queue = null; this.socket.write(reply.ok()); return;
      case 'EXEC': {
        if (!this.#queue) { this.socket.write(reply.err('ERR', 'EXEC without MULTI')); return; }
        const q = this.#queue; this.#queue = null;
        const outs = q.map(([c, r]) => this.server.execute(c, r, this));
        this.socket.write(`*${outs.length}\r\n` + outs.join(''));
        return;
      }
      case 'QUIT':
        this.socket.end(reply.ok('BYE'));
        return;
      default:
        this.socket.write(this.server.execute(cmd, rest, this));
    }
  }
}

class KVServer extends EventEmitter {
  #store; #server; #sessions = new Set(); #handlers = new Map(); #served = 0;
  constructor(store) {
    super();
    this.#store = store;
    this.#server = net.createServer((sock) => {
      const s = new Session(this, sock);
      this.#sessions.add(s);
      this.emit('session', s.id);
      sock.on('close', () => { this.#sessions.delete(s); this.emit('session-end', s.id, s.commands); });
    });
    this.#register();
  }
  get served() { return this.#served; }
  #register() {
    const st = this.#store;
    const needKey = (fn) => (args, sess) => {
      const [key, ...rest] = args.split(' ');
      if (!KEY_RE.test(key ?? '')) return reply.err('EKEY', 'invalid key');
      return fn(key, rest.join(' '), sess);
    };
    this.#handlers.set('PING', (a) => reply.ok(a ? a : 'PONG'));
    this.#handlers.set('SET', needKey((k, v) => (v === '' ? reply.err('EARG', 'missing value') : (st.set(k, v), reply.ok()))));
    this.#handlers.set('GET', needKey((k) => reply.bulk(st.get(k))));
    this.#handlers.set('DEL', needKey((k) => reply.int(st.del(k) ? 1 : 0)));
    this.#handlers.set('INCR', needKey((k, by) => reply.int(st.incr(k, by ? BigInt(by) : 1n))));
    this.#handlers.set('VER', needKey((k) => reply.int(st.version(k))));
    this.#handlers.set('CAS', needKey((k, rest) => {
      const m = /^(\d+)\s+(.+)$/.exec(rest);
      if (!m) return reply.err('EARG', 'CAS key version value');
      return reply.int(st.cas(k, Number(m[1]), m[2]) ? 1 : 0);
    }));
    this.#handlers.set('KEYS', (a) => reply.array(st.keys(a || '*')));
    this.#handlers.set('MGET', (a) => reply.array(a.split(/\s+/).map((k) => st.get(k))));
    this.#handlers.set('MSET', (a) => {
      const parts = a.split(/\s+/);
      if (parts.length % 2) return reply.err('EARG', 'MSET needs pairs');
      for (let i = 0; i < parts.length; i += 2) {
        if (!KEY_RE.test(parts[i])) return reply.err('EKEY', `invalid key at ${i}`);
      }
      for (let i = 0; i < parts.length; i += 2) st.set(parts[i], parts[i + 1]);
      return reply.int(parts.length / 2);
    });
    this.#handlers.set('STATS', () => reply.bulk(JSON.stringify({ keys: st.count, bytes: st.size, dead: st.deadBytes, ops: st.ops })));
    this.#handlers.set('COMPACT', () => { const r = st.compact(); return reply.bulk(`${r.before}->${r.after}`); });
    this.#handlers.set('DIGEST', () => {
      const h = crypto.createHash('sha256');
      for (const [k, v] of st.entries()) h.update(`${k}=${v}\n`);
      return reply.bulk(h.digest('hex').slice(0, 20));
    });
  }
  execute(cmd, args, sess) {
    this.#served++;
    const h = this.#handlers.get(cmd);
    if (!h) return reply.err('EUNKNOWN', `unknown command '${cmd.toLowerCase()}'`);
    try { return h(args, sess); } catch (err) { return reply.err(err.code ?? 'ERR', err.message); }
  }
  listen() {
    return new Promise((resolve) => this.#server.listen(0, '127.0.0.1', () => resolve(this.#server.address().port)));
  }
  async close() {
    const closed = new Promise((resolve) => this.#server.close(() => resolve()));
    while (this.#sessions.size) await once(this, 'session-end');
    await closed;
  }
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------
function parseReply(buf, off = 0) {
  const nl = buf.indexOf('\r\n', off);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[off]);
  const line = buf.toString('utf8', off + 1, nl);
  const next = nl + 2;
  switch (type) {
    case '+': return { value: { ok: line }, end: next };
    case '-': { const [code, ...msg] = line.split(' '); return { value: { error: code, message: msg.join(' ') }, end: next }; }
    case ':': return { value: BigInt(line), end: next };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, end: next };
      if (buf.length < next + len + 2) return null;
      return { value: buf.toString('utf8', next, next + len), end: next + len + 2 };
    }
    case '*': {
      const n = Number(line);
      const items = [];
      let pos = next;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, pos);
        if (!r) return null;
        items.push(r.value);
        pos = r.end;
      }
      return { value: items, end: pos };
    }
    default: throw new Error(`protocol error: ${type}`);
  }
}

class KVClient extends EventEmitter {
  #sock = null; #buf = Buffer.alloc(0); #pending = [];
  constructor(name) { super(); this.name = name; }
  connect(port) {
    return new Promise((resolve, reject) => {
      this.#sock = net.connect(port, '127.0.0.1', () => resolve(this));
      this.#sock.once('error', reject);
      this.#sock.on('data', (d) => this.#onData(d));
      this.#sock.on('close', () => this.emit('closed'));
    });
  }
  #onData(d) {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (!this.#pending.length || !this.#buf.length) break;
      const r = parseReply(this.#buf);
      if (!r) break;
      this.#buf = this.#buf.subarray(r.end);
      this.#pending.shift()(r.value);
    }
  }
  send(line) {
    return new Promise((resolve) => { this.#pending.push(resolve); this.#sock.write(line + '\r\n'); });
  }
  pipeline(lines) {
    const ps = lines.map((l) => new Promise((resolve) => this.#pending.push(resolve)));
    this.#sock.write(lines.map((l) => l + '\r\n').join(''));
    return Promise.all(ps);
  }
  async quit() {
    const closed = once(this, 'closed');
    const r = await this.send('QUIT');
    await closed;
    return r;
  }
}

function fmt(v) {
  if (v === null) return '(nil)';
  if (typeof v === 'bigint') return `(integer) ${v}`;
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (typeof v === 'object') return v.ok !== undefined ? v.ok : `(error ${v.error}) ${v.message}`;
  return JSON.stringify(v);
}

async function run(client, line) {
  const r = await client.send(line);
  console.log(`${client.name}> ${line.length > 60 ? line.slice(0, 57) + '...' : line}  =>  ${fmt(r)}`);
  return r;
}

// ---------------------------------------------------------------------------
// snapshot export via streams
// ---------------------------------------------------------------------------
class SnapshotEncoder extends Transform {
  #n = 0;
  constructor() { super({ writableObjectMode: true }); }
  _transform([k, v], _e, cb) { this.#n++; cb(null, `${JSON.stringify(k)}\t${JSON.stringify(v)}\n`); }
  _flush(cb) { this.push(`#end ${this.#n}\n`); cb(); }
}

async function* storeEntriesAsync(store) {
  for (const e of store.entries()) { await new Promise((r) => setImmediate(r)); yield e; }
}

async function exportSnapshot(store, file) {
  await pipelineAsync(Readable.from(storeEntriesAsync(store)), new SnapshotEncoder(), fs.createWriteStream(file));
  const data = fs.readFileSync(file);
  return { bytes: data.length, sha: crypto.createHash('sha1').update(data).digest('hex').slice(0, 16), lines: data.toString().trim().split('\n').length };
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
function attachStoreLog(store) {
  store.on('recovered', (r) => console.log(`[store] recovered: ${JSON.stringify(r)}`));
  store.on('compacted', (r) => console.log(`[store] compacted ${r.before} -> ${r.after} bytes`));
  store.on('autocompact', () => console.log('[store] (auto compaction triggered)'));
}

async function phaseOne(dbFile) {
  console.log('== phase 1: basic protocol ==');
  const store = new KVStore(dbFile);
  attachStoreLog(store);
  console.log(`open: ${JSON.stringify(store.open())}`);
  const server = new KVServer(store);
  const sessions = [];
  server.on('session', (id) => sessions.push(`+${id}`));
  server.on('session-end', (id, n) => sessions.push(`-${id}(${n})`));
  const port = await server.listen();
  const alice = await new KVClient('alice').connect(port);
  const bob = await new KVClient('bob').connect(port);

  await run(alice, 'PING');
  await run(alice, 'PING hello there');
  await run(alice, 'SET user:1 Ada Lovelace');
  await run(alice, 'SET user:2 Alan Turing');
  await run(alice, 'SET user:3 Grace Hopper');
  await run(bob, 'GET user:2');
  await run(bob, 'GET user:99');
  await run(alice, 'SET greet héllo wörld ✓');
  await run(bob, 'GET greet');
  await run(alice, 'INCR counter');
  await run(alice, 'INCR counter 41');
  await run(bob, 'INCR counter 9007199254740993');
  await run(bob, 'INCR user:1');
  await run(alice, 'KEYS user:*');
  await run(alice, 'KEYS *e*');
  await run(bob, 'DEL user:3');
  await run(bob, 'DEL user:3');
  await run(alice, 'SET bad/key x');
  await run(alice, 'SET lonely');
  await run(alice, 'FLY me to the moon');
  await run(alice, 'MSET a 1 b 2 c 3');
  await run(alice, 'MSET a 1 b');
  await run(bob, 'MGET a b c nope');
  await run(alice, 'VER user:1');
  await run(alice, 'CAS user:1 1 Augusta Ada King');
  await run(bob, 'CAS user:1 1 stale write');
  await run(bob, 'VER user:1');
  await run(bob, 'GET user:1');

  console.log('-- transaction --');
  await run(alice, 'MULTI');
  await run(alice, 'SET tx:a alpha');
  await run(alice, 'INCR tx:n 5');
  await run(alice, 'GET tx:a');
  await run(bob, 'GET tx:a');
  await run(alice, 'EXEC');
  await run(alice, 'MULTI');
  await run(alice, 'SET tx:b never');
  await run(alice, 'DISCARD');
  await run(alice, 'GET tx:b');
  await run(alice, 'EXEC');

  console.log('-- pipelined --');
  const cmds = [];
  for (let i = 0; i < 8; i++) cmds.push(i % 3 === 2 ? `GET p:${i - 1}` : `SET p:${i} v${i * i}`);
  const results = await bob.pipeline(cmds);
  cmds.forEach((c, i) => console.log(`  ${c.padEnd(12)} => ${fmt(results[i])}`));

  console.log('-- churn to create dead bytes --');
  for (let round = 0; round < 3; round++) {
    const batch = [];
    for (let i = 0; i < 20; i++) batch.push(`SET churn:${i % 5} round${round}-item${i}-${'x'.repeat(i)}`);
    await alice.pipeline(batch);
  }
  await run(alice, 'STATS');
  await run(alice, 'COMPACT');
  await run(alice, 'STATS');
  await run(bob, 'GET churn:4');
  const digest = await run(bob, 'DIGEST');

  console.log(`alice quit: ${fmt(await alice.quit())}`);
  console.log(`bob quit: ${fmt(await bob.quit())}`);
  await server.close();
  console.log(`sessions: ${sessions.join(' ')} commands served=${server.served}`);
  store.close();
  return digest;
}

function phaseTwoCrash(dbFile) {
  console.log('== phase 2: crash recovery ==');
  const cleanSize = fs.statSync(dbFile).size;
  // simulate a torn write: full record + half of another
  const tail1 = encodeRecord(OP.PUT, 'late:1', 'written before crash');
  const tail2 = encodeRecord(OP.PUT, 'late:2', 'torn write that never finished');
  fs.appendFileSync(dbFile, Buffer.concat([tail1, tail2.subarray(0, 15)]));
  console.log(`appended ${tail1.length} + 15 bytes (torn)`);
  const s1 = new KVStore(dbFile);
  attachStoreLog(s1);
  const r1 = s1.open();
  console.log(`reopen: replayed=${r1.replayed} keys=${r1.keys} size=${s1.size - cleanSize} bytes past clean end`);
  console.log(`late:1=${JSON.stringify(s1.get('late:1'))} late:2=${JSON.stringify(s1.get('late:2'))}`);
  s1.set('after:crash', 'ok');
  s1.close();

  // flip a byte inside the last record's value -> CRC failure
  const buf = fs.readFileSync(dbFile);
  buf[buf.length - 1] ^= 0x20;
  fs.writeFileSync(dbFile, buf);
  const s2 = new KVStore(dbFile);
  attachStoreLog(s2);
  const r2 = s2.open();
  console.log(`after bit flip: replayed=${r2.replayed} keys=${r2.keys} after:crash=${JSON.stringify(s2.get('after:crash'))}`);

  // bad magic in the middle: scan everything and report where it stops
  const raw = fs.readFileSync(dbFile);
  const offsets = [];
  for (const rec of decodeRecords(raw)) { if (rec.corrupt) break; offsets.push(rec.off); }
  const victim = offsets[Math.floor(offsets.length / 2)];
  const damaged = Buffer.from(raw);
  damaged[victim] = 0x00;
  const scan = [...decodeRecords(damaged)];
  const last = scan[scan.length - 1];
  console.log(`damaged scan: ${scan.length - 1} good records then ${last.corrupt ?? 'none'} (victim is record #${offsets.indexOf(victim)})`);
  const ops = { PUT: 0, DEL: 0 };
  for (const rec of decodeRecords(raw)) ops[OP_NAMES[rec.op]]++;
  console.log(`record ops in file: ${JSON.stringify(ops)}`);
  s2.close();
}

async function phaseThree(dbFile, tmp, digestBefore) {
  console.log('== phase 3: restart server on recovered file ==');
  const store = new KVStore(dbFile);
  attachStoreLog(store);
  store.open();
  const server = new KVServer(store);
  const port = await server.listen();
  const carol = await new KVClient('carol').connect(port);
  await run(carol, 'GET user:1');
  await run(carol, 'GET late:1');
  await run(carol, 'DEL late:1');
  const d = await run(carol, 'DIGEST');
  console.log(`digest matches phase 1: ${d === digestBefore}`);
  await run(carol, 'KEYS p:*');
  await run(carol, 'MGET p:0 p:1 p:3');

  console.log('-- auto compaction --');
  for (let r = 0; r < 12; r++) {
    const batch = [];
    for (let i = 0; i < 10; i++) batch.push(`SET hot:${i % 2} ${'y'.repeat(20 + r)}-${i}`);
    await carol.pipeline(batch);
  }
  await run(carol, 'GET hot:1');
  const stats = JSON.parse(await carol.send('STATS'));
  console.log(`stats after churn: keys=${stats.keys} threshold respected: ${stats.bytes <= 2048 || stats.dead / stats.bytes <= KVStore.COMPACT_RATIO}`);
  console.log(`carol quit: ${fmt(await carol.quit())}`);
  await server.close();

  console.log('-- snapshot export --');
  const snap = await exportSnapshot(store, path.join(tmp, 'snapshot.tsv'));
  console.log(`snapshot: ${snap.lines} lines ${snap.bytes} bytes sha1=${snap.sha}`);
  const lines = fs.readFileSync(path.join(tmp, 'snapshot.tsv'), 'utf8').split('\n').filter(Boolean);
  for (const l of lines.slice(0, 5)) console.log(`  ${l}`);
  console.log(`  ... ${lines[lines.length - 1]}`);

  const bigTotal = store.keys('*').reduce((acc, k) => {
    const v = store.get(k);
    return /^-?\d+$/.test(v) ? acc + BigInt(v) : acc;
  }, 0n);
  console.log(`sum of integer values (bigint): ${bigTotal}`);
  store.close();
  try { store.set('x', 'y'); } catch (err) { console.log(`write after close: ${err.code}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcorp-'));
  try {
    const rec = encodeRecord(OP.PUT, 'k', 'v');
    console.log(`record layout: ${rec.length} bytes hex=${rec.toString('hex')}`);
    console.log(`crc32 check: ${crc32(Buffer.from('123456789')).toString(16)}`);
    const dbFile = path.join(tmp, 'data.log');
    const digest = await phaseOne(dbFile);
    phaseTwoCrash(dbFile);
    await phaseThree(dbFile, tmp, digest);
    console.log(`files left in temp dir: ${fs.readdirSync(tmp).sort().join(',')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

process.on('exit', (c) => console.log(`exit ${c}`));
main().catch((err) => { console.log(`fatal: ${err.stack}`); process.exitCode = 1; });
