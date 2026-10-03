'use strict';
/**
 * Step 1: locate the VM inside the (normalized) source and assign *roles* to
 * its variables.
 *
 * Nothing in here depends on identifier names, opcode numbers or on the
 * per-build randomized slot layout of program objects. The interpreter is
 * found by its fetch-decode-execute shape:
 *
 *     while (pc < len) { try { while (pc < len) {
 *         let idx = pc << shift, op = code[opBase + idx], operand = code[operBase + idx];
 *         ... switch (op) { case N: {...} ... }
 *
 * and every other role (operand stack, stack pointer, register file, constant
 * pool, jump table, try table, scope object, `this`, `arguments`, ...) is
 * inferred from how the prologue and the opcode handlers use each variable.
 */

const parser = require('@babel/parser');
const t = require('@babel/types');
const { findGlobalName, findNamespaceName, findNamespaceKey, isGeneratorCopy, yieldOpcodes, resolveYieldTags } = require('./runtime');
const { findInterpreterLoops, parseFetch, collectHandlers } = require('./interpreter');
const { inferRoles, collectFactoryHelpers, declaredLocals, prologueStatements } = require('./roles');

function parse(code) {
  const opts = { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true, plugins: ['bigInt'] };
  // a plain script first (there `await` can be an identifier); top-level await only as a fallback
  try { return parser.parse(code, opts); } catch { return parser.parse(code, { ...opts, allowAwaitOutsideFunction: true }); }
}

function locate(code, { log = () => {} } = {}) {
  const ast = parse(code);
  const globalName = findGlobalName(ast);
  const nsName = findNamespaceName(ast, globalName);
  const nsKey = nsName ? findNamespaceKey(ast, globalName, nsName) : null;
  const loops = findInterpreterLoops(ast);
  if (!loops.length) throw new Error('No VM interpreter loop found - not an obfuscator.io Virtualization build?');

  const interpreters = loops.map((loop) => {
    const pc = loop.outerPath.node.test.left.name;
    const fetch = parseFetch(loop.inner, pc);
    const fnPath = loop.outerPath.getFunctionParent();
    const generator = isGeneratorCopy(loop.inner, fetch);
    return { loop, fetch, fnPath, generator };
  });
  const plain = interpreters.find((i) => !i.generator) || interpreters[0];
  const genCopy = interpreters.find((i) => i.generator);

  // factory: nearest enclosing function of the interpreter that is an IIFE / holds the loaders
  let factoryPath = plain.fnPath.parentPath.getFunctionParent();
  while (factoryPath && !(t.isCallExpression(factoryPath.parent) || factoryPath.parentPath.isProgram())) {
    const up = factoryPath.parentPath.getFunctionParent();
    if (!up) break;
    factoryPath = up;
  }
  if (!factoryPath) throw new Error('Could not find the VM factory function');

  const handlers = collectHandlers(plain.fnPath, plain.fetch);
  const roles = inferRoles(plain.fnPath, plain.loop, plain.fetch, handlers, globalName);
  roles.global = globalName;
  roles.ns = nsName;
  const helpers = collectFactoryHelpers(factoryPath);

  let yields = { await: null, yield: null, yieldStar: null };
  if (genCopy) {
    const ys = yieldOpcodes(genCopy.loop.inner, genCopy.fetch, factoryPath);
    const tagKey = ys.find((y) => y.tagKey)?.tagKey;
    const tagRoles = resolveYieldTags(factoryPath, tagKey);
    for (const y of ys) {
      if (y.tag === tagRoles.await) yields.await = y.opcode;
      else if (y.tag === tagRoles.yield) yields.yield = y.opcode;
      else if (y.tag === tagRoles.yieldStar) yields.yieldStar = y.opcode;
    }
  }

  log(`interpreter found: ${interpreters.length} copies, ${handlers.length} handler bodies, factory=${factoryPath.node.id?.name || '(iife)'}`);
  return { ast, code, globalName, nsName, nsKey, factoryPath, plain, genCopy, handlers, roles, helpers, yields };
}

module.exports = { locate, parse, declaredLocals, prologueStatements };
