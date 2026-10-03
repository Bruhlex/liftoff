'use strict';
/**
 * Step 1: locate the VM inside the (normalized) source and assign *roles* to
 * its variables.
 *
 * Nothing in here depends on identifier names, opcode numbers or on the
 * per-build randomized slot layout of program objects. The interpreter is
 * found by its fetch-decode-execute shape:
 *
 *     while (pc < len) { try { while (pc < len) {
 *         let idx = pc << shift, op = code[opBase + idx], operand = code[operBase + idx];
 *         ... switch (op) { case N: {...} ... }
 *
 * and every other role (operand stack, stack pointer, register file, constant
 * pool, jump table, try table, scope object, `this`, `arguments`, ...) is
 * inferred from how the prologue and the opcode handlers use each variable.
 */
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function parse(code) {
  const opts = { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true, plugins: ['bigInt'] };
  // a plain script first (there `await` can be an identifier); top-level await only as a fallback
  try { return parser.parse(code, opts); } catch { return parser.parse(code, { ...opts, allowAwaitOutsideFunction: true }); }
}

const { gen, containsNode } = require('./ast');

// ---------------------------------------------------------------------------
// 1. Find the interpreter loops
// ---------------------------------------------------------------------------

function sameIdentTest(a, b) {
  return (
    t.isBinaryExpression(a, { operator: '<' }) &&
    t.isBinaryExpression(b, { operator: '<' }) &&
    t.isIdentifier(a.left) && t.isIdentifier(b.left) && a.left.name === b.left.name &&
    t.isIdentifier(a.right) && t.isIdentifier(b.right) && a.right.name === b.right.name
  );
}

function firstStatement(block) {
  return t.isBlockStatement(block) ? block.body[0] : block;
}

function findInterpreterLoops(ast) {
  const found = [];
  traverse(ast, {
    WhileStatement(path) {
      const outer = path.node;
      if (!t.isBinaryExpression(outer.test, { operator: '<' })) return;
      const tryStmt = firstStatement(outer.body);
      if (!t.isTryStatement(tryStmt)) return;
      const inner = tryStmt.block.body[0];
      if (!t.isWhileStatement(inner) || !sameIdentTest(outer.test, inner.test)) return;
      found.push({ outerPath: path, inner, tryStmt });
    },
  });
  return found;
}

/** Decode the fetch statements at the top of the inner loop body. */
function parseFetch(inner, pc) {
  const decls = [];
  for (const st of inner.body.body) {
    if (!t.isVariableDeclaration(st)) break;
    decls.push(...st.declarations);
  }
  let idx, shift, code, opBase, operBase, op, operand;
  for (const d of decls) {
    if (!t.isIdentifier(d.id) || !d.init) continue;
    // let idx = pc << shift
    if (t.isBinaryExpression(d.init, { operator: '<<' }) && t.isIdentifier(d.init.left, { name: pc })) {
      idx = d.id.name;
      shift = d.init.right;
      continue;
    }
    // let op = code[base + idx]
    if (
      idx &&
      t.isMemberExpression(d.init, { computed: true }) &&
      t.isIdentifier(d.init.object) &&
      t.isBinaryExpression(d.init.property, { operator: '+' }) &&
      t.isIdentifier(d.init.property.right, { name: idx })
    ) {
      if (!op) {
        code = d.init.object.name;
        opBase = d.init.property.left;
        op = d.id.name;
      } else if (!operand) {
        operBase = d.init.property.left;
        operand = d.id.name;
      }
    }
  }
  if (!op || !operand) throw new Error('VM loop found but the fetch statements do not match the expected shape');
  return { idx, shift: gen(shift), code, opBase: gen(opBase), operBase: gen(operBase), op, operand };
}

// ---------------------------------------------------------------------------
// 2. Collect opcode handlers from every dispatch switch inside the interpreter
// ---------------------------------------------------------------------------

function numericCaseValue(test) {
  if (t.isNumericLiteral(test)) return test.value;
  if (t.isUnaryExpression(test, { operator: '-' }) && t.isNumericLiteral(test.argument)) return -test.argument.value;
  return null;
}

/**
 * Handlers live either directly in a `switch (op)` in the loop body, or in
 * lazily created dispatch functions `R8 = function (opParam, operandParam) { switch (opParam) ... }`
 * that are invoked as `R8(op, operand)`. This resolves both.
 */
