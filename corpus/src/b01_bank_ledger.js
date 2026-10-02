// Bank account ledger with transactions, overdraft errors, interest and audit.
'use strict';

class LedgerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

class OverdraftError extends LedgerError {
  constructor(account, amount) {
    super(`Overdraft on ${account.id}: requested ${formatCents(amount)}, available ${formatCents(account.available)}`, 'E_OVERDRAFT');
    this.name = 'OverdraftError';
    this.shortfall = amount - account.available;
  }
}

const TX_KIND = Object.freeze({
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
  TRANSFER_IN: 'transfer-in',
  TRANSFER_OUT: 'transfer-out',
  FEE: 'fee',
  INTEREST: 'interest',
});

const auditTag = Symbol('audit');

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${frac}`;
}

function money(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      out += typeof v === 'number' ? formatCents(v) : String(v);
    }
  });
  return out;
}

let txCounter = 0;
function nextTxId(prefix = 'TX') {
  txCounter += 1;
  return `${prefix}-${String(txCounter).padStart(4, '0')}`;
}

class Transaction {
  constructor(kind, amount, memo = '', meta = {}) {
    this.id = nextTxId();
    this.kind = kind;
    this.amount = amount;
    this.memo = memo;
    this.meta = { ...meta };
    this[auditTag] = `${kind}:${amount}`;
  }
  get signed() {
    switch (this.kind) {
      case TX_KIND.DEPOSIT:
      case TX_KIND.TRANSFER_IN:
      case TX_KIND.INTEREST:
        return this.amount;
      case TX_KIND.WITHDRAW:
      case TX_KIND.TRANSFER_OUT:
      case TX_KIND.FEE:
        return -this.amount;
      default:
        throw new LedgerError('unknown kind ' + this.kind, 'E_KIND');
    }
  }
  toString() {
    return `${this.id} ${this.kind.padEnd(12)} ${formatCents(this.signed).padStart(12)} ${this.memo}`;
  }
}

class Account {
  #balance = 0;
  #history = [];
  #frozen = false;
  static #count = 0;
  static bankCode = 'VMB';

  constructor(owner, { overdraftLimit = 0, type = 'checking' } = {}) {
    Account.#count++;
    this.id = `${Account.bankCode}${String(Account.#count).padStart(3, '0')}`;
    this.owner = owner;
    this.overdraftLimit = overdraftLimit;
    this.type = type;
  }

  static get count() {
    return Account.#count;
  }

  get balance() {
    return this.#balance;
  }

  get available() {
    return this.#balance + this.overdraftLimit;
  }

  get frozen() {
    return this.#frozen;
  }

  set frozen(v) {
    this.#frozen = !!v;
  }

  get history() {
    return [...this.#history];
  }

  #apply(tx) {
    if (this.#frozen) throw new LedgerError(`Account ${this.id} is frozen`, 'E_FROZEN');
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) {
      throw new LedgerError(`Invalid amount ${tx.amount}`, 'E_AMOUNT');
    }
    if (tx.signed < 0 && -tx.signed > this.available) {
      throw new OverdraftError(this, -tx.signed);
    }
    this.#balance += tx.signed;
    this.#history.push(tx);
    return tx;
  }

  deposit(amount, memo) {
    return this.#apply(new Transaction(TX_KIND.DEPOSIT, amount, memo));
  }

  withdraw(amount, memo) {
    return this.#apply(new Transaction(TX_KIND.WITHDRAW, amount, memo));
  }

  charge(amount, memo = 'fee') {
    return this.#apply(new Transaction(TX_KIND.FEE, amount, memo));
  }

  _raw(tx) {
    return this.#apply(tx);
  }

  *statement(filter = () => true) {
    let running = 0;
    for (const tx of this.#history) {
      running += tx.signed;
      if (filter(tx)) yield { tx, running };
    }
  }

  static compare(a, b) {
    return b.balance - a.balance || a.id.localeCompare(b.id);
  }
}

