'use strict';
/**
 * Loops and the declarations around them: `let` declarations moved into the block (or `for`
 * head) that uses them, object rest destructuring, while loops that are for loops.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { removeDeclarator, countIdent: countRefs } = require('../../ast');

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

module.exports = { loopCleanup };
