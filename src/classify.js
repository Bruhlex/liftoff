'use strict';
/**
 * Step 2: give every opcode handler a *semantic* label.
 *
 * Each handler body is first canonicalized: every identifier that plays a
 * known role in the interpreter (operand stack, stack pointer, pc, constant
 * pool, ...) is renamed to a fixed token, every remaining local gets a
 * positional name (v0, v1, ...), and obfuscated property names that were
 * assigned a role (scope slots, try-frame fields, ...) are renamed too. What is
 * left is the handler's *shape*, which is the same in every obfuscator.io
 * build; only the opcode number in front of it changes. The classification
 * rules below are written against that canonical text.
 */
const t = require('@babel/types');
const generate = require('@babel/generator').default;

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

const { normalizeStatements, sortEqualityOperands } = require('./normalform');

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

// ---------------------------------------------------------------------------
// Helpers for rules
// ---------------------------------------------------------------------------

const count = (s, re) => (s.match(re) || []).length;
const BIN_RE = /^let v0=S\[--SP\];let v1=S\[--SP\];S\[SP\+\+\]=v1(\*\*|>>>|<<|>>|<=|>=|===|!==|==|!=|\*|\/|%|\^|\+|-|\||&|<|>| in | instanceof )v0;PC\+\+;$/;
const FUSED_RE = /^let v0=OP&65535;let v1=OP>>>16;S\[SP\+\+\]=R\[v0\](\*\*|>>>|<<|>>|<=|>=|===|!==|==|!=|\*|\/|%|\^|\+|-|\||&|<|>)K\[v1\];PC\+\+;$/;
const ROT_RE = /^let v0=S\[SP-3\];let v1=S\[SP-2\];let v2=S\[SP-1\];S\[SP-3\]=(v\d);S\[SP-2\]=(v\d);S\[SP-1\]=(v\d);PC\+\+;$/;

/**
 * Evaluate the operator-selection ladder of the generic BINOP handler for a
 * given selector value by walking the (nested if / conditional) AST.
 */
function evalLadder(handler, selName, resultName, sel, canonNames) {
  // Work on the canonicalized clone: rebuild it so names match the canonical text.
  let result = null;
  const evalCond = (node) => {
    if (t.isUnaryExpression(node, { operator: '!' })) { const c = evalCond(node.argument); return c === null ? null : !c; }
    if (t.isBinaryExpression(node) && t.isNumericLiteral(node.left) && t.isIdentifier(node.right, { name: selName })) {
      const sw = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' }[node.operator] || node.operator;
      return evalCond(t.binaryExpression(sw, node.right, node.left));
    }
    if (t.isBinaryExpression(node) && t.isIdentifier(node.left, { name: selName }) && t.isNumericLiteral(node.right)) {
      const n = node.right.value;
      switch (node.operator) {
        case '<': return sel < n;
        case '<=': return sel <= n;
        case '>': return sel > n;
        case '>=': return sel >= n;
        case '===': case '==': return sel === n;
        case '!==': case '!=': return sel !== n;
      }
    }
    return null;
  };
  const visit = (node) => {
    if (result || !node) return;
    if (t.isIfStatement(node)) {
      const c = evalCond(node.test);
      if (c === null) return;
      visit(c ? node.consequent : node.alternate);
      return;
    }
    if (t.isBlockStatement(node)) { for (const s of node.body) visit(s); return; }
    if (t.isExpressionStatement(node)) { visit(node.expression); return; }
    if (t.isAssignmentExpression(node) && t.isIdentifier(node.left, { name: resultName })) { visit(node.right); return; }
    if (t.isConditionalExpression(node)) {
      const c = evalCond(node.test);
      if (c === null) return;
      visit(c ? node.consequent : node.alternate);
      return;
    }
    if (t.isBinaryExpression(node) && t.isIdentifier(node.left) && t.isIdentifier(node.right)) {
      result = { op: node.operator, left: canonNames.get(node.left.name), right: canonNames.get(node.right.name) };
    }
  };
  for (const st of handler.body) visit(st);
  return result;
}

