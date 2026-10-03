'use strict';
/**
 * Registers: their names, which ones are compiler temporaries that can be substituted, and
 * parameters that the VM also uses as registers.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { referencesName, containsNode } = require('../ast');
const { NUM_JUMP, templateField, tryBodyEnd, isPseudo, templateRegEffects, UNCOND_JUMP, isPure, fresh } = require('./nodes');

module.exports = {
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
        const f = (x) => templateField(x, operand);
        for (const w of e.writes || []) if (w.target.startsWith('R:')) storedRegs.add(f(w.target.slice(2)));
        const walk = (x) => { if (!x) return; if (x.k === 'leaf' && x.key.startsWith('A:')) argSlots.add(f(x.key.slice(2))); walk(x.a); walk(x.b); };
        [...(e.pushes || []), ...(e.writes || []).map((w) => w.expr), e.cond].forEach(walk);
        for (const w of e.writes || []) if (w.target.startsWith('A:')) argSlots.add(f(w.target.slice(2)));
      }
    }
    state.splitRegs = new Set([...storedRegs].filter((r) => r < state.prog.paramCount && argSlots.has(r)));
  },

regName(state, r) {
    if (r < state.prog.paramCount && !(state.splitRegs && state.splitRegs.has(r))) return state.paramNames[r];
    if (!state.regNames.has(r)) state.regNames.set(r, fresh(`r${r}`));
    return state.regNames.get(r);
  },

  /** the register a lifted name stands for (registers are named `rN` by regName), or undefined */
  regOfName(state, name) {
    for (const [r, n] of state.regNames) if (n === name) return r;
    return undefined;
  },

regId(state, r) {
    state.usedRegs.add(r);
    return t.identifier(this.regName(state, r));
  },

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
    // values below a flushed assignment are evaluated before it: spill those with effects
    const spillBelow = (i) => {
      for (let j = 0; j < i; j++) {
        const u = stack[j];
        // (a literal under construction keeps its node; values in it that read `name` are spilled)
        if (u && u.__builder && (t.isObjectExpression(u) || t.isArrayExpression(u))) { this.spillBuilder(u, emit, new Set([name])); continue; }
        if (!u || isPseudo(u) || t.isFunction(u) || t.isClass(u)) continue;
        if (isPure(u) && !referencesName(u, name)) continue;
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('const', [t.variableDeclarator(id, u)]));
        stack[j] = id;
      }
    };
    const hasTarget = (n) => containsNode(n, isTarget);
    for (let i = 0; i < stack.length; i++) {
      const v = stack[i];
      if (v && typeof v.type === 'string' && !t.isFunction(v) && !t.isClass(v) && hasTarget(v)) {
        spillBelow(i);
        // inside a literal under construction: its earlier entries are evaluated before the assignment
        if (v.__builder && (t.isObjectExpression(v) || t.isArrayExpression(v))) this.spillBuilder(v, emit, new Set([name]));
      }
      if (isTarget(v)) { walk(v.right); flush(v); stack[i] = t.identifier(name); }
      else walk(v);
    }
  },

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
    state.regLoads = loads; // register -> pcs that read it (also through fused and template ops)
    state.firstSuperCall = state.instrs.findIndex(([op]) => this.mnem(op) === 'SUPER_CALL');
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
        const hStart = tryBodyEnd(tr);
        return sps[0] > Number(tp) && sps[0] < hStart && ls.some((l) => l >= hStart);
      });
      if (inTry) continue;
      // the store must run before every load: a jump from before it to a point between the store
      // and a load (a loop exit, a skipped `if` body) leaves the register unset there
      if (ls.length) {
        const maxLoad = Math.max(...ls);
        if (Object.entries(state.jumps).some(([f, to]) => Number(f) < sps[0] && to > sps[0] && to <= maxLoad)) continue;
      }
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
  },

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
  },

  /** is register r written again after the current instruction before it is read (straight line)? */
  storedAgainBeforeRead(state, r) {
    for (let q = state.curPc + 1; q < state.instrs.length; q++) {
      const [op, operand] = state.instrs[q];
      const m = this.mnem(op);
      if (m === 'STORE_REG' && operand === r) return true;
      if ((m === 'LOAD_REG' || /^REG_/.test(m)) && operand === r) return false;
      if (NUM_JUMP.has(m) || UNCOND_JUMP.has(m) || m === 'RETURN' || m === 'THROW' || state.jumps[q] !== undefined) return false;
    }
    return false;
  }
};
