'use strict';
/**
 * Scope variables: the scope chain at each instruction, frames and their variable names, slots
 * that stay in the TDZ.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { isIdentName } = require('../ast');
const { NUM_JUMP, UNCOND_JUMP, fresh } = require('./nodes');

class Frame {
  constructor(id, opts = {}) {
    this.id = id;
    this.names = new Map(); // slot -> variable name
    this.declared = new Set();
    this.thisSlot = null;
    this.tdzOnly = new Set(); // slots declared but never initialized: every access throws
    this.external = !!opts.external; // host / parent scope: never declare here
  }
  nameOf(slot, prefix) {
    if (this.thisSlot === slot) return null;
    if (!this.names.has(slot)) this.names.set(slot, fresh(`${prefix}${this.id}_${slot}`));
    return this.names.get(slot);
  }
}

module.exports = { Frame, methods: {
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
  },

  /**
   * Slots of a scope that are declared (DECLARE_TDZ) but never initialized in it, such as the
   * copy of `x` in the head of `for (let x of expr)` that `expr` sees: every access throws.
   */
  tdzOnlySlots(state, root) {
    if (!state.tdzScan) {
      // one pass over the program: per scope (aliased copies of a `for (let ...)` scope count as
      // one) the slots declared and the slots stored
      state.tdzScan = new Map();
      const entry = (e) => {
        const r = state.frameAlias && state.frameAlias.has(e) ? state.frameAlias.get(e) : e;
        if (!state.tdzScan.has(r)) state.tdzScan.set(r, { declared: new Set(), stored: new Set(), unknown: false });
        return state.tdzScan.get(r);
      };
      for (let pc = 0; pc < state.instrs.length; pc++) {
        const st = state.scopeStacks && state.scopeStacks[pc];
        if (!st || !st.length) continue;
        const m = this.mnem(state.instrs[pc][0]), operand = state.instrs[pc][1];
        if (m === 'DECLARE_TDZ') entry(st[st.length - 1]).declared.add(operand & 0xffff);
        else if (m === 'STORE_LOCAL' || m === 'STORE_LOCAL_CONST' || m === 'BIND_THIS_SLOT') entry(st[st.length - 1]).stored.add(operand);
        else if (m === 'STORE_SCOPE' && operand >>> 16 === 0) entry(st[st.length - 1]).stored.add(operand & 0xffff);
        else if (m === 'TEMPLATE' || m === 'COND_TEMPLATE') entry(st[st.length - 1]).unknown = true; // (may write slots)
      }
    }
    const e = state.tdzScan.get(root);
    return !e || e.unknown ? new Set() : new Set([...e.declared].filter((sl) => !e.stored.has(sl)));
  },

frameForEnter(state, enterPc) {
    if (state.frameAlias && state.frameAlias.has(enterPc)) enterPc = state.frameAlias.get(enterPc);
    if (!state.enterFrames.has(enterPc)) {
      const f = new Frame(this.frameCounter++);
      f.tdzOnly = this.tdzOnlySlots(state, enterPc);
      state.enterFrames.set(enterPc, f);
    }
    return state.enterFrames.get(enterPc);
  },

  /** Scope chain (outermost first) that is active at the instruction being lifted. */
  chainAt(state) {
    const st = state.scopeStacks && state.scopeStacks[state.curPc];
    if (!st) return state.chain;
    return [...state.baseChain, ...st.map((p) => this.frameForEnter(state, p))];
  },

currentFrame(state) {
    const c = this.chainAt(state);
    return c[c.length - 1];
  },

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
  },

  // -------------------------------------------------------------------------
  // scope variables
  // -------------------------------------------------------------------------

  frameAtQuiet(state, depth) {
    const chain = this.chainAt(state);
    return chain[chain.length - 1 - depth] || null;
  },

frameAt(state, depth) {
    const chain = this.chainAt(state);
    const idx = chain.length - 1 - depth;
    if (idx < 0) {
      state.unknownScope = true; // reported by slotName unless the variable's name can be recovered
      return null;
    }
    return chain[idx];
  },

slotName(state, frame, slot) {
    if (!frame) {
      // A slot in a scope the host did not hand over (e.g. sibling function declarations inside a
      // non-virtualized function). The compiler keeps the variable's name as a string constant for
      // the TDZ error message; if the program has exactly one identifier-like string constant that
      // no instruction refers to, and only one such unknown slot, that is the name.
      const unknown = new Set();
      const savedPc = state.curPc;
      state.instrs.forEach(([op, operand], pc) => {
        if (this.mnem(op) === 'LOAD_SCOPE' || this.mnem(op) === 'STORE_SCOPE') {
          state.curPc = pc;
          if (!this.frameAtQuiet(state, operand >>> 16)) unknown.add(operand);
        }
      });
      state.curPc = savedPc;
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
    if (frame.thisSlot === slot) { const th = t.thisExpression(); th.__lexical = true; return th; } // `this` captured by an arrow
    return t.identifier(frame.nameOf(slot, 's'));
  }
} };
