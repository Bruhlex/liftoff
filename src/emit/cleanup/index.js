'use strict';
/**
 * Readability passes over the assembled program, run to a fixpoint: `x = x + 1` -> `x++`,
 * `let x; x = v` -> `let x = v`, template literals, declarations moved to where they are used,
 * propagated temporaries, function declarations, loops; and the `"use strict"` directives that
 * the result does not need. They depend neither on the VM nor on the obfuscator.
 */

const t = require('@babel/types');
const { rewriteExpressions, arrowExpressionBodies } = require('./expressions');
const { nameFunctionHolders, rewriteBlocks, rewriteParams, restorePatternParams, forOfPatterns, dropUnusedLets } = require('./declarations');
const { rewriteBindings, propagateTempBinding, functionHolderBinding } = require('./bindings');
const { loopCleanup } = require('./loops');

/** `"use strict"` is a syntax error in functions with default, rest or destructured parameters. */
function stripIllegalStrict(file) {
  t.traverseFast(file, (n) => {
    if (!t.isFunction(n) || !t.isBlockStatement(n.body) || !n.body.directives || !n.body.directives.length) return;
    if (n.params.every((p) => t.isIdentifier(p))) return;
    n.body.directives = n.body.directives.filter((d) => d.value.value !== 'use strict');
  });
}

/** `"use strict"` of a function inside strict code (a strict function, a class, a strict
 *  program) changes nothing: drop it. (It also changes `fn.toString()`: equal functions at
 *  different depths would otherwise print differently.) */
function stripRedundantStrict(file) {
  const isStrictDir = (d) => d.value.value === 'use strict';
  const walk = (n, strict) => {
    if (!n || typeof n.type !== 'string') return;
    if (t.isProgram(n)) strict = strict || n.directives.some(isStrictDir);
    if (t.isClass(n)) strict = true;
    if (t.isFunction(n) && t.isBlockStatement(n.body)) {
      if (strict) n.body.directives = n.body.directives.filter((d) => !isStrictDir(d));
      else strict = n.body.directives.some(isStrictDir);
    }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, strict)); else walk(v, strict);
    }
  };
  walk(file.program || file, false);
}

// ---------------------------------------------------------------------------
// cleanup passes
// ---------------------------------------------------------------------------

function cleanup(file) {
  if (process.env.VMDEC_NOCLEANUP) return;
  rewriteExpressions(file);
  nameFunctionHolders(file);
  rewriteBlocks(file);
  rewriteParams(file);
  rewriteBindings(file, propagateTempBinding); // single-assignment temporaries holding constant expressions
  rewriteBindings(file, functionHolderBinding); // `r0 = function name(){}` -> `function name(){}`
  rewriteParams(file);
  restorePatternParams(file);
  arrowExpressionBodies(file);
  forOfPatterns(file);
  stripIllegalStrict(file); // default-parameter conversion can make parameter lists non-simple
  dropUnusedLets(file);
  loopCleanup(file);
}

module.exports = { stripIllegalStrict, stripRedundantStrict, cleanup };
