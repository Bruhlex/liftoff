// d04_chess.js - 0x88 chess move generator, perft, zobrist hashing (BigInt),
// tiny alpha-beta search and assorted analysis. Deterministic, no I/O besides console.log.

const FILES = 'abcdefgh';
const WHITE = 'w', BLACK = 'b';
const DIRS = Object.freeze({
  knight: [33, 31, 18, 14, -33, -31, -18, -14],
  bishop: [15, 17, -15, -17],
  rook: [16, -16, 1, -1],
  get queen() { return [...this.bishop, ...this.rook]; },
  get king() { return this.queen; },
});
const KING_DIRS = DIRS.king;
let dirAccessCount = 0;
const TRACKED_DIRS = new Proxy(DIRS, {
  get(target, key, recv) {
    if (typeof key === 'string') dirAccessCount++;
    return Reflect.get(target, key, recv);
  },
  has(target, key) { return key in target || key === 'pawn'; },
  ownKeys(target) { return Reflect.ownKeys(target).reverse(); },
});

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const RIGHT_SQUARES = new Map([[4, 'KQ'], [0, 'Q'], [7, 'K'], [116, 'kq'], [112, 'q'], [119, 'k']]);

const sqName = (sq) => (sq < 0 ? '-' : FILES[sq & 7] + ((sq >> 4) + 1));
function parseSq(name) {
  const m = /^(?<f>[a-h])(?<r>[1-8])$/u.exec(name);
  if (!m) return -1;
  const { groups: { f, r } } = m;
  return (Number(r) - 1) * 16 + FILES.indexOf(f);
}
const onBoard = (sq) => (sq & 0x88) === 0;
const colorOf = (p) => (p == null ? null : p === p.toUpperCase() ? WHITE : BLACK);
const other = (c) => (c === WHITE ? BLACK : WHITE);

function stripRights(rights, ...squares) {
  let out = rights;
  for (const sq of squares) for (const r of RIGHT_SQUARES.get(sq) ?? '') out = out.replace(r, '');
  return out;
}

// sloppy-mode helpers exercising the arguments object
function aliasArgs(a, b) {
  arguments[0] = a * 10;
  return a + b + arguments.length;
}
function sumArgs() {
  let s = 0;
  for (let i = 0; i < arguments.length; i++) s += typeof arguments[i] === 'number' ? arguments[i] : 0;
  return s;
}

class XorShift64 {
  #s;
  static #instances;
  static { XorShift64.#instances = 0; }
  constructor(seed) { this.#s = BigInt.asUintN(64, BigInt(seed)) || 1n; }
  next() {
    let x = this.#s;
    x ^= (x << 13n) & 0xFFFFFFFFFFFFFFFFn;
    x ^= x >> 7n;
    x ^= (x << 17n) & 0xFFFFFFFFFFFFFFFFn;
    this.#s = x;
    return x;
  }
  static get instances() { return XorShift64.#instances; }
  static create(seed) { XorShift64.#instances++; return new XorShift64(seed); }
}

const ZOBRIST = (() => {
  const rng = XorShift64.create(0x9E3779B97F4A7C15n);
  const table = {};
  for (const p of 'PNBRQKpnbrqk') table[p] = Array.from({ length: 128 }, (_, sq) => (onBoard(sq) ? rng.next() : 0n));
  return {
    table,
    side: rng.next(),
    castle: Object.fromEntries([...'KQkq'].map((c) => [c, rng.next()])),
    ep: Array.from({ length: 8 }, () => rng.next()),
  };
})();

function fmtMove(m) {
  if (m == null) return '(none)';
  if (typeof m !== 'object') return String(m);
  return sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
}
function uci(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].map(fmtMove).join(',') : fmtMove(vals[i])) : ''), '');
}

class MoveLike {
  static [Symbol.hasInstance](o) {
    return o != null && typeof o === 'object' && 'from' in o && 'to' in o && typeof o.piece === 'string';
  }
}

