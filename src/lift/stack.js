'use strict';
/**
 * The symbolic operand stack: popping, spilling values into temporaries before a statement
 * changes what they read, assignments and stores.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { referencesName, countIdentity, replaceIdentity } = require('../ast');
const { isPseudo, isPure, assignedNames, assignedProps, readsProps, containsCall, fresh } = require('./nodes');

module.exports = {
  // -------------------------------------------------------------------------
  // stack helpers
  // -------------------------------------------------------------------------

  pop(stack) {
    if (stack.length) return stack.pop();
    const u = t.identifier('undefined');
    u.__underflow = true;
    return u;
  },

peek(stack) {
    if (stack.length) return stack[stack.length - 1];
    const u = t.identifier('undefined');
    u.__underflow = true;
    stack.push(u);
    return u;
  },

popN(stack, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.unshift(this.pop(stack));
    return out;
  },

popLit(stack) {
    const v = this.pop(stack);
    if (t.isNumericLiteral(v)) return v.value;
    if (t.isUnaryExpression(v, { operator: '-' }) && t.isNumericLiteral(v.argument)) return -v.argument.value;
    this.ctx.warn('non-literal argument count on the stack; assuming 0');
    return 0;
  },

  /** Emit an impure value that is about to be discarded. */
  dropValue(v, emit) {
    // reading an undeclared global throws, so a dropped read of an unknown global is kept
    // (standard built-ins such as `console` are known to exist)
    if (v && v.__global && t.isIdentifier(v) && !(v.name in globalThis)) { emit(t.expressionStatement(v)); return; }
    if (!v || isPure(v)) return;
    emit(t.expressionStatement(v));
  },

  /**
   * Before emitting a statement `stmt` while values are pending on the stack,
   * spill pending values that the statement could affect into temporaries.
   */
  spillForStatement(state, stack, emit, stmt) {
    if (!stack.length) return;
    // a pure top-of-stack value that the next instruction discards needs no spill
    if (state.nextIsDrop && stack.length && isPure(stack[stack.length - 1])) {
      stack.pop();
      state.nextIsDrop = false;
      state.skipNextDrop = true;
    }
    // a DUP'd value that the statement consumes and that stays on the stack would be evaluated
    // twice (`const x = (c ? d : o).x; const y = (c ? d : o).y;`): evaluate it once into a temporary
    if (stmt) {
      const simple = (v) => t.isIdentifier(v) || t.isLiteral(v) || t.isThisExpression(v) || t.isFunction(v) || t.isClass(v) ||
        (t.isMemberExpression(v) && (!v.computed || t.isLiteral(v.property)) && simple(v.object));
      for (let i = 0; i < stack.length; i++) {
        const v = stack[i];
        if (!v || typeof v !== 'object' || isPseudo(v) || simple(v)) continue;
        let shared = false;
        t.traverseFast(stmt, (x) => { if (x === v) shared = true; });
        if (!shared) continue;
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('const', [t.variableDeclarator(id, v)]));
        for (let j = 0; j < stack.length; j++) stack[j] = replaceIdentity(stack[j], v, id);
        replaceIdentity(stmt, v, id);
      }
    }
    const assigned = stmt ? assignedNames(stmt) : new Set();
    const props = stmt ? assignedProps(stmt) : new Set();
    const stmtHasCall = stmt ? containsCall(stmt) : true;
    for (let i = 0; i < stack.length; i++) {
      const v = stack[i];
      if (v && v.__builder && (t.isObjectExpression(v) || t.isArrayExpression(v)) && (!stmt || stmtHasCall || assigned.size || props.size)) { this.spillBuilder(v, emit, assigned, props); continue; }
      if (!v || isPseudo(v)) continue;
      if (t.isLiteral(v) || t.isThisExpression(v) || t.isFunctionExpression(v) || t.isArrowFunctionExpression(v)) continue;
      if (t.isSpreadElement(v)) {
        // `...x` waiting for its call/array: spill the operand, keep the spread marker
        const a = v.argument;
        let aff = !isPure(a);
        if (!aff) for (const n of assigned) if (referencesName(a, n)) aff = true;
        if (!aff && readsProps(a, props)) aff = true;
        if (aff) {
          const id = t.identifier(this.tmpName());
          emit(t.variableDeclaration('const', [t.variableDeclarator(id, a)]));
          v.argument = id;
        }
        continue;
      }
      let affected = !isPure(v);
      if (!affected) for (const n of assigned) if (referencesName(v, n)) affected = true;
      if (!affected && readsProps(v, props)) affected = true;
      if (affected) {
        // values below that read a variable this one assigns are evaluated before it
        const own = assignedNames(t.expressionStatement(v));
        for (let j = 0; j < i && own.size; j++) {
          const u = stack[j];
          if (!u || isPseudo(u) || t.isLiteral(u) || t.isFunction(u)) continue;
          if (![...own].some((nm) => referencesName(u, nm))) continue;
          const uid = t.identifier(this.tmpName());
          emit(t.variableDeclaration('const', [t.variableDeclarator(uid, u)]));
          for (let k = 0; k < stack.length; k++) stack[k] = replaceIdentity(stack[k], u, uid);
        }
        const id = t.identifier(this.tmpName());
        emit(t.variableDeclaration('const', [t.variableDeclarator(id, v)]));
        for (let j = 0; j < stack.length; j++) stack[j] = replaceIdentity(stack[j], v, id);
      }
    }
  },

