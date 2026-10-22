// Radial runout: the teeth cut unequal chips, and the side wall is generated mostly by the
// tooth that reaches furthest, so the scallop grows from fz²/8R towards (N·fz)²/8R (marks once
// per revolution). A rigid tool keeps vibration out of it.
import assert from 'node:assert/strict';
import { wallProfile } from '../src/roughness.js';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { MATERIALS } from '../src/materials.js';

const rigid = { k: 1e6, fn: 6000, zeta: 0.1 };
function cut(runout, fz = 0.05) {
  const e = new CuttingEngine();
  e.configure({ R: 5, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25, runout, nonlinear: false }, rigid, MATERIALS.A5052, 12000);
  for (let b = 0; b < BINS; b++) e.Hb[b] = (b + 0.5) / BINS < 0.5 ? 0 : -100; // slot: both walls
  e.setEngagement([1, 0], fz, -1, 1);
  e.run(e.stepsPerTooth * 3 * 60);
  const vols = e.chipEvents.slice(-9).map(c => c.vol);
  return { vols, walls: [wallProfile(e.wallSamples, [1, 0], 1, 5, fz), wallProfile(e.wallSamplesPi, [1, 0], -1, 5, fz)] };
}

// 1. chip load: equal teeth without runout, one tooth carrying more with it
{
  const a = cut(0), b = cut(0.01);
  const spread = v => Math.max(...v) / Math.min(...v);
  console.log(`chip volume per tooth, max/min: no runout ${spread(a.vols).toFixed(3)}, 10 µm runout ${spread(b.vols).toFixed(3)}`);
  assert.ok(spread(a.vols) < 1.02, 'equal teeth');
  assert.ok(spread(b.vols) > 1.3, 'runout loads one tooth more (fz 50 µm, e 10 µm)');
}

// 2. side wall: per-tooth scallop without runout, towards the per-revolution scallop with it
{
  const R = 5, fz = 0.05, N = 3;
  const perTooth = fz * fz / (8 * R) * 1e3, perRev = (N * fz) ** 2 / (8 * R) * 1e3;
  const a = cut(0, fz).walls, b = cut(0.01, fz).walls;
  const rz = w => Math.max(w[0].Rz, w[1].Rz);
  console.log(`wall Rz: no runout ${rz(a).toFixed(3)} µm (fz²/8R ${perTooth.toFixed(3)}), 10 µm runout ${rz(b).toFixed(3)} µm ((N·fz)²/8R ${perRev.toFixed(3)})`);
  assert.ok(Math.abs(rz(a) / perTooth - 1) < 0.15, 'per-tooth scallop');
  assert.ok(rz(b) > 0.7 * perRev && rz(b) < 1.15 * perRev, 'one tooth generates the wall');
}
console.log('runout tests passed');
