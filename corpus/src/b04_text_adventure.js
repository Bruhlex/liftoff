// Text adventure state machine driven by a scripted command list.
'use strict';

const DIRECTIONS = { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };

const STATE = Object.freeze({
  EXPLORING: 'EXPLORING',
  COMBAT: 'COMBAT',
  DIALOG: 'DIALOG',
  DEAD: 'DEAD',
  WON: 'WON',
});

class Item {
  constructor(id, name, { weight = 1, value = 0, damage = 0, heals = 0, key = null } = {}) {
    Object.assign(this, { id, name, weight, value, damage, heals, key });
  }
  get isWeapon() {
    return this.damage > 0;
  }
  describe() {
    const tags = [];
    if (this.isWeapon) tags.push(`dmg ${this.damage}`);
    if (this.heals) tags.push(`heals ${this.heals}`);
    if (this.key) tags.push(`opens ${this.key}`);
    return `${this.name}${tags.length ? ' (' + tags.join(', ') + ')' : ''}`;
  }
}

class Room {
  constructor(id, title, description) {
    this.id = id;
    this.title = title;
    this.description = description;
    this.exits = new Map();
    this.locked = new Map();
    this.items = [];
    this.npc = null;
    this.visits = 0;
  }
  connect(dir, room, lockId = null) {
    this.exits.set(dir, room);
    room.exits.set(OPPOSITE[dir], this);
    if (lockId) {
      this.locked.set(dir, lockId);
      room.locked.set(OPPOSITE[dir], lockId);
    }
    return this;
  }
  take(name) {
    const idx = this.items.findIndex((i) => i.id === name || i.name.toLowerCase() === name);
    return idx >= 0 ? this.items.splice(idx, 1)[0] : null;
  }
}

class Creature {
  #hp;
  constructor(name, hp, attack, loot = []) {
    this.name = name;
    this.maxHp = hp;
    this.#hp = hp;
    this.attack = attack;
    this.loot = loot;
  }
  get hp() {
    return this.#hp;
  }
  set hp(v) {
    this.#hp = Math.max(0, Math.min(this.maxHp, v));
  }
  get alive() {
    return this.#hp > 0;
  }
}

class Npc {
  constructor(name, lines, gift = null) {
    this.name = name;
    this.lines = lines;
    this.gift = gift;
    this.talked = 0;
  }
  *conversation() {
    for (const line of this.lines) {
      const reply = yield line;
      if (reply === 'bye') return 'The conversation ends abruptly.';
    }
    return this.gift ? `${this.name} hands you ${this.gift.name}.` : `${this.name} nods.`;
  }
}

// deterministic pseudo-random for combat
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

class Player extends Creature {
  constructor(name) {
    super(name, 30, 2);
    this.inventory = [];
    this.capacity = 10;
    this.score = 0;
    this.moves = 0;
  }
  get load() {
    return this.inventory.reduce((w, i) => w + i.weight, 0);
  }
  get weapon() {
    return this.inventory.filter((i) => i.isWeapon).sort((a, b) => b.damage - a.damage)[0] ?? null;
  }
  has(pred) {
    return this.inventory.some(pred);
  }
}

class Game {
  constructor(seed = 42) {
    this.rand = lcg(seed);
    this.state = STATE.EXPLORING;
    this.player = new Player('Hero');
    this.transcript = [];
    this.flags = new Set();
    this.dialog = null;
    this.enemy = null;
    this.buildWorld();
    this.location = this.rooms.get('gate');
    this.location.visits++;
  }

