// Browser check of the native bridge: the page from sphserve, the drill example in STL mode run
// for a few degrees by the native core. node native/scripts/ui-native.mjs <sphserve> [shot.png]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const { chromium } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright');
const [srv, shot] = process.argv.slice(2);
const port = 8700 + Math.floor(Math.random() * 200);
const p = spawn(srv, ['dist/index.html', String(port)], { stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.click('[data-mode="mesh"]');
  await page.selectOption('#sex', 'drill');
  await page.fill('#sangle', '8'); await page.dispatchEvent('#sangle', 'change');
  await page.waitForTimeout(1500);
  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('state').dataset.s === 'done', null, { timeout: 180000 });
  const meta = await page.textContent('#meta'), fatal = await page.isVisible('#fatal');
  console.log(JSON.stringify({ meta, fatal, errs }));
  if (shot) await page.screenshot({ path: shot });
  ok = !fatal && !errs.length && /ネイティブ計算/.test(meta);
} finally { await browser.close(); p.kill(); }
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);
