'use strict';
// n07: reverse proxy / load balancer in front of three backend http servers.
// Round robin with health checks, retries, ejection/recovery, consistent hashing,
// smooth weighted round robin, access-log stream pipeline. Acts as its own client.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { Readable, Transform, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const pipe = promisify(pipeline);
const HOST = '127.0.0.1';

// ---------------------------------------------------------------- helpers
function sha1(data, len = 12) {
  return crypto.createHash('sha1').update(data).digest('hex').slice(0, len);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function fibBig(n) {
  let a = 0n, b = 1n;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

function digitSum(big) {
  let s = 0n;
  let x = big;
  while (x > 0n) {
    s += x % 10n;
    x /= 10n;
  }
  return Number(s);
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on('data', (c) => parts.push(c));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

function httpCall(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: HOST, port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

class Section {
  static #n = 0;
  static open(title) {
    Section.#n++;
    console.log(`== ${Section.#n}. ${title} ==`);
  }
  static get count() {
    return Section.#n;
  }
}

// ---------------------------------------------------------------- router
class Router {
  #routes = [];
  add(method, pattern, handler) {
    const keys = [];
    const src = pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.#routes.push({ method, re: new RegExp('^' + src + '$'), keys, handler });
    return this;
  }
  match(method, url) {
    const [p, qs = ''] = url.split('?');
    for (const r of this.#routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params, query: Object.fromEntries(new URLSearchParams(qs)) };
    }
    return null;
  }
  get size() {
    return this.#routes.length;
  }
}

// ---------------------------------------------------------------- backend
class Backend extends EventEmitter {
  static #created = 0;
  static registry;
  static {
    Backend.registry = new Map();
  }

  #name;
  #server = null;
  #hits = 0;
  #healthy = true;
  #failBudget = 0;
  #router;
  port = 0;

  constructor(name, weight = 1) {
    super();
    this.#name = name;
    this.weight = weight;
    Backend.#created++;
    this.serial = Backend.#created;
    Backend.registry.set(name, this);
    this.#router = this.#buildRouter();
  }

  get name() { return this.#name; }
  get hits() { return this.#hits; }
  get running() { return this.#server !== null; }
  get healthy() { return this.#healthy; }
  set healthy(v) {
    this.#healthy = !!v;
    this.emit('state', this.#name, this.#healthy);
  }
  failNext(n) {
    this.#failBudget += n;
  }

  #buildRouter() {
    const r = new Router();
    r.add('GET', '/health', (ctx) =>
      this.#healthy
        ? ctx.json(200, { status: 'ok', backend: this.#name })
        : ctx.json(503, { status: 'down', backend: this.#name }));
    r.add('GET', '/whoami', (ctx) => ctx.json(200, { backend: this.#name, hits: this.#hits, serial: this.serial }));
    r.add('POST', '/echo', (ctx) => {
      const text = ctx.body.toString('utf8');
      ctx.json(200, { backend: this.#name, reversed: [...text].reverse().join(''), sha: sha1(text), len: ctx.body.length });
    });
    r.add('GET', '/compute/:n', (ctx) => {
      const n = Number(ctx.params.n);
      if (!Number.isInteger(n) || n < 0 || n > 500) return ctx.json(400, { error: 'bad n', backend: this.#name });
      const f = fibBig(n);
      const s = f.toString();
      return ctx.json(200, { backend: this.#name, n, fib: s.length > 20 ? s.slice(0, 8) + '..' + s.slice(-8) : s, digits: s.length, digitSum: digitSum(f) });
    });
    r.add('GET', '/flaky', (ctx) => {
      if (this.#failBudget > 0) {
        this.#failBudget--;
        return ctx.json(502, { error: 'flaky', backend: this.#name });
      }
      return ctx.json(200, { ok: true, backend: this.#name });
    });
    r.add('GET', '/stream/:count', (ctx) => ctx.stream(Number(ctx.params.count)));
    r.add('GET', '/headers', (ctx) => {
      const picked = {};
      for (const k of Object.keys(ctx.req.headers).sort()) if (k.startsWith('x-')) picked[k] = ctx.req.headers[k];
      ctx.json(200, { backend: this.#name, headers: picked });
    });
    r.add('GET', '/crash', () => {
      throw new Error('backend exploded');
    });
    r.add('GET', '/query', (ctx) => ctx.json(200, { backend: this.#name, query: ctx.query }));
    return r;
  }

  async #handle(req, res) {
    this.#hits++;
    const body = await readBody(req);
    const name = this.#name;
    const ctx = {
      req, res, body, params: {}, query: {},
      json(status, obj) {
        const s = JSON.stringify(obj);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), 'x-backend': name });
        res.end(s);
      },
      async stream(n) {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-backend': name });
        async function* lines() {
          for (let i = 1; i <= n; i++) {
            await null;
            yield `${name}:line${i}:${sha1(name + i, 6)}\n`;
          }
        }
        await pipe(Readable.from(lines()), res);
      },
    };
    const m = this.#router.match(req.method, req.url);
    try {
      if (!m) return ctx.json(404, { error: 'not found', path: req.url, backend: name });
      ctx.params = m.params;
      ctx.query = m.query;
      await m.handler(ctx);
    } catch (e) {
      ctx.json(500, { error: e.message, backend: name });
    }
  }

  async start() {
    this.#server = http.createServer((q, s) => {
      this.#handle(q, s);
    });
    this.#server.listen(0, HOST);
    await once(this.#server, 'listening');
    this.port = this.#server.address().port;
    this.emit('started', this.#name);
  }

  async stop() {
    if (!this.#server) return;
    const s = this.#server;
    this.#server = null;
    const closed = once(s, 'close');
    s.closeAllConnections();
    s.close();
    await closed;
    this.emit('stopped', this.#name);
  }
}

// ---------------------------------------------------------------- balancer
class Upstream {
  constructor(backend) {
    this.backend = backend;
    this.name = backend.name;
    this.up = true;
    this.fails = 0;
    this.served = 0;
    this.errors = 0;
  }
  get port() {
    return this.backend.port;
  }
  toJSON() {
    return { name: this.name, up: this.up, fails: this.fails, served: this.served, errors: this.errors };
  }
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);

class LoadBalancer extends EventEmitter {
  #ups = [];
  #cursor = 0;
  #maxAttempts;
  #failThreshold;
  #seq = 0;
  #events = [];

  constructor({ maxAttempts = 3, failThreshold = 2 } = {}) {
    super();
    this.#maxAttempts = maxAttempts;
    this.#failThreshold = failThreshold;
  }

  add(backend) {
    this.#ups.push(new Upstream(backend));
    return this;
  }
  get upstreams() { return this.#ups.slice(); }
  get events() { return this.#events.slice(); }
  get healthyNames() { return this.#ups.filter((u) => u.up).map((u) => u.name); }

  *#rotation() {
    const n = this.#ups.length;
    const start = this.#cursor % n;
    this.#cursor++;
    for (let i = 0; i < n; i++) {
      const u = this.#ups[(start + i) % n];
      if (u.up) yield u;
    }
  }

  #record(kind, detail) {
    this.#events.push(`${kind}:${detail}`);
    this.emit(kind, detail);
  }

  #fail(u) {
    u.errors++;
    u.fails++;
    if (u.fails >= this.#failThreshold && u.up) {
      u.up = false;
      this.#record('ejected', u.name);
    }
  }

  async healthCheck() {
    const report = [];
    for (const u of this.#ups) {
      let ok = false;
      let why;
      try {
        const r = await httpCall(u.port, { path: '/health' });
        ok = r.status === 200;
        why = String(r.status);
      } catch (e) {
        why = e.code || 'ERR';
      }
      const was = u.up;
      u.up = ok;
      if (ok) u.fails = 0;
      if (was !== ok) this.#record(ok ? 'recovered' : 'ejected', u.name);
      report.push({ name: u.name, up: ok, why });
    }
    return report;
  }

  async forward(method, url, headers, body) {
    const id = ++this.#seq;
    const trace = [];
    const fwd = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k)) fwd[k] = v;
    let attempts = 0;
    let last = null;
    outer: for (const u of this.#rotation()) {
      if (attempts >= this.#maxAttempts) break outer;
      attempts++;
      try {
        const r = await httpCall(u.port, {
          method, path: url, body: body && body.length ? body : null,
          headers: { ...fwd, 'x-request-id': `req-${id}`, 'x-hop': String(attempts), 'x-forwarded-proto': 'http' },
        });
        trace.push(`${u.name}:${r.status}`);
        if (r.status >= 500) {
          last = r;
          this.#fail(u);
          continue outer;
        }
        u.served++;
        u.fails = 0;
        return { ...r, upstream: u.name, trace, id };
      } catch (e) {
        trace.push(`${u.name}:${e.code || 'ERR'}`);
        this.#fail(u);
      }
    }
    if (last) return { ...last, status: 502, upstream: null, trace, id };
    const msg = JSON.stringify({ error: attempts ? 'all attempts failed' : 'no healthy backend' });
    return { status: 503, headers: {}, body: Buffer.from(msg), upstream: null, trace, id };
  }
}

// ---------------------------------------------------------------- proxy server
class ChecksumTransform extends Transform {
  #hash = crypto.createHash('sha1');
  #bytes = 0;
  _transform(chunk, enc, cb) {
    this.#hash.update(chunk);
    this.#bytes += chunk.length;
    cb(null, chunk);
  }
  _flush(cb) {
    this.digest = this.#hash.digest('hex').slice(0, 10);
    cb();
  }
  get bytes() {
    return this.#bytes;
  }
}

class Collector extends Writable {
  constructor() {
    super();
    this.parts = [];
  }
  _write(chunk, enc, cb) {
    this.parts.push(chunk);
    cb();
  }
  get buffer() {
    return Buffer.concat(this.parts);
  }
}

function makeConfig(obj) {
  const reads = new Map();
  const config = new Proxy(obj, {
    get(t, k, r) {
      if (typeof k === 'string') reads.set(k, (reads.get(k) || 0) + 1);
      return Reflect.get(t, k, r);
    },
    set(t, k) {
      throw new TypeError(`config is read-only: ${String(k)}`);
    },
    has(t, k) {
      return k in t;
    },
  });
  return { config, reads };
}

class ProxyServer {
  #lb;
  #server = null;
  #access = [];
  port = 0;

  constructor(lb, config) {
    this.#lb = lb;
    this.config = config;
  }

  get accessLog() {
    return this.#access.slice();
  }

  async #handle(req, res) {
    const body = await readBody(req);
    if (req.url.startsWith(this.config.adminPrefix)) return this.#admin(req, res);
    if (this.config.blocked.some((re) => re.test(req.url))) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      this.#access.push({ id: 0, method: req.method, url: req.url, status: 403, upstream: '-', bytes: 9 });
      return res.end('forbidden');
    }
    const out = await this.#lb.forward(req.method, req.url, { ...req.headers, 'x-via': this.config.name }, body);
    const ck = new ChecksumTransform();
    const sink = new Collector();
    await pipe(Readable.from([out.body]), ck, sink);
    const headers = {
      'content-type': out.headers['content-type'] || 'application/json',
      'x-upstream': out.upstream || 'none',
      'x-trace': out.trace.join(','),
      'x-body-sha': ck.digest,
    };
    res.writeHead(out.status, headers);
    res.end(sink.buffer);
    this.#access.push({ id: out.id, method: req.method, url: req.url, status: out.status, upstream: out.upstream || '-', bytes: ck.bytes });
  }

  async #admin(req, res) {
    const route = req.url.slice(this.config.adminPrefix.length);
    let payload;
    if (route === 'stats') payload = this.#lb.upstreams.map((u) => u.toJSON());
    else if (route === 'health') payload = await this.#lb.healthCheck();
    else if (route === 'events') payload = this.#lb.events;
    else payload = { error: 'unknown admin route', route };
    const s = JSON.stringify(payload);
    res.writeHead(payload.error ? 404 : 200, { 'content-type': 'application/json' });
    res.end(s);
  }

  async start() {
    this.#server = http.createServer((q, s) => {
      this.#handle(q, s).catch((e) => {
        res500(s, e);
      });
    });
    this.#server.listen(0, HOST);
    await once(this.#server, 'listening');
    this.port = this.#server.address().port;
  }

  async stop() {
    const s = this.#server;
    if (!s) return;
    this.#server = null;
    const closed = once(s, 'close');
    s.closeAllConnections();
    s.close();
    await closed;
  }
}

function res500(res, e) {
  if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('proxy error: ' + e.message);
}

// ---------------------------------------------------------------- pure algorithms
function* smoothWeighted(nodes, rounds) {
  const cur = nodes.map(() => 0);
  const total = nodes.reduce((a, n) => a + n.weight, 0);
  for (let r = 0; r < rounds; r++) {
    let best = -1;
    for (let i = 0; i < nodes.length; i++) {
      cur[i] += nodes[i].weight;
      if (best < 0 || cur[i] > cur[best]) best = i;
    }
    cur[best] -= total;
    yield nodes[best].name;
  }
}

class HashRing {
  #ring = [];
  constructor(names, vnodes = 16) {
    for (const n of names) {
      for (let v = 0; v < vnodes; v++) {
        const h = crypto.createHash('sha1').update(`${n}#${v}`).digest();
        this.#ring.push({ point: h.readUInt32BE(0), name: n });
      }
    }
    this.#ring.sort((a, b) => a.point - b.point || (a.name < b.name ? -1 : 1));
  }
  lookup(key) {
    const p = crypto.createHash('sha1').update(key).digest().readUInt32BE(0);
    let lo = 0, hi = this.#ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#ring[mid].point < p) lo = mid + 1;
      else hi = mid;
    }
    return this.#ring[lo % this.#ring.length].name;
  }
  get size() {
    return this.#ring.length;
  }
}

class AccessFormatter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.n = 0;
  }
  _transform(entry, enc, cb) {
    this.n++;
    const { id, method, url, status, upstream, bytes } = entry;
    cb(null, `${String(this.n).padStart(2, '0')} #${id} ${pad(method, 4)} ${pad(url, 22)} ${status} ${pad(upstream, 2)} ${bytes}b\n`);
  }
}

// ---------------------------------------------------------------- client scenario
async function* requestPlan(list) {
  for (const item of list) {
    await null;
    yield typeof item === 'string' ? { method: 'GET', path: item } : item;
  }
}

function summarize(r) {
  let parsed = null;
  try {
    parsed = JSON.parse(r.body.toString('utf8'));
  } catch {
    parsed = r.body.toString('utf8').trim();
  }
  return parsed;
}

async function main() {
  const backends = [new Backend('A', 3), new Backend('B', 2), new Backend('C', 1)];
  const stateLog = [];
  for (const b of backends) {
    b.on('state', (name, up) => stateLog.push(`${name}=${up ? 'up' : 'down'}`));
    await b.start();
  }
  console.log(`backends started: ${backends.map((b) => b.name + '#' + b.serial).join(', ')} registry=${Backend.registry.size}`);

  const lb = new LoadBalancer({ maxAttempts: 3, failThreshold: 2 });
  backends.forEach((b) => lb.add(b));
  const { config, reads } = makeConfig({ name: 'edge-1', adminPrefix: '/__lb/', blocked: [/^\/secret/, /\.\.\//] });
  const proxy = new ProxyServer(lb, config);
  await proxy.start();
  const call = (method, p, body, headers = {}) => httpCall(proxy.port, { method, path: p, body, headers });
  const get = (p, headers) => call('GET', p, null, headers);

  try {
    config.name = 'hacked';
  } catch (e) {
    console.log('config write rejected: ' + e.message);
  }

  Section.open('initial health');
  for (const h of summarize(await get('/__lb/health'))) console.log(`  ${h.name} up=${h.up} (${h.why})`);

  Section.open('round robin');
  for (let i = 0; i < 6; i++) {
    const r = await get('/whoami');
    const j = summarize(r);
    console.log(`  req ${i + 1}: via=${r.headers['x-upstream']} backend=${j.backend} hits=${j.hits} sha=${r.headers['x-body-sha']}`);
  }

  Section.open('echo bodies');
  for (const text of ['hello', 'proxy über alles', '{"json":true}', '']) {
    const r = await call('POST', '/echo', text);
    const j = summarize(r);
    console.log(`  ${JSON.stringify(text)} -> ${j.backend} rev=${JSON.stringify(j.reversed)} len=${j.len} sha=${j.sha}`);
  }

  Section.open('bigint compute');
  for (const n of [10, 50, 93, 200, 999]) {
    const r = await get(`/compute/${n}`);
    const j = summarize(r);
    if (r.status !== 200) console.log(`  n=${n} status=${r.status} error=${j.error}`);
    else console.log(`  n=${n} fib=${j.fib} digits=${j.digits} sum=${j.digitSum} (${j.backend})`);
  }

  Section.open('header forwarding');
  {
    const r = await get('/headers', { 'x-client': 'suite', 'x-empty': '' });
    const j = summarize(r);
    for (const [k, v] of Object.entries(j.headers)) console.log(`  ${j.backend} saw ${k}: ${v}`);
  }

  Section.open('query params and 404');
  {
    const r1 = await get('/query?b=2&a=1&name=x%20y');
    console.log(`  query -> ${stable(summarize(r1).query)}`);
    const r2 = await get('/nowhere');
    console.log(`  404 -> status=${r2.status} trace=${r2.headers['x-trace']}`);
    const r3 = await get('/secret/key');
    console.log(`  blocked -> status=${r3.status} body=${r3.body.toString()}`);
  }

  Section.open('flaky upstream retries');
  Backend.registry.get('B').failNext(1);
  Backend.registry.get('C').failNext(1);
  for (let i = 0; i < 4; i++) {
    const r = await get('/flaky');
    console.log(`  flaky ${i + 1}: status=${r.status} upstream=${r.headers['x-upstream']} trace=${r.headers['x-trace']}`);
  }

  Section.open('crash route exhausts attempts');
  {
    const r = await get('/crash');
    console.log(`  crash: status=${r.status} trace=${r.headers['x-trace']}`);
    console.log(`  healthy after crash: ${lb.healthyNames.join(',') || '(none)'}`);
    for (const h of summarize(await get('/__lb/health'))) console.log(`  recheck ${h.name} up=${h.up}`);
  }

  Section.open('mark C unhealthy');
  Backend.registry.get('C').healthy = false;
  for (const h of summarize(await get('/__lb/health'))) console.log(`  ${h.name} up=${h.up} (${h.why})`);
  for (let i = 0; i < 4; i++) {
    const r = await get('/whoami');
    console.log(`  after C down ${i + 1}: via=${r.headers['x-upstream']}`);
  }

  Section.open('kill backend A');
  const ejected = once(lb, 'ejected');
  await Backend.registry.get('A').stop();
  console.log(`  A running=${Backend.registry.get('A').running}`);
  for (let i = 0; i < 4; i++) {
    const r = await get('/whoami');
    console.log(`  with A dead ${i + 1}: status=${r.status} via=${r.headers['x-upstream']} trace=${r.headers['x-trace']}`);
  }
  const [who] = await ejected;
  console.log(`  ejected event for ${who}`);

  Section.open('all down');
  Backend.registry.get('B').healthy = false;
  for (const h of summarize(await get('/__lb/health'))) console.log(`  ${h.name} up=${h.up} (${h.why})`);
  {
    const r = await get('/whoami');
    console.log(`  status=${r.status} body=${r.body.toString()} trace=${JSON.stringify(r.headers['x-trace'])}`);
  }
  const watchdog = new EventEmitter();
  const alarm = once(watchdog, 'ok');
  queueMicrotask(() => watchdog.emit('error', new Error(`no capacity (${lb.healthyNames.length} healthy)`)));
  try {
    await alarm;
  } catch (e) {
    console.log(`  watchdog: ${e.message}`);
  }

  Section.open('recovery');
  Backend.registry.get('C').healthy = true;
  await Backend.registry.get('A').start();
  for (const h of summarize(await get('/__lb/health'))) console.log(`  ${h.name} up=${h.up} (${h.why})`);
  for await (const item of requestPlan(['/whoami', '/whoami', '/whoami', { method: 'POST', path: '/echo', body: 'back' }])) {
    const r = await call(item.method, item.path, item.body ?? null);
    const j = summarize(r);
    console.log(`  ${item.method} ${item.path} -> ${j.backend} ${j.hits !== undefined ? 'hits=' + j.hits : 'rev=' + j.reversed}`);
  }

  Section.open('streamed response');
  {
    const r = await get('/stream/5');
    const lines = r.body.toString().trim().split('\n');
    lines.forEach((l) => console.log(`  ${l}`));
    console.log(`  lines=${lines.length} sha=${r.headers['x-body-sha']}`);
  }

  Section.open('stats and events');
  for (const u of summarize(await get('/__lb/stats'))) {
    console.log(`  ${u.name} up=${u.up} served=${u.served} errors=${u.errors} fails=${u.fails}`);
  }
  console.log(`  events: ${summarize(await get('/__lb/events')).join(' ')}`);
  console.log(`  backend state changes: ${stateLog.join(' ')}`);
  console.log(`  backend hits: ${backends.map((b) => `${b.name}=${b.hits}`).join(' ')}`);
  const adminBad = await get('/__lb/nope');
  console.log(`  admin unknown -> ${adminBad.status} ${adminBad.body.toString()}`);

  Section.open('smooth weighted round robin');
  const seq = [...smoothWeighted(backends.map((b) => ({ name: b.name, weight: b.weight })), 12)];
  console.log(`  order: ${seq.join('')}`);
  const counts = seq.reduce((m, n) => ((m[n] = (m[n] || 0) + 1), m), {});
  console.log(`  counts: ${stable(counts)}`);

  Section.open('consistent hashing');
  const ring = new HashRing(backends.map((b) => b.name));
  const ring2 = new HashRing(['A', 'B']);
  let moved = 0;
  for (let k = 0; k < 8; k++) {
    const key = `session-${k * 7}`;
    const a = ring.lookup(key), b = ring2.lookup(key);
    if (a !== b) moved++;
    console.log(`  ${pad(key, 11)} -> ${a} (without C: ${b})`);
  }
  console.log(`  ring size=${ring.size} moved=${moved}`);

  Section.open('access log');
  const formatter = new AccessFormatter();
  const out = new Collector();
  await pipe(Readable.from(proxy.accessLog), formatter, out);
  const logLines = out.buffer.toString().trim().split('\n');
  logLines.slice(0, 12).forEach((l) => console.log('  ' + l));
  console.log(`  ... total entries=${formatter.n} digest=${sha1(out.buffer)}`);
  const byStatus = {};
  for (const e of proxy.accessLog) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  console.log(`  by status: ${stable(byStatus)}`);

  Section.open('config reads');
  for (const [k, v] of [...reads.entries()].sort()) console.log(`  ${k}: ${v > 10 ? '>10' : v}`);

  await proxy.stop();
  for (const b of backends) await b.stop();
  console.log(`sections=${Section.count} done`);
}

process.on('exit', (code) => {
  console.log(`exit code ${code}`);
});

main().catch((e) => {
  console.log('FATAL ' + e.stack);
  process.exitCode = 1;
});
