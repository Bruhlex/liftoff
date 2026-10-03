// Builds the pipeline with the browser shims (vm, worker_threads) for Node and checks that it
// decompiles the samples exactly like the Node CLI.
import { build } from 'esbuild';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

await build({
  entryPoints: ['test/web/shim-entry.js'], bundle: true, platform: 'node', format: 'cjs',
  outfile: 'test/web/.shim-bundle.cjs', logLevel: 'warning', packages: 'external',
  alias: { vm: './web/shims/vm.js', worker_threads: './web/shims/worker_threads.js', 'isolated-vm': './web/shims/empty.js' },
});

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync('samples').filter((f) => f.endsWith('.js') && !f.endsWith('.src.js')).map((f) => path.join('samples', f));
const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-web-'));
for (const f of files) {
  const out = path.join(refDir, path.basename(f).replace(/\.js$/, '.dec.js'));
  spawnSync('node', ['index.js', f, '-o', out, '--quiet'], { stdio: 'inherit' });
}
const r = spawnSync('node', ['test/web/.shim-bundle.cjs', refDir, ...files], { stdio: 'inherit' });
process.exit(r.status);
