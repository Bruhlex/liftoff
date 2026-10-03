'use strict';
/**
 * Class fields that the compiler moved out of the class body: instance field initializers run
 * from the constructor (after super() in a derived class) are folded back into field
 * declarations, and computed member keys that read a private name go back into the class.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { containsNode, removeDeclarator, isUndef } = require('../ast');

/**
 * A computed member key is evaluated ahead of the class into a temporary; one that reads a private
 * name of the class (`[this.#f] = 1`) is only valid inside the class, so it goes back into the key:
 *   const k = this.#f; class C { [k] = 1; get #f() {} }   ->   class C { [this.#f] = 1; ... }
 */
function inlinePrivateComputedKeys(file) {
  const hasPrivate = (e) => containsNode(e, (x) => t.isPrivateName(x));
  // the single reference is the computed key of a class member: put the expression there
  const inlineInto = (b, init) => {
    if (!b || b.referencePaths.length !== 1) return false;
    const ref = b.referencePaths[0];
    const member = ref.parentPath;
    if (!(member.isClassProperty() || member.isClassMethod() || member.isClassPrivateProperty()) || member.node.key !== ref.node || !member.node.computed) return false;
    ref.replaceWith(init);
    return true;
  };
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !n.init || !hasPrivate(n.init) || p.parentPath.node.declarations.length !== 1) return;
      const b = p.scope.getBinding(n.id.name);
      if (b && !b.constantViolations.length && inlineInto(b, n.init)) p.parentPath.remove();
    },
    // `let k; ... k = this.#f;`
    AssignmentExpression(p) {
      const n = p.node;
      if (n.operator !== '=' || !t.isIdentifier(n.left) || !hasPrivate(n.right) || !p.parentPath.isExpressionStatement()) return;
      const b = p.scope.getBinding(n.left.name);
      if (!b || b.constantViolations.length !== 1 || !b.path.isVariableDeclarator() || (b.path.node.init && !isUndef(b.path.node.init))) return;
      if (!inlineInto(b, n.right)) return;
      p.parentPath.remove();
      removeDeclarator(b.path);
    },
  });
}

/**
 * Instance fields of a derived class are initialized after `super()` by a function the compiler
 * creates outside the class and the constructor calls as `init.call(this)`:
 *
 *   const init = function () { const set = (x) => { <brand>; return this.#f = x; }; set(v); this.p = w; };
 *   class C extends B { constructor() { super(); init.call(this); ... } }
 *
 * When every statement of `init` is such a field setup, it becomes the field declarations
 * `#f = v; p = w;` of the class again (fields of a derived class run right after super()).
 */
