'use strict';
/**
 * Step 4: lift a program's bytecode to a JavaScript AST.
 *
 * The VM is a stack machine whose bytecode is produced by a compiler from
 * structured source, so the control flow is reducible and can be recovered by
 * a recursive region walk over pc ranges:
 *
 *   - a backward jump closes a loop (`while`, `do/while`, `for..of`, `for..in`);
 *   - a forward conditional jump opens an `if`/`else`, a ternary, or a
 *     short-circuit `&&`/`||`/`??` (decided by the stack effect of the branches);
 *   - a chain of tests that jump into a run of consecutive bodies is a `switch`;
 *   - TRY_ENTER together with the program's try table gives `try/catch/finally`.
 *
 * Values are tracked on a symbolic stack of Babel expression nodes; opcodes
 * that produce statements (stores, drops of impure values, returns, ...) append
 * to the current region's statement list. Nested functions are lifted
 * recursively and inlined at their MAKE_CLOSURE site.
 *
 * Stack values carry facts as `__` properties on their nodes. (A node DUP'd onto the stack twice
 * is one object, so a flag set on it holds for both copies.)
 *   __marker       not a value: an iterator ('iter'), for..in keys, scope / super placeholders
 *   __builder      an object, array or class literal still being built (members are added in place)
 *   __underflow    `undefined` produced by popping an empty stack
 *   __dup          duplicated by DUP; a dropped duplicated member read is a compiler artifact
 *   __global       read of a global variable (an unknown one may throw)
 *   __scopeRef     read of a captured (scope) variable
 *   __lexical      `this` of an arrow, read from the enclosing function
 *   __superResult  `this` after super(...) ran: its value, not the check that `this` exists
 *   __inc          `x + 1` / `x - 1` from INC_VALUE / DEC_VALUE: may become `++x` (also for BigInt)
 *   __coercible    checked by DESTRUCTURE_CHECK: dropping it keeps the check as `({} = v)`
 *   __propertyKey  coerced by TO_PROPERTY_KEY: the key of an object destructuring (read in emit.js)
 *   __toString     `String(x)` from TO_STRING: becomes part of a template literal (read in emit.js)
 *   __noTemp, __brandHelper, __staticInit, __templateRaw, __templateCooked, __programRef,
 *   __methodKind, __stmtsMark: bookkeeping of single idioms, see where they are set
 */

const t = require('@babel/types');
const { isUndef } = require('../ast');
const { NUM_JUMP, isBookkeepingStore, UNCOND_JUMP, isPure, fresh, setHostNames, isHostName } = require('./nodes');
const { Frame } = require('./scopes');


