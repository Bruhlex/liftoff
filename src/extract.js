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
const nodeVm = require('vm');
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { prologueStatements, containsNode } = require('./locate');

const gen = (node) => generate(node, { compact: false, comments: false }).code;

// ---------------------------------------------------------------------------
// Synthesize helper functions from the interpreter source
// ---------------------------------------------------------------------------

function topLevelLocals(stmts) {
  const names = [];
  for (const st of stmts) {
    if (t.isVariableDeclaration(st)) for (const d of st.declarations) if (t.isIdentifier(d.id)) names.push(d.id.name);
  }
  return names;
}

function buildPrologueFunction(vm) {
  const fn = vm.plain.fnPath.node;
  const prologue = prologueStatements(fn, vm.plain.loop.outerPath.node);
  const locals = topLevelLocals(prologue);
  const params = vm.roles.params;
  const ret = t.returnStatement(
    t.objectExpression([...new Set([...locals, ...params])].map((n) => t.objectProperty(t.identifier(n), t.identifier(n)))),
  );
  return t.functionExpression(null, params.map((p) => t.identifier(p)), t.blockStatement([...prologue.map((s) => t.cloneNode(s, true)), ret]));
}

/**
 * Synthesize a single-step function from the interpreter itself:
 * prologue (resolves the program exactly like the VM) + overrides for the state
 * the caller wants to control + ONE iteration of the real fetch/dispatch body.
 * Because the real dispatch code runs, it does not matter how the build routes
 * opcodes (plain switch, `switch (MAP[op])`, range-bucketed dispatch functions).
 */
function buildStepFunction(vm) {
  const { parse } = require('./locate');
  const fn = vm.plain.fnPath.node;
  const prologue = prologueStatements(fn, vm.plain.loop.outerPath.node);
  const { roles } = vm;
  const fetch = vm.plain.fetch;
  const locals = [...new Set([...topLevelLocals(prologue), ...roles.params])];
  const isId = (x) => /^[A-Za-z_$][\w$]*$/.test(x);
  const body = generate(vm.plain.loop.inner.body, { comments: false }).code;
  const lines = [];
  lines.push(`(function (${roles.params.join(', ')}, __P) {`);
  lines.push(prologue.map((s) => generate(s, { comments: false }).code).join('\n'));
  const outer = [roles.ns, roles.global].filter(Boolean).map((n, i) => `__outer${i}: ${n}`);
  lines.push(`const __snap = () => ({ ${[...locals.map((n) => `${n}: ${n}`), ...outer].join(', ')} });`);
  if (isId(fetch.opBase)) lines.push(`${fetch.opBase} = 0;`);
  if (isId(fetch.operBase)) lines.push(`${fetch.operBase} = 1;`);
  if (isId(fetch.shift)) lines.push(`${fetch.shift} = 1;`);
  lines.push(`${roles.code} = new Int32Array(__P.codeSize); ${roles.len} = __P.pc + 1; ${roles.pc} = __P.pc;`);
  lines.push(`${roles.code}[(${fetch.opBase}) + (${roles.pc} << (${fetch.shift}))] = __P.op;`);
  lines.push(`${roles.code}[(${fetch.operBase}) + (${roles.pc} << (${fetch.shift}))] = __P.operand;`);
  lines.push(`if (__P.stack) { ${roles.stack} = __P.stack; ${roles.sp} = __P.sp; }`);
  if (roles.scope) lines.push(`if (__P.scope) ${roles.scope} = __P.scope;`);
  if (roles.this) lines.push(`if (__P.thisValue !== undefined) ${roles.this} = __P.thisValue;`);
  if (roles.lexThis) lines.push(`if (__P.thisValue !== undefined) ${roles.lexThis} = __P.thisValue;`);
  if (roles.newTarget) lines.push(`if (__P.newTarget !== undefined) ${roles.newTarget} = __P.newTarget;`);
  for (const [key, role] of [['regs', 'regs'], ['consts', 'consts'], ['jumps', 'jumps'], ['args', 'args']]) {
    if (roles[role]) lines.push(`if (__P.${key}) ${roles[role]} = __P.${key};`);
  }
  lines.push(`const __before = __P.fp ? __P.fp(__snap()) : __snap();`);
  lines.push(`let __ret = __P.NORET, __threw = __P.NORET;`);
  lines.push(`try { __ret = (() => { for (let __i = 0; __i < 1; __i++) ${body} return __P.NORET; })(); } catch (__e) { __threw = __e; }`);
  lines.push(`return { before: __before, after: __P.fp ? __P.fp(__snap()) : __snap(), ret: __ret, threw: __threw, sp: ${roles.sp}, pc: ${roles.pc}, stack: ${roles.stack} };`);
  lines.push(`})`);
  const src = lines.join('\n');
  const ast = parse(src);
  return ast.program.body[0].expression;
}

/** Find `let X = FN(ARR); ARR = null;` loader pairs in the factory body. */
function findLoaders(vm) {
  const body = vm.factoryPath.node.body.body;
  const loaders = [];
  for (let i = 0; i < body.length; i++) {
    const st = body[i];
    if (!t.isVariableDeclaration(st) || st.declarations.length !== 1) continue;
    const d = st.declarations[0];
    if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init) || !t.isIdentifier(d.init.callee) || d.init.arguments.length < 1 || !t.isIdentifier(d.init.arguments[0])) continue;
    const next = body[i + 1];
    if (t.isExpressionStatement(next) && t.isAssignmentExpression(next.expression) && t.isIdentifier(next.expression.left, { name: d.init.arguments[0].name }) && t.isNullLiteral(next.expression.right)) {
      loaders.push({ name: d.id.name, table: d.init.arguments[0].name, factory: d.init.callee.name });
    }
  }
  return loaders;
}

