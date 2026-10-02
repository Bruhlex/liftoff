'use strict';
/**
 * Browser stand-in for Node's `vm` module. Code runs inside the decompiler's Web Worker,
 * with a scope object in front of the worker's globals: names the context defines resolve
 * to the context, standard ECMAScript built-ins resolve normally, and every other global
 * (fetch, self, importScripts, ...) reads as undefined. This mirrors a fresh Node context
 * closely enough for the obfuscator's loader code. It is NOT a security boundary; the page
 * runs the whole job in a disposable worker that is terminated after a timeout.
 */
const BUILTINS = new Set(('Object Function Array Number parseFloat parseInt Infinity NaN undefined ' +
  'Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError ' +
  'SyntaxError TypeError URIError JSON Math Intl ArrayBuffer Uint8Array Int8Array Uint16Array Int16Array ' +
  'Uint32Array Int32Array Float32Array Float64Array Uint8ClampedArray BigInt64Array BigUint64Array ' +
  'DataView Map Set WeakMap WeakSet Proxy Reflect BigInt eval isFinite isNaN encodeURI ' +
  'encodeURIComponent decodeURI decodeURIComponent escape unescape Atomics SharedArrayBuffer WeakRef ' +
  'FinalizationRegistry Iterator setTimeout clearTimeout setInterval clearInterval queueMicrotask ' +
  'TextEncoder TextDecoder atob btoa structuredClone').split(' '));

function scopeFor(ctx) {
  return new Proxy(ctx, {
    has(target, key) {
      if (typeof key !== 'string') return false;
      if (key === '__vmshim_code__') return false;   // the runner's own parameter
      if (key in target) return true;
      return !BUILTINS.has(key);           // unknown globals are shadowed (read as undefined)
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

// direct eval inside `with` gives the completion value and keeps the scope chain
// eslint-disable-next-line no-new-func
const RUN = new Function('__vmshim_scope__', '__vmshim_code__', 'with (__vmshim_scope__) { return eval(__vmshim_code__); }');

function createContext(obj = {}) {
  if (!('globalThis' in obj)) obj.globalThis = obj;
  return obj;
}
function runInContext(code, ctx) { return RUN.call(ctx, scopeFor(ctx), code); }
function runInNewContext(code, obj) { return runInContext(code, createContext(obj || {})); }

module.exports = { createContext, runInContext, runInNewContext };
