'use strict';
// Pub/sub message broker over TCP: length-prefixed JSON frames, topic tries with
// wildcards (* = one segment, # = rest), queue groups, acks/nacks, redelivery,
// dead letters, retained messages. The program is its own set of clients.
const net = require('net');
const { EventEmitter, once } = require('events');
const { Transform } = require('stream');
const crypto = require('crypto');

// ---------------------------------------------------------------- framing
const HEADER = 6; // u32 length + u8 version + u8 kind
const KIND = { JSON: 1, PING: 2, PONG: 3 };
const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

function encodeFrame(kind, payload) {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(HEADER);
  head.writeUInt32BE(body.length, 0);
  head.writeUInt8(1, 4);
  head.writeUInt8(kind, 5);
  return Buffer.concat([head, body]);
}

class FrameDecoder extends Transform {
  #pending = Buffer.alloc(0);
  #frames = 0;
  constructor() { super({ readableObjectMode: true }); }
  get frames() { return this.#frames; }
  _transform(chunk, _enc, cb) {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    try {
      while (this.#pending.length >= HEADER) {
        const len = this.#pending.readUInt32BE(0);
        const ver = this.#pending.readUInt8(4);
        if (ver !== 1) throw new Error('bad frame version ' + ver);
        if (this.#pending.length < HEADER + len) break;
        const kind = this.#pending.readUInt8(5);
        const body = this.#pending.subarray(HEADER, HEADER + len);
        this.#pending = this.#pending.subarray(HEADER + len);
        this.#frames++;
        this.push({ kind: KIND_NAME[kind] || 'UNKNOWN', data: len ? JSON.parse(body.toString('utf8')) : null, size: len });
      }
      cb();
    } catch (e) { cb(e); }
  }
}

// ---------------------------------------------------------------- topic trie
function validTopic(t, allowWild) {
  if (typeof t !== 'string' || !t.length) return false;
  const parts = t.split('.');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) return false;
    if ((p === '*' || p === '#') && !allowWild) return false;
    if (p === '#' && i !== parts.length - 1) return false;
    if (/[*#]/.test(p) && p.length > 1) return false;
  }
  return true;
}

class TrieNode {
  constructor() { this.children = new Map(); this.subs = new Set(); }
}

class TopicTrie {
  #root = new TrieNode();
  #count = 0;
  get size() { return this.#count; }
  add(pattern, sub) {
    let node = this.#root;
    for (const part of pattern.split('.')) {
      if (!node.children.has(part)) node.children.set(part, new TrieNode());
      node = node.children.get(part);
    }
    if (!node.subs.has(sub)) { node.subs.add(sub); this.#count++; }
  }
  remove(pattern, pred) {
    let node = this.#root;
    for (const part of pattern.split('.')) {
      node = node.children.get(part);
      if (!node) return 0;
    }
    let removed = 0;
    for (const s of [...node.subs]) if (pred(s)) { node.subs.delete(s); removed++; }
    this.#count -= removed;
    return removed;
  }
  removeWhere(pred) {
    let removed = 0;
    const walk = (node) => {
      for (const s of [...node.subs]) if (pred(s)) { node.subs.delete(s); removed++; }
      for (const child of node.children.values()) walk(child);
    };
    walk(this.#root);
    this.#count -= removed;
    return removed;
  }
  match(topic) {
    const parts = topic.split('.');
    const out = new Set();
    const visit = (node, i) => {
      const hash = node.children.get('#');
      if (hash) for (const s of hash.subs) out.add(s);
      if (i === parts.length) { for (const s of node.subs) out.add(s); return; }
      const exact = node.children.get(parts[i]);
      if (exact) visit(exact, i + 1);
      const star = node.children.get('*');
      if (star) visit(star, i + 1);
    };
    visit(this.#root, 0);
    return [...out];
  }
}

function patternMatches(pattern, topic) {
  const re = new RegExp('^' + pattern.split('.').map((p) =>
    p === '#' ? '.+' : p === '*' ? '[^.]+' : p.replace(/[-/\\^$+?()|[\]{}]/g, '\\$&')).join('\\.') + '$');
  return re.test(topic);
}

// ---------------------------------------------------------------- broker
const brokerConfig = new Proxy({ maxRedeliveries: 2, retainLimit: 3 }, {
  set(target, key, value) {
    if (!(key in target)) throw new TypeError('unknown config key ' + String(key));
    if (!Number.isInteger(value) || value < 0) throw new RangeError('config ' + String(key) + ' must be a non-negative integer');
    target[key] = value;
    return true;
  },
});

class Session {
  static #seq = 0;
  #socket;
  constructor(socket, name) {
    this.id = 'c' + (++Session.#seq);
    this.name = name;
    this.#socket = socket;
    this.inflight = new Map();
    this.bytesOut = 0n;
    this.alive = true;
  }
  send(kind, payload) {
    if (!this.alive) return false;
    const frame = encodeFrame(kind, payload);
    this.bytesOut += BigInt(frame.length);
    this.#socket.write(frame);
    return true;
  }
  end() { this.alive = false; this.#socket.end(); }
}

class Broker extends EventEmitter {
  #server = net.createServer();
  #sessions = new Map();
  #trie = new TopicTrie();
  #groups = new Map();
  #retained = new Map();
  #deadLetters = [];
  #msgSeq = 0;
  #stats = { published: 0, delivered: 0, acked: 0, nacked: 0, redelivered: 0, dropped: 0 };
  static #instances = 0;
  static { Broker.VERSION = '1.' + (2 + 3) + '.0'; }

  constructor() {
    super();
    Broker.#instances++;
    this.#server.on('connection', (sock) => this.#accept(sock));
  }
  static get instances() { return Broker.#instances; }
  get stats() { return { ...this.#stats, subscriptions: this.#trie.size, sessions: this.#sessions.size }; }
  get deadLetters() { return this.#deadLetters.slice(); }

  async listen() {
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    return this.#server.address().port;
  }

  #accept(sock) {
    const decoder = new FrameDecoder();
    let session = null;
    sock.pipe(decoder);
    decoder.on('data', (frame) => {
      if (frame.kind === 'PING') { session?.send(KIND.PONG, frame.data); return; }
      const msg = frame.data;
      if (!session) {
        if (msg?.op !== 'hello') { sock.destroy(); return; }
        session = new Session(sock, msg.name);
        this.#sessions.set(session.id, session);
        session.send(KIND.JSON, { op: 'welcome', id: session.id, version: Broker.VERSION });
        this.emit('join', session);
        return;
      }
      try { this.#handle(session, msg); }
      catch (e) { session.send(KIND.JSON, { op: 'error', ref: msg?.ref, message: e.message }); }
    });
    decoder.on('error', (e) => { this.emit('protocol-error', e.message); sock.destroy(); });
    sock.on('error', () => {});
    sock.on('close', () => { if (session) this.#drop(session); });
  }

  #reply(session, ref, body) { session.send(KIND.JSON, { op: 'ok', ref, ...body }); }

  #handle(session, msg) {
    switch (msg.op) {
      case 'sub': {
        if (!validTopic(msg.pattern, true)) throw new Error('invalid pattern: ' + msg.pattern);
        const sub = { session, pattern: msg.pattern, group: msg.group || null };
        if (sub.group) {
          const key = sub.group + '|' + sub.pattern;
          if (!this.#groups.has(key)) {
            const g = { members: [], cursor: 0, pattern: sub.pattern, name: sub.group };
            this.#groups.set(key, g);
            this.#trie.add(sub.pattern, g);
          }
          this.#groups.get(key).members.push(session);
        } else this.#trie.add(sub.pattern, sub);
        this.#reply(session, msg.ref, { subscribed: msg.pattern });
        const retained = [...this.#retained.entries()].filter(([t]) => patternMatches(msg.pattern, t)).sort(([a], [b]) => a.localeCompare(b));
        for (const [topic, list] of retained) for (const m of list) session.send(KIND.JSON, { op: 'msg', id: 0, topic, body: m, retained: true });
        return;
      }
      case 'unsub': {
        const n = this.#trie.remove(msg.pattern, (s) => s.session === session);
        this.#reply(session, msg.ref, { removed: n });
        return;
      }
      case 'pub': {
        if (!validTopic(msg.topic, false)) throw new Error('invalid topic: ' + msg.topic);
        this.#stats.published++;
        if (msg.retain) {
          const list = this.#retained.get(msg.topic) || [];
          list.push(msg.body);
          while (list.length > brokerConfig.retainLimit) list.shift();
          this.#retained.set(msg.topic, list);
        }
        const id = ++this.#msgSeq;
        const n = this.#fanout({ id, topic: msg.topic, body: msg.body, attempts: 0 }, null);
        this.#reply(session, msg.ref, { id, receivers: n });
        return;
      }
      case 'ack':
      case 'nack': {
        const entry = session.inflight.get(msg.id);
        if (!entry) throw new Error('unknown delivery ' + msg.id);
        session.inflight.delete(msg.id);
        if (msg.op === 'ack') { this.#stats.acked++; this.emit('acked', session, entry); }
        else { this.#stats.nacked++; this.#redeliver(entry.message, entry.target, session); }
        return;
      }
      case 'stats':
        this.#reply(session, msg.ref, { stats: this.stats });
        return;
      default:
        throw new Error('unknown op ' + msg.op);
    }
  }

  #deliver(session, message, target) {
    const key = message.id + ':' + session.id;
    if (!session.alive) return false;
    session.inflight.set(message.id, { message, target, key });
    session.send(KIND.JSON, { op: 'msg', id: message.id, topic: message.topic, body: message.body, attempt: message.attempts + 1 });
    this.#stats.delivered++;
    return true;
  }

  #pickFromGroup(group, exclude) {
    const live = group.members.filter((m) => m.alive);
    if (!live.length) return null;
    for (let k = 0; k < live.length; k++) {
      const cand = live[(group.cursor + k) % live.length];
      if (cand !== exclude || live.length === 1) { group.cursor = (group.cursor + k + 1) % live.length; return cand; }
    }
    return null;
  }

  #fanout(message, only) {
    let receivers = 0;
    const targets = only ? [only] : this.#trie.match(message.topic);
    targets.sort((a, b) => (a.pattern + (a.name || a.session.id)).localeCompare(b.pattern + (b.name || b.session.id)));
    for (const t of targets) {
      if (t.members) {
        const who = this.#pickFromGroup(t, null);
        if (who && this.#deliver(who, message, t)) receivers++;
      } else if (this.#deliver(t.session, message, t)) receivers++;
    }
    if (!receivers) this.#stats.dropped++;
    return receivers;
  }

  #redeliver(message, target, previous) {
    const next = { ...message, attempts: message.attempts + 1 };
    if (next.attempts > brokerConfig.maxRedeliveries) {
      this.#deadLetters.push({ id: next.id, topic: next.topic, attempts: next.attempts });
      this.emit('dead', next);
      return;
    }
    this.#stats.redelivered++;
    let who = null;
    if (target.members) who = this.#pickFromGroup(target, previous);
    else if (target.session.alive) who = target.session;
    if (!who) { this.#deadLetters.push({ id: next.id, topic: next.topic, attempts: next.attempts, reason: 'no-consumer' }); return; }
    this.#deliver(who, next, target);
  }

  #drop(session) {
    session.alive = false;
    this.#sessions.delete(session.id);
    this.#trie.removeWhere((s) => s.session === session);
    const pending = [...session.inflight.values()].sort((a, b) => a.message.id - b.message.id);
    session.inflight.clear();
    for (const { message, target } of pending) {
      if (target.members) this.#redeliver(message, target, session);
    }
    this.emit('leave', session, pending.length);
  }

  async close() {
    for (const s of this.#sessions.values()) s.end();
    await new Promise((r) => this.#server.close(r));
  }
}

// ---------------------------------------------------------------- client
class BrokerClient extends EventEmitter {
  #socket = null;
  #ref = 0;
  #waiting = new Map();
  #pingWaiters = [];
  #inbox = [];
  #inboxWaiters = [];
  constructor(name, policy) {
    super();
    this.name = name;
    this.policy = policy || (() => 'ack');
    this.received = [];
    this.id = null;
  }
  async connect(port) {
    this.#socket = net.connect(port, '127.0.0.1');
    await once(this.#socket, 'connect');
    const decoder = new FrameDecoder();
    this.#socket.pipe(decoder);
    decoder.on('data', (f) => this.#onFrame(f));
    this.#socket.on('error', (e) => this.emit('error', e));
    this.#socket.write(encodeFrame(KIND.JSON, { op: 'hello', name: this.name }));
    const [welcome] = await once(this, 'welcome');
    this.id = welcome.id;
    return welcome;
  }
  #onFrame(frame) {
    if (frame.kind === 'PONG') { const w = this.#pingWaiters.shift(); if (w) w(frame.data); return; }
    const m = frame.data;
    if (m.op === 'welcome') { this.emit('welcome', m); return; }
    if (m.op === 'ok' || m.op === 'error') {
      const w = this.#waiting.get(m.ref);
      if (w) { this.#waiting.delete(m.ref); m.op === 'ok' ? w.resolve(m) : w.reject(new Error(m.message)); }
      return;
    }
    if (m.op === 'msg') {
      this.received.push(m);
      const w = this.#inboxWaiters.shift();
      if (w) w({ value: m, done: false }); else this.#inbox.push(m);
      if (m.id !== 0) {
        const decision = this.policy(m);
        if (decision !== 'hold') this.#send({ op: decision, id: m.id });
      }
    }
  }
  #send(obj) { this.#socket.write(encodeFrame(KIND.JSON, obj)); }
  request(obj) {
    const ref = ++this.#ref;
    return new Promise((resolve, reject) => {
      this.#waiting.set(ref, { resolve, reject });
      this.#send({ ...obj, ref });
    });
  }
  subscribe(pattern, group) { return this.request({ op: 'sub', pattern, group }); }
  unsubscribe(pattern) { return this.request({ op: 'unsub', pattern }); }
  publish(topic, body, retain = false) { return this.request({ op: 'pub', topic, body, retain }); }
  ack(id) { this.#send({ op: 'ack', id }); }
  ping(token) {
    return new Promise((resolve) => { this.#pingWaiters.push(resolve); this.#socket.write(encodeFrame(KIND.PING, token)); });
  }
  drain() { const out = this.#inbox; this.#inbox = []; return out; }
  async *messages(limit) {
    let n = 0;
    while (n < limit) {
      if (this.#inbox.length) { n++; yield this.#inbox.shift(); continue; }
      const next = await new Promise((r) => this.#inboxWaiters.push(r));
      n++;
      yield next.value;
    }
  }
  async close() {
    const s = this.#socket;
    s.end();
    if (!s.destroyed) await once(s, 'close');
  }
  destroy() { this.#socket.destroy(); }
}

// ---------------------------------------------------------------- scenario helpers
const log = (...a) => console.log(...a);
function fmtMsg(m) {
  return `${m.retained ? 'R' : '#' + m.id} ${m.topic} ${JSON.stringify(m.body)}${m.attempt > 1 ? ' (attempt ' + m.attempt + ')' : ''}`;
}
async function settle(clients) {
  for (const c of clients) await c.ping('sync');
  for (const c of clients) await c.ping('sync2');
}
function report(clients) {
  for (const c of [...clients].sort((a, b) => a.name.localeCompare(b.name))) {
    const got = c.drain();
    log(`  ${c.name.padEnd(8)} <- ${got.length ? got.map(fmtMsg).join(' | ') : '(nothing)'}`);
  }
}
async function closeAndWait(broker, client) {
  const left = once(broker, 'leave');
  await client.close();
  await left;
}
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }

async function section(title, fn) {
  log('');
  log('=== ' + title + ' ===');
  try { await fn(); }
  catch (e) { log('  section failed: ' + e.message); }
  finally { log('  --- end ' + title.toLowerCase()); }
}

// ---------------------------------------------------------------- unit tests (pure)
function unitTests() {
  log('=== unit: topic validation ===');
  const cases = [['a.b.c', false], ['a.*.c', true], ['a.#', true], ['a.#.c', true], ['', false], ['a..b', false], ['a.b*', true], ['*', true]];
  for (const [t, wild] of cases) log(`  ${JSON.stringify(t).padEnd(9)} wild=${wild ? 'y' : 'n'} -> ${validTopic(t, wild)}`);
  log('=== unit: trie matching ===');
  const trie = new TopicTrie();
  const pats = ['orders.*', 'orders.#', 'orders.eu.created', '*.eu.*', '#', 'users.*.login'];
  for (const p of pats) trie.add(p, { pattern: p });
  for (const topic of ['orders.eu.created', 'orders.us', 'users.bob.login', 'users.bob', 'x']) {
    const hits = trie.match(topic).map((s) => s.pattern).sort();
    const viaRe = pats.filter((p) => patternMatches(p, topic)).sort();
    log(`  ${topic.padEnd(18)} -> [${hits.join(', ')}] ${JSON.stringify(hits) === JSON.stringify(viaRe) ? 'consistent' : 'MISMATCH'}`);
  }
  log('=== unit: framing ===');
  const frames = [encodeFrame(KIND.JSON, { op: 'x', n: 1 }), encodeFrame(KIND.PING, 'p'), encodeFrame(KIND.JSON, { big: 'é'.repeat(5) })];
  const all = Buffer.concat(frames);
  const dec = new FrameDecoder();
  const got = [];
  dec.on('data', (f) => got.push(f));
  for (let i = 0; i < all.length; i += 7) dec.write(all.subarray(i, i + 7));
  log(`  bytes=${all.length} frames=${dec.frames} kinds=${got.map((f) => f.kind).join(',')} sizes=${got.map((f) => f.size).join(',')}`);
  log(`  header[0]=0x${all.readUInt32BE(0).toString(16)} crc-ish=${digest(all.toString('hex'))}`);
  log('=== unit: config proxy ===');
  for (const [k, v] of [['maxRedeliveries', 2], ['retainLimit', -1], ['bogus', 1]]) {
    try { brokerConfig[k] = v; log(`  set ${k}=${v} ok`); }
    catch (e) { log(`  set ${k}=${v} -> ${e.name}: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- main scenario
async function main() {
  unitTests();
  const broker = new Broker();
  const events = [];
  broker.on('join', (s) => events.push('join ' + s.name + ' as ' + s.id));
  broker.on('leave', (s, n) => events.push(`leave ${s.name} inflight=${n}`));
  broker.on('dead', (m) => events.push(`dead #${m.id} ${m.topic}`));
  const port = await broker.listen();
  log('');
  log('broker version ' + Broker.VERSION + ', instances=' + Broker.instances);

  const flakyCounts = new Map();
  const mk = (name, policy) => new BrokerClient(name, policy);
  const pub = mk('pub');
  const alice = mk('alice');
  const bob = mk('bob');
  const carol = mk('carol', (m) => {
    const n = (flakyCounts.get(m.id) || 0) + 1;
    flakyCounts.set(m.id, n);
    return m.body?.poison ? 'nack' : n === 1 && m.id % 2 === 0 ? 'nack' : 'ack';
  });
  const dave = mk('dave', () => 'hold');
  const clients = [pub, alice, bob, carol, dave];
  for (const c of clients) {
    const w = await c.connect(port);
    log(`connected ${c.name.padEnd(6)} id=${w.id}`);
  }

  await section('direct and wildcard subscriptions', async () => {
    await alice.subscribe('news.sports');
    await bob.subscribe('news.*');
    await carol.subscribe('news.#');
    for (const t of ['news.sports', 'news.weather', 'news.sports.football', 'other.x']) {
      const r = await pub.publish(t, { headline: t.split('.').pop().toUpperCase() });
      log(`  pub ${t.padEnd(22)} id=${r.id} receivers=${r.receivers}`);
    }
    await settle(clients);
    report(clients);
  });

  await section('error handling', async () => {
    for (const bad of [['sub', 'a.#.b'], ['pub', 'a.*'], ['pub', '']]) {
      try {
        if (bad[0] === 'sub') await alice.subscribe(bad[1]);
        else await pub.publish(bad[1], {});
        log('  unexpected success');
      } catch (e) { log(`  ${bad[0]} ${JSON.stringify(bad[1])} rejected: ${e.message}`); }
    }
    try { await pub.request({ op: 'explode' }); } catch (e) { log('  ' + e.message); }
    try { await pub.request({ op: 'nack', id: 999 }); } catch (e) { log('  ' + e.message); }
  });

  await section('queue groups round robin', async () => {
    await alice.subscribe('jobs.render', 'workers');
    await bob.subscribe('jobs.render', 'workers');
    await dave.subscribe('jobs.audit');
    for (let i = 1; i <= 5; i++) {
      const r = await pub.publish('jobs.render', { frame: i });
      log(`  job frame=${i} id=${r.id} receivers=${r.receivers}`);
    }
    await settle(clients);
    report(clients);
  });

  await section('nack and redelivery', async () => {
    await carol.subscribe('tasks.*', 'solo');
    const ids = [];
    for (const [i, body] of [{ n: 1 }, { n: 2 }, { n: 3, poison: true }, { n: 4 }].entries()) {
      const r = await pub.publish('tasks.run', body);
      ids.push(r.id);
      log(`  task ${i} id=${r.id}`);
    }
    await settle(clients);
    await settle(clients);
    await settle(clients);
    report(clients);
    const attempts = [...flakyCounts.entries()].filter(([id]) => ids.includes(id)).map(([id, n]) => `#${id}:${n}`);
    log('  carol attempts ' + attempts.join(' '));
    log('  dead letters ' + JSON.stringify(broker.deadLetters));
  });

  await section('retained messages', async () => {
    for (let v = 1; v <= 5; v++) await pub.publish('config.theme', { v }, true);
    await pub.publish('config.lang', { lang: 'de' }, true);
    await settle(clients);
    clients.forEach((c) => c.drain());
    const late = mk('late');
    await late.connect(port);
    log('  late joiner id=' + late.id);
    await late.subscribe('config.*');
    await settle([late]);
    report([late]);
    await closeAndWait(broker, late);
  });

  await section('async iterator consumption', async () => {
    const eve = mk('eve');
    await eve.connect(port);
    await eve.subscribe('stream.#');
    const consumer = (async () => {
      const seen = [];
      for await (const m of eve.messages(4)) seen.push(`${m.topic}=${m.body.i}`);
      return seen;
    })();
    for (let i = 0; i < 4; i++) await pub.publish('stream.part.' + (i % 2 ? 'odd' : 'even'), { i });
    const seen = await consumer;
    log('  eve consumed ' + seen.join(', '));
    await closeAndWait(broker, eve);
    await settle([pub]);
    clients.forEach((c) => c.drain());
  });

  await section('disconnect with inflight group messages', async () => {
    await dave.subscribe('mail.send', 'mailers');
    await alice.subscribe('mail.send', 'mailers');
    const results = [];
    for (let i = 1; i <= 4; i++) results.push((await pub.publish('mail.send', { to: 'user' + i })).id);
    await settle(clients);
    log('  published ' + results.map((id) => '#' + id).join(' '));
    log(`  dave holding ${dave.received.filter((m) => m.topic === 'mail.send').length} mail message(s); disconnecting`);
    await closeAndWait(broker, dave);
    await settle([pub, alice, bob, carol]);
    await settle([pub, alice, bob, carol]);
    report([alice, bob, carol, pub]);
  });

  await section('unsubscribe and stats', async () => {
    const r = await bob.unsubscribe('news.*');
    log('  bob removed ' + r.removed);
    const p = await pub.publish('news.weather', { t: 'rain' });
    log('  news.weather receivers=' + p.receivers);
    await settle([pub, alice, bob, carol]);
    report([alice, bob, carol]);
    const s = (await pub.request({ op: 'stats' })).stats;
    for (const k of Object.keys(s).sort()) log(`  stat ${k.padEnd(14)} ${s[k]}`);
  });

  log('');
  log('=== broker events ===');
  for (const e of events) log('  ' + e);
  const transcript = clients.map((c) => c.name + ':' + c.received.map((m) => m.id + m.topic).join(',')).join(';');
  log('transcript digest ' + digest(transcript));
  let total = 0n;
  for (const c of clients) total += BigInt(c.received.length) * 1000n + BigInt(c.received.reduce((a, m) => a + m.id, 0));
  log('bigint checksum ' + total.toString(16));

  for (const c of [pub, alice, bob, carol]) await c.close();
  await broker.close();
  log('broker closed');
}

process.on('exit', (code) => console.log('exit code ' + code));
main().catch((e) => { console.log('fatal ' + e.message); process.exitCode = 1; });
