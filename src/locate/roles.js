'use strict';
/**
 * Role inference: which variable of the interpreter is the operand stack, the stack pointer,
 * the register file, the constant pool, the jump and try tables, `this`, `arguments`, ...;
 * judged from how the prologue and the handlers use each variable. Also the helper functions
 * declared next to the interpreter in the factory scope.
 */

const t = require('@babel/types');
const { gen, containsNode, identifiersIn } = require('../ast');
const { normalizeStatements } = require('../normalform');

// ---------------------------------------------------------------------------
// 3. Role inference
// ---------------------------------------------------------------------------

function prologueStatements(fnNode, outerWhile) {
  const out = [];
  for (const st of fnNode.body.body) {
    if (st === outerWhile) break;
    out.push(st);
  }
  return out;
}

function declaredLocals(stmts) {
  const map = new Map(); // name -> init node
  for (const st of stmts) {
    if (t.isVariableDeclaration(st)) {
      for (const d of st.declarations) if (t.isIdentifier(d.id)) map.set(d.id.name, d.init || null);
    }
  }
  return map;
}

function isSlotRead(node, progName) {
  // prog[<anything>] possibly wrapped in `|| X`
  if (t.isLogicalExpression(node, { operator: '||' })) node = node.left;
  return t.isMemberExpression(node, { computed: true }) && t.isIdentifier(node.object, { name: progName });
}

