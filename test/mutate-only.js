#!/usr/bin/env node
'use strict';
/**
 * Robustness experiment: simulate a new code-generator version.
 *
 * Takes a VM-protected sample, rewrites every opcode handler with
 * semantics-preserving transformations that a new obfuscator release could
 * plausibly make, checks that the mutated file still behaves like the
 * original, and then runs the decompiler on the mutated file.
 *
 *   node test/mutate.js <sample.js> [--level 1|2|3] [-o mutated.js]
 *
 * levels (cumulative):
 *   1  `x++;` statements  ->  `x += 1;`   (breaks almost every text rule)
 *   2  + `a < b` -> `b > a` etc. for identifier operands, `if (c) A else B` -> `if (!c) B else A`
 *   3  + `let a = X, b = Y;` split into single declarations and handler statements
 *        wrapped in an extra block
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { normalize } = require('../src/normalize');
const { locate } = require('../src/locate');

const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '===': '===', '!==': '!==', '==': '==', '!=': '!=' };

function mutateNode(root, level, stats) {
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          let c = v[i];
          // level 1: `x++;` -> `x += 1;`
          if (t.isExpressionStatement(c) && t.isUpdateExpression(c.expression) && t.isIdentifier(c.expression.argument)) {
            v[i] = c = t.expressionStatement(t.assignmentExpression(c.expression.operator === '++' ? '+=' : '-=', c.expression.argument, t.numericLiteral(1)));
            stats.inc++;
          }
          // level 3: split multi-declarations
          if (level >= 3 && t.isVariableDeclaration(c) && c.declarations.length > 1) {
            const parts = c.declarations.map((d) => t.variableDeclaration(c.kind, [d]));
            v.splice(i, 1, ...parts);
            stats.split++;
            c = v[i];
          }
          walk(c);
        }
      } else if (v && typeof v.type === 'string') {
        // level 2: flip comparisons with identifier operands
        if (level >= 2 && t.isBinaryExpression(v) && FLIP[v.operator] && t.isIdentifier(v.left) && t.isIdentifier(v.right)) {
          n[k] = t.binaryExpression(FLIP[v.operator], v.right, v.left);
          stats.flip++;
          walk(n[k]);
          continue;
        }
        // level 2: invert if/else
        if (level >= 2 && t.isIfStatement(v) && v.alternate && !t.isIfStatement(v.alternate)) {
          n[k] = t.ifStatement(t.unaryExpression('!', v.test), v.alternate, v.consequent);
          stats.ifs++;
          walk(n[k]);
          continue;
        }
        walk(v);
      }
    }
  };
  walk(root);
}

async function mutateFile(file, level, out) {
  const code = await normalize(fs.readFileSync(file, 'utf8'));
  const vm = locate(code);
  const stats = { handlers: 0, inc: 0, flip: 0, ifs: 0, split: 0 };
  const seen = new Set();
  for (const h of vm.handlers) {
    if (seen.has(h.body)) continue;
    seen.add(h.body);
    stats.handlers++;
    const holder = t.blockStatement(h.body.slice());
    mutateNode(holder, level, stats);
    h.body.length = 0;
    h.body.push(...holder.body);
    if (level >= 3) {
      const last = h.body[h.body.length - 1];
      const tail = last && (t.isBreakStatement(last) || t.isContinueStatement(last)) && !last.label ? [h.body.pop()] : [];
      const inner = h.body.splice(0, h.body.length);
      h.body.push(t.blockStatement(inner), ...tail);
    }
  }
  fs.writeFileSync(out, generate(vm.ast, { comments: false }).code);
  return stats;
}

module.exports = { mutateFile, mutateNode };

if (require.main === module) {
  const [file, level, out] = process.argv.slice(2);
  mutateFile(file, Number(level), out).then((st) => console.log(JSON.stringify(st))).catch((e) => { console.error(e); process.exit(1); });
}
