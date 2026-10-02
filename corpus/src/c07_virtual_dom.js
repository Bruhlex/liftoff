// Virtual DOM library: h() builds vnodes, mount() creates real elements, diff() produces a patch
// list (props, text, insert/remove/move with keyed children via a longest-increasing-subsequence
// pass), patch() applies it to the shim DOM. Every operation is counted and the resulting HTML is
// printed so the effect of each update can be compared.
'use strict';

const TEXT = Symbol('text');
const stats = { create: 0, remove: 0, move: 0, setProp: 0, removeProp: 0, text: 0, events: 0 };

function h(type, props, ...children) {
  const flat = [];
  const walk = (list) => {
    for (const c of list) {
      if (Array.isArray(c)) walk(c);
      else if (c === null || c === undefined || c === false || c === true) continue;
      else if (typeof c === 'object') flat.push(c);
      else flat.push({ type: TEXT, props: {}, key: null, children: [], text: String(c), el: null });
    }
  };
  walk(children);
  props = props || {};
  return { type, props, key: props.key !== undefined ? props.key : null, children: flat, el: null };
}

function isEventProp(name) {
  return /^on[A-Z]/.test(name);
}

function setProp(el, name, value, old) {
  if (name === 'key') return;
  if (isEventProp(name)) {
    const evt = name.slice(2).toLowerCase();
    if (old) el.removeEventListener(evt, old);
    if (value) el.addEventListener(evt, value);
    stats.events++;
    return;
  }
  stats.setProp++;
  if (name === 'style' && typeof value === 'object') {
    el.style.cssText = Object.keys(value).map((k) => k + ': ' + value[k]).join('; ');
  } else if (name === 'className') el.className = value;
  else if (name === 'value') el.value = value;
  else if (typeof value === 'boolean') el.toggleAttribute(name, value);
  else el.setAttribute(name, value);
}

function removeProp(el, name, old) {
  if (isEventProp(name)) {
    el.removeEventListener(name.slice(2).toLowerCase(), old);
    stats.events++;
    return;
  }
  stats.removeProp++;
  if (name === 'className') el.removeAttribute('class');
  else if (name === 'style') el.style.cssText = '';
  else el.removeAttribute(name);
}

function mount(vnode) {
  stats.create++;
  if (vnode.type === TEXT) {
    vnode.el = document.createTextNode(vnode.text);
    return vnode.el;
  }
  const el = document.createElement(vnode.type);
  for (const [k, v] of Object.entries(vnode.props)) setProp(el, k, v, null);
  for (const c of vnode.children) el.appendChild(mount(c));
  vnode.el = el;
  return el;
}

function sameNode(a, b) {
  return a.type === b.type && a.key === b.key;
}

function lis(arr) {
  // indices (into arr) of a longest increasing subsequence, ignoring -1 entries
  const p = arr.slice();
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < 0) continue;
    if (!result.length || arr[result[result.length - 1]] < arr[i]) {
      p[i] = result.length ? result[result.length - 1] : -1;
      result.push(i);
      continue;
    }
    let lo = 0, hi = result.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[result[mid]] < arr[i]) lo = mid + 1; else hi = mid;
    }
    p[i] = lo > 0 ? result[lo - 1] : -1;
    result[lo] = i;
  }
  let k = result.length ? result[result.length - 1] : -1;
  const out = [];
  while (k >= 0) { out.unshift(k); k = p[k]; }
  return out;
}

function patchProps(el, oldProps, newProps) {
  for (const k of Object.keys(oldProps)) {
    if (!(k in newProps)) removeProp(el, k, oldProps[k]);
  }
  for (const k of Object.keys(newProps)) {
    const a = oldProps[k], b = newProps[k];
    const same = typeof a === 'object' && typeof b === 'object' && a && b ? JSON.stringify(a) === JSON.stringify(b) : a === b;
    if (!same) setProp(el, k, b, a);
  }
}

function patch(oldV, newV) {
  if (!sameNode(oldV, newV)) {
    const el = mount(newV);
    oldV.el.parentNode.replaceChild(el, oldV.el);
    stats.remove++;
    return el;
  }
  const el = (newV.el = oldV.el);
  if (newV.type === TEXT) {
    if (oldV.text !== newV.text) { el.data = newV.text; stats.text++; }
    return el;
  }
  patchProps(el, oldV.props, newV.props);
  const keyed = newV.children.length > 0 && newV.children.every((c) => c.key !== null);
  if (keyed) patchKeyed(el, oldV.children, newV.children);
  else patchUnkeyed(el, oldV.children, newV.children);
  return el;
}

function patchUnkeyed(parent, oldCh, newCh) {
  const common = Math.min(oldCh.length, newCh.length);
  for (let i = 0; i < common; i++) patch(oldCh[i], newCh[i]);
  for (let i = common; i < newCh.length; i++) parent.appendChild(mount(newCh[i]));
  for (let i = common; i < oldCh.length; i++) { parent.removeChild(oldCh[i].el); stats.remove++; }
}

