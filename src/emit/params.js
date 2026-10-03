'use strict';
/**
 * Parameters and destructuring as the source wrote them: default values, parameters beyond the
 * function's `length` read through `arguments`, array and object patterns that the compiler
 * lowered to element and property reads, and object destructuring with computed keys.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { sameExpr, iife, exprStmts, isUndef, containsReturn, countIdent: countRefs } = require('../ast');

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

/** k for `if (arguments[k] === undefined) ...`, the VM's default check of parameter k; else -1 */
function argDefaultIndex(st) {
  if (!t.isIfStatement(st) || !t.isBinaryExpression(st.test, { operator: '===' }) || !isUndef(st.test.right)) return -1;
  const m = st.test.left;
  return t.isMemberExpression(m) && m.computed && t.isIdentifier(m.object, { name: 'arguments' }) && t.isNumericLiteral(m.property) ? m.property.value : -1;
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
  // in the VM a parameter beyond `length` and `arguments[k]` are the same storage: in the default
  // value of parameter j, `arguments[k]` with k < j is the earlier parameter k (already set,
  // possibly by its own default), with k >= j a later one, which only the arguments object holds yet
  const defaultValues = new Map(); // default value node -> index of the parameter it initializes
  for (const st of n.body.body.slice(leadingBareLets(n.body.body))) {
    const k = argDefaultIndex(st);
    if (k < 0) break;
    t.traverseFast(st.consequent, (x) => { if (t.isAssignmentExpression(x)) defaultValues.set(x.right, k); });
  }
  let inDefault = null;
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string' || other) return;
    if (node !== n && t.isFunction(node) && !t.isArrowFunctionExpression(node)) return;
    // `delete arguments[i]` has no parameter equivalent
    if (t.isUnaryExpression(node, { operator: 'delete' }) && t.isMemberExpression(node.argument) && t.isIdentifier(node.argument.object, { name: 'arguments' })) { other = true; return; }
    if (t.isIdentifier(node, { name: 'arguments' })) {
      if (t.isMemberExpression(parent) && parent.object === node && parent.computed && t.isNumericLiteral(parent.property) && Number.isInteger(parent.property.value)) {
        // with a non-simple parameter list `arguments` is unmapped: `arguments[i]` of a declared
        // parameter i, and reads of later parameters in default values, stay reads of the arguments object
        const k = parent.property.value;
        if (k >= P && (inDefault === null || k < inDefault)) uses.push(parent);
      } else other = true;
      return;
    }
    const outer = inDefault;
    if (defaultValues.has(node)) inDefault = defaultValues.get(node);
    for (const k of t.VISITOR_KEYS[node.type] || []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node)); else visit(v, node);
    }
    inDefault = outer;
  };
  visit(n.body, null);
  if (other || !uses.length) return;
  // the first missing parameter must get a default, or the `length` would grow
  const first = n.body.body[leadingBareLets(n.body.body)];
  if (argDefaultIndex(first) !== P) return;
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
          if (!(isInertDefault(p.right) && sameExpr(p.right, d.value))) break;
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
  if (!t.isBinaryExpression(test, { operator: '===' }) || !t.isIdentifier(test.left) || !isUndef(test.right)) return null;
  const name = test.left.name;
  const cons = t.isBlockStatement(st.consequent) ? st.consequent.body : [st.consequent];
  const isSet = (x) => t.isExpressionStatement(x) && t.isAssignmentExpression(x.expression, { operator: '=' }) && t.isIdentifier(x.expression.left, { name });
  const last = cons[cons.length - 1];
  if (!last || !isSet(last)) return null;
  if (cons.length === 1) return { name, value: last.expression.right };
  // a default that reads a later parameter in its TDZ: `{ throw new ReferenceError(..); a = undefined; }`
  if (cons.length === 2 && t.isThrowStatement(cons[0])) return { name, value: iife([cons[0]]) };
  // `_ = (a = f, b = g)`: expressions before the parameter's own assignment
  const before = exprStmts(cons.slice(0, -1));
  if (before) return { name, value: t.sequenceExpression([...before, last.expression.right]) };
  return null;
}

/** literal-like default values whose evaluation time cannot be observed */
function isInertDefault(e) {
  if (t.isLiteral(e) && !t.isTemplateLiteral(e)) return true;
  if (t.isTemplateLiteral(e)) return e.expressions.length === 0;
  if (isUndef(e)) return true;
  if (t.isUnaryExpression(e) && (e.operator === '-' || e.operator === '!' || e.operator === 'void')) return isInertDefault(e.argument);
  if (t.isArrayExpression(e)) return e.elements.every((x) => x && isInertDefault(x));
  if (t.isObjectExpression(e)) return e.properties.every((p) => t.isObjectProperty(p) && !p.computed && isInertDefault(p.value));
  if (t.isArrowFunctionExpression(e)) return true;
  return false;
}

module.exports = { argumentsToParams, leadingBareLets, defaultCheck, readsBodyBinding, convertDefaultParams, mergeParamCopy };
