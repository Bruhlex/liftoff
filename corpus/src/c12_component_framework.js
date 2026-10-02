// Small component framework: a Store with actions, subscriptions and memoised computed getters;
// a Component base class with private #fields, lifecycle hooks and render-to-DOM; subclasses
// (cart, product list, badge, notification toasts) talk through bubbling CustomEvents; ids come
// from generators. A shopping-cart flow is driven through clicks and the state is logged.
'use strict';

function* idGenerator(prefix) {
  let n = 0;
  while (true) {
    const reset = yield prefix + '-' + (++n).toString(36).padStart(3, '0');
    if (reset) n = 0;
  }
}

function* take(iter, count) {
  let i = 0;
  for (const v of iter) {
    if (i++ >= count) return;
    yield v;
  }
}

const componentIds = idGenerator('cmp');
const toastIds = idGenerator('toast');

function formatPrice(cents) {
  return (cents / 100).toFixed(2) + ' EUR';
}

class Store {
  #state;
  #listeners = new Set();
  #computed = new Map();
  #version = 0;
  #log = [];

  constructor(initial, actions) {
    this.#state = Object.freeze(Object.assign({}, initial));
    this.actions = {};
    for (const [name, fn] of Object.entries(actions)) {
      this.actions[name] = (...args) => this.#dispatch(name, fn, args);
    }
  }

