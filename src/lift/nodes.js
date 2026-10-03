'use strict';
/**
 * AST helpers of the lifter: constants and literals, member and key nodes, purity (what may be
 * dropped or substituted), the names a statement writes, fresh synthetic names.
 */

const t = require('@babel/types');
const { isIdentName, referencesName, containsNode, staticKey, isArgumentsSlice, isUndef } = require('../ast');

const NUM_JUMP = new Set(['JMPF', 'JMPT', 'JMPF_KEEP', 'JMPT_KEEP', 'JMPF_POP2', 'JMPT_POP2', 'JMP_NOT_NULLISH', 'JMP_NULLISH', 'FUSED_JMPT', 'FUSED_JMPF', 'COND_TEMPLATE']);

/** a TEMPLATE operand field: the whole operand, its low / high half, or a constant (`#n`) */
const templateField = (f, operand) => (f === 'op' ? operand : f === 'lo' ? operand & 0xffff : f === 'hi' ? operand >>> 16 : Number(String(f).slice(1)));

/** first pc of a try statement's handlers (catch, finally, else the end): where its body ends */
const tryBodyEnd = (tr, fallback = Infinity) => (tr[0] !== null ? tr[0] : tr[1] !== null ? tr[1] : tr[2] !== null ? tr[2] : fallback);

/** does a statement list end in return / throw / break / continue? */
const endsWithJump = (stmts) => stmts.length > 0 && ['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(stmts[stmts.length - 1].type);

/**
 * The loop variable of a for..of / for..in: a first body statement `let x = v` / `x = v` that takes
 * the iteration value `v` (an identifier not used elsewhere) becomes the loop's left side and is
 * removed from the body; otherwise `const v`.
 */
function takeLoopBinding(bodyStmts, valueId) {
  const first = bodyStmts[0];
  if (first && !bodyStmts.slice(1).some((x) => referencesName(x, valueId.name))) {
    if (t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isIdentifier(first.declarations[0].init, { name: valueId.name })) {
      bodyStmts.shift();
      return t.variableDeclaration(first.kind, [t.variableDeclarator(first.declarations[0].id)]);
    }
    if (t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) && t.isIdentifier(first.expression.right, { name: valueId.name })) {
      bodyStmts.shift();
      return first.expression.left;
    }
  }
  return t.variableDeclaration('const', [t.variableDeclarator(valueId)]);
}

/** the expressions of a lifted loop update range; null entries mark statements that are not
 *  expressions (the update then cannot be a `for` clause) */
const updateExpressions = (upd) => [...upd.stmts.map((x) => (t.isExpressionStatement(x) ? x.expression : null)), ...upd.stack.filter((v) => !isPure(v))];

/**
 * A statement an idiom flagged for removal, or `rN = <literal | identifier>` into a register in
 * `names` that only carries an idiom's bookkeeping (a done flag, an iterator, a loop index).
 * `anyValueFor` names a register whose stores are bookkeeping whatever the value.
 */
function isBookkeepingStore(s, names, { literalOnly = false, anyValueFor = null } = {}) {
  if (s.__remove) return true;
  if (!t.isExpressionStatement(s) || !t.isAssignmentExpression(s.expression) || !t.isIdentifier(s.expression.left)) return false;
  const name = s.expression.left.name, v = s.expression.right;
  if (name === anyValueFor) return true;
  return names.has(name) && (t.isLiteral(v) || (!literalOnly && t.isIdentifier(v)));
}

/** a stack entry that stands for no ordinary value: a marker, a literal under construction,
 *  or the `undefined` of an underflow */
const isPseudo = (v) => !!v && !!(v.__marker || v.__builder || v.__underflow);

/** values left on a lifted range's stack that have effects become statements */
function drainImpure(res) {
  for (const v of res.stack) if (!isPure(v)) res.stmts.push(t.expressionStatement(v));
}

