// Runs the simulator off the main thread so the dynamics get a larger time budget than a
// render frame allows. Talks to host.js through plain messages and transferable snapshots.
import { Simulator } from './sim.js';
import { MAX_CHIPS } from './chips.js';

const sim = new Simulator();
let running = false, last = 0, gen = 0;
const TARGET_MS = 12;      // compute time per tick
const TICK_MS = 16;

self.onmessage = ({ data: m }) => {
  if (m.gen !== undefined) gen = m.gen;
  if (m.type === 'load') { Object.assign(sim.cfg, m.cfg); sim.load(m.code, m.setup); }
  else if (m.type === 'reset') sim.reset();
  else if (m.type === 'cfg') { Object.assign(sim.cfg, m.cfg, { dynBudget: sim.cfg.dynBudget }); if (m.reconfigure) sim.reconfigure(); }
  else if (m.type === 'speed') sim.speed = m.speed;
  else if (m.type === 'run') { running = m.running; last = performance.now(); }
};

function tick() {
  const t0 = performance.now();
  const dt = Math.min(0.05, (t0 - last) / 1000); last = t0;
  if (running && sim.path) {
    sim.step(dt);
    // adapt the dynamics budget to the time actually spent
    const ms = performance.now() - t0;
    sim.cfg.dynBudget = Math.max(1e5, Math.min(4e6, sim.cfg.dynBudget * Math.max(0.7, Math.min(1.3, TARGET_MS / Math.max(ms, 0.5)))));
  }
  if (sim.stock) post();
  setTimeout(tick, Math.max(0, TICK_MS - (performance.now() - t0)));
}

function post() {
  const e = sim.engine, s = sim.stock, c = sim.chips, h = e.hist;
  const transfer = [];
  const copy = a => { const b = a.slice(); transfer.push(b.buffer); return b; };
  let patch = null;
  const d = s.dirty;
  if (d.i1 >= 0) {
    const a = d.j0 * s.nx, b = (d.j1 + 1) * s.nx;
    patch = { j0: d.j0, j1: d.j1, i0: d.i0, i1: d.i1, H: copy(s.H.subarray(a, b)), err: copy(s.err.subarray(a, b)), wallErr: copy(s.wallErr.subarray(a, b)), markS: copy(s.markS.subarray(a, b)), markF: copy(s.markF.subarray(a, b)) };
    s.clearDirty();
  }
  self.postMessage({
    type: 'snap', gen,
    mtime: sim.mtime, line: sim.line, activeT: sim.activeT, done: sim.done, pos: sim.pos, ap: sim.ap, wall: sim.wall, S: sim.S,
    display: sim.display, alerts: [...sim.alerts], removed: s.removed, dynBudget: sim.cfg.dynBudget,
    engine: e.stepsPerTooth ? {
      x: e.x, y: e.y, w: e.w, wk: e.wk, wnx: e.wnx, wny: e.wny, runMeanW: e.runMeanW, omega: e.omega, S: e.S, N: e.N,
      stepsPerTooth: e.stepsPerTooth, decim: e.decim, dt: e.dt,
      hist: { n: h.n, i: h.i, count: h.count, Fx: copy(h.Fx), Fy: copy(h.Fy), Fz: copy(h.Fz), x: copy(h.x), y: copy(h.y) },
      toothSamples: { ...e.toothSamples, x: copy(e.toothSamples.x), y: copy(e.toothSamples.y) },
      wallSamples: { ...e.wallSamples, x: copy(e.wallSamples.x), y: copy(e.wallSamples.y) },
      wallSamplesPi: { ...e.wallSamplesPi, x: copy(e.wallSamplesPi.x), y: copy(e.wallSamplesPi.y) },
      ux: e.ux, uy: e.uy,
    } : null,
    chips: { p: copy(c.p), state: copy(c.state), size: copy(c.size), heat: copy(c.heat), rot: copy(c.rot), stats: c.stats,
      pool: c.pool ? { nx: c.pool.nx, ny: c.pool.ny, cx: c.pool.cx, cy: c.pool.cy, bed: copy(c.pool.bed), depth: copy(c.pool.depth) } : null },
    patch,
  }, transfer);
}

void MAX_CHIPS;
tick();
