'use strict';
const { decompile } = require('../src/pipeline');

self.onmessage = async (e) => {
  const { source, name, skipWebcrack, prettyNames } = e.data;
  const post = (m) => self.postMessage(m);
  try {
    const t0 = performance.now();
    const res = await decompile(source, {
      name: name || 'input.js',
      skipWebcrack: !!skipWebcrack,
      prettyNames: prettyNames !== false,
      log: (m) => post({ type: 'log', text: m }),
      warn: (m) => post({ type: 'warn', text: m }),
    });
    post({ type: 'done', mode: res.mode, stats: res.stats, code: res.code, warnings: res.warnings, programs: res.programs, opcodes: res.opcodes, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ type: 'error', text: String(err && err.message || err) });
  }
};