function collectHandlers(fnPath, fetch) {
  const handlers = [];
  const switches = [];
  fnPath.traverse({
    SwitchStatement(p) {
      const numeric = p.node.cases.filter((c) => c.test && numericCaseValue(c.test) !== null);
      if (numeric.length < 8) return;
      switches.push(p);
    },
  });

  for (const sp of switches) {
    let opVar, operandVar;
    let disc = sp.node.discriminant;
    // indirect dispatch: switch (MAP[op]) { case idx: ... } with MAP an array literal opcode -> idx
    let caseToOpcode = null;
    if (t.isMemberExpression(disc, { computed: true }) && t.isIdentifier(disc.object) && t.isIdentifier(disc.property, { name: fetch.op })) {
      const mapName = disc.object.name;
      let lit = null;
      fnPath.traverse({
        AssignmentExpression(ap) { if (!lit && t.isIdentifier(ap.node.left, { name: mapName }) && t.isArrayExpression(ap.node.right)) lit = ap.node.right; },
        VariableDeclarator(dp) { if (!lit && t.isIdentifier(dp.node.id, { name: mapName }) && t.isArrayExpression(dp.node.init)) lit = dp.node.init; },
      });
      if (!lit) continue;
      caseToOpcode = new Map();
      lit.elements.forEach((e, opcode) => { if (t.isNumericLiteral(e) && e.value !== 0) caseToOpcode.set(e.value, opcode); });
      disc = t.identifier(fetch.op);
    }
    if (!t.isIdentifier(disc)) continue;
    if (disc.name === fetch.op) {
      opVar = fetch.op;
      operandVar = fetch.operand;
    } else {
      // dispatch function: find the enclosing function whose param is `disc`
      const fn = sp.getFunctionParent();
      if (!fn) continue;
      const params = fn.node.params.map((x) => (t.isIdentifier(x) ? x.name : null));
      const pi = params.indexOf(disc.name);
      if (pi < 0) continue;
      // find how this function is called: X(op, operand)
      let calleeName = null;
      if (t.isAssignmentExpression(fn.parent) && t.isIdentifier(fn.parent.left)) calleeName = fn.parent.left.name;
      else if (t.isVariableDeclarator(fn.parent) && t.isIdentifier(fn.parent.id)) calleeName = fn.parent.id.name;
      else if (t.isFunctionDeclaration(fn.node)) calleeName = fn.node.id.name;
      let argOrder = null;
      if (calleeName) {
        fnPath.traverse({
          CallExpression(cp) {
            if (argOrder) return;
            if (t.isIdentifier(cp.node.callee, { name: calleeName })) {
              argOrder = cp.node.arguments.map((a) => (t.isIdentifier(a) ? a.name : null));
            }
          },
        });
      }
      if (argOrder) {
        const oi = argOrder.indexOf(fetch.op);
        const ai = argOrder.indexOf(fetch.operand);
        if (oi >= 0 && ai >= 0) {
          opVar = params[oi];
          operandVar = params[ai];
        }
      }
      if (!opVar) {
        // fall back: two params, first is opcode
        opVar = params[pi];
        operandVar = params.find((x, i) => i !== pi) || null;
      }
    }
    for (const c of sp.node.cases) {
      if (!c.test) continue;
      let opcode = numericCaseValue(c.test);
      if (opcode === null) continue;
      if (caseToOpcode) { if (!caseToOpcode.has(opcode)) continue; opcode = caseToOpcode.get(opcode); }
      let body = c.consequent;
      if (body.length === 1 && t.isBlockStatement(body[0])) body = body[0].body;
      handlers.push({ opcode, body, opVar, operandVar, switchNode: sp.node });
    }
  }
  return handlers;
}

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