function inferRoles(fnPath, loop, fetch, handlers, globalName) {
  const fn = fnPath.node;
  const roles = {};
  const params = fn.params.map((p) => (t.isIdentifier(p) ? p.name : null));
  const prologue = prologueStatements(fn, loop.outerPath.node);
  const locals = declaredLocals(prologue);

  roles.pc = fetch.op ? loop.outerPath.node.test.left.name : null;
  roles.len = loop.outerPath.node.test.right.name;
  roles.code = fetch.code;
  roles.opLocal = fetch.op;
  roles.operandLocal = fetch.operand;

  // program parameter: the parameter most often used as `X[...]` in the prologue
  const memberCounts = new Map();
  for (const st of prologue) {
    t.traverseFast(st, (n) => {
      if (t.isMemberExpression(n, { computed: true }) && t.isIdentifier(n.object) && params.includes(n.object.name)) {
        memberCounts.set(n.object.name, (memberCounts.get(n.object.name) || 0) + 1);
      }
    });
  }
  roles.prog = [...memberCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // stack / sp: `X[Y++] = ...`
  fnPath.traverse({
    AssignmentExpression(p) {
      if (roles.stack) return;
      const l = p.node.left;
      if (
        t.isMemberExpression(l, { computed: true }) && t.isIdentifier(l.object) &&
        t.isUpdateExpression(l.property, { operator: '++', prefix: false }) && t.isIdentifier(l.property.argument)
      ) {
        roles.stack = l.object.name;
        roles.sp = l.property.argument.name;
      }
    },
  });

  // registers: `let R = new Array(...)` in prologue (the only `new Array` at top level of prologue
  // that is later indexed by the operand)
  for (const [name, init] of locals) {
    if (t.isNewExpression(init) && t.isIdentifier(init.callee, { name: 'Array' })) {
      const arg = init.arguments[0];
      if (arg && containsNode(arg, (n) => t.isIdentifier(n, { name: roles.prog }))) {
        roles.regs = name;
        // param-count / local-count slot expressions: (A || 0) + (B || 0)
        if (t.isBinaryExpression(arg, { operator: '+' })) {
          roles.paramCountExpr = gen(arg.left);
          roles.localCountExpr = gen(arg.right);
        }
      }
    }
  }

  // args param: copied into regs inside a for loop `regs[i] = P[i]`
  for (const st of prologue) {
    t.traverseFast(st, (n) => {
      if (
        !roles.args && t.isAssignmentExpression(n) &&
        t.isMemberExpression(n.left, { computed: true }) && t.isIdentifier(n.left.object, { name: roles.regs }) &&
        t.isMemberExpression(n.right, { computed: true }) && t.isIdentifier(n.right.object) && params.includes(n.right.object.name)
      ) roles.args = n.right.object.name;
    });
  }

  // this param: `P = <global>` assignment in prologue
  for (const st of prologue) {
    t.traverseFast(st, (n) => {
      if (!roles.this && t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left) && params.includes(n.left.name) &&
          t.isIdentifier(n.right, { name: globalName })) roles.this = n.left.name;
    });
  }

  // scope object literal: { slots: new Array(...), constFlags: null, selfIdx: -1, parent: <param> }
  for (const [name, init] of locals) {
    if (!t.isObjectExpression(init) || init.properties.length < 3) continue;
    const props = {};
    let ok = true;
    for (const p of init.properties) {
      if (!t.isObjectProperty(p)) { ok = false; break; }
      const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
      const v = p.value;
      const arrNew = t.isNewExpression(v) && t.isIdentifier(v.callee, { name: 'Array' }) ? v : null;
      let nestedNew = null;
      if (!arrNew) t.traverseFast(v, (n) => { if (!nestedNew && t.isNewExpression(n) && t.isIdentifier(n.callee, { name: 'Array' })) nestedNew = n; });
      if (arrNew || nestedNew) { props.slots = key; roles.scopeSlotCountExpr = gen((arrNew || nestedNew).arguments[0]); }
      else if (t.isNullLiteral(v)) props.constFlags = key;
      else if (t.isUnaryExpression(v, { operator: '-' })) props.selfIdx = key;
      else if (t.isIdentifier(v) && params.includes(v.name)) { props.parent = key; roles.parentScope = v.name; }
      else if (t.isIdentifier(v)) { props.parent = key; roles.parentScope = v.name; }
    }
    if (ok && props.slots && props.parent) {
      roles.scope = name;
      roles.scopeProps = props;
      break;
    }
  }

  // lexical this: `let X = <thisParam>`
  for (const [name, init] of locals) {
    if (t.isIdentifier(init, { name: roles.this })) roles.lexThis = name;
  }

  // slot-loaded locals: code, consts, jumps, tries
  const slotLocals = [];
  for (const [name, init] of locals) {
    if (init && isSlotRead(init, roles.prog)) slotLocals.push(name);
  }
  // also assignments inside a switch in the prologue (test1 style: the four loads are permuted)
  for (const st of prologue) {
    t.traverseFast(st, (n) => {
      if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left) && locals.has(n.left.name) && isSlotRead(n.right, roles.prog)) {
        if (!slotLocals.includes(n.left.name)) slotLocals.push(n.left.name);
      }
    });
  }
  // jumps: a handler whose body is `pc = X[pc]`
  // role detection compares handler text: use the normal form so that trivial
  // syntactic variation (`pc += 1`, extra blocks, inverted ifs) does not matter
  const textCache = new Map();
  const bodyText = (h) => {
    if (!textCache.has(h)) {
      const txt = normalizeStatements(h.body).map(gen).join('');
      textCache.set(h, txt.replace(/;(break|continue);$/, ';$1;'));
    }
    return textCache.get(h);
  };
  for (const h of handlers) {
    const txt = bodyText(h);
    const m = txt.match(new RegExp(`^${roles.pc}=(\\w+)\\[${roles.pc}\\];(?:(?:break|continue);?)?$`));
    if (m && slotLocals.includes(m[1])) { roles.jumps = m[1]; break; }
  }
  // tries: a handler containing `X[pc]` where X is a slot local other than jumps/code, and it pushes an object literal
  for (const h of handlers) {
    if (roles.tries) break;
    for (const name of slotLocals) {
      if (name === roles.jumps || name === roles.code) continue;
      const txt = bodyText(h);
      if (txt.includes(`${name}[${roles.pc}]`) && /\.push\(\{/.test(txt)) roles.tries = name;
    }
  }
  // consts: the remaining slot local that handlers index with the operand most often (`X[operand]`)
  {
    const cands = slotLocals.filter((n) => ![roles.code, roles.jumps, roles.tries].includes(n));
    let best = null, bestN = -1;
    for (const c of cands) {
      let n = 0;
      for (const h of handlers) {
        const re = new RegExp(`\\b${c}\\[${h.operandVar}\\]`, 'g');
        n += (bodyText(h).match(re) || []).length;
      }
      if (n > bestN) { bestN = n; best = c; }
    }
    roles.consts = best;
  }

  // try-frames array: `let X = null` and some handler does `X.push({` and another `X.pop()`
  for (const h of handlers) {
    const m = bodyText(h).match(/(\w+)\.push\(\{/);
    if (m && locals.has(m[1]) && m[1] !== roles.stack) { roles.tryFrames = m[1]; break; }
  }
  if (roles.tryFrames) {
    // frame property roles from the pushed literal: [catchPc, finallyPc, endPc] taken from tries[pc][0..2], sp, pc, scope
    for (const h of handlers) {
      let lit = null;
      for (const st of h.body) t.traverseFast(st, (n) => {
        if (!lit && t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: roles.tryFrames }) &&
            t.isIdentifier(n.callee.property, { name: 'push' }) && t.isObjectExpression(n.arguments[0])) lit = n.arguments[0];
      });
      if (!lit) continue;
      const fp = {};
      for (const p of lit.properties) {
        const key = t.isIdentifier(p.key) ? p.key.name : p.key.value;
        const v = p.value;
        const txt = gen(v);
        if (t.isIdentifier(v, { name: roles.sp })) fp.sp = key;
        else if (t.isIdentifier(v, { name: roles.pc })) fp.pc = key;
        else if (t.isIdentifier(v, { name: roles.scope })) fp.scope = key;
        else if (/\[0\]/.test(txt)) fp.catchPc = key;
        else if (/\[1\]/.test(txt)) fp.finallyPc = key;
        else if (/\[2\]/.test(txt)) fp.endPc = key;
      }
      roles.tryFrameProps = fp;
      break;
    }
  }

  // flags: `let X = !!prog[...]`
  const flagLocals = [];
  for (const [name, init] of locals) {
    if (t.isUnaryExpression(init, { operator: '!' }) && t.isUnaryExpression(init.argument, { operator: '!' }) && isSlotRead(init.argument.argument, roles.prog)) flagLocals.push(name);
  }
  roles.flagLocals = flagLocals;
  // strict: used as `if (X) { ... Reflect.set ... }` in a handler
  for (const h of handlers) {
    if (roles.strict) break;
    for (const st of h.body) t.traverseFast(st, (n) => {
      if (!roles.strict && t.isIfStatement(n) && t.isIdentifier(n.test) && flagLocals.includes(n.test.name) &&
          containsNode(n.consequent, (m) => t.isMemberExpression(m) && t.isIdentifier(m.object, { name: 'Reflect' }) && t.isIdentifier(m.property, { name: 'set' }))) roles.strict = n.test.name;
    });
  }
  // derived constructor flag: used together with the "Must call super constructor" error
  for (const h of handlers) {
    if (roles.derived) break;
    const txt = bodyText(h);
    if (!txt.includes('Must call super constructor')) continue;
    for (const f of flagLocals) if (f !== roles.strict && new RegExp(`\\b${f}&&`).test(txt)) roles.derived = f;
  }
  // arrow flag: in `if (!strict && !X && (this === undefined || ...)) this = global`
  for (const st of prologue) {
    t.traverseFast(st, (n) => {
      if (roles.arrowFlag || !t.isIfStatement(n)) return;
      if (!containsNode(n.consequent, (m) => t.isAssignmentExpression(m) && t.isIdentifier(m.left, { name: roles.this }))) return;
      const ids = [...identifiersIn(n.test)].filter((x) => flagLocals.includes(x) && x !== roles.strict);
      if (ids.length) roles.arrowFlag = ids[0];
    });
  }

  // remaining params: newTarget (a handler is exactly `stack[sp++] = P`) and callee
  const known = new Set([roles.prog, roles.args, roles.this, roles.parentScope]);
  const rest = params.filter((p) => p && !known.has(p));
  for (const h of handlers) {
    const txt = bodyText(h);
    for (const p of rest) {
      if (new RegExp(`^${roles.stack}\\[${roles.sp}\\+\\+\\]=${p};${roles.pc}\\+\\+;(?:break;|continue;)?$`).test(txt)) roles.newTarget = p;
    }
  }
  roles.callee = rest.find((p) => p !== roles.newTarget) || null;
  roles.params = params;

  // scope "names" property: `(scope.X ||= {})[slot] = consts[...]`
  for (const h of handlers) {
    if (roles.scopeProps?.names) break;
    for (const st of h.body) t.traverseFast(st, (n) => {
      if (t.isAssignmentExpression(n, { operator: '||=' }) && t.isMemberExpression(n.left) && t.isIdentifier(n.left.object, { name: roles.scope }) && t.isObjectExpression(n.right)) {
        roles.scopeProps.names = t.isIdentifier(n.left.property) ? n.left.property.name : n.left.property.value;
      }
    });
  }

  // in-VM call stack (self-recursion fast path): `R5[R6++] = args` ... not needed for lifting, but
  // recorded so canonicalization can name it.
  roles.prologueLocals = [...locals.keys()];
  return roles;
}

// ---------------------------------------------------------------------------
// 4. Factory scope helpers (functions declared next to the interpreter)
// ---------------------------------------------------------------------------

function classifyHelper(fnNode) {
  const src = gen(fnNode);
  if (src.length > 1500) return null;
  const params = fnNode.params.length;
  if (/return typeof \w+==="object"\|\|typeof \w+==="function"/.test(src)) return 'isObject';
  if (/Array\.prototype\.slice\.call\(\w+\)/.test(src) && params === 1) return 'sliceArgs';
  if (/for\(let \w+ in \w+\)\{?\w+\.push\(\w+\)/.test(src)) return 'forInKeys';
  if (/Reflect\.ownKeys\(\w+\)\[0\]/.test(src) && params === 1) return 'toPropertyKey';
  if (/typeof \w+==="function"&&\w+\.prototype\)\{?return \w+\.prototype/.test(src)) return 'protoTarget';
  if (/Iterator result/.test(src) && params === 1) return 'checkIterResult';
  if (/Math\.imul/.test(src) && params === 2 && /return\[/.test(src)) return 'hash';
  if (/new Array\(\w+\)/.test(src) && params === 2 && /\w+\(\)/.test(src) && /\.value/.test(src)) return 'popArgs';
  if (/"name",\{value/.test(src) || /'name',\{value/.test(src)) return 'setName';
  if (/\.desc/.test(src) && /getOwnPropertyDescriptor|\b\w+\(\w+,\w+\)/.test(src) && /while\(\w+!==null\)/.test(src)) return 'findProperty';
  if (/"constructor"/.test(src) && /prototype===/.test(src)) return 'superProto';
  if (/Symbol\.asyncIterator/.test(src) && /nextMethod/.test(src)) return 'getAsyncIterRecord';
  if (/\.done/.test(src) && /value:\w+\?\w+\.value:undefined/.test(src)) return 'iterResultCopy';
  if (/Method is not callable/.test(src)) return 'getMethod';
  if (/try\{\w+\(\w+,\w+,\w+\);?\}catch/.test(src) && params === 3) return 'safeDefine';
  if (/try\{\w+\(\w+,\w+\);?\}catch/.test(src) && params === 2) return 'safeSetProto';
  if (/writable:true,configurable:true\}/.test(src) && params === 1) return 'descriptor';
  return null;
}

function collectFactoryHelpers(factoryPath) {
  const helpers = new Map(); // name -> role
  const body = factoryPath.node.body.body;
  for (const st of body) {
    if (t.isFunctionDeclaration(st) && st.id) {
      const r = classifyHelper(st);
      if (r) helpers.set(st.id.name, r);
    } else if (t.isVariableDeclaration(st)) {
      for (const d of st.declarations) {
        if (t.isIdentifier(d.id) && (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init))) {
          const r = classifyHelper(d.init);
          if (r) helpers.set(d.id.name, r);
        } else if (t.isIdentifier(d.id) && t.isMemberExpression(d.init) && !containsNode(d.init, (n) => t.isCallExpression(n))) {
          // aliases such as `var K = Object.defineProperty, w = WeakMap.prototype.get`
          const txt = gen(d.init);
          if (/^[A-Z]\w*(\.\w+)+$/.test(txt)) helpers.set(d.id.name, 'alias:' + txt);
        } else if (t.isIdentifier(d.id) && t.isUnaryExpression(d.init, { operator: 'typeof' }) && t.isBigIntLiteral(d.init.argument)) {
          helpers.set(d.id.name, 'const:bigint');
        } else if (t.isIdentifier(d.id) && t.isArrayExpression(d.init) && d.init.elements.length === 0 && st.kind === 'const') {
          helpers.set(d.id.name, 'const:emptyArray');
        }
      }
    }
  }
  return helpers;
}

module.exports = { declaredLocals, prologueStatements, inferRoles, collectFactoryHelpers };
