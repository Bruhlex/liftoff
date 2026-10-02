// d18: game AI - minimax with alpha-beta + transposition table for connect-four
// (sloppy mode on purpose: uses `arguments` aliasing)

var ROWS = 6, COLS = 7, WIN = 4;
var EMPTY = 0, P1 = 1, P2 = 2;

// ---------------------------------------------------------------------------
// Deterministic RNG + Zobrist keys (two 32-bit halves)
// ---------------------------------------------------------------------------
function Lcg(seed) {
  if (!new.target) return new Lcg(seed);
  this.s = seed >>> 0;
}
Lcg.prototype.next = function () {
  this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
  return this.s;
};

const ZOB = (function () {
  const rng = Lcg(0xc0ffee);
  const keys = [];
  for (let c = 0; c < ROWS * COLS; c++) {
    keys.push([null, [rng.next(), rng.next()], [rng.next(), rng.next()]]);
  }
  return { keys, side: [rng.next(), rng.next()] };
})();

// ---------------------------------------------------------------------------
// Board with private state, symbols, accessors
// ---------------------------------------------------------------------------
class BaseBoard {
  static #created = 0;
  constructor(rows, cols) {
    if (new.target === BaseBoard) throw new TypeError('abstract board');
    this.rows = rows;
    this.cols = cols;
    BaseBoard.#created++;
  }
  static get created() { return BaseBoard.#created; }
  get size() { return this.rows * this.cols; }
  describe() { return `${this.rows}x${this.cols}`; }
}

class GridBoard extends BaseBoard {
  constructor(rows, cols) {
    super(rows, cols);
    this.cells = new Array(rows * cols).fill(EMPTY);
    this.heights = new Array(cols).fill(0);
  }
  idx(r, c) { return r * this.cols + c; }
  at(r, c) { return this.cells[this.idx(r, c)]; }
  describe() { return 'grid ' + super.describe(); }
  *[Symbol.iterator]() {
    for (let r = this.rows - 1; r >= 0; r--) {
      let line = '';
      for (let c = 0; c < this.cols; c++) line += '.XO'[this.at(r, c)];
      yield line;
    }
  }
}

class C4Board extends GridBoard {
  #moves = [];
  #hash = [0, 0];
  #turn = P1;
  static {
    C4Board.ORDER = [3, 2, 4, 1, 5, 0, 6];
  }
  constructor() {
    super(ROWS, COLS);
  }
  get turn() { return this.#turn; }
  get moveCount() { return this.#moves.length; }
  get history() { return this.#moves.join(''); }
  get key() { return (this.#hash[0] >>> 0).toString(36) + ':' + (this.#hash[1] >>> 0).toString(36); }
  get [Symbol.toStringTag]() { return 'C4Board'; }
  static [Symbol.hasInstance](obj) { return obj != null && #moves in obj; }
  describe() { return 'c4 ' + super.describe() + ' moves=' + this.moveCount; }
  canPlay(c) { return c >= 0 && c < COLS && this.heights[c] < ROWS; }
  #xor(i, p) {
    const k = ZOB.keys[i][p];
    this.#hash[0] ^= k[0];
    this.#hash[1] ^= k[1];
  }
  #flipSide() {
    this.#hash[0] ^= ZOB.side[0];
    this.#hash[1] ^= ZOB.side[1];
    this.#turn = 3 - this.#turn;
  }
  play(c) {
    if (!this.canPlay(c)) throw new RangeError('column full or invalid: ' + c);
    const r = this.heights[c]++;
    const i = this.idx(r, c);
    this.cells[i] = this.#turn;
    this.#xor(i, this.#turn);
    this.#moves.push(c);
    this.#flipSide();
    return r;
  }
  undo() {
    const c = this.#moves.pop();
    if (c === undefined) throw new Error('nothing to undo');
    this.#flipSide();
    const r = --this.heights[c];
    const i = this.idx(r, c);
    this.#xor(i, this.cells[i]);
    this.cells[i] = EMPTY;
    return c;
  }
  isWinningMove(c) {
    if (!this.canPlay(c)) return false;
    const p = this.#turn, r = this.heights[c];
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (const s of [1, -1]) {
        let rr = r + dr * s, cc = c + dc * s;
        while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && this.at(rr, cc) === p) {
          count++;
          rr += dr * s;
          cc += dc * s;
        }
      }
      if (count >= WIN) return true;
    }
    return false;
  }
  winner() {
    const lines = [[0, 1], [1, 0], [1, 1], [1, -1]];
    scan: for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.at(r, c);
        if (p === EMPTY) continue;
        dirs: for (const [dr, dc] of lines) {
          for (let k = 1; k < WIN; k++) {
            const rr = r + dr * k, cc = c + dc * k;
            if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue dirs;
            if (this.at(rr, cc) !== p) continue dirs;
          }
          return p;
        }
      }
      if (r > ROWS) break scan;
    }
    return this.moveCount === this.size ? 0 : null;
  }
  clone() {
    const b = new C4Board();
    for (const c of this.#moves) b.play(c);
    return b;
  }
  static from(seq) {
    const b = new C4Board();
    for (const ch of String(seq)) b.play(+ch);
    return b;
  }
}

// ---------------------------------------------------------------------------
// Heuristic evaluation (window scoring)
// ---------------------------------------------------------------------------
const WINDOW_SCORES = { 4: 100000, 3: 50, 2: 5 };
function scoreWindow(a, b, c, d, me) {
  const opp = 3 - me;
  let mine = 0, theirs = 0, empty = 0;
  for (let i = 0; i < arguments.length - 1; i++) {
    const v = arguments[i];
    v === me ? mine++ : v === opp ? theirs++ : empty++;
  }
  if (mine && theirs) return 0;
  if (mine) return WINDOW_SCORES[mine] ?? 1;
  if (theirs) return -(WINDOW_SCORES[theirs] ?? 1) * (theirs === 3 ? 1.5 : 1);
  return 0;
}

function evaluate(board, me) {
  let score = 0;
  for (let r = 0; r < ROWS; r++) score += (board.at(r, 3) === me ? 6 : board.at(r, 3) === 3 - me ? -6 : 0);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 3 < COLS) score += scoreWindow(board.at(r, c), board.at(r, c + 1), board.at(r, c + 2), board.at(r, c + 3), me);
      if (r + 3 < ROWS) score += scoreWindow(board.at(r, c), board.at(r + 1, c), board.at(r + 2, c), board.at(r + 3, c), me);
      if (r + 3 < ROWS && c + 3 < COLS) score += scoreWindow(board.at(r, c), board.at(r + 1, c + 1), board.at(r + 2, c + 2), board.at(r + 3, c + 3), me);
      if (r + 3 < ROWS && c - 3 >= 0) score += scoreWindow(board.at(r, c), board.at(r + 1, c - 1), board.at(r + 2, c - 2), board.at(r + 3, c - 3), me);
    }
  }
  return Math.round(score);
}

