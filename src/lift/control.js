'use strict';
/**
 * Control flow: jumps that become break / continue / labeled blocks, conditionals and
 * short-circuits, switch statements, try / catch / finally.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { gen, countIdentity, replaceIdentity, negate, exprStmts, isUndef } = require('../ast');
const { NUM_JUMP, endsWithJump, isBookkeepingStore, drainImpure, optionalChain, maxStackLeaf, UNCOND_JUMP, constNode, isPure, fresh } = require('./nodes');

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
  },

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
        const e = this.entry(state.instrs[state.condPc][0]);
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
  },

fusedCond(state, pc) {
    const [op, operand] = state.instrs[pc];
    const e = this.entry(op);
    const cond = t.binaryExpression(e.op, this.regId(state, operand & 0xffff), constNode(state.prog.consts[operand >>> 16]));
    return { cond, jumpWhenTrue: e.mnemonic === 'FUSED_JMPT' };
  },

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
    state.condPc = pc;
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
    const fallStack = stack; // condFromJump already applied fallthrough pops

    // jump leaves the region
    if (T > end || T <= pc) {
      state.alive.delete(cond);
      if (info.nullishOf) state.alive.delete(info.nullishOf);
      if (info.keepOnJump) state.alive.delete(info.keepOnJump);
      const js = this.jumpStatement(state, T, end);
      let test = jumpWhenTrue ? cond : negate(cond);
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
      const fallCond = jumpWhenTrue ? negate(cond) : cond; // condition under which fallthrough value is used
      if (info.keepOnJump && b === info.keepOnJump) { // (set only by the KEEP / POP2 jumps)
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
    if (fall.stack.length === other.stack.length && fall.stack.length >= 1 && fall.stack.slice(0, -1).every((v, i) => v === other.stack[i]) &&
        !endsWithJump(fall.stmts) && !endsWithJump(other.stmts)) {
      let a = fall.stack[fall.stack.length - 1], b = other.stack[other.stack.length - 1];
      let fallCond = jumpWhenTrue ? negate(cond) : cond;
      if (shortCircuit && !isPure(cond) && (a === cond || b === cond)) {
        // the short-circuit operand is needed as test and as value: evaluate it once
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('const', [t.variableDeclarator(id, cond)]));
        const rep = (x) => replaceIdentity(x, cond, id);
        a = rep(a); b = rep(b); fallCond = jumpWhenTrue ? negate(t.identifier(id.name)) : t.identifier(id.name);
        fall.stmts = fall.stmts.map(rep); other.stmts = other.stmts.map(rep);
      }
      // bookkeeping stores of an idiom lifted inside a branch (iterator registers of a
      // destructuring) are dropped here, before the branch becomes an expression
      const hidden = new Set([...state.hiddenRegs].map((r) => this.regName(state, r)));
      const isBookkeeping = (x) => isBookkeepingStore(x, hidden);
      fall.stmts = fall.stmts.filter((x) => !isBookkeeping(x));
      other.stmts = other.stmts.filter((x) => !isBookkeeping(x));
      let expr;
      if (exprStmts(fall.stmts) && exprStmts(other.stmts)) {
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
    let test = jumpWhenTrue ? negate(cond) : cond;
    let thenStmts = fall.stmts;
    let elseStmts = other.stmts;
    // leftover values on branch stacks that are not shared -> statements
    const drain = (res, arr) => { for (let i = common; i < res.stack.length; i++) if (!isPure(res.stack[i])) arr.push(t.expressionStatement(res.stack[i])); };
    drain(fall, thenStmts);
    drain(other, elseStmts);
    if (thenStmts.length === 0 && elseStmts.length > 0) {
      test = negate(test);
      [thenStmts, elseStmts] = [elseStmts, thenStmts];
    }
    if (thenStmts.length === 0 && elseStmts.length === 0) {
      if (!isPure(test)) emit(t.expressionStatement(test));
    } else {
      emit(t.ifStatement(test, t.blockStatement(thenStmts), elseStmts.length ? t.blockStatement(elseStmts) : null));
    }
    // resulting stack: prefer the fallthrough path unless it terminated
    let outStack = fall.stack.slice(0, common);
    if (!endsWithJump(fall.stmts) && fall.stack.length === other.stack.length && fall.stack.length > common) {
      // both push the same number of extra values (unusual): keep fallthrough's
      outStack = fall.stack;
    }
    return { stack: outStack, next: mergePc };
  },

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
  },

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
      drainImpure(finRes);
      finalizer = t.blockStatement(finRes.stmts);
    }
    if (!handler && !finalizer) handler = t.catchClause(null, t.blockStatement([]));
    this.spillForStatement(state, stack, emit, null);
    emit(t.tryStatement(t.blockStatement(tryRes.stmts), handler, finalizer));
    for (const c of carried) stack.push(c);
    return { stack, next: regionEnd };
  }
};
