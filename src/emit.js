'use strict';
/**
 * Step 5: put the lifted programs back into the host script and clean up.
 *
 * Two build modes exist:
 *   - "full": the whole script is one VM program invoked from a trailing IIFE
 *     `(function(){ return vm(this, ..., 0) })()`;
 *   - "partial": plain host code remains and each virtualized function is a
 *     stub `function f(a){ return vm(3, arguments, {scope}, ..., this) }`.
 * In both cases every call to the VM entry point is located, its arguments are
 * mapped to roles by shape (arguments / array literal, scope object literal,
 * this, new.target, program index) and the enclosing host function gets the
 * decompiled body. VM boilerplate statements are removed and a few AST
 * cleanups (x = x + 1 -> x++, `let x; x = v` -> `let x = v`, template
 * literals, default parameters, named function declarations) make the result
 * read like source again.
 */
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { renameSynthetic } = require('./naming');
const { gen } = require('./locate');
const { Lifter, Frame, isIdentName, referencesName } = require('./lift');

// ---------------------------------------------------------------------------
// host analysis
// ---------------------------------------------------------------------------

function factoryStatementIndex(vm) {
  let top = vm.factoryPath;
  while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
  return vm.ast.program.body.indexOf(top.node);
}

function factoryVarName(vm) {
  let top = vm.factoryPath;
  while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
  const st = top.node;
  if (t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id)) return st.declarations[0].id.name;
  return null;
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
  const frame = new Frame(lifter.frameCounter++, 0, { external: true });
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
  const facIdx = factoryStatementIndex(vm);
  const entryName = factoryVarName(vm) || ex.entryName;
  const nsName = vm.nsName;
  const globalName = vm.globalName;

  // Private-method keys: `NS["_$ps_0"] = Symbol()` anywhere at top level
  const privateSymbols = new Set();
  for (const st of program.body) {
    t.traverseFast(st, (n) => {
      if (t.isAssignmentExpression(n, { operator: '=' }) && t.isMemberExpression(n.left) && t.isIdentifier(n.left.object, { name: nsName }) &&
          t.isCallExpression(n.right) && t.isIdentifier(n.right.callee, { name: 'Symbol' }) && n.right.arguments.length === 0) {
        const key = n.left.computed ? (t.isStringLiteral(n.left.property) ? n.left.property.value : null) : n.left.property.name;
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
          let other = false;
          const walk = (n, parent, key, idx) => {
            if (!n || typeof n.type !== 'string') return;
            if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property, { name: 'call' }) && /slice/.test(gen(n.callee.object)) &&
                t.isIdentifier(n.arguments[0], { name: 'arguments' }) && t.isNumericLiteral(n.arguments[1], { value: restIdx })) {
              const rep = t.identifier(restName);
              if (idx !== undefined) parent[key][idx] = rep; else parent[key] = rep;
              return;
            }
            if (t.isIdentifier(n, { name: 'arguments' })) other = true;
            for (const k of t.VISITOR_KEYS[n.type] || []) {
              const v = n[k];
              if (Array.isArray(v)) v.forEach((c, i) => walk(c, n, k, i));
              else if (v && typeof v.type === 'string') walk(v, n, k);
            }
          };
          const holder = t.blockStatement(lifted.body);
          walk(holder, null, null);
          lifted.body = holder.body;
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
        path.replaceWith(t.callExpression(t.arrowFunctionExpression([], t.blockStatement(liftedStmts)), []));
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
  const memberKey = (n) => (n.computed ? (t.isStringLiteral(n.property) ? n.property.value : null) : n.property.name);
  const userBinding = (n) => t.isMemberExpression(n) && isNS(n.object) && (() => { const k = memberKey(n); return k !== null && isIdentName(k) && !/^_\$/.test(k); })();
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
      const key = e.left.computed ? (t.isStringLiteral(e.left.property) ? e.left.property.value : null) : e.left.property.name;
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
      const key = n.computed ? (t.isStringLiteral(n.property) ? n.property.value : null) : n.property.name;
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
    if (isReferencedByLifted(p, lifter)) continue;
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
  t.traverseFast(file, (n) => { if (t.isClassPrivateMethod(n) && n.body.directives) n.body.directives = n.body.directives.filter((d) => d.value.value !== 'use strict'); });
  stripIllegalStrict(file);
  t.traverseFast(file, (n) => {
    if (t.isDirectiveLiteral(n)) { delete n.extra; if (/^use\\x20strict$/.test(n.value)) n.value = 'use strict'; }
    if ((t.isClassMethod(n) || t.isClassPrivateMethod(n)) && n.body.directives) n.body.directives = n.body.directives.filter((d) => d.value.value !== 'use strict'); // implied in class bodies
  });
  // the cleanup passes enable each other (e.g. a removed parameter copy exposes a default
  // parameter check); iterate to a fixpoint
  let code = null;
  for (let round = 0; round < 4; round++) {
    cleanup(file);
    inlinePrivateComputedKeys(file);
    const next = generate(file, { comments: true, compact: false, jsescOption: { minimal: true } }).code;
    if (next === code) break;
    code = next;
  }
  // readable names for synthetic identifiers (cosmetic, last)
  if (prettyNames && !process.env.VMDEC_NONAMES && renameSynthetic(file)) code = generate(file, { comments: true, compact: false, jsescOption: { minimal: true } }).code;
  log(`${replaced} host call site(s) replaced, ${unreferenced.length} unreferenced program(s)`);
  return { code, replaced };
}

/** Does a predicate hold for some node in `stmts`, not looking into nested (non-arrow for await; any for yield) functions? */
function containsOwn(stmts, pred) {
  let hit = false;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string' || hit) return;
    if (t.isFunction(n) || t.isClass(n)) return;
    if (pred(n)) { hit = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  stmts.forEach(walk);
  return hit;
}

// ---------------------------------------------------------------------------
// private class members
//
// obfuscator.io lowers `#field` to a static WeakMap per class holding one
// object per instance (`C.<wm>.get(this).<key>`), installed by a field
// initializer `__vmwm__<key> = (x => (...set..., C.<wm>.get(this).<key> = x))(init)`,
// and `#method` to a method keyed by a `Symbol()` stored in the VM namespace,
// with a WeakSet brand check before every call. The original names are gone;
// the members are restored as `#field_N` / `#method_N`.
// ---------------------------------------------------------------------------

/** may evaluating the expression change state? (calls, assignments, yield, await, new, delete) */
function hasEffects(node) {
  let hit = false;
  t.traverseFast(node, (x) => {
    if (t.isCallExpression(x) || t.isOptionalCallExpression(x) || t.isNewExpression(x) || t.isAssignmentExpression(x) || t.isUpdateExpression(x) ||
        t.isYieldExpression(x) || t.isAwaitExpression(x) || t.isTaggedTemplateExpression(x) || t.isUnaryExpression(x, { operator: 'delete' })) hit = true;
  });
  return hit;
}

/** number of `let x;` declarations without initializer at the start of a body */
function leadingBareLets(body) {
  let k = 0;
  while (k < body.length && t.isVariableDeclaration(body[k]) && body[k].declarations.every((d) => !d.init && t.isIdentifier(d.id))) k++;
  return k;
}

/** does an expression moved into the parameter list read a binding of the function body? (the
 *  parameter scope does not see those) */
function readsBodyBinding(fnPath, expr, own = []) {
  let hit = false;
  t.traverseFast(expr, (x) => {
    if (hit || !t.isIdentifier(x) || own.includes(x.name)) return;
    const b = fnPath.scope.getBinding(x.name);
    if (b && b.scope === fnPath.scope && b.kind !== 'param') hit = true;
  });
  return hit;
}

/**
 * A parameter with a default does not count in the function's `length`, so the VM program has
 * fewer parameters than the source and reads the rest as `arguments[i]`:
 *   function* (a0) { if (arguments[1] === undefined) { arguments[1] = X; } ... arguments[1] ... }
 * becomes `function* (a0, a1 = X) { ... a1 ... }`. For a generator this matters: its parameter
 * defaults are evaluated by the call, its body only by the first `next()`.
 */
function argumentsToParams(path) {
  const n = path.node;
  if (t.isArrowFunctionExpression(n) || !n.params.every((p) => t.isIdentifier(p))) return;
  const P = n.params.length;
  const uses = [];
  let other = false;
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string' || other) return;
    if (node !== n && t.isFunction(node) && !t.isArrowFunctionExpression(node)) return;
    if (t.isIdentifier(node, { name: 'arguments' })) {
      if (t.isMemberExpression(parent) && parent.object === node && parent.computed && t.isNumericLiteral(parent.property) && Number.isInteger(parent.property.value)) uses.push(parent);
      else other = true;
      return;
    }
    for (const k of t.VISITOR_KEYS[node.type] || []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node)); else visit(v, node);
    }
  };
  visit(n.body, null);
  if (other || !uses.length) return;
  // the first missing parameter must get a default, or the `length` would grow
  const first = n.body.body[leadingBareLets(n.body.body)];
  const isDefaultOf = (st, i) => t.isIfStatement(st) && t.isBinaryExpression(st.test, { operator: '===' }) && t.isMemberExpression(st.test.left) &&
    t.isIdentifier(st.test.left.object, { name: 'arguments' }) && t.isNumericLiteral(st.test.left.property, { value: i }) && t.isIdentifier(st.test.right, { name: 'undefined' });
  if (!isDefaultOf(first, P)) return;
  if (uses.some((u) => t.isUnaryExpression(u, { operator: 'delete' }))) return;
  const max = Math.max(...uses.map((u) => u.property.value));
  const names = n.params.map((p) => p.name);
  for (let i = P; i <= max; i++) {
    let nm = `a${i}`;
    while (path.scope.hasBinding(nm) || path.scope.hasGlobal(nm) || names.includes(nm)) nm = '_' + nm;
    names.push(nm);
  }
  for (const u of new Set(uses)) { const id = t.identifier(names[u.property.value]); delete u.computed; Object.assign(u, id); for (const k of ['object', 'property', 'optional']) delete u[k]; }
  n.params = names.map((nm) => t.identifier(nm));
  path.scope.crawl();
}

