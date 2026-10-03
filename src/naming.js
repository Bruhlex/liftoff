'use strict';
/**
 * Readable names for the decompiler's synthetic identifiers (registers `r3`, scope slots
 * `s12_0`, parameters `a0`, loop items `item2`, catch variables, temporaries `_t4`).
 *
 * Names are derived from how a binding is used, never guessed from obfuscated source names:
 *   catch parameter -> e;  numeric for-loop counter -> i, j, k, ...;  for..in -> key;
 *   for..of over `xs` -> x (singular), `.entries()` -> entry;  `new Grid()` -> grid;
 *   `obj.prop` -> prop;  `getUser()` / `parseQuery()` -> user / query;  `[]` -> arr, `{}` -> obj;
 *   callback parameters of array methods -> element / index / acc.
 * Renaming is purely cosmetic: a candidate is only used if it cannot capture or shadow any
 * other binding or global reference in the affected scopes.
 */
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { identifiersIn } = require('./ast');

const SYNTHETIC = /^(r\d+|s\d+_\d+|a\d+_?|item\d*|key\d*|_t\d+|e\d+|rest)$/;
// names the obfuscator generated (`_0x4df810`, `vmHK`); renamed only below the top level, where
// no VM program can reach them by name
const OBFUSCATED = /^(_0x[0-9a-f]{4,}|vm[A-Z][A-Za-z0-9]{1,4})$/;
const RESERVED = new Set(['arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'let', 'static', 'yield', 'await', 'enum', 'implements', 'package', 'protected', 'interface', 'private', 'public']);

const lowerCamel = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const readable = (s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9]{1,30}$/.test(s) && !/^_?0x/.test(s) && s.length > 1;

function singular(word) {
  if (!readable(word)) return null;
  if (/ies$/.test(word) && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(word)) return null;
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return null;
}

/** trailing name of an expression: `a.b.items` -> items, `items` -> items, `this.#list` -> list */
function tailName(e) {
  if (t.isIdentifier(e)) return e.name;
  if (t.isMemberExpression(e) && !e.computed) return t.isPrivateName(e.property) ? e.property.id.name : e.property.name;
  if (t.isCallExpression(e) && t.isMemberExpression(e.callee) && !e.callee.computed && t.isIdentifier(e.callee.property)) {
    const m = e.callee.property.name;
    if (['slice', 'filter', 'concat', 'reverse', 'sort', 'toSorted', 'flat'].includes(m)) return tailName(e.callee.object);
    if (m === 'values') return tailName(e.callee.object);
  }
  return null;
}

function nameFromCallee(callee) {
  let n = null;
  if (t.isIdentifier(callee)) n = callee.name;
  else if (t.isMemberExpression(callee) && !callee.computed && (t.isIdentifier(callee.property) || t.isPrivateName(callee.property))) n = t.isPrivateName(callee.property) ? callee.property.id.name : callee.property.name;
  if (!readable(n)) return null;
  const m = /^(get|parse|create|make|build|compute|load|read|find|to|new|fetch|calc|calculate)([A-Z][A-Za-z0-9]*)$/.exec(n);
  return m ? lowerCamel(m[2]) : null;
}

function nameFromInit(init) {
  if (!init) return null;
  if (t.isNewExpression(init) && t.isIdentifier(init.callee) && readable(init.callee.name) && /^[A-Z]/.test(init.callee.name)) {
    const c = init.callee.name;
    return ({ Map: 'map', Set: 'set', WeakMap: 'weakMap', Array: 'arr', Error: 'err', Promise: 'promise', RegExp: 're' })[c] || lowerCamel(c);
  }
  if (t.isArrayExpression(init)) return init.elements.length ? null : 'arr';
  if (t.isObjectExpression(init)) return init.properties.length ? null : 'obj';
  if (t.isMemberExpression(init) && !init.computed) {
    const n = tailName(init);
    if (readable(n) && n !== 'length' && n !== 'prototype' && !/^[A-Z0-9_]+$/.test(n)) return n; // (constants such as `Fraction.ONE` name a value, not a variable)
    if (n === 'length') return 'len';
  }
  if (t.isCallExpression(init)) return nameFromCallee(init.callee);
  if (t.isAwaitExpression(init)) return nameFromInit(init.argument);
  return null;
}

// what a binding's uses say about its value: [name, weight]
const LIST_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'indexOf', 'includes', 'join', 'forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'flat', 'flatMap', 'sort', 'reverse', 'fill']);
const STR_METHODS = new Set(['split', 'trim', 'trimStart', 'trimEnd', 'charCodeAt', 'charAt', 'codePointAt', 'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'substring', 'substr', 'localeCompare', 'normalize', 'repeat']);
const MAP_METHODS = new Set(['has', 'set', 'delete', 'clear']);
const EL_PROPS = new Set(['appendChild', 'addEventListener', 'removeEventListener', 'setAttribute', 'getAttribute', 'classList', 'style', 'textContent', 'innerHTML', 'querySelector', 'querySelectorAll', 'parentNode', 'children']);
const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);

function usageCandidate(binding) {
  const votes = new Map();
  const vote = (n, w) => { if (n) votes.set(n, (votes.get(n) || 0) + w); };
  const values = binding.constantViolations.map((v) => (v.isAssignmentExpression({ operator: '=' }) ? v.node.right : null));
  if (binding.path.isVariableDeclarator()) values.push(binding.path.node.init);
  // an anonymous function or class takes its `.name` from the variable it is assigned to
  if (values.some((v) => (t.isFunction(v) || t.isClass(v)) && !v.id)) return null;
  for (const v of values) {
    const n = nameFromInit(v);
    if (n) vote(n, 4);
    if (t.isStringLiteral(v) || t.isTemplateLiteral(v)) vote('str', 1);
    if (t.isBooleanLiteral(v)) vote('flag', 1);
    if (t.isFunction(v)) vote('fn', 2);
    if (t.isArrayExpression(v)) vote('list', 2);
    if (t.isObjectExpression(v) && v.properties.length) vote('obj', 1);
  }
  for (const r of binding.referencePaths) {
    const p = r.parentPath;
    if (!p) continue;
    const pn = p.node;
    if (p.isMemberExpression() && pn.object === r.node && !pn.computed && t.isIdentifier(pn.property)) {
      const m = pn.property.name;
      if (LIST_METHODS.has(m)) vote('list', 2);
      else if (STR_METHODS.has(m)) vote('str', 2);
      else if (MAP_METHODS.has(m)) vote('map', 2);
      else if (PROMISE_METHODS.has(m)) vote('promise', 2);
      else if (m === 'call' || m === 'apply' || m === 'bind') vote('fn', 2);
      else if (m === 'prototype') vote('Ctor', 3);
      else if (EL_PROPS.has(m)) vote('el', 2);
      else if (m === 'toFixed' || m === 'toPrecision') vote('num', 2);
      else if (m === 'length') vote('list', 0.5);
    } else if (p.isCallExpression() && pn.callee === r.node) vote('fn', 2);
    else if (p.isNewExpression() && pn.callee === r.node) vote('Ctor', 3);
    else if (p.isForOfStatement() && pn.right === r.node) vote('list', 2);
    else if (p.isBinaryExpression({ operator: 'in' }) && pn.right === r.node) vote('obj', 1);
    else if (p.isUnaryExpression({ operator: 'typeof' })) {
      const cmp = p.parentPath && p.parentPath.isBinaryExpression() ? p.parentPath.node : null;
      const lit = cmp && [cmp.left, cmp.right].find((x) => t.isStringLiteral(x));
      if (lit) vote(({ string: 'str', number: 'num', function: 'fn', object: 'obj', boolean: 'flag' })[lit.value], 2);
    } else if (p.isObjectProperty() && pn.value === r.node && !pn.computed && t.isIdentifier(pn.key) && readable(pn.key.name)) vote(pn.key.name, 3);
    else if (p.isAssignmentExpression({ operator: '=' }) && pn.right === r.node && t.isMemberExpression(pn.left) && !pn.left.computed &&
        t.isIdentifier(pn.left.property) && readable(pn.left.property.name)) vote(pn.left.property.name, 3);
  }
  let best = null, bw = 0;
  for (const [n, w] of votes) if (w > bw) { best = n; bw = w; }
  return bw >= 2 ? best : null;
}

/** a parameter named after the readable argument its callers pass at that position */
function callSiteCandidate(binding) {
  const fnPath = binding.path.isFunction() ? binding.path : binding.path.findParent((q) => q.isFunction());
  if (!fnPath) return null;
  const idx = fnPath.node.params.findIndex((q) => q === binding.identifier || (t.isAssignmentPattern(q) && q.left === binding.identifier));
  if (idx < 0) return null;
  let fnBinding = null;
  if (fnPath.isFunctionDeclaration() && fnPath.node.id) fnBinding = fnPath.parentPath.scope.getBinding(fnPath.node.id.name);
  else if (fnPath.parentPath.isVariableDeclarator() && t.isIdentifier(fnPath.parent.id)) fnBinding = fnPath.parentPath.scope.getBinding(fnPath.parent.id.name);
  if (!fnBinding) return null;
  const names = new Map();
  for (const r of fnBinding.referencePaths) {
    if (!r.parentPath.isCallExpression() || r.parent.callee !== r.node) continue;
    const arg = r.parent.arguments[idx];
    let n = t.isIdentifier(arg) ? arg.name : t.isMemberExpression(arg) && !arg.computed && t.isIdentifier(arg.property) ? arg.property.name : null;
    if (!n || !readable(n) || SYNTHETIC.test(n) || OBFUSCATED.test(n)) continue;
    names.set(n, (names.get(n) || 0) + 1);
  }
  let best = null, bc = 0;
  for (const [n, c] of names) if (c > bc) { best = n; bc = c; }
  return best;
}

const ARRAY_CB = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap']);

let pretty = true;

function candidateFor(binding) {
  const path = binding.path;
  const node = binding.identifier;
  // catch (e)
  if (t.isCatchClause(path.node) || (path.parentPath && t.isCatchClause(path.parent) && path.parent.param === node)) return ['e', 'err', 'error'];
  if (binding.kind === 'param') {
    const fn = path.isFunction() ? path : path.findParent((p) => p.isFunction());
    if (!fn) return null;
    const idx = fn.node.params.findIndex((p) => p === node || (t.isAssignmentPattern(p) && p.left === node));
    const call = fn.parentPath;
    if (call && call.isCallExpression() && call.node.arguments[0] === fn.node && t.isMemberExpression(call.node.callee) && t.isIdentifier(call.node.callee.property)) {
      const m = call.node.callee.property.name;
      const recv = tailName(call.node.callee.object);
      if (ARRAY_CB.has(m)) return idx === 0 ? [singular(recv) || 'x', 'el'] : idx === 1 ? ['i', 'idx'] : idx === 2 ? ['array'] : null;
      if (m === 'reduce' || m === 'reduceRight') return idx === 0 ? ['acc'] : idx === 1 ? [singular(recv) || 'x', 'el'] : idx === 2 ? ['i'] : null;
      if (m === 'sort' || m === 'toSorted') return idx === 0 ? ['a'] : idx === 1 ? ['b'] : null;
      if (m === 'then') return idx === 0 ? ['value', 'res'] : null;
      if (m === 'catch') return idx === 0 ? ['e', 'err'] : null;
    }
    if (call && call.isNewExpression() && t.isIdentifier(call.node.callee, { name: 'Promise' })) return idx === 0 ? ['resolve'] : idx === 1 ? ['reject'] : null;
    if (!pretty) return null;
    const fromCall = callSiteCandidate(binding);
    if (fromCall) return [fromCall];
    const u = usageCandidate(binding);
    return u ? [u] : null;
  }
  // `const { key: r21 } = src` / `{ key: r21, ...r22 }`: the property name
  if (path.isVariableDeclarator() && t.isObjectPattern(path.node.id)) {
    const prop = path.node.id.properties.find((p) => t.isObjectProperty(p) && p.value === node);
    if (prop && !prop.computed && t.isIdentifier(prop.key) && readable(prop.key.name)) return [prop.key.name];
    if (path.node.id.properties.some((p) => t.isRestElement(p) && p.argument === node)) return ['rest', 'others'];
  }
  // declarations
  const decl = path.isVariableDeclarator() ? path : null;
  const stmt = decl ? decl.parentPath : null;
  if (stmt && stmt.parentPath && (stmt.parentPath.isForOfStatement() || stmt.parentPath.isForInStatement()) && stmt.parentPath.node.left === stmt.node) {
    if (stmt.parentPath.isForInStatement()) return ['key', 'prop'];
    const right = stmt.parentPath.node.right;
    if (t.isCallExpression(right) && t.isMemberExpression(right.callee) && t.isIdentifier(right.callee.property, { name: 'entries' })) return ['entry'];
    if (t.isCallExpression(right) && t.isMemberExpression(right.callee) && t.isIdentifier(right.callee.property, { name: 'keys' })) return ['key'];
    return [singular(tailName(right)) || 'item'];
  }
  if (stmt && stmt.parentPath && stmt.parentPath.isForStatement() && stmt.parentPath.node.init === stmt.node && decl.node.init && t.isNumericLiteral(decl.node.init)) {
    let depth = 0;
    for (let p = stmt.parentPath.parentPath; p; p = p.parentPath) if (p.isForStatement() && p.node.init && t.isVariableDeclaration(p.node.init)) depth++; else if (p.isFunction()) break;
    return [['i', 'j', 'k', 'l', 'm', 'n'][depth] || 'i'];
  }
  if (decl) {
    const n = nameFromInit(decl.node.init);
    if (n) return [n];
  }
  if (!pretty) return null;
  // names a program can observe stay: a function's or class's own name (`.name`)
  if (path.isClassExpression() || path.isFunctionExpression() || path.isFunctionDeclaration() || path.isClassDeclaration()) return null;
  const u = usageCandidate(binding);
  return u ? [u] : null;
}

/** every identifier name occurring in the subtree of `scopePath` */
/**
 * `pretty` (default) also names values by how they are used, parameters by what their callers
 * pass, and obfuscator-generated names below the top level; without it only the basic rules
 * apply.
 */
function renameSynthetic(file, opts = {}) {
  pretty = opts.pretty !== false;
  traverse.cache.clear();
  const bindings = [];
  traverse(file, {
    Scope(p) {
      for (const [name, b] of Object.entries(p.scope.bindings)) {
        if (b.scope !== p.scope) continue;
        if (SYNTHETIC.test(name) || (pretty && OBFUSCATED.test(name) && !p.isProgram())) bindings.push(b);
      }
    },
  });
  let renamed = 0;
  for (const b of bindings) {
    const cands = candidateFor(b);
    if (!cands) continue;
    const scope = b.scope;
    const used = identifiersIn(scope.block);
    for (const base of cands.filter(Boolean)) {
      if (RESERVED.has(base) || !/^[A-Za-z_$][\w$]*$/.test(base)) continue;
      let name = base;
      for (let k = 2; used.has(name) || scope.hasBinding(name) || t.isValidIdentifier(name) === false; k++) name = `${base}${k}`;
      scope.rename(b.identifier.name, name);
      renamed++;
      break;
    }
  }
  return renamed;
}

module.exports = { renameSynthetic };
