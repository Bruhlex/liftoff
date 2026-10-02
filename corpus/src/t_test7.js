// Testprogramm für die obfuscator.io VM-Obfuskierung.
// Deckt bewusst viele Sprachfeatures ab und ist deterministisch
// (kein Math.random, kein Date), damit man die Ausgabe von Original,
// obfuskierter und dekompilierter Version direkt vergleichen kann.

const log = [];
const out = (...parts) => log.push(parts.join(" "));

// ---------- Klassen: Vererbung, Getter/Setter, static, super ----------
class Account {
  static count = 0;

  constructor(owner, balance = 0) {
    this.owner = owner;
    this._balance = balance;
    this.history = [];
    Account.count++;
  }

  get balance() {
    return this._balance;
  }

  set balance(v) {
    if (v < 0) throw new RangeError(`negative balance for ${this.owner}`);
    this._balance = v;
  }

  deposit(amount) {
    this.balance += amount;
    this.history.push({ type: "deposit", amount });
    return this;
  }

  withdraw(amount) {
    this.balance -= amount;
    this.history.push({ type: "withdraw", amount });
    return this;
  }

  toString() {
    return `${this.owner}: ${this.balance.toFixed(2)}`;
  }

  static compare(a, b) {
    return a.balance - b.balance;
  }
}

class SavingsAccount extends Account {
  constructor(owner, balance, rate) {
    super(owner, balance);
    this.rate = rate;
  }

  addInterest(years = 1) {
    for (let i = 0; i < years; i++) {
      this.deposit(Math.round(this.balance * this.rate * 100) / 100);
    }
    return this;
  }

  toString() {
    return `${super.toString()} @ ${(this.rate * 100).toFixed(1)}%`;
  }
}

// ---------- Closures & Higher-Order Functions ----------
function makeCounter(start = 0, step = 1) {
  let value = start;
  return {
    next: () => (value += step),
    reset() {
      value = start;
    },
    get current() {
      return value;
    },
  };
}

const compose = (...fns) => (x) => fns.reduceRight((acc, f) => f(acc), x);
const memo = (fn) => {
  const cache = new Map();
  return (n) => {
    if (!cache.has(n)) cache.set(n, fn(n));
    return cache.get(n);
  };
};

const fib = memo((n) => (n < 2 ? n : fib(n - 1) + fib(n - 2)));

// ---------- Generatoren ----------
function* range(start, end, step = 1) {
  for (let i = start; i < end; i += step) yield i;
}

function* take(iter, n) {
  let i = 0;
  for (const v of iter) {
    if (i++ >= n) return;
    yield v;
  }
}

function* primes() {
  const found = [];
  let n = 2;
  while (true) {
    if (found.every((p) => n % p !== 0)) {
      found.push(n);
      yield n;
    }
    n++;
  }
}

// ---------- Destructuring, Spread, Rest, Optional Chaining, Nullish ----------
function describeUser({ name, age = "?", address: { city } = {}, ...rest }) {
  const extras = Object.keys(rest).sort().join(",") || "-";
  return `${name} (${age}) aus ${city ?? "unbekannt"} [${extras}]`;
}

function stats(first, ...others) {
  const all = [first, ...others];
  const [min, max] = [Math.min(...all), Math.max(...all)];
  const avg = all.reduce((a, b) => a + b, 0) / all.length;
  return { min, max, avg: +avg.toFixed(3) };
}

// ---------- Kontrollfluss: switch mit fallthrough, labels, do/while ----------
function classify(n) {
  switch (n % 4) {
    case 0:
      return "vier";
    case 1:
    case 3:
      return "ungerade";
    default:
      return "zwei";
  }
}

function findPair(matrix, target) {
  let result = null;
  outer: for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (matrix[i][j] < 0) continue outer;
      if (matrix[i][j] === target) {
        result = [i, j];
        break outer;
      }
    }
  }
  return result;
}

function digitSum(n) {
  let sum = 0;
  do {
    sum += n % 10;
    n = Math.floor(n / 10);
  } while (n > 0);
  return sum;
}

// ---------- Strings, Regex, Tagged Templates ----------
function highlight(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? `[${values[i]}]` : ""), "");
}

