// 3D oblique cutting: updated-Lagrangian SPH in three dimensions, explicit time integration.
// The straight cutting edge is inclined by λ in the plane of the machined surface; its normal
// section is the 2D wedge of tool.js (normal rake αn, clearance, edge radius). Two set-ups:
//  - sides 'periodic' (default): a wide plate. The geometry is invariant along the edge, so the
//    box is periodic along it: the edge lies along z and the tool moves at V (cos λ, 0, sin λ).
//    This is the classical oblique cut without side effects (chip flow angle, Stabler ηc ≈ λ).
//  - sides 'free': a strip of width b with free sides, the edge rotated by λ and the tool moving
//    along x; the chip also spreads and flows off the sides.
// mode 'helix': one tooth of a helical end mill in peripheral milling of a plate of thickness ap
// (the cutter passes through it, both faces free). The 2D comma-shaped chip of process.js Mill is
// extruded along the cutter axis z, and the tooth at height z lags by z·tan β / R (helix angle β),
// so it enters the work gradually and the chip flows up the flute at about β.
// Same material and contact model as the 2D solver (sph.js): Jaumann-rate hypoelasticity with
// radial return to Johnson-Cook, linear EOS with a tension cut-off, Monaghan artificial viscosity,
// a diagonal (component-wise) artificial stress, XSPH, Shepard filter, Taylor-Quinney heating,
// SPH conduction, Coulomb friction capped at the shear flow stress, mass scaling.
// Not modelled here (yet): the tool temperature field, wear and ductile fracture; the tool is
// adiabatic and takes no heat from the chip.
// Units: SI. Axes: x cutting direction, y up, z across the strip (helix: x feed, y towards the
// cutter centre from the work, z along the cutter axis).
import { MATERIALS, flowStress } from './materials.js';
import { makeTool, localSdf, toolOutline } from './tool.js';
import { Mill } from './process.js';

export const DEFAULTS3D = {
  mat: 'S45C', vc: 200, h: 0.1, b: 0.3, lambda: 15, rake: 5, clearance: 7, edgeRadius: 10, mu: null,
  nh: 5, cutLen: 0.5, T0: 20, beta: 0.9, heatToWork: 0.5, avAlpha: null, avBeta: null, sides: 'periodic',
  // Helical end mill (mode 'helix'): diameter, flutes, feed per tooth, radial and axial depth [mm],
  // helix angle [°], up/down milling, degrees followed after the tooth leaves the work.
  D: 2, z: 3, fz: 0.1, ae: 0.2, ap: 0.3, helix: 30, dir: 'down', track: 5,
};

const PI = Math.PI, DEG = PI / 180;

export class Cutting3D {
  constructor(cfg = {}) {
    const c = this.cfg = { ...DEFAULTS3D, ...cfg };
    const mat = this.mat = MATERIALS[c.mat];
    if (c.mu == null) c.mu = mat.mu;
    if (c.avAlpha == null) c.avAlpha = mat.av ?? 1;
    if (c.avBeta == null) c.avBeta = mat.av ?? 1;
    this.V = c.vc / 60;
    const helix = this.helix = c.mode === 'helix';
    const mill = this.mill = helix ? new Mill(c) : null;
    const h = this.h = helix ? mill.hRef : c.h * 1e-3, dx = this.dx = h / c.nh;
    this.hk = 1.2 * dx;
    this.E = mat.E * 1e9; this.G = this.E / (2 * (1 + mat.nu)); this.K = this.E / (3 * (1 - 2 * mat.nu));
    this.ms = Math.min(1e4, Math.max(1, 0.04 * mat.A * 1e6 / (mat.rho * this.V * this.V)));
    this.rho0 = mat.rho * this.ms;
    this.cs = Math.sqrt((this.K + 4 * this.G / 3) / this.rho0);
    const tool = this.tool = makeTool({ rakeDeg: c.rake, clearanceDeg: c.clearance, edgeRadius: c.edgeRadius * 1e-6 });
    this.tv = new Float64Array(3);
    const pts = helix ? this.buildHelix() : this.buildOblique();
    const N = this.N = pts.length / 4;
    const f = (n) => new Float64Array(n);
    this.x = f(N); this.y = f(N); this.z = f(N); this.vx = f(N); this.vy = f(N); this.vz = f(N);
    this.cx = f(N); this.cy = f(N);                             // scratch (Shepard filter)
    this.rho = f(N); this.p = f(N); this.T = f(N); this.dT = f(N); this.ep = f(N); this.epd = f(N); this.seq = f(N); this.sr = f(N);
    // Deviatoric stress (symmetric): xx, yy, zz, xy, yz, xz.
    this.s = [f(N), f(N), f(N), f(N), f(N), f(N)];
    // Interleaved per-particle work arrays (cache-friendly pair loops): Q = (vx, vy, vz, ρ),
    // LM = (L row-major, M row-major, dρ/dt), PK = ((S − p I)/ρ² diagonal, S/ρ² shear, artificial
    // stress diagonal), AC = (acceleration, XSPH correction).
    this.Q = f(4 * N); this.LM = f(19 * N); this.PK = f(9 * N); this.AC = f(6 * N);
    this.z0 = f(N);                                             // initial height (helix: away from the plate faces)
    this.fixed = new Uint8Array(N); this.contact = new Uint8Array(N); this.dead = new Uint8Array(N); this.nDead = 0;
    this.m = this.rho0 * dx * dx * dx; this.mReal = mat.rho * dx * dx * dx;
    for (let k = 0; k < N; k++) {
      this.x[k] = pts[4 * k]; this.y[k] = pts[4 * k + 1]; this.z[k] = this.z0[k] = pts[4 * k + 2]; this.fixed[k] = pts[4 * k + 3];
      this.rho[k] = this.rho0; this.T[k] = c.T0;
    }

    this.ad = 1 / (PI * this.hk ** 3);
    this.Wdx = this.kernelW(dx / this.hk);
    this.dt = (c.cfl ?? 0.3) * this.hk / (this.cs + this.V);
    this.dtTh = 0.08 * mat.rho * mat.c * this.hk * this.hk / mat.k;
    this.nSub = Math.max(1, Math.ceil(this.dt / this.dtTh));
    this.cap = N * 40; this.allocPairs(this.cap);
    this.next = new Int32Array(N); this.head = new Int32Array(1);
    this.t = 0; this.steps = 0; this.done = false; this.lastSample = 0;
    this.imp = [0, 0, 0, 0, 0, 0]; this.impT = 0; this.workIn = 0;
    this.hist = { axis: [], fc: [], ft: [], fr: [], tmax: [], flow: [], area: [], len: [] };
    this.pose(0);
  }

