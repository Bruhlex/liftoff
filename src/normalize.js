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

async function normalize(code, { skipWebcrack = false, log = () => {} } = {}) {
  if (skipWebcrack) return code;
  return inlineLiteralTemps(await runWebcrack(hoistDecoderArrayLoads(code), log));
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
