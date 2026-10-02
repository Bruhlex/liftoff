'use strict';
/**
 * Behavioural opcode inference.
 *
 * For an opcode whose handler text matches no known shape, the handler is
 * executed through the VM's own dispatch (the synthesized `step` function, see
 * extract.js) under many controlled machine states, and its effect is
 * reconstructed from observation alone. Three probe families exist:
 *
 *  1. data probe - stack, registers, arguments, constants and the scope chain
 *     are replaced by index-logging proxies filled with chosen values (random
 *     numbers, numeric strings, equal values, 0, null, undefined, ...).
 *     Everything the handler leaves on the stack or writes to a register /
 *     argument / scope slot is explained as a small expression over the values
 *     it read (copy, unary op, binary op, literal, fresh {} / []). The read
 *     index is related to the operand (whole operand, low 16 or high 16 bits).
 *     Conditional jumps are explained by a predicate over the read values.
 *  2. call probe - operand values are callable/constructible proxies; the
 *     single apply/construct trap reveals callee, `this`, arguments and where
 *     the argument count came from.
 *  3. closure probe - a real program object is pushed; a handler that pops it
 *     and pushes a function is the closure constructor.
 *
 * Any effect that cannot be observed and explained (property access on an
 * operand, other interpreter state changing, a thrown error, ...) rejects the
 * inference; the opcode then stays unknown instead of being guessed.
 */

const SP0 = 8; // initial stack pointer
const PC0 = 5; // pc of the probed instruction
const JUMP_TARGET = 700;
const OPERANDS = [(3 << 16) | 5, (6 << 16) | 2, (2 << 16) | 4];
const SCOPE_DEPTH = 10;

// ---------------------------------------------------------------------------
// value environments
// ---------------------------------------------------------------------------

function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function makeEnvironments() {
  const envs = [];
  for (let i = 0; i < 6; i++) {
    const rnd = prng(1234 + i * 7919);
    const used = new Set();
    const cache = new Map();
    envs.push({ kind: 'num', value(tag, idx) {
      const k = `${tag}/${idx}`;
      if (!cache.has(k)) {
        let v;
        do { v = Math.floor(rnd() * 61) - 30; if (i >= 4) v += 0.5; } while (v === 0 || used.has(v));
        used.add(v); cache.set(k, v);
      }
      return cache.get(k);
    } });
  }
  const numOf = envs[0];
  envs.push({ kind: 'str', value: (tag, idx) => (tag === 'K' ? numOf.value(tag, idx) : String(numOf.value(tag, idx))) });
  envs.push({ kind: 'eq', value: () => 4 });
  envs.push({ kind: 'eqstr', value: (tag) => (tag === 'K' ? 4 : '4') });
  envs.push({ kind: 'zero', value: () => 0 });
  envs.push({ kind: 'null', value: () => null });
  envs.push({ kind: 'undef', value: () => undefined });
  envs.push({ kind: 'mixed', value: (tag, idx) => ((idx % 2) ? 0 : 3) });
  envs.push({ kind: 'mixtype', value: (tag, idx) => ((idx % 2) ? 4 : '4') });
  envs.push({ kind: 'mixtype2', value: (tag, idx) => ((idx % 2) ? '4' : 4) });
  return envs;
}

// ---------------------------------------------------------------------------
// state fingerprints (detect effects on anything we do not model)
// ---------------------------------------------------------------------------

