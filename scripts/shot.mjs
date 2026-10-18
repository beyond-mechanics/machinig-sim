import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
const out = process.argv[2] || '/tmp/claude-0/-home-claude/6606a69e-0937-5551-a992-fa8245fc1a32/scratchpad';
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + readFileSync('dist/index.html', 'utf8') + '</body></html>';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, vp, scheme, wait, actions] of [
  ['desk-dark', { width: 1440, height: 1000 }, 'dark', 9000, []],
  ['desk-light-vib', { width: 1440, height: 1000 }, 'light', 9000, ['vib']],
  ['phone', { width: 400, height: 860 }, 'dark', 3000, []],
]) {
  const page = await browser.newPage({ viewport: vp, colorScheme: scheme });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ body: readFileSync('node_modules/three/build/three.min.js'), contentType: 'application/javascript' }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route('http://app.local/', r => r.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('http://app.local/');
  await page.selectOption('#speed', '5');
  await page.click('#btnPlay');
  if (actions.includes('vib')) await page.click('[data-color="vibration"]');
  await page.waitForTimeout(wait);
  const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(name, 'fps≈', fps, 'hOverflow', overflow, 'state', await page.textContent('#statePill'), await page.textContent('#clock'), errs.slice(0, 5));
  await page.close();
}
await browser.close();
