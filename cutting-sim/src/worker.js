// Runs the SPH solver off the UI thread and streams frames (positions + all fields) back.
import { CuttingSim } from './sph.js';
import { toolOutline } from './tool.js';

let sim = null, running = false, lastSample = 0, t0 = 0, wall = 0;

onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') { sim = new CuttingSim(d.cfg); running = false; lastSample = 0; wall = 0; send(); }
  else if (d.type === 'run') { if (sim && !sim.done && !running) { running = true; t0 = performance.now(); loop(); } }
  else if (d.type === 'pause') { if (running) wall += performance.now() - t0; running = false; send(); }
};

function loop() {
  if (!running || !sim) return;
  const start = performance.now(), every = sim.cfg.cutLen * 1e-3 / 160;
  while (performance.now() - start < 45 && !sim.done) {
    sim.step();
    if (sim.travel - lastSample >= every) { sim.sample(); lastSample = sim.travel; }
  }
  if (sim.done) { sim.sample(); running = false; wall += performance.now() - t0; }
  send();
  if (running) setTimeout(loop, 0);
}

function send() {
  const s = sim, N = s.N;
  let n = 0;
  for (let i = 0; i < N; i++) if (!s.dead[i]) n++;
  const x = new Float32Array(n), y = new Float32Array(n), T = new Float32Array(n), seq = new Float32Array(n);
  const ep = new Float32Array(n), sr = new Float32Array(n), p = new Float32Array(n), flag = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < N; i++) {
    if (s.dead[i]) continue;
    x[k] = s.x[i] * 1e3; y[k] = s.y[i] * 1e3; T[k] = s.T[i]; seq[k] = s.seq[i] * 1e-6; ep[k] = s.ep[i];
    sr[k] = s.sr[i]; p[k] = s.p[i] * 1e-6; flag[k] = s.contact[i] ? 2 : s.fixed[i] === 1 ? 1 : 0; k++;
  }
  const outline = toolOutline(s.tool, Math.max(4 * s.h, 0.4e-3)).map(([a, b]) => [a * 1e3, b * 1e3]);
  const now = running ? wall + performance.now() - t0 : wall;
  postMessage({
    type: 'frame', x, y, T, seq, ep, sr, p, flag, outline, dx: s.dx * 1e3, L: s.L * 1e3, H: s.H * 1e3,
    tip: [s.tool.ex * 1e3, s.tool.ey * 1e3, s.tool.r * 1e3], hist: s.hist, summary: s.summary(),
    running, wall: now, dt: s.dt,
  }, [x.buffer, y.buffer, T.buffer, seq.buffer, ep.buffer, sr.buffer, p.buffer, flag.buffer]);
}
