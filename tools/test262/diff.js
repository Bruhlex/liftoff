// node diff.js <bundle.js> [--quiet]: decompile camp/out/<b>, run source / build / decompiled
// with preload.js and compare per test (only tests the build itself gets right count).
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const W = __dirname, C = path.join(W, 'camp'), PRE = path.join(W, 'preload.js');
const [name, flag] = process.argv.slice(2);
const run = (f) => spawnSync('node', ['--require', PRE, f], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300000 });
const L = (s) => new Map((s || '').split('\n').filter((l) => /^(PASS|FAIL) /.test(l)).map((l) => [l.slice(5).split(':')[0], l]));
const obf = path.join(C, 'out', name), dec = path.join(C, 'dec', name);
if (fs.existsSync(dec)) fs.unlinkSync(dec);
const t0 = Date.now();
const d = spawnSync('node', ['--max-old-space-size=8000', '--stack-size=4000', path.join(__dirname, '../../index.js'), obf, '-o', dec], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3600000 });
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const warns = (d.stderr || '').split('\n').filter((l) => /warning/.test(l));
if (d.status !== 0 || !fs.existsSync(dec)) { console.log(`${name}: DECOMPILER ERROR (${secs}s) ${(d.stderr || '').split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' | ').slice(0, 300)}`); process.exit(1); }
const a = run(path.join(C, 'src', name)), b = run(obf), c = run(dec);
const A = L(a.stdout), B = L(b.stdout), D = L(c.stdout);
let diffs = 0, buildWrong = 0, closer = 0; const bad = [];
for (const [k, v] of A) {
  if (B.get(k) !== v) { buildWrong++; if (D.get(k) === v) closer++; continue; }
  if (D.get(k) !== v) { diffs++; bad.push(`${k} | ${(D.get(k) || '(missing)').slice(k.length + 6, k.length + 130)}`); }
}
const head = fs.readFileSync(dec, 'utf8').split('\n').slice(0, 4).join(' ');
const rec = (head.match(/recovered (all|about [\d.]+ %(?: of)?) [\d,]* ?VM instructions/) || [''])[0];
console.log(`${name}: ${A.size} tests, build wrong ${buildWrong} (decompiled = source on ${closer}), ${diffs} diffs among ${A.size - buildWrong}; dec exit ${c.status}${c.status ? ' ' + (c.stderr || '').split('\n').filter((l) => /Error/.test(l)).slice(0, 1).join('').slice(0, 160) : ''}; ${rec}; ${warns.length} warnings; ${secs}s`);
fs.mkdirSync(path.join(C, 'diffs'), { recursive: true }); fs.writeFileSync(path.join(C, 'diffs', name + '.txt'), bad.join('\n'));
if (flag !== '--quiet') { for (const x of bad.slice(0, 40)) console.log('   ' + x); for (const w of warns.slice(0, 8)) console.log('   W ' + w.slice(0, 200)); }
