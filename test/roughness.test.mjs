// Side-wall roughness: without vibration the envelope reproduces the scallop height fz²/(8R);
// a stable cut stays near it and chatter raises it by orders of magnitude.
import assert from 'node:assert/strict';
import { wallProfile } from '../src/roughness.js';
import { CuttingEngine, BINS } from '../src/cutting.js';
import { MATERIALS } from '../src/materials.js';

const ring = (pts) => ({ n: 64, i: pts.length % 64, count: pts.length, x: Float32Array.from(pts.map(p => p[0])), y: Float32Array.from(pts.map(p => p[1])) });
{
  const R = 5, fz = 0.1;
  const p = wallProfile(ring(Array.from({ length: 30 }, () => [0, 0])), [1, 0], 1, R, fz);
  console.log(`ideal: Rz ${p.Rz.toFixed(3)} µm, theory ${p.Rth.toFixed(3)} µm`);
  assert.ok(Math.abs(p.Rz / p.Rth - 1) < 0.03, 'ideal scallop height');
}

const tool = { R: 5, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25 };
const modal = { k: 10570, fn: 2200, zeta: 0.04 };
function rough(S, ap) {
  const e = new CuttingEngine();
  e.configure(tool, modal, MATERIALS.A5052, S);
  // slot: both walls are generated
  for (let b = 0; b < BINS; b++) e.Hb[b] = (b + 0.5) / BINS < 0.5 ? 0 : -100;
  e.setEngagement([1, 0], 0.05, -ap, ap);
  e.vx = 0.001;
  e.run(e.stepsPerTooth * 3 * 200);
  return [wallProfile(e.wallSamples, [1, 0], 1, 5, 0.05), wallProfile(e.wallSamplesPi, [1, 0], -1, 5, 0.05)];
}
const st = rough(12000, 0.4), ch = rough(12000, 2);
console.log(`stable  12000 rpm ap 0.4: Rz ${st[0].Rz.toFixed(2)} / ${st[1].Rz.toFixed(2)} µm (theory ${st[0].Rth.toFixed(3)})`);
console.log(`chatter 12000 rpm ap 2.0: Rz ${ch[0].Rz.toFixed(2)} / ${ch[1].Rz.toFixed(2)} µm`);
assert.ok(st[0].Rz < 1 && st[1].Rz < 1, 'stable cut leaves a smooth wall');
assert.ok(Math.max(ch[0].Rz, ch[1].Rz) > 10 * Math.max(st[0].Rz, st[1].Rz), 'chatter roughens the wall');
console.log('roughness tests passed');
