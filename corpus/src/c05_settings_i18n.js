// Settings panel: resolves the theme from a stored choice or matchMedia('(prefers-color-scheme:
// dark)'), picks the UI language from navigator.language/languages with fallback negotiation,
// formats messages from i18n tables with hand-written CLDR-style plural rules and interpolation,
// and persists preferences in localStorage with a schema version and migration.
'use strict';

const PREFS_KEY = 'app.prefs';
const PREFS_VERSION = 3;

const PLURAL_RULES = {
  en: (n) => (n === 1 ? 'one' : 'other'),
  de: (n) => (n === 1 ? 'one' : 'other'),
  fr: (n) => (n === 0 || n === 1 ? 'one' : 'other'),
  pl: (n) => {
    if (n === 1) return 'one';
    const m10 = n % 10, m100 = n % 100;
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'few';
    return 'many';
  },
  ru: (n) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'one';
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'few';
    return 'many';
  },
  ja: () => 'other',
};

const MESSAGES = {
  en: {
    title: 'Settings',
    theme: 'Theme: {theme}',
    'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System ({resolved})',
    unread: { one: 'You have {n} unread message', other: 'You have {n} unread messages' },
    files: { one: '{n} file selected', other: '{n} files selected' },
    greeting: 'Hello, {user}!',
  },
  de: {
    title: 'Einstellungen',
    theme: 'Design: {theme}',
    'theme.light': 'Hell', 'theme.dark': 'Dunkel', 'theme.system': 'System ({resolved})',
    unread: { one: 'Sie haben {n} ungelesene Nachricht', other: 'Sie haben {n} ungelesene Nachrichten' },
    files: { one: '{n} Datei ausgewählt', other: '{n} Dateien ausgewählt' },
    greeting: 'Hallo, {user}!',
  },
  fr: {
    title: 'Paramètres',
    unread: { one: 'Vous avez {n} message non lu', other: 'Vous avez {n} messages non lus' },
    greeting: 'Bonjour, {user} !',
  },
  pl: {
    title: 'Ustawienia',
    unread: { one: 'Masz {n} nieprzeczytaną wiadomość', few: 'Masz {n} nieprzeczytane wiadomości', many: 'Masz {n} nieprzeczytanych wiadomości' },
    files: { one: 'Wybrano {n} plik', few: 'Wybrano {n} pliki', many: 'Wybrano {n} plików' },
  },
  ru: {
    title: 'Настройки',
    files: { one: 'Выбран {n} файл', few: 'Выбрано {n} файла', many: 'Выбрано {n} файлов' },
  },
};

const SUPPORTED = Object.keys(MESSAGES);

function baseLang(tag) {
  return String(tag).toLowerCase().split(/[-_]/)[0];
}

