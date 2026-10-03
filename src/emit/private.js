'use strict';
/**
 * Private class members. obfuscator.io lowers `#field` to a static WeakMap per class holding one
 * object per instance (`C.<wm>.get(this).<key>`), installed by a field initializer, and `#method`
 * to a method keyed by a `Symbol()` stored in the VM namespace, with a WeakSet brand check before
 * every call. The original names are gone; the members are restored as `#field_N` / `#method_N`,
 * and the field initializers that run in the constructor are folded back into class fields.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { containsNode, removeDeclarator, staticKey, thunkValue, PRIVATE_ERROR, isBrandCheckMessage, isUndef } = require('../ast');

/** a lowering helper that throws "Cannot read private member ..." (a brand check); the install
 *  of a #method brand ("Cannot install private ...") is a different helper */
const isBrandCheckFn = (n) => t.isFunction(n) && n.params.length === 1 &&
  // (the message of a class nested in some other function, e.g. a field initializer, does not count)
  containsNode(n.body, (x) => t.isStringLiteral(x) && isBrandCheckMessage(x.value), (x) => t.isClass(x));

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

function restorePrivateMembers(file, privateSymbols) {
  const privName = (key) => {
    const m = /\$p([a-z]+)_(\d+)$/.exec(key);
    if (m) return `${m[1].startsWith('s') ? 'method' : 'field'}_${m[2]}`;
    return key.replace(/[^A-Za-z0-9_]/g, '') || 'priv';
  };
  const isNew = (v, ctor) => t.isNewExpression(v) && t.isIdentifier(v.callee, { name: ctor });
  const keyName = (p) => (t.isIdentifier(p.key) && !p.computed ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null);
  // 1. per class: WeakMap / WeakSet statics
  const weakMaps = new Set(), weakSets = new Set();
  t.traverseFast(file, (n) => {
    if (!t.isClassBody(n)) return;
    for (const m of n.body) {
      if (!t.isClassProperty(m) || !m.static) continue;
      const k = keyName(m);
      if (k && isNew(m.value, 'WeakMap')) weakMaps.add(k);
      if (k && isNew(m.value, 'WeakSet')) weakSets.add(k);
    }
  });
  if (!weakMaps.size && !weakSets.size && !privateSymbols.size) return;
  // local aliases of a private symbol (`let k = _$ps_3; class { static [k] = 0 }`) -> the symbol
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !t.isIdentifier(n.init) || !privateSymbols.has(n.init.name)) return;
      const b = p.scope.getBinding(n.id.name);
      if (!b || b.constantViolations.length) return;
      for (const r of b.referencePaths) r.replaceWith(t.identifier(n.init.name));
      p.remove();
    },
  });
  // symbol-keyed members: a symbol used as a method key names a method, otherwise a field
  const symbolKind = new Map();
  t.traverseFast(file, (n) => {
    if (!t.isClassBody(n)) return;
    for (const m of n.body) {
      if (!m.computed || !t.isIdentifier(m.key) || !privateSymbols.has(m.key.name)) continue;
      symbolKind.set(m.key.name, t.isClassMethod(m) ? 'method' : 'field');
    }
  });
  const symName = (sym) => {
    const num = (/(\d+)$/.exec(sym) || [, '0'])[1];
    return symbolKind.get(sym) === 'field' ? `field_s${num}` : `method_${num}`;
  };
  // private keys of WeakMap-lowered fields (from their initializers `__vmwm__<key>`)
  const privateKeys = new Set();
  t.traverseFast(file, (n) => {
    if (t.isClassProperty(n)) {
      const k = keyName(n);
      if (k && /^__vmwm__/.test(k) && !/^__vmwm__\$pib_/.test(k)) { const key = k.replace(/^__vmwm__/, ''); privateKeys.add(key); privateKeys.add('_' + key); }
    }
  });
  const isWM = (n) => t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property) && weakMaps.has(n.property.name);
  // `C.<wm>.get(obj)` -> obj
  const storeOf = (n) => (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property, { name: 'get' }) && isWM(n.callee.object) && n.arguments.length === 1 ? n.arguments[0] : null);
  const brandHelpers = new Set();
  // `#x in o` helpers:  o => o is object ? C.<wm>.has(o) && "<key>" in C.<wm>.get(o) : "__vm_brand" in o
  const inHelpers = new Map(); // binding identifier -> private key
  const privateInKey = (fn) => {
    if (!t.isFunction(fn) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return null;
    let key = null, brand = false;
    t.traverseFast(fn.body, (x) => {
      if (t.isBinaryExpression(x, { operator: 'in' }) && t.isStringLiteral(x.left)) {
        if (storeOf(x.right)) key = x.left.value;
        else if (x.left.value === '__vm_brand') brand = true;
      }
    });
    return key && brand ? key : null;
  };
  traverse(file, {
    // 2. brand-check helpers:  let rN = function (o) { ... "Cannot read private member" ... }
    VariableDeclarator(p) {
      const n = p.node;
      if (!t.isIdentifier(n.id) || !t.isFunction(n.init)) return;
      const inKey = privateInKey(n.init);
      if (inKey) {
        const b = p.scope.getBinding(n.id.name);
        if (b && !b.constantViolations.length) {
          inHelpers.set(b.identifier, inKey);
          removeDeclarator(p);
          return;
        }
      }
      const hit = isBrandCheckFn(n.init);
      if (hit) {
        const b = p.scope.getBinding(n.id.name);
        if (b) brandHelpers.add(b.identifier);
        removeDeclarator(p);
      }
    },
    // helper assigned inside an expression:  (rN = function (o) { ... }, rN(this).#m())
    AssignmentExpression(p) {
      const e = p.node;
      if (e.operator !== '=' || !t.isIdentifier(e.left) || !t.isFunction(e.right) || !t.isSequenceExpression(p.parent)) return;
      const inKey = privateInKey(e.right);
      if (inKey) {
        const b = p.scope.getBinding(e.left.name);
        if (!b || b.constantViolations.some((v) => v.node !== e && !(t.isAssignmentExpression(v.node) && privateInKey(v.node.right) === inKey))) return;
        inHelpers.set(b.identifier, inKey);
        const seq = p.parent;
        seq.expressions = seq.expressions.filter((x) => x !== e);
        if (seq.expressions.length === 1) p.parentPath.replaceWith(seq.expressions[0]);
        return;
      }
      const hit = isBrandCheckFn(e.right);
      if (!hit) return;
      const b = p.scope.getBinding(e.left.name);
      if (!b || b.constantViolations.some((v) => v.node !== e && !(t.isAssignmentExpression(v.node) && t.isFunction(v.node.right)))) return;
      brandHelpers.add(b.identifier);
      const seq = p.parent;
      seq.expressions = seq.expressions.filter((x) => x !== e);
      if (seq.expressions.length === 1) p.parentPath.replaceWith(seq.expressions[0]);
    },
    // same helper assigned later:  rN = function (o) { ... }
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isIdentifier(e.left) || !t.isFunction(e.right)) return;
      const inKey = privateInKey(e.right);
      if (inKey) {
        const b = p.scope.getBinding(e.left.name);
        if (b && b.constantViolations.length === 1) { inHelpers.set(b.identifier, inKey); p.remove(); return; }
      }
      const hit = isBrandCheckFn(e.right);
      if (hit) {
        const b = p.scope.getBinding(e.left.name);
        if (b && b.constantViolations.length === 1) { brandHelpers.add(b.identifier); p.remove(); }
      }
    },
  });
  // `let r = C.<wm>.get(obj)` / `r = C.<wm>.get(obj)`  ->  `obj`, remember r
  const storeVars = new Set();
  traverse.cache.clear();
  traverse(file, {
    VariableDeclarator(p) { const o = storeOf(p.node.init); if (o && t.isIdentifier(p.node.id)) { storeVars.add(p.node.id.name); p.node.init = o; } },
    AssignmentExpression(p) { const o = storeOf(p.node.right); if (o && t.isIdentifier(p.node.left)) { storeVars.add(p.node.left.name); p.node.right = o; } },
  });
  traverse.cache.clear();
  traverse(file, {
    CallExpression(p) {
      // `#x in o` helper call
      if (t.isIdentifier(p.node.callee) && p.node.arguments.length === 1) {
        const b = p.scope.getBinding(p.node.callee.name);
        if (b && inHelpers.has(b.identifier)) {
          p.replaceWith(t.binaryExpression('in', t.privateName(t.identifier(privName(inHelpers.get(b.identifier)))), p.node.arguments[0]));
          return;
        }
      }
      // a static field initializer called with the private key as receiver
      // (`static #f = function () { return E; }.call(sym)`): in a field initializer `this` is the
      // class, so the thunk's value is the initializer itself
      if (t.isMemberExpression(p.node.callee) && t.isIdentifier(p.node.callee.property, { name: 'call' }) && t.isFunctionExpression(p.node.callee.object) &&
          p.node.arguments.length === 1 && t.isIdentifier(p.node.arguments[0]) && privateSymbols.has(p.node.arguments[0].name) && p.parentPath.isClassPrivateProperty() && p.node.callee.object.params.length === 0) {
        p.replaceWith(thunkValue(p.node.callee.object.body.body));
        return;
      }
      // immediately invoked brand check: (o => SYM in o ? o : {...throws...})(x) / (function (o) {...})(x) -> x
      if (t.isFunction(p.node.callee) && p.node.arguments.length === 1 && p.node.callee.params.length === 1) {
        if (containsNode(p.node.callee, (x) => t.isStringLiteral(x) && PRIVATE_ERROR.test(x.value))) { p.replaceWith(p.node.arguments[0]); return; }
      }
      // rN(obj) -> obj   (only calls of that very helper binding, names are reused across functions)
      if (t.isIdentifier(p.node.callee) && p.node.arguments.length === 1) {
        const b = p.scope.getBinding(p.node.callee.name);
        if (b && brandHelpers.has(b.identifier)) { p.replaceWith(p.node.arguments[0]); return; }
      }
    },
    // `sym in o` with a private member's symbol -> `#member in o`
    BinaryExpression(p) {
      const n = p.node;
      if (n.operator === 'in' && t.isIdentifier(n.left) && privateSymbols.has(n.left.name)) n.left = t.privateName(t.identifier(symName(n.left.name)));
    },
    MemberExpression: {
      exit(p) {
        const n = p.node;
        // C.<wm>.get(obj).key  ->  obj.#field
        const obj = storeOf(n.object);
        if (obj) {
          const key = staticKey(n);
          if (key) { p.replaceWith(t.memberExpression(obj, t.privateName(t.identifier(privName(key))))); return; }
        }
        // obj[sym] -> obj.#method
        if (n.computed && t.isIdentifier(n.property) && privateSymbols.has(n.property.name)) {
          p.replaceWith(t.memberExpression(n.object, t.privateName(t.identifier(symName(n.property.name)))));
          return;
        }
        // any access with a lowered private key (`r.key`, `(r = obj).key`): the keys are unique random
        // names used only by the lowering, and every store object has been replaced by its instance
        if (!n.computed && t.isIdentifier(n.property) && (privateKeys.has(n.property.name) || (privateKeys.size + weakMaps.size && /^_?\$p[a-z]+_\d+$/.test(n.property.name)))) {
          p.replaceWith(t.memberExpression(n.object, t.privateName(t.identifier(privName(n.property.name)))));
        }
      },
    },
    ClassBody(p) {
      const out = [];
      for (const m of p.node.body) {
        const k = t.isClassProperty(m) ? keyName(m) : null;
        // static WeakMap / WeakSet stores
        if (t.isClassProperty(m) && m.static && k && (weakMaps.has(k) || weakSets.has(k))) continue;
        // brand installation
        if (t.isClassProperty(m) && k && /^__vmwm__\$pib_/.test(k)) continue;
        // field initializer -> #field = init
        if (t.isClassProperty(m) && k && /^__vmwm__/.test(k)) {
          let init = t.isCallExpression(m.value) && m.value.arguments.length === 1 ? m.value.arguments[0] : null;
          if (init && isUndef(init)) init = null;
          const key = k.replace(/^__vmwm__/, '');
          out.push(t.classPrivateProperty(t.privateName(t.identifier(privName(key))), init, null, m.static));
          continue;
        }
        // [sym](...) {} -> #method(...) {}
        if (t.isClassMethod(m) && m.computed && t.isIdentifier(m.key) && privateSymbols.has(m.key.name)) {
          const pm = t.classPrivateMethod(m.kind, t.privateName(t.identifier(symName(m.key.name))), m.params, m.body, m.static);
          pm.async = !!m.async;
          pm.generator = !!m.generator;
          out.push(pm);
          continue;
        }
        // static [sym] = v  ->  static #field_sN = v
        if (t.isClassProperty(m) && m.computed && t.isIdentifier(m.key) && privateSymbols.has(m.key.name)) {
          out.push(t.classPrivateProperty(t.privateName(t.identifier(symName(m.key.name))), m.value, null, m.static));
          continue;
        }
        // brand block: static { this.<key> = this; }
        if (t.isStaticBlock(m) && m.body.length === 1 && t.isExpressionStatement(m.body[0]) && t.isAssignmentExpression(m.body[0].expression) &&
            t.isMemberExpression(m.body[0].expression.left) && t.isThisExpression(m.body[0].expression.left.object) && t.isThisExpression(m.body[0].expression.right)) continue;
        // static { register(this.prototype, sym) }
        if (t.isStaticBlock(m) && m.body.every((st) => t.isExpressionStatement(st) && t.isCallExpression(st.expression) && st.expression.arguments.some((a) => t.isIdentifier(a) && privateSymbols.has(a.name)))) continue;
        out.push(m);
      }
      p.node.body = out;
    },
    // `delete this.__vmwm__...;` in constructors
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (t.isUnaryExpression(e, { operator: 'delete' }) && t.isMemberExpression(e.argument) && t.isIdentifier(e.argument.property) && /^__vmwm__/.test(e.argument.property.name)) p.remove();
    },
  });
  return () => {
    let left = 0;
    t.traverseFast(file, (n) => { if (t.isIdentifier(n) && (weakMaps.has(n.name) || weakSets.has(n.name) || privateSymbols.has(n.name))) left++; });
    return left;
  };
}

module.exports = { restorePrivateMembers, foldDerivedFieldInitializers, inlinePrivateComputedKeys };