  buildWorld() {
    const r = (id, t, d) => [id, new Room(id, t, d)];
    this.rooms = new Map([
      r('gate', 'Castle Gate', 'A rusted portcullis looms above.'),
      r('yard', 'Courtyard', 'Weeds crack through the flagstones.'),
      r('armory', 'Armory', 'Empty racks line the walls.'),
      r('hall', 'Great Hall', 'A long table, set for no one.'),
      r('cellar', 'Cellar', 'It smells of damp and old wine.'),
      r('tower', 'Tower Top', 'Wind howls around the battlements.'),
      r('vault', 'Vault', 'Gold glitters in the torchlight.'),
    ]);
    const R = (id) => this.rooms.get(id);
    R('gate').connect('north', R('yard'));
    R('yard').connect('east', R('armory')).connect('north', R('hall'));
    R('hall').connect('down', R('cellar')).connect('up', R('tower'), 'brass');
    R('cellar').connect('east', R('vault'), 'iron');

    R('gate').items.push(new Item('stick', 'Stick', { damage: 1 }));
    R('armory').items.push(new Item('sword', 'Sword', { weight: 4, damage: 6, value: 20 }), new Item('anvil', 'Anvil', { weight: 20 }));
    R('yard').items.push(new Item('herb', 'Herb', { heals: 8 }));
    R('cellar').items.push(new Item('wine', 'Wine', { heals: 3, value: 5 }));
    R('tower').items.push(new Item('ironkey', 'Iron Key', { key: 'iron' }));
    R('vault').items.push(new Item('crown', 'Crown', { weight: 2, value: 100 }));

    R('hall').npc = new Npc('Ghost', ['Who disturbs my rest?', 'The tower holds a key.', 'Beware the rat king below.'], new Item('brasskey', 'Brass Key', { key: 'brass' }));
    this.monsters = new Map([
      ['cellar', new Creature('Rat King', 14, 3, [new Item('tooth', 'Rat Tooth', { value: 2 })])],
    ]);
  }

  say(msg) {
    this.transcript.push(msg);
    console.log('  ' + msg);
  }

  look() {
    const loc = this.location;
    this.say(`[${loc.title}] ${loc.description}`);
    if (loc.items.length) this.say(`You see: ${loc.items.map((i) => i.describe()).join(', ')}`);
    const exits = [...loc.exits.keys()].map((d) => (loc.locked.has(d) ? `${d}(locked)` : d));
    this.say(`Exits: ${exits.join(' ') || 'none'}`);
    if (loc.npc) this.say(`${loc.npc.name} is here.`);
  }

  move(dir) {
    dir = DIRECTIONS[dir] ?? dir;
    const loc = this.location;
    const dest = loc.exits.get(dir);
    if (!dest) return this.say(`You can't go ${dir}.`);
    const lock = loc.locked.get(dir);
    if (lock) {
      if (!this.player.has((i) => i.key === lock)) return this.say(`The way ${dir} is locked (${lock}).`);
      loc.locked.delete(dir);
      dest.locked.delete(OPPOSITE[dir]);
      this.say(`You unlock the ${lock} door.`);
      this.player.score += 5;
    }
    this.location = dest;
    this.player.moves++;
    const first = dest.visits++ === 0;
    if (first) this.player.score += 2;
    this.look();
    const monster = this.monsters.get(dest.id);
    if (monster?.alive) {
      this.enemy = monster;
      this.state = STATE.COMBAT;
      this.say(`A ${monster.name} attacks! (hp ${monster.hp})`);
    }
  }

  take(name) {
    const item = this.location.take(name);
    if (!item) return this.say(`No ${name} here.`);
    if (this.player.load + item.weight > this.player.capacity) {
      this.location.items.push(item);
      return this.say(`${item.name} is too heavy (load ${this.player.load}/${this.player.capacity}).`);
    }
    this.player.inventory.push(item);
    this.player.score += item.value > 0 ? 1 : 0;
    this.say(`Taken: ${item.describe()}.`);
    if (item.id === 'crown') {
      this.state = STATE.WON;
      this.say('The crown is yours! You win.');
    }
  }

  drop(name) {
    const idx = this.player.inventory.findIndex((i) => i.id === name);
    if (idx < 0) return this.say(`You have no ${name}.`);
    const [item] = this.player.inventory.splice(idx, 1);
    this.location.items.push(item);
    this.say(`Dropped ${item.name}.`);
  }

  use(name) {
    const item = this.player.inventory.find((i) => i.id === name);
    if (!item) return this.say(`You have no ${name}.`);
    if (item.heals) {
      const before = this.player.hp;
      this.player.hp += item.heals;
      this.player.inventory.splice(this.player.inventory.indexOf(item), 1);
      return this.say(`You use ${item.name}: hp ${before} -> ${this.player.hp}.`);
    }
    this.say(`Nothing happens with ${item.name}.`);
  }

  talk() {
    const npc = this.location.npc;
    if (!npc) return this.say('Nobody to talk to.');
    this.dialog = npc.conversation();
    this.state = STATE.DIALOG;
    const { value } = this.dialog.next();
    this.say(`${npc.name}: "${value}"`);
  }

  reply(text) {
    const res = this.dialog.next(text);
    const npc = this.location.npc;
    if (res.done) {
      this.say(res.value);
      if (npc.gift && text !== 'bye') {
        this.player.inventory.push(npc.gift);
        npc.gift = null;
        this.player.score += 3;
      }
      npc.talked++;
      this.dialog = null;
      this.state = STATE.EXPLORING;
    } else {
      this.say(`${npc.name}: "${res.value}"`);
    }
  }

