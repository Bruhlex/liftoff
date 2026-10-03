'use strict';
/**
 * Jumps that become break / continue, labeled blocks for jumps out of nested code, and the
 * dead code after an unconditional jump. (Conditionals, switch and try: conditional.js,
 * switch.js, try.js.)
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { NUM_JUMP, UNCOND_JUMP } = require('./nodes');

module.exports = {
  /** `L: { ... }` for the code up to `esc`, which a jump inside leaves early (`break L`); the
   *  label is dropped when nothing breaks out. Returns the stack after the block. */
  liftLabeledBlock(state, pc, esc, stack, emit) {
    state.blockDone.add(pc);
    const label = `L${++state.labelCounter}`;
    state.blocks.push({ target: esc, label, used: false });
    const inner = this.liftRange(state, pc, esc, stack);
    const blk = state.blocks.pop();
    emit(blk.used ? t.labeledStatement(t.identifier(label), t.blockStatement(inner.stmts)) : t.blockStatement(inner.stmts));
    return inner.stack;
  },

/** first pc at or after `from` that a jump or exception handler can reach (dead code after an
   *  unconditional jump, e.g. `continue\nFOR1;`, is skipped) */
  nextReachable(state, from, end) {
    if (!state.reachTargets) {
      state.reachTargets = new Set(Object.values(state.jumps).map(Number));
      for (const [k, v] of Object.entries(state.tries || {})) { state.reachTargets.add(Number(k)); for (const x of v) if (x !== null) state.reachTargets.add(x); }
    }
    let q = from;
    while (q < end && !state.reachTargets.has(q)) q++;
    return q;
  },

/** pc after a run of EXIT_SCOPE instructions (a `break` may target either end of the run) */
  skipScopeExits(state, pc) {
    while (pc < state.instrs.length && this.mnem(state.instrs[pc][0]) === 'EXIT_SCOPE') pc++;
    return pc;
  },

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
  },

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
      // the target is the end of this conditional or a point behind it (`out: { if (..) {.. break out ..} more; }`);
      // targets inside it belong to nested constructs (switch breaks)
      if (!UNCOND_JUMP.has(this.mnem(instrs[f][0])) || T <= f || T >= end || T < regionEnd || resolved(T)) continue;
      // a break out of an inner loop or try region is structured there
      if ([...state.loopEnds].some(([H, L]) => H > pc && H <= f && f <= L)) continue;
      if (Object.entries(state.tries).some(([tp, tr]) => tr && Number(tp) > pc && Number(tp) < f && (tr[2] === null || tr[2] >= f))) continue;
      // nested: some jump between pc and f lands between f and T (not right behind f, where f is
      // just the jump over a nested `else`)
      if (!list.some(([h, to]) => h < f && to > f + 1 && to < T)) continue;
      if (best === null || T > best) best = T;
    }
    return best;
  },

/** Statement for a jump to `tgt` from inside a region ending at `end`, or null. */
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
  },

labelled(loopRec, stmt) {
    return loopRec.label ? t.labeledStatement(t.identifier(loopRec.label), stmt) : stmt;
  },

firstJumpAt(state, from, to) {
    for (let pc = from; pc < to; pc++) {
      const m = this.mnem(state.instrs[pc][0]);
      if (NUM_JUMP.has(m) || UNCOND_JUMP.has(m) || m === 'RETURN' || m === 'THROW' || m === 'TRY_ENTER' || m === 'FOR_OF_NEXT') return pc;
      if (state.loopEnds.has(pc) && pc !== from) return pc;
    }
    return to;
  }
};
