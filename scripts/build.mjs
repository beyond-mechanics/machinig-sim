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

// stand-alone copy for handing out: three.js inlined, no web fonts, opens offline from disk
const three = readFileSync('node_modules/three/build/three.min.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const offline = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + html.replace(/<link[^>]*fonts\.g[^>]*>\n?/g, '')
    .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>', () => `<script>${three}</script>`)
  + '</html>';
writeFileSync('dist/machining-sim-offline.html', offline);
console.log('dist/machining-sim-offline.html', (offline.length / 1024).toFixed(0), 'KB');
