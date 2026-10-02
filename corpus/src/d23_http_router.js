// d23: HTTP-like router + async middleware chain with request/response objects,
// error handling, retries, route params, sub-routers, caching and rate limiting.
// Fully deterministic (virtual clock, no timers).

const OUT = [];
function log(...xs) {
  const s = xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  OUT.push(s);
  console.log(s);
}

// ---------- virtual clock ----------
const Clock = (() => {
  let now = 1000;
  return {
    get now() { return now; },
    advance(ms) { now += ms; return now; },
    reset() { now = 1000; },
  };
})();

// ---------- errors ----------
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
  get expose() { return this.status < 500; }
  toJSON() { return { error: this.message, status: this.status }; }
}
class NotFound extends HttpError { constructor(path) { super(404, `no route for ${path}`); } }
class MethodNotAllowed extends HttpError {
  constructor(allowed) { super(405, 'method not allowed', { allowed }); }
}
class TransientError extends HttpError {
  constructor(msg, attempt) { super(503, msg, { attempt, transient: true }); }
}
class ValidationError extends HttpError {
  constructor(fields) { super(422, 'validation failed', { fields }); }
}

// ---------- headers with case-insensitive proxy ----------
function makeHeaders(init = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(init)) store.set(k.toLowerCase(), String(v));
  return new Proxy(Object.create(null), {
    get(_, prop) {
      if (prop === Symbol.iterator) return () => [...store.entries()].sort()[Symbol.iterator]();
      if (prop === 'toJSON') return () => Object.fromEntries([...store.entries()].sort());
      if (typeof prop !== 'string') return undefined;
      return store.get(prop.toLowerCase());
    },
    set(_, prop, value) { store.set(String(prop).toLowerCase(), String(value)); return true; },
    has(_, prop) { return store.has(String(prop).toLowerCase()); },
    deleteProperty(_, prop) { return store.delete(String(prop).toLowerCase()); },
    ownKeys() { return [...store.keys()].sort(); },
    getOwnPropertyDescriptor(_, prop) {
      const k = String(prop).toLowerCase();
      return store.has(k) ? { value: store.get(k), enumerable: true, configurable: true, writable: true } : undefined;
    },
  });
}

// ---------- request / response ----------
class Message {
  #body = null;
  constructor(headers) { this.headers = makeHeaders(headers); }
  get body() { return this.#body; }
  set body(v) {
    this.#body = v;
    if (v !== null && v !== undefined) this.headers['content-length'] = JSON.stringify(v).length;
  }
  static hasBody(m) { return #body in m && m.#body !== null; }
}

class Request extends Message {
  static #seq = 0;
  constructor({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    super(headers);
    this.id = ++Request.#seq;
    this.method = method.toUpperCase();
    const [path, qs = ''] = url.split('?');
    this.path = path;
    this.query = Object.fromEntries(
      qs.split('&').filter(Boolean).map((kv) => {
        const [k, v = ''] = kv.split('=');
        return [decodeURIComponent(k), decodeURIComponent(v)];
      })
    );
    this.params = {};
    this.state = {};
    this.body = body;
  }
  static resetSeq() { Request.#seq = 0; }
}

class Response extends Message {
  constructor() {
    super({});
    this.status = 200;
    this.finished = false;
  }
  json(obj, status) {
    if (this.finished) throw new Error('response already sent');
    if (status !== undefined) this.status = status;
    this.headers['content-type'] = 'application/json';
    this.body = obj;
    this.finished = true;
    return this;
  }
  text(s, status = this.status) {
    this.status = status;
    this.headers['content-type'] = 'text/plain';
    this.body = s;
    this.finished = true;
    return this;
  }
  summary() {
    return `${this.status} ${this.headers['content-type'] ?? '-'} ${JSON.stringify(this.body)}`;
  }
}

// ---------- path patterns with named groups ----------
function compilePattern(pattern) {
  const keys = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      let m;
      if ((m = /^:(?<name>\w+)(?<opt>\?)?(?:\((?<re>[^)]+)\))?$/.exec(seg))) {
        const { name, opt, re = '[^/]+' } = m.groups;
        keys.push(name);
        return opt ? `(?:/(?<${name}>${re}))?` : `/(?<${name}>${re})`;
      }
      if (seg === '*') { keys.push('rest'); return '(?:/(?<rest>.*))?'; }
      return seg ? '/' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&') : '';
    })
    .join('');
  return { re: new RegExp('^' + (src || '/') + '/?$'), keys };
}

// ---------- compose (koa-like) ----------
function compose(middlewares) {
  return function dispatchAll(ctx, final) {
    let index = -1;
    const dispatch = async (i) => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      const fn = i === middlewares.length ? final : middlewares[i];
      if (!fn) return;
      return fn(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}

// ---------- router hierarchy ----------
class BaseRouter {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.routes = [];
    this.stack = [];
  }
  use(...fns) { this.stack.push(...fns); return this; }
  add(method, pattern, ...handlers) {
    const { re, keys } = compilePattern(this.prefix + pattern);
    this.routes.push({ method, pattern: this.prefix + pattern, re, keys, handlers });
    return this;
  }
}

class Router extends BaseRouter {
  static {
    for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
      Router.prototype[m] = function (pattern, ...handlers) {
        return this.add(m.toUpperCase(), pattern, ...handlers);
      };
    }
  }
  mount(sub) {
    for (const r of sub.routes) {
      const pattern = this.prefix + r.pattern;
      const { re, keys } = compilePattern(pattern);
      this.routes.push({ ...r, pattern, re, keys, handlers: [...sub.stack, ...r.handlers] });
    }
    return this;
  }
  match(method, path) {
    const allowed = new Set();
    for (const route of this.routes) {
      const m = route.re.exec(path);
      if (!m) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) {
        allowed.add(route.method);
        continue;
      }
      const params = {};
      for (const k of route.keys) if (m.groups?.[k] !== undefined) params[k] = m.groups[k];
      return { route, params };
    }
    if (allowed.size) throw new MethodNotAllowed([...allowed].sort());
    throw new NotFound(path);
  }
}

