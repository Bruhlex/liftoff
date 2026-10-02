// Testprogramm 15 für die obfuscator.io VM-Obfuskierung: Shop-Anwendung.
//
// Module: Testdaten, Katalog mit Indizes, Volltextsuche mit Ranking,
// LRU-Cache und Memoisierung, Warenkorb mit Aktionen, Checkout mit
// Lagerreservierung, Bestellhistorie und Empfehlungen, Rate-Limiter und
// Anfrage-Warteschlange mit simulierter Uhr, Analytics mit Top-K-Heap.
//
// "Performance" wird nicht in Millisekunden gemessen (nicht deterministisch),
// sondern über Zähler: Vergleiche, Cache-Treffer, durchsuchte Einträge usw.
// So bleibt die Ausgabe bei jedem Lauf identisch.

"use strict";

// =====================================================================
// 1. Hilfsmittel
// =====================================================================

/** Einfacher deterministischer Zufallsgenerator (lineare Kongruenz). */
class SeededRandom {
  constructor(seed) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }
  next() {
    this.state = (this.state * 16807) % 2147483647;
    return (this.state - 1) / 2147483646;
  }
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick(list) {
    return list[this.int(0, list.length - 1)];
  }
  sample(list, n) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }
}

const euro = (cents) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100).toLocaleString("de-DE")},${String(abs % 100).padStart(2, "0")} €`;
};

/** Zählt Operationen pro Kategorie ("Performance-Zähler"). */
class Metrics {
  #counters = new Map();
  inc(name, by = 1) {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }
  get(name) {
    return this.#counters.get(name) ?? 0;
  }
  snapshot(prefix = "") {
    return Object.fromEntries([...this.#counters].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)));
  }
  reset(prefix = "") {
    for (const key of [...this.#counters.keys()]) if (key.startsWith(prefix)) this.#counters.delete(key);
  }
}

const metrics = new Metrics();

/** Ereignisbus mit Wildcards ("order.*"). */
class EventBus {
  #handlers = [];
  on(pattern, handler) {
    const re = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`);
    const entry = { re, handler };
    this.#handlers.push(entry);
    return () => {
      this.#handlers = this.#handlers.filter((h) => h !== entry);
    };
  }
  emit(event, payload) {
    metrics.inc("bus.events");
    for (const { re, handler } of this.#handlers) {
      if (re.test(event)) {
        metrics.inc("bus.deliveries");
        handler(payload, event);
      }
    }
  }
}

const bus = new EventBus();

// =====================================================================
// 2. Datenstrukturen für Performance
// =====================================================================

/** LRU-Cache auf Basis der Einfügereihenfolge einer Map. */
class LRUCache {
  constructor(capacity, name) {
    this.capacity = capacity;
    this.name = name;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) {
      metrics.inc(`cache.${this.name}.miss`);
      return undefined;
    }
    metrics.inc(`cache.${this.name}.hit`);
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      metrics.inc(`cache.${this.name}.evict`);
    }
    this.map.set(key, value);
  }
  invalidate(predicate) {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) {
        this.map.delete(key);
        n++;
      }
    }
    metrics.inc(`cache.${this.name}.invalidated`, n);
    return n;
  }
}

/** Memoisierung mit eigenem Schlüssel und LRU-Cache. */
function memoize(fn, { name, capacity = 64, key = (...args) => JSON.stringify(args) }) {
  const cache = new LRUCache(capacity, name);
  const wrapped = (...args) => {
    const k = key(...args);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const value = fn(...args);
    cache.set(k, value);
    return value;
  };
  wrapped.cache = cache;
  return wrapped;
}

