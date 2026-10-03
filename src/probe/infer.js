'use strict';
/**
 * The three probe families: data (stack, registers, arguments, constants, scope), call (callee,
 * `this`, arguments, argument count) and closure (a program object turned into a function), and
 * the mnemonics their explanations stand for.
 */

const { makeEnvironments, observe, OPERANDS, PC0, SP0 } = require('./observe');
const { normalize, orderLeaves, explainValues, explain } = require('./explain');

// ---------------------------------------------------------------------------
// data probe
// ---------------------------------------------------------------------------

function inferData(X, prog, opcode, ctx) {
  const envs = makeEnvironments();
  const pr = observe(X, prog, opcode, OPERANDS[0], envs[0], ctx, 'proxy');
  if (pr.error || pr.returned || pr.threw || pr.traps.length) return null;
  const samples = [];
  for (const env of envs) {
    for (const operand of OPERANDS) {
      const obs = observe(X, prog, opcode, operand, env, ctx, 'data');
      if (obs.error || obs.returned || obs.threw) return null;
      if (obs.traps.length || obs.changed.length) return null;
      samples.push(normalize(obs, operand, env));
    }
  }
  const stable = orderLeaves([...new Set(samples.flatMap((s) => Object.keys(s.leaves)))].filter((k) => samples.every((s) => k in s.leaves)));
  const pcKinds = new Set(samples.map((s) => s.pcKind));
  if (pcKinds.has('other')) return null;

  const describePath = (group) => {
    const shape = new Set(group.map((s) => `${s.pops}/${s.pushed.length}/${Object.keys(s.stores).sort().join(',')}`));
    if (shape.size !== 1) return null;
    let { pops, pushed } = group[0];
    const pushes = [];
    for (let i = 0; i < pushed.length; i++) {
      const e = explainValues(group.map((s) => ({ L: s.leaves, v: s.pushed[i] })), stable);
      if (!e) return null;
      pushes.push(e);
    }
    // values that were popped and pushed back unchanged at the bottom were not really popped
    while (pops > 0 && pushes.length && isLeaf(pushes[0], `S:${pops - 1}`)) { pops--; pushes.shift(); }
    const writes = [];
    for (const k of Object.keys(group[0].stores).sort()) {
      if (/#/.test(k)) return null; // write index not derived from the operand
      const e = explainValues(group.map((s) => ({ L: s.leaves, v: s.stores[k] })), stable);
      if (!e) return null;
      writes.push({ target: k, expr: e });
    }
    return { pops, pushes, writes };
  };

  if (pcKinds.size === 1) {
    const path = describePath(samples);
    if (!path) return null;
    if (pcKinds.has('jump')) return path.pops === 0 && !path.pushes.length && !path.writes.length ? { mnemonic: 'JMP' } : null;
    return toMnemonic({ mnemonic: 'TEMPLATE', ...path });
  }
  const cond = explain(samples.map((s) => ({ L: s.leaves, v: s.pcKind === 'jump' })), stable, { truthy: true });
  if (!cond) return null;
  const taken = describePath(samples.filter((s) => s.pcKind === 'jump'));
  const fall = describePath(samples.filter((s) => s.pcKind === 'next'));
  if (!taken || !fall) return null;
  return toCondMnemonic({ cond, taken, fall });
}

const isLeaf = (e, key) => e && e.k === 'leaf' && e.key === key;

function toMnemonic(tpl) {
  const { pops, pushes, writes } = tpl;
  if (writes.length === 0) {
    if (pops === 0 && pushes.length === 0) return { mnemonic: 'NOP' };
    if (pops === 1 && pushes.length === 0) return { mnemonic: 'DROP' };
    if (pops === 0 && pushes.length === 1 && isLeaf(pushes[0], 'S:0')) return { mnemonic: 'DUP' };
    if (pops === 1 && pushes.length === 1 && pushes[0].k === 'lit' && pushes[0].v === undefined) return { mnemonic: 'VOID' };
    if (pops === 2 && pushes.length === 2 && isLeaf(pushes[0], 'S:0') && isLeaf(pushes[1], 'S:1')) return { mnemonic: 'SWAP' };
    if (pops === 3 && pushes.length === 3 && isLeaf(pushes[0], 'S:1') && isLeaf(pushes[1], 'S:0') && isLeaf(pushes[2], 'S:2')) return { mnemonic: 'ROT_BOTTOM_UP' };
    if (pops === 3 && pushes.length === 3 && isLeaf(pushes[0], 'S:0') && isLeaf(pushes[1], 'S:2') && isLeaf(pushes[2], 'S:1')) return { mnemonic: 'ROT_TOP_DOWN' };
    if (pops === 0 && pushes.length === 1) {
      const e = pushes[0];
      if (isLeaf(e, 'K:op')) return { mnemonic: 'PUSH_CONST' };
      if (isLeaf(e, 'R:op')) return { mnemonic: 'LOAD_REG' };
      if (isLeaf(e, 'A:op')) return { mnemonic: 'LOAD_ARG' };
      if (isLeaf(e, 'Chi:lo')) return { mnemonic: 'LOAD_SCOPE' };
      if (e.k === 'lit' && e.v === undefined) return { mnemonic: 'PUSH_UNDEF' };
      if (e.k === 'lit' && e.v === null) return { mnemonic: 'PUSH_NULL' };
      if (e.k === 'fresh') return { mnemonic: e.kind === 'arr' ? 'PUSH_ARR' : 'PUSH_OBJ' };
    }
    if (pops === 2 && pushes.length === 1 && pushes[0].k === 'bin' && isLeaf(pushes[0].a, 'S:1') && isLeaf(pushes[0].b, 'S:0')) return { mnemonic: 'BINOP', op: pushes[0].op };
    if (pops === 1 && pushes.length === 1 && pushes[0].k === 'un' && isLeaf(pushes[0].a, 'S:0') && ['-', '+', '!', '~', 'typeof'].includes(pushes[0].op)) return { mnemonic: 'UNARY', op: pushes[0].op };
  }
  if (pops === 1 && pushes.length === 0 && writes.length === 1 && isLeaf(writes[0].expr, 'S:0')) {
    const w = writes[0].target;
    if (w === 'R:op') return { mnemonic: 'STORE_REG' };
    if (w === 'A:op') return { mnemonic: 'STORE_ARG' };
    if (w === 'C#0:op') return { mnemonic: 'STORE_LOCAL' };
    if (w === 'Chi:lo') return { mnemonic: 'STORE_SCOPE' };
  }
  return tpl;
}

function toCondMnemonic({ cond, taken, fall }) {
  const simple = (p, n) => p.pops === n && p.pushes.length === 0 && p.writes.length === 0;
  const top = (e) => isLeaf(e, 'S:0');
  const neg = (e) => e.k === 'un' && e.op === '!' ? e.a : null;
  if (top(cond) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMPT' };
  if (top(neg(cond)) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMPF' };
  if (top(cond) && simple(taken, 0) && simple(fall, 1)) return { mnemonic: 'JMPT_KEEP' };
  if (top(neg(cond)) && simple(taken, 0) && simple(fall, 1)) return { mnemonic: 'JMPF_KEEP' };
  if (top(cond) && simple(taken, 1) && simple(fall, 2)) return { mnemonic: 'JMPT_POP2' };
  if (top(neg(cond)) && simple(taken, 1) && simple(fall, 2)) return { mnemonic: 'JMPF_POP2' };
  if (cond.k === 'un' && cond.op === '!=null' && top(cond.a) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMP_NOT_NULLISH' };
  if (cond.k === 'un' && cond.op === '==null' && top(cond.a) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMP_NULLISH' };
  return { mnemonic: 'COND_TEMPLATE', cond, taken, fall };
}

// ---------------------------------------------------------------------------
// call probe
// ---------------------------------------------------------------------------

function inferCall(X, prog, opcode, ctx) {
  const env = makeEnvironments()[0];
  const tryVariant = (numeric, argc) => {
    const results = [];
    for (const operand of OPERANDS) {
      const obs = observe(X, prog, opcode, operand, env, ctx, 'call', { numeric, argc });
      if (obs.error || obs.returned || obs.threw || obs.changed.length) return null;
      const calls = obs.traps.filter((tr) => tr[0] === 'apply' || tr[0] === 'construct');
      const other = obs.traps.filter((tr) => tr[0] !== 'apply' && tr[0] !== 'construct');
      if (calls.length !== 1 || other.length) return null;
      if (obs.pc !== PC0 + 1) return null;
      results.push({ obs, operand, call: calls[0] });
    }
    return results;
  };
  // Map proxies back to leaf keys: re-derive from reads (same proxy objects are cached per observe)
  // argument count from the stack top
  const variants = [
    { name: 'stack', numeric: (tag, idx) => tag === 'S' && idx === SP0 - 1 },
    { name: 'const', numeric: (tag) => tag === 'K' },
  ];
  for (const v of variants) {
    for (const argc of [2, 3]) {
      const res = tryVariant(v.numeric, argc);
      if (!res) continue;
      const shapes = res.map(({ obs, call }) => callShape(obs, call));
      if (shapes.some((x) => !x)) break;
      const key = JSON.stringify(shapes[0]);
      if (!shapes.every((x) => JSON.stringify(x) === key)) break;
      const sh = shapes[0];
      if (sh.args.length !== argc) break;
      // expected layouts
      const argsBelow = (from) => sh.args.every((a, i) => a === `S:${from + argc - 1 - i}`);
      if (v.name === 'stack') {
        if (sh.kind === 'apply' && sh.callee === 'S:1' && sh.thisArg === 'undefined' && argsBelow(2) && sh.pops === argc + 2 && sh.pushedResult) return { mnemonic: 'CALL' };
        if (sh.kind === 'apply' && sh.callee === 'S:1' && sh.thisArg === `S:${2 + argc}` && argsBelow(2) && sh.pops === argc + 3 && sh.pushedResult) return { mnemonic: 'CALL_METHOD' };
        if (sh.kind === 'apply' && sh.callee === 'S:1' && sh.thisArg === 'S:2' && argsBelow(3) && sh.pops === argc + 3 && sh.pushedResult) return { mnemonic: 'CALL_METHOD' };
        if (sh.kind === 'construct' && sh.callee === `S:${1 + argc}` && argsBelow(1) && sh.pops === argc + 2 && sh.pushedResult) return { mnemonic: 'NEW' };
      } else {
        if (sh.kind === 'apply' && sh.callee === 'S:0' && sh.thisArg === 'undefined' && argsBelow(1) && sh.pops === argc + 1 && sh.pushedResult) return { mnemonic: 'CALL_IMM' };
        if (sh.kind === 'apply' && sh.callee === 'S:0' && sh.thisArg === 'S:1' && argsBelow(2) && sh.pops === argc + 2 && sh.pushedResult) return { mnemonic: 'CALL_METHOD_IMM' };
      }
      break;
    }
  }
  return null;
}

/** Identify callee / this / args of an observed call by comparing with the initial stack contents. */
function callShape(obs, call) {
  const stackKey = new Map();
  for (let i = 0; i < SP0; i++) if (!stackKey.has(obs.initialStack[i])) stackKey.set(obs.initialStack[i], `S:${SP0 - 1 - i}`);
  // obs.stack is the final stack; the initial contents are gone for popped slots.
  // Popped slots keep their old values in the backing array unless overwritten.
  const keyOf = (v) => (v === undefined ? 'undefined' : stackKey.get(v) || null);
  const kind = call[0];
  const callee = call[1] && call[1].startsWith('S/') ? `S:${SP0 - 1 - Number(call[1].slice(2))}` : null;
  const thisArg = kind === 'apply' ? keyOf(call[2]) : null;
  const args = (kind === 'apply' ? call[3] : call[2]).map(keyOf);
  if (!callee || args.some((a) => !a) || (kind === 'apply' && !thisArg)) return null;
  let low = obs.sp;
  for (const [tag, idx] of obs.reads) if (tag === 'S' && idx < low) low = idx;
  low = Math.min(low, SP0);
  const pushedResult = obs.sp === low + 1 && obs.stack[low] === obs.callResult;
  return { kind, callee, thisArg, args, pops: SP0 - low, pushedResult };
}

// ---------------------------------------------------------------------------
// closure probe
// ---------------------------------------------------------------------------

function inferClosure(X, prog, opcode, ctx) {
  const NORET = {};
  let r;
  try {
    r = X.step(...X.stepArgs(prog, { codeSize: 64, pc: PC0, op: opcode, operand: 0, stack: [prog], sp: 1, NORET }));
  } catch { return null; }
  if (r.threw !== NORET || r.ret !== NORET || r.pc !== PC0 + 1 || r.sp !== 1) return null;
  const fn = r.stack[0];
  if (typeof fn !== 'function' || fn === prog) return null;
  // a second run with a different program must give a different function
  let r2;
  try { r2 = X.step(...X.stepArgs(prog, { codeSize: 64, pc: PC0, op: opcode, operand: 0, stack: [prog], sp: 1, NORET })); } catch { return null; }
  if (r2.stack[0] === fn) return null;
  return { mnemonic: 'MAKE_CLOSURE' };
}

module.exports = { inferData, inferCall, inferClosure };
