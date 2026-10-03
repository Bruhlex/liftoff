'use strict';
/**
 * Step 3: extract every compiled program from the file.
 *
 * The byte format of a program (varint layout, type tags, flag bits, base64
 * alphabet, per-program string XOR key, hashed slot layout ...) is randomized
 * per build, so instead of re-implementing the decoder we *run the VM's own
 * decoder* inside a Node `vm` sandbox:
 *
 *  1. keep only the top-level statements up to and including the VM factory
 *     (so no host code executes), and inject an export object into the
 *     factory scope that exposes the program loaders and two small evaluator
 *     functions synthesized from the interpreter's own source;
 *  2. `__prologue(...)` is the interpreter's prologue (everything before the
 *     fetch loop) with `return { ...locals }` appended: it resolves the
 *     bytecode array, its layout, constant pool, jump/try tables, flags and
 *     scope size for a given program object exactly as the VM would;
 *  3. `__makeClosure(...)` additionally runs the MAKE_CLOSURE handler body on a
 *     nested program so the resulting function object can be inspected for its
 *     kind (arrow / async / generator / method / strict).
 */

const t = require('@babel/types');
const { createSandbox, buildInstrumentedSource } = require('./sandbox');

// ---------------------------------------------------------------------------
// Program extraction
// ---------------------------------------------------------------------------

function serializeConst(v, progIds) {
  if (v === null) return { t: 'null' };
  if (v === undefined) return { t: 'undefined' };
  const ty = typeof v;
  if (ty === 'number' || ty === 'string' || ty === 'boolean') return { t: ty, v };
  if (ty === 'bigint') return { t: 'bigint', v: v.toString() };
  if (ty === 'symbol') return { t: 'symbol', v: v.description };
  if (v instanceof RegExp || Object.prototype.toString.call(v) === '[object RegExp]') return { t: 'regexp', source: v.source, flags: v.flags };
  if (progIds.has(v)) return { t: 'program', id: progIds.get(v) };
  return { t: 'unknown', v: String(v) };
}

function isProgramObject(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v)) return false;
  for (const k of Object.keys(v)) {
    const e = v[k];
    if (e && typeof e === 'object' && e.constructor && e.constructor.name === 'Int32Array') return true;
  }
  return false;
}

/** identifiers, property keys and strings of the VM factory (cached) */
function runtimeNames(vm) {
  if (vm.__runtimeNames) return vm.__runtimeNames;
  const names = new Set();
  t.traverseFast(vm.factoryPath.node, (n) => {
    if (t.isIdentifier(n)) names.add(n.name);
    else if (t.isStringLiteral(n)) names.add(n.value);
  });
  vm.__runtimeNames = names;
  return names;
}