class App extends Router {
  #errorHandlers = [];
  #stats = { handled: 0, errors: 0, byStatus: {} };
  constructor() {
    super('');
    this.onError((err, ctx) => {
      const status = err?.status ?? 500;
      ctx.res.json(err instanceof HttpError && err.expose ? err : { error: 'internal', status }, status);
    });
  }
  onError(fn) { this.#errorHandlers.unshift(fn); return this; }
  get stats() { return structuredCloneLite(this.#stats); }

  async handle(reqInit) {
    const req = new Request(reqInit);
    const res = new Response();
    const ctx = { req, res, app: this, trace: [] };
    try {
      await compose(this.stack)(ctx, async () => {
        const { route, params } = this.match(req.method, req.path);
        req.params = params;
        ctx.trace.push('route:' + route.pattern);
        await compose(route.handlers)(ctx, async () => {
          if (!res.finished) throw new HttpError(500, 'handler chain ended without response');
        });
      });
    } catch (err) {
      this.#stats.errors++;
      ctx.trace.push('error:' + (err.status ?? 'js'));
      for (const h of this.#errorHandlers) {
        try {
          if (res.finished) res.finished = false;
          h(err, ctx);
          break;
        } catch (inner) {
          ctx.trace.push('handler-failed:' + inner.message);
          continue;
        }
      }
    } finally {
      this.#stats.handled++;
      const s = res.status;
      this.#stats.byStatus[s] = (this.#stats.byStatus[s] ?? 0) + 1;
    }
    if (req.method === 'HEAD') res.body = null;
    return ctx;
  }
}

function structuredCloneLite(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------- middleware factories ----------
function logger(sink) {
  return async (ctx, next) => {
    const t0 = Clock.now;
    sink.push(`--> ${ctx.req.method} ${ctx.req.path}`);
    try {
      await next();
    } finally {
      Clock.advance(3);
      sink.push(`<-- ${ctx.req.method} ${ctx.req.path} ${ctx.res.status} ${Clock.now - t0}ms`);
    }
  };
}

function timing() {
  return async function (ctx, next) {
    const start = Clock.now;
    await next();
    ctx.res.headers['x-time'] = Clock.now - start;
  };
}

function auth(tokens) {
  return async ({ req, trace }, next) => {
    const hdr = req.headers.authorization ?? '';
    const m = /^(?<scheme>Bearer)\s+(?<token>\S+)$/i.exec(hdr);
    const user = m && tokens[m.groups.token];
    if (!user) throw new HttpError(401, 'unauthorized');
    req.state.user = user;
    trace.push('auth:' + user.name);
    await next();
  };
}

function requireRole(role) {
  return async (ctx, next) => {
    if (!ctx.req.state.user?.roles?.includes(role)) throw new HttpError(403, `need ${role}`);
    return next();
  };
}

function rateLimit({ limit, windowMs }) {
  const hits = new Map();
  return async (ctx, next) => {
    const key = ctx.req.headers['x-client'] ?? 'anon';
    const now = Clock.now;
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) hits.set(key, (entry = { start: now, n: 0 }));
    entry.n++;
    ctx.res.headers['x-ratelimit-remaining'] = Math.max(0, limit - entry.n);
    if (entry.n > limit) throw new HttpError(429, 'too many requests', { retryAfter: windowMs - (now - entry.start) });
    await next();
  };
}

function cache() {
  const store = new Map();
  let hits = 0, misses = 0;
  const mw = async (ctx, next) => {
    if (ctx.req.method !== 'GET') return next();
    const key = ctx.req.path + '?' + JSON.stringify(ctx.req.query);
    const hit = store.get(key);
    if (hit) {
      hits++;
      ctx.res.headers['x-cache'] = 'HIT';
      ctx.res.json(structuredCloneLite(hit.body), hit.status);
      return;
    }
    misses++;
    await next();
    if (ctx.res.status === 200) store.set(key, { body: structuredCloneLite(ctx.res.body), status: 200 });
    ctx.res.headers['x-cache'] = 'MISS';
  };
  Object.defineProperty(mw, 'stats', { get: () => ({ hits, misses, size: store.size }), enumerable: false });
  return mw;
}

function validate(schema) {
  return async (ctx, next) => {
    const body = ctx.req.body ?? {};
    const fields = [];
    for (const [key, rule] of Object.entries(schema)) {
      const v = body[key];
      switch (rule.type) {
        case 'string':
          if (typeof v !== 'string') { fields.push(key + ':type'); break; }
          if (rule.min && v.length < rule.min) fields.push(key + ':min');
          // fallthrough intentionally to pattern check
        case 'pattern':
          if (rule.re && typeof v === 'string' && !rule.re.test(v)) fields.push(key + ':pattern');
          break;
        default:
          if (typeof v !== rule.type) fields.push(key + ':type');
          break;
        case 'int':
          if (!Number.isInteger(v)) fields.push(key + ':int');
          else if (v < (rule.min ?? -Infinity)) fields.push(key + ':min');
      }
    }
    if (fields.length) throw new ValidationError(fields);
    await next();
  };
}

// retry wrapper: retries downstream when TransientError is thrown
function retry({ attempts = 3, backoff = 10 } = {}) {
  return async (ctx, next) => {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        ctx.req.state.attempt = attempt;
        return await next.call(null);
      } catch (e) {
        if (!(e?.transient) || attempt >= attempts) {
          ctx.trace.push(`retry-giveup:${attempt}`);
          throw e;
        }
        ctx.trace.push(`retry:${attempt}`);
        Clock.advance(backoff * 2 ** (attempt - 1));
        ctx.res.finished = false;
        // next() can only be called once per compose index, so re-dispatch by recursion trick
        next = makeRedispatch(ctx);
      }
    }
  };
}
function makeRedispatch(ctx) {
  const route = ctx.app.match(ctx.req.method, ctx.req.path).route;
  const idx = route.handlers.findIndex((h) => h.isRetry);
  const rest = route.handlers.slice(idx + 1);
  return () => compose(rest)(ctx, async () => {});
}
function retryMw(opts) {
  const f = retry(opts);
  f.isRetry = true;
  return f;
}

// ---------- the data layer ----------
class Repo {
  #rows = new Map();
  #nextId = 1;
  #failures;
  constructor(failPlan = []) { this.#failures = [...failPlan]; }
  #maybeFail(op) {
    const f = this.#failures[0];
    if (f && f.op === op) {
      if (--f.times <= 0) this.#failures.shift();
      throw new TransientError(`db ${op} flaked`);
    }
  }
  async insert(obj) {
    await null;
    this.#maybeFail('insert');
    const row = { id: this.#nextId++, ...obj, createdAt: Clock.now };
    this.#rows.set(row.id, row);
    return row;
  }
  async find(id) {
    await null;
    this.#maybeFail('find');
    return this.#rows.get(Number(id)) ?? null;
  }
  async all({ sort = 'id', dir = 'asc', limit = 100 } = {}) {
    await Promise.resolve();
    const rows = [...this.#rows.values()].sort((a, b) =>
      (a[sort] > b[sort] ? 1 : a[sort] < b[sort] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    return rows.slice(0, limit);
  }
  async update(id, patch) {
    const row = await this.find(id);
    if (!row) return null;
    const { id: _ignored, ...rest } = patch;
    Object.assign(row, rest, { updatedAt: Clock.now });
    return row;
  }
  async remove(id) {
    await null;
    return this.#rows.delete(Number(id));
  }
  get size() { return this.#rows.size; }
}

// ---------- build application ----------
function buildApp() {
  const accessLog = [];
  const app = new App();
  const itemCache = cache();
  const repo = new Repo([{ op: 'insert', times: 2 }, { op: 'find', times: 1 }]);
  const tokens = {
    t1: { name: 'alice', roles: ['admin', 'user'] },
    t2: { name: 'bob', roles: ['user'] },
  };
  app.use(logger(accessLog), timing(), rateLimit({ limit: 25, windowMs: 1000 }));
  app.onError((err, ctx) => {
    if (err instanceof ValidationError) return ctx.res.json({ invalid: err.fields }, 422);
    if (err?.status === 429) {
      ctx.res.headers['retry-after'] = err.retryAfter;
      return ctx.res.text('slow down', 429);
    }
    throw new Error('pass');
  });

  app.get('/', async ({ res }) => res.text('home'));
  app.get('/health', async ({ res }) => res.json({ ok: true, now: Clock.now }));
  app.get('/echo/:word/:times?(\\d+)', async ({ req, res }) => {
    const { word, times = '1' } = req.params;
    res.json({ echo: Array(Number(times)).fill(word).join('-'), query: req.query });
  });
  app.get('/files/*', async ({ req, res }) => res.json({ rest: req.params.rest ?? '' }));
  app.get('/boom', async () => { throw new TypeError('kaboom'); });
  app.get('/double', async ({ res }, next) => { res.json({ a: 1 }); res.json({ b: 2 }); });
  app.get('/noresp', async (_ctx, next) => next());

  const api = new Router('/api');
  api.use(auth(tokens));
  api.get('/items', itemCache, async ({ req, res }) => {
    const { sort, dir, limit } = req.query;
    const rows = await repo.all({ sort: sort ?? 'id', dir: dir ?? 'asc', limit: limit ? Number(limit) : undefined });
    res.json(rows.map(({ id, name, qty }) => ({ id, name, qty })));
  });
  api.post('/items', retryMw({ attempts: 4 }),
    validate({ name: { type: 'string', min: 2, re: /^[a-z][a-z0-9-]*$/ }, qty: { type: 'int', min: 0 } }),
    async ({ req, res }) => {
      const row = await repo.insert({ name: req.body.name, qty: req.body.qty, by: req.state.user.name });
      res.json({ id: row.id, attempt: req.state.attempt }, 201);
    });
  api.get('/items/:id(\\d+)', retryMw({ attempts: 2 }), async ({ req, res }) => {
    const row = await repo.find(req.params.id);
    if (!row) throw new HttpError(404, 'item not found');
    res.json(row);
  });
  api.put('/items/:id(\\d+)', requireRole('admin'), async ({ req, res }) => {
    const row = await repo.update(req.params.id, req.body ?? {});
    row ? res.json(row) : res.json({ error: 'gone' }, 404);
  });
  api.delete('/items/:id(\\d+)', requireRole('admin'), async ({ req, res }) => {
    const ok = await repo.remove(req.params.id);
    res.json({ deleted: ok }, ok ? 200 : 404);
  });
  app.mount(api);
  return { app, accessLog, itemCache, repo };
}

// ---------- scenario runner ----------
async function scenario(app, label, init) {
  const ctx = await app.handle(init);
  Clock.advance(7);
  log(`${label.padEnd(16)} ${ctx.res.summary()}`);
  if (ctx.trace.length) log(`   trace ${ctx.trace.join(' ')}`);
  return ctx;
}

async function basicRoutes(app) {
  log('== basic routes ==');
  await scenario(app, 'home', { url: '/' });
  await scenario(app, 'health', { url: '/health' });
  await scenario(app, 'echo', { url: '/echo/hi/3?x=1&y=two%20words' });
  await scenario(app, 'echo-opt', { url: '/echo/solo' });
  await scenario(app, 'echo-bad', { url: '/echo/solo/abc' });
  await scenario(app, 'files', { url: '/files/a/b/c.txt' });
  await scenario(app, 'files-root', { url: '/files' });
  await scenario(app, '404', { url: '/nothing/here' });
  await scenario(app, '405', { method: 'POST', url: '/health' });
  await scenario(app, 'boom', { url: '/boom' });
  await scenario(app, 'double', { url: '/double' });
  await scenario(app, 'noresp', { url: '/noresp' });
  const head = await scenario(app, 'head', { method: 'HEAD', url: '/health' });
  log('head headers', JSON.stringify(head.res.headers));
}

async function apiRoutes(app, itemCache) {
  log('== api routes ==');
  const A = { authorization: 'Bearer t1', 'X-Client': 'alice' };
  const B = { authorization: 'bearer t2', 'X-Client': 'bob' };
  await scenario(app, 'unauth', { url: '/api/items' });
  await scenario(app, 'badtoken', { url: '/api/items', headers: { Authorization: 'Bearer zz' } });
  await scenario(app, 'create-flaky', { method: 'POST', url: '/api/items', headers: A, body: { name: 'widget', qty: 5 } });
  await scenario(app, 'create2', { method: 'POST', url: '/api/items', headers: B, body: { name: 'gadget-2', qty: 12 } });
  await scenario(app, 'create3', { method: 'POST', url: '/api/items', headers: A, body: { name: 'bolt', qty: 99 } });
  await scenario(app, 'invalid', { method: 'POST', url: '/api/items', headers: A, body: { name: 'X', qty: -1 } });
  await scenario(app, 'invalid2', { method: 'POST', url: '/api/items', headers: A, body: { name: 7 } });
  await scenario(app, 'list', { url: '/api/items', headers: A });
  await scenario(app, 'list-cached', { url: '/api/items', headers: B });
  await scenario(app, 'list-sorted', { url: '/api/items?sort=qty&dir=desc&limit=2', headers: A });
  await scenario(app, 'get-flaky', { url: '/api/items/1', headers: A });
  await scenario(app, 'get-missing', { url: '/api/items/77', headers: A });
  await scenario(app, 'put-forbidden', { method: 'PUT', url: '/api/items/2', headers: B, body: { qty: 0 } });
  await scenario(app, 'put', { method: 'PUT', url: '/api/items/2', headers: A, body: { id: 999, qty: 1 } });
  await scenario(app, 'delete', { method: 'DELETE', url: '/api/items/3', headers: A });
  await scenario(app, 'delete-again', { method: 'DELETE', url: '/api/items/3', headers: A });
  await scenario(app, 'list-after', { url: '/api/items?v=2', headers: A });
  log('cache stats', itemCache.stats, 'enumerable?', Object.keys(itemCache).includes('stats'));
}

async function rateLimited(app) {
  log('== rate limit ==');
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    const ctx = await app.handle({ url: '/health', headers: { 'x-client': 'spammer' } });
    statuses.push(ctx.res.status);
  }
  log('statuses', statuses.join(''));
  Clock.advance(1000);
  const ctx = await app.handle({ url: '/health', headers: { 'x-client': 'spammer' } });
  log('after window', ctx.res.status, ctx.res.headers['x-ratelimit-remaining']);
}

async function concurrent(app) {
  log('== concurrency ==');
  const order = [];
  const reqs = ['/', '/health', '/echo/a/2', '/nope', '/files/x'].map((url, i) =>
    app.handle({ url, headers: { 'x-client': 'c' + i } }).then((ctx) => {
      order.push(i + ':' + ctx.res.status);
      return ctx.res.status;
    }));
  const statuses = await Promise.all(reqs);
  log('statuses', statuses, 'completion order', order.join(' '));
  const settled = await Promise.allSettled([
    app.handle({ url: '/' }),
    Promise.reject(new HttpError(418, 'teapot')),
  ]);
  log('settled', settled.map((s) => s.status === 'fulfilled' ? s.value.res.status : s.reason.status));
}

// ---------- async generator traffic feed ----------
async function* trafficFeed(n) {
  let seed = 42;
  const paths = ['/', '/health', '/echo/w', '/api/items', '/missing', '/boom'];
  try {
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      await null;
      yield { url: paths[seed % paths.length], headers: { 'x-client': 'feed' + (i % 3), authorization: 'Bearer t2' } };
    }
    return 'exhausted';
  } finally {
    log('feed closed');
  }
}

async function replayTraffic(app) {
  log('== traffic replay ==');
  const tally = {};
  let count = 0;
  feed: for await (const init of trafficFeed(40)) {
    const ctx = await app.handle(init);
    const s = ctx.res.status;
    tally[s] = (tally[s] ?? 0) + 1;
    switch (s) {
      case 500:
        if (tally[500] > 3) break feed;
      // fallthrough
      case 404:
        count += 2;
        continue feed;
      default:
        count++;
    }
  }
  log('tally', tally, 'score', count);
}

// ---------- tagged template for response formatting ----------
function fmt(strings, ...vals) {
  return strings.raw.reduce((acc, s, i) => {
    const v = vals[i - 1];
    const rendered = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return acc + rendered + s;
  });
}

// ---------- misc features ----------
function miscChecks() {
  log('== misc ==');
  const pat = compilePattern('/a/:id(\\d+)/:slug?');
  log('pattern', pat.re.source, pat.keys);
  log('match1', JSON.stringify(pat.re.exec('/a/12/hello')?.groups));
  log('match2', JSON.stringify(pat.re.exec('/a/12')?.groups));
  log('match3', pat.re.exec('/a/x') === null);
  const h = makeHeaders({ 'Content-Type': 'x', Accept: '*/*' });
  h['X-Foo'] = 1;
  delete h.accept;
  log('headers', JSON.stringify(h), 'has', 'content-type' in h, 'CONTENT-TYPE' in h, 'accept' in h);
  log('keys', Object.keys(h));
  const req = new Request({ url: '/p?a=1&b=&c=%3D', body: { z: 1 } });
  log('req', req.method, req.path, JSON.stringify(req.query), Message.hasBody(req), req.headers['content-length']);
  const res = new Response();
  log('res hasBody', Message.hasBody(res));
  log('fmt', fmt`status=${404} body=${{ a: [1, 2] }} none=${undefined}\n`);
  const e = new NotFound('/x');
  log('error json', JSON.stringify(e), e instanceof HttpError, e.expose, new HttpError(502, 'bad').expose);
  const withProto = {
    __proto__: { describe() { return 'base:' + this.kind; } },
    kind: 'child',
    describe() { return 'child>' + super.describe(); },
  };
  log('super in literal', withProto.describe());
  const reviver = JSON.parse('{"a":"1","b":{"c":"2"},"d":[1,"3"]}', (k, v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) * 10 : v));
  log('reviver', JSON.stringify(reviver));
  log('replacer', JSON.stringify({ secret: 'x', ok: 1, nested: { secret: 'y', v: 2 } }, (k, v) => (k === 'secret' ? undefined : v)));
}

// ---------- main ----------
async function main() {
  Clock.reset();
  Request.resetSeq();
  const { app, accessLog, itemCache, repo } = buildApp();
  await basicRoutes(app);
  await apiRoutes(app, itemCache);
  await rateLimited(app);
  await concurrent(app);
  await replayTraffic(app);
  miscChecks();
  log('== summary ==');
  log('access log size', accessLog.length);
  log('access head', accessLog.slice(0, 4));
  log('access tail', accessLog.slice(-2));
  log('stats', app.stats);
  log('repo size', repo.size, 'clock', Clock.now);
  log('lines', OUT.length + 1);
}

main().then(
  () => undefined,
  (e) => console.log('FATAL ' + e.message)
);