  attack() {
    const p = this.player;
    const e = this.enemy;
    const weapon = p.weapon;
    const dmg = p.attack + (weapon?.damage ?? 0) + Math.floor(this.rand() * 3);
    e.hp -= dmg;
    this.say(`You hit ${e.name} with ${weapon?.name ?? 'fists'} for ${dmg} (hp ${e.hp}).`);
    if (!e.alive) {
      this.say(`${e.name} is defeated!`);
      this.location.items.push(...e.loot);
      p.score += 10;
      this.enemy = null;
      this.state = STATE.EXPLORING;
      return;
    }
    const back = e.attack + Math.floor(this.rand() * 4);
    p.hp -= back;
    this.say(`${e.name} strikes back for ${back} (your hp ${p.hp}).`);
    if (!p.alive) {
      this.state = STATE.DEAD;
      this.say('You have died.');
    }
  }

  flee() {
    const back = [...this.location.exits.entries()].find(([d]) => !this.location.locked.has(d));
    this.say(`You flee ${back[0]}!`);
    this.enemy = null;
    this.state = STATE.EXPLORING;
    this.move(back[0]);
  }

  inventory() {
    const inv = this.player.inventory;
    this.say(inv.length ? `Carrying (${this.player.load}/${this.player.capacity}): ${inv.map((i) => i.name).join(', ')}` : 'You carry nothing.');
  }

  handle(line) {
    const [verb = '', ...rest] = line.trim().toLowerCase().split(/\s+/);
    const arg = rest.join(' ');
    const allowed = {
      [STATE.EXPLORING]: ['look', 'go', 'n', 's', 'e', 'w', 'u', 'd', 'take', 'drop', 'use', 'talk', 'inv', 'score'],
      [STATE.COMBAT]: ['attack', 'flee', 'use', 'inv'],
      [STATE.DIALOG]: ['say'],
      [STATE.DEAD]: [],
      [STATE.WON]: ['score'],
    }[this.state];
    if (!allowed.includes(verb)) {
      return this.say(`(${verb || 'nothing'} is not possible while ${this.state})`);
    }
    switch (verb) {
      case 'look': return this.look();
      case 'go': return this.move(arg);
      case 'n': case 's': case 'e': case 'w': case 'u': case 'd':
        return this.move(verb);
      case 'take': return this.take(arg);
      case 'drop': return this.drop(arg);
      case 'use': return this.use(arg);
      case 'talk': return this.talk();
      case 'say': return this.reply(arg);
      case 'attack': return this.attack();
      case 'flee': return this.flee();
      case 'inv': return this.inventory();
      case 'score':
        return this.say(`Score ${this.player.score} in ${this.player.moves} moves, hp ${this.player.hp}/${this.player.maxHp}`);
    }
  }
}

function play(script, seed, startHp = null) {
  const game = new Game(seed);
  if (startHp !== null) game.player.hp = startHp;
  console.log(`=== new game (seed ${seed}) ===`);
  game.look();
  let turn = 0;
  for (const cmd of script) {
    turn++;
    console.log(`> ${cmd}   [${game.state}]`);
    game.handle(cmd);
    if (game.state === STATE.DEAD || game.state === STATE.WON) {
      console.log(`Game over at turn ${turn}: ${game.state}`);
      break;
    }
  }
  const visited = [...game.rooms.values()].filter((r) => r.visits > 0).map((r) => `${r.id}:${r.visits}`);
  console.log('visited', visited.join(' '));
  console.log('final', JSON.stringify({ state: game.state, score: game.player.score, hp: game.player.hp, lines: game.transcript.length }));
  return game;
}

const SCRIPT_WIN = [
  'take stick', 'n', 'take herb', 'e', 'take anvil', 'take sword', 'w', 'n', 'talk', 'say hello',
  'say go on', 'say thanks', 'u', 'take ironkey', 'd', 'inv', 'd', 'attack', 'attack', 'use herb',
  'attack', 'attack', 'take tooth', 'look', 'e', 'score', 'take crown', 'score',
];
const SCRIPT_LOSE = ['n', 'n', 'dance', 'd', 'attack', 'flee', 'd', 'attack', 'attack', 'attack', 'attack', 'attack', 'attack', 'attack', 'attack'];

play(SCRIPT_WIN, 7);
play(SCRIPT_LOSE, 3, 14);
