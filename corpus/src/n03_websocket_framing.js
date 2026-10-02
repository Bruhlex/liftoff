'use strict';
// WebSocket-like protocol over raw TCP (net): RFC6455 handshake (sha1+base64 accept key),
// masked client frames, 7/16/64-bit payload lengths, fragmentation, ping/pong, close handshake.
const net = require('net');
const crypto = require('crypto');
const { Transform } = require('stream');
const { EventEmitter, once } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
const OP_NAMES = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// deterministic "random" source for nonces and masks
class DetRng {
  #state;
  constructor(seed) { this.#state = BigInt(seed) & 0xffffffffffffffffn; }
  nextU32() {
    // xorshift64*
    let x = this.#state;
    x ^= x >> 12n; x ^= (x << 25n) & 0xffffffffffffffffn; x ^= x >> 27n;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 32n);
  }
  bytes(n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i += 4) {
      const v = this.nextU32();
      for (let j = 0; j < 4 && i + j < n; j++) b[i + j] = (v >>> (24 - 8 * j)) & 0xff;
    }
    return b;
  }
}

// ---------------------------------------------------------------- frame codec
function applyMask(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
  return out;
}

function encodeFrame({ fin = true, opcode, payload = Buffer.alloc(0), mask = null, rsv = 0 }) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | ((rsv & 7) << 4) | (opcode & 0x0f);
  if (mask) {
    header[1] |= 0x80;
    return Buffer.concat([header, mask, applyMask(payload, mask)]);
  }
  return Buffer.concat([header, payload]);
}

class ProtocolError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

class FrameParser extends Transform {
  #buf = Buffer.alloc(0);
  #requireMask;
  #maxPayload;
  constructor({ requireMask, maxPayload = 1 << 20 }) {
    super({ readableObjectMode: true });
    this.#requireMask = requireMask;
    this.#maxPayload = maxPayload;
  }
  _transform(chunk, enc, cb) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    try {
      for (;;) {
        const f = this.#tryParse();
        if (!f) break;
        this.push(f);
      }
      cb();
    } catch (e) {
      cb(e);
    }
  }
  #tryParse() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = (b[0] >> 4) & 7;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (rsv) throw new ProtocolError(1002, 'reserved bits set');
    if (!(opcode in OP_NAMES)) throw new ProtocolError(1002, 'bad opcode ' + opcode);
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.#maxPayload)) throw new ProtocolError(1009, 'too big');
      len = Number(big); off = 10;
    }
    if (opcode >= 8 && (len > 125 || !fin)) throw new ProtocolError(1002, 'bad control frame');
    if (masked !== this.#requireMask) throw new ProtocolError(1002, masked ? 'unexpected mask' : 'mask required');
    if (len > this.#maxPayload) throw new ProtocolError(1009, 'too big');
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    const mask = masked ? b.subarray(off, off + 4) : null;
    let payload = b.subarray(off + maskLen, off + maskLen + len);
    if (mask) payload = applyMask(payload, mask);
    this.#buf = b.subarray(off + maskLen + len);
    return { fin, opcode, payload: Buffer.from(payload), wireLen: off + maskLen + len };
  }
}