/**
 * An object pattern parameter is lowered to one property read per element at the top of the body:
 *   (a0 = {}) => { let r1, r2; const r0 = a0.a; const x = a0.b === undefined ? D : a0.b; [r1, r2] = a0.w; }
 * becomes `({ a: r0, b: x = D, w: [r1, r2] } = {}) => {}`. For a generator this restores when the
 * reads run (at the call), and each property is read once again.
 */
function objectParams(path) {
  const n = path.node;
  const body = n.body.body;
  if (referencesName(n.body, 'arguments')) return;
  for (let pi = 0; pi < n.params.length; pi++) {
    const prm = n.params[pi];
    const P = t.isIdentifier(prm) ? prm.name : t.isAssignmentPattern(prm) && t.isIdentifier(prm.left) ? prm.left.name : null;
    if (!P) continue;
    // a property key: a name, or a computed key expression (`{ [f()]: x }`, evaluated in order)
    const keyOf = (m) => {
      if (!t.isMemberExpression(m) || !t.isIdentifier(m.object, { name: P })) return null;
      if (!m.computed && t.isIdentifier(m.property)) return m.property.name;
      if (m.computed && t.isStringLiteral(m.property)) return m.property.value;
      if (m.computed && t.isIdentifier(m.property) && keyTemps.has(m.property.name)) return keyTemps.get(m.property.name);
      if (m.computed && !referencesName(m.property, P)) return m.property;
      return null;
    };
    const keyTemps = new Map(); // temporary holding a computed key -> its expression
    const prop = (e) => {
      const k = keyOf(e);
      if (k !== null) return { k, def: null };
      if (t.isConditionalExpression(e) && t.isBinaryExpression(e.test, { operator: '===' }) && t.isIdentifier(e.test.right, { name: 'undefined' })) {
        // (a computed key is evaluated once: only a name key may appear in both reads)
        const k2 = keyOf(e.test.left);
        if (typeof k2 === 'string' && keyOf(e.alternate) === k2) return { k: k2, def: e.consequent };
      }
      return null;
    };
    const props = [];
    const bare = new Set();
    let i = 0;
    for (; i < body.length; i++) {
      const st = body[i];
      if (t.isVariableDeclaration(st) && st.declarations.every((d) => !d.init && t.isIdentifier(d.id))) { for (const d of st.declarations) bare.add(d.id.name); continue; }
      if (t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && st.declarations[0].init) {
        // `const k = f(); const x = a0[k];`: the computed key, held in a temporary used once
        const nx = body[i + 1];
        const nxInit = nx && t.isVariableDeclaration(nx) && nx.declarations.length === 1 ? nx.declarations[0].init
          : nx && t.isExpressionStatement(nx) && t.isAssignmentExpression(nx.expression) ? nx.expression.right : null;
        const kName = st.declarations[0].id.name;
        if (nxInit && t.isMemberExpression(nxInit) && nxInit.computed && t.isIdentifier(nxInit.object, { name: P }) && t.isIdentifier(nxInit.property, { name: kName }) &&
            countRefs(t.blockStatement(body.slice(i + 1)), kName) === 1 && !prop(st.declarations[0].init)) {
          keyTemps.set(kName, st.declarations[0].init);
          continue;
        }
        const r = prop(st.declarations[0].init);
        if (!r) break;
        props.push({ ...r, target: st.declarations[0].id });
        continue;
      }
      if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && (t.isArrayPattern(st.expression.left) || t.isObjectPattern(st.expression.left))) {
        const r = prop(st.expression.right);
        const names = Object.keys(t.getBindingIdentifiers(st.expression.left));
        if (!r || !names.every((x) => bare.has(x))) break;
        for (const x of names) bare.delete(x);
        props.push({ ...r, target: st.expression.left });
        continue;
      }
      break;
    }
    if (!props.length || bare.size) continue;
    if (body.slice(i).some((x) => referencesName(x, P))) continue;
    const own = props.flatMap((x) => Object.keys(t.getBindingIdentifiers(x.target)));
    if (new Set(own).size !== own.length || props.some((x) => x.def && (readsBodyBinding(path, x.def, own) || referencesName(x.def, P)))) continue;
    if (props.some((x) => typeof x.k !== 'string' && readsBodyBinding(path, x.k, own))) continue;
    const pat = t.objectPattern(props.map((x) => {
      const value = x.def ? t.assignmentPattern(x.target, x.def) : x.target;
      if (typeof x.k !== 'string') return t.objectProperty(x.k, value, true);
      const short = t.isIdentifier(x.target, { name: x.k }) && isIdentName(x.k);
      return t.objectProperty(isIdentName(x.k) ? t.identifier(x.k) : t.stringLiteral(x.k), value, false, short);
    }));
    n.params[pi] = t.isAssignmentPattern(prm) ? t.assignmentPattern(pat, prm.right) : pat;
    body.splice(0, i);
    path.scope.crawl();
    return;
  }
}

/** `(a0) => { let r = a0; [r, ...] = a0; ... }` -> `([r, ...]) => { ... }` */
function destructuredParams(path) {
  const n = path.node;
  const body = n.body.body;
  let i = 0;
  const declared = new Map(); // name -> declarator
  let src = null;
  while (i < body.length && t.isVariableDeclaration(body[i], { kind: 'let' })) {
    for (const d of body[i].declarations) {
      if (!t.isIdentifier(d.id)) return;
      if (d.init) { if (!t.isIdentifier(d.init) || (src && d.init.name !== src)) return; src = d.init.name; }
      declared.set(d.id.name, d);
    }
    i++;
  }
  const st = body[i];
  if (!st || !t.isExpressionStatement(st) || !t.isAssignmentExpression(st.expression, { operator: '=' }) ||
      !(t.isArrayPattern(st.expression.left) || t.isObjectPattern(st.expression.left)) || !t.isIdentifier(st.expression.right) || (src && st.expression.right.name !== src)) return;
  src = st.expression.right.name;
  // the parameter, possibly with a default: `(a0 = x) => { let r; [r] = a0; }` -> `([r] = x) => {}`
  const pi = n.params.findIndex((p) => t.isIdentifier(p, { name: src }) || (t.isAssignmentPattern(p) && t.isIdentifier(p.left, { name: src })));
  if (pi < 0) return;
  const pat = st.expression.left;
  const bound = Object.keys(t.getBindingIdentifiers(pat));
  if (bound.length !== declared.size || !bound.every((x) => declared.has(x))) return;
  if (body.slice(i + 1).some((x) => referencesName(x, src))) return;
  if (referencesName(n.body, 'arguments') || readsBodyBinding(path, pat, bound)) return;
  // defaults inside the pattern may only read parameters and outer bindings
  n.params[pi] = t.isAssignmentPattern(n.params[pi]) ? t.assignmentPattern(pat, n.params[pi].right) : pat;
  body.splice(0, i + 1);
  path.scope.crawl();
}

/**
 * A computed member key is evaluated ahead of the class into a temporary; one that reads a private
 * name of the class (`[this.#f] = 1`) is only valid inside the class, so it goes back into the key:
 *   const k = this.#f; class C { [k] = 1; get #f() {} }   ->   class C { [this.#f] = 1; ... }
 */
function inlinePrivateComputedKeys(file) {
  const hasPrivate = (e) => { let hit = false; t.traverseFast(e, (x) => { if (t.isPrivateName(x)) hit = true; }); return hit; };
  // the single reference is the computed key of a class member: put the expression there
  const inlineInto = (b, init) => {
    if (!b || b.referencePaths.length !== 1) return false;
    const ref = b.referencePaths[0];
    const member = ref.parentPath;
    if (!(member.isClassProperty() || member.isClassMethod() || member.isClassPrivateProperty()) || member.node.key !== ref.node || !member.node.computed) return false;
    ref.replaceWith(init);
    return true;
  };
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !n.init || !hasPrivate(n.init) || p.parentPath.node.declarations.length !== 1) return;
      const b = p.scope.getBinding(n.id.name);
      if (b && !b.constantViolations.length && inlineInto(b, n.init)) p.parentPath.remove();
    },
    // `let k; ... k = this.#f;`
    AssignmentExpression(p) {
      const n = p.node;
      if (n.operator !== '=' || !t.isIdentifier(n.left) || !hasPrivate(n.right) || !p.parentPath.isExpressionStatement()) return;
      const b = p.scope.getBinding(n.left.name);
      if (!b || b.constantViolations.length !== 1 || !b.path.isVariableDeclarator() || (b.path.node.init && !t.isIdentifier(b.path.node.init, { name: 'undefined' }))) return;
      if (!inlineInto(b, n.right)) return;
      p.parentPath.remove();
      if (b.path.parentPath.node.declarations.length === 1) b.path.parentPath.remove(); else b.path.remove();
    },
  });
}

/**
 * Instance fields of a derived class are initialized after `super()` by a function the compiler
 * creates outside the class and the constructor calls as `init.call(this)`:
 *
 *   const init = function () { const set = (x) => { <brand>; return this.#f = x; }; set(v); this.p = w; };
 *   class C extends B { constructor() { super(); init.call(this); ... } }
 *
 * When every statement of `init` is such a field setup, it becomes the field declarations
 * `#f = v; p = w;` of the class again (fields of a derived class run right after super()).
 */
