// Small AST helpers shared by the lifter and the emitter.
'use strict';

const t = require('@babel/types');
const generate = require('@babel/generator').default;

/** compact source text of a node, used to compare expressions */
const gen = (node) => generate(node, { compact: true, comments: false }).code;

/** the same expression: one node (a DUP'd value) or equal source text */
const sameExpr = (a, b) => a === b || (!!a && !!b && gen(a) === gen(b));

const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));
const isIdentName = (s) => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s) && !RESERVED.has(s);

function countIdent(nodes, name) {
  let c = 0;
  for (const n of [].concat(nodes)) t.traverseFast(n, (x) => { if (t.isIdentifier(x, { name })) c++; });
  return c;
}

function referencesName(node, name) {
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) hit = true; });
  return hit;
}

function countIdentity(tree, node) {
  let c = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n === node) { c++; return; }
    for (const k of t.VISITOR_KEYS[n.type] || []) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v); }
  };
  walk(tree);
  return c;
}

function replaceIdentity(tree, node, rep) {
  if (tree === node) return rep;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x, i) => { if (x === node) v[i] = t.cloneNode(rep); else walk(x); });
      else if (v === node) n[k] = t.cloneNode(rep);
      else walk(v);
    }
  };
  walk(tree);
  return tree;
}

/** does any node below `root` (itself included) satisfy `pred`? Subtrees whose root satisfies
 *  `skip` (checked first, also for `root`) are not looked into. */
function containsNode(root, pred, skip = null) {
  if (!skip) {
    let hit = false;
    t.traverseFast(root, (n) => { if (!hit && pred(n)) hit = true; });
    return hit;
  }
  const walk = (n) => {
    if (!n || typeof n.type !== 'string' || skip(n)) return false;
    if (pred(n)) return true;
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v) ? v.some(walk) : walk(v)) return true;
    }
    return false;
  };
  return walk(root);
}

/** error texts of the private-member lowering: any of its checks (`Cannot read private field`, ...) */
const PRIVATE_ERROR = /private (member|method|field)/;
/** the text of a brand check proper, which reads a member or calls a method; installing the brand
 *  of a #method (`Cannot install private method`) is a different helper */
const isBrandCheckMessage = (s) => /private (member|method)/.test(s) && !/install private/.test(s);

/** replace every node below `root` that satisfies `pred` by `make(node)` (not looking into
 *  subtrees whose root satisfies `skip`, nor into replaced nodes); returns how many were replaced */
function replaceWhere(root, pred, make, skip = null) {
  let count = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string' || (skip && skip(n))) return;
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c, i) => { if (c && pred(c)) { v[i] = make(c); count++; } else walk(c); });
      else if (v && typeof v.type === 'string') { if (pred(v)) { n[k] = make(v); count++; } else walk(v); }
    }
  };
  walk(root);
  return count;
}

/** `Array.prototype.slice.call(arguments, n)`: how the compiler reads a rest parameter after n
 *  named ones */
const isArgumentsSlice = (x, n) => t.isCallExpression(x) && x.arguments.length === 2 && t.isIdentifier(x.arguments[0], { name: 'arguments' }) &&
  t.isNumericLiteral(x.arguments[1], { value: n }) && t.isMemberExpression(x.callee) && t.isIdentifier(x.callee.property, { name: 'call' }) &&
  t.isMemberExpression(x.callee.object) && t.isIdentifier(x.callee.object.property, { name: 'slice' }) &&
  t.isMemberExpression(x.callee.object.object) && t.isIdentifier(x.callee.object.object.property, { name: 'prototype' }) &&
  t.isIdentifier(x.callee.object.object.object, { name: 'Array' });

/** a function with its own `arguments` (an arrow uses the enclosing one) */
const hasOwnArguments = (n) => t.isFunction(n) && !t.isArrowFunctionExpression(n);

/** the identifier `undefined` */
const isUndef = (n) => t.isIdentifier(n, { name: 'undefined' });

/** the names of all identifiers below `root` */
function identifiersIn(root) {
  const names = new Set();
  t.traverseFast(root, (n) => { if (t.isIdentifier(n)) names.add(n.name); });
  return names;
}

/** `!expr`, simplified where that is exact. (`!(a < b)` is not `a >= b`: both are false
 *  for NaN, so relational comparisons keep the `!`.) */
function negate(expr) {
  if (t.isUnaryExpression(expr, { operator: '!' })) return expr.argument;
  const inv = t.isBinaryExpression(expr) && { '===': '!==', '!==': '===', '==': '!=', '!=': '==' }[expr.operator];
  if (inv) return t.binaryExpression(inv, expr.left, expr.right);
  if (t.isBooleanLiteral(expr)) return t.booleanLiteral(!expr.value);
  return t.unaryExpression('!', expr);
}

/** the name a member expression reads when it is static (`o.k`, `o["k"]`), else null */
const staticKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : null);

/** `(() => { stmts })()` */
const iife = (stmts) => t.callExpression(t.arrowFunctionExpression([], t.blockStatement(stmts)), []);

/** the value of a thunk body: the returned expression of a lone `return`, else the body run as an iife */
const thunkValue = (stmts) => (stmts.length === 1 && t.isReturnStatement(stmts[0]) ? stmts[0].argument || t.identifier('undefined') : iife(stmts));

/** the expressions of a statement list made only of expression statements, else null */
const exprStmts = (stmts) => (stmts.every((s) => t.isExpressionStatement(s)) ? stmts.map((s) => s.expression) : null);

/** the declarator of `let|const x = init` (one identifier; `var` too unless `notVar`) or null */
const singleDeclarator = (st, { requireInit = true, notVar = false } = {}) =>
  (t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && (!notVar || st.kind !== 'var') &&
    (!requireInit || st.declarations[0].init) ? st.declarations[0] : null);

/** the assignment of an `x = v;` statement (operator `=`), or null */
const plainAssign = (st) => (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) ? st.expression : null);

/** remove a variable declarator, and its declaration when it was the only one */
function removeDeclarator(p) {
  if (p.parentPath.node.declarations.length === 1) p.parentPath.remove(); else p.remove();
}

/** Does a predicate hold for some node in `stmts`, not looking into nested functions or classes? */
function containsOwn(stmts, pred) {
  return stmts.some((s) => containsNode(s, pred, (n) => t.isFunction(n) || t.isClass(n)));
}

/** a return statement of this function (returns of nested functions don't count) */
const containsReturn = (node) => containsOwn([node], (n) => t.isReturnStatement(n));

function referencesThisOrArgs(node) {
  return containsNode(node, (n) => t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }) || t.isMetaProperty(n),
    (n) => t.isFunction(n) && !t.isArrowFunctionExpression(n));
}

module.exports = { containsOwn, containsReturn, referencesThisOrArgs, gen, sameExpr, isIdentName, countIdent, referencesName, countIdentity, replaceIdentity, containsNode, identifiersIn, negate, removeDeclarator, staticKey, iife, thunkValue, exprStmts, PRIVATE_ERROR, isBrandCheckMessage, singleDeclarator, plainAssign, replaceWhere, isArgumentsSlice, hasOwnArguments, isUndef };
