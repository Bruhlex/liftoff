// Event sourcing + observer pattern with subscriptions, unsubscribe, error isolation
'use strict';

const EVENT_KIND = Symbol('eventKind');

class EventBus {
  #handlers = new Map();
  #errors = [];
  #dispatchCount = 0;
  static instances = 0;

  constructor(name = 'bus') {
    this.name = name;
    EventBus.instances++;
  }

  get dispatchCount() {
    return this.#dispatchCount;
  }

  get errors() {
    return [...this.#errors];
  }

  subscribe(topic, handler, { once = false, priority = 0 } = {}) {
    let list = this.#handlers.get(topic);
    if (!list) {
      list = [];
      this.#handlers.set(topic, list);
    }
    const entry = { handler, once, priority, id: list.length + 1 + topic.length * 100 };
    list.push(entry);
    list.sort((a, b) => b.priority - a.priority || a.id - b.id);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      const cur = this.#handlers.get(topic) ?? [];
      const idx = cur.indexOf(entry);
      if (idx >= 0) cur.splice(idx, 1);
      return true;
    };
  }

  publish(topic, payload) {
    this.#dispatchCount++;
    const list = this.#handlers.get(topic);
    const wildcard = this.#handlers.get('*') ?? [];
    const all = [...(list ?? []), ...wildcard];
    let delivered = 0;
    for (const entry of all) {
      try {
        entry.handler(payload, topic);
        delivered++;
      } catch (err) {
        this.#errors.push(`${topic}: ${err.message}`);
      } finally {
        if (entry.once) {
          const owner = list && list.includes(entry) ? list : wildcard;
          owner.splice(owner.indexOf(entry), 1);
        }
      }
    }
    return delivered;
  }

  topics() {
    return [...this.#handlers.keys()].sort();
  }

  handlerCount(topic) {
    return this.#handlers.get(topic)?.length ?? 0;
  }
}

class DomainEvent {
  static #seq = 0;
  constructor(type, aggregateId, data = {}) {
    this.seq = ++DomainEvent.#seq;
    this.type = type;
    this.aggregateId = aggregateId;
    this.data = data;
    this[EVENT_KIND] = 'domain';
  }
  toString() {
    return `#${this.seq} ${this.type}(${this.aggregateId}) ${JSON.stringify(this.data)}`;
  }
  static resetSeq() {
    DomainEvent.#seq = 0;
  }
}

class EventStore {
  #events = [];
  #bus;
  constructor(bus) {
    this.#bus = bus;
  }
  append(event) {
    if (!(event instanceof DomainEvent)) throw new TypeError('not a domain event');
    this.#events.push(event);
    this.#bus.publish(event.type, event);
    return this.#events.length;
  }
  *stream(aggregateId) {
    for (const e of this.#events) {
      if (aggregateId === undefined || e.aggregateId === aggregateId) yield e;
    }
  }
  get size() {
    return this.#events.length;
  }
  snapshot() {
    return JSON.stringify(this.#events.map(({ seq, type, aggregateId, data }) => ({ seq, type, aggregateId, data })));
  }
}

class Cart {
  constructor(id) {
    this.id = id;
    this.items = new Map();
    this.checkedOut = false;
    this.version = 0;
  }
  apply(event) {
    this.version++;
    switch (event.type) {
      case 'ItemAdded': {
        const { sku, qty = 1, price } = event.data;
        const prev = this.items.get(sku);
        this.items.set(sku, { qty: (prev?.qty ?? 0) + qty, price: price ?? prev?.price ?? 0 });
        break;
      }
      case 'ItemRemoved': {
        const { sku, qty } = event.data;
        const prev = this.items.get(sku);
        if (!prev) break;
        prev.qty -= qty ?? prev.qty;
        if (prev.qty <= 0) this.items.delete(sku);
        break;
      }
      case 'CheckedOut':
        this.checkedOut = true;
        break;
      case 'CouponApplied':
        this.coupon ??= event.data.code;
        break;
      default:
        this.version--;
    }
    return this;
  }
  get total() {
    let sum = 0;
    for (const [, { qty, price }] of this.items) sum += qty * price;
    if (this.coupon === 'HALF') sum = Math.floor(sum / 2);
    else if (this.coupon?.startsWith('OFF')) sum -= Number(this.coupon.slice(3)) || 0;
    return Math.max(0, sum);
  }
  static rehydrate(id, events) {
    const cart = new Cart(id);
    for (const e of events) cart.apply(e);
    return cart;
  }
}

function makeCounterProjection(bus) {
  const counts = {};
  const unsub = bus.subscribe('*', (_payload, topic) => {
    counts[topic] = (counts[topic] || 0) + 1;
  });
  return { counts, stop: unsub };
}

function makeRevenueProjection(bus) {
  let revenue = 0;
  const log = [];
  bus.subscribe('ItemAdded', (e) => {
    const { qty = 1, price = 0 } = e.data;
    revenue += qty * price;
    log.push(`+${qty * price}`);
  }, { priority: 5 });
  bus.subscribe('ItemRemoved', (e) => {
    log.push(`-${e.data.sku}`);
  });
  return {
    get revenue() { return revenue; },
    get log() { return log.join(' '); },
  };
}

function faultyHandlerFactory(threshold) {
  let calls = 0;
  return function faulty(e) {
    calls++;
    if (calls % threshold === 0) {
      throw new Error(`faulty call ${calls} on seq ${e?.seq}`);
    }
  };
}

function tag(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? `[${String(values[i]).toUpperCase()}]` : ''), '');
}