tmpName() { return fresh(`_t${this.tempCounter++}`); },

  /** literals under construction keep their node, but values already evaluated into them
   *  (calls etc.) precede any statement emitted now: move those into temporaries */
  spillBuilder(b, emit, assigned = null, props = null) {
    // a pure value (e.g. a variable read) is affected only by a statement that writes what it reads
    const touched = (v) => (assigned && [...assigned].some((n) => referencesName(v, n))) || (props && props.size && readsProps(v, props));
    const slots = t.isObjectExpression(b) ? b.properties.filter((p) => t.isObjectProperty(p) || t.isSpreadElement(p)).map((p) => (t.isSpreadElement(p) ? [p, 'argument'] : [p, 'value']))
      : t.isArrayExpression(b) ? b.elements.map((e, k) => (e ? [b.elements, k] : null)).filter(Boolean) : [];
    // computed keys come before their values: a key read (`[r]: ...`) is affected like a value
    if (t.isObjectExpression(b)) {
      const keys = [];
      for (const p of b.properties) if ((t.isObjectProperty(p) || t.isObjectMethod(p)) && p.computed && !t.isLiteral(p.key)) keys.push([p, 'key']);
      // in source order: key, value, next key, ...
      const order = (h) => b.properties.indexOf(h[0]) * 2 + (h[1] === 'key' ? 0 : 1);
      slots.push(...keys);
      slots.sort((x, y) => order(x) - order(y));
    }
    for (const [holder, key] of slots) {
      let v = holder[key];
      if (t.isSpreadElement(v)) { holder[key] = v; const inner = v; if (!isPure(inner.argument)) { const id = t.identifier(this.tmpName()); emit(t.variableDeclaration('const', [t.variableDeclarator(id, inner.argument)])); inner.argument = id; } continue; }
      if (!v || (isPure(v) && !touched(v)) || t.isFunctionExpression(v) || t.isArrowFunctionExpression(v)) continue;
      if (v.__builder) { this.spillBuilder(v, emit, assigned, props); continue; }
      const id = t.identifier(this.tmpName());
      emit(t.variableDeclaration('const', [t.variableDeclarator(id, v)]));
      holder[key] = id;
    }
  },

  /**
   * A branch that emits a statement spills pending values of the stack it inherited
   * (`const _tN = <value>`); those values were computed before the branch, so the spill
   * belongs in front of the conditional. Both branches may have spilled the same value.
   */
  hoistBaseSpills(base, results, stack, emit, baseNodes, cond) {
    const hoisted = new Map(); // value node -> temp name
    // `(rN = v)` pending on the shared stack: a branch that reads rN flushes it as `rN = v;`. The VM
    // ran that store before the test, so the statement belongs in front of the conditional, and
    // the stack entry becomes `rN` on both paths
    const baseAssigns = new Map(); // right-hand node -> assignment node
    for (const v of base) if (v && typeof v === 'object') t.traverseFast(v, (n) => { if (t.isAssignmentExpression(n, { operator: '=' }) && t.isIdentifier(n.left)) baseAssigns.set(n.right, n); });
    const flushedAsg = new Map(); // assignment node -> name
    for (const res of results) {
      const keep = [];
      const renames = new Map();
      for (const st of res.stmts) {
        const asg = t.isExpressionStatement(st) && t.isAssignmentExpression(st.expression, { operator: '=' }) && t.isIdentifier(st.expression.left) ? st.expression : null;
        const orig = asg && baseAssigns.get(asg.right);
        if (orig && t.isIdentifier(orig.left, { name: asg.left.name })) {
          if (!flushedAsg.has(orig)) { flushedAsg.set(orig, asg.left.name); emit(st); }
          continue;
        }
        const d = t.isVariableDeclaration(st, { kind: 'const' }) && st.declarations.length === 1 ? st.declarations[0] : null;
        if (d && t.isIdentifier(d.id) && /^_t\d+$/.test(d.id.name) && baseNodes.has(d.init) && keep.length === 0 || d && hoisted.has(d.init) && baseNodes.has(d.init)) {
          if (hoisted.has(d.init)) renames.set(d.id.name, hoisted.get(d.init));
          else { hoisted.set(d.init, d.id.name); emit(st); }
          continue;
        }
        keep.push(st);
      }
      if (renames.size) {
        const fix = (n) => t.traverseFast(n, (x) => { if (t.isIdentifier(x) && renames.has(x.name)) x.name = renames.get(x.name); });
        keep.forEach(fix);
        res.stack.forEach((v) => v && typeof v === 'object' && fix(v));
      }
      res.stmts = keep;
    }
    if (hoisted.size || flushedAsg.size) {
      // one shared node per temporary: stack entries are compared by identity (`a === b`) later
      const ids = new Map([...hoisted, ...flushedAsg].map(([node, name]) => [node, t.identifier(name)]));
      const byName = new Map([...ids.values()].map((id) => [id.name, id]));
      // identifiers the branches created for their own spills of the same value: canonicalize
      const sub = (x) => { for (const [node, id] of ids) x = replaceIdentity(x, node, id); return t.isIdentifier(x) && byName.has(x.name) ? byName.get(x.name) : x; };
      for (let j = 0; j < stack.length; j++) stack[j] = sub(stack[j]);
      for (let j = 0; j < base.length; j++) base[j] = sub(base[j]);
      for (const res of results) for (let j = 0; j < res.stack.length; j++) res.stack[j] = sub(res.stack[j]);
    }
  },

