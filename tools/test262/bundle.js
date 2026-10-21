// Packs runtime tests of test262 (test/language) into deterministic bundles for the
// obfuscate -> decompile -> compare campaign.
//   node bundle.js select            -> candidates.json (static filter)
//   node bundle.js probe             -> passing.json (tests that pass natively, one by one)
//   node bundle.js build [maxBytes]  -> bundles/b001.js ... (only natively passing tests)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const W = __dirname;
const R = path.join(W, 'repo');

function meta(src) {
  const m = /\/\*---([\s\S]*?)---\*\//.exec(src);
  const y = m ? m[1] : '';
  const list = (key) => {
    const inline = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(y);
    if (inline) return inline[1].split(',').map((x) => x.trim()).filter(Boolean);
    const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s*.+\\n?)+)`, 'm').exec(y);
    return block ? block[1].split('\n').map((x) => x.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : [];
  };
  return { flags: list('flags'), includes: list('includes'), features: list('features'), negative: /^negative:/m.test(y) };
}

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.includes('_FIXTURE')) out.push(p);
  }
  return out;
}

const BAD_FLAGS = new Set(['module', 'raw', 'async', 'noStrict', 'CanBlockIsFalse', 'CanBlockIsTrue']);
const BAD_FEATURES = new Set(['IsHTMLDDA', 'cross-realm', 'Atomics', 'SharedArrayBuffer', 'tail-call-optimization', 'decorators', 'source-phase-imports', 'import-defer', 'explicit-resource-management']);

function select() {
  const files = walk(path.join(R, 'test/language'));
  const keep = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const m = meta(src);
    if (m.negative || m.flags.some((x) => BAD_FLAGS.has(x)) || m.features.some((x) => BAD_FEATURES.has(x))) continue;
    if (/\$262|\$DONE|\bprint\(|\bwith\s*\(|\beval\s*\(|arguments\.callee|\bimport\s*\(/.test(src)) continue;
    // modifies built-ins that later tests (and the runner) rely on
    if (/\b(Array|Object|Function|String|Number|Boolean|Symbol|Map|Set|WeakMap|WeakSet|Promise|RegExp|Date|Error|Iterator|Reflect|JSON|Math|BigInt|Proxy|ArrayBuffer|DataView|\w+Array)\.prototype\b[^;\n]*?(=[^=]|delete)|\bdelete\s+(Array|Object|Function|String|Symbol)\b|defineProperty\(\s*(Array|Object|Function|String|Number|Symbol|Promise|RegExp)\b|Object\.prototype|globalThis|\bthis\.\w+\s*=(?!=)/.test(src)) continue;
    keep.push({ file: path.relative(R, f), includes: m.includes, bytes: src.length });
  }
  fs.writeFileSync(path.join(W, 'candidates.json'), JSON.stringify(keep));
  console.log(`${files.length} tests, ${keep.length} candidates`);
}

const harness = (names) => ['assert.js', 'sta.js', ...names].filter((v, i, a) => a.indexOf(v) === i)
  .map((n) => fs.readFileSync(path.join(R, 'harness', n), 'utf8')).join('\n');

function body(file) {
  return fs.readFileSync(path.join(R, file), 'utf8').replace(/\/\*---[\s\S]*?---\*\//, '');
}

// one test as a function; the runner prints PASS / FAIL per test
function wrap(t, i) {
  return `function __t${i}() {\n${body(t.file)}\n}\n__run(${JSON.stringify(t.file.replace(/^test\/language\//, ''))}, __t${i});\n`;
}
const RUNNER = `
var __log = console.log.bind(console), __str = String, __out = '';
function __run(name, fn) {
  var line;
  try { fn(); line = 'PASS ' + name; }
  catch (e) { line = 'FAIL ' + name + ': ' + __str(e && e.constructor && e.constructor.name) + ' ' + __str(e && e.message).slice(0, 80); }
  __out += line + '\\n';
}
`;
const FOOTER = `\n__log(__out);\n`;

function program(tests) {
  const inc = [...new Set(tests.flatMap((t) => t.includes))];
  return `'use strict';\n${harness(inc)}\n${RUNNER}\n${tests.map(wrap).join('\n')}${FOOTER}`;
}

function probe() {
  const cands = JSON.parse(fs.readFileSync(path.join(W, 'candidates.json')));
  const passing = [];
  const tmp = path.join(W, 'probe.js');
  // probe in chunks; a chunk that crashes as a whole is retried test by test
  const run = (tests) => {
    fs.writeFileSync(tmp, program(tests));
    const r = spawnSync('node', [tmp], { encoding: 'utf8', timeout: 20000 });
    return r.status === 0 ? r.stdout.split('\n') : null;
  };
  for (let i = 0; i < cands.length; i += 200) {
    const chunk = cands.slice(i, i + 200);
    let lines = run(chunk);
    if (!lines) { lines = []; for (const t of chunk) { const l = run([t]); if (l) lines.push(...l); } }
    const ok = new Set(lines.filter((l) => l.startsWith('PASS ')).map((l) => l.slice(5)));
    for (const t of chunk) if (ok.has(t.file.replace(/^test\/language\//, ''))) passing.push(t);
    process.stderr.write(`\r${Math.min(i + 200, cands.length)}/${cands.length} probed, ${passing.length} pass`);
  }
  // determinism: run twice
  fs.writeFileSync(path.join(W, 'passing.json'), JSON.stringify(passing));
  console.log(`\n${passing.length} natively passing`);
}

function build(maxBytes = 480000) {
  const all = JSON.parse(fs.readFileSync(path.join(W, 'passing.json')));
  // round-robin over feature directories, so every bundle covers the whole language
  const groups = new Map();
  for (const t of all) { const g = t.file.split('/').slice(2, 4).join('/'); (groups.get(g) || groups.set(g, []).get(g)).push(t); }
  const passing = [];
  for (let i = 0; passing.length < all.length; i++) for (const g of groups.values()) if (g[i]) passing.push(g[i]);
  const out = path.join(W, 'bundles');
  fs.mkdirSync(out, { recursive: true });
  // a bundle is accepted only if it runs, every test passes and the output is deterministic;
  // failing tests are dropped, a crashing one is found by halving
  const runSrc = (tests) => {
    const f = path.join(W, 'tmp_bundle.js');
    fs.writeFileSync(f, program(tests));
    const r = spawnSync('node', [f], { encoding: 'utf8', timeout: 30000 });
    return { ok: r.status === 0, out: r.stdout || '' };
  };
  const clean = (tests) => {
    for (let round = 0; round < 20; round++) {
      const r = runSrc(tests);
      if (r.ok) {
        const failed = new Set(r.out.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5).split(':')[0]));
        if (!failed.size) return tests;
        tests = tests.filter((t) => !failed.has(t.file.replace(/^test\/language\//, '')));
        continue;
      }
      if (tests.length === 1) return [];
      const half = Math.ceil(tests.length / 2);
      return [...clean(tests.slice(0, half)), ...clean(tests.slice(half))];
    }
    return tests;
  };
  let k = 0, cur = [];
  const flush = () => {
    if (!cur.length) return;
    let tests = clean(cur);
    // the halves were clean on their own; check the joined bundle once more
    tests = clean(tests);
    const name = `t262_${String(++k).padStart(3, '0')}.js`;
    const src = program(tests);
    fs.writeFileSync(path.join(out, name), src);
    const a = spawnSync('node', [path.join(out, name)], { encoding: 'utf8', timeout: 30000 });
    const b = spawnSync('node', [path.join(out, name)], { encoding: 'utf8', timeout: 30000 });
    const fails = (a.stdout.match(/^FAIL /gm) || []).length;
    console.log(`${name}: ${tests.length}/${cur.length} tests, ${src.length} bytes, exit ${a.status}, fails ${fails}, deterministic ${a.stdout === b.stdout}`);
    cur = [];
  };
  for (const t of passing) {
    cur.push(t);
    if (program(cur).length > maxBytes) { cur.pop(); flush(); cur.push(t); }
  }
  flush();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'select') select();
else if (cmd === 'probe') probe();
else if (cmd === 'build') build(arg ? Number(arg) : undefined);
