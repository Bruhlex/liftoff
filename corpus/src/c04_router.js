// Client-side router: parses the current location, compiles route patterns with :params and
// optional/wildcard segments into regexes, intercepts link clicks via delegation, navigates with
// history.pushState/replaceState, reacts to popstate on back/forward and renders views into #app.
'use strict';

function compilePattern(pattern) {
  const keys = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') { keys.push('rest'); return '(.*)'; }
      const m = /^:(\w+)(\?)?(?:\((.+)\))?$/.exec(seg);
      if (!m) return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      keys.push(m[1]);
      const body = '(' + (m[3] || '[^/]+') + ')';
      return m[2] ? '(?:' + body + ')?' : body;
    })
    .join('/')
    .replace(/\/\(\?:/g, '(?:/');
  return { re: new RegExp('^' + src + '/?$'), keys };
}

function parseQuery(search) {
  const out = {};
  const params = new URLSearchParams(search);
  for (const [k, v] of params) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

function buildQuery(obj) {
  const params = new URLSearchParams();
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    for (const item of [].concat(v)) params.append(k, String(item));
  }
  const s = params.toString();
  return s ? '?' + s : '';
}

function currentPath() {
  const loc = window.location;
  return { path: loc.pathname, query: parseQuery(loc.search), hash: loc.hash.slice(1) };
}

class Route {
  constructor(pattern, view, opts) {
    this.pattern = pattern;
    this.view = view;
    this.opts = opts || {};
    Object.assign(this, compilePattern(pattern));
  }

  match(path) {
    const m = this.re.exec(path);
    if (!m) return null;
    const params = {};
    this.keys.forEach((k, i) => {
      if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]);
    });
    return params;
  }
}

class Router {
  constructor(outlet) {
    this.outlet = outlet;
    this.routes = [];
    this.guards = [];
    this.visits = [];
    this.current = null;
    this.onPop = (ev) => {
      console.log('  popstate state=' + JSON.stringify(ev.state) + ' url=' + window.location.pathname + window.location.search);
      this.resolve('pop');
    };
    window.addEventListener('popstate', this.onPop);
    document.addEventListener('click', (ev) => this.onClick(ev));
  }

  add(pattern, view, opts) {
    this.routes.push(new Route(pattern, view, opts));
    return this;
  }

  guard(fn) {
    this.guards.push(fn);
    return this;
  }

  lookup(path) {
    for (const r of this.routes) {
      const params = r.match(path);
      if (params) return { route: r, params };
    }
    return null;
  }

  onClick(ev) {
    const a = ev.target.closest('a[href]');
    if (!a || a.getAttribute('target') === '_blank' || ev.ctrlKey || ev.metaKey) {
      if (a) console.log('  click on ' + a.getAttribute('href') + ' left to browser (modifier/target)');
      return;
    }
    const url = new URL(a.getAttribute('href'), window.location.href);
    if (url.origin !== window.location.origin) {
      console.log('  external link ' + url.host + ' ignored');
      return;
    }
    ev.preventDefault();
    this.navigate(url.pathname + url.search + url.hash);
  }

  navigate(to, opts) {
    opts = opts || {};
    const url = new URL(to, window.location.href);
    const target = this.lookup(url.pathname);
    for (const g of this.guards) {
      const verdict = g(url.pathname, target && target.route.opts);
      if (verdict === false) {
        console.log('  guard blocked ' + url.pathname);
        return false;
      }
      if (typeof verdict === 'string') {
        console.log('  guard redirect ' + url.pathname + ' -> ' + verdict);
        return this.navigate(verdict, { replace: true });
      }
    }
    const state = { n: this.visits.length, from: this.current ? this.current.path : null };
    if (opts.replace) window.history.replaceState(state, '', url.href);
    else window.history.pushState(state, '', url.href);
    this.resolve(opts.replace ? 'replace' : 'push');
    return true;
  }

  resolve(how) {
    const loc = currentPath();
    const hit = this.lookup(loc.path);
    let html;
    if (!hit) html = renderNotFound(loc.path);
    else html = hit.route.view(hit.params, loc.query, loc.hash);
    this.outlet.textContent = '';
    for (const line of html) {
      const p = document.createElement('p');
      p.textContent = line;
      this.outlet.appendChild(p);
    }
    document.title = (hit ? hit.route.opts.title || 'Page' : 'Not found') + ' | Shop';
    this.current = { path: loc.path, params: hit ? hit.params : null };
    this.visits.push(how + ':' + loc.path);
    console.log('[' + how + '] ' + loc.path + ' -> ' + (hit ? hit.route.pattern : '404') + ' params=' + JSON.stringify(hit ? hit.params : {}) + ' q=' + JSON.stringify(loc.query));
    console.log('    view: ' + html.join(' / '));
    console.log('    title="' + document.title + '" history.length=' + window.history.length);
  }
}

