// Form validation library: declarative rule sets per field, sync and async rules, error rendering
// into <span class="error"> nodes next to inputs, aria-invalid toggling, live validation on
// input/blur events and a submit handler that prevents default until the form is valid.
'use strict';

const Rules = {
  required: (msg) => (v) => (v.trim() === '' ? msg || 'This field is required' : null),
  minLength: (n) => (v) => (v.length < n ? 'Must be at least ' + n + ' characters' : null),
  maxLength: (n) => (v) => (v.length > n ? 'Must be at most ' + n + ' characters' : null),
  pattern: (re, msg) => (v) => (v !== '' && !re.test(v) ? msg : null),
  email: () => Rules.pattern(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i, 'Enter a valid email address'),
  numberRange: (lo, hi) => (v) => {
    if (v === '') return null;
    const n = Number(v);
    if (Number.isNaN(n)) return 'Must be a number';
    return n < lo || n > hi ? 'Must be between ' + lo + ' and ' + hi : null;
  },
  matches: (otherName, label) => (v, values) => (v !== values[otherName] ? 'Must match ' + label : null),
  strongPassword: () => (v) => {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
    return classes < 3 ? 'Use at least 3 of: lower, upper, digit, symbol (' + classes + '/4)' : null;
  },
};

const TAKEN_USERNAMES = new Set(['admin', 'root', 'alice']);

function usernameAvailable() {
  return (v) => new Promise((resolve) => {
    queueMicrotask(() => resolve(TAKEN_USERNAMES.has(v.toLowerCase()) ? 'Username "' + v + '" is taken' : null));
  });
}

function buildField(form, spec) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = spec.label;
  label.setAttribute('for', 'f-' + spec.name);
  const input = document.createElement('input');
  input.setAttribute('name', spec.name);
  input.setAttribute('id', 'f-' + spec.name);
  input.setAttribute('type', spec.type || 'text');
  const err = document.createElement('span');
  err.className = 'error';
  err.hidden = true;
  wrap.append(label, input, err);
  form.appendChild(wrap);
  return input;
}

class FieldState {
  constructor(name, input, rules) {
    this.name = name;
    this.input = input;
    this.rules = rules;
    this.touched = false;
    this.errors = [];
    this.validations = 0;
  }

  get errorNode() {
    return this.input.parentElement.querySelector('.error');
  }

  render() {
    const node = this.errorNode;
    if (this.errors.length && this.touched) {
      node.textContent = this.errors[0];
      node.hidden = false;
      this.input.setAttribute('aria-invalid', 'true');
      this.input.classList.add('invalid');
    } else {
      node.textContent = '';
      node.hidden = true;
      this.input.removeAttribute('aria-invalid');
      this.input.classList.remove('invalid');
    }
  }
}

class FormValidator {
  constructor(form, schema) {
    this.form = form;
    this.fields = new Map();
    this.submissions = [];
    this.pending = 0;
    this.inflight = new Set();
    for (const [name, rules] of Object.entries(schema)) {
      const input = form.querySelector('[name="' + name + '"]');
      this.fields.set(name, new FieldState(name, input, rules));
    }
    form.addEventListener('input', (ev) => this.onInput(ev));
    form.addEventListener('blur', (ev) => this.onBlur(ev), true);
    form.addEventListener('submit', (ev) => this.onSubmit(ev));
  }

  values() {
    const out = {};
    for (const [name, f] of this.fields) out[name] = f.input.value;
    return out;
  }

  async validateField(name) {
    const f = this.fields.get(name);
    const values = this.values();
    const results = [];
    for (const rule of f.rules) {
      let r = rule(values[name], values);
      if (r && typeof r.then === 'function') {
        this.pending++;
        r = await r;
        this.pending--;
      }
      if (r) results.push(r);
    }
    f.errors = results;
    f.validations++;
    f.render();
    return results.length === 0;
  }

  async validateAll() {
    const verdicts = {};
    for (const name of this.fields.keys()) verdicts[name] = await this.validateField(name);
    return verdicts;
  }

  track(promise) {
    this.inflight.add(promise);
    promise.then(() => this.inflight.delete(promise));
    return promise;
  }

  async settle() {
    while (this.inflight.size) await Promise.all(Array.from(this.inflight));
  }

  onInput(ev) {
    const name = ev.target.getAttribute('name');
    const f = this.fields.get(name);
    if (!f) return;
    if (f.touched) this.track(this.validateField(name).then((ok) => console.log('  live[' + name + '] -> ' + (ok ? 'ok' : f.errors.join('; ')))));
  }

  onBlur(ev) {
    const name = ev.target.getAttribute && ev.target.getAttribute('name');
    const f = this.fields.get(name);
    if (!f) return;
    f.touched = true;
    this.track(this.validateField(name).then((ok) => console.log('  blur[' + name + '] -> ' + (ok ? 'ok' : f.errors.join('; ')))));
  }

