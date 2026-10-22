// Advice on flagged report lines: the numbers it gives do what they say under the same models.
import assert from 'node:assert/strict';
import { adviceFor } from '../src/advice.js';
import { forceRatio } from '../src/feedopt.js';
import { cuttingTemperature } from '../src/thermal.js';
import { MATERIALS } from '../src/materials.js';

const limits = { stress: 1500, temp: 900, swing: 400 };
const mat = MATERIALS.SUS304;
// stress over the limit: the feed factor brings it to 80 % of the limit
{
  const r = { why: ['応力超過'], stress: 1800, h: 0.06, temp: 600, swing: 0 };
  const a = adviceFor(r, { mat, nonlinear: true, S: 3000, F: 900, D: 10, rakeDeg: 10, limits });
  const k = +a[0].match(/×([\d.]+)/)[1];
  assert.ok(Math.abs(1800 * forceRatio(mat, 0.06, k, true) - 1200) < 25, a[0]);
  assert.match(a[0], /900 → \d+ mm\/min/);
  console.log(a.join(' / '));
}
// hot edge and a large swing: the spindle factor brings the quasi-steady temperature down so
// that the peak and the swing fall under their guides
{
  const D = 10, S = 6000, h = 0.05, Vc = Math.PI * D * S / 60000, T1 = cuttingTemperature(mat, h, Vc).tool;
  // a cycle peak 10 % over the guide and a swing 20 % over it
  const r = { why: ['高温', '熱亀裂注意'], stress: 500, h, temp: 990, swing: 480 };
  const a = adviceFor(r, { mat, nonlinear: true, S, F: 1200, D, rakeDeg: 10, limits });
  const q = +a[0].match(/×([\d.]+)/)[1], T = cuttingTemperature(mat, h, Vc * q).tool;
  assert.ok(q < 1 && T * r.temp / T1 <= 900 + 1 && (T - 20) / (T1 - 20) * r.swing <= 400 + 1, `${a[0]}: ${T}`);
  assert.ok(a.some(s => /熱亀裂/.test(s)));
  console.log(`T ${T1.toFixed(0)} → ${T.toFixed(0)} °C: ` + a.join(' / '));
}
// chatter and vibration: pointers, no numbers needed
{
  const a = adviceFor({ why: ['びびり', '振動大'], stress: 300, h: 0.03, temp: 300, swing: 0 }, { mat, S: 8000, F: 1000, D: 10, limits });
  assert.equal(a.length, 1); assert.match(a[0], /安定ポケット/);
}
console.log('advice tests passed');
// chatter with the line's lobes at hand: the limit and a better speed in numbers
{
  const r = { why: ['びびり'], stress: 300, h: 0.03, temp: 300, swing: 0, ap: 2, pst: 0, pex: Math.PI };
  const a = adviceFor(r, { mat, S: 8000, F: 1000, D: 10, limits, stability: () => ({ alim: 0.7, pocketS: 9500, pocketA: 2.4 }) });
  assert.match(a[0], /0\.70 mm/); assert.match(a[0], /S9500/);
}
