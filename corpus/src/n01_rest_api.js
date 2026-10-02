'use strict';
// REST API server: router with params, JSON body parsing, middleware chain,
// error handler, plus an in-process client test suite over the http module.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------- errors
class HttpError extends Error {
  #status;
  constructor(status, message, details) {
    super(message);
    this.#status = status;
    this.details = details || null;
  }
  get status() { return this.#status; }
  toJSON() {
    const out = { error: this.message, status: this.#status };
    if (this.details) out.details = this.details;
    return out;
  }
}
class NotFoundError extends HttpError {
  constructor(what) { super(404, `${what} not found`); }
}
class ValidationError extends HttpError {
  constructor(fields) { super(422, 'validation failed', fields); }
}
class ConflictError extends HttpError {
  constructor(msg) { super(409, msg); }
}

// ---------------------------------------------------------------- router
function compilePath(pattern) {
  const keys = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        const opt = seg.endsWith('?');
        const name = opt ? seg.slice(1, -1) : seg.slice(1);
        keys.push(name);
        return opt ? '(?:/([^/]+))?' : '/([^/]+)';
      }
      if (seg === '*') { keys.push('wild'); return '/(.*)'; }
      return seg ? '/' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&') : '';
    })
    .join('');
  return { re: new RegExp('^' + (src || '/') + '/?$'), keys };
}

class Router {
  #routes = [];
  #middleware = [];
  #errorHandlers = [];
  static METHODS;
  static {
    Router.METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (const m of Router.METHODS) {
      Router.prototype[m.toLowerCase()] = function (pattern, ...handlers) {
        return this.add(m, pattern, handlers);
      };
    }
  }
  add(method, pattern, handlers) {
    const { re, keys } = compilePath(pattern);
    this.#routes.push({ method, pattern, re, keys, handlers });
    return this;
  }
  use(fn) {
    if (fn.length === 4) this.#errorHandlers.push(fn);
    else this.#middleware.push(fn);
    return this;
  }
  get routeCount() { return this.#routes.length; }
  describe() {
    return this.#routes.map((r) => `${r.method.padEnd(6)} ${r.pattern} [${r.keys.join(',')}]`);
  }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
  async handle(req, res) {
    const chain = [...this.#middleware];
    chain.push(async (rq, rs, next) => {
      const { route, params, pathMatched } = this.match(rq.method, rq.path);
      if (!route) {
        if (pathMatched) throw new HttpError(405, 'method not allowed');
        throw new NotFoundError('route ' + rq.path);
      }
      rq.params = params;
      rq.routePattern = route.pattern;
      let i = 0;
      const step = async () => {
        const h = route.handlers[i++];
        if (h) await h(rq, rs, step);
      };
      await step();
      await next();
    });
    let idx = 0;
    const dispatch = async () => {
      const fn = chain[idx++];
      if (fn) await fn(req, res, dispatch);
    };
    try {
      await dispatch();
    } catch (err) {
      for (const eh of this.#errorHandlers) {
        const handled = await eh(err, req, res, () => false);
        if (handled !== false) return;
      }
      res.status(500).json({ error: 'unhandled' });
    }
  }
}

// ---------------------------------------------------------------- response helpers
function decorateResponse(res) {
  let statusCode = 200;
  res.status = (c) => { statusCode = c; return res; };
  res.json = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'X-Body-Hash': crypto.createHash('sha1').update(body).digest('hex').slice(0, 12),
    });
    res.end(body);
    return res;
  };
  res.noContent = () => { res.writeHead(204); res.end(); };
  return res;
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    const key = decodeURIComponent(k);
    const val = decodeURIComponent(v.replace(/\+/g, ' '));
    if (key in out) out[key] = [].concat(out[key], val);
    else out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------- middleware
const trace = [];
function requestId() {
  let counter = 0;
  return async (req, res, next) => {
    req.id = 'req-' + String(++counter).padStart(3, '0');
    res.setHeader('X-Request-Id', req.id);
    await next();
  };
}
function logger(events) {
  return async (req, res, next) => {
    events.emit('request', req);
    try {
      await next();
    } finally {
      events.emit('finished', req, res.statusCode);
    }
  };
}
function bodyParser(limit) {
  return (req, res, next) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'payload too large', { size, limit }));
      const raw = Buffer.concat(chunks).toString('utf8');
      req.rawBody = raw;
      const ct = req.headers['content-type'] || '';
      if (raw.length && ct.startsWith('application/json')) {
        try { req.body = JSON.parse(raw); } catch (e) {
          return reject(new HttpError(400, 'invalid json'));
        }
      } else req.body = raw.length ? raw : null;
      Promise.resolve(next()).then(resolve, reject);
    });
  });
}
function auth(tokens) {
  return async (req, res, next) => {
    if (req.method === 'GET' || req.path === '/health') return next();
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/.exec(h);
    const user = m && tokens.get(m[1]);
    if (!user) throw new HttpError(401, 'unauthorized');
    req.user = user;
    await next();
  };
}

