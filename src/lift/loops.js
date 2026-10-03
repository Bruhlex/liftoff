'use strict';
/**
 * Loops: while, do-while, for, for..of, for..in, and `for (let ...)` with per-iteration bindings.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { identifiersIn, negate, exprStmts } = require('../ast');
const { NUM_JUMP, takeLoopBinding, updateExpressions, drainImpure, UNCOND_JUMP } = require('./nodes');

module.exports = {
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
    const M = (q) => this.mnemAt(instrs, q);
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
      // the same slots, in any order; each STORE_LOCAL pops the value of the matching LOAD_SCOPE
      const tailSlots = [];
      for (let i = 0; i < k; i++) {
        if (M(T - k + i) !== 'LOAD_SCOPE' || (instrs[T - k + i][1] >>> 16) !== 0) ok = false;
        else tailSlots.push(instrs[T - k + i][1] & 0xffff);
      }
      if (ok && [...tailSlots].sort().join() !== [...slots].sort().join()) ok = false;
      for (let i = 0; i < k && ok; i++) if (M(T + 3 + i) !== 'STORE_LOCAL' || instrs[T + 3 + i][1] !== tailSlots[k - 1 - i]) ok = false;
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
  },

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
  },

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
      const M = (q) => this.mnemAt(instrs, q);
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
        const left = takeLoopBinding(bodyStmts, valueId);
        const loop = t.forOfStatement(left, src, t.blockStatement(bodyStmts), !!isAsync);
        emit(this.labelled(loopRec, loop));
        return { stack, next };
      }
    }

    // ---- for..in idiom ---------------------------------------------------
    // H: LOAD_REG i ; LOAD_REG keys ; GETPROP_NAMED length ; BINOP < ; JMPF exit ; LOAD_REG keys; LOAD_REG i; GETPROP_COMPUTED; DUP; LOAD obj; IN_SAFE; JMPF skip; STORE x; body; skip: DROP; i++ ; JMP H
    {
      const seq = (pcs) => pcs.map((q) => (instrs[q] ? this.mnem(instrs[q][0]) : ''));
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
        const left = takeLoopBinding(bodyStmts, keyId);
        if (process.env.VMDEC_TRACE) console.error(`[trace]   for-in idiom: keys r${keysReg} idx r${idxReg} body ${H + 12 + d}..${skip} exit ${exit} stmts=${bodyStmts.length}`);
        emit(this.labelled(loopRec, t.forInStatement(left, obj, t.blockStatement(bodyStmts))));
        return { stack, next: exit };
      }
    }

    // ---- generic while / do-while --------------------------------------
    const lastM = this.mnem(instrs[L][0]);
    if (NUM_JUMP.has(lastM)) {
      // do { body } while (cond); `continue` jumps to where the condition is computed: a jump
      // target in the loop from which only the condition follows (no statements, one value)
      let condStart = null;
      const targets = [...new Set(Object.entries(jumps).filter(([f, to]) => Number(f) >= H && Number(f) < L && to > H && to <= L && UNCOND_JUMP.has(this.mnem(instrs[Number(f)][0]))).map(([, to]) => to))].sort((a, b) => a - b);
      for (const T of targets) {
        const restore = this.snapshot(state);
        const probe = this.liftRange(state, T, L, []);
        restore();
        if (!probe.stmts.length && probe.stack.length === 1) { condStart = T; break; }
      }
      const loopRec = { header: H, exit: exitDefault, update: condStart, label: null };
      state.loops.push(loopRec);
      const body = this.liftRange(state, H, L, []);
      state.loops.pop();
      const condInfo = this.condFromJump(state, lastM, instrs[L][1], body.stack);
      let test = condInfo.cond;
      if (!condInfo.jumpWhenTrue) test = negate(test);
      // the test is outside the body's block: variables it reads that the body declares at its
      // top level are declared in front of the loop and only assigned inside
      const testNames = identifiersIn(test);
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
      // `const` at the top of a `for (;;)` body) must not survive into the real lift of the body.
      // A `for (let ...)` condition may evaluate expressions before its test (`a.push(f), i < 5`).
      const forLet = state.forLet.has(H);
      const probeCondition = (X, oneValue) => {
        const restore = this.snapshot(state);
        const probe = this.liftRange(state, H, X, []);
        restore({ declaredOnly: true });
        const pre = exprStmts(probe.stmts);
        if ((probe.stmts.length && !(forLet && pre)) || (oneValue && probe.stack.length !== 1)) return null;
        const info = this.condFromJump(state, this.mnem(instrs[X][0]), instrs[X][1], probe.stack);
        if (probe.stmts.length) info.pre = pre;
        condEnd = X;
        return info;
      };
      const jpc = this.firstJumpAt(state, H, L);
      if (jpc < L && NUM_JUMP.has(this.mnem(instrs[jpc][0])) && jumps[jpc] > L) condInfo = probeCondition(jpc, false);
      // a `for (let ...)` condition with a short-circuit (`run && (x = 1, f)`): up to the jump
      // that leaves the loop, provided all jumps before it stay inside the condition
      if (!condInfo && forLet) {
        let X = -1;
        for (let q = H; q < L; q++) if (NUM_JUMP.has(this.mnem(instrs[q][0])) && jumps[q] > L) { X = q; break; }
        if (X > H && Object.entries(jumps).every(([f, to]) => Number(f) < H || Number(f) >= X || (to > Number(f) && to <= X))) condInfo = probeCondition(X, true);
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
      drainImpure(body);
      const upd = this.liftRange(state, fl.updateStart, L, []);
      const updExprs = updateExpressions(upd);
      let test = condInfo.cond;
      if (condInfo.jumpWhenTrue) test = negate(test);
      if (condInfo.pre) test = t.sequenceExpression([...condInfo.pre, test]);
      if (updExprs.every(Boolean)) {
        // the declaration of the loop variables right before the loop becomes the init
        const frame = this.frameForEnter(state, fl.enterA !== null ? fl.enterA : H - 1 - fl.slots.length);
        const names = new Set(fl.slots.map((sl) => this.slotName(state, frame, sl)).filter((n) => t.isIdentifier(n)).map((n) => n.name));
        const inits = [];
        // registers declared among them (`for (let i = 0, f = () => i; ...)`) join the init when
        // nothing reads them after the loop
        const readAfter = (r) => (state.regLoads.get(r) || []).some((q) => q > L);
        const unreadRegister = (name) => { const r = this.regOfName(state, name); return r !== undefined && !readAfter(r); };
        const joins = (d) => t.isIdentifier(d.id) && (names.has(d.id.name) || unreadRegister(d.id.name));
        let slotInits = 0;
        while (outStmts.length) {
          const last = outStmts[outStmts.length - 1];
          if (t.isVariableDeclaration(last) && last.kind !== 'var' && last.declarations.every(joins)) {
            inits.unshift(...last.declarations);
            slotInits += last.declarations.filter((d) => names.has(d.id.name)).length;
            outStmts.pop();
          } else if (t.isExpressionStatement(last) && t.isAssignmentExpression(last.expression, { operator: '=' }) && t.isIdentifier(last.expression.left) &&
                     unreadRegister(last.expression.left.name)) {
            // `r = v` of a register declared further up: the declaration there becomes unused
            inits.unshift(t.variableDeclarator(t.identifier(last.expression.left.name), last.expression.right));
            outStmts.pop();
          } else break;
        }
        if (slotInits === names.size) {
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
    // a condition with statements before its test is only taken apart for `for (let ...)`
    if (condInfo && condInfo.pre) { condInfo = null; condEnd = -1; }
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
        const updExprs = updateExpressions(upd);
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
      drainImpure(tail);
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
      if (condInfo.jumpWhenTrue) test = negate(test);
      // a value still pending at U: U is the join of a conditional expression
      // (`x = c ? a : b; i++`), not the start of an update clause; the tail continues the body
      if (body.stack.length) {
        state.loops.push(loopRec);
        const tail = this.liftRange(state, U, L, body.stack);
        state.loops.pop();
        drainImpure(tail);
        emit(this.labelled(loopRec, t.whileStatement(test, t.blockStatement([...body.stmts, ...tail.stmts]))));
        return { stack, next: Math.max(exit, L + 1) };
      }
      const upd = this.liftRange(state, U, L, []);
      const updExprs = updateExpressions(upd);
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
      if (condInfo.jumpWhenTrue) test = negate(test);
      drainImpure(body);
      emit(this.labelled(loopRec, t.whileStatement(test, t.blockStatement(body.stmts))));
      return { stack, next: Math.max(exit, L + 1) };
    }
    state.loops.push(loopRec);
    const body = this.liftRange(state, H, L, []);
    state.loops.pop();
    drainImpure(body);
    emit(this.labelled(loopRec, t.whileStatement(t.booleanLiteral(true), t.blockStatement(body.stmts))));
    return { stack, next: exitDefault };
  },

stripFlagStores(stmts, flagRegs, state) {
    const names = new Set(flagRegs.map((r) => this.regName(state, r)));
    return stmts.filter((s) => !(t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression) && t.isIdentifier(s.expression.left) && names.has(s.expression.left.name) && t.isBooleanLiteral(s.expression.right)));
  }
};
