// Size effect and process damping: specific force rises at thin chips, and low-speed cutting
// in steel stays stable well above the linear stability limit while high speed does not.
import assert from 'node:assert/strict';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { stabilityLobes } from '../src/sld.js';
import { toolModel } from '../src/tool.js';
import { MATERIALS } from '../src/materials.js';

const tool = { D: 10, R: 5, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25, stickout: 30, kSpindle: 50000 };
const tm = toolModel(tool);
const modal = { k: tm.k, fn: tm.fn, zeta: 0.04 };

function cut(mat, S, ap, fz, nonlinear, md = modal, revs = 150) {
  const e = new CuttingEngine();
  e.configure({ ...tool, nonlinear }, md, mat, S);
  // half-immersion down milling: material on the second quarter of the revolution
  for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi > Math.PI / 2 && phi < Math.PI ? 0 : -100; }
  e.setEngagement([1, 0], fz, -ap, ap);
  e.vx = 0.01;
  e.run(e.stepsPerTooth * 3 * revs);
  const ci = e.chatterIndex(), st = e.takeStats();
  return { idx: ci.index, amp: ci.amp, F: st.sumF / st.n };
}

// 1. size effect: force per feed rises as the chip gets thinner (rigid tool, no chatter)
{
  const m = MATERIALS.S50C, rigid = { k: 1e6, fn: 2200, zeta: 0.1 };
  const lin = [0.01, 0.1].map(fz => cut(m, 3000, 1, fz, false, rigid).F / fz);
  const nl = [0.01, 0.1].map(fz => cut(m, 3000, 1, fz, true, rigid).F / fz);
  console.log('specific force ratio thin/thick  linear', (lin[0] / lin[1]).toFixed(2), ' nonlinear', (nl[0] / nl[1]).toFixed(2));
  assert.ok(nl[0] / nl[1] > lin[0] / lin[1] * 1.05, 'size effect raises specific force at thin chips');
}

// 2. process damping: steel above the linear limit chatters at high speed, but low speed
//    (short vibration wavelength on the cut surface) is damped by the flank
{
  const m = MATERIALS.S50C;
  const lobes = stabilityLobes({ ...modal, N: 3, Ktc: m.Ktc, Krc: m.Krc, phiSt: Math.PI / 2, phiEx: Math.PI, rpmMin: 3000, rpmMax: 30000 });
  const alimMin = Math.min(...lobes.flat().map(p => p.alim));
  const ap = 2;
  assert.ok(ap > 2 * alimMin, 'test depth is well above the linear limit');
  const res = {};
  for (const S of [1500, 8000]) {
    const a = cut(m, S, ap, 0.05, false), b = cut(m, S, ap, 0.05, true);
    res[S] = { a, b };
    console.log(`S=${S} vc=${(Math.PI * 10 * S / 1000).toFixed(0)}m/min ap=${ap} (linear limit ${alimMin.toFixed(2)}) | linear idx ${a.idx.toFixed(2)} ${a.amp.toFixed(0)}µm | with process damping idx ${b.idx.toFixed(2)} ${b.amp.toFixed(0)}µm`);
  }
  assert.ok(res[1500].a.idx > 0.55, 'linear model chatters at low speed');
  assert.ok(res[1500].b.idx < 0.35, 'process damping stabilises low speed');
  assert.ok(res[8000].b.idx > 0.55, 'process damping fades at high speed');
}
console.log('process tests passed');
