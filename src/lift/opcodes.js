'use strict';
/**
 * The semantics of single instructions (`step`), templates of behaviourally inferred opcodes,
 * calls, property definitions, closures and the functions they become.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { gen, sameExpr, isIdentName, referencesName, iife, thunkValue, exprStmts, PRIVATE_ERROR, replaceWhere, isArgumentsSlice, hasOwnArguments, isUndef } = require('../ast');
const { templateField, constNode, member, optMember, propKey, isDroppable, isKeyHelper, usesArgumentsBeyondSlice, fresh } = require('./nodes');

module.exports = {
/** names under which the VM keeps the superclass of a class for `super(...)`: the keys read
   *  right after PUSH_SUPER_CTOR in any program */
  superCtorKeys() {
    if (!this._superCtorKeys) {
      this._superCtorKeys = new Set();
      for (const prog of this.ctx.programsById.values()) {
        prog.instrs.forEach(([op], q) => {
          if (this.mnem(op) !== 'PUSH_SUPER_CTOR' || this.mnemAt(prog.instrs, q + 1) !== 'GETPROP_NAMED') return;
          const c = prog.consts[prog.instrs[q + 1][1]];
          if (c && c.t === 'string') this._superCtorKeys.add(c.v);
        });
      }
    }
    return this._superCtorKeys;
  },