function patchKeyed(parent, oldCh, newCh) {
  const oldIndex = new Map();
  oldCh.forEach((c, i) => oldIndex.set(c.key, i));
  const sources = newCh.map((c) => (oldIndex.has(c.key) ? oldIndex.get(c.key) : -1));
  const used = new Set();
  newCh.forEach((c, i) => {
    if (sources[i] >= 0) { patch(oldCh[sources[i]], c); used.add(sources[i]); }
  });
  oldCh.forEach((c, i) => {
    if (!used.has(i)) { parent.removeChild(c.el); stats.remove++; }
  });
  const stable = new Set(lis(sources));
  let anchor = null;
  for (let i = newCh.length - 1; i >= 0; i--) {
    const c = newCh[i];
    if (sources[i] < 0) {
      parent.insertBefore(mount(c), anchor);
    } else if (!stable.has(i)) {
      parent.insertBefore(c.el, anchor);
      stats.move++;
    }
    anchor = c.el;
  }
}

class App {
  constructor(container, view) {
    this.container = container;
    this.view = view;
    this.vtree = null;
    this.renders = 0;
  }

  render(state) {
    const next = this.view(state, this);
    const before = Object.assign({}, stats);
    if (!this.vtree) this.container.appendChild(mount(next));
    else patch(this.vtree, next);
    this.vtree = next;
    this.renders++;
    const delta = Object.keys(stats).filter((k) => stats[k] !== before[k]).map((k) => k + '+' + (stats[k] - before[k]));
    return delta.join(' ') || '(no-op)';
  }
}

function listView(state, app) {
  return h('div', { className: 'panel ' + state.mode, 'data-count': String(state.items.length) },
    h('h3', null, state.title),
    state.mode === 'edit' ? h('input', { value: state.title, disabled: false }) : null,
    h('ul', { className: 'items' },
      state.items.map((it) => h('li', { key: it.id, className: it.hot ? 'hot' : 'cold', onClick: () => app.clicked.push(it.id) }, it.label))),
    h('p', { style: { color: state.items.length > 4 ? 'red' : 'gray' } }, 'total: ', String(state.items.length)));
}

function items(ids, hot) {
  return ids.map((id) => ({ id, label: 'Item ' + id.toUpperCase(), hot: (hot || '').includes(id) }));
}

function keysInDom(container) {
  return Array.from(container.querySelectorAll('li')).map((li) => li.textContent.slice(5)).join('');
}

function main() {
  console.log('lis([3,1,2,-1,4,0]) =', JSON.stringify(lis([3, 1, 2, -1, 4, 0])));
  console.log('lis([0,1,2,3]) =', JSON.stringify(lis([0, 1, 2, 3])), 'lis([4,3,2,1]) =', JSON.stringify(lis([4, 3, 2, 1])));
  const v = h('p', { id: 'x' }, 'a', ['b', ['c', null, 7]], false);
  console.log('flattened children:', v.children.map((c) => c.text).join('|'));

  const container = document.getElementById('app');
  const app = new App(container, listView);
  app.clicked = [];
  const states = [
    { title: 'Groceries', mode: 'view', items: items(['a', 'b', 'c', 'd']) },
    { title: 'Groceries', mode: 'view', items: items(['a', 'b', 'c', 'd']) },
    { title: 'Groceries!', mode: 'view', items: items(['a', 'b', 'c', 'd'], 'b') },
    { title: 'Groceries!', mode: 'view', items: items(['d', 'c', 'b', 'a'], 'b') },
    { title: 'Groceries!', mode: 'edit', items: items(['d', 'x', 'b', 'a', 'y'], 'x') },
    { title: 'Groceries!', mode: 'edit', items: items(['b', 'y', 'e', 'd']) },
    { title: 'Short', mode: 'view', items: items(['e']) },
    { title: 'Short', mode: 'view', items: items(['f', 'g', 'e', 'h', 'i', 'j'], 'gj') },
    { title: 'Short', mode: 'view', items: items(['j', 'f', 'g', 'e', 'h', 'i'], 'gj') },
  ];
  states.forEach((s, i) => {
    const delta = app.render(s);
    const root = container.firstElementChild;
    console.log('render ' + i + ': ' + delta);
    console.log('    order=' + keysInDom(container) + ' class="' + root.className + '" count=' + root.getAttribute('data-count') + ' input=' + (root.querySelector('input') ? 'yes' : 'no'));
  });

  const lis2 = container.querySelectorAll('li');
  lis2[0].click();
  lis2[3].click();
  lis2[5].click();
  console.log('clicked keys:', app.clicked.join(','));

  const last = container.firstElementChild.outerHTML;
  console.log('html length:', last.length);
  console.log('html head:', last.slice(0, 120));
  console.log('p style:', container.querySelector('p').style.cssText);
  const replaced = app.render({ title: 'Swap', mode: 'view', items: [] });
  console.log('empty list render: ' + replaced + ' li=' + container.querySelectorAll('li').length);
  app.view = () => h('section', { id: 'other' }, h('span', null, 'replaced root'));
  console.log('root type change: ' + app.render({}) + ' -> ' + container.innerHTML);
  console.log('stats:', JSON.stringify(stats), 'renders:', app.renders);
}

main();
