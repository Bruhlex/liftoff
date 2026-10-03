'use strict';
/**
 * Instruction semantics: arithmetic, property access, literals and object building.
 * Handlers of Lifter#step, keyed by mnemonic and called with the lifter as `this`.
 */

const t = require('@babel/types');
const { member, optMember, propKey } = require('../nodes');

const ops = {
  // arithmetic
  BINOP({ e, push, pop }) { const b = pop(), a = pop(); push(this.binary(e.op, a, b)); },
  BINOP_MEGA({ operand, e, push, pop }) {
    const sel = (operand ^ e.mask) >>> 0;
    const l = e.ladder[sel];
    const b = pop(), a = pop();
    if (!l) { this.ctx.warn(`unknown BINOP selector ${sel}`); push(t.callExpression(t.identifier('__binop'), [t.numericLiteral(sel), a, b])); return; }
    push(l.swapped ? this.binary(l.op, b, a) : this.binary(l.op, a, b));
  },
  FUSED_BINOP({ state, operand, e, push, constAt }) { push(this.binary(e.op, this.regId(state, operand & 0xffff), constAt(operand >>> 16))); },
  UNARY({ e, push, pop }) { push(t.unaryExpression(e.op, pop())); },
  VOID({ push, pop }) { push(t.unaryExpression('void', pop())); },
  TO_NUMERIC() {}, // a coercion: identity for source recovery
  // the key of an object destructuring, coerced before the target is evaluated: marked, so
  // that the emitter can put the destructuring back together
  TO_PROPERTY_KEY({ stack }) { const v = this.peek(stack); if (v && typeof v === 'object') v.__propertyKey = true; },
  // (tagged: only an increment is an update `++x`, which also works on BigInts; `x + 1` does not)
  INC_VALUE({ push, pop }) { const b = t.binaryExpression('+', pop(), t.numericLiteral(1)); b.__inc = true; push(b); },
  DEC_VALUE({ push, pop }) { const b = t.binaryExpression('-', pop(), t.numericLiteral(1)); b.__inc = true; push(b); },
  TO_STRING({ push, pop }) { const v = pop(); if (t.isStringLiteral(v)) { push(v); return; } const c = t.callExpression(t.identifier('String'), [v]); c.__toString = true; push(c); },
  // property access
  GETPROP_NAMED({ operand, push, pop, keyConst }) {
    const obj = pop();
    if (obj.__marker === 'superCtor') { push(t.super()); return; }
    push(member(obj, keyConst(operand)));
  },
  GETPROP_NAMED_KEEP({ operand, stack, push, keyConst }) { const obj = this.peek(stack); push(member(obj, keyConst(operand))); },
  GETPROP_COMPUTED({ push, pop }) { const key = pop(), obj = pop(); push(member(obj, key)); },
  GETPROP_REG_CONST({ state, operand, push, keyConst }) { push(member(this.regId(state, operand & 0xffff), keyConst(operand >>> 16))); },
  GET_THIS_PROP({ operand, push, keyConst }) { push(member(t.thisExpression(), keyConst(operand))); },
  OPT_GETPROP_NAMED({ operand, push, pop, keyConst }) { push(optMember(pop(), keyConst(operand))); },
  OPT_GETPROP_COMPUTED({ push, pop }) { const key = pop(), obj = pop(); push(optMember(obj, key)); },
  SETPROP_NAMED({ state, operand, stack, pop, keyConst }) { const v = pop(), obj = pop(); this.pushStore(state, stack, t.assignmentExpression('=', member(obj, keyConst(operand)), v)); },
  SETPROP_COMPUTED({ state, stack, pop }) { const v = pop(), key = pop(), obj = pop(); this.pushStore(state, stack, t.assignmentExpression('=', member(obj, key), v)); },
  DELETE_PROP({ operand, push, pop, keyConst }) {
    if (operand >= 0) { const obj = pop(); push(t.unaryExpression('delete', member(obj, keyConst(operand)))); }
    else { const key = pop(), obj = pop(); push(t.unaryExpression('delete', member(obj, key))); }
  },
  IN_SAFE({ push, pop }) { const obj = pop(), key = pop(); push(t.binaryExpression('in', key, obj)); },
  // literals / object building
  DEFINE_PROP_NAMED({ state, operand, stack, emit, pop, keyConst }) { const v = pop(), obj = pop(); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: true }); },
  DEFINE_PROP_COMPUTED({ state, stack, emit, pop }) { const v = pop(), key = pop(), obj = pop(); this.defineProp(state, stack, emit, obj, key, v, { enumerable: true }); },
  DEFINE_METHOD_NAMED({ state, operand, stack, emit, pop, keyConst }) { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: false, isStatic: true }); },
  DEFINE_METHOD_COMPUTED({ state, stack, emit, pop }) { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { enumerable: false, isStatic: true }); },
  DEFINE_PROTO_METHOD_NAMED({ state, operand, stack, emit, pop, keyConst }) { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { enumerable: false, proto: true }); },
  DEFINE_PROTO_METHOD_COMPUTED({ state, stack, emit, pop }) { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { enumerable: false, proto: true }); },
  DEFINE_GETTER_NAMED({ state, operand, stack, emit, e, pop, keyConst }) { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { accessor: 'get', proto: e.protoTarget, isStatic: !e.protoTarget }); },
  DEFINE_SETTER_NAMED({ state, operand, stack, emit, e, pop, keyConst }) { const v = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, keyConst(operand), v, { accessor: 'set', proto: e.protoTarget, isStatic: !e.protoTarget }); },
  DEFINE_GETTER_COMPUTED({ state, stack, emit, e, pop }) { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { accessor: 'get', proto: e.protoTarget, isStatic: !e.protoTarget }); },
  DEFINE_SETTER_COMPUTED({ state, stack, emit, e, pop }) { const v = pop(), key = pop(), obj = this.peek(stack); this.defineProp(state, stack, emit, obj, key, v, { accessor: 'set', proto: e.protoTarget, isStatic: !e.protoTarget }); },
  SET_PROTO({ state, stack, emit, pop }) {
    const proto = pop(), obj = this.peek(stack);
    if (obj.__builder && t.isObjectExpression(obj)) obj.properties.push(t.objectProperty(t.identifier('__proto__'), proto));
    else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('setPrototypeOf')), [obj, proto])));
  },
  OBJ_SPREAD({ state, stack, emit, pop }) {
    const src = pop(), obj = this.peek(stack);
    if (obj.__builder && t.isObjectExpression(obj)) obj.properties.push(t.spreadElement(src));
    else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), [obj, src])));
  },
  OBJ_REST({ push, pop }) {
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
  },
  ARR_PUSH({ state, stack, emit, pop }) {
    const v = pop(), arr = this.peek(stack);
    if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(v);
    else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(arr, t.identifier('push')), [v])));
  },
  ARR_SPREAD({ state, stack, emit, pop }) {
    const v = pop(), arr = this.peek(stack);
    if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(t.spreadElement(v));
    else this.emitStatement(state, stack, emit, t.expressionStatement(t.callExpression(t.memberExpression(arr, t.identifier('push')), [t.spreadElement(v)])));
  },
  ARR_HOLE({ state, stack, emit }) {
    const arr = this.peek(stack);
    if (arr.__builder && t.isArrayExpression(arr)) arr.elements.push(null);
    else this.emitStatement(state, stack, emit, t.expressionStatement(t.updateExpression('++', t.memberExpression(arr, t.identifier('length')))));
  },
  SPREAD_MARK({ push, pop }) { push(t.spreadElement(pop())); },
  TEMPLATE_OBJECT({ stack, push }) {
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
  },
  NEW_REGEXP({ operand, K, push }) {
    const src = K[operand & 0xffff], flags = K[operand >>> 16];
    push(t.regExpLiteral(src && src.t === 'string' ? src.v : '', flags && flags.t === 'string' ? flags.v : ''));
  },
  SYMBOL({ operand, push, pop }) { push(t.callExpression(t.identifier('Symbol'), operand === -1 ? [] : [pop()])); },
  SYMBOL_FOR({ operand, push, constAt }) { push(t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('for')), [constAt(operand)])); },
  SYMBOL_KEYFOR({ push, pop }) { push(t.callExpression(t.memberExpression(t.identifier('Symbol'), t.identifier('keyFor')), [pop()])); },
  DYNAMIC_IMPORT({ push, pop }) { push(t.callExpression(t.import(), [pop()])); },
};

module.exports = ops;
