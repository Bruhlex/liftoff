// Navigator fingerprint collector: gathers navigator / screen / timezone properties into a
// component list, normalises them, builds a JSON payload and hashes it with FNV-1a, MurmurHash3
// (x86_32) and a cyrb53-style 53-bit hash. Mimics the "collect -> canonicalise -> hash" stage of
// commercial fingerprinting scripts.
'use strict';

const FP_VERSION = '3.4.1';

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function murmur3_32(key, seed) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const nblocks = key.length >> 2;
  for (let i = 0; i < nblocks; i++) {
    const j = i << 2;
    let k1 = (key.charCodeAt(j) & 0xff) | ((key.charCodeAt(j + 1) & 0xff) << 8) |
      ((key.charCodeAt(j + 2) & 0xff) << 16) | ((key.charCodeAt(j + 3) & 0xff) << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }
  const tail = nblocks << 2;
  let k1 = 0;
  switch (key.length & 3) {
    case 3: k1 ^= (key.charCodeAt(tail + 2) & 0xff) << 16; // fallthrough
    case 2: k1 ^= (key.charCodeAt(tail + 1) & 0xff) << 8; // fallthrough
    case 1:
      k1 ^= key.charCodeAt(tail) & 0xff;
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
  }
  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function hex32(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

function toUtf8Binary(str) {
  return unescape(encodeURIComponent(str));
}

class Component {
  constructor(key, getter, weight) {
    this.key = key;
    this.getter = getter;
    this.weight = weight || 1;
    this.value = undefined;
    this.error = null;
    this.duration = 0;
  }

  collect() {
    const start = performance.now();
    try {
      this.value = this.getter();
    } catch (e) {
      this.error = e && e.name ? e.name : 'Error';
      this.value = null;
    }
    this.duration = performance.now() - start;
    return this;
  }
}

function listPlugins() {
  const out = [];
  const plugins = navigator.plugins || [];
  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];
    const mimes = [];
    for (let j = 0; j < p.length; j++) mimes.push(p[j].type + '~' + p[j].suffixes);
    out.push([p.name, p.filename, mimes.join(',')].join('::'));
  }
  return out;
}

function listMimeTypes() {
  const out = [];
  const mt = navigator.mimeTypes || [];
  for (let i = 0; i < mt.length; i++) out.push(mt[i].type);
  return out.sort();
}

function timezoneInfo() {
  const opts = Intl.DateTimeFormat().resolvedOptions();
  return { calendar: opts.calendar, numberingSystem: opts.numberingSystem, hasTimeZone: typeof opts.timeZone === 'string' };
}

function screenSignature() {
  const s = window.screen;
  const dims = [s.width, s.height].sort((a, b) => b - a);
  return { dims: dims.join('x'), avail: s.availWidth + 'x' + s.availHeight, depth: s.colorDepth, dpr: window.devicePixelRatio };
}

function buildComponents() {
  return [
    new Component('ua', () => navigator.userAgent, 3),
    new Component('platform', () => navigator.platform, 2),
    new Component('vendor', () => navigator.vendor),
    new Component('language', () => navigator.language, 2),
    new Component('languages', () => Array.prototype.slice.call(navigator.languages || []), 2),
    new Component('cores', () => navigator.hardwareConcurrency),
    new Component('memory', () => navigator.deviceMemory === undefined ? -1 : navigator.deviceMemory),
    new Component('touch', () => navigator.maxTouchPoints),
    new Component('cookies', () => navigator.cookieEnabled),
    new Component('dnt', () => navigator.doNotTrack === null ? 'unspecified' : navigator.doNotTrack),
    new Component('pdf', () => !!navigator.pdfViewerEnabled),
    new Component('plugins', listPlugins, 2),
    new Component('mimes', listMimeTypes),
    new Component('screen', screenSignature, 2),
    new Component('tz', timezoneInfo),
    new Component('product', () => navigator.product + '/' + navigator.productSub),
    new Component('java', () => typeof navigator.javaEnabled === 'function' ? navigator.javaEnabled() : null),
    new Component('connection', () => {
      const c = navigator.connection;
      if (!c) return null;
      return { type: c.effectiveType, rtt: c.rtt, down: c.downlink, save: c.saveData };
    }),
    new Component('broken', () => navigator.thisDoesNotExist.nope),
  ];
}

function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return '"' + String(value) + '"';
  return JSON.stringify(value);
}

