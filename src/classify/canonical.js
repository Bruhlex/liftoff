'use strict';
/**
 * Canonicalization of a handler body: identifiers with a known role become fixed tokens
 * (S, SP, PC, K, ...), the remaining locals positional names (v0, v1, ...), role properties
 * their role name. The result is the handler's shape, the same in every build. With `normal`,
 * equivalent ways of writing it are normalized further (normalform.js).
 */

const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { normalizeStatements, sortEqualityOperands } = require('../normalform');

const gen = (node) => generate(node, { compact: true, comments: false, jsescOption: { minimal: true } }).code;

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

function roleMap(roles, handler, helpers) {
  const m = new Map();
  const set = (name, tok) => { if (name) m.set(name, tok); };
  set(roles.stack, 'S');
  set(roles.sp, 'SP');
  set(roles.pc, 'PC');
  set(handler.operandVar, 'OP');
  set(handler.opVar, 'OPC');
  set(roles.regs, 'R');
  set(roles.consts, 'K');
  set(roles.jumps, 'J');
  set(roles.tries, 'TT');
  set(roles.args, 'ARGS');
  set(roles.this, 'THIS');
  set(roles.newTarget, 'NT');
  set(roles.scope, 'SC');
  set(roles.lexThis, 'LT');
  set(roles.callee, 'FN');
  set(roles.prog, 'PROG');
  set(roles.parentScope, 'PSC');
  set(roles.tryFrames, 'TF');
  set(roles.global, 'G');
  set(roles.ns, 'NS');
  set(roles.strict, 'STRICT');
  set(roles.derived, 'DERIVED');
  set(roles.arrowFlag, 'ARROW');
  set(roles.len, 'LEN');
  set(roles.code, 'CODE');
  for (const f of roles.flagLocals || []) if (!m.has(f)) m.set(f, 'FLAG');
  for (const [name, role] of helpers) {
    if (role.startsWith('alias:')) m.set(name, role.slice(6).replace(/\./g, '_'));
    else if (role.startsWith('const:')) m.set(name, role.slice(6).toUpperCase());
    else m.set(name, 'H_' + role);
  }
  return m;
}

function propMap(roles) {
  const m = new Map();
  for (const [role, name] of Object.entries(roles.scopeProps || {})) m.set(name, 'sc_' + role);
  for (const [role, name] of Object.entries(roles.tryFrameProps || {})) m.set(name, 'tf_' + role);
  return m;
}

const OBFUSCATED_PROP = /^(_\$\w+|_\w{2,3})$/;

// JS globals that must keep their names in the canonical text
const JS_GLOBALS = new Set(('undefined NaN Infinity Object Array Function String Number Boolean Symbol BigInt Math JSON Reflect Proxy Promise ' +
  'RegExp Error TypeError ReferenceError RangeError SyntaxError EvalError URIError Map Set WeakMap WeakSet WeakRef Date ' +
  'Int32Array Uint8Array Uint16Array Uint32Array Float64Array DataView ArrayBuffer globalThis console arguments eval isNaN ' +
  'isFinite parseInt parseFloat Iterator AsyncIterator Generator FinalizationRegistry Atomics SharedArrayBuffer Intl this').split(' '));

/**
 * Produce the canonical text of a handler body.
 * With `normal: true` the body is first brought into normal form.
 */
function canonicalize(handler, roles, helpers, { normal = false } = {}) {
  if (normal) handler = { ...handler, body: normalizeStatements(handler.body) };
  const rmap = roleMap(roles, handler, helpers);
  const pmap = propMap(roles);
  const locals = new Map();
  const props = new Map();
  const labels = new Map();
  const local = (name) => {
    if (rmap.has(name)) return rmap.get(name);
    if (JS_GLOBALS.has(name)) return name;
    if (!locals.has(name)) locals.set(name, `v${locals.size}`);
    return locals.get(name);
  };
  const prop = (name) => {
    if (pmap.has(name)) return pmap.get(name);
    if (OBFUSCATED_PROP.test(name)) {
      if (!props.has(name)) props.set(name, `p${props.size}`);
      return props.get(name);
    }
    return name;
  };
  const label = (name) => {
    if (!labels.has(name)) labels.set(name, `L${labels.size}`);
    return labels.get(name);
  };

  const body = handler.body.map((s) => t.cloneNode(s, true));
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (t.isIdentifier(node)) {
      if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) node.name = prop(node.name);
      else if (t.isOptionalMemberExpression(parent) && key === 'property' && !parent.computed) node.name = prop(node.name);
      else if ((t.isObjectProperty(parent) || t.isObjectMethod(parent)) && key === 'key' && !parent.computed) node.name = prop(node.name);
      else if (t.isLabeledStatement(parent) && key === 'label') node.name = label(node.name);
      else if ((t.isBreakStatement(parent) || t.isContinueStatement(parent)) && key === 'label') node.name = label(node.name);
      else node.name = local(node.name);
      return;
    }
    if (t.isStringLiteral(node) && (t.isObjectProperty(parent) && key === 'key')) {
      node.value = prop(node.value);
      return;
    }
    for (const k of t.VISITOR_KEYS[node.type] || []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, node, k));
      else if (v && typeof v.type === 'string') walk(v, node, k);
    }
  };
  // Pre-seed locals declared in the handler (so declaration order gives stable numbering)
  for (const st of body) walk(st, null, null);

  // Drop the trailing `break;` / `continue;` and stringify.
  let stmts = body;
  const last = stmts[stmts.length - 1];
  if (last && (t.isBreakStatement(last) || t.isContinueStatement(last)) && !last.label) stmts = stmts.slice(0, -1);
  if (normal) stmts = stmts.map((st) => sortEqualityOperands(st));
  let text = stmts.map(gen).join('');
  // cosmetic normalizations so regexes stay simple
  text = text.replace(/;;/g, ';');
  return text;
}

module.exports = { canonicalize, roleMap };