/** The function returned by the factory (the VM entry point) */
function findEntryName(vm) {
  const body = vm.factoryPath.node.body.body;
  const ret = body[body.length - 1];
  if (t.isReturnStatement(ret) && t.isIdentifier(ret.argument)) return ret.argument.name;
  return null;
}

/** Which loader does the entry function use? -> main loader; the other one holds nested functions. */
function splitLoaders(vm, loaders, entryName) {
  const body = vm.factoryPath.node.body.body;
  let entryFn = null;
  for (const st of body) {
    if (t.isFunctionDeclaration(st) && st.id && st.id.name === entryName) entryFn = st;
    if (t.isVariableDeclaration(st)) for (const d of st.declarations) if (t.isIdentifier(d.id, { name: entryName }) && t.isFunction(d.init)) entryFn = d.init;
  }
  let main = null;
  if (entryFn) {
    for (const l of loaders) if (containsNode(entryFn.body, (n) => t.isCallExpression(n) && t.isIdentifier(n.callee, { name: l.name }))) main = l;
  }
  if (!main) main = loaders[0];
  const nested = loaders.find((l) => l !== main) || null;
  return { main, nested, entryFn };
}

/** Program-index argument of the entry function: the parameter passed to the main loader. */
function entryProgramParamIndex(entryFn, mainLoaderName) {
  if (!entryFn) return null;
  let idx = null;
  t.traverseFast(entryFn.body, (n) => {
    if (idx === null && t.isCallExpression(n) && t.isIdentifier(n.callee, { name: mainLoaderName }) && t.isIdentifier(n.arguments[0])) {
      idx = entryFn.params.findIndex((p) => t.isIdentifier(p, { name: n.arguments[0].name }));
    }
  });
  return idx;
}

// ---------------------------------------------------------------------------
// Build and run the instrumented copy
// ---------------------------------------------------------------------------

function buildInstrumentedSource(vm, table) {
  const program = vm.ast.program;
  // top-level statement containing the factory
  let top = vm.factoryPath;
  while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
  const idx = program.body.indexOf(top.node);
  if (idx < 0) throw new Error('factory statement not found at top level');
  const kept = program.body.slice(0, idx + 1).map((s) => t.cloneNode(s, true));
  // function declarations later in the file are hoisted, so statements before the factory
  // may already call them (e.g. the string-array rotation IIFE and its array function);
  // declaring them runs no host code
  for (const s of program.body.slice(idx + 1)) if (t.isFunctionDeclaration(s)) kept.push(t.cloneNode(s, true));

  const loaders = findLoaders(vm);
  if (!loaders.length) throw new Error('program loaders not found in VM factory');
  const entryName = findEntryName(vm);
  const { main, nested, entryFn } = splitLoaders(vm, loaders, entryName);

  const exportObj = t.objectExpression([
    t.objectProperty(t.identifier('mainLoader'), t.identifier(main.name)),
    t.objectProperty(t.identifier('nestedLoader'), nested ? t.identifier(nested.name) : t.nullLiteral()),
    t.objectProperty(t.identifier('prologue'), buildPrologueFunction(vm)),
    t.objectProperty(t.identifier('step'), buildStepFunction(vm)),
  ]);
  const inject = t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('globalThis'), t.identifier('__VMX')), exportObj));

  // Insert into the *cloned* factory body before its final return.
  // Locate the cloned factory: same path indices as the original.
  const clonedTop = kept[idx];
  let clonedFactory = null;
  const origFactory = vm.factoryPath.node;
  // walk both trees in lockstep
  const walk = (a, b) => {
    if (clonedFactory || !a || typeof a.type !== 'string') return;
    if (a === origFactory) { clonedFactory = b; return; }
    for (const k of t.VISITOR_KEYS[a.type] || []) {
      const va = a[k], vb = b[k];
      if (Array.isArray(va)) va.forEach((c, i) => walk(c, vb[i]));
      else if (va && typeof va.type === 'string') walk(va, vb);
    }
  };
  walk(top.node, clonedTop);
  if (!clonedFactory) throw new Error('could not mirror factory into instrumented copy');
  const fb = clonedFactory.body.body;
  const retIdx = fb.findIndex((s) => t.isReturnStatement(s));
  fb.splice(retIdx < 0 ? fb.length : retIdx, 0, inject);

  const src = gen(t.program(kept));
  return { src, entryName, entryFn, mainLoader: main, nestedLoader: nested, entryProgramParam: entryProgramParamIndex(entryFn, main.name) };
}

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

/** Run the instrumented VM copy in a fresh sandbox; returns { X, built } */
function createSandbox(vm) {
  const built = buildInstrumentedSource(vm);
  const sandbox = {
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    // builds for Node read e.g. `process.env.NODE_DEBUG` into their constant pool; an inert
    // stand-in (the real process object is never exposed to the build's code)
    process: { env: {}, argv: [], platform: 'linux', version: 'v20.0.0', versions: {}, nextTick() {}, cwd: () => '/' },
  };
  const ctx = nodeVm.createContext(sandbox);
  nodeVm.runInContext(built.src, ctx, { timeout: 10000, filename: 'vm-instrumented.js' });
  const X = ctx.__VMX;
  if (!X) throw new Error('instrumented VM did not export its loaders');
  X.stepArgs = (prog, P) => {
    const a = new Array(vm.roles.params.length).fill(undefined);
    a[vm.roles.params.indexOf(vm.roles.prog)] = prog;
    a[vm.roles.params.indexOf(vm.roles.args)] = [];
    const ci = vm.roles.params.indexOf(vm.roles.callee);
    if (ci >= 0) a[ci] = function __callee() {};
    return [...a, P];
  };
  X.firstProgram = () => { try { return X.mainLoader(0); } catch { return null; } };
  return { X, built };
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