function materialBalance(board) {
  let score = 0;
  for (const [, p] of board.occupied()) {
    const v = PIECE_VALUES[p.toLowerCase()];
    score += colorOf(p) === WHITE ? v : -v;
  }
  return score;
}

class BoardBase {
  #cells = new Array(128).fill(null);
  static #created = 0;
  static { this.EMPTY = '.'; }
  constructor() {
    if (new.target === BoardBase) throw new TypeError('abstract board');
    BoardBase.#created++;
  }
  static get created() { return BoardBase.#created; }
  at(sq) { return this.#cells[sq]; }
  put(sq, p) { const old = this.#cells[sq]; this.#cells[sq] = p; return old; }
  *occupied() {
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.#cells[sq];
      if (p) yield [sq, p];
    }
  }
  static isBoard(o) { return o != null && typeof o === 'object' && #cells in o; }
}

class Board extends BoardBase {
  side = WHITE;
  castle = '';
  ep = -1;
  half = 0;
  full = 1;
  kings = { w: -1, b: -1 };
  static fromFEN(fen) {
    const re = /^(?<placement>[pnbrqkPNBRQK1-8/]+)\s+(?<side>[wb])\s+(?<castle>K?Q?k?q?|-)\s+(?<ep>[a-h][36]|-)(?:\s+(?<half>\d+)\s+(?<full>\d+))?$/u;
    const m = re.exec(String(fen).trim());
    if (!m) throw new SyntaxError('bad fen: ' + fen);
    const { placement, side, castle, ep, half = '0', full = '1' } = m.groups;
    const b = new this();
    const rows = placement.split('/');
    if (rows.length !== 8) throw new SyntaxError('bad rank count ' + rows.length);
    rows.forEach((row, i) => {
      const rank = 7 - i;
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { file += +ch; continue; }
        const sq = rank * 16 + file++;
        b.put(sq, ch);
        if (ch === 'K') b.kings.w = sq; else if (ch === 'k') b.kings.b = sq;
      }
      if (file !== 8) throw new SyntaxError(`rank ${rank + 1} has ${file} files`);
    });
    b.side = side;
    b.castle = castle === '-' ? '' : castle;
    b.ep = ep === '-' ? -1 : parseSq(ep);
    b.half = +half;
    b.full = +full;
    return b;
  }
  toFEN() {
    const rows = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = '', empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.at(rank * 16 + file);
        p ? (empty && (row += empty), (empty = 0), (row += p)) : empty++;
      }
      rows.push(empty ? row + empty : row);
    }
    return `${rows.join('/')} ${this.side} ${this.castle || '-'} ${sqName(this.ep)} ${this.half} ${this.full}`;
  }
  *[Symbol.iterator]() {
    for (let rank = 7; rank >= 0; rank--) {
      let s = '';
      for (let file = 0; file < 8; file++) s += this.at(rank * 16 + file) ?? BoardBase.EMPTY;
      yield s;
    }
  }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return materialBalance(this);
    if (hint === 'string') return this.toFEN();
    return `Board<${this.side}>`;
  }
}

