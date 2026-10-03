'use strict';
/**
 * The surroundings of the interpreter: the global object and the VM namespace the runtime
 * keeps its state in, generator copies of the interpreter, and the opcodes that yield.
 */

const t = require('@babel/types');
const { gen, containsNode, staticKey } = require('../ast');

// ---------------------------------------------------------------------------
// 5. Put it together
// ---------------------------------------------------------------------------

function findGlobalName(ast) {
  // `let vmH = typeof globalThis !== "undefined" ? globalThis : ...`
  for (const st of ast.program.body) {
    if (!t.isVariableDeclaration(st)) continue;
    for (const d of st.declarations) {
      if (t.isIdentifier(d.id) && d.init && containsNode(d.init, (n) => t.isIdentifier(n, { name: 'globalThis' })) && t.isConditionalExpression(d.init)) return d.id.name;
    }
  }
  return null;
}

function findNamespaceName(ast, globalName) {
  // `let vms = vmH.vms || (vmH.vms = {})` / `vmH["vms"] ||= {}`
  for (const st of ast.program.body) {
    if (!t.isVariableDeclaration(st)) continue;
    for (const d of st.declarations) {
      if (t.isIdentifier(d.id) && d.init && containsNode(d.init, (n) => t.isIdentifier(n, { name: globalName })) && d.id.name !== globalName) return d.id.name;
    }
  }
  return null;
}

/** The global property the namespace lives in (`G.KEY || (G.KEY = {})`); VM programs reach it by this name. */
function findNamespaceKey(ast, globalName, nsName) {
  for (const st of ast.program.body) {
    if (!t.isVariableDeclaration(st)) continue;
    for (const d of st.declarations) {
      if (!t.isIdentifier(d.id, { name: nsName }) || !d.init) continue;
      let key = null;
      t.traverseFast(d.init, (n) => {
        if (!key && t.isMemberExpression(n) && t.isIdentifier(n.object, { name: globalName })) key = staticKey(n);
      });
      return key;
    }
  }
  return null;
}

/**
 * The object literal returned in `block`: `return {...}`, or `var o = {...}; return o;` as builds
 * with transformObjectKeys write it.
 */
function returnedObject(block) {
  let found = null;
  t.traverseFast(block, (n) => {
    if (found) return;
    const body = t.isBlockStatement(n) ? n.body : null;
    if (!body) return;
    for (let i = 0; i < body.length && !found; i++) {
      const st = body[i];
      if (!t.isReturnStatement(st)) continue;
      if (t.isObjectExpression(st.argument)) found = st.argument;
      else if (t.isIdentifier(st.argument) && i > 0 && t.isVariableDeclaration(body[i - 1]) && body[i - 1].declarations.length === 1 &&
          t.isIdentifier(body[i - 1].declarations[0].id, { name: st.argument.name }) && t.isObjectExpression(body[i - 1].declarations[0].init)) found = body[i - 1].declarations[0].init;
    }
  });
  if (!found && t.isReturnStatement(block) && t.isObjectExpression(block.argument)) found = block.argument;
  return found;
}

function isGeneratorCopy(inner, fetch) {
  // generator interpreter: `if (op === CONST) { ...; return {...} }` guards before dispatch
  return inner.body.body.some(
    (st) => t.isIfStatement(st) && t.isBinaryExpression(st.test, { operator: '===' }) && t.isIdentifier(st.test.left, { name: fetch.op }) && t.isIdentifier(st.test.right) &&
      returnedObject(st.consequent),
  );
}

function yieldOpcodes(inner, fetch, factoryPath) {
  // returns [{constName, tagName}] for each `if (op === CONST) { let v = pop(); pc++; return { tagProp: TAG, valueProp: v, ... } }`
  const out = [];
  for (const st of inner.body.body) {
    if (!(t.isIfStatement(st) && t.isBinaryExpression(st.test, { operator: '===' }) && t.isIdentifier(st.test.left, { name: fetch.op }) && t.isIdentifier(st.test.right))) continue;
    const ret = returnedObject(st.consequent);
    if (!ret) continue;
    // first property whose value is an identifier that is a factory-level constant
    let tag = null, tagKey = null;
    for (const p of ret.properties) {
      if (t.isIdentifier(p.value)) {
        const b = factoryPath.scope.getBinding(p.value.name);
        if (b && b.path.isVariableDeclarator() && t.isNumericLiteral(b.path.node.init)) { tag = b.path.node.init.value; tagKey = t.isIdentifier(p.key) ? p.key.name : p.key.value; break; }
      }
    }
    const cb = factoryPath.scope.getBinding(st.test.right.name);
    const opcode = cb && cb.path.isVariableDeclarator() && t.isNumericLiteral(cb.path.node.init) ? cb.path.node.init.value : null;
    out.push({ opcode, tag, tagKey });
  }
  return out;
}

/**
 * Determine which of the yield tags means await / yield / yield*.
 * The async runner throws "Unexpected yield in async context" unless the tag equals the AWAIT tag;
 * the generator runner treats one tag as a plain yield (returns {value, done:false}) and the other as
 * delegation (looks up Symbol.iterator).
 */
function resolveYieldTags(factoryPath, tagKey) {
  const result = { await: null, yield: null, yieldStar: null };
  if (!tagKey) return result;
  const src = gen(factoryPath.node);
  const esc = tagKey.replace(/\$/g, '\\$');
  // async runner: `if (X.tag !== T) throw new Error("Unexpected yield in async context")`
  let m = src.match(new RegExp(`\\.${esc}!==(\\w+)\\)\\{?throw new Error\\("Unexpected yield in async context"`));
  const constVal = (name) => {
    const b = factoryPath.scope.getBinding(name);
    return b && b.path.isVariableDeclarator() && t.isNumericLiteral(b.path.node.init) ? b.path.node.init.value : null;
  };
  if (m) result.await = constVal(m[1]);
  // generator runner: `if (x.tag === X) { return { value: x.val, done: false } }` and `if (x.tag === D) { let it = x.val; ... Symbol.iterator`
  const re = new RegExp(`\\.${esc}===(\\w+)\\)\\{`, 'g');
  let mm;
  const seen = new Map();
  const blockAfter = (pos) => {
    // pos points at the `{` that opens the block; return its text (brace matching, string-aware)
    let depth = 0, i = pos, q = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') q = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(pos, i + 1);
  };
  while ((mm = re.exec(src))) {
    const after = blockAfter(mm.index + mm[0].length - 1);
    const v = constVal(mm[1]);
    if (v === null || v === result.await) continue;
    if (/Symbol\.iterator|is not iterable/.test(after)) seen.set(v, 'yieldStar');
    else if (/done:false/.test(after) && !seen.has(v)) seen.set(v, 'yield');
  }
  for (const [v, kind] of seen) if (!result[kind]) result[kind] = v;
  return result;
}

module.exports = { findGlobalName, findNamespaceName, findNamespaceKey, isGeneratorCopy, yieldOpcodes, resolveYieldTags };
