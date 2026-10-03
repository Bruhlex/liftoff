'use strict';
/**
 * Step 2: give every opcode handler a *semantic* label.
 *
 * Each handler body is first canonicalized: every identifier that plays a
 * known role in the interpreter (operand stack, stack pointer, pc, constant
 * pool, ...) is renamed to a fixed token, every remaining local gets a
 * positional name (v0, v1, ...), and obfuscated property names that were
 * assigned a role (scope slots, try-frame fields, ...) are renamed too. What is
 * left is the handler's *shape*, which is the same in every obfuscator.io
 * build; only the opcode number in front of it changes. The classification
 * rules below are written against that canonical text.
 */

const { normalizeStatements } = require('../normalform');
const { canonicalize } = require('./canonical');
const { classifyHandler, RULES } = require('./rules');

/**
 * Build the opcode table for a located VM.
 * Returns { table: Map<opcode, {mnemonic, ...info, text}>, unknown: [{opcode, text}] }
 */
function buildOpcodeTable(vm) {
  const { handlers, roles, helpers, yields } = vm;
  const table = new Map();
  const unknown = [];
  const seenText = new Map();
  const signatures = loadSignatures();
  for (const h of handlers) {
    const text = canonicalize(h, roles, helpers);
    const prev = table.get(h.opcode);
    let cls = classifyHandler(text, { handler: h, roles, helpers });
    if (!cls) {
      const nf = canonicalize(h, roles, helpers, { normal: true });
      cls = classifyHandler(nf, { handler: h, roles, helpers });
      if (!cls && signatures.has(nf)) cls = { ...signatures.get(nf), viaSignature: true };
    }
    if (cls) {
      if (!prev || !prev.mnemonic || prev.unknown) table.set(h.opcode, { ...cls, text });
    } else if (!prev) {
      table.set(h.opcode, { mnemonic: `UNKNOWN_${h.opcode}`, unknown: true, text });
    }
    seenText.set(h.opcode, text);
  }
  for (const [op, e] of table) if (e.unknown) unknown.push({ opcode: op, text: e.text });
  if (yields) {
    if (yields.await !== null) table.set(yields.await, { mnemonic: 'AWAIT', text: '' });
    if (yields.yield !== null) table.set(yields.yield, { mnemonic: 'YIELD', text: '' });
    if (yields.yieldStar !== null) table.set(yields.yieldStar, { mnemonic: 'YIELD_STAR', text: '' });
  }
  return { table, unknown };
}

let signatureCache = null;

function loadSignatures() {
  if (signatureCache) return signatureCache;
  signatureCache = new Map();
  try {
    const custom = typeof process !== 'undefined' && process.env && process.env.VMDEC_SIGNATURES;
    const db = custom ? JSON.parse(require('fs').readFileSync(custom, 'utf8')) : require('./signatures.json');
    for (const [k, v] of Object.entries(db.signatures || {})) signatureCache.set(k, v);
  } catch { /* no database yet */ }
  return signatureCache;
}

module.exports = { canonicalize, classifyHandler, buildOpcodeTable, normalizeStatements, RULES };