class Lifter {
/**
   * @param {object} ctx { table, programsById, nestedIndexToId, log, warn }
   */
  constructor(ctx) {
    this.ctx = ctx;
    setHostNames(ctx.reserved || new Set());
    this.frameCounter = 0;
    this.tempCounter = 0;
    this.active = new Set(); // programs being lifted (recursion guard)
    this.globalVarDecls = new Set();
  }

/** the mnemonic of instruction q of a program (`instrs`), null outside it */
  mnemAt(instrs, q) {
    return q >= 0 && q < instrs.length ? this.mnem(instrs[q][0]) : null;
  }

mnem(op) {
    const e = this.ctx.table.get(op);
    return e ? e.mnemonic : `UNKNOWN_${op}`;
  }

entry(op) {
    return this.ctx.table.get(op) || { mnemonic: `UNKNOWN_${op}` };
  }

/**
   * Lift a program to a function-like description.
   * @returns {{ params: Node[], body: Statement[], usesArguments: boolean, paramCount?: number }}
   */
  liftProgram(prog, opts = {}) {
    const { parentChain = [], paramNames = null, isTopLevel = false } = opts;
    if (this.active.has(prog.id)) {
      this.ctx.warn(`recursive closure reference to program ${prog.id}`);
      return { params: [], body: [t.expressionStatement(t.stringLiteral(`/* recursive program ${prog.id} */`))], usesArguments: false };
    }
    this.active.add(prog.id);
    const fnFrame = new Frame(this.frameCounter++);
    const state = {
      prog,
      instrs: prog.instrs,
      jumps: prog.jumps,
      tries: prog.tries,
      chain: [...parentChain, fnFrame],
      fnFrame,
      paramNames: paramNames || Array.from({ length: prog.paramCount }, (_, i) => fresh(`a${i}`)),
      regNames: new Map(),
      usedRegs: new Set(),
      regIter: new Map(), // reg index -> iterable source expression (for..of bookkeeping)
      regForIn: new Map(), // reg index -> object expression (for..in keys)
      hiddenRegs: new Set(), // registers that only carry for..of/for..in bookkeeping
      usesArguments: false,
      loops: [],
      switchEnds: [],
      blocks: [],
      blockDone: new Set(),
      labelCounter: 0,
      isTopLevel,
      catchCounter: 0,
    };
    state.baseChain = state.chain.slice();
    state.enterFrames = new Map();
    this.computeScopeStacks(state);
    this.computeLoopEnds(state);
    this.computeForLet(state);
    this.computeSlotNames(state);
    this.computeParamSplit(state);
    this.computeTempRegs(state);
    const { stmts, stack } = this.liftRange(state, 0, prog.instrs.length, []);
    for (const v of stack) if (!isPure(v)) stmts.push(t.expressionStatement(v));
    this.removeHiddenRegStores(state, stmts);

    // register declarations
    const regDecls = [];
    const splitInits = [];
    for (const r of [...state.usedRegs].sort((a, b) => a - b)) {
      if (state.hiddenRegs.has(r)) continue;
      if (r < prog.paramCount) {
        if (state.splitRegs.has(r)) splitInits.push(t.variableDeclarator(t.identifier(this.regName(state, r)), t.identifier(state.paramNames[r])));
        continue;
      }
      regDecls.push(this.regName(state, r));
    }
    const body = [];
    if (splitInits.length) body.push(t.variableDeclaration('let', splitInits));
    if (regDecls.length) {
      body.push(t.variableDeclaration('let', regDecls.map((n) => t.variableDeclarator(t.identifier(n)))));
    }
    body.push(...stmts);
    // drop a trailing `return undefined;` / `return;`
    const last = body[body.length - 1];
    if (t.isReturnStatement(last) && (!last.argument || isUndef(last.argument))) body.pop();
    this.active.delete(prog.id);
    return {
      params: state.paramNames.map((n) => t.identifier(n)),
      body,
      usesArguments: state.usesArguments,
      paramCount: prog.paramCount,
    };
  }

dropIterInit(state, reg) {
    const st = state.iterInit && state.iterInit.get(reg);
    if (st) { st.__remove = true; state.iterInit.delete(reg); }
  }

/** Drop `rN = <literal>` statements for registers that only carried loop bookkeeping. */
  removeHiddenRegStores(state, stmts) {
    const names = new Set([...state.hiddenRegs].map((r) => this.regName(state, r)));
    const isHiddenStore = (s) => isBookkeepingStore(s, names);
    const walk = (node) => {
      // nested closures are other programs with their own registers (same names, other variables)
      if (!node || typeof node.type !== 'string' || t.isFunction(node) || t.isClass(node)) return;
      for (const k of t.VISITOR_KEYS[node.type] || []) {
        const v = node[k];
        if (Array.isArray(v)) {
          for (let i = v.length - 1; i >= 0; i--) {
            if (v[i] && isHiddenStore(v[i])) v.splice(i, 1);
            else walk(v[i]);
          }
        } else if (v && typeof v.type === 'string') walk(v);
      }
    };
    for (let i = stmts.length - 1; i >= 0; i--) {
      if (isHiddenStore(stmts[i])) stmts.splice(i, 1);
      else walk(stmts[i]);
    }
  }

/** A readable name that is not yet used in this program (item, item2, ...). */
  freshName(state, base) {
    state.usedNames = state.usedNames || new Set([...state.paramNames]);
    let name = base, i = 1;
    while (state.usedNames.has(name) || isHostName(name)) name = `${base}${++i}`;
    state.usedNames.add(name);
    return name;
  }

// -------------------------------------------------------------------------
  // region walker
  // -------------------------------------------------------------------------

