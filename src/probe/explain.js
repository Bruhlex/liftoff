'use strict';
/**
 * Explaining observations: candidate expressions (copy, unary, binary operator, literal,
 * fresh object) over the values a handler read, and the normalization of observations to the
 * operand fields they came from.
 */

const { SP0, PC0, JUMP_TARGET } = require('./observe');

// ---------------------------------------------------------------------------
// expression candidates
// ---------------------------------------------------------------------------

const UNARY = [
  ['-', (a) => -a], ['+', (a) => +a], ['!', (a) => !a], ['~', (a) => ~a], ['typeof', (a) => typeof a], ['void', () => undefined],
  ['inc', (a) => (typeof a === 'bigint' ? a + 1n : +a + 1)], ['dec', (a) => (typeof a === 'bigint' ? a - 1n : +a - 1)],
  ['|0', (a) => a | 0], ['>>>0', (a) => a >>> 0], ['String', (a) => String(a)],
  ['!=null', (a) => a !== null && a !== undefined], ['==null', (a) => a === null || a === undefined],
];

const BINARY = [
  ['+', (a, b) => a + b], ['-', (a, b) => a - b], ['*', (a, b) => a * b], ['/', (a, b) => a / b], ['%', (a, b) => a % b], ['**', (a, b) => a ** b],
  ['&', (a, b) => a & b], ['|', (a, b) => a | b], ['^', (a, b) => a ^ b], ['<<', (a, b) => a << b], ['>>', (a, b) => a >> b], ['>>>', (a, b) => a >>> b],
  ['===', (a, b) => a === b], ['!==', (a, b) => a !== b], ['==', (a, b) => a == b], ['!=', (a, b) => a != b], // eslint-disable-line eqeqeq
  ['<', (a, b) => a < b], ['>', (a, b) => a > b], ['<=', (a, b) => a <= b], ['>=', (a, b) => a >= b],
];

const same = (x, y) => Object.is(x, y);

const safe = (f) => { try { return { ok: true, v: f() }; } catch { return { ok: false }; } };

/** Deeper stack slots first (natural left-to-right operand order), then R, A, scope, K, operand values. */
function orderLeaves(keys) {
  const rank = (k) => {
    const m = /^S:(\d+)$/.exec(k);
    if (m) return [0, -Number(m[1])];
    const order = ['R', 'A', 'C', 'K', 'OPV'];
    return [1 + order.indexOf(k.split(':')[0].replace(/\d+$/, '')), 0];
  };
  return keys.slice().sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
}

function* candidates(leafKeys) {
  for (const k of leafKeys) yield { expr: { k: 'leaf', key: k }, ev: (L) => L[k] };
  yield { expr: { k: 'lit', v: undefined }, ev: () => undefined };
  yield { expr: { k: 'lit', v: null }, ev: () => null };
  yield { expr: { k: 'lit', v: true }, ev: () => true };
  yield { expr: { k: 'lit', v: false }, ev: () => false };
  for (const k of leafKeys) for (const [op, f] of UNARY) yield { expr: { k: 'un', op, a: { k: 'leaf', key: k } }, ev: (L) => f(L[k]) };
  for (const a of leafKeys) for (const b of leafKeys) {
    if (a === b) continue;
    for (const [op, f] of BINARY) yield { expr: { k: 'bin', op, a: { k: 'leaf', key: a }, b: { k: 'leaf', key: b } }, ev: (L) => f(L[a], L[b]) };
  }
}

function explain(samples, leafKeys, { truthy = false } = {}) {
  for (const c of candidates(leafKeys)) {
    let ok = true;
    for (const s of samples) {
      const r = safe(() => c.ev(s.L));
      if (!r.ok || (truthy ? !!r.v !== !!s.v : !same(r.v, s.v))) { ok = false; break; }
    }
    if (ok) return c.expr;
  }
  return null;
}

function isPlainFresh(v, arr) {
  if (!v || typeof v !== 'object') return false;
  if (arr) return Array.isArray(v) && v.length === 0;
  const p = Object.getPrototypeOf(v);
  return !Array.isArray(v) && p && Object.getPrototypeOf(p) === null && p.constructor && p.constructor.name === 'Object' && Reflect.ownKeys(v).length === 0;
}

function explainValues(samples, leafKeys) {
  const e = explain(samples, leafKeys);
  if (e) return e;
  if (samples.every((s) => isPlainFresh(s.v, true))) return { k: 'fresh', kind: 'arr' };
  if (samples.every((s) => isPlainFresh(s.v, false))) return { k: 'fresh', kind: 'obj' };
  return null;
}

// ---------------------------------------------------------------------------
// normalization of observations
// ---------------------------------------------------------------------------

function fieldOf(idx, operand) {
  if (idx === operand) return 'op';
  if (idx === (operand & 0xffff)) return 'lo';
  if (idx === operand >>> 16) return 'hi';
  return `#${idx}`;
}

function leafKeyOf(tag, idx, operand) {
  if (tag === 'S') return `S:${SP0 - 1 - idx}`;
  const m = /^C(\d+)$/.exec(tag);
  if (m) return `C${fieldOf(Number(m[1]), operand)}:${fieldOf(idx, operand)}`;
  return `${tag}:${fieldOf(idx, operand)}`;
}

function normalize(obs, operand, env) {
  const leaves = {};
  for (const [tag, idx] of obs.reads) {
    if (tag === 'J') continue;
    if (tag === 'S' && (idx >= SP0 || idx < 0)) continue;
    const key = leafKeyOf(tag, idx, operand);
    if (!(key in leaves)) leaves[key] = env.value(tag, idx);
  }
  let low = obs.sp;
  for (const [tag, idx] of obs.reads) if (tag === 'S' && idx < low) low = idx;
  for (const [tag, idx] of obs.writes) if (tag === 'S' && idx < low) low = idx;
  low = Math.min(low, SP0);
  const pushed = [];
  for (let i = low; i < obs.sp; i++) pushed.push(obs.stack[i]);
  const stores = {};
  for (const [tag, idx, v] of obs.writes) if (tag !== 'S') stores[leafKeyOf(tag, idx, operand)] = v;
  let pcKind = 'other';
  if (obs.pc === PC0 + 1) pcKind = 'next';
  else if (obs.pc === JUMP_TARGET) pcKind = 'jump';
  leaves['OPV:lo'] = operand & 0xffff;
  leaves['OPV:hi'] = operand >>> 16;
  return { leaves, pops: SP0 - low, pushed, stores, pcKind };
}

module.exports = { normalize, orderLeaves, explainValues, explain };
