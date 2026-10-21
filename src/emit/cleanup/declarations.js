'use strict';
/**
 * Declarations and statements: named function holders and declarations, `let x; x = v` ->
 * `let x = v`, parameters (defaults, copies, patterns), destructuring loop variables, unused
 * synthetic declarations.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { removeDeclarator, countIdent: countRefs, isIdentName, isUndef } = require('../../ast');
const { argumentsToParams, leadingBareLets, defaultCheck, readsBodyBinding, convertDefaultParams, mergeParamCopy } = require('../params');
const { restoreKeyedDestructuring, destructuredParams, objectParams } = require('../patterns');
const { rewriteBindings, assignsOwnName } = require('./bindings');

/** `let r1 = function f() {}` -> `let f = function f() {}` (then a declaration, see rewriteBlocks):
 *  a register or scope slot holding a named nested function is that function's binding */
function nameFunctionHolders(file) {
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
}

/**
 * >= 8.4 gives every closure the name the source infers for it (`const arrow = () => {}`,
 * `const { arrow = () => {} } = o`), and a register holding it has only a synthetic name. When such a
 * register is declared with the closure as its value, or as the default of a property read
 * (`o.k === undefined ? f : o.k`), the register gets the closure's name; the default read becomes a
 * destructuring default again when its source is side-effect free, which is where JavaScript infers
 * that name.
 */
function nameRegistersByClosure(file) {
  const isClosure = (n) => (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) || t.isClassExpression(n)) && typeof n.__inferredName === 'string';
  const pure = (e) => t.isIdentifier(e) || t.isLiteral(e) && !t.isTemplateLiteral(e) || (t.isObjectExpression(e) && !e.properties.length) || (t.isArrayExpression(e) && !e.elements.length);
  const keyOf = (m) => (t.isMemberExpression(m) && !m.computed && t.isIdentifier(m.property) ? m.property.name : t.isMemberExpression(m) && m.computed && t.isStringLiteral(m.property) ? m.property.value : null);
  const synthetic = (id) => t.isIdentifier(id) && /^(r\d+|s\d+_\d+)_*$/.test(id.name);
  // the closure a binding receives at `node` (a value, or the default of a property read)
  const closureIn = (v) => {
    if (isClosure(v)) return v;
    if (t.isConditionalExpression(v) && t.isBinaryExpression(v.test, { operator: '===' }) && isUndef(v.test.right) && isClosure(v.consequent)) return v.consequent;
    return null;
  };
  // rename the binding of `id` (seen at path p) to the closure's name, if every closure it ever
  // receives carries that same name (registers are reused) and nothing in scope shadows it
  const rename = (p, id, fn) => {
    const name = fn.__inferredName;
    const b = p.scope.getBinding(id.name);
    if (!isIdentName(name) || !b || b.scope.hasBinding(name) || b.referencePaths.some((r) => r.scope.hasBinding(name))) return false;
    // a function or class with its own name: that name is not one the binding gave it
    if ((t.isFunctionExpression(fn) || t.isClassExpression(fn)) && fn.id) return false;
    const values = [b.path.isVariableDeclarator() ? b.path.node.init : null, ...b.constantViolations.map((v) => (v.isAssignmentExpression() ? v.node.right : null))];
    if (values.some((v) => { const c = v && closureIn(v); return c && c.__inferredName !== name; })) return false;
    b.scope.rename(id.name, name);
    return true;
  };
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!synthetic(n.id) || !n.init) return;
      const fn = closureIn(n.init);
      if (!fn) return;
      let deflt = null;
      if (fn !== n.init) {
        const a = n.init.test.left, b = n.init.alternate;
        const k = keyOf(a);
        if (!(k && keyOf(b) === k && t.isNodesEquivalent(a, b))) return;
        if (pure(a.object)) deflt = { k, src: a.object };
      }
      if (!rename(p, n.id, fn)) return;
      const name = fn.__inferredName;
      if (deflt && p.parentPath.isVariableDeclaration() && p.parentPath.node.kind !== 'var') {
        const key = isIdentName(deflt.k) ? t.identifier(deflt.k) : t.stringLiteral(deflt.k);
        p.node.id = t.objectPattern([t.objectProperty(key, t.assignmentPattern(t.identifier(name), fn), false, deflt.k === name)]);
        p.node.init = deflt.src;
      }
    },
    // `r = f` (a register assigned later), and `{ k: r = f }` / `[r = f]` / `(r = f) =>` defaults
    AssignmentExpression(p) {
      // (only a closure itself: a default read is renamed once it has become a declaration, which
      // then restores the destructuring as well)
      if (p.node.operator === '=' && synthetic(p.node.left) && isClosure(p.node.right)) rename(p, p.node.left, p.node.right);
    },
    AssignmentPattern(p) {
      if (synthetic(p.node.left) && isClosure(p.node.right)) rename(p, p.node.left, p.node.right);
    },
  });
}

