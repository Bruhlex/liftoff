'use strict';
/**
 * Rewrites driven by Babel's scope analysis, one binding at a time: temporaries holding constant
 * expressions are propagated, function holders become declarations, parameter copies merge.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { containsNode, removeDeclarator, referencesThisOrArgs } = require('../../ast');

/** does a named function expression assign its own name? That name is immutable (an assignment
 *  throws in strict code), the name of a function declaration is not: keep the expression */
const assignsOwnName = (fn) => !!fn.id && containsNode(fn, (x) =>
  (t.isAssignmentExpression(x) && t.isIdentifier(x.left, { name: fn.id.name })) || (t.isUpdateExpression(x) && t.isIdentifier(x.argument, { name: fn.id.name })));

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

module.exports = { rewriteBindings, propagateTempBinding, functionHolderBinding, assignsOwnName };
