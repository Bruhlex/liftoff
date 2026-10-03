'use strict';
/**
 * Behavioural opcode inference.
 *
 * For an opcode whose handler text matches no known shape, the handler is
 * executed through the VM's own dispatch (the synthesized `step` function, see
 * extract.js) under many controlled machine states, and its effect is
 * reconstructed from observation alone. Three probe families exist:
 *
 *  1. data probe - stack, registers, arguments, constants and the scope chain
 *     are replaced by index-logging proxies filled with chosen values (random
 *     numbers, numeric strings, equal values, 0, null, undefined, ...).
 *     Everything the handler leaves on the stack or writes to a register /
 *     argument / scope slot is explained as a small expression over the values
 *     it read (copy, unary op, binary op, literal, fresh {} / []). The read
 *     index is related to the operand (whole operand, low 16 or high 16 bits).
 *     Conditional jumps are explained by a predicate over the read values.
 *  2. call probe - operand values are callable/constructible proxies; the
 *     single apply/construct trap reveals callee, `this`, arguments and where
 *     the argument count came from.
 *  3. closure probe - a real program object is pushed; a handler that pops it
 *     and pushes a function is the closure constructor.
 *
 * Any effect that cannot be observed and explained (property access on an
 * operand, other interpreter state changing, a thrown error, ...) rejects the
 * inference; the opcode then stays unknown instead of being guessed.
 */

const { makeFingerprinter, SP0 } = require('./observe');
const { inferData, inferCall, inferClosure } = require('./infer');

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

function inferUnknown(X, vm, opcodes) {
  const prog = X.firstProgram();
  const out = new Map();
  if (!prog) return out;
  const { roles } = vm;
  const f = vm.plain.fetch;
  const ignore = new Set([roles.stack, roles.sp, roles.pc, roles.code, roles.len, roles.regs, roles.args, roles.consts, roles.jumps, f.opBase, f.operBase, f.shift, roles.this, roles.lexThis, roles.newTarget].filter(Boolean));
  const ctx = { scopeProps: roles.scopeProps, fingerprint: makeFingerprinter(ignore) };
  const swallow = () => {};
  process.on('unhandledRejection', swallow);
  try {
    for (const op of opcodes) {
      let e = null;
      for (const probe of [inferData, inferCall, inferClosure]) {
        try { e = probe(X, prog, op, ctx); } catch { e = null; }
        if (e) break;
      }
      if (e) out.set(op, { ...e, inferred: true });
    }
  } finally {
    setTimeout(() => process.removeListener('unhandledRejection', swallow), 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

function exprToString(e) {
  if (!e) return '?';
  switch (e.k) {
    case 'leaf': return e.key.replace(/^S:(\d+)$/, 'pop$1').replace(/^([RAK]):(\w+)$/, (m, a, fl) => `${a}[${fl}]`).replace(/^C(\w+):(\w+)$/, (m, d, s) => `scope(${d})[${s}]`).replace(/^OPV:(\w+)$/, '$1');
    case 'lit': return String(e.v);
    case 'un': return `${e.op}(${exprToString(e.a)})`;
    case 'bin': return `(${exprToString(e.a)} ${e.op} ${exprToString(e.b)})`;
    case 'fresh': return e.kind === 'arr' ? '[]' : '{}';
    default: return '?';
  }
}

function describeEntry(e) {
  if (e.mnemonic === 'TEMPLATE') return `pop ${e.pops}; push [${e.pushes.map(exprToString).join(', ')}]${e.writes.length ? '; ' + e.writes.map((w) => `${w.target} = ${exprToString(w.expr)}`).join('; ') : ''}`;
  if (e.mnemonic === 'COND_TEMPLATE') return `jump if ${exprToString(e.cond)}`;
  return e.mnemonic + (e.op ? ` ${e.op}` : '');
}

module.exports = { inferUnknown, describeEntry, exprToString, SP0 };
