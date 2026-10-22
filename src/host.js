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

  load(code, setup = {}) { this.sim.reportPack = null; this.sim.load(code, setup); this.send({ type: 'load', code, setup, cfg: this.cfgSnapshot(), gen: ++this.gen }); }
  // imported tool/holder meshes and tool libraries: structured-cloned, not JSON
  setAssets(a) { this.sim.setAssets(a); this.send({ type: 'assets', assets: a }); }
  reset() { this.sim.reportPack = null; this.sim.reset(); this.send({ type: 'reset', gen: ++this.gen }); }
  config(reconfigure = false) { if (reconfigure) this.sim.reconfigure(); this.send({ type: 'cfg', cfg: this.cfgSnapshot(), reconfigure }); }
  setSpeed(v) { this.sim.speed = v; this.send({ type: 'speed', speed: v }); }
  setRunning(r) { this.send({ type: 'run', running: r }); }
  // jump to machine time t: the worker runs ahead (after the reset that a backward jump needs,
  // which the caller has already sent); without a worker the local simulator does it
  seek(t) { if (this.worker) this.send({ type: 'seek', t }); else this.sim.seekTo(t); }

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
    Object.assign(sim, { mtime: m.mtime, line: m.line, done: m.done, pos: m.pos, ap: m.ap, wall: m.wall, S: m.S, seg: m.seg });
    sim.display = m.display;
    if (m.report) sim.reportPack = m.report;
    sim.hits = m.hits;
    sim.alerts = new Map(m.alerts);
    sim.cfg.dynBudget = m.dynBudget;
    if (m.engine) Object.assign(sim.engine, m.engine);
    const c = sim.chips;
    c.p = m.chips.p; c.state = m.chips.state; c.size = m.chips.size; c.heat = m.chips.heat; c.rot = m.chips.rot; c.stats = m.chips.stats; c.pool = m.chips.pool;
    const p = m.patch, s = sim.stock;
    if (p && p.H.length === (p.j1 - p.j0 + 1) * s.nx) {
      const off = p.j0 * s.nx;
      s.H.set(p.H, off); s.err.set(p.err, off); s.wallErr.set(p.wallErr, off); s.markS.set(p.markS, off); s.markF.set(p.markF, off);
      if (p.devIdeal && s.devIdeal) { s.devIdeal.set(p.devIdeal, off); s.devTarget.set(p.devTarget, off); }
      if (p.wallD) s.wallD.set(p.wallD, off);
      const d = s.dirty;
      d.i0 = Math.min(d.i0, p.i0); d.j0 = Math.min(d.j0, p.j0); d.i1 = Math.max(d.i1, p.i1); d.j1 = Math.max(d.j1, p.j1);
      s.removed = m.removed;
    }
  }
}
