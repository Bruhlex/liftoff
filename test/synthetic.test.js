#!/usr/bin/env node
'use strict';
/**
 * Synthetic lifter tests: hand-written programs in mnemonic form are lifted,
 * printed, executed, and compared against the expected result. This exercises
 * control-flow shapes that the sample files do not contain.
 *
 *   node test/synthetic.test.js
 */
const assert = require('assert');
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { Lifter } = require('../src/lift');

// --- a tiny assembler -------------------------------------------------------
const MNEMONICS = ['NOP', 'PUSH_CONST', 'PUSH_UNDEF', 'PUSH_NULL', 'PUSH_OBJ', 'PUSH_ARR', 'PUSH_THIS', 'DUP', 'DROP', 'SWAP', 'ROT_BOTTOM_UP', 'ROT_TOP_DOWN',
  'LOAD_REG', 'STORE_REG', 'LOAD_ARG', 'STORE_ARG', 'REG_INC', 'REG_DEC', 'LOAD_GLOBAL', 'STORE_GLOBAL', 'GETPROP_NAMED', 'GETPROP_NAMED_KEEP', 'GETPROP_COMPUTED',
  'SETPROP_NAMED', 'SETPROP_COMPUTED', 'DEFINE_PROP_NAMED', 'DEFINE_PROTO_METHOD_NAMED', 'DEFINE_METHOD_NAMED', 'DEFINE_GETTER_NAMED', 'ARR_PUSH', 'CALL', 'CALL_METHOD', 'NEW',
  'RETURN', 'THROW', 'JMP', 'JMPF', 'JMPT', 'JMPF_KEEP', 'JMPT_KEEP', 'JMP_NOT_NULLISH', 'TRY_ENTER', 'TRY_POP', 'FINALLY_ENTER', 'FINALLY_END', 'MAKE_CLOSURE', 'MAKE_CLASS', 'CLASS_EXTENDS',
  'PUSH_SUPER_CTOR', 'SUPER_CALL', 'PUSH_SCOPE', 'ENTER_SCOPE', 'EXIT_SCOPE', 'DECLARE_TDZ', 'STORE_LOCAL', 'STORE_LOCAL_CONST', 'LOAD_SCOPE', 'STORE_SCOPE', 'UNARY_NOT', 'BINOP_ADD', 'BINOP_SUB', 'BINOP_MUL', 'BINOP_LT', 'BINOP_EQ', 'BINOP_SEQ', 'TO_STRING', 'INC_VALUE', 'TO_NUMERIC', 'YIELD', 'AWAIT', 'GET_ITERATOR', 'FOR_OF_NEXT', 'PUSH_ARGUMENTS', 'SPREAD_MARK', 'DEFINE_GETTER_COMPUTED', 'DEFINE_SETTER_NAMED'];
const table = new Map();
MNEMONICS.forEach((m, i) => {
  let e = { mnemonic: m };
  if (m.startsWith('BINOP_')) e = { mnemonic: 'BINOP', op: { ADD: '+', SUB: '-', MUL: '*', LT: '<', EQ: '==', SEQ: '===' }[m.slice(6)] };
  if (m === 'UNARY_NOT') e = { mnemonic: 'UNARY', op: '!' };
  if (m === 'DEFINE_GETTER_NAMED' || m === 'DEFINE_GETTER_COMPUTED' || m === 'DEFINE_SETTER_NAMED') e = { mnemonic: m, protoTarget: true };
  table.set(i, e);
});
const OP = Object.fromEntries(MNEMONICS.map((m, i) => [m, i]));

function assemble(lines, consts, opts = {}) {
  // lines: ["MNEM operand", "MNEM", "label:", "JMPF @label"]
  const labels = {};
  const instrs = [];
  const jumps = {};
  const pending = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith(':')) { labels[line.slice(0, -1)] = instrs.length; continue; }
    const [m, ...args] = line.split(/\s+/);
    if (!(m in OP)) throw new Error('unknown mnemonic ' + m);
    let operand = -1;
    for (const arg of args) {
      if (arg.startsWith('@')) pending.push([instrs.length, arg.slice(1)]);
      else operand = Number(arg);
    }
    instrs.push([OP[m], operand]);
  }
  for (const [pc, lab] of pending) { if (!(lab in labels)) throw new Error('unknown label ' + lab); jumps[pc] = labels[lab]; }
  const tries = {};
  for (const [pc, [c, f, e]] of Object.entries(opts.tries || {})) tries[labels[pc] ?? pc] = [c && labels[c], f && labels[f], e && labels[e]].map((x) => (x === undefined || x === null ? null : x));
  return {
    id: opts.id || 0, source: 'main', index: 0, name: opts.name || null,
    paramCount: opts.params || 0, localCount: opts.locals || 0, scopeSlots: opts.scopeSlots || 0,
    strict: false, derived: !!opts.derived, arrowFlag: false, instrs, jumps, tries,
    consts: consts.map((c) => (c === null ? { t: 'null' } : c === undefined ? { t: 'undefined' } : typeof c === 'object' ? c : { t: typeof c, v: c })),
    fnKind: opts.fnKind || { kind: 'function', async: false, generator: false, strict: false },
  };
}

