// d24: timetable scheduling solver - constraint propagation (AC-3 style forward
// checking) + backtracking with MRV/LCV heuristics, soft-constraint scoring and
// local improvement. Deterministic.

var printed = 0;
function p() {
  var s = Array.prototype.map.call(arguments, function (x) {
    return typeof x === 'string' ? x : JSON.stringify(x);
  }).join(' ');
  printed++;
  console.log(s);
}

// ---------- PRNG ----------
function lcg(seed) {
  let state = BigInt(seed) & 0xffffffffn;
  return function next(n) {
    state = (state * 1664525n + 1013904223n) & 0xffffffffn;
    return n === undefined ? Number(state) : Number(state % BigInt(n));
  };
}

// ---------- domain model ----------
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const PERIODS = 4;

class Entity {
  static #registry = new Map();
  #kind;
  constructor(kind, id) {
    if (new.target === Entity) throw new TypeError('abstract Entity');
    this.#kind = kind;
    this.id = id;
    Entity.#registry.set(kind + ':' + id, this);
  }
  get kind() { return this.#kind; }
  static lookup(kind, id) { return Entity.#registry.get(kind + ':' + id) ?? null; }
  static count() { return Entity.#registry.size; }
  static clear() { Entity.#registry.clear(); }
  [Symbol.toPrimitive](hint) { return hint === 'number' ? this.id.length : `${this.#kind}(${this.id})`; }
}

class Teacher extends Entity {
  #unavailable;
  constructor(id, { unavailable = [], maxPerDay = 3, prefers = 'any' } = {}) {
    super('teacher', id);
    this.#unavailable = new Set(unavailable);
    this.maxPerDay = maxPerDay;
    this.prefers = prefers;
  }
  available(slot) { return !this.#unavailable.has(slot); }
  get blockedCount() { return this.#unavailable.size; }
}

class Room extends Entity {
  constructor(id, capacity, features = []) {
    super('room', id);
    this.capacity = capacity;
    this.features = new Set(features);
  }
  static isRoom(x) { return x instanceof Room; }
}

class Group extends Entity {
  constructor(id, size) {
    super('group', id);
    this.size = size;
  }
}

class Lesson extends Entity {
  static #n = 0;
  constructor(subject, teacher, group, { needs = [], length = 1 } = {}) {
    super('lesson', `${subject}/${group.id}#${++Lesson.#n}`);
    Object.assign(this, { subject, teacher, group, needs, length });
  }
  static reset() { Lesson.#n = 0; }
}

// ---------- slot helpers ----------
const slotOf = (d, pIdx) => d * PERIODS + pIdx;
const dayOf = (s) => Math.floor(s / PERIODS);
const periodOf = (s) => s % PERIODS;
const slotName = (s) => `${DAYS[dayOf(s)]}${periodOf(s) + 1}`;

// ---------- value = [slot, roomIndex] encoded ----------
function enc(slot, roomIdx) { return slot * 100 + roomIdx; }
function dec(v) { return [Math.floor(v / 100), v % 100]; }

// ---------- problem ----------
class Problem {
  constructor({ teachers, rooms, groups, lessons }) {
    this.teachers = teachers;
    this.rooms = rooms;
    this.groups = groups;
    this.lessons = lessons;
    this.nSlots = DAYS.length * PERIODS;
    this.domains = lessons.map((l) => this.#initialDomain(l));
    this.neighbors = lessons.map((l, i) =>
      lessons.reduce((acc, m, j) => {
        if (i !== j && (m.teacher === l.teacher || m.group === l.group)) acc.push(j);
        return acc;
      }, []));
  }
  #initialDomain(lesson) {
    const dom = [];
    for (let s = 0; s < this.nSlots; s++) {
      if (!lesson.teacher.available(s)) continue;
      rooms: for (let r = 0; r < this.rooms.length; r++) {
        const room = this.rooms[r];
        if (room.capacity < lesson.group.size) continue;
        for (const f of lesson.needs) if (!room.features.has(f)) continue rooms;
        dom.push(enc(s, r));
      }
    }
    return dom;
  }
  domainStats() {
    const sizes = this.domains.map((d) => d.length);
    return { min: Math.min(...sizes), max: Math.max(...sizes), total: sizes.reduce((a, b) => a + b, 0) };
  }
}

// ---------- constraint checking ----------
function conflicts(problem, assign, i, v) {
  const [s, r] = dec(v);
  const li = problem.lessons[i];
  for (let j = 0; j < assign.length; j++) {
    const w = assign[j];
    if (j === i || w === undefined) continue;
    const [s2, r2] = dec(w);
    if (s2 !== s) continue;
    if (r2 === r) return 'room';
    const lj = problem.lessons[j];
    if (lj.teacher === li.teacher) return 'teacher';
    if (lj.group === li.group) return 'group';
  }
  // teacher daily maximum
  const day = dayOf(s);
  let perDay = 1;
  for (let j = 0; j < assign.length; j++) {
    if (j === i || assign[j] === undefined) continue;
    if (problem.lessons[j].teacher === li.teacher && dayOf(dec(assign[j])[0]) === day) perDay++;
  }
  if (perDay > li.teacher.maxPerDay) return 'maxPerDay';
  // same subject for same group not twice on one day
  for (let j = 0; j < assign.length; j++) {
    if (j === i || assign[j] === undefined) continue;
    const lj = problem.lessons[j];
    if (lj.group === li.group && lj.subject === li.subject && dayOf(dec(assign[j])[0]) === day) return 'subjectDay';
  }
  return null;
}

// ---------- solver ----------
class Backtrack {
  #stats = { nodes: 0, backtracks: 0, pruned: 0, reasons: {} };
  #limit;
  constructor(problem, { limit = 200000, heuristic = 'mrv' } = {}) {
    this.problem = problem;
    this.#limit = limit;
    this.heuristic = heuristic;
  }
  get stats() { return JSON.parse(JSON.stringify(this.#stats)); }
  #reason(r) { this.#stats.reasons[r] = (this.#stats.reasons[r] ?? 0) + 1; }

  // forward checking: returns pruned domains or null on wipeout
  #forward(domains, assign, i, v) {
    const next = domains.slice();
    for (const j of this.problem.neighbors[i]) {
      if (assign[j] !== undefined) continue;
      assign[i] = v;
      const filtered = domains[j].filter((w) => {
        const why = conflicts(this.problem, assign, j, w);
        if (why) { this.#stats.pruned++; return false; }
        return true;
      });
      assign[i] = undefined;
      if (filtered.length === 0) return null;
      next[j] = filtered;
    }
    return next;
  }

  #selectVar(domains, assign) {
    let best = -1, bestKey = Infinity;
    for (let i = 0; i < assign.length; i++) {
      if (assign[i] !== undefined) continue;
      const key = this.heuristic === 'mrv'
        ? domains[i].length * 1000 - this.problem.neighbors[i].length
        : i;
      if (key < bestKey) { bestKey = key; best = i; }
    }
    return best;
  }

  #orderValues(domains, assign, i) {
    // least constraining value: count how many neighbor options each value removes
    const scored = domains[i].map((v) => {
      let removed = 0;
      const [s] = dec(v);
      for (const j of this.problem.neighbors[i]) {
        if (assign[j] !== undefined) continue;
        for (const w of domains[j]) if (dec(w)[0] === s) removed++;
      }
      return [removed, v];
    });
    scored.sort(([a, va], [b, vb]) => a - b || va - vb);
    return scored.map(([, v]) => v);
  }

  *search(domains = this.problem.domains, assign = new Array(this.problem.lessons.length)) {
    this.#stats.nodes++;
    if (this.#stats.nodes > this.#limit) throw new RangeError('node limit');
    const i = this.#selectVar(domains, assign);
    if (i === -1) {
      yield assign.slice();
      return;
    }
    for (const v of this.#orderValues(domains, assign, i)) {
      const why = conflicts(this.problem, assign, i, v);
      if (why) { this.#reason(why); continue; }
      const nd = this.#forward(domains, assign, i, v);
      if (nd === null) { this.#reason('wipeout'); continue; }
      assign[i] = v;
      try {
        yield* this.search(nd, assign);
      } finally {
        assign[i] = undefined;
      }
    }
    this.#stats.backtracks++;
  }

  first() {
    const gen = this.search();
    try {
      const { value, done } = gen.next();
      return done ? null : value;
    } catch (e) {
      if (e instanceof RangeError) return 'limit';
      throw e;
    } finally {
      gen.return();
    }
  }

  count(max) {
    let n = 0;
    const gen = this.search();
    try {
      for (const _ of gen) {
        if (++n >= max) break;
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return -n;
    }
    return n;
  }
}

// ---------- soft constraint scoring ----------
const SOFT = {
  gaps(problem, assign) {
    let pen = 0;
    for (const g of problem.groups) {
      for (let d = 0; d < DAYS.length; d++) {
        const ps = assign
          .map((v, i) => (problem.lessons[i].group === g && dayOf(dec(v)[0]) === d ? periodOf(dec(v)[0]) : -1))
          .filter((x) => x >= 0)
          .sort((a, b) => a - b);
        for (let k = 1; k < ps.length; k++) pen += ps[k] - ps[k - 1] - 1;
      }
    }
    return pen;
  },
  preference(problem, assign) {
    let pen = 0;
    assign.forEach((v, i) => {
      const t = problem.lessons[i].teacher;
      const per = periodOf(dec(v)[0]);
      switch (t.prefers) {
        case 'morning': if (per >= 2) pen += per - 1; break;
        case 'afternoon': if (per < 2) pen += 2 - per; break;
        case 'any':
        default:
      }
    });
    return pen;
  },
  friday(problem, assign) {
    return assign.filter((v) => dayOf(dec(v)[0]) === 4 && periodOf(dec(v)[0]) === PERIODS - 1).length * 2;
  },
  roomChanges(problem, assign) {
    let pen = 0;
    for (const g of problem.groups) {
      const seq = assign
        .map((v, i) => [dec(v), problem.lessons[i].group === g])
        .filter(([, mine]) => mine)
        .map(([[s, r]]) => [s, r])
        .sort(([a], [b]) => a - b);
      for (let k = 1; k < seq.length; k++) {
        if (dayOf(seq[k][0]) === dayOf(seq[k - 1][0]) && seq[k][0] - seq[k - 1][0] === 1 && seq[k][1] !== seq[k - 1][1]) pen++;
      }
    }
    return pen;
  },
};

function score(problem, assign) {
  const parts = {};
  let total = 0;
  for (const key in SOFT) {
    if (!Object.prototype.hasOwnProperty.call(SOFT, key)) continue;
    const v = SOFT[key](problem, assign);
    parts[key] = v;
    total += v;
  }
  return { total, parts };
}

// ---------- local search improvement (hill climbing with deterministic moves) ----------
function improve(problem, assign, rng, iterations) {
  let cur = assign.slice();
  let best = score(problem, cur).total;
  const history = [best];
  let accepted = 0, rejected = 0;
  outer: for (let it = 0; it < iterations; it++) {
    const i = rng(cur.length);
    const dom = problem.domains[i];
    const tries = Math.min(dom.length, 6);
    for (let k = 0; k < tries; k++) {
      const v = dom[rng(dom.length)];
      if (v === cur[i]) continue;
      const old = cur[i];
      cur[i] = undefined;
      const why = conflicts(problem, cur, i, v);
      if (why) { cur[i] = old; rejected++; continue; }
      cur[i] = v;
      const sc = score(problem, cur).total;
      if (sc <= best) {
        if (sc < best) history.push(sc);
        best = sc;
        accepted++;
        if (best === 0) break outer;
        continue outer;
      }
      cur[i] = old;
      rejected++;
    }
  }
  return { assign: cur, best, history, accepted, rejected };
}

// ---------- validation ----------
function validate(problem, assign) {
  const errors = [];
  assign.forEach((v, i) => {
    const copy = assign.slice();
    copy[i] = undefined;
    const why = conflicts(problem, copy, i, v);
    if (why) errors.push(`${i}:${why}`);
    if (!problem.domains[i].includes(v)) errors.push(`${i}:domain`);
  });
  return errors;
}

// ---------- rendering ----------
function renderGrid(problem, assign, filterFn, label) {
  const grid = Array.from({ length: PERIODS }, () => Array(DAYS.length).fill('.'));
  assign.forEach((v, i) => {
    const l = problem.lessons[i];
    if (!filterFn(l)) return;
    const [s, r] = dec(v);
    grid[periodOf(s)][dayOf(s)] = `${l.subject.slice(0, 3)}@${problem.rooms[r].id}`;
  });
  p(`-- ${label} --`);
  p('    ' + DAYS.map((d) => d.padEnd(9)).join(''));
  grid.forEach((row, per) => p(`P${per + 1}  ` + row.map((c) => c.padEnd(9)).join('')));
}

// ---------- instance builders ----------
function buildSmall() {
  Entity.clear();
  Lesson.reset();
  const t = {
    ada: new Teacher('ada', { unavailable: [slotOf(0, 0), slotOf(0, 1)], prefers: 'morning' }),
    bob: new Teacher('bob', { maxPerDay: 2, prefers: 'afternoon' }),
    cyd: new Teacher('cyd', { unavailable: [slotOf(4, 2), slotOf(4, 3)] }),
  };
  const rooms = [new Room('R1', 30), new Room('LAB', 20, ['lab']), new Room('GYM', 40, ['gym'])];
  const g = { a: new Group('7a', 25), b: new Group('7b', 18) };
  const lessons = [];
  const plan = [
    ['math', 'ada', 'a', 4], ['math', 'ada', 'b', 4],
    ['phys', 'bob', 'b', 2, ['lab']], ['chem', 'bob', 'b', 1, ['lab']],
    ['eng', 'cyd', 'a', 3], ['eng', 'cyd', 'b', 3],
    ['sport', 'bob', 'a', 2, ['gym']],
  ];
  for (const [subject, tk, gk, times, needs = []] of plan) {
    for (let k = 0; k < times; k++) lessons.push(new Lesson(subject, t[tk], g[gk], { needs }));
  }
  return new Problem({ teachers: Object.values(t), rooms, groups: Object.values(g), lessons });
}

function buildGenerated(seed, nTeachers, nGroups, perGroup) {
  Entity.clear();
  Lesson.reset();
  const rng = lcg(seed);
  const prefs = ['morning', 'afternoon', 'any'];
  const teachers = Array.from({ length: nTeachers }, (_, i) => {
    const un = [];
    for (let k = 0; k < 2; k++) un.push(rng(DAYS.length * PERIODS));
    return new Teacher('T' + i, { unavailable: un, maxPerDay: 3, prefers: prefs[rng(3)] });
  });
  const rooms = [new Room('A', 35), new Room('B', 30), new Room('C', 25), new Room('L', 24, ['lab'])];
  const groups = Array.from({ length: nGroups }, (_, i) => new Group('G' + i, 18 + rng(12)));
  const subjects = ['math', 'lang', 'hist', 'bio', 'art'];
  const lessons = [];
  for (const g of groups) {
    for (let k = 0; k < perGroup; k++) {
      const subj = subjects[k % subjects.length];
      const needs = subj === 'bio' && g.size <= 24 ? ['lab'] : [];
      lessons.push(new Lesson(subj, teachers[rng(nTeachers)], g, { needs }));
    }
  }
  return new Problem({ teachers, rooms, groups, lessons });
}

// ---------- scenarios ----------
function runSmall() {
  p('== small instance ==');
  const prob = buildSmall();
  p('entities', Entity.count(), 'lessons', prob.lessons.length, 'domains', prob.domainStats());
  p('neighbors sample', prob.neighbors.slice(0, 4).map((n) => n.length));
  const ada = Entity.lookup('teacher', 'ada');
  p('ada', `${ada}`, +ada, ada.blockedCount, 'room?', Room.isRoom(ada), Room.isRoom(prob.rooms[0]));
  const solver = new Backtrack(prob);
  const sol = solver.first();
  if (sol === null || sol === 'limit') {
    p('no solution', String(sol));
    return;
  }
  p('solution', sol.map((v) => { const [s, r] = dec(v); return slotName(s) + '/' + prob.rooms[r].id; }).join(' '));
  p('valid errors', validate(prob, sol));
  const st = solver.stats;
  p('stats nodes', st.nodes, 'backtracks', st.backtracks, 'pruned>0', st.pruned > 0);
  p('reasons', Object.keys(st.reasons).sort());
  const sc = score(prob, sol);
  p('score', sc);
  renderGrid(prob, sol, (l) => l.group.id === '7a', 'group 7a');
  renderGrid(prob, sol, (l) => l.group.id === '7b', 'group 7b');
  const imp = improve(prob, sol, lcg(3), 300);
  p('improved', imp.best, 'history', imp.history, 'acc', imp.accepted, 'rej', imp.rejected);
  p('improved valid', validate(prob, imp.assign).length === 0);
  renderGrid(prob, imp.assign, (l) => l.teacher.id === 'bob', 'teacher bob');
  const countSolver = new Backtrack(prob, { limit: 5000 });
  p('count up to 25', countSolver.count(25));
}

function runGenerated(seed) {
  p(`== generated seed=${seed} ==`);
  const prob = buildGenerated(seed, 5, 3, 7);
  p('lessons', prob.lessons.length, 'domains', prob.domainStats());
  const byTeacher = prob.lessons.reduce((m, l) => m.set(l.teacher.id, (m.get(l.teacher.id) ?? 0) + 1), new Map());
  p('load', JSON.stringify([...byTeacher].sort()));
  const results = {};
  for (const heuristic of ['mrv', 'static']) {
    const s = new Backtrack(prob, { heuristic, limit: 20000 });
    let sol;
    try {
      sol = s.first();
    } finally {
      results[heuristic] = { nodes: s.stats.nodes, ok: Array.isArray(sol) };
    }
    if (Array.isArray(sol)) {
      const errs = validate(prob, sol);
      const sc = score(prob, sol);
      p(`${heuristic}: errors=${errs.length} score=${sc.total} parts=${JSON.stringify(sc.parts)}`);
      if (heuristic === 'mrv') {
        const imp = improve(prob, sol, lcg(seed + 1), 400);
        p(`  improved ${sc.total} -> ${imp.best} steps=${imp.history.length}`);
        renderGrid(prob, imp.assign, (l) => l.group.id === 'G0', 'G0');
      }
    } else {
      p(`${heuristic}: ${String(sol)}`);
    }
  }
  p('heuristics', results);
}

function runInfeasible() {
  p('== infeasible ==');
  Entity.clear();
  Lesson.reset();
  const t = new Teacher('solo', { maxPerDay: 1, unavailable: Array.from({ length: 15 }, (_, i) => i) });
  const g = new Group('g', 10);
  const rooms = [new Room('X', 20)];
  const lessons = Array.from({ length: 6 }, () => new Lesson('x', t, g));
  const prob = new Problem({ teachers: [t], rooms, groups: [g], lessons });
  p('domains', prob.domainStats());
  const s = new Backtrack(prob, { limit: 100000 });
  const sol = s.first();
  p('result', String(sol), 'nodes', s.stats.nodes, 'backtracks', s.stats.backtracks);
  p('reasons', s.stats.reasons);
  try {
    new Entity('x', 'y');
  } catch (e) {
    p('abstract', e instanceof TypeError, e.message);
  }
}

// ---------- AC-3 standalone on map colouring (classic test) ----------
function ac3(vars, domains, constraints) {
  const queue = [];
  for (const [a, b] of constraints) queue.push([a, b], [b, a]);
  let revisions = 0;
  while (queue.length) {
    const [x, y] = queue.shift();
    const before = domains[x].length;
    domains[x] = domains[x].filter((vx) => domains[y].some((vy) => vy !== vx));
    if (domains[x].length !== before) {
      revisions++;
      if (!domains[x].length) return { ok: false, revisions };
      for (const [a, b] of constraints) {
        if (b === x && a !== y) queue.push([a, x]);
        else if (a === x && b !== y) queue.push([b, x]);
      }
    }
  }
  return { ok: true, revisions };
}

function colour(vars, domains, constraints, assign = {}, depth = 0) {
  const free = vars.filter((v) => !(v in assign));
  if (!free.length) return { ...assign };
  const v = free.reduce((a, b) => (domains[a].length <= domains[b].length ? a : b));
  for (const c of domains[v]) {
    if (constraints.some(([a, b]) => (a === v && assign[b] === c) || (b === v && assign[a] === c))) continue;
    assign[v] = c;
    const r = colour(vars, domains, constraints, assign, depth + 1);
    if (r) return r;
    delete assign[v];
  }
  return null;
}

function runMapColouring() {
  p('== map colouring ==');
  const vars = ['WA', 'NT', 'SA', 'Q', 'NSW', 'V', 'T'];
  const edges = [['WA', 'NT'], ['WA', 'SA'], ['NT', 'SA'], ['NT', 'Q'], ['SA', 'Q'], ['SA', 'NSW'], ['SA', 'V'], ['Q', 'NSW'], ['NSW', 'V']];
  const doms = Object.fromEntries(vars.map((v) => [v, ['r', 'g', 'b']]));
  doms.WA = ['r'];
  doms.Q = ['r'];
  const res = ac3(vars, doms, edges);
  p('ac3', res, JSON.stringify(doms));
  const sol = colour(vars, doms, edges);
  p('colouring', JSON.stringify(sol));
  const two = Object.fromEntries(vars.map((v) => [v, ['r', 'g']]));
  p('two colours', ac3(vars, two, edges).ok, JSON.stringify(colour(vars, two, edges)));
}

// ---------- N-queens via same generator machinery, deep recursion check ----------
function* queens(n, row = 0, cols = [], diag1 = new Set(), diag2 = new Set()) {
  if (row === n) { yield cols.slice(); return 1; }
  let found = 0;
  for (let c = 0; c < n; c++) {
    if (cols.includes(c) || diag1.has(row + c) || diag2.has(row - c)) continue;
    cols.push(c); diag1.add(row + c); diag2.add(row - c);
    found += yield* queens(n, row + 1, cols, diag1, diag2);
    cols.pop(); diag1.delete(row + c); diag2.delete(row - c);
  }
  return found;
}

function chainDepth(n) { return n <= 0 ? 0 : 1 + chainDepth(n - 1); }

function runQueens() {
  p('== queens ==');
  for (const n of [4, 5, 6, 8]) {
    const g = queens(n);
    let first = null, count = 0, r;
    while (!(r = g.next()).done) { count++; first ??= r.value; }
    p(`n=${n} solutions=${count} ret=${r.value} first=${JSON.stringify(first)}`);
  }
  p('chain', chainDepth(3000));
}

// ---------- async orchestration of several solves ----------
async function* solveStream(seeds) {
  for (const seed of seeds) {
    await null;
    const prob = buildGenerated(seed, 4, 2, 6);
    const s = new Backtrack(prob, { limit: 10000 });
    const sol = s.first();
    yield { seed, ok: Array.isArray(sol), score: Array.isArray(sol) ? score(prob, sol).total : null, nodes: s.stats.nodes };
  }
}

async function runAsync() {
  p('== async batch ==');
  const rows = [];
  for await (const { seed, ok, score: sc = -1, nodes } of solveStream([11, 22, 33, 44])) {
    rows.push(`${seed}:${ok ? 'ok' : 'fail'}:${sc ?? 'n/a'}:${nodes}`);
  }
  p('stream', rows);
  const tasks = [5, 6, 7].map((seed) => Promise.resolve(seed).then((s) => {
    const prob = buildGenerated(s, 4, 2, 5);
    return new Backtrack(prob).first() !== null ? s : Promise.reject(new Error('unsat ' + s));
  }));
  const settled = await Promise.allSettled(tasks);
  p('settled', settled.map((x) => x.status + ':' + (x.value ?? x.reason.message)));
}

// ---------- misc: arguments, labeled blocks, tagged template ----------
function slots() {
  var names = [];
  for (var i = 0; i < arguments.length; i++) names.push(slotName(arguments[i]));
  return names.join(',');
}
function tt(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (i < vals.length ? `<${vals[i]}>` : ''), '');
}

function runMisc() {
  p('== misc ==');
  p('slots', slots(0, 5, 19));
  p('tagged', tt`day ${DAYS[2]} period ${PERIODS} end`);
  const cfg = { weight: 0, name: '', opts: null };
  cfg.weight ||= 5;
  cfg.name ??= 'unused';
  cfg.opts ??= { depth: 2 };
  cfg.opts.depth &&= cfg.opts.depth * 10;
  p('cfg', JSON.stringify(cfg));
  check: {
    for (const d of DAYS) if (d.startsWith('W')) { p('found W', d); break check; }
    p('no W');
  }
  const { a = 1, b: { c: [first, ...rest] = [] } = {}, ...others } = { b: { c: [7, 8, 9] }, x: 1, y: 2 };
  p('destructure', a, first, rest, others);
  try {
    null.x;
  } catch ({ name: errName, message }) {
    p('catch destructure', errName, typeof message);
  }
  p('typeof', typeof undefinedThing, typeof lcg, typeof 1n, typeof Symbol.iterator);
}

async function main() {
  runSmall();
  runGenerated(101);
  runGenerated(202);
  runInfeasible();
  runMapColouring();
  runQueens();
  await runAsync();
  runMisc();
  p('printed', printed + 1);
}

main().catch(function (e) { console.log('FATAL ' + e.message); });
