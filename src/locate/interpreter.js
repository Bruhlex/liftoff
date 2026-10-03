'use strict';
/**
 * Find the interpreter loops by their fetch-decode-execute shape, decode the fetch
 * statements, and collect the opcode handlers of every dispatch switch inside them.
 */

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { gen } = require('../ast');

// ---------------------------------------------------------------------------
// 1. Find the interpreter loops
// ---------------------------------------------------------------------------

function sameIdentTest(a, b) {
  return (
    t.isBinaryExpression(a, { operator: '<' }) &&
    t.isBinaryExpression(b, { operator: '<' }) &&
    t.isIdentifier(a.left) && t.isIdentifier(b.left) && a.left.name === b.left.name &&
    t.isIdentifier(a.right) && t.isIdentifier(b.right) && a.right.name === b.right.name
  );
}

function firstStatement(block) {
  return t.isBlockStatement(block) ? block.body[0] : block;
}

function findInterpreterLoops(ast) {
  const found = [];
  traverse(ast, {
    WhileStatement(path) {
      const outer = path.node;
      if (!t.isBinaryExpression(outer.test, { operator: '<' })) return;
      const tryStmt = firstStatement(outer.body);
      if (!t.isTryStatement(tryStmt)) return;
      const inner = tryStmt.block.body[0];
      if (!t.isWhileStatement(inner) || !sameIdentTest(outer.test, inner.test)) return;
      found.push({ outerPath: path, inner, tryStmt });
    },
  });
  return found;
}

/** Decode the fetch statements at the top of the inner loop body. */
function parseFetch(inner, pc) {
  const decls = [];
  for (const st of inner.body.body) {
    if (!t.isVariableDeclaration(st)) break;
    decls.push(...st.declarations);
  }
  let idx, shift, code, opBase, operBase, op, operand;
  for (const d of decls) {
    if (!t.isIdentifier(d.id) || !d.init) continue;
    // let idx = pc << shift
    if (t.isBinaryExpression(d.init, { operator: '<<' }) && t.isIdentifier(d.init.left, { name: pc })) {
      idx = d.id.name;
      shift = d.init.right;
      continue;
    }
    // let op = code[base + idx]
    if (
      idx &&
      t.isMemberExpression(d.init, { computed: true }) &&
      t.isIdentifier(d.init.object) &&
      t.isBinaryExpression(d.init.property, { operator: '+' }) &&
      t.isIdentifier(d.init.property.right, { name: idx })
    ) {
      if (!op) {
        code = d.init.object.name;
        opBase = d.init.property.left;
        op = d.id.name;
      } else if (!operand) {
        operBase = d.init.property.left;
        operand = d.id.name;
      }
    }
  }
  if (!op || !operand) throw new Error('VM loop found but the fetch statements do not match the expected shape');
  return { idx, shift: gen(shift), code, opBase: gen(opBase), operBase: gen(operBase), op, operand };
}

// ---------------------------------------------------------------------------
// 2. Collect opcode handlers from every dispatch switch inside the interpreter
// ---------------------------------------------------------------------------

function numericCaseValue(test) {
  if (t.isNumericLiteral(test)) return test.value;
  if (t.isUnaryExpression(test, { operator: '-' }) && t.isNumericLiteral(test.argument)) return -test.argument.value;
  return null;
}

/**
 * Handlers live either directly in a `switch (op)` in the loop body, or in
 * lazily created dispatch functions `R8 = function (opParam, operandParam) { switch (opParam) ... }`
 * that are invoked as `R8(op, operand)`. This resolves both.
 */
function collectHandlers(fnPath, fetch) {
  const handlers = [];
  const switches = [];
  fnPath.traverse({
    SwitchStatement(p) {
      const numeric = p.node.cases.filter((c) => c.test && numericCaseValue(c.test) !== null);
      if (numeric.length < 8) return;
      switches.push(p);
    },
  });

  for (const sp of switches) {
    let opVar, operandVar;
    let disc = sp.node.discriminant;
    // indirect dispatch: switch (MAP[op]) { case idx: ... } with MAP an array literal opcode -> idx
    let caseToOpcode = null;
    if (t.isMemberExpression(disc, { computed: true }) && t.isIdentifier(disc.object) && t.isIdentifier(disc.property, { name: fetch.op })) {
      const mapName = disc.object.name;
      let lit = null;
      fnPath.traverse({
        AssignmentExpression(ap) { if (!lit && t.isIdentifier(ap.node.left, { name: mapName }) && t.isArrayExpression(ap.node.right)) lit = ap.node.right; },
        VariableDeclarator(dp) { if (!lit && t.isIdentifier(dp.node.id, { name: mapName }) && t.isArrayExpression(dp.node.init)) lit = dp.node.init; },
      });
      if (!lit) continue;
      caseToOpcode = new Map();
      lit.elements.forEach((e, opcode) => { if (t.isNumericLiteral(e) && e.value !== 0) caseToOpcode.set(e.value, opcode); });
      disc = t.identifier(fetch.op);
    }
    if (!t.isIdentifier(disc)) continue;
    if (disc.name === fetch.op) {
      opVar = fetch.op;
      operandVar = fetch.operand;
    } else {
      // dispatch function: find the enclosing function whose param is `disc`
      const fn = sp.getFunctionParent();
      if (!fn) continue;
      const params = fn.node.params.map((x) => (t.isIdentifier(x) ? x.name : null));
      const pi = params.indexOf(disc.name);
      if (pi < 0) continue;
      // find how this function is called: X(op, operand)
      let calleeName = null;
      if (t.isAssignmentExpression(fn.parent) && t.isIdentifier(fn.parent.left)) calleeName = fn.parent.left.name;
      else if (t.isVariableDeclarator(fn.parent) && t.isIdentifier(fn.parent.id)) calleeName = fn.parent.id.name;
      else if (t.isFunctionDeclaration(fn.node)) calleeName = fn.node.id.name;
      let argOrder = null;
      if (calleeName) {
        fnPath.traverse({
          CallExpression(cp) {
            if (argOrder) return;
            if (t.isIdentifier(cp.node.callee, { name: calleeName })) {
              argOrder = cp.node.arguments.map((a) => (t.isIdentifier(a) ? a.name : null));
            }
          },
        });
      }
      if (argOrder) {
        const oi = argOrder.indexOf(fetch.op);
        const ai = argOrder.indexOf(fetch.operand);
        if (oi >= 0 && ai >= 0) {
          opVar = params[oi];
          operandVar = params[ai];
        }
      }
      if (!opVar) {
        // fall back: two params, first is opcode
        opVar = params[pi];
        operandVar = params.find((x, i) => i !== pi) || null;
      }
    }
    for (const c of sp.node.cases) {
      if (!c.test) continue;
      let opcode = numericCaseValue(c.test);
      if (opcode === null) continue;
      if (caseToOpcode) { if (!caseToOpcode.has(opcode)) continue; opcode = caseToOpcode.get(opcode); }
      let body = c.consequent;
      if (body.length === 1 && t.isBlockStatement(body[0])) body = body[0].body;
      handlers.push({ opcode, body, opVar, operandVar, switchNode: sp.node });
    }
  }
  return handlers;
}

module.exports = { findInterpreterLoops, parseFetch, collectHandlers };