function runBasicBus() {
  console.log('--- basic bus ---');
  const bus = new EventBus('basic');
  const received = [];
  const u1 = bus.subscribe('greet', (p) => received.push(`a:${p}`));
  const u2 = bus.subscribe('greet', (p) => received.push(`b:${p}`), { priority: 10 });
  bus.subscribe('greet', (p) => received.push(`once:${p}`), { once: true });
  console.log('delivered', bus.publish('greet', 'hi'));
  console.log('delivered', bus.publish('greet', 'yo'));
  console.log('unsub u1', u1(), 'again', u1());
  console.log('delivered', bus.publish('greet', 'hey'));
  u2();
  console.log('delivered after all unsub', bus.publish('greet', 'none'));
  console.log('received', received.join(','));
  console.log('topics', bus.topics().join('|'), 'count', bus.handlerCount('greet'));
  console.log(tag`bus ${bus.name} dispatched ${bus.dispatchCount} times`);
}

function runErrorIsolation() {
  console.log('--- error isolation ---');
  const bus = new EventBus('errors');
  const seen = [];
  bus.subscribe('tick', faultyHandlerFactory(2));
  bus.subscribe('tick', (e) => seen.push(e.seq));
  bus.subscribe('tick', () => { throw new RangeError('always'); }, { priority: -1 });
  for (let i = 1; i <= 5; i++) {
    const d = bus.publish('tick', { seq: i });
    console.log(`tick ${i} delivered=${d}`);
  }
  console.log('seen', JSON.stringify(seen));
  const errs = bus.errors;
  console.log('errors', errs.length);
  errs.forEach((e, i) => console.log(`  err[${i}] ${e}`));
}

function runEventSourcing() {
  console.log('--- event sourcing ---');
  DomainEvent.resetSeq();
  const bus = new EventBus('store');
  const store = new EventStore(bus);
  const counter = makeCounterProjection(bus);
  const revenue = makeRevenueProjection(bus);
  const script = [
    ['ItemAdded', 'c1', { sku: 'apple', qty: 3, price: 20 }],
    ['ItemAdded', 'c1', { sku: 'pear', price: 35 }],
    ['ItemAdded', 'c2', { sku: 'melon', qty: 2, price: 120 }],
    ['ItemRemoved', 'c1', { sku: 'apple', qty: 1 }],
    ['CouponApplied', 'c2', { code: 'OFF50' }],
    ['CouponApplied', 'c2', { code: 'HALF' }],
    ['ItemAdded', 'c1', { sku: 'apple', qty: 4 }],
    ['Unknown', 'c1', {}],
    ['CheckedOut', 'c2'],
    ['ItemRemoved', 'c1', { sku: 'pear' }],
  ];
  for (const [type, id, data] of script) {
    const n = store.append(new DomainEvent(type, id, data));
    if (n === 5) counter.stop();
  }
  try {
    store.append({ type: 'fake' });
  } catch (e) {
    console.log('rejected:', e.constructor.name, e.message);
  }
  for (const e of store.stream('c1')) console.log('c1 event', String(e));
  const carts = ['c1', 'c2', 'c3'].map((id) => Cart.rehydrate(id, store.stream(id)));
  for (const { id, items, total, version, checkedOut, coupon } of carts) {
    console.log(`cart ${id}: v${version} items=${JSON.stringify([...items])} total=${total} out=${checkedOut} coupon=${coupon ?? '-'}`);
  }
  console.log('counter (stopped at 5)', JSON.stringify(counter.counts));
  console.log('revenue', revenue.revenue, 'log', revenue.log);
  console.log('store size', store.size, 'snapshot length', store.snapshot().length);
  const parsed = JSON.parse(store.snapshot());
  const byType = parsed.reduce((m, { type }) => m.set(type, (m.get(type) ?? 0) + 1), new Map());
  console.log('by type', [...byType].map(([k, v]) => `${k}=${v}`).join(' '));
  return store;
}

function replayUntil(store, predicate) {
  const out = [];
  outer: for (const e of store.stream()) {
    for (const key in e.data) {
      if (predicate(key, e.data[key])) {
        out.push(`stop@${e.seq}:${key}`);
        break outer;
      }
    }
    out.push(e.seq);
  }
  return out;
}

function kindCheck(store) {
  let domain = 0;
  let i = 0;
  const it = store.stream();
  let step;
  do {
    step = it.next();
    if (!step.done && step.value[EVENT_KIND] === 'domain') domain++;
    i++;
  } while (!step.done);
  return { domain, iterations: i };
}

async function asyncObserverDemo() {
  console.log('--- async observers ---');
  const bus = new EventBus('async');
  const results = [];
  const pending = [];
  bus.subscribe('job', (p) => {
    pending.push((async () => {
      await null;
      results.push(`slow:${p}`);
    })());
  });
  bus.subscribe('job', (p) => {
    pending.push(Promise.resolve(p).then((v) => results.push(`fast:${v}`)));
  });
  ['x', 'y', 'z'].forEach((j) => bus.publish('job', j));
  await Promise.all(pending);
  console.log('async results', results.join(' '));
  let settled = await Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(new Error('nope')),
  ]);
  console.log('settled', settled.map((s) => s.status + ':' + (s.value ?? s.reason.message)).join(', '));
}

function summarize() {
  const args = Array.prototype.slice.call(arguments);
  return args.map((a, i) => `${i}=${typeof a === 'object' ? JSON.stringify(a) : a}`).join('; ');
}

async function main() {
  runBasicBus();
  runErrorIsolation();
  const store = runEventSourcing();
  console.log('replay', replayUntil(store, (k, v) => k === 'code' && /^H/.test(v)).join(','));
  const kc = kindCheck(store);
  console.log('kind check', kc.domain, kc.iterations);
  await asyncObserverDemo();
  console.log('instances', EventBus.instances);
  console.log('summary', summarize('done', { ok: true }, 42));
}

main().then(() => console.log('main finished'), (e) => console.log('main failed', e.message));