function wordStats(text) {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, 3)
    .map(([w, c]) => `${w}=${c}`)
    .join(" ");
}

// ---------- Fehlerbehandlung ----------
class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function validate(input) {
  const errors = [];
  let checked = 0;
  for (const [field, value] of Object.entries(input)) {
    try {
      checked++;
      if (typeof value !== "number") throw new ValidationError(field, "keine Zahl");
      if (value < 0) throw new ValidationError(field, "negativ");
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      errors.push(`${e.field}: ${e.message}`);
    } finally {
      if (checked > 10) break;
    }
  }
  return errors;
}

// ---------- Symbol, BigInt, Map/Set, Objekt-Features ----------
const TAG = Symbol("tag");
const inventory = {
  [TAG]: "lager",
  items: new Map([
    ["apfel", 3],
    ["birne", 0],
    ["kiwi", 7],
  ]),
  get total() {
    let t = 0;
    for (const [, n] of this.items) t += n;
    return t;
  },
};

function factorialBig(n) {
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return r;
}

// ---------- async / await ----------
const delay = (value) => new Promise((resolve) => resolve(value));

async function pipeline(values) {
  const results = [];
  for (const v of values) {
    const x = await delay(v * 2);
    results.push(x);
  }
  const all = await Promise.all(values.map(async (v) => (await delay(v)) + 1));
  return { results, all };
}

// ---------- main ----------
async function main() {
  const a = new Account("Anna", 100).deposit(50).withdraw(30);
  const s = new SavingsAccount("Ben", 1000, 0.05).addInterest(3);
  out("konten:", a.toString(), "|", s.toString());
  out("anzahl:", Account.count, "sortiert:", [s, a].sort(Account.compare).map((x) => x.owner).join(","));
  try {
    a.withdraw(1000);
  } catch (e) {
    out("fehler:", e.name, e.message);
  }
  out("history:", s.history.map(({ type, amount }) => `${type[0]}${amount}`).join(" "));

  const c = makeCounter(10, 5);
  c.next();
  c.next();
  out("counter:", c.current);
  c.reset();
  out("reset:", c.current);

  const inc = (x) => x + 1;
  const dbl = (x) => x * 2;
  out("compose:", compose(inc, dbl)(5), compose(dbl, inc)(5));
  out("fib:", [10, 20, 30, 50].map(fib).join(","));

  out("range:", [...range(0, 20, 3)].join(","));
  out("primes:", [...take(primes(), 10)].join(","));

  out("user:", describeUser({ name: "Clara", age: 31, address: { city: "Berlin" }, role: "admin", id: 7 }));
  out("user:", describeUser({ name: "Dan" }));
  out("stats:", JSON.stringify(stats(4, 8, 15, 16, 23, 42)));

  out("classify:", [0, 1, 2, 3, 4, 7].map(classify).join(","));
  out("pair:", JSON.stringify(findPair([[1, 2, 3], [-1, 9, 9], [4, 9, 6]], 9)));
  out("digitSum:", digitSum(987654321));

  const who = "Welt";
  const n = 3;
  out("tagged:", highlight`Hallo ${who}, du hast ${n} Nachrichten`);
  out("words:", wordStats("Der Hund und der Kater und der Vogel. Der Vogel singt!"));

  out("validate:", validate({ a: 1, b: -2, c: "x", d: 4 }).join("; "));

  out("symbol:", inventory[TAG], "total:", inventory.total);
  const inStock = [...inventory.items].filter(([, n]) => n > 0).map(([k]) => k);
  out("lager:", inStock.join(","), "unique:", [...new Set("mississippi")].join(""));
  out("bigint:", factorialBig(25).toString());

  const { results, all } = await pipeline([1, 2, 3]);
  out("async:", results.join(","), all.join(","));

  const config = { debug: false, level: 2, nested: { deep: { value: 42 } } };
  out("optional:", config.nested?.deep?.value, config.missing?.deep?.value ?? "default");
  const { debug, ...restConfig } = config;
  out("rest:", debug, Object.keys(restConfig).join(","));

  console.log(log.join("\n"));
}

main();