  // Oblique cutting. Tool: 2D wedge in the normal plane. Edge direction e and edge normal n in
  // the surface plane, tool velocity (tvx, 0, tvz).
  buildOblique() {
    const c = this.cfg, h = this.h, dx = this.dx, b = c.b * 1e-3, tool = this.tool;
    const lam = this.lam = c.lambda * DEG, per = this.periodic = c.sides !== 'free';
    if (per) { this.ex_ = 0; this.ez_ = 1; this.nx_ = 1; this.nz_ = 0; this.tvx = this.V * Math.cos(lam); this.tvz = this.V * Math.sin(lam); }
    else { this.ex_ = Math.sin(lam); this.ez_ = Math.cos(lam); this.nx_ = Math.cos(lam); this.nz_ = -Math.sin(lam); this.tvx = this.V; this.tvz = 0; }
    this.tv[0] = this.tvx; this.tv[2] = this.tvz;
    const lead = this.lead = per ? 0 : 0.5 * b * Math.abs(Math.tan(lam));
    this.x0 = -lead - tool.r - dx;                              // edge fully behind the work
    this.oy = -h + tool.r;
    // Work: x ∈ [0, L], y ∈ [−H, 0], z ∈ [−bz/2, bz/2] (periodic: bz = b / cos λ along the edge).
    const L = c.cutLen * 1e-3 + 2 * lead + Math.max(3 * h, 0.2e-3), H = Math.max(2.5 * h, h + 8 * dx);
    const nx = Math.round(L / dx), ny = Math.round(H / dx);
    let nz = Math.max(3, Math.round((per ? b / Math.cos(lam) : b) / dx));
    if (per) nz = Math.max(nz, Math.ceil(6 * this.hk / dx));    // at least three neighbour cells around
    this.L = nx * dx; this.H = ny * dx; this.bz = nz * dx;
    const pts = [];
    for (let kz = 0; kz < nz; kz++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const X = (i + 0.5) * dx, Y = -(j + 0.5) * dx, Z = (kz + 0.5) * dx - 0.5 * this.bz;
      pts.push(X, Y, Z, j >= ny - 3 || i >= nx - 3 || (i < 3 && Y < -h - 1.5 * dx) ? 1 : 0);
    }
    return pts;
  }

  // Helical end mill: the 2D band of process.js Mill (work between the previous tooth's arc and
  // the uncut material, supports on its outer and angular ends) stacked in layers over z ∈ [0, ap].
  buildHelix() {
    const c = this.cfg, m = this.mill, dx = this.dx, tool = this.tool;
    this.periodic = false; this.lam = c.helix * DEG;
    const nz = Math.max(3, Math.round(c.ap * 1e-3 / dx));
    this.bz = nz * dx;
    this.kh = Math.tan(this.lam) / m.R;                         // tooth lag per unit height [rad/m]
    const band = m.build(dx, Math.max(1.5 * m.hRef, 6 * dx)), pts = [];
    for (let kz = 0; kz < nz; kz++) for (const [x, y, fx] of band) pts.push(x, y, (kz + 0.5) * dx, fx);
    this.L = m.L; this.H = m.H;
    // Kinematics as Mill.init, with the bottom tooth leading: θ(z) = θ0 − z·kh. The pass ends when
    // the top of the tooth has left the work.
    m.V = this.V; m.om = this.V / m.R;
    m.vf = m.s * m.fz * c.z * m.om / (2 * PI);
    const mg = (Math.max(tool.r, tool.umax) + 2 * dx + (m.s < 0 ? m.hRef : 0)) / m.R;
    m.bStart = m.b0 - mg;
    m.bEnd = (m.s > 0 ? m.b1 + (3 * m.hRef + tool.r) / m.R : m.b1 + (tool.r + 3 * dx) / m.R) + this.bz * this.kh + (c.track || 0) * DEG;
    this.rr = m.R + tool.wmin;
    return pts;
  }

  allocPairs(n) {
    this.pi = new Int32Array(n); this.pj = new Int32Array(n);
    this.prx = new Float64Array(n); this.pry = new Float64Array(n); this.prz = new Float64Array(n);
    this.gx = new Float64Array(n); this.gy = new Float64Array(n); this.gz = new Float64Array(n);
    this.pw = new Float64Array(n); this.pf = new Float64Array(n);
  }
  growPairs() {
    const o = { pi: this.pi, pj: this.pj, prx: this.prx, pry: this.pry, prz: this.prz, gx: this.gx, gy: this.gy, gz: this.gz, pw: this.pw, pf: this.pf };
    this.cap *= 2; this.allocPairs(this.cap);
    for (const k in o) this[k].set(o[k]);
  }
  kernelW(q) {
    if (q < 1) return this.ad * (1 - 1.5 * q * q + 0.75 * q * q * q);
    if (q < 2) { const s = 2 - q; return this.ad * 0.25 * s * s * s; }
    return 0;
  }

  pose(time) {
    if (!this.helix) { this.ox = this.x0 + this.tvx * time; return; }
    const m = this.mill;
    m.beta = m.bStart + m.om * time; m.cx = m.vf * time; m.cy = m.R - m.ae;
  }
  progress() {
    if (this.helix) { const m = this.mill; return (m.beta - m.bStart) / (m.bEnd - m.bStart); }
    return (this.ox - this.x0) / (this.cfg.cutLen * 1e-3 + 2 * this.lead);
  }
  // Nominal chip section of the helical tooth: area [mm²] and engaged edge length [mm] (projected
  // on the axis) from the 2D thickness h(θ(z)) of each layer.
  helixSection() {
    const m = this.mill, dz = this.dx, nz = Math.round(this.bz / dz);
    let A = 0, Lc = 0;
    for (let k = 0; k < nz; k++) {
      const th = m.beta - (k + 0.5) * dz * this.kh, hh = m.hNom(th);
      A += hh * dz; if (th >= m.b0 && th <= m.b1) Lc += dz;
    }
    return [A * 1e6, Lc * 1e3];
  }

