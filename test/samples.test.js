#!/usr/bin/env node
'use strict';
/**
 * End-to-end regression test: decompile every VM-protected build in samples/
 * (out.js, test<n>.js, fib.js, http-client.js), run the original and the
 * decompiled script under Node and compare their standard output. If a source file
 * <name>.src.js exists, the decompiled script is compared with it instead of the build (for
 * builds that do not run as they are). Every output is also checked for assignments to
 * undeclared variables (a lost declaration).
 *
 *   node test/samples.test.js [file ...]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check: undeclared } = require('./undeclared');

const here = path.resolve(__dirname, '..');
const samplesDir = path.resolve(here, 'samples');
const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync(samplesDir).filter((f) => /^(out|test\d+|fib|http-client)\.js$/.test(f)).map((f) => path.join(samplesDir, f));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-'));
const divergence = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected-divergence.json'), 'utf8'));
let failures = 0;
for (const file of files) {
  const outFile = path.join(tmp, path.basename(file, '.js') + '.dec.js');
  const dec = spawnSync('node', [path.join(here, 'index.js'), file, '-q', '-o', outFile], { encoding: 'utf8', timeout: 300000 });
  if (dec.status !== 0) { failures++; console.log(`FAIL ${path.basename(file)}: decompiler exited ${dec.status}\n${dec.stderr}`); continue; }
  const run = (f) => spawnSync('node', [f], { encoding: 'utf8', timeout: 20000 });
  const src = file.replace(/\.js$/, '.src.js');
  const a = run(fs.existsSync(src) ? src : file), b = run(outFile);
  const lost = undeclared(outFile);
  if (lost.length) { failures++; console.log(`FAIL ${path.basename(file)}: undeclared assignments: ${lost.join(', ')}`); continue; }
  const div = divergence[path.basename(file)];
  const ok = div && div.mode === 'prefix'
    ? b.status === 0 && b.stdout.startsWith(a.stdout) && a.stdout.length > 0
    : a.stdout === b.stdout && a.status === b.status;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${path.basename(file)} (${b.stdout.split('\n').length - 1} output lines)${div ? ' [known divergence: original output is a prefix]' : ''}`);
  if (!ok) console.log(`--- expected ---\n${a.stdout}${a.stderr}\n--- got ---\n${b.stdout}${b.stderr}`);
}
console.log(failures ? `${failures} failure(s)` : 'all samples match');
process.exit(failures ? 1 : 0);
