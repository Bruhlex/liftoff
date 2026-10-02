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

const SYNTHETIC = /^(r\d+|s\d+_\d+|a\d+|item\d*|key\d*|_t\d+|e\d+|rest)$/;
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

const ARRAY_CB = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap']);

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
    return null;
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
  return null;
}

/** every identifier name occurring in the subtree of `scopePath` */
function namesIn(node) {
  const s = new Set();
  t.traverseFast(node, (n) => { if (t.isIdentifier(n)) s.add(n.name); });
  return s;
}

function renameSynthetic(file) {
  traverse.cache.clear();
  const bindings = [];
  traverse(file, {
    Scope(p) {
      for (const [name, b] of Object.entries(p.scope.bindings)) if (SYNTHETIC.test(name) && b.scope === p.scope) bindings.push(b);
    },
  });
  let renamed = 0;
  for (const b of bindings) {
    const cands = candidateFor(b);
    if (!cands) continue;
    const scope = b.scope;
    const used = namesIn(scope.block);
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
