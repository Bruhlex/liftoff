#!/usr/bin/env node
'use strict';
/**
 * Liftoff - decompiler for obfuscator.io "Virtualization" (VM) protected JavaScript.
 *
 *   node index.js <input.js> [-o output.js] [--no-webcrack] [--disasm] [--quiet]
 *
 * Pipeline: webcrack normalization -> locate VM & infer roles -> classify opcode
 * handlers -> extract programs by running the VM's own loader in a sandbox ->
 * lift bytecode to an AST -> splice into the host script -> print.
 */
const fs = require('fs');
const path = require('path');
const { decompile } = require('./src/pipeline');

function usage() {
  console.error('usage: liftoff <input.js> [-o output.js] [--no-webcrack] [--disasm] [--quiet]');
  process.exit(2);
}

async function main(argv) {
  const args = argv.slice(2);
  if (!args.length) usage();
  let input = null, output = null, skipWebcrack = false, disasm = false, quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') output = args[++i];
    else if (a === '--no-webcrack') skipWebcrack = true;
    else if (a === '--disasm') disasm = true;
    else if (a === '--quiet' || a === '-q') quiet = true;
    else if (a.startsWith('-')) usage();
    else input = a;
  }
  if (!input) usage();
  const log = quiet ? () => {} : (m) => console.error(`[liftoff] ${m}`);

  const raw = fs.readFileSync(input, 'utf8');
  const res = await decompile(raw, { name: path.basename(input), skipWebcrack, disasm, log, warn: (m) => { if (!quiet) console.error(`[liftoff] warning: ${m}`); } });
  if (disasm) { process.stdout.write(res.code); return; }
  if (output) { fs.writeFileSync(output, res.code); log(`written to ${output}`); }
  else process.stdout.write(res.code);
}

main(process.argv).catch((e) => {
  console.error(`[liftoff] error: ${e.stack || e.message}`);
  process.exit(1);
});
