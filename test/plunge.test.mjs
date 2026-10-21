// End (bottom) edge forces: a plunge must give the analytic thrust and torque of the end edges,
// and a ramp / plunge in the full simulator must produce thrust instead of cutting for free.
import assert from 'node:assert/strict';
import { CuttingEngine, END_RINGS } from '../src/cutting.js';
import { Simulator } from '../src/sim.js';
import { MATERIALS } from '../src/materials.js';

const m = MATERIALS.A5052;
const rigid = { k: 1e6, fn: 3000, zeta: 0.1 };

// edge height above the tip by radius (what the simulator derives from the tool's tip shape)
const R5 = 5;
const PROFILE = {
  flat: () => 0,
  ball: r => R5 - Math.sqrt(Math.max(0, R5 * R5 - r * r)),
  bull: r => { const rc = 2, r0 = R5 - rc; return r <= r0 ? 0 : rc - Math.sqrt(Math.max(0, rc * rc - (r - r0) ** 2)); },
};

function plunge(type, fza) {
  const e = new CuttingEngine();
  e.configure({ N: 3, R: 5, helixDeg: 30, type: type === 'bull' ? 'flat' : type, fluteLen: 25, nonlinear: false }, rigid, m, 6000);
  e.Hb.fill(-100);
  e.Eb.fill(1); // 1 mm of material under the whole end face
  e.setEngagement([1, 0], 0, 0, 0);
  e.setEndEngagement(fza, 5, PROFILE[type]);
  e.run(e.stepsPerTooth * 3 * 20);
  const st = e.takeStats();
  return { Fz: -st.sumFz / st.n, T: st.sumT / st.n, Fxy: Math.hypot(st.sumFx, st.sumFy) / st.n };
}

// flat: thrust = N·(Krc·fza + Kre)·R, torque = N·(Ktc·fza + Kte)·R²/2 (rings: Σr dr ≈ R²/2)
{
  const fza = 0.02, R = 5, N = 3;
  const p = plunge('flat', fza);
  const Fz = N * (m.Krc * fza + m.Kre) * R;
  let sr = 0; for (let j = 0; j < END_RINGS; j++) sr += (j + 0.5) * (R / END_RINGS) * (R / END_RINGS);
  const T = N * (m.Ktc * fza + m.Kte) * sr;
  console.log(`flat plunge fza=${fza}: Fz ${p.Fz.toFixed(1)} N (analytic ${Fz.toFixed(1)}), T ${p.T.toFixed(0)} N·mm (analytic ${T.toFixed(0)}), lateral ${p.Fxy.toFixed(2)} N`);
  assert.ok(Math.abs(p.Fz / Fz - 1) < 0.02, 'thrust matches the end-edge model');
  assert.ok(Math.abs(p.T / T - 1) < 0.02, 'torque matches the end-edge model');
  assert.ok(p.Fxy < 0.05 * p.Fz, 'symmetric teeth cancel in-plane');
  const p2 = plunge('flat', 2 * fza);
  assert.ok(Math.abs(p2.Fz / p.Fz - (m.Krc * 2 * fza + m.Kre) / (m.Krc * fza + m.Kre)) < 0.02, 'thrust grows with axial feed as Krc·fza + Kre');
  // ball nose: chip thickness fza·cosκ on a longer edge dr/cosκ, thrust component ·cosκ → lower thrust
  const b = plunge('ball', fza);
  console.log(`ball plunge: Fz ${b.Fz.toFixed(1)} N, T ${b.T.toFixed(0)} N·mm`);
  assert.ok(b.Fz < p.Fz && b.Fz > 0.3 * p.Fz, 'ball nose thrust below flat');
  // bull nose (corner R2): flat centre, inclined corner → between the two
  const bu = plunge('bull', fza);
  console.log(`bull nose R2 plunge: Fz ${bu.Fz.toFixed(1)} N`);
  assert.ok(bu.Fz < p.Fz && bu.Fz > b.Fz, 'bull nose thrust between ball and flat');
}

// full simulator: a plunge then a ramp into the stock
{
  const sim = new Simulator();
  sim.load(`(STOCK 60 40 20)
G21 G90 S8000 M3
G0 X15 Y20 Z2
G1 Z0 F400
G1 Z-2 F300
G1 X45 Z-4 F900
G1 X15
G0 Z5
M30`);
  sim.speed = 1;
  let maxFzPlunge = 0, maxFzRamp = 0, maxT = 0;
  while (!sim.done) {
    sim.step(1 / 60);
    const d = sim.display;
    if (sim.line === 5) maxFzPlunge = Math.max(maxFzPlunge, d.Fz);
    if (sim.line === 6) maxFzRamp = Math.max(maxFzRamp, d.Fz);
    if (sim.line <= 6) maxT = Math.max(maxT, d.torque);
  }
  console.log(`sim: plunge Fz ${maxFzPlunge.toFixed(0)} N, ramp Fz ${maxFzRamp.toFixed(0)} N, torque ${maxT.toFixed(2)} N·m, alerts`, [...sim.alerts.values()].map(a => a.msg));
  assert.ok(maxFzPlunge > 20, 'plunge produces thrust');
  assert.ok(maxFzRamp > 5, 'ramp produces thrust');
  assert.ok(maxT > 0.05, 'plunge produces torque');
}
console.log('plunge tests passed');