class Position extends Board {
  static #nodes = 0;
  static get nodes() { return Position.#nodes; }
  static resetNodes() { const n = Position.#nodes; Position.#nodes = 0; return n; }
  #history = [];
  get ply() { return this.#history.length; }

  isAttacked(sq, by) {
    const pawn = by === WHITE ? 'P' : 'p';
    const dir = by === WHITE ? -16 : 16;
    for (const d of [dir - 1, dir + 1]) {
      const s = sq + d;
      if (onBoard(s) && this.at(s) === pawn) return true;
    }
    const up = (c) => (by === WHITE ? c.toUpperCase() : c);
    const [N, B, R, Q, K] = ['n', 'b', 'r', 'q', 'k'].map(up);
    for (const d of DIRS.knight) { const s = sq + d; if (onBoard(s) && this.at(s) === N) return true; }
    for (const d of KING_DIRS) { const s = sq + d; if (onBoard(s) && this.at(s) === K) return true; }
    for (const [dirs, a, q] of [[DIRS.bishop, B, Q], [DIRS.rook, R, Q]]) {
      ray: for (const d of dirs) {
        for (let s = sq + d; onBoard(s); s += d) {
          const p = this.at(s);
          if (p == null) continue;
          if (p === a || p === q) return true;
          continue ray;
        }
      }
    }
    return false;
  }

  *pseudoMoves() {
    const us = this.side;
    for (const [sq, p] of this.occupied()) {
      if (colorOf(p) !== us) continue;
      switch (p.toLowerCase()) {
        case 'p': yield* this.#pawnMoves(sq, p); break;
        case 'n': yield* this.#leaperMoves(sq, p, DIRS.knight); break;
        case 'k':
          yield* this.#leaperMoves(sq, p, KING_DIRS);
          yield* this.#castleMoves(sq, p);
          break;
        case 'b': yield* this.#sliderMoves(sq, p, DIRS.bishop); break;
        case 'q': yield* this.#sliderMoves(sq, p, KING_DIRS); break;
        case 'r': yield* this.#sliderMoves(sq, p, DIRS.rook); break;
        default: throw new Error('unknown piece ' + p);
      }
    }
  }
  *#pawnMoves(from, p) {
    const white = p === 'P';
    const dir = white ? 16 : -16;
    const startRank = white ? 1 : 6, lastRank = white ? 7 : 0;
    const promos = white ? ['Q', 'R', 'B', 'N'] : ['q', 'r', 'b', 'n'];
    const emit = function* (to, captured, flag) {
      if (to >> 4 === lastRank) for (const promo of promos) yield { from, to, piece: p, captured, promo, flag };
      else yield { from, to, piece: p, captured, promo: null, flag };
    };
    const one = from + dir;
    if (onBoard(one) && !this.at(one)) {
      yield* emit(one, null, 'n');
      const two = one + dir;
      if (from >> 4 === startRank && !this.at(two)) yield { from, to: two, piece: p, captured: null, promo: null, flag: 'dbl' };
    }
    for (const side of [-1, 1]) {
      const to = from + dir + side;
      if (!onBoard(to)) continue;
      const target = this.at(to);
      if (target && colorOf(target) !== colorOf(p)) yield* emit(to, target, 'c');
      else if (to === this.ep && !target) yield { from, to, piece: p, captured: white ? 'p' : 'P', promo: null, flag: 'ep' };
    }
  }
  *#leaperMoves(from, p, dirs) {
    for (const d of dirs) {
      const to = from + d;
      if (!onBoard(to)) continue;
      const t = this.at(to);
      if (t == null) yield { from, to, piece: p, captured: null, promo: null, flag: 'n' };
      else if (colorOf(t) !== colorOf(p)) yield { from, to, piece: p, captured: t, promo: null, flag: 'c' };
    }
  }
  *#sliderMoves(from, p, dirs) {
    const me = colorOf(p);
    for (const d of dirs) {
      let to = from;
      do {
        to += d;
        if (!onBoard(to)) break;
        const t = this.at(to);
        if (t == null) { yield { from, to, piece: p, captured: null, promo: null, flag: 'n' }; continue; }
        if (colorOf(t) !== me) yield { from, to, piece: p, captured: t, promo: null, flag: 'c' };
        break;
      } while (true);
    }
  }
  *#castleMoves(from, p) {
    const white = p === 'K';
    const home = white ? 4 : 116;
    if (from !== home) return;
    const them = white ? BLACK : WHITE;
    const [kRight, qRight] = white ? ['K', 'Q'] : ['k', 'q'];
    const rook = white ? 'R' : 'r';
    if (!this.castle.includes(kRight) && !this.castle.includes(qRight)) return;
    if (this.isAttacked(home, them)) return;
    if (this.castle.includes(kRight) && !this.at(home + 1) && !this.at(home + 2) && this.at(home + 3) === rook &&
        !this.isAttacked(home + 1, them) && !this.isAttacked(home + 2, them))
      yield { from, to: home + 2, piece: p, captured: null, promo: null, flag: 'k' };
    if (this.castle.includes(qRight) && !this.at(home - 1) && !this.at(home - 2) && !this.at(home - 3) && this.at(home - 4) === rook &&
        !this.isAttacked(home - 1, them) && !this.isAttacked(home - 2, them))
      yield { from, to: home - 2, piece: p, captured: null, promo: null, flag: 'q' };
  }

  makeMove(m) {
    Position.#nodes++;
    const undo = { m, castle: this.castle, ep: this.ep, half: this.half, full: this.full, kings: { ...this.kings } };
    this.#history.push(undo);
    const white = m.piece === m.piece.toUpperCase();
    this.put(m.from, null);
    this.put(m.to, m.promo ?? m.piece);
    switch (m.flag) {
      case 'ep': this.put(m.to + (white ? -16 : 16), null); break;
      case 'k': this.put(m.to + 1, null); this.put(m.to - 1, white ? 'R' : 'r'); break;
      case 'q': this.put(m.to - 2, null); this.put(m.to + 1, white ? 'R' : 'r'); break;
      default:
    }
    if (m.piece === 'K') this.kings.w = m.to;
    else if (m.piece === 'k') this.kings.b = m.to;
    this.castle = stripRights(this.castle, m.from, m.to);
    this.ep = m.flag === 'dbl' ? (m.from + m.to) >> 1 : -1;
    this.half = m.captured || m.piece.toLowerCase() === 'p' ? 0 : this.half + 1;
    if (!white) this.full++;
    this.side = white ? BLACK : WHITE;
    return undo;
  }
  unmakeMove() {
    const u = this.#history.pop();
    if (!u) throw new RangeError('nothing to undo');
    const { m } = u;
    const white = m.piece === m.piece.toUpperCase();
    const rook = white ? 'R' : 'r';
    this.put(m.from, m.piece);
    if (m.flag === 'ep') { this.put(m.to, null); this.put(m.to + (white ? -16 : 16), m.captured); }
    else this.put(m.to, m.captured);
    if (m.flag === 'k') { this.put(m.to - 1, null); this.put(m.to + 1, rook); }
    else if (m.flag === 'q') { this.put(m.to + 1, null); this.put(m.to - 2, rook); }
    ({ castle: this.castle, ep: this.ep, half: this.half, full: this.full, kings: this.kings } = u);
    this.side = white ? WHITE : BLACK;
    return m;
  }
  legalMoves() {
    const pseudo = [...this.pseudoMoves()];
    const us = this.side, them = other(us);
    const out = [];
    for (const m of pseudo) {
      this.makeMove(m);
      try {
        if (this.isAttacked(this.kings[us], them)) continue;
        out.push(m);
      } finally {
        this.unmakeMove();
      }
    }
    return out;
  }
  inCheck() { return this.isAttacked(this.kings[this.side], other(this.side)); }
  status() {
    const n = this.legalMoves().length;
    return n ? (this.half >= 100 ? 'fifty-move' : 'ongoing') : this.inCheck() ? 'checkmate' : 'stalemate';
  }
}