class SavingsAccount extends Account {
  constructor(owner, rateBps = 150) {
    super(owner, { type: 'savings' });
    this.rateBps = rateBps;
  }
  accrue(months = 1) {
    let total = 0;
    for (let m = 0; m < months; m++) {
      const interest = Math.floor((this.balance * this.rateBps) / 10000 / 12);
      if (interest > 0) {
        this._raw(new Transaction(TX_KIND.INTEREST, interest, `interest m${m + 1}`));
        total += interest;
      }
    }
    return total;
  }
  withdraw(amount, memo) {
    if (amount > 50000) throw new LedgerError('savings withdrawal limit exceeded', 'E_LIMIT');
    return super.withdraw(amount, memo);
  }
}

class Bank {
  constructor(name) {
    this.name = name;
    this.accounts = new Map();
    this.errors = [];
    this.log = [];
  }
  open(kind, owner, opts) {
    const acct = kind === 'savings' ? new SavingsAccount(owner, opts?.rateBps) : new Account(owner, opts);
    this.accounts.set(acct.id, acct);
    this.log.push(`open ${acct.id} ${owner}`);
    return acct;
  }
  get(id) {
    const a = this.accounts.get(id);
    if (!a) throw new LedgerError(`No account ${id}`, 'E_NOACCT');
    return a;
  }
  transfer(fromId, toId, amount, memo = 'transfer') {
    const from = this.get(fromId);
    const to = this.get(toId);
    const out = new Transaction(TX_KIND.TRANSFER_OUT, amount, memo, { to: toId });
    const inn = new Transaction(TX_KIND.TRANSFER_IN, amount, memo, { from: fromId });
    from._raw(out);
    try {
      to._raw(inn);
    } catch (e) {
      // compensate
      from._raw(new Transaction(TX_KIND.TRANSFER_IN, amount, 'reversal', { to: toId }));
      throw e;
    } finally {
      this.log.push(`transfer ${fromId}->${toId} ${amount}`);
    }
    return [out.id, inn.id];
  }
  execute(op) {
    const { type, account, amount, to, memo } = op;
    try {
      switch (type) {
        case 'dep':
          return this.get(account).deposit(amount, memo).id;
        case 'wd':
          return this.get(account).withdraw(amount, memo).id;
        case 'xfer':
          return this.transfer(account, to, amount, memo).join('+');
        case 'fee':
          return this.get(account).charge(amount, memo).id;
        case 'freeze':
          this.get(account).frozen = true;
          return 'frozen';
        case 'thaw':
          this.get(account).frozen = false;
          return 'thawed';
        default:
          throw new LedgerError(`Unknown op ${type}`, 'E_OP');
      }
    } catch (e) {
      if (e instanceof LedgerError) {
        this.errors.push({ op: type, code: e.code, msg: e.message, shortfall: e.shortfall ?? null });
        return `ERR(${e.code})`;
      }
      throw e;
    }
  }
  totals() {
    let sum = 0;
    const byType = {};
    for (const [, acct] of this.accounts) {
      sum += acct.balance;
      byType[acct.type] ||= 0;
      byType[acct.type] += acct.balance;
    }
    return { sum, byType };
  }
}

function summarize(acct) {
  const counts = {};
  for (const tx of acct.history) {
    counts[tx.kind] = (counts[tx.kind] ?? 0) + 1;
  }
  const parts = [];
  for (const k in counts) parts.push(`${k}=${counts[k]}`);
  return `${acct.id} [${acct.owner}] ${formatCents(acct.balance)} {${parts.join(', ')}}`;
}

function sumAll() {
  let total = 0;
  for (let i = 0; i < arguments.length; i++) total += arguments[i];
  return total;
}

function runScript(bank, ops) {
  const results = [];
  let i = 0;
  outer: for (const op of ops) {
    i++;
    if (op.type === 'halt') {
      console.log(`  op#${i} halt requested`);
      break outer;
    }
    const res = bank.execute(op);
    results.push(res);
    console.log(`  op#${i} ${op.type} ${op.account}${op.to ? '->' + op.to : ''} ${op.amount ?? ''} => ${res}`);
  }
  return results;
}

