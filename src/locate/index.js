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
  inferAliasedRoles(handlers, roles);

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

/**
 * Fill roles that inferRoles could not detect on newer builds because its heuristics scan
 * handler text for the root register names, while newer handlers use the aliases resolved by
 * attachStateAliases. Only fills a role when it is still null, so older builds (where inferRoles
 * already found everything) are untouched.
 */
function inferAliasedRoles(handlers, roles) {
  const isPc = (name, h) => name === roles.pc || h.stateAliases?.get(name) === 'PC';

  // jump table: a handler whose whole body is `pc = TABLE[pc]` (pc possibly aliased). The table
  // itself is referenced directly, so once named it canonicalizes to J via roleMap.
  if (!roles.jumps) {
    for (const h of handlers) {
      const body = h.body.filter((st) => !t.isBreakStatement(st) && !t.isContinueStatement(st));
      if (body.length !== 1 || !t.isExpressionStatement(body[0])) continue;
      const e = body[0].expression;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isIdentifier(e.left) || !isPc(e.left.name, h)) continue;
      if (!t.isMemberExpression(e.right, { computed: true }) || !t.isIdentifier(e.right.object)) continue;
      if (!t.isIdentifier(e.right.property) || !isPc(e.right.property.name, h)) continue;
      roles.jumps = e.right.object.name;
      break;
    }
  }

  // scope register + scope-object property roles. Older builds build the first scope object in the
  // prologue (inferRoles finds it there); newer builds build it inside the ENTER_SCOPE handler with
  // obfuscated keys ({slots:new Array, constFlags:null, selfIdx:-1, parent:<id>}). Detect it from
  // the handler, and take the scope register as the outer variable it is stored into.
  if (!roles.scope) {
    for (const h of handlers) {
      // the scope object literal + its property roles
      let lit = null, props = null;
      for (const st of h.body) {
        t.traverseFast(st, (n) => {
          if (lit || !t.isObjectExpression(n) || n.properties.length < 3) return;
          const pr = {};
          let ok = true;
          for (const p of n.properties) {
            if (!t.isObjectProperty(p)) { ok = false; break; }
            const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
            const v = p.value;
            if (t.isNewExpression(v) && t.isIdentifier(v.callee, { name: 'Array' })) pr.slots = key;
            else if (t.isNullLiteral(v)) pr.constFlags = key;
            else if (t.isUnaryExpression(v, { operator: '-' })) pr.selfIdx = key;
            else if (t.isIdentifier(v)) pr.parent = key;
          }
          if (ok && pr.slots && pr.parent) { lit = n; props = pr; }
        });
        if (lit) break;
      }
      if (!lit) continue;
      // names declared inside this handler, and the declared locals that hold the new scope object
      const declared = new Set();
      const holdsLit = new Set();
      for (const st of h.body) t.traverseFast(st, (n) => {
        if (!t.isVariableDeclarator(n) || !t.isIdentifier(n.id)) return;
        declared.add(n.id.name);
        if (n.init === lit || (t.isIdentifier(n.init) && holdsLit.has(n.init.name))) holdsLit.add(n.id.name);
      });
      // scope register: an assignment target that receives the scope object but is NOT a handler
      // local (so it persists across handlers) -- `SC = lit` or `SC = <localHoldingLit>`.
      let scopeVar = null;
      for (const st of h.body) t.traverseFast(st, (n) => {
        if (scopeVar || !t.isAssignmentExpression(n, { operator: '=' }) || !t.isIdentifier(n.left) || declared.has(n.left.name)) return;
        if (n.right === lit || (t.isIdentifier(n.right) && holdsLit.has(n.right.name))) scopeVar = n.left.name;
      });
      if (scopeVar) { roles.scope = scopeVar; roles.scopeProps = props; break; }
    }
  }

  // scope "names" property: `(scope.X ||= {})[slot] = consts[...]` in the DECLARE handler. Detected
  // here (not in inferRoles) because roles.scope is only known after the pass above on newer builds.
  if (roles.scope && roles.scopeProps && !roles.scopeProps.names) {
    for (const h of handlers) {
      if (roles.scopeProps.names) break;
      for (const st of h.body) t.traverseFast(st, (n) => {
        if (roles.scopeProps.names) return;
        if (t.isAssignmentExpression(n, { operator: '||=' }) && t.isMemberExpression(n.left) &&
            t.isIdentifier(n.left.object, { name: roles.scope }) && t.isObjectExpression(n.right)) {
          roles.scopeProps.names = t.isIdentifier(n.left.property) ? n.left.property.name : n.left.property.value;
        }
      });
    }
  }
}

module.exports = { locate, parse, declaredLocals, prologueStatements };
