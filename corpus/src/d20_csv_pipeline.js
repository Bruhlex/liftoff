// d20: streaming CSV parser + aggregation pipeline built from async iterators
'use strict';

// ---------------------------------------------------------------------------
// Deterministic data generation
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['north', 'south', 'east', 'west'];
const PRODUCTS = ['widget', 'gadget', 'doohickey, deluxe', 'thing "pro"', 'gizmo'];

function quoteField(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function generateCsv(rows, seed = 7) {
  const rnd = mulberry32(seed);
  const lines = ['id,date,region,product,qty,price,note'];
  for (let i = 1; i <= rows; i++) {
    const day = 1 + Math.floor(rnd() * 28);
    const month = 1 + Math.floor(rnd() * 3);
    const region = REGIONS[Math.floor(rnd() * REGIONS.length)];
    const product = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)];
    let qty = Math.floor(rnd() * 20) - 2;
    const price = (Math.floor(rnd() * 10000) / 100).toFixed(2);
    let note = '';
    const r = rnd();
    if (r < 0.1) note = 'multi\nline';
    else if (r < 0.2) note = 'has, comma';
    else if (r < 0.25) qty = 'N/A';
    else if (r < 0.28) note = 'quote "inside"';
    lines.push([i, `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, region, product, qty, price, note].map(quoteField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Chunk source: async generator splitting text into irregular chunks
// ---------------------------------------------------------------------------
async function* chunkSource(text, sizes) {
  let pos = 0, k = 0;
  try {
    while (pos < text.length) {
      const n = sizes[k++ % sizes.length];
      await null;
      yield text.slice(pos, pos + n);
      pos += n;
    }
    return pos;
  } finally {
    chunkSource.closed = (chunkSource.closed ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Streaming CSV tokenizer: state machine, chars across chunk boundaries
// ---------------------------------------------------------------------------
class CsvSyntaxError extends Error {
  constructor(msg, line, col) {
    super(`${msg} at ${line}:${col}`);
    this.line = line;
    this.col = col;
  }
}

const S = Object.freeze({ FIELD_START: 0, UNQUOTED: 1, QUOTED: 2, QUOTE_IN_QUOTED: 3, CR: 4 });

async function* parseCsv(chunks, { delimiter = ',', strict = true } = {}) {
  let state = S.FIELD_START, field = '', row = [], line = 1, col = 0, rowsOut = 0;
  const endField = () => { row.push(field); field = ''; };
  for await (const chunk of chunks) {
    let i = 0;
    charLoop: while (i < chunk.length) {
      const ch = chunk[i++];
      col++;
      switch (state) {
        case S.CR:
          state = S.FIELD_START;
          if (ch === '\n') continue charLoop;
        // fallthrough: CR without LF, treat ch as start of new field
        case S.FIELD_START:
          if (ch === '"') { state = S.QUOTED; continue charLoop; }
        // fallthrough
        case S.UNQUOTED:
          if (ch === delimiter) { endField(); state = S.FIELD_START; break; }
          if (ch === '\r' || ch === '\n') {
            endField();
            rowsOut++;
            yield row;
            row = [];
            line++; col = 0;
            state = ch === '\r' ? S.CR : S.FIELD_START;
            break;
          }
          if (ch === '"' && strict) throw new CsvSyntaxError('stray quote', line, col);
          field += ch;
          state = S.UNQUOTED;
          break;
        case S.QUOTED:
          if (ch === '"') state = S.QUOTE_IN_QUOTED;
          else { if (ch === '\n') { line++; col = 0; } field += ch; }
          break;
        case S.QUOTE_IN_QUOTED:
          if (ch === '"') { field += '"'; state = S.QUOTED; break; }
          state = S.UNQUOTED;
          i--; col--;
          if (ch !== delimiter && ch !== '\r' && ch !== '\n') {
            if (strict) throw new CsvSyntaxError('garbage after quote', line, col + 1);
            i++; col++; field += ch;
          }
          break;
        default:
          throw new Error('bad state ' + state);
      }
    }
  }
  if (state === S.QUOTED) throw new CsvSyntaxError('unterminated quote', line, col);
  if (field !== '' || row.length) { endField(); rowsOut++; yield row; }
  return rowsOut;
}

// ---------------------------------------------------------------------------
// Pipeline operators (async generator combinators)
// ---------------------------------------------------------------------------
async function* withHeader(rows) {
  let header = null;
  for await (const r of rows) {
    if (!header) { header = r.map((h) => h.trim()); continue; }
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    yield obj;
  }
}

const mapA = (fn) => async function* (src) { let i = 0; for await (const x of src) yield await fn(x, i++); };
const filterA = (pred) => async function* (src) { for await (const x of src) if (await pred(x)) yield x; };
const tapA = (fn) => async function* (src) { for await (const x of src) { fn(x); yield x; } };
const takeA = (n) => async function* (src) {
  if (n <= 0) return;
  let i = 0;
  for await (const x of src) {
    yield x;
    if (++i >= n) return;
  }
};
const batchA = (n) => async function* (src) {
  let b = [];
  for await (const x of src) { b.push(x); if (b.length === n) { yield b; b = []; } }
  if (b.length) yield b;
};

function pipe(src, ...ops) { return ops.reduce((acc, op) => op(acc), src); }

async function collect(src) { const out = []; for await (const x of src) out.push(x); return out; }

// Validation / typing with error side channel
class RowError extends Error {
  constructor(row, field, reason) {
    super(`row ${row.id ?? '?'}: ${field} ${reason}`);
    Object.assign(this, { row, field, reason });
  }
}

function typedRow(errors) {
  return async function* (src) {
    for await (const raw of src) {
      try {
        const { id, date, qty, price, ...rest } = raw;
        const n = Number(qty);
        if (!Number.isInteger(n)) throw new RowError(raw, 'qty', 'not integer');
        if (n < 0) throw new RowError(raw, 'qty', 'negative');
        const m = /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})$/.exec(date);
        if (!m) throw new RowError(raw, 'date', 'bad format');
        const cents = BigInt(price.replace('.', ''));
        yield { id: +id, month: +m.groups.mo, day: +m.groups.d, qty: n, cents, ...rest };
      } catch (e) {
        if (!(e instanceof RowError)) throw e;
        errors.push(e.message);
        continue;
      } finally {
        typedRow.seen = (typedRow.seen || 0) + 1;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Aggregators: class hierarchy
// ---------------------------------------------------------------------------
class Aggregator {
  #count = 0;
  constructor(name) {
    if (new.target === Aggregator) throw new TypeError('abstract aggregator');
    this.label = name;
  }
  get count() { return this.#count; }
  add(row) { this.#count++; this.accept(row); return this; }
  accept() {}
  result() { return { label: this.label, count: this.#count }; }
  static combine(...aggs) { return new CompositeAggregator(aggs); }
}

class SumAggregator extends Aggregator {
  #sum = 0n;
  constructor(name, getter) { super(name); this.getter = getter; }
  accept(row) { this.#sum += BigInt(this.getter(row)); }
  get sum() { return this.#sum; }
  result() { return { ...super.result(), sum: this.#sum.toString() }; }
}

class GroupAggregator extends Aggregator {
  #groups = new Map();
  static #factories = 0;
  constructor(name, keyFn, makeInner) {
    super(name);
    this.keyFn = keyFn;
    this.makeInner = makeInner;
    GroupAggregator.#factories++;
  }
  static get factories() { return GroupAggregator.#factories; }
  accept(row) {
    const k = this.keyFn(row);
    let g = this.#groups.get(k);
    if (!g) this.#groups.set(k, (g = this.makeInner(k)));
    g.add(row);
  }
  result() {
    const groups = {};
    for (const k of [...this.#groups.keys()].sort()) groups[k] = this.#groups.get(k).result();
    return { ...super.result(), groups };
  }
  has(k) { return this.#groups.has(k); }
}

class StatsAggregator extends SumAggregator {
  #min = Infinity;
  #max = -Infinity;
  #sq = 0;
  accept(row) {
    super.accept(row);
    const v = Number(this.getter(row));
    this.#min = Math.min(this.#min, v);
    this.#max = Math.max(this.#max, v);
    this.#sq += v * v;
  }
  #mean() { return this.count ? Number(this.sum) / this.count : 0; }
  result() {
    const mean = this.#mean();
    const variance = this.count ? this.#sq / this.count - mean * mean : 0;
    return { ...super.result(), min: this.#min, max: this.#max, mean: +mean.toFixed(3), sd: +Math.sqrt(Math.max(0, variance)).toFixed(3) };
  }
  static isStats(o) { return #min in o; }
}

class TopKAggregator extends Aggregator {
  constructor(name, k, scoreFn) { super(name); this.k = k; this.scoreFn = scoreFn; this.heap = []; }
  accept(row) {
    const s = this.scoreFn(row);
    this.heap.push([s, row.id]);
    this.heap.sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : a[1] - b[1]));
    if (this.heap.length > this.k) this.heap.length = this.k;
  }
  result() { return { ...super.result(), top: this.heap.map(([s, id]) => `${id}:${s}`) }; }
}

class CompositeAggregator extends Aggregator {
  constructor(parts) { super('composite'); this.parts = parts; }
  accept(row) { for (const p of this.parts) p.add(row); }
  result() { return Object.fromEntries(this.parts.map((p) => [p.label, p.result()])); }
  *[Symbol.iterator]() { yield* this.parts; }
}

// ---------------------------------------------------------------------------
// Formatting helpers: tagged templates, toPrimitive money
// ---------------------------------------------------------------------------
class Money {
  constructor(cents) { this.cents = BigInt(cents); }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return Number(this.cents) / 100;
    const neg = this.cents < 0n;
    const abs = neg ? -this.cents : this.cents;
    const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    return `${neg ? '-' : ''}$${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
  }
  static [Symbol.hasInstance](x) { return typeof x?.cents === 'bigint'; }
}

function fmt(strings, ...vals) {
  return strings.reduce((acc, s, i) => {
    let v = vals[i - 1];
    if (typeof v === 'bigint') v = new Money(v);
    else if (typeof v === 'number' && !Number.isInteger(v)) v = v.toFixed(2);
    else if (v && typeof v === 'object' && !(v instanceof Money)) v = JSON.stringify(v);
    return acc + `${v}` + s;
  });
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join(' | ');
  return [line(cols), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map((r) => line(cols.map((c) => r[c] ?? '')))];
}

// ---------------------------------------------------------------------------
// Merge of multiple async sources with deterministic round-robin
// ---------------------------------------------------------------------------
async function* roundRobin(...sources) {
  const its = sources.map((s) => s[Symbol.asyncIterator]());
  const active = new Set(its.keys());
  while (active.size) {
    for (const i of [...active]) {
      const { value, done } = await its[i].next();
      if (done) { active.delete(i); continue; }
      yield [i, value];
    }
  }
}

// Promise-queue with concurrency limit (microtask ordering)
async function mapConcurrent(items, limit, fn, trace) {
  const results = new Array(items.length);
  let next = 0;
  async function worker(w) {
    while (next < items.length) {
      const idx = next++;
      trace.push(`w${w}>${idx}`);
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, (_, w) => worker(w)));
  return results;
}

// JSON with BigInt replacer/reviver
const bigReplacer = (k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const bigReviver = (k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v);

// Recursion: deep nested JSON-like path sum
function deepNest(n) { let o = { v: 0 }; for (let i = 1; i <= n; i++) o = { v: i, child: o }; return o; }
function deepSum(o) { return o ? o.v + deepSum(o.child) : 0; }

// sloppy-style arguments use (allowed in strict for reading)
function avgArgs() {
  if (!arguments.length) return NaN;
  let s = 0;
  for (const a of arguments) s += a;
  return s / arguments.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('== d20 csv pipeline ==');
  const csv = generateCsv(60);
  console.log('csv length: ' + csv.length + ' lines(raw)=' + csv.split('\r\n').length);
  console.log('csv head: ' + JSON.stringify(csv.slice(0, 160)));

  // Parse with irregular chunk boundaries - result must be identical for all splits
  const splits = [[1], [7, 3], [64], [csv.length], [5, 17, 2, 11]];
  const digests = [];
  for (const sizes of splits) {
    const rows = await collect(parseCsv(chunkSource(csv, sizes)));
    const digest = rows.reduce((h, r) => (Math.imul(h, 31) + r.join('\u0001').length) | 0, 7);
    digests.push(digest);
    console.log(`split ${JSON.stringify(sizes)}: rows=${rows.length} digest=${digest} lastId=${rows.at(-1)[0]}`);
  }
  console.log('all splits equal: ' + digests.every((d) => d === digests[0]) + ' sources closed=' + chunkSource.closed);

  // Edge cases
  const edge = [
    'a,b,c\n1,2,3',
    'x\r\ny\rz\n',
    '"q ""x"" y",,"",end\n',
    'one,"multi\nline",two\n',
    ',,\n',
    '"unterminated',
    'bad"quote\n',
    '"ok"junk,1\n',
  ];
  for (const [i, text] of edge.entries()) {
    try {
      const rows = await collect(parseCsv(chunkSource(text, [3])));
      console.log(`edge${i}: ${JSON.stringify(rows)}`);
    } catch (e) {
      const { line, col, message } = e;
      console.log(`edge${i}: ${e instanceof CsvSyntaxError ? 'syntax' : 'other'} ${message} (${line}/${col})`);
    }
  }
  {
    const loose = await collect(parseCsv(chunkSource('"ok"junk,1\n', [2]), { strict: false }));
    console.log('loose: ' + JSON.stringify(loose));
    const semi = await collect(parseCsv(chunkSource('a;b;"c;d"\n', [4]), { delimiter: ';' }));
    console.log('semicolon: ' + JSON.stringify(semi));
  }

  // Full pipeline
  const errors = [];
  const seenRegions = new Set();
  const typed = await collect(pipe(
    parseCsv(chunkSource(csv, [13, 29])),
    withHeader,
    typedRow(errors),
    tapA((r) => seenRegions.add(r.region)),
  ));
  console.log(`typed rows: ${typed.length} errors=${errors.length} seen=${typedRow.seen} regions=${[...seenRegions].sort().join(',')}`);
  for (const e of errors.slice(0, 6)) console.log('  error: ' + e);
  console.log('first typed: ' + JSON.stringify(typed[0], bigReplacer));

  const revenue = (r) => r.cents * BigInt(r.qty);
  const agg = Aggregator.combine(
    new SumAggregator('revenue', revenue),
    new StatsAggregator('qty', (r) => r.qty),
    new GroupAggregator('byRegion', (r) => r.region, (k) => new SumAggregator(k, revenue)),
    new GroupAggregator('byMonth', (r) => 'm' + r.month, (k) => new StatsAggregator(k, (r) => r.qty)),
    new GroupAggregator('byProduct', (r) => r.product, (k) => new GroupAggregator(k, (r) => r.region, () => new SumAggregator('q', (r) => r.qty))),
    new TopKAggregator('topRevenue', 5, revenue),
  );
  for (const r of typed) agg.add(r);
  const res = agg.result();
  console.log('revenue: ' + fmt`total=${res.revenue.sum ? BigInt(res.revenue.sum) : 0n} rows=${res.revenue.count}`);
  console.log('qty stats: ' + JSON.stringify(res.qty));
  for (const [region, g] of Object.entries(res.byRegion.groups)) console.log(fmt`  region ${region}: ${BigInt(g.sum)} over ${g.count}`);
  for (const [m, g] of Object.entries(res.byMonth.groups)) console.log(`  month ${m}: ${JSON.stringify(g)}`);
  for (const [p, g] of Object.entries(res.byProduct.groups)) {
    const regs = Object.entries(g.groups).map(([k, v]) => `${k}=${v.sum}`).join(' ');
    console.log(`  product ${JSON.stringify(p)}: n=${g.count} ${regs}`);
  }
  console.log('top: ' + res.topRevenue.top.join(', '));
  console.log('isStats: ' + [...agg].map((a) => StatsAggregator.isStats(a)).join(',') + ' groupFactories=' + GroupAggregator.factories);
  try { new Aggregator('x'); } catch (e) { console.log('abstract: ' + e.message); }

  // Table output
  const tableRows = Object.entries(res.byRegion.groups).map(([region, g]) => ({ region, count: g.count, revenue: `${new Money(BigInt(g.sum))}` }));
  for (const l of table(tableRows, ['region', 'count', 'revenue'])) console.log('  ' + l);

  // Money primitive conversions
  const m = new Money(-123456789n);
  console.log(`money: ${m} num=${+m} inst=${m instanceof Money} ${({ cents: 5n }) instanceof Money} ${({ cents: 5 }) instanceof Money}`);

  // Filter / take / batch with early termination (return() propagates to source)
  const before = chunkSource.closed;
  const firstBig = await collect(pipe(
    parseCsv(chunkSource(csv, [50])),
    withHeader,
    typedRow([]),
    filterA(async (r) => { await null; return r.qty > 10; }),
    mapA((r, i) => `${i}:${r.id}:${r.qty}`),
    takeA(4),
  ));
  console.log('first big: ' + firstBig.join(' ') + ' closedDelta=' + (chunkSource.closed - before));
  const batches = await collect(pipe(parseCsv(chunkSource(csv, [100])), withHeader, mapA((r) => +r.id), batchA(16)));
  console.log('batches: ' + batches.map((b) => `${b[0]}..${b.at(-1)}(${b.length})`).join(' '));

  // Round-robin merge of two parsers
  const merged = [];
  for await (const [src, row] of roundRobin(
    parseCsv(chunkSource('a,1\nb,2\nc,3\n', [4])),
    parseCsv(chunkSource('X,9\nY,8\n', [2])),
    takeA(2)(parseCsv(chunkSource('p\nq\nr\ns\n', [1]))),
  )) merged.push(`${src}:${row[0]}`);
  console.log('round robin: ' + merged.join(','));

  // Concurrency-limited mapping, deterministic trace
  const trace = [];
  const sizes = await mapConcurrent(['north', 'south', 'east', 'west', 'extra'], 2, async (region, idx) => {
    for (let k = 0; k < (idx % 3); k++) await null;
    trace.push(`done${idx}`);
    return typed.filter((r) => r.region === region).length;
  }, trace);
  console.log('concurrent sizes: ' + sizes.join(',') + ' trace=' + trace.join(','));

  // Promise combinators
  const settled = await Promise.allSettled([
    collect(parseCsv(chunkSource('"x', [1]))),
    collect(parseCsv(chunkSource('ok\n', [1]))),
  ]);
  console.log('settled: ' + settled.map((s) => (s.status === 'fulfilled' ? 'ok:' + JSON.stringify(s.value) : 'err:' + s.reason.constructor.prototype.constructor === CsvSyntaxError)).join(' | '));
  const firstDone = await Promise.race([
    collect(parseCsv(chunkSource('slow,row\n', [1]))),
    collect(parseCsv(chunkSource('fast\n', [100]))),
  ]);
  console.log('race winner: ' + JSON.stringify(firstDone));
  try {
    await Promise.any([Promise.reject(new RowError({ id: 1 }, 'x', 'y')), collect(parseCsv(chunkSource('"', [1])))]);
  } catch (e) {
    console.log('any failed: ' + (e instanceof AggregateError) + ' ' + e.errors.map((x) => x.message).join(' / '));
  }

  // JSON round-trip with BigInt
  const snapshot = JSON.stringify({ total: BigInt(res.revenue.sum), groups: res.byRegion.groups, when: undefined }, bigReplacer);
  const back = JSON.parse(snapshot, bigReviver);
  console.log('snapshot: ' + snapshot.slice(0, 120));
  console.log('revived total is bigint: ' + (typeof back.total === 'bigint') + ' eq=' + (back.total === BigInt(res.revenue.sum)) + ' hasWhen=' + ('when' in back));

  // Labeled loop scanning for a pattern across rows, with finally
  let found = null;
  scan: for (const [i, row] of typed.entries()) {
    try {
      for (const key of Object.keys(row)) {
        if (key === 'note' && row[key].includes('\n')) { found = `${i}:${row.id}`; break scan; }
        if (key === 'cents' && row.cents === 0n) continue scan;
      }
    } finally {
      if (i > 1000) found = 'overflow';
    }
  }
  console.log('first multiline note: ' + found);

  // Closures capturing loop variables
  const getters = [];
  for (const region of REGIONS) getters.push(() => region + '=' + typed.filter((r) => r.region === region).length);
  for (let i = 0; i < 3; i++) getters.push(() => 'i' + i);
  for (const k in res.qty) if (typeof res.qty[k] === 'number') getters.push(() => k);
  console.log('closures: ' + getters.map((g) => g()).join(','));

  // Optional chaining & logical assignment
  const opts = { output: { format: null }, limits: {} };
  opts.output.format ??= 'table';
  opts.limits.rows ||= 100;
  opts.limits.rows &&= opts.limits.rows * 2;
  opts.debug?.enable?.();
  console.log('opts: ' + JSON.stringify(opts) + ' ' + (opts.missing?.deep ?? 'none') + ' ' + (opts.output?.['format']?.toUpperCase?.() ?? ''));

  console.log('deep recursion: ' + deepSum(deepNest(3000)));
  console.log('avgArgs: ' + avgArgs(1, 2, 3, 4) + ' ' + avgArgs());
  console.log('typeof checks: ' + [typeof 1n, typeof Money, typeof void 0, typeof null, 'cents' in m, delete opts.limits.rows, JSON.stringify(opts.limits)].join(','));

  // Proxy wrapping a row object for auditing access
  const accessed = [];
  const audited = new Proxy(typed[0], {
    get(t, k, r) { if (typeof k === 'string') accessed.push(k); return Reflect.get(t, k, r); },
    ownKeys(t) { return Reflect.ownKeys(t).filter((k) => k !== 'note'); },
  });
  const { region, product, ...others } = audited;
  console.log('audited: ' + region + ' ' + product + ' rest=' + Object.keys(others).join(',') + ' accessed=' + accessed.join(','));
  return typed.length;
}

main()
  .then((n) => console.log('== d20 end (' + n + ') =='))
  .catch((e) => console.log('main failed: ' + e.message));