/**
 * >= 8.4: where JavaScript infers a function's name from its position (`x = f`, `{ k: f }`,
 * `k = f` in a class, a default `x = f`), a closure whose run-time name differs (the source had
 * `x = (0, function () {})`, or the binding was renamed) is written `(0, f)`, which infers nothing.
 * Run once, after all other renames.
 */
function keepRuntimeNames(file) {
  let changed = 0;
  const anon = (n) => (t.isArrowFunctionExpression(n) || ((t.isFunctionExpression(n) || t.isClassExpression(n)) && !n.id)) && typeof n.__inferredName === 'string';
  const check = (holder, key, name) => {
    const v = holder[key];
    if (!anon(v) || name === null || v.__inferredName === name) return;
    holder[key] = t.sequenceExpression([t.numericLiteral(0), v]);
    changed++;
  };
  const keyName = (n) => (n.computed ? null : t.isIdentifier(n.key) ? n.key.name : t.isStringLiteral(n.key) ? n.key.value : t.isPrivateName(n.key) ? '#' + n.key.id.name : null);
  t.traverseFast(file, (n) => {
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && n.init) check(n, 'init', n.id.name);
    else if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left)) check(n, 'right', n.left.name);
    else if (t.isAssignmentPattern(n) && t.isIdentifier(n.left)) check(n, 'right', n.left.name);
    else if (t.isObjectProperty(n) && !n.shorthand) check(n, 'value', keyName(n));
    else if ((t.isClassProperty(n) || t.isClassPrivateProperty(n)) && n.value) check(n, 'value', keyName(n));
  });
  return changed;
}

/** block-level statement rewrites (manual mutation, no scope info needed) */
function rewriteBlocks(file) {
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
          // the crawled scope still holds the declarator's binding; drop it, or entering the new
          // declaration collides with it (`const f = function f() {}` in >= 8.4 builds)
          const own = path.scope.getOwnBinding(fn.id.name);
          if (own && own.path.node === st.declarations[0]) path.scope.removeOwnBinding(fn.id.name);
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
}

/** `let X = p;` where p is a parameter used nowhere else -> use p directly; default parameters.
 *  The two enable each other: iterate. */
function rewriteParams(file) {
  for (let i = 0; i < 6; i++) {
    const a = convertDefaultParams(file);
    const b = rewriteBindings(file, mergeParamCopy);
    if (!a && !b) break;
  }
}

/** destructured parameters, once the register copies are merged into `let r = a0;` */
function restorePatternParams(file) {
  traverse.cache.clear();
  traverse(file, { Function(p) { if (t.isBlockStatement(p.node.body)) { destructuredParams(p); objectParams(p); } } });
}

/** `for (const item of x) { [a, b] = item; ... }` -> `for (const [a, b] of x) { ... }` */
function forOfPatterns(file) {
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
}

/** drop unused synthetic `let` declarations */
function dropUnusedLets(file) {
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

module.exports = { nameFunctionHolders, nameRegistersByClosure, keepRuntimeNames, rewriteBlocks, rewriteParams, restorePatternParams, forOfPatterns, dropUnusedLets };
