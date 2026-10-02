// Progressive enhancement: detects features with `in` / typeof checks on window, navigator and
// document, wraps risky API calls in try/catch, picks native implementations or small polyfills
// (storage, idle callbacks, clipboard, share, observers, structuredClone) and reports which code
// path each widget ended up using.
'use strict';

const report = [];

function note(feature, path, detail) {
  report.push({ feature, path, detail: detail || '' });
  console.log('  ' + feature.padEnd(18) + ' -> ' + path + (detail ? ' (' + detail + ')' : ''));
}

function has(obj, prop) {
  try {
    return obj != null && prop in obj;
  } catch (e) {
    return false;
  }
}

function isFn(x) {
  return typeof x === 'function';
}

const probes = {
  fetch: () => isFn(window.fetch),
  promise: () => typeof Promise !== 'undefined' && isFn(Promise.prototype.finally),
  matchMedia: () => isFn(window.matchMedia),
  raf: () => isFn(window.requestAnimationFrame),
  idle: () => has(window, 'requestIdleCallback'),
  intersection: () => has(window, 'IntersectionObserver'),
  resizeObs: () => has(window, 'ResizeObserver'),
  customElements: () => has(window, 'customElements'),
  serviceWorker: () => has(navigator, 'serviceWorker'),
  clipboard: () => has(navigator, 'clipboard') && isFn(navigator.clipboard.writeText),
  share: () => isFn(navigator.share),
  vibrate: () => isFn(navigator.vibrate),
  onLine: () => typeof navigator.onLine === 'boolean',
  cookieEnabled: () => navigator.cookieEnabled === true,
  classList: () => has(document.createElement('div'), 'classList'),
  dataset: () => has(document.createElement('div'), 'dataset'),
  querySelector: () => isFn(document.querySelector),
  closest: () => isFn(document.createElement('div').closest),
  structuredClone: () => typeof structuredClone === 'function',
  crypto: () => has(window, 'crypto') && isFn(window.crypto.getRandomValues),
  randomUUID: () => has(window, 'crypto') && isFn(window.crypto.randomUUID),
  webp: () => document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0,
  touch: () => 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  passive: () => {
    let supported = false;
    const opts = Object.defineProperty({}, 'passive', { get() { supported = true; return true; } });
    window.addEventListener('test-passive', null, opts);
    document.body.addEventListener('test-passive', () => {}, opts);
    return supported;
  },
};

function detectAll() {
  const out = {};
  for (const [k, probe] of Object.entries(probes)) {
    try {
      out[k] = !!probe();
    } catch (e) {
      out[k] = false;
    }
  }
  return out;
}

function storageAvailable(kind) {
  try {
    const s = window[kind];
    const key = '__probe__';
    s.setItem(key, key);
    const ok = s.getItem(key) === key;
    s.removeItem(key);
    return ok;
  } catch (e) {
    return e && e.name === 'QuotaExceededError' && window[kind] && window[kind].length > 0;
  }
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  get length() { return this.map.size; }
}

function pickStorage() {
  if (storageAvailable('localStorage')) { note('storage', 'localStorage'); return window.localStorage; }
  if (storageAvailable('sessionStorage')) { note('storage', 'sessionStorage'); return window.sessionStorage; }
  note('storage', 'memory polyfill');
  return new MemoryStorage();
}

function pickIdle() {
  if (has(window, 'requestIdleCallback')) {
    note('idle', 'native requestIdleCallback');
    return (cb) => window.requestIdleCallback(cb);
  }
  note('idle', 'rAF fallback');
  return (cb) => requestAnimationFrame(() => cb({ didTimeout: false, timeRemaining: () => 8 }));
}

function pickClone() {
  if (typeof structuredClone === 'function') {
    note('clone', 'structuredClone');
    return (v) => structuredClone(v);
  }
  note('clone', 'JSON round-trip');
  return (v) => JSON.parse(JSON.stringify(v));
}

function pickLazyLoader(images) {
  if (has(window, 'IntersectionObserver')) {
    note('lazy-images', 'IntersectionObserver');
    return 'observer';
  }
  // fallback: load everything whose top is within two viewports
  const limit = window.innerHeight * 2;
  let loaded = 0;
  for (const img of images) {
    const r = img.getBoundingClientRect();
    if (r.top < limit) { img.setAttribute('src', img.dataset.src); loaded++; } else img.classList.add('deferred');
  }
  note('lazy-images', 'eager-within-viewport', loaded + '/' + images.length + ' loaded');
  return 'eager';
}

function pickCopy() {
  if (has(navigator, 'clipboard')) {
    note('copy', 'async clipboard');
    return (text) => navigator.clipboard.writeText(text);
  }
  if (isFn(document.execCommand)) {
    note('copy', 'execCommand');
    return () => document.execCommand('copy');
  }
  note('copy', 'manual-select hint');
  return (text) => { const hint = document.createElement('textarea'); hint.value = text; document.body.appendChild(hint); return 'select-me:' + text.length; };
}

