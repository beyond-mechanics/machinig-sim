// Thin rib: the wall deflection should grow as the rib gets thinner and taller.
import { Simulator } from '../src/sim.js';
import { SAMPLES } from '../src/samples.js';
const sim = new Simulator();
sim.load(SAMPLES.rib.code);
sim.cfg.spindleOverride = 1;
sim.speed = 3;
let last = -1, frames = 0;
const t0 = performance.now();
while (!sim.done && frames < 30000) {
  sim.step(1 / 60); frames++;
  const d = sim.display;
  if (frames % 60 === 0 && d.cutting) {
    const w = d.wall;
    console.log(`t=${sim.mtime.toFixed(1)} N${sim.line} ap=${d.ap.toFixed(1)} F=${d.F.toFixed(0)}N tool=${d.defl.toFixed(1)}um wall=${d.wallDefl.toFixed(1)}/${d.wallMax.toFixed(1)}um ${w ? `t=${w.t.toFixed(2)} h=${w.hWall.toFixed(1)} a=${w.a.toFixed(1)} b=${w.bEff.toFixed(1)} k=${(w.k / 1000).toFixed(2)}N/um fn=${w.fn.toFixed(0)}` : 'rigid'} ${d.state}`);
  }
}
console.log('frames', frames, 'ms/frame', ((performance.now() - t0) / frames).toFixed(2));
// rib thickness check along the middle: nominal 1.5 mm
const s = sim.stock;
for (const z of [-2, -10, -18]) {
  let n = 0; const j0 = Math.round(20 / s.hy), j1 = Math.round(40 / s.hy), i = Math.round(50 / s.hx);
  for (let j = j0; j <= j1; j++) if (s.H[j * s.nx + i] > z) n++;
  console.log(`rib width at x=50 z=${z}: ${(n * s.hy).toFixed(2)} mm (grid ${s.hy.toFixed(2)})`);
}
