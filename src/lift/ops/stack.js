'use strict';
/**
 * Instruction semantics: stack, literals, registers, arguments and globals.
 * Handlers of Lifter#step, keyed by mnemonic and called with the lifter as `this`.
 */

const t = require('@babel/types');
const { isDroppable } = require('../nodes');

const ops = {
  // RequireObjectCoercible of a destructuring source: a property read of the pattern throws the
  // same way, only an empty pattern (`{} = v`, the value then dropped) needs it spelled out
  DESTRUCTURE_CHECK({ stack }) { const v = this.peek(stack); if (v && typeof v === 'object' && !v.__marker) v.__coercible = true; },
  NOP() {},
  DEBUGGER({ emit }) { emit(t.debuggerStatement()); },
  DECOY_PUSH({ push }) { push(t.identifier('undefined')); },
  PUSH_UNDEF({ push }) { push(t.identifier('undefined')); },
  PUSH_NULL({ push }) { push(t.nullLiteral()); },
  PUSH_OBJ({ push }) { const o = t.objectExpression([]); o.__builder = true; push(o); },
  PUSH_ARR({ push }) { const a = t.arrayExpression([]); a.__builder = true; push(a); },
  PUSH_CONST({ operand, K, push, constAt }) {
    const c = K[operand];
    if (c && c.t === 'program') { const n = t.identifier(`__program_${c.id}`); n.__programRef = c.id; push(n); return; }
    push(constAt(operand));
  },
  PUSH_THIS({ state, m, pc, push }) {
    if (state.skipPushThis === pc) { state.skipPushThis = null; return; } // the value of `super(...)`, already on the stack
    const th = t.thisExpression();
    if (m === 'PUSH_LEXICAL_THIS') th.__lexical = true;
    // after super(...) has run, a `this` is its value (or the initialized `this`), no check
    if (state.firstSuperCall >= 0 && state.firstSuperCall < pc) th.__superResult = true;
    push(th);
  },
  PUSH_NEW_TARGET({ push }) { push(t.metaProperty(t.identifier('new'), t.identifier('target'))); },
  PUSH_ARGUMENTS({ state, push }) { state.usesArguments = true; push(t.identifier('arguments')); },
  PUSH_SCOPE({ push }) { const s = t.identifier('__scope'); s.__marker = 'scope'; push(s); },
  PUSH_SUPER_CTOR({ push }) { const s = t.identifier('__superCtor'); s.__marker = 'superCtor'; push(s); },
  DUP({ stack, push }) { const v = this.peek(stack); if (v && typeof v === 'object') v.__dup = true; push(v); },
  DROP({ state, stack, emit, pop }) {
    if (state.skipNextDrop) { state.skipNextDrop = false; return; }
    const v = pop();
    // in a derived constructor a dropped `this` is the check that `this` is initialized
    // (`super[super()]` reads `this` before calling super)
    // (an arrow's dropped `this` is the source's `this;`, which throws before super() too)
    if (t.isThisExpression(v) && !v.__superResult && (state.prog.derived || v.__lexical) && !stack.includes(v)) { this.emitStatement(state, stack, emit, t.expressionStatement(t.thisExpression())); return; }
    if (v && v.__coercible && !stack.includes(v)) { this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', t.objectPattern([]), v))); return; }
    if (!stack.includes(v) && !(state.alive && state.alive.has(v)) && !isDroppable(v)) this.emitStatement(state, stack, emit, t.expressionStatement(v));
  },
  SWAP({ push, pop }) { const a = pop(), b = pop(); push(a); push(b); },
  ROT_TOP_DOWN({ push, pop }) { const c = pop(), b = pop(), a = pop(); push(c); push(a); push(b); }, // [a,b,c] -> [c,a,b]
  ROT_BOTTOM_UP({ push, pop }) { const c = pop(), b = pop(), a = pop(); push(b); push(c); push(a); }, // [a,b,c] -> [b,c,a]
  ROT3({ e, push, pop }) { const c = pop(), b = pop(), a = pop(); const map = { v0: a, v1: b, v2: c }; for (const k of (e.perm || 'v0,v1,v2').split(',')) push(map[k]); },
  // registers / args
  LOAD_REG({ state, operand, stack, emit, push }) {
    if (state.brandRegs && state.brandRegs.has(operand)) { const b = t.identifier('__brand'); b.__brandHelper = true; push(b); return; }
    if (state.tempValues.has(operand)) { push(t.cloneNode(state.tempValues.get(operand), true)); return; }
    if (state.iterInit && state.iterInit.has(operand)) { push(this.regId(state, operand)); return; }
    if (state.regIter.has(operand)) { const it = state.regIter.get(operand); const n = t.identifier(`__iter${operand}`); n.__marker = 'iter'; n.__src = it; push(n); return; }
    this.flushAssignmentsTo(state, stack, emit, this.regName(state, operand));
    push(this.regId(state, operand));
  },
  STORE_REG({ state, operand, stack, emit, pop }) {
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
    // a class or literal still under construction copied into a register that is stored again
    // (with the finished value) before any read: the early copy is not needed
    if (v.__builder && stack.includes(v) && this.storedAgainBeforeRead(state, operand)) return;
    const tw = state.tempWindow.get(operand);
    const win = tw ? { ...tw, regStoreNames: new Set([...tw.regStores].map((r) => this.regName(state, r))) } : { stores: true, effects: true };
    // a property read (getter, proxy trap) must stay a single read: substitute it only at a single load
    let root = v;
    while (t.isMemberExpression(root)) root = root.object;
    const multi = tw && tw.loads > 1 && !(t.isIdentifier(v) || t.isLiteral(v) || t.isThisExpression(v)) && !(root && root.__global);
    // (a register never read keeps its store when the value can throw or run a getter)
    if (state.tempRegs.has(operand) && !multi && this.isSimpleValue(v, win) && !stack.includes(v) && (!tw || tw.loads || isDroppable(v))) { state.tempValues.set(operand, v); state.hiddenRegs.add(operand); return; }
    this.assign(state, stack, emit, this.regId(state, operand), v);
  },
  REG_INC({ state, operand, stack, emit }) { this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('++', this.regId(state, operand)))); },
  REG_DEC({ state, operand, stack, emit }) { this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('--', this.regId(state, operand)))); },
  REG_PREINC({ state, operand, push }) { push(t.updateExpression('++', this.regId(state, operand), true)); },
  REG_PREDEC({ state, operand, push }) { push(t.updateExpression('--', this.regId(state, operand), true)); },
  LOAD_ARG({ state, operand, stack, emit, push }) { const a = this.argId(state, operand); if (t.isIdentifier(a)) this.flushAssignmentsTo(state, stack, emit, a.name); push(a); },
  STORE_ARG({ state, operand, stack, emit, pop }) { const v = pop(); this.assign(state, stack, emit, this.argId(state, operand), v); },
  // globals
  LOAD_GLOBAL({ operand, K, push }) { const g = this.globalRef(K[operand]); g.__global = true; push(g); },
  TYPEOF_GLOBAL({ operand, K, push }) { push(t.unaryExpression('typeof', this.globalRef(K[operand]))); },
  DELETE_GLOBAL({ operand, push, keyConst }) { push(t.unaryExpression('delete', t.memberExpression(t.identifier('globalThis'), keyConst(operand), true))); },
  STORE_GLOBAL({ m, operand, K, push, pop }) {
    const v = pop();
    // the superclass registered for `super` (read only by the VM): nothing to emit
    if (K[operand] && K[operand].t === 'string' && this.superCtorKeys().has(K[operand].v)) { push(v); return; }
    if (m === 'STORE_GLOBAL_DECL' && K[operand] && K[operand].t === 'string') this.globalVarDecls.add(K[operand].v);
    push(t.assignmentExpression('=', this.globalRef(K[operand]), v));
  },
};

ops.TRY_POP = ops.NOP;
ops.FINALLY_ENTER = ops.NOP;
ops.FINALLY_END = ops.NOP;
ops.PUSH_LEXICAL_THIS = ops.PUSH_THIS;
ops.STORE_GLOBAL_DECL = ops.STORE_GLOBAL;

module.exports = ops;