// ---------------------------------------------------------------- data model
class Store extends EventEmitter {
  #items = new Map();
  #seq = 0;
  constructor(kind) { super(); this.kind = kind; }
  create(data) {
    const id = ++this.#seq;
    const rec = { id, ...data, version: 1 };
    this.#items.set(id, rec);
    this.emit('change', 'create', rec);
    return rec;
  }
  get(id) {
    const r = this.#items.get(Number(id));
    if (!r) throw new NotFoundError(`${this.kind} ${id}`);
    return r;
  }
  update(id, patch) {
    const cur = this.get(id);
    const next = { ...cur, ...patch, id: cur.id, version: cur.version + 1 };
    this.#items.set(cur.id, next);
    this.emit('change', 'update', next);
    return next;
  }
  remove(id) {
    const cur = this.get(id);
    this.#items.delete(cur.id);
    this.emit('change', 'delete', cur);
    return cur;
  }
  *filter(pred) {
    for (const r of this.#items.values()) if (pred(r)) yield r;
  }
  get size() { return this.#items.size; }
}

function validateUser(body, partial) {
  const errors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError({ body: 'object required' });
  if (!partial || 'name' in body) {
    if (typeof body.name !== 'string' || body.name.trim().length < 2) errors.name = 'min length 2';
  }
  if (!partial || 'email' in body) {
    if (!/^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i.test(body.email ?? '')) errors.email = 'invalid email';
  }
  if ('age' in body && !(Number.isInteger(body.age) && body.age >= 0 && body.age < 150)) errors.age = 'integer 0..149';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const { name, email, age, tags = [] } = body;
  const out = {};
  if (name !== undefined) out.name = name.trim();
  if (email !== undefined) out.email = email.toLowerCase();
  if (age !== undefined) out.age = age;
  if (!partial || 'tags' in body) out.tags = [...new Set(tags.map(String))].sort();
  return out;
}

// ---------------------------------------------------------------- application
function buildApp() {
  const events = new EventEmitter();
  const users = new Store('user');
  const posts = new Store('post');
  const audit = [];
  users.on('change', (op, rec) => audit.push(`user:${op}:${rec.id}`));
  posts.on('change', (op, rec) => audit.push(`post:${op}:${rec.id}`));
  const tokens = new Map([['tok-admin', { name: 'admin', role: 'admin' }], ['tok-bob', { name: 'bob', role: 'user' }]]);

  const router = new Router();
  router.use(requestId());
  router.use(logger(events));
  router.use(bodyParser(512));
  router.use(auth(tokens));

  const requireRole = (role) => async (req, res, next) => {
    if (req.user?.role !== role) throw new HttpError(403, 'forbidden', { need: role, have: req.user?.role ?? null });
    await next();
  };

  router.get('/health', (req, res) => res.json({ ok: true, users: users.size, posts: posts.size }));
  router.get('/users', (req, res) => {
    const { tag, sort = 'id', limit } = req.query;
    let list = [...users.filter((u) => !tag || u.tags.includes(tag))];
    list.sort((a, b) => (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0));
    if (limit) list = list.slice(0, Number(limit));
    res.json({ count: list.length, items: list.map(({ id, name }) => ({ id, name })) });
  });
  router.post('/users', (req, res) => {
    const data = validateUser(req.body, false);
    for (const u of users.filter((x) => x.email === data.email)) throw new ConflictError('email taken: ' + u.id);
    res.status(201).json(users.create(data));
  });
  router.get('/users/:id', (req, res) => res.json(users.get(req.params.id)));
  router.patch('/users/:id', (req, res) => res.json(users.update(req.params.id, validateUser(req.body, true))));
  router.delete('/users/:id', requireRole('admin'), (req, res) => {
    const u = users.remove(req.params.id);
    for (const p of [...posts.filter((p) => p.authorId === u.id)]) posts.remove(p.id);
    res.noContent();
  });
  router.get('/users/:id/posts/:postId?', (req, res) => {
    const u = users.get(req.params.id);
    if (req.params.postId) {
      const p = posts.get(req.params.postId);
      if (p.authorId !== u.id) throw new NotFoundError('post ' + p.id + ' of user ' + u.id);
      return res.json(p);
    }
    res.json([...posts.filter((p) => p.authorId === u.id)].map((p) => p.title));
  });
  router.post('/users/:id/posts', (req, res) => {
    const u = users.get(req.params.id);
    const title = req.body?.title;
    if (typeof title !== 'string' || !title) throw new ValidationError({ title: 'required' });
    const words = title.split(/\s+/).length;
    res.status(201).json(posts.create({ authorId: u.id, title, words, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }));
  });
  router.get('/files/*', (req, res) => res.json({ wild: req.params.wild, parts: req.params.wild.split('/').length }));
  router.get('/boom', () => { throw new TypeError('kaboom'); });
  router.get('/audit', (req, res) => res.json(audit.slice()));

  router.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.toJSON());
      return true;
    }
    return false;
  });
  router.use((err, req, res, _next) => {
    res.status(500).json({ error: 'internal', kind: err.constructor === TypeError ? 'TypeError' : 'Error', message: err.message });
    return true;
  });

  const server = http.createServer((req, res) => {
    const [p, qs] = req.url.split('?');
    req.path = p;
    req.query = parseQuery(qs);
    decorateResponse(res);
    router.handle(req, res);
  });
  return { server, router, events, users, posts };
}

