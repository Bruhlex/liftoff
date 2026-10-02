// Cookie-consent / preferences manager: parses and serialises document.cookie, stores a consent
// record (categories + version + expiry) encoded in a single cookie, uses a simulated day counter
// instead of wall-clock time for expiry, renders a banner with per-category toggles, dispatches
// consent-change events and removes cookies of categories the user withdrew.
'use strict';

const CONSENT_COOKIE = 'cc_prefs';
const POLICY_VERSION = 4;
const VALID_DAYS = 180;

const CATEGORIES = [
  { id: 'necessary', label: 'Strictly necessary', locked: true, cookies: ['session_id', 'csrf'] },
  { id: 'preferences', label: 'Preferences', locked: false, cookies: ['ui_lang', 'ui_theme'] },
  { id: 'statistics', label: 'Statistics', locked: false, cookies: ['stats_visits'] },
  { id: 'marketing', label: 'Marketing', locked: false, cookies: ['promo_seen', 'promo_ref'] },
];

class SimClock {
  constructor(startDay) {
    this.day = startDay;
  }
  advance(days) {
    this.day += days;
    return this.day;
  }
}

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (e) {
      out[k] = v;
    }
  }
  return out;
}

function serializeCookie(name, value, opts) {
  opts = opts || {};
  const parts = [encodeURIComponent(name) + '=' + encodeURIComponent(value)];
  if (opts.maxAge !== undefined) parts.push('Max-Age=' + opts.maxAge);
  parts.push('Path=' + (opts.path || '/'));
  if (opts.domain) parts.push('Domain=' + opts.domain);
  if (opts.sameSite) parts.push('SameSite=' + opts.sameSite);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function setCookie(name, value, opts) {
  const s = serializeCookie(name, value, opts);
  document.cookie = s;
  return s;
}

function deleteCookie(name) {
  document.cookie = serializeCookie(name, '', { maxAge: 0 });
}

function encodeConsent(rec) {
  const bits = CATEGORIES.map((c) => (rec.granted[c.id] ? '1' : '0')).join('');
  return ['v' + rec.version, bits, 'd' + rec.day.toString(36), 'x' + rec.expires.toString(36), rec.id].join('.');
}

function decodeConsent(raw) {
  const m = /^v(\d+)\.([01]+)\.d([0-9a-z]+)\.x([0-9a-z]+)\.([\w-]+)$/.exec(raw || '');
  if (!m) return null;
  const granted = {};
  CATEGORIES.forEach((c, i) => { granted[c.id] = m[2][i] === '1'; });
  return { version: Number(m[1]), granted, day: parseInt(m[3], 36), expires: parseInt(m[4], 36), id: m[5] };
}

function consentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

class ConsentManager extends EventTarget {
  constructor(clock) {
    super();
    this.clock = clock;
    this.record = null;
    this.history = [];
  }

  load() {
    const raw = parseCookies(document.cookie)[CONSENT_COOKIE];
    const rec = decodeConsent(raw);
    if (!rec) return { status: raw ? 'corrupt' : 'missing' };
    if (rec.version < POLICY_VERSION) return { status: 'outdated', rec };
    if (rec.expires <= this.clock.day) return { status: 'expired', rec };
    this.record = rec;
    return { status: 'valid', rec };
  }

  needsBanner() {
    return this.load().status !== 'valid';
  }

  save(granted, source) {
    const prev = this.record ? Object.assign({}, this.record.granted) : null;
    const full = {};
    for (const c of CATEGORIES) full[c.id] = c.locked ? true : !!granted[c.id];
    this.record = { version: POLICY_VERSION, granted: full, day: this.clock.day, expires: this.clock.day + VALID_DAYS, id: this.record ? this.record.id : consentId() };
    const s = setCookie(CONSENT_COOKIE, encodeConsent(this.record), { maxAge: VALID_DAYS * 86400, sameSite: 'Lax', secure: true });
    this.history.push(source + '@' + this.clock.day);
    const withdrawn = prev ? CATEGORIES.filter((c) => prev[c.id] && !full[c.id]).map((c) => c.id) : [];
    const added = CATEGORIES.filter((c) => full[c.id] && (!prev || !prev[c.id])).map((c) => c.id);
    for (const id of withdrawn) this.purge(id);
    this.dispatchEvent(new CustomEvent('consentchange', { detail: { granted: full, withdrawn, added, source } }));
    return s;
  }

  purge(categoryId) {
    const cat = CATEGORIES.find((c) => c.id === categoryId);
    const present = parseCookies(document.cookie);
    for (const name of cat.cookies) {
      if (name in present) {
        deleteCookie(name);
        console.log('  purged cookie ' + name + ' (' + categoryId + ')');
      }
    }
  }

  allowed(categoryId) {
    return !!(this.record && this.record.granted[categoryId]);
  }
}

function renderBanner(mgr, container) {
  const banner = document.createElement('div');
  banner.id = 'cc-banner';
  banner.setAttribute('role', 'dialog');
  for (const c of CATEGORIES) {
    const row = document.createElement('label');
    const box = document.createElement('input');
    box.setAttribute('type', 'checkbox');
    box.setAttribute('data-cat', c.id);
    box.checked = c.locked || mgr.allowed(c.id);
    if (c.locked) box.setAttribute('disabled', '');
    row.append(box, ' ' + c.label);
    banner.appendChild(row);
  }
  for (const [action, text] of [['accept-all', 'Accept all'], ['reject', 'Reject optional'], ['save', 'Save choices']]) {
    const b = document.createElement('button');
    b.dataset.action = action;
    b.textContent = text;
    banner.appendChild(b);
  }
  banner.addEventListener('click', (ev) => {
    const action = ev.target.dataset && ev.target.dataset.action;
    if (!action) return;
    const boxes = banner.querySelectorAll('input[data-cat]');
    const granted = {};
    for (const box of boxes) {
      const id = box.getAttribute('data-cat');
      granted[id] = action === 'accept-all' ? true : action === 'reject' ? false : box.checked;
    }
    mgr.save(granted, action);
    banner.remove();
  });
  container.appendChild(banner);
  return banner;
}

function writeAppCookies(mgr) {
  const written = [];
  const tryWrite = (cat, name, value) => {
    if (mgr.allowed(cat)) { setCookie(name, value); written.push(name); }
  };
  tryWrite('necessary', 'session_id', 's-' + mgr.clock.day);
  tryWrite('preferences', 'ui_lang', 'de');
  tryWrite('preferences', 'ui_theme', 'dark mode');
  tryWrite('statistics', 'stats_visits', String((Number(parseCookies(document.cookie).stats_visits) || 0) + 1));
  tryWrite('marketing', 'promo_seen', 'spring;sale');
  return written;
}

function cookieNames() {
  return Object.keys(parseCookies(document.cookie)).sort().join(',');
}

function showConsent(mgr) {
  const r = mgr.record;
  return r ? CATEGORIES.map((c) => c.id.slice(0, 4) + '=' + (r.granted[c.id] ? 'Y' : 'n')).join(' ') + ' exp@' + r.expires : '(none)';
}

function main() {
  console.log('initial cookies:', JSON.stringify(document.cookie));
  console.log('parse sample:', JSON.stringify(parseCookies('a=1; b=hello%20world; bad=%E0%A4%A; empty=; noeq')));
  console.log('serialize sample:', serializeCookie('x y', 'a;b', { maxAge: 60, sameSite: 'Strict', secure: true }));

  const clock = new SimClock(1000);
  const mgr = new ConsentManager(clock);
  mgr.addEventListener('consentchange', (ev) => {
    const d = ev.detail;
    console.log('  event consentchange source=' + d.source + ' added=[' + d.added.join(',') + '] withdrawn=[' + d.withdrawn.join(',') + ']');
  });

  console.log('load:', mgr.load().status, 'banner needed:', mgr.needsBanner());
  const container = document.getElementById('app');
  let banner = renderBanner(mgr, container);
  console.log('banner checkboxes:', banner.querySelectorAll('input').length, 'disabled:', banner.querySelectorAll('input[disabled]').length);
  banner.querySelector('input[data-cat="statistics"]').checked = true;
  banner.querySelector('button[data-action="save"]').click();
  console.log('after save:', showConsent(mgr), 'banner in DOM:', !!document.getElementById('cc-banner'));
  console.log('written:', writeAppCookies(mgr).join(','), '->', cookieNames());

  clock.advance(30);
  console.log('day ' + clock.day + ' load:', mgr.load().status, 'visits cookie:', parseCookies(document.cookie).stats_visits);
  writeAppCookies(mgr);
  console.log('visits after second write:', parseCookies(document.cookie).stats_visits);

  banner = renderBanner(mgr, container);
  banner.querySelector('button[data-action="accept-all"]').click();
  console.log('after accept-all:', showConsent(mgr));
  console.log('written:', writeAppCookies(mgr).join(','));
  console.log('raw promo cookie:', parseCookies(document.cookie).promo_seen, 'theme:', parseCookies(document.cookie).ui_theme);

  clock.advance(45);
  banner = renderBanner(mgr, container);
  banner.querySelector('input[data-cat="preferences"]').checked = false;
  banner.querySelector('input[data-cat="marketing"]').checked = false;
  banner.querySelector('button[data-action="save"]').click();
  console.log('after withdrawal:', showConsent(mgr), 'cookies:', cookieNames());

  const raw = parseCookies(document.cookie)[CONSENT_COOKIE];
  console.log('consent cookie raw:', raw, 'decoded day:', decodeConsent(raw).day);

  for (const days of [100, 80]) {
    clock.advance(days);
    const st = mgr.load();
    console.log('day ' + clock.day + ' -> ' + st.status + (st.rec ? ' (expires ' + st.rec.expires + ')' : ''));
  }
  banner = renderBanner(mgr, container);
  banner.querySelector('button[data-action="reject"]').click();
  console.log('after reject:', showConsent(mgr), 'cookies:', cookieNames());

  setCookie(CONSENT_COOKIE, 'v3.1111.drs.xabc.old');
  console.log('old policy cookie ->', mgr.load().status);
  setCookie(CONSENT_COOKIE, 'garbage!!');
  console.log('garbage cookie ->', mgr.load().status);
  deleteCookie(CONSENT_COOKIE);
  console.log('deleted cookie ->', mgr.load().status);
  console.log('history:', mgr.history.join(' '));
  console.log('final cookie string:', document.cookie);
}

main();
