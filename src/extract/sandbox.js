'use strict';
/**
 * The instrumented copy of the VM: the factory with its program loaders exported and the
 * synthesized helpers injected, run in a fresh Node `vm` context without any host code.
 */

const nodeVm = require('vm');
const t = require('@babel/types');
const { containsNode } = require('../ast');
const { buildPrologueFunction, buildStepFunction, genPretty } = require('./synthesize');

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

  const src = genPretty(t.program(kept));
  return { src, entryName, entryFn, mainLoader: main, nestedLoader: nested, entryProgramParam: entryProgramParamIndex(entryFn, main.name) };
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

module.exports = { createSandbox, buildInstrumentedSource };
