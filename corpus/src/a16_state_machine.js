// a16: event emitter + state machine simulation with callbacks

class EventEmitter {
  constructor() {
    this._handlers = Object.create(null);
    this._anyHandlers = [];
  }
  on(evt, fn) {
    (this._handlers[evt] ||= []).push({ fn, once: false });
    return this;
  }
  once(evt, fn) {
    (this._handlers[evt] ||= []).push({ fn, once: true });
    return this;
  }
  off(evt, fn) {
    const list = this._handlers[evt];
    if (!list) return this;
    this._handlers[evt] = list.filter((h) => h.fn !== fn);
    return this;
  }
  onAny(fn) {
    this._anyHandlers.push(fn);
    return () => {
      this._anyHandlers = this._anyHandlers.filter((f) => f !== fn);
    };
  }
  emit(evt, ...args) {
    const list = this._handlers[evt];
    this._anyHandlers.forEach((f) => f(evt, args));
    if (!list || list.length === 0) return false;
    for (const h of [...list]) {
      if (h.once) this.off(evt, h.fn);
      h.fn.apply(this, args);
    }
    return true;
  }
  listenerCount(evt) {
    return (this._handlers[evt] || []).length;
  }
}

class StateMachine extends EventEmitter {
  constructor(config) {
    super();
    this.state = config.initial;
    this.transitions = config.transitions;
    this.guards = config.guards || {};
    this.history = [config.initial];
    this.context = { ...(config.context || {}) };
  }
  can(event) {
    const t = this.transitions[this.state]?.[event];
    if (!t) return false;
    const guard = this.guards[this.state + ':' + event];
    return guard ? guard(this.context) : true;
  }
  send(event, payload) {
    const target = this.transitions[this.state]?.[event];
    if (!target) {
      this.emit('rejected', this.state, event);
      return false;
    }
    if (!this.can(event)) {
      this.emit('guarded', this.state, event);
      return false;
    }
    const from = this.state;
    this.emit('exit:' + from, payload);
    this.state = typeof target === 'function' ? target(this.context, payload) : target;
    this.history.push(this.state);
    this.emit('enter:' + this.state, payload);
    this.emit('transition', from, this.state, event);
    return true;
  }
}

function emitterBasics() {
  const e = new EventEmitter();
  const log = [];
  const h1 = (x) => log.push('h1:' + x);
  e.on('data', h1);
  e.on('data', function (x) {
    log.push('h2:' + x + ':' + (this === e));
  });
  e.once('data', (x) => log.push('once:' + x));
  const unsub = e.onAny((evt, args) => log.push('any:' + evt + '/' + args.length));
  e.emit('data', 1);
  e.emit('data', 2);
  e.off('data', h1);
  e.emit('data', 3);
  unsub();
  console.log('emit none', e.emit('nothing'));
  e.emit('data', 4);
  console.log('emitter log', log.join(' '));
  console.log('listenerCount', e.listenerCount('data'), e.listenerCount('nope'));
  const e2 = new EventEmitter();
  const order = [];
  e2.on('x', () => {
    order.push('a');
    e2.on('x', () => order.push('late'));
  });
  e2.on('x', () => order.push('b'));
  e2.emit('x');
  e2.emit('x');
  console.log('handler added during emit', order.join(''));
}

function trafficLight() {
  const light = new StateMachine({
    initial: 'red',
    transitions: {
      red: { TIMER: 'green', FAIL: 'flashing' },
      green: { TIMER: 'yellow', FAIL: 'flashing' },
      yellow: { TIMER: 'red', FAIL: 'flashing' },
      flashing: { RESET: 'red' },
    },
  });
  const log = [];
  light.on('transition', (f, t, ev) => log.push(f + '-' + ev + '->' + t));
  light.on('rejected', (s, ev) => log.push('REJECT ' + ev + '@' + s));
  ['TIMER', 'TIMER', 'TIMER', 'TIMER', 'RESET', 'FAIL', 'TIMER', 'RESET', 'TIMER'].forEach((ev) => light.send(ev));
  log.forEach((l) => console.log('  light', l));
  console.log('light history', light.history.join('>'));
}

