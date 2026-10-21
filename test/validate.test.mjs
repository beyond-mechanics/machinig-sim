// Validation against a force record: parsing, synchronous averaging, the asynchronous peak, and
// the coefficients and runout recovered from a synthetic record whose truth is known.
import assert from 'node:assert/strict';
import { parseRecord, syncAverage, simRevolution, align, shifted, compare, fitRecord, syntheticRecord, asyncPeak, NB } from '../src/validate.js';
import { MATERIALS } from '../src/materials.js';

const m = MATERIALS.A5052, tool = { D: 10, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25 };
const test = { S: 6000, fz: 0.05, ap: 2, ae: 3, mode: 'down' };
const truth = { ...m, Ktc: m.Ktc * 1.15, Krc: m.Krc * 0.85, Kte: m.Kte * 1.4 };
const tTool = { ...tool, runout: 7, runoutPhase: 1.1 };   // 7 µm lies between the search grid's sizes

// 1. the header gives the test, the rows the record; text rows are skipped, broken ones counted
{
  const r = parseRecord('# S=3000 fz=0.05 ap=2 ae=3 mode=DOWN D=8 N=4 helix=35\nt,Fx,Fy,Fz\n0,1,2,3\n0.001;4;5;6\n0.002 7 8\nx\n1,2\n');
  assert.deepEqual(r.test, { S: 3000, fz: 0.05, ap: 2, ae: 3, mode: 'down', D: 8, N: 4, helix: 35 });
  assert.deepEqual(r.t, [0, 0.001, 0.002]); assert.deepEqual(r.F[1], [2, 5, 8]); assert.equal(r.bad.length, 1);
}
// 2. averaging over the revolutions takes the noise out: the average is the clean revolution
const noisy = parseRecord(syntheticRecord(tTool, truth, test, { noise: 0.05, ring: 0.05, ringHz: 2317, revs: 30 }));
const sa = syncAverage(noisy.t, noisy.F, test.S);
{
  const clean = simRevolution(tTool, truth, test), c = compare(sa.avg, shifted(clean, align(sa.avg, clean)));
  assert.ok(c.every(x => x.r > 0.99 && x.rmsPct < 4), c.map(x => `${x.comp} ${x.rmsPct.toFixed(1)}% r ${x.r.toFixed(3)}`).join(' '));
  assert.ok(Math.abs(sa.revs - 30) < 0.1);
}
// 3. the ringing (not locked to the spindle) shows as the asynchronous peak; a clean cut has none
{
  const pk = asyncPeak(noisy.t, noisy.F, test.S, tool.N, sa.avg);
  assert.ok(Math.abs(pk.f - 2317) < 15 && pk.share > 0.1, JSON.stringify(pk));
  const q = parseRecord(syntheticRecord(tTool, truth, test, { noise: 0.05, revs: 30 })), qa = syncAverage(q.t, q.F, test.S);
  assert.ok(asyncPeak(q.t, q.F, test.S, tool.N, qa.avg).share < 0.1);
  console.log(`asynchronous peak ${pk.f.toFixed(0)} Hz (${(pk.share * 100).toFixed(0)}% of the asynchronous part)`);
}
// 4. coefficients and runout from one feed: the truth comes back
{
  const f = fitRecord(tool, m, test, sa.avg);
  for (const k of ['Ktc', 'Krc', 'Kac', 'Kte', 'Kre']) assert.ok(Math.abs(f.coefs[k] / truth[k] - 1) < 0.04, `${k} ${f.coefs[k].toFixed(1)} vs ${truth[k]}`);
  assert.ok(Math.abs(f.runout - 7) <= 0.5, `runout ${f.runout}`);
  assert.ok(f.cmp.every(c => c.rmsPct < 4));
  console.log(`fit: Ktc ${f.coefs.Ktc.toFixed(0)} (truth ${truth.Ktc.toFixed(0)}), Krc ${f.coefs.Krc.toFixed(0)} (${truth.Krc.toFixed(0)}), Kte ${f.coefs.Kte.toFixed(1)} (${truth.Kte.toFixed(1)}), runout ${f.runout} µm (7)`);
}
// 5. a coarse sampling leaves empty angle bins: they are filled, not NaN
{
  const r = parseRecord(syntheticRecord(tool, m, test, { fs: 3000, noise: 0, revs: 5 })), a = syncAverage(r.t, r.F, test.S);
  assert.ok(a.avg.every(c => c.every(Number.isFinite)) && a.cnt.some(v => v === 0) && a.avg[0].length === NB);
}
console.log('validate tests passed');
