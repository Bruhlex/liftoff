'use strict';
/**
 * Parameters and destructuring as the source wrote them: default values, parameters beyond the
 * function's `length` read through `arguments`, array and object patterns that the compiler
 * lowered to element and property reads, and object destructuring with computed keys.
 */

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { sameExpr, isIdentName, referencesName, iife, exprStmts, singleDeclarator, plainAssign, isUndef, containsReturn, countIdent: countRefs } = require('../ast');

/** number of `let x;` declarations without initializer at the start of a body */
function leadingBareLets(body) {
  let k = 0;
  while (k < body.length && t.isVariableDeclaration(body[k]) && body[k].declarations.every((d) => !d.init && t.isIdentifier(d.id))) k++;
  return k;
}

/** does an expression moved into the parameter list read a binding of the function body? (the
 *  parameter scope does not see those) */
function readsBodyBinding(fnPath, expr, own = []) {
  let hit = false;
  t.traverseFast(expr, (x) => {
    if (hit || !t.isIdentifier(x) || own.includes(x.name)) return;
    const b = fnPath.scope.getBinding(x.name);
    if (b && b.scope === fnPath.scope && b.kind !== 'param') hit = true;
  });
  return hit;
}

/** k for `if (arguments[k] === undefined) ...`, the VM's default check of parameter k; else -1 */
function argDefaultIndex(st) {
  if (!t.isIfStatement(st) || !t.isBinaryExpression(st.test, { operator: '===' }) || !isUndef(st.test.right)) return -1;
  const m = st.test.left;
  return t.isMemberExpression(m) && m.computed && t.isIdentifier(m.object, { name: 'arguments' }) && t.isNumericLiteral(m.property) ? m.property.value : -1;
}

/**
 * A parameter with a default does not count in the function's `length`, so the VM program has
 * fewer parameters than the source and reads the rest as `arguments[i]`:
 *   function* (a0) { if (arguments[1] === undefined) { arguments[1] = X; } ... arguments[1] ... }
 * becomes `function* (a0, a1 = X) { ... a1 ... }`. For a generator this matters: its parameter
 * defaults are evaluated by the call, its body only by the first `next()`.
 */
function argumentsToParams(path) {
  const n = path.node;
  if (t.isArrowFunctionExpression(n) || !n.params.every((p) => t.isIdentifier(p))) return;
  const P = n.params.length;
  const uses = [];
  let other = false;
  // in the VM a parameter beyond `length` and `arguments[k]` are the same storage: in the default
  // value of parameter j, `arguments[k]` with k < j is the earlier parameter k (already set,
  // possibly by its own default), with k >= j a later one, which only the arguments object holds yet
  const defaultValues = new Map(); // default value node -> index of the parameter it initializes
  for (const st of n.body.body.slice(leadingBareLets(n.body.body))) {
    const k = argDefaultIndex(st);
    if (k < 0) break;
    t.traverseFast(st.consequent, (x) => { if (t.isAssignmentExpression(x)) defaultValues.set(x.right, k); });
  }
  let inDefault = null;
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string' || other) return;
    if (node !== n && t.isFunction(node) && !t.isArrowFunctionExpression(node)) return;
    // `delete arguments[i]` has no parameter equivalent
    if (t.isUnaryExpression(node, { operator: 'delete' }) && t.isMemberExpression(node.argument) && t.isIdentifier(node.argument.object, { name: 'arguments' })) { other = true; return; }
    if (t.isIdentifier(node, { name: 'arguments' })) {
      if (t.isMemberExpression(parent) && parent.object === node && parent.computed && t.isNumericLiteral(parent.property) && Number.isInteger(parent.property.value)) {
        // with a non-simple parameter list `arguments` is unmapped: `arguments[i]` of a declared
        // parameter i, and reads of later parameters in default values, stay reads of the arguments object
        const k = parent.property.value;
        if (k >= P && (inDefault === null || k < inDefault)) uses.push(parent);
      } else other = true;
      return;
    }
    const outer = inDefault;
    if (defaultValues.has(node)) inDefault = defaultValues.get(node);
    for (const k of t.VISITOR_KEYS[node.type] || []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node)); else visit(v, node);
    }
    inDefault = outer;
  };
  visit(n.body, null);
  if (other || !uses.length) return;
  // the first missing parameter must get a default, or the `length` would grow
  const first = n.body.body[leadingBareLets(n.body.body)];
  if (argDefaultIndex(first) !== P) return;
  const max = Math.max(...uses.map((u) => u.property.value));
  const names = n.params.map((p) => p.name);
  for (let i = P; i <= max; i++) {
    let nm = `a${i}`;
    while (path.scope.hasBinding(nm) || path.scope.hasGlobal(nm) || names.includes(nm)) nm = '_' + nm;
    names.push(nm);
  }
  for (const u of new Set(uses)) { const id = t.identifier(names[u.property.value]); delete u.computed; Object.assign(u, id); for (const k of ['object', 'property', 'optional']) delete u[k]; }
  n.params = names.map((nm) => t.identifier(nm));
  path.scope.crawl();
}

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

