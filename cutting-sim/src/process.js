// Cutting processes: initial workpiece geometry, tool kinematics and what to report.
//  - Ortho: orthogonal cutting, a straight tool moving at Vc through a layer of thickness h.
//  - Mill: one tooth of an end mill in peripheral (side) milling, in the plane normal to the
//    tool axis (no helix). The tooth rotates at Vc about the moving cutter centre and removes
//    the comma-shaped chip left between the previous tooth's arc and its own: h(β) = fz·|cos β|
//    from 0 to fz·sin Δ, with Δ = acos((R − ae)/R). Up milling enters at h = 0 and exits at hmax,
//    down milling the reverse.
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
    const H = Math.max(3.5 * h, h + 12 * dx);
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
  freezes(sim, x, y) { return x < sim.tool.ex - this.h - sim.tool.r && y < -0.5 * this.h; }
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
    // Engaged arc (angle of the tooth tip about the cutter centre, CCW rotation).
    if (this.s > 0) { this.b0 = -90 * DEG; this.b1 = -90 * DEG + this.Delta; }
    else { this.b0 = -90 * DEG - this.Delta; this.b1 = -90 * DEG; }
  }
  build(dx) {
    const { R, fz, ae, s } = this;
    const band = Math.max(3 * this.hRef, 10 * dx);
    this.band = band;
    const cy = R - ae, px = -s * fz;
    const mA = band / R, a0 = this.b0 - mA, a1 = this.b1 + mA, fixA = 3 * dx / R;
    const pts = [];
    const xr = R + band, ny = Math.ceil((ae + band) / dx);
    const nx0 = Math.floor(-xr / dx), nx1 = Math.ceil(xr / dx);
    let xmin = Infinity, xmax = -Infinity;
    for (let j = 0; j < ny; j++) for (let i = nx0; i < nx1; i++) {
      const x = (i + 0.5) * dx, y = -(j + 0.5) * dx;
      if (Math.hypot(x - px, y - cy) < R) continue;           // removed by the previous tooth
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
  angle(time) { return this.bStart + this.om * time; }
  pose(sim, time) {
    const t = sim.tool, b = this.angle(time), cx = this.vf * time, cy = this.R - this.ae, rr = this.R + t.wmin;
    this.cx = cx; this.cy = cy; this.beta = b;
    t.ox = cx; t.oy = cy; t.vx = this.vf; t.vy = 0;
    setPose(t, cx + rr * Math.cos(b), cy + rr * Math.sin(b), b + Math.PI / 2);
  }
  progress() { return (this.beta - this.bStart) / (this.bEnd - this.bStart); }
  accumulate() { return true; }
  freezes(sim, x, y) {
    const rc = Math.hypot(x - this.cx, y - this.cy);
    if (rc <= this.R) return false;
    const ang = Math.atan2(y - this.cy, x - this.cx);
    return ang < this.beta - (this.hRef + sim.tool.r + 2 * sim.dx) / this.R;
  }
  axis() { return this.beta / DEG + 90; }                     // tooth angle from the bottom [°]
  hNom(beta = this.beta) {                                     // nominal uncut chip thickness [m]
    if (beta < this.b0 || beta > this.b1) return 0;
    return Math.max(0, this.s * this.fz * Math.cos(beta));
  }
  forces(Fx, Fy) {                                             // tangential, radial (toward centre)
    const b = this.beta, tx = -Math.sin(b), ty = Math.cos(b), rx = Math.cos(b), ry = Math.sin(b);
    return { a: -(Fx * tx + Fy * ty), b: -(Fx * rx + Fy * ry) };
  }
}