// ---------------------------------------------------------------- client
function request(port, method, path, { body, token, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Connection: 'close', ...headers };
    if (payload) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = payload.length; }
    if (token) h.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = { unparsable: text.length }; }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class TestSuite {
  #cases = [];
  #results = { pass: 0, fail: 0 };
  constructor(name) { this.name = name; }
  test(name, fn) { this.#cases.push({ name, fn }); }
  async run(ctx) {
    console.log(`== suite ${this.name} (${this.#cases.length} cases)`);
    let n = 0;
    for (const { name, fn } of this.#cases) {
      n++;
      try {
        await fn(ctx);
        this.#results.pass++;
        console.log(`  ok ${n} - ${name}`);
      } catch (e) {
        this.#results.fail++;
        console.log(`  not ok ${n} - ${name}: ${e.message}`);
      }
    }
    return { ...this.#results };
  }
}

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'assert'}: ${a} !== ${b}`);
}

function show(label, r) {
  console.log(`  ${label} -> ${r.status} ${r.text.length > 90 ? r.text.slice(0, 87) + '...' : r.text}`);
}

async function main() {
  const { server, router, events } = buildApp();
  events.on('request', (req) => trace.push(`> ${req.id} ${req.method} ${req.path}`));
  events.on('finished', (req, code) => trace.push(`< ${req.id} ${code}`));
  console.log('routes: ' + router.routeCount);
  for (const line of router.describe()) console.log('  ' + line);

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (m, p, o) => request(port, m, p, o);

  const suite = new TestSuite('users');
  suite.test('health empty', async () => {
    const r = await call('GET', '/health');
    show('health', r);
    assertEq(r.json, { ok: true, users: 0, posts: 0 });
  });
  suite.test('create requires auth', async () => {
    const r = await call('POST', '/users', { body: { name: 'Ann', email: 'ann@x.io' } });
    show('noauth', r);
    assertEq(r.status, 401);
  });
  const people = [
    { name: 'Ann Lee', email: 'Ann@Example.com', age: 31, tags: ['ops', 'dev', 'ops'] },
    { name: 'Bo', email: 'bo@example.com', tags: ['dev'] },
    { name: 'Cyd Park', email: 'cyd@example.org', age: 44, tags: ['qa'] },
    { name: 'Dee', email: 'dee@example.net', age: 27 },
  ];
  for (const [i, p] of people.entries()) {
    suite.test(`create user #${i + 1}`, async () => {
      const r = await call('POST', '/users', { body: p, token: 'tok-bob' });
      show('create', r);
      assertEq(r.status, 201);
      assertEq(r.json.id, i + 1, 'id');
    });
  }
  suite.test('validation errors', async () => {
    const r = await call('POST', '/users', { body: { name: 'x', email: 'nope', age: -3 }, token: 'tok-bob' });
    show('invalid', r);
    assertEq(Object.keys(r.json.details).sort(), ['age', 'email', 'name']);
  });
  suite.test('duplicate email conflict', async () => {
    const r = await call('POST', '/users', { body: { name: 'Ann2', email: 'ann@example.com' }, token: 'tok-bob' });
    show('dup', r);
    assertEq(r.status, 409);
  });
  suite.test('invalid json', async () => {
    const r = await call('POST', '/users', { raw: '{"name":', token: 'tok-bob' });
    show('badjson', r);
    assertEq(r.json.error, 'invalid json');
  });
  suite.test('payload too large', async () => {
    const r = await call('POST', '/users', { raw: JSON.stringify({ name: 'x'.repeat(600) }), token: 'tok-bob' });
    show('large', r);
    assertEq(r.status, 413);
  });
  suite.test('list and filter', async () => {
    const r1 = await call('GET', '/users?sort=name');
    show('list', r1);
    const r2 = await call('GET', '/users?tag=dev&limit=5');
    show('tag=dev', r2);
    assertEq(r2.json.count, 2);
    const r3 = await call('GET', '/users?sort=age&limit=2');
    show('byAge', r3);
  });
  suite.test('get and patch', async () => {
    const r = await call('PATCH', '/users/2', { body: { age: 19, tags: ['z', 'a'] }, token: 'tok-bob' });
    show('patch', r);
    assertEq([r.json.version, r.json.tags], [2, ['a', 'z']]);
    const g = await call('GET', '/users/2');
    show('get', g);
  });
  suite.test('missing user 404', async () => {
    const r = await call('GET', '/users/99');
    show('404', r);
    assertEq(r.status, 404);
  });
  suite.test('method not allowed', async () => {
    const r = await call('PUT', '/users/1', { body: {}, token: 'tok-bob' });
    show('405', r);
    assertEq(r.status, 405);
  });
  suite.test('posts nested routes', async () => {
    const titles = ['Hello World', 'Second  post here', 'On VMs & Decompilers!'];
    for (const t of titles) {
      const r = await call('POST', '/users/1/posts', { body: { title: t }, token: 'tok-bob' });
      show('post', r);
    }
    const r = await call('POST', '/users/3/posts', { body: { title: 'Cyd writes' }, token: 'tok-bob' });
    show('post3', r);
    const l = await call('GET', '/users/1/posts');
    show('posts of 1', l);
    const one = await call('GET', '/users/1/posts/2');
    show('post 2', one);
    const wrong = await call('GET', '/users/1/posts/4');
    show('wrong owner', wrong);
    assertEq(wrong.status, 404);
  });
  suite.test('forbidden delete for user role', async () => {
    const r = await call('DELETE', '/users/1', { token: 'tok-bob' });
    show('forbid', r);
    assertEq(r.json.details, { need: 'admin', have: 'user' });
  });
  suite.test('admin delete cascades', async () => {
    const r = await call('DELETE', '/users/1', { token: 'tok-admin' });
    console.log(`  delete -> ${r.status} len=${r.text.length}`);
    const h = await call('GET', '/health');
    show('health', h);
    assertEq(h.json.posts, 1);
  });
  suite.test('wildcard route', async () => {
    const r = await call('GET', '/files/a/b%20c/d.txt');
    show('wild', r);
    assertEq(r.json.parts, 3);
  });
  suite.test('internal error handler', async () => {
    const r = await call('GET', '/boom');
    show('boom', r);
    assertEq(r.json.kind, 'TypeError');
  });
  suite.test('headers', async () => {
    const r = await call('GET', '/health');
    console.log(`  x-request-id=${r.headers['x-request-id']} x-body-hash=${r.headers['x-body-hash']}`);
    assertEq(r.headers['content-type'], 'application/json; charset=utf-8');
  });
  suite.test('unknown route', async () => {
    const r = await call('GET', '/nope/deeper');
    show('unknown', r);
  });
  suite.test('audit log', async () => {
    const r = await call('GET', '/audit');
    console.log('  audit: ' + r.json.join(' '));
    assertEq(r.json.length, 11);
  });
  suite.test('intentionally failing check', async () => {
    assertEq(1 + 1, 3, 'math');
  });

  const results = await suite.run({ port });
  console.log(`results: pass=${results.pass} fail=${results.fail}`);

  const statusCounts = {};
  outer: for (const line of trace) {
    if (!line.startsWith('<')) continue;
    const code = line.split(' ')[2];
    for (const skip of ['204']) if (code === skip) continue outer;
    statusCounts[code] = (statusCounts[code] || 0) + 1;
  }
  console.log('status histogram: ' + JSON.stringify(Object.keys(statusCounts).sort().map((k) => [k, statusCounts[k]])));
  console.log('trace entries: ' + trace.length);
  const digest = crypto.createHash('sha256').update(trace.filter((l) => !l.includes('/users/') || l.startsWith('>')).join('\n')).digest('hex');
  console.log('trace digest: ' + digest.slice(0, 16));

  // concurrent burst, print sorted
  const burst = await Promise.all(['/users/2', '/users/3', '/users/4', '/users/1', '/health'].map((p) => call('GET', p)));
  const lines = burst.map((r, i) => `${String(i).padStart(2)} ${r.status} ${r.json?.name ?? r.json?.error ?? 'health'}`);
  lines.sort();
  console.log('burst:');
  lines.forEach((l) => console.log('  ' + l));
  console.log('trace after burst: ' + trace.length);

  await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  console.log('server closed');
}

process.on('exit', (code) => console.log('exit ' + code));
main().catch((e) => { console.log('fatal ' + e.message); process.exitCode = 1; });
