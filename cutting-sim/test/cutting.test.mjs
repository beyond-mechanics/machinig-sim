// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { CuttingSim } from '../src/sph.js';
import { MATERIALS, flowStress } from '../src/materials.js';
import { makeTool, toolSdf } from '../src/tool.js';

const run = (cfg) => { const s = new CuttingSim(cfg); let k = 0; while (!s.done) { s.step(); if (++k % 100 === 0) s.sample(); } s.sample(); return s; };

test('tool signed distance: rounded edge, rake face and interior', () => {
  const t = makeTool({ rakeDeg: 0, clearanceDeg: 7, edgeRadius: 10e-6 });
  assert.ok(Math.abs(toolSdf(t, 30e-6, 0) - 20e-6) < 1e-12);           // in front of the edge circle
  assert.ok(Math.abs(toolSdf(t, 25e-6, 100e-6) - 15e-6) < 1e-12);      // in front of a vertical rake face
  assert.ok(Math.abs(toolSdf(t, 0, -30e-6) - 20e-6) < 1e-9);           // below the edge
  assert.ok(toolSdf(t, -20e-6, 20e-6) < 0);                             // inside the body
  assert.ok(Math.abs(t.out[1] - 1) < 1e-12);                            // nearest face is the rake face
});

test('Johnson-Cook flow stress: reference, rate and thermal softening', () => {
  const m = MATERIALS.S45C;
  assert.equal(flowStress(m, 0, 1, 20), m.A * 1e6);
  assert.ok(Math.abs(flowStress(m, 1, 1, 20) - (m.A + m.B) * 1e6) < 1);
  assert.ok(flowStress(m, 0, 1e4, 20) > flowStress(m, 0, 1, 20));
  assert.ok(flowStress(m, 0, 1, 740) < 0.55 * flowStress(m, 0, 1, 20));
});

test('S45C reference cut: forces, chip and temperatures in the experimental range', () => {
  const s = run({ mat: 'S45C', vc: 200, h: 0.1, rake: 5, nh: 6, cutLen: 0.4 });
  const r = s.summary();
  assert.equal(s.nDead, 0, 'no particles ejected');
  // Specific cutting force of medium carbon steel at h = 0.1 mm: about 1,800–2,600 N/mm².
  assert.ok(r.kc > 1500 && r.kc < 2800, `kc ${r.kc.toFixed(0)}`);
  assert.ok(r.ft > 0.1 * r.fc && r.ft < r.fc, `Ft/Fc ${(r.ft / r.fc).toFixed(2)}`);
  assert.ok(r.ratio > 1.3 && r.ratio < 2.8, `chip ratio ${r.ratio.toFixed(2)}`);
  assert.ok(r.tmax > 350 && r.tmax < 1000, `Tmax ${r.tmax.toFixed(0)}`);
  // Most cutting work ends up as heat (plastic heating at 90 %, friction at 100 %).
  assert.ok(r.heatRatio > 0.7 && r.heatRatio < 1.0, `heat / work ${r.heatRatio.toFixed(2)}`);
});

test('larger rake angle lowers the cutting force and thickens the shear angle', () => {
  const a = run({ mat: 'S45C', rake: -5, nh: 6, cutLen: 0.35 }).summary();
  const b = run({ mat: 'S45C', rake: 15, nh: 6, cutLen: 0.35 }).summary();
  assert.ok(b.fc < 0.92 * a.fc, `Fc ${a.fc.toFixed(0)} → ${b.fc.toFixed(0)}`);
  assert.ok(b.phi > a.phi, `φ ${a.phi.toFixed(1)} → ${b.phi.toFixed(1)}`);
});

test('higher cutting speed raises the cutting temperature', () => {
  const lo = run({ mat: 'S45C', vc: 80, nh: 6, cutLen: 0.35 }).summary();
  const hi = run({ mat: 'S45C', vc: 300, nh: 6, cutLen: 0.35 }).summary();
  assert.ok(hi.trake > lo.trake + 50, `rake T ${lo.trake.toFixed(0)} → ${hi.trake.toFixed(0)}`);
});
