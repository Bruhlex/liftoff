// Runs the pipeline with the browser shims (vm, worker_threads) under Node and compares the
// result with the reference output of the Node CLI. Built by test/web/run.mjs.
const fs = require('fs');
const path = require('path');
const { decompile } = require('../../src/pipeline');
(async () => {
  const [refDir, ...files] = process.argv.slice(2);
  let same = 0, diff = 0, fail = 0;
  for (const f of files) {
    const name = path.basename(f);
    try {
      const res = await decompile(fs.readFileSync(f, 'utf8'), { name });
      const refFile = path.join(refDir, name.replace(/\.js$/, '.dec.js'));
      const ref = fs.existsSync(refFile) ? fs.readFileSync(refFile, 'utf8') : null;
      if (ref === res.code) same++; else { diff++; console.log('DIFF', name); }
    } catch (e) { fail++; console.log('FAIL', name, e.message); }
  }
  console.log(`same ${same}  different ${diff}  failed ${fail}`);
})();
