// Runs the SPH solver off the UI thread and streams frames (positions + all fields) back.
import { CuttingSim } from './sph.js';
import { Mill } from './process.js';
import { toolOutline } from './tool.js';
import { Cutting3D } from './sph3d.js';

let sim = null, running = false, t0 = 0, wall = 0;

onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') { sim = (d.cfg.mode === '3d' || d.cfg.mode === 'helix') ? new Cutting3D(d.cfg) : new CuttingSim(d.cfg); running = false; wall = 0; send(); }
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
  if (sim instanceof Cutting3D) { send3d(); return; }
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

// 3D frame: positions and fields of live particles, the tool pose and its normal-section outline.
function send3d() {
  const s = sim, N = s.N;
  let n = 0;
  for (let i = 0; i < N; i++) if (!s.dead[i]) n++;
  const F = () => new Float32Array(n);
  const x = F(), y = F(), z = F(), T = F(), seq = F(), ep = F(), sr = F(), p = F(), D = F(), flag = new Uint8Array(n);
  // Periodic box: the edge lies along z there; turn the scene so the cutting velocity points
  // along +x and the edge shows its inclination λ, as on the machine.
  const c = s.periodic ? Math.cos(s.lam) : 1, sn = s.periodic ? Math.sin(s.lam) : 0;
  let k = 0;
  for (let i = 0; i < N; i++) {
    if (s.dead[i]) continue;
    x[k] = (s.x[i] * c + s.z[i] * sn) * 1e3; y[k] = s.y[i] * 1e3; z[k] = (-s.x[i] * sn + s.z[i] * c) * 1e3; T[k] = s.T[i]; seq[k] = s.seq[i] * 1e-6; ep[k] = s.ep[i];
    sr[k] = s.sr[i]; p[k] = s.p[i] * 1e-6; D[k] = s.dmg[i]; flag[k] = s.contact[i] ? 2 : s.fixed[i] === 1 ? 1 : 0; k++;
  }
  const now = running ? wall + performance.now() - t0 : wall;
  const outline = s.outline(3 * s.h).map(([a, b]) => [a * 1e3, b * 1e3]);
  // Helix: positions stay in the solver frame (z = cutter axis); the view turns the axis upright.
  const m = s.mill;
  const tool = s.helix
    ? { helix: true, c: [m.cx * 1e3, m.cy * 1e3], R: m.R * 1e3, rr: s.rr * 1e3, theta: m.beta, kh: s.kh * 1e-3, ap: s.bz * 1e3, outline }
    : { pos: [s.ox * c * 1e3, s.oy * 1e3, -s.ox * sn * 1e3], lam: s.lam, outline,
      len: ((s.periodic ? s.bz : s.bz / Math.max(Math.cos(s.lam), 0.3)) + 4 * s.h) * 1e3 };
  postMessage({
    type: 'frame', dim: 3, x, y, z, T, seq, ep, sr, p, D, flag, dx: s.dx * 1e3, h: s.h * 1e3,
    tool,
    box: [s.L * 1e3, s.H * 1e3, s.bz * 1e3],
    profile: s.done ? s.heat.profile() : null,
    hist: s.hist, summary: s.summary(), running, wall: now, dt: s.dt,
  }, [x.buffer, y.buffer, z.buffer, T.buffer, seq.buffer, ep.buffer, sr.buffer, p.buffer, flag.buffer, D.buffer]);
}
