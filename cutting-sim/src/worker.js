// Runs the SPH solver off the UI thread and streams frames (positions + all fields) back.
import { CuttingSim } from './sph.js';
import { Mill } from './process.js';
import { toolOutline } from './tool.js';

let sim = null, running = false, t0 = 0, wall = 0;

onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') { sim = new CuttingSim(d.cfg); running = false; wall = 0; send(); }
  else if (d.type === 'run') { if (sim && !sim.done && !running) { running = true; t0 = performance.now(); loop(); } }
  else if (d.type === 'pause') { if (running) wall += performance.now() - t0; running = false; send(); }
};

function loop() {
  if (!running || !sim) return;
  const start = performance.now();
  while (performance.now() - start < 45 && !sim.done) sim.stepSample();
  if (sim.done) { running = false; wall += performance.now() - t0; }
  send();
  if (running) setTimeout(loop, 0);
}

function send() {
  const s = sim, N = s.N;
  let n = 0;
  for (let i = 0; i < N; i++) if (!s.dead[i]) n++;
  const x = new Float32Array(n), y = new Float32Array(n), T = new Float32Array(n), seq = new Float32Array(n);
  const ep = new Float32Array(n), sr = new Float32Array(n), p = new Float32Array(n), D = new Float32Array(n), flag = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < N; i++) {
    if (s.dead[i]) continue;
    x[k] = s.x[i] * 1e3; y[k] = s.y[i] * 1e3; T[k] = s.T[i]; seq[k] = s.seq[i] * 1e-6; ep[k] = s.ep[i];
    sr[k] = s.sr[i]; p[k] = s.p[i] * 1e-6; D[k] = s.dmg[i]; flag[k] = s.contact[i] ? 2 : s.fixed[i] === 1 ? 1 : 0; k++;
  }
  const t = s.tool, h = s.heat;
  const outline = toolOutline(t, Math.max(4 * s.h, 0.4e-3)).map(([a, b]) => [a * 1e3, b * 1e3]);
  const tg = Float32Array.from(h.steadyT || h.T);
  const now = running ? wall + performance.now() - t0 : wall;
  const v = s.view;
  postMessage({
    type: 'frame', x, y, T, seq, ep, sr, p, D, flag, outline, dx: s.dx * 1e3, h: s.h * 1e3,
    view: [v.x0 * 1e3, v.x1 * 1e3, v.y0 * 1e3, v.y1 * 1e3],
    tip: [t.ex * 1e3, t.ey * 1e3, t.r * 1e3, t.th],
    toolGrid: { nu: h.nu, nw: h.nw, u0: h.u0 * 1e3, w0: h.w0 * 1e3, a: h.a * 1e3, T: tg, inside: h.inside, steady: !!h.steadyT },
    mill: s.proc instanceof Mill ? { cx: s.proc.cx * 1e3, cy: s.proc.cy * 1e3, R: s.proc.R * 1e3 } : null,
    profile: s.done ? h.profile() : null,
    hist: s.hist, summary: s.summary(), running, wall: now, dt: s.dt,
  }, [x.buffer, y.buffer, T.buffer, seq.buffer, ep.buffer, sr.buffer, p.buffer, D.buffer, flag.buffer, tg.buffer]);
}