function foldDerivedFieldInitializers(file) {
  traverse.cache.clear();
  traverse(file, {
    Class(cp) {
      const body = cp.node.body.body;
      const ctor = body.find((m) => t.isClassMethod(m, { kind: 'constructor' }));
      if (!ctor) return;
      // a base class runs its initializer first, a derived class right after super(), which may
      // also be called from an arrow function in the constructor (`const init = () => super();`)
      const isSuperCall = (st) => t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isSuper(st.expression.callee);
      let stmts = ctor.body.body;
      let superIdx = -1;
      if (cp.node.superClass) {
        superIdx = stmts.findIndex(isSuperCall);
        if (superIdx < 0) {
          t.traverseFast(ctor.body, (x) => {
            if (superIdx >= 0 || !t.isArrowFunctionExpression(x) || !t.isBlockStatement(x.body)) return;
            const k = x.body.body.findIndex(isSuperCall);
            if (k >= 0) { stmts = x.body.body; superIdx = k; }
          });
        }
        if (superIdx < 0) return;
      }
      // (uninitialized `let x;` declarations may come first; they have no effect)
      let callIdx = superIdx + 1;
      while (callIdx < stmts.length && t.isVariableDeclaration(stmts[callIdx]) && stmts[callIdx].declarations.every((d) => !d.init)) callIdx++;
      const callSt = stmts[callIdx];
      const call = callSt && t.isExpressionStatement(callSt) && t.isCallExpression(callSt.expression) ? callSt.expression : null;
      const isCallKey = (m) => (!m.computed && t.isIdentifier(m.property, { name: 'call' })) || (m.computed && t.isStringLiteral(m.property, { value: 'call' }));
      if (!call || !t.isMemberExpression(call.callee) || !isCallKey(call.callee) || !t.isIdentifier(call.callee.object) ||
          call.arguments.length !== 1 || !t.isThisExpression(call.arguments[0])) return;
      const b = cp.scope.getBinding(call.callee.object.name);
      if (!b || !b.path.isVariableDeclarator() || b.constantViolations.length || b.referencePaths.length !== 1) return;
      const fn = b.path.node.init;
      if (!t.isFunctionExpression(fn) || fn.params.length || fn.async || fn.generator) return;
      // brand bookkeeping of the WeakMap lowering: `C.wm.has(this) || C.wm.set(this, ...)`
      const isBrand = (st) => t.isExpressionStatement(st) && t.isLogicalExpression(st.expression, { operator: '||' }) &&
        t.isCallExpression(st.expression.left) && t.isMemberExpression(st.expression.left.callee) &&
        (t.isIdentifier(st.expression.left.callee.property, { name: 'has' }) || t.isStringLiteral(st.expression.left.callee.property, { value: 'has' }));
      const setters = new Map(); // arrow name -> private name
      const fields = [];
      const brandKeys = []; // `const k = "__vmwm__$pib_N"` naming the brand slot
      for (const st of fn.body.body) {
        if (isBrand(st)) continue;
        // `let set;` declared ahead of its assignment
        if (t.isVariableDeclaration(st) && st.declarations.every((d) => t.isIdentifier(d.id) && !d.init)) continue;
        // const set = (x) => { <brand>; return this.#f = x; }   or   set = (x) => ...
        const setterDecl = t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && t.isArrowFunctionExpression(st.declarations[0].init)
          ? { name: st.declarations[0].id.name, a: st.declarations[0].init }
          : t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isIdentifier(st.expression.left) && t.isArrowFunctionExpression(st.expression.right)
            ? { name: st.expression.left.name, a: st.expression.right } : null;
        if (setterDecl) {
          const a = setterDecl.a;
          if (a.params.length !== 1 || !t.isIdentifier(a.params[0])) return;
          const p = a.params[0].name;
          const ret = t.isBlockStatement(a.body) ? a.body.body : [t.returnStatement(a.body)];
          if (!ret.slice(0, -1).every(isBrand)) return;
          const last = ret[ret.length - 1];
          const e = t.isReturnStatement(last) ? last.argument : null;
          if (!e || !t.isAssignmentExpression(e, { operator: '=' }) || !t.isMemberExpression(e.left) || !t.isThisExpression(e.left.object) ||
              !t.isPrivateName(e.left.property) || !t.isIdentifier(e.right, { name: p })) return;
          setters.set(setterDecl.name, e.left.property.id.name);
          continue;
        }
        // set(v)
        if (t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isIdentifier(st.expression.callee) && setters.has(st.expression.callee.name) && st.expression.arguments.length === 1) {
          const v = st.expression.arguments[0];
          fields.push(t.classPrivateProperty(t.privateName(t.identifier(setters.get(st.expression.callee.name))), t.isIdentifier(v, { name: 'undefined' }) ? null : v));
          continue;
        }
        // this[__vmwm__$pib_N] = <install brand>: the brand of the class's #methods, implicit in the class
        if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isMemberExpression(st.expression.left) &&
            t.isThisExpression(st.expression.left.object) && st.expression.left.computed) {
          let install = false;
          t.traverseFast(st.expression.right, (x) => { if (t.isStringLiteral(x) && /install private/.test(x.value)) install = true; });
          if (install) { if (t.isIdentifier(st.expression.left.property)) brandKeys.push(st.expression.left.property.name); continue; }
        }
        // this.p = w
        if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isMemberExpression(st.expression.left) &&
            t.isThisExpression(st.expression.left.object)) {
          const l = st.expression.left;
          const v = st.expression.right;
          fields.push(t.classProperty(l.property, t.isIdentifier(v, { name: 'undefined' }) ? null : v, null, null, l.computed));
          continue;
        }
        return; // anything else: leave as it is
      }
      if (!fields.length && !brandKeys.length) return;
      cp.node.body.body = [...fields, ...body];
      stmts.splice(callIdx, 1);
      b.path.remove();
      // nothing left of a base class's constructor: the class has its default one
      if (!cp.node.superClass && !stmts.length && !ctor.params.length) cp.node.body.body = cp.node.body.body.filter((m) => m !== ctor);
      for (const k of brandKeys) {
        const kb = cp.scope.getBinding(k);
        if (kb && !kb.constantViolations.length && kb.path.isVariableDeclarator() && t.isStringLiteral(kb.path.node.init) && /^__vmwm__\$pib_/.test(kb.path.node.init.value)) {
          const rest = kb.referencePaths.filter((r) => !r.findParent((x) => x.node === fn));
          if (!rest.length) kb.path.remove();
        }
      }
    },
  });
}

