'use strict';
/**
 * Normal form of handler code: undoes syntactic variation that a new code
 * generator could introduce without changing semantics, so that handlers can
 * be compared across builds (role inference in locate.js, signature matching
 * in classify.js).
 */
const t = require('@babel/types');
const generate = require('@babel/generator').default;

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

// a literal without side effects: only identifiers, literals and nested literals of those
function inertLiteral(n) {
  if (t.isIdentifier(n) || t.isLiteral(n) && !t.isTemplateLiteral(n)) return true;
  if (t.isUnaryExpression(n) && (n.operator === '-' || n.operator === '!' || n.operator === 'void')) return inertLiteral(n.argument);
  if (t.isArrayExpression(n)) return n.elements.every((e) => !e || inertLiteral(e));
  if (t.isObjectExpression(n)) return n.properties.every((p) => t.isObjectProperty(p) && !p.computed && inertLiteral(p.value));
  // reads and arithmetic on them (handler code: `x[0] >= 0 ? x[0] : undefined`)
  if (t.isMemberExpression(n)) return inertLiteral(n.object) && (!n.computed || inertLiteral(n.property));
  if (t.isBinaryExpression(n) || t.isLogicalExpression(n)) return inertLiteral(n.left) && inertLiteral(n.right);
  if (t.isConditionalExpression(n)) return inertLiteral(n.test) && inertLiteral(n.consequent) && inertLiteral(n.alternate);
  return false;
}

/**
 * `var o = {get: f, enumerable: false}; Object.defineProperty(x, k, o);` -> the literal at its
 * single use. The obfuscator's key transformation (transformObjectKeys) moves object literals out
 * of their expressions, also in the VM's own handlers.
 */
function inlineLiteralVars(list, root) {
  const count = (name) => { let k = 0; t.traverseFast(root, (n) => { if (t.isIdentifier(n, { name })) k++; }); return k; };
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (!t.isVariableDeclaration(st) || st.declarations.length !== 1) continue;
    const d = st.declarations[0];
    if (!t.isIdentifier(d.id) || !(t.isObjectExpression(d.init) || t.isArrayExpression(d.init)) || !inertLiteral(d.init)) continue;
    if (count(d.id.name) !== 2) continue; // the declaration and one use
    const reads = new Set();
    t.traverseFast(d.init, (n) => { if (t.isIdentifier(n)) reads.add(n.name); });
    // the use must be in a later statement of this list, with no write to what the literal reads in between
    let target = null;
    for (let j = i + 1; j < list.length && !target; j++) {
      let used = false, written = false;
      t.traverseFast(list[j], (n) => {
        if (t.isIdentifier(n, { name: d.id.name })) used = true;
        if ((t.isAssignmentExpression(n) && t.isIdentifier(n.left) && reads.has(n.left.name)) || (t.isUpdateExpression(n) && t.isIdentifier(n.argument) && reads.has(n.argument.name))) written = true;
      });
      if (used) target = written ? 'blocked' : list[j];
      else if (written) target = 'blocked';
    }
    if (!target || target === 'blocked') continue;
    let done = false;
    const replace = (n) => {
      if (!n || typeof n.type !== 'string' || done) return;
      for (const k of t.VISITOR_KEYS[n.type] || []) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c, idx) => { if (!done && t.isIdentifier(c, { name: d.id.name })) { v[idx] = d.init; done = true; } else replace(c); });
        else if (v && typeof v.type === 'string') { if (!done && t.isIdentifier(v, { name: d.id.name }) && !(t.isMemberExpression(n) && k === 'property' && !n.computed)) { n[k] = d.init; done = true; } else replace(v); }
      }
    };
    replace(target);
    if (done) { list.splice(i, 1); i--; }
  }
  return list;
}

/** Normal form of a statement list (a deep copy; the input is not modified). */
function normalizeStatements(stmts) {
  const wrapper = t.blockStatement(stmts.map((s) => t.cloneNode(s, true)));
  const res = walk(wrapper);
  const out = splitDecls(flattenBlocks(res.body));
  const root = t.blockStatement(out);
  // also inside nested blocks of the handler
  t.traverseFast(root, (n) => { if (t.isBlockStatement(n) && n !== root) inlineLiteralVars(n.body, root); });
  return inlineLiteralVars(out, root);
}

/** After canonical renaming: order the operands of symmetric comparisons. */
function sortEqualityOperands(stmt) {
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