function binopMegaInfo(handler, roles, helpers) {
  // canonical names of the two popped operands: v0 = first pop (right operand), v1 = second pop (left)
  const rmap = roleMap(roles, handler, helpers);
  const canonNames = new Map();
  let idx = 0;
  const seen = new Set();
  t.traverseFast({ type: 'BlockStatement', body: handler.body, directives: [] }, (n) => {
    if (t.isIdentifier(n) && !rmap.has(n.name) && !seen.has(n.name)) { seen.add(n.name); canonNames.set(n.name, `v${idx++}`); }
  });
  let mask = null, selName = null, resultName = null;
  t.traverseFast({ type: 'BlockStatement', body: handler.body, directives: [] }, (n) => {
    if (t.isVariableDeclarator(n) && t.isBinaryExpression(n.init, { operator: '>>>' }) && t.isBinaryExpression(n.init.left, { operator: '^' }) && t.isNumericLiteral(n.init.left.right)) {
      mask = n.init.left.right.value;
      selName = n.id.name;
    }
  });
  t.traverseFast({ type: 'BlockStatement', body: handler.body, directives: [] }, (n) => {
    if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && t.isIdentifier(n.left.object, { name: roles.stack }) && t.isIdentifier(n.right)) resultName = n.right.name;
  });
  const ladder = {};
  for (let sel = 0; sel < 64; sel++) {
    const r = evalLadder(handler, selName, resultName, sel, canonNames);
    if (r) ladder[sel] = { op: r.op, swapped: r.left === 'v0' };
  }
  return { mask, ladder };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Each rule: (text, ctx) => mnemonic | { mnemonic, ...info } | null.
 * Order matters: more specific rules first.
 */
