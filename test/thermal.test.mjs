// Cutting temperature and tool wear: trends that any machinist expects, the calibration anchor,
// and the force increase of a worn flank in the dynamics.
import assert from 'node:assert/strict';
import { cuttingTemperature, wearRate, wornEdge, VB_LIMIT, edgeCycle, CARBIDE, T0 } from '../src/thermal.js';
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
// 5. wear belongs to each tool: a tool change starts from that tool's own wear
{
  const sim = new Simulator();
  sim.cfg.material = 'SUS304';
  sim.load(`(STOCK 80 40 20)
(TOOL T1 D10 N3 FLAT L25)
(TOOL T2 D6 N2 FLAT L15)
G21 G90
T1 M6
S3000 M3
G0 X-6 Y12 Z-2
G1 X86 F360
G0 Z5
T2 M6
S5000 M3
G0 X-6 Y30 Z-1
G1 X40 F300
G0 Z5
M30`);
  let vbAtChange = null;
  while (!sim.done) {
    const before = sim.activeT;
    sim.step(1 / 60);
    if (before === 1 && sim.activeT === 2) vbAtChange = sim.VB;
  }
  const w1 = sim.wear.get(1), w2 = sim.wear.get(2);
  console.log(`per-tool wear: T1 ${(w1 * 1000).toFixed(2)} µm, T2 ${(w2 * 1000).toFixed(2)} µm (T2 at its first move ${(vbAtChange * 1000).toFixed(2)} µm)`);
  assert.ok(w1 > 0 && w2 > 0, 'both tools wear');
  assert.ok(vbAtChange < 0.2 * w1, 'the new tool does not inherit the old tool\'s wear');
  assert.equal(sim.display.VB, w2, 'display shows the active tool');
}
// Interrupted cutting: the edge temperature over a revolution
{
  const Tss = 820, lc = 0.1, kap = CARBIDE.k / (CARBIDE.rho * CARBIDE.cp), tau = (lc * 1e-3) ** 2 / kap;
  // a continuous cut stays at the steady value
  const c = edgeCycle(Tss, 12000, 1, lc);
  assert.equal(c.swing, 0); assert.equal(c.onMean, Tss);
  // a long contact (≫ a²/κ) gets near the steady value and cools almost to ambient in the gap
  const L = edgeCycle(Tss, 600, 0.5, lc);
  assert.ok(L.max > T0 + 0.97 * (Tss - T0) && L.max < Tss + 1, `long contact peak ${L.max}`);
  assert.ok(L.min < T0 + 0.05 * (Tss - T0), `long gap low ${L.min}`);
  // a very short contact (high speed, light radial engagement): the 1-D semi-infinite rise
  // (2/√π)·√(t/τ) of a surface under constant flux, well below the steady value
  const S = 30000, duty = 0.02, s = edgeCycle(Tss, S, duty, lc), tOn = duty * 60 / S;
  const rise = 2 / Math.sqrt(Math.PI) * Math.sqrt(tOn / tau);
  const got = (s.max - T0) / (Tss - T0);
  console.log(`edge cycle: τ = a²/κ ${(tau * 1e3).toFixed(2)} ms; long contact ${L.min.toFixed(0)}–${L.max.toFixed(0)} °C; short ${(tOn * 1e3).toFixed(3)} ms contact: peak ${(got * 100).toFixed(0)} % of steady (1-D ${(rise * 100).toFixed(0)} %), wear temperature ${s.onMean.toFixed(0)} °C`);
  assert.ok(Math.abs(got / rise - 1) < 0.12, 'short contact follows the semi-infinite rise');
  assert.ok(s.onMean < s.max && s.onMean < T0 + 0.5 * (Tss - T0), 'and the edge cuts cooler, so it wears less');
  // coolant takes more heat out while the edge is out of the cut: lower low, larger swing
  const dry = edgeCycle(Tss, 300, 0.3, 0.2, 'dry'), wet = edgeCycle(Tss, 300, 0.3, 0.2, 'through');
  assert.ok(wet.min < dry.min && wet.swing > dry.swing);
  // the wear calibration point (a continuous cut) is unchanged by the cycle
  const m = MATERIALS.S50C, ref = cuttingTemperature(m, 0.05, m.vc / 60).tool;
  assert.equal(edgeCycle(ref, 5000, 1, 0.1).onMean, ref);
}
// A worn flank cuts on a smaller radius (VB·tan 10°): the wall is left oversize by that much
{
  const code = '(STOCK 60 40 20)\nG21 G90\nS8000 M3\nG0 X-6 Y-4.5 Z5\nG1 Z-5 F500\nG1 X66 F800\nG0 Z5\nM30';
  const left = VB0 => { const sim = new Simulator(); sim.cfg.tool.VB0 = VB0; sim.cfg.material = 'S50C'; sim.load(code, { origin: { x: 0, y: 0, z: 0 } }); sim.speed = 5; while (!sim.done) sim.step(1 / 60); return sim.deviationSummary().ideal.left; };
  const d = left(0.3) - left(0), want = 0.3 * Math.tan(10 * Math.PI / 180);
  console.log(`worn tool (VB 0.3 mm): wall left ${(d * 1000).toFixed(0)} µm thicker (VB·tan 10° = ${(want * 1000).toFixed(0)} µm)`);
  assert.ok(Math.abs(d - want) < 0.015);
}
// A ball nose in a shallow cut cuts near its axis: the speed for temperature and wear is the
// chip-weighted radius of the engaged edge, under √(2·R·ap) at the top of the cut
{
  const e = new CuttingEngine(), R = 5, ap = 0.2;
  e.configure({ N: 2, R, helixDeg: 30, type: 'ball', fluteLen: 20, nonlinear: false }, { k: 1e6, fn: 2000, zeta: 0.1 }, MATERIALS.S50C, 10000);
  for (let b = 0; b < BINS; b++) e.Hb[b] = (b + 0.5) / BINS < 0.5 ? 0 : -100;
  e.setEngagement([1, 0], 0.05, -ap, ap);
  e.run(e.stepsPerTooth * 2 * 20);
  const st = e.takeStats(), rEff = st.sumRb / st.sumHb, rTop = Math.sqrt(R * R - (R - ap) ** 2);
  console.log(`ball R5 at ap ${ap}: effective radius ${rEff.toFixed(2)} mm (top of cut ${rTop.toFixed(2)} mm)`);
  assert.ok(rEff > 0.3 * rTop && rEff <= rTop * 1.01);
}
console.log('thermal tests passed');
