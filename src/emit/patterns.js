'use strict';
/**
 * Destructuring patterns rebuilt from the element and property reads the compiler lowered them
 * to: array and object pattern parameters (also nested, with defaults and computed keys) and
 * object destructuring assignments with a computed key.
 */

const t = require('@babel/types');
const { isIdentName, referencesName, singleDeclarator, plainAssign, isUndef, countIdent: countRefs } = require('../ast');
const { readsBodyBinding } = require('./params');

/**
 * An object pattern parameter is lowered to one property read per element at the top of the body:
 *   (a0 = {}) => { let r1, r2; const r0 = a0.a; const x = a0.b === undefined ? D : a0.b; [r1, r2] = a0.w; }
 * becomes `({ a: r0, b: x = D, w: [r1, r2] } = {}) => {}`. For a generator this restores when the
 * reads run (at the call), and each property is read once again.
 */
function objectParams(path) {
  const n = path.node;
  const body = n.body.body;
  if (referencesName(n.body, 'arguments')) return;
  for (let pi = 0; pi < n.params.length; pi++) {
    const prm = n.params[pi];
    const P = t.isIdentifier(prm) ? prm.name : t.isAssignmentPattern(prm) && t.isIdentifier(prm.left) ? prm.left.name : null;
    if (!P) continue;
    const ctx = { bare: new Set(), keyTemps: new Map() };
    const r = readObjectPattern(body, 0, P, ctx);
    if (!r || ctx.bare.size) continue;
    if (body.slice(r.end).some((x) => referencesName(x, P))) continue;
    const own = Object.keys(t.getBindingIdentifiers(r.pattern));
    if (new Set(own).size !== own.length) continue;
    // defaults and computed keys move into the parameter scope: they may only read outer bindings
    let ok = true;
    t.traverseFast(r.pattern, (x) => {
      if (t.isAssignmentPattern(x) && (readsBodyBinding(path, x.right, own) || referencesName(x.right, P))) ok = false;
      if (t.isObjectProperty(x) && x.computed && readsBodyBinding(path, x.key, own)) ok = false;
    });
    if (!ok) continue;
    n.params[pi] = t.isAssignmentPattern(prm) ? t.assignmentPattern(r.pattern, prm.right) : r.pattern;
    body.splice(0, r.end);
    path.scope.crawl();
    return;
  }
}

/**
 * Reads the statements from `i` on that destructure the variable `src` property by property; returns
 * the object pattern and the index after it, or null. `ctx.bare` collects `let r;` declarations
 * whose variables a pattern must bind, `ctx.keyTemps` temporaries holding computed keys.
 */
function readObjectPattern(body, i, src, ctx) {
  const keyOf = (m) => {
    if (!t.isMemberExpression(m) || !t.isIdentifier(m.object, { name: src })) return null;
    if (!m.computed && t.isIdentifier(m.property)) return m.property.name;
    if (m.computed && t.isStringLiteral(m.property)) return m.property.value;
    if (m.computed && t.isIdentifier(m.property) && ctx.keyTemps.has(m.property.name)) return ctx.keyTemps.get(m.property.name);
    if (m.computed && !referencesName(m.property, src)) return m.property; // `{ [f()]: x }`, evaluated in order
    return null;
  };
  // `src.k` or `src.k === undefined ? D : src.k` (a computed key is evaluated once: names only)
  const prop = (e) => {
    const k = keyOf(e);
    if (k !== null) return { k, def: null };
    if (t.isConditionalExpression(e) && t.isBinaryExpression(e.test, { operator: '===' }) && isUndef(e.test.right)) {
      const k2 = keyOf(e.test.left);
      if (typeof k2 === 'string' && keyOf(e.alternate) === k2) return { k: k2, def: e.consequent };
    }
    return null;
  };
  const decl1 = (st) => singleDeclarator(st, { requireInit: false });
  const assign = plainAssign;
  const props = [];
  for (; i < body.length; i++) {
    const st = body[i], nx = body[i + 1];
    const d = decl1(st), a = assign(st);
    if (t.isVariableDeclaration(st) && st.declarations.every((x) => !x.init && t.isIdentifier(x.id))) { for (const x of st.declarations) ctx.bare.add(x.id.name); continue; }
    // the RequireObjectCoercible check of the source itself: `({} = src);`
    if (a && t.isObjectPattern(a.left) && !a.left.properties.length && t.isIdentifier(a.right, { name: src })) continue;
    if (d && d.init) {
      const name = d.id.name;
      // `let r = src; ... r = src.x;`: a register that first held the source and is overwritten
      // before anything reads it
      const na = assign(nx);
      if (t.isIdentifier(d.init, { name: src })) {
        const k = body.findIndex((x, j) => j > i && referencesName(x, name)); // first use after the copy
        const ka = k >= 0 ? assign(body[k]) : null;
        const writes = ka && (t.isIdentifier(ka.left, { name }) || ((t.isArrayPattern(ka.left) || t.isObjectPattern(ka.left)) && name in t.getBindingIdentifiers(ka.left)));
        if (writes && !referencesName(ka.right, name)) { ctx.bare.add(name); continue; }
      }
      // `const k = f(); const x = src[k];`: a computed key held in a temporary used once
      const nxInit = decl1(nx) ? decl1(nx).init : na ? na.right : null;
      if (nxInit && t.isMemberExpression(nxInit) && nxInit.computed && t.isIdentifier(nxInit.object, { name: src }) && t.isIdentifier(nxInit.property, { name }) &&
          countRefs(t.blockStatement(body.slice(i + 1)), name) === 1 && !prop(d.init)) { ctx.keyTemps.set(name, d.init); continue; }
      const r = prop(d.init);
      if (!r) break;
      // `const t = src.w; const x = t.x; ...`: a nested object pattern when t is read for nothing else
      const nested = /^_t\d+$/.test(name) ? readObjectPattern(body, i + 1, name, ctx) : null;
      if (nested && !body.slice(nested.end).some((x) => referencesName(x, name))) {
        props.push({ ...r, target: nested.pattern });
        i = nested.end - 1;
        continue;
      }
      props.push({ ...r, target: d.id });
      continue;
    }
    if (a && t.isIdentifier(a.left) && ctx.bare.has(a.left.name)) {
      const r = prop(a.right);
      if (!r) break;
      ctx.bare.delete(a.left.name);
      props.push({ ...r, target: t.identifier(a.left.name) });
      continue;
    }
    if (a && (t.isArrayPattern(a.left) || t.isObjectPattern(a.left))) {
      const r = prop(a.right);
      const names = Object.keys(t.getBindingIdentifiers(a.left));
      if (!r || !names.every((x) => ctx.bare.has(x))) break;
      for (const x of names) ctx.bare.delete(x);
      props.push({ ...r, target: a.left });
      continue;
    }
    break;
  }
  if (!props.length) return null;
  const pattern = t.objectPattern(props.map((x) => {
    const value = x.def ? t.assignmentPattern(x.target, x.def) : x.target;
    if (typeof x.k !== 'string') return t.objectProperty(x.k, value, true);
    const short = t.isIdentifier(x.target, { name: x.k }) && isIdentName(x.k);
    return t.objectProperty(isIdentName(x.k) ? t.identifier(x.k) : t.stringLiteral(x.k), value, false, short);
  }));
  return { pattern, end: i };
}