function pickShare() {
  if (isFn(navigator.share)) { note('share', 'Web Share'); return 'native'; }
  const url = 'mailto:?subject=' + encodeURIComponent(document.title) + '&body=' + encodeURIComponent(window.location.href);
  note('share', 'mailto link', url.length + ' chars');
  return url;
}

function pickUuid() {
  if (has(window, 'crypto') && isFn(crypto.randomUUID)) {
    note('uuid', 'crypto.randomUUID');
    return () => crypto.randomUUID();
  }
  note('uuid', 'getRandomValues v4');
  return () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  };
}

function safeCall(label, fn) {
  try {
    const r = fn();
    if (r && isFn(r.then)) return r.then((v) => label + ': resolved ' + JSON.stringify(v), (e) => label + ': rejected ' + (e && e.name) + ' ' + (e && e.message));
    return Promise.resolve(label + ': ok ' + JSON.stringify(r));
  } catch (e) {
    return Promise.resolve(label + ': threw ' + e.name + ' - ' + e.message);
  }
}

function enhanceNav() {
  const nav = document.querySelector('nav');
  if (!nav || !probes.closest() || !probes.classList()) { note('nav', 'plain links'); return 0; }
  let clicks = 0;
  nav.addEventListener('click', (ev) => {
    const link = ev.target.closest('a');
    if (!link) return;
    ev.preventDefault();
    clicks++;
    for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a === link);
  });
  note('nav', 'enhanced (delegated)', nav.querySelectorAll('a').length + ' links');
  nav.querySelectorAll('a')[2].click();
  nav.querySelectorAll('a')[0].click();
  return { clicks, active: nav.querySelector('a.active').textContent };
}

async function main() {
  console.log('document.readyState:', document.readyState, 'secure:', window.isSecureContext, 'online:', navigator.onLine);
  const features = detectAll();
  const on = Object.keys(features).filter((k) => features[k]);
  const off = Object.keys(features).filter((k) => !features[k]);
  console.log('supported (' + on.length + '):', on.join(' '));
  console.log('missing   (' + off.length + '):', off.join(' '));
  console.log('html classes:', ['js'].concat(on.slice(0, 6).map((f) => 'has-' + f), off.slice(0, 4).map((f) => 'no-' + f)).join(' '));

  console.log('-- chosen code paths');
  const store = pickStorage();
  store.setItem('pe-test', 'yes');
  const idle = pickIdle();
  const clone = pickClone();
  const imgs = [0, 700, 1500, 2400, 4000].map((top, i) => {
    const img = document.createElement('img');
    img.dataset.src = '/img/photo-' + i + '.jpg';
    img.style.top = top + 'px';
    document.body.appendChild(img);
    return img;
  });
  pickLazyLoader(imgs);
  const copy = pickCopy();
  const share = pickShare();
  const uuid = pickUuid();
  const navState = enhanceNav();
  console.log('nav state:', JSON.stringify(navState));

  const src = { a: [1, 2, { b: 3 }], when: 'day-7', nested: { list: new Array(3).fill('x') } };
  const copyObj = clone(src);
  copyObj.a[2].b = 99;
  console.log('clone independent:', src.a[2].b, copyObj.a[2].b);
  console.log('uuid sample:', uuid(), uuid().length);
  console.log('copy result:', copy('hello clipboard'));
  console.log('share value starts:', String(share).slice(0, 30));
  console.log('img srcs:', imgs.map((i) => (i.getAttribute('src') ? 'L' : i.classList.contains('deferred') ? 'D' : '?')).join(''));
  const idleResult = await new Promise((resolve) => idle((d) => resolve(d.didTimeout + '/' + d.timeRemaining())));
  console.log('idle callback:', idleResult);

  console.log('-- guarded API calls');
  const results = [];
  results.push(await safeCall('storage.estimate', () => navigator.storage.estimate().then((e) => e.quota > 0)));
  results.push(await safeCall('orientation.lock', () => screen.orientation.lock('portrait')));
  results.push(await safeCall('permissions.query(bogus)', () => navigator.permissions.query({ name: 'teleport' })));
  results.push(await safeCall('permissions.query(geo)', () => navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)));
  results.push(await safeCall('querySelector(:hover)', () => document.querySelector('a:hover')));
  results.push(await safeCall('innerHTML markup', () => { document.body.innerHTML = '<b>x</b>'; return 1; }));
  results.push(await safeCall('atob(bad)', () => atob('***')));
  results.push(await safeCall('getRandomValues(Float64)', () => crypto.getRandomValues(new Float64Array(2))));
  results.push(await safeCall('vibrate', () => navigator.vibrate(100)));
  results.push(await safeCall('createElement(bad)', () => document.createElement('1div')));
  for (const r of results) console.log('  ' + r);

  const paths = report.map((r) => r.feature + '=' + r.path).join('; ');
  console.log('summary:', report.length, 'decisions');
  console.log('paths:', paths);
  console.log('storage probe cleaned:', localStorage.getItem('__probe__') === null, 'pe-test:', localStorage.getItem('pe-test'));
}

main();
