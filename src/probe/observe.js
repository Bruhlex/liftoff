'use strict';
/**
 * One observation: run a handler once through the VM's own dispatch in a controlled machine
 * state (value environments, index-logging proxies) and record what it read and wrote; a
 * fingerprint of the rest of the interpreter state detects effects that are not modelled.
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

module.exports = { makeFingerprinter, SP0, PC0, JUMP_TARGET, makeEnvironments, observe, OPERANDS };