function restorePrivateMembers(file, privateSymbols) {
  const privName = (key) => {
    const m = /\$p([a-z]+)_(\d+)$/.exec(key);
    if (m) return `${m[1].startsWith('s') ? 'method' : 'field'}_${m[2]}`;
    return key.replace(/[^A-Za-z0-9_]/g, '') || 'priv';
  };
  const isNew = (v, ctor) => t.isNewExpression(v) && t.isIdentifier(v.callee, { name: ctor });
  const keyName = (p) => (t.isIdentifier(p.key) && !p.computed ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null);
  // 1. per class: WeakMap / WeakSet statics
  const weakMaps = new Set(), weakSets = new Set();
  t.traverseFast(file, (n) => {
    if (!t.isClassBody(n)) return;
    for (const m of n.body) {
      if (!t.isClassProperty(m) || !m.static) continue;
      const k = keyName(m);
      if (k && isNew(m.value, 'WeakMap')) weakMaps.add(k);
      if (k && isNew(m.value, 'WeakSet')) weakSets.add(k);
    }
  });
  if (!weakMaps.size && !weakSets.size && !privateSymbols.size) return;
  // local aliases of a private symbol (`let k = _$ps_3; class { static [k] = 0 }`) -> the symbol
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !t.isIdentifier(n.init) || !privateSymbols.has(n.init.name)) return;
      const b = p.scope.getBinding(n.id.name);
      if (!b || b.constantViolations.length) return;
      for (const r of b.referencePaths) r.replaceWith(t.identifier(n.init.name));
      p.remove();
    },
  });
  // symbol-keyed members: a symbol used as a method key names a method, otherwise a field
  const symbolKind = new Map();
  t.traverseFast(file, (n) => {
    if (!t.isClassBody(n)) return;
    for (const m of n.body) {
      if (!m.computed || !t.isIdentifier(m.key) || !privateSymbols.has(m.key.name)) continue;
      symbolKind.set(m.key.name, t.isClassMethod(m) ? 'method' : 'field');
    }
  });
  const symName = (sym) => {
    const num = (/(\d+)$/.exec(sym) || [, '0'])[1];
    return symbolKind.get(sym) === 'field' ? `field_s${num}` : `method_${num}`;
  };
  // private keys of WeakMap-lowered fields (from their initializers `__vmwm__<key>`)
  const privateKeys = new Set();
  t.traverseFast(file, (n) => {
    if (t.isClassProperty(n)) {
      const k = keyName(n);
      if (k && /^__vmwm__/.test(k) && !/^__vmwm__\$pib_/.test(k)) { const key = k.replace(/^__vmwm__/, ''); privateKeys.add(key); privateKeys.add('_' + key); }
    }
  });
  const isWM = (n) => t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property) && weakMaps.has(n.property.name);
  // `C.<wm>.get(obj)` -> obj
  const storeOf = (n) => (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property, { name: 'get' }) && isWM(n.callee.object) && n.arguments.length === 1 ? n.arguments[0] : null);
  const brandHelpers = new Set();
  // `#x in o` helpers:  o => o is object ? C.<wm>.has(o) && "<key>" in C.<wm>.get(o) : "__vm_brand" in o
  const inHelpers = new Map(); // binding identifier -> private key
  const privateInKey = (fn) => {
    if (!t.isFunction(fn) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return null;
    let key = null, brand = false;
    t.traverseFast(fn.body, (x) => {
      if (t.isBinaryExpression(x, { operator: 'in' }) && t.isStringLiteral(x.left)) {
        if (storeOf(x.right)) key = x.left.value;
        else if (x.left.value === '__vm_brand') brand = true;
      }
    });
    return key && brand ? key : null;
  };
  traverse(file, {
    // 2. brand-check helpers:  let rN = function (o) { ... "Cannot read private member" ... }
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !t.isFunction(n.init)) return;
      const inKey = privateInKey(n.init);
      if (inKey) {
        const b = p.scope.getBinding(n.id.name);
        if (b && !b.constantViolations.length) {
          inHelpers.set(b.identifier, inKey);
          if (p.parentPath.node.declarations.length === 1) p.parentPath.remove(); else p.remove();
          return;
        }
      }
      let hit = false;
      t.traverseFast(n.init, (x) => { if (t.isStringLiteral(x) && /private member|private method/.test(x.value) && !/install private/.test(x.value)) hit = true; });
      if (hit) {
        const b = p.scope.getBinding(n.id.name);
        if (b) brandHelpers.add(b.identifier);
        if (p.parentPath.node.declarations.length === 1) p.parentPath.remove(); else p.remove();
      }
    },
    // helper assigned inside an expression:  (rN = function (o) { ... }, rN(this).#m())
    AssignmentExpression(p) {
      const e = p.node;
      if (e.operator !== '=' || !t.isIdentifier(e.left) || !t.isFunction(e.right) || !t.isSequenceExpression(p.parent)) return;
      const inKey = privateInKey(e.right);
      if (inKey) {
        const b = p.scope.getBinding(e.left.name);
        if (!b || b.constantViolations.some((v) => v.node !== e && !(t.isAssignmentExpression(v.node) && privateInKey(v.node.right) === inKey))) return;
        inHelpers.set(b.identifier, inKey);
        const seq = p.parent;
        seq.expressions = seq.expressions.filter((x) => x !== e);
        if (seq.expressions.length === 1) p.parentPath.replaceWith(seq.expressions[0]);
        return;
      }
      let hit = false;
      t.traverseFast(e.right, (x) => { if (t.isStringLiteral(x) && /private member|private method/.test(x.value) && !/install private/.test(x.value)) hit = true; });
      if (!hit) return;
      const b = p.scope.getBinding(e.left.name);
      if (!b || b.constantViolations.some((v) => v.node !== e && !(t.isAssignmentExpression(v.node) && t.isFunction(v.node.right)))) return;
      brandHelpers.add(b.identifier);
      const seq = p.parent;
      seq.expressions = seq.expressions.filter((x) => x !== e);
      if (seq.expressions.length === 1) p.parentPath.replaceWith(seq.expressions[0]);
    },
    // same helper assigned later:  rN = function (o) { ... }
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isIdentifier(e.left) || !t.isFunction(e.right)) return;
      const inKey = privateInKey(e.right);
      if (inKey) {
        const b = p.scope.getBinding(e.left.name);
        if (b && b.constantViolations.length === 1) { inHelpers.set(b.identifier, inKey); p.remove(); return; }
      }
      let hit = false;
      t.traverseFast(e.right, (x) => { if (t.isStringLiteral(x) && /private member|private method/.test(x.value) && !/install private/.test(x.value)) hit = true; });
      if (hit) {
        const b = p.scope.getBinding(e.left.name);
        if (b && b.constantViolations.length === 1) { brandHelpers.add(b.identifier); p.remove(); }
      }
    },
  });
  // `let r = C.<wm>.get(obj)` / `r = C.<wm>.get(obj)`  ->  `obj`, remember r
  const storeVars = new Set();
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) { const o = storeOf(p.node.init); if (o && t.isIdentifier(p.node.id)) { storeVars.add(p.node.id.name); p.node.init = o; } },
    AssignmentExpression(p) { const o = storeOf(p.node.right); if (o && t.isIdentifier(p.node.left)) { storeVars.add(p.node.left.name); p.node.right = o; } },
  });
  traverse.cache.clear();
  traverse(file, {
    CallExpression(p) {
      // `#x in o` helper call
      if (t.isIdentifier(p.node.callee) && p.node.arguments.length === 1) {
        const b = p.scope.getBinding(p.node.callee.name);
        if (b && inHelpers.has(b.identifier)) {
          p.replaceWith(t.binaryExpression('in', t.privateName(t.identifier(privName(inHelpers.get(b.identifier)))), p.node.arguments[0]));
          return;
        }
      }
      // immediately invoked brand check: (o => SYM in o ? o : {...throws...})(x) / (function (o) {...})(x) -> x
      if (t.isFunction(p.node.callee) && p.node.arguments.length === 1 && p.node.callee.params.length === 1) {
        let hit = false;
        t.traverseFast(p.node.callee, (x) => { if (t.isStringLiteral(x) && /private (member|method|field)/.test(x.value)) hit = true; });
        if (hit) { p.replaceWith(p.node.arguments[0]); return; }
      }
      // rN(obj) -> obj   (only calls of that very helper binding, names are reused across functions)
      if (t.isIdentifier(p.node.callee) && p.node.arguments.length === 1) {
        const b = p.scope.getBinding(p.node.callee.name);
        if (b && brandHelpers.has(b.identifier)) { p.replaceWith(p.node.arguments[0]); return; }
      }
    },
    // `sym in o` with a private member's symbol -> `#member in o`
    BinaryExpression(p) {
      const n = p.node;
      if (n.operator === 'in' && t.isIdentifier(n.left) && privateSymbols.has(n.left.name)) n.left = t.privateName(t.identifier(symName(n.left.name)));
    },
    MemberExpression: {
      exit(p) {
        const n = p.node;
        // C.<wm>.get(obj).key  ->  obj.#field
        const obj = storeOf(n.object);
        if (obj) {
          const key = !n.computed && t.isIdentifier(n.property) ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null;
          if (key) { p.replaceWith(t.memberExpression(obj, t.privateName(t.identifier(privName(key))))); return; }
        }
        // obj[sym] -> obj.#method
        if (n.computed && t.isIdentifier(n.property) && privateSymbols.has(n.property.name)) {
          p.replaceWith(t.memberExpression(n.object, t.privateName(t.identifier(symName(n.property.name)))));
          return;
        }
        // any access with a lowered private key (`r.key`, `(r = obj).key`): the keys are unique random
        // names used only by the lowering, and every store object has been replaced by its instance
        if (!n.computed && t.isIdentifier(n.property) && (privateKeys.has(n.property.name) || (privateKeys.size + weakMaps.size && /^_?\$p[a-z]+_\d+$/.test(n.property.name)))) {
          p.replaceWith(t.memberExpression(n.object, t.privateName(t.identifier(privName(n.property.name)))));
        }
      },
    },
    ClassBody(p) {
      const out = [];
      for (const m of p.node.body) {
        const k = t.isClassProperty(m) ? keyName(m) : null;
        // static WeakMap / WeakSet stores
        if (t.isClassProperty(m) && m.static && k && (weakMaps.has(k) || weakSets.has(k))) continue;
        // brand installation
        if (t.isClassProperty(m) && k && /^__vmwm__\$pib_/.test(k)) continue;
        // field initializer -> #field = init
        if (t.isClassProperty(m) && k && /^__vmwm__/.test(k)) {
          let init = t.isCallExpression(m.value) && m.value.arguments.length === 1 ? m.value.arguments[0] : null;
          if (init && t.isIdentifier(init, { name: 'undefined' })) init = null;
          const key = k.replace(/^__vmwm__/, '');
          out.push(t.classPrivateProperty(t.privateName(t.identifier(privName(key))), init, null, m.static));
          continue;
        }
        // [sym](...) {} -> #method(...) {}
        if (t.isClassMethod(m) && m.computed && t.isIdentifier(m.key) && privateSymbols.has(m.key.name)) {
          const pm = t.classPrivateMethod(m.kind, t.privateName(t.identifier(symName(m.key.name))), m.params, m.body, m.static);
          pm.async = !!m.async;
          pm.generator = !!m.generator;
          out.push(pm);
          continue;
        }
        // static [sym] = v  ->  static #field_sN = v
        if (t.isClassProperty(m) && m.computed && t.isIdentifier(m.key) && privateSymbols.has(m.key.name)) {
          out.push(t.classPrivateProperty(t.privateName(t.identifier(symName(m.key.name))), m.value, null, m.static));
          continue;
        }
        // brand block: static { this.<key> = this; }
        if (t.isStaticBlock(m) && m.body.length === 1 && t.isExpressionStatement(m.body[0]) && t.isAssignmentExpression(m.body[0].expression) &&
            t.isMemberExpression(m.body[0].expression.left) && t.isThisExpression(m.body[0].expression.left.object) && t.isThisExpression(m.body[0].expression.right)) continue;
        // static { register(this.prototype, sym) }
        if (t.isStaticBlock(m) && m.body.every((st) => t.isExpressionStatement(st) && t.isCallExpression(st.expression) && st.expression.arguments.some((a) => t.isIdentifier(a) && privateSymbols.has(a.name)))) continue;
        out.push(m);
      }
      p.node.body = out;
    },
    // `delete this.__vmwm__...;` in constructors
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (t.isUnaryExpression(e, { operator: 'delete' }) && t.isMemberExpression(e.argument) && t.isIdentifier(e.argument.property) && /^__vmwm__/.test(e.argument.property.name)) p.remove();
    },
  });
  return () => {
    let left = 0;
    t.traverseFast(file, (n) => { if (t.isIdentifier(n) && (weakMaps.has(n.name) || weakSets.has(n.name) || privateSymbols.has(n.name))) left++; });
    return left;
  };
}

