'use strict';
/**
 * Step 0: normalize the obfuscated input with webcrack.
 *
 * obfuscator.io's VM output is wrapped in the usual "light" transformations
 * (hex numbers, `!![]` booleans, `obj["prop"]` computed members, string
 * concatenation of constants, ...). webcrack undoes those reliably, which lets
 * every later stage work on a clean, pretty-printed AST instead of on regexes.
 */
const nodeVm = require('vm');
const { webcrack } = require('webcrack');

// webcrack evaluates string-array decoders in a sandbox; its default one needs the native
// isolated-vm addon (skipped by `npm install --ignore-scripts`). A fresh node:vm context is
// enough for obfuscator.io's decoders; results are copied out of the context via JSON. Real
// decoders finish in milliseconds; the timeout only guards against a rotation loop whose
// decoder was not recognised (see hoistDecoderArrayLoads).
const nodeVmSandbox = async (code) => {
  const res = nodeVm.runInNewContext(code, Object.create(null), { timeout: 10000, filename: 'obfuscated.js' });
  return res === undefined ? undefined : JSON.parse(JSON.stringify(res));
};

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

/**
 * Undo obfuscator.io's "Transform Object Keys" option: it moves object literals out of
 * expressions (`f({a: 1})` -> `const o = {}; o.a = 1; f(o)`), which webcrack merges back to
 * `const o = {a: 1}; f(o)` but leaves the temporary in place. Handler shapes, role inference
 * (try frames, scope objects) and host call sites all expect the literal inline.
 *
 * Inlined only when semantics are certainly unchanged: a binding that is never reassigned,
 * exactly one reference, located in the directly following statement of the same block and not inside a
 * nested function (which would create a new object per call), and none of the literal's
 * identifiers is written by that statement.
 */
/** a declaration whose initializers cannot observe or cause side effects */
function isInertDeclaration(node) {
  if (!t.isVariableDeclaration(node)) return false;
  return node.declarations.every((d) => !d.init || isInertExpr(d.init));
}
function isInertExpr(e) {
  if (t.isLiteral(e) && !t.isTemplateLiteral(e) || t.isIdentifier(e) || t.isFunction(e)) return true;
  if (t.isArrayExpression(e)) return e.elements.every((x) => x && !t.isSpreadElement(x) && isInertExpr(x));
  if (t.isObjectExpression(e)) return e.properties.every((p) => t.isObjectMethod(p) || t.isObjectProperty(p) && !p.computed && isInertExpr(p.value));
  if (t.isUnaryExpression(e) && e.operator !== 'delete') return isInertExpr(e.argument);
  return false;
}

function inlineLiteralTemps(code) {
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: false }); } catch { return code; }
  let changed = 0;
  traverse(ast, {
    VariableDeclaration(path) {
      // `var` too: builds with transformObjectKeys declare the temporaries with `var` (`let` stays:
      // the VM's own handlers use `let o = {...}` and are recognized in that form)
      if (path.node.kind === 'let' || path.node.declarations.length !== 1) return;
      // a top-level `var` is a global property that VM code reads by name, invisible to the binding
      if (path.node.kind === 'var' && path.scope.getFunctionParent() === null) return;
      const d = path.node.declarations[0];
      if (!t.isIdentifier(d.id) || !(t.isObjectExpression(d.init) || t.isArrayExpression(d.init))) return;
      if (!Array.isArray(path.container)) return;
      const binding = path.scope.getBinding(d.id.name);
      if (!binding || binding.path.node !== d || binding.references !== 1 || binding.constantViolations.length) return;
      const ref = binding.referencePaths[0];
      if (ref.getFunctionParent() !== path.getFunctionParent()) return;
      // the consuming statement: a later sibling, with only side-effect-free declarations between
      let next = null;
      for (let k = path.key + 1; k < path.container.length; k++) {
        const sib = path.getSibling(k);
        if (ref.findParent((p) => p === sib)) { next = sib; break; }
        if (!isInertDeclaration(sib.node)) return;
      }
      if (!next) return;
      // identifiers read by the literal must not be written by the consuming statement
      const reads = new Set();
      t.traverseFast(d.init, (n) => { if (t.isIdentifier(n)) reads.add(n.name); });
      let conflict = false;
      t.traverseFast(next.node, (n) => {
        if (t.isUpdateExpression(n) && t.isIdentifier(n.argument) && reads.has(n.argument.name)) conflict = true;
        if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && reads.has(n.left.name)) conflict = true;
        if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && t.isIdentifier(n.left.object) && reads.has(n.left.object.name)) conflict = true;
      });
      if (conflict) return;
      ref.replaceWith(d.init);
      path.remove();
      changed++;
    },
  });
  if (!changed) return code;
  return generate(ast, { comments: false, jsescOption: { minimal: true } }).code;
}