// ---------------------------------------------------------------- connection (both sides)
class WsConnection extends EventEmitter {
  #socket;
  #isClient;
  #rng;
  #fragments = null;
  #state = 'open';
  #stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 };
  constructor(socket, { isClient, rng, maxPayload }) {
    super();
    this.#socket = socket;
    this.#isClient = isClient;
    this.#rng = rng;
    const parser = new FrameParser({ requireMask: !isClient, maxPayload });
    socket.pipe(parser);
    parser.on('data', (f) => this.#onFrame(f));
    parser.on('error', (e) => this.#fail(e.code || 1002, e.message));
    socket.on('close', () => {
      const was = this.#state;
      this.#state = 'closed';
      this.emit('closed', was);
    });
    socket.on('error', () => {});
  }
  get state() { return this.#state; }
  get stats() { return { ...this.#stats }; }
  #write(opcode, payload, fin = true) {
    if (this.#state === 'closed') return false;
    const frame = encodeFrame({ fin, opcode, payload, mask: this.#isClient ? this.#rng.bytes(4) : null });
    this.#stats.framesOut++;
    this.#stats.bytesOut += frame.length;
    this.#socket.write(frame);
    return true;
  }
  send(data) {
    const isText = typeof data === 'string';
    this.#write(isText ? OP.TEXT : OP.BINARY, isText ? Buffer.from(data, 'utf8') : data);
  }
  sendFragmented(text, pieceSize) {
    const buf = Buffer.from(text, 'utf8');
    const count = Math.max(1, Math.ceil(buf.length / pieceSize));
    for (let i = 0; i < count; i++) {
      this.#write(i === 0 ? OP.TEXT : OP.CONT, buf.subarray(i * pieceSize, (i + 1) * pieceSize), i === count - 1);
    }
    return count;
  }
  ping(data = '') { this.#write(OP.PING, Buffer.from(data)); }
  sendRaw(buf) { this.#socket.write(buf); }
  close(code = 1000, reason = '') {
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this.#write(OP.CLOSE, p);
  }
  #fail(code, reason) {
    this.emit('protocol-error', code, reason);
    if (this.#state === 'open') this.close(code, reason);
    this.#socket.end();
    this.#socket.resume();
  }
  #onFrame(f) {
    this.#stats.framesIn++;
    this.#stats.bytesIn += f.wireLen;
    switch (f.opcode) {
      case OP.PING:
        this.emit('ping', f.payload.toString());
        this.#write(OP.PONG, f.payload);
        return;
      case OP.PONG:
        this.emit('pong', f.payload.toString());
        return;
      case OP.CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.subarray(2).toString();
        this.emit('close-frame', code, reason);
        if (this.#state === 'open') {
          this.#state = 'closing';
          this.#write(OP.CLOSE, f.payload.subarray(0, 2));
        }
        if (this.#isClient) this.#socket.end(); else this.#socket.end();
        return;
      }
      case OP.CONT:
        if (!this.#fragments) return this.#fail(1002, 'unexpected continuation');
        this.#fragments.parts.push(f.payload);
        break;
      default:
        if (this.#fragments) return this.#fail(1002, 'interleaved data frame');
        this.#fragments = { opcode: f.opcode, parts: [f.payload] };
    }
    if (f.fin) {
      const { opcode, parts } = this.#fragments;
      this.#fragments = null;
      const data = Buffer.concat(parts);
      if (opcode === OP.TEXT) {
        const text = data.toString('utf8');
        if (Buffer.from(text, 'utf8').compare(data) !== 0) return this.#fail(1007, 'invalid utf8');
        this.emit('message', text, parts.length);
      } else this.emit('message', data, parts.length);
    }
  }
}

// ---------------------------------------------------------------- handshake
function parseHttpHead(text) {
  const [start, ...lines] = text.split('\r\n');
  const headers = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { start, headers };
}

function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.removeListener('data', onData);
      socket.pause();
      const rest = buf.subarray(idx + 4);
      if (rest.length) socket.unshift(rest);
      resolve(parseHttpHead(buf.subarray(0, idx).toString('latin1')));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

class WsServer extends EventEmitter {
  #server;
  #conns = new Set();
  #routes = new Map();
  constructor() {
    super();
    this.#server = net.createServer((s) => this.#accept(s));
  }
  route(pathname, handler) { this.#routes.set(pathname, handler); return this; }
  listen() { return new Promise((r) => this.#server.listen(0, '127.0.0.1', () => r(this.#server.address().port))); }
  async #accept(socket) {
    const head = await readHead(socket);
    const [method, target] = head.start.split(' ');
    const h = head.headers;
    const reject = (code, msg) => {
      socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      this.emit('rejected', target, code);
    };
    if (method !== 'GET') return reject(405, 'Method Not Allowed');
    if (!/\bupgrade\b/i.test(h.connection || '') || (h.upgrade || '').toLowerCase() !== 'websocket') return reject(426, 'Upgrade Required');
    if (h['sec-websocket-version'] !== '13') return reject(400, 'Bad Version');
    const key = h['sec-websocket-key'] || '';
    if (Buffer.from(key, 'base64').length !== 16) return reject(400, 'Bad Key');
    const handler = this.#routes.get(target);
    if (!handler) return reject(404, 'Not Found');
    const protocols = (h['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const chosen = protocols.find((p) => p === 'chat.v2') ?? protocols[0];
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`];
    if (chosen) lines.push(`Sec-WebSocket-Protocol: ${chosen}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    const conn = new WsConnection(socket, { isClient: false, maxPayload: 70000 });
    this.#conns.add(conn);
    conn.on('closed', () => this.#conns.delete(conn));
    socket.resume();
    handler(conn, { path: target, protocol: chosen ?? null });
  }
  get connectionCount() { return this.#conns.size; }
  close() { return new Promise((r) => this.#server.close(r)); }
}

async function connect(port, pathname, { protocols, rng, badKey, version = '13' } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const key = badKey ?? rng.bytes(16).toString('base64');
  const lines = [`GET ${pathname} HTTP/1.1`, 'Host: localhost', 'Upgrade: websocket', 'Connection: keep-alive, Upgrade', `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: ${version}`];
  if (protocols) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  const head = await readHead(socket);
  const status = Number(head.start.split(' ')[1]);
  if (status !== 101) {
    socket.destroy();
    return { status, conn: null };
  }
  const ok = head.headers['sec-websocket-accept'] === acceptKey(key);
  const conn = new WsConnection(socket, { isClient: true, rng, maxPayload: 1 << 20 });
  return { status, conn, acceptOk: ok, protocol: head.headers['sec-websocket-protocol'] ?? null };
}

// ---------------------------------------------------------------- helpers
function nextMessage(conn) {
  return new Promise((resolve) => conn.once('message', (m, parts) => resolve({ m, parts })));
}
function nextEvent(conn, ev) {
  return new Promise((resolve) => conn.once(ev, (...args) => resolve(args)));
}
const short = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);
const hex = (b) => b.toString('hex').replace(/(..)/g, '$1 ').trim();

// ---------------------------------------------------------------- application handlers
function echoHandler(conn) {
  conn.on('message', (m, parts) => {
    if (typeof m === 'string') conn.send(`echo(${parts}):${m}`);
    else {
      const sum = m.reduce((a, b) => (a + b) & 0xffff, 0);
      const out = Buffer.alloc(8);
      out.writeUInt32BE(m.length, 0);
      out.writeUInt32BE(sum, 4);
      conn.send(Buffer.concat([out, m.subarray(0, 4)]));
    }
  });
}

function makeRpcHandler() {
  const methods = {
    add: ({ a, b }) => a + b,
    upper: ({ s }) => s.toUpperCase(),
    fib: ({ n }) => { let [x, y] = [0n, 1n]; for (let i = 0; i < n; i++) [x, y] = [y, x + y]; return x.toString(); },
    sha: ({ s }) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16),
    fail: () => { throw new Error('requested failure'); },
  };
  return (conn, info) => {
    conn.on('message', async (m) => {
      let req;
      try { req = JSON.parse(m); } catch { return conn.send(JSON.stringify({ error: 'parse' })); }
      const fn = methods[req?.method];
      try {
        if (!fn) throw new Error('no method ' + req?.method);
        const result = await fn(req.params ?? {});
        conn.send(JSON.stringify({ id: req.id, result, proto: info.protocol }));
      } catch (e) {
        conn.send(JSON.stringify({ id: req.id, error: e.message }));
      }
    });
  };
}

function makeRoomHandler(roomLog) {
  const members = new Map();
  return (conn) => {
    let name = null;
    conn.on('message', (m) => {
      const [cmd, ...rest] = String(m).split(' ');
      const arg = rest.join(' ');
      if (cmd === '/nick') {
        name = arg;
        members.set(name, conn);
        conn.send(`welcome ${name}; members=${[...members.keys()].sort().join(',')}`);
      } else if (cmd === '/say' && name) {
        roomLog.push(`${name}: ${arg}`);
        for (const [n, c] of [...members].sort()) if (c !== conn) c.send(`<${name}> ${arg}`);
        conn.send('ack');
      } else if (cmd === '/bye') {
        members.delete(name);
        conn.close(1000, 'bye ' + name);
      } else conn.send('?' + cmd);
    });
    conn.on('closed', () => name && members.delete(name));
  };
}

// ---------------------------------------------------------------- scenario
async function main() {
  console.log('rfc example accept: ' + acceptKey('dGhlIHNhbXBsZSBub25jZQ=='));
  const rng = new DetRng(0x1234abcd);

  console.log('-- codec');
  const f1 = encodeFrame({ opcode: OP.TEXT, payload: Buffer.from('Hello'), mask: Buffer.from([0x37, 0xfa, 0x21, 0x3d]) });
  console.log('masked Hello: ' + hex(f1));
  console.log('unmasked ping: ' + hex(encodeFrame({ opcode: OP.PING, payload: Buffer.from('hi') })));
  for (const n of [0, 125, 126, 65535, 65536]) {
    const fr = encodeFrame({ opcode: OP.BINARY, payload: Buffer.alloc(n, 7) });
    console.log(`len ${String(n).padStart(5)} -> header ${hex(fr.subarray(0, Math.min(10, fr.length - n || 2)))} total=${fr.length}`);
  }
  const parser = new FrameParser({ requireMask: true });
  const parsed = [];
  parser.on('data', (f) => parsed.push(`${OP_NAMES[f.opcode]}:${f.fin}:${f.payload.toString()}`));
  const stream = Buffer.concat([f1, encodeFrame({ opcode: OP.TEXT, fin: false, payload: Buffer.from('ab'), mask: rng.bytes(4) }), encodeFrame({ opcode: OP.CONT, payload: Buffer.from('cd'), mask: rng.bytes(4) })]);
  for (let i = 0; i < stream.length; i += 3) parser.write(stream.subarray(i, i + 3));
  await new Promise(setImmediate);
  console.log('byte-dribbled parse: ' + parsed.join(' | '));

  const server = new WsServer();
  const roomLog = [];
  const rejected = [];
  server.on('rejected', (p, c) => rejected.push(`${p}:${c}`));
  server.route('/echo', echoHandler).route('/rpc', makeRpcHandler()).route('/room', makeRoomHandler(roomLog));
  const port = await server.listen();

  console.log('-- handshake failures');
  for (const [label, opts, p] of [['unknown path', {}, '/nope'], ['bad version', { version: '8' }, '/echo'], ['bad key', { badKey: 'c2hvcnQ=' }, '/echo']]) {
    const r = await connect(port, p, { rng, ...opts });
    console.log(`  ${label}: status=${r.status}`);
  }

  console.log('-- echo');
  {
    const { conn, acceptOk, protocol, status } = await connect(port, '/echo', { rng });
    console.log(`  status=${status} acceptOk=${acceptOk} protocol=${protocol}`);
    const texts = ['hello', 'grüße 🌍', '', 'x'.repeat(200), 'y'.repeat(70000 - 20)];
    for (const t of texts) {
      const p = nextMessage(conn);
      conn.send(t);
      const { m } = await p;
      console.log(`  echo len=${Buffer.byteLength(t)} -> ${short(m)} (${m.length})`);
    }
    const p2 = nextMessage(conn);
    const pieces = conn.sendFragmented('fragmented message spanning several frames ✓', 7);
    const { m: fm, parts } = await p2;
    console.log(`  fragments sent=${pieces} -> ${fm} parts=${parts}`);
    const bin = Buffer.from([1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const p3 = nextMessage(conn);
    conn.send(bin);
    const { m: bm } = await p3;
    console.log(`  binary reply len=${bm.readUInt32BE(0)} sum=${bm.readUInt32BE(4)} head=${hex(bm.subarray(8))}`);
    for (const tag of ['p1', 'p2', 'ping-with-longer-payload']) {
      const pp = nextEvent(conn, 'pong');
      conn.ping(tag);
      const [data] = await pp;
      console.log(`  pong ${data}`);
    }
    const cp = nextEvent(conn, 'close-frame');
    const closed = nextEvent(conn, 'closed');
    conn.close(1000, 'done');
    const [code, reason] = await cp;
    await closed;
    const st = conn.stats;
    console.log(`  close echoed code=${code} reason='${reason}' state=${conn.state} framesOut=${st.framesOut} framesIn=${st.framesIn}`);
  }

  console.log('-- rpc');
  {
    const { conn, protocol } = await connect(port, '/rpc', { rng, protocols: ['chat.v1', 'chat.v2'] });
    console.log(`  negotiated=${protocol}`);
    const calls = [
      { id: 1, method: 'add', params: { a: 20, b: 22 } },
      { id: 2, method: 'upper', params: { s: 'virtual machine' } },
      { id: 3, method: 'fib', params: { n: 90 } },
      { id: 4, method: 'sha', params: { s: 'abc' } },
      { id: 5, method: 'fail' },
      { id: 6, method: 'missing' },
    ];
    for (const c of calls) {
      const p = nextMessage(conn);
      conn.send(JSON.stringify(c));
      console.log('  ' + (await p).m);
    }
    const p = nextMessage(conn);
    conn.send('{not json');
    console.log('  ' + (await p).m);
    const closed = nextEvent(conn, 'closed');
    conn.close(1001, 'going away');
    await closed;
    console.log('  rpc closed');
  }

  console.log('-- room');
  {
    const names = ['carol', 'alice', 'bob'];
    const clients = [];
    for (const n of names) {
      const { conn } = await connect(port, '/room', { rng });
      const inbox = [];
      conn.on('message', (m) => inbox.push(m));
      const p = nextMessage(conn);
      conn.send('/nick ' + n);
      console.log(`  ${(await p).m}`);
      clients.push({ n, conn, inbox });
    }
    const script = [[0, 'hi all'], [1, 'hello carol'], [2, 'yo'], [1, 'bye soon']];
    for (const [who, text] of script) {
      const c = clients[who];
      const ack = new Promise((res) => {
        const l = (m) => { if (m === 'ack') { c.conn.removeListener('message', l); res(); } };
        c.conn.on('message', l);
      });
      c.conn.send('/say ' + text);
      await ack;
    }
    for (const c of clients) {
      const pp = nextEvent(c.conn, 'pong');
      c.conn.ping('sync-' + c.n);
      await pp;
    }
    for (const c of clients) console.log(`  inbox ${c.n}: ${c.inbox.filter((m) => m.startsWith('<')).join(' | ')}`);
    const p = nextMessage(clients[0].conn);
    clients[0].conn.send('/dance');
    console.log(`  unknown -> ${(await p).m}`);
    for (const c of clients) {
      const cf = nextEvent(c.conn, 'close-frame');
      const closed = nextEvent(c.conn, 'closed');
      c.conn.send('/bye');
      const [code, reason] = await cf;
      await closed;
      console.log(`  ${c.n} closed by server code=${code} reason=${reason}`);
    }
    console.log('  room log: ' + roomLog.join(' / '));
  }

  console.log('-- protocol violations');
  {
    const { conn } = await connect(port, '/echo', { rng });
    const cf = nextEvent(conn, 'close-frame');
    conn.sendRaw(encodeFrame({ opcode: OP.TEXT, payload: Buffer.from('nomask') }));
    const [code, reason] = await cf;
    console.log(`  unmasked frame -> close ${code} ${reason}`);
    await nextEvent(conn, 'closed');
  }
  {
    const { conn } = await connect(port, '/echo', { rng });
    const cf = nextEvent(conn, 'close-frame');
    conn.sendRaw(encodeFrame({ opcode: OP.CONT, payload: Buffer.from('orphan'), mask: rng.bytes(4) }));
    const [code, reason] = await cf;
    console.log(`  orphan continuation -> close ${code} ${reason}`);
    await nextEvent(conn, 'closed');
  }
  {
    const { conn } = await connect(port, '/echo', { rng });
    const cf = nextEvent(conn, 'close-frame');
    conn.sendRaw(encodeFrame({ opcode: OP.TEXT, payload: Buffer.from([0xc3, 0x28, 0x41]), mask: rng.bytes(4) }));
    const [code, reason] = await cf;
    console.log(`  invalid utf8 -> close ${code} ${reason}`);
    await nextEvent(conn, 'closed');
  }
  {
    const { conn } = await connect(port, '/echo', { rng });
    const cf = nextEvent(conn, 'close-frame');
    conn.sendRaw(encodeFrame({ opcode: OP.BINARY, payload: Buffer.alloc(70001), mask: rng.bytes(4) }));
    const [code, reason] = await cf;
    console.log(`  oversized -> close ${code} ${reason}`);
    await nextEvent(conn, 'closed');
  }
  {
    const { conn } = await connect(port, '/echo', { rng });
    const cf = nextEvent(conn, 'close-frame');
    const bad = encodeFrame({ opcode: OP.PING, payload: Buffer.from('x'), mask: rng.bytes(4) });
    bad[0] &= 0x7f;
    conn.sendRaw(bad);
    const [code, reason] = await cf;
    console.log(`  fragmented control -> close ${code} ${reason}`);
    await nextEvent(conn, 'closed');
  }

  console.log('rejected: ' + rejected.join(', '));
  const digest = crypto.createHash('sha1');
  for (let i = 0; i < 16; i++) digest.update(rng.bytes(4));
  console.log('rng tail digest: ' + digest.digest('hex').slice(0, 12));
  await server.close();
  console.log("server closed");
}

process.on('exit', (c) => console.log('exit code ' + c));
main().catch((e) => { console.log('fatal: ' + e.stack); process.exitCode = 1; });
