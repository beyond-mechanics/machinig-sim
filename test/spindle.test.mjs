// Speed-dependent tool-tip dynamics: bearing softening model, its effect on the tool tip,
// the speed-by-speed lobe diagram, agreement with the time-domain engine, and measured FRFs
// at several speeds.
import assert from 'node:assert/strict';
import { bearingFactor, tipFactor, modesAt } from '../src/spindle.js';
import { Simulator } from '../src/sim.js';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { stabilityLobes, alimAt } from '../src/sld.js';

// 1. the bearing model: 1 at rest, the given loss at the reference speed, falling with speed
{
  const soft = { drop: 0.25, Sref: 30000 };
  assert.equal(bearingFactor(0, soft), 1);
  assert.ok(Math.abs(bearingFactor(30000, soft) - 0.75) < 1e-12);
  assert.ok(bearingFactor(10000, soft) > bearingFactor(20000, soft));
  assert.equal(bearingFactor(30000, { drop: 0 }), 1);
  // a slender tool (its own bending dominates) changes less than a stubby one on the same spindle
  const slender = tipFactor(30000, 13000, 50000, soft), stubby = tipFactor(30000, 200000, 50000, soft);
  console.log(`tool-tip stiffness at 30000 min⁻¹: slender ${((slender - 1) * 100).toFixed(1)} %, stubby ${((stubby - 1) * 100).toFixed(1)} %`);
  assert.ok(slender > stubby && stubby < 0.85 && slender > 0.9);
}

const sim = new Simulator();
sim.load('(STOCK 50 50 10)\nG0 X0 Y0 Z5\nM30');

// 2. the tool tip softens with speed; at rest it is the hammer-test value
{
  const fn = S => sim.modalNow(S).modesX[0].fn;
  console.log(`fn: rest ${fn(0).toFixed(0)}, 15000 ${fn(15000).toFixed(0)}, 30000 ${fn(30000).toFixed(0)} Hz`);
  assert.equal(fn(0), sim.cfg.modal.fn);
  assert.ok(fn(0) > fn(15000) && fn(15000) > fn(30000));
}

// 3. the composite diagram matches the diagram of each speed's own FRF
const base = { N: 3, Ktc: sim.mat.Ktc, Krc: sim.mat.Krc, phiSt: 0, phiEx: Math.PI, lobes: 30, rpmMin: 2000, rpmMax: 40000 };
const dep = sim.lobes(0, Math.PI), rest = sim.lobes(0, Math.PI, true);
{
  let worst = 0;
  for (let S = 4000; S <= 38000; S += 1700) {
    const own = alimAt(stabilityLobes({ ...sim.modalNow(S), ...base }), S);
    worst = Math.max(worst, Math.abs(alimAt(dep, S) / own - 1));
  }
  console.log(`composite vs per-speed diagrams: worst ${(worst * 100).toFixed(2)} %`);
  assert.ok(worst < 0.01);
}

// 4. the pockets move to lower speed, and the time domain follows the shifted diagram. A stubby
//    tool (its tip compliance mostly the spindle's) shows it clearly: at the at-rest pocket the
//    tool at speed chatters, at the shifted pocket the tool at rest chatters, at a depth between
//    the two limits. (The default slender tool shifts only ~3 %, within the time-domain scatter.)
{
  const st = new Simulator();
  st.cfg.tool.stickout = 15; st.cfg.tool.fluteLen = 12;
  st.load('(STOCK 50 50 10)\nG0 X0 Y0 Z5\nM30');
  const dp = st.lobes(0, Math.PI), rs = st.lobes(0, Math.PI, true);
  const topIn = (L, a, b) => { let t = { S: 0, a: 0 }; for (let S = a; S <= b; S += 25) { const v = alimAt(L, S); if (v > t.a && v < 50) t = { S, a: v }; } return t; };
  const pRest = topIn(rs, 22000, 32000), pSpeed = topIn(dp, 20000, pRest.S - 500);
  console.log(`stubby tool fn ${st.modalNow(0).modesX[0].fn.toFixed(0)} → ${st.modalNow(30000).modesX[0].fn.toFixed(0)} Hz; pocket at rest ${pRest.S}, at speed ${pSpeed.S} min⁻¹`);
  assert.ok(pSpeed.S < pRest.S * 0.97, 'the pocket moves down by several per cent');
  const run = (modal, S, ap) => {
    const e = new CuttingEngine();
    e.configure({ N: 3, R: 5, helixDeg: 30, type: 'flat', fluteLen: 12, nonlinear: false }, modal, st.mat, S);
    for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi < Math.PI ? 0 : -100; }
    e.setEngagement([1, 0], 0.05, -ap, ap);
    e.vx = 0.01;
    e.run(e.stepsPerTooth * 3 * 150);
    return e.chatterIndex().index;
  };
  for (const [S, label] of [[pRest.S, 'at-rest pocket'], [pSpeed.S, 'at-speed pocket']]) {
    const lo = Math.min(alimAt(rs, S), alimAt(dp, S)), hi = Math.max(alimAt(rs, S), alimAt(dp, S));
    const ap = lo + 0.3 * (hi - lo);
    const iRest = run(st.modalNow(0), S, ap), iSpeed = run(st.modalNow(S), S, ap);
    console.log(`${label} ${S} min⁻¹, ap ${ap.toFixed(2)} (limits rest ${alimAt(rs, S).toFixed(2)}, speed ${alimAt(dp, S).toFixed(2)}): chatter index rest ${iRest.toFixed(2)}, at speed ${iSpeed.toFixed(2)}`);
    const restStable = alimAt(rs, S) > alimAt(dp, S);
    assert.ok(restStable ? iRest < 0.35 && iSpeed > 0.55 : iRest > 0.55 && iSpeed < 0.35, `${label}: the time domain follows the diagram of its own FRF`);
  }
}