/**
 * "Split strings" output (also inside 8.4's VM Low builds) writes long strings as chains of
 * hundreds of one-character literals, `'n' + 'y' + 'D' + ...`. Such a chain is an AST over a
 * thousand levels deep, and webcrack's recursive passes then overflow the stack now and then
 * (frame sizes vary with what the JIT has compiled), so the result depended on the run. The
 * chains are folded to one literal first (constant folding, text-level edit); the walk uses an
 * explicit stack, so it is not limited by the depth it removes.
 */
const MIN_FOLD_TERMS = 32;
function foldStringConcats(code) {
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true }); } catch { return code; }
  const edits = [];
  const isConcat = (n) => t.isBinaryExpression(n, { operator: '+' });
  const stack = [ast.program];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    if (isConcat(n)) {
      // left spine of string literals: (((s0 + s1) + s2) + ...)
      const parts = [];
      let x = n;
      while (isConcat(x) && t.isStringLiteral(x.right)) { parts.push(x.right.value); x = x.left; }
      if (t.isStringLiteral(x) && parts.length + 1 >= MIN_FOLD_TERMS && !isConcat(x)) {
        parts.push(x.value);
        edits.push({ from: n.start, to: n.end, text: JSON.stringify(parts.reverse().join('')) });
        continue;
      }
    }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
      else if (v && typeof v.type === 'string') stack.push(v);
    }
  }
  if (!edits.length) return code;
  edits.sort((a, b) => b.from - a.from);
  for (const e of edits) code = code.slice(0, e.from) + e.text + code.slice(e.to);
  return code;
}

/**
 * Newer obfuscator.io builds emit the string-array decoder as
 *   function D(i, k) { i = i - 134; const a = ARR(); let s = a[i]; return s; }
 * webcrack only recognises decoders whose first statement is `const a = ARR()`. The index
 * shift does not depend on `a`, so the two statements are swapped (text-level edit, the
 * rest of the file stays byte-identical).
 */
function hoistDecoderArrayLoads(code) {
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true }); } catch { return code; }
  // string-array functions: function F() { const K = ['..', ...]; F = function () { return K; }; return F(); }
  const arrayFns = new Set();
  for (const st of ast.program.body) {
    if (!t.isFunctionDeclaration(st) || st.params.length) continue;
    const b = st.body.body;
    if (b.length === 3 && t.isVariableDeclaration(b[0]) && t.isArrayExpression(b[0].declarations[0].init) &&
        b[0].declarations[0].init.elements.every((e) => t.isStringLiteral(e)) &&
        t.isExpressionStatement(b[1]) && t.isAssignmentExpression(b[1].expression) && t.isIdentifier(b[1].expression.left, { name: st.id.name })) arrayFns.add(st.id.name);
  }
  if (!arrayFns.size) return code;
  const edits = [];
  t.traverseFast(ast, (fn) => {
    if (!t.isFunctionDeclaration(fn)) return;
    const b = fn.body.body;
    const k = b.findIndex((x) => t.isVariableDeclaration(x) && x.declarations.length === 1 && t.isIdentifier(x.declarations[0].id) &&
      t.isCallExpression(x.declarations[0].init) && t.isIdentifier(x.declarations[0].init.callee) && arrayFns.has(x.declarations[0].init.callee.name) && !x.declarations[0].init.arguments.length);
    if (k <= 0) return;
    const name = b[k].declarations[0].id.name;
    let refs = false;
    for (const x of b.slice(0, k)) t.traverseFast(x, (n) => { if (t.isIdentifier(n, { name })) refs = true; });
    if (refs) return;
    edits.push({ from: b[k].start, to: b[k].end, at: b[0].start });
  });
  if (!edits.length) return code;
  edits.sort((a, b) => b.from - a.from);
  for (const e of edits) {
    const text = code.slice(e.from, e.to);
    code = code.slice(0, e.from) + code.slice(e.to);
    code = code.slice(0, e.at) + text + code.slice(e.at);
  }
  return code;
}

/**
 * Control-flow flattening without a string array. obfuscator.io >= 8.4 also flattens the VM
 * runtime itself; webcrack (2.15) undoes control-flow flattening only inside its string-array
 * pass, so with "Control Flow Flattening" but no "String Array" the interpreter stays hidden in
 * `"3|1|0".split("|")` dispatchers driven by a storage object of strings and operator proxies.
 * This mirrors webcrack's control-flow-object and control-flow-switch transforms: inline the
 * storage object (only when every use is a read of a known key; proxies only as direct calls with
 * matching arity) and replace each dispatcher at the start of a block by its cases in sequence.
 * Runs only when dispatchers survived webcrack, so other inputs are untouched.
 */
