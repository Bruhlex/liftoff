// Small platformer: a requestAnimationFrame-driven game loop with a fixed-timestep accumulator,
// integer fixed-point physics (1/256 px units), tile-map collision resolved axis by axis,
// entities built on a class hierarchy with private state, keyboard input from synthetic
// KeyboardEvents (scripted replay), a Proxy-backed HUD that mirrors score/lives into the DOM,
// a canvas renderer whose drawing calls are hashed by the shim, and coroutine-style enemy AI
// written as generators.
'use strict';

const out = (...a) => console.log(...a);

// ------------------------------------------------------------------ fixed point helpers
const FP = 256;
const toFp = (px) => px * FP;
const fromFp = (v) => (v >= 0 ? (v / FP) | 0 : -(((-v) / FP) | 0));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TILE = 16;

const LEVEL_SRC = [
  '##############################',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '#.......................#....#',
  '#............................#',
  '#.........o.......oo.....o...#',
  '#.P...o....E......^^....E..F.#',
  '##############################',
  '##############################',
];

// ------------------------------------------------------------------ tile map
class TileMap {
  #rows;
  #w;
  #h;
  constructor(src) {
    this.#rows = src.map((r) => r.split(''));
    this.#h = src.length;
    this.#w = src[0].length;
  }
  get width() { return this.#w; }
  get height() { return this.#h; }
  at(tx, ty) {
    if (ty < 0 || ty >= this.#h || tx < 0 || tx >= this.#w) return '#';
    return this.#rows[ty][tx];
  }
  set(tx, ty, ch) { this.#rows[ty][tx] = ch; }
  solid(tx, ty) { return this.at(tx, ty) === '#'; }
  *cells(pred) {
    for (let y = 0; y < this.#h; y++) {
      for (let x = 0; x < this.#w; x++) {
        const ch = this.#rows[y][x];
        if (pred(ch)) yield { x, y, ch };
      }
    }
  }
  checksum() {
    let h = 7;
    for (const row of this.#rows) for (const ch of row) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    return h.toString(16);
  }
}

// ------------------------------------------------------------------ entities
let entitySeq = 0;
class Entity {
  #id;
  constructor(kind, px, py, w, h) {
    this.#id = ++entitySeq;
    this.kind = kind;
    this.x = toFp(px);
    this.y = toFp(py);
    this.vx = 0;
    this.vy = 0;
    this.w = w;
    this.h = h;
    this.alive = true;
    this.onGround = false;
  }
  get id() { return this.#id; }
  get box() { return { l: fromFp(this.x), t: fromFp(this.y), r: fromFp(this.x) + this.w, b: fromFp(this.y) + this.h }; }
  overlaps(o) {
    const a = this.box, b = o.box;
    return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  }
  update() {}
  describe() { const { l, t } = this.box; return `${this.kind}#${this.#id}@${l},${t}`; }
}

const GRAVITY = 90;
const MAX_FALL = toFp(6);
const WALK_ACC = 60;
const WALK_MAX = toFp(2);
const FRICTION = 40;
const JUMP_V = -toFp(5);

class Body extends Entity {
  moveAndCollide(map) {
    const hits = [];
    // horizontal
    this.x += this.vx;
    let { l, t, r, b } = this.box;
    for (let ty = (t / TILE) | 0; ty <= ((b - 1) / TILE) | 0; ty++) {
      if (this.vx > 0 && map.solid(((r - 1) / TILE) | 0, ty)) {
        this.x = toFp((((r - 1) / TILE) | 0) * TILE - this.w);
        this.vx = 0; hits.push('R'); break;
      }
      if (this.vx < 0 && map.solid((l / TILE) | 0, ty)) {
        this.x = toFp((((l / TILE) | 0) + 1) * TILE);
        this.vx = 0; hits.push('L'); break;
      }
    }
    // vertical
    this.y += this.vy;
    ({ l, t, r, b } = this.box);
    this.onGround = false;
    for (let tx = (l / TILE) | 0; tx <= ((r - 1) / TILE) | 0; tx++) {
      if (this.vy > 0 && map.solid(tx, ((b - 1) / TILE) | 0)) {
        this.y = toFp((((b - 1) / TILE) | 0) * TILE - this.h);
        this.vy = 0; this.onGround = true; hits.push('D'); break;
      }
      if (this.vy < 0 && map.solid(tx, (t / TILE) | 0)) {
        this.y = toFp((((t / TILE) | 0) + 1) * TILE);
        this.vy = 0; hits.push('U'); break;
      }
    }
    return hits;
  }
  applyGravity() { this.vy = Math.min(this.vy + GRAVITY, MAX_FALL); }
}

class Player extends Body {
  #coyote = 0;
  #jumpBuffer = 0;
  #facing = 1;
  constructor(px, py) { super('player', px, py, 12, 14); this.lives = 3; this.spawn = [px, py]; this.invuln = 0; }
  get facing() { return this.#facing; }
  update(input, map) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) {
      this.#facing = dir;
      this.vx = clamp(this.vx + dir * WALK_ACC, -WALK_MAX, WALK_MAX);
    } else if (this.vx > 0) this.vx = Math.max(0, this.vx - FRICTION);
    else if (this.vx < 0) this.vx = Math.min(0, this.vx + FRICTION);
    this.#coyote = this.onGround ? 6 : Math.max(0, this.#coyote - 1);
    this.#jumpBuffer = input.jumpPressed ? 5 : Math.max(0, this.#jumpBuffer - 1);
    let jumped = false;
    if (this.#jumpBuffer > 0 && this.#coyote > 0) {
      this.vy = JUMP_V;
      this.#coyote = 0;
      this.#jumpBuffer = 0;
      jumped = true;
    }
    if (!input.jump && this.vy < 0) this.vy = Math.trunc(this.vy / 2); // variable jump height
    this.applyGravity();
    const hits = this.moveAndCollide(map);
    if (this.invuln > 0) this.invuln--;
    return { jumped, hits };
  }
  respawn() {
    const [px, py] = this.spawn;
    this.x = toFp(px); this.y = toFp(py); this.vx = 0; this.vy = 0; this.invuln = 60;
  }
}

// generator-based AI: yields a desired horizontal speed each tick
function* patrolBrain(self2, map) {
  let dir = 1;
  for (;;) {
    for (let steps = 0; steps < 48; steps++) {
      const { l, r, b } = self2.box;
      const aheadX = dir > 0 ? ((r + 1) / TILE) | 0 : ((l - 1) / TILE) | 0;
      const footY = (b / TILE) | 0;
      const blocked = map.solid(aheadX, footY - 1);
      const edge = !map.solid(aheadX, footY);
      if (blocked || edge) { dir = -dir; yield 0; break; }
      yield dir * toFp(1);
    }
    for (let i = 0; i < 10; i++) yield 0; // pause
  }
}

class Enemy extends Body {
  #brain;
  #ticks = 0;
  constructor(px, py, map) { super('enemy', px, py, 14, 14); this.#brain = patrolBrain(this, map); }
  update(_input, map) {
    this.#ticks++;
    const { value } = this.#brain.next();
    this.vx = value;
    this.applyGravity();
    this.moveAndCollide(map);
    return { ticks: this.#ticks };
  }
}

class Pickup extends Entity {
  constructor(px, py, value) { super('coin', px, py, 8, 8); this.value = value; }
}

// ------------------------------------------------------------------ input
class InputState {
  #down = new Set();
  #pressedThisTick = new Set();
  #bindings = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'jump', ArrowUp: 'jump', KeyP: 'pause' };
  attach(target) {
    const onKey = (ev) => {
      const action = this.#bindings[ev.code];
      if (!action) return;
      ev.preventDefault();
      if (ev.type === 'keydown') {
        if (!ev.repeat && !this.#down.has(action)) this.#pressedThisTick.add(action);
        this.#down.add(action);
      } else this.#down.delete(action);
    };
    target.addEventListener('keydown', onKey);
    target.addEventListener('keyup', onKey);
    return () => { target.removeEventListener('keydown', onKey); target.removeEventListener('keyup', onKey); };
  }
  snapshot() {
    const s = {
      left: this.#down.has('left'), right: this.#down.has('right'), jump: this.#down.has('jump'),
      jumpPressed: this.#pressedThisTick.has('jump'), pausePressed: this.#pressedThisTick.has('pause'),
    };
    this.#pressedThisTick.clear();
    return s;
  }
}

// scripted replay: [tick, type, code] (manual segments), merged with an autopilot that
// looks ahead in the map and presses keys like a player would
const SCRIPT = [
  [2, 'down', 'ArrowLeft'], [14, 'up', 'ArrowLeft'], [16, 'down', 'KeyD'], [20, 'down', 'Space'], [23, 'up', 'Space'],
  [60, 'down', 'KeyP'], [61, 'up', 'KeyP'], [66, 'down', 'KeyP'], [67, 'up', 'KeyP'], [80, 'up', 'KeyD'],
];

function* scriptFeeder(script) {
  let i = 0;
  let tick = 0;
  while (i < script.length) {
    const batch = [];
    while (i < script.length && script[i][0] === tick) batch.push(script[i++]);
    tick = yield batch;
  }
}

class Director {
  #feeder;
  #holdJump = 0;
  #auto = false;
  #holdingRight = false;
  constructor(script) { this.#feeder = scriptFeeder(script); this.#feeder.next(); }
  eventsFor(tick, game) {
    const evs = [];
    const { value: batch = [], done } = this.#feeder.next(tick);
    if (!done) for (const [, type, code] of batch) evs.push([type, code]);
    if (tick === 81) this.#auto = true;
    if (!this.#auto || game.hud.state !== 'playing') return evs;
    if (!this.#holdingRight) { evs.push(['down', 'ArrowRight']); this.#holdingRight = true; }
    if (this.#holdJump > 0) {
      if (--this.#holdJump === 0) evs.push(['up', 'Space']);
      return evs;
    }
    const p = game.player;
    if (!p.onGround) return evs;
    const { r, t } = p.box;
    const ty = ((t + 7) / TILE) | 0;
    let reason = null;
    scan: for (let dx = 4; dx <= 28; dx += 4) {
      const tx = ((r + dx) / TILE) | 0;
      if (dx <= 8 && game.spikes?.some((s) => tx === ((s.l / TILE) | 0) && ty === ((s.t / TILE) | 0))) { reason = 'spike'; break scan; }
      if (game.map.at(tx, ty - 1) === '.' && game.entities.some((e) => e.alive && e.kind === 'coin' && ((e.box.l / TILE) | 0) === tx && ((e.box.t / TILE) | 0) === ty - 1) && dx <= 8) { reason = 'coin'; break scan; }
      for (const e of game.entities) {
        if (e.kind !== 'enemy' || !e.alive) continue;
        const gap = e.box.l - r;
        if (gap >= 6 && gap <= 22) { reason = 'enemy'; break scan; }
      }
    }
    if (reason) {
      evs.push(['down', 'Space']);
      this.#holdJump = reason === 'enemy' ? 14 : 18;
      game.emit('autojump', { tick, reason });
    }
    return evs;
  }
}

// ------------------------------------------------------------------ HUD via Proxy
function createHud(root) {
  const nodes = {};
  for (const key of ['score', 'lives', 'coins', 'state']) {
    const span = document.createElement('span');
    span.className = 'hud-' + key;
    span.setAttribute('data-key', key);
    root.appendChild(span);
    nodes[key] = span;
  }
  const changes = [];
  const hud = new Proxy({ score: 0, lives: 3, coins: 0, state: 'boot' }, {
    set(t, k, v) {
      if (!(k in nodes)) return false;
      if (t[k] !== v) {
        changes.push(k);
        t[k] = v;
        nodes[k].textContent = String(v);
        root.dispatchEvent(new CustomEvent('hud:change', { bubbles: true, detail: { k, v } }));
      }
      return true;
    },
  });
  for (const k of Object.keys(nodes)) nodes[k].textContent = String(hud[k]);
  return { hud, changes, nodes };
}

// ------------------------------------------------------------------ renderer
class Renderer {
  #ctx;
  #canvas;
  #frames = 0;
  constructor(canvas) { this.#canvas = canvas; this.#ctx = canvas.getContext('2d'); }
  draw(game) {
    const ctx = this.#ctx;
    this.#frames++;
    const p = game.player.box;
    const camX = clamp(p.l - 160, 0, game.map.width * TILE - 320);
    ctx.save();
    ctx.fillStyle = '#87ceeb';
    ctx.fillRect(0, 0, 320, 208);
    ctx.translate(-camX, 0);
    ctx.fillStyle = '#654321';
    for (const { x, y } of game.solidCells) {
      if (x * TILE + TILE < camX || x * TILE > camX + 320) continue;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
    for (const e of game.entities) {
      if (!e.alive) continue;
      const b = e.box;
      ctx.fillStyle = e.kind === 'player' ? (game.player.invuln % 4 < 2 ? '#ff0000' : '#ffffff') : e.kind === 'enemy' ? '#800080' : '#ffd700';
      if (e.kind === 'coin') { ctx.beginPath(); ctx.arc(b.l + 4, b.t + 4, 4, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(b.l, b.t, e.w, e.h);
    }
    ctx.restore();
    ctx.font = '10px monospace';
    ctx.fillStyle = '#000';
    ctx.fillText('S' + game.hud.score + ' L' + game.hud.lives, 4, 12);
    return camX;
  }
  get frames() { return this.#frames; }
  hash() { const u = this.#canvas.toDataURL(); let h = 0; for (let i = 0; i < u.length; i++) h = (Math.imul(h, 33) ^ u.charCodeAt(i)) >>> 0; return h.toString(36); }
}

// ------------------------------------------------------------------ game
class Game extends EventTarget {
  #accum = 0;
  #last = null;
  #tick = 0;
  #paused = false;
  constructor(src, hud) {
    super();
    this.map = new TileMap(src);
    this.hud = hud;
    this.entities = [];
    this.solidCells = [...this.map.cells((c) => c === '#')];
    for (const { x, y, ch } of this.map.cells((c) => /[PoEF^]/.test(c))) {
      const px = x * TILE, py = y * TILE;
      switch (ch) {
        case 'P': this.player = new Player(px + 2, py + 2); this.entities.push(this.player); break;
        case 'o': this.entities.push(new Pickup(px + 4, py + 4, 10)); break;
        case 'E': this.entities.push(new Enemy(px + 1, py + 2, this.map)); break;
        case 'F': this.flag = { x: px, y: py }; break;
        case '^': (this.spikes ||= []).push({ l: px, t: py + 8, r: px + TILE, b: py + TILE }); break;
        default: break;
      }
      this.map.set(x, y, '.');
    }
    this.entities.sort((a, b) => (a.kind === 'player') - (b.kind === 'player') || a.id - b.id);
  }
  get tick() { return this.#tick; }
  get paused() { return this.#paused; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  step(input) {
    this.#tick++;
    if (input.pausePressed) {
      this.#paused = !this.#paused;
      this.hud.state = this.#paused ? 'paused' : 'playing';
      this.emit('pause', { paused: this.#paused, tick: this.#tick });
    }
    if (this.#paused) return;
    const { jumped, hits } = this.player.update(input, this.map);
    if (jumped) this.emit('jump', { tick: this.#tick, at: this.player.describe() });
    if (hits.includes('U')) this.emit('bonk', { tick: this.#tick });
    for (const e of this.entities) {
      if (!e.alive || e === this.player) continue;
      e.update(input, this.map);
      if (!e.overlaps(this.player)) continue;
      if (e instanceof Pickup) {
        e.alive = false;
        this.hud.coins += 1;
        this.hud.score += e.value;
        this.emit('coin', { tick: this.#tick, id: e.id });
      } else if (e instanceof Enemy) {
        const stomp = this.player.vy > 0 && this.player.box.b - e.box.t <= 6;
        if (stomp) {
          e.alive = false;
          this.player.vy = Math.trunc(JUMP_V * 0.6);
          this.hud.score += 50;
          this.emit('stomp', { tick: this.#tick, id: e.id });
        } else if (this.player.invuln === 0) this.hurt('enemy');
      }
    }
    const pb = this.player.box;
    for (const s of this.spikes || []) {
      if (pb.l < s.r && pb.r > s.l && pb.t < s.b && pb.b > s.t && this.player.invuln === 0) { this.hurt('spike'); break; }
    }
    if (this.flag && pb.l < this.flag.x + TILE && pb.r > this.flag.x && pb.b > this.flag.y && pb.t < this.flag.y + TILE && this.hud.state !== 'won') {
      this.hud.state = 'won';
      this.hud.score += 100 * this.hud.lives;
      this.emit('win', { tick: this.#tick });
    }
  }
  hurt(cause) {
    this.hud.lives -= 1;
    this.player.lives = this.hud.lives;
    this.emit('hurt', { tick: this.#tick, cause, lives: this.hud.lives });
    if (this.hud.lives <= 0) { this.hud.state = 'gameover'; return; }
    this.player.respawn();
  }
  // fixed timestep accumulator driven by rAF timestamps (ms)
  advance(ts, pollInput) {
    if (this.#last === null) { this.#last = ts; return 0; }
    this.#accum += Math.round((ts - this.#last) * 1000);
    this.#last = ts;
    let steps = 0;
    const STEP_US = 16667;
    try {
      while (this.#accum >= STEP_US) {
        if (steps >= 4) { this.#accum = 0; break; } // spiral-of-death guard
        this.#accum -= STEP_US;
        this.step(pollInput());
        steps++;
        if (this.hud.state === 'won' || this.hud.state === 'gameover') return steps;
      }
      return steps;
    } finally {
      this.lastSteps = steps;
    }
  }
}

// ------------------------------------------------------------------ run
async function* frameStream(limit) {
  for (let i = 0; i < limit; i++) {
    const ts = await new Promise((res) => requestAnimationFrame(res));
    yield { i, ts };
  }
}

async function run() {
  const app = document.getElementById('app');
  const hudRoot = document.createElement('div');
  hudRoot.id = 'hud';
  app.appendChild(hudRoot);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 208;
  app.appendChild(canvas);

  const { hud, changes, nodes } = createHud(hudRoot);
  const hudEvents = [];
  document.addEventListener('hud:change', (ev) => { if (ev.detail.k === 'lives' || ev.detail.k === 'state') hudEvents.push(ev.detail.k + ':' + ev.detail.v); });

  const game = new Game(LEVEL_SRC, hud);
  const renderer = new Renderer(canvas);
  const input = new InputState();
  const detach = input.attach(window);

  const evLog = [];
  const counts = {};
  for (const type of ['jump', 'coin', 'stomp', 'hurt', 'win', 'pause', 'bonk', 'autojump']) {
    counts[type] = 0;
    game.addEventListener(type, (ev) => {
      counts[type]++;
      evLog.push(`${type}@${ev.detail.tick}${ev.detail.cause || ev.detail.reason ? '(' + (ev.detail.cause || ev.detail.reason) + ')' : ''}`);
    });
  }

  out('map', game.map.width + 'x' + game.map.height, 'checksum', game.map.checksum(), 'solid', game.solidCells.length);
  out('entities', game.entities.map((e) => e.describe()).join(' '));
  out('spikes', JSON.stringify(game.spikes), 'flag', JSON.stringify(game.flag));

  // a canvas-level key handler that swallows keys when the game is over (capture on document)
  document.addEventListener('keydown', (ev) => {
    if (hud.state === 'gameover') { ev.stopPropagation(); }
  }, true);

  const director = new Director(SCRIPT);
  let scriptTick = 0;
  const pollInput = () => {
    for (const [type, code] of director.eventsFor(++scriptTick, game)) {
      window.dispatchEvent(new KeyboardEvent(type === 'down' ? 'keydown' : 'keyup', { code, key: code, cancelable: true }));
    }
    return input.snapshot();
  };

  hud.state = 'playing';
  let lastCam = -1;
  const trace = [];
  loop: for await (const { i, ts } of frameStream(600)) {
    const steps = game.advance(ts, pollInput);
    const cam = renderer.draw(game);
    if (i % 25 === 0 || cam !== lastCam && i % 10 === 0) {
      const p = game.player;
      trace.push(`f${String(i).padStart(3, '0')} t${game.tick} steps=${steps} ${p.describe()} v=(${p.vx},${p.vy}) g=${p.onGround ? 1 : 0} cam=${cam}`);
    }
    lastCam = cam;
    switch (hud.state) {
      case 'won':
      case 'gameover':
        out('stopped at frame', i, 'state', hud.state);
        break loop;
      default:
        continue loop;
    }
  }
  detach();

  out('--- trace ---');
  for (const line of trace) out(line);
  out('--- events ---');
  for (let k = 0; k < evLog.length; k += 8) out(evLog.slice(k, k + 8).join(' '));
  out('counts', JSON.stringify(counts));
  out('hud', JSON.stringify({ ...hud }), 'dom', Object.keys(nodes).map((k) => k + '=' + nodes[k].textContent).join(','));
  out('hud changes', changes.length, 'lives/state events', hudEvents.join(' '));
  out('alive', game.entities.filter((e) => e.alive).map((e) => e.describe()).join(' '));
  out('renderer frames', renderer.frames, 'canvas hash', renderer.hash());
  out('hud selector', document.querySelector('#hud .hud-score')?.textContent, document.querySelectorAll('#hud span').length);

  // determinism self-check: re-simulate headless without rAF, compare final state
  const hud2 = { score: 0, lives: 3, coins: 0, state: 'playing' };
  const g2 = new Game(LEVEL_SRC, hud2);
  const in2 = new InputState();
  const fake = new EventTarget();
  in2.attach(fake);
  const d2 = new Director(SCRIPT);
  let t2 = 0;
  while (t2 < game.tick) {
    for (const [type, code] of d2.eventsFor(++t2, g2)) fake.dispatchEvent(new KeyboardEvent(type === 'down' ? 'keydown' : 'keyup', { code }));
    g2.step(in2.snapshot());
    if (hud2.state === 'won' || hud2.state === 'gameover') break;
  }
  const pos = (e) => e.describe().replace(/#\d+/, '');
  out('headless replay', t2, 'ticks', pos(g2.player), 'match', pos(g2.player) === pos(game.player) && hud2.score === hud.score, JSON.stringify(hud2));
}

run().then(() => out('done'), (e) => out('crash', e instanceof Error ? 'error' : String(e)));