function negotiateLanguage(requested, supported, fallback) {
  const trail = [];
  for (const tag of requested) {
    const lower = tag.toLowerCase();
    trail.push(lower);
    if (supported.includes(lower)) return { lang: lower, trail };
    const base = baseLang(lower);
    if (supported.includes(base)) return { lang: base, trail };
  }
  return { lang: fallback, trail };
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

class Translator {
  constructor(lang) {
    this.setLanguage(lang);
    this.misses = [];
  }

  setLanguage(lang) {
    this.lang = SUPPORTED.includes(lang) ? lang : 'en';
    this.chain = this.lang === 'en' ? ['en'] : [this.lang, 'en'];
    this.plural = PLURAL_RULES[this.lang] || PLURAL_RULES.en;
  }

  lookup(key) {
    for (const l of this.chain) {
      const entry = MESSAGES[l][key];
      if (entry !== undefined) return { entry, from: l };
    }
    return null;
  }

  t(key, vars) {
    vars = vars || {};
    const hit = this.lookup(key);
    if (!hit) {
      this.misses.push(key);
      return '⟦' + key + '⟧';
    }
    let entry = hit.entry;
    if (typeof entry === 'object') {
      const rule = hit.from === this.lang ? this.plural : PLURAL_RULES[hit.from];
      const cat = rule(vars.n);
      entry = entry[cat] !== undefined ? entry[cat] : entry.other || entry.many;
    }
    return interpolate(entry, vars) + (hit.from !== this.lang ? ' [' + hit.from + ']' : '');
  }
}

function defaultPrefs() {
  return { version: PREFS_VERSION, theme: 'system', lang: null, fontScale: 1, reduceMotion: false };
}

function migrate(raw) {
  const steps = [];
  let p = raw;
  if (!p.version) { p = { version: 1, theme: p.dark ? 'dark' : 'light', lang: p.locale || null }; steps.push('0->1'); }
  if (p.version === 1) { p = Object.assign({}, p, { version: 2, fontScale: 1 }); steps.push('1->2'); }
  if (p.version === 2) { p = Object.assign({}, p, { version: 3, reduceMotion: false }); steps.push('2->3'); }
  return { prefs: p, steps };
}

class PreferenceStore {
  constructor(storage) {
    this.storage = storage;
    this.writes = 0;
  }

  read() {
    const text = this.storage.getItem(PREFS_KEY);
    if (!text) return { prefs: defaultPrefs(), steps: ['default'] };
    return migrate(JSON.parse(text));
  }

  write(prefs) {
    this.writes++;
    this.storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }
}

class ThemeController {
  constructor() {
    this.query = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = this.query.matches;
    this.changes = 0;
    this.query.addEventListener('change', (ev) => {
      this.changes++;
      this.systemDark = ev.matches;
      console.log('  media change -> systemDark=' + this.systemDark);
    });
  }

  resolve(choice) {
    if (choice === 'dark' || choice === 'light') return choice;
    return this.systemDark ? 'dark' : 'light';
  }

  apply(choice) {
    const resolved = this.resolve(choice);
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.classList.toggle('theme-dark', resolved === 'dark');
    root.style.setProperty('--bg', resolved === 'dark' ? '#121212' : '#ffffff');
    root.style.setProperty('--fg', resolved === 'dark' ? '#eeeeee' : '#111111');
    return resolved;
  }
}

function renderPanel(tr, prefs, theme) {
  const panel = document.createElement('section');
  panel.className = 'settings';
  const h = document.createElement('h2');
  h.textContent = tr.t('title');
  panel.appendChild(h);
  const resolved = theme.resolve(prefs.theme);
  const themeLabel = prefs.theme === 'system' ? tr.t('theme.system', { resolved: tr.t('theme.' + resolved) }) : tr.t('theme.' + prefs.theme);
  const rows = [tr.t('theme', { theme: themeLabel }), tr.t('greeting', { user: 'Alex' }), tr.t('unread', { n: 3 })];
  for (const r of rows) {
    const p = document.createElement('p');
    p.textContent = r;
    panel.appendChild(p);
  }
  return panel;
}

function showPlurals(lang, key, counts) {
  const tr = new Translator(lang);
  return counts.map((n) => tr.t(key, { n })).join(' | ');
}

function main() {
  localStorage.clear();
  console.log('navigator.language:', navigator.language, 'languages:', navigator.languages.join(','));
  const neg = negotiateLanguage(navigator.languages, SUPPORTED, 'en');
  console.log('negotiated:', neg.lang, 'trail:', neg.trail.join('>'));
  for (const req of [['de-AT', 'en'], ['pt-BR', 'es'], ['zh-Hant-TW', 'RU'], ['fr_CA']]) {
    const r = negotiateLanguage(req, SUPPORTED, 'en');
    console.log('  request ' + req.join(',') + ' -> ' + r.lang);
  }

  const theme = new ThemeController();
  console.log('media query:', theme.query.media, 'matches:', theme.query.matches);
  console.log('reduced motion:', window.matchMedia('(prefers-reduced-motion: reduce)').matches, 'light:', window.matchMedia('(prefers-color-scheme: light)').matches);

  const store = new PreferenceStore(localStorage);
  let { prefs, steps } = store.read();
  prefs.lang = prefs.lang || neg.lang;
  console.log('prefs loaded via', steps.join(','), JSON.stringify(prefs));

  const tr = new Translator(prefs.lang);
  console.log('applied theme:', theme.apply(prefs.theme), 'css:', document.documentElement.style.cssText);
  let panel = renderPanel(tr, prefs, theme);
  document.body.appendChild(panel);
  for (const p of panel.querySelectorAll('h2, p')) console.log('  | ' + p.textContent);

  const fakeChange = new Event('change');
  Object.defineProperty(fakeChange, 'matches', { value: true });
  theme.query.dispatchEvent(fakeChange);
  console.log('applied theme after OS switch:', theme.apply(prefs.theme), 'class:', document.documentElement.className);

  prefs.theme = 'light';
  prefs.lang = 'de';
  store.write(prefs);
  tr.setLanguage(prefs.lang);
  theme.apply(prefs.theme);
  panel.remove();
  panel = renderPanel(tr, prefs, theme);
  document.body.appendChild(panel);
  for (const p of panel.querySelectorAll('h2, p')) console.log('  | ' + p.textContent);

  console.log('-- plural tables');
  const counts = [0, 1, 2, 5, 12, 21, 22, 25, 101, 111];
  console.log('en files:', showPlurals('en', 'files', counts.slice(0, 4)));
  console.log('fr unread:', showPlurals('fr', 'unread', [0, 1, 2]));
  console.log('pl files:', showPlurals('pl', 'files', [1, 2, 5, 12, 22, 25]));
  console.log('ru files:', showPlurals('ru', 'files', [1, 2, 5, 11, 21, 22, 111]));
  for (const lang of ['pl', 'ru']) {
    const cats = counts.map((n) => n + ':' + PLURAL_RULES[lang](n));
    console.log('  ' + lang + ' categories ' + cats.join(' '));
  }
  const ruTr = new Translator('ru');
  console.log('ru fallback:', ruTr.t('unread', { n: 2 }), '/', ruTr.t('greeting', { user: 'Иван' }));
  console.log('missing:', ruTr.t('nope.key'), 'misses:', ruTr.misses.join(','));
  console.log('interpolate leftovers:', interpolate('{a}-{b}-{c}', { a: 1, c: 3 }));

  console.log('-- migrations');
  const legacy = [{ dark: true, locale: 'pl' }, { version: 1, theme: 'light', lang: 'fr' }, { version: 2, theme: 'system', lang: null, fontScale: 1.25 }];
  for (const raw of legacy) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(raw));
    const r = store.read();
    console.log('  ' + JSON.stringify(raw) + ' => [' + r.steps.join(',') + '] ' + JSON.stringify(r.prefs));
  }
  store.write(prefs);
  console.log('stored:', localStorage.getItem(PREFS_KEY), 'writes:', store.writes, 'media changes:', theme.changes);
}

main();
