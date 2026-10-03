'use strict';
/**
 * Instruction semantics: iteration, calls, functions, classes and generators.
 * Handlers of Lifter#step, keyed by mnemonic and called with the lifter as `this`.
 */

const t = require('@babel/types');
const { isIdentName, exprStmts } = require('../../ast');
const { member } = require('../nodes');

const ops = {
  // iteration
  GET_ITERATOR({ push, pop }) { const src = pop(); const n = t.identifier('__iter'); n.__marker = 'iter'; n.__src = src; push(n); },
  GET_ASYNC_ITERATOR({ push, pop }) { const src = pop(); const n = t.identifier('__aiter'); n.__marker = 'iter'; n.__src = src; n.__async = true; push(n); },
  ITER_NEXT_RESULT({ push, pop }) { const it = pop(); push(t.callExpression(t.memberExpression(this.iterExpr(it), t.identifier('next')), [])); },
  ITER_RESULT_DONE({ push, pop }) { push(t.memberExpression(pop(), t.identifier('done'))); },
  ITER_CLOSE({ state, m, stack, emit, pop }) {
    // IteratorClose: the `return` method is optional (array iterators have none)
    const it = pop();
    if (it.__marker === 'iter') return;
    const close = t.expressionStatement(t.optionalCallExpression(t.optionalMemberExpression(it, t.identifier('return'), false, true), [], true));
    this.emitStatement(state, stack, emit, m === 'ITER_CLOSE_SILENT' ? t.tryStatement(t.blockStatement([close]), t.catchClause(null, t.blockStatement([]))) : close);
  },
  ASYNC_ITER_CLOSE({ push, pop }) { pop(); push(t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), [])); },
  FOR_IN_KEYS({ push, pop }) { const obj = pop(); const n = t.identifier('__keys'); n.__marker = 'forInKeys'; n.__src = obj; push(n); },
  // calls
  CALL({ stack, push, pop }) {
    const argc = this.popLit(stack);
    const callee = pop();
    const args = this.popN(stack, argc);
    push(this.callExpr(callee, args, null));
  },
  CALL_METHOD({ m, operand, stack, K, push, pop }) {
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
  },
  CALL_METHOD_REG_CONST({ state, operand, stack, push, keyConst }) {
    const argc = this.popLit(stack);
    const args = this.popN(stack, argc);
    push(t.callExpression(member(this.regId(state, operand & 0xffff), keyConst(operand >>> 16)), args));
  },
  NEW({ stack, push, pop }) {
    const argc = this.popLit(stack);
    const args = this.popN(stack, argc);
    const ctor = pop();
    push(t.newExpression(ctor, args));
  },
  SUPER_CALL({ state, operand, stack, emit, pc, push, pop }) {
    const argc = this.popLit(stack);
    const args = this.popN(stack, argc);
    pop(); // the callee, always `super`
    if (operand === 1) { push(t.arrayExpression(args)); return; }
    // `super(...)` used as a value (`super[super()]`): SUPER_CALL; PUSH_THIS; <not DROP>
    const M = (q) => this.mnemAt(state.instrs, q);
    if (M(pc + 1) === 'PUSH_THIS' && M(pc + 2) !== 'DROP' && state.jumps[pc + 1] === undefined) {
      push(t.callExpression(t.super(), args));
      state.skipPushThis = pc + 1;
      return;
    }
    this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.super(), args)));
  },
  SUPER_GET({ push, pop }) { const key = pop(); pop(); push(member(t.super(), key)); },
  SUPER_SET({ push, pop }) { const v = pop(), key = pop(); pop(); push(t.assignmentExpression('=', member(t.super(), key), v)); },
  // functions & classes
  MAKE_CLOSURE({ state, push, pop }) {
    const desc = pop();
    push(this.makeClosure(state, desc));
  },
  MAKE_CLASS({ state, push, pop }) {
    const name = pop();
    const ctor = pop();
    const cls = t.classExpression(t.isStringLiteral(name) && isIdentName(name.value) ? t.identifier(name.value) : null, null, t.classBody([]));
    cls.__builder = true;
    cls.__stmtsMark = { stmts: state.curStmts, length: state.curStmts ? state.curStmts.length : 0 };
    if (t.isFunctionExpression(ctor)) {
      cls.body.body.push(t.classMethod('constructor', t.identifier('constructor'), ctor.params, ctor.body));
    }
    push(cls);
  },
  CLASS_EXTENDS({ state, stack, emit, pop }) {
    let sup = pop();
    const cls = this.peek(stack);
    // statements emitted while the heritage was evaluated (`extends (f = () => C, B)`) belong
    // into the extends clause: there the class's own name is its inner binding
    const mark = cls && cls.__stmtsMark;
    const exprs = t.isClassExpression(cls) && mark && mark.stmts === state.curStmts && state.curStmts.length > mark.length ? exprStmts(state.curStmts.slice(mark.length)) : null;
    if (exprs) {
      state.curStmts.splice(mark.length);
      sup = t.sequenceExpression([...exprs, sup]);
    }
    if (t.isClassExpression(cls)) cls.superClass = sup;
    else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')), [cls, sup])));
  },
  TEMPLATE({ state, operand, stack, emit, e }) { this.applyTemplate(state, e, operand, stack, emit); },
  CALL_IMM({ operand, stack, K, push, pop }) {
    const argc = K[operand] && K[operand].t === 'number' ? K[operand].v : 0;
    const callee = pop();
    const args = this.popN(stack, argc);
    push(this.callExpr(callee, args, null));
  },
  // generators
  YIELD({ push, pop }) { push(t.yieldExpression(pop())); },
  YIELD_STAR({ push, pop }) { push(t.yieldExpression(pop(), true)); },
  AWAIT({ push, pop }) { push(t.awaitExpression(pop())); },
};

ops.ITER_NEXT_CALL = ops.ITER_NEXT_RESULT;
ops.ITER_CLOSE_SILENT = ops.ITER_CLOSE;
ops.CALL_METHOD_IMM = ops.CALL_METHOD;

module.exports = ops;
