// Multi-step signup form wizard: markup comes from an `html` tagged template that is parsed by a
// tiny regex tokenizer into real DOM nodes; the form model is a Proxy-based reactive store; fields
// are a class hierarchy with private state, sync + async validators (rAF-scheduled "server"
// checks), dependent fields (confirm password, region list by country, postal pattern by
// country, interests required when newsletter is on). Steps are mirrored into history.pushState
// and restored on popstate. Submission streams progress through an async generator.
'use strict';

const say = (...parts) => console.log(parts.join(' '));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const microtask = () => Promise.resolve();

// ------------------------------------------------------------------ html tagged template -> DOM
class SafeMarkup {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const UNESC = { amp: '&', lt: '<', gt: '>', quot: '"' };
const escapeMarkup = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const unescapeMarkup = (s) => s.replace(/&(amp|lt|gt|quot);/g, (m, n) => UNESC[n]);

function html(strings, ...values) {
  let text = strings[0];
  values.forEach((v, i) => {
    if (Array.isArray(v)) text += v.map((x) => (x instanceof SafeMarkup ? x.text : escapeMarkup(x))).join('');
    else if (v instanceof SafeMarkup) text += v.text;
    else if (v !== null && v !== undefined && v !== false) text += escapeMarkup(v);
    text += strings[i + 1];
  });
  return new SafeMarkup(text);
}

const TOKEN_RE = /<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/y;
const ATTR_RE = /([\w-]+)(?:="([^"]*)")?/g;
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img']);

function buildDom(markup) {
  const frag = document.createDocumentFragment();
  const stack = [frag];
  const src = String(markup);
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    const [, closeTag, openTag, attrText, selfClose, textRun] = m;
    if (closeTag) {
      if (stack.length > 1 && top.localName === closeTag) stack.pop();
      else throw new Error('mismatched closing tag ' + closeTag);
    } else if (openTag) {
      const el = document.createElement(openTag);
      ATTR_RE.lastIndex = 0;
      for (let a = ATTR_RE.exec(attrText); a; a = ATTR_RE.exec(attrText)) el.setAttribute(a[1], a[2] === undefined ? '' : unescapeMarkup(a[2]));
      top.appendChild(el);
      if (!selfClose && !VOID_TAGS.has(openTag)) stack.push(el);
    } else if (textRun.trim()) {
      top.appendChild(document.createTextNode(unescapeMarkup(textRun.trim())));
    }
  }
  if (stack.length !== 1) throw new Error('unclosed tags: ' + (stack.length - 1));
  return frag;
}

// ------------------------------------------------------------------ reactive model
const proxyCache = new WeakMap();
function reactive(target, notify, path = []) {
  if (proxyCache.has(target)) return proxyCache.get(target);
  const proxy = new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv);
      if (typeof key === 'string' && v && typeof v === 'object') return reactive(v, notify, path.concat(key));
      return v;
    },
    set(t, key, value, recv) {
      const old = t[key];
      if (Object.is(old, value)) return true;
      Reflect.set(t, key, value, recv);
      notify(path.concat(String(key)).join('.'), old, value);
      return true;
    },
    deleteProperty(t, key) {
      if (!(key in t)) return true;
      const old = t[key];
      delete t[key];
      notify(path.concat(String(key)).join('.'), old, undefined);
      return true;
    },
  });
  proxyCache.set(target, proxy);
  return proxy;
}

const changeLog = [];
const watchers = new Map();
const model = reactive({ account: {}, profile: {}, address: {}, meta: { step: 0, submitted: false } }, (p, oldV, newV) => {
  changeLog.push(p);
  for (const [prefix, fns] of watchers) if (p === prefix || p.startsWith(prefix + '.')) for (const fn of fns) fn(newV, oldV, p);
});
function watch(prefix, fn) {
  if (!watchers.has(prefix)) watchers.set(prefix, []);
  watchers.get(prefix).push(fn);
}

// ------------------------------------------------------------------ fake backend
const TAKEN_NAMES = new Set(['admin', 'root', 'alice', 'support']);
const CITY_BY_PREFIX = { CH: { 1: 'Lausanne', 3: 'Bern', 8: 'Zuerich' }, DE: { 1: 'Berlin', 8: 'Muenchen', 5: 'Koeln' }, US: { 1: 'New York', 9: 'San Francisco' } };
let backendCalls = 0;
async function checkUsername(name) {
  backendCalls++;
  await nextFrame();
  return !TAKEN_NAMES.has(name.toLowerCase());
}
async function lookupCity(country, postal) {
  backendCalls++;
  await nextFrame();
  await nextFrame();
  return CITY_BY_PREFIX[country]?.[postal[0]] ?? null;
}