function lift(programs, mainId = 0) {
  const byId = new Map(programs.map((p) => [p.id, p]));
  const nested = {};
  for (const p of programs) if (p.id !== mainId) nested[p.id] = p.id;
  const warnings = [];
  const lifter = new Lifter({ table, programsById: byId, nestedIndexToId: nested, log: () => {}, warn: (m) => warnings.push(m) });
  const main = byId.get(mainId);
  const lifted = lifter.liftProgram(main, {});
  const fn = lifter.buildFunction(main, lifted, { noStrict: true });
  const code = generate(t.program([t.expressionStatement(fn)])).code;
  return { code, fn, warnings };
}

function run(code, args = []) {
  const f = eval('(' + code.replace(/;\s*$/, '') + ')');
  const r = f(...args);
  if (r && typeof r.next === 'function' && typeof r[Symbol.iterator] === 'function') return Array.from(r);
  return r;
}

let failures = 0;
function check(name, programs, expected, args = [], mainId = 0) {
  const { code, warnings } = lift(programs, mainId);
  let result, error = null;
  try { result = run(code, args); } catch (e) { error = e; }
  const ok = !error && JSON.stringify(result) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) {
    failures++;
    console.log(code);
    if (error) console.log('  error:', error.message);
    else console.log('  got:', JSON.stringify(result), 'expected:', JSON.stringify(expected));
    if (warnings.length) console.log('  warnings:', warnings.join('; '));
  } else if (process.env.SHOW) console.log(code);
}

// --- tests --------------------------------------------------------------------

// do { i++ } while (i < n); return i
check('do-while', [assemble([
  'PUSH_CONST 0', 'STORE_REG 1',
  'top:', 'REG_INC 1', 'LOAD_REG 1', 'LOAD_ARG 0', 'BINOP_LT', 'JMPT @top',
  'LOAD_REG 1', 'RETURN',
], [0], { params: 1, locals: 1 })], 5, [5]);

// while (true) { if (i === 3) break; i++; if (i === 1) continue; s += i } return s
check('break-continue', [assemble([
  'PUSH_CONST 0', 'STORE_REG 1', 'PUSH_CONST 0', 'STORE_REG 2',
  'loop:',
  'LOAD_REG 1', 'PUSH_CONST 1', 'BINOP_SEQ', 'JMPF @c1', 'JMP @exit', 'c1:',
  'REG_INC 1',
  'LOAD_REG 1', 'PUSH_CONST 2', 'BINOP_SEQ', 'JMPF @c2', 'JMP @loop', 'c2:',
  'LOAD_REG 2', 'LOAD_REG 1', 'BINOP_ADD', 'STORE_REG 2',
  'JMP @loop',
  'exit:', 'LOAD_REG 2', 'RETURN',
], [0, 3, 1], { locals: 2 })], 5);

// try { throw x } catch (e) { return e + 1 }
check('try-catch-param', [assemble([
  'TRY_ENTER',
  'LOAD_ARG 0', 'THROW',
  'TRY_POP', 'JMP @end',
  'catch:', 'STORE_REG 1', 'LOAD_REG 1', 'PUSH_CONST 0', 'BINOP_ADD', 'RETURN',
  'end:', 'PUSH_UNDEF', 'RETURN',
], [1], { params: 1, locals: 1, tries: { 0: ['catch', null, 'end'] } })], 42, [41]);

// a && b, a || b via KEEP jumps, a ?? b
check('short-circuit', [assemble([
  'PUSH_ARR',
  'LOAD_ARG 0', 'JMPF_KEEP @and', 'LOAD_ARG 1', 'and:', 'ARR_PUSH',
  'LOAD_ARG 0', 'JMPT_KEEP @or', 'LOAD_ARG 1', 'or:', 'ARR_PUSH',
  'LOAD_ARG 2', 'DUP', 'JMP_NOT_NULLISH @nn', 'DROP', 'LOAD_ARG 1', 'nn:', 'ARR_PUSH',
  'RETURN',
], [], { params: 3 })], [0, 7, 7], [0, 7, null]);

// ternary inside a call argument: f(a ? 1 : 2)
check('ternary-arg', [assemble([
  'LOAD_ARG 0', 'JMPF @else', 'PUSH_CONST 0', 'JMP @join', 'else:', 'PUSH_CONST 1', 'join:',
  'LOAD_ARG 1', 'PUSH_CONST 0', 'CALL',
  'RETURN',
], [1, 2], { params: 2 })], 4, [false, (x) => x * 2]);

