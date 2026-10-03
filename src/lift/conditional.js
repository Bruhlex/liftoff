'use strict';
/**
 * Conditional jumps: if / else, the ternary operator and the short-circuits `&&`, `||`, `??`,
 * decided by what the two branches leave on the stack.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { countIdentity, replaceIdentity, negate, exprStmts, isUndef } = require('../ast');
const { NUM_JUMP, endsWithJump, isBookkeepingStore, optionalChain, maxStackLeaf, UNCOND_JUMP, constNode, isPure } = require('./nodes');

module.exports = {
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
  }
};
