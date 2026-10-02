'use strict';
/**
 * Normal form of handler code: undoes syntactic variation that a new code
 * generator could introduce without changing semantics, so that handlers can
 * be compared across builds (role inference in locate.js, signature matching
 * in classify.js).
 */
const t = require('@babel/types');

// test polarity: `if (!c) A else B` -> `if (c) B else A`, `a !== b` -> `a === b`, ...
const INVERT = { '!==': '===', '!=': '==', '>=': '<', '>': '<=' };
const FLIP_REL = { '>': '<', '>=': '<=' };

function canonicalTest(test, cons, alt) {
  let changed = false;
  for (;;) {
    if (t.isUnaryExpression(test, { operator: '!' })) { test = test.argument; [cons, alt] = [alt, cons]; changed = true; continue; }
    if (t.isBinaryExpression(test) && INVERT[test.operator]) { test = t.binaryExpression(INVERT[test.operator], test.left, test.right); [cons, alt] = [alt, cons]; changed = true; continue; }
    break;
  }
  return { test, cons, alt, changed };
}

function fixNode(n) {
  // `x += 1` / `x -= 1` / `x = x + 1`  ->  `x++` / `x--`
  if (t.isAssignmentExpression(n) && (n.operator === '+=' || n.operator === '-=') && t.isNumericLiteral(n.right, { value: 1 }) && (t.isIdentifier(n.left) || t.isMemberExpression(n.left))) {
    return t.updateExpression(n.operator === '+=' ? '++' : '--', n.left, false);
  }
  if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left) && t.isBinaryExpression(n.right) && (n.right.operator === '+' || n.right.operator === '-') &&
      t.isIdentifier(n.right.left, { name: n.left.name }) && t.isNumericLiteral(n.right.right, { value: 1 })) {
    return t.updateExpression(n.right.operator === '+' ? '++' : '--', n.left, false);
  }
  if (t.isIfStatement(n) && n.alternate) {
    const r = canonicalTest(n.test, n.consequent, n.alternate);
    if (r.changed) return t.ifStatement(r.test, r.cons, r.alt);
  }
  if (t.isConditionalExpression(n)) {
    const r = canonicalTest(n.test, n.consequent, n.alternate);
    if (r.changed) return t.conditionalExpression(r.test, r.cons, r.alt);
  }
  // `b > a` -> `a < b`
  if (t.isBinaryExpression(n) && FLIP_REL[n.operator]) return t.binaryExpression(FLIP_REL[n.operator], n.right, n.left);
  return n;
}

function flattenBlocks(list) {
  const out = [];
  for (const st of list) {
    if (t.isBlockStatement(st)) out.push(...flattenBlocks(st.body));
    else out.push(st);
  }
  return out;
}

function splitDecls(list) {
  return list.flatMap((st) => (t.isVariableDeclaration(st) && st.declarations.length > 1 ? st.declarations.map((d) => t.variableDeclaration(st.kind, [d])) : [st]));
}

function walk(n) {
  if (!n || typeof n.type !== 'string') return n;
  let cur = n;
  for (let i = 0; i < 8; i++) { const next = fixNode(cur); if (next === cur) break; cur = next; }
  for (const k of t.VISITOR_KEYS[cur.type] || []) {
    const v = cur[k];
    if (Array.isArray(v)) {
      const mapped = v.map((c) => walk(c));
      cur[k] = (t.isBlockStatement(cur) || t.isSwitchCase(cur) || t.isProgram(cur)) && k !== 'test' ? splitDecls(flattenBlocks(mapped)) : mapped;
    } else if (v && typeof v.type === 'string') cur[k] = walk(v);
  }
  // `if (c) A` with an empty else is just `if (c) A`
  if (t.isIfStatement(cur) && cur.alternate && t.isBlockStatement(cur.alternate) && cur.alternate.body.length === 0) cur.alternate = null;
  return cur;
}

/** Normal form of a statement list (a deep copy; the input is not modified). */
function normalizeStatements(stmts) {
  const wrapper = t.blockStatement(stmts.map((s) => t.cloneNode(s, true)));
  const res = walk(wrapper);
  return splitDecls(flattenBlocks(res.body));
}

/** After canonical renaming: order the operands of symmetric comparisons. */
function sortEqualityOperands(stmt) {
  const generate = require('@babel/generator').default;
  const g = (x) => generate(x, { compact: true }).code;
  t.traverseFast(stmt, (n) => {
    if (t.isBinaryExpression(n) && ['===', '==', '!==', '!='].includes(n.operator)) {
      const a = g(n.left), b = g(n.right);
      if (a > b) { const tmp = n.left; n.left = n.right; n.right = tmp; }
    }
  });
  return stmt;
}

module.exports = { normalizeStatements, sortEqualityOperands, flattenBlocks };