/** `"use strict"` is a syntax error in functions with default, rest or destructured parameters. */
function stripIllegalStrict(file) {
  t.traverseFast(file, (n) => {
    if (!t.isFunction(n) || !t.isBlockStatement(n.body) || !n.body.directives || !n.body.directives.length) return;
    if (n.params.every((p) => t.isIdentifier(p))) return;
    n.body.directives = n.body.directives.filter((d) => d.value.value !== 'use strict');
  });
}

function containsReturn(node) {
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isReturnStatement(n)) hit = true; });
  // returns nested inside functions don't count
  if (!hit) return false;
  let real = false;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string' || real) return;
    if (t.isFunction(n) || t.isClass(n)) return;
    if (t.isReturnStatement(n)) { real = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(node);
  return real;
}

function referencesThisOrArgs(node) {
  let hit = false;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string' || hit) return;
    if (t.isFunctionExpression(n) || t.isFunctionDeclaration(n) || t.isObjectMethod(n) || t.isClassMethod(n)) return;
    if (t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }) || t.isMetaProperty(n)) { hit = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(node);
  return hit;
}

function isReferencedByLifted() { return false; }

// ---------------------------------------------------------------------------
// cleanup passes
// ---------------------------------------------------------------------------

function cleanup(file) {
  if (process.env.VMDEC_NOCLEANUP) return;
  // pass A: local expression rewrites
  traverse(file, {
    // `c ? x : c` -> `c && x`, `c ? c : x` -> `c || x`: a short-circuit whose operand the lifter had
    // to duplicate (the VM evaluates it once, as `&&` / `||` do)
    ConditionalExpression(path) {
      const n = path.node;
      // (structurally equal operands with effects, `(yield) ? yield : yield`, are two evaluations)
      const same = (a, b) => a === b || (t.isNodesEquivalent(a, b) && !hasEffects(a));
      if (same(n.test, n.alternate)) path.replaceWith(t.logicalExpression('&&', n.test, n.consequent));
      else if (same(n.test, n.consequent)) path.replaceWith(t.logicalExpression('||', n.test, n.alternate));
    },
    // x = x + 1  ->  x++ ;   (x = x + 1) -> ++x ; x = x op y -> x op= y
    AssignmentExpression(path) {
      const n = path.node;
      // a.b = a.b op y  ->  a.b op= y   (object must be side-effect free: this / identifier)
      // (an object node shared by reference comes from DUP: evaluated once, exactly like `op=`)
      if (n.operator === '=' && t.isMemberExpression(n.left) && t.isBinaryExpression(n.right) && (t.isThisExpression(n.left.object) || t.isIdentifier(n.left.object) ||
          t.isMemberExpression(n.right.left) && n.right.left.object === n.left.object) &&
          (!n.left.computed || t.isLiteral(n.left.property)) && t.isNodesEquivalent(n.right.left, n.left) &&
          ['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^'].includes(n.right.operator)) {
        if ((n.right.operator === '+' || n.right.operator === '-') && t.isNumericLiteral(n.right.right, { value: 1 }) && n.right.__inc) {
          path.replaceWith(t.updateExpression(n.right.operator === '+' ? '++' : '--', n.left, !path.parentPath.isExpressionStatement()));
        } else {
          path.replaceWith(t.assignmentExpression(n.right.operator + '=', n.left, n.right.right));
        }
        return;
      }
      if (n.operator !== '=' || !t.isIdentifier(n.left) || !t.isBinaryExpression(n.right)) return;
      const r = n.right;
      if ((r.operator === '+' || r.operator === '-') && t.isIdentifier(r.left, { name: n.left.name }) && t.isNumericLiteral(r.right, { value: 1 }) && r.__inc) {
        const isStmt = path.parentPath.isExpressionStatement();
        path.replaceWith(t.updateExpression(r.operator === '+' ? '++' : '--', t.identifier(n.left.name), !isStmt));
        return;
      }
      if (t.isIdentifier(r.left, { name: n.left.name }) && ['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^'].includes(r.operator)) {
        path.replaceWith(t.assignmentExpression(r.operator + '=', t.identifier(n.left.name), r.right));
      }
    },
    // `"" + String(a) + "x"` -> template literal
    BinaryExpression: {
      exit(path) {
        const n = path.node;
        if (n.operator !== '+') return;
        if (path.parentPath.isBinaryExpression({ operator: '+' }) && path.key === 'left') return;
        const parts = [];
        const flatten = (x) => { if (t.isBinaryExpression(x, { operator: '+' })) { flatten(x.left); flatten(x.right); } else parts.push(x); };
        flatten(n);
        if (!parts.some((p) => p.__toString)) return;
        if (!parts.every((p) => p.__toString || t.isStringLiteral(p) || t.isTemplateLiteral(p))) return;
        const quasis = [];
        const exprs = [];
        let cur = '';
        for (const p of parts) {
          if (t.isStringLiteral(p)) cur += p.value;
          else if (t.isTemplateLiteral(p)) {
            p.quasis.forEach((q, i) => { cur += q.value.cooked; if (i < p.expressions.length) { quasis.push(cur); exprs.push(p.expressions[i]); cur = ''; } });
          } else { quasis.push(cur); exprs.push(p.arguments[0]); cur = ''; }
        }
        quasis.push(cur);
        path.replaceWith(t.templateLiteral(quasis.map((q, i) => t.templateElement({ raw: escapeTemplate(q), cooked: q }, i === quasis.length - 1)), exprs));
      },
    },
    CallExpression(path) {
      const n = path.node;
      // super.m.call(this, ...args) -> super.m(...args)
      if (t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property, { name: 'call' }) && !n.callee.computed &&
          t.isMemberExpression(n.callee.object) && t.isSuper(n.callee.object.object) && t.isThisExpression(n.arguments[0])) {
        path.replaceWith(t.callExpression(n.callee.object, n.arguments.slice(1)));
        return;
      }
      if (n.__toString && !path.parentPath.isBinaryExpression()) {
        path.replaceWith(t.templateLiteral([t.templateElement({ raw: '', cooked: '' }), t.templateElement({ raw: '', cooked: '' }, true)], [n.arguments[0]]));
      }
    },
    IfStatement(path) {
      const n = path.node;
      if (t.isBlockStatement(n.consequent) && n.consequent.body.length === 0 && n.alternate) {
        path.replaceWith(t.ifStatement(negate(n.test), n.alternate));
        return;
      }
      if (n.alternate && t.isBlockStatement(n.alternate) && n.alternate.body.length === 0) n.alternate = null;
    },
  });

  // pass A2: `let r1 = function f() {}` -> `let f = function f() {}` (then a declaration, pass B):
  // a register or scope slot holding a named nested function is that function's binding
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !/^(r\d+|s\d+_\d+)$/.test(n.id.name) || !t.isFunctionExpression(n.init) || !n.init.id) return;
      const name = n.init.id.name;
      const b = p.scope.getBinding(n.id.name);
      if (!b || b.constantViolations.length || p.scope.hasBinding(name) || b.referencePaths.some((r) => r.scope.hasBinding(name))) return;
      p.scope.rename(n.id.name, name);
      // `let f = function f() {}` -> `function f() {}` right away (with a clean binding)
      const decl = p.parentPath;
      if (decl.isVariableDeclaration() && decl.node.declarations.length === 1 && Array.isArray(decl.container)) {
        const fn = n.init;
        p.scope.removeBinding(name);
        decl.replaceWith(t.functionDeclaration(fn.id, fn.params, fn.body, fn.generator, fn.async));
      }
    },
  });

  // pass B: block-level statement rewrites (manual mutation, no scope info needed)
  traverse.cache.clear();
  traverse(file, {
    'BlockStatement|Program'(path) {
      const body = path.node.body;
      mergeLetDeclarations(body);
      for (let i = 0; i < body.length; i++) {
        const st = body[i];
        if (t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && t.isFunctionExpression(st.declarations[0].init) && st.declarations[0].init.id && st.declarations[0].init.id.name === st.declarations[0].id.name) {
          const fn = st.declarations[0].init;
          body[i] = t.functionDeclaration(fn.id, fn.params, fn.body, fn.generator, fn.async);
        }
      }
    },
    Function(path) {
      const n = path.node;
      if (!t.isBlockStatement(n.body)) return;
      argumentsToParams(path);
      // default parameters: `if (a === undefined) { a = X; }` at the start of the body
      const body = n.body.body;
      const k = leadingBareLets(body);
      while (body.length > k) {
        const st = body[k];
        if (!t.isIfStatement(st) || st.alternate) break;
        const test = st.test;
        if (!t.isBinaryExpression(test, { operator: '===' }) || !t.isIdentifier(test.left) || !t.isIdentifier(test.right, { name: 'undefined' })) break;
        const cons = t.isBlockStatement(st.consequent) ? st.consequent.body : [st.consequent];
        const isSet = (x) => t.isExpressionStatement(x) && t.isAssignmentExpression(x.expression, { operator: '=' }) && t.isIdentifier(x.expression.left, { name: test.left.name });
        let value;
        if (cons.length === 1 && isSet(cons[0])) value = cons[0].expression.right;
        // a default that reads a later parameter in its TDZ: `{ throw new ReferenceError(..); a = undefined; }`
        else if (cons.length === 2 && t.isThrowStatement(cons[0]) && isSet(cons[1])) value = t.callExpression(t.arrowFunctionExpression([], t.blockStatement([cons[0]])), []);
        else break;
        const pi = n.params.findIndex((p) => t.isIdentifier(p, { name: test.left.name }));
        if (pi < 0 || readsBodyBinding(path, value)) break;
        n.params[pi] = t.assignmentPattern(t.identifier(test.left.name), value);
        body.splice(k, 1);
      }
    },
  });

  // pass B2: `let X = p;` where p is a parameter used nowhere else -> use p directly
  const paramPasses = () => {
    for (let i = 0; i < 6; i++) {
      const a = convertDefaultParams(file);
      const b = rewriteBindings(file, mergeParamCopy);
      if (!a && !b) break;
    }
  };
  paramPasses();
  // pass C: propagate single-assignment temp registers holding constant expressions
  rewriteBindings(file, propagateTempBinding);
  // pass D: `r0 = function name(){}` -> `function name(){}`
  rewriteBindings(file, functionHolderBinding);

  paramPasses();
  // destructured parameters, once the register copies are merged into `let r = a0;`
  traverse.cache.clear();
  traverse(file, { Function(p) { if (t.isBlockStatement(p.node.body)) { destructuredParams(p); objectParams(p); } } });
  // pass F: `() => { return x; }` -> `() => x`
  traverse.cache.clear();
  traverse(file, {
    ArrowFunctionExpression(p) {
      const b = p.node.body;
      if (t.isBlockStatement(b) && b.body.length === 1 && t.isReturnStatement(b.body[0]) && b.body[0].argument && !b.directives.length) {
        const arg = b.body[0].argument;
        p.node.body = t.isObjectExpression(arg) || t.isSequenceExpression(arg) ? t.parenthesizedExpression(arg) : arg;
      }
    },
  });

  // pass G: `for (const item of x) { [a, b] = item; ... }` -> `for (const [a, b] of x) { ... }`
  traverse.cache.clear();
  traverse(file, {
    ForOfStatement(p) {
      const n = p.node;
      if (!t.isVariableDeclaration(n.left) || n.left.declarations.length !== 1 || !t.isIdentifier(n.left.declarations[0].id) || !t.isBlockStatement(n.body)) return;
      const item = n.left.declarations[0].id.name;
      const first = n.body.body[0];
      if (!first || !t.isExpressionStatement(first) || !t.isAssignmentExpression(first.expression, { operator: '=' }) || !t.isArrayPattern(first.expression.left) ||
          !t.isIdentifier(first.expression.right, { name: item })) return;
      if (countRefs(t.blockStatement(n.body.body.slice(1)), item)) return;
      const names = [];
      for (const el of first.expression.left.elements) {
        if (el === null) continue;
        const id = t.isAssignmentPattern(el) ? el.left : el;
        if (!t.isIdentifier(id) || names.includes(id.name)) return; // (`const [x, x]` is not valid)
        names.push(id.name);
      }
      const bodyPath = p.get('body');
      for (const nm of names) {
        const b = bodyPath.scope.getBinding(nm);
        if (!b || b.kind !== 'let' || !b.path.isVariableDeclarator() || b.path.node.init) return;
        const inside = (q) => q.findParent((x) => x === bodyPath) !== null;
        if (!b.referencePaths.every(inside) || !b.constantViolations.every((q) => q.node === first.expression || inside(q))) return;
        if (b.constantViolations.some((q) => q.node !== first.expression)) return; // reassigned in the body: keep `let`
      }
      for (const nm of names) {
        const b = bodyPath.scope.getBinding(nm);
        const vd = b.path.parentPath;
        if (vd.node.declarations.length === 1) vd.remove(); else b.path.remove();
      }
      n.left = t.variableDeclaration('const', [t.variableDeclarator(first.expression.left)]);
      n.body.body.shift();
      bodyPath.scope.crawl();
    },
  });

  stripIllegalStrict(file); // default-parameter conversion can make parameter lists non-simple

  // pass E: drop unused synthetic `let` declarations
  traverse.cache.clear();
  traverse(file, {
    VariableDeclaration(path) {
      if (path.parentPath.isForXStatement() && path.key === 'left') return; // `for (let k in o)` needs its binding
      const keep = [];
      for (const d of path.node.declarations) {
        if (!d.init && t.isIdentifier(d.id) && /^(r\d+|s\d+_\d+|_t\d+)$/.test(d.id.name)) {
          const b = path.scope.getBinding(d.id.name);
          if (b && b.references === 0 && b.constantViolations.length === 0) continue;
        }
        keep.push(d);
      }
      if (keep.length === 0) path.remove();
      else path.node.declarations = keep;
    },
  });
  loopCleanup(file);
}

