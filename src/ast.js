// Small AST helpers shared by the lifter and the emitter.
'use strict';

const t = require('@babel/types');
const generate = require('@babel/generator').default;

/** compact source text of a node, used to compare expressions */
const gen = (node) => generate(node, { compact: true, comments: false }).code;

const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));
const isIdentName = (s) => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s) && !RESERVED.has(s);

function countIdent(nodes, name) {
  let c = 0;
  for (const n of [].concat(nodes)) t.traverseFast(n, (x) => { if (t.isIdentifier(x, { name })) c++; });
  return c;
}

function referencesName(node, name) {
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) hit = true; });
  return hit;
}

function countIdentity(tree, node) {
  let c = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n === node) { c++; return; }
    for (const k of t.VISITOR_KEYS[n.type] || []) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v); }
  };
  walk(tree);
  return c;
}

function replaceIdentity(tree, node, rep) {
  if (tree === node) return rep;
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x, i) => { if (x === node) v[i] = t.cloneNode(rep); else walk(x); });
      else if (v === node) n[k] = t.cloneNode(rep);
      else walk(v);
    }
  };
  walk(tree);
  return tree;
}

module.exports = { gen, isIdentName, countIdent, referencesName, countIdentity, replaceIdentity };