const PRODUCTS = [
  { id: 17, slug: 'blue-mug', name: 'Blue Mug', price: 900 },
  { id: 23, slug: 'red-kettle', name: 'Red Kettle', price: 3450 },
  { id: 42, slug: 'green-teapot', name: 'Green Teapot', price: 2599 },
];

function money(cents) {
  return '$' + Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
}

function renderHome() {
  return ['Welcome to the shop', PRODUCTS.length + ' products available'];
}

function renderList(params, query) {
  const page = Number(query.page || 1);
  const sort = query.sort || 'name';
  const items = PRODUCTS.slice().sort((a, b) => (sort === 'price' ? a.price - b.price : a.name < b.name ? -1 : 1));
  return ['Products (page ' + page + ', sort ' + sort + ')'].concat(items.map((p) => p.name + ' ' + money(p.price)));
}

function renderProduct(params, query, hash) {
  const p = PRODUCTS.find((x) => String(x.id) === params.id);
  if (!p) return ['Unknown product ' + params.id];
  const lines = [p.name, 'Price: ' + money(p.price)];
  if (params.slug && params.slug !== p.slug) lines.push('(canonical slug is ' + p.slug + ')');
  if (hash) lines.push('section #' + hash);
  return lines;
}

function renderDocs(params) {
  return ['Docs', 'path segments: ' + (params.rest ? params.rest.split('/').join(' > ') : '(index)')];
}

function renderAccount(params) {
  return ['Account settings', 'tab: ' + (params.tab || 'profile')];
}

function renderNotFound(path) {
  return ['404', 'Nothing at ' + path];
}

function makeLink(href, text, attrs) {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  a.textContent = text;
  for (const k of Object.keys(attrs || {})) a.setAttribute(k, attrs[k]);
  document.body.appendChild(a);
  return a;
}

function tick() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

async function main() {
  const start = currentPath();
  console.log('initial path:', start.path, 'query:', JSON.stringify(start.query), 'hash:', start.hash);
  console.log('buildQuery:', buildQuery({ sort: 'price', page: 2, tag: ['a', 'b'], empty: '' }));
  for (const p of ['/products/:id(\\d+)/:slug?', '/docs/*', '/account/:tab?']) {
    const c = compilePattern(p);
    console.log('pattern ' + p + ' -> ' + c.re.source + ' keys=' + c.keys.join(','));
  }

  let loggedIn = false;
  const router = new Router(document.getElementById('app'));
  router
    .add('/', renderHome, { title: 'Home' })
    .add('/products/list', renderList, { title: 'Products' })
    .add('/products/:id(\\d+)/:slug?', renderProduct, { title: 'Product' })
    .add('/docs/*', renderDocs, { title: 'Docs' })
    .add('/account/:tab?', renderAccount, { title: 'Account', auth: true })
    .add('/login', () => ['Please sign in'], { title: 'Login' })
    .guard((path, opts) => (opts && opts.auth && !loggedIn ? '/login?next=' + encodeURIComponent(path) : true))
    .guard((path) => (path.startsWith('/admin') ? false : true));

  router.resolve('init');
  router.navigate('/products/42/green-teapot#reviews');
  router.navigate('/products/23');
  router.navigate('/products/17/wrong-slug');
  router.navigate('/products/list?sort=name&page=1');
  router.navigate('/docs/api/router/params');
  router.navigate('/account/billing');
  console.log('after redirect location:', window.location.pathname + window.location.search);
  router.navigate('/admin/users');
  loggedIn = true;
  router.navigate('/account/billing');
  router.navigate('/does/not/exist');

  console.log('-- link clicks');
  makeLink('/products/23/red-kettle', 'Kettle').click();
  makeLink('https://other.example.net/x', 'External').click();
  makeLink('/products/list', 'New tab', { target: '_blank' }).click();
  const plain = makeLink('/', 'Home');
  plain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  plain.click();

  console.log('-- back/forward');
  window.history.back();
  await tick();
  window.history.back();
  await tick();
  window.history.forward();
  await tick();
  window.history.go(-3);
  await tick();
  console.log('history.state now:', JSON.stringify(window.history.state));

  console.log('visits:', router.visits.length);
  for (let i = 0; i < router.visits.length; i += 4) console.log('  ' + router.visits.slice(i, i + 4).join('  '));
  console.log('outlet paragraphs:', document.querySelectorAll('#app p').length);
  window.removeEventListener('popstate', router.onPop);
  window.history.back();
  await tick();
  console.log('after unsubscribe, location:', window.location.pathname, 'visits still', router.visits.length);
}

main();
