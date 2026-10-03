'use strict';
/**
 * Step 5: put the lifted programs back into the host script.
 *
 * Two build modes exist:
 *   - "full": the whole script is one VM program invoked from a trailing IIFE
 *     `(function(){ return vm(this, ..., 0) })()`;
 *   - "partial": plain host code remains and each virtualized function is a
 *     stub `function f(a){ return vm(3, arguments, {scope}, ..., this) }`.
 * In both cases every call to the VM entry point is located, its arguments are
 * mapped to roles by shape (arguments / array literal, scope object literal,
 * this, new.target, program index) and the enclosing host function gets the
 * decompiled body. VM boilerplate statements are removed. Then the lowering of
 * private members is undone (private.js) and the result is made to read like
 * source again (cleanup.js, which uses params.js for parameters and destructuring).
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { renameSynthetic } = require('../naming');
const { Lifter, Frame } = require('../lift');
const { gen, isIdentName, referencesName, staticKey, iife, replaceWhere, isArgumentsSlice, hasOwnArguments, containsOwn, containsReturn, referencesThisOrArgs } = require('../ast');
const { restorePrivateMembers } = require('./private');
const { foldDerivedFieldInitializers, inlinePrivateComputedKeys } = require('./fields');
const { stripIllegalStrict, stripRedundantStrict, cleanup } = require('./cleanup');

// output: comments kept, strings with minimal escaping
const GEN_OPTS = { comments: true, compact: false, jsescOption: { minimal: true } };

// ---------------------------------------------------------------------------
// host analysis
// ---------------------------------------------------------------------------

/** the top-level statement of the host program that contains the VM factory */
function factoryTopStatement(vm) {
  let top = vm.factoryPath;
  while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
  return top.node;
}

/** Map the arguments of one entry call to roles by shape. */
function classifyEntryArgs(call, ex, vm) {
  const roles = { programIndex: null, args: null, scope: null, hasThis: false, newTarget: false, callee: null };
  const slotsKey = vm.roles.scopeProps.slots;
  call.arguments.forEach((a, i) => {
    if (i === ex.entryProgramParam && (t.isNumericLiteral(a))) { roles.programIndex = a.value; return; }
    if (t.isIdentifier(a, { name: 'arguments' })) roles.args = a;
    else if (t.isArrayExpression(a)) roles.args = a;
    else if (t.isObjectExpression(a) && a.properties.some((p) => t.isObjectProperty(p) && (t.isIdentifier(p.key, { name: slotsKey }) || t.isStringLiteral(p.key, { value: slotsKey })))) roles.scope = a;
    else if (t.isThisExpression(a)) roles.hasThis = true;
    else if (t.isMetaProperty(a)) roles.newTarget = true;
    else if (t.isConditionalExpression(a) && t.isUnaryExpression(a.test.left, { operator: 'typeof' })) roles.callee = a.test.left.argument;
  });
  if (roles.programIndex === null) {
    // fall back: first numeric literal
    const n = call.arguments.find((a) => t.isNumericLiteral(a));
    if (n) roles.programIndex = n.value;
  }
  return roles;
}

