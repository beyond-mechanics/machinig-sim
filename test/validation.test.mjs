// Validation against the literature benchmark for milling stability (Insperger & Stépán:
// 1-DOF tool in the feed direction, m = 0.03993 kg, ωn = 5793 rad/s, ζ = 0.011,
// Kt = 6e8 N/m², Kn = 2e8 N/m², two straight flutes). The reference stability limit comes
// from the semi-discretization method (test/lib/sdm.mjs), which unlike the zero-order lobes
// also captures the period-doubling (flip) lobes of intermittent cutting. The time-domain
// engine must be stable below and chatter above that limit.
import assert from 'node:assert/strict';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { stabilityLobes, alimAt } from '../src/sld.js';
import { sdmLimit } from './lib/sdm.mjs';

const bm = { m: 0.03993, k: 0.03993 * 5793 ** 2, zeta: 0.011, Kt: 6e8, Kn: 2e8, N: 2 };
// x is the feed direction; y made rigid so the tool is effectively 1-DOF like the benchmark
const modal = { k: 0, fn: 0, zeta: 0, modesX: [{ k: bm.k / 1e3, fn: 5793 / (2 * Math.PI), zeta: bm.zeta }], modesY: [{ k: 1e9, fn: 20000, zeta: 0.05 }] };
const mat = { Ktc: 600, Krc: 200, Kac: 0, Kte: 0, Kre: 0, Kae: 0, mc: 0, Ci: 0 };

function chatters(rpm, ap, st, ex) {
  const e = new CuttingEngine();
  e.configure({ R: 5, N: 2, helixDeg: 0, type: 'flat', fluteLen: 20, nonlinear: false }, modal, mat, rpm);
  for (let b = 0; b < BINS; b++) { const p = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = p >= st && p <= ex ? 0 : -100; }
  e.setEngagement([1, 0], 0.05, -ap, ap);
  e.vx = 0.002;
  e.run(e.stepsPerTooth * 2 * 300);
  return e.chatterIndex().index > 0.55;
}

let agree = 0, total = 0;
for (const [name, st, ex] of [['slot', 0, Math.PI], ['half-immersion down milling', Math.PI / 2, Math.PI]]) {
  const lobes = stabilityLobes({ ...modal, N: 2, Ktc: mat.Ktc, Krc: mat.Krc, phiSt: st, phiEx: ex, rpmMin: 4000, rpmMax: 30000, lobes: 30 });
  for (const rpm of [5000, 9000, 12000, 16000]) {
    const lim = sdmLimit({ ...bm, phiSt: st, phiEx: ex, rpm }) * 1e3; // mm
    const lo = chatters(rpm, 0.7 * lim, st, ex), hi = chatters(rpm, 1.4 * lim, st, ex);
    agree += !lo + hi; total += 2;
    const zoa = alimAt(lobes, rpm);
    console.log(`${name.padEnd(28)} ${rpm} min⁻¹  SDM ${lim.toFixed(2)} mm (zero-order ${zoa > 100 ? '∞' : zoa.toFixed(2)})  time domain: 0.7× ${lo ? 'chatter' : 'stable'}, 1.4× ${hi ? 'chatter' : 'stable'}`);
  }
}
console.log(`time domain agrees with the semi-discretization limit in ${agree}/${total} cases`);
assert.ok(agree >= total - 2, 'time-domain simulation matches the benchmark stability limit');
console.log('validation tests passed');
