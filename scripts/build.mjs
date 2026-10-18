import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
const w = await build({ entryPoints: ['src/worker.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020' });
const r = await build({ entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020',
  define: { __WORKER_SRC__: JSON.stringify(w.outputFiles[0].text) } });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('scripts/template.html', 'utf8').replace('/*APP*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', (html.length / 1024).toFixed(0), 'KB');
