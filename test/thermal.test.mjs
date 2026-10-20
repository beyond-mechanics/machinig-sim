// Cutting temperature and tool wear: trends that any machinist expects, the calibration anchor,
// and the force increase of a worn flank in the dynamics.
import assert from 'node:assert/strict';
import { cuttingTemperature, wearRate, wornEdge, VB_LIMIT } from '../src/thermal.js';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { Simulator } from '../src/sim.js';
import { MATERIALS } from '../src/materials.js';

// 1. temperature rises with speed and chip thickness, harder materials run hotter
for (const [k, m] of Object.entries(MATERIALS)) {
  const t = (vf, h) => cuttingTemperature(m, h, m.vc * vf / 60).tool;
  assert.ok(t(2, 0.05) > t(1, 0.05) && t(1, 0.05) > t(0.5, 0.05), `${k}: hotter at higher speed`);
  assert.ok(t(1, 0.1) > t(1, 0.05) && t(1, 0.05) > t(1, 0.02), `${k}: hotter with thicker chips`);
  assert.ok(t(4, 0.2) < m.Tm, `${k}: stays below the solidus`);
}
const at = (k, vc) => cuttingTemperature(MATERIALS[k], 0.05, vc / 60).tool;
console.log(`at 100 m/min, h 0.05: A5052 ${at('A5052', 100).toFixed(0)}  S50C ${at('S50C', 100).toFixed(0)}  SUS304 ${at('SUS304', 100).toFixed(0)}  Ti64 ${at('Ti64', 100).toFixed(0)} °C`);
assert.ok(at('A5052', 100) < at('S50C', 100) && at('S50C', 100) < at('SUS304', 100), 'aluminium < steel < stainless');

// 2. calibration anchor and a Taylor-like life curve (doubling the speed cuts life several-fold)
for (const [k, m] of Object.entries(MATERIALS)) {
  const life = vc => VB_LIMIT / wearRate(m, vc / 60, cuttingTemperature(m, 0.05, vc / 60).tool) / 60;
  assert.ok(Math.abs(life(m.vc) / m.life - 1) < 1e-6, `${k}: reference life`);
  const n = Math.log(2) / Math.log(life(m.vc) / life(2 * m.vc)); // Taylor exponent V·T^n = C
  console.log(`${k}: life ${m.life} min at ${m.vc} m/min, ${life(2 * m.vc).toFixed(1)} min at ${2 * m.vc}; Taylor n ≈ ${n.toFixed(2)}`);
  assert.ok(n > 0.05 && n < 0.6, `${k}: Taylor exponent in the carbide range`);
}

// 3. a worn flank raises the cutting force (rigid tool, half-immersion)
{
  const m = MATERIALS.S50C;
  const F = VB => {
    const e = new CuttingEngine();
    e.configure({ N: 3, R: 5, helixDeg: 30, type: 'flat', fluteLen: 25 }, { k: 1e6, fn: 3000, zeta: 0.1 }, m, 4000);
    for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi > Math.PI / 2 && phi < Math.PI ? 0 : -100; }
    e.setEngagement([1, 0], 0.05, -2, 2);
    e.setWear(wornEdge(m, VB));
    e.run(e.stepsPerTooth * 30);
    const st = e.takeStats(); return st.sumF / st.n;
  };
  const f0 = F(0), f3 = F(0.3);
  console.log(`S50C force: sharp ${f0.toFixed(0)} N, VB 0.3 mm ${f3.toFixed(0)} N (+${((f3 / f0 - 1) * 100).toFixed(0)}%)`);
  assert.ok(f3 > 1.2 * f0 && f3 < 3 * f0, 'worn tool cuts with a higher force');
}

// 4. full simulator: wear accumulates while cutting and is reported with temperature
{
  const sim = new Simulator();
  sim.cfg.material = 'SUS304';
  sim.load(`(STOCK 80 40 20)
G21 G90 S3000 M3
G0 X-6 Y20 Z-2
G1 X86 F360
M30`);
  let maxT = 0;
  while (!sim.done) { sim.step(1 / 60); maxT = Math.max(maxT, sim.display.tempTool); }
  console.log(`SUS304 slot: tool ${maxT.toFixed(0)} °C, VB ${(sim.VB * 1000).toFixed(1)} µm after ${sim.mtime.toFixed(1)} s`);
  assert.ok(maxT > 300 && maxT < MATERIALS.SUS304.Tm, 'stainless slot runs hot');
  assert.ok(sim.VB > 0 && sim.VB < VB_LIMIT, 'wear accumulates');
}
console.log('thermal tests passed');
