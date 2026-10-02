'use strict';
// n09: auth API with scrypt password hashing (fixed salts), HMAC-signed tokens,
// refresh-token rotation with reuse detection, revocation, role guards and
// several rate-limiting strategies driven by a simulated clock (x-sim-time header).
const http = require('http');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { Readable, Transform, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const pipe = promisify(pipeline);
const SECRET = Buffer.from('corpus-n09-server-secret-key-000', 'utf8');
const SCRYPT_OPTS = { N: 1024, r: 8, p: 1 };

// ---------------------------------------------------------------- encoding helpers
const b64url = {
  encode(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new AuthError('malformed token encoding', 401);
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
  },
};

function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest();
}

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(str, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function shardOf(key, shards = 4) {
  return Number(fnv1a64(key) % BigInt(shards));
}

class AuthError extends Error {
  constructor(message, status = 401, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- password policy
function* policyViolations(password, username) {
  if (password.length < 8) yield 'too short';
  if (!/[A-Z]/.test(password)) yield 'needs uppercase';
  if (!/[0-9]/.test(password)) yield 'needs digit';
  if (!/[^A-Za-z0-9]/.test(password)) yield 'needs symbol';
  if (password.toLowerCase().includes(username.toLowerCase())) yield 'contains username';
  let run = 1;
  scan: for (let i = 1; i < password.length; i++) {
    run = password[i] === password[i - 1] ? run + 1 : 1;
    if (run >= 3) {
      yield 'repeated characters';
      break scan;
    }
  }
}

async function hashPassword(username, password) {
  const salt = crypto.createHash('sha256').update('salt:' + username).digest().subarray(0, 16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT_OPTS);
  return `scrypt$${SCRYPT_OPTS.N}$${b64url.encode(salt)}$${b64url.encode(key)}`;
}

async function verifyPassword(stored, password) {
  const [scheme, n, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const key = await scrypt(password.normalize('NFKC'), b64url.decode(saltB64), 32, { ...SCRYPT_OPTS, N: Number(n) });
  const expected = b64url.decode(keyB64);
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

// ---------------------------------------------------------------- tokens
class TokenService {
  #revoked = new Set();
  #refresh = new Map();
  #families = new Map();
  #seq = 0;
  static TTL = 300;
  static REFRESH_TTL = 3600;
  static {
    TokenService.HEADER = b64url.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  }

  #jti() {
    this.#seq++;
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(this.#seq, 0);
    buf.writeUInt32BE(hmac('jti:' + this.#seq).readUInt32BE(0), 4);
    return buf.toString('hex');
  }

  sign(payload) {
    const body = b64url.encode(JSON.stringify(payload));
    const sig = b64url.encode(hmac(`${TokenService.HEADER}.${body}`));
    return `${TokenService.HEADER}.${body}.${sig}`;
  }

  issue(user, now, family = null) {
    const jti = this.#jti();
    const access = this.sign({ sub: user.name, role: user.role, iat: now, exp: now + TokenService.TTL, jti });
    const refresh = b64url.encode(hmac('refresh:' + jti)).slice(0, 32);
    const fam = family || 'fam-' + jti.slice(-6);
    this.#refresh.set(refresh, { sub: user.name, exp: now + TokenService.REFRESH_TTL, family: fam, used: false, jti });
    if (!this.#families.has(fam)) this.#families.set(fam, new Set());
    this.#families.get(fam).add(jti);
    return { access, refresh, jti, family: fam };
  }

  verify(token, now) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('malformed token');
    const [h, p, s] = parts;
    const header = JSON.parse(b64url.decode(h).toString('utf8'));
    if (header.alg !== 'HS256') throw new AuthError(`unsupported alg ${header.alg}`);
    const expected = hmac(`${h}.${p}`);
    const got = b64url.decode(s);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new AuthError('bad signature');
    const payload = JSON.parse(b64url.decode(p).toString('utf8'));
    if (payload.exp <= now) throw new AuthError('token expired', 401, { expiredBy: now - payload.exp });
    if (payload.iat > now) throw new AuthError('token used before issued');
    if (this.#revoked.has(payload.jti)) throw new AuthError('token revoked');
    return payload;
  }

  rotate(refreshToken, now, users) {
    const rec = this.#refresh.get(refreshToken);
    if (!rec) throw new AuthError('unknown refresh token');
    if (rec.used) {
      for (const j of this.#families.get(rec.family)) this.#revoked.add(j);
      throw new AuthError('refresh token reuse detected; family revoked', 401, { family: rec.family });
    }
    if (rec.exp <= now) throw new AuthError('refresh token expired');
    rec.used = true;
    return this.issue(users.get(rec.sub), now, rec.family);
  }

  revoke(jti) {
    this.#revoked.add(jti);
  }

  get stats() {
    return { issued: this.#seq, revoked: this.#revoked.size, families: this.#families.size, refreshTokens: this.#refresh.size };
  }
}

// ---------------------------------------------------------------- rate limiters
class RateLimiter {
  static strategies = new Map();
  static register(name, cls) {
    RateLimiter.strategies.set(name, cls);
  }
  static create(name, opts) {
    const Cls = RateLimiter.strategies.get(name);
    if (!Cls) throw new Error('unknown limiter ' + name);
    return new Cls(opts);
  }
  check() {
    throw new Error('abstract');
  }
}

class TokenBucket extends RateLimiter {
  #buckets = new Map();
  constructor({ capacity, refillPerSec }) {
    super();
    this.capacity = capacity;
    this.refill = refillPerSec;
  }
  check(key, now) {
    const b = this.#buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refill);
    b.at = now;
    this.#buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    }
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((1 - b.tokens) / this.refill) };
  }
}

class SlidingWindowLog extends RateLimiter {
  #logs = new Map();
  constructor({ limit, windowSec }) {
    super();
    this.limit = limit;
    this.window = windowSec;
  }
  check(key, now) {
    const log = (this.#logs.get(key) || []).filter((t) => t > now - this.window);
    if (log.length >= this.limit) {
      this.#logs.set(key, log);
      return { allowed: false, remaining: 0, retryAfter: log[0] + this.window - now };
    }
    log.push(now);
    this.#logs.set(key, log);
    return { allowed: true, remaining: this.limit - log.length };
  }
  reset(key) {
    this.#logs.delete(key);
  }
}

class FixedWindow extends RateLimiter {
  #counts = new Map();
  constructor({ limit, windowSec }) {
    super();
    this.limit = limit;
    this.window = windowSec;
  }
  check(key, now) {
    const win = Math.floor(now / this.window);
    const k = `${key}@${win}`;
    const n = (this.#counts.get(k) || 0) + 1;
    this.#counts.set(k, n);
    if (n > this.limit) return { allowed: false, remaining: 0, retryAfter: (win + 1) * this.window - now };
    return { allowed: true, remaining: this.limit - n };
  }
}

RateLimiter.register('bucket', TokenBucket);
RateLimiter.register('sliding', SlidingWindowLog);
RateLimiter.register('fixed', FixedWindow);

// ---------------------------------------------------------------- audit log
class AuditLog extends EventEmitter {
  #entries = [];
  record(type, detail) {
    const entry = { n: this.#entries.length + 1, type, ...detail };
    this.#entries.push(entry);
    this.emit('entry', entry);
    if (type === 'breach') this.emit('alert', entry);
  }
  get entries() {
    return this.#entries.slice();
  }
}

class AuditFormatter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }
  _transform(e, enc, cb) {
    const { n, type, ...rest } = e;
    const detail = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join(' ');
    cb(null, `${String(n).padStart(3, '0')} ${type.padEnd(14)} ${detail}\n`);
  }
}

// ---------------------------------------------------------------- app framework
function compose(middlewares) {
  return function run(ctx) {
    let last = -1;
    const dispatch = async (i) => {
      if (i <= last) throw new Error('next() called twice');
      last = i;
      const fn = middlewares[i];
      if (fn) await fn(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}

class App {
  #routes = [];
  #middleware = [];
  use(fn) {
    this.#middleware.push(fn);
    return this;
  }
  route(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    this.#routes.push({ method, re, keys, handlers });
    return this;
  }
  #router() {
    return async (ctx, next) => {
      for (const r of this.#routes) {
        const m = r.method === ctx.method && r.re.exec(ctx.path);
        if (!m) continue;
        r.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
        ctx.route = `${r.method} ${r.re.source}`;
        return compose(r.handlers)(ctx);
      }
      ctx.status = 404;
      ctx.body = { error: 'not found' };
      return next();
    };
  }
  handler() {
    const chain = compose([...this.#middleware, this.#router()]);
    return async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const [path, qs = ''] = req.url.split('?');
      const ctx = { req, method: req.method, path, query: new URLSearchParams(qs), headers: req.headers, raw: Buffer.concat(chunks), params: {}, status: 200, body: null, resHeaders: {}, state: {} };
      await chain(ctx);
      const text = JSON.stringify(ctx.body);
      res.writeHead(ctx.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...ctx.resHeaders });
      res.end(text);
    };
  }
}

// ---------------------------------------------------------------- server setup
function buildApp() {
  const users = new Map();
  const tokens = new TokenService();
  const audit = new AuditLog();
  const limits = {
    login: RateLimiter.create('sliding', { limit: 3, windowSec: 60 }),
    api: RateLimiter.create('bucket', { capacity: 4, refillPerSec: 0.5 }),
    register: RateLimiter.create('fixed', { limit: 6, windowSec: 100 }),
  };
  const permissions = new Proxy({ ADMIN: ['read', 'write', 'admin'], USER: ['read'] }, {
    get: (t, role) => (Object.prototype.hasOwnProperty.call(t, role) ? t[role] : []),
  });
  let failedLogins = 0;

  const app = new App();
  // error handler
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      ctx.status = e.status || 500;
      ctx.body = { error: e.message, ...e.extra };
      if (ctx.status === 401) ctx.resHeaders['www-authenticate'] = 'Bearer realm="corpus"';
      audit.record('error', { path: ctx.path, status: ctx.status, msg: e.message.split(';')[0] });
    }
  });
  // simulated clock + request id
  let reqId = 0;
  app.use(async (ctx, next) => {
    ctx.now = Number(ctx.headers['x-sim-time'] ?? 0);
    if (!Number.isInteger(ctx.now) || ctx.now < 0) throw new AuthError('bad x-sim-time', 400);
    ctx.id = ++reqId;
    ctx.resHeaders['x-request-id'] = String(ctx.id);
    await next();
  });
  // JSON body
  app.use(async (ctx, next) => {
    if (ctx.raw.length) {
      if (!/^application\/json/.test(ctx.headers['content-type'] || '')) throw new AuthError('expected JSON', 415);
      try {
        ctx.json = JSON.parse(ctx.raw.toString('utf8'));
      } catch {
        throw new AuthError('invalid JSON', 400);
      }
    } else ctx.json = {};
    await next();
  });

  const limit = (name, keyFn) => async (ctx, next) => {
    const key = keyFn(ctx);
    const r = limits[name].check(key, ctx.now);
    ctx.resHeaders['x-ratelimit-remaining'] = String(r.remaining);
    if (!r.allowed) {
      ctx.resHeaders['retry-after'] = String(r.retryAfter);
      audit.record('ratelimited', { limiter: name, key, shard: shardOf(key), retry: r.retryAfter });
      throw new AuthError('rate limit exceeded', 429, { retryAfter: r.retryAfter });
    }
    await next();
  };

  const authenticate = async (ctx, next) => {
    const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]*)$/.exec(ctx.headers.authorization || '');
    if (!m) throw new AuthError('missing bearer token');
    ctx.state.claims = tokens.verify(m[1], ctx.now);
    ctx.state.user = users.get(ctx.state.claims.sub);
    if (!ctx.state.user) throw new AuthError('user no longer exists');
    await next();
  };

  const requirePerm = (perm) => async (ctx, next) => {
    if (!permissions[ctx.state.claims.role].includes(perm)) {
      audit.record('forbidden', { sub: ctx.state.claims.sub, perm });
      throw new AuthError(`requires ${perm}`, 403);
    }
    await next();
  };

  app.route('POST', '/register', limit('register', () => 'global'), async (ctx) => {
    const { username = '', password = '', role } = ctx.json;
    if (!/^[a-z][a-z0-9_]{2,15}$/.test(username)) throw new AuthError('invalid username', 400);
    if (users.has(username)) throw new AuthError('username taken', 409);
    const problems = [...policyViolations(password, username)];
    if (problems.length) throw new AuthError('weak password', 400, { problems });
    const isFirst = users.size === 0;
    users.set(username, { name: username, role: isFirst || role === 'ADMIN' && isFirst ? 'ADMIN' : 'USER', hash: await hashPassword(username, password), created: ctx.now });
    audit.record('register', { user: username, role: users.get(username).role });
    ctx.status = 201;
    ctx.body = { user: username, role: users.get(username).role, hashPrefix: users.get(username).hash.slice(0, 18) };
  });

  app.route('POST', '/login', limit('login', (ctx) => 'ip:' + (ctx.json.username || '?')), async (ctx) => {
    const { username, password } = ctx.json;
    const u = users.get(username);
    const ok = u ? await verifyPassword(u.hash, password || '') : false;
    if (!ok) {
      failedLogins++;
      audit.record('login-fail', { user: username, total: failedLogins });
      if (failedLogins % 4 === 0) audit.record('breach', { suspect: username });
      throw new AuthError('invalid credentials');
    }
    limits.login.reset('ip:' + username);
    const t = tokens.issue(u, ctx.now);
    audit.record('login', { user: username, jti: t.jti.slice(0, 8) });
    ctx.body = { access: t.access, refresh: t.refresh, family: t.family, expiresIn: TokenService.TTL };
  });

  app.route('POST', '/refresh', async (ctx) => {
    const t = tokens.rotate(ctx.json.refresh || '', ctx.now, users);
    audit.record('refresh', { family: t.family, jti: t.jti.slice(0, 8) });
    ctx.body = { access: t.access, refresh: t.refresh, family: t.family };
  });

  app.route('POST', '/logout', authenticate, async (ctx) => {
    tokens.revoke(ctx.state.claims.jti);
    audit.record('logout', { user: ctx.state.claims.sub });
    ctx.body = { ok: true };
  });

  app.route('GET', '/me', authenticate, limit('api', (ctx) => 'user:' + ctx.state.claims.sub), async (ctx) => {
    const { name, role, created } = ctx.state.user;
    ctx.body = { name, role, created, perms: permissions[role], ttl: ctx.state.claims.exp - ctx.now };
  });

  app.route('GET', '/data/:n', authenticate, limit('api', (ctx) => 'user:' + ctx.state.claims.sub), requirePerm('read'), async (ctx) => {
    const n = Number(ctx.params.n);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new AuthError('n out of range', 400);
    let acc = 1n;
    for (let i = 1n; i <= BigInt(n); i++) acc *= i;
    ctx.body = { n, factorial: acc.toString().length > 24 ? acc.toString().slice(0, 12) + '...' : acc.toString(), digits: acc.toString().length };
  });

  app.route('POST', '/password', authenticate, async (ctx) => {
    const { current, next: nextPw } = ctx.json;
    const u = ctx.state.user;
    if (!(await verifyPassword(u.hash, current || ''))) throw new AuthError('current password wrong', 403);
    const problems = [...policyViolations(nextPw || '', u.name)];
    if (problems.length) throw new AuthError('weak password', 400, { problems });
    u.hash = await hashPassword(u.name, nextPw);
    tokens.revoke(ctx.state.claims.jti);
    audit.record('password', { user: u.name });
    ctx.body = { ok: true, hashTail: u.hash.slice(-12) };
  });

  app.route('GET', '/admin/users', authenticate, requirePerm('admin'), async (ctx) => {
    ctx.body = [...users.values()].map(({ name, role }) => ({ name, role })).sort((a, b) => a.name.localeCompare(b.name));
  });

  app.route('GET', '/admin/stats', authenticate, requirePerm('admin'), async (ctx) => {
    ctx.body = { tokens: tokens.stats, users: users.size, failedLogins, audit: audit.entries.length };
  });

  return { app, audit, tokens, users };
}

// ---------------------------------------------------------------- client
class ApiClient {
  #port;
  #count = 0;
  constructor(port) {
    this.#port = port;
    this.time = 0;
  }
  advance(sec) {
    this.time += sec;
    return this;
  }
  request(method, path, { body, token, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw ?? (body !== undefined ? JSON.stringify(body) : null);
      const h = { 'x-sim-time': String(this.time), ...headers };
      if (payload != null) {
        h['content-type'] = h['content-type'] || 'application/json';
        h['content-length'] = Buffer.byteLength(payload);
      }
      if (token) h.authorization = 'Bearer ' + token;
      const req = http.request({ host: '127.0.0.1', port: this.#port, method, path, headers: h, agent: false }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          this.#count++;
          const text = Buffer.concat(parts).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(text) });
        });
      });
      req.on('error', reject);
      if (payload != null) req.write(payload);
      req.end();
    });
  }
  get count() {
    return this.#count;
  }
}

function show(label, r, pick) {
  const extra = [];
  if (r.headers['x-ratelimit-remaining'] !== undefined) extra.push(`rl=${r.headers['x-ratelimit-remaining']}`);
  if (r.headers['retry-after']) extra.push(`retry=${r.headers['retry-after']}`);
  const body = pick ? pick(r.json) : r.json;
  console.log(`${label.padEnd(30)} ${r.status} ${JSON.stringify(body)}${extra.length ? ' [' + extra.join(' ') + ']' : ''}`);
}

function tamper(token, fn) {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(b64url.decode(p).toString('utf8'));
  fn(payload);
  return `${h}.${b64url.encode(JSON.stringify(payload))}.${s}`;
}

// ---------------------------------------------------------------- main
async function main() {
  const { app, audit, tokens } = buildApp();
  const alerts = [];
  audit.on('alert', (e) => alerts.push(`#${e.n} suspect=${e.suspect}`));
  const server = http.createServer(app.handler());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = new ApiClient(server.address().port);

  console.log('--- helpers ---');
  for (const w of ['alice', 'bob', 'mallory', 'user:alice']) console.log(`fnv1a64(${w}) = ${fnv1a64(w).toString(16).padStart(16, '0')} shard=${shardOf(w)}`);
  console.log('b64url roundtrip: ' + b64url.decode(b64url.encode(Buffer.from([251, 255, 0, 62, 63]))).toString('hex'));
  for (const [pw, user] of [['short', 'x'], ['alllowercase1!', 'y'], ['Aaa111!!!x', 'z'], ['Alice#2024x', 'alice'], ['Str0ng#Pass', 'bob']]) {
    console.log(`policy ${JSON.stringify(pw)}: ${[...policyViolations(pw, user)].join(', ') || 'ok'}`);
  }

  console.log('--- registration ---');
  show('register alice', await api.request('POST', '/register', { body: { username: 'alice', password: 'Wonder#Land9' } }));
  show('register bob', await api.request('POST', '/register', { body: { username: 'bob', password: 'Build3r!Kng', role: 'ADMIN' } }));
  show('register dup', await api.request('POST', '/register', { body: { username: 'bob', password: 'Build3r!Kng' } }));
  show('register weak', await api.request('POST', '/register', { body: { username: 'carol', password: 'carol' } }));
  show('register bad name', await api.request('POST', '/register', { body: { username: '9lives', password: 'Str0ng#Pass' } }));
  show('register mallory', await api.request('POST', '/register', { body: { username: 'mallory', password: 'Ev1l#Plans' } }));
  show('register limit', await api.request('POST', '/register', { body: { username: 'dave', password: 'Str0ng#Pass' } }));
  api.advance(100);
  show('register after window', await api.request('POST', '/register', { body: { username: 'dave', password: 'Str0ng#Pass' } }));
  const daveTok = (await api.request('POST', '/login', { body: { username: 'dave', password: 'Str0ng#Pass' } })).json.access;
  console.log(`dave token segments: ${daveTok.split('.').map((x) => x.length).join('/')}`);
  show('wrong content-type', await api.request('POST', '/register', { raw: 'username=x', headers: { 'content-type': 'text/plain' } }));
  show('invalid json', await api.request('POST', '/register', { raw: '{"username":' }));

  console.log('--- login ---');
  const la = await api.request('POST', '/login', { body: { username: 'alice', password: 'Wonder#Land9' } });
  show('login alice', la, (j) => ({ family: j.family, expiresIn: j.expiresIn, parts: j.access.split('.').length }));
  const aliceTok = la.json.access;
  const claims = JSON.parse(b64url.decode(aliceTok.split('.')[1]).toString());
  console.log(`alice claims: ${JSON.stringify(claims)}`);
  show('me', await api.request('GET', '/me', { token: aliceTok }));
  for (let i = 1; i <= 4; i++) show(`bad login #${i}`, await api.request('POST', '/login', { body: { username: 'bob', password: 'guess' + i } }));
  api.advance(30);
  show('bob still locked', await api.request('POST', '/login', { body: { username: 'bob', password: 'Build3r!Kng' } }));
  api.advance(31);
  const lb = await api.request('POST', '/login', { body: { username: 'bob', password: 'Build3r!Kng' } });
  show('bob after window', lb, (j) => ({ family: j.family }));
  const bobTok = lb.json.access;
  show('unknown user', await api.request('POST', '/login', { body: { username: 'zed', password: 'x' } }));

  console.log('--- token checks ---');
  show('no token', await api.request('GET', '/me'), (j) => j.error);
  show('garbage token', await api.request('GET', '/me', { token: 'abc' }), (j) => j.error);
  show('tampered role', await api.request('GET', '/admin/users', { token: tamper(daveTok, (p) => (p.role = 'ADMIN')) }), (j) => j.error);
  show('tampered exp', await api.request('GET', '/me', { token: tamper(aliceTok, (p) => (p.exp += 9999)) }), (j) => j.error);
  const noneTok = b64url.encode(JSON.stringify({ alg: 'none' })) + '.' + aliceTok.split('.')[1] + '.';
  show('alg none', await api.request('GET', '/me', { token: noneTok }), (j) => j.error);
  const forged = tokens.sign({ sub: 'ghost', role: 'ADMIN', iat: api.time, exp: api.time + 10, jti: 'x' });
  show('valid sig, ghost user', await api.request('GET', '/me', { token: forged }), (j) => j.error);
  show('future iat', await api.request('GET', '/me', { token: tokens.sign({ ...claims, iat: api.time + 50, exp: api.time + 100 }) }), (j) => j.error);

  console.log('--- roles ---');
  show('dave admin/users', await api.request('GET', '/admin/users', { token: daveTok }), (j) => j.error);
  show('alice admin/users', await api.request('GET', '/admin/users', { token: aliceTok }));
  show('bob data/20', await api.request('GET', '/data/20', { token: bobTok }));
  show('bob data/99', await api.request('GET', '/data/99', { token: bobTok }), (j) => j.error);

  console.log('--- token bucket ---');
  for (let i = 1; i <= 5; i++) show(`alice data/${i * 5}`, await api.request('GET', `/data/${i * 5}`, { token: aliceTok }));
  api.advance(2);
  show('alice after 2s', await api.request('GET', '/data/30', { token: aliceTok }));
  show('alice again', await api.request('GET', '/data/31', { token: aliceTok }));
  api.advance(10);
  show('alice after 10s', await api.request('GET', '/me', { token: aliceTok }), (j) => ({ ttl: j.ttl, perms: j.perms }));

  console.log('--- expiry + refresh ---');
  api.advance(400);
  show('alice expired', await api.request('GET', '/me', { token: aliceTok }));
  const r1 = await api.request('POST', '/refresh', { body: { refresh: la.json.refresh } });
  show('refresh #1', r1, (j) => ({ family: j.family }));
  show('me with refreshed', await api.request('GET', '/me', { token: r1.json.access }), (j) => ({ name: j.name, ttl: j.ttl }));
  const r2 = await api.request('POST', '/refresh', { body: { refresh: r1.json.refresh } });
  show('refresh #2', r2, (j) => ({ family: j.family }));
  show('reuse old refresh', await api.request('POST', '/refresh', { body: { refresh: la.json.refresh } }));
  show('family revoked', await api.request('GET', '/me', { token: r2.json.access }), (j) => j.error);
  show('unknown refresh', await api.request('POST', '/refresh', { body: { refresh: 'nope' } }), (j) => j.error);

  console.log('--- password change + logout ---');
  const lm = await api.request('POST', '/login', { body: { username: 'mallory', password: 'Ev1l#Plans' } });
  const malTok = lm.json.access;
  show('change wrong current', await api.request('POST', '/password', { token: malTok, body: { current: 'x', next: 'N3w#Secret' } }), (j) => j.error);
  show('change weak', await api.request('POST', '/password', { token: malTok, body: { current: 'Ev1l#Plans', next: 'weak' } }));
  show('change ok', await api.request('POST', '/password', { token: malTok, body: { current: 'Ev1l#Plans', next: 'N3w#Secret' } }));
  show('old token after change', await api.request('GET', '/me', { token: malTok }), (j) => j.error);
  show('login old password', await api.request('POST', '/login', { body: { username: 'mallory', password: 'Ev1l#Plans' } }), (j) => j.error);
  const lm2 = await api.request('POST', '/login', { body: { username: 'mallory', password: 'N3w#Secret' } });
  show('login new password', lm2, (j) => ({ family: j.family }));
  show('logout', await api.request('POST', '/logout', { token: lm2.json.access }));
  show('after logout', await api.request('GET', '/me', { token: lm2.json.access }), (j) => j.error);

  console.log('--- misc ---');
  show('404', await api.request('GET', '/nope'));
  show('bad sim time', await api.request('GET', '/me', { headers: { 'x-sim-time': '-5' } }));
  show('stale bob token', await api.request('GET', '/admin/stats', { token: bobTok }), (j) => j.error);
  const bobFresh = await api.request('POST', '/login', { body: { username: 'bob', password: 'Build3r!Kng' } });
  show('bob stats (forbidden)', await api.request('GET', '/admin/stats', { token: bobFresh.json.access }), (j) => j.error);
  api.advance(1);
  const fresh = await api.request('POST', '/login', { body: { username: 'alice', password: 'Wonder#Land9' } });
  show('admin stats', await api.request('GET', '/admin/stats', { token: fresh.json.access }));

  console.log('--- audit log ---');
  const collected = [];
  await pipe(Readable.from(audit.entries), new AuditFormatter(), new Writable({
    write(chunk, enc, cb) {
      collected.push(chunk.toString());
      cb();
    },
  }));
  const text = collected.join('');
  text.trim().split('\n').forEach((l) => console.log('  ' + l));
  const byType = audit.entries.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  console.log('  counts: ' + Object.keys(byType).sort().map((k) => `${k}=${byType[k]}`).join(' '));
  console.log('  alerts: ' + alerts.join(', '));
  console.log('  digest: ' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16));
  console.log(`requests sent: ${api.count}`);

  const closed = once(server, 'close');
  server.closeAllConnections();
  server.close();
  await closed;
}

process.on('exit', (code) => console.log(`exit ${code}`));
main().catch((e) => {
  console.log('FATAL ' + e.stack);
  process.exitCode = 1;
});
