// Runs one script in this worker and reports its console output to the page. A worker has no
// DOM and is terminated from outside, so a script that never ends cannot block the page.
'use strict';
(() => {
  const post = (type, text) => self.postMessage({ type, text });

  // stack frames point into the script's blob URL; frames of this runner are left out
  const cleanStack = (st) => st.split('\n').filter((l) => !/runner\.js/.test(l)).join('\n').replace(/blob:[^\s)]*?:(?=\d+:\d+)/g, 'script.js:');

  // console arguments formatted roughly like Node's util.format / util.inspect
  const inspect = (v, depth = 0, seen = new Set()) => {
    if (typeof v === 'string') return depth ? `'${v}'` : v;
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'symbol' || typeof v !== 'object' && typeof v !== 'function' || v === null) return String(v);
    if (typeof v === 'function') return /^class\b/.test(Function.prototype.toString.call(v)) ? `[class ${v.name || '(anonymous)'}]` : `[Function: ${v.name || '(anonymous)'}]`;
    if (v instanceof Error) return depth ? `[${v.name}: ${v.message}]` : (v.stack && v.stack.includes(v.message) ? cleanStack(v.stack) : `${v.name}: ${v.message}`);
    if (seen.has(v)) return '[Circular]';
    if (depth > 2) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.length ? `[ ${v.map((x) => inspect(x, depth + 1, seen)).join(', ')} ]` : '[]';
      if (v instanceof Map) return `Map(${v.size}) {${v.size ? ` ${[...v].map(([k, x]) => `${inspect(k, depth + 1, seen)} => ${inspect(x, depth + 1, seen)}`).join(', ')} ` : ''}}`;
      if (v instanceof Set) return `Set(${v.size}) {${v.size ? ` ${[...v].map((x) => inspect(x, depth + 1, seen)).join(', ')} ` : ''}}`;
      if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (v instanceof Promise) return 'Promise { <pending> }';
      const keys = Object.keys(v);
      const ctor = v.constructor && v.constructor !== Object && v.constructor.name ? `${v.constructor.name} ` : '';
      if (!keys.length) return `${ctor}{}`;
      const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);
      return `${ctor}{ ${keys.map((k) => `${key(k)}: ${inspect(v[k], depth + 1, seen)}`).join(', ')} }`;
    } finally { seen.delete(v); }
  };
  const format = (args) => {
    if (typeof args[0] === 'string' && /%[sdifjoOc%]/.test(args[0])) {
      let i = 1;
      const head = args[0].replace(/%([sdifjoOc%])/g, (m, f) => {
        if (f === '%') return '%';
        if (i >= args.length) return m;
        const a = args[i++];
        switch (f) {
          case 's': return typeof a === 'string' ? a : inspect(a, 1);
          case 'd': case 'i': return String(f === 'i' ? parseInt(a, 10) : Number(a));
          case 'f': return String(parseFloat(a));
          case 'j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
          case 'c': return '';
          default: return inspect(a, 1);
        }
      });
      return [head, ...args.slice(i).map((a) => inspect(a))].join(' ');
    }
    return args.map((a) => inspect(a)).join(' ');
  };
  const out = (type) => (...args) => post(type, format(args));
  self.console = {
    ...self.console,
    log: out('log'), info: out('log'), debug: out('log'), table: out('log'), dir: (v) => post('log', inspect(v)),
    warn: out('warn'), error: out('error'), trace: out('error'),
  };

  // pending timers decide when the program has finished
  let pending = 0;
  const live = new Set();
  const realSetTimeout = self.setTimeout, realClearTimeout = self.clearTimeout;
  const realSetInterval = self.setInterval, realClearInterval = self.clearInterval;
  self.setTimeout = (fn, ms, ...a) => {
    const id = realSetTimeout(() => { if (live.delete(id)) pending--; typeof fn === 'function' ? fn(...a) : (0, eval)(String(fn)); }, ms);
    live.add(id); pending++;
    return id;
  };
  self.clearTimeout = (id) => { if (live.delete(id)) pending--; realClearTimeout(id); };
  self.setInterval = (fn, ms, ...a) => { const id = realSetInterval(fn, ms, ...a); live.add(id); pending++; return id; };
  self.clearInterval = (id) => { if (live.delete(id)) pending--; realClearInterval(id); };
  self.setImmediate = (fn, ...a) => self.setTimeout(fn, 0, ...a);
  if (typeof self.fetch === 'function') {
    const realFetch = self.fetch;
    self.fetch = (...a) => { pending++; return realFetch(...a).finally(() => { pending--; }); };
  }

  // the little of Node that plain programs touch
  self.global = self;
  self.process = {
    argv: ['node', 'script.js'], env: {}, platform: 'browser', exitCode: undefined,
    version: 'v0.0.0-browser', versions: {},
    stdout: { write: (s) => { post('log', String(s).replace(/\n$/, '')); return true; } },
    stderr: { write: (s) => { post('error', String(s).replace(/\n$/, '')); return true; } },
    nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
    hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
    cwd: () => '/', on: () => self.process, exit: (code) => { post('exit', String(code ?? 0)); self.close(); },
  };
  self.require = (name) => { throw new Error(`require('${name}') is not available in the browser; run this Node program with node instead`); };

  self.addEventListener('error', (e) => { e.preventDefault(); post('error', `Uncaught ${e.error ? inspect(e.error) : e.message}`); });
  self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); post('error', `Uncaught (in promise) ${inspect(e.reason)}`); });

  self.onmessage = (e) => {
    const code = String(e.data.code).replace(/^#![^\n]*/, '');
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { importScripts(url); } catch (err) { post('error', `Uncaught ${inspect(err)}`); } finally { URL.revokeObjectURL(url); }
    // finished once no timer or request is left for a few consecutive checks
    let idle = 0;
    const check = () => {
      idle = pending === 0 ? idle + 1 : 0;
      if (idle >= 3) post('done', '');
      else realSetTimeout(check, 30);
    };
    realSetTimeout(check, 30);
  };
})();
