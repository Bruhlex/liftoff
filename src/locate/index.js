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
  attachStateAliases(handlers, roles);

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

/**
 * Resolve handler-local aliases of the interpreter state.
 *
 * Older builds reference the operand stack / stack pointer / pc / constant pool directly by
 * their role variable, so canonicalization recognizes them. Newer builds (>= 8.4) route some
 * opcodes through a secondary dispatch whose cases bind those registers to fresh locals first,
 * sometimes through a chain (`pW = Pg; pN = pW; ... pN[--pn]`). Role inference still finds the
 * roots (Pg/Pn/PF), but the handler bodies use the leaves, so every shape rule misses.
 *
 * For each handler we resolve the names it actually uses, in their own scope, back to a root
 * role by following `let x = y` / single `x = y` bindings transitively. The result is attached
 * as `handler.stateAliases` (Map<localName, roleToken>) and merged by the canonicalizer. This is
 * scope-aware, so the same name meaning something else in another handler is unaffected, and it
 * is a no-op on older builds (no such aliases exist), so their classification is unchanged.
 */
function attachStateAliases(handlers, roles) {
  const rootMap = new Map();
  const put = (name, tok) => { if (name && !rootMap.has(name)) rootMap.set(name, tok); };
  // The interpreter registers newer builds alias into handler-locals. Limited to the data-plane
  // registers (operand stack, stack pointer, pc, constant pool, register file); tokens match
  // roleMap() in classify/canonical.js so resolved aliases canonicalize like direct references.
  // Control-plane roles (scope/ns/this/...) are deliberately excluded: resolving them changed the
  // canonical form of some older-build handlers and introduced warnings there.
  put(roles.stack, 'S'); put(roles.sp, 'SP'); put(roles.pc, 'PC'); put(roles.consts, 'K'); put(roles.regs, 'R');
  if (!rootMap.size) return;

  // name (in a given scope) -> role token, following alias bindings transitively.
  // The stack is a straight chain, but sp/pc are "register" copies shuffled between the root and
  // one or more locals (pv = Pn; pn = pv; Pn = pv; plus ++/-- mutation). So a variable may be
  // assigned from several identifiers: resolve each, and accept the role only if they all agree
  // (ignoring cycles, which come back null). Any assignment of a non-identifier value (e.g. a
  // popped stack slot) makes the variable not a pure register alias, so we bail.
  const resolve = (name, scope, seen) => {
    if (rootMap.has(name)) return rootMap.get(name);
    if (seen.has(name)) return null;
    seen.add(name);
    const b = scope.getBinding(name);
    if (!b) return null;
    // A declarator initialized from a single identifier establishes the register's identity
    // (`let pO = pJ`). The pc is then mutated with non-identifier values (jumps: `pO = jumps[pO]`,
    // try-frame pc, `pO = 0`); those change the register's value, not its role, so they do not veto
    // the init. Only when there is no such identity do non-identifier assignments make it ambiguous
    // (e.g. `let x = stack[--sp]` is a popped value, never the stack itself).
    const idInit = b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.init) ? b.path.node.init.name : null;
    const plain = b.constantViolations.filter((cv) => cv.isAssignmentExpression() && cv.node.operator === '=');
    const asgNonId = plain.some((cv) => !t.isIdentifier(cv.node.right));
    const cands = new Set();
    if (idInit) cands.add(idInit);
    for (const cv of plain) if (t.isIdentifier(cv.node.right)) cands.add(cv.node.right.name);
    if (!cands.size) return null;
    if (asgNonId && !idInit) return null;
    const roleset = new Set();
    for (const c of cands) { const r = resolve(c, b.scope, new Set(seen)); if (r) roleset.add(r); }
    return roleset.size === 1 ? [...roleset][0] : null;
  };

  for (const h of handlers) {
    if (!h.casePath) continue;
    const aliases = new Map();
    try {
      h.casePath.traverse({
        Identifier(p) {
          const name = p.node.name;
          if (rootMap.has(name) || aliases.has(name)) return;
          // skip non-reference positions (property names, labels)
          const par = p.parent;
          if ((t.isMemberExpression(par) || t.isOptionalMemberExpression(par)) && p.key === 'property' && !par.computed) return;
          if ((t.isObjectProperty(par) || t.isObjectMethod(par)) && p.key === 'key' && !par.computed) return;
          const tok = resolve(name, p.scope, new Set());
          if (tok) aliases.set(name, tok);
        },
      });
    } catch { /* stale path: leave this handler without aliases */ }
    if (aliases.size) h.stateAliases = aliases;
  }
}

module.exports = { locate, parse, declaredLocals, prologueStatements };