function collectIdentifiers(root) {
  const names = new Set();
  t.traverseFast(root, (n) => {
    if (t.isIdentifier(n)) names.add(n.name);
  });
  return names;
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
  const { normalizeStatements } = require('./normalform');
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
      const ids = [...collectIdentifiers(n.test)].filter((x) => flagLocals.includes(x) && x !== roles.strict);
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

// ---------------------------------------------------------------------------
// 5. Put it together
// ---------------------------------------------------------------------------

function findGlobalName(ast) {
  // `let vmH = typeof globalThis !== "undefined" ? globalThis : ...`
  for (const st of ast.program.body) {
    if (!t.isVariableDeclaration(st)) continue;
    for (const d of st.declarations) {
      if (t.isIdentifier(d.id) && d.init && containsNode(d.init, (n) => t.isIdentifier(n, { name: 'globalThis' })) && t.isConditionalExpression(d.init)) return d.id.name;
    }
  }
  return null;
}

function findNamespaceName(ast, globalName) {
  // `let vms = vmH.vms || (vmH.vms = {})` / `vmH["vms"] ||= {}`
  for (const st of ast.program.body) {
    if (!t.isVariableDeclaration(st)) continue;
    for (const d of st.declarations) {
      if (t.isIdentifier(d.id) && d.init && containsNode(d.init, (n) => t.isIdentifier(n, { name: globalName })) && d.id.name !== globalName) return d.id.name;
    }
  }
  return null;
}

/** The global property the namespace lives in (`G.KEY || (G.KEY = {})`); VM programs reach it by this name. */
function findNamespaceKey(ast, globalName, nsName) {
  for (const st of ast.program.body) {
    if (!t.isVariableDeclaration(st)) continue;
    for (const d of st.declarations) {
      if (!t.isIdentifier(d.id, { name: nsName }) || !d.init) continue;
      let key = null;
      t.traverseFast(d.init, (n) => {
        if (!key && t.isMemberExpression(n) && t.isIdentifier(n.object, { name: globalName })) key = n.computed ? (t.isStringLiteral(n.property) ? n.property.value : null) : n.property.name;
      });
      return key;
    }
  }
  return null;
}

/**
 * The object literal returned in `block`: `return {...}`, or `var o = {...}; return o;` as builds
 * with transformObjectKeys write it.
 */
function returnedObject(block) {
  let found = null;
  t.traverseFast(block, (n) => {
    if (found) return;
    const body = t.isBlockStatement(n) ? n.body : null;
    if (!body) return;
    for (let i = 0; i < body.length && !found; i++) {
      const st = body[i];
      if (!t.isReturnStatement(st)) continue;
      if (t.isObjectExpression(st.argument)) found = st.argument;
      else if (t.isIdentifier(st.argument) && i > 0 && t.isVariableDeclaration(body[i - 1]) && body[i - 1].declarations.length === 1 &&
          t.isIdentifier(body[i - 1].declarations[0].id, { name: st.argument.name }) && t.isObjectExpression(body[i - 1].declarations[0].init)) found = body[i - 1].declarations[0].init;
    }
  });
  if (!found && t.isReturnStatement(block) && t.isObjectExpression(block.argument)) found = block.argument;
  return found;
}

function isGeneratorCopy(inner, fetch) {
  // generator interpreter: `if (op === CONST) { ...; return {...} }` guards before dispatch
  return inner.body.body.some(
    (st) => t.isIfStatement(st) && t.isBinaryExpression(st.test, { operator: '===' }) && t.isIdentifier(st.test.left, { name: fetch.op }) && t.isIdentifier(st.test.right) &&
      returnedObject(st.consequent),
  );
}

function yieldOpcodes(inner, fetch, factoryPath) {
  // returns [{constName, tagName}] for each `if (op === CONST) { let v = pop(); pc++; return { tagProp: TAG, valueProp: v, ... } }`
  const out = [];
  for (const st of inner.body.body) {
    if (!(t.isIfStatement(st) && t.isBinaryExpression(st.test, { operator: '===' }) && t.isIdentifier(st.test.left, { name: fetch.op }) && t.isIdentifier(st.test.right))) continue;
    const ret = returnedObject(st.consequent);
    if (!ret) continue;
    // first property whose value is an identifier that is a factory-level constant
    let tag = null, tagKey = null;
    for (const p of ret.properties) {
      if (t.isIdentifier(p.value)) {
        const b = factoryPath.scope.getBinding(p.value.name);
        if (b && b.path.isVariableDeclarator() && t.isNumericLiteral(b.path.node.init)) { tag = b.path.node.init.value; tagKey = t.isIdentifier(p.key) ? p.key.name : p.key.value; break; }
      }
    }
    const cb = factoryPath.scope.getBinding(st.test.right.name);
    const opcode = cb && cb.path.isVariableDeclarator() && t.isNumericLiteral(cb.path.node.init) ? cb.path.node.init.value : null;
    out.push({ opcode, tag, tagKey });
  }
  return out;
}

/**
 * Determine which of the yield tags means await / yield / yield*.
 * The async runner throws "Unexpected yield in async context" unless the tag equals the AWAIT tag;
 * the generator runner treats one tag as a plain yield (returns {value, done:false}) and the other as
 * delegation (looks up Symbol.iterator).
 */
function resolveYieldTags(factoryPath, tagKey) {
  const result = { await: null, yield: null, yieldStar: null };
  if (!tagKey) return result;
  const src = gen(factoryPath.node);
  const esc = tagKey.replace(/\$/g, '\\$');
  // async runner: `if (X.tag !== T) throw new Error("Unexpected yield in async context")`
  let m = src.match(new RegExp(`\\.${esc}!==(\\w+)\\)\\{?throw new Error\\("Unexpected yield in async context"`));
  const constVal = (name) => {
    const b = factoryPath.scope.getBinding(name);
    return b && b.path.isVariableDeclarator() && t.isNumericLiteral(b.path.node.init) ? b.path.node.init.value : null;
  };
  if (m) result.await = constVal(m[1]);
  // generator runner: `if (x.tag === X) { return { value: x.val, done: false } }` and `if (x.tag === D) { let it = x.val; ... Symbol.iterator`
  const re = new RegExp(`\\.${esc}===(\\w+)\\)\\{`, 'g');
  let mm;
  const seen = new Map();
  const blockAfter = (pos) => {
    // pos points at the `{` that opens the block; return its text (brace matching, string-aware)
    let depth = 0, i = pos, q = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') q = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(pos, i + 1);
  };
  while ((mm = re.exec(src))) {
    const after = blockAfter(mm.index + mm[0].length - 1);
    const v = constVal(mm[1]);
    if (v === null || v === result.await) continue;
    if (/Symbol\.iterator|is not iterable/.test(after)) seen.set(v, 'yieldStar');
    else if (/done:false/.test(after) && !seen.has(v)) seen.set(v, 'yield');
  }
  for (const [v, kind] of seen) if (!result[kind]) result[kind] = v;
  return result;
}

function locate(code, { log = () => {} } = {}) {
  const ast = parse(code);
  const globalName = findGlobalName(ast);
  const nsName = findNamespaceName(ast, globalName);
  const nsKey = nsName ? findNamespaceKey(ast, globalName, nsName) : null;
  const loops = findInterpreterLoops(ast);
  if (!loops.length) throw new Error('No VM interpreter loop found - not an obfuscator.io Virtualization build?');

  const interpreters = loops.map((loop) => {
    const pc = loop.outerPath.node.test.left.name;
    const fetch = parseFetch(loop.inner, pc);
    const fnPath = loop.outerPath.getFunctionParent();
    const generator = isGeneratorCopy(loop.inner, fetch);
    return { loop, fetch, fnPath, generator };
  });
  const plain = interpreters.find((i) => !i.generator) || interpreters[0];
  const genCopy = interpreters.find((i) => i.generator);

  // factory: nearest enclosing function of the interpreter that is an IIFE / holds the loaders
  let factoryPath = plain.fnPath.parentPath.getFunctionParent();
  while (factoryPath && !(t.isCallExpression(factoryPath.parent) || factoryPath.parentPath.isProgram())) {
    const up = factoryPath.parentPath.getFunctionParent();
    if (!up) break;
    factoryPath = up;
  }
  if (!factoryPath) throw new Error('Could not find the VM factory function');

  const handlers = collectHandlers(plain.fnPath, plain.fetch);
  const roles = inferRoles(plain.fnPath, plain.loop, plain.fetch, handlers, globalName);
  roles.global = globalName;
  roles.ns = nsName;
  const helpers = collectFactoryHelpers(factoryPath);

  let yields = { await: null, yield: null, yieldStar: null };
  if (genCopy) {
    const ys = yieldOpcodes(genCopy.loop.inner, genCopy.fetch, factoryPath);
    const tagKey = ys.find((y) => y.tagKey)?.tagKey;
    const tagRoles = resolveYieldTags(factoryPath, tagKey);
    for (const y of ys) {
      if (y.tag === tagRoles.await) yields.await = y.opcode;
      else if (y.tag === tagRoles.yield) yields.yield = y.opcode;
      else if (y.tag === tagRoles.yieldStar) yields.yieldStar = y.opcode;
    }
  }

  log(`interpreter found: ${interpreters.length} copies, ${handlers.length} handler bodies, factory=${factoryPath.node.id?.name || '(iife)'}`);
  return { ast, code, globalName, nsName, nsKey, factoryPath, plain, genCopy, handlers, roles, helpers, yields };
}

module.exports = { locate, parse, gen, collectHandlers, numericCaseValue, containsNode, collectIdentifiers, declaredLocals, prologueStatements };
