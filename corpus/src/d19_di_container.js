// d19: dependency-injection container with decorators-as-functions, scopes, lifecycle hooks,
// circular dependency detection, async factories and proxies.

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
class Token {
  static #registry = new Map();
  #desc;
  constructor(desc) {
    this.#desc = desc;
    this.id = Token.#registry.size + 1;
    Token.#registry.set(desc, this);
  }
  static of(desc) { return Token.#registry.get(desc) ?? new Token(desc); }
  static get count() { return Token.#registry.size; }
  get description() { return this.#desc; }
  [Symbol.toPrimitive](hint) { return hint === 'number' ? this.id : `Token(${this.#desc})`; }
  get [Symbol.toStringTag]() { return 'Token'; }
  static isToken(x) { return typeof x === 'object' && x !== null && #desc in x; }
}

const T = new Proxy({}, {
  get(cache, key) {
    if (typeof key !== 'string') return undefined;
    return (cache[key] ??= Token.of(key));
  },
  has(cache, key) { return Reflect.has(cache, key); },
});

// ---------------------------------------------------------------------------
// Metadata (decorators-as-functions)
// ---------------------------------------------------------------------------
const META = new WeakMap();
function meta(target) {
  let m = META.get(target);
  if (!m) {
    m = { deps: [], scope: 'transient', hooks: {}, tags: new Set(), props: [], token: null };
    META.set(target, m);
  }
  return m;
}

const injectable = (token, { scope = 'transient', tags = [] } = {}) => (cls) => {
  const m = meta(cls);
  m.token = token;
  m.scope = scope;
  tags.forEach((t) => m.tags.add(t));
  return cls;
};
const inject = (...tokens) => (cls) => ((meta(cls).deps = tokens.map((t) => (typeof t === 'string' ? T[t] : t))), cls);
const optional = (token) => ({ optional: true, token: typeof token === 'string' ? T[token] : token });
const lazy = (token) => ({ lazy: true, token: typeof token === 'string' ? T[token] : token });
const onInit = (method) => (cls) => ((meta(cls).hooks.init = method), cls);
const onDispose = (method) => (cls) => ((meta(cls).hooks.dispose = method), cls);
const injectProp = (prop, token) => (cls) => (meta(cls).props.push([prop, token]), cls);

function decorate(...decorators) {
  return (cls) => decorators.reduceRight((acc, d) => d(acc) ?? acc, cls);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
class DIError extends Error {
  constructor(message, path = []) {
    super(message + (path.length ? ' [' + path.join(' -> ') + ']' : ''));
    this.path = path;
  }
}
class CircularDependencyError extends DIError {
  constructor(path) { super('circular dependency', path); this.kind = 'circular'; }
}
class MissingProviderError extends DIError {
  constructor(token, path) { super('no provider for ' + token, path); this.kind = 'missing'; }
}
class ScopeError extends DIError {
  constructor(msg, path) { super(msg, path); this.kind = 'scope'; }
}
class DisposedError extends DIError {
  constructor() { super('container disposed'); this.kind = 'disposed'; }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
class Provider {
  constructor(token, scope) {
    if (new.target === Provider) throw new TypeError('Provider is abstract');
    this.token = token;
    this.scope = scope;
  }
  deps() { return []; }
  create() { throw new Error('not implemented'); }
}
class ValueProvider extends Provider {
  constructor(token, value) { super(token, 'singleton'); this.value = value; }
  create() { return this.value; }
}
class FactoryProvider extends Provider {
  constructor(token, factory, deps = [], scope = 'transient') {
    super(token, scope);
    this.factory = factory;
    this._deps = deps;
  }
  deps() { return this._deps; }
  create(args) { return this.factory(...args); }
}
class ClassProvider extends FactoryProvider {
  constructor(cls) {
    const m = meta(cls);
    super(m.token, (...args) => new cls(...args), m.deps, m.scope);
    this.cls = cls;
    this.meta = m;
  }
  create(args) {
    const inst = super.create(args);
    return inst;
  }
}
class AliasProvider extends Provider {
  constructor(token, target) { super(token, 'transient'); this.target = target; }
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------
const SCOPE_RANK = { singleton: 3, scoped: 2, transient: 1 };

class Container {
  #providers = new Map();
  #instances = new Map();
  #disposables = [];
  #disposed = false;
  #parent;
  static #nextId = 1;
  static {
    Container.ROOT_NAME = 'root';
  }
  constructor(parent = null, name = Container.ROOT_NAME) {
    this.#parent = parent;
    this.name = name;
    this.id = Container.#nextId++;
    this.events = parent?.events ?? [];
  }
  get #root() {
    let c = this;
    while (c.#parent) c = c.#parent;
    return c;
  }
  get depth() { let d = 0, c = this; while ((c = c.#parent)) d++; return d; }
  #check() { if (this.#disposed) throw new DisposedError(); }
  register(p) {
    this.#check();
    if (!(p instanceof Provider)) p = new ClassProvider(p);
    this.#providers.set(p.token, p);
    return this;
  }
  value(token, v) { return this.register(new ValueProvider(token, v)); }
  factory(token, fn, deps, scope) { return this.register(new FactoryProvider(token, fn, deps, scope)); }
  alias(token, target) { return this.register(new AliasProvider(token, target)); }
  has(token) { return this.#providers.has(token) || !!this.#parent?.has(token); }
  #find(token) {
    for (let c = this; c; c = c.#parent) {
      const p = c.#providers.get(token);
      if (p) return [p, c];
    }
    return [null, null];
  }
  createScope(name) { this.#check(); return new Container(this, name); }
  #log(ev) { this.events.push(`${this.name}:${ev}`); }

  resolve(tokenOrSpec, path = [], minRank = 0) {
    this.#check();
    let spec = Token.isToken(tokenOrSpec) ? { token: tokenOrSpec } : tokenOrSpec;
    const { token, optional: opt = false, lazy: isLazy = false } = spec;
    const label = String(token);
    if (path.includes(label)) throw new CircularDependencyError([...path, label]);
    if (isLazy) {
      let cached, resolved = false;
      const self = this, basePath = path;
      return new Proxy(function () {}, {
        get(_, k) {
          if (k === '__isLazy') return true;
          if (!resolved) { cached = self.resolve(token, basePath.length > 50 ? basePath : []); resolved = true; }
          const v = Reflect.get(cached, k);
          return typeof v === 'function' ? v.bind(cached) : v;
        },
        apply(_, thisArg, args) {
          if (!resolved) { cached = self.resolve(token, basePath.length > 50 ? basePath : []); resolved = true; }
          return Reflect.apply(cached, thisArg, args);
        },
      });
    }
    let [provider, owner] = this.#find(token);
    if (!provider) {
      if (opt) return undefined;
      throw new MissingProviderError(label, path);
    }
    if (provider instanceof AliasProvider) return this.resolve({ ...spec, token: provider.target }, [...path, label], minRank);
    const rank = SCOPE_RANK[provider.scope];
    if (rank < minRank) throw new ScopeError(`${provider.scope} ${label} injected into longer-lived service`, [...path, label]);
    let store;
    switch (provider.scope) {
      case 'singleton': store = owner; break;
      case 'scoped':
        if (this === this.#root) throw new ScopeError('scoped ' + label + ' resolved from root', [...path, label]);
        store = this;
        break;
      case 'transient':
      default:
        store = null;
    }
    if (store && store.#instances.has(token)) return store.#instances.get(token);
    const nextPath = [...path, label];
    const args = provider.deps().map((d) => this.resolve(Token.isToken(d) ? d : d, nextPath, provider.scope === 'transient' ? 0 : rank));
    const inst = provider.create(args);
    if (provider instanceof ClassProvider) {
      for (const [prop, ptoken] of provider.meta.props) {
        Object.defineProperty(inst, prop, {
          get: () => this.resolve(ptoken, nextPath),
          enumerable: false,
          configurable: true,
        });
      }
      const { init, dispose } = provider.meta.hooks;
      if (init) inst[init]?.();
      if (dispose) (store ?? this).#disposables.push(() => inst[dispose]());
    }
    this.#log('create ' + label);
    store?.#instances.set(token, inst);
    return inst;
  }

  async resolveAsync(token) {
    const v = this.resolve(token);
    return v && typeof v.then === 'function' ? await v : v;
  }

  dispose() {
    if (this.#disposed) return 0;
    const errors = [];
    let n = 0;
    while (this.#disposables.length) {
      const d = this.#disposables.pop();
      try {
        d();
        n++;
      } catch (e) {
        errors.push(e.message);
      } finally {
        this.#log('dispose#' + n);
      }
    }
    this.#disposed = true;
    this.#instances.clear();
    if (errors.length) throw new AggregateError(errors.map((m) => new Error(m)), 'dispose errors: ' + errors.join('; '));
    return n;
  }

  *entries() {
    for (const [token, p] of this.#providers) yield [String(token), p.scope, p.constructor === ClassProvider ? 'class' : p instanceof ValueProvider ? 'value' : p instanceof AliasProvider ? 'alias' : 'factory'];
    if (this.#parent) yield* this.#parent.entries();
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
let instanceCounter = 0;

class BaseService {
  #serial;
  constructor() {
    this.#serial = ++instanceCounter;
    this.log = [];
  }
  get serial() { return this.#serial; }
  kind() { return 'base'; }
  describe() { return `${this.kind()}#${this.#serial}`; }
}

const Config = decorate(injectable(T.config, { scope: 'singleton' }))(
  class Config extends BaseService {
    #values;
    constructor() {
      super();
      this.#values = { dbUrl: 'mem://main', retries: 3, features: { cache: true, audit: false } };
    }
    kind() { return 'config'; }
    get(path, fallback) {
      return path.split('.').reduce((o, k) => o?.[k], this.#values) ?? fallback;
    }
    set(path, v) {
      const keys = path.split('.');
      const last = keys.pop();
      let o = this.#values;
      for (const k of keys) o = o[k] ??= {};
      o[last] = v;
    }
  }
);

class Database extends BaseService {
  #rows = new Map();
  #open = false;
  constructor(config) {
    super();
    this.url = config.get('dbUrl');
  }
  kind() { return 'db'; }
  connect() { this.#open = true; this.log.push('connect ' + this.url); }
  close() { this.#open = false; this.log.push('close'); }
  get isOpen() { return this.#open; }
  insert(table, row) {
    if (!this.#open) throw new Error('db closed');
    const rows = this.#rows.get(table) ?? [];
    rows.push({ id: rows.length + 1, ...row });
    this.#rows.set(table, rows);
    return rows.length;
  }
  select(table, pred = () => true) { return (this.#rows.get(table) ?? []).filter(pred); }
}
decorate(injectable(T.db, { scope: 'singleton' }), inject('config'), onInit('connect'), onDispose('close'))(Database);

class Repository extends BaseService {
  constructor(db, table) {
    super();
    this.db = db;
    this.table = table;
  }
  kind() { return 'repo:' + this.table; }
  add(row) { return this.db.insert(this.table, row); }
  all() { return this.db.select(this.table); }
}

class UserRepo extends Repository {
  constructor(db) { super(db, 'users'); }
  kind() { return 'user-' + super.kind(); }
  byName(name) { return this.db.select(this.table, (r) => r.name === name)[0] ?? null; }
}
decorate(injectable(T.userRepo, { scope: 'scoped' }), inject('db'))(UserRepo);

class AuditLog extends BaseService {
  constructor(clock) { super(); this.clock = clock; this.entries = []; }
  kind() { return 'audit'; }
  record(ev) { this.entries.push(`${this.clock.tick()}:${ev}`); }
  flush() { this.log.push('flushed ' + this.entries.length); }
}
decorate(injectable(T.audit, { scope: 'scoped' }), inject('clock'), onDispose('flush'))(AuditLog);

class UserService extends BaseService {
  constructor(repo, audit, mailer) {
    super();
    Object.assign(this, { repo, audit, mailer });
  }
  kind() { return 'users'; }
  register({ name, email = `${name}@example.test`, roles: [primary = 'user', ...others] = [] } = {}) {
    if (!name) throw new TypeError('name required');
    if (this.repo.byName(name)) throw new Error('duplicate ' + name);
    const id = this.repo.add({ name, email, role: primary, extra: others });
    this.audit?.record('register ' + name);
    this.mailer?.send?.(email, 'welcome');
    return id;
  }
}
decorate(injectable(T.userService, { scope: 'scoped' }), inject('userRepo', optional('audit'), optional('mailer')))(UserService);

// Circular pair
class Chicken extends BaseService { constructor(egg) { super(); this.egg = egg; } }
class Egg extends BaseService { constructor(chicken) { super(); this.chicken = chicken; } }
decorate(injectable(T.chicken), inject('egg'))(Chicken);
decorate(injectable(T.egg), inject('chicken'))(Egg);

// Circular broken by lazy
class Ping extends BaseService {
  constructor(pong) { super(); this.pong = pong; }
  hit(n) { return n <= 0 ? 'ping-done' : this.pong.hit(n - 1); }
}
class Pong extends BaseService {
  constructor(ping) { super(); this.ping = ping; }
  hit(n) { return n <= 0 ? 'pong-done' : this.ping.hit(n - 1); }
}
decorate(injectable(T.ping, { scope: 'singleton' }), inject(lazy('pong')))(Ping);
decorate(injectable(T.pong, { scope: 'singleton' }), inject('ping'))(Pong);

// Property injection + ill-scoped
class Reporter extends BaseService {
  kind() { return 'reporter'; }
  report() { return `cfg.retries=${this.config.get('retries')} db=${this.db.url}`; }
}
decorate(injectable(T.reporter), injectProp('config', T.config), injectProp('db', T.db))(Reporter);

class BadSingleton extends BaseService { constructor(repo) { super(); this.repo = repo; } }
decorate(injectable(T.bad, { scope: 'singleton' }), inject('userRepo'))(BadSingleton);

// Mailer as object-literal with super
const baseMailer = {
  sent: [],
  send(to, subject) { this.sent.push(`${to}|${subject}`); return this.sent.length; },
};
function makeMailer(prefix) {
  const m = {
    sent: [],
    send(to, subject) { return super.send(to, `${prefix}${subject}`); },
  };
  return Object.setPrototypeOf(m, baseMailer);
}

// Clock (deterministic)
function makeClock(start = 1000) {
  let t = start;
  return { tick: () => (t += 7), get now() { return t; } };
}

// ---------------------------------------------------------------------------
// Resolution helpers with deep recursion (chain of factories)
// ---------------------------------------------------------------------------
function buildChain(container, n) {
  container.factory(T['chain0'], () => 0, [], 'singleton');
  for (let i = 1; i <= n; i++) {
    const prev = T['chain' + (i - 1)];
    container.factory(T['chain' + i], (p) => p + (i % 3), [prev], 'singleton');
  }
  return T['chain' + n];
}

// ---------------------------------------------------------------------------
// Tagged template to build a module definition
// ---------------------------------------------------------------------------
function moduleDef(strings, ...values) {
  const out = [];
  strings.forEach((s, i) => {
    for (const line of s.split(/[\n;]/)) {
      const m = /^\s*(?<name>[a-z]\w*)\s*(?<op>=|->)\s*(?<rhs>[\w.]*)\s*$/i.exec(line);
      if (!m) continue;
      const { name, op, rhs } = m.groups;
      out.push({ name, op, rhs: rhs || (i < values.length ? values[i] : null) });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('== d19 di container ==');
console.log('token: ' + String(T.config) + ' num=' + +T.config + ' same=' + (T.config === Token.of('config')) + ' tag=' + Object.prototype.toString.call(T.db));
console.log('token checks: ' + Token.isToken(T.x) + ' ' + Token.isToken({}) + ' has=' + ('x' in T) + ' ' + ('zzz' in T));

const root = new Container();
root.register(Config).register(Database).register(UserRepo).register(AuditLog).register(UserService)
  .register(Chicken).register(Egg).register(Ping).register(Pong).register(Reporter).register(BadSingleton)
  .factory(T.clock, () => makeClock(), [], 'scoped')
  .value(T.appName, 'demo-app')
  .alias(T.settings, T.config);

console.log('entries: ' + JSON.stringify([...root.entries()]));
{
  let n = 0;
  providers: for (const [tok, scope, kind] of root.entries()) {
    n++;
    switch (kind) {
      case 'alias':
        console.log(`  provider ${n}: ${tok} (alias -> ${String(root.resolve(T.settings) === root.resolve(T.config) ? 'config' : '?')})`);
        continue providers;
      case 'value':
      case 'factory':
        console.log(`  provider ${n}: ${tok} ${scope} ${kind}`);
        break;
      default:
        console.log(`  provider ${n}: ${tok} ${scope} class rank=${SCOPE_RANK[scope] ?? 0}`);
    }
  }
}

const cfg1 = root.resolve(T.config);
const cfg2 = root.resolve(T.settings);
console.log('singleton same: ' + (cfg1 === cfg2) + ' ' + cfg1.describe());
console.log('config get: ' + cfg1.get('features.cache') + ' ' + cfg1.get('features.missing', 'dflt') + ' ' + cfg1.get('retries'));
cfg1.set('features.audit', true);
cfg1.set('new.deep.key', 5);
console.log('config after set: ' + cfg1.get('features.audit') + ' ' + cfg1.get('new.deep.key'));

const db = root.resolve(T.db);
console.log('db: ' + db.describe() + ' open=' + db.isOpen + ' log=' + JSON.stringify(db.log));

// Scoped from root -> error
try {
  root.resolve(T.userRepo);
} catch (e) {
  console.log(`scope error: ${e.kind} ${e instanceof ScopeError} ${e instanceof DIError} ${e.message}`);
}

// Request scopes
const requests = [
  { name: 'alice', roles: ['admin', 'ops'] },
  { name: 'bob' },
  { name: 'carol', email: 'c@x.test', roles: [] },
  { name: 'alice' },
  {},
];
const scopes = [];
for (const [i, req] of requests.entries()) {
  const scope = root.createScope('req' + i);
  scopes.push(scope);
  if (i % 2 === 0) scope.value(T.mailer, makeMailer(`[r${i}] `));
  try {
    const svc = scope.resolve(T.userService);
    const svc2 = scope.resolve(T.userService);
    const id = svc.register(req);
    console.log(`req${i}: id=${id} sameSvc=${svc === svc2} audit=${svc.audit?.entries.join('|') ?? 'none'} mailer=${typeof svc.mailer}`);
  } catch (err) {
    const { message, constructor: { prototype } } = err;
    console.log(`req${i}: failed (${prototype === TypeError.prototype ? 'TypeError' : 'Error'}) ${message}`);
  } finally {
    console.log(`req${i}: depth=${scope.depth} name=${scope.name}`);
  }
}
console.log('users: ' + JSON.stringify(db.select('users')));
console.log('mailer sent (shared proto): ' + JSON.stringify(baseMailer.sent));

// Dispose scopes (flush audits)
for (const s of scopes) {
  try {
    console.log(`dispose ${s.name}: ${s.dispose()} again=${s.dispose()}`);
  } catch (e) {
    console.log(`dispose ${s.name} failed: ${e.message}`);
  }
}
try { scopes[0].resolve(T.config); } catch (e) { console.log('after dispose: ' + e.kind); }

// Circular detection
try {
  root.resolve(T.chicken);
} catch (e) {
  console.log(`circular: ${e.kind} path=${JSON.stringify(e.path)}`);
}

// Lazy breaks cycle
const ping = root.resolve(T.ping);
console.log('lazy: ' + ping.hit(5) + ' ' + ping.hit(6) + ' pongIsLazy=' + ping.pong.__isLazy + ' same=' + (root.resolve(T.pong).ping === ping));

// Property injection
const rep = root.resolve(T.reporter);
console.log('reporter: ' + rep.report() + ' keys=' + JSON.stringify(Object.keys(rep)) + ' hasConfig=' + ('config' in rep));

// Captive dependency detection
try {
  root.createScope('x').resolve(T.bad);
} catch (e) {
  console.log('captive: ' + e.kind + ' ' + e.message);
}

// Missing / optional
try { root.resolve(T.nothingHere); } catch (e) { console.log('missing: ' + e.message); }
console.log('optional: ' + root.resolve(optional('nothingHere')) + ' ' + typeof root.resolve(optional('appName')));
try { new Provider(T.x); } catch (e) { console.log('abstract provider: ' + e.message); }

// Deep chain resolution (~3000 recursion levels through resolve)
{
  const c = new Container(null, 'chain');
  const top = buildChain(c, 900);
  try {
    console.log('chain(900) = ' + c.resolve(top));
  } catch (e) {
    console.log('chain failed: ' + (e instanceof RangeError));
  }
  console.log('chain events: ' + c.events.length + ' first=' + c.events[0] + ' last=' + c.events.at(-1));
}

// Module definitions via tagged template
const mod = moduleDef`
  greeting = ${'hello'}
  target -> appName; shout =
  ${42}
`;
console.log('moduleDef: ' + JSON.stringify(mod));
{
  const c = root.createScope('mod');
  for (const { name, op, rhs } of mod) {
    if (op === '=') c.value(T[name], rhs);
    else c.alias(T[name], T[rhs]);
  }
  console.log('module resolve: ' + [c.resolve(T.greeting), c.resolve(T.target), c.resolve(T.shout)].join(','));
}

// Hook ordering and dispose error aggregation
{
  const c = new Container(null, 'hooks');
  const order = [];
  class A extends BaseService { init() { order.push('initA'); } fin() { order.push('finA'); } }
  class B extends BaseService { constructor(a) { super(); this.a = a; } init() { order.push('initB'); } fin() { order.push('finB'); throw new Error('B broke'); } }
  class C extends BaseService { constructor(b, a) { super(); Object.assign(this, { a, b }); } init() { order.push('initC'); } fin() { order.push('finC'); } }
  decorate(injectable(T.hA, { scope: 'singleton' }), onInit('init'), onDispose('fin'))(A);
  decorate(injectable(T.hB, { scope: 'singleton' }), inject(T.hA), onInit('init'), onDispose('fin'))(B);
  decorate(injectable(T.hC, { scope: 'singleton' }), inject('hB', 'hA'), onInit('init'), onDispose('fin'))(C);
  c.register(A).register(B).register(C);
  const cc = c.resolve(T.hC);
  console.log('hooks: shared a=' + (cc.a === cc.b.a) + ' order=' + order.join(','));
  try {
    c.dispose();
  } catch (e) {
    console.log('aggregate: ' + (e instanceof AggregateError) + ' n=' + e.errors.length + ' ' + e.message);
  }
  console.log('dispose order: ' + order.join(',') + ' events=' + c.events.join(','));
}

// Closures capturing loop vars as factories
{
  const c = new Container(null, 'loops');
  const names = { alpha: 1, beta: 2, gamma: 3 };
  for (const key in names) c.factory(T['in_' + key], () => key.toUpperCase() + names[key]);
  for (const [i, v] of ['x', 'y'].entries()) c.factory(T['of_' + v], () => v.repeat(i + 1));
  for (let i = 0; i < 3; i++) c.factory(T['let_' + i], () => i * 10);
  const got = [...c.entries()].map(([t]) => c.resolve(Token.of(t.slice(6, -1))));
  console.log('loop factories: ' + JSON.stringify(got));
}

// Async factories
(async () => {
  const c = new Container(null, 'async');
  const trace = [];
  c.factory(T.remoteCfg, async () => {
    trace.push('fetch-start');
    await null;
    trace.push('fetch-end');
    return { region: 'eu', shards: 4 };
  }, [], 'singleton');
  c.factory(T.pool, async (cfgP) => {
    const cfg = await cfgP;
    trace.push('pool');
    return Array.from({ length: cfg.shards }, (_, i) => `${cfg.region}-${i}`);
  }, [T.remoteCfg], 'singleton');
  const [pool, cfg] = await Promise.all([c.resolveAsync(T.pool), c.resolveAsync(T.remoteCfg)]);
  console.log('async pool: ' + JSON.stringify(pool) + ' cfg=' + JSON.stringify(cfg));
  console.log('async trace: ' + trace.join(','));
  async function* services(container, tokens) {
    for (const t of tokens) {
      try {
        yield [String(t), await container.resolveAsync(t)];
      } catch (e) {
        yield [String(t), 'ERR ' + e.kind];
      }
    }
  }
  const rows = [];
  for await (const [t, v] of services(c, [T.pool, T.missingOne, T.remoteCfg])) rows.push(`${t}=${JSON.stringify(v)}`);
  console.log('async services: ' + rows.join(' ; '));
  const results = await Promise.allSettled([c.resolveAsync(T.nope), c.resolveAsync(T.pool)]);
  console.log('allSettled: ' + results.map((r) => r.status).join(','));
  console.log('tokens > 20: ' + (Token.count > 20) + ' instances=' + (instanceCounter > 10));
  console.log('events sample: ' + root.events.slice(0, 6).join(','));
})().catch((e) => console.log('async error: ' + e.message)).finally(() => console.log('== d19 end =='));
