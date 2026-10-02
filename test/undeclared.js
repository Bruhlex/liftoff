#!/usr/bin/env node
'use strict';
/**
 * Finds assignments to identifiers that are declared nowhere in a decompiled file. Such an
 * assignment creates an implicit global (or throws in strict mode), which means the decompiler
 * lost a declaration, e.g. a block-scoped variable inside a loop.
 *   node test/undeclared.js <file.dec.js> ...
 */
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function check(file) {
  const code = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true }); }
  catch (e) { return [`parse error: ${e.message}`]; }
  const hits = [];
  traverse(ast, {
    AssignmentExpression(p) {
      const left = p.node.left;
      if (left.type !== 'Identifier') return;
      if (!p.scope.hasBinding(left.name, true) && !(left.name in globalThis)) {
        hits.push(`${left.name} (line ${left.loc.start.line})`);
      }
    },
    UpdateExpression(p) {
      const a = p.node.argument;
      if (a.type === 'Identifier' && !p.scope.hasBinding(a.name, true) && !(a.name in globalThis)) hits.push(`${a.name}++ (line ${a.loc.start.line})`);
    },
  });
  return hits;
}

module.exports = { check };

if (require.main === module) {
  let total = 0;
  for (const f of process.argv.slice(2)) {
    const hits = check(f);
    if (hits.length) { total++; console.log(`${f}: ${[...new Set(hits)].slice(0, 8).join(', ')}`); }
  }
  console.log(`${total} file(s) with undeclared assignments`);
}
