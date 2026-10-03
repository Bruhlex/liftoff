'use strict';
/**
 * Local expression rewrites: short-circuits the lifter had to spell out, `x = x + 1` -> `x++`,
 * `a = a op b` -> `a op= b`, string concatenation -> template literals, `() => { return x; }`
 * -> `() => x`.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { containsNode, negate } = require('../../ast');

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

/** local expression rewrites */
function rewriteExpressions(file) {
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
}

/** `() => { return x; }` -> `() => x` */
function arrowExpressionBodies(file) {
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
}

function escapeTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

module.exports = { rewriteExpressions, arrowExpressionBodies };