const RULES = [
  // --- trivial ---
  [(s) => s === 'PC++;' && 'NOP'],
  [(s) => /^v0=OP;PC\+\+;$/.test(s) && 'NOP'],
  [(s) => /^v0=v1\(v2,OP\);PC\+\+;$/.test(s) && 'NOP'],
  [(s) => /^debugger;PC\+\+;$/.test(s) && 'DEBUGGER'],
  [(s) => /^throw S\[--SP\];/.test(s) && 'THROW'],
  [(s) => /^S\[--SP\];PC\+\+;$/.test(s) && 'DROP'],
  [(s) => /^let v0=S\[SP-1\];S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'DUP'],
  [(s) => /^let v0=S\[SP-1\];S\[SP-1\]=S\[SP-2\];S\[SP-2\]=v0;PC\+\+;$/.test(s) && 'SWAP'],
  [(s) => {
    const m = s.match(ROT_RE);
    if (!m) return null;
    const perm = [m[1], m[2], m[3]].join(',');
    if (perm === 'v2,v0,v1') return 'ROT_TOP_DOWN'; // [a,b,c] -> [c,a,b]
    if (perm === 'v1,v2,v0') return 'ROT_BOTTOM_UP'; // [a,b,c] -> [b,c,a]
    return { mnemonic: 'ROT3', perm };
  }],
  [(s) => /^S\[SP\+\+\]=undefined;PC\+\+;$/.test(s) && 'PUSH_UNDEF'],
  [(s) => /^S\[SP\+\+\]=null;PC\+\+;$/.test(s) && 'PUSH_NULL'],
  [(s) => /^S\[SP\+\+\]=\{\};PC\+\+;$/.test(s) && 'PUSH_OBJ'],
  [(s) => /^S\[SP\+\+\]=\[\];PC\+\+;$/.test(s) && 'PUSH_ARR'],
  [(s) => /^S\[SP\+\+\]=K\[OP\];PC\+\+;$/.test(s) && 'PUSH_CONST'],
  [(s) => /^S\[SP\+\+\]=R\[OP\];PC\+\+;$/.test(s) && 'LOAD_REG'],
  [(s) => /^R\[OP\]=S\[--SP\];PC\+\+;$/.test(s) && 'STORE_REG'],
  [(s) => /^S\[SP\+\+\]=ARGS\[OP\];PC\+\+;$/.test(s) && 'LOAD_ARG'],
  [(s) => /^ARGS\[OP\]=S\[--SP\];PC\+\+;$/.test(s) && 'STORE_ARG'],
  [(s) => /^R\[OP\]=R\[OP\]\+1;PC\+\+;$/.test(s) && 'REG_INC'],
  [(s) => /^R\[OP\]=R\[OP\]-1;PC\+\+;$/.test(s) && 'REG_DEC'],
  [(s) => /^S\[SP\+\+\]=LT;PC\+\+;$/.test(s) && 'PUSH_LEXICAL_THIS'],
  [(s) => /^S\[SP\+\+\]=NT;PC\+\+;$/.test(s) && 'PUSH_NEW_TARGET'],
  [(s) => /^S\[SP\+\+\]=SC;PC\+\+;$/.test(s) && 'PUSH_SCOPE'],
  [(s) => /^S\[SP\+\+\]=v0\[OP\];PC\+\+;$/.test(s) && 'DECOY_PUSH'],
  [(s) => /^S\[--SP\];S\[SP\+\+\]=undefined;PC\+\+;$/.test(s) && 'VOID'],
  [(s) => {
    const m = s.match(/^S\[SP-1\]=(-|!|~|\+|typeof )S\[SP-1\];PC\+\+;$/);
    return m ? { mnemonic: 'UNARY', op: m[1].trim() } : null;
  }],
  [(s) => { const m = s.match(BIN_RE); return m ? { mnemonic: 'BINOP', op: m[1].trim() } : null; }],
  [(s) => { const m = s.match(FUSED_RE); return m ? { mnemonic: 'FUSED_BINOP', op: m[1] } : null; }],
  [(s) => /^let v0=OP&65535;let v1=OP>>>16;let v2=R\[v0\];let v3=K\[v1\];if\(v2===null\|\|v2===undefined\)\{throw new TypeError\("Cannot read properties of "/.test(s) && 'GETPROP_REG_CONST'],
  [(s, c) => (/\(OP\^\d+\)>>>0/.test(s) && count(s, /\?/g) >= 4) ? { mnemonic: 'BINOP_MEGA', ...binopMegaInfo(c.handler, c.roles, c.helpers) } : null],

  // --- older-codegen variants (seen in the out.js build) ---
  [(s) => { const m = s.match(/^let v0=OP&65535;let v1=OP>>>16;if\(R\[v0\](\*\*|>>>|<<|>>|<=|>=|===|!==|==|!=|\*|\/|%|\^|\+|-|\||&|<|>)K\[v1\]\)\{PC=J\[PC\];\}else\{PC\+\+;\}$/); return m ? { mnemonic: 'FUSED_JMPT', op: m[1] } : null; }],
  [(s) => { const m = s.match(/^let v0=OP&65535;let v1=OP>>>16;if\(!\(R\[v0\](\*\*|>>>|<<|>>|<=|>=|===|!==|==|!=|\*|\/|%|\^|\+|-|\||&|<|>)K\[v1\]\)\)\{PC=J\[PC\];\}else\{PC\+\+;\}$/); return m ? { mnemonic: 'FUSED_JMPF', op: m[1] } : null; }],
  [(s) => /^v0=SP>0\?S\[--SP\]:undefined;return 1;$/.test(s) && 'RETURN'],
  [(s) => /^let v0=OP&65535;let v1=OP>>>16;let v2=R\[v0\];let v3=K\[v1\];S\[SP\+\+\]=v2\[v3\];PC\+\+;$/.test(s) && 'GETPROP_REG_CONST'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];if\(v0!==null&&v0!==undefined\)\{Object\.assign\(v1,v0\);\}PC\+\+;$/.test(s) && 'OBJ_SPREAD'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=typeof v0===BIGINT\?v0-(?:0x)?1n:\+v0-1;PC\+\+;$/.test(s) && 'DEC_VALUE'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=typeof v0===BIGINT\?v0\+(?:0x)?1n:\+v0\+1;PC\+\+;$/.test(s) && 'INC_VALUE'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=typeof v0===BIGINT\?v0:\+v0;PC\+\+;$/.test(s) && 'TO_NUMERIC'],
  [(s) => /^let v0=S\[--SP\];let v1=typeof v0;if\(v0!==null&&\(v1==="object"\|\|v1==="function"\)\)\{let v2=\{\[v0\]:0\};v0=Reflect\.ownKeys\(v2\)\[0\];\}else if\(v1!=="symbol"\)\{v0=String\(v0\);\}S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'TO_PROPERTY_KEY'],
  [(s) => /^let v0=S\[--SP\];let v1=K\[OP\];if\(v0===null\|\|v0===undefined\)\{S\[SP\+\+\]=undefined;\}else\{S\[SP\+\+\]=v0\[v1\];\}PC\+\+;$/.test(s) && 'OPT_GETPROP_NAMED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];if\(v1===null\|\|v1===undefined\)\{S\[SP\+\+\]=undefined;\}else\{S\[SP\+\+\]=v1\[v0\];\}PC\+\+;$/.test(s) && 'OPT_GETPROP_COMPUTED'],
  [(s) => /^let v0=R\[OP\]\+1;R\[OP\]=v0;S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'REG_PREINC'],
  [(s) => /^let v0=R\[OP\]-1;R\[OP\]=v0;S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'REG_PREDEC'],
  [(s) => /^let v0=OP&65535;let v1=OP>>>?16;let v2=K\[v0\];let v3=K\[v1\];S\[SP\+\+\]=new RegExp\(v2,v3\);PC\+\+;$/.test(s) && 'NEW_REGEXP'],
  [(s) => /^let v0=OP&65535;let v1=OP>>>16;let v2=S\[--SP\];let v3=H_popArgs\(\w+,v2\);let v\d=R\[v0\];let v\d=K\[v1\];let v\d=v\d\[v\d\];S\[SP\+\+\]=v\d\.apply\(v\d,v3\);PC\+\+;$/.test(s) && 'CALL_METHOD_REG_CONST'],
  [(s) => /^L0:\{let v0=J\[PC\];/.test(s) && /tf_finallyPc/.test(s) && /PC=v0;\}$/.test(s) && 'JMP_UNWIND'],
  [(s) => /^L0:\{if\(v0!==null\)\{/.test(s) && /return 1;/.test(s) && /tf_finallyPc/.test(s) && /PC\+\+;\}$/.test(s) && 'FINALLY_END'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[--SP\];let v3=NS\.p0;let v4=v3\?Object_getPrototypeOf\(v3\):H_superProto\(v2\);/.test(s) && /\.set\.call\(/.test(s) && 'SUPER_SET'],
  [(s) => /^L0:\{let v0=S\[--SP\];let v1=S\[--SP\];let v2=NS\.p0;let v3=v2\?Object_getPrototypeOf\(v2\):H_superProto\(v1\);/.test(s) && /\.desc\.get/.test(s) && 'SUPER_GET'],

  // --- control flow ---
  [(s) => /^PC=J\[PC\];$/.test(s) && 'JMP'],
  [(s) => /^if\(!S\[--SP\]\)\{PC=J\[PC\];\}else\{PC\+\+;\}$/.test(s) && 'JMPF'],
  [(s) => /^if\(S\[--SP\]\)\{PC=J\[PC\];\}else\{PC\+\+;\}$/.test(s) && 'JMPT'],
  [(s) => /^if\(!S\[SP-1\]\)\{PC=J\[PC\];\}else\{S\[--SP\];PC\+\+;\}$/.test(s) && 'JMPF_KEEP'],
  [(s) => /^if\(S\[SP-1\]\)\{PC=J\[PC\];\}else\{S\[--SP\];PC\+\+;\}$/.test(s) && 'JMPT_KEEP'],
  [(s) => /^if\(!S\[--SP\]\)\{PC=J\[PC\];\}else\{S\[--SP\];PC\+\+;\}$/.test(s) && 'JMPF_POP2'],
  [(s) => /^if\(S\[--SP\]\)\{PC=J\[PC\];\}else\{S\[--SP\];PC\+\+;\}$/.test(s) && 'JMPT_POP2'],
  [(s) => /^let v0=S\[--SP\];if\(v0!==null&&v0!==undefined\)\{PC=J\[PC\];\}else\{PC\+\+;\}$/.test(s) && 'JMP_NOT_NULLISH'],
  [(s) => /^let v0=S\[--SP\];if\(v0===null\|\|v0===undefined\)\{PC=J\[PC\];\}else\{PC\+\+;\}$/.test(s) && 'JMP_NULLISH'],
  [(s) => /^L0:\{let v0=J\[PC\];while\(TF&&TF\.length>0\)/.test(s) && /PC=v0;\}$/.test(s) && 'JMP_UNWIND'],
  [(s) => /^L0:\{let v0=J\[PC\];if\(v0===/.test(s) && /return 1;/.test(s) && 'FINALLY_END'],
  [(s) => /return 1;/.test(s) && /Must call super constructor/.test(s) && !/J\[PC\]/.test(s) && 'RETURN'],
  [(s) => /return 1;/.test(s) && /^L0:\{while\(TF&&TF\.length>0\)/.test(s) && 'RETURN'],
  [(s) => /^let v0=TT\[PC\];if\(!TF\)\{TF=\[\];\}TF\.push\(\{/.test(s) && 'TRY_ENTER'],
  [(s) => /^TF\.pop\(\);PC\+\+;$/.test(s) && 'TRY_POP'],
  [(s) => /^if\(TF&&TF\.length>0\)\{let v0=TF\[TF\.length-1\];if\(v0\.tf_finallyPc===PC\)/.test(s) && 'FINALLY_ENTER'],

  // --- scopes ---
  [(s) => /^let v0=S\[--SP\];let v1=\{sc_slots:new Array\(OP\),sc_constFlags:null,sc_selfIdx:-1,sc_parent:v0\};SC=v1;PC\+\+;$/.test(s) && 'ENTER_SCOPE'],
  [(s) => /^SC=SC\.sc_parent;PC\+\+;$/.test(s) && 'EXIT_SCOPE'],
  [(s) => /^let v0=OP&65535;let v1=SC\.sc_slots;v1\[v0\]=v1;let v2=OP>>>16;if\(v2\)\{\(SC\.sc_names\|\|=\{\}\)\[v0\]=K\[v2-1\];\}PC\+\+;$/.test(s) && 'DECLARE_TDZ'],
  [(s) => /^let v0=SC\.sc_slots;v0\[OP\]=v0;SC\.sc_selfIdx=OP;PC\+\+;$/.test(s) && 'BIND_THIS_SLOT'],
  [(s) => /^if\(OP===-2\)\{\}else if\(OP===-1\)\{S\[--SP\];\}else\{SC\.sc_slots\[OP\]=S\[--SP\];\}PC\+\+;$/.test(s) && 'STORE_LOCAL'],
  [(s) => /^let v0=OP;let v1=S\[--SP\];SC\.sc_slots\[v0\]=v1;PC\+\+;$/.test(s) && 'STORE_LOCAL'],
  [(s) => /^let v0=OP;let v1=S\[--SP\];SC\.sc_slots\[v0\]=v1;let v2=SC\.sc_constFlags;if\(!v2\)\{v2=\w+\(null\);SC\.sc_constFlags=v2;\}v2\[v0\]=1;PC\+\+;$/.test(s) && 'STORE_LOCAL_CONST'],
  [(s) => /^let v0=OP;SC\.sc_slots\[v0\]=FN;let v1=SC\.sc_constFlags;if\(!v1\)\{v1=\w+\(null\);SC\.sc_constFlags=v1;\}v1\[v0\]=2;PC\+\+;$/.test(s) && 'BIND_SELF'],
  [(s) => /^L0:\{let v0=OP&65535;let v1=OP>>>16;let v2=SC;for\(let v3=0;v3<v1;v3\+\+\)\{v2=v2\.sc_parent;\}let v4=v2\.sc_slots;let v5=v4\[v0\];if\(v5===v4\)\{/.test(s) && /S\[SP\+\+\]=v5;PC\+\+;break L0;\}$/.test(s) && 'LOAD_SCOPE'],
  [(s) => /^L0:\{let v0=OP&65535;let v1=OP>>>16;let v2=S\[--SP\];let v3=SC;for\(let v4=0;v4<v1;v4\+\+\)\{v3=v3\.sc_parent;\}/.test(s) && /Assignment to constant variable/.test(s) && 'STORE_SCOPE'],

  // --- globals ---
  [(s) => /^let v0=K\[OP\];let v1;if\(NS\.p0&&v0 in NS\.p0\)\{throw new ReferenceError\("Cannot access '"/.test(s) && /S\[SP\+\+\]=v1;PC\+\+;$/.test(s) && 'LOAD_GLOBAL'],
  [(s) => /^let v0=S\[--SP\];let v1=K\[OP\];if\(STRICT&&!\(v1 in G\)&&!\(v1 in NS\)\)\{throw new ReferenceError\(v1\+" is not defined"\);\}NS\[v1\]=v0;G\[v1\]=v0;S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'STORE_GLOBAL'],
  [(s) => /^let v0=S\[--SP\];let v1=K\[OP\];if\(NS\.p0&&v1 in NS\.p0\)\{throw new ReferenceError\("Cannot access '"/.test(s) && /NS\[v1\]=v0;/.test(s) && /S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'STORE_GLOBAL_DECL'],
  [(s) => /^let v0=K\[OP\];if\(v0 in NS\)\{S\[SP\+\+\]=typeof NS\[v0\];\}else\{S\[SP\+\+\]=typeof G\[v0\];\}PC\+\+;$/.test(s) && 'TYPEOF_GLOBAL'],
  [(s) => /^let v0=K\[OP\];let v1=true;if\(v0 in G\)\{v1=delete G\[v0\];\}/.test(s) && 'DELETE_GLOBAL'],

  // --- property access ---
  [(s) => /^let v0=S\[--SP\];let v1=K\[OP\];if\(v0===null\|\|v0===undefined\)\{throw new TypeError\("Cannot read properties of "/.test(s) && /S\[SP\+\+\]=v0\[v1\];PC\+\+;$/.test(s) && 'GETPROP_NAMED'],
  [(s) => /^let v0=S\[SP-1\];let v1=K\[OP\];if\(v0===null\|\|v0===undefined\)\{throw new TypeError\("Cannot read properties of "/.test(s) && /S\[SP\+\+\]=v0\[v1\];PC\+\+;$/.test(s) && 'GETPROP_NAMED_KEEP'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];if\(v1===null\|\|v1===undefined\)\{if\(v0===Symbol\.iterator\)/.test(s) && /S\[SP\+\+\]=v1\[v0\];PC\+\+;$/.test(s) && 'GETPROP_COMPUTED'],
  [(s) => /Must call super constructor/.test(s) && /^if\(DERIVED&&!v0\)/.test(s) && /let v\d=THIS;let v\d=K\[OP\];/.test(s) && /Cannot read properties of/.test(s) && 'GET_THIS_PROP'],
  [(s) => /Must call super constructor/.test(s) && /^if\(DERIVED&&!v0\)/.test(s) && /S\[SP\+\+\]=THIS;PC\+\+;$/.test(s) && 'PUSH_THIS'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=K\[OP\];if\(v1===null\|\|v1===undefined\)\{throw new TypeError\("Cannot set properties of "/.test(s) && /S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'SETPROP_NAMED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[--SP\];if\(v2===null\|\|v2===undefined\)\{throw new TypeError\("Cannot set properties of "/.test(s) && /S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'SETPROP_COMPUTED'],
  [(s) => /^let v0;let v1;if\(OP>=0\)\{v1=S\[--SP\];v0=K\[OP\];\}else\{v0=S\[--SP\];v1=S\[--SP\];\}let v2=delete v1\[v0\];/.test(s) && 'DELETE_PROP'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];S\[SP\+\+\]=v0==null\|\|typeof v0!=="object"&&typeof v0!=="function"\?true:v1 in v0;PC\+\+;$/.test(s) && 'IN_SAFE'],
  [(s) => /^let v0=S\[SP-1\];if\(v0==null\)\{var v1=K\[OP\];if\(v1===null\)\{throw new TypeError\("Cannot destructure '"/.test(s) && 'DESTRUCTURE_CHECK'],

  // --- object / class literal building ---
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=K\[OP\];Object_defineProperty\(v1,v2,\{value:v0,writable:true,enumerable:true,configurable:true\}\);/.test(s) && 'DEFINE_PROP_NAMED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[--SP\];Object_defineProperty\(v2,v1,\{value:v0,writable:true,enumerable:true,configurable:true\}\);/.test(s) && 'DEFINE_PROP_COMPUTED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];let v2=K\[OP\];Object_defineProperty\(v1,v2,\{value:v0,writable:true,enumerable:false,configurable:true\}\);/.test(s) && 'DEFINE_METHOD_NAMED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[SP-1\];Object_defineProperty\(v2,v1,\{value:v0,writable:true,enumerable:false,configurable:true\}\);/.test(s) && 'DEFINE_METHOD_COMPUTED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];let v2=K\[OP\];Object_defineProperty\(v1\.prototype,v2,\{value:v0,writable:true,enumerable:false,configurable:true\}\);/.test(s) && 'DEFINE_PROTO_METHOD_NAMED'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[SP-1\];Object_defineProperty\(v2\.prototype,v1,\{value:v0,writable:true,enumerable:false,configurable:true\}\);/.test(s) && 'DEFINE_PROTO_METHOD_COMPUTED'],
  // accessors: {get:v0,...} / {set:v0,...}
  [(s) => {
    const m = s.match(/^let v0=S\[--SP\];let v1=S\[SP-1\];let v2=K\[OP\];(?:let v3=H_protoTarget\(v1\);Object_defineProperty\(v3,v2,\{(get|set):v0,enumerable:v3===v1|Object_defineProperty\(v1,v2,\{(get|set):v0,enumerable:false)/);
    if (!m) return null;
    const kind = m[1] || m[2];
    return { mnemonic: kind === 'get' ? 'DEFINE_GETTER_NAMED' : 'DEFINE_SETTER_NAMED', protoTarget: !!m[1] };
  }],
  [(s) => {
    const m = s.match(/^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[SP-1\];(?:let v3=H_protoTarget\(v2\);Object_defineProperty\(v3,v1,\{(get|set):v0,enumerable:v3===v2|Object_defineProperty\(v2,v1,\{(get|set):v0,enumerable:false)/);
    if (!m) return null;
    const kind = m[1] || m[2];
    return { mnemonic: kind === 'get' ? 'DEFINE_GETTER_COMPUTED' : 'DEFINE_SETTER_COMPUTED', protoTarget: !!m[1] };
  }],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];if\(v0===null\|\|H_isObject\(v0\)\)\{Object_setPrototypeOf\(v1,v0\);\}PC\+\+;$/.test(s) && 'SET_PROTO'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];if\(v0!==null&&v0!==undefined\)\{let v2=Object\(v0\);let v3=Reflect\.ownKeys\(v2\);/.test(s) && 'OBJ_SPREAD'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=\{\};if\(v1!==null&&v1!==undefined\)\{let v3=Object\(v1\);let v4=Reflect\.ownKeys\(v3\);/.test(s) && /S\[SP\+\+\]=v2;PC\+\+;$/.test(s) && 'OBJ_REST'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];v1\.push\(v0\);PC\+\+;$/.test(s) && 'ARR_PUSH'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];if\(Array\.isArray\(v0\)&&v0\[\w+\]===\w+\)\{let v\d=v1\.length;let v\d=v0\.length;for/.test(s) && 'ARR_SPREAD'],
  [(s) => /^let v0=S\[--SP\];let v1=S\[SP-1\];if\(Array\.isArray\(v0\)\)\{Array\.prototype\.push\.apply\(v1,v0\);\}else\{for\(let v\d of v0\)\{v1\.push\(v\d\);\}\}PC\+\+;$/.test(s) && 'ARR_SPREAD'],
  [(s) => /^let v0=S\[SP-1\];v0\.length\+\+;PC\+\+;$/.test(s) && 'ARR_HOLE'],
  [(s) => /is not iterable/.test(s) && /let v\d=\{value:v\d\};WeakSet_prototype_add\.call\(/.test(s) && 'SPREAD_MARK'],
  [(s) => /Object_defineProperty\(v\d,"raw",\{value:Object\.freeze\(/.test(s) && 'TEMPLATE_OBJECT'],
  [(s) => /^let v0=OP&65535;let v1=OP>>>16;let v2=K\[v0\];let v3=K\[v1\];S\[SP\+\+\]=new RegExp\(v2,v3\);PC\+\+;$/.test(s) && 'NEW_REGEXP'],
  [(s) => /^if\(OP===-1\)\{S\[SP\+\+\]=Symbol\(\);\}else\{let v0=S\[--SP\];S\[SP\+\+\]=Symbol\(v0\);\}PC\+\+;$/.test(s) && 'SYMBOL'],
  [(s) => /^let v0=K\[OP\];S\[SP\+\+\]=Symbol\.for\(v0\);PC\+\+;$/.test(s) && 'SYMBOL_FOR'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=Symbol\.keyFor\(v0\);PC\+\+;$/.test(s) && 'SYMBOL_KEYFOR'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=import\(v0\);PC\+\+;$/.test(s) && 'DYNAMIC_IMPORT'],
  [(s) => /^let v0=S\[--SP\];let v1=typeof v0;if\(v0!==null&&\(v1==="object"\|\|v1==="function"\)\)\{let v2=Object_create\(null\);v2\[v0\]=0;v0=Reflect\.ownKeys\(v2\)\[0\];\}else if\(v1!=="symbol"\)\{v0=String\(v0\);\}S\[SP\+\+\]=v0;PC\+\+;$/.test(s) && 'TO_PROPERTY_KEY'],
  [(s) => /Symbol\.toPrimitive/.test(s) && /S\[SP\+\+\]=typeof v0===BIGINT\?v0:\+v0;PC\+\+;$/.test(s) && 'TO_NUMERIC'],
  [(s) => /Symbol\.toPrimitive/.test(s) && /S\[SP\+\+\]=typeof v0===BIGINT\?v0\+(?:0x)?1n:\+v0\+1;PC\+\+;$/.test(s) && 'INC_VALUE'],
  [(s) => /Symbol\.toPrimitive/.test(s) && /S\[SP\+\+\]=typeof v0===BIGINT\?v0-(?:0x)?1n:\+v0-1;PC\+\+;$/.test(s) && 'DEC_VALUE'],
  [(s) => /Cannot convert a Symbol value to a string/.test(s) && /S\[SP-1\]=String\(S\[SP-1\]\);PC\+\+;$/.test(s) && 'TO_STRING'],

  // --- iteration ---
  [(s) => /^let v0=S\[--SP\];if\(v0==null\)\{throw new TypeError\(v0\+" is not iterable"\);\}let v1=v0\[\w+\];if\(Array\.isArray\(v0\)&&v1===\w+\)\{S\[SP\+\+\]=\{/.test(s) && 'GET_ITERATOR'],
  [(s) => /^let v0=R\[OP\];let v1=v0&&v0\.p0;if\(v1!==undefined\)\{let v2=v0\.p1;if\(v2>=v1\.length\)\{PC=J\[PC\];\}else\{v0\.p1=v2\+1;S\[SP\+\+\]=v1\[v2\];PC\+\+;\}\}else\{/.test(s) && 'FOR_OF_NEXT'],
  [(s) => /^let v0=S\[--SP\];let v1=v0&&v0\.p0;if\(v1!==undefined\)\{let v2=v0\.p1;let v3;if\(v2>=v1\.length\)\{v3=\{value:undefined,done:true\};\}/.test(s) && 'ITER_NEXT_RESULT'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=!!v0\.done;PC\+\+;$/.test(s) && 'ITER_RESULT_DONE'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=v0\.next\(\);PC\+\+;$/.test(s) && 'ITER_NEXT_CALL'],
  [(s) => /^let v0=S\[--SP\];let v1=v0&&v0\.i\?v0\.i:v0;if\(v1!=null\)\{if\(v2!==null\)\{try\{let v3=v1\.return;/.test(s) && "ITER_CLOSE"],
  [(s) => /^let v0=S\[--SP\];let v1=v0&&v0\.i\?v0\.i:v0;try\{if\(v1!=null\)\{let v2=v1\.return;/.test(s) && 'ITER_CLOSE_SILENT'],
  [(s) => /^let v0=S\[--SP\];S\[SP\+\+\]=H_forInKeys\(v0\);PC\+\+;$/.test(s) && 'FOR_IN_KEYS'],
  [(s) => /Symbol\.asyncIterator/.test(s) && /^let v0=S\[--SP\];if\(v0==null\)\{throw new TypeError\(v0\+" is not iterable"\);\}let v1=v0\[Symbol\.asyncIterator\];/.test(s) && 'GET_ASYNC_ITERATOR'],
  [(s) => /Promise\.resolve\(/.test(s) && /\.return/.test(s) && /^let v0=S\[--SP\];let v1=v0&&v0\.i\?v0\.i:v0;/.test(s) && 'ASYNC_ITER_CLOSE'],

  // --- calls / functions / classes ---
  [(s) => /Super constructor may only be called once|Super expression must be a constructor/.test(s) && 'SUPER_CALL'],
  [(s) => /'super' keyword is only valid inside a derived constructor/.test(s) && 'PUSH_SUPER_CTOR'],
  [(s) => /^L0:\{let v0=H_toPropertyKey\(S\[--SP\]\);let v1=S\[--SP\];/.test(s) && /\.desc\.get/.test(s) && 'SUPER_GET'],
  [(s) => /^let v0=S\[--SP\];let v1=H_toPropertyKey\(S\[--SP\]\);let v2=S\[--SP\];/.test(s) && /\.set\.call\(/.test(s) && 'SUPER_SET'],
  [(s) => /is not a constructor/.test(s) && /Reflect\.construct\(/.test(s) && /^let v0=S\[--SP\];let v1=H_popArgs\(\w+,v0\);let v\d=S\[--SP\];/.test(s) && 'NEW'],
  [(s) => /Derived constructors may only return object or undefined/.test(s) && 'MAKE_CLASS'],
  [(s) => /Class extends value/.test(s) && 'CLASS_EXTENDS'],
  [(s) => /^let v0=S\[--SP\];let v1=typeof v0==="object"\?v0:\w+\(v0\);/.test(s) && /"length"/.test(s) && 'MAKE_CLOSURE'],
  [(s) => /"Arguments"/.test(s) && /"callee"/.test(s) && 'PUSH_ARGUMENTS'],
  [(s) => /is not a function/.test(s) && /^let v0=K\[OP\];let v1=S\[--SP\];let v2=S\[--SP\];if\(typeof v1!=="function"\)/.test(s) && 'CALL_METHOD_IMM'],
  [(s) => /is not a function/.test(s) && /^let v0=S\[--SP\];let v1=S\[--SP\];let v2=S\[--SP\];if\(typeof v1!=="function"\)/.test(s) && 'CALL_METHOD'],
  [(s) => /is not a function/.test(s) && /^L0:\{let v0=S\[--SP\];let v1=S\[--SP\];if\(typeof v1!=="function"\)/.test(s) && 'CALL'],
  [(s) => /is not a function/.test(s) && /^let v0=S\[--SP\];let v1=S\[--SP\];if\(typeof v1!=="function"\)/.test(s) && 'CALL'],
];

function classifyHandler(text, ctx) {
  for (const [rule] of RULES) {
    const r = rule(text, ctx);
    if (r) return typeof r === 'string' ? { mnemonic: r } : r;
  }
  return null;
}

/**
 * Build the opcode table for a located VM.
 * Returns { table: Map<opcode, {mnemonic, ...info, text}>, unknown: [{opcode, text}] }
 */
function buildOpcodeTable(vm) {
  const { handlers, roles, helpers, yields } = vm;
  const table = new Map();
  const unknown = [];
  const seenText = new Map();
  const signatures = loadSignatures();
  for (const h of handlers) {
    const text = canonicalize(h, roles, helpers);
    const prev = table.get(h.opcode);
    let cls = classifyHandler(text, { handler: h, roles, helpers });
    if (!cls) {
      const nf = canonicalize(h, roles, helpers, { normal: true });
      cls = classifyHandler(nf, { handler: h, roles, helpers });
      if (!cls && signatures.has(nf)) cls = { ...signatures.get(nf), viaSignature: true };
    }
    if (cls) {
      if (!prev || !prev.mnemonic || prev.unknown) table.set(h.opcode, { ...cls, text });
    } else if (!prev) {
      table.set(h.opcode, { mnemonic: `UNKNOWN_${h.opcode}`, unknown: true, text });
    }
    seenText.set(h.opcode, text);
  }
  for (const [op, e] of table) if (e.unknown) unknown.push({ opcode: op, text: e.text });
  if (yields) {
    if (yields.await !== null) table.set(yields.await, { mnemonic: 'AWAIT', text: '' });
    if (yields.yield !== null) table.set(yields.yield, { mnemonic: 'YIELD', text: '' });
    if (yields.yieldStar !== null) table.set(yields.yieldStar, { mnemonic: 'YIELD_STAR', text: '' });
  }
  return { table, unknown };
}

let signatureCache = null;
function loadSignatures() {
  if (signatureCache) return signatureCache;
  signatureCache = new Map();
  try {
    const custom = typeof process !== 'undefined' && process.env && process.env.VMDEC_SIGNATURES;
    const db = custom ? JSON.parse(require('fs').readFileSync(custom, 'utf8')) : require('./signatures.json');
    for (const [k, v] of Object.entries(db.signatures || {})) signatureCache.set(k, v);
  } catch { /* no database yet */ }
  return signatureCache;
}

module.exports = { canonicalize, classifyHandler, buildOpcodeTable, normalizeStatements, RULES };