function main() {
  const bank = new Bank('Virtual Machine Bank');
  const alice = bank.open('checking', 'Alice', { overdraftLimit: 5000 });
  const bob = bank.open('checking', 'Bob');
  const carol = bank.open('savings', 'Carol', { rateBps: 240 });
  console.log(`Bank: ${bank.name}, accounts=${Account.count}`);
  console.log(money`Alice limit ${alice.overdraftLimit}, available ${alice.available}`);

  const ops = [
    { type: 'dep', account: alice.id, amount: 120000, memo: 'salary' },
    { type: 'dep', account: bob.id, amount: 4550, memo: 'gift' },
    { type: 'dep', account: carol.id, amount: 1000000, memo: 'inheritance' },
    { type: 'wd', account: bob.id, amount: 9000, memo: 'rent' },
    { type: 'xfer', account: alice.id, to: bob.id, amount: 30000, memo: 'loan' },
    { type: 'wd', account: bob.id, amount: 9000, memo: 'rent retry' },
    { type: 'fee', account: alice.id, amount: 250 },
    { type: 'wd', account: alice.id, amount: 95000, memo: 'car' },
    { type: 'wd', account: alice.id, amount: 1000, memo: 'coffee' },
    { type: 'freeze', account: bob.id },
    { type: 'dep', account: bob.id, amount: 100 },
    { type: 'xfer', account: carol.id, to: bob.id, amount: 2000 },
    { type: 'thaw', account: bob.id },
    { type: 'wd', account: carol.id, amount: 60000 },
    { type: 'wd', account: 'VMB999', amount: 1 },
    { type: 'dep', account: bob.id, amount: -5 },
    { type: 'bogus', account: bob.id },
    { type: 'xfer', account: carol.id, to: alice.id, amount: 40000, memo: 'help' },
    { type: 'halt' },
    { type: 'dep', account: bob.id, amount: 1, memo: 'never' },
  ];
  console.log('Running script:');
  const results = runScript(bank, ops);
  console.log(`results: ${results.length}, errors: ${bank.errors.length}`);

  for (const err of bank.errors) {
    const { op, code, shortfall } = err;
    console.log(`  error ${op} ${code}${shortfall !== null ? ' shortfall=' + formatCents(shortfall) : ''}`);
  }

  const interest = carol.accrue(6);
  console.log(money`Carol accrued ${interest} over 6 months, balance ${carol.balance}`);

  console.log('Statements:');
  for (const acct of [alice, bob, carol]) {
    console.log(`-- ${acct.id} (${acct.owner})`);
    for (const { tx, running } of acct.statement()) {
      console.log(`   ${tx.toString()} | ${formatCents(running)}`);
    }
  }

  const big = [...carol.statement((tx) => tx.amount >= 10000)].map(({ tx }) => tx.id);
  console.log('Carol big txs:', big.join(','));

  const sorted = [...bank.accounts.values()].sort(Account.compare);
  console.log('Ranking:', sorted.map((a) => `${a.owner}:${formatCents(a.balance)}`).join(' > '));

  for (const a of sorted) console.log(summarize(a));

  const { sum, byType } = bank.totals();
  console.log(money`Total holdings ${sum}`);
  console.log('By type:', JSON.stringify(byType));
  console.log('sumAll check:', sumAll(alice.balance, bob.balance, carol.balance) === sum);

  const audit = alice.history.map((t) => t[auditTag]);
  console.log('Alice audit tags:', audit.join(' '));

  const report = {
    bank: bank.name,
    accounts: sorted.map(({ id, owner, type, balance }) => ({ id, owner, type, balance })),
    log: bank.log.length,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log(formatCents(123456789), formatCents(-5), formatCents(0));
}

main();
