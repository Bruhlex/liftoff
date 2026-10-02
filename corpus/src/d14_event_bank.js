// d14: event-sourced bank with aggregates, sagas (generators), compensation,
// idempotency keys, optimistic concurrency, projections, snapshots, async gateway.

function makeRng(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0);
    },
    int(n) { return this.next() % n; },
  };
}

const fmtMoney = (c) => {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return (neg ? '-$' : '$') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
};
function money(strings, ...vals) {
  return strings.raw.reduce((acc, s, i) => acc + s + (i < vals.length ? (typeof vals[i] === 'bigint' ? fmtMoney(vals[i]) : String(vals[i])) : ''), '');
}
const parseAmount = (s) => {
  const m = /^(?<int>\d+)(?:\.(?<frac>\d{1,2}))?$/.exec(s);
  if (!m) throw new SyntaxError('bad amount ' + s);
  return BigInt(m.groups.int) * 100n + BigInt((m.groups.frac ?? '0').padEnd(2, '0'));
};
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? fmtMoney(x) : x instanceof Map ? Object.fromEntries(x) : x));

class Money {
  #cents;
  constructor(c) { this.#cents = BigInt(c); }
  static parse(s) { return new Money(parseAmount(s)); }
  plus(o) { return new Money(this.#cents + (o instanceof Money ? o.#cents : BigInt(o))); }
  get cents() { return this.#cents; }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return Number(this.#cents) / 100;
    if (hint === 'string') return fmtMoney(this.#cents);
    return this.#cents;
  }
  get [Symbol.toStringTag]() { return 'Money'; }
}

class DomainError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
  get name() { return 'DomainError'; }
}
class IdempotencyError extends DomainError {
  constructor(key) { super('IDEM', 'key reused with different payload: ' + key); }
}
class ConcurrencyError extends Error {
  constructor(stream, expected, actual) { super(`stream ${stream} expected v${expected} got v${actual}`); this.stream = stream; }
  get name() { return 'ConcurrencyError'; }
}
class TransientError extends Error { get name() { return 'TransientError'; } }

const CommandShape = {
  [Symbol.hasInstance](o) { return o !== null && typeof o === 'object' && typeof o.cmd === 'string' && typeof o.account === 'string'; },
};

class EventStore {
  #events = []; #streams = new Map(); #subs = []; #hooks = [];
  append(stream, expected, events, meta = {}) {
    for (const h of [...this.#hooks]) h(stream, expected);
    const list = this.#streams.get(stream) ?? [];
    if (list.length !== expected) throw new ConcurrencyError(stream, expected, list.length);
    const stored = events.map((e, i) => Object.freeze({ seq: this.#events.length + i + 1, stream, version: expected + i + 1, type: e.type, data: e.data, meta: { ...meta } }));
    list.push(...stored);
    this.#streams.set(stream, list);
    this.#events.push(...stored);
    for (const e of stored) for (const s of this.#subs) s(e);
    return stored.length;
  }
  read(stream, from = 0) { return (this.#streams.get(stream) ?? []).slice(from); }
  has(stream) { return this.#streams.has(stream); }
  get length() { return this.#events.length; }
  streams() { return [...this.#streams.keys()].sort(); }
  *[Symbol.iterator]() { yield* this.#events; }
  *ofType(...types) { for (const e of this) if (types.includes(e.type)) yield e; }
  subscribe(fn) { this.#subs.push(fn); return () => { this.#subs = this.#subs.filter((s) => s !== fn); }; }
  onBeforeAppend(fn) { this.#hooks.push(fn); return () => { this.#hooks = this.#hooks.filter((h) => h !== fn); }; }
}

class Aggregate {
  #version = 0; #pending = [];
  static #registry = new Map();
  static register(kind, cls) { Aggregate.#registry.set(kind, cls); }
  static classFor(kind) {
    const c = Aggregate.#registry.get(kind);
    if (!c) throw new DomainError('KIND', 'unknown account kind ' + kind);
    return c;
  }
  static get kinds() { return [...Aggregate.#registry.keys()]; }
  constructor(id) {
    if (new.target === Aggregate) throw new TypeError('abstract aggregate');
    this.id = id;
  }
  get version() { return this.#version; }
  apply(event, isNew = true) {
    const h = this['on' + event.type];
    if (typeof h !== 'function') throw new DomainError('EVT', 'no handler for ' + event.type);
    h.call(this, event.data);
    this.#version++;
    if (isNew) this.#pending.push({ type: event.type, data: event.data });
  }
  raise(type, data) { this.apply({ type, data }, true); }
  takePending() { const p = this.#pending; this.#pending = []; return p; }
  static hydrate(id, events, base = null) {
    const a = base ?? new this(id);
    for (const e of events) a.apply(e, false);
    return a;
  }
}

class Account extends Aggregate {
  static KIND = 'basic';
  static { Aggregate.register('basic', Account); }
  balance = 0n; status = 'new'; holds = new Map(); owner = null; txCount = 0;
  #requireOpen() {
    if (this.status !== 'open') throw new DomainError('STATE', `${this.id} is ${this.status}`);
  }
  get overdraft() { return 0n; }
  get available() {
    let held = 0n;
    for (const v of this.holds.values()) held += v;
    return this.balance - held + this.overdraft;
  }
  canWithdraw(amount) { return this.status === 'open' && amount <= this.available; }
  open(owner) {
    if (this.status !== 'new') throw new DomainError('STATE', 'already open ' + this.id);
    this.raise('Opened', { owner, kind: this.constructor.KIND });
    return this.status;
  }
  deposit(amount, ref) {
    this.#requireOpen();
    if (amount <= 0n) throw new DomainError('AMT', 'non-positive deposit');
    this.raise('Deposited', { amount, ref });
    return this.balance;
  }
  withdraw(amount, ref, force = false) {
    if (!force) {
      this.#requireOpen();
      if (!this.canWithdraw(amount)) throw new DomainError('NSF', money`insufficient funds in ${this.id}: want ${amount} have ${this.available}`);
    }
    this.raise('Withdrawn', { amount, ref });
    return this.balance;
  }
  reserve(tid, amount) {
    this.#requireOpen();
    if (this.holds.has(tid)) return this.holds.get(tid);
    if (!this.canWithdraw(amount)) throw new DomainError('NSF', money`cannot reserve ${amount} on ${this.id}`);
    this.raise('Reserved', { tid, amount });
    return amount;
  }
  commit(tid) {
    const amount = this.holds.get(tid);
    if (amount === undefined) throw new DomainError('HOLD', 'no hold ' + tid);
    this.raise('ReserveCommitted', { tid, amount });
    return this.balance;
  }
  release(tid) {
    if (!this.holds.has(tid)) return false;
    this.raise('ReserveReleased', { tid });
    return true;
  }
  freeze(reason) { this.#requireOpen(); this.raise('Frozen', { reason }); return 'frozen'; }
  onOpened({ owner }) { this.owner = owner; this.status = 'open'; }
  onDeposited({ amount }) { this.balance += amount; this.txCount++; }
  onWithdrawn({ amount }) { this.balance -= amount; this.txCount++; }
  onReserved({ tid, amount }) { this.holds.set(tid, amount); }
  onReserveCommitted({ tid, amount }) { this.holds.delete(tid); this.balance -= amount; this.txCount++; }
  onReserveReleased({ tid }) { this.holds.delete(tid); }
  onFrozen() { this.status = 'frozen'; }
  summary() { return { id: this.id, kind: this.constructor.KIND, balance: this.balance, status: this.status, v: this.version, holds: this.holds.size }; }
}

class SavingsAccount extends Account {
  static KIND = 'savings';
  static #LIMIT = 3;
  static { Aggregate.register('savings', SavingsAccount); }
  #withdrawals = 0;
  canWithdraw(amount) { return this.#withdrawals < SavingsAccount.#LIMIT && super.canWithdraw(amount); }
  accrue(rateBp) {
    const interest = (this.balance * BigInt(rateBp)) / 10000n;
    if (interest > 0n) this.raise('InterestAccrued', { amount: interest });
    return interest;
  }
  onWithdrawn(d) { super.onWithdrawn(d); this.#withdrawals++; }
  onReserveCommitted(d) { super.onReserveCommitted(d); this.#withdrawals++; }
  onInterestAccrued({ amount }) { this.balance += amount; }
  get withdrawalsLeft() { return SavingsAccount.#LIMIT - this.#withdrawals; }
  static isSavings(o) { return #withdrawals in o; }
  summary() { return { ...super.summary(), left: this.withdrawalsLeft }; }
}

class PremiumSavings extends SavingsAccount {
  static KIND = 'premium';
  static #tiers = [[100000n, 5], [10000n, 3], [0n, 1]];
  static { Aggregate.register('premium', PremiumSavings); }
  #fees = 0n;
  get overdraft() { return 20000n; }
  canWithdraw(amount) { return super.canWithdraw(amount) || (this.status === 'open' && amount <= this.available); }
  withdraw(amount, ref, force) {
    const r = super.withdraw(amount, ref, force);
    if (this.balance < 0n) this.#chargeFee();
    return r;
  }
  #chargeFee() { this.raise('FeeCharged', { amount: PremiumSavings.#feeFor(this.balance) }); }
  static #feeFor(bal) { return bal < -10000n ? 500n : 250n; }
  accrue(rateBp) {
    const tier = PremiumSavings.#tiers.find(([min]) => this.balance >= min);
    return super.accrue(rateBp + (tier?.[1] ?? 0));
  }
  onFeeCharged({ amount }) { this.balance -= amount; this.#fees += amount; }
  get fees() { return this.#fees; }
  summary() { return { ...super.summary(), fees: this.#fees }; }
}

function fingerprint(cmd) {
  const { key, ...rest } = cmd;
  return JSON.stringify(rest, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v));
}

class Bank {
  #store; #idem = new Map();
  constructor(store) {
    this.#store = store;
    this.stats = { executed: 0, replayed: 0, retries: 0, attempts: 0, failed: 0 };
  }
  get store() { return this.#store; }
  load(id) {
    const events = this.#store.read(id);
    if (events.length === 0) return null;
    return Aggregate.classFor(events[0].data.kind).hydrate(id, events);
  }
  #dispatch(acct, cmd) {
    switch (cmd.cmd) {
      case 'deposit': return acct.deposit(cmd.amount, cmd.ref ?? null);
      case 'force-withdraw':
        cmd = { ...cmd, force: true };
      // fallthrough
      case 'withdraw': return acct.withdraw(cmd.amount, cmd.ref ?? null, cmd.force === true);
      case 'reserve': return acct.reserve(cmd.tid, cmd.amount);
      default:
        throw new DomainError('CMD', 'unknown command ' + cmd.cmd);
      case 'commit': return acct.commit(cmd.tid);
      case 'release': return acct.release(cmd.tid);
      case 'freeze': return acct.freeze(cmd.reason ?? 'n/a');
      case 'accrue':
        if (typeof acct.accrue !== 'function') throw new DomainError('CMD', 'no interest on ' + acct.id);
        return acct.accrue(cmd.rate);
    }
  }
  execute(cmd) {
    if (!(cmd instanceof CommandShape)) throw new TypeError('not a command');
    const { key = null } = cmd;
    const fp = fingerprint(cmd);
    if (key !== null && this.#idem.has(key)) {
      const prev = this.#idem.get(key);
      if (prev.fp !== fp) throw new IdempotencyError(key);
      this.stats.replayed++;
      return prev.result;
    }
    let attempt = 0;
    retry: for (;;) {
      attempt++;
      try {
        let acct;
        if (cmd.cmd === 'open') {
          if (this.#store.has(cmd.account)) throw new DomainError('DUP', 'exists ' + cmd.account);
          acct = new (Aggregate.classFor(cmd.kind ?? 'basic'))(cmd.account);
          acct.open(cmd.owner);
        } else {
          acct = this.load(cmd.account);
          if (acct === null) throw new DomainError('404', 'no account ' + cmd.account);
          this.#dispatch(acct, cmd);
        }
        const pending = acct.takePending();
        this.#store.append(acct.id, acct.version - pending.length, pending, { key, saga: cmd.saga ?? null });
        const result = { ok: true, account: acct.id, balance: acct.balance, v: acct.version };
        if (key !== null) this.#idem.set(key, { fp, result });
        this.stats.executed++;
        return result;
      } catch (e) {
        if (e instanceof ConcurrencyError && attempt < 3) { this.stats.retries++; continue retry; }
        this.stats.failed++;
        throw e;
      } finally {
        this.stats.attempts++;
      }
    }
  }
}

// ---------- sagas as generators ----------
function* transferSaga(t) {
  let reserved = false, credited = false;
  const tag = { saga: t.tid };
  try {
    yield { cmd: 'reserve', account: t.from, amount: t.amount, tid: t.tid, ...tag };
    reserved = true;
    if (t.failAfterReserve) throw new DomainError('INJECT', 'injected failure ' + t.tid);
    yield { cmd: 'deposit', account: t.to, amount: t.amount, ref: t.tid, ...tag };
    credited = true;
    yield { cmd: 'commit', account: t.from, tid: t.tid, ...tag };
    return { status: 'committed', tid: t.tid };
  } catch (err) {
    if (credited) yield { cmd: 'force-withdraw', account: t.to, amount: t.amount, ref: 'comp-' + t.tid, ...tag };
    if (reserved) yield { cmd: 'release', account: t.from, tid: t.tid, ...tag };
    return { status: 'compensated', tid: t.tid, reason: err.code ?? err.message };
  } finally {
    t.closed = true;
  }
}

function* payrollSaga(from, payees, prefix) {
  const done = [];
  for (const [i, { to, amount, fail = false }] of payees.entries()) {
    const tid = `${prefix}-${i}`;
    const r = yield* transferSaga({ from, to, amount, tid, failAfterReserve: fail });
    if (r.status !== 'committed') {
      let reverted = 0;
      for (const d of [...done].reverse()) {
        const back = yield* transferSaga({ from: d.to, to: from, amount: d.amount, tid: 'rev-' + d.tid });
        if (back.status === 'committed') reverted++;
      }
      return { status: 'rolled-back', at: to, reverted, reason: r.reason };
    }
    done.push({ to, amount, tid });
  }
  return { status: 'paid', count: done.length };
}

function runSaga(gen, bank, trace) {
  let r = gen.next();
  let steps = 0;
  while (!r.done) {
    const step = r.value;
    steps++;
    let res;
    try {
      res = bank.execute({ ...step, key: `${step.saga}:${steps}:${step.cmd}` });
    } catch (e) {
      trace?.push(`${step.cmd}@${step.account}!${e.code ?? e.name}`);
      try {
        r = gen.throw(e);
      } catch (fatal) {
        return { status: 'stuck', reason: fatal.message, steps };
      }
      continue;
    }
    trace?.push(`${step.cmd}@${step.account}`);
    r = gen.next(res);
  }
  return { ...r.value, steps };
}

// ---------- projections ----------
function makeAudit() {
  const writes = [];
  const target = { total: 0, byType: {} };
  const proxy = new Proxy(target, {
    set(t, k, v) {
      writes.push(String(k));
      return Reflect.set(t, k, v);
    },
    get(t, k) {
      if (k === 'writes') return writes.length;
      return Reflect.get(t, k);
    },
  });
  return proxy;
}

function attachProjections(store) {
  const balances = new Map();
  const audit = makeAudit();
  const sagas = new Map();
  const unsub = store.subscribe((e) => {
    audit.total = audit.total + 1;
    audit.byType[e.type] = (audit.byType[e.type] ?? 0) + 1;
    const cur = balances.get(e.stream) ?? 0n;
    switch (e.type) {
      case 'Deposited': case 'InterestAccrued':
        balances.set(e.stream, cur + e.data.amount); break;
      case 'Withdrawn': case 'ReserveCommitted': case 'FeeCharged':
        balances.set(e.stream, cur - e.data.amount); break;
      case 'Opened':
        balances.set(e.stream, 0n);
      // fallthrough
      default:
        break;
    }
    if (e.meta.saga) {
      const s = sagas.get(e.meta.saga) ?? [];
      s.push(e.type[0] + e.type.slice(-3));
      sagas.set(e.meta.saga, s);
    }
  });
  return { balances, audit, sagas, unsub };
}

function foldEvents(events, i, state) {
  if (i === events.length) return state;
  const e = events[i];
  const delta = e.type === 'Deposited' ? e.data.amount : e.type === 'Withdrawn' ? -e.data.amount : 0n;
  return foldEvents(events, i + 1, { sum: state.sum + delta, n: state.n + 1 });
}

function snapshotOf(acct) {
  return JSON.stringify({ id: acct.id, kind: acct.constructor.KIND, v: acct.version, state: { balance: acct.balance, status: acct.status, owner: acct.owner, holds: [...acct.holds], txCount: acct.txCount } },
    (k, v) => (typeof v === 'bigint' ? { $n: v.toString() } : v));
}
function restoreSnapshot(text, store) {
  const snap = JSON.parse(text, (k, v) => (v && typeof v === 'object' && '$n' in v ? BigInt(v.$n) : v));
  const Cls = Aggregate.classFor(snap.kind);
  const tail = store.read(snap.id, snap.v);
  // rebuild from full stream for private state, but verify snapshot prefix matches
  const full = Cls.hydrate(snap.id, store.read(snap.id, 0, snap.v).slice(0, snap.v));
  const prefixOk = full.balance === snap.state.balance && full.txCount === snap.state.txCount;
  Cls.hydrate(snap.id, tail, full);
  return { acct: full, tail: tail.length, prefixOk };
}

// ---------- sections ----------
function seedBank() {
  const store = new EventStore();
  const bank = new Bank(store);
  const proj = attachProjections(store);
  const opens = [
    ['alice', 'Alice', 'basic'], ['bob', 'Bob', 'savings'], ['carol', 'Carol', 'premium'],
    ['dave', 'Dave', 'basic'], ['erin', 'Erin', 'savings'], ['corp', 'Corp', 'premium'],
  ];
  for (const [account, owner, kind] of opens) bank.execute({ cmd: 'open', account, owner, kind, key: 'open-' + account });
  const deposits = { alice: '500.00', bob: '1200.50', carol: '80.00', dave: '10', erin: '999.99', corp: '5000' };
  for (const acc in deposits) bank.execute({ cmd: 'deposit', account: acc, amount: parseAmount(deposits[acc]), key: 'seed-' + acc });
  return { store, bank, proj };
}

function sectionBasics() {
  console.log('== basics ==');
  const m = Money.parse('12.5');
  console.log(`money ${String(m)} num=${+m} big=${m + 1n} plus=${String(m.plus(Money.parse('0.75')))} tag=${Object.prototype.toString.call(m)}`);
  console.log(money`tagged ${1234n} and ${-5n} raw\t${'x'}`);
  for (const bad of ['12.345', 'abc', '']) {
    try { parseAmount(bad); } catch (e) { console.log(`bad amount "${bad}" -> ${e instanceof SyntaxError}`); }
  }
  try { new Aggregate('x'); } catch (e) { console.log('abstract ' + e.message); }
  console.log('kinds ' + Aggregate.kinds.join(','));
  const { store, bank, proj } = seedBank();
  console.log('after seed events=' + store.length + ' streams=' + store.streams().join(','));
  for (const id of store.streams()) console.log('  ' + json(bank.load(id).summary()));
  const r1 = bank.execute({ cmd: 'withdraw', account: 'alice', amount: 2500n, key: 'w1' });
  const r2 = bank.execute({ cmd: 'withdraw', account: 'alice', amount: 2500n, key: 'w1' });
  console.log('idempotent ' + (r1 === r2) + ' ' + json(r1) + ' stats=' + json(bank.stats));
  try {
    bank.execute({ cmd: 'withdraw', account: 'alice', amount: 9999n, key: 'w1' });
  } catch (e) {
    console.log(`reuse -> ${e.name} ${e.code} ${e instanceof DomainError} ${e instanceof IdempotencyError}`);
  }
  const probes = [
    { cmd: 'withdraw', account: 'dave', amount: 5000n },
    { cmd: 'deposit', account: 'ghost', amount: 1n },
    { cmd: 'deposit', account: 'dave', amount: 0n },
    { cmd: 'teleport', account: 'dave' },
    { cmd: 'accrue', account: 'dave', rate: 10 },
    { cmd: 'open', account: 'dave', owner: 'x' },
    { cmd: 'open', account: 'zed', owner: 'Zed', kind: 'crypto' },
    { nope: true },
  ];
  for (const p of probes) {
    try {
      bank.execute(p);
      console.log('unexpected ok ' + p.cmd);
    } catch (e) {
      console.log(`reject ${p.cmd ?? '?'}: ${e.code ?? e.name} ${e.message}`);
    }
  }
  for (let i = 0; i < 5; i++) {
    try {
      const r = bank.execute({ cmd: 'withdraw', account: 'bob', amount: 1000n, ref: 'atm' + i });
      console.log(`bob atm${i} ok bal=${fmtMoney(r.balance)}`);
    } catch (e) {
      console.log(`bob atm${i} ${e.code}`);
    }
  }
  const carolOps = [3000n, 6000n, 5000n, 9000n];
  for (const [i, amt] of carolOps.entries()) {
    try {
      bank.execute({ cmd: 'withdraw', account: 'carol', amount: amt, ref: 'c' + i });
    } catch (e) {
      console.log('carol reject ' + i + ' ' + e.code);
    } finally {
      const c = bank.load('carol');
      console.log(money`carol after ${i}: bal=${c.balance} avail=${c.available} fees=${c.fees} left=${c.withdrawalsLeft}`);
    }
  }
  const interest = ['bob', 'carol', 'erin', 'corp'].map((a) => bank.execute({ cmd: 'accrue', account: a, rate: 25, key: 'int-' + a }).balance);
  console.log('after interest ' + interest.map(fmtMoney).join(' '));
  console.log('savings check ' + ['alice', 'bob', 'carol'].map((a) => SavingsAccount.isSavings(bank.load(a))).join(','));
  console.log('projection matches ' + store.streams().every((id) => proj.balances.get(id) === bank.load(id).balance));
  console.log('audit total=' + proj.audit.total + ' writes=' + proj.audit.writes + ' types=' + JSON.stringify(proj.audit.byType));
  return { store, bank, proj };
}

function sectionConcurrency(ctx) {
  console.log('== concurrency ==');
  const { store, bank } = ctx;
  let injected = 0;
  const off = store.onBeforeAppend(function (stream) {
    if (stream !== 'dave' || injected >= 2) return;
    injected++;
    const acct = bank.load('dave');
    const rival = new Account('dave');
    Account.hydrate('dave', store.read('dave'), rival);
    rival.deposit(100n, 'rival' + injected);
    const p = rival.takePending();
    store.append('dave', acct.version, p, { key: null, saga: null });
  });
  const res = bank.execute({ cmd: 'deposit', account: 'dave', amount: 700n, ref: 'main' });
  console.log(`after conflicts injected=${injected} bal=${fmtMoney(res.balance)} v=${res.v} retries=${bank.stats.retries}`);
  injected = 0;
  let busy = false;
  const off2 = store.onBeforeAppend((stream) => {
    if (stream === 'erin' && !busy && injected < 5) {
      busy = true;
      injected++;
      const v = store.read('erin').length;
      const rival = SavingsAccount.hydrate('erin', store.read('erin'));
      rival.deposit(1n, 'spam');
      try { store.append('erin', v, rival.takePending()); } finally { busy = false; }
    }
  });
  try {
    bank.execute({ cmd: 'deposit', account: 'erin', amount: 5n });
  } catch (e) {
    console.log('gave up: ' + e.name + ' ' + e.message);
  } finally {
    off2();
    off();
  }
  console.log('erin bal ' + fmtMoney(bank.load('erin').balance) + ' injected=' + injected + ' stats ' + json(bank.stats));
}

function sectionSagas(ctx) {
  console.log('== sagas ==');
  const { bank, proj } = ctx;
  const cases = [
    { from: 'alice', to: 'dave', amount: 1500n, tid: 't1' },
    { from: 'dave', to: 'alice', amount: 999999n, tid: 't2' },
    { from: 'erin', to: 'bob', amount: 2000n, tid: 't3', failAfterReserve: true },
    { from: 'corp', to: 'ghost', amount: 100n, tid: 't4' },
    { from: 'alice', to: 'dave', amount: 1500n, tid: 't1' },
  ];
  for (const t of cases) {
    const trace = [];
    const r = runSaga(transferSaga(t), bank, trace);
    console.log(`saga ${t.tid}: ${json(r)} closed=${t.closed} trace=${trace.join(' > ')}`);
  }
  const pay = [{ to: 'alice', amount: 10000n }, { to: 'bob', amount: 20000n }, { to: 'dave', amount: 5000n }];
  const trace1 = [];
  console.log('payroll ok ' + json(runSaga(payrollSaga('corp', pay, 'pay1'), bank, trace1)) + ' steps=' + trace1.length);
  const pay2 = [{ to: 'alice', amount: 100n }, { to: 'erin', amount: 200n }, { to: 'bob', amount: 300n, fail: true }];
  const trace2 = [];
  console.log('payroll fail ' + json(runSaga(payrollSaga('corp', pay2, 'pay2'), bank, trace2)));
  console.log('  trace ' + trace2.join(' '));
  bank.execute({ cmd: 'freeze', account: 'dave', reason: 'fraud', key: 'frz' });
  const trace3 = [];
  const stuck = runSaga((function* () {
    const r = yield* transferSaga({ from: 'alice', to: 'dave', amount: 100n, tid: 't9' });
    return { inner: r.status };
  })(), bank, trace3);
  console.log('frozen target ' + json(stuck) + ' ' + trace3.join(' '));
  const cancel = transferSaga({ from: 'alice', to: 'bob', amount: 1n, tid: 'tc' });
  const first = cancel.next();
  const ret = cancel.return({ status: 'cancelled' });
  console.log(`cancelled first=${first.value.cmd} ret=${json(ret)}`);
  const sagaKeys = [...proj.sagas.keys()].filter((k) => k.startsWith('pay'));
  console.log('saga events ' + sagaKeys.map((k) => k + ':' + proj.sagas.get(k).join('.')).join(' '));
  const holds = ctx.store.streams().map((id) => [id, bank.load(id).holds.size]).filter(([, n]) => n > 0);
  console.log('dangling holds ' + JSON.stringify(holds));
}

function sectionReplay(ctx) {
  console.log('== replay ==');
  const { store, bank, proj } = ctx;
  const counts = {};
  for (const e of store) counts[e.stream] = (counts[e.stream] ?? 0) + 1;
  console.log('per stream ' + JSON.stringify(counts));
  const commits = [...store.ofType('ReserveCommitted', 'ReserveReleased')].map((e) => e.data.tid);
  console.log('hold outcomes ' + commits.join(','));
  bank.execute({ cmd: 'open', account: 'stress', owner: 'S', kind: 'basic' });
  for (let i = 0; i < 3000; i++) {
    bank.execute({ cmd: i % 7 === 6 ? 'withdraw' : 'deposit', account: 'stress', amount: BigInt((i % 5) + 1) });
  }
  const events = store.read('stress');
  const folded = foldEvents(events, 0, { sum: 0n, n: 0 });
  const live = bank.load('stress');
  console.log(`stress events=${events.length} fold=${fmtMoney(folded.sum)} live=${fmtMoney(live.balance)} proj=${fmtMoney(proj.balances.get('stress'))}`);
  const carol = bank.load('carol');
  const snap = snapshotOf(carol);
  console.log('snapshot ' + snap);
  bank.execute({ cmd: 'deposit', account: 'carol', amount: 12345n });
  bank.execute({ cmd: 'withdraw', account: 'carol', amount: 45n });
  const { acct, tail, prefixOk } = restoreSnapshot(snap, store);
  console.log(`restored tail=${tail} prefixOk=${prefixOk} ${json(acct.summary())} same=${acct.balance === bank.load('carol').balance}`);
  const dump = JSON.stringify(store.read('bob').slice(0, 3), (k, v) => (typeof v === 'bigint' ? `${v}n` : k === 'seq' ? undefined : v));
  const back = JSON.parse(dump, (k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
  console.log('dump ' + dump);
  console.log('revived amount type ' + typeof back[1].data.amount + ' ' + ('seq' in back[0]));
  let mismatches = 0;
  outer: for (const id of store.streams()) {
    const evs = store.read(id);
    for (let cut = 1; cut <= evs.length; cut += Math.max(1, evs.length >> 2)) {
      const partial = Aggregate.classFor(evs[0].data.kind).hydrate(id, evs.slice(0, cut));
      if (partial.version !== cut) { mismatches++; continue outer; }
    }
  }
  console.log('partial replays ok mismatches=' + mismatches);
  const statement = 'Paid $12.50 to bob, refund $3.07, fee $0.25 and $100.00 bonus';
  const amounts = statement.match(/(?<=\$)\d+\.\d{2}/g).map(parseAmount);
  console.log('statement total ' + fmtMoney(amounts.reduce((a, b) => a + b, 0n)) + ' n=' + amounts.length);
}

function parseCommandLine(line) {
  const m = /^(?<verb>transfer|deposit|withdraw)\s+\$(?<amt>\d+(?:\.\d{1,2})?)(?:\s+from\s+(?<from>\w+))?(?:\s+to\s+(?<to>\w+))?(?:\s+key=(?<key>[\w-]+))?$/.exec(line.trim());
  if (!m) throw new SyntaxError('cannot parse: ' + line.trim());
  const { verb, amt, from, to, key = undefined } = m.groups;
  return { verb, amount: parseAmount(amt), from, to, key };
}

function* splitScript(src) {
  const re = /\s*(?<stmt>[^;]+);?/y;
  let m;
  while ((m = re.exec(src)) !== null && m[0].length > 0) {
    const s = m.groups.stmt.trim();
    if (s) yield s;
  }
}

class FlakyGateway {
  #rng; #bank;
  constructor(bank, seed) { this.#bank = bank; this.#rng = makeRng(seed); this.log = []; }
  async call(cmd) {
    await Promise.resolve();
    const roll = this.#rng.int(10);
    if (roll < 2) { this.log.push('drop-before'); throw new TransientError('network before ' + cmd.cmd); }
    const res = this.#bank.execute(cmd);
    await null;
    if (roll === 9) { this.log.push('drop-after'); throw new TransientError('network after ' + cmd.cmd); }
    return res;
  }
}

async function callWithRetry(gw, cmd, max = 4) {
  let last;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await gw.call(cmd);
    } catch (e) {
      last = e;
      if (!(e instanceof TransientError)) throw e;
      continue;
    } finally {
      gw.log.push(`try${attempt}:${cmd.cmd}`);
    }
  }
  throw new DomainError('RETRY', 'exhausted: ' + last.message);
}

async function runSagaAsync(gen, gw) {
  let r = gen.next();
  let n = 0;
  while (!r.done) {
    const step = r.value;
    n++;
    try {
      const res = await callWithRetry(gw, { ...step, key: `${step.saga}:${n}:${step.cmd}` });
      r = gen.next(res);
    } catch (e) {
      r = gen.throw(e);
    }
  }
  return r.value;
}

async function* commandFeed(script) {
  for (const stmt of splitScript(script)) {
    await null;
    try {
      yield parseCommandLine(stmt);
    } catch (e) {
      yield { verb: 'invalid', error: e.message };
    }
  }
}

async function sectionAsync(ctx) {
  console.log('== async ==');
  const { bank } = ctx;
  const gw = new FlakyGateway(bank, 7);
  const script = 'deposit $25 to alice key=a1; transfer $10.5 from alice to bob key=x1; withdraw $1.25 from bob; bogus line; transfer $99999 from dave to alice; deposit $25 to alice key=a1';
  const results = [];
  let i = 0;
  for await (const c of commandFeed(script)) {
    i++;
    try {
      switch (c.verb) {
        case 'deposit': {
          const r = await callWithRetry(gw, { cmd: 'deposit', account: c.to, amount: c.amount, key: c.key ?? 'feed' + i });
          results.push(`dep ${c.to} ${fmtMoney(r.balance)}`);
          break;
        }
        case 'withdraw': {
          const r = await callWithRetry(gw, { cmd: 'withdraw', account: c.from, amount: c.amount, key: 'feed' + i });
          results.push(`wd ${c.from} ${fmtMoney(r.balance)}`);
          break;
        }
        case 'transfer': {
          const r = await runSagaAsync(transferSaga({ from: c.from, to: c.to, amount: c.amount, tid: c.key ?? 'ft' + i }), gw);
          results.push(`xfer ${r.status}${r.reason ? '(' + r.reason + ')' : ''}`);
          break;
        }
        default:
          results.push('skip ' + c.error.slice(0, 20));
      }
    } catch (e) {
      results.push('err ' + (e.code ?? e.name));
    }
  }
  results.forEach((r, k) => console.log(`  feed ${k}: ${r}`));
  console.log('gateway log ' + gw.log.join(','));
  const order = [];
  const par = ['p1', 'p2', 'p3', 'p4'].map(async (tid, k) => {
    order.push('start ' + tid);
    const r = await runSagaAsync(transferSaga({ from: k % 2 ? 'corp' : 'erin', to: 'alice', amount: BigInt(100 * (k + 1)), tid, failAfterReserve: k === 2 }), gw);
    order.push('end ' + tid);
    if (r.status !== 'committed') throw new DomainError('SAGA', tid + ' ' + r.status);
    return tid;
  });
  const settled = await Promise.allSettled(par);
  console.log('parallel ' + settled.map((s) => (s.status === 'fulfilled' ? s.value : s.reason.message)).join(' | '));
  console.log('order ' + order.join(', '));
  const winner = await Promise.race([
    callWithRetry(gw, { cmd: 'deposit', account: 'bob', amount: 1n, key: 'race1' }).then(() => 'deposit'),
    Promise.resolve('instant'),
  ]);
  console.log('gateway log2 ' + gw.log.slice(-12).join(','));
  console.log('race ' + winner + ' idem stats ' + json(bank.stats));
  const total = [...ctx.store.streams()].reduce((acc, id) => acc + bank.load(id).balance, 0n);
  console.log('system total ' + fmtMoney(total));
}

function main() {
  const ctx = sectionBasics();
  sectionConcurrency(ctx);
  sectionSagas(ctx);
  sectionReplay(ctx);
  return sectionAsync(ctx).then(() => console.log('== done ==')).catch((e) => console.log('FAILED ' + e.message));
}

main();
