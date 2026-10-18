// Measured-FRF import and multi-mode dynamics: the peak-picking fit recovers the modes of a
// synthetic two-mode asymmetric FRF, and the time-domain simulation with those modes agrees
// with the multi-mode stability lobes.
import assert from 'node:assert/strict';
import { parseFrfCsv, fitModes, exampleCsv } from '../src/frf.js';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { stabilityLobes, alimAt } from '../src/sld.js';
import { MATERIALS } from '../src/materials.js';

const d = parseFrfCsv(exampleCsv());
assert.equal(d.unit, 'm/N');
const mx = fitModes(d.f, d.xx), my = fitModes(d.f, d.yy);
console.log('fit X', mx.map(m => `${m.fn.toFixed(0)}Hz k${(m.k / 1000).toFixed(1)}N/µm ζ${m.zeta.toFixed(3)}`).join(', '));
console.log('fit Y', my.map(m => `${m.fn.toFixed(0)}Hz k${(m.k / 1000).toFixed(1)}N/µm ζ${m.zeta.toFixed(3)}`).join(', '));
const trueX = [{ k: 18000, fn: 1150, zeta: 0.05 }, { k: 11000, fn: 2250, zeta: 0.035 }];
assert.equal(mx.length, 2);
mx.forEach((m, i) => {
  assert.ok(Math.abs(m.fn / trueX[i].fn - 1) < 0.02, 'fn');
  assert.ok(Math.abs(m.zeta / trueX[i].zeta - 1) < 0.2, 'zeta');
  assert.ok(Math.abs(m.k / trueX[i].k - 1) < 0.25, 'k');
});

const modal = { k: 0, fn: 0, zeta: 0, modesX: mx, modesY: my };
const mat = { ...MATERIALS.A5052, mc: 0, Ci: 0 };
const tool = { R: 5, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25, nonlinear: false };
const lobes = stabilityLobes({ ...modal, N: 3, Ktc: mat.Ktc, Krc: mat.Krc, phiSt: 0, phiEx: Math.PI, rpmMin: 3000, rpmMax: 30000, lobes: 30 });
function chatter(S, ap) {
  const e = new CuttingEngine();
  e.configure(tool, modal, mat, S);
  for (let b = 0; b < BINS; b++) e.Hb[b] = (b + 0.5) / BINS < 0.5 ? 0 : -100;
  e.setEngagement([1, 0], 0.05, -ap, ap);
  e.vx = 0.01;
  e.run(e.stepsPerTooth * 3 * 200);
  return e.chatterIndex().index;
}
let agree = 0, total = 0;
for (const S of [9000, 12000, 16000, 21000, 26000]) {
  const lim = alimAt(lobes, S);
  const lo = chatter(S, 0.7 * lim), hi = chatter(S, 1.5 * lim);
  console.log(`S=${S} alim=${lim.toFixed(2)}mm  0.7·alim idx ${lo.toFixed(2)}  1.5·alim idx ${hi.toFixed(2)}`);
  total += 2; agree += (lo < 0.35) + (hi > 0.55);
}
assert.ok(agree >= total - 1, `time domain agrees with the multi-mode lobes (${agree}/${total})`);
console.log('frf tests passed');