  onSubmit(ev) {
    ev.preventDefault();
    console.log('  submit event: defaultPrevented=' + ev.defaultPrevented + ' target=' + ev.target.id);
    for (const f of this.fields.values()) f.touched = true;
    const done = this.validateAll().then((verdicts) => {
      const bad = Object.keys(verdicts).filter((k) => !verdicts[k]);
      const entry = { ok: bad.length === 0, bad, values: bad.length === 0 ? this.values() : null };
      this.submissions.push(entry);
      this.form.dispatchEvent(new CustomEvent(entry.ok ? 'form:valid' : 'form:invalid', { detail: entry, bubbles: true }));
      return entry;
    });
    this.lastSubmit = this.track(done);
  }

  summary() {
    const rows = [];
    for (const f of this.fields.values()) {
      rows.push(f.name.padEnd(9) + ' touched=' + (f.touched ? 'y' : 'n') + ' runs=' + f.validations + ' ' + (f.errors.length ? 'ERR ' + f.errors.join(' | ') : 'ok'));
    }
    return rows;
  }
}

async function setValue(validator, input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await validator.settle();
}

function blurField(input) {
  input.focus();
  input.blur();
}

function visibleErrors(form) {
  return Array.from(form.querySelectorAll('.error')).filter((n) => !n.hidden).map((n) => n.textContent);
}

async function submitForm(form, validator) {
  const btn = form.querySelector('button');
  btn.click(); // the shim's click() does not submit forms; dispatch submit explicitly
  const notCancelled = form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  console.log('  dispatch returned ' + notCancelled);
  await validator.settle();
  return validator.lastSubmit;
}

async function main() {
  const form = document.createElement('form');
  form.id = 'signup';
  document.body.appendChild(form);
  const specs = [
    { name: 'username', label: 'Username' },
    { name: 'email', label: 'E-mail', type: 'email' },
    { name: 'age', label: 'Age', type: 'number' },
    { name: 'password', label: 'Password', type: 'password' },
    { name: 'confirm', label: 'Confirm password', type: 'password' },
  ];
  const inputs = {};
  for (const s of specs) inputs[s.name] = buildField(form, s);
  const btn = document.createElement('button');
  btn.textContent = 'Create account';
  form.appendChild(btn);
  console.log('fields built:', form.querySelectorAll('.field').length, 'button type:', btn.type);

  const validator = new FormValidator(form, {
    username: [Rules.required(), Rules.minLength(3), Rules.pattern(/^[a-z0-9_]+$/i, 'Letters, digits and _ only'), usernameAvailable()],
    email: [Rules.required('E-mail is required'), Rules.email()],
    age: [Rules.numberRange(13, 120)],
    password: [Rules.required(), Rules.minLength(8), Rules.strongPassword()],
    confirm: [Rules.matches('password', 'password')],
  });

  document.body.addEventListener('form:valid', (ev) => console.log('  <body> saw form:valid with ' + Object.keys(ev.detail.values).length + ' values'));
  document.body.addEventListener('form:invalid', (ev) => console.log('  <body> saw form:invalid bad=' + ev.detail.bad.join(',')));

  console.log('-- phase 1: blur empty username');
  blurField(inputs.username);
  await validator.settle();
  console.log('visible errors:', JSON.stringify(visibleErrors(form)));

  console.log('-- phase 2: typing');
  await setValue(validator, inputs.username, 'al');
  await setValue(validator, inputs.username, 'alice');
  await setValue(validator, inputs.username, 'alice-2');
  await setValue(validator, inputs.username, 'alice_2');
  await setValue(validator, inputs.email, 'alice@example');
  await setValue(validator, inputs.age, '9');
  await setValue(validator, inputs.password, 'password');

  console.log('-- phase 3: first submit');
  const r1 = await submitForm(form, validator);
  console.log('submit #1 ok=' + r1.ok + ' bad=' + r1.bad.join(','));
  for (const row of validator.summary()) console.log('  ' + row);
  console.log('invalid inputs:', form.querySelectorAll('input.invalid').length, 'aria:', form.querySelectorAll('[aria-invalid="true"]').length);

  console.log('-- phase 4: fixes');
  await setValue(validator, inputs.email, 'alice@example.org');
  await setValue(validator, inputs.age, 'abc');
  await setValue(validator, inputs.age, '34');
  await setValue(validator, inputs.password, 'Tr0ub4dor&3');
  await setValue(validator, inputs.confirm, 'Tr0ub4dor&');
  await setValue(validator, inputs.confirm, 'Tr0ub4dor&3');

  const r2 = await submitForm(form, validator);
  console.log('submit #2 ok=' + r2.ok + ' values=' + JSON.stringify(r2.values));
  for (const row of validator.summary()) console.log('  ' + row);
  console.log('visible errors:', JSON.stringify(visibleErrors(form)));
  console.log('total submissions:', validator.submissions.length, 'pending async:', validator.pending);
  console.log('ok flags:', validator.submissions.map((s) => (s.ok ? 'Y' : 'N')).join(''));
}

main().then(() => console.log('done'));