/** Build an external Frame from a host scope object literal. */
function frameFromScopeLiteral(obj, vm, lifter, warn) {
  const slotsKey = vm.roles.scopeProps.slots;
  const frame = new Frame(lifter.frameCounter++, { external: true });
  const prop = obj.properties.find((p) => t.isObjectProperty(p) && (t.isIdentifier(p.key, { name: slotsKey }) || t.isStringLiteral(p.key, { value: slotsKey })));
  if (!prop) return frame;
  const v = prop.value;
  const setName = (i, node) => {
    if (t.isIdentifier(node)) frame.names.set(i, node.name);
    else if (t.isFunctionExpression(node) && node.body.body.length === 1 && t.isReturnStatement(node.body.body[0]) && t.isIdentifier(node.body.body[0].argument)) frame.names.set(i, node.body.body[0].argument.name);
    else { frame.names.set(i, `__slot${i}`); warn(`scope slot ${i} is not a plain identifier: ${gen(node)}`); }
    frame.declared.add(i);
  };
  if (t.isArrayExpression(v)) {
    v.elements.forEach((el, i) => el && setName(i, el));
  } else if (t.isCallExpression(v) && t.isMemberExpression(v.callee) && t.isIdentifier(v.callee.property, { name: 'defineProperties' }) && t.isObjectExpression(v.arguments[1])) {
    for (const p of v.arguments[1].properties) {
      if (!t.isObjectProperty(p)) continue;
      const idx = Number(t.isStringLiteral(p.key) ? p.key.value : t.isNumericLiteral(p.key) ? p.key.value : t.isIdentifier(p.key) ? p.key.name : NaN);
      if (Number.isNaN(idx) || !t.isObjectExpression(p.value)) continue;
      const val = p.value.properties.find((q) => t.isObjectProperty(q) && t.isIdentifier(q.key, { name: 'value' }));
      const get = p.value.properties.find((q) => (t.isObjectProperty(q) && t.isIdentifier(q.key, { name: 'get' })) || (t.isObjectMethod(q) && t.isIdentifier(q.key, { name: 'get' })));
      if (val) setName(idx, val.value);
      else if (get) {
        const fn = t.isObjectMethod(get) ? get : get.value;
        const ret = fn.body.body.find((s) => t.isReturnStatement(s));
        if (ret && t.isIdentifier(ret.argument)) { frame.names.set(idx, ret.argument.name); frame.declared.add(idx); }
        else setName(idx, fn);
      }
    }
  } else {
    warn(`unrecognized scope literal shape: ${gen(v).slice(0, 80)}`);
  }
  return frame;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function assemble(vm, ex, table, { log = () => {}, warn = () => {}, prettyNames = true } = {}) {
  const programsById = new Map(ex.programs.map((p) => [p.id, p]));
  // every identifier of the file: synthetic names (`r2`, `a0`, `_t1`, ...) are chosen not to capture one
  const reserved = new Set();
  t.traverseFast(vm.ast, (n) => { if (t.isIdentifier(n)) reserved.add(n.name); });
  const lifter = new Lifter({ table, programsById, nestedIndexToId: ex.nestedIndexToId, log, warn, reserved });

  const program = vm.ast.program;
  const facTop = factoryTopStatement(vm);
  const facIdx = vm.ast.program.body.indexOf(facTop);
  const facDecl = t.isVariableDeclaration(facTop) && facTop.declarations.length === 1 && t.isIdentifier(facTop.declarations[0].id) ? facTop.declarations[0].id.name : null;
  const entryName = facDecl || ex.entryName;
  const nsName = vm.nsName;
  const globalName = vm.globalName;

  // Private-method keys: `NS["_$ps_0"] = Symbol()` anywhere at top level
  const privateSymbols = new Set();
  for (const st of program.body) {
    t.traverseFast(st, (n) => {
      if (t.isAssignmentExpression(n, { operator: '=' }) && t.isMemberExpression(n.left) && t.isIdentifier(n.left.object, { name: nsName }) &&
          t.isCallExpression(n.right) && t.isIdentifier(n.right.callee, { name: 'Symbol' }) && n.right.arguments.length === 0) {
        const key = staticKey(n.left);
        if (key) privateSymbols.add(key);
      }
    });
  }

  // Collect entry calls in the host part
  const hostStmts = program.body.slice(facIdx + 1);
  const hostProgram = t.program(hostStmts);
  const hostAst = t.file(hostProgram);
  const liftedIds = new Set();
  let replaced = 0;

  traverse(hostAst, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee, { name: entryName })) return;
      const roles = classifyEntryArgs(path.node, ex, vm);
      const progId = ex.mainIndexToId[roles.programIndex];
      const prog = progId !== undefined ? programsById.get(progId) : null;
      if (!prog) { warn(`entry call with unknown program index ${roles.programIndex}`); return; }
      const fnPath = path.getFunctionParent();
      if (!fnPath) { warn('entry call outside of a function'); return; }
      const fnNode = fnPath.node;

      // parameter names / host signature
      let paramNames = null;
      const prelude = [];
      const hostParams = fnNode.params.map((p) => (t.isIdentifier(p) ? p.name : null));
      let keepHostParams = true;
      if (roles.args && t.isIdentifier(roles.args, { name: 'arguments' })) {
        paramNames = [];
        for (let i = 0; i < Math.max(prog.paramCount, hostParams.filter(Boolean).length); i++) paramNames.push(hostParams[i] || `a${i}`);
        for (let i = fnNode.params.length; i < prog.paramCount; i++) fnNode.params.push(t.identifier(paramNames[i]));
        keepHostParams = false; // may receive a rest parameter below
      } else if (roles.args && t.isArrayExpression(roles.args)) {
        const els = roles.args.elements;
        if (els.every((e) => t.isIdentifier(e)) && els.length >= prog.paramCount) {
          paramNames = els.map((e) => e.name);
        } else {
          paramNames = Array.from({ length: prog.paramCount }, (_, i) => `a${i}`);
          if (prog.paramCount) prelude.push(t.variableDeclaration('let', [t.variableDeclarator(t.arrayPattern(paramNames.map((n) => t.identifier(n))), roles.args)]));
        }
      }
      // parent scope
      const chain = [];
      if (roles.scope) chain.push(frameFromScopeLiteral(roles.scope, vm, lifter, warn));

      const lifted = lifter.liftProgram(prog, { parentChain: chain, paramNames, isTopLevel: false });
      liftedIds.add(prog.id);
      const arrayArgs = roles.args && t.isArrayExpression(roles.args);
      if (arrayArgs && lifted.usesArguments) {
        const els = roles.args.elements;
        const restIdx = els.findIndex((e) => t.isSpreadElement(e));
        if (restIdx >= 0 && restIdx === els.length - 1 && t.isIdentifier(els[restIdx].argument) && els.slice(0, restIdx).every((e) => t.isIdentifier(e))) {
          const restName = els[restIdx].argument.name;
          const holder = t.blockStatement(lifted.body);
          replaceWhere(holder, (x) => isArgumentsSlice(x, restIdx), () => t.identifier(restName), (x) => x !== holder && hasOwnArguments(x));
          lifted.body = holder.body;
          const other = referencesName(holder, 'arguments');
          if (!other) { lifted.usesArguments = false; }
        }
      }
      const fn = lifter.buildFunction(prog, lifted, { noStrict: true, argumentsName: arrayArgs && lifted.usesArguments ? '__args' : null });
      if (arrayArgs && lifted.usesArguments) {
        for (const st of prelude) t.traverseFast(st, (n) => { if (t.isVariableDeclarator(n) && n.init === roles.args) n.init = t.identifier('__args'); });
        prelude.unshift(t.variableDeclaration('const', [t.variableDeclarator(t.identifier('__args'), t.cloneNode(roles.args, true))]));
      }
      let params = fnNode.params.slice();
      if (!keepHostParams) {
        const rest = fn.params.find((p) => t.isRestElement(p));
        if (rest && !params.some((p) => t.isRestElement(p))) params.push(rest);
      }
      fnNode.params = params;
      const stmtPath = path.getStatementParent();
      const liftedStmts = [...prelude, ...fn.body.body];
      const arg = stmtPath && stmtPath.isReturnStatement() ? stmtPath.node.argument : null;
      const wrapsCall = arg === path.node || (t.isYieldExpression(arg) && arg.delegate && arg.argument === path.node) || (t.isAwaitExpression(arg) && arg.argument === path.node);
      if (stmtPath && stmtPath.isReturnStatement() && wrapsCall && stmtPath.parentPath === fnPath.get('body')) {
        // `return vm(...)` directly in the function body: splice the decompiled statements in place
        const body = fnNode.body.body;
        const idx = body.indexOf(stmtPath.node);
        body.splice(idx, 1, ...liftedStmts);
      } else if (stmtPath && stmtPath.isExpressionStatement() && stmtPath.node.expression === path.node && stmtPath.parentPath === fnPath.get('body')) {
        const body = fnNode.body.body;
        const idx = body.indexOf(stmtPath.node);
        body.splice(idx, 1, ...liftedStmts.filter((s) => !(t.isReturnStatement(s) && !s.argument)));
      } else {
        // the call is nested in an expression: keep it as an immediately-invoked arrow
        path.replaceWith(iife(liftedStmts));
      }
      if (fn.generator || containsOwn(liftedStmts, (n) => t.isYieldExpression(n))) fnNode.generator = true;
      if (fn.async || containsOwn(liftedStmts, (n) => t.isAwaitExpression(n) || t.isForOfStatement(n) && n.await)) fnNode.async = true;
      if (fnNode.generator || fnNode.async) {
        // stub guard `if (new.target) throw new TypeError();` is implied for async/generator functions
        const b = fnNode.body.body;
        const gi = b.findIndex((x) => t.isIfStatement(x) && t.isMetaProperty(x.test) && (t.isThrowStatement(x.consequent) || (t.isBlockStatement(x.consequent) && x.consequent.body.length === 1 && t.isThrowStatement(x.consequent.body[0]))));
        if (gi >= 0) b.splice(gi, 1);
      }
      replaced++;
      path.skip();
    },
  });

  // Remove VM boilerplate statements from the host. Only statements that consist
  // entirely of VM bookkeeping are dropped; references to top-level bindings that
  // the obfuscator routed through the namespace object (`NS["memo"]`) are
  // rewritten back to plain identifiers afterwards.
  // lifted programs reach the namespace through its global key (differs with "Rename Globals")
  const isNS = (n) => t.isIdentifier(n) && (n.name === nsName || (vm.nsKey && n.name === vm.nsKey));
  const isEntry = (n) => t.isIdentifier(n, { name: entryName });
  // a member chain on the namespace is bookkeeping unless it goes through a user binding the
  // namespace carries (`NS.vault.locked = true` is the program's own `vault.locked = true`)
  const userBinding = (n) => t.isMemberExpression(n) && isNS(n.object) && (() => { const k = staticKey(n); return k !== null && isIdentName(k) && !/^_\$/.test(k); })();
  const onNS = (n) => (t.isMemberExpression(n) && (isNS(n.object) || (onNS(n.object) && !userBinding(n.object)) || isEntry(n.object) || t.isIdentifier(n.object, { name: 'globalThis' })));
  const isBoilerExpr = (e) => {
    if (t.isSequenceExpression(e)) return e.expressions.every(isBoilerExpr);
    if (t.isAssignmentExpression(e) && onNS(e.left)) return true;
    if (t.isUnaryExpression(e, { operator: 'delete' }) && onNS(e.argument)) return true;
    if (t.isCallExpression(e) && t.isMemberExpression(e.callee) && t.isIdentifier(e.callee.object, { name: 'Object' }) && t.isIdentifier(e.callee.property, { name: 'defineProperty' }) && isNS(e.arguments[0])) return true;
    if (t.isCallExpression(e) && t.isMemberExpression(e.callee) && isEntry(e.callee.object)) return true; // registration: ENTRY._$x(fn, idx)
    if (t.isIdentifier(e)) return true; // bare `console;` probes inside the global-shim try blocks
    return false;
  };
  const isBoilerplate = (st) => {
    if (t.isExpressionStatement(st)) return isBoilerExpr(st.expression);
    if (t.isTryStatement(st)) return st.block.body.every(isBoilerplate) && (!st.handler || st.handler.body.body.length === 0);
    if (t.isVariableDeclaration(st)) return st.declarations.every((d) => t.isIdentifier(d.id) && (d.id.name === nsName || d.id.name === globalName || d.id.name === entryName));
    return false;
  };
  // `NS.key = local`: the VM programs (and globalThis) know a top-level binding by its export key;
  // with obfuscator.io's "Rename Globals" the host binding itself has another name
  const exportNames = new Map();
  for (const st of hostProgram.body) {
    const exprs = t.isExpressionStatement(st) ? (t.isSequenceExpression(st.expression) ? st.expression.expressions : [st.expression]) : [];
    for (const e of exprs) {
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isMemberExpression(e.left) || !isNS(e.left.object) || !t.isIdentifier(e.right)) continue;
      const key = staticKey(e.left);
      if (key && isIdentName(key) && key !== e.right.name && e.right.name !== nsName) exportNames.set(e.right.name, key);
    }
  }
  let out = hostProgram.body.filter((s) => !isBoilerplate(s));
  // Host TDZ guards: `NS[tdz].x ? (function () { throw new ReferenceError(...) })() : NS.x`  ->  `NS.x`
  const throwsReferenceError = (fn) => t.isCallExpression(fn) && (t.isFunctionExpression(fn.callee) || t.isArrowFunctionExpression(fn.callee)) &&
    t.isBlockStatement(fn.callee.body) && fn.callee.body.body.length === 1 && t.isThrowStatement(fn.callee.body.body[0]) &&
    t.isNewExpression(fn.callee.body.body[0].argument) && t.isIdentifier(fn.callee.body.body[0].argument.callee, { name: 'ReferenceError' });
  traverse(t.file(t.program(out)), {
    ConditionalExpression(p) {
      const n = p.node;
      if (t.isMemberExpression(n.test) && t.isMemberExpression(n.test.object) && isNS(n.test.object.object) && throwsReferenceError(n.consequent)) p.replaceWith(n.alternate);
    },
  });
  // NS["x"] / NS.x  ->  x
  traverse(t.file(t.program(out)), {
    MemberExpression(p) {
      const n = p.node;
      if (!isNS(n.object)) return;
      const key = staticKey(n);
      if (key && isIdentName(key)) p.replaceWith(t.identifier(key));
    },
  });

  // Inline the top-level IIFE of a "full" build: `(function () { ...body... })();`
  out = out.flatMap((st) => {
    if (t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isFunctionExpression(st.expression.callee) && st.expression.arguments.length === 0 &&
        !st.expression.callee.generator && !st.expression.callee.async && st.expression.callee.params.length === 0) {
      const body = st.expression.callee.body.body;
      const hasReturn = body.some((s) => containsReturn(s));
      const usesThis = referencesThisOrArgs(st.expression.callee.body);
      if (!hasReturn && !usesThis) return body;
    }
    return [st];
  });

  // Programs that were never referenced from the host (e.g. alternative constructor variants) -> comment
  const unreferenced = ex.programs.filter((p) => p.source === 'main' && !liftedIds.has(p.id) && !lifter.active.has(p.id));
  const extra = [];
  for (const p of unreferenced) {
    // dead code: its lifting problems (e.g. unknown captured scopes) are notes in the comment,
    // not warnings about the decompiled program
    const notes = [];
    const realWarn = lifter.ctx.warn;
    lifter.ctx.warn = (m) => { if (!notes.includes(m)) notes.push(m); };
    try {
      const lifted = lifter.liftProgram(p, { parentChain: [] });
      const fn = lifter.buildFunction(p, lifted, { noStrict: true });
      const text = generate(t.program([t.expressionStatement(fn)]), { comments: false }).code.replace(/\*\//g, '* /');
      const holder = t.emptyStatement();
      t.addComment(holder, 'leading', `\n VM program ${p.id} (main table index ${p.index}) is present in the bytecode but never invoked by the host code:\n${text}\n` +
        (notes.length ? ` notes: ${notes.join('; ')}\n` : ''));
      extra.push(holder);
    } catch (e) {
      log(`could not lift unreferenced program ${p.id}: ${e.message}`);
    } finally {
      lifter.ctx.warn = realWarn;
    }
  }

  // var declarations for STORE_GLOBAL_DECL targets
  const varDecls = [...lifter.globalVarDecls].filter(isIdentName);
  const finalBody = [];
  if (varDecls.length) finalBody.push(t.variableDeclaration('var', varDecls.map((n) => t.variableDeclarator(t.identifier(n)))));
  finalBody.push(...out, ...extra);
  const file = t.file(t.program(finalBody, [], 'script'));
  if (exportNames.size) {
    traverse.cache.clear();
    traverse(file, {
      Program(p) {
        for (const [local, key] of exportNames) if (p.scope.hasOwnBinding(local) && !p.scope.hasBinding(key)) p.scope.rename(local, key);
        p.stop();
      },
    });
  }
  const privateLeft = restorePrivateMembers(file, privateSymbols);
  foldDerivedFieldInitializers(file);
  // leftovers that still reference the lowering (reported, not guessed), counted after the
  // initializer functions that use the WeakMaps are folded into the classes
  const left = privateLeft ? privateLeft() : 0;
  if (left) warn(`${left} reference(s) to lowered private members could not be restored`);
  stripIllegalStrict(file);
  t.traverseFast(file, (n) => { if (t.isDirectiveLiteral(n)) { delete n.extra; if (/^use\\x20strict$/.test(n.value)) n.value = 'use strict'; } });
  stripRedundantStrict(file); // (also the directives of class members: class bodies are strict)
  // the cleanup passes enable each other (e.g. a removed parameter copy exposes a default
  // parameter check); iterate to a fixpoint
  let code = null;
  for (let round = 0; round < 4; round++) {
    cleanup(file);
    inlinePrivateComputedKeys(file);
    const next = generate(file, GEN_OPTS).code;
    if (next === code) break;
    code = next;
  }
  // readable names for synthetic identifiers (cosmetic, last)
  if (prettyNames && !process.env.VMDEC_NONAMES && renameSynthetic(file)) code = generate(file, GEN_OPTS).code;
  log(`${replaced} host call site(s) replaced, ${unreferenced.length} unreferenced program(s)`);
  return { code, replaced };
}

module.exports = { assemble };
