'use strict';
/**
 * Switch statements: a chain of case tests that jump into a run of consecutive bodies.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { gen } = require('../ast');
const { NUM_JUMP, drainImpure, UNCOND_JUMP } = require('./nodes');

module.exports = {
  // -------------------------------------------------------------------------
  // switch
  // -------------------------------------------------------------------------

  trySwitch(state, pc, end, inStack, emit) {
    // the case tests are probed by lifting them; a failed attempt must leave no trace in the state
    const restore = this.snapshot(state);
    const r = this.trySwitchChain(state, pc, end, inStack, emit);
    if (!r) restore();
    return r;
  },

trySwitchChain(state, pc, end, inStack, emit) {
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
        // probing a region that stores or builds literals would mutate shared nodes (array/object/
        // class builders); calls are fine, case tests are evaluated in order like the chain
        for (let q = p; q < j; q++) {
          const mq = this.mnem(instrs[q][0]);
          if (mq === 'STORE_REG' && state.tempRegs.has(instrs[q][1])) continue; // the callee temp of `f(x)`
          if (/^(STORE_|ARR_|DEFINE_|OBJ_|SET|MAKE_|DELETE|TRY|ENTER_SCOPE|EXIT_SCOPE)/.test(mq)) return null;
        }
        const probe = this.liftRange(state, p, j, stack);
        if (probe.stmts.length || probe.stack.length !== stack.length + 1) return null;
        tests.push({ cond: probe.stack[probe.stack.length - 1], target: jumps[j], pc: j });
        p = j + 1;
        continue;
      }
      if (jm === 'JMP' && j === p) { defaultTarget = jumps[j]; p = j + 1; break; }
      return null;
    }
    // (one case: `JMPT case; JMP default` is how only a switch compiles, an `if` uses JMPF)
    if (!tests.length || defaultTarget === null) return null;
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
    // `break` at the end of the last case jumps to the next instruction; that is the switch end
    // when an earlier case breaks to the same point
    if (swEnd === end) {
      const last = targets[targets.length - 1];
      for (let q = end - 2; q >= last; q--) {
        if (!UNCOND_JUMP.has(this.mnem(instrs[q][0])) || jumps[q] !== q + 1) continue;
        const tg = q + 1;
        if (Object.entries(jumps).some(([f, to]) => to === tg && Number(f) >= bodiesStart && Number(f) < last && UNCOND_JUMP.has(this.mnem(instrs[Number(f)][0])))) swEnd = tg;
        break;
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
      drainImpure(body);
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
};