emitStatement(state, stack, emit, stmt) {
    this.spillShared(state, stack, emit, [stmt]);
    this.spillForStatement(state, stack, emit, stmt);
    emit(stmt);
  },

  /**
   * A value with side effects (call, await, new, assignment, ...) that was
   * duplicated on the stack (DUP) must be evaluated once. If such a node occurs
   * in the code about to be emitted and is still referenced from the stack (or
   * occurs twice in that code), evaluate it into a temporary first.
   */
  spillShared(state, stack, emit, exprs) {
    const isEffect = (n) => t.isCallExpression(n) || t.isOptionalCallExpression(n) || t.isNewExpression(n) || t.isAwaitExpression(n) || t.isYieldExpression(n) || t.isAssignmentExpression(n) || t.isUpdateExpression(n);
    const counts = new Map();
    const count = (root, into) => {
      const walk = (n) => {
        if (!n || typeof n.type !== 'string' || t.isFunction(n) || t.isClass(n)) return;
        if (isEffect(n)) into.set(n, (into.get(n) || 0) + 1);
        for (const k of t.VISITOR_KEYS[n.type] || []) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v); }
      };
      walk(root);
    };
    for (const e of exprs) count(e, counts);
    if (!counts.size) return;
    const onStack = new Map();
    for (const v of stack) if (v && typeof v.type === 'string') count(v, onStack);
    // outermost shared nodes first: a node containing another shared node is replaced as a whole
    const shared = [...counts.keys()].filter((n) => counts.get(n) > 1 || onStack.has(n));
    if (!shared.length) return;
    const inside = (a, b) => a !== b && countIdentity(b, a) > 0; // a inside b
    const roots = shared.filter((n) => !shared.some((o) => inside(n, o)));
    for (const n of roots) {
      const id = t.identifier(this.tmpName());
      emit(t.variableDeclaration('const', [t.variableDeclarator(id, n)]));
      for (let i = 0; i < exprs.length; i++) exprs[i] = replaceIdentity(exprs[i], n, id);
      for (let i = 0; i < stack.length; i++) stack[i] = replaceIdentity(stack[i], n, id);
    }
  },

  /** Assignment: value `v` has just been popped for storing into `target`. */
  assign(state, stack, emit, target, v, declKind = null) {
    const idx = stack.lastIndexOf(v);
    if (idx >= 0 && !t.isLiteral(v)) {
      if (declKind && t.isIdentifier(target)) {
        // a declaring store whose value stays on the stack (`f = g = function () {}` in a block)
        if (v.__builder) emit(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(target.name))]));
        else {
          this.emitStatement(state, stack, emit, t.variableDeclaration(declKind, [t.variableDeclarator(target, v)]));
          const at = stack.lastIndexOf(v);
          if (at >= 0) stack[at] = t.identifier(target.name);
          return;
        }
      }
      // value is still needed on the stack (DUP'd): make the assignment an expression
      const a = t.assignmentExpression('=', target, v);
      stack[idx] = a;
      return;
    }
    if (idx >= 0) {
      // literal duplicated: assign, keep literal on the stack
      this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', target, v)));
      return;
    }
    if (declKind) {
      this.emitStatement(state, stack, emit, t.variableDeclaration(declKind, [t.variableDeclarator(target, v)]));
      return;
    }
    // function declaration sugar handled later by cleanup
    this.emitStatement(state, stack, emit, t.expressionStatement(t.assignmentExpression('=', target, v)));
  },

  /** push the result of a property store; when the stored value is still on top of the stack
   *  (`DUP; ...; SETPROP; DROP`, an assignment used as a value: `f(++o[k])`), the assignment
   *  takes that value's place, so it is not split into a temporary and a statement */
  pushStore(state, stack, asg) {
    const v = asg.right;
    if (state.nextIsDrop && stack.length && stack[stack.length - 1] === v && typeof v === 'object' && !t.isLiteral(v)) {
      stack[stack.length - 1] = asg;
      state.skipNextDrop = true;
      return;
    }
    stack.push(asg);
  },

  /** a probe lifts code only to look at it; the returned function undoes what that lifting
   *  recorded: declared slots (a `const` in a probed loop header), and unless `declaredOnly`, the
   *  temp-register values and hidden registers */
  snapshot(state) {
    const frames = () => [...state.chain, ...state.enterFrames.values()];
    const declared = new Map(frames().map((f) => [f, new Set(f.declared)]));
    const tempValues = new Map(state.tempValues), hiddenRegs = new Set(state.hiddenRegs);
    return ({ declaredOnly = false } = {}) => {
      for (const f of frames()) f.declared = declared.has(f) ? declared.get(f) : new Set();
      if (declaredOnly) return;
      state.tempValues = tempValues;
      state.hiddenRegs = hiddenRegs;
    };
  }
};
