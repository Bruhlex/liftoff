'use strict';
/**
 * The decompiler pipeline without any file or process handling, shared by the CLI (index.js)
 * and the browser build (web/). Input: the obfuscated source text. Output: decompiled source.
 */
const { normalize } = require('./normalize');
const { locate } = require('./locate');
const { buildOpcodeTable } = require('./classify');
const { extractPrograms, createSandbox } = require('./extract');
const { inferUnknown, describeEntry } = require('./probe');
const { assemble } = require('./emit');
const { disassemble } = require('./disasm');

async function decompile(raw, { name = 'input.js', skipWebcrack = false, disasm = false, prettyNames = true, log = () => {}, warn: onWarn = () => {} } = {}) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); onWarn(m); };

  log(`normalizing ${name} (${raw.length} bytes) with webcrack ...`);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let t = now();
  const code = await normalize(raw, { skipWebcrack, log });
  log(`normalized in ${((now() - t) / 1000).toFixed(1)} s; looking for the VM interpreter ...`);

  let vm;
  t = now();
  try {
    vm = locate(code, { log });
  } catch (e) {
    log(`interpreter search took ${((now() - t) / 1000).toFixed(1)} s`);
    if (!/No VM interpreter loop found/.test(e.message)) throw e;
    // not a virtualized build: the webcrack pass is all there is to do
    log('no obfuscator.io VM interpreter found; returning the webcrack result');
    const header = `// ${name}: no obfuscator.io VM found. Output of webcrack only\n` +
      `// (string arrays, control-flow flattening, constants and formatting undone where webcrack recognises them).\n`;
    return { mode: 'webcrack', code: withHeader(header, code), warnings, programs: 0, opcodes: 0, stats: null };
  }
  const { table, unknown } = buildOpcodeTable(vm);
  log(`opcode table: ${table.size} opcodes, ${table.size - unknown.length} classified by handler shape`);
  const sandbox = createSandbox(vm);
  if (unknown.length) {
    const inferred = inferUnknown(sandbox.X, vm, unknown.map((u) => u.opcode));
    log(`behavioural inference: ${inferred.size} of ${unknown.length} remaining opcode(s) recovered`);
    for (const [op, e] of inferred) { table.set(op, e); log(`  opcode ${op}: ${describeEntry(e)}`); }
    for (const u of unknown) if (!inferred.has(u.opcode)) warn(`unclassified opcode ${u.opcode}: ${u.text.slice(0, 120)}`);
  }

  const ex = extractPrograms(vm, table, { log, sandbox });
  if (disasm) return { mode: 'vm', code: disassemble(ex, table), warnings, programs: ex.programs.length, opcodes: table.size, stats: null };

  const { code: out } = assemble(vm, ex, table, { log, warn, prettyNames });
  const unresolved = (out.match(/unresolved jump to \d+/g) || []).length;
  if (unresolved) warn(`${unresolved} jump(s) could not be structured; the output marks them with /* unresolved jump to N */ and is not equivalent there`);
  const unidentified = unknown.filter((u) => !table.has(u.opcode)).length;
  const stats = recoveryStats(ex, table, out, unidentified);
  log(`recovered about ${stats.recoveredPct} % of ${stats.instructions} VM instructions`);
  const header = `// Decompiled from ${name} by Liftoff (obfuscator.io VM decompiler)\n` +
    `// ${ex.programs.length} VM program(s) recovered; ${warnings.length} warning(s)\n` +
    (stats.unrecovered === 0 ? `// recovered all ${stats.instructions} VM instructions; `
      : `// recovered about ${stats.recoveredPct} % of ${stats.instructions} VM instructions; `) +
    `${stats.opcodesKnown} of ${stats.opcodes} opcodes identified\n` +
    (warnings.length ? warnings.map((w) => `//   - ${w}`).join('\n') + '\n' : '');
  return { mode: 'vm', code: withHeader(header, out), warnings, programs: ex.programs.length, opcodes: table.size, stats };
}

/** Prepend the header comment; a hashbang line (`#!/usr/bin/env node`) must stay the first line. */
function withHeader(header, code) {
  const m = /^#![^\n]*\n?/.exec(code);
  const body = m ? code.slice(m[0].length) : code;
  return (m ? m[0].replace(/\n?$/, '\n') : '') + header + body + (body.endsWith('\n') ? '' : '\n');
}

/**
 * How much of the bytecode came back as real code. An instruction counts as not recovered
 * when its opcode could not be identified, when the lifter had to emit a placeholder call
 * for it (`__UNKNOWN_12(...)`, `__SOME_OPCODE(...)`, `__binop(...)`), or when it is a jump that
 * could not be structured (`/* unresolved jump to N *\/`).
 */
function recoveryStats(ex, table, out, unidentified = 0) {
  let instructions = 0, unknown = 0;
  for (const p of ex.programs) {
    for (const [op] of p.instrs) {
      instructions++;
      const e = table.get(op);
      if (!e || /^UNKNOWN/.test(e.mnemonic)) unknown++;
    }
  }
  const placeholders = (out.match(/\b__(?:UNKNOWN_\d+|[A-Z][A-Z0-9_]*[A-Z0-9]|binop)\(|unresolved jump to \d+/g) || []).length;
  const lost = Math.min(instructions, Math.max(unknown, placeholders));
  const pct = instructions ? (100 * (instructions - lost)) / instructions : 100;
  const opcodesKnown = [...table.values()].filter((e) => !/^UNKNOWN/.test(e.mnemonic)).length;
  return {
    instructions, unrecovered: lost, placeholders,
    recoveredPct: lost === 0 ? 100 : Math.min(99.9, Math.floor(pct * 10) / 10),
    opcodes: table.size + unidentified, opcodesKnown,
  };
}

module.exports = { decompile };
