// Inventory / warehouse simulation with deterministic async order processing
'use strict';

const LOG_TAG = Symbol('logTag');

class InventoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details;
  }
}

class Product {
  #sku;
  #price;
  static #count = 0;
  constructor(sku, name, price, weight = 1) {
    this.#sku = sku;
    this.name = name;
    this.#price = price;
    this.weight = weight;
    Product.#count++;
  }
  get sku() { return this.#sku; }
  get price() { return this.#price; }
  set price(v) {
    if (typeof v !== 'number' || v < 0) throw new InventoryError('BAD_PRICE', `invalid price ${v}`);
    this.#price = v;
  }
  static get created() { return Product.#count; }
  toString() { return `${this.#sku}(${this.name} @ ${this.#price.toFixed(2)})`; }
}

class Bin {
  constructor(id, capacity) {
    this.id = id;
    this.capacity = capacity;
    this.items = new Map();
  }
  get used() {
    let total = 0;
    for (const qty of this.items.values()) total += qty;
    return total;
  }
  get free() { return this.capacity - this.used; }
  put(sku, qty) {
    const room = Math.min(this.free, qty);
    if (room <= 0) return 0;
    this.items.set(sku, (this.items.get(sku) ?? 0) + room);
    return room;
  }
  take(sku, qty) {
    const have = this.items.get(sku) ?? 0;
    const n = Math.min(have, qty);
    if (n === have) this.items.delete(sku);
    else this.items.set(sku, have - n);
    return n;
  }
}

class Warehouse {
  #bins = [];
  #catalog = new Map();
  #reserved = new Map();
  #audit = [];
  constructor(name, binCount, binCapacity) {
    this.name = name;
    for (let i = 0; i < binCount; i++) this.#bins.push(new Bin(`${name}-B${i}`, binCapacity));
    this[LOG_TAG] = `[${name}]`;
  }
  register(product) {
    this.#catalog.set(product.sku, product);
    this.#log('register', product.sku);
  }
  product(sku) {
    return this.#catalog.get(sku) ?? null;
  }
  #log(action, ...args) {
    this.#audit.push(`${action}:${args.join(',')}`);
  }
  stock(sku) {
    let n = 0;
    for (const b of this.#bins) n += b.items.get(sku) ?? 0;
    return n;
  }
  available(sku) {
    return this.stock(sku) - (this.#reserved.get(sku) ?? 0);
  }
  receive(sku, qty) {
    if (!this.#catalog.has(sku)) throw new InventoryError('UNKNOWN_SKU', `unknown ${sku}`, { sku });
    let left = qty;
    for (const bin of this.#bins) {
      if (left <= 0) break;
      left -= bin.put(sku, left);
    }
    this.#log('receive', sku, qty - left);
    if (left > 0) throw new InventoryError('FULL', `warehouse full, ${left} of ${sku} rejected`, { sku, left });
    return qty;
  }
  reserve(sku, qty) {
    if (this.available(sku) < qty) {
      throw new InventoryError('SHORT', `short on ${sku}: need ${qty}, have ${this.available(sku)}`, { sku, qty });
    }
    this.#reserved.set(sku, (this.#reserved.get(sku) ?? 0) + qty);
    this.#log('reserve', sku, qty);
  }
  release(sku, qty) {
    const cur = this.#reserved.get(sku) ?? 0;
    const next = Math.max(0, cur - qty);
    if (next === 0) this.#reserved.delete(sku); else this.#reserved.set(sku, next);
    this.#log('release', sku, qty);
  }
  pick(sku, qty) {
    let left = qty;
    for (let i = this.#bins.length - 1; i >= 0 && left > 0; i--) {
      left -= this.#bins[i].take(sku, left);
    }
    this.release(sku, qty - left);
    this.#log('pick', sku, qty - left);
    return qty - left;
  }
  *binReport() {
    for (const bin of this.#bins) {
      const entries = [...bin.items].map(([k, v]) => `${k}=${v}`).join(' ');
      yield `${bin.id} used=${bin.used}/${bin.capacity} ${entries || '(empty)'}`;
    }
  }
  get auditTrail() { return this.#audit.slice(); }
  get totalValue() {
    let sum = 0;
    for (const [sku, p] of this.#catalog) sum += this.stock(sku) * p.price;
    return Math.round(sum * 100) / 100;
  }
}

// deterministic "async" helpers: resolve through microtasks only
function tick(n = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

async function fetchSupplierQuote(sku, qty) {
  await tick(sku.length % 3 + 1);
  const base = [...sku].reduce((a, c) => a + c.charCodeAt(0), 0) % 17;
  return { sku, qty, unit: base + 3, total: (base + 3) * qty };
}

const eventLog = [];
function logEvent(kind, payload) {
  eventLog.push(`${kind}${payload ? ' ' + JSON.stringify(payload) : ''}`);
}

async function processOrder(wh, order) {
  const { id, lines, priority = 'normal', customer: { name, vip = false } = {} } = order;
  console.log(`order ${id} for ${name ?? 'anonymous'} (${priority}${vip ? ', vip' : ''})`);
  const reserved = [];
  try {
    for (const { sku, qty } of lines) {
      await tick();
      wh.reserve(sku, qty);
      reserved.push({ sku, qty });
    }
    let subtotal = 0;
    for (const { sku, qty } of reserved) {
      const picked = wh.pick(sku, qty);
      const p = wh.product(sku);
      subtotal += picked * p.price;
      console.log(`  picked ${picked}x ${p}`);
    }
    const discount = vip ? 0.1 : 0;
    const total = Math.round(subtotal * (1 - discount) * 100) / 100;
    logEvent('shipped', { id, total });
    return { id, status: 'shipped', total };
  } catch (err) {
    for (const r of reserved) wh.release(r.sku, r.qty);
    if (err instanceof InventoryError) {
      console.log(`  order ${id} failed: ${err.code} ${err.message}`);
      logEvent('failed', { id, code: err.code });
      return { id, status: 'failed', reason: err.code, details: err.details };
    }
    throw err;
  } finally {
    console.log(`  order ${id} done, reserved=${reserved.length}`);
  }
}

async function restock(wh, skus, threshold) {
  const low = skus.filter((s) => wh.available(s) < threshold);
  console.log(`restock check: low=${JSON.stringify(low)}`);
  const quotes = await Promise.all(low.map((s) => fetchSupplierQuote(s, threshold * 2)));
  for (const q of quotes) {
    try {
      wh.receive(q.sku, q.qty);
      console.log(`  restocked ${q.sku} +${q.qty} cost=${q.total}`);
    } catch (e) {
      console.log(`  restock ${q.sku} error: ${e.code} left=${e.details?.left}`);
    }
  }
  return quotes.reduce((a, q) => a + q.total, 0);
}

function summarize(results) {
  const byStatus = {};
  for (const r of results) {
    byStatus[r.status] ||= [];
    byStatus[r.status].push(r.id);
  }
  let revenue = 0;
  for (const r of results) revenue += r.total ?? 0;
  return { byStatus, revenue: Math.round(revenue * 100) / 100 };
}

function money(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    const v = vals[i - 1];
    return out + (typeof v === 'number' ? v.toFixed(2) + ' EUR' : String(v)) + s;
  });
}

async function runBatch(wh, orders, concurrency) {
  const results = [];
  let idx = 0;
  async function worker(wid) {
    while (idx < orders.length) {
      const my = orders[idx++];
      const r = await processOrder(wh, my);
      r.worker = wid;
      results.push(r);
    }
  }
  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker(w));
  await Promise.all(workers);
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

async function main() {
  const wh = new Warehouse('WH1', 5, 40);
  const products = [
    new Product('A100', 'bolt', 0.25, 0.01),
    new Product('B200', 'nut', 0.1),
    new Product('C300', 'gear', 4.5, 0.3),
    new Product('D400', 'motor', 39.99, 2.5),
    new Product('E500', 'belt', 7.2),
  ];
  products.forEach((p) => wh.register(p));
  console.log(`products created: ${Product.created}`);

  try {
    products[1].price = -3;
  } catch (e) {
    console.log(`price error: ${e.name}/${e.code}: ${e.message}`);
  }
  products[1].price = 0.12;

  const initial = { A100: 60, B200: 50, C300: 20, D400: 6, E500: 12 };
  for (const sku in initial) {
    if (!Object.prototype.hasOwnProperty.call(initial, sku)) continue;
    wh.receive(sku, initial[sku]);
  }
  try {
    wh.receive('Z999', 1);
  } catch (e) {
    console.log(`receive error: ${e.code} ${JSON.stringify(e.details)}`);
  }
  for (const line of wh.binReport()) console.log(line);
  console.log(money`initial value: ${wh.totalValue}`);

  const orders = [
    { id: 'O1', lines: [{ sku: 'A100', qty: 10 }, { sku: 'B200', qty: 10 }], customer: { name: 'Ada' } },
    { id: 'O2', lines: [{ sku: 'D400', qty: 2 }], customer: { name: 'Bob', vip: true }, priority: 'high' },
    { id: 'O3', lines: [{ sku: 'C300', qty: 25 }], customer: { name: 'Cyd' } },
    { id: 'O4', lines: [{ sku: 'E500', qty: 5 }, { sku: 'D400', qty: 3 }] },
    { id: 'O5', lines: [{ sku: 'D400', qty: 2 }, { sku: 'A100', qty: 5 }], customer: { name: 'Eve', vip: true } },
    { id: 'O6', lines: [{ sku: 'B200', qty: 45 }], customer: { name: 'Fay' } },
  ];
  const results = await runBatch(wh, orders, 2);
  for (const r of results) {
    const { id, status, total, reason, worker } = r;
    console.log(`result ${id}: ${status} ${total !== undefined ? total.toFixed(2) : reason} (w${worker})`);
  }
  const { byStatus, revenue } = summarize(results);
  console.log(`by status: ${JSON.stringify(byStatus)}`);
  console.log(money`revenue: ${revenue}`);

  const cost = await restock(wh, products.map((p) => p.sku), 15);
  console.log(`restock cost: ${cost}`);
  for (const line of wh.binReport()) console.log(line);
  console.log(money`final value: ${wh.totalValue}`);

  const counts = wh.auditTrail.reduce((m, e) => {
    const k = e.split(':')[0];
    m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, new Map());
  console.log(`audit: ${[...counts].map(([k, v]) => k + '=' + v).join(', ')}`);
  console.log(`events: ${eventLog.length}`);
  eventLog.forEach((e, i) => console.log(`  ${i}: ${e}`));
  console.log(`tag: ${wh[LOG_TAG]} ${String(LOG_TAG)}`);
}

main().then(() => console.log('done'), (e) => console.log('fatal', e));
