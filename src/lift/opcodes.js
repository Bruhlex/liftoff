'use strict';
/**
 * Dispatch of single instructions (`step`, to the handlers in ops/), templates of behaviourally
 * inferred opcodes, calls, property definitions, closures and the functions they become.
 * (Methods of Lifter, mixed into its prototype by index.js.)
 */

const t = require('@babel/types');
const { gen, sameExpr, isIdentName, referencesName, thunkValue, PRIVATE_ERROR, replaceWhere, isArgumentsSlice, hasOwnArguments, isUndef } = require('../ast');
const { templateField, constNode, member, propKey, isKeyHelper, usesArgumentsBeyondSlice, fresh } = require('./nodes');

// instruction semantics by mnemonic
const OPS = Object.assign({}, require('./ops/stack'), require('./ops/scopes'), require('./ops/values'), require('./ops/calls'));

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
    const handler = OPS[m];
    if (!handler) {
      this.ctx.warn(`unhandled opcode ${m} at pc ${pc}`);
      stack.push(t.callExpression(t.identifier(`__${m}`), [t.numericLiteral(operand)]));
      return;
    }
    const K = state.prog.consts;
    handler.call(this, {
      state, m, op, operand, stack, emit, pc, K,
      e: this.entry(op),
      push: (v) => stack.push(v),
      pop: () => this.pop(stack),
      constAt: (i) => constNode(K[i]),
      keyConst: (i) => (K[i] ? constNode(K[i]) : t.stringLiteral(`__k${i}`)),
    });
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