const STORAGE_KEY = /^[a-z]{5}$/i;
function isProxyFn(v) {
  if (!t.isFunctionExpression(v) || v.async || v.generator || !v.params.every((p) => t.isIdentifier(p))) return false;
  const body = v.body.body;
  if (body.length !== 1 || !t.isReturnStatement(body[0]) || !body[0].argument) return false;
  const e = body[0].argument, ps = v.params.map((p) => p.name);
  const isP = (n, i) => t.isIdentifier(n, { name: ps[i] });
  if ((t.isBinaryExpression(e) || t.isLogicalExpression(e)) && ps.length === 2) return (isP(e.left, 0) && isP(e.right, 1)) || (isP(e.left, 1) && isP(e.right, 0));
  if (t.isCallExpression(e) && ps.length >= 1 && isP(e.callee, 0)) return e.arguments.length === ps.length - 1 && e.arguments.every((a, i) => isP(a, i + 1));
  return false;
}
function inlineProxy(fn, args) {
  const map = new Map(fn.params.map((p, i) => [p.name, args[i]]));
  const e = t.cloneNode(fn.body.body[0].argument, true);
  const sub = (n) => (t.isIdentifier(n) && map.has(n.name) ? map.get(n.name) : n);
  if (t.isCallExpression(e)) { e.callee = sub(e.callee); e.arguments = e.arguments.map(sub); } else { e.left = sub(e.left); e.right = sub(e.right); }
  return e;
}
function unflattenControlFlow(code) {
  if (!/\.split\("\|"\)/.test(code)) return code;
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true }); } catch { return code; }
  let changes = 0;
  traverse(ast, {
    VariableDeclarator: { exit(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isObjectExpression(init) || !init.properties.length) return;
      const props = new Map();
      for (const pr of init.properties) {
        if (!t.isObjectProperty(pr) || pr.computed) return;
        const key = t.isIdentifier(pr.key) ? pr.key.name : t.isStringLiteral(pr.key) ? pr.key.value : null;
        if (!key || !STORAGE_KEY.test(key) || !(t.isStringLiteral(pr.value) || isProxyFn(pr.value))) return;
        props.set(key, pr.value);
      }
      const b = p.scope.getBinding(id.name);
      if (!b || !b.constant || b.path !== p) return;
      const uses = [];
      for (const r of b.referencePaths) {
        const m = r.parentPath;
        if (!m.isMemberExpression() || m.node.object !== r.node) return;
        const key = !m.node.computed && t.isIdentifier(m.node.property) ? m.node.property.name : t.isStringLiteral(m.node.property) ? m.node.property.value : null;
        const v = key !== null ? props.get(key) : undefined;
        if (!v) return;
        const call = m.parentPath;
        if (t.isStringLiteral(v)) {
          if ((call.isAssignmentExpression() && call.node.left === m.node) || call.isUpdateExpression() || call.isUnaryExpression({ operator: 'delete' }) || (call.isCallExpression() && call.node.callee === m.node)) return;
        } else if (!(call.isCallExpression() && call.node.callee === m.node && call.node.arguments.length === v.params.length && !call.node.arguments.some((a) => t.isSpreadElement(a)))) return;
        uses.push({ m, v });
      }
      for (const { m, v } of uses.reverse()) {
        if (t.isStringLiteral(v)) m.replaceWith(t.stringLiteral(v.value));
        else m.parentPath.replaceWith(inlineProxy(v, m.parentPath.node.arguments));
      }
      p.remove();
      changes++;
    } },
    BlockStatement: { exit(p) {
      const body = p.node.body;
      const [d, it, loop] = body;
      if (!t.isVariableDeclaration(d) || d.declarations.length !== 1 || !t.isIdentifier(d.declarations[0].id)) return;
      const init = d.declarations[0].init;
      if (!t.isCallExpression(init) || !t.isMemberExpression(init.callee) || !t.isStringLiteral(init.callee.object) || !/^\d+(\|\d+)*$/.test(init.callee.object.value) ||
          !(t.isIdentifier(init.callee.property, { name: 'split' }) || t.isStringLiteral(init.callee.property, { value: 'split' })) || init.arguments.length !== 1 || !t.isStringLiteral(init.arguments[0], { value: '|' })) return;
      if (!t.isVariableDeclaration(it) || it.declarations.length !== 1 || !t.isIdentifier(it.declarations[0].id)) return;
      const seq = d.declarations[0].id.name, idx = it.declarations[0].id.name;
      const infinite = (t.isWhileStatement(loop) && (t.isBooleanLiteral(loop.test, { value: true }) || t.isUnaryExpression(loop.test, { operator: '!' }))) || (t.isForStatement(loop) && !loop.test);
      if (!infinite || !t.isBlockStatement(loop.body) || loop.body.body.length !== 2 || !t.isSwitchStatement(loop.body.body[0]) || !t.isBreakStatement(loop.body.body[1]) || loop.body.body[1].label) return;
      const sw = loop.body.body[0];
      if (!t.isMemberExpression(sw.discriminant, { computed: true }) || !t.isIdentifier(sw.discriminant.object, { name: seq }) ||
          !t.isUpdateExpression(sw.discriminant.property, { operator: '++' }) || !t.isIdentifier(sw.discriminant.property.argument, { name: idx })) return;
      const cases = new Map();
      for (const c of sw.cases) {
        if (!t.isStringLiteral(c.test) || !/^\d+$/.test(c.test.value)) return;
        const last = c.consequent[c.consequent.length - 1];
        if (!(t.isContinueStatement(last) && !last.label) && !t.isReturnStatement(last)) return;
        cases.set(c.test.value, t.isContinueStatement(last) ? c.consequent.slice(0, -1) : c.consequent);
      }
      const order = init.callee.object.value.split('|');
      if (!order.every((s) => cases.has(s))) return;
      body.splice(0, 3, ...order.flatMap((s) => cases.get(s)));
      changes++;
    } },
  });
  return changes ? generate(ast, { comments: false, jsescOption: { minimal: true } }).code : code;
}

