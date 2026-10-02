import { build } from 'esbuild';
await build({
  entryPoints: ['test/web/shim-entry.js'], bundle: true, platform: 'node', format: 'cjs',
  outfile: 'test/web/.shim-bundle.cjs', logLevel: 'warning', packages: 'external',
  alias: { vm: './web/shims/vm.js', worker_threads: './web/shims/worker_threads.js', 'isolated-vm': './web/shims/empty.js' },
});