  // Tool SDF at a world point: writes this.o = [d, nx, ny, nz, u, w, s] and returns d.
  sdf(px, py, pz) {
    if (this.helix) return this.sdfHelix(px, py, pz);
    const rx = px - this.ox, ry = py - this.oy, rz = pz;
    const u = rx * this.nx_ + rz * this.nz_, s = rx * this.ex_ + rz * this.ez_;
    const o = this.tool.out, d = localSdf(this.tool, u, ry, o);
    const q = this.o || (this.o = new Float64Array(7));
    q[0] = d; q[1] = o[1] * this.nx_; q[2] = o[2]; q[3] = o[1] * this.nz_; q[4] = u; q[5] = ry; q[6] = s;
    return d;
  }

  // Helical tooth: in the plane of height z the tooth is the 2D wedge at angle θ(z) about the
  // cutter centre (tooth frame: u along the cutting direction, w towards the axis). The face is a
  // helicoid, so the in-plane distance d₂ has ∂d/∂z = kh (n_u q_x + n_w q_y); the 3D distance and
  // normal follow from the full gradient. Also sets this.tv, the tool surface velocity there.
  sdfHelix(px, py, pz) {
    const m = this.mill, q = this.o || (this.o = new Float64Array(7));
    const X = px - m.cx, Y = py - m.cy, th = m.beta - pz * this.kh, ct = Math.cos(th), st = Math.sin(th);
    const qx = ct * X + st * Y, qy = -st * X + ct * Y;
    this.tv[0] = m.vf - m.om * Y; this.tv[1] = m.om * X; this.tv[2] = 0;
    if (qx <= 0) { q[0] = 1; return 1; }                       // far side of the cutter
    const o = this.tool.out, d2 = localSdf(this.tool, qy, this.rr - qx, o), nu = o[1], nw = o[2];
    const gz = this.kh * (nu * qx + nw * qy), ig = 1 / Math.sqrt(1 + gz * gz);
    q[0] = d2 * ig; q[1] = (-ct * nw - st * nu) * ig; q[2] = (-st * nw + ct * nu) * ig; q[3] = gz * ig;
    q[4] = qy; q[5] = this.rr - qx; q[6] = th;
    return q[0];
  }

  // Sort the particles by neighbour cell (counting sort) so that the pair loops walk memory
  // nearly in order; every per-particle array is permuted.
  reorder(key, nc) {
    const N = this.N, dead = this.dead, cnt = new Int32Array(nc + 2), kk = new Int32Array(N);
    for (let i = 0; i < N; i++) { kk[i] = dead[i] ? nc + 1 : key(i); cnt[kk[i] + 1]++; }
    for (let c = 1; c <= nc + 1; c++) cnt[c] += cnt[c - 1];
    const perm = new Int32Array(N);
    for (let i = 0; i < N; i++) perm[cnt[kk[i]]++] = i;
    const arrs = [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.rho, this.p, this.T, this.ep, this.epd, this.seq, this.sr, this.z0,
      ...this.s, this.fixed, this.contact, this.dead];
    for (const a of arrs) {
      const tmp = a.slice();
      for (let k = 0; k < N; k++) a[k] = tmp[perm[k]];
    }
  }

  // Neighbour pairs from a Verlet list: candidates within 2h + skin, searched again only when
  // some particle has moved more than half the skin (or one was removed); every step keeps the
  // candidates inside the kernel support and evaluates the kernel.
  buildPairs() {
    const { N, x, y, z, dead } = this, skin = 0.3 * this.hk, per = this.periodic, P = this.bz;
    let need = !this.xr || this.nDead !== this.deadRef;
    if (!need) {
      const lim = 0.25 * skin * skin, xr = this.xr, yr = this.yr, zr = this.zr;
      for (let i = 0; i < N; i++) {
        if (dead[i]) continue;
        let dz = z[i] - zr[i];
        if (per) { if (dz > 0.5 * P) dz -= P; else if (dz < -0.5 * P) dz += P; }
        const dx = x[i] - xr[i], dy = y[i] - yr[i];
        if (dx * dx + dy * dy + dz * dz > lim) { need = true; break; }
      }
    }
    if (need) {
      this.searchPairs(2 * this.hk + skin);
      this.xr = x.slice(); this.yr = y.slice(); this.zr = z.slice(); this.deadRef = this.nDead;
    }
    const { ci, cj, nc } = this, hk = this.hk, r2max = 4 * hk * hk, inv = 1 / hk, ad = this.ad, eta = 0.01 * hk * hk;
    let np = 0;
    for (let k = 0; k < nc; k++) {
      const i = ci[k], j = cj[k];
      if (dead[i] || dead[j]) continue;
      const rx = x[i] - x[j], ry = y[i] - y[j];
      let rz = z[i] - z[j];
      if (per) { if (rz > 0.5 * P) rz -= P; else if (rz < -0.5 * P) rz += P; }
      const r2 = rx * rx + ry * ry + rz * rz;
      if (r2 >= r2max || r2 === 0) continue;
      if (np >= this.cap) this.growPairs();
      const r = Math.sqrt(r2), q = r * inv;
      let w, dw;
      if (q < 1) { w = ad * (1 - 1.5 * q * q + 0.75 * q * q * q); dw = ad * inv * (-3 * q + 2.25 * q * q); }
      else { const s = 2 - q; w = ad * 0.25 * s * s * s; dw = -ad * inv * 0.75 * s * s; }
      this.pi[np] = i; this.pj[np] = j; this.prx[np] = rx; this.pry[np] = ry; this.prz[np] = rz;
      const g = dw / r; this.gx[np] = g * rx; this.gy[np] = g * ry; this.gz[np] = g * rz;
      this.pw[np] = w; this.pf[np] = dw * r / (r2 + eta);
      np++;
    }
    this.np = np;
  }