// ------------------------------------------------------------------ fields
const REGIONS = { DE: ['Bayern', 'Berlin', 'Hessen'], US: ['California', 'New York', 'Texas'], CH: ['Bern', 'Vaud', 'Zuerich'] };
const POSTAL = { DE: /^\d{5}$/, US: /^\d{5}(?:-\d{4})?$/, CH: /^[1-9]\d{3}$/ };

class Field {
  #errors = [];
  #touched = false;
  #pending = 0;
  constructor(section, key, label, opts = {}) {
    this.section = section;
    this.key = key;
    this.label = label;
    this.required = !!opts.required;
    this.rules = opts.rules || [];
    this.asyncRule = opts.asyncRule || null;
    this.el = null;
  }
  get value() { return model[this.section][this.key] ?? ''; }
  set value(v) { model[this.section][this.key] = v; }
  get errors() { return this.#errors.slice(); }
  get valid() { return this.#errors.length === 0 && this.#pending === 0; }
  get touched() { return this.#touched; }
  touch() { this.#touched = true; }
  markup() { return html`<input name="${this.key}" value="${this.value}"/>`; }
  render() {
    const hint = this.#errors.length ? html`<span class="error" role="alert">${this.#errors.join('; ')}</span>` : '';
    return html`<div class="field" data-key="${this.key}"><label>${this.label}${this.required ? ' *' : ''}</label>${this.markup()}<button type="button" class="help" data-help="${this.key}">?</button>${hint}</div>`;
  }
  readFromDom(el) { return el.value; }
  isEmpty(v) { return v === '' || v === null || v === undefined; }
  async validate() {
    const errs = [];
    const v = this.value;
    if (this.isEmpty(v)) {
      if (this.required) errs.push('required');
    } else {
      for (const rule of this.rules) {
        const msg = rule(v, model);
        if (msg) { errs.push(msg); if (rule.fatal) break; }
      }
      if (!errs.length && this.asyncRule) {
        this.#pending++;
        try {
          const msg = await this.asyncRule(v, model);
          if (msg) errs.push(msg);
        } finally {
          this.#pending--;
        }
      }
    }
    this.#errors = errs;
    return errs.length === 0;
  }
}

class TextField extends Field {}

class NumberField extends Field {
  constructor(section, key, label, { min, max, ...rest }) {
    super(section, key, label, rest);
    this.rules = [(v) => (/^-?\d+$/.test(String(v)) ? null : 'not a whole number'), (v) => (v < min || v > max ? `must be ${min}..${max}` : null), ...this.rules];
    this.rules[0].fatal = true;
  }
  readFromDom(el) { const s = el.value.trim(); return /^-?\d+$/.test(s) ? Number(s) : s; }
}

class CheckboxField extends Field {
  markup() { return html`<input type="checkbox" name="${this.key}"${this.value ? new SafeMarkup(' checked') : ''}/>`; }
  readFromDom(el) { return el.checked; }
  isEmpty(v) { return v !== true; }
}

class SelectField extends Field {
  #optionsFn;
  constructor(section, key, label, optionsFn, opts) {
    super(section, key, label, opts);
    this.#optionsFn = optionsFn;
  }
  get options() { return this.#optionsFn(model) || []; }
  markup() {
    const opts = this.options.map((o) => html`<option value="${o}"${o === this.value ? new SafeMarkup(' selected') : ''}>${o}</option>`);
    return html`<select name="${this.key}"><option value="">--</option>${opts}</select>`;
  }
  async validate() {
    if (this.value && !this.options.includes(this.value)) this.value = '';
    return super.validate();
  }
}

class ListField extends TextField {
  readFromDom(el) {
    return el.value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  isEmpty(v) { return !Array.isArray(v) || v.length === 0; }
  markup() { return html`<input name="${this.key}" value="${(this.value || []).join(', ')}"/>`; }
}

function rule(fn, fatal) { fn.fatal = !!fatal; return fn; }

const STEPS = [
  { slug: 'account', title: 'Account', fields: [
    new TextField('account', 'username', 'Username', { required: true,
      rules: [rule((v) => (/^[a-z][a-z0-9_]{2,15}$/.test(v) ? null : 'lowercase letters, digits, _ (3-16)'), true)],
      asyncRule: async (v) => ((await checkUsername(v)) ? null : `"${v}" is taken`) }),
    new TextField('account', 'email', 'E-mail', { required: true, rules: [(v) => (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? null : 'invalid e-mail')] }),
    new TextField('account', 'password', 'Password', { required: true, rules: [
      (v) => (v.length >= 8 ? null : 'at least 8 characters'),
      (v) => (/\d/.test(v) ? null : 'needs a digit'),
      (v) => (/[A-Z]/.test(v) ? null : 'needs an uppercase letter')] }),
    new TextField('account', 'confirm', 'Confirm password', { required: true, rules: [(v, m) => (v === m.account.password ? null : 'does not match')] }),
  ] },
  { slug: 'profile', title: 'Profile', fields: [
    new TextField('profile', 'displayName', 'Display name', { rules: [(v) => (v.length <= 20 ? null : 'too long')] }),
    new NumberField('profile', 'age', 'Age', { required: true, min: 13, max: 120 }),
    new CheckboxField('profile', 'newsletter', 'Newsletter'),
    new ListField('profile', 'interests', 'Interests', { rules: [(v) => (v.length <= 4 ? null : 'max 4 interests')] }),
  ] },
  { slug: 'address', title: 'Address', fields: [
    new SelectField('address', 'country', 'Country', () => Object.keys(REGIONS), { required: true }),
    new SelectField('address', 'region', 'Region', (m) => REGIONS[m.address.country], { required: true }),
    new TextField('address', 'postal', 'Postal code', { required: true,
      rules: [(v, m) => (POSTAL[m.address.country]?.test(v) ? null : `invalid for ${m.address.country || 'no country'}`)],
      asyncRule: async (v, m) => {
        const city = await lookupCity(m.address.country, v);
        if (city && !m.address.city) m.address.city = city;
        return null;
      } }),
    new TextField('address', 'city', 'City', { required: true }),
  ] },
  { slug: 'review', title: 'Review', fields: [] },
];
const FIELD_INDEX = new Map();
for (const [stepNo, step] of STEPS.entries()) for (const f of step.fields) FIELD_INDEX.set(f.key, { field: f, stepNo });

// dependent-field wiring
const interestsField = FIELD_INDEX.get('interests').field;
watch('profile.newsletter', (on) => { interestsField.required = !!on; say('  [dep] interests required =', interestsField.required); });
watch('account.username', (v) => {
  if (!model.profile.displayName || model.profile.displayName === model.meta.autoName) {
    model.profile.displayName = v;
    model.meta.autoName = v;
  }
});
watch('account.password', () => { if (model.account.confirm) FIELD_INDEX.get('confirm').field.validate(); });
watch('address.country', (v, old) => {
  if (old !== undefined) { model.address.region = ''; model.address.city = ''; }
  say('  [dep] country', old ?? '(none)', '->', v, '| regions:', (REGIONS[v] || []).join('/'));
});

// ------------------------------------------------------------------ wizard
const STEP_ROUTE = /^\/signup\/(?<slug>[a-z]+)(?:\/(?<extra>\d+))?$/;

class Wizard extends EventTarget {
  #index = 0;
  #busy = false;
  #root;
  #renders = 0;
  constructor(root) {
    super();
    this.#root = root;
  }
  get step() { return STEPS[this.#index]; }
  get index() { return this.#index; }
  get renders() { return this.#renders; }
  render() {
    this.#renders++;
    const step = this.step;
    const dots = STEPS.map((s, i) => html`<li class="${i === this.#index ? 'current' : i < this.#index ? 'done' : 'todo'}">${s.title}</li>`);
    const body = step.slug === 'review' ? this.reviewMarkup() : step.fields.map((f) => f.render());
    const markup = html`<form id="wizard" data-step="${step.slug}"><ol class="steps">${dots}</ol><h2>${step.title}</h2>${body}<div class="actions">${this.#index > 0 ? html`<button type="button" data-action="back">Back</button>` : ''}<button type="button" data-action="${step.slug === 'review' ? 'submit' : 'next'}">${step.slug === 'review' ? 'Submit' : 'Next'}</button></div></form>`;
    this.#root.replaceChildren(buildDom(markup));
    for (const f of step.fields) f.el = this.#root.querySelector(`[name=${f.key}]`);
    this.#root.firstElementChild.dispatchEvent(new CustomEvent('wizard:render', { bubbles: true, detail: { step: step.slug, n: this.#renders } }));
  }
  reviewMarkup() {
    const rows = [];
    for (const [section, values] of Object.entries(model)) {
      if (section === 'meta') continue;
      for (const [k, v] of Object.entries(values)) {
        const shown = k === 'password' || k === 'confirm' ? '*'.repeat(String(v).length) : Array.isArray(v) ? v.join(' | ') : String(v);
        rows.push(html`<tr><td>${section}.${k}</td><td>${shown}</td></tr>`);
      }
    }
    return html`<table class="review">${rows}</table>`;
  }
  async validateStep(i = this.#index) {
    const results = await Promise.all(STEPS[i].fields.map((f) => f.validate()));
    return results.every(Boolean);
  }
  async next() {
    if (this.#busy) return 'busy';
    this.#busy = true;
    try {
      const ok = await this.validateStep();
      if (!ok) {
        this.render();
        const bad = this.step.fields.filter((f) => !f.valid).map((f) => `${f.key}(${f.errors.join(',')})`);
        this.dispatchEvent(new CustomEvent('invalid', { detail: bad }));
        return 'invalid';
      }
      this.goTo(this.#index + 1, true);
      return 'advanced';
    } finally {
      this.#busy = false;
    }
  }
  goTo(i, push) {
    this.#index = Math.max(0, Math.min(STEPS.length - 1, i));
    model.meta.step = this.#index;
    if (push) window.history.pushState({ step: this.#index }, '', '/signup/' + this.step.slug);
    this.render();
    this.dispatchEvent(new CustomEvent('step', { detail: { index: this.#index, slug: this.step.slug } }));
  }
  restore(state) {
    const route = STEP_ROUTE.exec(window.location.pathname);
    const bySlug = route ? STEPS.findIndex((s) => s.slug === route.groups.slug) : -1;
    const target = state?.step ?? (bySlug >= 0 ? bySlug : 0);
    say('  [popstate] path', window.location.pathname, 'state', JSON.stringify(state), '-> step', target);
    this.goTo(target, false);
  }
  async *submitProgress(payload) {
    const chunks = payload.match(/.{1,40}/g) || [];
    let sent = 0;
    for (const chunk of chunks) {
      await nextFrame();
      sent += chunk.length;
      yield { sent, total: payload.length, pct: Math.round((sent / payload.length) * 100) };
    }
  }
  async submit() {
    if (this.#busy) return { ok: false, reason: 'busy' };
    this.#busy = true;
    const t0 = performance.now();
    try {
      for (let i = 0; i < STEPS.length - 1; i++) {
        if (!(await this.validateStep(i))) {
          this.goTo(i, true);
          return { ok: false, reason: 'step ' + STEPS[i].slug + ' invalid' };
        }
      }
      const payload = JSON.stringify({ account: { ...model.account, password: undefined, confirm: undefined }, profile: model.profile, address: model.address });
      let last = null;
      for await (const p of this.submitProgress(payload)) {
        last = p;
        if (p.pct >= 50 && p.pct < 75) say('  upload', p.pct + '%', `(${p.sent}/${p.total})`);
      }
      model.meta.submitted = true;
      return { ok: true, bytes: last.total, id: 'sub-' + (payload.length * 31 % 997) };
    } finally {
      this.#busy = false;
      say('  [submit] finally, busy cleared, elapsed ticks', ((performance.now() - t0) > 0) ? 'positive' : 'zero');
    }
  }
}

// ------------------------------------------------------------------ mount + delegation
const app = document.getElementById('app');
const wizard = new Wizard(app);
let captureSeen = 0, helpShown = [];

app.addEventListener('click', (ev) => { if (ev.target.matches?.('button')) captureSeen++; }, true);
app.addEventListener('click', async (ev) => {
  const action = ev.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  say('  [click] action', action);
  if (action === 'next') say('  next ->', await wizard.next());
  else if (action === 'back') window.history.back();
  else if (action === 'submit') {
    const res = await wizard.submit();
    say('  submit ->', JSON.stringify(res));
  }
});
app.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.help');
  if (!btn) return;
  ev.stopPropagation();
  helpShown.push(btn.dataset.help);
}, true);
// the capture handler above stops propagation for help buttons, so this bubble handler never sees them
document.body.addEventListener('click', (ev) => { if (ev.target.closest('.help')) say('  !! help leaked to body'); });

app.addEventListener('input', (ev) => {
  const entry = FIELD_INDEX.get(ev.target.getAttribute('name'));
  if (!entry) return;
  entry.field.touch();
  entry.field.value = entry.field.readFromDom(ev.target);
});
app.addEventListener('change', (ev) => {
  const entry = FIELD_INDEX.get(ev.target.getAttribute('name'));
  if (entry) entry.field.value = entry.field.readFromDom(ev.target);
});
document.addEventListener('wizard:render', (ev) => { say(`  [render #${ev.detail.n}] ${ev.detail.step}: ${app.querySelectorAll('.error').length} error(s)`); });
wizard.addEventListener('invalid', (ev) => { for (const b of ev.detail) say('    invalid', b); });
wizard.addEventListener('step', (ev) => { say('  [step]', ev.detail.index, ev.detail.slug, 'url', window.location.pathname); });
window.addEventListener('popstate', (ev) => wizard.restore(ev.state));

// ------------------------------------------------------------------ user simulation
function typeInto(name, text) {
  const el = app.querySelector(`[name=${name}]`);
  if (!el) { say('  (no field', name + ')'); return; }
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function choose(name, value) {
  const el = app.querySelector(`[name=${name}]`);
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function tick(name, on) {
  const el = app.querySelector(`[name=${name}]`);
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
async function press(action) {
  const btn = app.querySelector(`[data-action=${action}]`);
  btn.click();
  for (let i = 0; i < 12; i++) await nextFrame();
}
async function settle(n = 6) { for (let i = 0; i < n; i++) await nextFrame(); }

async function* scenario() {
  yield 'initial render';
  wizard.render();
  yield 'next with empty form';
  await press('next');
  yield 'fill account (bad values)';
  typeInto('username', 'Admin');
  typeInto('email', 'alice@@example');
  typeInto('password', 'short');
  typeInto('confirm', 'nope');
  await press('next');
  yield 'username taken, fix others';
  typeInto('username', 'admin');
  typeInto('email', 'alice@example.org');
  typeInto('password', 'Sup3rSecret');
  typeInto('confirm', 'Sup3rSecret');
  await press('next');
  yield 'available username';
  typeInto('username', 'alice_dev');
  await press('next');
  yield 'profile step';
  say('  auto display name:', model.profile.displayName);
  for (const key of ['displayName', 'age', 'newsletter']) app.querySelector(`[data-help=${key}]`).click();
  typeInto('age', 'nine');
  await press('next');
  typeInto('age', '9');
  tick('newsletter', true);
  await press('next');
  typeInto('age', '34');
  typeInto('interests', 'js, css, , a11y');
  await press('next');
  yield 'address step';
  choose('country', 'US');
  wizard.render();
  choose('region', 'Texas');
  typeInto('postal', '1234');
  await press('next');
  choose('country', 'CH');
  wizard.render();
  say('  region after country change:', JSON.stringify(model.address.region));
  choose('region', 'Zuerich');
  typeInto('postal', '8001');
  await press('next');
  say('  city filled by lookup:', model.address.city);
  yield 'history back / forward';
  window.history.back();
  await settle();
  say('  age still', model.profile.age, 'interests', JSON.stringify(model.profile.interests));
  window.history.forward();
  await settle();
  yield 'go to review';
  await press('next');
  const cells = [...app.querySelectorAll('td')].map((td) => td.textContent);
  for (let i = 0; i < cells.length; i += 2) say('   ', cells[i].padEnd(22), cells[i + 1]);
  yield 'invalidate account then submit';
  model.account.confirm = 'changed';
  await press('submit');
  yield 'repair and submit again';
  typeInto('confirm', 'Sup3rSecret');
  await press('next');
  await press('next');
  await press('next');
  await press('submit');
  await settle(10);
}

async function main() {
  say('start at', window.location.pathname + window.location.search);
  window.history.replaceState({ step: 0 }, '', '/signup/account');
  let n = 0;
  for await (const label of scenario()) say(`== ${++n}. ${label}`);
  say('== summary');
  say('submitted:', model.meta.submitted, '| step:', model.meta.step, '| renders:', wizard.renders);
  say('backend calls:', backendCalls, '| help shown:', helpShown.join(','), '| capture clicks:', captureSeen);
  say('history length:', window.history.length, '| path:', window.location.pathname);
  const counts = changeLog.reduce((acc, p) => { const s = p.split('.')[0]; acc[s] = (acc[s] || 0) + 1; return acc; }, {});
  say('changes by section:', JSON.stringify(counts));
  say('model:', JSON.stringify(model));
  let firstInvalid = null;
  scan: for (const step of STEPS) {
    for (const f of step.fields) {
      if (!f.valid) { firstInvalid = f.key; break scan; }
    }
  }
  say('first invalid field:', firstInvalid ?? 'none');
  await microtask();
}

main().catch((e) => { say('FAILED', e instanceof Error ? e.message : String(e)); });
