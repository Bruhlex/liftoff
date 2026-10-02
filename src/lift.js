'use strict';
/**
 * Step 4: lift a program's bytecode to a JavaScript AST.
 *
 * The VM is a stack machine whose bytecode is produced by a compiler from
 * structured source, so the control flow is reducible and can be recovered by
 * a recursive region walk over pc ranges:
 *
 *   - a backward jump closes a loop (`while`, `do/while`, `for..of`, `for..in`);
 *   - a forward conditional jump opens an `if`/`else`, a ternary, or a
 *     short-circuit `&&`/`||`/`??` (decided by the stack effect of the branches);
 *   - a chain of tests that jump into a run of consecutive bodies is a `switch`;
 *   - TRY_ENTER together with the program's try table gives `try/catch/finally`.
 *
 * Values are tracked on a symbolic stack of Babel expression nodes; opcodes
 * that produce statements (stores, drops of impure values, returns, ...) append
 * to the current region's statement list. Nested functions are lifted
 * recursively and inlined at their MAKE_CLOSURE site.
 */
const t = require('@babel/types');

const NUM_JUMP = new Set(['JMPF', 'JMPT', 'JMPF_KEEP', 'JMPT_KEEP', 'JMPF_POP2', 'JMPT_POP2', 'JMP_NOT_NULLISH', 'JMP_NULLISH', 'FUSED_JMPT', 'FUSED_JMPF', 'COND_TEMPLATE']);

/** Registers read / written by a behaviourally inferred template. */
function templateRegEffects(e, operand) {
  const reads = [], writes = [];
  const field = (f) => (f === 'op' ? operand : f === 'lo' ? operand & 0xffff : f === 'hi' ? operand >>> 16 : Number(String(f).slice(1)));
  const walk = (x) => {
    if (!x) return;
    if (x.k === 'leaf' && /^R:/.test(x.key)) reads.push(field(x.key.slice(2)));
    if (x.a) walk(x.a);
    if (x.b) walk(x.b);
  };
  (e.pushes || []).forEach(walk);
  (e.writes || []).forEach((w) => { walk(w.expr); if (/^R:/.test(w.target)) writes.push(field(w.target.slice(2))); });
  if (e.cond) walk(e.cond);
  for (const p of [e.taken, e.fall]) if (p) { p.pushes.forEach(walk); }
  return { reads, writes };
}

const isUndef = (n) => t.isIdentifier(n, { name: 'undefined' });

/** `root == null ? undefined : root.a.b(c)`  ->  `root?.a.b(c)` (null if expr is not a chain on root) */
function optionalChain(expr, root) {
  const links = [];
  let cur = expr;
  for (;;) {
    if (t.isMemberExpression(cur)) { links.push(cur); if (cur.object === root) break; cur = cur.object; continue; }
    if (t.isCallExpression(cur)) { links.push(cur); if (cur.callee === root) break; cur = cur.callee; continue; }
    return null;
  }
  let built = root;
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i];
    const first = i === links.length - 1;
    built = t.isMemberExpression(l) ? t.optionalMemberExpression(built, l.property, l.computed, first) : t.optionalCallExpression(built, l.arguments, first);
  }
  return built;
}

function countIdentity(tree, node) {
  let c = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n === node) { c++; return; }
    for (const k of t.VISITOR_KEYS[n.type] || []) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v); }
  };
  walk(tree);
  return c;
}

function replaceIdentity(tree, node, rep) {
  if (tree === node) return rep;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x, i) => { if (x === node) v[i] = t.cloneNode(rep); else walk(x); });
      else if (v === node) n[k] = t.cloneNode(rep);
      else walk(v);
    }
  };
  walk(tree);
  return tree;
}

function maxStackLeaf(x) {
  if (!x) return -1;
  let m = -1;
  if (x.k === 'leaf') { const r = /^S:(\d+)$/.exec(x.key); if (r) m = Number(r[1]); }
  return Math.max(m, maxStackLeaf(x.a), maxStackLeaf(x.b));
}
const UNCOND_JUMP = new Set(['JMP', 'JMP_UNWIND']);

// ---------------------------------------------------------------------------
// small AST helpers
// ---------------------------------------------------------------------------

const isIdentName = (s) => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s) && !RESERVED.has(s);
const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));

function constNode(c) {
  if (!c) return t.identifier('undefined');
  switch (c.t) {
    case 'string': return t.stringLiteral(c.v);
    case 'number': return numberNode(c.v);
    case 'boolean': return t.booleanLiteral(c.v);
    case 'null': return t.nullLiteral();
    case 'undefined': return t.identifier('undefined');
    case 'bigint': return t.bigIntLiteral(c.v);
    case 'regexp': return t.regExpLiteral(c.source, c.flags);
    case 'symbol': return t.callExpression(t.identifier('Symbol'), c.v === undefined ? [] : [t.stringLiteral(c.v)]);
    default: return t.identifier('undefined');
  }
}

function numberNode(v) {
  if (Number.isNaN(v)) return t.identifier('NaN');
  if (v === Infinity) return t.identifier('Infinity');
  if (v === -Infinity) return t.unaryExpression('-', t.identifier('Infinity'));
  if (v < 0 || Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(-v));
  return t.numericLiteral(v);
}

function member(obj, key) {
  // key: AST node
  if (t.isStringLiteral(key) && isIdentName(key.value)) return t.memberExpression(obj, t.identifier(key.value));
  if (t.isNumericLiteral(key)) return t.memberExpression(obj, key, true);
  return t.memberExpression(obj, key, true);
}

function optMember(obj, key) {
  if (t.isStringLiteral(key) && isIdentName(key.value)) return t.optionalMemberExpression(obj, t.identifier(key.value), false, true);
  return t.optionalMemberExpression(obj, key, true, true);
}

function propKey(key) {
  // returns {key, computed}
  if (t.isStringLiteral(key)) {
    if (isIdentName(key.value)) return { key: t.identifier(key.value), computed: false };
    if (/^(0|[1-9]\d*)$/.test(key.value)) return { key: t.numericLiteral(Number(key.value)), computed: false };
    return { key, computed: false };
  }
  if (t.isNumericLiteral(key)) return { key, computed: false };
  return { key, computed: true };
}

function isPure(node) {
  if (!node) return true;
  if (node.__underflow) return true;
  switch (node.type) {
    case 'Identifier': case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': case 'NullLiteral':
    case 'BigIntLiteral': case 'RegExpLiteral': case 'ThisExpression': case 'Super': case 'MetaProperty':
      return true;
    case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression':
      return true;
    case 'MemberExpression': case 'OptionalMemberExpression':
      return isPure(node.object) && (!node.computed || isPure(node.property));
    case 'UnaryExpression':
      return node.operator !== 'delete' && isPure(node.argument);
    case 'BinaryExpression': case 'LogicalExpression':
      return isPure(node.left) && isPure(node.right);
    case 'ConditionalExpression':
      return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
    case 'ArrayExpression':
      return node.elements.every((e) => !e || isPure(t.isSpreadElement(e) ? e.argument : e));
    case 'ObjectExpression':
      return node.properties.every((p) => (t.isObjectProperty(p) ? isPure(p.value) && (!p.computed || isPure(p.key)) : t.isSpreadElement(p) ? isPure(p.argument) : true));
    case 'TemplateLiteral':
      return node.expressions.every(isPure);
    case 'SequenceExpression':
      return node.expressions.every(isPure);
    default:
      return false;
  }
}

/** may a value be discarded without evaluating it? Like isPure, but a property read can run a
 *  getter or proxy trap, so an expression statement `obj.prop;` / `void obj.prop;` is kept */
function isDroppable(node) {
  if (!node) return true;
  // (a DUP'd member read that is dropped is a compiler artifact, e.g. the `this` of `a.b?.()`)
  let n = node;
  if (t.isUnaryExpression(n, { operator: 'void' })) n = n.argument;
  if ((t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) && !n.__dup) return false;
  return isPure(node);
}

/** `function (k) { let o = {}; o[k] = 0; return k; }`: the lowering's property-key helper, an identity */
function isKeyHelper(fn) {
  if (!t.isFunctionExpression(fn) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return false;
  const p = fn.params[0].name;
  let b = fn.body.body;
  // `let o; o = {};` (register declarations come first at this stage) -> `let o = {};`
  if (b.length === 4 && t.isVariableDeclaration(b[0]) && b[0].declarations.length === 1 && !b[0].declarations[0].init && t.isExpressionStatement(b[1]) &&
      t.isAssignmentExpression(b[1].expression, { operator: '=' }) && t.isIdentifier(b[1].expression.left, { name: b[0].declarations[0].id.name })) {
    b = [t.variableDeclaration('let', [t.variableDeclarator(b[0].declarations[0].id, b[1].expression.right)]), ...b.slice(2)];
  }
  return b.length === 3 && t.isVariableDeclaration(b[0]) && b[0].declarations.length === 1 && t.isObjectExpression(b[0].declarations[0].init) && b[0].declarations[0].init.properties.length === 0 &&
    t.isExpressionStatement(b[1]) && t.isAssignmentExpression(b[1].expression) && t.isMemberExpression(b[1].expression.left) && t.isIdentifier(b[1].expression.left.property, { name: p }) &&
    t.isReturnStatement(b[2]) && t.isIdentifier(b[2].argument, { name: p });
}

/** does code use `arguments` other than in `Array.prototype.slice.call(arguments, n)`? */
function usesArgumentsBeyondSlice(body, n) {
  let all = 0, slices = 0;
  for (const st of body) t.traverseFast(st, (x) => {
    if (t.isIdentifier(x, { name: 'arguments' })) all++;
    if (t.isCallExpression(x) && t.isMemberExpression(x.callee) && t.isIdentifier(x.callee.property, { name: 'call' }) && x.arguments.length === 2 &&
        t.isIdentifier(x.arguments[0], { name: 'arguments' }) && t.isNumericLiteral(x.arguments[1], { value: n })) slices++;
  });
  return all > slices;
}

function countIdent(nodes, name) {
  let c = 0;
  for (const n of [].concat(nodes)) t.traverseFast(n, (x) => { if (t.isIdentifier(x, { name })) c++; });
  return c;
}

function referencesName(node, name) {
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) hit = true; });
  return hit;
}

function assignedNames(stmt) {
  const names = new Set();
  t.traverseFast(stmt, (n) => {
    if (t.isAssignmentExpression(n) && t.isIdentifier(n.left)) names.add(n.left.name);
    if (t.isUpdateExpression(n) && t.isIdentifier(n.argument)) names.add(n.argument.name);
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) names.add(n.id.name);
  });
  return names;
}

/** Property names written by a statement (`a.b = ...`, `a[k]++`, ...); '*' for computed keys. */
function assignedProps(stmt) {
  const props = new Set();
  const note = (m) => {
    if (!t.isMemberExpression(m) && !t.isOptionalMemberExpression(m)) return;
    if (!m.computed && t.isIdentifier(m.property)) props.add(m.property.name);
    else if (t.isStringLiteral(m.property)) props.add(m.property.value);
    else props.add('*');
  };
  t.traverseFast(stmt, (n) => {
    if (t.isAssignmentExpression(n)) note(n.left);
    if (t.isUpdateExpression(n)) note(n.argument);
    if (t.isUnaryExpression(n, { operator: 'delete' })) note(n.argument);
  });
  return props;
}

function readsProps(v, props) {
  if (!props.size) return false;
  let hit = false;
  t.traverseFast(v, (n) => {
    if (hit || (!t.isMemberExpression(n) && !t.isOptionalMemberExpression(n))) return;
    if (props.has('*')) { hit = true; return; }
    const name = !n.computed && t.isIdentifier(n.property) ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null;
    if (name === null || props.has(name)) hit = true;
  });
  return hit;
}

function containsCall(node) {
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isCallExpression(n) || t.isNewExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n)) hit = true; });
  return hit;
}

// ---------------------------------------------------------------------------
// Lifter
// ---------------------------------------------------------------------------

// names occurring in the host program (and the VM runtime): synthetic names must not capture them
let HOST_NAMES = new Set();
const fresh = (n) => { while (HOST_NAMES.has(n)) n += "_"; return n; };
class Frame {
  constructor(id, slotCount, opts = {}) {
    this.id = id;
    this.slotCount = slotCount;
    this.names = new Map(); // slot -> variable name
    this.declared = new Set();
    this.kinds = new Map(); // slot -> 'let' | 'const'
    this.thisSlot = null;
    this.external = !!opts.external; // host / parent scope: never declare here
  }
  nameOf(slot, prefix) {
    if (this.thisSlot === slot) return null;
    if (!this.names.has(slot)) this.names.set(slot, fresh(`${prefix}${this.id}_${slot}`));
    return this.names.get(slot);
  }
}

class Lifter {
  /**
   * @param {object} ctx { table, programsById, nestedIndexToId, log, warn }
   */
  constructor(ctx) {
    this.ctx = ctx;
    HOST_NAMES = ctx.reserved || new Set();
    this.frameCounter = 0;
    this.tempCounter = 0;
    this.active = new Set(); // programs being lifted (recursion guard)
    this.globalVarDecls = new Set();
  }

  mnem(op) {
    const e = this.ctx.table.get(op);
    return e ? e.mnemonic : `UNKNOWN_${op}`;
  }
  entry(op) {
    return this.ctx.table.get(op) || { mnemonic: `UNKNOWN_${op}` };
  }

  /**
   * Lift a program to a function-like description.
   * @returns {{ params: Node[], body: Statement[], usesArguments: boolean, kind }}
   */
  liftProgram(prog, opts = {}) {
    const { parentChain = [], paramNames = null, isTopLevel = false } = opts;
    if (this.active.has(prog.id)) {
      this.ctx.warn(`recursive closure reference to program ${prog.id}`);
      return { params: [], body: [t.expressionStatement(t.stringLiteral(`/* recursive program ${prog.id} */`))], usesArguments: false };
    }
    this.active.add(prog.id);
    const fnFrame = new Frame(this.frameCounter++, prog.scopeSlots);
    const state = {
      prog,
      instrs: prog.instrs,
      jumps: prog.jumps,
      tries: prog.tries,
      chain: [...parentChain, fnFrame],
      fnFrame,
      paramNames: paramNames || Array.from({ length: prog.paramCount }, (_, i) => fresh(`a${i}`)),
      regNames: new Map(),
      usedRegs: new Set(),
      regIter: new Map(), // reg index -> iterable source expression (for..of bookkeeping)
      regForIn: new Map(), // reg index -> object expression (for..in keys)
      hiddenRegs: new Set(), // registers that only carry for..of/for..in bookkeeping
      usesArguments: false,
      loops: [],
      switchEnds: [],
      blocks: [],
      blockDone: new Set(),
      labelCounter: 0,
      declaredLets: [],
      isTopLevel,
      catchCounter: 0,
    };
    state.baseChain = state.chain.slice();
    state.enterFrames = new Map();
    this.computeScopeStacks(state);
    this.computeLoopEnds(state);
    this.computeForLet(state);
    this.computeSlotNames(state);
    this.computeParamSplit(state);
    this.computeTempRegs(state);
    const { stmts, stack } = this.liftRange(state, 0, prog.instrs.length, []);
    for (const v of stack) if (!isPure(v)) stmts.push(t.expressionStatement(v));
    this.removeHiddenRegStores(state, stmts);

    // register declarations
    const regDecls = [];
    const splitInits = [];
    for (const r of [...state.usedRegs].sort((a, b) => a - b)) {
      if (state.hiddenRegs.has(r)) continue;
      if (r < prog.paramCount) {
        if (state.splitRegs.has(r)) splitInits.push(t.variableDeclarator(t.identifier(this.regName(state, r)), t.identifier(state.paramNames[r])));
        continue;
      }
      regDecls.push(this.regName(state, r));
    }
    const body = [];
    if (splitInits.length) body.push(t.variableDeclaration('let', splitInits));
    if (regDecls.length) {
      body.push(t.variableDeclaration('let', regDecls.map((n) => t.variableDeclarator(t.identifier(n)))));
    }
    body.push(...stmts);
    // drop a trailing `return undefined;` / `return;`
    const last = body[body.length - 1];
    if (t.isReturnStatement(last) && (!last.argument || t.isIdentifier(last.argument, { name: 'undefined' }))) body.pop();
    this.active.delete(prog.id);
    return {
      params: state.paramNames.map((n) => t.identifier(n)),
      body,
      usesArguments: state.usesArguments,
      paramCount: prog.paramCount,
    };
  }

  dropIterInit(state, reg) {
    const st = state.iterInit && state.iterInit.get(reg);
    if (st) { st.__remove = true; state.iterInit.delete(reg); }
  }