/** Binärer Min-Heap mit Vergleichsfunktion (für Top-K). */
class MinHeap {
  constructor(compare) {
    this.items = [];
    this.compare = (a, b) => {
      metrics.inc("heap.compare");
      return compare(a, b);
    };
  }
  get size() {
    return this.items.length;
  }
  peek() {
    return this.items[0];
  }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(a[i], a[parent]) >= 0) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < a.length && this.compare(a[l], a[smallest]) < 0) smallest = l;
        if (r < a.length && this.compare(a[r], a[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [a[i], a[smallest]] = [a[smallest], a[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Top-K in O(n log k) statt vollständigem Sortieren. */
function topK(iterable, k, score) {
  const heap = new MinHeap((a, b) => a.score - b.score || (a.key < b.key ? 1 : -1));
  for (const item of iterable) {
    const entry = { item, score: score(item), key: item.id ?? String(item) };
    if (heap.size < k) heap.push(entry);
    else if (heap.compare(entry, heap.peek()) > 0) {
      heap.pop();
      heap.push(entry);
    }
  }
  const out = [];
  while (heap.size) out.push(heap.pop());
  return out.reverse().map((e) => ({ ...e.item, score: e.score }));
}

/** Untere Grenze in einem sortierten Array (binäre Suche). */
function lowerBound(sorted, value, key = (x) => x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    metrics.inc("search.binarySteps");
    const mid = (lo + hi) >>> 1;
    if (key(sorted[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// =====================================================================
// 3. Testdaten
// =====================================================================
const CATEGORIES = ["Bücher", "Elektronik", "Küche", "Garten", "Spielzeug", "Sport"];
const ADJECTIVES = ["robuster", "leichter", "kompakter", "smarter", "klassischer", "nachhaltiger", "schneller", "leiser"];
const NOUNS = {
  Bücher: ["Roman", "Kochbuch", "Reiseführer", "Bildband", "Krimi"],
  Elektronik: ["Kopfhörer", "Lautsprecher", "Ladegerät", "Monitor", "Tastatur"],
  Küche: ["Mixer", "Topf", "Messer", "Wasserkocher", "Pfanne"],
  Garten: ["Rasenmäher", "Gartenschlauch", "Pflanzkübel", "Gartenschere", "Hochbeet"],
  Spielzeug: ["Puzzle", "Baukasten", "Brettspiel", "Plüschtier", "Modellauto"],
  Sport: ["Laufschuh", "Yogamatte", "Hantel", "Fahrradhelm", "Rucksack"],
};
const BRANDS = ["Nordwind", "Alpina", "Tessa", "Kronberg", "Lumo", "Vela"];

function generateCatalog(rng, count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    const category = rng.pick(CATEGORIES);
    const noun = rng.pick(NOUNS[category]);
    const brand = rng.pick(BRANDS);
    const name = `${brand} ${rng.pick(ADJECTIVES)} ${noun}`;
    products.push({
      id: `P${String(i + 1).padStart(4, "0")}`,
      name,
      brand,
      category,
      priceCents: rng.int(3, 400) * 50 - 1,
      rating: Math.round((2.5 + rng.next() * 2.5) * 10) / 10,
      stock: rng.int(0, 40),
      tags: rng.sample(["neu", "bestseller", "sale", "öko", "premium", "limitiert"], rng.int(0, 2)),
    });
  }
  return products;
}

function generateUsers(rng, count) {
  const first = ["Anna", "Ben", "Clara", "David", "Eva", "Felix", "Greta", "Hannes", "Ida", "Jonas"];
  return Array.from({ length: count }, (_, i) => ({
    id: `U${i + 1}`,
    name: `${first[i % first.length]} ${String.fromCharCode(65 + (i % 26))}.`,
    premium: rng.next() < 0.3,
    favorites: new Set(rng.sample(CATEGORIES, 2)),
  }));
}

// =====================================================================
// 4. Katalog mit Indizes
// =====================================================================
const STOP_WORDS = new Set(["der", "die", "das", "und", "mit", "für"]);
const tokenize = (text) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

class Catalog {
  constructor(products) {
    this.byId = new Map();
    this.byCategory = new Map();
    this.byPrice = [];
    this.inverted = new Map();
    for (const p of products) this.add(p);
    this.byPrice.sort((a, b) => a.priceCents - b.priceCents || a.id.localeCompare(b.id));
  }
  add(product) {
    this.byId.set(product.id, product);
    if (!this.byCategory.has(product.category)) this.byCategory.set(product.category, []);
    this.byCategory.get(product.category).push(product);
    this.byPrice.push(product);
    const terms = new Set([...tokenize(product.name), ...tokenize(product.category), ...product.tags.map((t) => t.toLowerCase())]);
    for (const term of terms) {
      if (!this.inverted.has(term)) this.inverted.set(term, new Set());
      this.inverted.get(term).add(product.id);
    }
  }
  get size() {
    return this.byId.size;
  }
  /** Preisbereich über binäre Suche statt linearer Suche. */
  inPriceRange(minCents, maxCents) {
    const start = lowerBound(this.byPrice, minCents, (p) => p.priceCents);
    const end = lowerBound(this.byPrice, maxCents + 1, (p) => p.priceCents);
    metrics.inc("search.rangeScanned", end - start);
    return this.byPrice.slice(start, end);
  }
  /** Zum Vergleich: dieselbe Abfrage linear. */
  inPriceRangeLinear(minCents, maxCents) {
    metrics.inc("search.linearScanned", this.byPrice.length);
    return this.byPrice.filter((p) => p.priceCents >= minCents && p.priceCents <= maxCents);
  }
}

// =====================================================================
// 5. Suche mit Ranking (TF-IDF-ähnlich) und Facetten
// =====================================================================
class SearchEngine {
  constructor(catalog) {
    this.catalog = catalog;
    this.search = memoize((query, options) => this.#run(query, options), {
      name: "search",
      capacity: 8,
      key: (q, o) => `${q}|${JSON.stringify(o)}`,
    });
  }
  #idf(term) {
    const df = this.catalog.inverted.get(term)?.size ?? 0;
    return df === 0 ? 0 : Math.log(1 + this.catalog.size / df);
  }
  #run(query, { category = null, maxPrice = Infinity, inStockOnly = false, page = 1, pageSize = 5, sort = "relevance" } = {}) {
    metrics.inc("search.executed");
    const terms = tokenize(query);
    const scores = new Map();
    for (const term of terms) {
      // Präfixsuche: "kopf" findet "kopfhoerer"
      for (const [indexed, ids] of this.catalog.inverted) {
        metrics.inc("search.termsCompared");
        if (!indexed.startsWith(term)) continue;
        const weight = this.#idf(indexed) * (indexed === term ? 1 : 0.6);
        for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + weight);
      }
    }
    let hits = [...scores]
      .map(([id, score]) => ({ product: this.catalog.byId.get(id), score }))
      .filter(({ product }) => (!category || product.category === category) && product.priceCents <= maxPrice && (!inStockOnly || product.stock > 0))
      .map(({ product, score }) => ({ product, score: score * (0.8 + product.rating / 10) }));
    const facets = hits.reduce((acc, { product }) => ({ ...acc, [product.category]: (acc[product.category] ?? 0) + 1 }), {});
    const sorters = {
      relevance: (a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id),
      price: (a, b) => a.product.priceCents - b.product.priceCents || a.product.id.localeCompare(b.product.id),
      rating: (a, b) => b.product.rating - a.product.rating || a.product.id.localeCompare(b.product.id),
    };
    hits.sort(sorters[sort] ?? sorters.relevance);
    const total = hits.length;
    hits = hits.slice((page - 1) * pageSize, page * pageSize);
    return { total, pages: Math.ceil(total / pageSize), facets, hits: hits.map((h) => ({ id: h.product.id, name: h.product.name, price: h.product.priceCents, score: Math.round(h.score * 100) / 100 })) };
  }
}

// =====================================================================
// 6. Lager mit Reservierungen
// =====================================================================
class OutOfStock extends Error {
  constructor(id, wanted, available) {
    super(`${id}: ${wanted} gewünscht, ${available} verfügbar`);
    this.name = "OutOfStock";
    this.id = id;
  }
}

class Inventory {
  #reserved = new Map();
  constructor(catalog) {
    this.catalog = catalog;
  }
  available(id) {
    return this.catalog.byId.get(id).stock - (this.#reserved.get(id) ?? 0);
  }
  reserve(items) {
    // alles oder nichts
    for (const { id, qty } of items) {
      const available = this.available(id);
      if (available < qty) throw new OutOfStock(id, qty, available);
    }
    for (const { id, qty } of items) this.#reserved.set(id, (this.#reserved.get(id) ?? 0) + qty);
    return () => {
      for (const { id, qty } of items) this.#reserved.set(id, this.#reserved.get(id) - qty);
    };
  }
  commit(items) {
    for (const { id, qty } of items) {
      const product = this.catalog.byId.get(id);
      product.stock -= qty;
      this.#reserved.set(id, this.#reserved.get(id) - qty);
      if (product.stock <= 2) bus.emit("inventory.low", { id, stock: product.stock });
    }
  }
}

// =====================================================================
// 7. Warenkorb und Aktionen
// =====================================================================
const PROMOTIONS = [
  {
    code: "3FUER2",
    label: "3 für 2 bei Büchern",
    applies: (line) => line.product.category === "Bücher",
    discount: (lines) => {
      const unitPrices = lines.flatMap((l) => Array(l.qty).fill(l.product.priceCents)).sort((a, b) => a - b);
      return unitPrices.slice(0, Math.floor(unitPrices.length / 3)).reduce((s, p) => s + p, 0);
    },
  },
  {
    code: "SPORT10",
    label: "10 % auf Sport ab 2 Artikeln",
    applies: (line) => line.product.category === "Sport",
    discount: (lines) => {
      const count = lines.reduce((s, l) => s + l.qty, 0);
      return count >= 2 ? Math.round(lines.reduce((s, l) => s + l.qty * l.product.priceCents, 0) * 0.1) : 0;
    },
  },
  {
    code: "PREMIUM",
    label: "5 % für Premium-Kunden",
    applies: () => true,
    discount: (lines, cart) => (cart.user.premium ? Math.round(lines.reduce((s, l) => s + l.qty * l.product.priceCents, 0) * 0.05) : 0),
  },
];

class Cart {
  constructor(user, catalog) {
    this.user = user;
    this.catalog = catalog;
    this.lines = new Map();
  }
  add(id, qty = 1) {
    const product = this.catalog.byId.get(id);
    if (!product) throw new Error(`unbekannter Artikel ${id}`);
    const line = this.lines.get(id) ?? { product, qty: 0 };
    line.qty += qty;
    this.lines.set(id, line);
    return this;
  }
  remove(id, qty = Infinity) {
    const line = this.lines.get(id);
    if (!line) return this;
    line.qty -= Math.min(qty, line.qty);
    if (line.qty === 0) this.lines.delete(id);
    return this;
  }
  get itemCount() {
    let n = 0;
    for (const { qty } of this.lines.values()) n += qty;
    return n;
  }
  totals() {
    const lines = [...this.lines.values()];
    const subtotal = lines.reduce((s, l) => s + l.qty * l.product.priceCents, 0);
    const discounts = [];
    for (const promo of PROMOTIONS) {
      const matching = lines.filter(promo.applies);
      if (!matching.length) continue;
      const amount = promo.discount(matching, this);
      if (amount > 0) discounts.push({ code: promo.code, label: promo.label, amount });
    }
    const discount = discounts.reduce((s, d) => s + d.amount, 0);
    const heavy = lines.some((l) => ["Garten", "Küche"].includes(l.product.category) && l.product.priceCents > 10000);
    const shipping = subtotal - discount >= 5000 ? 0 : heavy ? 1490 : 495;
    return { subtotal, discounts, discount, shipping, total: subtotal - discount + shipping };
  }
}

// =====================================================================
// 8. Checkout, Bestellhistorie, Empfehlungen
// =====================================================================
class OrderService {
  #nextId = 5001;
  constructor(inventory) {
    this.inventory = inventory;
    this.orders = [];
    this.coPurchases = new Map();
  }
  checkout(cart, { paymentFails = false } = {}) {
    const items = [...cart.lines.values()].map((l) => ({ id: l.product.id, qty: l.qty }));
    if (!items.length) return { ok: false, reason: "leerer Warenkorb" };
    let release;
    try {
      release = this.inventory.reserve(items);
    } catch (e) {
      bus.emit("order.rejected", { user: cart.user.id, reason: e.name });
      return { ok: false, reason: e.message };
    }
    const totals = cart.totals();
    if (paymentFails) {
      release();
      bus.emit("order.failed", { user: cart.user.id, reason: "Zahlung abgelehnt" });
      return { ok: false, reason: "Zahlung abgelehnt" };
    }
    this.inventory.commit(items);
    const order = { id: `B${this.#nextId++}`, user: cart.user.id, items, total: totals.total, discount: totals.discount };
    this.orders.push(order);
    this.#recordCoPurchases(items.map((i) => i.id));
    bus.emit("order.placed", order);
    cart.lines.clear();
    return { ok: true, order, totals };
  }
  #recordCoPurchases(ids) {
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        if (!this.coPurchases.has(a)) this.coPurchases.set(a, new Map());
        const m = this.coPurchases.get(a);
        m.set(b, (m.get(b) ?? 0) + 1);
      }
    }
  }
  /** "Kunden kauften auch": Nachbarn im Co-Purchase-Graphen, zwei Ebenen tief. */
  recommend(id, k = 3) {
    const scores = new Map();
    for (const [b, w] of this.coPurchases.get(id) ?? []) {
      scores.set(b, (scores.get(b) ?? 0) + w * 2);
      for (const [c, w2] of this.coPurchases.get(b) ?? []) {
        if (c !== id) scores.set(c, (scores.get(c) ?? 0) + w2);
      }
    }
    return topK(
      [...scores].map(([pid, score]) => ({ id: pid, score })),
      k,
      (e) => e.score,
    ).map((e) => `${e.id}(${e.score})`);
  }
}

// =====================================================================
// 9. Rate-Limiter und Warteschlange mit simulierter Uhr
// =====================================================================
class SimClock {
  #now = 0;
  #timers = [];
  #seq = 0;
  get now() {
    return this.#now;
  }
  setTimeout(fn, ms) {
    this.#timers.push({ at: this.#now + ms, fn, seq: this.#seq++ });
  }
  sleep(ms) {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }
  async runAll() {
    while (this.#timers.length) {
      this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = this.#timers.shift();
      this.#now = t.at;
      t.fn();
      // Mikrotasks (then-Ketten) laufen lassen, bevor der nächste Timer feuert
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  }
}

/** Token-Bucket: `rate` Anfragen pro Sekunde, Burst bis `capacity`. */
class TokenBucket {
  constructor(clock, capacity, ratePerSecond) {
    this.clock = clock;
    this.capacity = capacity;
    this.rate = ratePerSecond;
    this.tokens = capacity;
    this.last = clock.now;
  }
  tryTake() {
    const elapsed = this.clock.now - this.last;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rate);
    this.last = this.clock.now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Warteschlange, die höchstens `concurrency` Anfragen gleichzeitig bearbeitet. */
class RequestQueue {
  constructor(clock, concurrency, limiter) {
    this.clock = clock;
    this.concurrency = concurrency;
    this.limiter = limiter;
    this.active = 0;
    this.peak = 0;
    this.pending = [];
    this.log = [];
  }
  submit(name, durationMs) {
    return new Promise((resolve) => {
      this.pending.push({ name, durationMs, resolve, submitted: this.clock.now });
      this.#pump();
    });
  }
  #pump() {
    while (this.active < this.concurrency && this.pending.length) {
      if (!this.limiter.tryTake()) {
        metrics.inc("queue.throttled");
        this.clock.setTimeout(() => this.#pump(), 100);
        return;
      }
      const job = this.pending.shift();
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      const started = this.clock.now;
      this.clock.setTimeout(() => {
        this.active--;
        this.log.push(`${job.name}:${job.submitted}→${started}→${this.clock.now}`);
        job.resolve(this.clock.now - job.submitted);
        this.#pump();
      }, job.durationMs);
    }
  }
}

/** Debounce auf der simulierten Uhr: nur der letzte Aufruf innerhalb der Wartezeit zählt. */
function debounce(clock, fn, waitMs) {
  let generation = 0;
  return (...args) => {
    const mine = ++generation;
    metrics.inc("debounce.calls");
    clock.setTimeout(() => {
      if (mine === generation) {
        metrics.inc("debounce.fired");
        fn(...args);
      }
    }, waitMs);
  };
}

// =====================================================================
// 10. Analytics
// =====================================================================
function analytics(orders, catalog, users) {
  const revenueByCategory = {};
  const unitsByProduct = new Map();
  for (const order of orders) {
    for (const { id, qty } of order.items) {
      const p = catalog.byId.get(id);
      revenueByCategory[p.category] = (revenueByCategory[p.category] ?? 0) + qty * p.priceCents;
      unitsByProduct.set(id, (unitsByProduct.get(id) ?? 0) + qty);
    }
  }
  const byUser = Object.groupBy
    ? Object.groupBy(orders, (o) => o.user)
    : orders.reduce((acc, o) => ((acc[o.user] ??= []).push(o), acc), {});
  const bestCustomer = Object.entries(byUser)
    .map(([user, list]) => ({ user, total: list.reduce((s, o) => s + o.total, 0), count: list.length }))
    .sort((a, b) => b.total - a.total || a.user.localeCompare(b.user))[0];
  const topProducts = topK(
    [...unitsByProduct].map(([id, units]) => ({ id, units })),
    3,
    (e) => e.units,
  );
  const avg = orders.length ? orders.reduce((s, o) => s + o.total, 0) / orders.length : 0;
  const premiumShare = users.filter((u) => u.premium).length / users.length;
  return { revenueByCategory, bestCustomer, topProducts, avg, premiumShare };
}

// =====================================================================
// 11. Hauptprogramm
// =====================================================================
async function main() {
  const out = (...parts) => console.log(parts.join(" "));
  const section = (title) => console.log(`\n== ${title} ==`);

  const rng = new SeededRandom(20260923);
  const catalog = new Catalog(generateCatalog(rng, 600));
  const users = generateUsers(rng, 12);
  const inventory = new Inventory(catalog);
  const orders = new OrderService(inventory);
  const search = new SearchEngine(catalog);

  const lowStock = [];
  const orderLog = [];
  bus.on("inventory.low", ({ id, stock }) => lowStock.push(`${id}:${stock}`));
  const stopOrderLog = bus.on("order.*", (payload, event) => orderLog.push(`${event.split(".")[1]}:${payload.user}`));

  section("Katalog");
  out("Produkte:", catalog.size, "| Kategorien:", catalog.byCategory.size, "| Suchbegriffe im Index:", catalog.inverted.size);
  out("Pro Kategorie:", [...catalog.byCategory].map(([c, list]) => `${c}=${list.length}`).join(" "));
  out("Günstigstes:", catalog.byPrice[0].name, euro(catalog.byPrice[0].priceCents), "| Teuerstes:", catalog.byPrice.at(-1).name, euro(catalog.byPrice.at(-1).priceCents));

  section("Preisbereich: binäre Suche vs. linear");
  const fast = catalog.inPriceRange(2000, 3000);
  const slow = catalog.inPriceRangeLinear(2000, 3000);
  out("Treffer:", fast.length, "gleich:", fast.length === slow.length && fast.every((p, i) => p === slow[i]));
  out("Binärsuche-Schritte:", metrics.get("search.binarySteps"), "+ gelesen:", metrics.get("search.rangeScanned"), "| linear gelesen:", metrics.get("search.linearScanned"));

  section("Suche");
  const queries = [
    ["kopfhörer", {}],
    ["nachhaltig roman", { sort: "price" }],
    ["kopf", { inStockOnly: true, pageSize: 3 }],
    ["garten", { maxPrice: 5000, sort: "rating", page: 2, pageSize: 3 }],
    ["kopfhörer", {}], // Cache-Treffer
    ["nachhaltig roman", { sort: "price" }], // Cache-Treffer
  ];
  for (const [q, opts] of queries) {
    const r = search.search(q, opts);
    const facetText = Object.entries(r.facets).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(",");
    out(`"${q}"`, `${r.total} Treffer/${r.pages} Seiten`, `[${facetText}]`, "→", r.hits.map((h) => `${h.id}(${h.score})`).join(" ") || "-");
  }
  out("Suchcache:", JSON.stringify(metrics.snapshot("cache.search")), "| ausgeführt:", metrics.get("search.executed"), "| Begriffe verglichen:", metrics.get("search.termsCompared"));

  section("Warenkörbe und Checkout");
  const pickIds = (category, n, offset = 0) => catalog.byCategory.get(category).filter((p) => p.stock >= 3).slice(offset, offset + n).map((p) => p.id);
  const scenarios = [
    { user: users[0], items: [...pickIds("Bücher", 3).map((id) => [id, 1])] },
    { user: users[1], items: [[pickIds("Sport", 1)[0], 2], [pickIds("Elektronik", 1)[0], 1]] },
    { user: users[2], items: [[pickIds("Küche", 1)[0], 1]], paymentFails: true },
    { user: users[3], items: [[pickIds("Garten", 1)[0], 999]] },
    { user: users[4], items: [[pickIds("Bücher", 1)[0], 2], [pickIds("Sport", 1, 1)[0], 1], [pickIds("Spielzeug", 1)[0], 1]] },
    { user: users[5], items: [] },
  ];
  for (const { user, items, paymentFails } of scenarios) {
    const cart = new Cart(user, catalog);
    for (const [id, qty] of items) cart.add(id, qty);
    if (user === users[4]) cart.add(items[0][0], 1).remove(items[0][0], 2); // hin und her
    const before = cart.totals();
    const result = orders.checkout(cart, { paymentFails });
    const promo = before.discounts.map((d) => `${d.code}-${euro(d.amount)}`).join(",") || "keine";
    out(
      user.name.padEnd(9),
      result.ok ? `✓ ${result.order.id}` : "✗",
      `Summe ${euro(before.subtotal)}`,
      `Rabatt ${promo}`,
      `Versand ${euro(before.shipping)}`,
      result.ok ? `= ${euro(result.totals.total)}` : `(${result.reason})`,
    );
  }

  // viele weitere Bestellungen für Analytics und Empfehlungen
  const allIds = [...catalog.byId.keys()];
  const popular = rng.sample(allIds, 15);
  for (let i = 0; i < 80; i++) {
    const cart = new Cart(users[i % users.length], catalog);
    const count = rng.int(1, 4);
    for (const id of rng.sample(popular, count)) if (inventory.available(id) > 0) cart.add(id, 1);
    orders.checkout(cart);
  }
  stopOrderLog();
  out("Bestellungen gesamt:", orders.orders.length, "| Ereignisse im Log:", orderLog.length, "| niedriger Bestand gemeldet:", lowStock.length);
  const counts = orderLog.reduce((acc, e) => ((acc[e.split(":")[0]] = (acc[e.split(":")[0]] ?? 0) + 1), acc), {});
  out("Log nach Typ:", JSON.stringify(counts));

  section("Empfehlungen (Co-Purchase-Graph)");
  const [topSeller] = topK(
    popular.map((id) => ({ id, deg: orders.coPurchases.get(id)?.size ?? 0 })),
    1,
    (e) => e.deg,
  );
  out("Knoten:", orders.coPurchases.size, "| Produkt mit den meisten Verbindungen:", topSeller.id, `(${topSeller.deg})`);
  out("Kunden kauften auch:", orders.recommend(topSeller.id, 4).join(" "));

  section("Analytics");
  const a = analytics(orders.orders, catalog, users);
  out("Umsatz je Kategorie:", Object.entries(a.revenueByCategory).sort(([x], [y]) => x.localeCompare(y)).map(([c, v]) => `${c} ${euro(v)}`).join(" | "));
  out("Bester Kunde:", a.bestCustomer.user, euro(a.bestCustomer.total), `(${a.bestCustomer.count} Bestellungen)`);
  out("Top-Produkte:", a.topProducts.map((p) => `${p.id}×${p.units}`).join(" "), "| Heap-Vergleiche:", metrics.get("heap.compare"));
  out("Ø Bestellwert:", euro(a.avg), "| Premium-Anteil:", `${Math.round(a.premiumShare * 100)} %`);

  section("Rate-Limiter, Warteschlange, Debounce (simulierte Zeit)");
  const clock = new SimClock();
  const queue = new RequestQueue(clock, 3, new TokenBucket(clock, 4, 5));
  const waits = [];
  const jobs = ["suche", "warenkorb", "checkout", "profil", "empfehlung", "bewertung", "suche2", "liste"].map((name, i) =>
    queue.submit(name, 150 + (i % 3) * 100).then((wait) => waits.push(`${name}=${wait}ms`)),
  );
  const typed = [];
  const onType = debounce(clock, (text) => typed.push(text), 250);
  ["k", "ko", "kop", "kopf"].forEach((t, i) => clock.setTimeout(() => onType(t), i * 80));
  clock.setTimeout(() => onType("kopfh"), 900);
  const runner = clock.runAll();
  await Promise.all(jobs);
  await runner;
  out("Wartezeiten:", waits.join(" "));
  out("Parallel max:", queue.peak, "| gedrosselt:", metrics.get("queue.throttled"), "| fertig bei:", `${clock.now}ms`);
  out("Debounce:", `${metrics.get("debounce.calls")} Aufrufe → ${metrics.get("debounce.fired")} ausgeführt`, JSON.stringify(typed));

  section("Performance-Zähler");
  const cacheStats = metrics.snapshot("cache.");
  for (const [k, v] of Object.entries(cacheStats)) out(k.padEnd(28), v);
  out("bus.events".padEnd(28), metrics.get("bus.events"), "| bus.deliveries", metrics.get("bus.deliveries"));
  const invalidated = search.search.cache.invalidate((key) => key.startsWith("kopf"));
  out("Cache invalidiert:", invalidated, "Einträge | danach noch:", search.search.cache.map.size);
}

main().catch((e) => {
  console.error("Fehler:", e);
  process.exitCode = 1;
});
