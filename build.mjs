// Builds the browser version into docs/ (served as a static site, e.g. GitHub Pages).
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('docs', { recursive: true });
await build({
  entryPoints: ['web/worker-entry.js'],
  bundle: true, platform: 'browser', format: 'iife', minify: true, keepNames: true,
  outfile: 'docs/decompiler.worker.js',
  alias: {
    vm: './web/shims/vm.js', worker_threads: './web/shims/worker_threads.js',
    fs: './web/shims/empty.js', 'node:fs/promises': './web/shims/empty.js', 'isolated-vm': './web/shims/empty.js',
    path: 'path-browserify', 'node:path': 'path-browserify', assert: './web/shims/assert.js',
  },
  inject: ['./web/shims/process.js'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
cpSync('web/index.html', 'docs/index.html');
cpSync('web/app.js', 'docs/app.js');
cpSync('web/style.css', 'docs/style.css');
cpSync('web/samples', 'docs/samples', { recursive: true });
writeFileSync('docs/.nojekyll', '');
