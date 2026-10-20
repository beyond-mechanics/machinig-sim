// Cutting processes: initial workpiece geometry, tool kinematics and what to report.
//  - Ortho: orthogonal cutting, a straight tool moving at Vc through a layer of thickness h.
//  - Mill: one tooth of an end mill in peripheral (side) milling, in the plane normal to the
//    tool axis (no helix). The tooth rotates at Vc about the moving cutter centre and removes
//    the comma-shaped chip left between the previous tooth's arc and its own: h(β) = fz·|cos β|
//    from 0 to fz·sin Δ, with Δ = acos((R − ae)/R). Up milling enters at h = 0 and exits at hmax,
//    down milling the reverse. With passes > 1 the next teeth follow, each one fz further on,
//    cutting the surface the previous one left (work-hardened, residual stress, real shape).
import { setPose } from './tool.js';

const DEG = Math.PI / 180;

export class Ortho {
  constructor(c) {
    this.c = c;
    this.h = c.h * 1e-3;
    this.hRef = this.h;                       // thickness that sets the particle size
  }
  build(dx) {
    const c = this.c, h = this.h;
    const L = c.cutLen * 1e-3 + Math.max(3 * h, 0.2e-3);
    const H = Math.max(3.5 * h, h + 12 * dx, (c.depth || 0) * 1e-3);
    const nx = Math.round(L / dx), ny = Math.round(H / dx);
    this.L = nx * dx; this.H = ny * dx;
    const pts = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx, y = -(j + 0.5) * dx;
      // Supports: bottom and far-end layers, plus the entry face below the cut (the tool never reaches it).
      const fixed = j >= ny - 3 || i >= nx - 3 || (i < 3 && y < -h - 1.5 * dx);
      pts.push([x, y, fixed ? 1 : 0]);
    }
    this.view = { x0: -0.15e-3, x1: this.L + 0.02e-3, y0: -this.H - 0.02e-3, y1: Math.max(0.5e-3, 6 * h) };
    return pts;
  }
  init(sim) {
    const t = sim.tool;
    this.x0 = -t.umax - sim.dx;
    this.V = sim.V;
    t.vx = this.V; t.vy = 0; t.om = 0;
    this.pose(sim, 0);
  }
  pose(sim, time) { setPose(sim.tool, this.x0 + this.V * time, -this.h - sim.tool.wmin, 0); }
  progress(sim) { return (sim.tool.ex - this.x0) / (this.c.cutLen * 1e-3); }
  accumulate(sim) { return this.progress(sim) > 0.5; }
  // Machined surface well behind the tool has unloaded: freeze it (keeps its residual state).
  freezes(sim, x, y) { return x < sim.tool.ex - (this.c.freezeK ?? 1) * this.h - sim.tool.r && y < -0.5 * this.h; }
  axis(sim) { return (sim.tool.ex - this.x0) * 1e3; }       // chart abscissa: cut length [mm]
  forces(Fx, Fy) { return { a: -Fx, b: Fy }; }                 // Fc (cutting), Ft (thrust)
}