// -------------------------------------------------------------------------
  // straight-line opcode semantics
  // -------------------------------------------------------------------------

  step(state, m, op, operand, stack, emit, pc) {
    const K = state.prog.consts;
    const e = this.entry(op);
    const push = (v) => stack.push(v);
    const pop = () => this.pop(stack);
    const constAt = (i) => constNode(K[i]);
    const keyConst = (i) => (K[i] ? constNode(K[i]) : t.stringLiteral(`__k${i}`));

    switch (m) {
      // RequireObjectCoercible of a destructuring source: a property read of the pattern throws the
      // same way, only an empty pattern (`{} = v`, the value then dropped) needs it spelled out
      case 'DESTRUCTURE_CHECK': { const v = this.peek(stack); if (v && typeof v === 'object' && !v.__marker) v.__coercible = true; return; }
      case 'NOP': case 'TRY_POP': case 'FINALLY_ENTER': case 'FINALLY_END':
        return;
      case 'DEBUGGER': emit(t.debuggerStatement()); return;
      case 'DECOY_PUSH': push(t.identifier('undefined')); return;
      case 'PUSH_UNDEF': push(t.identifier('undefined')); return;
      case 'PUSH_NULL': push(t.nullLiteral()); return;
      case 'PUSH_OBJ': { const o = t.objectExpression([]); o.__builder = true; push(o); return; }
      case 'PUSH_ARR': { const a = t.arrayExpression([]); a.__builder = true; push(a); return; }
      case 'PUSH_CONST': {
        const c = K[operand];
        if (c && c.t === 'program') { const n = t.identifier(`__program_${c.id}`); n.__programRef = c.id; push(n); return; }
        push(constAt(operand)); return;
      }
      case 'PUSH_THIS': case 'PUSH_LEXICAL_THIS':
        if (state.skipPushThis === pc) { state.skipPushThis = null; return; } // the value of `super(...)`, already on the stack
        {
          const th = t.thisExpression();
          if (m === 'PUSH_LEXICAL_THIS') th.__lexical = true;
          // after super(...) has run, a `this` is its value (or the initialized `this`), no check
          if (state.firstSuperCall >= 0 && state.firstSuperCall < pc) th.__superResult = true;
          push(th);
        }
        return;
      case 'PUSH_NEW_TARGET': push(t.metaProperty(t.identifier('new'), t.identifier('target'))); return;
      case 'PUSH_ARGUMENTS': state.usesArguments = true; push(t.identifier('arguments')); return;
      case 'PUSH_SCOPE': { const s = t.identifier('__scope'); s.__marker = 'scope'; push(s); return; }
      case 'PUSH_SUPER_CTOR': { const s = t.identifier('__superCtor'); s.__marker = 'superCtor'; push(s); return; }

      case 'DUP': { const v = this.peek(stack); if (v && typeof v === 'object') v.__dup = true; push(v); return; }
      case 'DROP': {
        if (state.skipNextDrop) { state.skipNextDrop = false; return; }
        const v = pop();
        // in a derived constructor a dropped `this` is the check that `this` is initialized
        // (`super[super()]` reads `this` before calling super)
        // (an arrow's dropped `this` is the source's `this;`, which throws before super() too)
        if (t.isThisExpression(v) && !v.__superResult && (state.prog.derived || v.__lexical) && !stack.includes(v)) { this.emitStatement(state, stack, emit, t.expressionStatement(t.thisExpression())); return; }
        if (v && v.__coercible && !stack.includes(v)) { this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', t.objectPattern([]), v))); return; }
        if (!stack.includes(v) && !(state.alive && state.alive.has(v)) && !isDroppable(v)) this.emitStatement(state, stack, emit, t.expressionStatement(v));
        return;
      }
      case 'SWAP': { const a = pop(), b = pop(); push(a); push(b); return; }
      case 'ROT_TOP_DOWN': { const c = pop(), b = pop(), a = pop(); push(c); push(a); push(b); return; } // [a,b,c] -> [c,a,b]
      case 'ROT_BOTTOM_UP': { const c = pop(), b = pop(), a = pop(); push(b); push(c); push(a); return; } // [a,b,c] -> [b,c,a]
      case 'ROT3': { const c = pop(), b = pop(), a = pop(); const map = { v0: a, v1: b, v2: c }; for (const k of (e.perm || 'v0,v1,v2').split(',')) push(map[k]); return; }

      // registers / args
      case 'LOAD_REG': {
        if (state.brandRegs && state.brandRegs.has(operand)) { const b = t.identifier('__brand'); b.__brandHelper = true; push(b); return; }
        if (state.tempValues.has(operand)) { push(t.cloneNode(state.tempValues.get(operand), true)); return; }
        if (state.iterInit && state.iterInit.has(operand)) { push(this.regId(state, operand)); return; }
        if (state.regIter.has(operand)) { const it = state.regIter.get(operand); const n = t.identifier(`__iter${operand}`); n.__marker = 'iter'; n.__src = it; push(n); return; }
        this.flushAssignmentsTo(state, stack, emit, this.regName(state, operand));
        push(this.regId(state, operand)); return;
      }
      case 'STORE_REG': {
        const v = pop();
        if (v.__marker === 'iter') {
          state.regIter.set(operand, v.__src);
          if (v.__async) (state.regIterAsync || (state.regIterAsync = new Set())).add(operand);
          // materialize the iterator once; the for..of / destructuring idioms drop this statement again
          const init = t.expressionStatement(t.assignmentExpression('=', this.regId(state, operand),
            t.callExpression(t.memberExpression(v.__src, t.memberExpression(t.identifier('Symbol'), t.identifier(v.__async ? 'asyncIterator' : 'iterator')), true), [])));
          (state.iterInit || (state.iterInit = new Map())).set(operand, init);
          this.emitStatement(state, stack, emit, init);
          // emitting may have moved the source (a call shared with the stack) into a temporary:
          // the for..of / destructuring idioms must use that temporary, not evaluate the call again
          state.regIter.set(operand, init.expression.right.callee.object);
          return;
        }
        if (v.__marker === 'forInKeys') { state.regForIn.set(operand, v.__src); state.hiddenRegs.add(operand); return; }
        if (v.__brandHelper) { (state.brandRegs || (state.brandRegs = new Set())).add(operand); state.hiddenRegs.add(operand); return; }
        // a class or literal still under construction copied into a register that is stored again
        // (with the finished value) before any read: the early copy is not needed
        if (v.__builder && stack.includes(v) && this.storedAgainBeforeRead(state, operand)) return;
        const tw = state.tempWindow.get(operand);
        const win = tw ? { ...tw, regStoreNames: new Set([...tw.regStores].map((r) => this.regName(state, r))) } : { stores: true, effects: true };
        // a property read (getter, proxy trap) must stay a single read: substitute it only at a single load
        let root = v;
        while (t.isMemberExpression(root)) root = root.object;
        const multi = tw && tw.loads > 1 && !(t.isIdentifier(v) || t.isLiteral(v) || t.isThisExpression(v)) && !(root && root.__global);
        // (a register never read keeps its store when the value can throw or run a getter)
        if (state.tempRegs.has(operand) && !multi && this.isSimpleValue(v, win) && !stack.includes(v) && (!tw || tw.loads || isDroppable(v))) { state.tempValues.set(operand, v); state.hiddenRegs.add(operand); return; }
        this.assign(state, stack, emit, this.regId(state, operand), v);
        return;
      }
      case 'REG_INC': this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('++', this.regId(state, operand)))); return;
      case 'REG_DEC': this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('--', this.regId(state, operand)))); return;
      case 'REG_PREINC': push(t.updateExpression('++', this.regId(state, operand), true)); return;
      case 'REG_PREDEC': push(t.updateExpression('--', this.regId(state, operand), true)); return;
      case 'LOAD_ARG': { const a = this.argId(state, operand); if (t.isIdentifier(a)) this.flushAssignmentsTo(state, stack, emit, a.name); push(a); return; }
      case 'STORE_ARG': { const v = pop(); this.assign(state, stack, emit, this.argId(state, operand), v); return; }

      // globals
      case 'LOAD_GLOBAL': { const g = this.globalRef(K[operand]); g.__global = true; push(g); return; }
      case 'TYPEOF_GLOBAL': push(t.unaryExpression('typeof', this.globalRef(K[operand]))); return;
      case 'DELETE_GLOBAL': push(t.unaryExpression('delete', t.memberExpression(t.identifier('globalThis'), keyConst(operand), true))); return;
      case 'STORE_GLOBAL': case 'STORE_GLOBAL_DECL': {
        const v = pop();
        // the superclass registered for `super` (read only by the VM): nothing to emit
        if (K[operand] && K[operand].t === 'string' && this.superCtorKeys().has(K[operand].v)) { push(v); return; }
        if (m === 'STORE_GLOBAL_DECL' && K[operand] && K[operand].t === 'string') this.globalVarDecls.add(K[operand].v);
        push(t.assignmentExpression('=', this.globalRef(K[operand]), v));
        return;
      }

      // scopes
      case 'ENTER_SCOPE': {
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
        return;
      }
      case 'EXIT_SCOPE': return;
      case 'DECLARE_TDZ': {
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
        return;
      }
      case 'BIND_THIS_SLOT': { const frame = this.currentFrame(state); frame.thisSlot = operand; return; }
      case 'BIND_SELF': {
        const frame = this.currentFrame(state);
        // a named function expression refers to itself through this slot; the name comes from
        // the prologue, else from the closure builder, else a synthetic one
        const p = state.prog;
        const fk = p.fnKind && p.fnKind.name;
        const name = p.name && isIdentName(p.name) ? p.name : fk && isIdentName(fk) ? fk : fresh(`fn${p.id}`);
        if (!p.name) p.selfName = name;
        frame.names.set(operand, name);
        frame.declared.add(operand);
        return;
      }
      case 'STORE_LOCAL': case 'STORE_LOCAL_CONST': {
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
        return;
      }
      case 'LOAD_SCOPE': {
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
        return;
      }
      case 'STORE_SCOPE': {
        const slot = operand & 0xffff, depth = operand >>> 16;
        const frame = this.frameAt(state, depth);
        const v = pop();
        this.assign(state, stack, emit, this.slotName(state, frame, slot), v);
        return;
      }

      // arithmetic
      case 'BINOP': { const b = pop(), a = pop(); push(this.binary(e.op, a, b)); return; }
      case 'BINOP_MEGA': {
        const sel = (operand ^ e.mask) >>> 0;
        const l = e.ladder[sel];
        const b = pop(), a = pop();
        if (!l) { this.ctx.warn(`unknown BINOP selector ${sel}`); push(t.callExpression(t.identifier('__binop'), [t.numericLiteral(sel), a, b])); return; }
        push(l.swapped ? this.binary(l.op, b, a) : this.binary(l.op, a, b));
        return;
      }
      case 'FUSED_BINOP': push(this.binary(e.op, this.regId(state, operand & 0xffff), constAt(operand >>> 16))); return;
      case 'UNARY': push(t.unaryExpression(e.op, pop())); return;
      case 'VOID': push(t.unaryExpression('void', pop())); return;
      case 'TO_NUMERIC': return; // a coercion: identity for source recovery
      // the key of an object destructuring, coerced before the target is evaluated: marked, so
      // that the emitter can put the destructuring back together
      case 'TO_PROPERTY_KEY': { const v = this.peek(stack); if (v && typeof v === 'object') v.__propertyKey = true; return; }
      // (tagged: only an increment is an update `++x`, which also works on BigInts; `x + 1` does not)
      case 'INC_VALUE': { const b = t.binaryExpression('+', pop(), t.numericLiteral(1)); b.__inc = true; push(b); return; }
      case 'DEC_VALUE': { const b = t.binaryExpression('-', pop(), t.numericLiteral(1)); b.__inc = true; push(b); return; }
      case 'TO_STRING': { const v = pop(); if (t.isStringLiteral(v)) { push(v); return; } const c = t.callExpression(t.identifier('String'), [v]); c.__toString = true; push(c); return; }

      // property access
      case 'GETPROP_NAMED': {
        const obj = pop();
        if (obj.__marker === 'superCtor') { push(t.super()); return; }
        push(member(obj, keyConst(operand))); return;
      }
      case 'GETPROP_NAMED_KEEP': { const obj = this.peek(stack); push(member(obj, keyConst(operand))); return; }
      case 'GETPROP_COMPUTED': { const key = pop(), obj = pop(); push(member(obj, key)); return; }
      case 'GETPROP_REG_CONST': push(member(this.regId(state, operand & 0xffff), keyConst(operand >>> 16))); return;
      case 'GET_THIS_PROP': push(member(t.thisExpression(), keyConst(operand))); return;
      case 'OPT_GETPROP_NAMED': push(optMember(pop(), keyConst(operand))); return;
      case 'OPT_GETPROP_COMPUTED': { const key = pop(), obj = pop(); push(optMember(obj, key)); return; }
      case 'SETPROP_NAMED': { const v = pop(), obj = pop(); this.pushStore(state, stack, t.assignmentExpression('=', member(obj, keyConst(operand)), v)); return; }
      case 'SETPROP_COMPUTED': { const v = pop(), key = pop(), obj = pop(); this.pushStore(state, stack, t.assignmentExpression('=', member(obj, key), v)); return; }
      case 'DELETE_PROP': {
        if (operand >= 0) { const obj = pop(); push(t.unaryExpression('delete', member(obj, keyConst(operand)))); }
        else { const key = pop(), obj = pop(); push(t.unaryExpression('delete', member(obj, key))); }
        return;
      }
      case 'IN_SAFE': { const obj = pop(), key = pop(); push(t.binaryExpression('in', key, obj)); return; }

      // literals / object building
      case 'DEFINE_PROP_NAMED': { const v = pop(), obj = pop(); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: true }); return; }
      case 'DEFINE_PROP_COMPUTED': { const v = pop(), key = pop(), obj = pop(); this.defineProp(state, stack, emit, obj, key, v, { enumerable: true }); return; }
      case 'DEFINE_METHOD_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: false, isStatic: true }); return; }
      case 'DEFINE_METHOD_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { enumerable: false, isStatic: true }); return; }
      case 'DEFINE_PROTO_METHOD_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: false, proto: true }); return; }
      case 'DEFINE_PROTO_METHOD_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { enumerable: false, proto: true }); return; }
      case 'DEFINE_GETTER_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { accessor: 'get', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'DEFINE_SETTER_NAMED': { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { accessor: 'set', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'DEFINE_GETTER_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { accessor: 'get', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'DEFINE_SETTER_COMPUTED': { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { accessor: 'set', proto: e.protoTarget, isStatic: !e.protoTarget }); return; }
      case 'SET_PROTO': {
        const proto = pop(), obj = this.peek(stack);
        if (obj.__builder && t.isObjectExpression(obj)) obj.properties.push(t.objectProperty(t.identifier('__proto__'), proto));
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')), [obj, proto])));
        return;
      }
      case 'OBJ_SPREAD': {
        const src = pop(), obj = this.peek(stack);
        if (obj.__builder && t.isObjectExpression(obj)) obj.properties.push(t.spreadElement(src));
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), [obj, src])));
        return;
      }
      case 'OBJ_REST': {
        const excluded = pop(), src = pop();
        // (({k1, k2, ...rest}) => rest)(src)
        const props = [];
        if (t.isArrayExpression(excluded)) {
          excluded.elements.forEach((k, i) => {
            const pk = propKey(k);
            props.push(t.objectProperty(pk.key, t.identifier(`_x${i}`), pk.computed));
          });
        }
        props.push(t.restElement(t.identifier('rest')));
        push(t.callExpression(t.arrowFunctionExpression([t.objectPattern(props)], t.identifier('rest')), [src]));
        return;
      }
      case 'ARR_PUSH': {
        const v = pop(), arr = this.peek(stack);
        if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(v);
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(arr, t.identifier('push')), [v])));
        return;
      }
      case 'ARR_SPREAD': {
        const v = pop(), arr = this.peek(stack);
        if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(t.spreadElement(v));
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(arr, t.identifier('push')), [t.spreadElement(v)])));
        return;
      }
      case 'ARR_HOLE': {
        const arr = this.peek(stack);
        if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(null);
        else this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('++', t.memberExpression(arr, t.identifier('length')))));
        return;
      }
      case 'SPREAD_MARK': push(t.spreadElement(pop())); return;
      case 'TEMPLATE_OBJECT': {
        const n = this.popLit(stack);
        const raw = this.popN(stack, n);
        const cooked = this.popN(stack, n);
        // outside a reconstructible tag call the object must still be a frozen strings array with
        // `.raw`: an identity tag applied to the same raw text yields exactly that
        let obj;
        if (raw.every((r) => t.isStringLiteral(r)) && raw.length) {
          const quasis = raw.map((r, i) => t.templateElement({ raw: r.value }, i === raw.length - 1));
          obj = t.taggedTemplateExpression(t.arrowFunctionExpression([t.identifier('s')], t.identifier('s')), t.templateLiteral(quasis, raw.slice(1).map(() => t.numericLiteral(0))));
        } else obj = t.arrayExpression(cooked);
        obj.__templateRaw = raw;
        obj.__templateCooked = cooked;
        push(obj);
        return;
      }
      case 'NEW_REGEXP': {
        const src = K[operand & 0xffff], flags = K[operand >>> 16];
        push(t.regExpLiteral(src && src.t === 'string' ? src.v : '', flags && flags.t === 'string' ? flags.v : ''));
        return;
      }
      case 'SYMBOL': push(t.callExpression(t.identifier('Symbol'), operand === -1 ? [] : [pop()])); return;
      case 'SYMBOL_FOR': push(t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('for')), [constAt(operand)])); return;
      case 'SYMBOL_KEYFOR': push(t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('keyFor')), [pop()])); return;
      case 'DYNAMIC_IMPORT': push(t.callExpression(t.import(), [pop()])); return;

      // iteration
      case 'GET_ITERATOR': { const src = pop(); const n = t.identifier('__iter'); n.__marker = 'iter'; n.__src = src; push(n); return; }
      case 'GET_ASYNC_ITERATOR': { const src = pop(); const n = t.identifier('__aiter'); n.__marker = 'iter'; n.__src = src; n.__async = true; push(n); return; }
      case 'ITER_NEXT_RESULT': case 'ITER_NEXT_CALL': { const it = pop(); push(t.callExpression(t.memberExpression(this.iterExpr(it), t.identifier('next')), [])); return; }
      case 'ITER_RESULT_DONE': push(t.memberExpression(pop(), t.identifier('done'))); return;
      case 'ITER_CLOSE': case 'ITER_CLOSE_SILENT': {
        // IteratorClose: the `return` method is optional (array iterators have none)
        const it = pop();
        if (it.__marker === 'iter') return;
        const close = t.expressionStatement(t.optionalCallExpression(t.optionalMemberExpression(it, t.identifier('return'), false, true), [], true));
        this.emitStatement(state, stack, emit, m === 'ITER_CLOSE_SILENT' ? t.tryStatement(t.blockStatement([close]), t.catchClause(null, t.blockStatement([]))) : close);
        return;
      }
      case 'ASYNC_ITER_CLOSE': { pop(); push(t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), [])); return; }
      case 'FOR_IN_KEYS': { const obj = pop(); const n = t.identifier('__keys'); n.__marker = 'forInKeys'; n.__src = obj; push(n); return; }

      // calls
      case 'CALL': {
        const argc = this.popLit(stack);
        const callee = pop();
        const args = this.popN(stack, argc);
        push(this.callExpr(callee, args, null));
        return;
      }
      case 'CALL_METHOD': case 'CALL_METHOD_IMM': {
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
        return;
      }
      case 'CALL_METHOD_REG_CONST': {
        const argc = this.popLit(stack);
        const args = this.popN(stack, argc);
        push(t.callExpression(member(this.regId(state, operand & 0xffff), keyConst(operand >>> 16)), args));
        return;
      }
      case 'NEW': {
        const argc = this.popLit(stack);
        const args = this.popN(stack, argc);
        const ctor = pop();
        push(t.newExpression(ctor, args));
        return;
      }
      case 'SUPER_CALL': {
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
        return;
      }
      case 'SUPER_GET': { const key = pop(); pop(); push(member(t.super(), key)); return; }
      case 'SUPER_SET': { const v = pop(), key = pop(); pop(); push(t.assignmentExpression('=', member(t.super(), key), v)); return; }

      // functions & classes
      case 'MAKE_CLOSURE': {
        const desc = pop();
        push(this.makeClosure(state, desc));
        return;
      }
      case 'MAKE_CLASS': {
        const name = pop();
        const ctor = pop();
        const cls = t.classExpression(t.isStringLiteral(name) && isIdentName(name.value) ? t.identifier(name.value) : null, null, t.classBody([]));
        cls.__builder = true;
        cls.__stmtsMark = { stmts: state.curStmts, length: state.curStmts ? state.curStmts.length : 0 };
        if (t.isFunctionExpression(ctor)) {
          cls.body.body.push(t.classMethod('constructor', t.identifier('constructor'), ctor.params, ctor.body));
        }
        push(cls);
        return;
      }
      case 'CLASS_EXTENDS': {
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
        return;
      }

      case 'TEMPLATE': this.applyTemplate(state, e, operand, stack, emit); return;
      case 'CALL_IMM': {
        const argc = K[operand] && K[operand].t === 'number' ? K[operand].v : 0;
        const callee = pop();
        const args = this.popN(stack, argc);
        push(this.callExpr(callee, args, null));
        return;
      }

      // generators
      case 'YIELD': push(t.yieldExpression(pop())); return;
      case 'YIELD_STAR': push(t.yieldExpression(pop(), true)); return;
      case 'AWAIT': push(t.awaitExpression(pop())); return;

      default:
        this.ctx.warn(`unhandled opcode ${m} at pc ${pc}`);
        push(t.callExpression(t.identifier(`__${m}`), [t.numericLiteral(operand)]));
    }
  },

