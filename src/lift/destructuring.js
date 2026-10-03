'use strict';
/**
 * Array destructuring, which the compiler lowers to the iterator protocol inside a try block.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { countIdent, referencesName, isUndef } = require('../ast');
const { tryBodyEnd, isBookkeepingStore, fresh } = require('./nodes');

module.exports = {
// -------------------------------------------------------------------------
  // array destructuring:  [a, , b = 1, [c, d]] = src
  //
  //   src GET_ITERATOR; STORE_REG it; PUSH false; STORE_REG done;
  //   TRY_ENTER
  //     per element: PUSH true; STORE done; LOAD it; ITER_NEXT_RESULT; DUP;
  //                  GETPROP "done"; JMPT a; GETPROP "value"; PUSH false; STORE done; JMP b;
  //                  a: DROP; PUSH_UNDEF; b: <store the value into the target>
  //   TRY_POP; <close iterator unless done>; JMP end; catch/finally: close iterator
  // -------------------------------------------------------------------------

  liftArrayDestructure(state, pc, end, inStack, emit) {
    const { instrs, jumps } = state;
    const M = (q) => this.mnemAt(instrs, q);
    const K = state.prog.consts;
    const isStr = (q, v) => K[instrs[q][1]] && K[instrs[q][1]].v === v;
    // header before TRY_ENTER
    const itReg = M(pc - 4) === 'GET_ITERATOR' && M(pc - 3) === 'STORE_REG' ? instrs[pc - 3][1] : null;
    const doneReg = M(pc - 1) === 'STORE_REG' ? instrs[pc - 1][1] : null;
    if (itReg === null || doneReg === null || !state.regIter.has(itReg)) return null;
    const [C, F, E] = state.tries[pc];
    if (E === null) return null;
    // element prologue: PUSH; STORE done; LOAD it; ITER_NEXT_RESULT; DUP; GETPROP "done"; JMPT x
    const elementHead = (q) => M(q) === 'PUSH_CONST' && M(q + 1) === 'STORE_REG' && instrs[q + 1][1] === doneReg && M(q + 2) === 'LOAD_REG' && instrs[q + 2][1] === itReg &&
      M(q + 3) === 'ITER_NEXT_RESULT' && M(q + 4) === 'DUP' && M(q + 5) === 'GETPROP_NAMED' && isStr(q + 5, 'done') && M(q + 6) === 'JMPT';
    // value element: ...; GETPROP "value"; PUSH; STORE done; JMP b; DROP; PUSH_UNDEF; b: <store>
    const valueElement = (q) => elementHead(q) && M(q + 7) === 'GETPROP_NAMED' && isStr(q + 7, 'value') && M(q + 8) === 'PUSH_CONST' && M(q + 9) === 'STORE_REG' &&
      M(q + 10) === 'JMP' && M(q + 11) === 'DROP' && M(q + 12) === 'PUSH_UNDEF' && jumps[q + 6] === q + 11 && jumps[q + 10] === q + 13;
    // hole: ...; PUSH; STORE done; x: DROP
    const holeElement = (q) => elementHead(q) && M(q + 7) === 'PUSH_CONST' && M(q + 8) === 'STORE_REG' && M(q + 9) === 'DROP' && jumps[q + 6] === q + 9;
    let tp = -1;
    for (let q = pc + 1; q < tryBodyEnd(state.tries[pc]); q++) if (M(q) === 'TRY_POP') tp = q;
    if (tp < 0) return null;
    // walk the elements
    const segs = [];
    let q = pc + 1;
    let prefixFrom = null;
    // rest element: PUSH_ARR; STORE a; L: PUSH; STORE done; LOAD it; ITER_NEXT_RESULT; STORE r; LOAD r;
    // GETPROP "done"; JMPT X; ... push(r.value) ...; JMP L; X: LOAD a; <store>
    const restElement = (q2) => {
      if (!(M(q2) === 'PUSH_ARR' && M(q2 + 1) === 'STORE_REG' && M(q2 + 2) === 'PUSH_CONST' && M(q2 + 3) === 'STORE_REG' && instrs[q2 + 3][1] === doneReg &&
            M(q2 + 4) === 'LOAD_REG' && instrs[q2 + 4][1] === itReg && M(q2 + 5) === 'ITER_NEXT_RESULT' && M(q2 + 6) === 'STORE_REG' && M(q2 + 7) === 'LOAD_REG' &&
            M(q2 + 8) === 'GETPROP_NAMED' && isStr(q2 + 8, 'done') && M(q2 + 9) === 'JMPT')) return null;
      const exit = jumps[q2 + 9];
      if (!(exit > q2 + 9 && exit < tp && M(exit - 1) === 'JMP' && jumps[exit - 1] === q2 + 2 && M(exit) === 'LOAD_REG' && instrs[exit][1] === instrs[q2 + 1][1])) return null;
      return { arr: instrs[q2 + 1][1], from: exit + 1 };
    };
    while (q < tp) {
      if (holeElement(q)) { segs.push({ hole: true }); q += 10; prefixFrom = null; continue; }
      const rest = restElement(q);
      if (rest) {
        segs.push({ from: rest.from, to: tp, rest: true, restArr: rest.arr, prefix: prefixFrom !== null ? [prefixFrom, q] : null });
        q = tp;
        break;
      }
      if (!valueElement(q)) {
        // `LOAD x; STORE_REG t` copies of a target object before the element's next(): keep scanning
        if (prefixFrom === null && M(q) !== null && !elementHead(q)) {
          let r = q;
          while (r < tp && !elementHead(r) && !restElement(r)) r++;
          if (r >= tp) return null;
          prefixFrom = q;
          q = r;
          continue;
        }
        return null;
      }
      let nextStart = q + 13;
      while (nextStart < tp && !elementHead(nextStart) && !restElement(nextStart)) nextStart++;
      // copies of the next element's target (`LOAD x; STORE_REG t` pairs right before its
      // next()) belong to that element, not to this one's store
      let storeEnd = nextStart;
      if (nextStart < tp) {
        while (storeEnd - 2 > q + 13 && M(storeEnd - 1) === 'STORE_REG' && /^(LOAD_REG|LOAD_ARG|LOAD_SCOPE|PUSH_CONST|LOAD_LOCAL)$/.test(M(storeEnd - 2))) storeEnd -= 2;
      }
      segs.push({ from: q + 13, to: storeEnd, prefix: prefixFrom !== null ? [prefixFrom, q] : null });
      prefixFrom = storeEnd < nextStart ? storeEnd : null;
      q = nextStart;
    }
    // (no elements: `[] = it` still gets and closes the iterator)
    const src = state.regIter.get(itReg);
    const elements = [];
    let declKind = null;
    let allDecl = true, anyDecl = false;
    const declaredTargets = [];
    const targetTemps = []; // registers folded into element targets, hidden once the pattern is certain
    let carry = []; // statements that prepare the next (rest) element's target
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (seg.hole) { elements.push(null); continue; }
      const elemId = t.identifier(fresh(`__elem${this.tempCounter++}`));
      elemId.__noTemp = true;
      let prefixStmts = [];
      if (seg.prefix) {
        const pre = this.liftRange(state, seg.prefix[0], seg.prefix[1], []);
        if (pre.stack.length) return null;
        prefixStmts = pre.stmts;
      }
      const res = this.liftRange(state, seg.from, seg.to, [elemId]);
      res.stmts = [...carry, ...prefixStmts, ...res.stmts];
      carry = [];
      // drop the done-flag stores, and the bookkeeping of a nested pattern (`[[a, b]] = x`: the
      // inner iterator init is flagged for removal, its done flag is a hidden register)
      const hiddenNames = new Set([...state.hiddenRegs].map((r) => this.regName(state, r)));
      const stmts = res.stmts.filter((x) => !isBookkeepingStore(x, hiddenNames, { literalOnly: true, anyValueFor: this.regName(state, doneReg) }));
      if (res.stack.length) return null;
      if (stmts.length === 0) { elements.push(null); continue; }
      // `[x, ...{}[yield]]`: the code after x's store up to the rest loop computes the rest target
      if (segs[si + 1] && segs[si + 1].rest && stmts.length > 1 && referencesName(stmts[0], elemId.name) && !stmts.slice(1).some((x) => referencesName(x, elemId.name))) carry = stmts.splice(1);
      // `rT = obj; rK = key; obj2[rK] = __elem`  ->  target `obj[key]` (the compiler copies the
      // target object and/or computed key into temporaries before the element's next())
      // (`const rK = yield;` when the key needs a statement of its own)
      const isReg = (name) => this.regOfName(state, name) !== undefined;
      const tempDef = (st) => (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isIdentifier(st.expression.left) && isReg(st.expression.left.name)
        ? { name: st.expression.left.name, value: st.expression.right }
        : t.isVariableDeclaration(st) && st.kind !== 'var' && st.declarations.length === 1 && t.isIdentifier(st.declarations[0].id) && isReg(st.declarations[0].id.name) && st.declarations[0].init
          ? { name: st.declarations[0].id.name, value: st.declarations[0].init } : null);
      while (stmts.length >= 2 && tempDef(stmts[0])) {
        const last = stmts[stmts.length - 1];
        const { name: tmp, value: tmpValue } = tempDef(stmts[0]);
        let tgt = null;
        if (t.isExpressionStatement(last) && t.isAssignmentExpression(last.expression) && t.isMemberExpression(last.expression.left)) tgt = last.expression.left;
        else if (t.isVariableDeclaration(last)) break;
        if (!tgt) break;
        const slots = [];
        if (t.isIdentifier(tgt.object, { name: tmp })) slots.push('object');
        if (tgt.computed && t.isIdentifier(tgt.property, { name: tmp })) slots.push('property');
        if (slots.length !== 1 || countIdent(stmts.slice(1), tmp) !== 1) break;
        tgt[slots[0]] = tmpValue;
        stmts.shift();
        targetTemps.push(this.regOfName(state, tmp));
      }
      if (stmts.length !== 1) return null;
      const st = stmts[0];
      let target = null, value = null;
      if (t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' })) { target = st.expression.left; value = st.expression.right; allDecl = false; }
      else if (t.isVariableDeclaration(st) && st.declarations.length === 1) { target = st.declarations[0].id; value = st.declarations[0].init; anyDecl = true; declKind = declKind === 'let' || st.kind === 'let' ? 'let' : st.kind; declaredTargets.push(target); }
      else return null;
      // `[{ x }]`: the element's object pattern reads the property of the element value
      const objPattern = (v) => (t.isMemberExpression(v) && t.isIdentifier(v.object, { name: elemId.name }) && (!v.computed || t.isStringLiteral(v.property) || t.isNumericLiteral(v.property))
        ? t.objectPattern([t.objectProperty(v.computed ? v.property : t.identifier(v.property.name), target, false, !v.computed && t.isIdentifier(target, { name: v.property.name }))]) : null);
      if (seg.rest) {
        if (t.isIdentifier(value, { name: elemId.name })) elements.push(t.restElement(target));
        else if (objPattern(value)) elements.push(t.restElement(objPattern(value)));
        else return null;
      } else if (t.isIdentifier(value, { name: elemId.name })) elements.push(target);
      else if (objPattern(value)) elements.push(objPattern(value));
      else if (t.isConditionalExpression(value) && t.isBinaryExpression(value.test, { operator: '===' }) && t.isIdentifier(value.test.left, { name: elemId.name }) &&
               isUndef(value.test.right) && t.isIdentifier(value.alternate, { name: elemId.name })) elements.push(t.assignmentPattern(target, value.consequent));
      else return null;
    }
    // (trailing holes stay: `[,] = it` still calls next() once)
    for (const seg of segs) if (seg.restArr !== undefined) state.hiddenRegs.add(seg.restArr);
    for (const r of targetTemps) state.hiddenRegs.add(r);
    state.hiddenRegs.add(itReg);
    state.hiddenRegs.add(doneReg);
    this.dropIterInit(state, itReg);
    const pattern = t.arrayPattern(elements);
    if (anyDecl && allDecl) emit(t.variableDeclaration(declKind || 'let', [t.variableDeclarator(pattern, src)]));
    else if (!anyDecl) emit(t.expressionStatement(t.assignmentExpression('=', pattern, src)));
    else {
      // mixed declarations and assignments: declare first, then assign
      const declNames = [];
      for (const id of declaredTargets) if (t.isIdentifier(id) && !declNames.includes(id.name)) declNames.push(id.name);
      emit(t.variableDeclaration('let', declNames.map((n) => t.variableDeclarator(t.identifier(n)))));
      emit(t.expressionStatement(t.assignmentExpression('=', pattern, src)));
    }
    return { stack: inStack.slice(), next: E };
  }
};
