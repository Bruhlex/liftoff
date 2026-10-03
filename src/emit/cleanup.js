'use strict';
/**
 * Readability passes over the assembled program, run to a fixpoint: `x = x + 1` -> `x++`,
 * `let x; x = v` -> `let x = v`, template literals, declarations moved to where they are used,
 * propagated temporaries, function declarations, loops; and the `"use strict"` directives that
 * the result does not need. They depend neither on the VM nor on the obfuscator.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { containsNode, negate, removeDeclarator, referencesThisOrArgs, countIdent: countRefs } = require('../ast');
const { restoreKeyedDestructuring, argumentsToParams, leadingBareLets, defaultCheck, readsBodyBinding, convertDefaultParams, mergeParamCopy, destructuredParams, objectParams } = require('./params');

// binary operators with a compound assignment form (`a = a op b` -> `a op= b`)
const COMPOUND_OPS = new Set(['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^']);

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
  return containsNode(node, (x) => t.isCallExpression(x) || t.isOptionalCallExpression(x) || t.isNewExpression(x) || t.isAssignmentExpression(x) || t.isUpdateExpression(x) ||
    t.isYieldExpression(x) || t.isAwaitExpression(x) || t.isTaggedTemplateExpression(x) || t.isUnaryExpression(x, { operator: 'delete' }));
}

/** `"use strict"` is a syntax error in functions with default, rest or destructured parameters. */
function stripIllegalStrict(file) {
  t.traverseFast(file, (n) => {
    if (!t.isFunction(n) || !t.isBlockStatement(n.body) || !n.body.directives || !n.body.directives.length) return;
    if (n.params.every((p) => t.isIdentifier(p))) return;
    n.body.directives = n.body.directives.filter((d) => d.value.value !== 'use strict');
  });
}

/** `"use strict"` of a function inside strict code (a strict function, a class, a strict
 *  program) changes nothing: drop it. (It also changes `fn.toString()`: equal functions at
 *  different depths would otherwise print differently.) */
function stripRedundantStrict(file) {
  const isStrictDir = (d) => d.value.value === 'use strict';
  const walk = (n, strict) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isProgram(n)) strict = strict || n.directives.some(isStrictDir);
    if (t.isClass(n)) strict = true;
    if (t.isFunction(n) && t.isBlockStatement(n.body)) {
      if (strict) n.body.directives = n.body.directives.filter((d) => !isStrictDir(d));
      else strict = n.body.directives.some(isStrictDir);
    }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, strict)); else walk(v, strict);
    }
  };
  walk(file.program || file, false);
}

/** does a named function expression assign its own name? That name is immutable (an assignment
 *  throws in strict code), the name of a function declaration is not: keep the expression */
const assignsOwnName = (fn) => !!fn.id && containsNode(fn, (x) =>
  (t.isAssignmentExpression(x) && t.isIdentifier(x.left, { name: fn.id.name })) || (t.isUpdateExpression(x) && t.isIdentifier(x.argument, { name: fn.id.name })));

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
          COMPOUND_OPS.has(n.right.operator)) {
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
      if (t.isIdentifier(r.left, { name: n.left.name }) && COMPOUND_OPS.has(r.operator)) {
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
      if (decl.isVariableDeclaration() && decl.node.declarations.length === 1 && Array.isArray(decl.container) && !assignsOwnName(n.init)) {
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
      restoreKeyedDestructuring(body);
      for (let i = 0; i < body.length; i++) {
        const st = body[i];
        if (t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && t.isFunctionExpression(st.declarations[0].init) && st.declarations[0].init.id && st.declarations[0].init.id.name === st.declarations[0].id.name && !assignsOwnName(st.declarations[0].init)) {
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
        const dc = defaultCheck(body[k]);
        if (!dc) break;
        const { name, value } = dc;
        const pi = n.params.findIndex((p) => t.isIdentifier(p, { name }));
        if (pi < 0 || readsBodyBinding(path, value)) break;
        n.params[pi] = t.assignmentPattern(t.identifier(name), value);
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
        // (a binding reassigned in the body keeps its `let`)
        if (!b.referencePaths.every(inside) || b.constantViolations.some((q) => q.node !== first.expression)) return;
      }
      for (const nm of names) {
        const b = bodyPath.scope.getBinding(nm);
        removeDeclarator(b.path);
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
    // one change per function and traversal: a change leaves that function's scope data stale,
    // other functions (except those nested in it) are unaffected
    const touched = new Set();
    traverse.cache.clear();
    traverse(file, {
      VariableDeclarator(p) {
        if (p.findParent((x) => x.isFunction() && touched.has(x.node)) || (!p.getFunctionParent() && touched.has(file))) return;
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
        const fn = p.getFunctionParent();
        if (replacement !== 'for') S.replaceWith(replacement);
        removeDeclarator(p);
        touched.add(fn ? fn.node : file);
      },
    });
    if (!touched.size) break;
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
      removeDeclarator(p);
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
  // one traversal: a change that enables another one in an already visited scope is picked up by
  // the next call (the cleanup passes run to a fixpoint)
  let changed = false;
  traverse.cache.clear();
  nameIndex = new WeakMap();
  indexedRoots.clear();
  traverse(file, {
    Scope(path) {
      const scope = path.scope;
      // after a change, re-crawl this scope and continue with its remaining bindings
      let hit = true, here = false;
      for (let n = 0; hit && n < 5000; n++) {
        hit = false;
        for (const name of Object.keys(scope.bindings)) {
          if (action(scope, name, scope.bindings[name])) { hit = here = changed = true; scope.crawl(); break; }
        }
      }
      if (here) path.skip();
    },
  });
  return changed;
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
    removeDeclarator(b.path);
  } else {
    removeDeclarator(def.defPath);
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
  if (!t.isFunctionExpression(rhs) || !rhs.id || assignsOwnName(rhs)) return false;
  const target = rhs.id.name;
  if (target !== name && (scope.hasBinding(target) || scope.hasGlobal(target) || identifierUsedOutside(scope.block, target, rhs))) return false;
  if (target !== name && b.referencePaths.some((r) => r.scope.hasBinding(target))) return false;
  const decl = t.functionDeclaration(t.identifier(target), rhs.params, rhs.body, rhs.generator, rhs.async);
  if (def.viaAssignment) {
    const stmt = def.defPath.getStatementParent();
    if (!stmt.isExpressionStatement()) return false;
    if (target !== name) scope.rename(name, target);
    removeDeclarator(b.path);
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

module.exports = { stripIllegalStrict, stripRedundantStrict, cleanup };