export class Mill {
  constructor(c) {
    this.c = c;
    this.R = c.D * 0.5e-3; this.fz = c.fz * 1e-3; this.ae = Math.min(c.ae * 1e-3, this.R);
    this.s = c.dir === 'down' ? -1 : 1;
    this.Delta = Math.acos((this.R - this.ae) / this.R);
    this.hRef = this.fz * Math.sin(this.Delta);
    this.h = this.hRef;
    this.passes = Math.max(1, Math.round(c.passes || 1)); this.k = 0; this.tk = 0;
    // Engaged arc (angle of the tooth tip about the cutter centre, CCW rotation).
    if (this.s > 0) { this.b0 = -90 * DEG; this.b1 = -90 * DEG + this.Delta; }
    else { this.b0 = -90 * DEG - this.Delta; this.b1 = -90 * DEG; }
  }
  // band: thickness of work kept beyond the cut surface (the 3D solver passes a thinner one).
  build(dx, band = Math.max(3 * this.hRef, 10 * dx) + (this.passes - 1) * this.fz) {
    const { R, fz, ae, s } = this;
    this.band = band;
    const cy = R - ae, px = -s * fz;
    const mA = band / R, a0 = this.b0 - mA, a1 = this.b1 + mA, fixA = 3 * dx / R;
    const pts = [];
    const xr = R + band, ny = Math.ceil((ae + band) / dx);
    const nx0 = Math.floor(-xr / dx), nx1 = Math.ceil(xr / dx);
    let xmin = Infinity, xmax = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = nx0; i < nx1; i++) {
      const x = (i + 0.5) * dx, y = -(j + 0.5) * dx;
      // Removed by the previous tooth. A tooth leaves its surface half a spacing (the contact
      // distance) outside its path, so the first tooth's surface is laid out there too; on the
      // path itself the first chip was thicker by that much than every later one (in 3D at h/4,
      // a first tooth 19 % above the second).
      if (this.removed(x, y, px, cy, 0, -0.5 * dx)) continue;
      const rc = Math.hypot(x, y - cy);
      if (rc > R + band) continue;
      const ang = Math.atan2(y - cy, x);
      if (ang < a0 || ang > a1) continue;
      const fixed = rc > R + band - 3 * dx || ang < a0 + fixA || ang > a1 - fixA;
      pts.push([x, y, fixed ? 1 : 0]);
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    }
    this.L = xmax - xmin; this.H = ae + band;
    this.view = { x0: xmin - 0.05e-3, x1: xmax + 0.05e-3, y0: -ae - band - 0.02e-3, y1: Math.max(0.25e-3, 6 * this.hRef) };
    return pts;
  }
  // Centre of a tooth's arc drifts with the feed while it turns: at angle β it is fz·z·(β − b0)/2π
  // past where it was at b0 (every tooth alike, one fz apart). The previous tooth's path is
  // that trochoid too; a fixed circle would leave the first tooth a chip thicker by the drift
  // (up to 20 % at the exit of a φ10 two-flute cut).
  drift(beta) { return this.s * this.fz * this.c.z * (beta - this.b0) / (2 * Math.PI); }
  // Inside the path of a tooth whose centre is at px when at angle b0 (lag: the angle by which
  // this layer of a helical tooth trails the bottom one).
  removed(x, y, px, cy, lag = 0, margin = 0) {
    let ox = px + this.drift(Math.atan2(y - cy, x - px) + lag);
    ox = px + this.drift(Math.atan2(y - cy, x - ox) + lag);
    return Math.hypot(x - ox, y - cy) < this.R - margin;
  }
  init(sim) {
    const t = sim.tool, c = this.c;
    this.V = sim.V; this.om = this.V / this.R;
    this.vf = this.s * this.fz * c.z * this.om / (2 * Math.PI);
    const m = (Math.max(t.r, t.umax) + 2 * sim.dx + (this.s < 0 ? this.hRef : 0)) / this.R;
    this.bStart = this.b0 - m;
    this.bEnd = (this.s > 0 ? this.b1 + (3 * this.hRef + t.r) / this.R : this.b1 + (t.r + 3 * sim.dx) / this.R) + (c.track || 0) * DEG;
    t.om = this.om;
    this.pose(sim, 0);
  }
  angle(time) { return this.bStart + this.om * (time - this.tk); }
  pose(sim, time) {
    const t = sim.tool, b = this.angle(time), cx = this.k * this.s * this.fz + this.drift(b), cy = this.R - this.ae, rr = this.R + t.wmin;
    this.cx = cx; this.cy = cy; this.beta = b;
    t.ox = cx; t.oy = cy; t.vx = this.vf; t.vy = 0;
    setPose(t, cx + rr * Math.cos(b), cy + rr * Math.sin(b), b + Math.PI / 2);
  }
  progress() { return (this.k + this.passProgress()) / this.passes; }
  passProgress() { return (this.beta - this.bStart) / (this.bEnd - this.bStart); }
  // Next tooth: the chip of this one is gone by then (dropped), the frozen surface it left is
  // released, and the tooth starts its own arc about a centre fz further on. The tooth goes
  // round the rest of the turn in the air, which is skipped.
  nextPass(sim) {
    if (this.k + 1 >= this.passes || this.passProgress() < 1) return false;
    // What lies inside this tooth's path (its trochoid, not the circle where it ended: that one
    // reaches up to the drift further on, into the next tooth's chip) is chip, except the surface
    // layer that sprang back up to a spacing into the path after the flank passed (it is work).
    const { N, x, y, fixed, dead } = sim, px = this.k * this.s * this.fz;
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      if (this.removed(x[i], y[i], px, this.cy, 0, sim.dx) || y[i] > sim.dx) { dead[i] = 2; sim.nEvac++; }
      else if (fixed[i] === 2) fixed[i] = 0;
    }
    this.k++; this.tk = sim.t; sim.xr = null;   // rebuild the neighbour list: held pairs changed
    this.pose(sim, sim.t);
    return true;
  }
  accumulate() { return true; }
  freezes(sim, x, y) {
    const rc = Math.hypot(x - this.cx, y - this.cy);
    if (rc <= this.R) return false;
    const ang = Math.atan2(y - this.cy, x - this.cx);
    return ang < this.beta - (this.hRef + sim.tool.r + 2 * sim.dx) / this.R;
  }
  // Chart abscissa: tooth angle from the bottom [°]; later teeth are laid end to end after it.
  axis() { return this.beta / DEG + 90 + this.k * this.span(); }
  span() { return (this.bEnd - this.bStart) / DEG; }
  hNom(beta = this.beta) {                                     // nominal uncut chip thickness [m]
    if (beta < this.b0 || beta > this.b1) return 0;
    return Math.max(0, this.s * this.fz * Math.cos(beta));
  }
  forces(Fx, Fy) {                                             // tangential, radial (toward centre)
    const b = this.beta, tx = -Math.sin(b), ty = Math.cos(b), rx = Math.cos(b), ry = Math.sin(b);
    return { a: -(Fx * tx + Fy * ty), b: -(Fx * rx + Fy * ry) };
  }
}