/** Build the AST for a template expression. ctx: { state, operand, popped } */
  templateExpr(x, ctx) {
    const { state, operand, popped } = ctx;
    const field = (f) => templateField(f, operand);
    switch (x.k) {
      case 'leaf': {
        const [tag, f] = x.key.split(':');
        if (tag === 'S') { const v = popped[Number(f)]; return v || t.identifier('undefined'); }
        if (tag === 'R') return this.regId(state, field(f));
        if (tag === 'A') return this.argId(state, field(f));
        if (tag === 'K') return constNode(state.prog.consts[field(f)]);
        if (tag === 'OPV') return t.numericLiteral(field(f));
        if (tag.startsWith('C')) return this.slotName(state, this.frameAt(state, field(tag.slice(1))), field(f));
        return t.identifier('undefined');
      }
      case 'lit': return x.v === undefined ? t.identifier('undefined') : x.v === null ? t.nullLiteral() : t.booleanLiteral(x.v);
      case 'fresh': { const n = x.kind === 'arr' ? t.arrayExpression([]) : t.objectExpression([]); n.__builder = true; return n; }
      case 'un': {
        const a = this.templateExpr(x.a, ctx);
        switch (x.op) {
          case 'inc': return t.binaryExpression('+', a, t.numericLiteral(1));
          case 'dec': return t.binaryExpression('-', a, t.numericLiteral(1));
          case '|0': return t.binaryExpression('|', a, t.numericLiteral(0));
          case '>>>0': return t.binaryExpression('>>>', a, t.numericLiteral(0));
          case '!=null': return t.binaryExpression('!=', a, t.nullLiteral());
          case '==null': return t.binaryExpression('==', a, t.nullLiteral());
          case 'String': { const c = t.callExpression(t.identifier('String'), [a]); c.__toString = true; return c; }
          default: return t.unaryExpression(x.op, a);
        }
      }
      case 'bin': return this.binary(x.op, this.templateExpr(x.a, ctx), this.templateExpr(x.b, ctx));
      default: return t.identifier('undefined');
    }
  },

