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

module.exports = { restorePrivateMembers };
