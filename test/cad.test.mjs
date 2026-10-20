// STEP import: a hand-written AP214 box (40 × 30 × 20 mm, planar B-rep) through OpenCascade
// (the npm package of the converter the browser fetches from the CDN), then onto the stock grid.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseCad, CAD_RE } from '../src/cad.js';
import { orientMesh, buildStock } from '../src/workpiece.js';

const require = createRequire(import.meta.url);
let factory;
try { factory = require('occt-import-js'); } catch { console.log('occt-import-js not installed (npm install): skipped'); process.exit(0); }
assert.ok(CAD_RE.test('part.STEP') && CAD_RE.test('a.stp') && CAD_RE.test('a.igs') && !CAD_RE.test('a.stl'));
const buf = readFileSync(new URL('./data/box40x30x20.step', import.meta.url));
const m = await parseCad(buf, 'box40x30x20.step', factory);
console.log(`STEP box: ${m.count} triangles, ${m.min.map(v => v.toFixed(2))} … ${m.max.map(v => v.toFixed(2))} mm`);
assert.equal(m.count, 12);
assert.deepEqual(m.min.map(v => +v.toFixed(6)), [0, 0, 0]);
assert.deepEqual(m.max.map(v => +v.toFixed(6)), [40, 30, 20]);
assert.ok(m.unitMm);
// on the stock grid: the full box, its top at the model top
const spec = { type: 'stl', ...orientMesh(m, { unit: 'mm' }), name: 'box' };
const s = buildStock(spec, 0.5);
assert.ok(Math.abs(s.w - 40) < 1e-6 && Math.abs(s.l - 30) < 1e-6);
const mid = s.H[Math.round(s.ny / 2) * s.nx + Math.round(s.nx / 2)];
assert.ok(Math.abs(mid - s.zTop) < 1e-6, `top ${mid} vs ${s.zTop}`);
console.log('cad tests passed');