function parseUserAgent(ua) {
  const result = { browser: 'unknown', version: '0', os: 'unknown', engine: 'unknown' };
  const rules = [
    [/Edg\/(\d+)/, 'edge'],
    [/OPR\/(\d+)/, 'opera'],
    [/Chrome\/(\d+)/, 'chrome'],
    [/Firefox\/(\d+)/, 'firefox'],
    [/Version\/(\d+).*Safari/, 'safari'],
  ];
  for (const [re, label] of rules) {
    const m = re.exec(ua);
    if (m) { result.browser = label; result.version = m[1]; break; }
  }
  if (/Windows NT 10/.test(ua)) result.os = 'windows10+';
  else if (/Mac OS X/.test(ua)) result.os = 'macos';
  else if (/Android/.test(ua)) result.os = 'android';
  else if (/Linux/.test(ua)) result.os = 'linux';
  if (/AppleWebKit/.test(ua)) result.engine = /Chrome/.test(ua) ? 'blink' : 'webkit';
  else if (/Gecko\//.test(ua)) result.engine = 'gecko';
  return result;
}

function consistencyChecks(components) {
  const byKey = {};
  for (const c of components) byKey[c.key] = c.value;
  const ua = parseUserAgent(byKey.ua || '');
  const checks = [];
  checks.push(['platform-vs-ua', ua.os === 'windows10+' ? /^Win/.test(byKey.platform) : true]);
  checks.push(['lang-in-languages', (byKey.languages || []).indexOf(byKey.language) === 0]);
  checks.push(['vendor-vs-engine', ua.engine !== 'blink' || byKey.vendor === 'Google Inc.']);
  checks.push(['plugins-vs-pdf', (byKey.plugins || []).length > 0 === byKey.pdf]);
  checks.push(['cores-sane', byKey.cores >= 1 && byKey.cores <= 128]);
  return { ua, checks };
}

function weightedEntropy(components) {
  let score = 0;
  for (const c of components) {
    if (c.error) continue;
    const s = canonicalize(c.value);
    const distinct = new Set(s).size;
    score += c.weight * Math.log2(1 + distinct);
  }
  return Math.round(score * 100) / 100;
}

function buildPayload(components) {
  const data = {};
  const errors = [];
  for (const c of components) {
    if (c.error) errors.push(c.key + ':' + c.error);
    else data[c.key] = c.value;
  }
  return { v: FP_VERSION, data, errors, n: components.length };
}

function hashPayload(payload) {
  const canon = canonicalize(payload.data);
  const bin = toUtf8Binary(canon);
  return {
    length: canon.length,
    fnv: hex32(fnv1a32(bin)),
    murmur: hex32(murmur3_32(bin, 0x9747b28c)),
    cyrb: cyrb53(bin).toString(36),
  };
}

function perComponentHashes(components) {
  const out = [];
  for (const c of components) {
    if (c.error) continue;
    out.push(c.key + '=' + hex32(murmur3_32(canonicalize(c.value), 31)).slice(0, 4));
  }
  return out;
}

function main() {
  console.log('fingerprint collector v' + FP_VERSION);
  console.log('self-test fnv("hello") =', hex32(fnv1a32('hello')));
  console.log('self-test murmur("hello", 0) =', hex32(murmur3_32('hello', 0)));
  console.log('self-test cyrb53("a") =', cyrb53('a'));

  const components = buildComponents().map((c) => c.collect());
  for (const c of components) {
    const shown = c.error ? '<error ' + c.error + '>' : canonicalize(c.value);
    console.log('  [' + c.key.padEnd(10) + '] w=' + c.weight + ' ' + (shown.length > 70 ? shown.slice(0, 67) + '...' : shown));
  }
  const totalTime = components.reduce((a, c) => a + c.duration, 0);
  console.log('collection time (perf units):', totalTime);

  const { ua, checks } = consistencyChecks(components);
  console.log('parsed UA:', JSON.stringify(ua));
  for (const [label, ok] of checks) console.log('  check ' + label + ': ' + (ok ? 'ok' : 'MISMATCH'));
  const failed = checks.filter((c) => !c[1]).length;
  console.log('consistency failures:', failed);

  console.log('weighted entropy score:', weightedEntropy(components));
  const payload = buildPayload(components);
  console.log('payload keys:', Object.keys(payload.data).join(','));
  console.log('payload errors:', JSON.stringify(payload.errors));
  const hashes = hashPayload(payload);
  console.log('canonical length:', hashes.length);
  console.log('fnv1a32 :', hashes.fnv);
  console.log('murmur3 :', hashes.murmur);
  console.log('cyrb53  :', hashes.cyrb);
  const parts = perComponentHashes(components);
  for (let i = 0; i < parts.length; i += 6) console.log('  ' + parts.slice(i, i + 6).join(' '));
  const visitorId = hashes.murmur + hashes.fnv.slice(0, 4) + '-' + hashes.cyrb.slice(-6);
  console.log('visitorId:', visitorId);
  const envelope = JSON.stringify({ id: visitorId, v: payload.v, n: payload.n, e: payload.errors.length });
  console.log('envelope:', envelope);
  console.log('envelope b64:', btoa(envelope));
}

main();