  liftRange(state, start, end, inStack) {
    const stmts = [];
    let stack = inStack.slice();
    const emit = (s) => stmts.push(s);
    let pc = start;

    while (pc < end) {
      const [op, operand] = state.instrs[pc];
      const m = this.mnem(op);
      state.curPc = pc;

      // loop header?
      const loopEnd = state.loopEnds.get(pc);
      // a `break label` out of a loop to a point behind code that follows the loop: the loop and
      // that code form a labeled block
      if (loopEnd !== undefined && loopEnd < end && loopEnd >= pc && !state.blockDone.has(pc)) {
        const esc = this.escapeTarget(state, pc, loopEnd, end);
        if (esc !== null) {
          stack = this.liftLabeledBlock(state, pc, esc, stack, emit);
          pc = esc;
          continue;
        }
      }
      if (loopEnd !== undefined && loopEnd < end && loopEnd >= pc) {
        const r = this.liftLoop(state, pc, loopEnd, stack, emit, stmts);
        stack = r.stack;
        pc = r.next;
        continue;
      }

      if (m === 'TRY_ENTER' && state.tries[pc]) {
        const d = this.liftArrayDestructure(state, pc, end, stack, emit);
        if (d) { stack = d.stack; pc = d.next; continue; }
        const r = this.liftTry(state, pc, end, stack, emit);
        stack = r.stack;
        pc = r.next;
        continue;
      }

      if (NUM_JUMP.has(m)) {
        const sw = m === 'JMPT' ? this.trySwitch(state, pc, end, stack, emit) : null;
        if (sw) { stack = sw.stack; pc = sw.next; continue; }
        // `out: if (..) { .. if (..) { .. } else { break out; } .. }`: a jump from inside a nested
        // branch to a point behind this conditional; the conditional and the code up to that point
        // form a labeled block
        const esc = state.blockDone.has(pc) ? null : this.deepBreakTarget(state, pc, end);
        if (esc !== null) {
          stack = this.liftLabeledBlock(state, pc, esc, stack, emit);
          pc = esc;
          continue;
        }
        const r = this.liftConditional(state, pc, end, stack, emit);
        stack = r.stack;
        pc = r.next;
        continue;
      }

      if (UNCOND_JUMP.has(m)) {
        const tgt = state.jumps[pc];
        const jr = this.jumpStatement(state, tgt, end);
        if (jr === 'end') { pc = this.nextReachable(state, pc + 1, end); continue; }
        if (jr) {
          emit(jr);
          // code between here and the next jump target is unreachable unless jumped into
          pc = this.nextReachable(state, pc + 1, end);
          continue;
        }
        if (tgt > pc && tgt <= end) { pc = tgt; continue; } // skip dead code
        emit(this.comment(`unresolved jump to ${tgt}`));
        pc++;
        continue;
      }

      if (m === 'RETURN') {
        const v = this.pop(stack);
        this.spillForStatement(state, stack, emit, null);
        if (isUndef(v)) emit(t.returnStatement());
        else emit(t.returnStatement(v));
        pc++;
        continue;
      }
      if (m === 'THROW') {
        const v = this.pop(stack);
        emit(t.throwStatement(v));
        pc++;
        continue;
      }
      if (m === 'FOR_OF_NEXT') {
        // loop header should have caught this; treat generically: push next value
        const it = this.regId(state, operand);
        stack.push(t.memberExpression(t.callExpression(t.memberExpression(it, t.identifier('next')), []), t.identifier('value')));
        pc++;
        continue;
      }

      // postfix `r++` used as a value: LOAD_REG r; TO_NUMERIC; DUP; INC_VALUE; STORE_REG r (the
      // old value is ToNumeric(r), which `r++` yields, not r itself)
      if (m === 'TO_NUMERIC' && pc + 3 < end && this.mnem(state.instrs[pc + 1][0]) === 'DUP' && /^(INC|DEC)_VALUE$/.test(this.mnem(state.instrs[pc + 2][0])) &&
          this.mnem(state.instrs[pc + 3][0]) === 'STORE_REG' && pc > 0 && this.mnem(state.instrs[pc - 1][0]) === 'LOAD_REG' && state.instrs[pc - 1][1] === state.instrs[pc + 3][1] &&
          stack.length && t.isIdentifier(stack[stack.length - 1], { name: this.regName(state, state.instrs[pc + 3][1]) }) && !state.tempValues.has(state.instrs[pc + 3][1])) {
        const r = state.instrs[pc + 3][1];
        stack.pop();
        this.spillForStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', this.regId(state, r), t.numericLiteral(0))));
        stack.push(t.updateExpression(this.mnem(state.instrs[pc + 2][0]) === 'INC_VALUE' ? '++' : '--', this.regId(state, r), false));
        pc += 4;
        continue;
      }
      state.curPc = pc;
      state.nextIsDrop = pc + 1 < end && this.mnem(state.instrs[pc + 1][0]) === 'DROP';
      state.curStmts = stmts;
      this.step(state, m, op, operand, stack, emit, pc);
      state.nextIsDrop = false;
      pc++;
    }
    return { stmts, stack };
  }

comment(text) {
    const s = t.emptyStatement();
    t.addComment(s, 'leading', ` ${text} `);
    return s;
  }
}

// the other methods, by topic
Object.assign(Lifter.prototype, require('./registers'),
  require('./scopes').methods,
  require('./stack'),
  require('./control'),
  require('./loops'),
  require('./destructuring'),
  require('./opcodes'));

module.exports = { Lifter, Frame };