/** Registers read / written by a behaviourally inferred template. */
function templateRegEffects(e, operand) {
  const reads = [], writes = [];
  const field = (f) => templateField(f, operand);
  const walk = (x) => {
    if (!x) return;
    if (x.k === 'leaf' && /^R:/.test(x.key)) reads.push(field(x.key.slice(2)));
    if (x.a) walk(x.a);
    if (x.b) walk(x.b);
  };
  (e.pushes || []).forEach(walk);
  (e.writes || []).forEach((w) => { walk(w.expr); if (/^R:/.test(w.target)) writes.push(field(w.target.slice(2))); });
  if (e.cond) walk(e.cond);
  for (const p of [e.taken, e.fall]) if (p) { p.pushes.forEach(walk); }
  return { reads, writes };
}

/** `root == null ? undefined : root.a.b(c)`  ->  `root?.a.b(c)` (null if expr is not a chain on root) */
function optionalChain(expr, root) {
  const links = [];
  let cur = expr;
  for (;;) {
    if (t.isMemberExpression(cur)) { links.push(cur); if (cur.object === root) break; cur = cur.object; continue; }
    if (t.isCallExpression(cur)) { links.push(cur); if (cur.callee === root) break; cur = cur.callee; continue; }
    return null;
  }
  let built = root;
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i];
    const first = i === links.length - 1;
    built = t.isMemberExpression(l) ? t.optionalMemberExpression(built, l.property, l.computed, first) : t.optionalCallExpression(built, l.arguments, first);
  }
  return built;
}

function maxStackLeaf(x) {
  if (!x) return -1;
  let m = -1;
  if (x.k === 'leaf') { const r = /^S:(\d+)$/.exec(x.key); if (r) m = Number(r[1]); }
  return Math.max(m, maxStackLeaf(x.a), maxStackLeaf(x.b));
}

const UNCOND_JUMP = new Set(['JMP', 'JMP_UNWIND']);

// ---------------------------------------------------------------------------
// small AST helpers
// ---------------------------------------------------------------------------

function constNode(c) {
  if (!c) return t.identifier('undefined');
  switch (c.t) {
    case 'string': return t.stringLiteral(c.v);
    case 'number': return numberNode(c.v);
    case 'boolean': return t.booleanLiteral(c.v);
    case 'null': return t.nullLiteral();
    case 'undefined': return t.identifier('undefined');
    case 'bigint': return t.bigIntLiteral(c.v);
    case 'regexp': return t.regExpLiteral(c.source, c.flags);
    case 'symbol': return t.callExpression(t.identifier('Symbol'), c.v === undefined ? [] : [t.stringLiteral(c.v)]);
    default: return t.identifier('undefined');
  }
}

function numberNode(v) {
  if (Number.isNaN(v)) return t.identifier('NaN');
  if (v === Infinity) return t.identifier('Infinity');
  if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
  if (v < 0 || Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(-v));
  return t.numericLiteral(v);
}

function member(obj, key) {
  // key: AST node
  if (t.isStringLiteral(key) && isIdentName(key.value)) return t.memberExpression(obj, t.identifier(key.value));
  return t.memberExpression(obj, key, true);
}

function optMember(obj, key) {
  if (t.isStringLiteral(key) && isIdentName(key.value)) return t.optionalMemberExpression(obj, t.identifier(key.value), false, true);
  return t.optionalMemberExpression(obj, key, true, true);
}

function propKey(key) {
  // returns {key, computed}
  if (t.isStringLiteral(key)) {
    // `__proto__: v` would set the prototype; a defined property of that name needs a computed key
    if (key.value === '__proto__') return { key, computed: true };
    if (isIdentName(key.value)) return { key: t.identifier(key.value), computed: false };
    // (a numeric key only when the number prints as the same string: not `999999999999999999`)
    if (/^(0|[1-9]\d*)$/.test(key.value) && String(Number(key.value)) === key.value) return { key: t.numericLiteral(Number(key.value)), computed: false };
    return { key, computed: false };
  }
  if (t.isNumericLiteral(key)) return { key, computed: false };
  return { key, computed: true };
}

