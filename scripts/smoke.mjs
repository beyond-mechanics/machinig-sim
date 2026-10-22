// Browser smoke test (npm run smoke): builds nothing, opens dist/index.html in headless Chromium
// (Playwright, three.js served from node_modules), runs the demo to the end, opens the panels
// and fails on any page error. PLAYWRIGHT_CHROMIUM may point at a Chromium binary.
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';

const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + readFileSync('dist/index.html', 'utf8') + '</body></html>';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ body: readFileSync('node_modules/three/build/three.min.js'), contentType: 'application/javascript' }));
await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
await page.route('http://app.local/', r => r.fulfill({ body: html, contentType: 'text/html' }));
await page.goto('http://app.local/', { timeout: 90000 });
await page.waitForTimeout(1500);
const step = async (name, fn) => { await page.evaluate(fn); await page.waitForTimeout(300); console.log('·', name); };
await step('panels', () => { for (const id of ['oxBox', 'idBox', 'scBox']) document.getElementById(id).open = true; document.getElementById('idExample').click(); document.getElementById('idRun').click(); });
await step('to the end', () => document.getElementById('progBar').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
for (let i = 0; i < 120 && !(await page.evaluate(() => window.machiningSim.done)); i++) await page.waitForTimeout(1000);
await page.waitForTimeout(3000);
await step('report tools', () => { document.getElementById('foRun').click(); document.getElementById('soRun').click(); document.getElementById('rBase').click(); const pc = document.getElementById('pathColor'); pc.value = 'state'; pc.dispatchEvent(new Event('change')); });
const res = await page.evaluate(() => ({ done: window.machiningSim.done, rows: document.querySelectorAll('#rSum div').length, fo: document.getElementById('foOut').textContent.slice(0, 60), overflow: document.documentElement.scrollWidth > innerWidth }));
console.log(res);
await browser.close();
if (errors.length || !res.done || !res.rows || res.overflow) { console.error('smoke test failed', errors); process.exit(1); }
console.log('smoke test passed');