/**
 * `let r5;` (hoisted register declaration) + `r5 = v;` as the first use in some inner block ->
 * `let r5 = v;` there (or `for (let r5 = v; ...)`). Only when every use is inside that block,
 * the assignment is a top-level statement of the block that comes before all other uses, and no
 * closure refers to the variable (a block-level binding is fresh per loop iteration).
 */
function narrowDeclarations(file) {
  for (let round = 0; round < 50; round++) {
    let changed = false;
    traverse.cache.clear();
    traverse(file, {
      VariableDeclarator(p) {
        if (changed) return;
        const n = p.node;
        if (n.init || !t.isIdentifier(n.id) || p.parent.kind !== 'let' || !/^(r\d+|s\d+_\d+|_t\d+)$/.test(n.id.name)) return;
        const name = n.id.name;
        const b = p.scope.getBinding(name);
        if (!b || b.path !== p) return;
        const uses = [...b.referencePaths, ...b.constantViolations];
        if (!uses.length) return;
        if (uses.some((u) => u.findParent((x) => x.isFunction()) !== p.findParent((x) => x.isFunction()))) return;
        // innermost block containing all uses
        const blocksOf = (u) => { const r = []; let q = u.parentPath; while (q && q !== p.parentPath.parentPath) { if (q.isBlockStatement()) r.push(q); q = q.parentPath; } return r; };
        let common = blocksOf(uses[0]);
        for (const u of uses.slice(1)) { const bs = new Set(blocksOf(u).map((x) => x.node)); common = common.filter((x) => bs.has(x.node)); }
        const B = common[0];
        if (!B || B.node === p.parentPath.parent) return;
        // first statement of B that touches the variable
        const stmts = B.get('body');
        const idx = stmts.findIndex((st) => uses.some((u) => u.findParent((x) => x === st)));
        if (idx < 0) return;
        const S = stmts[idx];
        const assign = (e) => t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left, { name }) && !countRefs(e.right, name);
        let replacement = null;
        if (S.isExpressionStatement() && assign(S.node.expression)) {
          replacement = t.variableDeclaration('let', [t.variableDeclarator(t.identifier(name), S.node.expression.right)]);
        } else if (S.isForStatement() && S.node.init && assign(S.node.init) && uses.every((u) => u.findParent((x) => x === S))) {
          S.node.init = t.variableDeclaration('let', [t.variableDeclarator(t.identifier(name), S.node.init.right)]);
          replacement = 'for';
        }
        if (!replacement) return;
        if (replacement !== 'for') S.replaceWith(replacement);
        if (p.parent.declarations.length === 1) p.parentPath.remove(); else p.remove();
        changed = true;
      },
    });
    if (!changed) break;
  }
}

/**
 * Object rest destructuring. The VM reads the named properties one by one and then copies the
 * remaining own properties; the lifter shows the copy as `(({k1: _x0, ...rest}) => rest)(src)`,
 * which would read the named properties a second time (observable through getters / proxies):
 *
 *   const a = src.k1;  const b = src.k2;  const r = (({k1: _x0, k2: _x1, ...rest}) => rest)(src);
 *   ->  const { k1: a, k2: b, ...r } = src;
 */
function mergeObjectRest(file) {
  const keyOf = (m) => (t.isMemberExpression(m) && (!m.computed && t.isIdentifier(m.property) ? m.property.name : m.computed && t.isStringLiteral(m.property) ? m.property.value : null));
  const patKey = (p) => (t.isObjectProperty(p) && !p.computed ? (t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null) : null);
  traverse.cache.clear();
  traverse(file, {
    'BlockStatement|Program'(path) {
      const body = path.node.body;
      for (let j = 0; j < body.length; j++) {
        const st = body[j];
        if (!t.isVariableDeclaration(st) || st.declarations.length !== 1) continue;
        const d = st.declarations[0];
        const call = d.init;
        if (!t.isIdentifier(d.id) || !t.isCallExpression(call) || call.arguments.length !== 1 || !t.isIdentifier(call.arguments[0])) continue;
        const fn = call.callee;
        if (!t.isArrowFunctionExpression(fn) || fn.params.length !== 1 || !t.isObjectPattern(fn.params[0]) || !t.isIdentifier(fn.body)) continue;
        const props = fn.params[0].properties;
        const last = props[props.length - 1];
        if (!t.isRestElement(last) || !t.isIdentifier(last.argument, { name: fn.body.name })) continue;
        const named = props.slice(0, -1);
        const keys = named.map(patKey);
        if (keys.some((k) => k === null) || j < named.length) continue;
        const src = call.arguments[0].name;
        const prev = body.slice(j - named.length, j);
        const ok = prev.every((q, i) => t.isVariableDeclaration(q) && q.declarations.length === 1 && t.isIdentifier(q.declarations[0].id) &&
          t.isMemberExpression(q.declarations[0].init) && t.isIdentifier(q.declarations[0].init.object, { name: src }) && keyOf(q.declarations[0].init) === keys[i]);
        if (!ok) continue;
        const kind = [st, ...prev].some((q) => q.kind === 'let') ? 'let' : st.kind;
        const pattern = t.objectPattern([
          ...named.map((p, i) => t.objectProperty(t.cloneNode(p.key), t.identifier(prev[i].declarations[0].id.name))),
          t.restElement(t.identifier(d.id.name)),
        ]);
        body.splice(j - named.length, named.length + 1, t.variableDeclaration(kind, [t.variableDeclarator(pattern, t.identifier(src))]));
        j -= named.length;
      }
    },
  });
}

