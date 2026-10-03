'use strict';
/**
 * Instruction semantics: scopes: entering, TDZ declarations, locals and closure slots.
 * Handlers of Lifter#step, keyed by mnemonic and called with the lifter as `this`.
 */

const t = require('@babel/types');
const { isIdentName, iife } = require('../../ast');
const { fresh } = require('../nodes');

const ops = {
  // scopes
  ENTER_SCOPE({ state, stack, emit, pop }) {
    const parent = pop();
    if (parent.__marker !== 'scope') this.ctx.warn('ENTER_SCOPE without PUSH_SCOPE');
    // frames come from the scope analysis (chainAt); declare the slots hoisted to this scope
    const hs = state.hoistSlots && state.hoistSlots.get(state.curPc);
    if (hs) {
      const frame = this.frameForEnter(state, state.curPc);
      const ids = [];
      for (const sl of hs) if (!frame.declared.has(sl) && frame.thisSlot !== sl) { frame.declared.add(sl); ids.push(this.slotName(state, frame, sl)); }
      if (ids.length) this.emitStatement(state, stack, emit, t.variableDeclaration('let', ids.filter((x) => t.isIdentifier(x)).map((x) => t.variableDeclarator(x))));
    }
  },
  EXIT_SCOPE() {},
  DECLARE_TDZ({ state, operand, stack, emit, K }) {
    const slot = operand & 0xffff;
    const nameIdx = operand >>> 16;
    const frame = this.currentFrame(state);
    // a slot can be re-declared under another name (the compiler reuses slot numbers for
    // TDZ tracking); keep the name it was declared with so every use refers to one binding
    if (nameIdx && K[nameIdx - 1] && K[nameIdx - 1].t === 'string' && isIdentName(K[nameIdx - 1].v) && !frame.declared.has(slot) && !frame.names.has(slot)) frame.names.set(slot, K[nameIdx - 1].v);
    // the declaration itself is emitted at the initializing store (the compiler always emits
    // one at the declaration point, `undefined` for a bare `let x;`), so reads before it keep
    // their TDZ ReferenceError - but only if that store follows in straight-line code;
    // otherwise (a store inside a branch comes first) declare here
    if (!frame.declared.has(slot)) {
      // the first store to the slot in this scope must be reached on every path from here:
      // no jump between the two leaves the interval, none enters it from outside, and the
      // store is not inside a try region that begins in between
      const d0 = state.curPc;
      let q = -1;
      for (let k = d0 + 1; k < state.instrs.length; k++) {
        const mk = this.mnem(state.instrs[k][0]);
        if ((mk === 'STORE_LOCAL' || mk === 'STORE_LOCAL_CONST') && state.instrs[k][1] === slot && state.scopeStacks[k] && state.scopeStacks[d0] &&
            state.scopeStacks[k].join() === state.scopeStacks[d0].join()) { q = k; break; }
      }
      let straight = q > 0;
      if (straight) {
        for (const [f, to] of Object.entries(state.jumps)) {
          const fn = Number(f);
          const inside = fn > d0 && fn < q;
          if (inside && (to > q || to <= d0)) { straight = false; break; }
          if (!inside && to > d0 && to <= q && fn !== q) { straight = false; break; }
        }
        for (const [tp, tr] of Object.entries(state.tries)) {
          const tpn = Number(tp);
          if (tr && tpn > d0 && tpn < q && (tr[2] === null || tr[2] > q)) straight = false;
        }
      }
      if (!straight) {
        frame.declared.add(slot);
        this.emitStatement(state, stack, emit, t.variableDeclaration('let', [t.variableDeclarator(this.slotName(state, frame, slot))]));
      }
    }
  },
  BIND_THIS_SLOT({ state, operand }) { const frame = this.currentFrame(state); frame.thisSlot = operand; },
  BIND_SELF({ state, operand }) {
    const frame = this.currentFrame(state);
    // a named function expression refers to itself through this slot; the name comes from
    // the prologue, else from the closure builder, else a synthetic one
    const p = state.prog;
    const fk = p.fnKind && p.fnKind.name;
    const name = p.name && isIdentName(p.name) ? p.name : fk && isIdentName(fk) ? fk : fresh(`fn${p.id}`);
    if (!p.name) p.selfName = name;
    frame.names.set(operand, name);
    frame.declared.add(operand);
  },
  STORE_LOCAL({ state, m, operand, stack, emit, pop }) {
    if (operand === -2) return;
    if (operand === -1) { this.dropValue(pop(), emit); return; }
    const frame = this.currentFrame(state);
    const v = pop();
    // a class under construction bound to a const slot (the inner class-name binding, or a
    // temporary of the private-member lowering): inside the class body that is the class's
    // own name, so the slot is an alias and the builder keeps collecting members
    if (m === 'STORE_LOCAL_CONST' && v.__builder && t.isClassExpression(v) && v.id && stack.includes(v) && !frame.declared.has(operand) && !frame.external &&
        this.slotName(state, frame, operand).name === v.id.name) {
      frame.declared.add(operand);
      (frame.classAliases || (frame.classAliases = new Set())).add(operand);
      return;
    }
    // the finished class stored again into its own name slot (after static initializers):
    // that slot is the class's inner binding, which the class expression already provides
    if (frame.classAliases && frame.classAliases.has(operand) && t.isClassExpression(v) && v.id &&
        this.slotName(state, frame, operand).name === v.id.name) return;
    const target = this.slotName(state, frame, operand);
    // per-iteration copy of an aliased `for (let ...)` variable: `i = i`
    if (frame.declared.has(operand) && t.isIdentifier(v) && t.isIdentifier(target, { name: v.name })) return;
    // the `this` slot of a derived constructor is set from `super(...)`, which binds `this` itself
    if (t.isThisExpression(target)) { if (!stack.includes(v)) this.dropValue(v, emit); return; }
    if (frame.declared.has(operand) || frame.external) this.assign(state, stack, emit, target, v);
    else {
      frame.declared.add(operand);
      this.assign(state, stack, emit, target, v, m === 'STORE_LOCAL_CONST' ? 'const' : 'let');
    }
  },
  LOAD_SCOPE({ state, operand, stack, emit, push }) {
    const slot = operand & 0xffff, depth = operand >>> 16;
    const frame = this.frameAt(state, depth);
    const n = this.slotName(state, frame, slot);
    // a binding that is never initialized: the read always throws
    if (frame && frame.tdzOnly.has(slot)) {
      const msg = `Cannot access '${t.isIdentifier(n) ? n.name : 'variable'}' before initialization`;
      push(iife([t.throwStatement(t.newExpression(t.identifier('ReferenceError'), [t.stringLiteral(msg)]))]));
      return;
    }
    if (t.isIdentifier(n)) { this.flushAssignmentsTo(state, stack, emit, n.name); n.__scopeRef = true; }
    push(n);
  },
  STORE_SCOPE({ state, operand, stack, emit, pop }) {
    const slot = operand & 0xffff, depth = operand >>> 16;
    const frame = this.frameAt(state, depth);
    const v = pop();
    this.assign(state, stack, emit, this.slotName(state, frame, slot), v);
  },
};

ops.STORE_LOCAL_CONST = ops.STORE_LOCAL;

module.exports = ops;