function vendingMachine() {
  const vm = new StateMachine({
    initial: 'idle',
    context: { credit: 0, stock: { cola: 2, chips: 1 }, sold: [] },
    transitions: {
      idle: { COIN: 'hasCredit' },
      hasCredit: {
        COIN: 'hasCredit',
        SELECT: (ctx, item) => {
          ctx.credit -= 3;
          ctx.stock[item]--;
          ctx.sold.push(item);
          return ctx.credit > 0 ? 'hasCredit' : 'idle';
        },
        REFUND: (ctx) => {
          ctx.credit = 0;
          return 'idle';
        },
      },
    },
    guards: {
      'hasCredit:SELECT': (ctx) => ctx.credit >= 3,
    },
  });
  vm.on('enter:hasCredit', function (amount) {
    if (typeof amount === 'number') this.context.credit += amount;
    console.log('  credit now', this.context.credit);
  });
  vm.on('guarded', (s, ev) => console.log('  guarded', ev, 'in', s, 'credit', vm.context.credit));
  vm.on('rejected', (s, ev) => console.log('  rejected', ev, 'in', s));
  vm.on('enter:idle', () => console.log('  back to idle, credit', vm.context.credit));
  const actions = [
    ['SELECT', 'cola'],
    ['COIN', 1],
    ['SELECT', 'cola'],
    ['COIN', 2],
    ['SELECT', 'cola'],
    ['COIN', 5],
    ['SELECT', 'chips'],
    ['SELECT', 'cola'],
    ['COIN', 1],
    ['REFUND'],
  ];
  for (const [ev, p] of actions) {
    const ok = vm.send(ev, p);
    console.log('send', ev, p === undefined ? '' : p, '->', ok, vm.state);
  }
  console.log('sold', vm.context.sold.join(','), 'stock', JSON.stringify(vm.context.stock));
}

function orderWorkflow() {
  const bus = new EventEmitter();
  const audit = [];
  bus.onAny((evt) => audit.push(evt));
  const orders = new Map();
  function createOrder(id, items) {
    const sm = new StateMachine({
      initial: 'new',
      context: { id, items, total: items.reduce((s, i) => s + i.price * i.qty, 0) },
      transitions: {
        new: { PAY: 'paid', CANCEL: 'cancelled' },
        paid: { SHIP: 'shipped', REFUND: 'refunded' },
        shipped: { DELIVER: 'delivered' },
      },
      guards: { 'new:PAY': (ctx) => ctx.total > 0 },
    });
    sm.on('transition', (from, to) => bus.emit('order:' + to, id, sm.context.total));
    orders.set(id, sm);
    return sm;
  }
  const revenue = { paid: 0, refunded: 0 };
  bus.on('order:paid', (id, total) => (revenue.paid += total));
  bus.on('order:refunded', (id, total) => (revenue.refunded += total));
  bus.on('order:delivered', (id) => console.log('  delivered order', id));
  createOrder('A1', [{ price: 10, qty: 2 }, { price: 5, qty: 1 }]);
  createOrder('B2', [{ price: 99, qty: 1 }]);
  createOrder('C3', []);
  createOrder('D4', [{ price: 1, qty: 7 }]);
  const script = [
    ['A1', 'PAY'], ['B2', 'PAY'], ['C3', 'PAY'], ['A1', 'SHIP'], ['B2', 'REFUND'],
    ['C3', 'CANCEL'], ['A1', 'DELIVER'], ['D4', 'SHIP'], ['D4', 'PAY'], ['D4', 'SHIP'], ['B2', 'SHIP'],
  ];
  script.forEach(([id, ev]) => {
    const ok = orders.get(id).send(ev);
    console.log('order', id, ev, ok ? 'ok' : 'no', '=>', orders.get(id).state);
  });
  console.log('revenue', JSON.stringify(revenue));
  console.log('final states', [...orders].map(([id, sm]) => id + ':' + sm.state).join(' '));
  console.log('audit', audit.join(','));
}

function callbackChains() {
  function step(name, next) {
    return (acc, done) => {
      acc.push(name);
      if (name === 'fail') return done(new Error('step failed'), acc);
      next(acc, done);
    };
  }
  const end = (acc, done) => done(null, acc);
  const pipeline = step('parse', step('validate', step('save', end)));
  pipeline([], (err, acc) => console.log('pipeline', err ? err.message : 'ok', acc.join('>')));
  const failing = step('parse', step('fail', step('save', end)));
  failing([], (err, acc) => console.log('pipeline', err ? err.message : 'ok', acc.join('>')));
  function series(tasks, cb) {
    const results = [];
    let i = 0;
    (function nextTask() {
      if (i === tasks.length) return cb(null, results);
      tasks[i++]((err, r) => {
        if (err) return cb(err, results);
        results.push(r);
        nextTask();
      });
    })();
  }
  series([(cb) => cb(null, 1), (cb) => cb(null, 'two'), (cb) => cb(null, [3])], (err, res) => console.log('series', err, JSON.stringify(res)));
}

emitterBasics();
trafficLight();
vendingMachine();
orderWorkflow();
callbackChains();
console.log('done a16');