// 5. FRFs measured at several speeds are interpolated and replace the model
{
  const m = { k: 10000, fn: 3000, zeta: 0.03, speedFrfs: [
    { S: 0, modesX: [{ k: 12000, fn: 3000, zeta: 0.03 }] },
    { S: 30000, modesX: [{ k: 9000, fn: 2400, zeta: 0.04 }] },
  ] };
  const at = S => modesAt(m, S, { kTool: 1e4, kSp: 5e4 }).x[0];
  assert.ok(Math.abs(at(15000).fn - 2700) < 1e-9 && Math.abs(at(15000).k - 10500) < 1e-9);
  assert.equal(at(40000).fn, 2400, 'held beyond the measured range');
  assert.equal(modesAt(m, 15000).y[0].fn, 2700, 'Y follows X when Y was not measured');
}

// Spindle/holder mode: two lumped masses give two tip modes whose compliances add up to the
// static chain, the spindle mode below the tool's; a stiff spindle leaves the tool mode alone;
// the bearing softening at speed lowers the spindle mode most
{
  const { twoDofModes } = await import('../src/spindle.js');
  const { SAMPLES } = await import('../src/samples.js');
  const kT = 10600, mT = kT * 1e3 / (2 * Math.PI * 2400) ** 2, kS = 50000, mS = kS * 1e3 / (2 * Math.PI * 1200) ** 2;
  const ms = twoDofModes(kT, mT, kS, mS);
  assert.ok(Math.abs(1 / ms.reduce((a, m) => a + 1 / m.k, 0) - 1 / (1 / kT + 1 / kS)) < 1e-6 * kT, 'static chain');
  assert.ok(ms[0].fn < 1200 && ms[1].fn > 2400 && ms[0].zeta === 0.05);
  const stiff = twoDofModes(kT, mT, 1e9, mS);
  // (the spindle mode then moves far up, above the tool's, and hardly shows at the tip)
  assert.ok(Math.abs(stiff[0].fn / 2400 - 1) < 1e-3 && stiff[0].zeta === 0.03 && stiff[1].k > 1e6, 'rigid spindle: the tool mode alone');
  const sim2 = new Simulator();
  sim2.cfg.modal.spindleMode = { on: true, fn: 1200, zeta: 0.05 }; sim2.load(SAMPLES.demo.code);
  const m0 = sim2.modalNow(0).modesX, m30 = sim2.modalNow(30000).modesX;
  console.log(`spindle mode: rest ${m0.map(m => Math.round(m.fn) + ' Hz').join(' + ')}, 30000 min⁻¹ ${m30.map(m => Math.round(m.fn) + ' Hz').join(' + ')}`);
  assert.equal(m0.length, 2);
  assert.ok(m30[0].fn / m0[0].fn < m30[1].fn / m0[1].fn && m30[0].fn < m0[0].fn, 'softening on the spindle mode');
  // the lobe diagram changes with the extra mode
  const a1 = sim2.lobes(0, Math.PI), sim3 = new Simulator(); sim3.load(SAMPLES.demo.code); const a0 = sim3.lobes(0, Math.PI);
  assert.ok(JSON.stringify(a1) !== JSON.stringify(a0));
}
console.log('spindle tests passed');
