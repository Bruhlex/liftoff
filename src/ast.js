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

/** remove a variable declarator, and its declaration when it was the only one */
function removeDeclarator(p) {
  if (p.parentPath.node.declarations.length === 1) p.parentPath.remove(); else p.remove();
}

module.exports = { gen, sameExpr, isIdentName, countIdent, referencesName, countIdentity, replaceIdentity, containsNode, identifiersIn, negate, removeDeclarator, staticKey, iife, thunkValue, exprStmts };