class SearchPosition extends Position {
  #genCount = 0;
  get lazyMoves() {
    this.#genCount++;
    return this.legalMoves();
  }
  get genCount() { return this.#genCount; }
  perft(depth) {
    if (depth === 0) return 1;
    const moves = this.legalMoves();
    if (depth === 1) return moves.length;
    let total = 0;
    for (const m of moves) {
      super.makeMove(m);
      try {
        total += this.perft(depth - 1);
      } finally {
        super.unmakeMove();
      }
    }
    return total;
  }
  divide(depth) {
    const out = [];
    for (const m of this.legalMoves()) {
      this.makeMove(m);
      try { out.push([fmtMove(m), this.perft(depth - 1)]); }
      finally { this.unmakeMove(); }
    }
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  perftStats(depth, acc = { nodes: 0, captures: 0, ep: 0, castles: 0, promotions: 0, checks: 0 }) {
    const moves = this.legalMoves();
    for (const m of moves) {
      if (depth === 1) {
        acc.nodes++;
        m.captured && acc.captures++;
        switch (m.flag) {
          case 'ep': acc.ep++; break;
          case 'k':
          case 'q': acc.castles++; break;
        }
        if (m.promo) acc.promotions++;
      }
      this.makeMove(m);
      try {
        if (depth === 1) { if (this.inCheck()) acc.checks++; }
        else this.perftStats(depth - 1, acc);
      } finally { this.unmakeMove(); }
    }
    return acc;
  }
  hash() {
    let h = 0n;
    for (const [sq, p] of this.occupied()) h ^= ZOBRIST.table[p][sq];
    if (this.side === BLACK) h ^= ZOBRIST.side;
    for (const c of this.castle) h ^= ZOBRIST.castle[c];
    if (this.ep >= 0) h ^= ZOBRIST.ep[this.ep & 7];
    return h;
  }
  uniqueLeaves(depth, set = new Set()) {
    if (depth === 0) { set.add(this.hash().toString(16)); return set; }
    for (const m of this.legalMoves()) {
      this.makeMove(m);
      try { this.uniqueLeaves(depth - 1, set); } finally { this.unmakeMove(); }
    }
    return set;
  }
  mateInOne() {
    const found = [];
    outer: for (const m of this.legalMoves()) {
      this.makeMove(m);
      try {
        const replies = this.legalMoves();
        if (replies.length) continue outer;
        if (!this.inCheck()) continue;
        found.push(m);
      } finally {
        this.unmakeMove();
      }
    }
    return found;
  }
}

const CENTER_BONUS = (sq) => {
  const f = sq & 7, r = sq >> 4;
  return 6 - (Math.abs(3.5 - f) + Math.abs(3.5 - r));
};
function evaluate(pos) {
  let s = 0;
  for (const [sq, p] of pos.occupied()) {
    const v = PIECE_VALUES[p.toLowerCase()] + (p.toLowerCase() === 'k' ? 0 : CENTER_BONUS(sq) * 2);
    s += colorOf(p) === WHITE ? v : -v;
  }
  return Math.round(s);
}
const stats = { maxNodes: 0, minNodes: 0, cutoffs: 0 };
function maxi(pos, depth, alpha, beta) {
  stats.maxNodes++;
  if (depth === 0) return evaluate(pos);
  const moves = pos.legalMoves();
  if (!moves.length) return pos.inCheck() ? -100000 - depth : 0;
  let best = -Infinity;
  for (const m of moves) {
    pos.makeMove(m);
    let v;
    try { v = mini(pos, depth - 1, alpha, beta); } finally { pos.unmakeMove(); }
    if (v > best) best = v;
    alpha = Math.max(alpha, v);
    if (alpha >= beta) { stats.cutoffs++; break; }
  }
  return best;
}
function mini(pos, depth, alpha, beta) {
  stats.minNodes++;
  if (depth === 0) return evaluate(pos);
  const moves = pos.legalMoves();
  if (!moves.length) return pos.inCheck() ? 100000 + depth : 0;
  let best = Infinity;
  for (const m of moves) {
    pos.makeMove(m);
    let v;
    try { v = maxi(pos, depth - 1, alpha, beta); } finally { pos.unmakeMove(); }
    if (v < best) best = v;
    beta = Math.min(beta, v);
    if (alpha >= beta) { stats.cutoffs++; break; }
  }
  return best;
}
function bestMove(pos, depth) {
  const white = pos.side === WHITE;
  let best = null, bestScore = white ? -Infinity : Infinity;
  for (const m of pos.legalMoves()) {
    pos.makeMove(m);
    let score;
    try { score = white ? mini(pos, depth - 1, -Infinity, Infinity) : maxi(pos, depth - 1, -Infinity, Infinity); }
    finally { pos.unmakeMove(); }
    if (white ? score > bestScore : score < bestScore) { bestScore = score; best = m; }
  }
  return { move: best, score: bestScore };
}

// deep recursion (~3000) via mutual recursion over a synthetic move list
function walkEven(list, i, acc) { return i >= list.length ? acc : walkOdd(list, i + 1, acc + list[i].length); }
function walkOdd(list, i, acc) { return i >= list.length ? acc : walkEven(list, i + 1, acc ^ list[i].charCodeAt(0)); }

const baseReporter = {
  label() { return 'base'; },
  describe(x) { return `[${this.label()}] ${x}`; },
};
const chessReporter = {
  __proto__: baseReporter,
  label() { return 'chess:' + super.label(); },
  describe(x) { return super.describe(x).toUpperCase(); },
  arrow: () => typeof baseReporter.label,
  counter: {
    n: 0,
    bump() { return ++this.n; },
    bumpLater() { return () => ++this.n; },
  },
};

const POSITIONS = [
  ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039]],
  ['pos3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812]],
  ['pos4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264]],
  ['pos5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486]],
];

function main() {
  console.log('== squares & helpers ==');
  console.log(['a1', 'e4', 'h8', 'z9'].map((n) => `${n}=${parseSq(n)}`).join(' '));
  console.log([0, 7, 52, 119, -1].map(sqName).join(' '));
  console.log('aliasArgs', aliasArgs(3, 4), 'sumArgs', sumArgs(1, 'x', 2, null, 3));
  console.log('stripRights', JSON.stringify([stripRights('KQkq', 4), stripRights('KQkq', 119, 0), stripRights('Kq', 5)]));
  console.log('dirs proxy', 'pawn' in TRACKED_DIRS, 'king' in TRACKED_DIRS, Object.keys(TRACKED_DIRS).join('|'), TRACKED_DIRS.queen.length, dirAccessCount);

  console.log('== fen roundtrip ==');
  for (const [name, fen] of POSITIONS) {
    const p = SearchPosition.fromFEN(fen);
    console.log(name, p.toFEN() === fen ? 'ok' : 'MISMATCH ' + p.toFEN(), 'material', +p, `${p}` === fen, p + '' === 'Board<' + p.side + '>');
  }
  try { new BoardBase(); } catch (e) { console.log('abstract:', e instanceof TypeError, e.message); }
  for (const bad of ['8/8/8 w - -', 'rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'xx']) {
    try { SearchPosition.fromFEN(bad); console.log('accepted?!', bad); }
    catch ({ name, message }) { console.log('reject', name, message.slice(0, 40)); }
  }

  console.log('== board picture ==');
  const start = SearchPosition.fromFEN(POSITIONS[0][1]);
  for (const row of start) console.log('  ' + row);
  console.log('isBoard', BoardBase.isBoard(start), BoardBase.isBoard({}), BoardBase.isBoard(null));

  console.log('== perft ==');
  let allOk = true;
  for (const [name, fen, expected] of POSITIONS) {
    const pos = SearchPosition.fromFEN(fen);
    const got = expected.map((_, i) => pos.perft(i + 1));
    const ok = got.every((g, i) => g === expected[i]);
    allOk &&= ok;
    console.log(`${name.padEnd(9)} ${got.join(' ')} ${ok ? 'OK' : 'FAIL expected ' + expected.join(' ')} fenAfter=${pos.toFEN() === fen}`);
  }
  console.log('all perft ok:', allOk, 'nodes made:', Position.resetNodes() > 0);

  console.log('== divide start depth 2 ==');
  const div = start.divide(2);
  for (let i = 0; i < div.length; i += 4) console.log('  ' + div.slice(i, i + 4).map(([m, n]) => `${m}:${n}`).join('  '));
  console.log('divide sum', div.reduce((s, [, n]) => s + n, 0));

  console.log('== perft stats ==');
  const kiwi = SearchPosition.fromFEN(POSITIONS[1][1]);
  for (const [label, p, d] of [['start d3', start, 3], ['kiwi d2', kiwi, 2], ['pos4 d2', SearchPosition.fromFEN(POSITIONS[3][1]), 2]]) {
    const { nodes, ...rest } = p.perftStats(d);
    console.log(label, nodes, JSON.stringify(rest));
  }

  console.log('== zobrist ==');
  console.log('rng instances', XorShift64.instances, 'side key', (ZOBRIST.side & 0xFFFFn).toString(16));
  console.log('start hash', start.hash().toString(16));
  const e4 = start.legalMoves().find((m) => fmtMove(m) === 'e2e4');
  start.makeMove(e4);
  const hE4 = start.hash();
  console.log('after e4', start.toFEN(), hE4.toString(16).slice(0, 8));
  start.unmakeMove();
  console.log('restored', start.hash() === SearchPosition.fromFEN(POSITIONS[0][1]).hash());
  const transp = SearchPosition.fromFEN(POSITIONS[0][1]);
  const seqA = ['g1f3', 'g8f6', 'b1c3'], seqB = ['b1c3', 'g8f6', 'g1f3'];
  const playSeq = (pos, seq) => {
    for (const s of seq) pos.makeMove(pos.legalMoves().find((m) => fmtMove(m) === s));
    const h = pos.hash();
    seq.forEach(() => pos.unmakeMove());
    return h;
  };
  console.log('transposition equal', playSeq(transp, seqA) === playSeq(transp, seqB));
  for (const d of [1, 2, 3]) console.log(`unique leaves d${d}`, start.uniqueLeaves(d).size);

  console.log('== status ==');
  const statusFens = {
    fools: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    stalemate: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    fifty: '8/8/8/4k3/8/8/4K3/7R b - - 100 80',
    open: POSITIONS[2][1],
  };
  for (const key in statusFens) {
    const p = SearchPosition.fromFEN(statusFens[key]);
    console.log(key.padEnd(10), p.status(), 'check', p.inCheck(), 'lazy', p.lazyMoves.length, p.lazyMoves.length, p.genCount);
  }

  console.log('== mate in one ==');
  const mateFens = ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'k7/8/1K6/8/8/8/8/7Q w - - 0 1', '4k3/8/8/8/8/8/8/4K3 w - - 0 1'];
  for (const f of mateFens) {
    const p = SearchPosition.fromFEN(f);
    const mates = p.mateInOne();
    console.log(uci`mates: ${mates} first=${mates[0]} count=${mates.length}`);
  }

  console.log('== search ==');
  for (const f of [mateFens[0], POSITIONS[2][1], 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 4']) {
    stats.maxNodes = stats.minNodes = stats.cutoffs = 0;
    const p = SearchPosition.fromFEN(f);
    const { move, score } = bestMove(p, 2);
    console.log(uci`best ${move}`, 'score', score, 'nodes', stats.maxNodes + stats.minNodes, 'cutoffs', stats.cutoffs, 'eval', evaluate(p));
  }

  console.log('== move typing ==');
  const sample = kiwi.legalMoves();
  const byFlag = sample.reduce((acc, m) => ((acc[m.flag] ??= []).push(fmtMove(m)), acc), {});
  for (const [flag, list] of Object.entries(byFlag)) console.log(`  ${flag}: ${list.length} ${list.slice(0, 5).join(',')}`);
  console.log('MoveLike', sample[0] instanceof MoveLike, {} instanceof MoveLike, null instanceof MoveLike);
  const pieceCounts = new Map();
  for (const { piece } of sample) pieceCounts.set(piece, (pieceCounts.get(piece) ?? 0) + 1);
  console.log('by piece', [...pieceCounts].sort().map(([k, v]) => k + v).join(' '));

  console.log('== closures over loop vars ==');
  const thunks = [];
  for (const key in PIECE_VALUES) thunks.push(() => key.toUpperCase() + PIECE_VALUES[key]);
  for (let i = 0; i < 3; i++) thunks.push(() => 'i' + i);
  for (const [sq, p] of start.occupied()) { if (p === 'K' || p === 'k') thunks.push(() => p + '@' + sqName(sq)); }
  var legacy = [];
  for (var j = 0; j < 3; j++) legacy.push(() => j);
  console.log(thunks.map((t) => t()).join(' '), '| var:', legacy.map((f) => f()).join(''));

  console.log('== reporters ==');
  console.log(chessReporter.describe('perft'), chessReporter.arrow());
  const later = chessReporter.counter.bumpLater();
  chessReporter.counter.bump();
  console.log('counter', later(), later(), chessReporter.counter.n);
  const detached = chessReporter.counter.bump;
  console.log('detached via call', detached.call({ n: 41 }), Reflect.apply(detached, chessReporter.counter, []));

  console.log('== deep recursion ==');
  const longList = [];
  for (let i = 0; i < 3000; i++) longList.push(sqName((i * 17) & 0x77));
  console.log('walk', walkEven(longList, 0, 0));

  console.log('== weakmap meta ==');
  const meta = new WeakMap();
  const tag = (pos) => {
    if (!meta.has(pos)) meta.set(pos, { visits: 0, fen: pos.toFEN() });
    const m = meta.get(pos);
    m.visits++;
    return m;
  };
  tag(start); tag(start); tag(kiwi);
  console.log('meta', tag(start).visits, tag(kiwi).visits, meta.has({}), BoardBase.created > 10);
  const o = { a: 1, b: undefined };
  delete o.a;
  console.log('ops', 'a' in o, 'b' in o, void 0 === o.b, typeof o.c, typeof SearchPosition, start instanceof Board);
}

async function* perftStream(entries) {
  for (const [name, fen, expected] of entries) {
    await null;
    const pos = SearchPosition.fromFEN(fen);
    const depth = Math.min(2, expected.length);
    yield { name, depth, nodes: pos.perft(depth), expect: expected[depth - 1] };
  }
}

async function runAsync() {
  console.log('== async ==');
  const order = [];
  for await (const { name, depth, nodes, expect } of perftStream(POSITIONS)) {
    order.push(name);
    console.log(`stream ${name} d${depth} ${nodes} ${nodes === expect ? 'ok' : 'bad'}`);
  }
  const settled = await Promise.allSettled([
    Promise.resolve().then(() => SearchPosition.fromFEN('garbage')),
    Promise.resolve(POSITIONS[2][1]).then((f) => SearchPosition.fromFEN(f).perft(1)),
    (async () => { throw new RangeError('nope'); })(),
  ]);
  console.log('settled', settled.map((s) => s.status + ':' + (s.status === 'fulfilled' ? s.value : s.reason.name)).join(' '));
  const ticks = [];
  const mk = (label, n) => (async () => { for (let i = 0; i < n; i++) await null; ticks.push(label); return label; })();
  const winner = await Promise.race([mk('slow', 3), mk('fast', 1), mk('mid', 2)]);
  const any = await Promise.any([Promise.reject(new Error('x')), mk('any', 2)]);
  const all = await Promise.all(POSITIONS.slice(0, 3).map(async ([n, f]) => [n, SearchPosition.fromFEN(f).legalMoves().length]));
  console.log('race', winner, 'any', any, 'ticks', ticks.join(','));
  console.log('all', JSON.stringify(all));
  try {
    await Promise.any([Promise.reject(new Error('a')), Promise.reject(new Error('b'))]);
  } catch (e) {
    console.log('aggregate', e instanceof AggregateError, e.errors.map((x) => x.message).join(''));
  }
  return order.length;
}

main();
runAsync().then((n) => console.log('done async, streamed', n), (e) => console.log('async failed', e && e.message));
