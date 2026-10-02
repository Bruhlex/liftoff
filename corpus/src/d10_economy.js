'use strict';
// d10: economic simulation with agents, auctions, BigInt accounting

// ---------- deterministic PRNG ----------
function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  return {
    next,
    int(lo, hi) { return lo + (next() % (hi - lo + 1)); },
    pick(arr) { return arr[next() % arr.length]; },
    chance(pct) { return next() % 100 < pct; },
  };
}
const RNG = makeRng(0xC0FFEE);

// ---------- money formatting via tagged templates ----------
const SCALE = 10000n; // 4 decimal places
function toMinor(str) {
  const m = /^(?<sign>-)?(?<int>\d+)(?:\.(?<frac>\d{1,4}))?$/u.exec(String(str));
  if (!m) throw new SyntaxError('bad amount: ' + str);
  const { sign = '', int, frac = '' } = m.groups;
  const v = BigInt(int) * SCALE + BigInt((frac + '0000').slice(0, 4));
  return sign ? -v : v;
}
function fmtMinor(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / SCALE, f = a % SCALE;
  const is = i.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + is + '.' + f.toString().padStart(4, '0');
}
function money(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    out += (typeof v === 'bigint' ? '$' + fmtMinor(v) : String(v)) + strings[i + 1];
  }
  return out;
}
function rawTag(strings, ...vals) {
  return String.raw({ raw: strings.raw.map(s => s.toUpperCase()) }, ...vals.map(v => `<${v}>`));
}

console.log(money`seed amount ${toMinor('1234567.5')} and ${toMinor('-0.0001')}`);
console.log(rawTag`ticker\t${'ACME'}\nqty ${42}`);

// ---------- ledger with double-entry and Proxy audit ----------
class LedgerError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
  get [Symbol.toStringTag]() { return 'LedgerError'; }
}

