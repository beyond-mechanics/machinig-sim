// JS reference run of an STL example: steps/s and the force history, for comparison with the native core.
// node native/scripts/jsbench.mjs <example> <steps> [dxUm]
import { Cutting3D } from '../../src/sph3d.js';
import { EXAMPLES } from '../../src/examples3d.js';
const [name = 'drill', steps = '200', dxUm] = process.argv.slice(2);
const e = EXAMPLES[name], m = (t) => t.map((v) => v * 1e-3);
const cfg = { mode: 'mesh', mat: 'S45C', vc: 200, ...e.cfg, toolTris: m(e.tool()), workTris: m(e.work()) };
if (cfg.axis) cfg.axis = cfg.axis.map((v) => v * 1e-3);
if (dxUm) cfg.dxUm = +dxUm;
let t0 = performance.now();
const s = new Cutting3D(cfg);
const tSetup = performance.now() - t0;
t0 = performance.now();
for (let k = 0; k < +steps && !s.done; k++) s.stepSample();
const tRun = performance.now() - t0;
const est = s.cfg.angle * Math.PI / 180 / (s.om * s.dt);
console.log(JSON.stringify({ N: s.N, setupMs: tSetup | 0, steps: s.steps, msPerStep: +(tRun / s.steps).toFixed(2), totalSteps: Math.round(est), estMin: +(est * tRun / s.steps / 6e4).toFixed(1), np: s.np, progress: s.progress() }));
