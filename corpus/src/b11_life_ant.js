// Conway's Game of Life + Langton's Ant, printing grids as text
'use strict';

class Grid {
  #w;
  #h;
  #cells;
  static #instances = 0;
  constructor(w, h, fill = 0) {
    this.#w = w;
    this.#h = h;
    this.#cells = new Uint8Array(w * h).fill(fill);
    Grid.#instances++;
  }
  static get instances() { return Grid.#instances; }
  static fromStrings(rows, on = '#') {
    const g = new Grid(rows[0].length, rows.length);
    rows.forEach((row, y) => [...row].forEach((ch, x) => g.set(x, y, ch === on ? 1 : 0)));
    return g;
  }
  get width() { return this.#w; }
  get height() { return this.#h; }
  #idx(x, y) {
    const xx = ((x % this.#w) + this.#w) % this.#w;
    const yy = ((y % this.#h) + this.#h) % this.#h;
    return yy * this.#w + xx;
  }
  get(x, y) { return this.#cells[this.#idx(x, y)]; }
  set(x, y, v) { this.#cells[this.#idx(x, y)] = v; }
  get population() {
    let n = 0;
    for (const c of this.#cells) n += c ? 1 : 0;
    return n;
  }
  clone() {
    const g = new Grid(this.#w, this.#h);
    for (let y = 0; y < this.#h; y++) for (let x = 0; x < this.#w; x++) g.set(x, y, this.get(x, y));
    return g;
  }
  equals(other) {
    if (other.width !== this.#w || other.height !== this.#h) return false;
    for (let y = 0; y < this.#h; y++) for (let x = 0; x < this.#w; x++) if (this.get(x, y) !== other.get(x, y)) return false;
    return true;
  }
  hash() {
    let h = 2166136261;
    for (let i = 0; i < this.#cells.length; i++) {
      h ^= this.#cells[i] + i * 7;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  *rows() {
    for (let y = 0; y < this.#h; y++) {
      const cells = [];
      for (let x = 0; x < this.#w; x++) cells.push(this.get(x, y));
      yield cells;
    }
  }
  render(palette = ['.', '#']) {
    return [...this.rows()].map((r) => r.map((c) => palette[c] ?? '?').join('')).join('\n');
  }
  boundingBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < this.#h; y++) {
      for (let x = 0; x < this.#w; x++) {
        if (!this.get(x, y)) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }
}

const RULES = {
  conway: { birth: new Set([3]), survive: new Set([2, 3]) },
  highlife: { birth: new Set([3, 6]), survive: new Set([2, 3]) },
  seeds: { birth: new Set([2]), survive: new Set() },
};

function parseRule(str) {
  const m = /^B(\d*)\/S(\d*)$/i.exec(str);
  if (!m) throw new SyntaxError(`bad rule ${str}`);
  const [, b, s] = m;
  return { birth: new Set([...b].map(Number)), survive: new Set([...s].map(Number)) };
}

function neighbours(grid, x, y) {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      n += grid.get(x + dx, y + dy);
    }
  }
  return n;
}

function step(grid, rule = RULES.conway) {
  const next = new Grid(grid.width, grid.height);
  let births = 0, deaths = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const alive = grid.get(x, y) === 1;
      const n = neighbours(grid, x, y);
      const live = alive ? rule.survive.has(n) : rule.birth.has(n);
      if (live) next.set(x, y, 1);
      if (live && !alive) births++;
      else if (!live && alive) deaths++;
    }
  }
  return { next, births, deaths };
}

function* simulate(grid, generations, rule) {
  let g = grid;
  for (let i = 1; i <= generations; i++) {
    const { next, births, deaths } = step(g, rule);
    g = next;
    yield { gen: i, grid: g, births, deaths };
  }
}

function detectCycle(grid, maxGen, rule) {
  const seen = new Map([[grid.hash(), 0]]);
  let gen = 0;
  for (const { gen: gnum, grid: g } of simulate(grid, maxGen, rule)) {
    gen = gnum;
    const h = g.hash();
    if (seen.has(h)) return { start: seen.get(h), period: gnum - seen.get(h) };
    seen.set(h, gnum);
  }
  return { start: -1, period: 0, checked: gen };
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const DIR_NAMES = 'NESW';

class Ant {
  #x;
  #y;
  #dir = 0;
  #steps = 0;
  constructor(x, y, rule = 'RL') {
    this.#x = x;
    this.#y = y;
    this.rule = rule;
  }
  get position() { return [this.#x, this.#y]; }
  get heading() { return DIR_NAMES[this.#dir]; }
  get steps() { return this.#steps; }
  tick(grid) {
    const colors = this.rule.length;
    const c = grid.get(this.#x, this.#y);
    const turn = this.rule[c];
    switch (turn) {
      case 'R': this.#dir = (this.#dir + 1) % 4; break;
      case 'L': this.#dir = (this.#dir + 3) % 4; break;
      case 'U': this.#dir = (this.#dir + 2) % 4; break;
      case 'N': break;
      default: throw new Error(`bad turn ${turn}`);
    }
    grid.set(this.#x, this.#y, (c + 1) % colors);
    const [dx, dy] = DIRS[this.#dir];
    this.#x = (this.#x + dx + grid.width) % grid.width;
    this.#y = (this.#y + dy + grid.height) % grid.height;
    this.#steps++;
  }
}

function runAnt(w, h, n, rule, palette) {
  const grid = new Grid(w, h);
  const ant = new Ant(w >> 1, h >> 1, rule);
  const checkpoints = new Set([10, 100, n]);
  for (let i = 1; i <= n; i++) {
    ant.tick(grid);
    if (checkpoints.has(i)) {
      const [x, y] = ant.position;
      console.log(`ant ${rule} step ${i}: pos=(${x},${y}) heading=${ant.heading} colored=${grid.population}`);
    }
  }
  console.log(grid.render(palette));
  return grid;
}

function histogram(grid) {
  const counts = {};
  for (const row of grid.rows()) for (const c of row) counts[c] = (counts[c] ?? 0) + 1;
  return counts;
}

function main() {
  const glider = Grid.fromStrings([
    '.#......',
    '..#.....',
    '###.....',
    '........',
    '........',
    '........',
  ]);
  console.log('glider gen 0:');
  console.log(glider.render());
  for (const { gen, grid, births, deaths } of simulate(glider, 8)) {
    if (gen % 4 === 0) {
      console.log(`glider gen ${gen} pop=${grid.population} +${births} -${deaths} bbox=${JSON.stringify(grid.boundingBox())}`);
      console.log(grid.render(['.', 'O']));
    }
  }

  const blinker = Grid.fromStrings(['.....', '..#..', '..#..', '..#..', '.....']);
  console.log('blinker cycle: ' + JSON.stringify(detectCycle(blinker, 10)));
  const block = Grid.fromStrings(['....', '.##.', '.##.', '....']);
  console.log('block cycle: ' + JSON.stringify(detectCycle(block, 10)));
  const gcycle = detectCycle(glider, 60);
  console.log(`glider cycle on torus: start=${gcycle.start} period=${gcycle.period}`);

  const rpent = Grid.fromStrings([
    '................',
    '................',
    '................',
    '.......##.......',
    '......##........',
    '.......#........',
    '................',
    '................',
    '................',
    '................',
  ]);
  const pops = [];
  let last = rpent;
  for (const { grid } of simulate(rpent, 30, RULES.conway)) { pops.push(grid.population); last = grid; }
  console.log(`r-pentomino pops: ${pops.join(',')}`);
  console.log(last.render());

  for (const [name, rule] of Object.entries(RULES)) {
    let g = rpent.clone();
    for (let i = 0; i < 5; i++) g = step(g, rule).next;
    console.log(`rule ${name}: pop after 5 = ${g.population} hash=${g.hash()}`);
  }
  const custom = parseRule('B36/S23');
  console.log(`custom rule equals highlife: ${[...custom.birth].join('') === [...RULES.highlife.birth].join('')}`);
  try {
    parseRule('X1/Y2');
  } catch (e) {
    console.log(`rule error: ${e.name}: ${e.message}`);
  }

  runAnt(21, 11, 400, 'RL', ['.', '#']);
  const g2 = runAnt(17, 9, 300, 'RLR', ' +*');
  console.log('histogram RLR: ' + JSON.stringify(histogram(g2)));
  const g3 = runAnt(15, 9, 250, 'LLRR', '.abc');
  console.log('histogram LLRR: ' + JSON.stringify(histogram(g3)));
  try {
    new Ant(0, 0, 'RX').tick(new Grid(3, 3, 1));
  } catch (e) {
    console.log('ant error: ' + e.message);
  }
  console.log(`grids created: ${Grid.instances > 50 ? 'many' : Grid.instances}`);
  console.log(`glider equals clone: ${glider.equals(glider.clone())}, equals block: ${glider.equals(block)}`);
}

main();
