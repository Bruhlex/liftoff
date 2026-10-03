'use strict';
/**
 * try / catch / finally from TRY_ENTER and the program's try table.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { drainImpure, UNCOND_JUMP, isPure, fresh } = require('./nodes');

module.exports = {
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
