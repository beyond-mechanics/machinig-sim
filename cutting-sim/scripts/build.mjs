import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
const w = await build({ entryPoints: ['src/worker.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020' });
const r = await build({ entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020',
  define: { __WORKER_SRC__: JSON.stringify(w.outputFiles[0].text) } });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
// Licence texts of the bundled libraries, shown in the page and kept as a comment at the top.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const threeLicense = readFileSync('node_modules/three/LICENSE', 'utf8').trim();
const threeVersion = JSON.parse(readFileSync('node_modules/three/package.json', 'utf8')).version;
// Author and version (package.json, the build date and the commit when git is there), shown in the page.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ }
const version = `${pkg.version}（${new Date().toISOString().slice(0, 10)}${commit ? `、${commit}` : ''}）`;
const html = `<!--\n切削シミュレーター ${version}、作成：${pkg.author}。研究用の試作です。結果は参考値で、実際の加工条件の決定には使わないでください。\n\nIncludes three.js ${threeVersion} (https://threejs.org), MIT License:\n\n${threeLicense.replace(/--/g, '- -')}\n-->\n`
  + readFileSync('scripts/template.html', 'utf8').replace('/*THREE_LICENSE*/', () => esc(`three.js ${threeVersion}\n\n${threeLicense}`)).replace(/\/\*AUTHOR\*\//g, () => esc(pkg.author)).replace(/\/\*VERSION\*\//g, () => esc(version)).replace('/*APP*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', (html.length / 1024).toFixed(0), 'KB');
