#!/usr/bin/env node
'use strict';
/**
 * Corpus run: decompile every obfuscated file in a directory (default ../../in/corpus),
 * run original and decompiled output under Node and compare stdout + exit status.
 * Also collects decompiler diagnostics (warnings, behaviourally inferred opcodes,
 * programs left as VM calls) so regressions in quality - not only in correctness -
 * are visible.
 *
 *   node test/corpus.js [dir|file ...] [-j N] [--out DIR] [--json report.json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const here = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let jobs = Math.max(2, Math.min(8, os.cpus().length - 2)), outDir = null, jsonOut = null;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-j') jobs = +args[++i];
  else if (args[i] === '--out') outDir = args[++i];
  else if (args[i] === '--json') jsonOut = args[++i];
  else inputs.push(args[i]);
}
if (!inputs.length) inputs.push(path.resolve(here, 'corpus', 'builds'));
const files = [];
for (const p of inputs) {
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) { if (f.endsWith('.js')) files.push(path.join(p, f)); }
  else files.push(p);
}
const tmp = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vmcorpus-'));
fs.mkdirSync(tmp, { recursive: true });

function run(cmd, argv, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code, sig) => { clearTimeout(timer); resolve({ code: sig ? sig : code, out, err, ms: Date.now() - t0 }); });
  });
}

const divFile = path.resolve(here, 'corpus', 'expected-divergence.json');
const divergence = fs.existsSync(divFile) ? JSON.parse(fs.readFileSync(divFile, 'utf8')) : {};
// programs using browser APIs (c01_*, ...) run with the corpus' deterministic browser shim
const shim = path.resolve(here, 'corpus', 'env', 'browser-shim.js');
const nodeGlobals = path.resolve(here, 'corpus', 'env', 'node-globals.js');
const nodeArgs = (orig, f) => (/(^|_)[ce]\d\d_/.test(path.basename(orig)) ? ['-r', shim, f] : /(^|_)n\d\d_/.test(path.basename(orig)) ? ['-r', nodeGlobals, f] : [f]);

async function one(file) {
  const name = path.basename(file, '.js');
  const dec = path.join(tmp, name + '.dec.js');
  const r = { name, ok: false };
  const d = await run('node', [path.join(here, 'index.js'), file, '-o', dec], 600000);
  r.decMs = d.ms;
  const m = (re) => { const x = d.err.match(re); return x ? +x[1] : null; };
  r.opcodes = m(/opcode table: (\d+) opcodes/);
  r.inferred = m(/behavioural inference: (\d+) of/);
  r.warnings = (d.err.match(/warning:/g) || []).length;
  r.programs = m(/(\d+) programs extracted/);
  r.unrefd = m(/(\d+) unreferenced program/);
  if (d.code !== 0) { r.error = (d.err.split('\n').filter((l) => /error/i.test(l))[0] || d.err.slice(-300)).slice(0, 300); return r; }
  const [a, b] = await Promise.all([run('node', nodeArgs(file, file), 60000), run('node', nodeArgs(file, dec), 60000)]);
  r.match = a.out === b.out && a.code === b.code;
  r.lines = a.out.split('\n').length - 1;
  const src = fs.readFileSync(dec, 'utf8');
  r.decBytes = src.length;
  r.vmLeft = (src.match(/\bvm[A-Za-z]*_[0-9a-f]{6}\b/g) || []).length; // leftover VM runtime references
  // where the obfuscated build itself deviates from its source (VM quirks such as names of
  // anonymous classes), a decompiled program that behaves like the *source* is the better result
  // documented per-line divergences (corpus/expected-divergence.json, keyed by source program)
  if (!r.match) {
    const sm0 = /^v8_[a-z0-9]+_(.+)$/.exec(path.basename(file));
    const div = sm0 && divergence[sm0[1]];
    if (div) {
      const al = a.out.split('\n'), bl = b.out.split('\n');
      if (al.length === bl.length && a.code === b.code && al.every((l, i) => l === bl[i] || div[String(i + 1)])) { r.match = true; r.documented = true; }
    }
  }
  if (!r.match) {
    const sm = /^v8_[a-z0-9]+_(.+)$/.exec(path.basename(file));
    const srcFile = sm && path.resolve(here, 'corpus', 'src', sm[1]);
    if (srcFile && fs.existsSync(srcFile)) {
      const s = await run('node', nodeArgs(file, srcFile), 60000);
      // line by line: every line equals the obfuscated build's or the source's
      const al = a.out.split('\n'), bl = b.out.split('\n'), sl = s.out.split('\n');
      const lineOk = al.length === bl.length && sl.length === bl.length && bl.every((l, i) => l === al[i] || l === sl[i]);
      if (lineOk && (b.code === a.code || b.code === s.code) && s.out !== a.out) { r.match = true; r.matchedSource = true; }
      // the obfuscated build dies (e.g. stack overflow: VM calls need far more native stack) after
      // printing a prefix of the source's output; the decompiled program completes like the source
      // (the crashed build is no reference at all then; the source is: exact equality required)
      else if ((a.code !== 0 || /Maximum call stack size exceeded/.test(a.out)) && s.code === 0 && b.out === s.out && b.code === s.code) { r.match = true; r.matchedSource = true; r.obfCrashed = true; }
    }
  }
  r.ok = r.match && !r.warnings;
  if (!r.match) {
    const al = a.out.split('\n'), bl = b.out.split('\n');
    let k = 0; while (k < al.length && al[k] === bl[k]) k++;
    r.diff = `line ${k + 1}: expected ${JSON.stringify((al[k] || '').slice(0, 100))} got ${JSON.stringify((bl[k] || '').slice(0, 100))}` +
      (a.code !== b.code ? ` exit ${a.code}/${b.code} ${b.err.split('\n').find((l) => /Error/.test(l)) || ''}` : '');
  }
  return r;
}

(async () => {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < files.length) {
      const f = files[next++];
      const r = await one(f);
      results.push(r);
      const flag = r.error ? 'ERROR' : r.ok ? (r.matchedSource ? 'PASS*' : r.documented ? 'PASS~' : 'PASS ') : r.match ? 'WARN ' : 'FAIL ';
      console.log(`${flag} ${r.name.padEnd(32)} ops=${r.opcodes} inf=${r.inferred ?? 0} warn=${r.warnings} progs=${r.programs} vmLeft=${r.vmLeft ?? '-'} ${(r.decMs / 1000).toFixed(1)}s` +
        (r.error ? `\n      ${r.error}` : '') + (r.diff ? `\n      ${r.diff}` : ''));
    }
  }));
  results.sort((x, y) => x.name.localeCompare(y.name));
  const pass = results.filter((r) => r.ok).length, match = results.filter((r) => r.match).length;
  console.log(`(PASS* = obfuscated build deviates from its source, each differing line equals the source's; PASS~ = documented divergence)`);
  console.log(`\n${pass}/${results.length} clean pass, ${match}/${results.length} stdout match, ${results.filter((r) => r.error).length} decompiler errors; outputs in ${tmp}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  process.exit(match === results.length ? 0 : 1);
})();