/** `let X = p;` at the top level of p's function, p referenced only there -> rename X to p */
function mergeParamCopy(scope, name, b) {
  if (b.kind !== 'let' && b.kind !== 'const') return false;
  if (!b.path.isVariableDeclarator() || !t.isIdentifier(b.path.node.id) || !t.isIdentifier(b.path.node.init)) return false;
  const declStmt = b.path.parentPath;
  if (declStmt.node.declarations.length !== 1) return false;
  const fn = declStmt.parentPath && declStmt.parentPath.parentPath;
  if (!fn || !fn.isFunction() || declStmt.parentPath !== fn.get('body')) return false;
  const pName = b.path.node.init.name;
  const pb = fn.scope.getBinding(pName);
  if (!pb || pb.kind !== 'param' || pb.references !== 1 || pb.scope !== fn.scope) return false;
  // parameter reassignments before the copy (default values) are fine; after it the copy would diverge
  const declIdx = declStmt.key;
  if (pb.constantViolations.some((cv) => { let q = cv; while (q && q.parentPath !== declStmt.parentPath) q = q.parentPath; return !q || q.key > declIdx; })) return false;
  if (scope !== fn.scope) return false;
  // every use of X must see the parameter p under that name (no shadowing p in nested functions)
  if (b.referencePaths.some((r) => r.scope.getBinding(pName) !== pb)) return false;
  if (b.constantViolations.some((r) => r.scope.getBinding(pName) !== pb)) return false;
  scope.rename(name, pName); // declaration becomes `let p = p;`
  declStmt.remove();
  return true;
}

/** `if (a === undefined) { a = X; }` at the start of a function body -> default parameter `a = X` */
function convertDefaultParams(file) {
  let changed = false;
  traverse.cache.clear();
  traverse(file, {
    Function(path) {
      const n = path.node;
      if (!t.isBlockStatement(n.body)) return;
      const body = n.body.body;
      let i = 0;
      while (i < body.length) {
        const st = body[i];
        const d = defaultCheck(st);
        if (!d) {
          // statements that can stay in front: bare `let x;` declarations, and (if every default
          // after them is a side-effect-free constant) statements such as a host `super(...)`
          if (t.isVariableDeclaration(st) && st.declarations.every((x) => !x.init)) { i++; continue; }
          const nextD = body.slice(i + 1).map(defaultCheck).find(Boolean);
          if (nextD && isInertDefault(nextD.value) && !countRefs(st, nextD.name) && !t.isReturnStatement(st) && !t.isThrowStatement(st) && !containsReturn(st)) { i++; continue; }
          break;
        }
        const pi = n.params.findIndex((p) => t.isIdentifier(p, { name: d.name }) || t.isAssignmentPattern(p) && t.isIdentifier(p.left, { name: d.name }));
        if (pi < 0) break;
        if (i > 0 && !isInertDefault(d.value)) break;
        const later = n.params.slice(pi + 1).map((p) => (t.isIdentifier(p) ? p.name : t.isAssignmentPattern(p) && t.isIdentifier(p.left) ? p.left.name : null)).filter(Boolean);
        if (later.some((nm) => countRefs(d.value, nm))) break;
        const p = n.params[pi];
        if (t.isAssignmentPattern(p)) {
          // the host function already has this default: the check is a no-op
          if (!(isInertDefault(p.right) && sameExpr(p.right, d.value))) break;
        } else n.params[pi] = t.assignmentPattern(t.identifier(d.name), d.value);
        body.splice(i, 1);
        changed = true;
      }
    },
  });
  return changed;
}

function defaultCheck(st) {
  if (!t.isIfStatement(st) || st.alternate) return null;
  const test = st.test;
  if (!t.isBinaryExpression(test, { operator: '===' }) || !t.isIdentifier(test.left) || !isUndef(test.right)) return null;
  const name = test.left.name;
  const cons = t.isBlockStatement(st.consequent) ? st.consequent.body : [st.consequent];
  const isSet = (x) => t.isExpressionStatement(x) && t.isAssignmentExpression(x.expression, { operator: '=' }) && t.isIdentifier(x.expression.left, { name });
  const last = cons[cons.length - 1];
  if (!last || !isSet(last)) return null;
  if (cons.length === 1) return { name, value: last.expression.right };
  // a default that reads a later parameter in its TDZ: `{ throw new ReferenceError(..); a = undefined; }`
  if (cons.length === 2 && t.isThrowStatement(cons[0])) return { name, value: iife([cons[0]]) };
  // `_ = (a = f, b = g)`: expressions before the parameter's own assignment
  const before = exprStmts(cons.slice(0, -1));
  if (before) return { name, value: t.sequenceExpression([...before, last.expression.right]) };
  return null;
}

/** literal-like default values whose evaluation time cannot be observed */
function isInertDefault(e) {
  if (t.isLiteral(e) && !t.isTemplateLiteral(e)) return true;
  if (t.isTemplateLiteral(e)) return e.expressions.length === 0;
  if (isUndef(e)) return true;
  if (t.isUnaryExpression(e) && (e.operator === '-' || e.operator === '!' || e.operator === 'void')) return isInertDefault(e.argument);
  if (t.isArrayExpression(e)) return e.elements.every((x) => x && isInertDefault(x));
  if (t.isObjectExpression(e)) return e.properties.every((p) => t.isObjectProperty(p) && !p.computed && isInertDefault(p.value));
  if (t.isArrowFunctionExpression(e)) return true;
  return false;
}

module.exports = { restoreKeyedDestructuring, argumentsToParams, leadingBareLets, defaultCheck, readsBodyBinding, convertDefaultParams, mergeParamCopy, destructuredParams, objectParams };