  /** Drop `rN = <literal>` statements for registers that only carried loop bookkeeping. */
  removeHiddenRegStores(state, stmts) {
    const names = new Set([...state.hiddenRegs].map((r) => this.regName(state, r)));
    const isHiddenStore = (s) => s.__remove || (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) && t.isIdentifier(s.expression.left) && names.has(s.expression.left.name) && (t.isLiteral(s.expression.right) || t.isIdentifier(s.expression.right)));
    const walk = (node) => {
      // nested closures are other programs with their own registers (same names, other variables)
      if (!node || typeof node.type !== 'string' || t.isFunction(node) || t.isClass(node)) return;
      for (const k of t.VISITOR_KEYS[node.type] || []) {
        const v = node[k];
        if (Array.isArray(v)) {
          for (let i = v.length - 1; i >= 0; i--) {
            if (v[i] && isHiddenStore(v[i])) v.splice(i, 1);
            else walk(v[i]);
          }
        } else if (v && typeof v.type === 'string') walk(v);
      }
    };
    for (let i = stmts.length - 1; i >= 0; i--) {
      if (isHiddenStore(stmts[i])) stmts.splice(i, 1);
      else walk(stmts[i]);
    }
  }

  /** A readable name that is not yet used in this program (item, item2, ...). */
  freshName(state, base) {
    state.usedNames = state.usedNames || new Set([...state.paramNames]);
    let name = base, i = 1;
    while (state.usedNames.has(name) || HOST_NAMES.has(name)) name = `${base}${++i}`;
    state.usedNames.add(name);
    return name;
  }

  /**
   * Registers 0..paramCount-1 start as copies of the arguments, but the VM keeps
   * the arguments array separately (LOAD_ARG / STORE_ARG). When a program both
   * overwrites a parameter register and accesses the same argument slot, the two
   * diverge and the register needs its own variable, initialised from the parameter.
   */
  computeParamSplit(state) {
    const storedRegs = new Set(), argSlots = new Set();
    for (const [op, operand] of state.instrs) {
      const e = this.entry(op);
      const m = e.mnemonic;
      if (m === 'STORE_REG' || m === 'REG_INC' || m === 'REG_DEC' || m === 'REG_PREINC' || m === 'REG_PREDEC') storedRegs.add(operand);
      if (m === 'LOAD_ARG' || m === 'STORE_ARG') argSlots.add(operand);
      if (m === 'TEMPLATE' || m === 'COND_TEMPLATE') {
        const f = (x) => (x === 'op' ? operand : x === 'lo' ? operand & 0xffff : x === 'hi' ? operand >>> 16 : Number(String(x).slice(1)));
        for (const w of e.writes || []) if (w.target.startsWith('R:')) storedRegs.add(f(w.target.slice(2)));
        const walk = (x) => { if (!x) return; if (x.k === 'leaf' && x.key.startsWith('A:')) argSlots.add(f(x.key.slice(2))); walk(x.a); walk(x.b); };
        [...(e.pushes || []), ...(e.writes || []).map((w) => w.expr), e.cond].forEach(walk);
        for (const w of e.writes || []) if (w.target.startsWith('A:')) argSlots.add(f(w.target.slice(2)));
      }
    }
    state.splitRegs = new Set([...storedRegs].filter((r) => r < state.prog.paramCount && argSlots.has(r)));
  }

  regName(state, r) {
    if (r < state.prog.paramCount && !(state.splitRegs && state.splitRegs.has(r))) return state.paramNames[r];
    if (!state.regNames.has(r)) state.regNames.set(r, fresh(`r${r}`));
    return state.regNames.get(r);
  }
  regId(state, r) {
    state.usedRegs.add(r);
    return t.identifier(this.regName(state, r));
  }

  /**
   * A read of variable `name` while an unflushed `(name = v)` expression is still
   * on the stack would observe the old value in the emitted code (JS evaluates
   * operands left to right). Emit such assignments as statements first.
   */
  flushAssignmentsTo(state, stack, emit, name) {
    const isTarget = (v) => v && t.isAssignmentExpression(v, { operator: '=' }) && t.isIdentifier(v.left, { name });
    const flushed = new Set();
    const flush = (v) => { if (!flushed.has(v)) { flushed.add(v); emit(t.expressionStatement(t.assignmentExpression('=', t.identifier(name), v.right))); } };
    // replace (possibly nested, possibly shared) `(name = v)` nodes by `name`
    const walk = (n) => {
      if (!n || typeof n.type !== 'string' || t.isFunction(n) || t.isClass(n)) return;
      for (const k of t.VISITOR_KEYS[n.type] || []) {
        const c = n[k];
        if (Array.isArray(c)) c.forEach((x, i) => { if (isTarget(x)) { walk(x.right); flush(x); c[i] = t.identifier(name); } else walk(x); });
        else if (isTarget(c)) { walk(c.right); flush(c); n[k] = t.identifier(name); }
        else walk(c);
      }
    };
    for (let i = 0; i < stack.length; i++) {
      const v = stack[i];
      if (isTarget(v)) { walk(v.right); flush(v); stack[i] = t.identifier(name); }
      else walk(v);
    }
  }

  /**
   * Registers with exactly one STORE_REG site that precedes every LOAD of the
   * register are compiler temporaries (e.g. the callee copied before argument
   * evaluation). When the stored value is a simple, side-effect-free
   * expression it is substituted at its uses instead of materializing `rN`.
   */
  computeTempRegs(state) {
    const stores = new Map(), loads = new Map();
    state.instrs.forEach(([op, operand], pc) => {
      const m = this.mnem(op);
      const e = this.entry(op);
      if (m === 'TEMPLATE' || m === 'COND_TEMPLATE') {
        const fx = templateRegEffects(e, operand);
        for (const r of fx.reads) (loads.get(r) || loads.set(r, []).get(r)).push(pc);
        for (const r of fx.writes) (stores.get(r) || stores.set(r, []).get(r)).push(pc, pc);
        return;
      }
      if (m === 'STORE_REG') (stores.get(operand) || stores.set(operand, []).get(operand)).push(pc);
      else if (m === 'LOAD_REG' || m === 'FOR_OF_NEXT') (loads.get(operand) || loads.set(operand, []).get(operand)).push(pc);
      else if (['REG_INC', 'REG_DEC', 'REG_PREINC', 'REG_PREDEC', 'FUSED_BINOP', 'GETPROP_REG_CONST', 'FUSED_JMPT', 'FUSED_JMPF', 'CALL_METHOD_REG_CONST'].includes(m)) {
        const r = m.startsWith('REG_') ? operand : operand & 0xffff;
        (loads.get(r) || loads.set(r, []).get(r)).push(pc);
        if (m.startsWith('REG_')) (stores.get(r) || stores.set(r, []).get(r)).push(pc);
      }
    });
    state.tempRegs = new Set();
    state.tempWindow = new Map(); // reg -> { stores, effects } between its store and last load
    const STORE_OPS = new Set(['STORE_REG', 'STORE_ARG', 'STORE_LOCAL', 'STORE_LOCAL_CONST', 'STORE_SCOPE', 'STORE_GLOBAL', 'STORE_GLOBAL_DECL', 'REG_INC', 'REG_DEC', 'REG_PREINC', 'REG_PREDEC', 'TEMPLATE']);
    const EFFECT_OPS = new Set(['CALL', 'CALL_METHOD', 'CALL_IMM', 'CALL_METHOD_IMM', 'CALL_METHOD_REG_CONST', 'NEW', 'SUPER_CALL', 'SUPER_SET', 'SETPROP_NAMED', 'SETPROP_COMPUTED', 'DELETE_PROP', 'AWAIT', 'YIELD', 'YIELD_STAR', 'ARR_PUSH', 'OBJ_SPREAD', 'DEFINE_PROP_NAMED', 'DEFINE_PROP_COMPUTED']);
    for (const [r, sps] of stores) {
      if (r < state.prog.paramCount || sps.length !== 1) continue;
      const ls = loads.get(r) || [];
      if (!ls.every((l) => l > sps[0])) continue;
      // a value stored inside a try block but read after it must stay in a register: the
      // statements that compute it are block-scoped to the try
      const inTry = Object.entries(state.tries).some(([tp, tr]) => {
        if (!tr) return false;
        // the try body ends where the first handler (catch / finally) or the region end begins
        const hStart = tr[0] !== null ? tr[0] : tr[1] !== null ? tr[1] : tr[2] !== null ? tr[2] : Infinity;
        return sps[0] > Number(tp) && sps[0] < hStart && ls.some((l) => l >= hStart);
      });
      if (inTry) continue;
      state.tempRegs.add(r);
      let last = ls.length ? Math.max(...ls) : sps[0];
      // a load inside a loop that the store is not part of runs on every iteration: everything up
      // to the loop's back edge runs between two such reads (`offset = a.length; while (..) a[offset + i] = ..`)
      let repeated = false;
      for (const [f, to] of Object.entries(state.jumps)) {
        const fn = Number(f);
        if (to > sps[0] && to <= fn && ls.some((l) => l >= to && l <= fn)) { repeated = true; if (fn > last) last = fn; }
      }
      // stores into other registers only matter to values that read those registers
      let st = false, fx = false;
      const regStores = new Set();
      for (let q = sps[0] + 1; q < last; q++) {
        const mm = this.mnem(state.instrs[q][0]);
        if (mm === 'STORE_REG') { regStores.add(state.instrs[q][1]); continue; }
        if (STORE_OPS.has(mm)) st = true;
        if (EFFECT_OPS.has(mm) || STORE_OPS.has(mm)) fx = true;
      }
      state.tempWindow.set(r, { stores: st, effects: fx, regStores, loads: repeated ? Math.max(2, ls.length) : ls.length });
    }
    state.tempValues = new Map();
  }

  /** May the value stored into temp register r be substituted at its loads? */
  isSimpleValue(v, win = null) {
    if (!v || v.__marker || v.__builder || v.__noTemp) return false;
    // a regex literal creates a new object (with its own lastIndex) on every evaluation
    if (t.isRegExpLiteral(v) || t.isTemplateLiteral(v)) return false;
    if (t.isThisExpression(v) || t.isLiteral(v)) return true;
    if (t.isIdentifier(v)) {
      if (!win) return true;
      if (win.regStoreNames && win.regStoreNames.has(v.name)) return false;
      // a captured (scope) or global variable can also change through any call in between
      if (v.__scopeRef && win.effects) return false;
      return !win.stores;
    }
    // property reads may change between store and load (e.g. `const t = a[i]; i += 2; use(t)`)
    if (t.isMemberExpression(v)) return !!win && !win.effects && (!v.computed ? this.isSimpleValue(v.object, win) : this.isSimpleValue(v.object, win) && this.isSimpleValue(v.property, win));
    return false;
  }

  /**
   * Block-scope nesting per instruction, computed by propagating along the
   * control-flow graph (ENTER_SCOPE pushes, EXIT_SCOPE pops, try handlers start
   * with the scope active at TRY_ENTER). Linear tracking during lifting is wrong
   * as soon as several exit paths (return, break, catch) each unwind scopes.
   */
  computeScopeStacks(state) {
    const { instrs, jumps, tries } = state;
    const stacks = new Array(instrs.length);
    const work = [[0, []]];
    const TERMINAL = new Set(['RETURN', 'THROW', 'JMP', 'JMP_UNWIND']);
    while (work.length) {
      const [pc, st] = work.pop();
      if (pc < 0 || pc >= instrs.length || stacks[pc]) continue;
      stacks[pc] = st;
      const m = this.mnem(instrs[pc][0]);
      let out = st;
      if (m === 'ENTER_SCOPE') out = [...st, pc];
      else if (m === 'EXIT_SCOPE') out = st.slice(0, -1);
      if (!TERMINAL.has(m)) work.push([pc + 1, out]);
      if (jumps[pc] !== undefined) work.push([jumps[pc], out]);
      if (m === 'TRY_ENTER' && tries[pc]) for (const h of tries[pc]) if (h !== null) work.push([h, st]);
    }
    state.scopeStacks = stacks;
  }

  frameForEnter(state, enterPc) {
    if (state.frameAlias && state.frameAlias.has(enterPc)) enterPc = state.frameAlias.get(enterPc);
    if (!state.enterFrames.has(enterPc)) state.enterFrames.set(enterPc, new Frame(this.frameCounter++, state.instrs[enterPc][1]));
    return state.enterFrames.get(enterPc);
  }

  /** Scope chain (outermost first) that is active at the instruction being lifted. */
  chainAt(state) {
    const st = state.scopeStacks && state.scopeStacks[state.curPc];
    if (!st) return state.chain;
    return [...state.baseChain, ...st.map((p) => this.frameForEnter(state, p))];
  }

  currentFrame(state) {
    const c = this.chainAt(state);
    return c[c.length - 1];
  }

  /**
   * `for (let i = ...; cond; update)` whose variables are captured by closures lives in scope
   * slots, and the compiler implements the per-iteration bindings literally:
   *
   *   ENTER_SCOPE A; <init: STORE_LOCAL k>;  LOAD_SCOPE k..; PUSH_SCOPE; ENTER_SCOPE B; STORE_LOCAL k..
   *   H: <cond>; JMPF exit; <body>;
   *   T: LOAD_SCOPE k..; EXIT_SCOPE; PUSH_SCOPE; ENTER_SCOPE C; STORE_LOCAL k..; <update>; JMP H
   *
   * A, B and C are one source variable. They are aliased to one frame here, and liftLoop emits
   * a real `for (let ...)` statement so that JavaScript recreates the per-iteration copies.
   */
  computeForLet(state) {
    const { instrs, jumps } = state;
    const M = (q) => (q >= 0 && q < instrs.length ? this.mnem(instrs[q][0]) : null);
    state.forLet = new Map();
    state.frameAlias = new Map();
    for (const [H, L] of state.loopEnds) {
      if (M(L) !== 'JMP' || jumps[L] !== H) continue;
      // header copy ending at H-1
      let k = 0;
      while (M(H - 1 - k) === 'STORE_LOCAL') k++;
      if (!k || M(H - 1 - k) !== 'ENTER_SCOPE' || M(H - 2 - k) !== 'PUSH_SCOPE') continue;
      const slots = [];
      let ok = true;
      for (let i = 0; i < k; i++) {
        const ld = H - 2 - k - k + i; // LOAD_SCOPE of slot i
        if (M(ld) !== 'LOAD_SCOPE' || (instrs[ld][1] >>> 16) !== 0) { ok = false; break; }
        slots.push(instrs[ld][1] & 0xffff);
      }
      if (!ok) continue;
      // tail copy: the last EXIT_SCOPE in the loop followed by the same copy sequence
      let T = -1;
      for (let q = L - 1; q > H; q--) {
        if (M(q) === 'EXIT_SCOPE' && M(q + 1) === 'PUSH_SCOPE' && M(q + 2) === 'ENTER_SCOPE') { T = q; break; }
      }
      if (T < 0) continue;
      for (let i = 0; i < k; i++) if (M(T - k + i) !== 'LOAD_SCOPE' || (instrs[T - k + i][1] & 0xffff) !== slots[i] || (instrs[T - k + i][1] >>> 16) !== 0) ok = false;
      for (let i = 0; i < k; i++) if (M(T + 3 + i) !== 'STORE_LOCAL') ok = false;
      if (!ok) continue;
      // no jump into the copy code other than to its start (continue targets T-k)
      const tailStart = T - k;
      for (const [from, to] of Object.entries(jumps)) if (to > tailStart && to <= T + 2 + k && Number(from) !== L) ok = false;
      if (!ok) continue;
      const enterB = H - 1 - k, enterC = T + 2;
      const outer = state.scopeStacks[H - 2 - 2 * k];
      const enterA = outer && outer.length ? outer[outer.length - 1] : null;
      const root = enterA !== null ? enterA : enterB;
      state.frameAlias.set(enterB, root);
      state.frameAlias.set(enterC, root);
      state.forLet.set(H, { slots, tailStart, updateStart: T + 3 + k, enterA });
    }
  }

  /**
   * Variable names from DECLARE_TDZ, assigned before lifting: hoisted function declarations
   * are created (and lifted) at scope entry, before the declarations of the variables they
   * close over.
   */
  computeSlotNames(state) {
    const K = state.prog.consts;
    // the obfuscator may give variables of nested scopes the same name (harmless in the VM, which
    // addresses slots); names are made unique within the program and against captured scopes
    const owners = new Map();
    for (const f of state.baseChain) for (const [sl, nm] of f.names) owners.set(nm, `${f.id}:${sl}`);
    const uniqueName = (name, frame, slot) => {
      const me = `${frame.id}:${slot}`;
      let n = name, k = 1;
      while (owners.has(n) && owners.get(n) !== me) n = `${name}_${k++}`;
      owners.set(n, me);
      return n;
    };
    for (let pc = 0; pc < state.instrs.length; pc++) {
      if (this.mnem(state.instrs[pc][0]) !== 'DECLARE_TDZ' || !state.scopeStacks[pc]) continue;
      const operand = state.instrs[pc][1];
      const slot = operand & 0xffff, nameIdx = operand >>> 16;
      const c = K[nameIdx - 1];
      if (!nameIdx || !c || c.t !== 'string' || !isIdentName(c.v)) continue;
      state.curPc = pc;
      const frame = this.currentFrame(state);
      if (frame && !frame.external && !frame.names.has(slot)) frame.names.set(slot, uniqueName(c.v, frame, slot));
    }
    // slots first declared/stored inside a branch, loop or try block nested in their scope (the
    // compiler emits e.g. DECLARE_TDZ of a destructured parameter inside the default-value
    // branch): declared at scope entry, so every later use refers to the same binding
    state.hoistSlots = new Map();
    const seenSlot = new Set();
    const jumpList = Object.entries(state.jumps).map(([f, to]) => [Number(f), to]);
    for (let pc = 0; pc < state.instrs.length; pc++) {
      const mq = this.mnem(state.instrs[pc][0]);
      if (mq !== 'DECLARE_TDZ' && mq !== 'STORE_LOCAL' && mq !== 'STORE_LOCAL_CONST') continue;
      const st = state.scopeStacks[pc];
      if (!st || !st.length) continue;
      const e = st[st.length - 1];
      const slot = mq === 'DECLARE_TDZ' ? state.instrs[pc][1] & 0xffff : state.instrs[pc][1];
      if (slot < 0) continue;
      const key = `${e}:${slot}`;
      if (seenSlot.has(key)) continue;
      seenSlot.add(key);
      const branched = jumpList.some(([f, to]) => (f > e && f < pc && to > pc) || (to > e && to <= pc && f > pc)) ||
        Object.entries(state.tries).some(([tp, tr]) => Number(tp) > e && Number(tp) < pc && tr && (tr[2] === null || tr[2] > pc));
      if (branched) {
        if (!state.hoistSlots.has(e)) state.hoistSlots.set(e, new Set());
        state.hoistSlots.get(e).add(slot);
      }
    }
    // `MAKE_CLASS <name>; ...members...; DUP; STORE_LOCAL_CONST k`: slot k is the class's inner
    // name binding or a temporary of the private-member / class-expression lowering
    // (`__$classExpr__X$__`); methods lifted before the store must already use the class name
    const JUMPS = new Set([...NUM_JUMP, ...UNCOND_JUMP, 'RETURN', 'THROW', 'TRY_ENTER']);
    for (let c = 1; c < state.instrs.length; c++) {
      if (this.mnem(state.instrs[c][0]) !== 'MAKE_CLASS' || this.mnem(state.instrs[c - 1][0]) !== 'PUSH_CONST') continue;
      const nc = K[state.instrs[c - 1][1]];
      if (!nc || nc.t !== 'string' || !isIdentName(nc.v)) continue;
      for (let q = c + 1; q < state.instrs.length && q < c + 400; q++) {
        const mq = this.mnem(state.instrs[q][0]);
        if (JUMPS.has(mq) || mq === 'MAKE_CLASS') break;
        if (mq === 'STORE_LOCAL_CONST' && this.mnem(state.instrs[q - 1][0]) === 'DUP') {
          state.curPc = q;
          const frame = this.currentFrame(state);
          const k = state.instrs[q][1];
          // only unnamed slots, lowering temporaries (`__$...$__`) and the class's own name
          const cur = frame && frame.names.get(k);
          if (frame && !frame.external && (!cur || /^__\$.*\$__$/.test(cur) || cur === nc.v || cur.replace(/_\d+$/, '') === nc.v)) frame.names.set(k, nc.v);
        }
      }
    }
    state.curPc = 0;
  }

  computeLoopEnds(state) {
    // header pc -> pc of the last backward jump (unconditional or conditional) targeting it
    const loopEnds = new Map();
    const { instrs, jumps } = state;
    for (let pc = 0; pc < instrs.length; pc++) {
      const m = this.mnem(instrs[pc][0]);
      if (UNCOND_JUMP.has(m) || NUM_JUMP.has(m)) {
        const tgt = jumps[pc];
        if (tgt !== undefined && tgt <= pc) {
          if (!loopEnds.has(tgt) || loopEnds.get(tgt) < pc) loopEnds.set(tgt, pc);
        }
      }
    }
    state.loopEnds = loopEnds;
  }

  // -------------------------------------------------------------------------
  // region walker
  // -------------------------------------------------------------------------

  liftRange(state, start, end, inStack) {
    const stmts = [];
    let stack = inStack.slice();
    const emit = (s) => stmts.push(s);
    let pc = start;

    while (pc < end) {
      const [op, operand] = state.instrs[pc];
      const m = this.mnem(op);
      state.curPc = pc;

      // loop header?
      const loopEnd = state.loopEnds.get(pc);
      // a `break label` out of a loop to a point behind code that follows the loop: the loop and
      // that code form a labeled block
      if (loopEnd !== undefined && loopEnd < end && loopEnd >= pc && !state.blockDone.has(pc)) {
        const esc = this.escapeTarget(state, pc, loopEnd, end);
        if (esc !== null) {
          state.blockDone.add(pc);
          const label = `L${++state.labelCounter}`;
          state.blocks.push({ target: esc, label, used: false });
          const inner = this.liftRange(state, pc, esc, stack);
          const blk = state.blocks.pop();
          stack = inner.stack;
          emit(blk.used ? t.labeledStatement(t.identifier(label), t.blockStatement(inner.stmts)) : t.blockStatement(inner.stmts));
          pc = esc;
          continue;
        }
      }
      if (loopEnd !== undefined && loopEnd < end && loopEnd >= pc) {
        const r = this.liftLoop(state, pc, loopEnd, stack, emit, stmts);
        stack = r.stack;
        pc = r.next;
        continue;
      }

      if (m === 'TRY_ENTER' && state.tries[pc]) {
        const d = this.liftArrayDestructure(state, pc, end, stack, emit);
        if (d) { stack = d.stack; pc = d.next; continue; }
        const r = this.liftTry(state, pc, end, stack, emit);
        stack = r.stack;
        pc = r.next;
        continue;
      }

      if (NUM_JUMP.has(m)) {
        const sw = m === 'JMPT' ? this.trySwitch(state, pc, end, stack, emit) : null;
        if (sw) { stack = sw.stack; pc = sw.next; continue; }
        // `out: if (..) { .. if (..) { .. } else { break out; } .. }`: a jump from inside a nested
        // branch to a point behind this conditional; the conditional and the code up to that point
        // form a labeled block
        const esc = state.blockDone.has(pc) ? null : this.deepBreakTarget(state, pc, end);
        if (esc !== null) {
          state.blockDone.add(pc);
          const label = `L${++state.labelCounter}`;
          state.blocks.push({ target: esc, label, used: false });
          const inner = this.liftRange(state, pc, esc, stack);
          const blk = state.blocks.pop();
          stack = inner.stack;
          emit(blk.used ? t.labeledStatement(t.identifier(label), t.blockStatement(inner.stmts)) : t.blockStatement(inner.stmts));
          pc = esc;
          continue;
        }
        const r = this.liftConditional(state, pc, end, stack, emit);
        stack = r.stack;
        pc = r.next;
        continue;
      }

      if (UNCOND_JUMP.has(m)) {
        const tgt = state.jumps[pc];
        const jr = this.jumpStatement(state, tgt, end);
        if (jr === 'end') { pc++; continue; }
        if (jr) {
          this.flushImpure(stack, emit, state);
          emit(jr);
          // code between here and the next jump target is unreachable unless jumped into
          pc++;
          continue;
        }
        if (tgt > pc && tgt <= end) { pc = tgt; continue; } // skip dead code
        emit(this.comment(`unresolved jump to ${tgt}`));
        pc++;
        continue;
      }

      if (m === 'RETURN') {
        const v = this.pop(stack);
        this.spillForStatement(state, stack, emit, null);
        if (t.isIdentifier(v, { name: 'undefined' })) emit(t.returnStatement());
        else emit(t.returnStatement(v));
        pc++;
        continue;
      }
      if (m === 'THROW') {
        const v = this.pop(stack);
        emit(t.throwStatement(v));
        pc++;
        continue;
      }
      if (m === 'FOR_OF_NEXT') {
        // loop header should have caught this; treat generically: push next value
        const it = this.regId(state, operand);
        stack.push(t.memberExpression(t.callExpression(t.memberExpression(it, t.identifier('next')), []), t.identifier('value')));
        pc++;
        continue;
      }

      state.curPc = pc;
      state.nextIsDrop = pc + 1 < end && this.mnem(state.instrs[pc + 1][0]) === 'DROP';
      this.step(state, m, op, operand, stack, emit, pc);
      state.nextIsDrop = false;
      pc++;
    }
    return { stmts, stack };
  }

  comment(text) {
    const s = t.emptyStatement();
    t.addComment(s, 'leading', ` ${text} `);
    return s;
  }

  /** Statement for a jump to `tgt` from inside a region ending at `end`, or null. */
  /** pc after a run of EXIT_SCOPE instructions (a `break` may target either end of the run) */
  skipScopeExits(state, pc) {
    while (pc < state.instrs.length && this.mnem(state.instrs[pc][0]) === 'EXIT_SCOPE') pc++;
    return pc;
  }

  /**
   * Target of a jump inside the loop [H, L] that leaves the loop for a point behind code that follows
   * it (and that no enclosing loop / switch / block resolves): the end of a labeled block, else null.
   */
  escapeTarget(state, H, L, end) {
    const { jumps } = state;
    // natural exits of this loop: behind the back edge, or the target of its header test
    const natural = new Set([L + 1]);
    for (let q = H; q < L; q++) {
      const mq = this.mnem(state.instrs[q][0]);
      if ((NUM_JUMP.has(mq) || mq === 'FOR_OF_NEXT') && jumps[q] > L) { natural.add(jumps[q]); natural.add(jumps[q] + 1); break; }
    }
    // (a try region around the loop body adds its own exits)
    for (const [tp, tr] of Object.entries(state.tries)) if (tr && Number(tp) > H && Number(tp) < L && tr[2] !== null && tr[2] > L) { natural.add(tr[2]); natural.add(tr[2] + 1); }
    // (`break` from inside scopes jumps behind the EXIT_SCOPE instructions that follow the exit)
    for (const x of [...natural]) natural.add(this.skipScopeExits(state, x));
    const resolved = (tgt) => tgt === end || natural.has(tgt) ||
      state.loops.some((l) => tgt === l.exit || tgt === l.header || tgt === l.update) || state.switchEnds.some((sw) => tgt === sw.end) || state.blocks.some((b) => b.target === tgt);
    let best = null;
    for (const [f, to] of Object.entries(jumps)) {
      const fn = Number(f);
      if (fn <= H || fn >= L || to <= L + 1 || to >= end || resolved(to)) continue;
      const mf = this.mnem(state.instrs[fn][0]);
      if (!UNCOND_JUMP.has(mf) && !NUM_JUMP.has(mf)) continue;
      if (best === null || to > best) best = to;
    }
    return best;
  }

  /**
   * Target of a `break label` out of the conditional at `pc`, or null: an unconditional forward
   * jump inside the conditional that lies within a nested region ending before its target (so
   * falling through cannot reach the target), and that no enclosing loop, switch or block resolves.
   */
  deepBreakTarget(state, pc, end) {
    const { jumps, instrs } = state;
    let regionEnd = jumps[pc];
    // (a jump to the end of the range being lifted is a plain fallthrough there)
    if (!(regionEnd > pc) || regionEnd > end) return null;
    const before = regionEnd - 1;
    // an `else` branch: the then-branch ends with a plain jump over it
    if (before > pc && this.mnem(instrs[before][0]) === 'JMP' && jumps[before] > regionEnd && jumps[before] <= end) regionEnd = jumps[before];
    const resolved = (tgt) => state.loops.some((l) => tgt === l.exit || tgt === l.header || tgt === l.update || tgt === l.back) ||
      state.switchEnds.some((sw) => tgt === sw.end) || state.blocks.some((b) => b.target === tgt);
    const list = Object.entries(jumps).map(([f, to]) => [Number(f), to]).filter(([f]) => f > pc && f < regionEnd);
    let best = null;
    for (const [f, T] of list) {
      if (!UNCOND_JUMP.has(this.mnem(instrs[f][0])) || T <= f || T >= end || (T !== jumps[pc] && T !== regionEnd) || resolved(T)) continue;
      // a break out of an inner loop or try region is structured there
      if ([...state.loopEnds].some(([H, L]) => H > pc && H <= f && f <= L)) continue;
      if (Object.entries(state.tries).some(([tp, tr]) => tr && Number(tp) > pc && Number(tp) < f && (tr[2] === null || tr[2] >= f))) continue;
      // nested: some jump between pc and f lands between f and T (not right behind f, where f is
      // just the jump over a nested `else`)
      if (!list.some(([h, to]) => h < f && to > f + 1 && to < T)) continue;
      if (best === null || T > best) best = T;
    }
    return best;
  }

  jumpStatement(state, tgt, end) {
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      if (state.blocks[i].target === tgt) { state.blocks[i].used = true; return t.breakStatement(t.identifier(state.blocks[i].label)); }
    }
    if (tgt === end) return 'end';
    // innermost loop first
    for (let i = state.loops.length - 1; i >= 0; i--) {
      const L = state.loops[i];
      const inner = i === state.loops.length - 1;
      if (tgt === L.exit || tgt > L.exit && this.skipScopeExits(state, L.exit) === tgt) {
        if (!inner || state.switchEnds.length && state.switchEnds[state.switchEnds.length - 1].depth === state.loops.length) L.label = L.label || `L${++state.labelCounter}`;
        return t.breakStatement(inner && !L.label ? null : t.identifier(L.label));
      }
      if (tgt === L.header || tgt === L.update || (L.back !== undefined && tgt === L.back && UNCOND_JUMP.has(this.mnem(state.instrs[L.back][0])))) {
        if (!inner) L.label = L.label || `L${++state.labelCounter}`;
        return t.continueStatement(inner && !L.label ? null : t.identifier(L.label));
      }
    }
    if (state.switchEnds.length) {
      const S = state.switchEnds[state.switchEnds.length - 1];
      if (tgt === S.end) return t.breakStatement();
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // loops
  // -------------------------------------------------------------------------

  liftLoop(state, H, L, inStack, emit, outStmts = null) {
    const { instrs, jumps } = state;
    if (process.env.VMDEC_TRACE) console.error(`[trace] program ${state.prog.id}: loop ${H}..${L}`);
    const stack = inStack.slice();
    const exitDefault = L + 1;

    // ---- for..of idiom -------------------------------------------------
    // H: [PUSH_CONST false; STORE_REG d; DROP]* FOR_OF_NEXT r -> X ; [TRY_ENTER] ; STORE x ; body ; [TRY_POP] ; JMP H
    {
      let p = H;
      const flagRegs = [];
      while (p + 2 < L && this.mnem(instrs[p][0]) === 'PUSH_CONST' && this.mnem(instrs[p + 1][0]) === 'STORE_REG' && this.mnem(instrs[p + 2][0]) === 'DROP') {
        flagRegs.push(instrs[p + 1][1]);
        p += 3;
      }
      // for await: LOAD_REG it; ITER_NEXT_CALL; AWAIT; DUP; ITER_RESULT_DONE; JMPT exit; GETPROP "value"
      const M = (q) => (q < instrs.length ? this.mnem(instrs[q][0]) : null);
      const asyncHead = M(p) === 'LOAD_REG' && state.regIterAsync && state.regIterAsync.has(instrs[p][1]) && M(p + 1) === 'ITER_NEXT_CALL' && M(p + 2) === 'AWAIT' &&
        M(p + 3) === 'DUP' && M(p + 4) === 'ITER_RESULT_DONE' && M(p + 5) === 'JMPT' && M(p + 6) === 'GETPROP_NAMED' && M(L) === 'JMP';
      if ((M(p) === 'FOR_OF_NEXT' || asyncHead) && M(L) === 'JMP') {
        const iterReg = instrs[p][1];
        const X = asyncHead ? jumps[p + 5] : jumps[p];
        let bodyStart = asyncHead ? p + 7 : p + 1;
        let bodyEnd = L;
        let next = X;
        let tryInfo = null;
        if (this.mnem(instrs[bodyStart][0]) === 'TRY_ENTER' && state.tries[bodyStart]) {
          tryInfo = state.tries[bodyStart];
          bodyStart++;
          if (this.mnem(instrs[bodyEnd - 1][0]) === 'TRY_POP') bodyEnd--;
          if (tryInfo[2] !== null) next = tryInfo[2];
        }
        // skip the exit DROP
        if (next < instrs.length && this.mnem(instrs[next][0]) === 'DROP' && (X === next || tryInfo)) next++;
        for (const r of flagRegs) state.hiddenRegs.add(r);
        state.hiddenRegs.add(iterReg);
        this.dropIterInit(state, iterReg);
        const src = state.regIter.get(iterReg) || this.regId(state, iterReg);
        const isAsync = asyncHead;
        // loop variable: first instruction of the body should store the value
        const valueId = t.identifier(this.freshName(state, 'item'));
        const bodyStack = [valueId];
        // `continue` jumps to the header, or (inside the iterator-closing try) to its TRY_POP
        const loopRec = { header: H, exit: next, update: bodyEnd < L ? bodyEnd : null, label: null };
        state.loops.push(loopRec);
        const body = this.liftRange(state, bodyStart, bodyEnd, bodyStack);
        state.loops.pop();
        const bodyStmts = this.stripFlagStores(body.stmts, flagRegs, state);
        // turn `let x = __it` / `x = __it` first statement into the loop binding
        let left = null;
        const first = bodyStmts[0];
        const usedLater = (name) => bodyStmts.slice(1).some((x) => referencesName(x, name));
        if (first && t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isIdentifier(first.declarations[0].init, { name: valueId.name }) && !usedLater(valueId.name)) {
          left = t.variableDeclaration(first.kind, [t.variableDeclarator(first.declarations[0].id)]);
          bodyStmts.shift();
        } else if (first && t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) && t.isIdentifier(first.expression.right, { name: valueId.name }) && !usedLater(valueId.name)) {
          left = first.expression.left;
          bodyStmts.shift();
        } else {
          left = t.variableDeclaration('const', [t.variableDeclarator(valueId)]);
        }
        const loop = t.forOfStatement(left, src, t.blockStatement(bodyStmts), !!isAsync);
        emit(this.labelled(loopRec, loop));
        return { stack, next };
      }
    }

    // ---- for..in idiom ---------------------------------------------------
    // H: LOAD_REG i ; LOAD_REG keys ; GETPROP_NAMED length ; BINOP < ; JMPF exit ; LOAD_REG keys; LOAD_REG i; GETPROP_COMPUTED; DUP; LOAD obj; IN_SAFE; JMPF skip; STORE x; body; skip: DROP; i++ ; JMP H
    {
      const seq = (pcs) => pcs.map((q) => this.mnem(instrs[q][0]));
      // a block-scoped loop variable captured by a closure adds `PUSH_SCOPE; ENTER_SCOPE` (d = 2)
      const d = seq([H + 5, H + 6]).join() === 'PUSH_SCOPE,ENTER_SCOPE' ? 2 : 0;
      if (L - H > 10 && seq([H, H + 1, H + 2]).join() === 'LOAD_REG,LOAD_REG,GETPROP_NAMED' && state.regForIn.has(instrs[H + 1][1]) && NUM_JUMP.has(this.mnem(instrs[H + 4][0])) &&
          seq([H + 5 + d, H + 6 + d, H + 7 + d, H + 8 + d]).join() === 'LOAD_REG,LOAD_REG,GETPROP_COMPUTED,DUP' && this.mnem(instrs[H + 10 + d][0]) === 'IN_SAFE' && this.mnem(instrs[H + 11 + d][0]) === 'JMPF') {
        const keysReg = instrs[H + 1][1];
        const idxReg = instrs[H][1];
        const skip = jumps[H + 11 + d];
        const obj = state.regForIn.get(keysReg);
        state.hiddenRegs.add(keysReg);
        state.hiddenRegs.add(idxReg);
        const exit = jumps[H + 4];
        const keyId = t.identifier(this.freshName(state, 'key'));
        const loopRec = { header: H, exit, update: skip, label: null };
        state.loops.push(loopRec);
        const body = this.liftRange(state, H + 12 + d, skip, [keyId]);
        state.loops.pop();
        const bodyStmts = body.stmts;
        let left;
        const first = bodyStmts[0];
        const keyUsedLater = bodyStmts.slice(1).some((x) => referencesName(x, keyId.name));
        if (first && !keyUsedLater && t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isIdentifier(first.declarations[0].init, { name: keyId.name })) {
          left = t.variableDeclaration(first.kind, [t.variableDeclarator(first.declarations[0].id)]);
          bodyStmts.shift();
        } else if (first && !keyUsedLater && t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) && t.isIdentifier(first.expression.right, { name: keyId.name })) {
          left = first.expression.left;
          bodyStmts.shift();
        } else left = t.variableDeclaration('const', [t.variableDeclarator(keyId)]);
        if (process.env.VMDEC_TRACE) console.error(`[trace]   for-in idiom: keys r${keysReg} idx r${idxReg} body ${H + 12 + d}..${skip} exit ${exit} stmts=${bodyStmts.length}`);
        emit(this.labelled(loopRec, t.forInStatement(left, obj, t.blockStatement(bodyStmts))));
        return { stack, next: exit };
      }
    }

    // ---- generic while / do-while --------------------------------------
    const lastM = this.mnem(instrs[L][0]);
    if (NUM_JUMP.has(lastM)) {
      // do { body } while (cond)
      const loopRec = { header: H, exit: exitDefault, update: null, label: null };
      state.loops.push(loopRec);
      const body = this.liftRange(state, H, L, []);
      state.loops.pop();
      const condInfo = this.condFromJump(state, lastM, instrs[L][1], body.stack);
      let test = condInfo.cond;
      if (!condInfo.jumpWhenTrue) test = this.negate(test);
      // the test is outside the body's block: variables it reads that the body declares at its
      // top level are declared in front of the loop and only assigned inside
      const testNames = new Set();
      t.traverseFast(test, (n) => { if (t.isIdentifier(n)) testNames.add(n.name); });
      const hoisted = [];
      body.stmts = body.stmts.map((st) => {
        if (!t.isVariableDeclaration(st) || st.kind === 'var' || !st.declarations.every((d) => t.isIdentifier(d.id))) return st;
        if (!st.declarations.some((d) => testNames.has(d.id.name))) return st;
        for (const d of st.declarations) hoisted.push(t.variableDeclarator(t.identifier(d.id.name)));
        const inits = st.declarations.filter((d) => d.init).map((d) => t.assignmentExpression('=', t.identifier(d.id.name), d.init));
        return inits.length ? t.expressionStatement(inits.length === 1 ? inits[0] : t.sequenceExpression(inits)) : t.emptyStatement();
      }).filter((st) => !t.isEmptyStatement(st));
      if (hoisted.length) emit(t.variableDeclaration('let', hoisted));
      emit(this.labelled(loopRec, t.doWhileStatement(test, t.blockStatement(body.stmts))));
      return { stack, next: exitDefault };
    }

    // while (cond): the header computes a condition then jumps out when it fails
    let condEnd = -1;
    let condInfo = null;
    {
      // the probe lifts the header only to find the condition; declarations it records (e.g. a
      // `const` at the top of a `for (;;)` body) must not survive into the real lift of the body
      const frames = () => [...state.chain, ...state.enterFrames.values()];
      const saved = new Map(frames().map((f) => [f, new Set(f.declared)]));
      const probe = this.liftRange(state, H, this.firstJumpAt(state, H, L), []);
      for (const f of frames()) f.declared = saved.has(f) ? saved.get(f) : new Set();
      const jpc = this.firstJumpAt(state, H, L);
      const jm = jpc < L ? this.mnem(instrs[jpc][0]) : null;
      if (jm && NUM_JUMP.has(jm) && probe.stmts.length === 0 && jumps[jpc] > L) {
        condEnd = jpc;
        condInfo = this.condFromJump(state, jm, instrs[jpc][1], probe.stack);
      }
    }
    const loopRec = { header: H, exit: exitDefault, update: null, label: null, back: L };
    const fl = state.forLet.get(H);
    if (condInfo && fl && outStmts) {
      // for (let i = init; cond; update) with per-iteration bindings
      const exit = jumps[condEnd];
      loopRec.exit = exit;
      loopRec.update = fl.tailStart;
      state.loops.push(loopRec);
      const body = this.liftRange(state, condEnd + 1, fl.tailStart, []);
      state.loops.pop();
      for (const v of body.stack) if (!isPure(v)) body.stmts.push(t.expressionStatement(v));
      const upd = this.liftRange(state, fl.updateStart, L, []);
      const updExprs = [...upd.stmts.map((x) => (t.isExpressionStatement(x) ? x.expression : null)), ...upd.stack.filter((v) => !isPure(v))];
      let test = condInfo.cond;
      if (condInfo.jumpWhenTrue) test = this.negate(test);
      if (updExprs.every(Boolean)) {
        // the declaration of the loop variables right before the loop becomes the init
        const frame = this.frameForEnter(state, fl.enterA !== null ? fl.enterA : H - 1 - fl.slots.length);
        const names = new Set(fl.slots.map((sl) => this.slotName(state, frame, sl)).filter((n) => t.isIdentifier(n)).map((n) => n.name));
        const inits = [];
        while (outStmts.length) {
          const last = outStmts[outStmts.length - 1];
          if (t.isVariableDeclaration(last) && last.kind !== 'var' && last.declarations.every((d) => t.isIdentifier(d.id) && names.has(d.id.name))) { inits.unshift(...last.declarations); outStmts.pop(); }
          else break;
        }
        if (inits.length === names.size) {
          const update = updExprs.length === 0 ? null : updExprs.length === 1 ? updExprs[0] : t.sequenceExpression(updExprs);
          emit(this.labelled(loopRec, t.forStatement(t.variableDeclaration('let', inits), test, update, t.blockStatement(body.stmts))));
          return { stack, next: Math.max(exit, L + 1) };
        }
        if (inits.length) outStmts.push(t.variableDeclaration('let', inits));
      }
      // fallback: closures in the body now share one binding
      this.ctx.warn(`per-iteration loop binding at pc ${H} of program ${state.prog.id} emitted as while loop`);
      emit(this.labelled(loopRec, t.whileStatement(test, t.blockStatement([...body.stmts, ...upd.stmts]))));
      return { stack, next: Math.max(exit, L + 1) };
    }
    // `continue` in a for loop jumps to the update code at the end of the body; if some jump
    // targets such a straight-line tail, it becomes the update clause of a `for` statement
    let U = -1;
    // body start - 1: the condition's jump, or (for `for (;;)` without a test) the pc before the header
    const cEnd = condInfo ? condEnd : H - 1;
    if (condInfo || !NUM_JUMP.has(this.mnem(instrs[L][0]))) {
      // only `continue`s (unconditional jumps) may target the tail, and the body must fall into
      // it (an `else` branch at the end of the body is entered by a conditional jump and
      // skipped by an unconditional one)
      const cands = new Set();
      for (const [from, to] of Object.entries(jumps)) {
        const f = Number(from);
        if (f > cEnd && f < L && to > cEnd + 1 && to < L) cands.add(to);
      }
      // the jump that leaves a try block normally (after its TRY_POP, before the handlers) is
      // structure, not a `continue`
      const tryExit = (f, to) => Object.entries(state.tries).some(([tp, tr]) => {
        if (!tr || tr[2] !== to) return false;
        const hStart = tr[0] !== null ? tr[0] : tr[1] !== null ? tr[1] : tr[2];
        let pop = -1;
        for (let q = Number(tp) + 1; q < hStart; q++) if (this.mnem(instrs[q][0]) === 'TRY_POP') pop = q;
        // the normal exit of the try block, and the end of each handler, jump to the region's end
        return (pop >= 0 && f > pop && f < hStart) || (f >= hStart && f === to - 1 && jumps[f] === to);
      });
      for (const to of cands) {
        const into = Object.entries(jumps).filter(([f, x]) => x === to && Number(f) !== L && !tryExit(Number(f), to)).map(([f]) => this.mnem(instrs[Number(f)][0]));
        const before = this.mnem(instrs[to - 1][0]);
        const fallsIn = !(UNCOND_JUMP.has(before) && jumps[to - 1] !== to) && before !== 'RETURN' && before !== 'THROW'; // a jump to the next pc falls in
        if (into.every((mm) => UNCOND_JUMP.has(mm) || mm === 'FINALLY_END') && into.some((mm) => UNCOND_JUMP.has(mm)) && fallsIn && to > U) U = to;
      }
      if (U >= 0) {
        for (let q = U; q < L; q++) {
          const mq = this.mnem(instrs[q][0]);
          if (NUM_JUMP.has(mq) || UNCOND_JUMP.has(mq) || mq === 'RETURN' || mq === 'THROW' || mq === 'TRY_ENTER' || mq === 'FINALLY_END' || jumps[q] !== undefined) { U = -1; break; }
        }
      }
      // the tail must not be reachable as part of a nested region other than by falling into it
      if (U >= 0 && Object.values(state.tries).some((tr) => tr && tr.some((h) => h !== null && h > U && h < L))) U = -1;
      // a region (if / ternary / try) that starts before U and ends after it: U is inside the body
      if (U >= 0 && Object.entries(jumps).some(([f, to]) => Number(f) > cEnd && Number(f) < U && to > U && to < L)) {
        U = -1;
      }
      // `continue`s that jump to the header / back edge: this loop has no update clause (jumps to
      // U are then e.g. `break`s of a switch at the end of the body)
      if (U >= 0 && Object.entries(jumps).some(([f, to]) => Number(f) > cEnd && Number(f) < L && (to === H || to === L) && UNCOND_JUMP.has(this.mnem(instrs[Number(f)][0])))) {
        U = -1;
      }
    }
    if (!condInfo && U >= 0) {
      // for (;; update) { ... }
      loopRec.update = U;
      state.loops.push(loopRec);
      const body = this.liftRange(state, H, U, []);
      state.loops.pop();
      if (!body.stack.length) {
        const upd = this.liftRange(state, U, L, []);
        const updExprs = [...upd.stmts.map((x) => (t.isExpressionStatement(x) ? x.expression : null)), ...upd.stack.filter((v) => !isPure(v))];
        if (updExprs.every(Boolean)) {
          const update = updExprs.length === 0 ? null : updExprs.length === 1 ? updExprs[0] : t.sequenceExpression(updExprs);
          emit(this.labelled(loopRec, t.forStatement(null, null, update, t.blockStatement(body.stmts))));
          return { stack, next: exitDefault };
        }
        this.ctx.warn(`loop at pc ${H}: update code at pc ${U} is not an expression`);
        emit(this.labelled(loopRec, t.whileStatement(t.booleanLiteral(true), t.blockStatement([...body.stmts, ...upd.stmts]))));
        return { stack, next: exitDefault };
      }
      state.loops.push(loopRec);
      const tail = this.liftRange(state, U, L, body.stack);
      state.loops.pop();
      for (const v of tail.stack) if (!isPure(v)) tail.stmts.push(t.expressionStatement(v));
      emit(this.labelled(loopRec, t.whileStatement(t.booleanLiteral(true), t.blockStatement([...body.stmts, ...tail.stmts]))));
      return { stack, next: exitDefault };
    }
    if (condInfo && U >= 0) {
      const exit = jumps[condEnd];
      loopRec.exit = exit;
      loopRec.update = U;
      state.loops.push(loopRec);
      const body = this.liftRange(state, condEnd + 1, U, []);
      state.loops.pop();
      let test = condInfo.cond;
      if (condInfo.jumpWhenTrue) test = this.negate(test);
      // a value still pending at U: U is the join of a conditional expression
      // (`x = c ? a : b; i++`), not the start of an update clause; the tail continues the body
      if (body.stack.length) {
        state.loops.push(loopRec);
        const tail = this.liftRange(state, U, L, body.stack);
        state.loops.pop();
        for (const v of tail.stack) if (!isPure(v)) tail.stmts.push(t.expressionStatement(v));
        emit(this.labelled(loopRec, t.whileStatement(test, t.blockStatement([...body.stmts, ...tail.stmts]))));
        return { stack, next: Math.max(exit, L + 1) };
      }
      const upd = this.liftRange(state, U, L, []);
      const updExprs = [...upd.stmts.map((x) => (t.isExpressionStatement(x) ? x.expression : null)), ...upd.stack.filter((v) => !isPure(v))];
      if (updExprs.every(Boolean)) {
        const update = updExprs.length === 0 ? null : updExprs.length === 1 ? updExprs[0] : t.sequenceExpression(updExprs);
        emit(this.labelled(loopRec, t.forStatement(null, test, update, t.blockStatement(body.stmts))));
        return { stack, next: Math.max(exit, L + 1) };
      }
      this.ctx.warn(`loop at pc ${H}: update code at pc ${U} is not an expression`);
      emit(this.labelled(loopRec, t.whileStatement(test, t.blockStatement([...body.stmts, ...upd.stmts]))));
      return { stack, next: Math.max(exit, L + 1) };
    }
    if (condInfo) {
      const exit = jumps[condEnd];
      loopRec.exit = exit;
      state.loops.push(loopRec);
      const body = this.liftRange(state, condEnd + 1, L, []);
      state.loops.pop();
      let test = condInfo.cond;
      if (condInfo.jumpWhenTrue) test = this.negate(test);
      for (const v of body.stack) if (!isPure(v)) body.stmts.push(t.expressionStatement(v));
      emit(this.labelled(loopRec, t.whileStatement(test, t.blockStatement(body.stmts))));
      return { stack, next: Math.max(exit, L + 1) };
    }
    state.loops.push(loopRec);
    const body = this.liftRange(state, H, L, []);
    state.loops.pop();
    for (const v of body.stack) if (!isPure(v)) body.stmts.push(t.expressionStatement(v));
    emit(this.labelled(loopRec, t.whileStatement(t.booleanLiteral(true), t.blockStatement(body.stmts))));
    return { stack, next: exitDefault };
  }

  labelled(loopRec, stmt) {
    return loopRec.label ? t.labeledStatement(t.identifier(loopRec.label), stmt) : stmt;
  }

  firstJumpAt(state, from, to) {
    for (let pc = from; pc < to; pc++) {
      const m = this.mnem(state.instrs[pc][0]);
      if (NUM_JUMP.has(m) || UNCOND_JUMP.has(m) || m === 'RETURN' || m === 'THROW' || m === 'TRY_ENTER' || m === 'FOR_OF_NEXT') return pc;
      if (state.loopEnds.has(pc) && pc !== from) return pc;
    }
    return to;
  }

  stripFlagStores(stmts, flagRegs, state) {
    const names = new Set(flagRegs.map((r) => this.regName(state, r)));
    return stmts.filter((s) => !(t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) && t.isIdentifier(s.expression.left) && names.has(s.expression.left.name) && t.isBooleanLiteral(s.expression.right)));
  }

  /**
   * Given a conditional-jump mnemonic and the stack at that point, return
   * { cond, jumpWhenTrue, keep, extraPop } and mutate the stack the way the
   * *fallthrough* path would (the jump path is described by `keep`).
   */
  condFromJump(state, m, operand, stack) {
    switch (m) {
      case 'JMPF': return { cond: this.pop(stack), jumpWhenTrue: false };
      case 'JMPT': return { cond: this.pop(stack), jumpWhenTrue: true };
      case 'JMPF_KEEP': { const c = this.pop(stack); return { cond: c, jumpWhenTrue: false, keepOnJump: c }; }
      case 'JMPT_KEEP': { const c = this.pop(stack); return { cond: c, jumpWhenTrue: true, keepOnJump: c }; }
      case 'JMPF_POP2': { const c = this.pop(stack); const extra = this.pop(stack); return { cond: c, jumpWhenTrue: false, keepOnJump: extra }; }
      case 'JMPT_POP2': { const c = this.pop(stack); const extra = this.pop(stack); return { cond: c, jumpWhenTrue: true, keepOnJump: extra }; }
      case 'JMP_NOT_NULLISH': { const v = this.pop(stack); return { cond: t.binaryExpression('!=', v, t.nullLiteral()), jumpWhenTrue: true, nullishOf: v }; }
      case 'JMP_NULLISH': { const v = this.pop(stack); return { cond: t.binaryExpression('==', v, t.nullLiteral()), jumpWhenTrue: true, nullishOf: v }; }
      case 'COND_TEMPLATE': {
        const e = this.entry(state.instrs[state.__condPc][0]);
        const need = Math.max(e.taken.pops, e.fall.pops, maxStackLeaf(e.cond) + 1);
        const popped = [];
        for (let i = 0; i < need; i++) popped.push(this.pop(stack));
        const base = popped.slice().reverse();
        const ctxT = { state, operand, popped };
        const cond = this.templateExpr(e.cond, ctxT);
        const build = (path) => {
          const st = base.slice(0, base.length - path.pops);
          for (const x of path.pushes) st.push(this.templateExpr(x, ctxT));
          return st;
        };
        const jumpStack = build(e.taken);
        for (const v of build(e.fall)) stack.push(v);
        return { cond, jumpWhenTrue: true, jumpStackOverride: jumpStack };
      }
      case 'FUSED_JMPT': case 'FUSED_JMPF': {
        return null; // handled by caller via fusedCond
      }
      default: return { cond: t.booleanLiteral(true), jumpWhenTrue: true };
    }
  }

  fusedCond(state, pc) {
    const [op, operand] = state.instrs[pc];
    const e = this.entry(op);
    const cond = t.binaryExpression(e.op, this.regId(state, operand & 0xffff), constNode(state.prog.consts[operand >>> 16]));
    return { cond, jumpWhenTrue: e.mnemonic === 'FUSED_JMPT' };
  }

  negate(expr) {
    if (t.isUnaryExpression(expr, { operator: '!' })) return expr.argument;
    if (t.isBinaryExpression(expr)) {
      const inv = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' }[expr.operator];
      if (inv) return t.binaryExpression(inv, expr.left, expr.right);
    }
    if (t.isBooleanLiteral(expr)) return t.booleanLiteral(!expr.value);
    return t.unaryExpression('!', expr);
  }

  // -------------------------------------------------------------------------
  // conditionals
  // -------------------------------------------------------------------------

  liftConditional(state, pc, end, inStack, emit) {
    const { instrs, jumps } = state;
    const m = this.mnem(instrs[pc][0]);
    const T = jumps[pc];
    const stack = inStack.slice();
    // the tested value must not share an effectful sub-expression with pending stack values
    // `DUP; JMPx; DROP` is the `a || b` / `a && b` idiom: the duplicate is the operand kept on the
    // jump path and dropped on the other, i.e. evaluated once - no spill
    const shortCircuit = pc > 0 && this.mnem(instrs[pc - 1][0]) === 'DUP' && pc + 1 < instrs.length && this.mnem(instrs[pc + 1][0]) === 'DROP' &&
      stack.length >= 2 && stack[stack.length - 1] === stack[stack.length - 2];
    // values already evaluated into literals under construction come before the test
    if (stack.length && !isPure(stack[stack.length - 1])) for (const v of stack.slice(0, -1)) if (v && v.__builder && (t.isObjectExpression(v) || t.isArrayExpression(v))) this.spillBuilder(v, emit);
    if (stack.length && NUM_JUMP.has(m) && m !== 'COND_TEMPLATE' && m !== 'FUSED_JMPT' && m !== 'FUSED_JMPF' && !shortCircuit) {
      const top = stack.pop();
      const ex = [top];
      this.spillShared(state, stack, emit, ex);
      stack.push(ex[0]);
    }
    const base = stack.slice();
    let info;
    state.__condPc = pc;
    if (m === 'FUSED_JMPT' || m === 'FUSED_JMPF') info = this.fusedCond(state, pc);
    else info = this.condFromJump(state, m, instrs[pc][1], stack);
    const { cond, jumpWhenTrue } = info;
    state.alive = state.alive || new Set();
    state.alive.add(cond);
    if (info.nullishOf) state.alive.add(info.nullishOf);
    if (info.keepOnJump) state.alive.add(info.keepOnJump);
    // stack after the jump path: base minus popped cond (and possibly keep)
    let jumpStack = base.slice();
    if (info.jumpStackOverride) jumpStack = info.jumpStackOverride;
    else if (m !== 'JMPF_KEEP' && m !== 'JMPT_KEEP' && m !== 'FUSED_JMPT' && m !== 'FUSED_JMPF') jumpStack.pop(); // cond popped
    if (m === 'JMPF_POP2' || m === 'JMPT_POP2') { /* keepOnJump stays on the jump path */ }
    const fallStack = stack; // condFromJump already applied fallthrough pops

    // jump leaves the region
    if (T > end || T <= pc) {
      state.alive.delete(cond);
    if (info.nullishOf) state.alive.delete(info.nullishOf);
    if (info.keepOnJump) state.alive.delete(info.keepOnJump);
      const js = this.jumpStatement(state, T, end);
      let test = jumpWhenTrue ? cond : this.negate(cond);
      if (js && js !== 'end') {
        this.spillForStatement(state, fallStack, emit, null);
        emit(t.ifStatement(test, t.blockStatement([js])));
        return { stack: fallStack, next: pc + 1 };
      }
      if (js === 'end') return { stack: fallStack, next: pc + 1 };
      emit(t.ifStatement(test, t.blockStatement([this.comment(`unresolved jump to ${T}`)])));
      return { stack: fallStack, next: pc + 1 };
    }

    // if/else shape?
    let thenEnd = T;
    let elseStart = null, elseEnd = null;
    let mergePc = T;
    if (T - 1 > pc && UNCOND_JUMP.has(this.mnem(instrs[T - 1][0]))) {
      const E = jumps[T - 1];
      if (E > T && E <= end) {
        thenEnd = T - 1;
        elseStart = T;
        elseEnd = E;
        mergePc = E;
      }
    }
    // nodes shared with the stack / the test before the branches are lifted (branch spills replace them in place)
    const sharedNodes = new Set();
    for (const v of [...base, cond, info.nullishOf, info.keepOnJump]) if (v && typeof v === 'object') t.traverseFast(v, (n) => { sharedNodes.add(n); });
    const fall = this.liftRange(state, pc + 1, thenEnd, fallStack);
    let other;
    if (elseStart !== null) other = this.liftRange(state, elseStart, elseEnd, jumpStack);
    else other = { stmts: [], stack: jumpStack.slice() };
    this.hoistBaseSpills(base, [fall, other], stack, emit, sharedNodes, cond);
    state.alive.delete(cond);

    // expression form: no statements on either side and both paths end with one more value than
    // the common prefix
    const common = Math.min(fall.stack.length, other.stack.length);
    const exprForm = fall.stmts.length === 0 && other.stmts.length === 0 && fall.stack.length === other.stack.length && fall.stack.length >= 1 &&
      fall.stack.slice(0, -1).every((v, i) => v === other.stack[i]);
    if (exprForm) {
      const a = fall.stack[fall.stack.length - 1]; // value when falling through
      const b = other.stack[other.stack.length - 1]; // value when jumping
      let expr;
      const fallCond = jumpWhenTrue ? this.negate(cond) : cond; // condition under which fallthrough value is used
      if (info.keepOnJump && b === info.keepOnJump && (m === 'JMPF_KEEP' || m === 'JMPT_KEEP' || m === 'JMPF_POP2' || m === 'JMPT_POP2') && (m === 'JMPF_KEEP' || m === 'JMPT_KEEP' ? true : b === cond || true)) {
        expr = t.logicalExpression(jumpWhenTrue ? '||' : '&&', b, a);
      } else if (info.nullishOf && b === info.nullishOf) {
        expr = t.logicalExpression('??', b, a);
      } else if (info.nullishOf && (isUndef(a) || isUndef(b)) && optionalChain(isUndef(a) ? b : a, info.nullishOf)) {
        expr = optionalChain(isUndef(a) ? b : a, info.nullishOf);
      } else if (b === cond && !jumpWhenTrue) {
        expr = t.logicalExpression('&&', cond, a);
      } else if (b === cond && jumpWhenTrue) {
        expr = t.logicalExpression('||', cond, a);
      } else {
        expr = t.conditionalExpression(fallCond, a, b);
      }
      if (info.nullishOf && !isPure(info.nullishOf) && countIdentity(expr, info.nullishOf) > 1) {
        // the tested value is evaluated more than once in the result: evaluate it once
        const id = t.identifier(this.tmpName());
        this.emitStatement(state, stack, emit, t.variableDeclaration('const', [t.variableDeclarator(id, info.nullishOf)]));
        expr = replaceIdentity(expr, info.nullishOf, id);
      }
      const out = fall.stack.slice(0, -1);
      out.push(expr);
      return { stack: out, next: mergePc };
    }

    // value-producing branches with side-effect statements
    const lastIsJump = (st) => st.length && (t.isReturnStatement(st[st.length - 1]) || t.isThrowStatement(st[st.length - 1]) || t.isBreakStatement(st[st.length - 1]) || t.isContinueStatement(st[st.length - 1]));
    if (fall.stack.length === other.stack.length && fall.stack.length >= 1 && fall.stack.slice(0, -1).every((v, i) => v === other.stack[i]) &&
        !lastIsJump(fall.stmts) && !lastIsJump(other.stmts)) {
      let a = fall.stack[fall.stack.length - 1], b = other.stack[other.stack.length - 1];
      let fallCond = jumpWhenTrue ? this.negate(cond) : cond;
      if (shortCircuit && !isPure(cond) && (a === cond || b === cond)) {
        // the short-circuit operand is needed as test and as value: evaluate it once
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('const', [t.variableDeclarator(id, cond)]));
        const rep = (x) => replaceIdentity(x, cond, id);
        a = rep(a); b = rep(b); fallCond = jumpWhenTrue ? this.negate(t.identifier(id.name)) : t.identifier(id.name);
        fall.stmts = fall.stmts.map(rep); other.stmts = other.stmts.map(rep);
      }
      // bookkeeping stores of an idiom lifted inside a branch (iterator registers of a
      // destructuring) are dropped here, before the branch becomes an expression
      const hidden = new Set([...state.hiddenRegs].map((r) => this.regName(state, r)));
      const isBookkeeping = (x) => x.__remove || (t.isExpressionStatement(x) && t.isAssignmentExpression(x.expression, { operator: '=' }) &&
        t.isIdentifier(x.expression.left) && hidden.has(x.expression.left.name) && (t.isLiteral(x.expression.right) || t.isIdentifier(x.expression.right)));
      fall.stmts = fall.stmts.filter((x) => !isBookkeeping(x));
      other.stmts = other.stmts.filter((x) => !isBookkeeping(x));
      const exprOnly = (st) => st.every((x) => t.isExpressionStatement(x));
      let expr;
      if (exprOnly(fall.stmts) && exprOnly(other.stmts)) {
        const seq = (st, v) => (st.length ? t.sequenceExpression([...st.map((x) => x.expression), v]) : v);
        expr = t.conditionalExpression(fallCond, seq(fall.stmts, a), seq(other.stmts, b));
      } else {
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('let', [t.variableDeclarator(id)]));
        emit(t.ifStatement(fallCond, t.blockStatement([...fall.stmts, t.expressionStatement(t.assignmentExpression('=', id, a))]),
          t.blockStatement([...other.stmts, t.expressionStatement(t.assignmentExpression('=', id, b))])));
        expr = t.identifier(id.name);
      }
      const outS = fall.stack.slice(0, -1);
      outS.push(expr);
      return { stack: outS, next: mergePc };
    }

    // statement form
    this.spillForStatement(state, base.slice(0, common), emit, null);
    let test = jumpWhenTrue ? this.negate(cond) : cond;
    let thenStmts = fall.stmts;
    let elseStmts = other.stmts;
    // leftover values on branch stacks that are not shared -> statements
    const drain = (res, arr) => { for (let i = common; i < res.stack.length; i++) if (!isPure(res.stack[i])) arr.push(t.expressionStatement(res.stack[i])); };
    drain(fall, thenStmts);
    drain(other, elseStmts);
    if (thenStmts.length === 0 && elseStmts.length > 0) {
      test = this.negate(test);
      [thenStmts, elseStmts] = [elseStmts, thenStmts];
    }
    if (thenStmts.length === 0 && elseStmts.length === 0) {
      if (!isPure(test)) emit(t.expressionStatement(test));
    } else {
      emit(t.ifStatement(test, t.blockStatement(thenStmts), elseStmts.length ? t.blockStatement(elseStmts) : null));
    }
    // resulting stack: prefer the fallthrough path unless it terminated
    const terminated = (stmts) => stmts.length && (t.isReturnStatement(stmts[stmts.length - 1]) || t.isThrowStatement(stmts[stmts.length - 1]) || t.isBreakStatement(stmts[stmts.length - 1]) || t.isContinueStatement(stmts[stmts.length - 1]));
    let outStack = fall.stack.slice(0, common);
    if (!terminated(fall.stmts) && fall.stack.length === other.stack.length && fall.stack.length > common) {
      // both push the same number of extra values (unusual): keep fallthrough's
      outStack = fall.stack;
    }
    return { stack: outStack, next: mergePc };
  }

  // -------------------------------------------------------------------------
  // switch
  // -------------------------------------------------------------------------

  trySwitch(state, pc, end, inStack, emit) {
    const { instrs, jumps } = state;
    // chain: test region (no statements, pushes 1) + JMPT -> Bi, repeated; then JMP -> D
    const tests = [];
    let p = pc;
    let stack = inStack.slice();
    // the first test has already been computed on the stack
    {
      const cond = stack[stack.length - 1];
      if (!cond) return null;
      tests.push({ cond, target: jumps[pc], pc });
      stack = stack.slice(0, -1);
      p = pc + 1;
    }
    let defaultTarget = null;
    // the jump that ends a case test: the first JMPT/JMP not nested inside a short-circuit
    // (`a && b`, `a || b`) of the test itself, i.e. no forward jump of the test still pending
    const caseJumpAt = (from) => {
      let pending = -1;
      for (let q = from; q < end; q++) {
        const mq = this.mnem(instrs[q][0]);
        if (pending > q) {
          if (NUM_JUMP.has(mq) || UNCOND_JUMP.has(mq)) pending = Math.max(pending, jumps[q] !== undefined && jumps[q] > q ? jumps[q] : pending);
          continue;
        }
        pending = -1;
        if (mq === 'JMPT' || mq === 'JMP') return q;
        if (NUM_JUMP.has(mq) && jumps[q] !== undefined && jumps[q] > q) { pending = jumps[q]; continue; }
        if (UNCOND_JUMP.has(mq) || mq === 'RETURN' || mq === 'THROW' || mq === 'TRY_ENTER') return q;
      }
      return end;
    };
    while (p < end) {
      const j = caseJumpAt(p);
      if (j >= end) return null;
      const jm = this.mnem(instrs[j][0]);
      if (jm === 'JMPT') {
        // a case test is a side-effect-free comparison; probing a region that stores or builds
        // literals would mutate shared nodes (array/object/class builders)
        for (let q = p; q < j; q++) if (/^(STORE_|ARR_|DEFINE_|OBJ_|SET|MAKE_|CALL|NEW|DELETE|TRY|ENTER_SCOPE|EXIT_SCOPE)/.test(this.mnem(instrs[q][0]))) return null;
        const probe = this.liftRange(state, p, j, stack);
        if (probe.stmts.length || probe.stack.length !== stack.length + 1) return null;
        tests.push({ cond: probe.stack[probe.stack.length - 1], target: jumps[j], pc: j });
        p = j + 1;
        continue;
      }
      if (jm === 'JMP' && j === p) { defaultTarget = jumps[j]; p = j + 1; break; }
      return null;
    }
    if (tests.length < 2 || defaultTarget === null) return null;
    const bodiesStart = p;
    const targets = [...new Set([...tests.map((x) => x.target), defaultTarget])].sort((a, b) => a - b);
    if (targets[0] !== bodiesStart || targets.some((x) => x > end)) return null;
    // switch end: the target of the terminal JMPs of the bodies, else `end`
    let swEnd = end;
    for (let i = 0; i < targets.length; i++) {
      const bEnd = i + 1 < targets.length ? targets[i + 1] : end;
      const lastPc = bEnd - 1;
      if (lastPc >= targets[i] && UNCOND_JUMP.has(this.mnem(instrs[lastPc][0]))) {
        const tg = jumps[lastPc];
        if (tg > lastPc && tg <= end && (swEnd === end || tg === swEnd)) swEnd = tg;
      }
    }
    // a switch without `default` jumps to the code behind it when no case matches; when a case
    // body breaks to that point (a jump that is not just the skip over a nested `else`), it is the
    // switch end and not a default body
    if (swEnd === end && defaultTarget === targets[targets.length - 1] && !tests.some((x) => x.target === defaultTarget)) {
      const breaks = Object.entries(jumps).some(([f, to]) => {
        const fn = Number(f);
        return to === defaultTarget && fn >= bodiesStart && fn < defaultTarget - 1 && UNCOND_JUMP.has(this.mnem(instrs[fn][0])) &&
          !Object.entries(jumps).some(([h, hto]) => hto === fn + 1 && NUM_JUMP.has(this.mnem(instrs[Number(h)][0])));
      });
      if (breaks) { swEnd = defaultTarget; targets.pop(); }
    }
    // discriminant: all tests `X === Y` with identical X
    const { gen } = require('./locate');
    let disc = null;
    const caseExprs = [];
    const allEq = tests.every((x) => t.isBinaryExpression(x.cond, { operator: '===' }));
    if (allEq) {
      const lefts = tests.map((x) => gen(x.cond.left));
      if (lefts.every((l) => l === lefts[0])) {
        disc = tests[0].cond.left;
        for (const x of tests) caseExprs.push(x.cond.right);
      }
    }
    if (!disc) {
      disc = t.booleanLiteral(true);
      for (const x of tests) caseExprs.push(x.cond);
    }
    this.spillForStatement(state, stack, emit, null);
    state.switchEnds.push({ end: swEnd, depth: state.loops.length });
    const cases = [];
    for (let i = 0; i < targets.length; i++) {
      const B = targets[i];
      let bEnd = i + 1 < targets.length ? targets[i + 1] : swEnd;
      if (bEnd > swEnd) bEnd = swEnd;
      const testsHere = tests.filter((x) => x.target === B);
      const body = this.liftRange(state, B, bEnd, []);
      for (const v of body.stack) if (!isPure(v)) body.stmts.push(t.expressionStatement(v));
      // label(s)
      const labels = testsHere.map((x) => caseExprs[tests.indexOf(x)]);
      if (defaultTarget === B) labels.push(null);
      for (let k = 0; k < labels.length; k++) {
        const stmts = k === labels.length - 1 ? body.stmts : [];
        cases.push(t.switchCase(labels[k], stmts));
      }
    }
    state.switchEnds.pop();
    emit(t.switchStatement(disc, cases));
    return { stack, next: swEnd };
  }

  // -------------------------------------------------------------------------
  // array destructuring:  [a, , b = 1, [c, d]] = src
  //
  //   src GET_ITERATOR; STORE_REG it; PUSH false; STORE_REG done;
  //   TRY_ENTER
  //     per element: PUSH true; STORE done; LOAD it; ITER_NEXT_RESULT; DUP;
  //                  GETPROP "done"; JMPT a; GETPROP "value"; PUSH false; STORE done; JMP b;
  //                  a: DROP; PUSH_UNDEF; b: <store the value into the target>
  //   TRY_POP; <close iterator unless done>; JMP end; catch/finally: close iterator
  // -------------------------------------------------------------------------

  liftArrayDestructure(state, pc, end, inStack, emit) {
    const { instrs, jumps } = state;
    const M = (q) => (q >= 0 && q < instrs.length ? this.mnem(instrs[q][0]) : null);
    const K = state.prog.consts;
    const isStr = (q, v) => K[instrs[q][1]] && K[instrs[q][1]].v === v;
    // header before TRY_ENTER
    if (!(M(pc - 4) === 'STORE_REG' && M(pc - 3) === 'PUSH_CONST' && M(pc - 2) === 'STORE_REG' && M(pc - 1) === 'PUSH_CONST' || M(pc - 2) === 'STORE_REG' && M(pc - 1) === 'PUSH_CONST')) { /* shape checked below */ }
    const itReg = M(pc - 4) === 'GET_ITERATOR' && M(pc - 3) === 'STORE_REG' ? instrs[pc - 3][1] : null;
    const doneReg = M(pc - 1) === 'STORE_REG' ? instrs[pc - 1][1] : null;
    if (itReg === null || doneReg === null || !state.regIter.has(itReg)) return null;
    const [C, F, E] = state.tries[pc];
    if (E === null) return null;
    // element prologue: PUSH; STORE done; LOAD it; ITER_NEXT_RESULT; DUP; GETPROP "done"; JMPT x
    const elementHead = (q) => M(q) === 'PUSH_CONST' && M(q + 1) === 'STORE_REG' && instrs[q + 1][1] === doneReg && M(q + 2) === 'LOAD_REG' && instrs[q + 2][1] === itReg &&
      M(q + 3) === 'ITER_NEXT_RESULT' && M(q + 4) === 'DUP' && M(q + 5) === 'GETPROP_NAMED' && isStr(q + 5, 'done') && M(q + 6) === 'JMPT';
    // value element: ...; GETPROP "value"; PUSH; STORE done; JMP b; DROP; PUSH_UNDEF; b: <store>
    const valueElement = (q) => elementHead(q) && M(q + 7) === 'GETPROP_NAMED' && isStr(q + 7, 'value') && M(q + 8) === 'PUSH_CONST' && M(q + 9) === 'STORE_REG' &&
      M(q + 10) === 'JMP' && M(q + 11) === 'DROP' && M(q + 12) === 'PUSH_UNDEF' && jumps[q + 6] === q + 11 && jumps[q + 10] === q + 13;
    // hole: ...; PUSH; STORE done; x: DROP
    const holeElement = (q) => elementHead(q) && M(q + 7) === 'PUSH_CONST' && M(q + 8) === 'STORE_REG' && M(q + 9) === 'DROP' && jumps[q + 6] === q + 9;
    let tp = -1;
    for (let q = pc + 1; q < (C !== null ? C : F !== null ? F : E); q++) if (M(q) === 'TRY_POP') tp = q;
    if (tp < 0) return null;
    // walk the elements
    const segs = [];
    let q = pc + 1;
    let prefixFrom = null;
    while (q < tp) {
      if (holeElement(q)) { segs.push({ hole: true }); q += 10; prefixFrom = null; continue; }
      if (!valueElement(q)) {
        // `LOAD x; STORE_REG t` copies of a target object before the element's next(): keep scanning
        if (prefixFrom === null && M(q) !== null && !elementHead(q)) {
          let r = q;
          while (r < tp && !elementHead(r)) r++;
          if (r >= tp) return null;
          prefixFrom = q;
          q = r;
          continue;
        }
        return null;
      }
      let nextStart = q + 13;
      while (nextStart < tp && !elementHead(nextStart)) nextStart++;
      // copies of the next element's target (`LOAD x; STORE_REG t` pairs right before its
      // next()) belong to that element, not to this one's store
      let storeEnd = nextStart;
      if (nextStart < tp) {
        while (storeEnd - 2 > q + 13 && M(storeEnd - 1) === 'STORE_REG' && /^(LOAD_REG|LOAD_ARG|LOAD_SCOPE|PUSH_CONST|LOAD_LOCAL)$/.test(M(storeEnd - 2))) storeEnd -= 2;
      }
      segs.push({ from: q + 13, to: storeEnd, prefix: prefixFrom !== null ? [prefixFrom, q] : null });
      prefixFrom = storeEnd < nextStart ? storeEnd : null;
      q = nextStart;
    }
    if (!segs.length) return null;
    const src = state.regIter.get(itReg);
    const elements = [];
    let declKind = null;
    let allDecl = true, anyDecl = false;
    const declaredTargets = [];
    for (const seg of segs) {
      if (seg.hole) { elements.push(null); continue; }
      const elemId = t.identifier(fresh(`__elem${this.tempCounter++}`));
      elemId.__noTemp = true;
      let prefixStmts = [];
      if (seg.prefix) {
        const pre = this.liftRange(state, seg.prefix[0], seg.prefix[1], []);
        if (pre.stack.length) return null;
        prefixStmts = pre.stmts;
      }
      const res = this.liftRange(state, seg.from, seg.to, [elemId]);
      res.stmts = [...prefixStmts, ...res.stmts];
      // drop the done-flag stores, and the bookkeeping of a nested pattern (`[[a, b]] = x`: the
      // inner iterator init is flagged for removal, its done flag is a hidden register)
      const hiddenNames = new Set([...state.hiddenRegs].map((r) => this.regName(state, r)));
      const stmts = res.stmts.filter((x) => !(x.__remove || t.isExpressionStatement(x) && t.isAssignmentExpression(x.expression) && t.isIdentifier(x.expression.left) &&
        (x.expression.left.name === this.regName(state, doneReg) || hiddenNames.has(x.expression.left.name) && t.isLiteral(x.expression.right))));
      if (res.stack.length) return null;
      if (stmts.length === 0) { elements.push(null); continue; }
      // `rT = obj; rK = key; obj2[rK] = __elem`  ->  target `obj[key]` (the compiler copies the
      // target object and/or computed key into temporaries before the element's next())
      while (stmts.length >= 2 && t.isExpressionStatement(stmts[0]) && t.isAssignmentExpression(stmts[0].expression, { operator: '=' }) &&
             t.isIdentifier(stmts[0].expression.left) && /^r\d+$/.test(stmts[0].expression.left.name)) {
        const last = stmts[stmts.length - 1];
        const tmp = stmts[0].expression.left.name;
        let tgt = null;
        if (t.isExpressionStatement(last) && t.isAssignmentExpression(last.expression) && t.isMemberExpression(last.expression.left)) tgt = last.expression.left;
        else if (t.isVariableDeclaration(last)) break;
        if (!tgt) break;
        const slots = [];
        if (t.isIdentifier(tgt.object, { name: tmp })) slots.push('object');
        if (tgt.computed && t.isIdentifier(tgt.property, { name: tmp })) slots.push('property');
        if (slots.length !== 1 || countIdent(stmts.slice(1), tmp) !== 1) break;
        tgt[slots[0]] = stmts[0].expression.right;
        stmts.shift();
        state.hiddenRegs.add(Number(tmp.slice(1)));
      }
      if (stmts.length !== 1) return null;
      const st = stmts[0];
      let target = null, value = null;
      if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' })) { target = st.expression.left; value = st.expression.right; allDecl = false; }
      else if (t.isVariableDeclaration(st) && st.declarations.length === 1) { target = st.declarations[0].id; value = st.declarations[0].init; anyDecl = true; declKind = declKind === 'let' || st.kind === 'let' ? 'let' : st.kind; declaredTargets.push(target); }
      else return null;
      if (t.isIdentifier(value, { name: elemId.name })) elements.push(target);
      else if (t.isConditionalExpression(value) && t.isBinaryExpression(value.test, { operator: '===' }) && t.isIdentifier(value.test.left, { name: elemId.name }) &&
               t.isIdentifier(value.test.right, { name: 'undefined' }) && t.isIdentifier(value.alternate, { name: elemId.name })) elements.push(t.assignmentPattern(target, value.consequent));
      else return null;
    }
    while (elements.length && elements[elements.length - 1] === null) elements.pop();
    state.hiddenRegs.add(itReg);
    state.hiddenRegs.add(doneReg);
    this.dropIterInit(state, itReg);
    const pattern = t.arrayPattern(elements);
    if (anyDecl && allDecl) emit(t.variableDeclaration(declKind || 'let', [t.variableDeclarator(pattern, src)]));
    else if (!anyDecl) emit(t.expressionStatement(t.assignmentExpression('=', pattern, src)));
    else {
      // mixed declarations and assignments: declare first, then assign
      const declNames = [];
      for (const id of declaredTargets) if (t.isIdentifier(id) && !declNames.includes(id.name)) declNames.push(id.name);
      emit(t.variableDeclaration('let', declNames.map((n) => t.variableDeclarator(t.identifier(n)))));
      emit(t.expressionStatement(t.assignmentExpression('=', pattern, src)));
    }
    return { stack: inStack.slice(), next: E };
  }

  // -------------------------------------------------------------------------
  // try / catch / finally
  // -------------------------------------------------------------------------

  liftTry(state, pc, end, inStack, emit) {
    const { instrs } = state;
    const [C, F, E] = state.tries[pc];
    const stack = inStack.slice();
    const regionEnd = E !== null ? E : end;
    // try body: up to the TRY_POP that precedes the catch/finally
    let tp = -1;
    const limit = C !== null ? C : F !== null ? F : regionEnd;
    for (let q = pc + 1; q < limit; q++) if (this.mnem(instrs[q][0]) === 'TRY_POP') tp = q;
    if (tp < 0) tp = limit;
    const tryRes = this.liftRange(state, pc + 1, tp, []);
    // a value left on the stack by the try block (the last element of a destructuring, ...) is used
    // after the block: carry it out through a variable declared in front of the try statement
    const carried = [];
    for (const v of tryRes.stack) {
      if (isPure(v) && (t.isLiteral(v) || t.isThisExpression(v))) { carried.push(v); continue; }
      const id = t.identifier(this.tmpName());
      carried.push(id);
      this.spillForStatement(state, stack, emit, null);
      emit(t.variableDeclaration('let', [t.variableDeclarator(id)]));
      tryRes.stmts.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(id.name), v)));
    }

    let handler = null;
    if (C !== null) {
      let cEnd = F !== null ? F : regionEnd;
      // drop trailing JMP -> F/E
      if (cEnd - 1 > C && UNCOND_JUMP.has(this.mnem(instrs[cEnd - 1][0]))) cEnd--;
      const eid = t.identifier(fresh(`e${state.catchCounter++}`));
      let param = eid;
      let cStart = C;
      if (this.mnem(instrs[C][0]) === 'STORE_LOCAL' && instrs[C][1] === -1) { param = null; cStart = C + 1; }
      const catchRes = this.liftRange(state, cStart, cEnd, param ? [eid] : []);
      for (const v of catchRes.stack) if (!isPure(v) && v !== eid) catchRes.stmts.push(t.expressionStatement(v));
      let body = catchRes.stmts;
      // `let x = e0;` / `x = e0;` as first statement -> catch (x)
      const first = body[0];
      if (param && first && t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isIdentifier(first.declarations[0].id) && t.isIdentifier(first.declarations[0].init, { name: eid.name })) {
        param = first.declarations[0].id;
        body = body.slice(1);
      } else if (param && first && t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) && t.isIdentifier(first.expression.left) && t.isIdentifier(first.expression.right, { name: eid.name })) {
        param = first.expression.left;
        body = body.slice(1);
      }
      handler = t.catchClause(param, t.blockStatement(body));
    }
    let finalizer = null;
    if (F !== null) {
      let fStart = F;
      if (this.mnem(instrs[fStart][0]) === 'FINALLY_ENTER') fStart++;
      let fEnd = regionEnd;
      for (let q = fStart; q < regionEnd; q++) if (this.mnem(instrs[q][0]) === 'FINALLY_END') fEnd = q;
      const finRes = this.liftRange(state, fStart, fEnd, []);
      for (const v of finRes.stack) if (!isPure(v)) finRes.stmts.push(t.expressionStatement(v));
      finalizer = t.blockStatement(finRes.stmts);
    }
    if (!handler && !finalizer) handler = t.catchClause(null, t.blockStatement([]));
    this.spillForStatement(state, stack, emit, null);
    emit(t.tryStatement(t.blockStatement(tryRes.stmts), handler, finalizer));
    for (const c of carried) stack.push(c);
    return { stack, next: regionEnd };
  }

  // -------------------------------------------------------------------------
  // stack helpers
  // -------------------------------------------------------------------------

  pop(stack) {
    if (stack.length) return stack.pop();
    this.underflows = (this.underflows || 0) + 1;
    const u = t.identifier('undefined');
    u.__underflow = true;
    return u;
  }
  peek(stack) {
    if (stack.length) return stack[stack.length - 1];
    this.underflows = (this.underflows || 0) + 1;
    const u = t.identifier('undefined');
    u.__underflow = true;
    stack.push(u);
    return u;
  }
  popN(stack, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.unshift(this.pop(stack));
    return out;
  }
  popLit(stack) {
    const v = this.pop(stack);
    if (t.isNumericLiteral(v)) return v.value;
    if (t.isUnaryExpression(v, { operator: '-' }) && t.isNumericLiteral(v.argument)) return -v.argument.value;
    this.ctx.warn('non-literal argument count on the stack; assuming 0');
    return 0;
  }

  /** Emit an impure value that is about to be discarded. */
  dropValue(v, emit) {
    // reading an undeclared global throws, so a dropped read of an unknown global is kept
    // (standard built-ins such as `console` are known to exist)
    if (v && v.__global && t.isIdentifier(v) && !(v.name in globalThis)) { emit(t.expressionStatement(v)); return; }
    if (!v || isPure(v)) return;
    emit(t.expressionStatement(v));
  }

  flushImpure(stack, emit) {
    // nothing: values stay on the stack; used before break/continue to keep side effects
  }

  /**
   * Before emitting a statement `stmt` while values are pending on the stack,
   * spill pending values that the statement could affect into temporaries.
   */
  spillForStatement(state, stack, emit, stmt) {
    if (!stack.length) return;
    // a pure top-of-stack value that the next instruction discards needs no spill
    if (state.nextIsDrop && stack.length && isPure(stack[stack.length - 1])) {
      stack.pop();
      state.nextIsDrop = false;
      state.skipNextDrop = true;
    }
    const assigned = stmt ? assignedNames(stmt) : new Set();
    const props = stmt ? assignedProps(stmt) : new Set();
    const stmtHasCall = stmt ? containsCall(stmt) : true;
    for (let i = 0; i < stack.length; i++) {
      const v = stack[i];
      if (v && v.__builder && (t.isObjectExpression(v) || t.isArrayExpression(v)) && (!stmt || stmtHasCall || assigned.size || props.size)) { this.spillBuilder(v, emit, assigned, props); continue; }
      if (!v || v.__underflow || v.__marker || v.__builder) continue;
      if (t.isLiteral(v) || t.isThisExpression(v) || t.isFunctionExpression(v) || t.isArrowFunctionExpression(v)) continue;
      if (t.isSpreadElement(v)) {
        // `...x` waiting for its call/array: spill the operand, keep the spread marker
        const a = v.argument;
        let aff = !isPure(a);
        if (!aff) for (const n of assigned) if (referencesName(a, n)) aff = true;
        if (!aff && readsProps(a, props)) aff = true;
        if (aff) {
          const id = t.identifier(this.tmpName());
          emit(t.variableDeclaration('const', [t.variableDeclarator(id, a)]));
          v.argument = id;
        }
        continue;
      }
      let affected = !isPure(v);
      if (!affected) for (const n of assigned) if (referencesName(v, n)) affected = true;
      if (!affected && readsProps(v, props)) affected = true;
      if (!affected && stmtHasCall && !t.isIdentifier(v)) affected = false; // property reads are assumed stable
      if (affected) {
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('const', [t.variableDeclarator(id, v)]));
        for (let j = 0; j < stack.length; j++) stack[j] = replaceIdentity(stack[j], v, id);
      }
    }
  }

  /** literals under construction keep their node, but values already evaluated into them
   *  (calls etc.) precede any statement emitted now: move those into temporaries */
  tmpName() { return fresh(`_t${this.tempCounter++}`); }

  spillBuilder(b, emit, assigned = null, props = null) {
    // a pure value (e.g. a variable read) is affected only by a statement that writes what it reads
    const touched = (v) => (assigned && [...assigned].some((n) => referencesName(v, n))) || (props && props.size && readsProps(v, props));
    const slots = t.isObjectExpression(b) ? b.properties.filter((p) => t.isObjectProperty(p) || t.isSpreadElement(p)).map((p) => (t.isSpreadElement(p) ? [p, 'argument'] : [p, 'value']))
      : t.isArrayExpression(b) ? b.elements.map((e, k) => (e ? [b.elements, k] : null)).filter(Boolean) : [];
    if (t.isObjectExpression(b)) for (const p of b.properties) if (t.isObjectProperty(p) && p.computed && !isPure(p.key)) slots.push([p, 'key']);
    for (const [holder, key] of slots) {
      let v = holder[key];
      if (t.isSpreadElement(v)) { holder[key] = v; const inner = v; if (!isPure(inner.argument)) { const id = t.identifier(this.tmpName()); emit(t.variableDeclaration('const', [t.variableDeclarator(id, inner.argument)])); inner.argument = id; } continue; }
      if (!v || (isPure(v) && !touched(v)) || t.isFunctionExpression(v) || t.isArrowFunctionExpression(v)) continue;
      if (v.__builder) { this.spillBuilder(v, emit, assigned, props); continue; }
      const id = t.identifier(this.tmpName());
      emit(t.variableDeclaration('const', [t.variableDeclarator(id, v)]));
      holder[key] = id;
    }
}

  /**
   * A branch that emits a statement spills pending values of the stack it inherited
   * (`const _tN = <value>`); those values were computed before the branch, so the spill
   * belongs in front of the conditional. Both branches may have spilled the same value.
   */
  hoistBaseSpills(base, results, stack, emit, baseNodes, cond) {
    const hoisted = new Map(); // value node -> temp name
    // `(rN = v)` pending on the shared stack: a branch that reads rN flushes it as `rN = v;`. The VM
    // ran that store before the test, so the statement belongs in front of the conditional, and
    // the stack entry becomes `rN` on both paths
    const baseAssigns = new Map(); // right-hand node -> assignment node
    for (const v of base) if (v && typeof v === 'object') t.traverseFast(v, (n) => { if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left)) baseAssigns.set(n.right, n); });
    const flushedAsg = new Map(); // assignment node -> name
    for (const res of results) {
      const keep = [];
      const renames = new Map();
      for (const st of res.stmts) {
        const asg = t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isIdentifier(st.expression.left) ? st.expression : null;
        const orig = asg && baseAssigns.get(asg.right);
        if (orig && t.isIdentifier(orig.left, { name: asg.left.name })) {
          if (!flushedAsg.has(orig)) { flushedAsg.set(orig, asg.left.name); emit(st); }
          continue;
        }
        const d = t.isVariableDeclaration(st, { kind: 'const' }) && st.declarations.length === 1 ? st.declarations[0] : null;
        if (d && t.isIdentifier(d.id) && /^_t\d+$/.test(d.id.name) && baseNodes.has(d.init) && keep.length === 0 || d && hoisted.has(d.init) && baseNodes.has(d.init)) {
          if (hoisted.has(d.init)) renames.set(d.id.name, hoisted.get(d.init));
          else { hoisted.set(d.init, d.id.name); emit(st); }
          continue;
        }
        keep.push(st);
      }
      if (renames.size) {
        const fix = (n) => t.traverseFast(n, (x) => { if (t.isIdentifier(x) && renames.has(x.name)) x.name = renames.get(x.name); });
        keep.forEach(fix);
        res.stack.forEach((v) => v && typeof v === 'object' && fix(v));
      }
      res.stmts = keep;
    }
    if (hoisted.size || flushedAsg.size) {
      // one shared node per temporary: stack entries are compared by identity (`a === b`) later
      const ids = new Map([...hoisted, ...flushedAsg].map(([node, name]) => [node, t.identifier(name)]));
      const byName = new Map([...ids.values()].map((id) => [id.name, id]));
      // identifiers the branches created for their own spills of the same value: canonicalize
      const sub = (x) => { for (const [node, id] of ids) x = replaceIdentity(x, node, id); return t.isIdentifier(x) && byName.has(x.name) ? byName.get(x.name) : x; };
      for (let j = 0; j < stack.length; j++) stack[j] = sub(stack[j]);
      for (let j = 0; j < base.length; j++) base[j] = sub(base[j]);
      for (const res of results) for (let j = 0; j < res.stack.length; j++) res.stack[j] = sub(res.stack[j]);
    }
  }

  emitStatement(state, stack, emit, stmt) {
    this.spillShared(state, stack, emit, [stmt]);
    this.spillForStatement(state, stack, emit, stmt);
    emit(stmt);
  }

  /**
   * A value with side effects (call, await, new, assignment, ...) that was
   * duplicated on the stack (DUP) must be evaluated once. If such a node occurs
   * in the code about to be emitted and is still referenced from the stack (or
   * occurs twice in that code), evaluate it into a temporary first.
   */
  spillShared(state, stack, emit, exprs) {
    const isEffect = (n) => t.isCallExpression(n) || t.isOptionalCallExpression(n) || t.isNewExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n) || t.isAssignmentExpression(n) || t.isUpdateExpression(n);
    const counts = new Map();
    const count = (root, into) => {
      const walk = (n) => {
        if (!n || typeof n.type !== 'string' || t.isFunction(n) || t.isClass(n)) return;
        if (isEffect(n)) into.set(n, (into.get(n) || 0) + 1);
        for (const k of t.VISITOR_KEYS[n.type] || []) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v); }
      };
      walk(root);
    };
    for (const e of exprs) count(e, counts);
    if (!counts.size) return;
    const onStack = new Map();
    for (const v of stack) if (v && typeof v.type === 'string') count(v, onStack);
    // outermost shared nodes first: a node containing another shared node is replaced as a whole
    const shared = [...counts.keys()].filter((n) => counts.get(n) > 1 || onStack.has(n));
    if (!shared.length) return;
    const inside = (a, b) => a !== b && countIdentity(b, a) > 0; // a inside b
    const roots = shared.filter((n) => !shared.some((o) => inside(n, o)));
    for (const n of roots) {
      const id = t.identifier(this.tmpName());
      emit(t.variableDeclaration('const', [t.variableDeclarator(id, n)]));
      for (let i = 0; i < exprs.length; i++) exprs[i] = replaceIdentity(exprs[i], n, id);
      for (let i = 0; i < stack.length; i++) stack[i] = replaceIdentity(stack[i], n, id);
    }
  }

  /** Assignment: value `v` has just been popped for storing into `target`. */
  assign(state, stack, emit, target, v, declKind = null) {
    const idx = stack.lastIndexOf(v);
    if (idx >= 0 && !t.isLiteral(v)) {
      // value is still needed on the stack (DUP'd): make the assignment an expression
      const a = t.assignmentExpression('=', target, v);
      stack[idx] = a;
      return;
    }
    if (idx >= 0) {
      // literal duplicated: assign, keep literal on the stack
      this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', target, v)));
      return;
    }
    if (declKind) {
      this.emitStatement(state, stack, emit, t.variableDeclaration(declKind, [t.variableDeclarator(target, v)]));
      return;
    }
    // function declaration sugar handled later by cleanup
    this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', target, v)));
  }

  // -------------------------------------------------------------------------
  // scope variables
  // -------------------------------------------------------------------------

  frameAtQuiet(state, depth) {
    const chain = this.chainAt(state);
    return chain[chain.length - 1 - depth] || null;
  }
  frameAt(state, depth) {
    const chain = this.chainAt(state);
    const idx = chain.length - 1 - depth;
    if (idx < 0) {
      state.unknownScope = true; // reported by slotName unless the variable's name can be recovered
      return null;
    }
    return chain[idx];
  }
  slotName(state, frame, slot) {
    if (!frame) {
      // A slot in a scope the host did not hand over (e.g. sibling function declarations inside a
      // non-virtualized function). The compiler keeps the variable's name as a string constant for
      // the TDZ error message; if the program has exactly one identifier-like string constant that
      // no instruction refers to, and only one such unknown slot, that is the name.
      const unknown = new Set();
      state.instrs.forEach(([op, operand], pc) => {
        if (this.mnem(op) === 'LOAD_SCOPE' || this.mnem(op) === 'STORE_SCOPE') {
          state.curPc = pc;
          if (!this.frameAtQuiet(state, operand >>> 16)) unknown.add(operand);
        }
      });
      state.curPc = state.curPc;
      if (unknown.size === 1) {
        const used = new Set();
        for (const [op, operand] of state.instrs) {
          const mn = this.mnem(op);
          if (!/NAMED|GLOBAL|CONST|PUSH_CONST|DECLARE_TDZ|FUSED|IMM|CALL_METHOD_REG/.test(mn) || mn === 'CALL' || mn === 'NEW') continue;
          used.add(operand); used.add(operand & 0xffff); used.add(operand >>> 16);
        }
        const cands = state.prog.consts.map((c, i) => [c, i]).filter(([c, i]) => c && c.t === 'string' && isIdentName(c.v) && !used.has(i));
        if (cands.length === 1) return t.identifier(cands[0][0].v);
      }
      this.ctx.warn('scope of a captured variable is unknown (not passed by the host)');
      return t.identifier(`__scope_unknown_${slot}`);
    }
    if (frame.thisSlot === slot) return t.thisExpression();
    return t.identifier(frame.nameOf(slot, 's'));
  }

  // -------------------------------------------------------------------------
  // straight-line opcode semantics
  // -------------------------------------------------------------------------

  step(state, m, op, operand, stack, emit, pc) {
    const K = state.prog.consts;
    const e = this.entry(op);
    const push = (v) => stack.push(v);
    const pop = () => this.pop(stack);
    const constAt = (i) => constNode(K[i]);
    const keyConst = (i) => (K[i] ? constNode(K[i]) : t.stringLiteral(`__k${i}`));

    switch (m) {
      case 'NOP': case 'DESTRUCTURE_CHECK': case 'TRY_POP': case 'FINALLY_ENTER': case 'FINALLY_END':
        return;
      case 'DEBUGGER': emit(t.debuggerStatement()); return;
      case 'DECOY_PUSH': push(t.identifier('undefined')); return;
      case 'PUSH_UNDEF': push(t.identifier('undefined')); return;
      case 'PUSH_NULL': push(t.nullLiteral()); return;
      case 'PUSH_OBJ': { const o = t.objectExpression([]); o.__builder = true; push(o); return; }
      case 'PUSH_ARR': { const a = t.arrayExpression([]); a.__builder = true; push(a); return; }
      case 'PUSH_CONST': {
        const c = K[operand];
        if (c && c.t === 'program') { const n = t.identifier(`__program_${c.id}`); n.__programRef = c.id; push(n); return; }
        push(constAt(operand)); return;
      }
      case 'PUSH_THIS': case 'PUSH_LEXICAL_THIS': push(t.thisExpression()); return;
      case 'PUSH_NEW_TARGET': push(t.metaProperty(t.identifier('new'), t.identifier('target'))); return;
      case 'PUSH_ARGUMENTS': state.usesArguments = true; push(t.identifier('arguments')); return;
      case 'PUSH_SCOPE': { const s = t.identifier('__scope'); s.__marker = 'scope'; push(s); return; }
      case 'PUSH_SUPER_CTOR': { const s = t.identifier('__superCtor'); s.__marker = 'superCtor'; push(s); return; }

      case 'DUP': { const v = this.peek(stack); if (v && typeof v === 'object') v.__dup = true; push(v); return; }
      case 'DROP': {
        if (state.skipNextDrop) { state.skipNextDrop = false; return; }
        const v = pop();
        const unknownGlobal = v && v.__global && t.isIdentifier(v) && !(v.name in globalThis); // a read that can throw
        if (!stack.includes(v) && !(state.alive && state.alive.has(v)) && (!isDroppable(v) || unknownGlobal)) this.emitStatement(state, stack, emit, t.expressionStatement(v));
        return;
      }
      case 'SWAP': { const a = pop(), b = pop(); push(a); push(b); return; }
      case 'ROT_TOP_DOWN': { const c = pop(), b = pop(), a = pop(); push(c); push(a); push(b); return; } // [a,b,c] -> [c,a,b]
      case 'ROT_BOTTOM_UP': { const c = pop(), b = pop(), a = pop(); push(b); push(c); push(a); return; } // [a,b,c] -> [b,c,a]
      case 'ROT3': { const c = pop(), b = pop(), a = pop(); const map = { v0: a, v1: b, v2: c }; for (const k of (e.perm || 'v0,v1,v2').split(',')) push(map[k]); return; }

      // registers / args
      case 'LOAD_REG': {
        if (state.brandRegs && state.brandRegs.has(operand)) { const b = t.identifier('__brand'); b.__brandHelper = true; push(b); return; }
        if (state.tempValues.has(operand)) { push(t.cloneNode(state.tempValues.get(operand), true)); return; }
        if (state.iterInit && state.iterInit.has(operand)) { push(this.regId(state, operand)); return; }
        if (state.regIter.has(operand)) { const it = state.regIter.get(operand); const n = t.identifier(`__iter${operand}`); n.__marker = 'iter'; n.__src = it; n.__reg = operand; push(n); return; }
        this.flushAssignmentsTo(state, stack, emit, this.regName(state, operand));
        push(this.regId(state, operand)); return;
      }
      case 'STORE_REG': {
        const v = pop();
        if (v.__marker === 'iter') {
          state.regIter.set(operand, v.__src);
          if (v.__async) (state.regIterAsync || (state.regIterAsync = new Set())).add(operand);
          // materialize the iterator once; the for..of / destructuring idioms drop this statement again
          const init = t.expressionStatement(t.assignmentExpression('=', this.regId(state, operand),
            t.callExpression(t.memberExpression(v.__src, t.memberExpression(t.identifier('Symbol'), t.identifier(v.__async ? 'asyncIterator' : 'iterator')), true), [])));
          (state.iterInit || (state.iterInit = new Map())).set(operand, init);
          this.emitStatement(state, stack, emit, init);
          // emitting may have moved the source (a call shared with the stack) into a temporary:
          // the for..of / destructuring idioms must use that temporary, not evaluate the call again
          state.regIter.set(operand, init.expression.right.callee.object);
          return;
        }
        if (v.__marker === 'forInKeys') { state.regForIn.set(operand, v.__src); state.hiddenRegs.add(operand); return; }
        if (v.__brandHelper) { (state.brandRegs || (state.brandRegs = new Set())).add(operand); state.hiddenRegs.add(operand); return; }
        const tw = state.tempWindow.get(operand);
        const win = tw ? { ...tw, regStoreNames: new Set([...tw.regStores].map((r) => this.regName(state, r))) } : { stores: true, effects: true };
        // a property read (getter, proxy trap) must stay a single read: substitute it only at a single load
        let root = v;
        while (t.isMemberExpression(root)) root = root.object;
        const multi = tw && tw.loads > 1 && !(t.isIdentifier(v) || t.isLiteral(v) || t.isThisExpression(v)) && !(root && root.__global);
        if (state.tempRegs.has(operand) && !multi && this.isSimpleValue(v, win) && !stack.includes(v)) { state.tempValues.set(operand, v); state.hiddenRegs.add(operand); return; }
        this.assign(state, stack, emit, this.regId(state, operand), v);
        return;
      }
      case 'REG_INC': this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('++', this.regId(state, operand)))); return;
      case 'REG_DEC': this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('--', this.regId(state, operand)))); return;
      case 'REG_PREINC': push(t.updateExpression('++', this.regId(state, operand), true)); return;
      case 'REG_PREDEC': push(t.updateExpression('--', this.regId(state, operand), true)); return;
      case 'LOAD_ARG': { const a = this.argId(state, operand); if (t.isIdentifier(a)) this.flushAssignmentsTo(state, stack, emit, a.name); push(a); return; }
      case 'STORE_ARG': { const v = pop(); this.assign(state, stack, emit, this.argId(state, operand), v); return; }

      // globals
      case 'LOAD_GLOBAL': { const g = this.globalRef(K[operand]); g.__global = true; push(g); return; }
      case 'TYPEOF_GLOBAL': push(t.unaryExpression('typeof', this.globalRef(K[operand]))); return;
      case 'DELETE_GLOBAL': push(t.unaryExpression('delete', t.memberExpression(t.identifier('globalThis'), keyConst(operand), true))); return;
      case 'STORE_GLOBAL': case 'STORE_GLOBAL_DECL': {
        const v = pop();
        if (m === 'STORE_GLOBAL_DECL' && K[operand] && K[operand].t === 'string') this.globalVarDecls.add(K[operand].v);
        push(t.assignmentExpression('=', this.globalRef(K[operand]), v));
        return;
      }

      // scopes
      case 'ENTER_SCOPE': {
        const parent = pop();
        if (parent.__marker !== 'scope') this.ctx.warn('ENTER_SCOPE without PUSH_SCOPE');
        // frames come from the scope analysis (chainAt); declare the slots hoisted to this scope
        const hs = state.hoistSlots && state.hoistSlots.get(state.curPc);
        if (hs) {
          const frame = this.frameForEnter(state, state.curPc);
          const ids = [];
          for (const sl of hs) if (!frame.declared.has(sl) && frame.thisSlot !== sl) { frame.declared.add(sl); ids.push(this.slotName(state, frame, sl)); }
          if (ids.length) this.emitStatement(state, stack, emit, t.variableDeclaration('let', ids.filter((x) => t.isIdentifier(x)).map((x) => t.variableDeclarator(x))));
        }
        return;
      }
      case 'EXIT_SCOPE': return;
      case 'DECLARE_TDZ': {
        const slot = operand & 0xffff;
        const nameIdx = operand >>> 16;
        const frame = this.currentFrame(state);
        // a slot can be re-declared under another name (the compiler reuses slot numbers for
        // TDZ tracking); keep the name it was declared with so every use refers to one binding
        if (nameIdx && K[nameIdx - 1] && K[nameIdx - 1].t === 'string' && isIdentName(K[nameIdx - 1].v) && !frame.declared.has(slot) && !frame.names.has(slot)) frame.names.set(slot, K[nameIdx - 1].v);
        // the declaration itself is emitted at the initializing store (the compiler always emits
        // one at the declaration point, `undefined` for a bare `let x;`), so reads before it keep
        // their TDZ ReferenceError - but only if that store follows in straight-line code;
        // otherwise (a store inside a branch comes first) declare here
        if (!frame.declared.has(slot)) {
          // the first store to the slot in this scope must be reached on every path from here:
          // no jump between the two leaves the interval, none enters it from outside, and the
          // store is not inside a try region that begins in between
          const d0 = state.curPc;
          let q = -1;
          for (let k = d0 + 1; k < state.instrs.length; k++) {
            const mk = this.mnem(state.instrs[k][0]);
            if ((mk === 'STORE_LOCAL' || mk === 'STORE_LOCAL_CONST') && state.instrs[k][1] === slot && state.scopeStacks[k] && state.scopeStacks[d0] &&
                state.scopeStacks[k].join() === state.scopeStacks[d0].join()) { q = k; break; }
          }
          let straight = q > 0;
          if (straight) {
            for (const [f, to] of Object.entries(state.jumps)) {
              const fn = Number(f);
              const inside = fn > d0 && fn < q;
              if (inside && (to > q || to <= d0)) { straight = false; break; }
              if (!inside && to > d0 && to <= q && fn !== q) { straight = false; break; }
            }
            for (const [tp, tr] of Object.entries(state.tries)) {
              const tpn = Number(tp);
              if (tr && tpn > d0 && tpn < q && (tr[2] === null || tr[2] > q)) straight = false;
            }
          }
          if (!straight) {
            frame.declared.add(slot);
            this.emitStatement(state, stack, emit, t.variableDeclaration('let', [t.variableDeclarator(this.slotName(state, frame, slot))]));
          }
        }
        return;
      }
      case 'BIND_THIS_SLOT': { const frame = this.currentFrame(state); frame.thisSlot = operand; return; }
      case 'BIND_SELF': {
        const frame = this.currentFrame(state);
        // a named function expression refers to itself through this slot; the name comes from
        // the prologue, else from the closure builder, else a synthetic one
        const p = state.prog;
        const fk = p.fnKind && p.fnKind.name;
        const name = p.name && isIdentName(p.name) ? p.name : fk && isIdentName(fk) ? fk : fresh(`fn${p.id}`);
        if (!p.name) p.selfName = name;
        frame.names.set(operand, name);
        frame.declared.add(operand);
        frame.selfSlot = operand;
        return;
      }
      case 'STORE_LOCAL': case 'STORE_LOCAL_CONST': {
        if (operand === -2) return;
        if (operand === -1) { this.dropValue(pop(), emit); return; }
        const frame = this.currentFrame(state);
        const v = pop();
        if (v.__marker === 'iter') { /* iterator stored into a scope slot: keep as expression */ }
        // a class under construction bound to a const slot (the inner class-name binding, or a
        // temporary of the private-member lowering): inside the class body that is the class's
        // own name, so the slot is an alias and the builder keeps collecting members
        if (m === 'STORE_LOCAL_CONST' && v.__builder && t.isClassExpression(v) && v.id && stack.includes(v) && !frame.declared.has(operand) && !frame.external &&
            this.slotName(state, frame, operand).name === v.id.name) {
          frame.declared.add(operand);
          (frame.classAliases || (frame.classAliases = new Set())).add(operand);
          return;
        }
        // the finished class stored again into its own name slot (after static initializers):
        // that slot is the class's inner binding, which the class expression already provides
        if (frame.classAliases && frame.classAliases.has(operand) && t.isClassExpression(v) && v.id &&
            this.slotName(state, frame, operand).name === v.id.name) return;
        const target = this.slotName(state, frame, operand);
        // per-iteration copy of an aliased `for (let ...)` variable: `i = i`
        if (frame.declared.has(operand) && t.isIdentifier(v) && t.isIdentifier(target, { name: v.name })) return;
        // the `this` slot of a derived constructor is set from `super(...)`, which binds `this` itself
        if (t.isThisExpression(target)) { if (!stack.includes(v)) this.dropValue(v, emit); return; }
        if (frame.declared.has(operand) || frame.external) this.assign(state, stack, emit, target, v);
        else {
          frame.declared.add(operand);
          this.assign(state, stack, emit, target, v, m === 'STORE_LOCAL_CONST' ? 'const' : 'let');
        }
        return;
      }
      case 'LOAD_SCOPE': {
        const slot = operand & 0xffff, depth = operand >>> 16;
        const frame = this.frameAt(state, depth);
        const n = this.slotName(state, frame, slot);
        if (t.isIdentifier(n)) { this.flushAssignmentsTo(state, stack, emit, n.name); n.__scopeRef = true; }
        push(n);
        return;
      }
      case 'STORE_SCOPE': {
        const slot = operand & 0xffff, depth = operand >>> 16;
        const frame = this.frameAt(state, depth);
        const v = pop();
        this.assign(state, stack, emit, this.slotName(state, frame, slot), v);
        return;
      }

      // arithmetic
      case 'BINOP': { const b = pop(), a = pop(); push(this.binary(e.op, a, b)); return; }
      case 'BINOP_MEGA': {
        const sel = (operand ^ e.mask) >>> 0;
        const l = e.ladder[sel];
        const b = pop(), a = pop();
        if (!l) { this.ctx.warn(`unknown BINOP selector ${sel}`); push(t.callExpression(t.identifier('__binop'), [t.numericLiteral(sel), a, b])); return; }
        push(l.swapped ? this.binary(l.op, b, a) : this.binary(l.op, a, b));
        return;
      }
      case 'FUSED_BINOP': push(this.binary(e.op, this.regId(state, operand & 0xffff), constAt(operand >>> 16))); return;
      case 'UNARY': {
        const v = pop();
        if (e.op === 'typeof') push(t.unaryExpression('typeof', v));
        else push(t.unaryExpression(e.op, v));
        return;
      }
      case 'VOID': push(t.unaryExpression('void', pop())); return;
      case 'TO_NUMERIC': case 'TO_PROPERTY_KEY': return; // coercions: identity for source recovery
      case 'INC_VALUE': push(t.binaryExpression('+', pop(), t.numericLiteral(1))); return;
      case 'DEC_VALUE': push(t.binaryExpression('-', pop(), t.numericLiteral(1))); return;
      case 'TO_STRING': { const v = pop(); if (t.isStringLiteral(v)) { push(v); return; } const c = t.callExpression(t.identifier('String'), [v]); c.__toString = true; push(c); return; }

      // property access
      case 'GETPROP_NAMED': {
        const obj = pop();
        if (obj.__marker === 'superCtor') { push(t.super()); return; }
        push(member(obj, keyConst(operand))); return;
      }
      case 'GETPROP_NAMED_KEEP': { const obj = this.peek(stack); push(member(obj, keyConst(operand))); return; }
      case 'GETPROP_COMPUTED': { const key = pop(), obj = pop(); push(member(obj, key)); return; }
      case 'GETPROP_REG_CONST': push(member(this.regId(state, operand & 0xffff), keyConst(operand >>> 16))); return;
      case 'GET_THIS_PROP': push(member(t.thisExpression(), keyConst(operand))); return;
      case 'OPT_GETPROP_NAMED': push(optMember(pop(), keyConst(operand))); return;
      case 'OPT_GETPROP_COMPUTED': { const key = pop(), obj = pop(); push(optMember(obj, key)); return; }
      case 'SETPROP_NAMED': { const v = pop(), obj = pop(); push(t.assignmentExpression('=', member(obj, keyConst(operand)), v)); return; }
      case 'SETPROP_COMPUTED': { const v = pop(), key = pop(), obj = pop(); push(t.assignmentExpression('=', member(obj, key), v)); return; }
      case 'DELETE_PROP': {
        if (operand >= 0) { const obj = pop(); push(t.unaryExpression('delete', member(obj, keyConst(operand)))); }
        else { const key = pop(), obj = pop(); push(t.unaryExpression('delete', member(obj, key))); }
        return;
      }
      case 'IN_SAFE': { const obj = pop(), key = pop(); push(t.binaryExpression('in', key, obj)); return; }

      // literals / object building
      case 'DEFINE_PROP_NAMED': { const v = pop(), obj = pop(); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: true }); return; }
      case 'DEFINE_PROP_COMPUTED': { const v = pop(), key = pop(), obj = pop(); this.defineProp(state, stack, emit, obj, key, v, { enumerable: true }); return; }
      case 'DEFINE_METHOD_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: false, isStatic: true }); return; }
      case 'DEFINE_METHOD_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { enumerable: false, isStatic: true }); return; }
      case 'DEFINE_PROTO_METHOD_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: false, proto: true }); return; }
      case 'DEFINE_PROTO_METHOD_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { enumerable: false, proto: true }); return; }
      case 'DEFINE_GETTER_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { accessor: 'get', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'DEFINE_SETTER_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { accessor: 'set', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'DEFINE_GETTER_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { accessor: 'get', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'DEFINE_SETTER_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { accessor: 'set', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'SET_PROTO': {
        const proto = pop(), obj = this.peek(stack);
        if (obj.__builder && t.isObjectExpression(obj)) obj.properties.push(t.objectProperty(t.identifier('__proto__'), proto));
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')), [obj, proto])));
        return;
      }
      case 'OBJ_SPREAD': {
        const src = pop(), obj = this.peek(stack);
        if (obj.__builder && t.isObjectExpression(obj)) obj.properties.push(t.spreadElement(src));
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), [obj, src])));
        return;
      }
      case 'OBJ_REST': {
        const excluded = pop(), src = pop();
        // (({k1, k2, ...rest}) => rest)(src)
        const props = [];
        if (t.isArrayExpression(excluded)) {
          excluded.elements.forEach((k, i) => {
            const pk = propKey(k);
            props.push(t.objectProperty(pk.key, t.identifier(`_x${i}`), pk.computed));
          });
        }
        props.push(t.restElement(t.identifier('rest')));
        push(t.callExpression(t.arrowFunctionExpression([t.objectPattern(props)], t.identifier('rest')), [src]));
        return;
      }
      case 'ARR_PUSH': {
        const v = pop(), arr = this.peek(stack);
        if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(v);
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(arr, t.identifier('push')), [v])));
        return;
      }
      case 'ARR_SPREAD': {
        const v = pop(), arr = this.peek(stack);
        if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(t.spreadElement(v));
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(arr, t.identifier('push')), [t.spreadElement(v)])));
        return;
      }
      case 'ARR_HOLE': {
        const arr = this.peek(stack);
        if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(null);
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('++', t.memberExpression(arr, t.identifier('length')))));
        return;
      }
      case 'SPREAD_MARK': push(t.spreadElement(pop())); return;
      case 'TEMPLATE_OBJECT': {
        const n = this.popLit(stack);
        const raw = this.popN(stack, n);
        const cooked = this.popN(stack, n);
        // outside a reconstructible tag call the object must still be a frozen strings array with
        // `.raw`: an identity tag applied to the same raw text yields exactly that
        let obj;
        if (raw.every((r) => t.isStringLiteral(r)) && raw.length) {
          const quasis = raw.map((r, i) => t.templateElement({ raw: r.value }, i === raw.length - 1));
          obj = t.taggedTemplateExpression(t.arrowFunctionExpression([t.identifier('s')], t.identifier('s')), t.templateLiteral(quasis, raw.slice(1).map(() => t.numericLiteral(0))));
        } else obj = t.arrayExpression(cooked);
        obj.__templateRaw = raw;
        obj.__templateCooked = cooked;
        push(obj);
        return;
      }
      case 'NEW_REGEXP': {
        const src = K[operand & 0xffff], flags = K[operand >>> 16];
        push(t.regExpLiteral(src && src.t === 'string' ? src.v : '', flags && flags.t === 'string' ? flags.v : ''));
        return;
      }
      case 'SYMBOL': push(t.callExpression(t.identifier('Symbol'), operand === -1 ? [] : [pop()])); return;
      case 'SYMBOL_FOR': push(t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('for')), [constAt(operand)])); return;
      case 'SYMBOL_KEYFOR': push(t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('keyFor')), [pop()])); return;
      case 'DYNAMIC_IMPORT': push(t.callExpression(t.import(), [pop()])); return;

      // iteration
      case 'GET_ITERATOR': { const src = pop(); const n = t.identifier('__iter'); n.__marker = 'iter'; n.__src = src; push(n); return; }
      case 'GET_ASYNC_ITERATOR': { const src = pop(); const n = t.identifier('__aiter'); n.__marker = 'iter'; n.__src = src; n.__async = true; push(n); return; }
      case 'ITER_NEXT_RESULT': { const it = pop(); push(t.callExpression(t.memberExpression(this.iterExpr(it), t.identifier('next')), [])); return; }
      case 'ITER_NEXT_CALL': { const it = pop(); push(t.callExpression(t.memberExpression(this.iterExpr(it), t.identifier('next')), [])); return; }
      case 'ITER_RESULT_DONE': push(t.memberExpression(pop(), t.identifier('done'))); return;
      case 'ITER_CLOSE': case 'ITER_CLOSE_SILENT': {
        // IteratorClose: the `return` method is optional (array iterators have none)
        const it = pop();
        if (it.__marker === 'iter') return;
        const close = t.expressionStatement(t.optionalCallExpression(t.optionalMemberExpression(it, t.identifier('return'), false, true), [], true));
        this.emitStatement(state, stack, emit, m === 'ITER_CLOSE_SILENT' ? t.tryStatement(t.blockStatement([close]), t.catchClause(null, t.blockStatement([]))) : close);
        return;
      }
      case 'ASYNC_ITER_CLOSE': { pop(); push(t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), [])); return; }
      case 'FOR_IN_KEYS': { const obj = pop(); const n = t.identifier('__keys'); n.__marker = 'forInKeys'; n.__src = obj; push(n); return; }

      // calls
      case 'CALL': {
        const argc = this.popLit(stack);
        const callee = pop();
        const args = this.popN(stack, argc);
        push(this.callExpr(callee, args, null));
        return;
      }
      case 'CALL_METHOD': case 'CALL_METHOD_IMM': {
        const argc = m === 'CALL_METHOD_IMM' ? (K[operand] && K[operand].t === 'number' ? K[operand].v : 0) : this.popLit(stack);
        const callee = pop();
        const thisObj = pop();
        const args = this.popN(stack, argc);
        // a thunk run with the class under construction as `this` is a static initializer
        if (thisObj && thisObj.__builder && t.isClassExpression(thisObj) && !args.length && t.isFunctionExpression(callee) && !callee.params.length && !callee.async && !callee.generator) {
          const block = t.staticBlock(callee.body.body);
          thisObj.body.body.push(block);
          // its result is the value of a static field when the next definition uses it
          const res = t.identifier('undefined');
          res.__staticInit = block;
          push(res);
          return;
        }
        push(this.callExpr(callee, args, thisObj));
        return;
      }
      case 'CALL_METHOD_REG_CONST': {
        const argc = this.popLit(stack);
        const args = this.popN(stack, argc);
        push(t.callExpression(member(this.regId(state, operand & 0xffff), keyConst(operand >>> 16)), args));
        return;
      }
      case 'NEW': {
        const argc = this.popLit(stack);
        const args = this.popN(stack, argc);
        const ctor = pop();
        push(t.newExpression(ctor, args));
        return;
      }
      case 'SUPER_CALL': {
        const argc = this.popLit(stack);
        const args = this.popN(stack, argc);
        pop(); // the callee, always `super`
        if (operand === 1) { push(t.arrayExpression(args)); return; }
        this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.super(), args)));
        return;
      }
      case 'SUPER_GET': { const key = pop(); pop(); push(member(t.super(), key)); return; }
      case 'SUPER_SET': { const v = pop(), key = pop(); pop(); push(t.assignmentExpression('=', member(t.super(), key), v)); return; }

      // functions & classes
      case 'MAKE_CLOSURE': {
        const desc = pop();
        push(this.makeClosure(state, desc));
        return;
      }
      case 'MAKE_CLASS': {
        const name = pop();
        const ctor = pop();
        const cls = t.classExpression(t.isStringLiteral(name) && isIdentName(name.value) ? t.identifier(name.value) : null, null, t.classBody([]));
        cls.__builder = true;
        if (t.isFunctionExpression(ctor)) {
          cls.body.body.push(t.classMethod('constructor', t.identifier('constructor'), ctor.params, ctor.body));
        }
        push(cls);
        return;
      }
      case 'CLASS_EXTENDS': {
        const sup = pop();
        const cls = this.peek(stack);
        if (t.isClassExpression(cls)) cls.superClass = sup;
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')), [cls, sup])));
        return;
      }

      case 'TEMPLATE': this.applyTemplate(state, e, operand, stack, emit); return;
      case 'CALL_IMM': {
        const argc = K[operand] && K[operand].t === 'number' ? K[operand].v : 0;
        const callee = pop();
        const args = this.popN(stack, argc);
        push(this.callExpr(callee, args, null));
        return;
      }

      // generators
      case 'YIELD': push(t.yieldExpression(pop())); return;
      case 'YIELD_STAR': push(t.yieldExpression(pop(), true)); return;
      case 'AWAIT': push(t.awaitExpression(pop())); return;

      default:
        this.ctx.warn(`unhandled opcode ${m} at pc ${pc}`);
        push(t.callExpression(t.identifier(`__${m}`), [t.numericLiteral(operand)]));
    }
  }

  /** Build the AST for a template expression. ctx: { state, operand, popped } */
  templateExpr(x, ctx) {
    const { state, operand, popped } = ctx;
    const field = (f) => (f === 'op' ? operand : f === 'lo' ? operand & 0xffff : f === 'hi' ? operand >>> 16 : Number(String(f).slice(1)));
    switch (x.k) {
      case 'leaf': {
        const [tag, f] = x.key.split(':');
        if (tag === 'S') { const v = popped[Number(f)]; return v || t.identifier('undefined'); }
        if (tag === 'R') return this.regId(state, field(f));
        if (tag === 'A') return this.argId(state, field(f));
        if (tag === 'K') return constNode(state.prog.consts[field(f)]);
        if (tag === 'OPV') return t.numericLiteral(field(f));
        if (tag.startsWith('C')) return this.slotName(state, this.frameAt(state, field(tag.slice(1))), field(f));
        return t.identifier('undefined');
      }
      case 'lit': return x.v === undefined ? t.identifier('undefined') : x.v === null ? t.nullLiteral() : t.booleanLiteral(x.v);
      case 'fresh': { const n = x.kind === 'arr' ? t.arrayExpression([]) : t.objectExpression([]); n.__builder = true; return n; }
      case 'un': {
        const a = this.templateExpr(x.a, ctx);
        switch (x.op) {
          case 'inc': return t.binaryExpression('+', a, t.numericLiteral(1));
          case 'dec': return t.binaryExpression('-', a, t.numericLiteral(1));
          case '|0': return t.binaryExpression('|', a, t.numericLiteral(0));
          case '>>>0': return t.binaryExpression('>>>', a, t.numericLiteral(0));
          case '!=null': return t.binaryExpression('!=', a, t.nullLiteral());
          case '==null': return t.binaryExpression('==', a, t.nullLiteral());
          case 'String': { const c = t.callExpression(t.identifier('String'), [a]); c.__toString = true; return c; }
          default: return t.unaryExpression(x.op, a);
        }
      }
      case 'bin': return this.binary(x.op, this.templateExpr(x.a, ctx), this.templateExpr(x.b, ctx));
      default: return t.identifier('undefined');
    }
  }

  applyTemplate(state, e, operand, stack, emit) {
    const { gen } = require('./locate');
    const popped = [];
    for (let i = 0; i < e.pops; i++) popped.push(this.pop(stack));
    const ctx = { state, operand, popped };
    const pushes = e.pushes.map((x) => this.templateExpr(x, ctx));
    const writes = e.writes.map((w) => ({ target: this.templateExpr({ k: 'leaf', key: w.target }, ctx), value: this.templateExpr(w.expr, ctx) }));
    // a pushed value that equals a written value becomes the assignment expression itself
    const usedWrite = new Set();
    for (let i = 0; i < pushes.length; i++) {
      const pg = gen(pushes[i]);
      const wi = writes.findIndex((w, j) => !usedWrite.has(j) && gen(w.value) === pg);
      if (wi >= 0) { usedWrite.add(wi); pushes[i] = t.assignmentExpression('=', writes[wi].target, writes[wi].value); }
    }
    // pushes reading a location that is written afterwards must be evaluated first
    const writtenNames = writes.filter((w, j) => !usedWrite.has(j)).map((w) => gen(w.target));
    for (let i = 0; i < pushes.length; i++) {
      const pg = gen(pushes[i]);
      if (writtenNames.some((n) => new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`).test(pg)) && !t.isAssignmentExpression(pushes[i])) {
        const id = t.identifier(this.tmpName());
        this.emitStatement(state, stack, emit, t.variableDeclaration('const', [t.variableDeclarator(id, pushes[i])]));
        pushes[i] = id;
      }
    }
    writes.forEach((w, j) => { if (!usedWrite.has(j)) this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', w.target, w.value))); });
    for (const p of pushes) stack.push(p);
  }

  iterExpr(it) {
    if (it.__marker === 'iter') return t.callExpression(t.memberExpression(it.__src, t.memberExpression(t.identifier('Symbol'), t.identifier('iterator')), true), []);
    return it;
  }

  argId(state, i) {
    if (i < state.paramNames.length) return t.identifier(state.paramNames[i]);
    state.usesArguments = true;
    return t.memberExpression(t.identifier('arguments'), t.numericLiteral(i), true);
  }

  globalRef(c) {
    if (c && c.t === 'string' && isIdentName(c.v)) return t.identifier(c.v);
    return t.memberExpression(t.identifier('globalThis'), constNode(c), true);
  }

  binary(op, a, b) {
    if (['&&', '||', '??'].includes(op)) return t.logicalExpression(op, a, b);
    return t.binaryExpression(op, a, b);
  }

  callExpr(callee, args, thisObj) {
    if (callee && callee.__brandHelper && args.length === 1) return args[0];
    // `(function () { return <expr>; }).call(x)` without `this`/`arguments` in <expr>: just <expr>
    // (the compiler wraps field initializers in such thunks)
    if (t.isFunctionExpression(callee) && !callee.params.length && !args.length && !callee.async && !callee.generator &&
        callee.body.body.length === 1 && t.isReturnStatement(callee.body.body[0]) && callee.body.body[0].argument && !callee.body.directives.length) {
      const e = callee.body.body[0].argument;
      let self = false;
      t.traverseFast(e, (n) => { if (t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }) || t.isFunction(n) || t.isSuper(n)) self = true; });
      if (!self) return e;
    }
    // tag`...${x}...`: first argument is a frozen template object with raw strings
    if (args.length && args[0] && args[0].__templateRaw && (thisObj === null || ((t.isMemberExpression(callee)) && require('./locate').gen(callee.object) === require('./locate').gen(thisObj)))) {
      const cooked = args[0].__templateCooked || args[0].elements;
      const raw = args[0].__templateRaw;
      const exprs = args.slice(1);
      if (cooked.length === exprs.length + 1 && cooked.every((c) => t.isStringLiteral(c) || t.isIdentifier(c, { name: 'undefined' })) && raw.every((r) => t.isStringLiteral(r))) {
        const quasis = raw.map((r, i) => t.templateElement({ raw: r.value, cooked: t.isStringLiteral(cooked[i]) ? cooked[i].value : undefined }, i === raw.length - 1));
        return t.taggedTemplateExpression(callee, t.templateLiteral(quasis, exprs));
      }
    }
    if (thisObj === null) {
      if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) return t.callExpression(t.sequenceExpression([t.numericLiteral(0), callee]), args);
      return t.callExpression(callee, args);
    }
    // method call: callee is `thisObj.prop`
    const { gen } = require('./locate');
    if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && gen(callee.object) === gen(thisObj)) {
      return t.callExpression(callee, args);
    }
    if (callee.__templateTag) return t.callExpression(callee, args);
    return t.callExpression(t.memberExpression(callee, t.identifier('call')), [thisObj, ...args]);
  }

  defineProp(state, stack, emit, obj, key, value, opts) {
    const pk = propKey(key);
    if (obj.__builder && t.isObjectExpression(obj)) {
      if (opts.accessor) {
        const fn = t.isFunctionExpression(value) || t.isArrowFunctionExpression(value) ? value : null;
        if (fn) { obj.properties.push(t.objectMethod(opts.accessor, pk.key, fn.params, t.isBlockStatement(fn.body) ? fn.body : t.blockStatement([t.returnStatement(fn.body)]), pk.computed)); return; }
      }
      if (t.isFunctionExpression(value) && value.__methodKind) {
        obj.properties.push(t.objectMethod('method', pk.key, value.params, value.body, pk.computed, value.generator, value.async));
        return;
      }
      obj.properties.push(t.objectProperty(pk.key, value, pk.computed));
      return;
    }
    if (obj.__builder && t.isClassExpression(obj)) {
      const fn = t.isFunctionExpression(value) ? value : null;
      // members defined on the class object itself are static (instance fields are set up by
      // the constructor, prototype members carry `proto`)
      const isStatic = !opts.proto;
      if (fn) {
        const kind = opts.accessor || 'method';
        const meth = t.classMethod(kind, pk.key, fn.params, fn.body, pk.computed, isStatic, fn.generator, fn.async);
        obj.body.body.push(meth);
      } else if (value.__staticInit && obj.body.body.includes(value.__staticInit)) {
        // `static x = <expr>` compiles to a thunk run with the class as `this`: the field takes
        // the static block's place, with the thunk's return value as initializer
        const block = value.__staticInit;
        const body = block.body;
        const init = body.length === 1 && t.isReturnStatement(body[0])
          ? body[0].argument || t.identifier('undefined')
          : t.callExpression(t.arrowFunctionExpression([], t.blockStatement(body)), []);
        obj.body.body.splice(obj.body.body.indexOf(block), 1, t.classProperty(pk.key, init, null, null, pk.computed, isStatic));
      } else {
        obj.body.body.push(t.classProperty(pk.key, value, null, null, pk.computed, isStatic));
      }
      return;
    }
    // generic object: assignment / defineProperty
    if (opts.accessor) {
      const desc = t.objectExpression([t.objectProperty(t.identifier(opts.accessor), value), t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true))]);
      const target = opts.proto ? t.memberExpression(obj, t.identifier('prototype')) : obj;
      this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')), [target, t.isIdentifier(pk.key) && !pk.computed ? t.stringLiteral(pk.key.name) : pk.key, desc])));
      return;
    }
    const target = opts.proto ? t.memberExpression(obj, t.identifier('prototype')) : obj;
    this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', member(target, pk.computed ? key : t.isIdentifier(pk.key) ? t.stringLiteral(pk.key.name) : pk.key), value)));
  }

  makeClosure(state, desc) {
    let progId = null;
    if (desc.__programRef !== undefined) progId = desc.__programRef;
    else if (t.isNumericLiteral(desc)) progId = this.ctx.nestedIndexToId[desc.value];
    if (progId === undefined || progId === null || !this.ctx.programsById.has(progId)) {
      this.ctx.warn(`could not resolve closure descriptor`);
      return t.callExpression(t.identifier('__closure'), [desc]);
    }
    const prog = this.ctx.programsById.get(progId);
    const lifted = this.liftProgram(prog, { parentChain: this.chainAt(state) });
    const fn = this.buildFunction(prog, lifted);
    if (this.isBrandCheckProgram(prog) || isKeyHelper(fn)) fn.__brandHelper = true;
    return fn;
  }

  /**
   * obfuscator.io lowers private members before compiling; every access then goes through a
   * one-argument brand check that returns its argument or throws "Cannot read private member
   * ...". Such helpers are identities on valid receivers, and the restored `#x` syntax performs
   * the same check natively.
   */
  isBrandCheckProgram(prog) {
    if (prog.__brand !== undefined) return prog.__brand;
    const re = /private (member|method|field)/;
    const hasMsg = (p) => p && p.consts.some((c) => c && c.t === 'string' && re.test(c.v));
    let brand = prog.paramCount === 1 && hasMsg(prog);
    if (!brand && prog.paramCount === 1) {
      // `o => SYM in o ? o : { get [SYM]() { throw ... } }`: the message sits in nested programs
      for (let pc = 1; pc < prog.instrs.length && !brand; pc++) {
        if (this.mnem(prog.instrs[pc][0]) !== 'MAKE_CLOSURE' || this.mnem(prog.instrs[pc - 1][0]) !== 'PUSH_CONST') continue;
        const c = prog.consts[prog.instrs[pc - 1][1]];
        const id = c && c.t === 'number' ? this.ctx.nestedIndexToId[c.v] : c && c.t === 'program' ? c.id : undefined;
        const nested = id !== undefined ? this.ctx.programsById.get(id) : null;
        if (hasMsg(nested)) brand = true;
      }
    }
    prog.__brand = brand;
    return brand;
  }

  buildFunction(prog, lifted, opts = {}) {
    const kind = prog.fnKind || { kind: 'function' };
    let params = lifted.params;
    let body = lifted.body;
    // rest parameter recovery: `Array.prototype.slice.call(arguments, N)` with N == paramCount
    const restName = fresh('rest');
    let usedRest = false;
    if (lifted.usesArguments && opts.argumentsName) {
      // the caller supplies the arguments array under another name
      const wrapper = t.blockStatement(body);
      t.traverseFast(wrapper, (n) => { if (t.isIdentifier(n, { name: 'arguments' })) n.name = opts.argumentsName; });
      body = wrapper.body;
    } else if (lifted.usesArguments && (prog.strict || kind.strict || !usesArgumentsBeyondSlice(body, prog.paramCount))) {
      // (in sloppy functions a rest parameter would unmap `arguments` from the parameters)
      const n = prog.paramCount;
      const replaceRest = (node, parent, key, idx) => {
        if (!node || typeof node.type !== 'string') return;
        if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property, { name: 'call' }) &&
            t.isMemberExpression(node.callee.object) && t.isIdentifier(node.callee.object.property, { name: 'slice' }) &&
            t.isMemberExpression(node.callee.object.object) && t.isIdentifier(node.callee.object.object.property, { name: 'prototype' }) && t.isIdentifier(node.callee.object.object.object, { name: 'Array' }) &&
            node.arguments.length === 2 && t.isIdentifier(node.arguments[0], { name: 'arguments' }) && t.isNumericLiteral(node.arguments[1], { value: n })) {
          usedRest = true;
          const rep = t.identifier(restName);
          if (idx !== undefined) parent[key][idx] = rep; else parent[key] = rep;
          return;
        }
        for (const k of t.VISITOR_KEYS[node.type] || []) {
          const v = node[k];
          if (Array.isArray(v)) v.forEach((c, i) => replaceRest(c, node, k, i));
          else if (v && typeof v.type === 'string') replaceRest(v, node, k);
        }
      };
      const wrapper = t.blockStatement(body);
      replaceRest(wrapper, null, null);
      body = wrapper.body;
      if (usedRest) params = [...params, t.restElement(t.identifier(restName))];
    }
    // `(a0) => { let [x, y] = a0; ... }`  ->  `([x, y]) => { ... }`
    params = params.slice();
    while (body.length && t.isVariableDeclaration(body[0]) && body[0].declarations.length === 1 && t.isArrayPattern(body[0].declarations[0].id)) {
      const init = body[0].declarations[0].init;
      const pi = params.findIndex((p) => t.isIdentifier(p) && t.isIdentifier(init, { name: p.name }));
      if (pi < 0 || body.slice(1).some((x) => referencesName(x, init.name))) break;
      params[pi] = body[0].declarations[0].id;
      body = body.slice(1);
    }
    const stillUsesArguments = lifted.usesArguments && !opts.argumentsName && referencesName(t.blockStatement(body), 'arguments');
    const strict = kind.strict && !opts.noStrict;
    const block = t.blockStatement(body, strict ? [t.directive(t.directiveLiteral('use strict'))] : []);
    const vmName = kind.kind === 'function' && kind.name && isIdentName(kind.name) ? kind.name : null; // nested function's own name
    const id = prog.name && isIdentName(prog.name) ? t.identifier(prog.name) : prog.selfName ? t.identifier(prog.selfName) : vmName ? t.identifier(vmName) : null;
    if (kind.kind === 'arrow' && !stillUsesArguments) {
      const fn = t.arrowFunctionExpression(params, block, !!kind.async);
      return fn;
    }
    const fn = t.functionExpression(id, params, block, !!kind.generator, !!kind.async);
    if (kind.kind === 'method') fn.__methodKind = true;
    if (kind.kind === 'arrow') fn.__wasArrow = true;
    return fn;
  }
}

module.exports = { Lifter, Frame, isPure, isIdentName, constNode };