/** `(a0) => { let r = a0; [r, ...] = a0; ... }` -> `([r, ...]) => { ... }` */
function destructuredParams(path) {
  const n = path.node;
  const body = n.body.body;
  let i = 0;
  const declared = new Map(); // name -> declarator
  let src = null;
  while (i < body.length && t.isVariableDeclaration(body[i], { kind: 'let' })) {
    for (const d of body[i].declarations) {
      if (!t.isIdentifier(d.id)) return;
      if (d.init) { if (!t.isIdentifier(d.init) || (src && d.init.name !== src)) return; src = d.init.name; }
      declared.set(d.id.name, d);
    }
    i++;
  }
  const st = body[i];
  if (!st || !t.isExpressionStatement(st) || !t.isAssignmentExpression(st.expression, { operator: '=' }) ||
      !(t.isArrayPattern(st.expression.left) || t.isObjectPattern(st.expression.left)) || !t.isIdentifier(st.expression.right) || (src && st.expression.right.name !== src)) return;
  src = st.expression.right.name;
  // the parameter, possibly with a default: `(a0 = x) => { let r; [r] = a0; }` -> `([r] = x) => {}`
  const pi = n.params.findIndex((p) => t.isIdentifier(p, { name: src }) || (t.isAssignmentPattern(p) && t.isIdentifier(p.left, { name: src })));
  if (pi < 0) return;
  const pat = st.expression.left;
  const bound = Object.keys(t.getBindingIdentifiers(pat));
  if (bound.length !== declared.size || !bound.every((x) => declared.has(x))) return;
  if (body.slice(i + 1).some((x) => referencesName(x, src))) return;
  if (referencesName(n.body, 'arguments') || readsBodyBinding(path, pat, bound)) return;
  // defaults inside the pattern may only read parameters and outer bindings
  n.params[pi] = t.isAssignmentPattern(n.params[pi]) ? t.assignmentPattern(pat, n.params[pi].right) : pat;
  body.splice(0, i + 1);
  path.scope.crawl();
}

/**
 * An object destructuring assignment with a computed key and a member target, which the VM
 * evaluates step by step (the key is coerced to a property key right away, the lifter marks it):
 *   const s = src(); const k = key(); const o = obj(); const p = prop(); o[p] = s[k];
 *   ->  ({ [key()]: obj()[prop()] } = src());
 * Written as statements, `key()`'s `toString` would run only at the read, after `obj()`.
 */
function restoreKeyedDestructuring(body) {
  const decl1 = (st) => singleDeclarator(st, { notVar: true });
  for (let i = 1; i < body.length; i++) {
    const kd = decl1(body[i]), sd = decl1(body[i - 1]);
    if (!kd || !kd.init.__propertyKey || !sd) continue;
    // temporaries of the target, then `T = s[k]`
    let j = i + 1;
    const temps = new Map();
    for (let d; j < body.length && (d = decl1(body[j])); j++) temps.set(d.id.name, d.init);
    const fin = body[j];
    const a = fin && plainAssign(fin);
    if (!a || !t.isMemberExpression(a.right) || !a.right.computed || !t.isIdentifier(a.right.object, { name: sd.id.name }) || !t.isIdentifier(a.right.property, { name: kd.id.name })) continue;
    const rest = body.slice(j + 1);
    const names = [sd.id.name, kd.id.name, ...temps.keys()];
    if (names.some((n) => rest.some((x) => referencesName(x, n)) || countRefs(fin, n) !== 1)) continue;
    // the target with its temporaries put back in place
    if (t.isIdentifier(a.left) && temps.has(a.left.name)) continue;
    const target = t.cloneNode(a.left, true);
    t.traverseFast(target, (x) => {
      for (const key of ['object', 'property']) if (t.isIdentifier(x[key]) && temps.has(x[key].name)) x[key] = temps.get(x[key].name);
    });
    const pattern = t.objectPattern([t.objectProperty(kd.init, target, true)]);
    body.splice(i - 1, j - i + 2, t.expressionStatement(t.assignmentExpression('=', pattern, sd.init)));
  }
}

module.exports = { restoreKeyedDestructuring, destructuredParams, objectParams };