function isPure(node) {
  if (!node) return true;
  if (node.__underflow) return true;
  switch (node.type) {
    case 'Identifier': case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': case 'NullLiteral':
    case 'BigIntLiteral': case 'RegExpLiteral': case 'ThisExpression': case 'Super': case 'MetaProperty':
      return true;
    case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression':
      return true;
    case 'MemberExpression': case 'OptionalMemberExpression':
      return isPure(node.object) && (!node.computed || isPure(node.property));
    case 'UnaryExpression':
      return node.operator !== 'delete' && isPure(node.argument);
    case 'BinaryExpression': case 'LogicalExpression':
      return isPure(node.left) && isPure(node.right);
    case 'ConditionalExpression':
      return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
    case 'ArrayExpression':
      return node.elements.every((e) => !e || isPure(t.isSpreadElement(e) ? e.argument : e));
    case 'ObjectExpression':
      return node.properties.every((p) => (t.isObjectProperty(p) ? isPure(p.value) && (!p.computed || isPure(p.key)) : t.isSpreadElement(p) ? isPure(p.argument) : true));
    case 'TemplateLiteral':
      return node.expressions.every(isPure);
    case 'SequenceExpression':
      return node.expressions.every(isPure);
    default:
      return false;
  }
}

/** may a value be discarded without evaluating it? Only when evaluating it can neither throw nor
 *  run user code: a property read can run a getter, an unknown global read throws, `in` and
 *  `instanceof` throw on primitives and arithmetic on an object calls its `valueOf`. So
 *  `obj.prop;`, `void x;` or `1 != y;` are kept. */
function isDroppable(node) {
  if (!node || node.__underflow) return true;
  const lit = (n) => t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) || t.isBigIntLiteral(n) ||
    isUndef(n) || (t.isUnaryExpression(n) && ['-', '+', '!', 'void'].includes(n.operator) && lit(n.argument) && !(n.operator === '+' && hasBigInt(n.argument)));
  const hasBigInt = (n) => t.isBigIntLiteral(n) || (t.isUnaryExpression(n) && hasBigInt(n.argument));
  switch (node.type) {
    case 'Identifier':
      return !(node.__global && !(node.name in globalThis));
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': case 'NullLiteral': case 'BigIntLiteral': case 'RegExpLiteral':
    case 'ThisExpression': case 'Super': case 'MetaProperty': case 'FunctionExpression': case 'ArrowFunctionExpression':
      return true;
    case 'MemberExpression': case 'OptionalMemberExpression':
      // (a DUP'd member read that is dropped is a compiler artifact, e.g. the `this` of `a.b?.()`)
      return !!node.__dup && isPure(node);
    case 'UnaryExpression':
      if (node.operator === 'delete') return false;
      if (node.operator === 'typeof' && t.isIdentifier(node.argument)) return true;
      if (node.operator === 'void' || node.operator === '!' || node.operator === 'typeof') return isDroppable(node.argument);
      return lit(node) ;
    case 'BinaryExpression':
      if (node.operator === '===' || node.operator === '!==') return isDroppable(node.left) && isDroppable(node.right);
      if (node.operator === 'in' || node.operator === 'instanceof') return false;
      // (BigInt arithmetic throws on a zero divisor or a negative exponent)
      return lit(node.left) && lit(node.right) && !hasBigInt(node.left) && !hasBigInt(node.right);
    case 'LogicalExpression':
      return isDroppable(node.left) && isDroppable(node.right);
    case 'ConditionalExpression':
      return isDroppable(node.test) && isDroppable(node.consequent) && isDroppable(node.alternate);
    case 'SequenceExpression':
      return node.expressions.every(isDroppable);
    case 'ArrayExpression': case 'ObjectExpression': {
      // (a dropped literal is the right side of a destructuring assignment, `[a, b] = [b, a]`, so a
      // member read in it is a compiler artifact); a spread runs an iterator or getters
      const value = (e) => (t.isArrayExpression(e) || t.isObjectExpression(e) || t.isIdentifier(e) ? isDroppable(e) : isPure(e));
      if (t.isArrayExpression(node)) return node.elements.every((e) => !e || (!t.isSpreadElement(e) && value(e)));
      return node.properties.every((p) => (t.isObjectMethod(p) || (t.isObjectProperty(p) && value(p.value))) && (!p.computed || (t.isLiteral(p.key) && !t.isTemplateLiteral(p.key))));
    }
    case 'TemplateLiteral':
      return node.expressions.every(lit);
    default:
      return false;
  }
}