async function normalize(code, { skipWebcrack = false, log = () => {} } = {}) {
  if (skipWebcrack) return code;
  const cracked = await runWebcrack(hoistDecoderArrayLoads(foldStringConcats(code)), log);
  let out = unflattenControlFlow(cracked);
  // the inlined strings and proxies leave `o["key"]`, `!(a === b)` etc.: let webcrack's syntactic
  // passes bring them into the same normal form as the rest of the file
  if (out !== cracked) {
    try { out = (await webcrack(out, { jsx: false, unpack: false, unminify: true, deobfuscate: false, mangle: false })).code; } catch (e) { log(`webcrack unminify after control-flow unflattening failed (${e.message})`); }
  }
  return inlineLiteralTemps(out);
}

const WEBCRACK_OPTS = {
  jsx: false,
  unpack: false, // the VM file is a single script, not a bundle
  unminify: true,
  deobfuscate: true,
  mangle: false,
};

/**
 * webcrack's passes recurse over the AST; "Split Strings" builds produce concatenation chains
 * thousands of operands deep, which overflow the default stack. Such inputs are normalized in
 * a worker thread with a large stack.
 */
function webcrackInWorker(code) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { code }, resourceLimits: { stackSizeMb: 256 } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m.code)));
    w.once('error', reject);
  });
}

async function runWebcrack(code, log) {
  try {
    const result = await webcrack(code, { ...WEBCRACK_OPTS, sandbox: nodeVmSandbox });
    return result.code;
  } catch (e) {
    if (e instanceof RangeError && /call stack/.test(e.message)) {
      // inputs close to the stack limit overflow only now and then (frame sizes vary with what the
      // JIT has compiled); a second attempt usually fits, and the browser build has no worker
      try {
        const result = await webcrack(code, { ...WEBCRACK_OPTS, sandbox: nodeVmSandbox });
        return result.code;
      } catch (e1) {
        if (!(e1 instanceof RangeError)) log(`webcrack retry failed (${e1.message})`);
      }
      try {
        return await webcrackInWorker(code);
      } catch (e2) {
        log(`webcrack failed in a large-stack worker too (${e2.message})`);
      }
    }
    // e.g. a string-array rotation whose decoder webcrack did not recognise never
    // terminates in the sandbox; the syntactic unminify passes are all the VM stages need
    log(`webcrack deobfuscation failed (${e.message}); retrying with unminify only`);
  }
  try {
    const result = await webcrack(code, { jsx: false, unpack: false, unminify: true, deobfuscate: false, mangle: false });
    return result.code;
  } catch (e) {
    log(`webcrack failed (${e.message}); continuing with the raw source`);
    return code;
  }
}

module.exports = { normalize, inlineLiteralTemps };

// worker entry (see webcrackInWorker)
const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && typeof wt.workerData.code === 'string') {
  webcrack(wt.workerData.code, { ...WEBCRACK_OPTS, sandbox: nodeVmSandbox })
    .then((r) => wt.parentPort.postMessage({ code: r.code }))
    .catch((e) => wt.parentPort.postMessage({ error: String(e && e.message || e) }));
}
