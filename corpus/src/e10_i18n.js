// i18n / l10n framework: locale negotiation from navigator.languages, message catalogs with
// ICU-like plural/select syntax parsed by a hand-written tokenizer, Intl.NumberFormat /
// PluralRules / Collator / ListFormat caches, a reactive locale store (Proxy) that re-renders
// DOM nodes carrying data-i18n attributes, lazy catalog loading via async generators and rAF,
// and a language picker driven through delegated click events.
'use strict';

const log = (...a) => console.log(...a);

// ------------------------------------------------------------------ locale negotiation
const SUPPORTED = ['en', 'en-GB', 'de', 'de-AT', 'fr', 'ar', 'ja', 'pl', 'ru'];

function parseTag(tag) {
  const m = /^([a-z]{2,3})(?:-([A-Z][a-z]{3}))?(?:-([A-Z]{2}|\d{3}))?$/.exec(tag);
  if (!m) return null;
  const [, lang, script = null, region = null] = m;
  return { lang, script, region };
}

function negotiate(requested, available, fallback = 'en') {
  const canon = [];
  for (const r of requested) {
    try {
      canon.push(...Intl.getCanonicalLocales(r));
    } catch {
      log('  skip invalid tag', JSON.stringify(r));
    }
  }
  const scored = [];
  outer: for (const [ri, req] of canon.entries()) {
    const rp = parseTag(req);
    if (!rp) continue;
    for (const av of available) {
      if (av === req) { scored.push({ av, score: 100 - ri * 10, why: 'exact' }); continue outer; }
    }
    for (const av of available) {
      const ap = parseTag(av);
      if (ap && ap.lang === rp.lang && !ap.region) { scored.push({ av, score: 80 - ri * 10, why: 'lang' }); continue outer; }
    }
    for (const av of available) {
      const ap = parseTag(av);
      if (ap?.lang === rp.lang) { scored.push({ av, score: 60 - ri * 10, why: 'sibling' }); break; }
    }
  }
  scored.sort((a, b) => b.score - a.score || a.av.localeCompare(b.av));
  const seen = new Set();
  const out = scored.filter(({ av }) => (seen.has(av) ? false : (seen.add(av), true)));
  if (!out.length) out.push({ av: fallback, score: 0, why: 'fallback' });
  return out;
}

