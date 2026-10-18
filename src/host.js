// Main-thread side of the simulator. The local Simulator holds configuration, the tool
// path and a mirror of the worker's state that the view and charts read. Without Worker
// support it simply steps the local Simulator in the render loop as before.
/* global __WORKER_SRC__ */

export class SimHost {
  constructor(sim) {
    this.sim = sim;
    this.worker = null;
    this.gen = 0;
    try {
      if (typeof Worker !== 'undefined' && typeof __WORKER_SRC__ === 'string') {
        const url = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        this.worker.onmessage = ev => this.apply(ev.data);
        this.worker.onerror = () => { this.worker = null; };
      }
    } catch { this.worker = null; }
  }
  get threaded() { return !!this.worker; }
  send(m) { if (this.worker) this.worker.postMessage(m); }
  cfgSnapshot() { return JSON.parse(JSON.stringify(this.sim.cfg)); }

  load(code, setup = {}) { this.sim.load(code, setup); this.send({ type: 'load', code, setup, cfg: this.cfgSnapshot(), gen: ++this.gen }); }
  reset() { this.sim.reset(); this.send({ type: 'reset', gen: ++this.gen }); }
  config(reconfigure = false) { if (reconfigure) this.sim.reconfigure(); this.send({ type: 'cfg', cfg: this.cfgSnapshot(), reconfigure }); }
  setSpeed(v) { this.sim.speed = v; this.send({ type: 'speed', speed: v }); }
  setRunning(r) { this.send({ type: 'run', running: r }); }

  // advance one render frame; in threaded mode the worker advances on its own
  frame(dt, running) {
    if (this.worker) return;
    if (running) this.sim.step(dt);
  }

  apply(m) {
    // ignore snapshots from before the latest load/reset
    if (m.type !== 'snap' || m.gen !== this.gen) return;
    const sim = this.sim;
    if (!sim.stock) return;
    if (m.activeT !== sim.activeT) sim.setActiveTool(m.activeT);
    Object.assign(sim, { mtime: m.mtime, line: m.line, done: m.done, pos: m.pos, ap: m.ap, wall: m.wall, S: m.S });
    sim.display = m.display;
    sim.alerts = new Map(m.alerts);
    sim.cfg.dynBudget = m.dynBudget;
    if (m.engine) Object.assign(sim.engine, m.engine);
    const c = sim.chips;
    c.p = m.chips.p; c.state = m.chips.state; c.size = m.chips.size; c.heat = m.chips.heat; c.rot = m.chips.rot; c.stats = m.chips.stats;
    const p = m.patch, s = sim.stock;
    if (p && p.H.length === (p.j1 - p.j0 + 1) * s.nx) {
      const off = p.j0 * s.nx;
      s.H.set(p.H, off); s.err.set(p.err, off); s.wallErr.set(p.wallErr, off); s.markS.set(p.markS, off); s.markF.set(p.markF, off);
      const d = s.dirty;
      d.i0 = Math.min(d.i0, p.i0); d.j0 = Math.min(d.j0, p.j0); d.i1 = Math.max(d.i1, p.i1); d.j1 = Math.max(d.j1, p.j1);
      s.removed = m.removed;
    }
  }
}
