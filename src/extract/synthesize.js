'use strict';
/**
 * Helper functions synthesized from the interpreter's own source: `__prologue` (the prologue
 * up to the fetch loop, returning its locals) and `__step` (one dispatch step), so that the
 * build's decoder and handlers run unchanged.
 */

const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { prologueStatements, declaredLocals, parse } = require('../locate');

const genPretty = (node) => generate(node, { compact: false, comments: false }).code;

// ---------------------------------------------------------------------------
// Synthesize helper functions from the interpreter source
// ---------------------------------------------------------------------------

const topLevelLocals = (stmts) => [...declaredLocals(stmts).keys()];

function buildPrologueFunction(vm) {
  const fn = vm.plain.fnPath.node;
  const prologue = prologueStatements(fn, vm.plain.loop.outerPath.node);
  const locals = topLevelLocals(prologue);
  const params = vm.roles.params;
  const ret = t.returnStatement(
    t.objectExpression([...new Set([...locals, ...params])].map((n) => t.objectProperty(t.identifier(n), t.identifier(n)))),
  );
  return t.functionExpression(null, params.map((p) => t.identifier(p)), t.blockStatement([...prologue.map((s) => t.cloneNode(s, true)), ret]));
}

/**
 * Synthesize a single-step function from the interpreter itself:
 * prologue (resolves the program exactly like the VM) + overrides for the state
 * the caller wants to control + ONE iteration of the real fetch/dispatch body.
 * Because the real dispatch code runs, it does not matter how the build routes
 * opcodes (plain switch, `switch (MAP[op])`, range-bucketed dispatch functions).
 */
function buildStepFunction(vm) {
  const fn = vm.plain.fnPath.node;
  const prologue = prologueStatements(fn, vm.plain.loop.outerPath.node);
  const { roles } = vm;
  const fetch = vm.plain.fetch;
  const locals = [...new Set([...topLevelLocals(prologue), ...roles.params])];
  const isId = (x) => /^[A-Za-z_$][\w$]*$/.test(x);
  const body = generate(vm.plain.loop.inner.body, { comments: false }).code;
  const lines = [];
  lines.push(`(function (${roles.params.join(', ')}, __P) {`);
  lines.push(prologue.map((s) => generate(s, { comments: false }).code).join('\n'));
  const outer = [roles.ns, roles.global].filter(Boolean).map((n, i) => `__outer${i}: ${n}`);
  lines.push(`const __snap = () => ({ ${[...locals.map((n) => `${n}: ${n}`), ...outer].join(', ')} });`);
  if (isId(fetch.opBase)) lines.push(`${fetch.opBase} = 0;`);
  if (isId(fetch.operBase)) lines.push(`${fetch.operBase} = 1;`);
  if (isId(fetch.shift)) lines.push(`${fetch.shift} = 1;`);
  lines.push(`${roles.code} = new Int32Array(__P.codeSize); ${roles.len} = __P.pc + 1; ${roles.pc} = __P.pc;`);
  lines.push(`${roles.code}[(${fetch.opBase}) + (${roles.pc} << (${fetch.shift}))] = __P.op;`);
  lines.push(`${roles.code}[(${fetch.operBase}) + (${roles.pc} << (${fetch.shift}))] = __P.operand;`);
  lines.push(`if (__P.stack) { ${roles.stack} = __P.stack; ${roles.sp} = __P.sp; }`);
  if (roles.scope) lines.push(`if (__P.scope) ${roles.scope} = __P.scope;`);
  if (roles.this) lines.push(`if (__P.thisValue !== undefined) ${roles.this} = __P.thisValue;`);
  if (roles.lexThis) lines.push(`if (__P.thisValue !== undefined) ${roles.lexThis} = __P.thisValue;`);
  if (roles.newTarget) lines.push(`if (__P.newTarget !== undefined) ${roles.newTarget} = __P.newTarget;`);
  for (const [key, role] of [['regs', 'regs'], ['consts', 'consts'], ['jumps', 'jumps'], ['args', 'args']]) {
    if (roles[role]) lines.push(`if (__P.${key}) ${roles[role]} = __P.${key};`);
  }
  lines.push(`const __before = __P.fp ? __P.fp(__snap()) : __snap();`);
  lines.push(`let __ret = __P.NORET, __threw = __P.NORET;`);
  lines.push(`try { __ret = (() => { for (let __i = 0; __i < 1; __i++) ${body} return __P.NORET; })(); } catch (__e) { __threw = __e; }`);
  lines.push(`return { before: __before, after: __P.fp ? __P.fp(__snap()) : __snap(), ret: __ret, threw: __threw, sp: ${roles.sp}, pc: ${roles.pc}, stack: ${roles.stack} };`);
  lines.push(`})`);
  const src = lines.join('\n');
  const ast = parse(src);
  return ast.program.body[0].expression;
}

module.exports = { buildPrologueFunction, buildStepFunction, genPretty };