// ------------------------------------------------------------------ message format parser
// Supports: {name}, {n, number}, {n, plural, one {...} other {...} =0 {...}}, {g, select, a {...} other {...}}, # in plural
function tokenize(src) {
  const toks = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { toks.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" && src[i + 1] === "'") { buf += "'"; i += 2; continue; }
    if (ch === "'" && /[{}#]/.test(src[i + 1] || '')) {
      const end = src.indexOf("'", i + 1);
      buf += src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ',' || ch === '#') { flush(); toks.push({ t: ch }); i++; continue; }
    buf += ch; i++;
  }
  flush();
  return toks;
}

class MessageSyntaxError extends Error {
  constructor(msg, pos) { super(msg + ' at token ' + pos); this.pos = pos; }
}

function parseMessage(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const expect = (t) => {
    const k = toks[p];
    if (!k || k.t !== t) throw new MessageSyntaxError('expected ' + t, p);
    p++;
    return k;
  };
  function parseSeq(inPlural) {
    const nodes = [];
    while (p < toks.length) {
      const k = peek();
      if (k.t === '}') break;
      if (k.t === 'text' || k.t === ',') { nodes.push({ type: 'text', v: k.t === ',' ? ',' : k.v }); p++; continue; }
      if (k.t === '#') { p++; nodes.push(inPlural ? { type: 'pound' } : { type: 'text', v: '#' }); continue; }
      if (k.t === '{') { p++; nodes.push(parseArg()); continue; }
      throw new MessageSyntaxError('unexpected ' + k.t, p);
    }
    return nodes;
  }
  function parseArg() {
    const nameTok = expect('text');
    const name = nameTok.v.trim();
    if (peek()?.t === '}') { p++; return { type: 'arg', name }; }
    expect(',');
    const kind = expect('text').v.trim();
    if (kind === 'number') { expect('}'); return { type: 'number', name }; }
    if (kind !== 'plural' && kind !== 'select') throw new MessageSyntaxError('bad kind ' + kind, p);
    expect(',');
    const options = {};
    let offset = 0;
    while (peek() && peek().t !== '}') {
      const keyTok = expect('text');
      let key = keyTok.v.trim();
      const off = /^offset:(\d+)\s*(.*)$/.exec(key);
      if (off) { offset = +off[1]; key = off[2]; if (!key) continue; }
      expect('{');
      options[key] = parseSeq(kind === 'plural');
      expect('}');
    }
    expect('}');
    if (!options.other) throw new MessageSyntaxError('missing other', p);
    return { type: kind, name, options, offset };
  }
  const ast = parseSeq(false);
  if (p !== toks.length) throw new MessageSyntaxError('trailing', p);
  return ast;
}

// ------------------------------------------------------------------ Intl caches
class IntlCache {
  #store = new Map();
  #hits = 0;
  #misses = 0;
  get(kind, locale, opts = {}) {
    const key = kind + '|' + locale + '|' + JSON.stringify(opts);
    let v = this.#store.get(key);
    if (v) { this.#hits++; return v; }
    this.#misses++;
    switch (kind) {
      case 'num': v = new Intl.NumberFormat(locale, opts); break;
      case 'plural': v = new Intl.PluralRules(locale, opts); break;
      case 'coll': v = new Intl.Collator(locale, opts); break;
      case 'list': v = new Intl.ListFormat(locale, opts); break;
      default: throw new RangeError('unknown formatter kind');
    }
    this.#store.set(key, v);
    return v;
  }
  get stats() { return { hits: this.#hits, misses: this.#misses, size: this.#store.size }; }
}
const intl = new IntlCache();

function formatAst(ast, locale, values, pound) {
  let out = '';
  for (const node of ast) {
    switch (node.type) {
      case 'text': out += node.v; break;
      case 'pound': out += intl.get('num', locale).format(pound); break;
      case 'arg': out += String(values[node.name] ?? '{' + node.name + '}'); break;
      case 'number': out += intl.get('num', locale).format(values[node.name]); break;
      case 'plural': {
        const n = Number(values[node.name]);
        const exact = node.options['=' + n];
        if (exact) { out += formatAst(exact, locale, values, n); break; }
        const cat = intl.get('plural', locale).select(n - node.offset);
        out += formatAst(node.options[cat] ?? node.options.other, locale, values, n - node.offset);
        break;
      }
      case 'select': {
        const key = String(values[node.name]);
        out += formatAst(node.options[key] ?? node.options.other, locale, values, pound);
        break;
      }
      default: throw new TypeError('bad node');
    }
  }
  return out;
}

// ------------------------------------------------------------------ catalogs (lazy)
const RAW_CATALOGS = {
  en: {
    'app.title': 'Recipe Box',
    'inbox.count': '{n, plural, =0 {No new messages} one {# new message} other {# new messages}}',
    'cart.items': '{count, plural, one {# item} other {# items}} in your cart, {name}',
    'party.guests': '{host} {guests, plural, offset:1 =0 {is alone} =1 {and {guest} are here} one {and one other are here} other {and # others are here}}',
    'profile.gender': '{g, select, female {She liked your recipe} male {He liked your recipe} other {They liked your recipe}}',
    'escape.demo': "Use '{braces}' like this: ''quoted''",
    'recipe.serves': 'Serves {n, number}',
  },
  'en-GB': { 'app.title': 'Recipe Box (UK)', 'cart.items': '{count, plural, one {# item} other {# items}} in your basket, {name}' },
  de: {
    'app.title': 'Rezeptbox',
    'inbox.count': '{n, plural, =0 {Keine neuen Nachrichten} one {# neue Nachricht} other {# neue Nachrichten}}',
    'cart.items': '{count, plural, one {# Artikel} other {# Artikel}} im Warenkorb, {name}',
    'profile.gender': '{g, select, female {Sie mag dein Rezept} male {Er mag dein Rezept} other {Jemand mag dein Rezept}}',
    'recipe.serves': 'Für {n, number} Personen',
  },
  pl: {
    'app.title': 'Przepiśnik',
    'inbox.count': '{n, plural, =0 {Brak wiadomości} one {# nowa wiadomość} few {# nowe wiadomości} many {# nowych wiadomości} other {# wiadomości}}',
  },
  ru: {
    'inbox.count': '{n, plural, one {# сообщение} few {# сообщения} many {# сообщений} other {# сообщения}}',
  },
  ar: {
    'inbox.count': '{n, plural, zero {لا رسائل} one {رسالة واحدة} two {رسالتان} few {# رسائل} many {# رسالة} other {# رسالة}}',
  },
  fr: { 'app.title': 'Boîte à recettes', 'broken.msg': '{n, plural, one {# truc}' },
};

const nextFrame = () => new Promise((res) => requestAnimationFrame(res));

async function* loadCatalogChunks(locale) {
  const entries = Object.entries(RAW_CATALOGS[locale] ?? {});
  for (let i = 0; i < entries.length; i += 3) {
    await nextFrame();
    yield entries.slice(i, i + 3);
  }
}

class Catalog {
  #locale;
  #compiled = new Map();
  #errors = [];
  constructor(locale) { this.#locale = locale; }
  get locale() { return this.#locale; }
  get errors() { return this.#errors.slice(); }
  get size() { return this.#compiled.size; }
  add(key, src) {
    try {
      this.#compiled.set(key, parseMessage(src));
      return true;
    } catch (e) {
      this.#errors.push(key + ': ' + (e instanceof MessageSyntaxError ? e.message : 'unknown'));
      return false;
    } finally {
      // keep deterministic insertion ordering of error keys
      this.#errors.sort();
    }
  }
  lookup(key) { return this.#compiled.get(key); }
}

class ChainedCatalog extends Catalog {
  #parent;
  constructor(locale, parent) { super(locale); this.#parent = parent; }
  lookup(key) { return super.lookup(key) ?? this.#parent?.lookup(key); }
  get chain() { const c = [this.locale]; let p = this.#parent; while (p) { c.push(p.locale); p = p instanceof ChainedCatalog ? p.parentCatalog : null; } return c; }
  get parentCatalog() { return this.#parent; }
}

// ------------------------------------------------------------------ i18n runtime with reactive store
class I18n extends EventTarget {
  #catalogs = new Map();
  #state;
  #subs = new Set();
  constructor() {
    super();
    const self2 = this;
    this.#state = new Proxy({ locale: 'en', dir: 'ltr', ready: false }, {
      set(t, k, v) {
        const old = t[k];
        if (old === v) return true;
        t[k] = v;
        for (const fn of self2.#subs) fn(k, v, old);
        self2.dispatchEvent(new CustomEvent('statechange', { detail: { key: k, value: v, old } }));
        return true;
      },
    });
  }
  get state() { return this.#state; }
  subscribe(fn) { this.#subs.add(fn); return () => this.#subs.delete(fn); }
  async load(locale) {
    if (this.#catalogs.has(locale)) return this.#catalogs.get(locale);
    const tag = parseTag(locale);
    const parentLocale = tag?.region ? tag.lang : locale === 'en' ? null : 'en';
    const parent = parentLocale ? await this.load(parentLocale) : null;
    const cat = new ChainedCatalog(locale, parent);
    let chunks = 0;
    for await (const chunk of loadCatalogChunks(locale)) {
      chunks++;
      for (const [k, v] of chunk) cat.add(k, v);
    }
    this.#catalogs.set(locale, cat);
    log(`  loaded ${locale}: ${cat.size} msgs in ${chunks} chunks, chain=${cat.chain.join('>')}${cat.errors.length ? ' errors=' + cat.errors.join(';') : ''}`);
    return cat;
  }
  async use(locale) {
    const cat = await this.load(locale);
    this.#state.locale = locale;
    this.#state.dir = /^(ar|he|fa)/.test(locale) ? 'rtl' : 'ltr';
    this.#state.ready = true;
    return cat;
  }
  t(key, values = {}) {
    const cat = this.#catalogs.get(this.#state.locale);
    const ast = cat?.lookup(key);
    if (!ast) return '⟦' + key + '⟧';
    return formatAst(ast, this.#state.locale, values, 0);
  }
  n(value, opts) { return intl.get('num', this.#state.locale, opts).format(value); }
  list(items, type = 'conjunction') { return intl.get('list', this.#state.locale, { type }).format(items); }
  sort(items, opts) { const c = intl.get('coll', this.#state.locale, opts); return items.slice().sort(c.compare); }
}

// ------------------------------------------------------------------ tagged template for translated html
function makeTag(i18n) {
  return function t(strings, ...vals) {
    let out = '';
    strings.forEach((s, i) => {
      out += s;
      if (i < vals.length) {
        const v = vals[i];
        if (Array.isArray(v) && typeof v[0] === 'string' && v[0].startsWith('@')) out += i18n.t(v[0].slice(1), v[1] || {});
        else if (typeof v === 'number') out += i18n.n(v);
        else out += String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      }
    });
    return out;
  };
}

// ------------------------------------------------------------------ DOM binding
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

function buildUi(root) {
  const header = el('h1', { 'data-i18n': 'app.title' });
  const inbox = el('p', { 'data-i18n': 'inbox.count', 'data-i18n-args': '{"n":5}' });
  const cart = el('p', { 'data-i18n': 'cart.items', 'data-i18n-args': '{"count":1,"name":"Ada"}' });
  const serves = el('p', { 'data-i18n': 'recipe.serves', 'data-i18n-args': '{"n":12000}' });
  const picker = el('ul', { class: 'lang-picker' });
  for (const code of ['en', 'en-GB', 'de', 'pl', 'ar']) {
    picker.append(el('li', { 'data-lang': code, class: 'lang' }, el('span', { class: 'label' }, code.toUpperCase())));
  }
  root.append(header, inbox, cart, serves, picker);
  return { header, inbox, cart, serves, picker };
}

function renderAll(root, i18n) {
  let changed = 0;
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    let args = {};
    try { args = JSON.parse(node.getAttribute('data-i18n-args') || '{}'); } catch { args = {}; }
    const txt = i18n.t(key, args);
    if (node.textContent !== txt) { node.textContent = txt; changed++; }
  }
  root.setAttribute('dir', i18n.state.dir);
  root.setAttribute('lang', i18n.state.locale);
  return changed;
}

// ------------------------------------------------------------------ main
async function main() {
  log('== negotiation ==');
  const reqs = [
    navigator.languages,
    ['de-CH', 'fr-CA', 'xx'],
    ['EN-gb', 'not a tag!', 'ja'],
    ['pt-BR'],
    ['ar-EG', 'de-AT'],
  ];
  for (const r of reqs) {
    const res = negotiate(r, SUPPORTED);
    log(`  [${r.join(', ')}] -> ${res.map(({ av, score, why }) => `${av}(${score},${why})`).join(' ')}`);
  }

  log('== parser ==');
  const samples = ['Hello {name}!', '{n, plural, one {# cat} other {# cats}}', "It''s '{literal}'", '{x, select, a {A} other {O}}', '{bad', '{n, plural, one {x}}'];
  for (const s of samples) {
    try {
      const ast = parseMessage(s);
      log('  ok  ', JSON.stringify(s), '->', ast.map((n) => n.type).join(','));
    } catch (e) {
      if (e instanceof MessageSyntaxError) log('  err ', JSON.stringify(s), '->', e.message);
      else throw e;
    }
  }

  const i18n = new I18n();
  const events = [];
  i18n.addEventListener('statechange', (ev) => events.push(ev.detail.key + '=' + ev.detail.value));
  const unsub = i18n.subscribe((k, v, old) => log(`  state ${k}: ${old} -> ${v}`));

  const best = negotiate(navigator.languages, SUPPORTED)[0].av;
  log('== loading', best, '==');
  await i18n.use(best);

  const app = document.getElementById('app');
  const ui = buildUi(app);
  let pending = false;
  const scheduleRender = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const c = renderAll(app, i18n);
      log(`  render[${i18n.state.locale}] changed=${c} title=${JSON.stringify(ui.header.textContent)} inbox=${JSON.stringify(ui.inbox.textContent)}`);
      app.dispatchEvent(new CustomEvent('i18n:rendered', { bubbles: true, detail: { changed: c } }));
    });
  };
  i18n.subscribe((k) => { if (k === 'locale') scheduleRender(); });
  const renderedCounts = [];
  document.body.addEventListener('i18n:rendered', (ev) => renderedCounts.push(ev.detail.changed));
  scheduleRender();
  await nextFrame();

  log('== messages en ==');
  for (const n of [0, 1, 2, 21, 1000]) log('  inbox', n, '=>', i18n.t('inbox.count', { n }));
  for (const g of ['female', 'male', 'x']) log('  gender', g, '=>', i18n.t('profile.gender', { g }));
  for (const guests of [0, 1, 2, 5]) log('  party', guests, '=>', i18n.t('party.guests', { host: 'Kim', guests, guest: 'Lee' }));
  log('  escape =>', i18n.t('escape.demo'));
  log('  missing =>', i18n.t('nope.key'));

  log('== picker (delegated clicks) ==');
  const clicked = [];
  const pickerLog = [];
  ui.picker.addEventListener('click', (ev) => {
    pickerLog.push('capture:' + ev.target.localName);
    if (ev.target.closest('[data-lang="ar"]') && ui.picker.getAttribute('data-lock') === '1') {
      ev.stopPropagation();
      pickerLog.push('blocked');
    }
  }, true);
  app.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-lang]');
    if (!li) return;
    clicked.push(li.dataset.lang);
  });
  const labels = ui.picker.querySelectorAll('.label');
  for (const idx of [2, 3, 1]) {
    labels[idx].click();
    const lang = clicked[clicked.length - 1];
    await i18n.use(lang);
    await nextFrame();
    const n = [0, 1, 2, 3, 5, 12, 22, 25, 101, 1.5];
    log(`  ${lang} inbox: ${n.map((x) => i18n.t('inbox.count', { n: x })).join(' | ')}`);
    log(`  ${lang} cart: ${i18n.t('cart.items', { count: 3, name: 'Ada' })}`);
    log(`  ${lang} serves: ${i18n.t('recipe.serves', { n: 12000 })}`);
  }
  ui.picker.setAttribute('data-lock', '1');
  labels[4].click();
  log('  after locked click:', clicked.join(','), '|', pickerLog.join(','));
  ui.picker.removeAttribute('data-lock');
  labels[4].click();
  await i18n.use(clicked[clicked.length - 1]);
  await nextFrame();
  log('  ar dir =', app.getAttribute('dir'), 'lang =', app.getAttribute('lang'));
  for (const n of [0, 1, 2, 3, 11, 100]) log('  ar inbox', n, '=>', i18n.t('inbox.count', { n }));

  log('== number / list / collation ==');
  const nums = [1234567.891, -0.5, 0.000123, 42];
  for (const loc of ['en', 'de', 'fr', 'ja', 'pl']) {
    await i18n.use(loc);
    const parts = [
      nums.map((x) => i18n.n(x, { maximumFractionDigits: 2 })).join(' ; '),
      i18n.n(0.256, { style: 'percent' }),
      i18n.n(1500, { notation: 'compact' }),
      i18n.n(12.5, { style: 'currency', currency: 'EUR' }),
      i18n.n(3, { minimumIntegerDigits: 3 }),
    ];
    log(`  ${loc}: ${parts.join(' | ')}`);
    log(`  ${loc} list: ${i18n.list(['flour', 'sugar', 'eggs'])} / ${i18n.list(['tea', 'coffee'], 'disjunction')}`);
  }
  const words = ['Äpfel', 'apple', 'Zebra', 'zucchini', 'éclair', 'Eclair', 'ångström', 'item10', 'item2'];
  for (const loc of ['en', 'de', 'sv']) {
    i18n.state.locale = loc;
    log(`  sort ${loc}:`, i18n.sort(words).join(','));
  }
  i18n.state.locale = 'en';
  log('  numeric sort:', i18n.sort(words.filter((w) => w.startsWith('item')), { numeric: true }).join(','));
  log('  base sensitivity eq:', intl.get('coll', 'en', { sensitivity: 'base' }).compare('éclair', 'Eclair'));

  log('== plural categories table ==');
  const cats = {};
  for (const loc of ['en', 'pl', 'ru', 'ar', 'ja', 'fr']) {
    const pr = intl.get('plural', loc);
    const row = [];
    for (let n = 0; n <= 25; n++) {
      if (n > 12 && n % 5 !== 0 && n !== 21 && n !== 22) continue;
      row.push(n + ':' + pr.select(n)[0]);
    }
    cats[loc] = pr.resolvedOptions().pluralCategories.join('/');
    log(`  ${loc.padEnd(2)} ${row.join(' ')}`);
  }
  log('  categories', JSON.stringify(cats));
  const ord = intl.get('plural', 'en', { type: 'ordinal' });
  const suffix = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
  log('  ordinals', [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => n + suffix[ord.select(n)]).join(' '));

  log('== tagged template ==');
  await i18n.use('de');
  const T = makeTag(i18n);
  const user = '<Bob & co>';
  log('  ' + T`<b>${user}</b>: ${['@inbox.count', { n: 3 }]} · ${9876.5} · ${['@missing']}`);
  await i18n.use('en-GB');
  log('  ' + T`<i>${['@app.title']}</i> ${['@cart.items', { count: 2, name: user }]}`);

  log('== pseudo-localization ==');
  const accent = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', O: 'Ó' };
  const pseudo = (s) => '[' + s.replace(/\{[^}]*\}|[aeiouAEO]/g, (m) => (m.length > 1 ? m : accent[m])) + ' ~~]';
  for (const k of ['app.title', 'recipe.serves']) {
    const src = RAW_CATALOGS.en[k];
    log('  ', k, '=>', pseudo(src));
  }

  unsub();
  i18n.state.locale = 'ja';
  log('== summary ==');
  log('  events', events.length, events.slice(0, 8).join(' '));
  log('  renders', renderedCounts.join(','));
  log('  intl cache', JSON.stringify(intl.stats));
  log('  document lang attr', document.documentElement.getAttribute('lang'));
}

main().then(
  () => log('done'),
  (e) => { log('FAILED', e instanceof Error ? 'error' : String(e)); },
);