function foldDerivedFieldInitializers(file) {
  traverse.cache.clear();
  traverse(file, {
    Class(cp) {
      const body = cp.node.body.body;
      const ctor = body.find((m) => t.isClassMethod(m, { kind: 'constructor' }));
      if (!ctor) return;
      // a base class runs its initializer first, a derived class right after super(), which may
      // also be called from an arrow function in the constructor (`const init = () => super();`)
      const isSuperCall = (st) => t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isSuper(st.expression.callee);
      let stmts = ctor.body.body;
      let superIdx = -1;
      if (cp.node.superClass) {
        superIdx = stmts.findIndex(isSuperCall);
        if (superIdx < 0) {
          t.traverseFast(ctor.body, (x) => {
            if (superIdx >= 0 || !t.isArrowFunctionExpression(x) || !t.isBlockStatement(x.body)) return;
            const k = x.body.body.findIndex(isSuperCall);
            if (k >= 0) { stmts = x.body.body; superIdx = k; }
          });
        }
        if (superIdx < 0) return;
      }
      // (uninitialized `let x;` declarations may come first; they have no effect)
      let callIdx = superIdx + 1;
      while (callIdx < stmts.length && t.isVariableDeclaration(stmts[callIdx]) && stmts[callIdx].declarations.every((d) => !d.init)) callIdx++;
      const callSt = stmts[callIdx];
      const call = callSt && t.isExpressionStatement(callSt) && t.isCallExpression(callSt.expression) ? callSt.expression : null;
      const isCallKey = (m) => (!m.computed && t.isIdentifier(m.property, { name: 'call' })) || (m.computed && t.isStringLiteral(m.property, { value: 'call' }));
      if (!call || !t.isMemberExpression(call.callee) || !isCallKey(call.callee) || !t.isIdentifier(call.callee.object) ||
          call.arguments.length !== 1 || !t.isThisExpression(call.arguments[0])) return;
      const b = cp.scope.getBinding(call.callee.object.name);
      if (!b || !b.path.isVariableDeclarator() || b.constantViolations.length || b.referencePaths.length !== 1) return;
      const fn = b.path.node.init;
      if (!t.isFunctionExpression(fn) || fn.params.length || fn.async || fn.generator) return;
      // brand bookkeeping of the WeakMap lowering: `C.wm.has(this) || C.wm.set(this, ...)`
      const isBrand = (st) => t.isExpressionStatement(st) && t.isLogicalExpression(st.expression, { operator: '||' }) &&
        t.isCallExpression(st.expression.left) && t.isMemberExpression(st.expression.left.callee) &&
        (t.isIdentifier(st.expression.left.callee.property, { name: 'has' }) || t.isStringLiteral(st.expression.left.callee.property, { value: 'has' }));
      const setters = new Map(); // arrow name -> private name
      const fields = [];
      const brandKeys = []; // `const k = "__vmwm__$pib_N"` naming the brand slot
      for (const st of fn.body.body) {
        if (isBrand(st)) continue;
        // `let set;` declared ahead of its assignment
        if (t.isVariableDeclaration(st) && st.declarations.every((d) => t.isIdentifier(d.id) && !d.init)) continue;
        // const set = (x) => { <brand>; return this.#f = x; }   or   set = (x) => ...
        const setterDecl = t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && t.isArrowFunctionExpression(st.declarations[0].init)
          ? { name: st.declarations[0].id.name, a: st.declarations[0].init }
          : t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isIdentifier(st.expression.left) && t.isArrowFunctionExpression(st.expression.right)
            ? { name: st.expression.left.name, a: st.expression.right } : null;
        if (setterDecl) {
          const a = setterDecl.a;
          if (a.params.length !== 1 || !t.isIdentifier(a.params[0])) return;
          const p = a.params[0].name;
          const ret = t.isBlockStatement(a.body) ? a.body.body : [t.returnStatement(a.body)];
          if (!ret.slice(0, -1).every(isBrand)) return;
          const last = ret[ret.length - 1];
          const e = t.isReturnStatement(last) ? last.argument : null;
          if (!e || !t.isAssignmentExpression(e, { operator: '=' }) || !t.isMemberExpression(e.left) || !t.isThisExpression(e.left.object) ||
              !t.isPrivateName(e.left.property) || !t.isIdentifier(e.right, { name: p })) return;
          setters.set(setterDecl.name, e.left.property.id.name);
          continue;
        }
        // set(v)
        if (t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isIdentifier(st.expression.callee) && setters.has(st.expression.callee.name) && st.expression.arguments.length === 1) {
          const v = st.expression.arguments[0];
          fields.push(t.classPrivateProperty(t.privateName(t.identifier(setters.get(st.expression.callee.name))), isUndef(v) ? null : v));
          continue;
        }
        // this[__vmwm__$pib_N] = <install brand>: the brand of the class's #methods, implicit in the class
        if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isMemberExpression(st.expression.left) &&
            t.isThisExpression(st.expression.left.object) && st.expression.left.computed) {
          let install = false;
          t.traverseFast(st.expression.right, (x) => { if (t.isStringLiteral(x) && /install private/.test(x.value)) install = true; });
          if (install) { if (t.isIdentifier(st.expression.left.property)) brandKeys.push(st.expression.left.property.name); continue; }
        }
        // this.p = w
        if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isMemberExpression(st.expression.left) &&
            t.isThisExpression(st.expression.left.object)) {
          const l = st.expression.left;
          const v = st.expression.right;
          fields.push(t.classProperty(l.property, isUndef(v) ? null : v, null, null, l.computed));
          continue;
        }
        return; // anything else: leave as it is
      }
      if (!fields.length && !brandKeys.length) return;
      cp.node.body.body = [...fields, ...body];
      stmts.splice(callIdx, 1);
      b.path.remove();
      // nothing left of a base class's constructor: the class has its default one
      if (!cp.node.superClass && !stmts.length && !ctor.params.length) cp.node.body.body = cp.node.body.body.filter((m) => m !== ctor);
      for (const k of brandKeys) {
        const kb = cp.scope.getBinding(k);
        if (kb && !kb.constantViolations.length && kb.path.isVariableDeclarator() && t.isStringLiteral(kb.path.node.init) && /^__vmwm__\$pib_/.test(kb.path.node.init.value)) {
          const rest = kb.referencePaths.filter((r) => !r.findParent((x) => x.node === fn));
          if (!rest.length) kb.path.remove();
        }
      }
    },
  });
}

module.exports = { foldDerivedFieldInitializers, inlinePrivateComputedKeys };