  // Cell search for all pairs closer than `cell` (also sorts the particles by cell now and then).
  searchPairs(cell) {
    const { N, x, y, z, dead } = this;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i];
      if (z[i] < z0) z0 = z[i]; if (z[i] > z1) z1 = z[i];
    }
    const cw = Math.floor((x1 - x0) / cell) + 1, ch = Math.floor((y1 - y0) / cell) + 1;
    // Periodic: z cells tile the period exactly (each at least one search radius wide) and wrap.
    const per = this.periodic, P = this.bz;
    let cd, czs;
    if (per) { cd = Math.max(3, Math.floor(P / cell)); czs = P / cd; z0 = -0.5 * P; }
    else { czs = cell; cd = Math.floor((z1 - z0) / cell) + 1; }
    const ncell = cw * ch * cd;
    const key = (i) => Math.floor((x[i] - x0) / cell) + cw * (Math.floor((y[i] - y0) / cell) + ch * Math.min(cd - 1, Math.floor((z[i] - z0) / czs)));
    if (this.steps - (this.lastSort ?? -1e9) >= 50) { this.reorder(key, ncell); this.lastSort = this.steps; }
    if (this.head.length < ncell) this.head = new Int32Array(ncell * 2);
    const head = this.head, next = this.next;
    head.fill(-1, 0, ncell);
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      const c = key(i);
      next[i] = head[c]; head[c] = i;
    }
    if (!this.ci) { this.ccap = this.cap; this.ci = new Int32Array(this.ccap); this.cj = new Int32Array(this.ccap); }
    const r2max = cell * cell;
    let nc = 0;
    for (let kz = 0; kz < cd; kz++) for (let ky = 0; ky < ch; ky++) for (let kx = 0; kx < cw; kx++) {
      const c0 = kx + cw * (ky + ch * kz);
      for (let i = head[c0]; i >= 0; i = next[i]) {
        // Half of the 27 neighbour cells (13 + self) so each pair is found once.
        for (let oz = 0; oz <= 1; oz++) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (oz === 0 && (oy < 0 || (oy === 0 && ox < 0))) continue;
          const nxc = kx + ox, nyc = ky + oy;
          let nzc = kz + oz;
          if (per && nzc >= cd) nzc -= cd;
          if (nxc < 0 || nxc >= cw || nyc < 0 || nyc >= ch || nzc >= cd) continue;
          const same = ox === 0 && oy === 0 && oz === 0;
          for (let j = same ? next[i] : head[nxc + cw * (nyc + ch * nzc)]; j >= 0; j = next[j]) {
            const rx = x[i] - x[j], ry = y[i] - y[j];
            let rz = z[i] - z[j];
            if (per) { if (rz > 0.5 * P) rz -= P; else if (rz < -0.5 * P) rz += P; }
            if (rx * rx + ry * ry + rz * rz >= r2max) continue;
            if (nc >= this.ccap) {
              const oi = this.ci, oj = this.cj;
              this.ccap *= 2; this.ci = new Int32Array(this.ccap); this.cj = new Int32Array(this.ccap);
              this.ci.set(oi); this.cj.set(oj);
            }
            this.ci[nc] = i; this.cj[nc] = j; nc++;
          }
        }
      }
    }
    this.nc = nc;
  }

  step() {
    if (this.done) return;
    const { N, dt, m, G, K, rho0, mat, cfg, x, y, z, vx, vy, vz, rho, p, T, ep, epd, fixed, Q, LM, PK, AC } = this;
    const [Sxx, Syy, Szz, Sxy, Syz, Sxz] = this.s;
    this.buildPairs();
    const { pi, pj, gx, gy, gz, pw, pf, np, prx, pry, prz } = this;
    for (let i = 0; i < N; i++) { const q = 4 * i; Q[q] = vx[i]; Q[q + 1] = vy[i]; Q[q + 2] = vz[i]; Q[q + 3] = rho[i]; }

    // 1. Velocity gradient L = −Σ V_j (v_i − v_j) ⊗ ∇W, correction matrix M and dρ/dt.
    LM.fill(0);
    for (let k = 0; k < np; k++) {
      const qi = 4 * pi[k], qj = 4 * pj[k], Vi = m / Q[qi + 3], Vj = m / Q[qj + 3];
      const dvx = Q[qi] - Q[qj], dvy = Q[qi + 1] - Q[qj + 1], dvz = Q[qi + 2] - Q[qj + 2];
      const rx = prx[k], ry = pry[k], rz = prz[k], g1 = gx[k], g2 = gy[k], g3 = gz[k];
      const a0 = dvx * g1, a1 = dvx * g2, a2 = dvx * g3, a3 = dvy * g1, a4 = dvy * g2, a5 = dvy * g3, a6 = dvz * g1, a7 = dvz * g2, a8 = dvz * g3;
      const b0 = rx * g1, b1 = rx * g2, b2 = rx * g3, b3 = ry * g1, b4 = ry * g2, b5 = ry * g3, b6 = rz * g1, b7 = rz * g2, b8 = rz * g3;
      const dr = m * (a0 + a4 + a8);
      let o = 19 * pi[k];
      LM[o] -= Vj * a0; LM[o + 1] -= Vj * a1; LM[o + 2] -= Vj * a2; LM[o + 3] -= Vj * a3; LM[o + 4] -= Vj * a4; LM[o + 5] -= Vj * a5;
      LM[o + 6] -= Vj * a6; LM[o + 7] -= Vj * a7; LM[o + 8] -= Vj * a8;
      LM[o + 9] -= Vj * b0; LM[o + 10] -= Vj * b1; LM[o + 11] -= Vj * b2; LM[o + 12] -= Vj * b3; LM[o + 13] -= Vj * b4; LM[o + 14] -= Vj * b5;
      LM[o + 15] -= Vj * b6; LM[o + 16] -= Vj * b7; LM[o + 17] -= Vj * b8; LM[o + 18] += dr;
      o = 19 * pj[k];
      LM[o] -= Vi * a0; LM[o + 1] -= Vi * a1; LM[o + 2] -= Vi * a2; LM[o + 3] -= Vi * a3; LM[o + 4] -= Vi * a4; LM[o + 5] -= Vi * a5;
      LM[o + 6] -= Vi * a6; LM[o + 7] -= Vi * a7; LM[o + 8] -= Vi * a8;
      LM[o + 9] -= Vi * b0; LM[o + 10] -= Vi * b1; LM[o + 11] -= Vi * b2; LM[o + 12] -= Vi * b3; LM[o + 13] -= Vi * b4; LM[o + 14] -= Vi * b5;
      LM[o + 15] -= Vi * b6; LM[o + 16] -= Vi * b7; LM[o + 17] -= Vi * b8; LM[o + 18] += dr;
    }
    if (this.steps % 20 === 0) this.shepard();

    // 2. Constitutive update.
    const eps = 0.3, sq23 = Math.sqrt(2 / 3), pCut = -2 * mat.A * 1e6;
    for (let i = 0; i < N; i++) {
      const o = 19 * i, pk = 9 * i;
      if (fixed[i] === 2 || this.dead[i]) {
        // Frozen or removed: keep the stored stress in the momentum sums, no artificial stress.
        const ir2 = 1 / (rho[i] * rho[i]);
        PK[pk] = (Sxx[i] - p[i]) * ir2; PK[pk + 1] = (Syy[i] - p[i]) * ir2; PK[pk + 2] = (Szz[i] - p[i]) * ir2;
        PK[pk + 3] = Sxy[i] * ir2; PK[pk + 4] = Syz[i] * ir2; PK[pk + 5] = Sxz[i] * ir2; PK[pk + 6] = 0; PK[pk + 7] = 0; PK[pk + 8] = 0;
        continue;
      }
      let l00 = LM[o], l01 = LM[o + 1], l02 = LM[o + 2], l10 = LM[o + 3], l11 = LM[o + 4], l12 = LM[o + 5], l20 = LM[o + 6], l21 = LM[o + 7], l22 = LM[o + 8];
      const a = LM[o + 9], b = LM[o + 10], c = LM[o + 11], d = LM[o + 12], e = LM[o + 13], f = LM[o + 14], g = LM[o + 15], hh = LM[o + 16], ii = LM[o + 17];
      const A = e * ii - f * hh, B = -(d * ii - f * g), C = d * hh - e * g, det = a * A + b * B + c * C;
      if (det > 0.3) {
        // L ← L · M⁻¹
        const id = 1 / det, i00 = A * id, i10 = B * id, i20 = C * id;
        const i01 = -(b * ii - c * hh) * id, i11 = (a * ii - c * g) * id, i21 = -(a * hh - b * g) * id;
        const i02 = (b * f - c * e) * id, i12 = -(a * f - c * d) * id, i22 = (a * e - b * d) * id;
        let u0 = l00, u1 = l01, u2 = l02;
        l00 = u0 * i00 + u1 * i10 + u2 * i20; l01 = u0 * i01 + u1 * i11 + u2 * i21; l02 = u0 * i02 + u1 * i12 + u2 * i22;
        u0 = l10; u1 = l11; u2 = l12;
        l10 = u0 * i00 + u1 * i10 + u2 * i20; l11 = u0 * i01 + u1 * i11 + u2 * i21; l12 = u0 * i02 + u1 * i12 + u2 * i22;
        u0 = l20; u1 = l21; u2 = l22;
        l20 = u0 * i00 + u1 * i10 + u2 * i20; l21 = u0 * i01 + u1 * i11 + u2 * i21; l22 = u0 * i02 + u1 * i12 + u2 * i22;
      }
      const tr = l00 + l11 + l22;
      const dxx = l00 - tr / 3, dyy = l11 - tr / 3, dzz = l22 - tr / 3;
      const dxy = 0.5 * (l01 + l10), dyz = 0.5 * (l12 + l21), dxz = 0.5 * (l02 + l20);
      const wxy = 0.5 * (l01 - l10), wyz = 0.5 * (l12 - l21), wxz = 0.5 * (l02 - l20);
      rho[i] += LM[o + 18] * dt;
      p[i] = K * (rho[i] / rho0 - 1);
      if (p[i] < pCut) { p[i] = pCut; rho[i] = rho0 * (1 + pCut / K); }
      let sxx = Sxx[i], syy = Syy[i], szz = Szz[i], sxy = Sxy[i], syz = Syz[i], sxz = Sxz[i];
      // Jaumann rotation: Ṡ = 2G D' + Ω S − S Ω = 2G D' + A + Aᵀ with A = Ω S.
      const Axx = wxy * sxy + wxz * sxz, Ayy = -wxy * sxy + wyz * syz, Azz = -wxz * sxz - wyz * syz;
      const Axy = wxy * syy + wxz * syz, Ayx = -wxy * sxx + wyz * sxz;
      const Ayz = -wxy * sxz + wyz * szz, Azy = -wxz * sxy - wyz * syy;
      const Axz = wxy * syz + wxz * szz, Azx = -wxz * sxx - wyz * sxy;
      sxx += dt * (2 * G * dxx + 2 * Axx); syy += dt * (2 * G * dyy + 2 * Ayy); szz += dt * (2 * G * dzz + 2 * Azz);
      sxy += dt * (2 * G * dxy + Axy + Ayx); syz += dt * (2 * G * dyz + Ayz + Azy); sxz += dt * (2 * G * dxz + Axz + Azx);
      const seq = Math.sqrt(1.5 * (sxx * sxx + syy * syy + szz * szz + 2 * (sxy * sxy + syz * syz + sxz * sxz)));
      const sy = flowStress(mat, ep[i], epd[i], T[i]);
      let dep = 0;
      if (seq > sy) {
        const sc = sy / seq;
        sxx *= sc; syy *= sc; szz *= sc; sxy *= sc; syz *= sc; sxz *= sc;
        dep = (seq - sy) / (3 * G); ep[i] += dep;
        T[i] += cfg.beta * sy * dep / (mat.rho * mat.c);
      }
      epd[i] = 0.7 * epd[i] + 0.3 * dep / dt;
      this.sr[i] = sq23 * Math.sqrt(dxx * dxx + dyy * dyy + dzz * dzz + 2 * (dxy * dxy + dyz * dyz + dxz * dxz));
      Sxx[i] = sxx; Syy[i] = syy; Szz[i] = szz; Sxy[i] = sxy; Syz[i] = syz; Sxz[i] = sxz;
      this.seq[i] = Math.min(seq, sy);
      // Momentum terms; artificial stress on tensile normal components (component-wise simplification).
      const ir2 = 1 / (rho[i] * rho[i]), pp = p[i];
      PK[pk] = (sxx - pp) * ir2; PK[pk + 1] = (syy - pp) * ir2; PK[pk + 2] = (szz - pp) * ir2;
      PK[pk + 3] = sxy * ir2; PK[pk + 4] = syz * ir2; PK[pk + 5] = sxz * ir2;
      PK[pk + 6] = sxx - pp > 0 ? -eps * (sxx - pp) * ir2 : 0;
      PK[pk + 7] = syy - pp > 0 ? -eps * (syy - pp) * ir2 : 0;
      PK[pk + 8] = szz - pp > 0 ? -eps * (szz - pp) * ir2 : 0;
    }
    for (let i = 0; i < N; i++) Q[4 * i + 3] = rho[i];

    // 3. Momentum, XSPH and heat conduction.
    const xs = 0.5 * m;
    AC.fill(0);
    const hk = this.hk, cs = this.cs, eta = 0.01 * hk * hk, alpha = cfg.avAlpha, betaV = cfg.avBeta, iWdx = 1 / this.Wdx;
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k], si = 9 * i, sj = 9 * j, qi = 4 * i, qj = 4 * j;
      let txx = PK[si] + PK[sj], tyy = PK[si + 1] + PK[sj + 1], tzz = PK[si + 2] + PK[sj + 2];
      const txy = PK[si + 3] + PK[sj + 3], tyz = PK[si + 4] + PK[sj + 4], txz = PK[si + 5] + PK[sj + 5];
      const rx = prx[k], ry = pry[k], rz = prz[k];
      const dvx = Q[qi] - Q[qj], dvy = Q[qi + 1] - Q[qj + 1], dvz = Q[qi + 2] - Q[qj + 2], rs = Q[qi + 3] + Q[qj + 3];
      const vr = dvx * rx + dvy * ry + dvz * rz;
      if (vr < 0) {
        const mu = hk * vr / (rx * rx + ry * ry + rz * rz + eta);
        const pv = (-alpha * cs * mu + betaV * mu * mu) * 2 / rs;
        txx -= pv; tyy -= pv; tzz -= pv;
      }
      let fq = pw[k] * iWdx; fq *= fq; fq *= fq;
      txx += fq * (PK[si + 6] + PK[sj + 6]); tyy += fq * (PK[si + 7] + PK[sj + 7]); tzz += fq * (PK[si + 8] + PK[sj + 8]);
      const g1 = gx[k], g2 = gy[k], g3 = gz[k];
      const fx = m * (txx * g1 + txy * g2 + txz * g3), fy = m * (txy * g1 + tyy * g2 + tyz * g3), fz = m * (txz * g1 + tyz * g2 + tzz * g3);
      const wx = xs * pw[k] * 2 / rs, ux = -dvx * wx, uy = -dvy * wx, uz = -dvz * wx;
      const ai = 6 * i, aj = 6 * j;
      AC[ai] += fx; AC[ai + 1] += fy; AC[ai + 2] += fz; AC[ai + 3] += ux; AC[ai + 4] += uy; AC[ai + 5] += uz;
      AC[aj] -= fx; AC[aj + 1] -= fy; AC[aj + 2] -= fz; AC[aj + 3] -= ux; AC[aj + 4] -= uy; AC[aj + 5] -= uz;
    }
    this.conduct();

    // 4. Integrate, tool contact, supports.
    this.pose(this.t + dt);
    const tool = this.tool, dx = this.dx, d0 = 0.5 * dx, mu = cfg.mu, fw = cfg.heatToWork, V = this.V, tv = this.tv;
    const per = this.periodic, P = this.bz, helix = this.helix, ml = this.mill;
    const freezeU = -this.h - tool.r, vEsc2 = 100 * V * V, area = dx * dx;
    const freezeA = helix ? (this.h + tool.r + 2 * dx) / ml.R : 0;
    let i0 = 0, i1 = 0, i2 = 0, work = 0, lt = 0, lr = 0;
    for (let i = 0; i < N; i++) {
      if (fixed[i] || this.dead[i]) { vx[i] = 0; vy[i] = 0; vz[i] = 0; this.contact[i] = 0; continue; }
      // Machined surface well behind the edge (normal distance) has unloaded: freeze it.
      if (helix) {
        const X = x[i] - ml.cx, Y = y[i] - ml.cy;
        if (X * X + Y * Y > ml.R * ml.R && Math.atan2(Y, X) < ml.beta - z[i] * this.kh - freezeA) { fixed[i] = 2; vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
      } else {
        const du = (x[i] - this.ox) * this.nx_ + z[i] * this.nz_;
        if (du < freezeU && y[i] < -0.5 * this.h) { fixed[i] = 2; vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
      }
      const ai = 6 * i;
      vx[i] += AC[ai] * dt; vy[i] += AC[ai + 1] * dt; vz[i] += AC[ai + 2] * dt;
      if (vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i] > vEsc2) { this.dead[i] = 1; this.nDead++; vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
      x[i] += (vx[i] + AC[ai + 3]) * dt; y[i] += (vy[i] + AC[ai + 4]) * dt; z[i] += (vz[i] + AC[ai + 5]) * dt;
      if (per) { if (z[i] >= 0.5 * P) z[i] -= P; else if (z[i] < -0.5 * P) z[i] += P; }
      const dist = this.sdf(x[i], y[i], z[i]);
      if (dist >= d0) { this.contact[i] = 0; continue; }
      this.contact[i] = 1;
      const o = this.o, nx = o[1], ny = o[2], nz = o[3], pen = d0 - dist;
      x[i] += nx * pen; y[i] += ny * pen; z[i] += nz * pen;
      const tvx = tv[0], tvy = tv[1], tvz = tv[2];
      const rvx = vx[i] - tvx, rvy = vy[i] - tvy, rvz = vz[i] - tvz;
      const vn = rvx * nx + rvy * ny + rvz * nz, jn = m * (vn < 0 ? -vn : 0);
      let tx = rvx - vn * nx, ty = rvy - vn * ny, tz = rvz - vn * nz;
      const vt = Math.hypot(tx, ty, tz);
      let jt = 0;
      if (vt > 1e-12) {
        tx /= vt; ty /= vt; tz /= vt;
        const tauMax = flowStress(mat, ep[i], epd[i], T[i]) / Math.sqrt(3);
        jt = Math.min(m * vt, mu * jn, tauMax * area * dt);
        T[i] += fw * jt * (vt - 0.5 * jt / m) / (this.mReal * mat.c);
      }
      const dpx = jn * nx - jt * tx, dpy = jn * ny - jt * ty, dpz = jn * nz - jt * tz;
      if (vn < 0) { vx[i] -= vn * nx; vy[i] -= vn * ny; vz[i] -= vn * nz; }
      vx[i] -= jt / m * tx; vy[i] -= jt / m * ty; vz[i] -= jt / m * tz;
      i0 -= dpx; i1 -= dpy; i2 -= dpz; work += dpx * tvx + dpy * tvy + dpz * tvz;
      if (helix) {                                              // tangential / radial at the particle
        const X = x[i] - ml.cx, Y = y[i] - ml.cy, ir = 1 / Math.hypot(X, Y);
        lt -= (-Y * dpx + X * dpy) * ir; lr -= (X * dpx + Y * dpy) * ir;
      }
    }
    const im = this.imp;
    im[0] += i0; im[1] += i1; im[2] += i2; im[3] += lt; im[4] += lr; this.impT += dt; this.workIn += work;
    this.t += dt; this.steps++;
    if (this.progress() >= 1) this.done = true;
  }

  stepSample() {
    this.step();
    const p = this.progress();
    if (p - this.lastSample >= 1 / 100 || this.done) { this.sample(); this.lastSample = p; }
  }

  shepard() {
    const { N, pi, pj, pw, np, m, rho } = this, num = this.cx, den = this.cy, w0 = this.ad;
    for (let i = 0; i < N; i++) { num[i] = m * w0; den[i] = m * w0 / rho[i]; }
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k], w = pw[k];
      num[i] += m * w; num[j] += m * w; den[i] += m * w / rho[j]; den[j] += m * w / rho[i];
    }
    for (let i = 0; i < N; i++) rho[i] = num[i] / den[i];
  }

  conduct() {
    const { N, pi, pj, pf, np, m, rho, T, dT, mat } = this, sub = this.nSub, h = this.dt / sub;
    const coef = 2 * mat.k / (mat.rho * mat.c) * h;
    for (let s = 0; s < sub; s++) {
      dT.fill(0);
      for (let k = 0; k < np; k++) {
        const i = pi[k], j = pj[k], q = coef * (T[i] - T[j]) * pf[k];
        dT[i] += q * m / rho[j]; dT[j] -= q * m / rho[i];
      }
      for (let i = 0; i < N; i++) T[i] += dT[i];
    }
  }

  // Chip flow on the rake face, from the mean velocity of chip particles relative to the tool:
  // ηc = angle in the rake face between the flow and the edge normal (Stabler: ηc ≈ λ).
  // Also the chip thickness normal to the rake face in the middle of the strip.
  chipFlow() {
    if (this.helix) return this.chipFlowHelix();
    const t = this.tool, h = this.h, V = this.V;
    let se = 0, su = 0, n = 0;
    const ds = [];
    const t1u = t.u1x, t1w = t.u1y;                             // rake face direction in the normal plane
    for (let i = 0; i < this.N; i++) {
      // Chip material only: already through the primary shear zone (εp > 0.8). Material still
      // approaching the shear plane moves almost along the edge in the tool frame and would bias ηc.
      if (this.dead[i] || this.fixed[i] || this.y[i] < 0.3 * h || this.ep[i] < 0.8) continue;
      const rx = this.x[i] - this.ox, ry = this.y[i] - this.oy, rz = this.z[i];
      const u = rx * this.nx_ + rz * this.nz_, s = rx * this.ex_ + rz * this.ez_;
      const along = u * t1u + ry * t1w, off = u * t.n1x + ry * t.n1y - t.r;
      if (along < 0.8 * h || along > 3 * h || off < this.dx || off > 4 * h) continue;
      const rvx = this.vx[i] - this.tvx, rvy = this.vy[i], rvz = this.vz[i] - this.tvz;
      const ve = rvx * this.ex_ + rvz * this.ez_, vu = (rvx * this.nx_ + rvz * this.nz_) * t1u + rvy * t1w;
      se += ve; su += vu; n++;
      // Chip flows along s by s0 = along·tan ηc from where it was cut; take the middle of the strip.
      if (this.periodic || Math.abs(rz) < 0.25 * this.bz) ds.push(off);
    }
    let hc = 0;
    if (ds.length >= 3) { ds.sort((a, b) => a - b); hc = ds[Math.floor(0.97 * (ds.length - 1))] + 0.5 * this.dx; }
    return { eta: n > 5 ? Math.atan2(-se, su) / DEG : null, hc, n };
  }

  // Helix: the same measure in the tooth frame at each particle's height. The edge runs along
  // e = (ẑ − tan β û) cos β; the work moves past the tooth along −û, i.e. up the flute, so a
  // positive ηc is chip flowing towards the shank (Stabler: ηc ≈ β). Only chip cut from the
  // middle half of the plate: near its faces the chip also spreads sideways.
  chipFlowHelix() {
    const t = this.tool, h = this.h, m = this.mill, cb = Math.cos(this.lam), tb = Math.tan(this.lam);
    let se = 0, su = 0, n = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.dead[i] || this.fixed[i] || this.ep[i] < 0.8 || Math.abs(this.z0[i] - 0.5 * this.bz) > 0.25 * this.bz) continue;
      const X = this.x[i] - m.cx, Y = this.y[i] - m.cy, th = m.beta - this.z[i] * this.kh, ct = Math.cos(th), st = Math.sin(th);
      const qx = ct * X + st * Y, qy = -st * X + ct * Y;
      if (qx <= 0) continue;
      const u = qy, w = this.rr - qx;
      const along = u * t.u1x + w * t.u1y, off = u * t.n1x + w * t.n1y - t.r;
      if (along < 0.8 * h || along > 3 * h || off < this.dx || off > 4 * h) continue;
      const rvx = this.vx[i] - (m.vf - m.om * Y), rvy = this.vy[i] - m.om * X, rvz = this.vz[i];
      const vU = -st * rvx + ct * rvy, vW = -ct * rvx - st * rvy;
      const ve = (rvz - tb * vU) * cb, vu = vU * t.u1x + vW * t.u1y;
      se += ve; su += vu; n++;
    }
    return { eta: n > 5 ? Math.atan2(se, su) / DEG : null, hc: 0, n };
  }

  sample() {
    if (this.impT <= 0) return;
    if (this.helix) { this.sampleHelix(); return; }
    const g = this.imp.map((v) => v / this.impT);
    this.imp.fill(0); this.impT = 0;
    // Cutting axes: c along the tool velocity, y up, r = y × c in the surface plane.
    const cxv = this.tvx / this.V, czv = this.tvz / this.V;
    const f = [g[0] * cxv + g[2] * czv, g[1], -g[0] * czv + g[2] * cxv];
    let tmax = -Infinity;
    for (let i = 0; i < this.N; i++) if (!this.dead[i] && this.T[i] > tmax) tmax = this.T[i];
    const hs = this.hist, fl = this.chipFlow();
    hs.axis.push((this.ox - this.x0) / Math.max(this.tvx / this.V, 1e-9) * 1e3); hs.fc.push(-f[0]); hs.ft.push(f[1]); hs.fr.push(f[2]); hs.tmax.push(tmax); hs.flow.push(fl.eta);
  }

  // Helix: tangential Ft and radial Fr (towards the axis) summed at each contact point, axial Fa
  // on the work (+z, towards the shank), against the bottom tooth angle from the bottom [°].
  sampleHelix() {
    const im = this.imp, T = this.impT, m = this.mill, hs = this.hist;
    const ft = -im[3] / T, fr = -im[4] / T, fa = -im[2] / T;
    this.imp.fill(0); this.impT = 0;
    let tmax = -Infinity;
    for (let i = 0; i < this.N; i++) if (!this.dead[i] && this.T[i] > tmax) tmax = this.T[i];
    const [A, Lc] = this.helixSection();
    hs.axis.push(m.beta / DEG + 90); hs.fc.push(ft); hs.ft.push(fr); hs.fr.push(fa); hs.tmax.push(tmax);
    hs.flow.push(A > 0 ? this.chipFlow().eta : null); hs.area.push(A); hs.len.push(Lc);
  }

  // Helix summary: peaks, and mechanistic coefficients from F = K·A + Ke·Lc over the samples with
  // a chip section above 15 % of hmax·ap (A: nominal chip area, Lc: engaged length).
  summaryHelix(base) {
    const hs = this.hist, m = this.mill, n = hs.fc.length, aMin = 0.15 * m.hRef * this.bz * 1e6;
    const fit = (F) => {
      let saa = 0, sal = 0, sll = 0, saf = 0, slf = 0, c = 0;
      for (let i = 0; i < n; i++) {
        const A = hs.area[i], L = hs.len[i];
        if (A < aMin) continue;
        saa += A * A; sal += A * L; sll += L * L; saf += A * F[i]; slf += L * F[i]; c++;
      }
      const det = saa * sll - sal * sal;
      if (c < 4 || Math.abs(det) < 1e-18) return [0, 0];
      return [(saf * sll - slf * sal) / det, (saa * slf - sal * saf) / det];
    };
    const [Ktc, Kte] = fit(hs.fc), [Krc, Kre] = fit(hs.ft), [Kac, Kae] = fit(hs.fr);
    // Chip flow angle while the chip section is at least half its peak (thin chips flow off sideways).
    const aPk = Math.max(0, ...hs.area);
    let sf = 0, cf = 0;
    for (let i = 0; i < n; i++) if (hs.flow[i] != null && hs.area[i] >= 0.5 * aPk) { sf += hs.flow[i]; cf++; }
    const amax = (a) => a.reduce((v, x) => (Math.abs(x) > Math.abs(v) ? x : v), 0);
    return {
      ...base, mode: 'helix', ftMax: Math.max(0, ...hs.fc), frMax: Math.max(0, ...hs.ft), faMax: amax(hs.fr),
      Ktc, Kte, Krc, Kre, Kac, Kae, flow: cf ? sf / cf : null, helix: this.cfg.helix, hmax: m.hRef * 1e3,
      angle: m.beta / DEG + 90, arc: m.Delta / DEG, lag: this.bz * this.kh / DEG, ap: this.bz * 1e3, track: this.cfg.track,
    };
  }

  // Steady averages over the second half of the cut.
  summary() {
    const hs = this.hist, n = hs.fc.length, c = this.cfg;
    let from = 0;
    while (from < n - 1 && hs.axis[from] < 0.5 * hs.axis[n - 1]) from++;
    const avg = (a) => { let s = 0, k = 0; for (let i = from; i < a.length; i++) if (a[i] != null) { s += a[i]; k++; } return k ? s / k : 0; };
    let tmax = -Infinity, epMax = 0, heat = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.dead[i]) continue;
      if (this.T[i] > tmax) tmax = this.T[i];
      if (this.ep[i] > epMax) epMax = this.ep[i];
      heat += this.T[i] - c.T0;
    }
    heat *= this.mReal * this.mat.c;
    if (this.helix) return this.summaryHelix({ tmax, epMax, heatRatio: this.workIn > 0 ? heat / this.workIn : 0, progress: Math.min(1, this.progress()),
      t: this.t, steps: this.steps, N: this.N, dx: this.dx * 1e6, ms: this.ms, done: this.done, kcRef: this.mat.kcRef });
    const fc = avg(hs.fc), ft = avg(hs.ft), fr = avg(hs.fr), fl = this.chipFlow();
    const area = (this.periodic ? this.bz * 1e3 * Math.cos(this.lam) : this.bz * 1e3) * c.h;   // mm², normal to V
    return {
      fc, ft, fr, kc: area > 0 ? fc / area : 0, tmax, epMax, flow: n ? avg(hs.flow) : null, flowNow: fl.eta,
      hc: fl.hc * 1e3, ratio: fl.hc > 0 ? fl.hc / this.h : 0, lambda: c.lambda, kcRef: this.mat.kcRef,
      heatRatio: this.workIn > 0 ? heat / this.workIn : 0, progress: Math.min(1, this.progress()),
      travel: (this.ox - this.x0) / (this.tvx / this.V) * 1e3, periodic: this.periodic, t: this.t, steps: this.steps, N: this.N, dx: this.dx * 1e6, ms: this.ms, done: this.done,
    };
  }

  // Tool outline in the normal plane (local u, w) for drawing an extruded wedge.
  outline(len) {
    const t = this.tool, sv = { ...t, ex: 0, ey: 0, ct: 1, st: 0 };
    return toolOutline(sv, len);
  }
}