/** `function (k) { let o = {}; o[k] = 0; return k; }`: the lowering's property-key helper, an identity */
function isKeyHelper(fn) {
  if (!t.isFunctionExpression(fn) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return false;
  const p = fn.params[0].name;
  let b = fn.body.body;
  // `let o; o = {};` (register declarations come first at this stage) -> `let o = {};`
  if (b.length === 4 && t.isVariableDeclaration(b[0]) && b[0].declarations.length === 1 && !b[0].declarations[0].init && t.isExpressionStatement(b[1]) &&
      t.isAssignmentExpression(b[1].expression, { operator: '=' }) && t.isIdentifier(b[1].expression.left, { name: b[0].declarations[0].id.name })) {
    b = [t.variableDeclaration('let', [t.variableDeclarator(b[0].declarations[0].id, b[1].expression.right)]), ...b.slice(2)];
  }
  return b.length === 3 && t.isVariableDeclaration(b[0]) && b[0].declarations.length === 1 && t.isObjectExpression(b[0].declarations[0].init) && b[0].declarations[0].init.properties.length === 0 &&
    t.isExpressionStatement(b[1]) && t.isAssignmentExpression(b[1].expression) && t.isMemberExpression(b[1].expression.left) && t.isIdentifier(b[1].expression.left.property, { name: p }) &&
    t.isReturnStatement(b[2]) && t.isIdentifier(b[2].argument, { name: p });
}

/** does code use `arguments` other than in `Array.prototype.slice.call(arguments, n)`? */
function usesArgumentsBeyondSlice(body, n) {
  let all = 0, slices = 0;
  for (const st of body) t.traverseFast(st, (x) => {
    if (t.isIdentifier(x, { name: 'arguments' })) all++;
    if (isArgumentsSlice(x, n)) slices++;
  });
  return all > slices;
}

function assignedNames(stmt) {
  const names = new Set();
  t.traverseFast(stmt, (n) => {
    if (t.isAssignmentExpression(n) && t.isIdentifier(n.left)) names.add(n.left.name);
    if (t.isUpdateExpression(n) && t.isIdentifier(n.argument)) names.add(n.argument.name);
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) names.add(n.id.name);
  });
  return names;
}

/** Property names written by a statement (`a.b = ...`, `a[k]++`, ...); '*' for computed keys. */
function assignedProps(stmt) {
  const props = new Set();
  const note = (m) => {
    if (!t.isMemberExpression(m) && !t.isOptionalMemberExpression(m)) return;
    props.add(staticKey(m) ?? '*');
  };
  t.traverseFast(stmt, (n) => {
    if (t.isAssignmentExpression(n)) note(n.left);
    if (t.isUpdateExpression(n)) note(n.argument);
    if (t.isUnaryExpression(n, { operator: 'delete' })) note(n.argument);
  });
  return props;
}

function readsProps(v, props) {
  if (!props.size) return false;
  let hit = false;
  t.traverseFast(v, (n) => {
    if (hit || (!t.isMemberExpression(n) && !t.isOptionalMemberExpression(n))) return;
    if (props.has('*')) { hit = true; return; }
    const name = staticKey(n);
    if (name === null || props.has(name)) hit = true;
  });
  return hit;
}

function containsCall(node) {
  return containsNode(node, (n) => t.isCallExpression(n) || t.isNewExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n));
}

// ---------------------------------------------------------------------------
// Lifter
// ---------------------------------------------------------------------------

// names occurring in the host program (and the VM runtime): synthetic names must not capture them
let HOST_NAMES = new Set();
/** names of the host program (and the VM runtime), which synthetic names must not capture */
const setHostNames = (names) => { HOST_NAMES = names; };
const isHostName = (name) => HOST_NAMES.has(name);

const fresh = (n) => { while (HOST_NAMES.has(n)) n += "_"; return n; };

module.exports = { NUM_JUMP, templateField, tryBodyEnd, endsWithJump, takeLoopBinding, updateExpressions, isBookkeepingStore, isPseudo, drainImpure, templateRegEffects, optionalChain, maxStackLeaf, UNCOND_JUMP, constNode, member, optMember, propKey, isPure, isDroppable, isKeyHelper, usesArgumentsBeyondSlice, assignedNames, assignedProps, readsProps, containsCall, fresh, setHostNames, isHostName };
