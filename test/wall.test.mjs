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

// Drafted wall: thicker at the root, stiffer than the thickness at the load height alone says
{
  const assert = (await import('node:assert/strict')).default;
  const { Stock } = await import('../src/stock.js');
  const { wallAt } = await import('../src/wall.js');
  const { BINS } = await import('../src/cutting.js');
  const { MATERIALS } = await import('../src/materials.js');
  const mat = MATERIALS.A5052, R = 5;
  // a rib along Y with its cutter-side face at x = 12; far face vertical at x = 10 (uniform) or
  // drafted from x = 8 at the root (z = −20) to x = 10 at the top (4 mm → 2 mm)
  const rib = drafted => {
    const s = new Stock(40, 40, 20, 0.1);
    for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) {
      const x = i * s.hx;
      let h = -20;
      if (x >= 10 && x <= 12) h = 0;
      else if (drafted && x >= 8 && x < 10) h = -20 + (x - 8) * 10;
      s.H[j * s.nx + i] = h;
    }
    return s;
  };
  const Hb = new Float32Array(BINS).map((_, b) => ((b + 0.5) / BINS * 2 * Math.PI < 0.25 ? 0 : -100));
  const at = drafted => wallAt(rib(drafted), { x: 12 + R, y: 20, z: -20 }, R, Hb, [0, 1], -10, mat, 1e9);
  const u = at(false), d = at(true);
  // the heightfield edge reads a little thick (bilinear sampling): compare like with like
  const a = u.a, dt = u.t - 2, kU = t => 3 * mat.E * (u.bEff * t ** 3 / 12) / a ** 3;
  // the drafted rib's compliance by direct integration of its thickness profile
  let comp = 0; const n = 2000;
  for (let q = 0; q < n; q++) { const z = (q + 0.5) / n * a, t = 4 - 2 * z / 20 + dt; comp += (a - z) ** 2 / (mat.E * u.bEff * t ** 3 / 12) * (a / n); }
  console.log(`rib k: uniform 2 mm ${u.k.toFixed(0)} N/mm (3EI/a³ ${kU(u.t).toFixed(0)}, t ${u.t.toFixed(2)}), drafted 4→2 mm ${d.k.toFixed(0)} N/mm (integral ${(1 / comp).toFixed(0)}, uniform 4 mm ${kU(4 + dt).toFixed(0)}); root ${d.tRoot.toFixed(2)} mm`);
  assert.ok(Math.abs(u.k / kU(u.t) - 1) < 0.03, 'uniform wall: the cantilever formula');
  assert.ok(Math.abs(d.k * comp - 1) < 0.08, 'drafted wall: the integral over its thickness profile');
  assert.ok(d.k > 1.5 * u.k && d.k < kU(4 + dt), 'between the uniform walls');
}
