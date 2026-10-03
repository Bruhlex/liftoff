'use strict';
/**
 * Declarations and statements: named function holders and declarations, `let x; x = v` ->
 * `let x = v`, parameters (defaults, copies, patterns), destructuring loop variables, unused
 * synthetic declarations.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { removeDeclarator, countIdent: countRefs } = require('../../ast');
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

module.exports = { nameFunctionHolders, rewriteBlocks, rewriteParams, restorePatternParams, forOfPatterns, dropUnusedLets };