function makeFingerprinter(ignore) {
  const ids = new WeakMap();
  let next = 1;
  const idOf = (o) => { if (!ids.has(o)) ids.set(o, next++); return ids.get(o); };
  const fpValue = (v, depth, seen) => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return typeof v === 'symbol' ? 'sym' : `${typeof v}:${String(v)}`;
    if (depth <= 0 || seen.has(v)) return `#${idOf(v)}`;
    seen.add(v);
    let keys;
    try { keys = Reflect.ownKeys(v); } catch { return `#${idOf(v)}`; }
    if (keys.length > 300) return `#${idOf(v)}:${keys.length}`;
    const parts = [];
    for (const k of keys) {
      let d;
      try { d = Object.getOwnPropertyDescriptor(v, k); } catch { continue; }
      if (!d) continue;
      const val = 'value' in d ? fpValue(d.value, depth - 1, seen) : 'accessor';
      parts.push(`${String(k)}=${val}`);
    }
    return `#${idOf(v)}{${parts.join(',')}}`;
  };
  return (snap) => {
    const out = {};
    for (const k of Object.keys(snap)) {
      if (ignore.has(k)) continue;
      const depth = k.startsWith('__outer') ? 1 : 3;
      out[k] = fpValue(snap[k], depth, new Set());
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// one observation
// ---------------------------------------------------------------------------

function makeTrapProxy(key, traps, { callResult } = {}) {
  const target = function () {};
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol') {
        if (k === Symbol.toPrimitive) return () => 7;
        return undefined; // VM-internal symbol tags, iterator lookups are rejected elsewhere
      }
      if (k === 'valueOf') return () => 7;
      if (k === 'toString') return () => '7';
      traps.push(['get', key, k]);
      return undefined;
    },
    set(t, k) { traps.push(['set', key, String(k)]); return true; },
    has(t, k) { traps.push(['has', key, String(k)]); return false; },
    apply(t, thisArg, args) { traps.push(['apply', key, thisArg, args]); return callResult; },
    construct(t, args) { traps.push(['construct', key, args]); return callResult; },
    defineProperty(t, k) { traps.push(['define', key, String(k)]); return true; },
    deleteProperty(t, k) { traps.push(['delete', key, String(k)]); return true; },
    ownKeys() { traps.push(['ownKeys', key]); return ['prototype']; },
    getPrototypeOf() { return Function.prototype; },
  });
}

/**
 * Execute the handler once.
 * mode: 'data' (leaf values from env), 'proxy' (leaves are trap proxies),
 *       'call' (leaves are trap proxies except `numeric` slots which hold `argc`)
 */
function observe(X, prog, opcode, operand, env, ctx, mode = 'data', opts = {}) {
  const reads = [];
  const writes = [];
  const traps = [];
  const leafObjs = new Map();
  const callResult = { __callResult: true };
  const leaf = (tag, idx) => {
    if (mode === 'data') return env.value(tag, idx);
    if (mode === 'call' && opts.numeric && opts.numeric(tag, idx)) return opts.argc;
    const key = `${tag}/${idx}`;
    if (!leafObjs.has(key)) leafObjs.set(key, makeTrapProxy(key, traps, { callResult }));
    return leafObjs.get(key);
  };
  const isIndex = (k) => typeof k === 'string' && /^-?\d+$/.test(k);
  const arrProxy = (tag) => new Proxy([], {
    get(t, k) {
      if (isIndex(k)) {
        const i = Number(k);
        reads.push([tag, i]);
        return i in t ? t[i] : leaf(tag, i);
      }
      if (k === 'length') return 1 << 20;
      return Reflect.get(t, k);
    },
    set(t, k, v) { if (isIndex(k)) writes.push([tag, Number(k), v]); t[k] = v; return true; },
  });
  const stackTarget = [];
  for (let i = 0; i < SP0; i++) stackTarget.push(opts.stackInit ? opts.stackInit(i, leaf) : leaf('S', i));
  const initialStack = stackTarget.slice();
  const stack = new Proxy(stackTarget, {
    get(t, k) { if (isIndex(k)) { reads.push(['S', Number(k)]); return t[Number(k)]; } return Reflect.get(t, k); },
    set(t, k, v) { if (isIndex(k)) writes.push(['S', Number(k), v]); t[k] = v; return true; },
  });
  const jumps = new Proxy({}, {
    get(t, k) { if (isIndex(k)) { reads.push(['J', Number(k)]); return Number(k) === PC0 ? JUMP_TARGET : 800 + Number(k); } return undefined; },
    has() { return true; },
  });
  // scope chain: depth d has a slot array tagged C<d>
  let scope = null;
  if (ctx.scopeProps && ctx.scopeProps.slots && ctx.scopeProps.parent) {
    for (let d = SCOPE_DEPTH - 1; d >= 0; d--) {
      const o = {};
      o[ctx.scopeProps.slots] = arrProxy(`C${d}`);
      if (ctx.scopeProps.constFlags) o[ctx.scopeProps.constFlags] = null;
      if (ctx.scopeProps.selfIdx) o[ctx.scopeProps.selfIdx] = -1;
      o[ctx.scopeProps.parent] = scope;
      scope = o;
    }
  }
  const sentinel = (name) => makeTrapProxy(name, traps);
  const NORET = {};
  let r;
  try {
    r = X.step(...X.stepArgs(prog, {
      codeSize: 64, pc: PC0, op: opcode, operand, stack, sp: SP0,
      regs: arrProxy('R'), args: arrProxy('A'), consts: arrProxy('K'), jumps, scope,
      thisValue: sentinel('this'), newTarget: sentinel('newTarget'),
      NORET, fp: ctx.fingerprint,
    }));
  } catch (e) {
    return { error: e };
  }
  const changed = [];
  for (const k of Object.keys(r.after)) if (r.before[k] !== r.after[k]) changed.push(k);
  return {
    reads, writes, traps, changed, callResult,
    sp: r.sp, pc: r.pc,
    returned: r.ret !== NORET, threw: r.threw !== NORET ? r.threw : null,
    stack: stackTarget, initialStack,
  };
}

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

