'use strict';
/** Human-readable disassembly of extracted programs (debugging aid). */

const fmtConst = (c) => {
  if (!c) return '?';
  switch (c.t) {
    case 'string': return JSON.stringify(c.v);
    case 'program': return `<program ${c.id}>`;
    case 'regexp': return `/${c.source}/${c.flags}`;
    case 'bigint': return c.v + 'n';
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    default: return String(c.v);
  }
};

const NAMED = new Set(['PUSH_CONST', 'GETPROP_NAMED', 'GETPROP_NAMED_KEEP', 'SETPROP_NAMED', 'DEFINE_PROP_NAMED', 'DEFINE_METHOD_NAMED', 'DEFINE_PROTO_METHOD_NAMED', 'DEFINE_GETTER_NAMED', 'DEFINE_SETTER_NAMED', 'LOAD_GLOBAL', 'STORE_GLOBAL', 'STORE_GLOBAL_DECL', 'TYPEOF_GLOBAL', 'DELETE_GLOBAL', 'GET_THIS_PROP', 'CALL_METHOD_IMM', 'SYMBOL_FOR', 'OPT_GETPROP_NAMED', 'DESTRUCTURE_CHECK']);
const FUSED = new Set(['FUSED_BINOP', 'GETPROP_REG_CONST', 'FUSED_JMPT', 'FUSED_JMPF', 'CALL_METHOD_REG_CONST']);

function disassemble(ex, table) {
  const lines = [];
  for (const p of ex.programs) {
    lines.push(`\n===== program ${p.id} (${p.source}#${p.index}) name=${p.name} params=${p.paramCount} locals=${p.localCount} scopeSlots=${p.scopeSlots} strict=${p.strict} kind=${JSON.stringify(p.fnKind)}`);
    lines.push(`consts: ${p.consts.map((c, i) => `${i}:${fmtConst(c)}`).join('  ')}`);
    if (Object.keys(p.tries).length) lines.push(`tries: ${JSON.stringify(p.tries)}`);
    p.instrs.forEach(([op, operand], pc) => {
      const e = table.get(op) || { mnemonic: `??${op}` };
      const m = e.mnemonic;
      let extra = '';
      if (NAMED.has(m)) extra = fmtConst(p.consts[operand]);
      else if (FUSED.has(m)) extra = `r${operand & 0xffff} ${e.op || ''} ${fmtConst(p.consts[operand >>> 16])}`;
      else if (m === 'NEW_REGEXP') extra = `${fmtConst(p.consts[operand & 0xffff])} ${fmtConst(p.consts[operand >>> 16])}`;
      else if (m === 'LOAD_SCOPE' || m === 'STORE_SCOPE') extra = `slot=${operand & 0xffff} depth=${operand >>> 16}`;
      else if (m === 'DECLARE_TDZ') extra = `slot=${operand & 0xffff} name=${operand >>> 16 ? fmtConst(p.consts[(operand >>> 16) - 1]) : '-'}`;
      else if (m === 'BINOP_MEGA') { const sel = (operand ^ e.mask) >>> 0; const l = e.ladder[sel]; extra = l ? `${l.swapped ? '(swapped) ' : ''}${l.op}` : `sel=${sel}?`; }
      else if (m === 'BINOP' || m === 'UNARY') extra = e.op;
      else if (m === 'TEMPLATE' || m === 'COND_TEMPLATE') extra = require('./probe').describeEntry(e);
      else if (m === 'CALL_IMM') extra = `argc=${fmtConst(p.consts[operand])}`;
      if (e.inferred) extra = `[inferred] ${extra}`;
      if (p.jumps[pc] !== undefined) extra += ` -> ${p.jumps[pc]}`;
      lines.push(`  ${String(pc).padStart(4)}: ${m.padEnd(26)} ${String(operand).padStart(6)}  ${extra}`);
    });
  }
  return lines.join('\n') + '\n';
}

module.exports = { disassemble, fmtConst };