applyTemplate(state, e, operand, stack, emit) {
    const popped = [];
    for (let i = 0; i < e.pops; i++) popped.push(this.pop(stack));
    const ctx = { state, operand, popped };
    const pushes = e.pushes.map((x) => this.templateExpr(x, ctx));
    const writes = e.writes.map((w) => ({ target: this.templateExpr({ k: 'leaf', key: w.target }, ctx), value: this.templateExpr(w.expr, ctx) }));
    // a pushed value that equals a written value becomes the assignment expression itself
    const usedWrite = new Set();
    for (let i = 0; i < pushes.length; i++) {
      const pg = gen(pushes[i]);
      const wi = writes.findIndex((w, j) => !usedWrite.has(j) && gen(w.value) === pg);
      if (wi >= 0) { usedWrite.add(wi); pushes[i] = t.assignmentExpression('=', writes[wi].target, writes[wi].value); }
    }
    // pushes reading a location that is written afterwards must be evaluated first
    const writtenNames = writes.filter((w, j) => !usedWrite.has(j)).map((w) => gen(w.target));
    for (let i = 0; i < pushes.length; i++) {
      const pg = gen(pushes[i]);
      if (writtenNames.some((n) => new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`).test(pg)) && !t.isAssignmentExpression(pushes[i])) {
        const id = t.identifier(this.tmpName());
        this.emitStatement(state, stack, emit, t.variableDeclaration('const', [t.variableDeclarator(id, pushes[i])]));
        pushes[i] = id;
      }
    }
    writes.forEach((w, j) => { if (!usedWrite.has(j)) this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', w.target, w.value))); });
    for (const p of pushes) stack.push(p);
  },

iterExpr(it) {
    if (it.__marker === 'iter') return t.callExpression(t.memberExpression(it.__src, t.memberExpression(t.identifier('Symbol'), t.identifier('iterator')), true), []);
    return it;
  },

argId(state, i) {
    if (i < state.paramNames.length) return t.identifier(state.paramNames[i]);
    state.usesArguments = true;
    return t.memberExpression(t.identifier('arguments'), t.numericLiteral(i), true);
  },

globalRef(c) {
    if (c && c.t === 'string' && isIdentName(c.v)) return t.identifier(c.v);
    return t.memberExpression(t.identifier('globalThis'), constNode(c), true);
  },

binary(op, a, b) {
    if (['&&', '||', '??'].includes(op)) return t.logicalExpression(op, a, b);
    return t.binaryExpression(op, a, b);
  },

callExpr(callee, args, thisObj) {
    if (callee && callee.__brandHelper && args.length === 1) return args[0];
    // `(function () { return <expr>; }).call(x)` without `this`/`arguments` in <expr>: just <expr>
    // (the compiler wraps field initializers in such thunks)
    if (t.isFunctionExpression(callee) && !callee.params.length && !args.length && !callee.async && !callee.generator &&
        callee.body.body.length === 1 && t.isReturnStatement(callee.body.body[0]) && callee.body.body[0].argument && !callee.body.directives.length) {
      const e = callee.body.body[0].argument;
      let self = false;
      t.traverseFast(e, (n) => { if (t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }) || t.isFunction(n) || t.isSuper(n)) self = true; });
      if (!self) return e;
    }
    // tag`...${x}...`: first argument is a frozen template object with raw strings
    if (args.length && args[0] && args[0].__templateRaw && (thisObj === null || (t.isMemberExpression(callee) && sameExpr(callee.object, thisObj)))) {
      const cooked = args[0].__templateCooked || args[0].elements;
      const raw = args[0].__templateRaw;
      const exprs = args.slice(1);
      if (cooked.length === exprs.length + 1 && cooked.every((c) => t.isStringLiteral(c) || isUndef(c)) && raw.every((r) => t.isStringLiteral(r))) {
        const quasis = raw.map((r, i) => t.templateElement({ raw: r.value, cooked: t.isStringLiteral(cooked[i]) ? cooked[i].value : undefined }, i === raw.length - 1));
        return t.taggedTemplateExpression(callee, t.templateLiteral(quasis, exprs));
      }
    }
    if (thisObj === null) {
      if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) return t.callExpression(t.sequenceExpression([t.numericLiteral(0), callee]), args);
      return t.callExpression(callee, args);
    }
    // method call: callee is `thisObj.prop`
    if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && sameExpr(callee.object, thisObj)) {
      return t.callExpression(callee, args);
    }
    return t.callExpression(t.memberExpression(callee, t.identifier('call')), [thisObj, ...args]);
  },

defineProp(state, stack, emit, obj, key, value, opts) {
    const pk = propKey(key);
    if (obj.__builder && t.isObjectExpression(obj)) {
      if (opts.accessor) {
        const fn = t.isFunctionExpression(value) || t.isArrowFunctionExpression(value) ? value : null;
        if (fn) { obj.properties.push(t.objectMethod(opts.accessor, pk.key, fn.params, t.isBlockStatement(fn.body) ? fn.body : t.blockStatement([t.returnStatement(fn.body)]), pk.computed)); return; }
      }
      if (t.isFunctionExpression(value) && value.__methodKind) {
        obj.properties.push(t.objectMethod('method', pk.key, value.params, value.body, pk.computed, value.generator, value.async));
        return;
      }
      obj.properties.push(t.objectProperty(pk.key, value, pk.computed));
      return;
    }
    if (obj.__builder && t.isClassExpression(obj)) {
      const fn = t.isFunctionExpression(value) ? value : null;
      // members defined on the class object itself are static (instance fields are set up by
      // the constructor, prototype members carry `proto`)
      const isStatic = !opts.proto;
      if (fn) {
        const kind = opts.accessor || 'method';
        const meth = t.classMethod(kind, pk.key, fn.params, fn.body, pk.computed, isStatic, fn.generator, fn.async);
        obj.body.body.push(meth);
      } else if (value.__staticInit && obj.body.body.includes(value.__staticInit)) {
        // `static x = <expr>` compiles to a thunk run with the class as `this`: the field takes
        // the static block's place, with the thunk's return value as initializer
        const block = value.__staticInit;
        obj.body.body.splice(obj.body.body.indexOf(block), 1, t.classProperty(pk.key, thunkValue(block.body), null, null, pk.computed, isStatic));
      } else {
        obj.body.body.push(t.classProperty(pk.key, value, null, null, pk.computed, isStatic));
      }
      return;
    }
    // generic object: assignment / defineProperty
    if (opts.accessor) {
      const desc = t.objectExpression([t.objectProperty(t.identifier(opts.accessor), value), t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true))]);
      const target = opts.proto ? t.memberExpression(obj, t.identifier('prototype')) : obj;
      this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')), [target, t.isIdentifier(pk.key) && !pk.computed ? t.stringLiteral(pk.key.name) : pk.key, desc])));
      return;
    }
    const target = opts.proto ? t.memberExpression(obj, t.identifier('prototype')) : obj;
    this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', member(target, pk.computed ? key : t.isIdentifier(pk.key) ? t.stringLiteral(pk.key.name) : pk.key), value)));
  },

makeClosure(state, desc) {
    let progId = null;
    if (desc.__programRef !== undefined) progId = desc.__programRef;
    else if (t.isNumericLiteral(desc)) progId = this.ctx.nestedIndexToId[desc.value];
    if (progId === undefined || progId === null || !this.ctx.programsById.has(progId)) {
      this.ctx.warn(`could not resolve closure descriptor`);
      return t.callExpression(t.identifier('__closure'), [desc]);
    }
    const prog = this.ctx.programsById.get(progId);
    const lifted = this.liftProgram(prog, { parentChain: this.chainAt(state) });
    const fn = this.buildFunction(prog, lifted);
    if (this.isBrandCheckProgram(prog) || isKeyHelper(fn)) fn.__brandHelper = true;
    return fn;
  },

/**
   * obfuscator.io lowers private members before compiling; every access then goes through a
   * one-argument brand check that returns its argument or throws "Cannot read private member
   * ...". Such helpers are identities on valid receivers, and the restored `#x` syntax performs
   * the same check natively.
   */
  isBrandCheckProgram(prog) {
    if (prog.__brand !== undefined) return prog.__brand;
    const hasMsg = (p) => p && p.consts.some((c) => c && c.t === 'string' && PRIVATE_ERROR.test(c.v));
    let brand = prog.paramCount === 1 && hasMsg(prog);
    if (!brand && prog.paramCount === 1) {
      // `o => SYM in o ? o : { get [SYM]() { throw ... } }`: the message sits in nested programs
      for (let pc = 1; pc < prog.instrs.length && !brand; pc++) {
        if (this.mnem(prog.instrs[pc][0]) !== 'MAKE_CLOSURE' || this.mnem(prog.instrs[pc - 1][0]) !== 'PUSH_CONST') continue;
        const c = prog.consts[prog.instrs[pc - 1][1]];
        const id = c && c.t === 'number' ? this.ctx.nestedIndexToId[c.v] : c && c.t === 'program' ? c.id : undefined;
        const nested = id !== undefined ? this.ctx.programsById.get(id) : null;
        if (hasMsg(nested)) brand = true;
      }
    }
    prog.__brand = brand;
    return brand;
  },

buildFunction(prog, lifted, opts = {}) {
    const kind = prog.fnKind || { kind: 'function' };
    let params = lifted.params;
    let body = lifted.body;
    // rest parameter recovery: `Array.prototype.slice.call(arguments, N)` with N == paramCount
    const restName = fresh('rest');
    let usedRest = false;
    if (lifted.usesArguments && opts.argumentsName) {
      // the caller supplies the arguments array under another name
      const wrapper = t.blockStatement(body);
      t.traverseFast(wrapper, (n) => { if (t.isIdentifier(n, { name: 'arguments' })) n.name = opts.argumentsName; });
      body = wrapper.body;
    } else if (lifted.usesArguments && (prog.strict || kind.strict || !usesArgumentsBeyondSlice(body, prog.paramCount))) {
      // (in sloppy functions a rest parameter would unmap `arguments` from the parameters)
      const n = prog.paramCount;
      // (nested functions with their own `arguments` keep theirs)
      const wrapper = t.blockStatement(body);
      usedRest = replaceWhere(wrapper, (x) => isArgumentsSlice(x, n), () => t.identifier(restName), (x) => x !== wrapper && hasOwnArguments(x)) > 0;
      body = wrapper.body;
      if (usedRest) params = [...params, t.restElement(t.identifier(restName))];
    }
    // `(a0) => { let [x, y] = a0; ... }`  ->  `([x, y]) => { ... }`
    params = params.slice();
    while (body.length && t.isVariableDeclaration(body[0]) && body[0].declarations.length === 1 && t.isArrayPattern(body[0].declarations[0].id)) {
      const init = body[0].declarations[0].init;
      const pi = params.findIndex((p) => t.isIdentifier(p) && t.isIdentifier(init, { name: p.name }));
      if (pi < 0 || body.slice(1).some((x) => referencesName(x, init.name))) break;
      params[pi] = body[0].declarations[0].id;
      body = body.slice(1);
    }
    const stillUsesArguments = lifted.usesArguments && !opts.argumentsName && referencesName(t.blockStatement(body), 'arguments');
    const strict = kind.strict && !opts.noStrict;
    const block = t.blockStatement(body, strict ? [t.directive(t.directiveLiteral('use strict'))] : []);
    const vmName = kind.kind === 'function' && kind.name && isIdentName(kind.name) ? kind.name : null; // nested function's own name
    const id = prog.name && isIdentName(prog.name) ? t.identifier(prog.name) : prog.selfName ? t.identifier(prog.selfName) : vmName ? t.identifier(vmName) : null;
    if (kind.kind === 'arrow' && !stillUsesArguments) {
      const fn = t.arrowFunctionExpression(params, block, !!kind.async);
      return fn;
    }
    const fn = t.functionExpression(id, params, block, !!kind.generator, !!kind.async);
    if (kind.kind === 'method') fn.__methodKind = true;
    return fn;
  }
};