// switch inside a loop with break out of switch and accumulation
check('switch-in-loop', [assemble([
  'PUSH_CONST 0', 'STORE_REG 1', 'PUSH_CONST 0', 'STORE_REG 2',
  'loop:', 'LOAD_REG 1', 'PUSH_CONST 3', 'BINOP_LT', 'JMPF @exit',
  'LOAD_REG 1', 'PUSH_CONST 0', 'BINOP_SEQ', 'JMPT @case0',
  'LOAD_REG 1', 'PUSH_CONST 1', 'BINOP_SEQ', 'JMPT @case1',
  'JMP @default',
  'case0:', 'LOAD_REG 2', 'PUSH_CONST 4', 'BINOP_ADD', 'STORE_REG 2', 'JMP @swend',
  'case1:', 'LOAD_REG 2', 'PUSH_CONST 5', 'BINOP_ADD', 'STORE_REG 2', 'JMP @swend',
  'default:', 'LOAD_REG 2', 'PUSH_CONST 6', 'BINOP_ADD', 'STORE_REG 2',
  'swend:', 'REG_INC 1', 'JMP @loop',
  'exit:', 'LOAD_REG 2', 'RETURN',
], [0, 1, 2, 3, 10, 20, 100], { locals: 2 })], 130);

// class with constructor, method, getter, extends + super
const ctor = assemble(['PUSH_THIS', 'LOAD_ARG 0', 'SETPROP_NAMED 0', 'DROP', 'PUSH_UNDEF', 'RETURN'], ['x'], { id: 1, params: 1 });
const meth = assemble(['PUSH_THIS', 'GETPROP_NAMED 0', 'PUSH_CONST 1', 'BINOP_MUL', 'RETURN'], ['x', 2], { id: 2, fnKind: { kind: 'method' } });
const getter = assemble(['PUSH_THIS', 'GETPROP_NAMED 0', 'RETURN'], ['x'], { id: 3, fnKind: { kind: 'method' } });
check('class', [assemble([
  'PUSH_CONST 0', 'MAKE_CLOSURE', 'PUSH_CONST 1', 'MAKE_CLASS 0',
  'PUSH_CONST 2', 'MAKE_CLOSURE', 'DEFINE_PROTO_METHOD_NAMED 3',
  'PUSH_CONST 4', 'MAKE_CLOSURE', 'DEFINE_GETTER_NAMED 5',
  'STORE_REG 0',
  'LOAD_REG 0', 'PUSH_CONST 6', 'PUSH_CONST 7', 'NEW',
  'DUP', 'GETPROP_NAMED 3', 'PUSH_CONST 8', 'CALL_METHOD',
  'RETURN',
], [{ t: 'program', id: 1 }, 'Point', { t: 'program', id: 2 }, 'double', { t: 'program', id: 3 }, 'val', 21, 1, 0], { locals: 1 }), ctor, meth, getter], 42);

// closure capturing a block-scoped variable through a scope slot
const inner = assemble(['PUSH_SCOPE', 'ENTER_SCOPE 0', 'LOAD_SCOPE 131072', 'INC_VALUE', 'DUP', 'STORE_SCOPE 131072', 'RETURN'], [], { id: 1, fnKind: { kind: 'arrow' } });
check('closure-scope', [assemble([
  'PUSH_SCOPE', 'ENTER_SCOPE 1', 'DECLARE_TDZ 65536', 'PUSH_CONST 1', 'STORE_LOCAL 0',
  'PUSH_CONST 2', 'MAKE_CLOSURE', 'STORE_REG 0',
  'LOAD_REG 0', 'PUSH_CONST 3', 'CALL', 'DROP',
  'LOAD_REG 0', 'PUSH_CONST 3', 'CALL',
  'RETURN', 'EXIT_SCOPE',
], ['count', 5, { t: 'program', id: 1 }, 0], { locals: 1 }), inner], 7);

// for..of with break; and template literal
check('for-of-break', [assemble([
  'PUSH_CONST 0', 'STORE_REG 1',
  'LOAD_ARG 0', 'GET_ITERATOR', 'STORE_REG 2',
  'loop:', 'FOR_OF_NEXT 2 @exit', 'STORE_REG 3',
  'LOAD_REG 3', 'PUSH_CONST 1', 'BINOP_EQ', 'JMPF @cont', 'JMP @exit', 'cont:',
  'LOAD_REG 1', 'LOAD_REG 3', 'BINOP_ADD', 'STORE_REG 1',
  'JMP @loop',
  'exit:', 'PUSH_CONST 2', 'LOAD_REG 1', 'TO_STRING', 'BINOP_ADD', 'RETURN',
], [0, 3, 'sum='], { params: 1, locals: 3 })], 'sum=3', [[1, 2, 3, 4]]);

// generator: function* () { yield 1; yield 2 }
check('generator', [assemble([
  'PUSH_CONST 0', 'YIELD', 'DROP', 'PUSH_CONST 1', 'YIELD', 'DROP', 'PUSH_UNDEF', 'RETURN',
], [1, 2], { fnKind: { kind: 'function', generator: true } })], [1, 2], []);

process.exit(failures ? 1 : 0);
