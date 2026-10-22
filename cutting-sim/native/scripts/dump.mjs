// Sets up an STL-mode run with the JS solver (src/sph3d.js) and writes its state for the native
// core: the setup (filling the work, supports, the tool's distance field) stays in one place, JS,
// and the native core only steps. node native/scripts/dump.mjs <example> <out.json> [dxUm] [angle]
import { writeFileSync } from 'node:fs';
import { Cutting3D } from '../../src/sph3d.js';
import { EXAMPLES } from '../../src/examples3d.js';
import { dumpState } from '../../src/nativestate.js';

export function exampleCfg(name, over = {}) {
  const e = EXAMPLES[name], m = (t) => t.map((v) => v * 1e-3);
  const cfg = { mode: 'mesh', mat: 'S45C', vc: 200, ...e.cfg, toolTris: m(e.tool()), workTris: m(e.work()), ...over };
  if (cfg.axis) cfg.axis = cfg.axis.map((v) => v * 1e-3);
  return cfg;
}

export { dumpState };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name = 'drill', out = 'state.json', dxUm, angle] = process.argv.slice(2);
  const over = {};
  if (dxUm) over.dxUm = +dxUm;
  if (angle) over.angle = +angle;
  const s = new Cutting3D(exampleCfg(name, over));
  writeFileSync(out, JSON.stringify(dumpState(s)));
  console.log(`N ${s.N}, dt ${s.dt}, steps to go ${Math.round(s.cfg.angle * Math.PI / 180 / (s.om * s.dt))}`);
}
