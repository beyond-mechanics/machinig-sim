// Full JS run of an example, for comparison with the native core: summary and history as JSON.
// node native/scripts/jsrun.mjs <example> <out.json> [dxUm] [angle]
import { writeFileSync } from 'node:fs';
import { Cutting3D } from '../../src/sph3d.js';
import { exampleCfg } from './dump.mjs';
const [name = 'drill', out = 'js.json', dxUm, angle] = process.argv.slice(2);
const over = {};
if (dxUm) over.dxUm = +dxUm;
if (angle) over.angle = +angle;
const s = new Cutting3D(exampleCfg(name, over));
const t0 = performance.now();
while (!s.done) s.stepSample();
const runS = (performance.now() - t0) / 1e3;
const sm = s.summary();
writeFileSync(out, JSON.stringify({ runS, msPerStep: 1e3 * runS / s.steps, steps: s.steps, summary: { fx: sm.fx, fy: sm.fy, fz: sm.fz, torque: sm.torque, tmax: sm.tmax, pieces: sm.pieces, evacuated: sm.evacuated }, hist: { axis: s.hist.axis, fc: s.hist.fc, ft: s.hist.ft, fr: s.hist.fr, mz: s.hist.mz, tmax: s.hist.tmax } }));
console.log(`${s.steps} steps in ${runS.toFixed(0)} s`);
