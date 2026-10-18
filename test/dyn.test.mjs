import { CuttingEngine, BINS } from '../src/cutting.js';
import { stabilityLobes, alimAt } from '../src/sld.js';
import { toolModel } from '../src/tool.js';
import { MATERIALS } from '../src/materials.js';
const tool = { D: 10, R: 5, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25, stickout: 40, kSpindle: 10000 };
const tm = toolModel(tool);
const modal = { k: tm.k, fn: tm.fn, zeta: 0.03 };
console.log('tool model', tm);
const mat = MATERIALS.A5052;
const lobes = stabilityLobes({ ...modal, N: 3, Ktc: mat.Ktc, Krc: mat.Krc, phiSt: 0, phiEx: Math.PI, rpmMin: 3000, rpmMax: 30000 });
for (const S of [8000, 10000, 12000, 15000, 20000, 24000]) {
  const lim = alimAt(lobes, S);
  const res = [];
  for (const ap of [0.5, 1, 2, 4, 8]) {
    const e = new CuttingEngine();
    e.configure({ ...tool }, modal, mat, S);
    for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi < Math.PI ? 0 : -100; }
    e.setEngagement([1, 0], 0.05, -ap, ap);
    // seed perturbation
    e.vx = 0.01;
    e.run(e.stepsPerTooth * 3 * 150);
    const ci = e.chatterIndex();
    const st = e.takeStats();
    res.push(`ap${ap}: idx=${ci.index.toFixed(2)} amp=${ci.amp.toFixed(1)}um F=${(st.sumF/st.n).toFixed(0)}N`);
  }
  console.log(`S=${S} alim=${lim.toFixed(2)}mm |`, res.join(' | '));
}