/**
 * Loop and temporary cleanups (readability only, each one semantics-preserving):
 *  - `const _t = this;` -> uses of `this` (not across non-arrow function boundaries)
 *  - `while (true) { if (!c) break; ... }` -> `while (c) { ... }`
 *  - `while (c) { ...; i++; }` without a `continue` of this loop -> `for (; c; i++) { ... }`
 *  - `let i = v; for (; ...)` -> `for (let i = v; ...)` if `i` is not used after the loop and no
 *    closure in the loop captures it (a `for` initializer gets per-iteration copies)
 */
function loopCleanup(file) {
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !/^_t\d+$/.test(n.id.name) || !t.isThisExpression(n.init) || p.parent.kind !== 'const') return;
      const b = p.scope.getBinding(n.id.name);
      if (!b || b.constantViolations.length) return;
      const fnOf = (q) => q.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression());
      const home = fnOf(p);
      if (b.referencePaths.some((r) => fnOf(r) !== home)) return;
      for (const r of b.referencePaths) r.replaceWith(t.thisExpression());
      if (p.parent.declarations.length === 1) p.parentPath.remove(); else p.remove();
    },
  });
  const breaksOf = (loop, kind) => {
    // unlabeled break/continue statements that belong to `loop` (not to a nested loop/switch)
    const out = [];
    const walk = (n, depth) => {
      if (!n || typeof n.type !== 'string' || t.isFunction(n)) return;
      if ((t.isBreakStatement(n) && kind === 'break' || t.isContinueStatement(n) && kind === 'continue') && !n.label && depth === 0) out.push(n);
      if ((t.isContinueStatement(n) && kind === 'continue' || t.isBreakStatement(n) && kind === 'break') && n.label) out.push(n); // labelled: checked by caller
      const inner = t.isLoop(n) || (kind === 'break' && t.isSwitchStatement(n));
      for (const k of t.VISITOR_KEYS[n.type] || []) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, depth + (inner ? 1 : 0))); else walk(v, depth + (inner ? 1 : 0)); }
    };
    walk(loop.body, 0);
    return out;
  };
  traverse.cache.clear();
  traverse(file, {
    WhileStatement: {
      exit(p) {
        const n = p.node;
        if (!t.isBlockStatement(n.body)) return;
        const body = n.body.body;
        // while (true) { if (!c) break; ... }
        if (t.isBooleanLiteral(n.test, { value: true }) && body.length && t.isIfStatement(body[0]) && !body[0].alternate) {
          const cons = t.isBlockStatement(body[0].consequent) ? body[0].consequent.body : [body[0].consequent];
          if (cons.length === 1 && t.isBreakStatement(cons[0]) && !cons[0].label) {
            n.test = body[0].test.type === 'UnaryExpression' && body[0].test.operator === '!' ? body[0].test.argument : t.unaryExpression('!', body[0].test);
            body.shift();
          }
        }
        // while (c) { ...; update } -> for
        const last = body[body.length - 1];
        if (!t.isBooleanLiteral(n.test) && last && t.isExpressionStatement(last) && (t.isUpdateExpression(last.expression) || t.isAssignmentExpression(last.expression)) && body.length > 1) {
          const target = t.isUpdateExpression(last.expression) ? last.expression.argument : last.expression.left;
          if (!t.isIdentifier(target) || !countRefs(n.test, target.name)) return;
          const label = t.isLabeledStatement(p.parent) ? p.parent.label.name : null;
          const conts = breaksOf(n, 'continue').filter((c) => !c.label || c.label.name === label);
          if (conts.length) return;
          // the update clause is outside the body's block scope
          const bodyDecls = new Set();
          for (const st of body.slice(0, -1)) if (t.isVariableDeclaration(st) || t.isFunctionDeclaration(st) || t.isClassDeclaration(st)) for (const nm of Object.keys(t.getBindingIdentifiers(st))) bodyDecls.add(nm);
          if ([...bodyDecls].some((nm) => countRefs(last.expression, nm))) return;
          const loop = t.forStatement(null, n.test, last.expression, t.blockStatement(body.slice(0, -1)));
          p.replaceWith(loop);
        }
      },
    },
  });
  mergeObjectRest(file);
  narrowDeclarations(file);
  // `let x = v;` never reassigned -> `const`
  traverse.cache.clear();
  traverse(file, {
    VariableDeclaration(p) {
      if (p.node.kind !== 'let' || t.isForStatement(p.parent) && p.parent.init === p.node) return;
      if (t.isForXStatement(p.parent)) return;
      const ok = p.node.declarations.every((d) => {
        if (!d.init) return false;
        return Object.keys(t.getBindingIdentifiers(d.id)).every((nm) => { const b = p.scope.getBinding(nm); return b && b.constantViolations.length === 0; });
      });
      if (ok) p.node.kind = 'const';
    },
  });
  traverse.cache.clear();
  traverse(file, {
    ForStatement(p) {
      const n = p.node;
      if (n.init) return;
      const holder = t.isLabeledStatement(p.parent) ? p.parentPath : p;
      if (!Array.isArray(holder.container) || holder.key === 0) return;
      const prev = holder.container[holder.key - 1];
      if (!t.isVariableDeclaration(prev) || prev.kind === 'var' || prev.declarations.length !== 1 || !t.isIdentifier(prev.declarations[0].id)) return;
      const name = prev.declarations[0].id.name;
      if (!countRefs(n.test || t.nullLiteral(), name) && !countRefs(n.update || t.nullLiteral(), name)) return;
      const b = p.scope.getBinding(name);
      if (!b) return;
      const inLoop = (r) => r.findParent((x) => x === holder || x.node === n);
      if ([...b.referencePaths, ...b.constantViolations].some((r) => r.node !== prev.declarations[0].id && !inLoop(r))) return;
      if ([...b.referencePaths, ...b.constantViolations].some((r) => inLoop(r) && r.findParent((x) => x.isFunction() && inLoop(x)))) return;
      n.init = t.variableDeclaration(prev.kind, prev.declarations);
      holder.container.splice(holder.key - 1, 1);
      traverse.cache.clear();
      p.stop();
    },
  });
}

/**
 * Repeatedly re-crawl scopes and apply `action(scope, name, binding)` to one
 * binding at a time until no action reports a change. An action changes only the
 * subtree of the scope that owns the binding, so after a change that subtree is
 * skipped until the next round (its paths are stale), while scopes elsewhere in
 * the same round are still processed. One round per change would be quadratic
 * in the size of large bundles.
 */
function rewriteBindings(file, action) {
  let any = false;
  for (let guard = 0; guard < 5000; guard++) {
    let changed = false;
    traverse.cache.clear();
    nameIndex = new WeakMap();
    indexedRoots.clear();
    traverse(file, {
      Scope(path) {
        const scope = path.scope;
        // after a change, re-crawl this scope and continue with its remaining bindings
        let hit = true;
        for (let n = 0; hit && n < 5000; n++) {
          hit = false;
          for (const name of Object.keys(scope.bindings)) {
            if (action(scope, name, scope.bindings[name])) { hit = changed = true; scope.crawl(); break; }
          }
        }
        if (changed) path.skip();
      },
    });
    if (!changed) break;
    any = true;
  }
  return any;
}

/** the single definition of a synthetic `let` binding: {defPath, expr} or null */
function singleDefinition(b) {
  if (b.kind !== 'let' && b.kind !== 'const') return null;
  const cv = b.constantViolations[0];
  if (b.constantViolations.length === 1 && cv.isAssignmentExpression({ operator: '=' }) && t.isIdentifier(cv.node.left, { name: b.identifier.name }) && b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.id) && !b.path.node.init) return { defPath: cv, expr: cv.node.right, viaAssignment: true };
  if (b.constantViolations.length === 0 && b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.id) && b.path.node.init) return { defPath: b.path, expr: b.path.node.init, viaAssignment: false };
  return null;
}

function removeDefinition(b, def) {
  if (def.viaAssignment) {
    if (def.defPath.parentPath.isExpressionStatement()) def.defPath.parentPath.remove();
    else def.defPath.replaceWith(t.cloneNode(def.expr, true)); // `(r = e)` nested in an expression -> `e`
    const vd = b.path.parentPath;
    if (vd.node.declarations.length === 1) vd.remove(); else b.path.remove();
  } else {
    const vd = def.defPath.parentPath;
    if (vd.node.declarations.length === 1) vd.remove(); else def.defPath.remove();
  }
}

function propagateTempBinding(scope, name, b) {
  if (!/^r\d+$/.test(name)) return false;
  const def = singleDefinition(b);
  if (!def || !isConstantExpr(def.expr, scope)) return false;
  const defStmt = def.defPath.getStatementParent();
  const blockPath = defStmt.parentPath;
  const usesThis = referencesThisOrArgs(def.expr);
  for (const ref of b.referencePaths) {
    let p = ref;
    while (p && p.parentPath !== blockPath) p = p.parentPath;
    if (!p || p.key <= defStmt.key) return false;
    if (usesThis && ref.getFunctionParent() !== def.defPath.getFunctionParent()) return false;
  }
  for (const ref of b.referencePaths) ref.replaceWith(t.cloneNode(def.expr, true));
  removeDefinition(b, def);
  return true;
}

