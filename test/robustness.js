#!/usr/bin/env node
'use strict';
/**
 * Robustness evaluation (leave-one-out + mutation).
 *
 * For every sample S:
 *   1. build a signature database from all OTHER samples (S is "unseen");
 *   2. for mutation level 0..3 (0 = unmodified), rewrite S's opcode handlers
 *      (see mutate.js), decompile, run original and decompiled program and
 *      compare their output.
 * Prints a table: how many opcodes the text rules / normal-form signatures
 * recognized, how many the behavioural inference recovered, how many stayed
 * unknown, and whether the decompiled program behaves like the original.
 *
 *   node test/robustness.js [--levels 0,1,2,3] [sample.js ...]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = path.resolve(__dirname, '..');
const samplesDir = path.resolve(here, 'samples');
const args = process.argv.slice(2);
const li = args.indexOf('--levels');
const levels = li >= 0 ? args[li + 1].split(',').map(Number) : [0, 1, 2, 3];
const allSamples = fs.readdirSync(samplesDir).filter((f) => /^(out|test\d+|fib)\.js$/.test(f)).map((f) => path.join(samplesDir, f));
const targets = args.filter((a, i) => !a.startsWith('--') && (li < 0 || i !== li + 1));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vmdec-rob-'));
const node = (argv, env = {}) => spawnSync('node', argv, { encoding: 'utf8', timeout: 900000, env: { ...process.env, ...env } });

const rows = [];
for (const target of targets.length ? targets : allSamples) {
  const name = path.basename(target, '.js');
  const db = path.join(work, `loo_${name}.json`);
  node([path.join(here, 'tools/build-signatures.js'), '-o', db, ...allSamples.filter((f) => path.resolve(f) !== path.resolve(target))]);
  const expected = node([target]).stdout;
  for (const level of levels) {
    let input = target;
    if (level > 0) {
      input = path.join(work, `${name}.mut${level}.js`);
      const m = node([path.join(here, 'test/mutate-only.js'), target, String(level), input]);
      if (m.status !== 0) { rows.push({ name, level, note: 'mutation failed' }); continue; }
      if (node([input]).stdout !== expected) { rows.push({ name, level, note: 'mutation changed behaviour' }); continue; }
    }
    const out = path.join(work, `${name}.l${level}.dec.js`);
    const d = node([path.join(here, 'index.js'), input, '-o', out], { VMDEC_SIGNATURES: db });
    const log = d.stderr;
    const num = (re) => { const m = log.match(re); return m ? Number(m[1]) : 0; };
    const total = num(/opcode table: (\d+) opcodes/);
    const shape = num(/, (\d+) classified by handler shape/);
    const infRec = num(/behavioural inference: (\d+) of/);
    const infOf = num(/behavioural inference: \d+ of (\d+)/);
    const ok = d.status === 0 && node([out]).stdout === expected;
    rows.push({ name, level, total, shape, inferred: infRec, unknown: infOf - infRec, result: d.status !== 0 ? 'decompiler error' : ok ? 'MATCH' : 'differs' });
    process.stderr.write(`${name} level ${level}: ${rows[rows.length - 1].result}\n`);
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('sample', 8)} ${pad('lvl', 4)} ${pad('opcodes', 8)} ${pad('shape', 6)} ${pad('inferred', 9)} ${pad('unknown', 8)} result`);
for (const r of rows) {
  if (r.note) { console.log(`${pad(r.name, 8)} ${pad(r.level, 4)} ${r.note}`); continue; }
  console.log(`${pad(r.name, 8)} ${pad(r.level, 4)} ${pad(r.total, 8)} ${pad(r.shape, 6)} ${pad(r.inferred, 9)} ${pad(r.unknown, 8)} ${r.result}`);
}
const ok = rows.filter((r) => r.result === 'MATCH').length;
console.log(`\n${ok}/${rows.length} runs produce a program that behaves like the original`);