function functionKind(fn) {
  if (typeof fn !== 'function') return { kind: 'function' };
  const src = Function.prototype.toString.call(fn);
  const ctor = Object.getPrototypeOf(fn) && Object.getPrototypeOf(fn).constructor && Object.getPrototypeOf(fn).constructor.name;
  const isArrow = /^(async\s*)?\(?[^)]*\)?\s*=>/.test(src.replace(/^\w+\s*:\s*/, '')) || /=>\s*\{/.test(src.slice(0, 120));
  const isMethod = !isArrow && !/^(async\s*)?function\b/.test(src.trim());
  return {
    kind: isArrow ? 'arrow' : isMethod ? 'method' : 'function',
    async: ctor === 'AsyncFunction' || ctor === 'AsyncGeneratorFunction',
    generator: ctor === 'GeneratorFunction' || ctor === 'AsyncGeneratorFunction',
    strict: /['"]use strict['"]/.test(src),
    length: fn.length,
    name: typeof fn.name === 'string' ? fn.name : null,
  };
}

/** Create the closure for a nested program with the VM's own MAKE_CLOSURE handler. */
function makeClosureViaStep(X, table, holderProg, nestedObj) {
  const entry = [...table.entries()].find(([, e]) => e.mnemonic === 'MAKE_CLOSURE');
  if (!entry) return null;
  const NORET = {};
  const r = X.step(...X.stepArgs(holderProg, { codeSize: 64, pc: 3, op: entry[0], operand: 0, stack: [nestedObj], sp: 1, NORET }));
  if (r.threw !== NORET) throw r.threw;
  return r.stack[r.sp - 1];
}

function extractPrograms(vm, table, { log = () => {}, sandbox = null } = {}) {
  const { X, built } = sandbox || createSandbox(vm);
  const { roles } = vm;

  // enumerate programs from both loaders
  const programs = []; // {id, obj, source: 'main'|'nested'|'const', index}
  const progIds = new Map();
  const addProgram = (obj, source, index) => {
    if (!obj || progIds.has(obj)) return progIds.get(obj);
    const id = programs.length;
    progIds.set(obj, id);
    programs.push({ id, obj, source, index });
    return id;
  };
  const enumerate = (loader, source) => {
    if (!loader) return;
    for (let i = 0; i < 100000; i++) {
      let p;
      try { p = loader(i); } catch { break; }
      if (!p) break;
      addProgram(p, source, i);
    }
  };
  enumerate(X.mainLoader, 'main');
  enumerate(X.nestedLoader, 'nested');

  const paramIdx = (role) => roles.params.indexOf(roles[role]);
  const callArgs = (prog, args, callee) => {
    const a = new Array(roles.params.length).fill(undefined);
    a[paramIdx('prog')] = prog;
    a[paramIdx('args')] = args;
    if (paramIdx('parentScope') >= 0) a[paramIdx('parentScope')] = null;
    a[paramIdx('callee')] = callee;
    return a;
  };

  const results = [];
  for (let i = 0; i < programs.length; i++) {
    const { id, obj, source, index } = programs[i];
    const sentinels = Array.from({ length: 256 }, () => ({ __sentinel: true }));
    const callee = function __callee() {};
    let st;
    try {
      st = X.prologue(...callArgs(obj, sentinels, callee));
    } catch (e) {
      log(`program ${id}: prologue failed: ${e.message}`);
      continue;
    }
    const code = st[roles.code];
    const len = st[roles.len];
    const fetch = vm.plain.fetch;
    const evalExpr = (txt) => (/^\d+$/.test(txt) ? Number(txt) : st[txt]);
    const opBase = evalExpr(fetch.opBase), operBase = evalExpr(fetch.operBase), shift = evalExpr(fetch.shift);
    const instrs = [];
    for (let pc = 0; pc < len; pc++) {
      const idx = pc << shift;
      instrs.push([code[opBase + idx], code[operBase + idx]]);
    }
    const regs = st[roles.regs] || [];
    let paramCount = 0;
    while (paramCount < regs.length && regs[paramCount] && regs[paramCount].__sentinel) paramCount++;
    const scope = st[roles.scope];
    const scopeSlots = scope && scope[roles.scopeProps.slots] ? scope[roles.scopeProps.slots].length : 0;
    // constants (register nested program objects found in the pool)
    const rawConsts = st[roles.consts] || [];
    for (let k = 0; k < rawConsts.length; k++) if (isProgramObject(rawConsts[k])) addProgram(rawConsts[k], 'const', k);
    const jumpsRaw = st[roles.jumps] || {};
    const triesRaw = st[roles.tries] || {};
    const jumps = {};
    for (const k of Object.keys(jumpsRaw)) jumps[k] = jumpsRaw[k];
    const tries = {};
    for (const k of Object.keys(triesRaw)) {
      const v = triesRaw[k];
      if (Array.isArray(v)) tries[k] = v.map((x) => (x >= 0 ? x : null));
    }
    results.push({
      id, source, index,
      name: callee.name && callee.name !== '__callee' ? callee.name : null,
      paramCount, localCount: regs.length - paramCount, scopeSlots,
      strict: !!st[roles.strict], derived: !!st[roles.derived], arrowFlag: !!st[roles.arrowFlag],
      instrs, rawConsts, jumps, tries, obj,
    });
  }
  // constants are serialized after all programs are known (nested program objects get ids)
  for (const r of results) {
    r.consts = Array.from(r.rawConsts, (v) => serializeConst(v, progIds));
    delete r.rawConsts;
  }
  // function kinds via the VM's own closure builder
  for (const r of results) {
    r.fnKind = { kind: 'function', async: false, generator: false, strict: r.strict };
    if (r.source !== 'main') {
      try {
        const fn = makeClosureViaStep(X, table, programs[0].obj, r.obj);
        r.fnKind = functionKind(fn);
        // an unnamed program's closure shows the name of the builder's own wrapper function
        // (`{ 'vjRMKk'() {...} }['vjRMKk']`); such names occur in the VM runtime's source text
        if (r.fnKind.name && runtimeNames(vm).has(r.fnKind.name)) r.fnKind.name = null;
      } catch (e) {
        log(`program ${r.id}: makeClosure probe failed: ${e.message}`);
      }
    }
  }
  const nestedIndexToId = {};
  for (const p of programs) if (p.source === 'nested') nestedIndexToId[p.index] = p.id;
  const mainIndexToId = {};
  for (const p of programs) if (p.source === 'main') mainIndexToId[p.index] = p.id;
  log(`${results.length} programs extracted (${Object.keys(mainIndexToId).length} main, ${Object.keys(nestedIndexToId).length} nested, ${results.filter((r) => r.source === 'const').length} embedded)`);
  for (const r of results) delete r.obj;
  return { programs: results, nestedIndexToId, mainIndexToId, entryName: built.entryName, entryProgramParam: built.entryProgramParam, entryFn: built.entryFn };
}

module.exports = { extractPrograms, buildInstrumentedSource, createSandbox };