class Ledger {
  #accounts = new Map();
  #journal = [];
  #seq = 0;
  static #instances = 0;
  static EPS;
  static {
    Ledger.EPS = 0n;
    Ledger.kinds = Object.freeze(['asset', 'liability', 'equity', 'revenue', 'expense']);
  }
  constructor(name) {
    this.name = name;
    Ledger.#instances++;
  }
  static get instances() { return Ledger.#instances; }
  open(id, kind = 'asset', initial = 0n) {
    if (this.#accounts.has(id)) throw new LedgerError('dup ' + id, 'EDUP');
    if (!Ledger.kinds.includes(kind)) throw new LedgerError('kind ' + kind, 'EKIND');
    this.#accounts.set(id, { id, kind, bal: 0n });
    if (initial) this.post('genesis', [[id, initial], ['equity:genesis', -initial]]);
    return this;
  }
  #ensure(id) {
    if (!this.#accounts.has(id)) {
      const kind = id.split(':')[0];
      this.#accounts.set(id, { id, kind: Ledger.kinds.includes(kind) ? kind : 'asset', bal: 0n });
    }
    return this.#accounts.get(id);
  }
  post(memo, legs) {
    let sum = 0n;
    for (const [, amt] of legs) sum += amt;
    if (sum !== Ledger.EPS) throw new LedgerError(`unbalanced ${memo}: ${sum}`, 'EBAL');
    const entry = { seq: ++this.#seq, memo, legs: legs.map(([a, v]) => [a, v]) };
    for (const [a, v] of legs) this.#ensure(a).bal += v;
    this.#journal.push(entry);
    return entry.seq;
  }
  balance(id) { return this.#accounts.get(id)?.bal ?? 0n; }
  has(id) { return this.#accounts.has(id); }
  get size() { return this.#journal.length; }
  *entries(filter = () => true) {
    for (const e of this.#journal) if (filter(e)) yield e;
  }
  trialBalance() {
    let total = 0n;
    const byKind = {};
    for (const { kind, bal } of this.#accounts.values()) {
      byKind[kind] = (byKind[kind] ?? 0n) + bal;
      total += bal;
    }
    return { total, byKind };
  }
  static isLedger(x) { return x != null && typeof x === 'object' && #journal in x; }
}

function audited(ledger, log) {
  return new Proxy(ledger, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, target);
      if (typeof v === 'function' && prop === 'post') {
        return function (memo, legs) {
          log.push(`post:${memo}:${legs.length}`);
          return v.call(target, memo, legs);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      log.push('has:' + String(prop));
      return Reflect.has(target, prop);
    },
  });
}

const auditLog = [];
const L = audited(new Ledger('main'), auditLog);
L.open('asset:cash:bank', 'asset', toMinor('1000000'));
console.log('ledger instances', Ledger.instances, 'isLedger(proxy)', Ledger.isLedger(new Ledger('x')), 'name' in L);
console.log('audit', JSON.stringify(auditLog));

// ---------- goods & agents ----------
const GOODS = ['wheat', 'iron', 'cloth', 'spice'];
const BASE_PRICE = { wheat: '12.5', iron: '40', cloth: '22.25', spice: '95.1' };

class Agent {
  static #nextId = 1;
  #id;
  #inventory = new Map();
  constructor(name, cash) {
    if (new.target === Agent) throw new TypeError('Agent is abstract');
    this.#id = Agent.#nextId++;
    this.name = name;
    this.kind = new.target.KIND ?? 'agent';
    L.open(this.cashAcct, 'asset');
    L.post('fund:' + name, [[this.cashAcct, cash], ['asset:cash:bank', -cash]]);
  }
  get id() { return this.#id; }
  get cashAcct() { return `asset:cash:${this.name}`; }
  get cash() { return L.balance(this.cashAcct); }
  qty(g) { return this.#inventory.get(g) ?? 0; }
  addGoods(g, q) {
    const n = this.qty(g) + q;
    if (n < 0) throw new RangeError(`${this.name} short ${g}`);
    n === 0 ? this.#inventory.delete(g) : this.#inventory.set(g, n);
  }
  valuation(g) { return toMinor(BASE_PRICE[g]); }
  bidFor(g) { return null; }
  askFor(g) { return null; }
  describe() {
    const inv = [...this.#inventory].sort(([a], [b]) => a < b ? -1 : 1).map(([g, q]) => `${g}=${q}`).join(',');
    return `${this.kind}#${this.#id}(${this.name}) cash=${fmtMinor(this.cash)} [${inv}]`;
  }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return Number(this.cash / SCALE);
    return this.describe();
  }
  static [Symbol.hasInstance](x) {
    return Function.prototype[Symbol.hasInstance].call(this, x) || (x && x.__duckAgent === true);
  }
}

class Producer extends Agent {
  static KIND = 'producer';
  constructor(name, cash, good, rate) {
    super(name, cash);
    this.good = good;
    this.rate = rate;
    this.produced = 0;
  }
  produce(tick) {
    const q = this.rate + (tick % 3 === 0 ? 1 : 0);
    this.addGoods(this.good, q);
    this.produced += q;
    return q;
  }
  askFor(g) {
    if (g !== this.good || this.qty(g) === 0) return null;
    const v = this.valuation(g);
    return { price: v - v / 10n, qty: Math.min(this.qty(g), 3) };
  }
}

class Trader extends Agent {
  static KIND = 'trader';
  #margin;
  constructor(name, cash, margin = 5n) {
    super(name, cash);
    this.#margin = margin;
  }
  get margin() { return this.#margin; }
  set margin(v) { this.#margin = v < 0n ? 0n : v > 50n ? 50n : v; }
  bidFor(g) {
    const v = this.valuation(g);
    const price = v - (v * this.#margin) / 100n;
    return price <= this.cash ? { price, qty: 2 } : null;
  }
  askFor(g) {
    if (!this.qty(g)) return null;
    const v = this.valuation(g);
    return { price: v + (v * this.#margin) / 100n, qty: this.qty(g) };
  }
}

class Speculator extends Trader {
  static KIND = 'speculator';
  #history = [];
  observe(price) { this.#history.push(price); if (this.#history.length > 4) this.#history.shift(); }
  #trend() {
    const h = this.#history;
    if (h.length < 2) return 0;
    return h[h.length - 1] > h[0] ? 1 : h[h.length - 1] < h[0] ? -1 : 0;
  }
  bidFor(g) {
    const base = super.bidFor(g);
    if (!base) return null;
    switch (this.#trend()) {
      case 1: base.price += base.price / 20n; // fallthrough intended
      case 0: base.qty += 1; break;
      default: return null;
    }
    return base;
  }
}

class Hoarder extends Speculator {
  static KIND = 'hoarder';
  askFor(g) {
    const a = super.askFor(g);
    return a && this.qty(g) > 4 ? { ...a, qty: this.qty(g) - 4 } : null;
  }
  describe() { return 'H:' + super.describe(); }
}

try { new Agent('bad', 0n); } catch (e) { console.log('abstract:', e.constructor === TypeError, e.message); }

const agents = [
  new Producer('farm', toMinor('500'), 'wheat', 4),
  new Producer('mine', toMinor('800'), 'iron', 2),
  new Producer('mill', toMinor('600'), 'cloth', 3),
  new Producer('port', toMinor('900'), 'spice', 1),
  new Trader('tina', toMinor('2000'), 8n),
  new Trader('tom', toMinor('1500'), 3n),
  new Speculator('sam', toMinor('3000'), 6n),
  new Hoarder('hal', toMinor('2500'), 4n),
];
console.log('duck instanceof', ({ __duckAgent: true }) instanceof Agent, agents[7] instanceof Trader, agents[0] instanceof Trader);
for (const a of agents) console.log(' ', `${a}`, +a);

// ---------- auctions ----------
function* englishAuction(item, reserve, bidders, step) {
  let price = reserve, leader = null, round = 0;
  outer: while (true) {
    round++;
    let raised = false;
    for (const b of bidders) {
      if (b === leader) continue;
      const cap = b.valuation(item) + BigInt(b.id) * step;
      if (cap >= price + step && b.cash >= price + step) {
        price += step;
        leader = b;
        raised = true;
        const cmd = yield { round, price, leader: b.name };
        if (cmd === 'halt') break outer;
      }
    }
    if (!raised || round > 50) break;
  }
  return leader ? { winner: leader, price } : null;
}

function dutchAuction(item, start, floor, decrement, bidders) {
  let p = start;
  let tries = 0;
  do {
    tries++;
    const taker = bidders.find(b => b.valuation(item) >= p && b.cash >= p);
    if (taker) return { winner: taker, price: p, tries };
    p -= decrement;
    if (p % 7n === 0n) continue;
  } while (p >= floor);
  return { winner: null, price: floor, tries };
}

function vickrey(item, bidders) {
  const bids = bidders
    .map(b => ({ b, v: b.valuation(item) + BigInt((b.id * 37) % 11) * 1000n }))
    .filter(({ b, v }) => b.cash >= v)
    .sort((x, y) => (y.v > x.v ? 1 : y.v < x.v ? -1 : x.b.id - y.b.id));
  if (bids.length === 0) return null;
  const [{ b: winner }, second = { v: 0n }] = bids;
  return { winner, price: second.v, n: bids.length };
}

function settle(winner, seller, item, qty, unit, memo) {
  const total = unit * BigInt(qty);
  try {
    if (winner.cash < total) throw new LedgerError('insufficient', 'EFUNDS');
    seller.addGoods(item, -qty);
    winner.addGoods(item, qty);
    L.post(memo, [[winner.cashAcct, -total], [seller.cashAcct, total]]);
    return true;
  } catch (e) {
    if (e instanceof RangeError) return false;
    if (e.code === 'EFUNDS') return false;
    throw e;
  } finally {
    settle.calls = (settle.calls || 0) + 1;
  }
}

agents.slice(0, 4).forEach((p, i) => { for (let t = 0; t <= i; t++) p.produce(t); });

{
  const buyers = agents.slice(4);
  const gen = englishAuction('spice', toMinor('80'), buyers, toMinor('2.5'));
  let r, steps = 0;
  while (!(r = gen.next(steps > 30 ? 'halt' : undefined)).done) {
    steps++;
    if (steps <= 3 || steps % 5 === 0) console.log('  english', r.value.round, fmtMinor(r.value.price), r.value.leader);
  }
  const res = r.value;
  console.log('english result', res && res.winner.name, res && fmtMinor(res.price), 'steps', steps);
  if (res) console.log('settled', settle(res.winner, agents[3], 'spice', 1, res.price, 'english:spice'));

  const d = dutchAuction('iron', toMinor('60'), toMinor('20'), toMinor('3.5'), buyers);
  console.log('dutch', d.winner?.name ?? 'none', fmtMinor(d.price), d.tries);
  if (d.winner) console.log('settled', settle(d.winner, agents[1], 'iron', 1, d.price, 'dutch:iron'));

  const v = vickrey('wheat', buyers);
  console.log('vickrey', v?.winner.name, fmtMinor(v?.price ?? 0n), v?.n);
  if (v) console.log('settled', settle(v.winner, agents[0], 'wheat', 2, v.price, 'vickrey:wheat'));
  console.log('settle calls', settle.calls);
}

// ---------- continuous double auction order book ----------
class OrderBook {
  #bids = []; #asks = [];
  #trades = [];
  constructor(good) { this.good = good; }
  static #cmp(side) {
    return side === 'bid'
      ? (a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : a.seq - b.seq)
      : (a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : a.seq - b.seq);
  }
  submit(order) {
    const book = order.side === 'bid' ? this.#bids : this.#asks;
    book.push(order);
    book.sort(OrderBook.#cmp(order.side));
    return this.#match();
  }
  #match() {
    let n = 0;
    match: for (;;) {
      const [bid] = this.#bids, [ask] = this.#asks;
      if (!bid || !ask || bid.price < ask.price) break match;
      if (bid.agent === ask.agent) { this.#asks.shift(); continue match; }
      const q = Math.min(bid.qty, ask.qty);
      const price = bid.seq < ask.seq ? bid.price : ask.price;
      const ok = settle(bid.agent, ask.agent, this.good, q, price, `cda:${this.good}`);
      if (!ok) { (bid.agent.cash < price ? this.#bids : this.#asks).shift(); continue; }
      this.#trades.push({ q, price, b: bid.agent.name, s: ask.agent.name });
      n++;
      (bid.qty -= q) || this.#bids.shift();
      (ask.qty -= q) || this.#asks.shift();
    }
    return n;
  }
  get trades() { return this.#trades.slice(); }
  get spread() {
    const b = this.#bids[0]?.price, a = this.#asks[0]?.price;
    return b !== undefined && a !== undefined ? a - b : null;
  }
  get depth() { return [this.#bids.length, this.#asks.length]; }
}

const books = Object.fromEntries(GOODS.map(g => [g, new OrderBook(g)]));
let orderSeq = 0;

const ORDER_RE = /^(?<side>BUY|SELL)\s+(?<qty>\d+)\s+(?<good>[a-z]+)\s*@\s*(?<px>\d+(?:\.\d{1,4})?)(?:\s+by\s+(?<who>\w+))?$/i;
function parseOrder(line, byName) {
  const m = ORDER_RE.exec(line.trim());
  if (!m) return { error: 'syntax', line };
  const { side, qty, good, px, who = 'tina' } = m.groups;
  const agent = byName.get(who);
  if (!agent) return { error: 'unknown agent ' + who };
  if (!(good in books)) return { error: 'unknown good ' + good };
  return { side: side.toUpperCase() === 'BUY' ? 'bid' : 'ask', qty: +qty, good, price: toMinor(px), agent, seq: ++orderSeq };
}

const byName = new Map(agents.map(a => [a.name, a]));
const script = [
  'SELL 3 wheat @ 11 by farm',
  'BUY 2 wheat @ 12.25 by tom',
  'buy 1 wheat @ 10 by sam',
  'SELL 2 iron @ 38.5 by mine',
  'BUY 5 iron @ 39 by hal',
  'BUY 1 gold @ 3 by tom',
  'SELL 1 cloth @ nope',
  'SELL 2 cloth @ 20 by mill',
  'BUY 2 cloth @ 21 by ghost',
  'BUY 2 cloth @ 21 by tina',
];
for (const line of script) {
  const o = parseOrder(line, byName);
  if (o.error) { console.log('  reject', JSON.stringify(o.error)); continue; }
  const n = books[o.good].submit(o);
  console.log('  order', o.side, o.qty, o.good, fmtMinor(o.price), o.agent.name, '-> trades', n);
}
for (const [g, b] of Object.entries(books)) {
  const sp = b.spread;
  console.log('book', g, 'depth', b.depth.join('/'), 'spread', sp === null ? '-' : fmtMinor(sp), 'trades', b.trades.length);
}

// ---------- simulation ticks with generators ----------
function* tickSource(n) {
  for (let t = 1; t <= n; t++) {
    const shock = t % 4 === 0 ? RNG.pick(GOODS) : null;
    const res = yield { t, shock };
    if (res === 'skip') t++;
  }
  return n;
}

function* phases(t) {
  yield 'produce';
  yield* ['quote', 'match'];
  if (t % 2) yield 'tax';
  return yield* (function* () { yield 'report'; return 'done:' + t; })();
}

const priceIndex = new Map(GOODS.map(g => [g, [toMinor(BASE_PRICE[g])]]));
const taxRate = 2n; // percent

function runTick({ t, shock }) {
  const log = [];
  let phaseResult;
  const ph = phases(t);
  for (let step = ph.next(); ; step = ph.next()) {
    if (step.done) { phaseResult = step.value; break; }
    const phase = step.value;
    switch (phase) {
      case 'produce':
        for (const a of agents) if (a instanceof Producer) a.produce(t);
        break;
      case 'quote': {
        agentLoop: for (const a of agents) {
          for (const g of GOODS) {
            const ask = a.askFor(g);
            if (ask && ask.qty > 0) books[g].submit({ side: 'ask', qty: ask.qty, good: g, price: ask.price, agent: a, seq: ++orderSeq });
            const bid = a.bidFor(g);
            if (bid == null) continue;
            if (bid.price > a.cash / 2n) continue agentLoop;
            books[g].submit({ side: 'bid', qty: bid.qty, good: g, price: bid.price, agent: a, seq: ++orderSeq });
          }
        }
        break;
      }
      case 'match':
        for (const g of GOODS) {
          const tr = books[g].trades;
          const last = tr[tr.length - 1];
          const series = priceIndex.get(g);
          let px = last ? last.price : series[series.length - 1];
          if (shock === g) px += px / 5n;
          series.push(px);
          for (const a of agents) if (a instanceof Speculator) a.observe(px);
        }
        break;
      case 'tax': {
        let collected = 0n;
        for (const a of agents) {
          const due = (a.cash * taxRate) / 1000n;
          if (due <= 0n) continue;
          L.post(`tax:${t}:${a.name}`, [[a.cashAcct, -due], ['revenue:tax', due]]);
          collected += due;
        }
        log.push('tax=' + fmtMinor(collected));
        break;
      }
      default:
        log.push(phase);
    }
  }
  return { phaseResult, log };
}

{
  const src = tickSource(10);
  let item = src.next();
  let ticks = 0;
  while (!item.done) {
    const { phaseResult, log } = runTick(item.value);
    ticks++;
    console.log(`tick ${item.value.t} shock=${item.value.shock ?? '-'} ${phaseResult} ${log.join(' ')}`);
    item = src.next(item.value.t === 5 ? 'skip' : undefined);
  }
  console.log('ticks run', ticks, 'return', item.value);
}

for (const [g, series] of priceIndex) {
  const last = series[series.length - 1];
  const max = series.reduce((m, x) => (x > m ? x : m), series[0]);
  const min = series.reduce((m, x) => (x < m ? x : m), series[0]);
  console.log('price', g.padEnd(6), 'n', series.length, 'last', fmtMinor(last), 'range', fmtMinor(min), '..', fmtMinor(max));
}
for (const a of agents) console.log(' ', String(a));

// ---------- BigInt interest, amortization ----------
function powBig(b, e) {
  let r = 1n;
  while (e > 0n) { if (e & 1n) r *= b; b *= b; e >>= 1n; }
  return r;
}
function compound(principal, ratePpm, periods) {
  const D = 1000000n;
  return (principal * powBig(D + ratePpm, periods)) / powBig(D, periods);
}
function amortize(principal, ratePpm, n) {
  const D = 1000000n;
  const f = powBig(D + ratePpm, n);
  const pay = (principal * ratePpm * f) / (D * (f - powBig(D, n)));
  const rows = [];
  let bal = principal;
  for (let k = 1n; k <= n; k++) {
    const interest = (bal * ratePpm) / D;
    let princ = pay - interest;
    if (k === n) princ = bal;
    bal -= princ;
    rows.push({ k, interest, princ, bal });
  }
  return { pay, rows };
}
console.log('compound', fmtMinor(compound(toMinor('1000'), 50000n, 10n)));
console.log('compound big', compound(10n ** 30n, 123456n, 64n).toString().length);
{
  const { pay, rows } = amortize(toMinor('10000'), 10000n, 12n);
  console.log('payment', fmtMinor(pay));
  for (const { k, interest, princ, bal } of rows.filter((_, i) => i % 3 === 0 || i === rows.length - 1))
    console.log(`  #${k} int=${fmtMinor(interest)} prin=${fmtMinor(princ)} bal=${fmtMinor(bal)}`);
  const sumInt = rows.reduce((s, { interest }) => s + interest, 0n);
  console.log('total interest', fmtMinor(sumInt));
}

// ---------- mutual recursion: credit chain / default cascade ----------
const debts = new Map();
function lend(from, to, amt) {
  const k = `${from}->${to}`;
  debts.set(k, (debts.get(k) ?? 0n) + amt);
}
for (let i = 0; i < 3000; i++) lend('n' + i, 'n' + (i + 1), BigInt(1000 + (i % 17)));
function exposureOf(node, depth) {
  if (depth === 0) return 0n;
  const nx = 'n' + (+node.slice(1) + 1);
  const d = debts.get(`${node}->${nx}`);
  return d === undefined ? 0n : d + haircut(nx, depth - 1);
}
function haircut(node, depth) {
  return depth % 2 === 0 ? exposureOf(node, depth) : (exposureOf(node, depth) * 9n) / 10n;
}
console.log('exposure chain', exposureOf('n0', 2900).toString());

// ---------- arguments object in sloppy helper (via Function-free trick) ----------
const sloppy = (function () {
  return function sumArgs() {
    var total = 0n;
    for (var i = 0; i < arguments.length; i++) total += BigInt(arguments[i]);
    return [arguments.length, total];
  };
})();
console.log('sumArgs', JSON.stringify(sloppy(1, 2, 3, '4').map(String)));

// ---------- JSON export with replacer/reviver ----------
const snapshot = {
  agents: agents.map(a => ({ name: a.name, kind: a.kind, cash: a.cash })),
  tb: L.trialBalance(),
  journalSize: L.size,
};
const json = JSON.stringify(snapshot, (k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v));
console.log('json length', json.length);
const back = JSON.parse(json, (k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v));
console.log('roundtrip total', back.tb.total === snapshot.tb.total, typeof back.agents[0].cash);
console.log('trial kinds', Object.keys(back.tb.byKind).sort().join(','));
for (const [k, v] of Object.entries(back.tb.byKind).sort()) console.log('  ', k, fmtMinor(v));
console.log('conservation', fmtMinor(back.tb.total));

// ---------- journal queries through generator + labeled block ----------
{
  let taxEntries = 0, cdaVol = 0n;
  for (const e of L.entries(e => /^(tax|cda):/.test(e.memo))) {
    e.memo.startsWith('tax') ? taxEntries++ : (cdaVol += e.legs[1][1]);
  }
  console.log('journal tax entries', taxEntries, 'cda volume', fmtMinor(cdaVol));
  scan: {
    for (const e of L.entries()) {
      if (e.memo.includes('english')) { console.log('first english entry seq', e.seq); break scan; }
    }
    console.log('no english entry');
  }
}

// ---------- WeakMap reputation, Set membership, logical assignment ----------
const reputation = new WeakMap();
const blacklist = new Set();
for (const a of agents) {
  const r = reputation.get(a) ?? { score: 50, notes: null };
  r.score += a.cash > toMinor('1000') ? 10 : -10;
  r.notes ||= [];
  r.notes.push(a.kind);
  r.flag &&= false;
  r.flag ??= a.cash < toMinor('500');
  reputation.set(a, r);
  if (r.flag) blacklist.add(a.name);
}
console.log('blacklist', JSON.stringify([...blacklist]), 'rep farm', JSON.stringify(reputation.get(agents[0])));

// ---------- async settlement batch (microtask only) ----------
class CancelToken {
  #cancelled = false; #reason = null; #subs = [];
  cancel(reason) { if (this.#cancelled) return; this.#cancelled = true; this.#reason = reason; this.#subs.splice(0).forEach(f => f(reason)); }
  get cancelled() { return this.#cancelled; }
  throwIfCancelled() { if (this.#cancelled) throw new Error('cancelled: ' + this.#reason); }
  onCancel(f) { this.#cancelled ? f(this.#reason) : this.#subs.push(f); }
}

async function clearPayment(from, to, amt, token, delayTicks) {
  for (let i = 0; i < delayTicks; i++) {
    await null;
    token.throwIfCancelled();
  }
  if (from.cash < amt) throw new LedgerError(`nsf ${from.name}`, 'ENSF');
  L.post(`clear:${from.name}:${to.name}`, [[from.cashAcct, -amt], [to.cashAcct, amt]]);
  return `${from.name}->${to.name}:${fmtMinor(amt)}`;
}

async function* paymentStream(pairs) {
  let i = 0;
  for (const [f, t, amt] of pairs) {
    await Promise.resolve();
    yield { i: i++, f: byName.get(f), t: byName.get(t), amt: toMinor(amt) };
  }
}

const asyncLog = [];
async function asyncMain() {
  const token = new CancelToken();
  token.onCancel(r => asyncLog.push('onCancel ' + r));
  const results = await Promise.allSettled([
    clearPayment(byName.get('tina'), byName.get('farm'), toMinor('10'), token, 2),
    clearPayment(byName.get('tom'), byName.get('mine'), toMinor('999999'), token, 1),
    clearPayment(byName.get('sam'), byName.get('mill'), toMinor('5'), token, 5),
    (async () => { await null; await null; await null; token.cancel('deadline'); return 'cancelled'; })(),
  ]);
  for (const r of results) asyncLog.push(r.status + ' ' + (r.status === 'fulfilled' ? r.value : r.reason.message));

  const first = await Promise.race([
    clearPayment(byName.get('hal'), byName.get('port'), toMinor('1'), new CancelToken(), 3),
    clearPayment(byName.get('tina'), byName.get('port'), toMinor('2'), new CancelToken(), 1),
  ]);
  asyncLog.push('race ' + first);

  try {
    await Promise.any([
      Promise.reject(new Error('a')),
      clearPayment(byName.get('tom'), byName.get('farm'), toMinor('99999999'), new CancelToken(), 0),
    ]);
  } catch (e) {
    asyncLog.push('any ' + e.constructor.name + ' ' + e.errors.map(x => x.message).join('|'));
  }

  const all = await Promise.all(['a', 'b', 'c'].map(async (x, i) => {
    for (let k = 0; k < 3 - i; k++) await null;
    asyncLog.push('done ' + x);
    return x.toUpperCase();
  }));
  asyncLog.push('all ' + all.join(''));

  let streamed = 0n;
  for await (const { i, f, t, amt } of paymentStream([['sam', 'tom', '3.5'], ['hal', 'tina', '1.25'], ['ghost', 'tom', '1']])) {
    try {
      const r = await clearPayment(f ?? { cash: -1n, name: 'ghost' }, t, amt, new CancelToken(), i % 2);
      streamed += amt;
      asyncLog.push('stream ' + r);
    } catch ({ message, code = 'none' }) {
      asyncLog.push(`stream err ${code} ${message}`);
      continue;
    } finally {
      asyncLog.push('stream step ' + i);
    }
  }
  asyncLog.push('streamed ' + fmtMinor(streamed));
  return L.trialBalance().total;
}

const interleave = [];
Promise.resolve().then(() => interleave.push('m1')).then(() => interleave.push('m3'));
queueMicrotaskSafe(() => interleave.push('m2'));
function queueMicrotaskSafe(f) { Promise.resolve().then(f); }

asyncMain().then(total => {
  asyncLog.forEach(l => console.log('async', l));
  console.log('interleave', interleave.join(','));
  console.log('final conservation', fmtMinor(total));
  for (const a of agents) console.log('final', `${a}`);
  console.log('journal entries', L.size, 'audit ops', auditLog.length);
}, e => console.log('async failure', e.message));
console.log('sync phase complete');