// ---------------------------------------------------------------------------
// data probe
// ---------------------------------------------------------------------------

function inferData(X, prog, opcode, ctx) {
  const envs = makeEnvironments();
  const pr = observe(X, prog, opcode, OPERANDS[0], envs[0], ctx, 'proxy');
  if (pr.error || pr.returned || pr.threw || pr.traps.length) return null;
  const samples = [];
  for (const env of envs) {
    for (const operand of OPERANDS) {
      const obs = observe(X, prog, opcode, operand, env, ctx, 'data');
      if (obs.error || obs.returned || obs.threw) return null;
      if (obs.traps.length || obs.changed.length) return null;
      samples.push(normalize(obs, operand, env));
    }
  }
  const stable = orderLeaves([...new Set(samples.flatMap((s) => Object.keys(s.leaves)))].filter((k) => samples.every((s) => k in s.leaves)));
  const pcKinds = new Set(samples.map((s) => s.pcKind));
  if (pcKinds.has('other')) return null;

  const describePath = (group) => {
    const shape = new Set(group.map((s) => `${s.pops}/${s.pushed.length}/${Object.keys(s.stores).sort().join(',')}`));
    if (shape.size !== 1) return null;
    let { pops, pushed } = group[0];
    const pushes = [];
    for (let i = 0; i < pushed.length; i++) {
      const e = explainValues(group.map((s) => ({ L: s.leaves, v: s.pushed[i] })), stable);
      if (!e) return null;
      pushes.push(e);
    }
    // values that were popped and pushed back unchanged at the bottom were not really popped
    while (pops > 0 && pushes.length && isLeaf(pushes[0], `S:${pops - 1}`)) { pops--; pushes.shift(); }
    const writes = [];
    for (const k of Object.keys(group[0].stores).sort()) {
      if (/#/.test(k)) return null; // write index not derived from the operand
      const e = explainValues(group.map((s) => ({ L: s.leaves, v: s.stores[k] })), stable);
      if (!e) return null;
      writes.push({ target: k, expr: e });
    }
    return { pops, pushes, writes };
  };

  if (pcKinds.size === 1) {
    const path = describePath(samples);
    if (!path) return null;
    if (pcKinds.has('jump')) return path.pops === 0 && !path.pushes.length && !path.writes.length ? { mnemonic: 'JMP' } : null;
    return toMnemonic({ mnemonic: 'TEMPLATE', ...path });
  }
  const cond = explain(samples.map((s) => ({ L: s.leaves, v: s.pcKind === 'jump' })), stable, { truthy: true });
  if (!cond) return null;
  const taken = describePath(samples.filter((s) => s.pcKind === 'jump'));
  const fall = describePath(samples.filter((s) => s.pcKind === 'next'));
  if (!taken || !fall) return null;
  return toCondMnemonic({ cond, taken, fall });
}

const isLeaf = (e, key) => e && e.k === 'leaf' && e.key === key;

function toMnemonic(tpl) {
  const { pops, pushes, writes } = tpl;
  if (writes.length === 0) {
    if (pops === 0 && pushes.length === 0) return { mnemonic: 'NOP' };
    if (pops === 1 && pushes.length === 0) return { mnemonic: 'DROP' };
    if (pops === 0 && pushes.length === 1 && isLeaf(pushes[0], 'S:0')) return { mnemonic: 'DUP' };
    if (pops === 1 && pushes.length === 1 && pushes[0].k === 'lit' && pushes[0].v === undefined) return { mnemonic: 'VOID' };
    if (pops === 2 && pushes.length === 2 && isLeaf(pushes[0], 'S:0') && isLeaf(pushes[1], 'S:1')) return { mnemonic: 'SWAP' };
    if (pops === 3 && pushes.length === 3 && isLeaf(pushes[0], 'S:1') && isLeaf(pushes[1], 'S:0') && isLeaf(pushes[2], 'S:2')) return { mnemonic: 'ROT_BOTTOM_UP' };
    if (pops === 3 && pushes.length === 3 && isLeaf(pushes[0], 'S:0') && isLeaf(pushes[1], 'S:2') && isLeaf(pushes[2], 'S:1')) return { mnemonic: 'ROT_TOP_DOWN' };
    if (pops === 0 && pushes.length === 1) {
      const e = pushes[0];
      if (isLeaf(e, 'K:op')) return { mnemonic: 'PUSH_CONST' };
      if (isLeaf(e, 'R:op')) return { mnemonic: 'LOAD_REG' };
      if (isLeaf(e, 'A:op')) return { mnemonic: 'LOAD_ARG' };
      if (isLeaf(e, 'Chi:lo')) return { mnemonic: 'LOAD_SCOPE' };
      if (e.k === 'lit' && e.v === undefined) return { mnemonic: 'PUSH_UNDEF' };
      if (e.k === 'lit' && e.v === null) return { mnemonic: 'PUSH_NULL' };
      if (e.k === 'fresh') return { mnemonic: e.kind === 'arr' ? 'PUSH_ARR' : 'PUSH_OBJ' };
    }
    if (pops === 2 && pushes.length === 1 && pushes[0].k === 'bin' && isLeaf(pushes[0].a, 'S:1') && isLeaf(pushes[0].b, 'S:0')) return { mnemonic: 'BINOP', op: pushes[0].op };
    if (pops === 1 && pushes.length === 1 && pushes[0].k === 'un' && isLeaf(pushes[0].a, 'S:0') && ['-', '+', '!', '~', 'typeof'].includes(pushes[0].op)) return { mnemonic: 'UNARY', op: pushes[0].op };
  }
  if (pops === 1 && pushes.length === 0 && writes.length === 1 && isLeaf(writes[0].expr, 'S:0')) {
    const w = writes[0].target;
    if (w === 'R:op') return { mnemonic: 'STORE_REG' };
    if (w === 'A:op') return { mnemonic: 'STORE_ARG' };
    if (w === 'C#0:op') return { mnemonic: 'STORE_LOCAL' };
    if (w === 'Chi:lo') return { mnemonic: 'STORE_SCOPE' };
  }
  return tpl;
}

function toCondMnemonic({ cond, taken, fall }) {
  const simple = (p, n) => p.pops === n && p.pushes.length === 0 && p.writes.length === 0;
  const top = (e) => isLeaf(e, 'S:0');
  const neg = (e) => e.k === 'un' && e.op === '!' ? e.a : null;
  if (top(cond) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMPT' };
  if (top(neg(cond)) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMPF' };
  if (top(cond) && simple(taken, 0) && simple(fall, 1)) return { mnemonic: 'JMPT_KEEP' };
  if (top(neg(cond)) && simple(taken, 0) && simple(fall, 1)) return { mnemonic: 'JMPF_KEEP' };
  if (top(cond) && simple(taken, 1) && simple(fall, 2)) return { mnemonic: 'JMPT_POP2' };
  if (top(neg(cond)) && simple(taken, 1) && simple(fall, 2)) return { mnemonic: 'JMPF_POP2' };
  if (cond.k === 'un' && cond.op === '!=null' && top(cond.a) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMP_NOT_NULLISH' };
  if (cond.k === 'un' && cond.op === '==null' && top(cond.a) && simple(taken, 1) && simple(fall, 1)) return { mnemonic: 'JMP_NULLISH' };
  return { mnemonic: 'COND_TEMPLATE', cond, taken, fall };
}

// ---------------------------------------------------------------------------
// call probe
// ---------------------------------------------------------------------------

function inferCall(X, prog, opcode, ctx) {
  const env = makeEnvironments()[0];
  const tryVariant = (numeric, argc) => {
    const results = [];
    for (const operand of OPERANDS) {
      const obs = observe(X, prog, opcode, operand, env, ctx, 'call', { numeric, argc });
      if (obs.error || obs.returned || obs.threw || obs.changed.length) return null;
      const calls = obs.traps.filter((tr) => tr[0] === 'apply' || tr[0] === 'construct');
      const other = obs.traps.filter((tr) => tr[0] !== 'apply' && tr[0] !== 'construct');
      if (calls.length !== 1 || other.length) return null;
      if (obs.pc !== PC0 + 1) return null;
      results.push({ obs, operand, call: calls[0] });
    }
    return results;
  };
  // Map proxies back to leaf keys: re-derive from reads (same proxy objects are cached per observe)
  // argument count from the stack top
  const variants = [
    { name: 'stack', numeric: (tag, idx) => tag === 'S' && idx === SP0 - 1 },
    { name: 'const', numeric: (tag) => tag === 'K' },
  ];
  for (const v of variants) {
    for (const argc of [2, 3]) {
      const res = tryVariant(v.numeric, argc);
      if (!res) continue;
      const shapes = res.map(({ obs, call }) => callShape(obs, call));
      if (shapes.some((x) => !x)) break;
      const key = JSON.stringify(shapes[0]);
      if (!shapes.every((x) => JSON.stringify(x) === key)) break;
      const sh = shapes[0];
      if (sh.args.length !== argc) break;
      // expected layouts
      const argsBelow = (from) => sh.args.every((a, i) => a === `S:${from + argc - 1 - i}`);
      if (v.name === 'stack') {
        if (sh.kind === 'apply' && sh.callee === 'S:1' && sh.thisArg === 'undefined' && argsBelow(2) && sh.pops === argc + 2 && sh.pushedResult) return { mnemonic: 'CALL' };
        if (sh.kind === 'apply' && sh.callee === 'S:1' && sh.thisArg === `S:${2 + argc}` && argsBelow(2) && sh.pops === argc + 3 && sh.pushedResult) return { mnemonic: 'CALL_METHOD' };
        if (sh.kind === 'apply' && sh.callee === 'S:1' && sh.thisArg === 'S:2' && argsBelow(3) && sh.pops === argc + 3 && sh.pushedResult) return { mnemonic: 'CALL_METHOD' };
        if (sh.kind === 'construct' && sh.callee === `S:${1 + argc}` && argsBelow(1) && sh.pops === argc + 2 && sh.pushedResult) return { mnemonic: 'NEW' };
      } else {
        if (sh.kind === 'apply' && sh.callee === 'S:0' && sh.thisArg === 'undefined' && argsBelow(1) && sh.pops === argc + 1 && sh.pushedResult) return { mnemonic: 'CALL_IMM' };
        if (sh.kind === 'apply' && sh.callee === 'S:0' && sh.thisArg === 'S:1' && argsBelow(2) && sh.pops === argc + 2 && sh.pushedResult) return { mnemonic: 'CALL_METHOD_IMM' };
      }
      break;
    }
  }
  return null;
}

/** Identify callee / this / args of an observed call by comparing with the initial stack contents. */
function callShape(obs, call) {
  const stackKey = new Map();
  for (let i = 0; i < SP0; i++) if (!stackKey.has(obs.initialStack[i])) stackKey.set(obs.initialStack[i], `S:${SP0 - 1 - i}`);
  // obs.stack is the final stack; the initial contents are gone for popped slots.
  // Popped slots keep their old values in the backing array unless overwritten.
  const keyOf = (v) => (v === undefined ? 'undefined' : stackKey.get(v) || null);
  const kind = call[0];
  const callee = call[1] && call[1].startsWith('S/') ? `S:${SP0 - 1 - Number(call[1].slice(2))}` : null;
  const thisArg = kind === 'apply' ? keyOf(call[2]) : null;
  const args = (kind === 'apply' ? call[3] : call[2]).map(keyOf);
  if (!callee || args.some((a) => !a) || (kind === 'apply' && !thisArg)) return null;
  let low = obs.sp;
  for (const [tag, idx] of obs.reads) if (tag === 'S' && idx < low) low = idx;
  low = Math.min(low, SP0);
  const pushedResult = obs.sp === low + 1 && obs.stack[low] === obs.callResult;
  return { kind, callee, thisArg, args, pops: SP0 - low, pushedResult };
}

// ---------------------------------------------------------------------------
// closure probe
// ---------------------------------------------------------------------------

function inferClosure(X, prog, opcode, ctx) {
  const NORET = {};
  let r;
  try {
    r = X.step(...X.stepArgs(prog, { codeSize: 64, pc: PC0, op: opcode, operand: 0, stack: [prog], sp: 1, NORET }));
  } catch { return null; }
  if (r.threw !== NORET || r.ret !== NORET || r.pc !== PC0 + 1 || r.sp !== 1) return null;
  const fn = r.stack[0];
  if (typeof fn !== 'function' || fn === prog) return null;
  // a second run with a different program must give a different function
  let r2;
  try { r2 = X.step(...X.stepArgs(prog, { codeSize: 64, pc: PC0, op: opcode, operand: 0, stack: [prog], sp: 1, NORET })); } catch { return null; }
  if (r2.stack[0] === fn) return null;
  return { mnemonic: 'MAKE_CLOSURE' };
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

function inferUnknown(X, vm, opcodes) {
  const prog = X.firstProgram();
  const out = new Map();
  if (!prog) return out;
  const { roles } = vm;
  const f = vm.plain.fetch;
  const ignore = new Set([roles.stack, roles.sp, roles.pc, roles.code, roles.len, roles.regs, roles.args, roles.consts, roles.jumps, f.opBase, f.operBase, f.shift, roles.this, roles.lexThis, roles.newTarget].filter(Boolean));
  const ctx = { scopeProps: roles.scopeProps, fingerprint: makeFingerprinter(ignore) };
  const swallow = () => {};
  process.on('unhandledRejection', swallow);
  try {
    for (const op of opcodes) {
      let e = null;
      for (const probe of [inferData, inferCall, inferClosure]) {
        try { e = probe(X, prog, op, ctx); } catch { e = null; }
        if (e) break;
      }
      if (e) out.set(op, { ...e, inferred: true });
    }
  } finally {
    setTimeout(() => process.removeListener('unhandledRejection', swallow), 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

function exprToString(e) {
  if (!e) return '?';
  switch (e.k) {
    case 'leaf': return e.key.replace(/^S:(\d+)$/, 'pop$1').replace(/^([RAK]):(\w+)$/, (m, a, fl) => `${a}[${fl}]`).replace(/^C(\w+):(\w+)$/, (m, d, s) => `scope(${d})[${s}]`).replace(/^OPV:(\w+)$/, '$1');
    case 'lit': return String(e.v);
    case 'un': return `${e.op}(${exprToString(e.a)})`;
    case 'bin': return `(${exprToString(e.a)} ${e.op} ${exprToString(e.b)})`;
    case 'fresh': return e.kind === 'arr' ? '[]' : '{}';
    default: return '?';
  }
}

function describeEntry(e) {
  if (e.mnemonic === 'TEMPLATE') return `pop ${e.pops}; push [${e.pushes.map(exprToString).join(', ')}]${e.writes.length ? '; ' + e.writes.map((w) => `${w.target} = ${exprToString(w.expr)}`).join('; ') : ''}`;
  if (e.mnemonic === 'COND_TEMPLATE') return `jump if ${exprToString(e.cond)}`;
  return e.mnemonic + (e.op ? ` ${e.op}` : '');
}

module.exports = { inferUnknown, describeEntry, exprToString, SP0 };