  get state() { return this.#state; }
  get version() { return this.#version; }
  get log() { return this.#log.slice(); }

  #dispatch(name, fn, args) {
    const patch = fn(this.#state, ...args);
    if (!patch) { this.#log.push(name + ':noop'); return false; }
    const prev = this.#state;
    this.#state = Object.freeze(Object.assign({}, prev, patch));
    this.#version++;
    this.#log.push(name);
    const changed = Object.keys(patch).filter((k) => prev[k] !== this.#state[k]);
    for (const l of Array.from(this.#listeners)) l(this.#state, changed, name);
    return true;
  }

  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  get listenerCount() { return this.#listeners.size; }

  computed(name, deps, fn) {
    let cache = null;
    let hits = 0, misses = 0;
    const getter = () => {
      const values = deps.map((d) => this.#state[d]);
      if (cache && cache.values.every((v, i) => v === values[i])) { hits++; return cache.result; }
      misses++;
      cache = { values, result: fn(...values) };
      return cache.result;
    };
    this.#computed.set(name, () => ({ hits, misses }));
    Object.defineProperty(this, name, { get: getter, enumerable: false });
    return getter;
  }

  cacheStats() {
    const out = {};
    for (const [name, f] of this.#computed) out[name] = f();
    return out;
  }
}

class Component {
  #id;
  #mounted = false;
  #unsubscribe = null;
  static instances = 0;

  constructor(store, props) {
    this.#id = componentIds.next().value;
    this.store = store;
    this.props = props || {};
    this.el = document.createElement(this.constructor.tag || 'div');
    this.el.setAttribute('data-cmp', this.#id);
    this.renders = 0;
    Component.instances++;
  }

  get id() { return this.#id; }
  get mounted() { return this.#mounted; }

  watches() { return null; }

  mount(parent) {
    parent.appendChild(this.el);
    this.#mounted = true;
    const keys = this.watches();
    this.#unsubscribe = this.store.subscribe((state, changed) => {
      if (!keys || changed.some((k) => keys.includes(k))) this.update();
    });
    this.onMount();
    this.update();
    return this;
  }

  unmount() {
    if (this.#unsubscribe) this.#unsubscribe();
    this.el.remove();
    this.#mounted = false;
    this.onUnmount();
  }

  update() {
    this.renders++;
    this.el.textContent = '';
    this.render(this.el);
  }

  emit(type, detail) {
    return this.el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, cancelable: true }));
  }

  onMount() {}
  onUnmount() {}
  render() {}
}

class ProductList extends Component {
  static tag = 'ul';
  watches() { return ['products', 'stock']; }
  onMount() {
    this.el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-sku]');
      if (btn) this.emit('cart:add', { sku: btn.getAttribute('data-sku'), from: this.id });
    });
  }
  render(el) {
    for (const p of this.store.state.products) {
      const li = document.createElement('li');
      const left = this.store.state.stock[p.sku];
      li.textContent = p.name + ' ' + formatPrice(p.price) + ' (' + left + ' left) ';
      const btn = document.createElement('button');
      btn.setAttribute('data-sku', p.sku);
      btn.textContent = 'Add';
      if (left === 0) btn.setAttribute('disabled', '');
      li.appendChild(btn);
      el.appendChild(li);
    }
  }
}

class CartView extends Component {
  static tag = 'section';
  watches() { return ['cart', 'coupon']; }
  onMount() {
    this.el.addEventListener('click', (ev) => {
      const sku = ev.target.getAttribute && ev.target.getAttribute('data-remove');
      if (sku) this.emit('cart:remove', { sku });
    });
  }
  render(el) {
    const s = this.store;
    for (const line of s.cartLines) {
      const row = document.createElement('div');
      row.className = 'line';
      row.textContent = line.qty + 'x ' + line.name + ' = ' + formatPrice(line.total);
      const rm = document.createElement('button');
      rm.setAttribute('data-remove', line.sku);
      rm.textContent = '-';
      row.appendChild(rm);
      el.appendChild(row);
    }
    const total = document.createElement('p');
    total.className = 'total';
    total.textContent = 'Total: ' + formatPrice(s.cartTotal) + (s.state.coupon ? ' (coupon ' + s.state.coupon + ')' : '');
    el.appendChild(total);
  }
}

class Badge extends Component {
  static tag = 'span';
  watches() { return ['cart']; }
  render(el) {
    const n = this.store.cartCount;
    el.textContent = n > 0 ? String(n) : '';
    el.classList.toggle('empty', n === 0);
  }
}

class Toasts extends Component {
  #queue = [];
  #max;
  constructor(store, props) {
    super(store, props);
    this.#max = this.props.max || 3;
  }
  push(text, level) {
    this.#queue.push({ id: toastIds.next().value, text, level: level || 'info' });
    while (this.#queue.length > this.#max) this.#queue.shift();
    this.update();
  }
  get size() { return this.#queue.length; }
  render(el) {
    for (const t of this.#queue) {
      const d = document.createElement('div');
      d.className = 'toast ' + t.level;
      d.textContent = t.id + ': ' + t.text;
      el.appendChild(d);
    }
  }
}

const PRODUCTS = [
  { sku: 'MUG', name: 'Mug', price: 1250 },
  { sku: 'TEE', name: 'T-Shirt', price: 2400 },
  { sku: 'CAP', name: 'Cap', price: 1799 },
];

function createShopStore() {
  const store = new Store({ products: PRODUCTS, stock: { MUG: 3, TEE: 1, CAP: 5 }, cart: {}, coupon: null }, {
    add(state, sku) {
      if (!state.stock[sku]) return null;
      return { cart: Object.assign({}, state.cart, { [sku]: (state.cart[sku] || 0) + 1 }), stock: Object.assign({}, state.stock, { [sku]: state.stock[sku] - 1 }) };
    },
    remove(state, sku) {
      if (!state.cart[sku]) return null;
      const cart = Object.assign({}, state.cart);
      if (--cart[sku] === 0) delete cart[sku];
      return { cart, stock: Object.assign({}, state.stock, { [sku]: state.stock[sku] + 1 }) };
    },
    applyCoupon(state, code) {
      return /^SAVE\d{2}$/.test(code) && state.coupon !== code ? { coupon: code } : null;
    },
  });
  store.computed('cartLines', ['cart', 'products'], (cart, products) =>
    Object.keys(cart).map((sku) => {
      const p = products.find((x) => x.sku === sku);
      return { sku, name: p.name, qty: cart[sku], total: p.price * cart[sku] };
    }));
  store.computed('cartCount', ['cart'], (cart) => Object.values(cart).reduce((a, b) => a + b, 0));
  store.computed('cartTotal', ['cart', 'coupon'], (cart, coupon) => {
    const sum = store.cartLines.reduce((a, l) => a + l.total, 0);
    const pct = coupon ? Number(coupon.slice(4)) : 0;
    return Math.round(sum * (100 - pct) / 100);
  });
  return store;
}

function textOf(cmp) {
  return Array.from(cmp.el.children).map((c) => c.textContent.replace(/\s+$/, '')).join(' | ') || JSON.stringify(cmp.el.textContent);
}

function main() {
  console.log('ids:', Array.from(take(idGenerator('x'), 4)).join(','));
  const g = idGenerator('r');
  console.log('reset gen:', g.next().value, g.next().value, g.next(true).value, g.next().value);

  const store = createShopStore();
  const root = document.getElementById('app');
  const list = new ProductList(store).mount(root);
  const cart = new CartView(store).mount(root);
  const badge = new Badge(store).mount(root);
  const toasts = new Toasts(store, { max: 2 }).mount(root);
  console.log('components:', [list, cart, badge, toasts].map((c) => c.id + '<' + c.el.localName + '>').join(' '), 'instances:', Component.instances);
  console.log('private id not enumerable:', Object.keys(list).join(','));

  root.addEventListener('cart:add', (ev) => {
    const ok = store.actions.add(ev.detail.sku);
    toasts.push(ok ? 'added ' + ev.detail.sku : 'out of stock: ' + ev.detail.sku, ok ? 'info' : 'warn');
  });
  root.addEventListener('cart:remove', (ev) => {
    store.actions.remove(ev.detail.sku);
    toasts.push('removed ' + ev.detail.sku);
  });
  store.subscribe((state, changed, action) => console.log('  store v' + store.version + ' ' + action + ' changed=[' + changed.join(',') + ']'));

  const clickAdd = (sku) => list.el.querySelector('button[data-sku="' + sku + '"]').click();
  clickAdd('MUG');
  clickAdd('TEE');
  clickAdd('TEE');
  clickAdd('MUG');
  console.log('list :', textOf(list));
  console.log('cart :', textOf(cart));
  console.log('badge:', badge.el.textContent, 'toasts:', textOf(toasts));

  console.log('coupon SAVE15:', store.actions.applyCoupon('SAVE15'), 'again:', store.actions.applyCoupon('SAVE15'), 'bad:', store.actions.applyCoupon('FREE'));
  console.log('cart :', textOf(cart));

  cart.el.querySelector('button[data-remove="MUG"]').click();
  clickAdd('CAP');
  console.log('cart :', textOf(cart));
  console.log('badge:', badge.el.textContent, 'class:', badge.el.className);

  const before = store.cacheStats();
  for (let i = 0; i < 3; i++) void store.cartTotal;
  const after = store.cacheStats();
  console.log('cache before:', JSON.stringify(before));
  console.log('cache after :', JSON.stringify(after));

  console.log('renders:', [list, cart, badge, toasts].map((c) => c.renders).join(','), 'listeners:', store.listenerCount);
  badge.unmount();
  store.actions.remove('TEE');
  console.log('after badge unmount: mounted=' + badge.mounted + ' renders=' + badge.renders + ' listeners=' + store.listenerCount + ' inDom=' + !!root.querySelector('span[data-cmp]'));
  for (const sku of ['CAP', 'CAP', 'MUG', 'TEE']) cart.el.querySelector('button[data-remove]') && store.actions.remove(sku);
  console.log('cart :', textOf(cart));
  try {
    store.state.cart.MUG = 5;
    console.log('nested cart object is not frozen, MUG =', store.state.cart.MUG);
  } catch (e) {
    console.log('frozen state rejected mutation:', e.constructor === TypeError);
  }
  try {
    store.state.coupon = 'HACK';
  } catch (e) {
    console.log('top-level state frozen:', e instanceof TypeError, 'coupon still', store.state.coupon);
  }
  console.log('action log:', store.log.join(' '));
  console.log('toast size:', toasts.size, 'next toast id would be', toastIds.next().value);
  console.log('final stock:', JSON.stringify(store.state.stock), 'html length:', root.innerHTML.length);
}

main();