// ---------------------------------------------------------------------------
// Transposition table
// ---------------------------------------------------------------------------
const EXACT = 0, LOWER = 1, UPPER = 2;
class TranspositionTable {
  #map = new Map();
  #cap;
  constructor(cap = 50000) {
    this.#cap = cap;
    this.hits = 0;
    this.stores = 0;
    this.evictions = 0;
  }
  get size() { return this.#map.size; }
  probe(key, depth, alpha, beta) {
    const e = this.#map.get(key);
    if (!e || e.depth < depth) return e ? { move: e.move } : null;
    this.hits++;
    switch (e.flag) {
      case EXACT: return { value: e.value, move: e.move };
      case LOWER: if (e.value >= beta) return { value: e.value, move: e.move }; break;
      case UPPER: if (e.value <= alpha) return { value: e.value, move: e.move }; break;
      default: throw new Error('corrupt tt');
    }
    return { move: e.move };
  }
  store(key, depth, value, flag, move) {
    if (this.#map.size >= this.#cap && !this.#map.has(key)) {
      const first = this.#map.keys().next().value;
      this.#map.delete(first);
      this.evictions++;
    }
    this.stores++;
    this.#map.set(key, { depth, value, flag, move });
  }
  clear() { this.#map.clear(); }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
class SearchAbort extends Error {
  constructor(nodes) { super('node budget exhausted at ' + nodes); this.nodes = nodes; }
}

class Searcher {
  constructor({ maxDepth = 6, nodeBudget = 400000, tt = new TranspositionTable() } = {}) {
    this.maxDepth = maxDepth;
    this.nodeBudget = nodeBudget;
    this.tt = tt;
    this.nodes = 0;
    this.killers = Array.from({ length: 64 }, () => [-1, -1]);
    this.historyTable = new Array(COLS).fill(0);
  }
  orderMoves(board, ply, ttMove) {
    const moves = C4Board.ORDER.filter((c) => board.canPlay(c));
    const k = this.killers[ply];
    const rank = (c) => (c === ttMove ? -1e9 : 0) + (k.includes(c) ? -1e6 : 0) - this.historyTable[c];
    return moves.sort((a, b) => rank(a) - rank(b) || C4Board.ORDER.indexOf(a) - C4Board.ORDER.indexOf(b));
  }
  negamax(board, depth, alpha, beta, ply) {
    if (++this.nodes > this.nodeBudget) throw new SearchAbort(this.nodes);
    const alpha0 = alpha;
    const me = board.turn;
    for (const c of C4Board.ORDER) {
      if (board.isWinningMove(c)) return { value: 1000000 - ply, move: c };
    }
    if (board.moveCount >= ROWS * COLS - 1) return { value: 0, move: C4Board.ORDER.find((c) => board.canPlay(c)) ?? -1 };
    if (depth === 0) return { value: evaluate(board, me), move: -1 };
    const key = board.key;
    const hit = this.tt.probe(key, depth, alpha, beta);
    if (hit?.value !== undefined) return hit;
    let best = -Infinity, bestMove = -1;
    const moves = this.orderMoves(board, ply, hit?.move);
    moveLoop: for (const c of moves) {
      board.play(c);
      let v;
      try {
        v = -this.negamax(board, depth - 1, -beta, -alpha, ply + 1).value;
      } finally {
        board.undo();
      }
      if (v > best) { best = v; bestMove = c; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) {
        const k = this.killers[ply];
        if (k[0] !== c) { k[1] = k[0]; k[0] = c; }
        this.historyTable[c] += depth * depth;
        break moveLoop;
      }
    }
    const flag = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT;
    this.tt.store(key, depth, best, flag, bestMove);
    return { value: best, move: bestMove };
  }
  *iterate(board) {
    let result = { value: 0, move: C4Board.ORDER.find((c) => board.canPlay(c)), depth: 0 };
    for (let d = 1; d <= this.maxDepth; d++) {
      const snapshot = board.history;
      try {
        const r = this.negamax(board, d, -Infinity, Infinity, 0);
        result = { ...r, depth: d };
        yield result;
        if (Math.abs(r.value) > 900000) return result;
      } catch (e) {
        if (!(e instanceof SearchAbort)) throw e;
        while (board.history.length > snapshot.length) board.undo();
        return { ...result, aborted: true };
      }
    }
    return result;
  }
  best(board) {
    const it = this.iterate(board);
    let r, last;
    while (!(r = it.next()).done) last = r.value;
    return r.value ?? last;
  }
}

// ---------------------------------------------------------------------------
// Players (object literal with super via setPrototypeOf)
// ---------------------------------------------------------------------------
const basePlayer = {
  label: 'base',
  choose(board) { return C4Board.ORDER.find((c) => board.canPlay(c)); },
  describe() { return `player<${this.label}>`; },
};
const greedyPlayer = {
  label: 'greedy',
  choose(board) {
    for (const c of C4Board.ORDER) if (board.isWinningMove(c)) return c;
    // block opponent's immediate win
    for (const c of C4Board.ORDER) {
      if (!board.canPlay(c)) continue;
      board.play(c);
      const oppWins = C4Board.ORDER.some((d) => board.isWinningMove(d));
      board.undo();
      if (!oppWins) return c;
    }
    return super.choose(board);
  },
  describe() { return 'greedy:' + super.describe(); },
};
Object.setPrototypeOf(greedyPlayer, basePlayer);

function makeAiPlayer(depth, label = 'ai' + depth) {
  const searcher = new Searcher({ maxDepth: depth, nodeBudget: 150000 });
  const p = {
    label,
    searcher,
    choose(board) {
      const r = searcher.best(board);
      this.lastScore = r.value;
      this.lastDepth = r.depth;
      return r.move >= 0 ? r.move : super.choose(board);
    },
    describe() { return super.describe() + `[d=${depth}]`; },
  };
  return Object.setPrototypeOf(p, basePlayer);
}

function* playGame(p1, p2, opening = '') {
  const board = C4Board.from(opening);
  const players = { [P1]: p1, [P2]: p2 };
  let w;
  while ((w = board.winner()) === null) {
    const p = players[board.turn];
    const c = p.choose(board);
    const who = board.turn;
    board.play(c);
    yield { who, c, ply: board.moveCount, score: p.lastScore };
  }
  return { winner: w, history: board.history, board };
}

// ---------------------------------------------------------------------------
// Perft-like counting with deep recursion and memo
// ---------------------------------------------------------------------------
function perft(board, depth, memo = new Map()) {
  if (depth === 0) return 1;
  const key = board.key + '/' + depth;
  if (memo.has(key)) return memo.get(key);
  let n = 0;
  for (let c = 0; c < COLS; c++) {
    if (!board.canPlay(c)) continue;
    if (board.isWinningMove(c)) { n++; continue; }
    board.play(c);
    n += perft(board, depth - 1, memo);
    board.undo();
  }
  memo.set(key, n);
  return n;
}

function countDown(n) { return n === 0 ? 0 : 1 + countUp(n - 1); }
function countUp(n) { return n === 0 ? 0 : 1 + countDown(n - 1); }

// ---------------------------------------------------------------------------
// Board serialization with JSON replacer/reviver
// ---------------------------------------------------------------------------
function serialize(board) {
  return JSON.stringify({ kind: 'c4', history: board.history, meta: { turn: board.turn, key: board.key, at: 'x' } },
    (k, v) => (k === 'at' ? undefined : v));
}
function deserialize(json) {
  return JSON.parse(json, function (k, v) {
    if (v && typeof v === 'object' && v.kind === 'c4') return C4Board.from(v.history);
    return v;
  });
}

// ---------------------------------------------------------------------------
// Opening book via tagged template
// ---------------------------------------------------------------------------
function book(strings, ...vals) {
  const out = {};
  strings.raw.forEach((s, i) => {
    const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      const m = /^(?<seq>\d*)\s*=>\s*(?<move>\d)$/.exec(line);
      if (m) out[m.groups.seq] = +m.groups.move;
    }
    if (i < vals.length) out['v' + i] = vals[i];
  });
  return out;
}
const OPENINGS = book`
  => 3
  3 => 3
  33 => 3
  333 => 3
  ${'end'}
  34 => 2
`;

// ---------------------------------------------------------------------------
// Proxy-wrapped stats with getters
// ---------------------------------------------------------------------------
const stats = new Proxy({ games: 0, p1: 0, p2: 0, draws: 0 }, {
  get(t, k) { return k in t ? t[k] : `no:${String(k)}`; },
  set(t, k, v) { if (!(k in t)) throw new TypeError('unknown stat ' + String(k)); t[k] = v; return true; },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('== d18 connect four ==');
const b0 = new C4Board();
console.log('describe: ' + b0.describe() + ' size=' + b0.size + ' tag=' + Object.prototype.toString.call(b0));
console.log('instanceof: ' + (b0 instanceof C4Board) + ' ' + ({} instanceof C4Board) + ' ' + (b0 instanceof GridBoard));
try { new BaseBoard(1, 1); } catch (e) { console.log('abstract: ' + e.message); }
const lcgA = Lcg(1), lcgB = new Lcg(1);
console.log('lcg: ' + lcgA.next() + ' ' + lcgB.next() + ' ' + (lcgA instanceof Lcg));

// Basic play/undo and hash consistency
const seqs = ['3', '33', '3344', '0123456', '334455', '0000000'];
for (const s of seqs) {
  let b;
  try {
    b = C4Board.from(s);
    console.log(`seq ${s}: key=${b.key} turn=${b.turn} winner=${b.winner()} rows=${[...b].slice(-2).join('/')}`);
  } catch (e) {
    console.log(`seq ${s}: error ${e.constructor === RangeError ? 'Range' : 'Other'} ${e.message}`);
  }
}
{
  const a = C4Board.from('3243');
  const b = C4Board.from('4233');
  const c = C4Board.from('32435');
  c.undo();
  console.log('transposition keys equal: ' + (a.key === b.key) + ' undo restores: ' + (a.key === c.key));
}

// Winner detection in all directions
const winCases = { horizontal: '0011223', vertical: '0101010', diag: '01122323353', anti: '65544343313' };
for (const [name, seq] of Object.entries(winCases)) {
  const b = C4Board.from(seq.slice(0, -1));
  const last = +seq.at(-1);
  const wm = b.isWinningMove(last);
  b.play(last);
  console.log(`win ${name}: winningMove=${wm} winner=${b.winner()}`);
}

// Evaluation
for (const s of ['', '3', '33', '3232', '3344552', '01234560123456']) {
  const b = C4Board.from(s);
  console.log(`eval ${JSON.stringify(s)}: p1=${evaluate(b, P1)} p2=${evaluate(b, P2)}`);
}
console.log('scoreWindow: ' + [scoreWindow(1, 1, 1, 0, 1), scoreWindow(2, 2, 2, 0, 1), scoreWindow(1, 2, 0, 0, 1), scoreWindow(0, 0, 0, 0, 2)].join(','));

// Perft
{
  const memo = new Map();
  for (let d = 1; d <= 5; d++) console.log(`perft(${d}) = ${perft(new C4Board(), d, memo)}`);
  console.log('perft memo size: ' + memo.size);
}

// Tactical puzzles
const puzzles = [
  { seq: '001122', expect: 3, desc: 'win horizontally' },
  { seq: '00112', expect: 3, desc: 'block horizontal' },
  { seq: '3434343', expect: null, desc: 'after vertical threat' },
  { seq: '2233', expect: null, desc: 'double threat' },
];
for (const { seq, expect, desc } of puzzles) {
  const b = C4Board.from(seq);
  const s = new Searcher({ maxDepth: 5 });
  const it = s.iterate(b);
  const trail = [];
  for (const step of it) trail.push(`d${step.depth}:${step.move}/${step.value}`);
  const best = s.best(b.clone());
  console.log(`puzzle ${desc} [${seq}]: best=${best.move} v=${best.value} ok=${expect === null ? 'n/a' : best.move === expect} nodes=${s.nodes}`);
  console.log(`  trail ${trail.join(' ')}`);
  console.log(`  tt size=${s.tt.size} hits=${s.tt.hits} stores=${s.tt.stores}`);
}

// Node budget abort
{
  const s = new Searcher({ maxDepth: 12, nodeBudget: 3000 });
  const r = s.best(new C4Board());
  console.log(`budget search: move=${r.move} depth=${r.depth} aborted=${r.aborted ?? false} nodes=${s.nodes}`);
}

// Generator .return / .throw on iterative deepening
{
  const s = new Searcher({ maxDepth: 6 });
  const b = C4Board.from('33');
  const it = s.iterate(b);
  console.log('iter first: ' + JSON.stringify(it.next().value));
  console.log('iter return: ' + JSON.stringify(it.return({ forced: true })));
  const it2 = s.iterate(b);
  it2.next();
  try { it2.throw(new SearchAbort(-1)); } catch (e) { console.log('iter throw escaped: ' + e.message); }
  console.log('board intact: ' + b.history);
}

// Players
const greedy = greedyPlayer;
const ai3 = makeAiPlayer(3);
const ai5 = makeAiPlayer(5);
console.log('players: ' + [basePlayer.describe(), greedy.describe(), ai3.describe(), ai5.describe()].join(' | '));

const matches = [[greedy, ai3, ''], [ai3, greedy, ''], [ai5, ai3, '3'], [ai3, ai5, '33'], [basePlayer, greedy, '']];
for (const [a, b, opening] of matches) {
  const g = playGame(a, b, opening);
  const moves = [];
  let step;
  while (!(step = g.next()).done) moves.push(step.value.c);
  const { winner, history, board } = step.value;
  stats.games++;
  switch (winner) {
    case P1: stats.p1++; break;
    case P2: stats.p2++; break;
    default:
    case 0: stats.draws++;
  }
  console.log(`game ${a.label} vs ${b.label} open=${JSON.stringify(opening)}: winner=${winner} len=${history.length} hist=${history}`);
  console.log(`  final: ${[...board].join('|')}`);
}
console.log('stats: ' + JSON.stringify({ ...stats }) + ' missing=' + stats.nope);
try { stats.bogus = 1; } catch (e) { console.log('stats set error: ' + e.message); }

// Serialization round trip
{
  const b = C4Board.from('3322110');
  const js = serialize(b);
  const back = deserialize(js);
  console.log('serialized: ' + js);
  console.log('roundtrip: ' + (back.history === b.history) + ' key=' + (back.key === b.key) + ' isBoard=' + (back instanceof C4Board));
}

// Opening book
console.log('openings: ' + JSON.stringify(OPENINGS));
{
  const b = new C4Board();
  let h;
  while ((h = OPENINGS[b.history]) !== undefined && b.moveCount < 6) b.play(h);
  console.log('book line: ' + b.history + ' next=' + (OPENINGS[b.history] ?? 'none'));
}

// Mutual deep recursion
console.log('mutual recursion 3000: ' + countDown(3000));

// Closures capturing loop vars
{
  const fns = [];
  for (let c = 0; c < COLS; c++) fns.push(() => c * c);
  for (const d of [10, 20]) fns.push(() => d + 1);
  for (const k in { a: 1, bb: 2 }) fns.push(() => k.length);
  console.log('closures: ' + fns.map((f) => f()).join(','));
  var vs = [];
  for (var v = 0; v < 3; v++) vs.push(() => v);
  console.log('var closures: ' + vs.map((f) => f()).join(','));
}

// arguments aliasing in sloppy mode
function aliasTest(a, b) {
  arguments[0] = 'changed';
  b = 'B';
  return [a, arguments[1], arguments.length, typeof arguments].join(',');
}
console.log('arguments alias: ' + aliasTest('x', 'y', 'z'));

// Async analysis with deterministic microtasks
async function analyzeAll(positions) {
  const log = [];
  const tasks = positions.map(async (seq, i) => {
    await null;
    log.push('start' + i);
    for (let k = 0; k < i; k++) await Promise.resolve();
    const s = new Searcher({ maxDepth: 3 });
    const r = s.best(C4Board.from(seq));
    log.push('end' + i);
    if (r.move < 0) throw new Error('no move for ' + seq);
    return `${seq || '-'}=>${r.move}`;
  });
  const results = await Promise.allSettled([...tasks, Promise.reject(new SearchAbort(0))]);
  return { log, results: results.map((x) => x.status === 'fulfilled' ? x.value : 'ERR:' + x.reason.message) };
}
async function* moveStream(seq) {
  for (const ch of seq) {
    await null;
    yield +ch;
  }
  return 'stream-end';
}
(async () => {
  const res = await analyzeAll(['', '3', '3232', '001122']);
  console.log('async log: ' + res.log.join(','));
  console.log('async results: ' + res.results.join(' ; '));
  const b = new C4Board();
  for await (const c of moveStream('3344')) b.play(c);
  console.log('streamed board: ' + b.history + ' eval=' + evaluate(b, P1));
  const g = moveStream('12');
  const r1 = await g.next();
  const r2 = await g.return('early');
  const r3 = await g.next();
  console.log('async gen: ' + JSON.stringify([r1, r2, r3]));
  console.log('boards created: ' + (BaseBoard.created > 10));
})().finally(() => console.log('== d18 end =='));