function functionHolderBinding(scope, name, b) {
  if (!/^(r\d+|s\d+_\d+)$/.test(name)) return false;
  const def = singleDefinition(b);
  if (!def) return false;
  const rhs = def.expr;
  if (!t.isFunctionExpression(rhs) || !rhs.id) return false;
  const target = rhs.id.name;
  if (target !== name && (scope.hasBinding(target) || scope.hasGlobal(target) || identifierUsedOutside(scope.block, target, rhs))) return false;
  if (target !== name && b.referencePaths.some((r) => r.scope.hasBinding(target))) return false;
  const decl = t.functionDeclaration(t.identifier(target), rhs.params, rhs.body, rhs.generator, rhs.async);
  if (def.viaAssignment) {
    const stmt = def.defPath.getStatementParent();
    if (!stmt.isExpressionStatement()) return false;
    if (target !== name) scope.rename(name, target);
    const vd = b.path.parentPath;
    if (vd.node.declarations.length === 1) vd.remove(); else b.path.remove();
    stmt.replaceWith(decl);
  } else {
    const vd = def.defPath.parentPath;
    if (vd.node.declarations.length !== 1) return false;
    if (target !== name) scope.rename(name, target);
    scope.removeBinding(target);
    vd.replaceWith(decl);
  }
  noteNameAdded(target);
  return true;
}

/** Count the identifier names below `n`, skipping the subtree `skip`. */
function countNames(n, counts = new Map(), skip = null) {
  const walk = (x) => {
    if (!x || typeof x.type !== 'string' || x === skip) return;
    if (x.type === 'Identifier') counts.set(x.name, (counts.get(x.name) || 0) + 1);
    for (const k of t.VISITOR_KEYS[x.type] || []) {
      const v = x[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(n);
  return counts;
}

// identifier counts per scope root, valid for one round of rewriteBindings: the changes of a round
// lie inside the scope being processed, so only names they introduce need to be added
let nameIndex = new WeakMap();
const indexedRoots = new Set();
function noteNameAdded(name) {
  for (const counts of indexedRoots) counts.set(name, (counts.get(name) || 0) + 1);
}

/** Is an identifier named `name` used anywhere inside `root`, outside the function expression `fn`? */
function identifierUsedOutside(root, name, fn) {
  let counts = nameIndex.get(root);
  if (!counts) {
    counts = countNames(root);
    nameIndex.set(root, counts);
    indexedRoots.add(counts);
  }
  const total = counts.get(name) || 0;
  if (!total) return false;
  return total - (countNames(fn).get(name) || 0) > 0;
}

/** `let X = p;` at the top level of p's function, p referenced only there -> rename X to p */
function mergeParamCopy(scope, name, b) {
  if (b.kind !== 'let' && b.kind !== 'const') return false;
  if (!b.path.isVariableDeclarator() || !t.isIdentifier(b.path.node.id) || !t.isIdentifier(b.path.node.init)) return false;
  const declStmt = b.path.parentPath;
  if (declStmt.node.declarations.length !== 1) return false;
  const fn = declStmt.parentPath && declStmt.parentPath.parentPath;
  if (!fn || !fn.isFunction() || declStmt.parentPath !== fn.get('body')) return false;
  const pName = b.path.node.init.name;
  const pb = fn.scope.getBinding(pName);
  if (!pb || pb.kind !== 'param' || pb.references !== 1 || pb.scope !== fn.scope) return false;
  // parameter reassignments before the copy (default values) are fine; after it the copy would diverge
  const declIdx = declStmt.key;
  if (pb.constantViolations.some((cv) => { let q = cv; while (q && q.parentPath !== declStmt.parentPath) q = q.parentPath; return !q || q.key > declIdx; })) return false;
  if (scope !== fn.scope) return false;
  // every use of X must see the parameter p under that name (no shadowing p in nested functions)
  if (b.referencePaths.some((r) => r.scope.getBinding(pName) !== pb)) return false;
  if (b.constantViolations.some((r) => r.scope.getBinding(pName) !== pb)) return false;
  scope.rename(name, pName); // declaration becomes `let p = p;`
  declStmt.remove();
  return true;
}

/** `if (a === undefined) { a = X; }` at the start of a function body -> default parameter `a = X` */
function convertDefaultParams(file) {
  let changed = false;
  traverse.cache.clear();
  traverse(file, {
    Function(path) {
      const n = path.node;
      if (!t.isBlockStatement(n.body)) return;
      const body = n.body.body;
      let i = 0;
      while (i < body.length) {
        const st = body[i];
        const d = defaultCheck(st);
        if (!d) {
          // statements that can stay in front: bare `let x;` declarations, and (if every default
          // after them is a side-effect-free constant) statements such as a host `super(...)`
          if (t.isVariableDeclaration(st) && st.declarations.every((x) => !x.init)) { i++; continue; }
          const nextD = body.slice(i + 1).map(defaultCheck).find(Boolean);
          if (nextD && isInertDefault(nextD.value) && !countRefs(st, nextD.name) && !t.isReturnStatement(st) && !t.isThrowStatement(st) && !containsReturn(st)) { i++; continue; }
          break;
        }
        const pi = n.params.findIndex((p) => t.isIdentifier(p, { name: d.name }) || t.isAssignmentPattern(p) && t.isIdentifier(p.left, { name: d.name }));
        if (pi < 0) break;
        if (i > 0 && !isInertDefault(d.value)) break;
        const later = n.params.slice(pi + 1).map((p) => (t.isIdentifier(p) ? p.name : t.isAssignmentPattern(p) && t.isIdentifier(p.left) ? p.left.name : null)).filter(Boolean);
        if (later.some((nm) => countRefs(d.value, nm))) break;
        const p = n.params[pi];
        if (t.isAssignmentPattern(p)) {
          // the host function already has this default: the check is a no-op
          if (!(isInertDefault(p.right) && generate(p.right).code === generate(d.value).code)) break;
        } else n.params[pi] = t.assignmentPattern(t.identifier(d.name), d.value);
        body.splice(i, 1);
        changed = true;
      }
    },
  });
  return changed;
}

function defaultCheck(st) {
  if (!t.isIfStatement(st) || st.alternate) return null;
  const test = st.test;
  if (!t.isBinaryExpression(test, { operator: '===' }) || !t.isIdentifier(test.left) || !t.isIdentifier(test.right, { name: 'undefined' })) return null;
  const cons = t.isBlockStatement(st.consequent) ? st.consequent.body : [st.consequent];
  if (cons.length !== 1 || !t.isExpressionStatement(cons[0]) || !t.isAssignmentExpression(cons[0].expression, { operator: '=' }) || !t.isIdentifier(cons[0].expression.left, { name: test.left.name })) return null;
  return { name: test.left.name, value: cons[0].expression.right };
}

/** literal-like default values whose evaluation time cannot be observed */
function isInertDefault(e) {
  if (t.isLiteral(e) && !t.isTemplateLiteral(e)) return true;
  if (t.isTemplateLiteral(e)) return e.expressions.length === 0;
  if (t.isIdentifier(e, { name: 'undefined' })) return true;
  if (t.isUnaryExpression(e) && (e.operator === '-' || e.operator === '!' || e.operator === 'void')) return isInertDefault(e.argument);
  if (t.isArrayExpression(e)) return e.elements.every((x) => x && isInertDefault(x));
  if (t.isObjectExpression(e)) return e.properties.every((p) => t.isObjectProperty(p) && !p.computed && isInertDefault(p.value));
  if (t.isArrowFunctionExpression(e)) return true;
  return false;
}

function isConstantExpr(e, scope) {
  if (!e) return false;
  if (t.isThisExpression(e)) return true;
  if (t.isIdentifier(e)) {
    if (e.name === 'undefined') return true;
    const b = scope.getBinding(e.name);
    if (!b) return true; // global
    return b.constant || b.kind === 'hoisted' || (b.kind === 'param' && b.constantViolations.length === 0);
  }
  if (t.isLiteral(e) && !t.isTemplateLiteral(e) && !t.isRegExpLiteral(e)) return true;
  return false;
}

function escapeTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function negate(expr) {
  if (t.isUnaryExpression(expr, { operator: '!' })) return expr.argument;
  if (t.isBinaryExpression(expr)) {
    const inv = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' }[expr.operator];
    if (inv) return t.binaryExpression(inv, expr.left, expr.right);
  }
  return t.unaryExpression('!', expr);
}

/** `let x;` followed (in the same block) by the first use `x = v;` -> `let x = v;` */
function mergeLetDeclarations(body) {
  for (let i = 0; i < body.length; i++) {
    const st = body[i];
    if (!t.isVariableDeclaration(st) || (st.kind !== 'let' && st.kind !== 'var')) continue;
    for (const d of st.declarations) {
      if (d.init || !t.isIdentifier(d.id)) continue;
      const name = d.id.name;
      // find first statement after i referencing name
      for (let j = i + 1; j < body.length; j++) {
        const s2 = body[j];
        const refs = countRefs(s2, name);
        if (refs === 0) continue;
        if (t.isExpressionStatement(s2) && t.isAssignmentExpression(s2.expression, { operator: '=' }) && t.isIdentifier(s2.expression.left, { name }) && countRefs(s2.expression.right, name) === 0) {
          // move the declaration to j
          const rest = st.declarations.filter((x) => x !== d);
          body[j] = t.variableDeclaration(st.kind, [t.variableDeclarator(t.identifier(name), s2.expression.right)]);
          if (rest.length) st.declarations = rest; else { body.splice(i, 1); i--; }
        }
        break;
      }
      if (i < 0) break;
    }
  }
}

function countRefs(node, name) {
  let c = 0;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) c++; });
  return c;
}

module.exports = { assemble, cleanup };
