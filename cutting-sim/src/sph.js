// 2D plane-strain cutting solver (orthogonal cutting or one end-mill tooth): updated-Lagrangian SPH, explicit time integration.
//  - Elasto-plastic solid: hypoelastic Jaumann-rate deviatoric stress + linear EOS pressure,
//    radial return to the Johnson-Cook flow stress (strain hardening, rate, thermal softening).
//  - Thermo-mechanical coupling: Taylor-Quinney plastic heating, frictional heating at the rake
//    face, SPH heat conduction (Cleary-Monaghan Laplacian, sub-cycled to its own stability limit).
//  - Corrected kernel gradient for the velocity gradient, Monaghan artificial viscosity and
//    Gray-Monaghan artificial stress against tensile instability.
//  - Rigid tool with rounded edge, Coulomb friction capped at the shear flow stress, and its own
//    temperature field and Usui wear estimate (toolheat.js).
//  - Mass scaling (density × ms for inertia only) keeps the explicit step affordable; the default
//    keeps inertial stress ρ·ms·V² near 4 % of the yield stress so the cut stays quasi-static.
// Units: SI internally (m, s, Pa, K-differences in °C). Forces are per metre of width.
import { MATERIALS, TOOLS, flowStress } from './materials.js';
import { makeTool, toolSdf } from './tool.js';
import { ToolHeat } from './toolheat.js';
import { Ortho, Mill } from './process.js';

export const DEFAULTS = {
  mode: 'ortho', mat: 'S45C', vc: 200, h: 0.1, rake: 5, clearance: 7, edgeRadius: 10, mu: null, mShear: 1.0,
  nh: 8, massScale: 0, cutLen: 0.6, width: 1, T0: 20, beta: 0.9, heatToWork: 0.5,
  // End mill (mode 'mill'): diameter D, flutes z, feed per tooth fz, radial depth ae [mm].
  D: 6, z: 3, fz: 0.1, ae: 0.3, dir: 'up',
  // Tool: material, interface heat-transfer coefficient [W/(m²·K)].
  toolMat: 'WC', hc: 1e8,
  // Artificial viscosity coefficients (Monaghan α, β); default 1, or the material's av.
  avAlpha: null, avBeta: null,
};

const PI = Math.PI;

export class CuttingSim {
  constructor(cfg = {}) {
    const c = this.cfg = { ...DEFAULTS, ...cfg };
    const mat = this.mat = MATERIALS[c.mat];
    if (c.mu == null) c.mu = mat.mu;
    if (c.avAlpha == null) c.avAlpha = mat.av ?? 1;
    if (c.avBeta == null) c.avBeta = mat.av ?? 1;
    this.V = c.vc / 60;                       // tool speed [m/s]
    const proc = this.proc = c.mode === 'mill' ? new Mill(c) : new Ortho(c);
    const h = this.h = proc.hRef;             // uncut chip thickness (maximum, for milling) [m]
    const dx = this.dx = h / c.nh;
    this.hk = 1.2 * dx;                       // smoothing length
    this.E = mat.E * 1e9; this.G = this.E / (2 * (1 + mat.nu)); this.K = this.E / (3 * (1 - 2 * mat.nu));
    this.ms = c.massScale > 0 ? c.massScale
      : Math.min(1e4, Math.max(1, 0.04 * mat.A * 1e6 / (mat.rho * this.V * this.V)));
    this.rho0 = mat.rho * this.ms;            // scaled density (inertia only)
    this.cs = Math.sqrt((this.K + 4 * this.G / 3) / this.rho0);

    const pts = proc.build(dx);
    this.L = proc.L; this.H = proc.H; this.view = proc.view;
    const N = this.N = pts.length;
    const f = n => new Float64Array(n);
    this.x = f(N); this.y = f(N); this.vx = f(N); this.vy = f(N); this.ax = f(N); this.ay = f(N);
    this.rho = f(N); this.p = f(N); this.sxx = f(N); this.syy = f(N); this.szz = f(N); this.sxy = f(N);
    this.ep = f(N); this.epd = f(N); this.sr = f(N); this.T = f(N); this.dT = f(N); this.seq = f(N);
    this.cx = f(N); this.cy = f(N); this.Lxx = f(N); this.Lxy = f(N); this.Lyx = f(N); this.Lyy = f(N);
    this.Mxx = f(N); this.Mxy = f(N); this.Myx = f(N); this.Myy = f(N);
    this.Rxx = f(N); this.Ryy = f(N); this.Rxy = f(N);
    this.contact = new Uint8Array(N); this.fixed = new Uint8Array(N); this.dead = new Uint8Array(N); this.nDead = 0;
    this.m = this.rho0 * dx * dx;             // scaled mass per unit width
    this.mReal = mat.rho * dx * dx;
    for (let k = 0; k < N; k++) {
      this.x[k] = pts[k][0]; this.y[k] = pts[k][1]; this.fixed[k] = pts[k][2];
      this.rho[k] = this.rho0; this.T[k] = c.T0;
    }

    this.tool = makeTool({ rakeDeg: c.rake, clearanceDeg: c.clearance, edgeRadius: c.edgeRadius * 1e-6 });
    proc.init(this);
    const Lb = Math.max(10 * h, 0.8e-3);
    this.heat = new ToolHeat(this.tool, TOOLS[c.toolMat], { cell: Math.max(dx, Lb / 90), Lb, T0: c.T0, hc: c.hc });

    // Kernel constants (cubic spline, 2D).
    this.ad = 10 / (7 * PI * this.hk * this.hk);
    this.Wdx = this.kernelW(dx / this.hk);

    // Time step: acoustic CFL and thermal diffusion limit (conduction is sub-cycled).
    this.dt = 0.3 * this.hk / (this.cs + this.V);
    this.dtTh = 0.1 * mat.rho * mat.c * this.hk * this.hk / mat.k;
    this.nSub = Math.max(1, Math.ceil(this.dt / this.dtTh));

    this.cap = N * 16;
    this.allocPairs(this.cap);
    this.head = new Int32Array(1); this.next = new Int32Array(N);

    this.t = 0; this.steps = 0; this.done = false; this.lastSample = 0;
    this.impX = 0; this.impY = 0; this.impT = 0; this.qTool = 0; this.qToolT = 0;
    this.workIn = 0; this.heatTool = 0;   // cumulative energy per unit width [J/m]
    // fc/ft: cutting and thrust force (ortho) or tangential and radial force (mill).
    this.hist = { axis: [], fc: [], ft: [], tmax: [], trake: [], ttool: [], hnom: [] };
  }

  allocPairs(n) {
    this.pi = new Int32Array(n); this.pj = new Int32Array(n);
    this.gx = new Float64Array(n); this.gy = new Float64Array(n);
    this.pw = new Float64Array(n); this.pf = new Float64Array(n);
  }

  kernelW(q) {
    if (q < 1) return this.ad * (1 - 1.5 * q * q + 0.75 * q * q * q);
    if (q < 2) { const s = 2 - q; return this.ad * 0.25 * s * s * s; }
    return 0;
  }

  // Cell-list neighbour search: builds the pair list with kernel values and gradients ∇_i W_ij.
  buildPairs() {
    const { N, x, y, hk } = this;
    const cell = 2 * hk;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const dead = this.dead;
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i];
    }
    const cw = Math.floor((x1 - x0) / cell) + 1, ch = Math.floor((y1 - y0) / cell) + 1;
    if (this.head.length < cw * ch) this.head = new Int32Array(cw * ch * 2);
    const head = this.head, next = this.next;
    head.fill(-1, 0, cw * ch);
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      const ci = Math.floor((x[i] - x0) / cell) + Math.floor((y[i] - y0) / cell) * cw;
      next[i] = head[ci]; head[ci] = i;
    }
    const r2max = cell * cell, inv = 1 / hk, ad = this.ad, eta = 0.01 * hk * hk;
    let np = 0;
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      for (let i = head[cx + cy * cw]; i >= 0; i = next[i]) {
        for (let oy = 0; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (oy === 0 && ox < 0) continue;
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || nx >= cw || ny >= ch) continue;
          const same = ox === 0 && oy === 0;
          for (let j = same ? next[i] : head[nx + ny * cw]; j >= 0; j = next[j]) {
            const rx = x[i] - x[j], ry = y[i] - y[j], r2 = rx * rx + ry * ry;
            if (r2 >= r2max || r2 === 0) continue;
            if (np >= this.cap) this.growPairs();
            const r = Math.sqrt(r2), q = r * inv;
            let w, dw;
            if (q < 1) { w = ad * (1 - 1.5 * q * q + 0.75 * q * q * q); dw = ad * inv * (-3 * q + 2.25 * q * q); }
            else { const s = 2 - q; w = ad * 0.25 * s * s * s; dw = -ad * inv * 0.75 * s * s; }
            this.pi[np] = i; this.pj[np] = j;
            this.gx[np] = dw * rx / r; this.gy[np] = dw * ry / r;
            this.pw[np] = w; this.pf[np] = dw * r / (r2 + eta);
            np++;
          }
        }
      }
    }
    this.np = np;
  }

  growPairs() {
    const old = { pi: this.pi, pj: this.pj, gx: this.gx, gy: this.gy, pw: this.pw, pf: this.pf };
    this.cap *= 2; this.allocPairs(this.cap);
    for (const k in old) this[k].set(old[k]);
  }

  step() {
    if (this.done) return;
    const { N, dt, m, G, K, rho0, mat, cfg } = this;
    const { x, y, vx, vy, rho, p, sxx, syy, szz, sxy, ep, epd, T } = this;
    const { Lxx, Lxy, Lyx, Lyy, Mxx, Mxy, Myx, Myy, Rxx, Ryy, Rxy, fixed } = this;
    this.buildPairs();
    const { pi, pj, gx, gy, pw, pf, np } = this;

    // 1. Velocity gradient with kernel-gradient correction.
    Lxx.fill(0); Lxy.fill(0); Lyx.fill(0); Lyy.fill(0);
    Mxx.fill(0); Mxy.fill(0); Myx.fill(0); Myy.fill(0);
    const drho = this.dT; drho.fill(0);
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      const Vi = m / rho[i], Vj = m / rho[j];
      const dvx = vx[i] - vx[j], dvy = vy[i] - vy[j];
      const rx = x[i] - x[j], ry = y[i] - y[j], g1 = gx[k], g2 = gy[k];
      Lxx[i] -= Vj * dvx * g1; Lxy[i] -= Vj * dvx * g2; Lyx[i] -= Vj * dvy * g1; Lyy[i] -= Vj * dvy * g2;
      Lxx[j] -= Vi * dvx * g1; Lxy[j] -= Vi * dvx * g2; Lyx[j] -= Vi * dvy * g1; Lyy[j] -= Vi * dvy * g2;
      Mxx[i] -= Vj * rx * g1; Mxy[i] -= Vj * rx * g2; Myx[i] -= Vj * ry * g1; Myy[i] -= Vj * ry * g2;
      Mxx[j] -= Vi * rx * g1; Mxy[j] -= Vi * rx * g2; Myx[j] -= Vi * ry * g1; Myy[j] -= Vi * ry * g2;
      const dr = dvx * g1 + dvy * g2;           // continuity: dρ_i/dt = Σ m_j v_ij·∇W
      drho[i] += m * dr; drho[j] += m * dr;
    }
    // Shepard density filter every 20 steps damps the slow pressure drift of the continuity form.
    if (this.steps % 20 === 0) this.shepard();

    // 2. Constitutive update per particle.
    const eps = 0.3, sq23 = Math.sqrt(2 / 3), pCut = -2 * mat.A * 1e6;
    let seqMax = 0;
    for (let i = 0; i < N; i++) {
      if (fixed[i] === 2) continue;
      // L ← L·M⁻¹ when M is well conditioned (interior and smooth free surfaces).
      let lxx = Lxx[i], lxy = Lxy[i], lyx = Lyx[i], lyy = Lyy[i];
      const det = Mxx[i] * Myy[i] - Mxy[i] * Myx[i];
      if (det > 0.25) {
        const ixx = Myy[i] / det, ixy = -Mxy[i] / det, iyx = -Myx[i] / det, iyy = Mxx[i] / det;
        const a = lxx * ixx + lxy * iyx, b = lxx * ixy + lxy * iyy;
        const c2 = lyx * ixx + lyy * iyx, d = lyx * ixy + lyy * iyy;
        lxx = a; lxy = b; lyx = c2; lyy = d;
      }
      const dxx = lxx, dyy = lyy, dxy = 0.5 * (lxy + lyx), w = 0.5 * (lxy - lyx);
      const tr = dxx + dyy;
      rho[i] += drho[i] * dt;
      p[i] = K * (rho[i] / rho0 - 1);
      if (p[i] < pCut) { p[i] = pCut; rho[i] = rho0 * (1 + pCut / K); }  // tensile cut-off
      const ddx = dxx - tr / 3, ddy = dyy - tr / 3, ddz = -tr / 3;
      let a = sxx[i], b = syy[i], cz = szz[i], s = sxy[i];
      const na = a + dt * (2 * G * ddx + 2 * s * w);
      const nb = b + dt * (2 * G * ddy - 2 * s * w);
      const nz = cz + dt * (2 * G * ddz);
      const ns = s + dt * (2 * G * dxy + w * (b - a));
      a = na; b = nb; cz = nz; s = ns;
      const seq = Math.sqrt(1.5 * (a * a + b * b + cz * cz + 2 * s * s));
      const sy = flowStress(mat, ep[i], epd[i], T[i]);
      let dep = 0;
      if (seq > sy) {
        const sc = sy / seq;
        a *= sc; b *= sc; cz *= sc; s *= sc;
        dep = (seq - sy) / (3 * G);
        ep[i] += dep;
        T[i] += cfg.beta * sy * dep / (mat.rho * mat.c);
      }
      epd[i] = 0.7 * epd[i] + 0.3 * dep / dt;
      // Total strain rate for display.
      this.sr[i] = sq23 * Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz + 2 * dxy * dxy);
      sxx[i] = a; syy[i] = b; szz[i] = cz; sxy[i] = s;
      this.seq[i] = Math.min(seq, sy);
      if (this.seq[i] > seqMax) seqMax = this.seq[i];
      // Artificial stress from positive principal stresses.
      const txx = a - p[i], tyy = b - p[i], txy = s;
      const th = 0.5 * Math.atan2(2 * txy, txx - tyy), ct = Math.cos(th), st = Math.sin(th);
      const s1 = ct * ct * txx + 2 * ct * st * txy + st * st * tyy;
      const s2 = st * st * txx - 2 * ct * st * txy + ct * ct * tyy;
      const ir2 = 1 / (rho[i] * rho[i]);
      const r1 = s1 > 0 ? -eps * s1 * ir2 : 0, r2 = s2 > 0 ? -eps * s2 * ir2 : 0;
      Rxx[i] = ct * ct * r1 + st * st * r2; Ryy[i] = st * st * r1 + ct * ct * r2; Rxy[i] = ct * st * (r1 - r2);
    }
    this.seqMax = seqMax;

    // 3. Momentum and heat conduction.
    const ax = this.ax, ay = this.ay, cx = this.cx, cy = this.cy, xs = 0.5 * m;
    ax.fill(0); ay.fill(0); cx.fill(0); cy.fill(0);
    const hk = this.hk, cs = this.cs, eta = 0.01 * hk * hk, alpha = cfg.avAlpha, betaV = cfg.avBeta, iWdx = 1 / this.Wdx;
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      const ri2 = 1 / (rho[i] * rho[i]), rj2 = 1 / (rho[j] * rho[j]);
      let txx = (sxx[i] - p[i]) * ri2 + (sxx[j] - p[j]) * rj2;
      let tyy = (syy[i] - p[i]) * ri2 + (syy[j] - p[j]) * rj2;
      let txy = sxy[i] * ri2 + sxy[j] * rj2;
      const rx = x[i] - x[j], ry = y[i] - y[j];
      const vr = (vx[i] - vx[j]) * rx + (vy[i] - vy[j]) * ry;
      if (vr < 0) {
        const mu = hk * vr / (rx * rx + ry * ry + eta);
        const pv = (-alpha * cs * mu + betaV * mu * mu) * 2 / (rho[i] + rho[j]);
        txx -= pv; tyy -= pv;
      }
      let fq = pw[k] * iWdx; fq *= fq; fq *= fq;
      txx += fq * (Rxx[i] + Rxx[j]); tyy += fq * (Ryy[i] + Ryy[j]); txy += fq * (Rxy[i] + Rxy[j]);
      const fx = m * (txx * gx[k] + txy * gy[k]), fy = m * (txy * gx[k] + tyy * gy[k]);
      ax[i] += fx; ay[i] += fy; ax[j] -= fx; ay[j] -= fy;
      // XSPH: move particles with a locally averaged velocity to keep the lattice orderly.
      const wx = xs * pw[k] * 2 / (rho[i] + rho[j]);
      const ux = (vx[j] - vx[i]) * wx, uy = (vy[j] - vy[i]) * wx;
      cx[i] += ux; cy[i] += uy; cx[j] -= ux; cy[j] -= uy;
    }
    this.conduct();

    // 4. Integrate, then enforce tool contact and supports.
    const tool = this.tool, proc = this.proc, heat = this.heat, dx = this.dx, d0 = 0.5 * dx, out = tool.out;
    proc.pose(this, this.t + dt);
    const mu = cfg.mu, fw = cfg.heatToWork, cMat = mat.c, mReal = this.mReal, acc = proc.accumulate(this);
    const tvx0 = tool.vx, tvy0 = tool.vy, om = tool.om, ox = tool.ox, oy = tool.oy;
    let ix = 0, iy = 0, qt = 0, work = 0, tRake = cfg.T0;
    const dead = this.dead, vEsc2 = 100 * this.V * this.V;
    for (let i = 0; i < N; i++) {
      if (!fixed[i] && proc.freezes(this, x[i], y[i])) fixed[i] = 2;
      if (fixed[i] || dead[i]) { vx[i] = 0; vy[i] = 0; this.contact[i] = 0; continue; }
      vx[i] += ax[i] * dt; vy[i] += ay[i] * dt;
      // A particle ejected far faster than the tool has lost its neighbours: retire it.
      if (vx[i] * vx[i] + vy[i] * vy[i] > vEsc2) { dead[i] = 1; this.nDead++; vx[i] = 0; vy[i] = 0; continue; }
      x[i] += (vx[i] + cx[i]) * dt; y[i] += (vy[i] + cy[i]) * dt;
      const dist = toolSdf(tool, x[i], y[i]);
      if (dist >= d0) { this.contact[i] = 0; continue; }
      this.contact[i] = 1;
      const nx = out[1], ny = out[2], lu = out[3], lw = out[4];
      const pen = d0 - dist;
      x[i] += nx * pen; y[i] += ny * pen;               // project back onto the contact surface
      // Tool surface velocity at the particle (translation + rotation about the cutter centre).
      const tvx = tvx0 - om * (y[i] - oy), tvy = tvy0 + om * (x[i] - ox);
      const rvx = vx[i] - tvx, rvy = vy[i] - tvy;
      const vn = rvx * nx + rvy * ny;
      const jn = m * (vn < 0 ? -vn : 0);
      let tx = rvx - vn * nx, ty = rvy - vn * ny;
      const vt = Math.hypot(tx, ty);
      let jt = 0, eTool = 0;
      if (vt > 1e-12) {
        tx /= vt; ty /= vt;
        const tauMax = cfg.mShear * flowStress(mat, ep[i], epd[i], T[i]) / Math.sqrt(3);
        jt = Math.min(m * vt, mu * jn, tauMax * dx * dt);
        const e = jt * (vt - 0.5 * jt / m);
        T[i] += fw * e / (mReal * cMat);
        eTool = (1 - fw) * e;
      }
      // Heat across the interface into the tool grid; pressure and slip for the wear estimate.
      const qc = heat.contact(heat.cellOf(lu, lw), T[i], dx, eTool, jn / dt, vt, dt, acc);
      T[i] -= qc / (mReal * cMat);
      qt += qc + eTool;
      const dpx = jn * nx - jt * tx, dpy = jn * ny - jt * ty;
      if (vn < 0) { vx[i] += -vn * nx; vy[i] += -vn * ny; }
      vx[i] -= jt / m * tx; vy[i] -= jt / m * ty;
      ix -= dpx; iy -= dpy; work += dpx * tvx + dpy * tvy;
      if (T[i] > tRake) tRake = T[i];
    }
    heat.step(dt);
    if (acc) heat.aTime += dt;
    this.impX += ix; this.impY += iy; this.impT += dt; this.qTool += qt; this.tRake = tRake;
    this.workIn += work; this.heatTool += qt;
    this.t += dt; this.steps++;
    if (proc.progress(this) >= 1) this.finish();
  }

  // Called once at the end: steady tool temperature and wear from the averaged contact.
  finish() {
    if (this.done) return;
    this.done = true;
    if (this.proc instanceof Ortho) this.heat.steady();
  }

  // Run until a new averaging window is due (about 160 per cut), then close it.
  stepSample() {
    this.step();
    const p = this.proc.progress(this);
    if (p - this.lastSample >= 1 / 160 || this.done) { this.sample(); this.lastSample = p; }
  }

  shepard() {
    const { N, pi, pj, pw, np, m, rho } = this;
    const num = this.cx, den = this.cy, w0 = this.ad;
    for (let i = 0; i < N; i++) { num[i] = m * w0; den[i] = m * w0 / rho[i]; }
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k], w = pw[k];
      num[i] += m * w; num[j] += m * w; den[i] += m * w / rho[j]; den[j] += m * w / rho[i];
    }
    for (let i = 0; i < N; i++) rho[i] = num[i] / den[i];
  }

  conduct() {
    const { N, pi, pj, pf, np, m, rho, T, dT, mat } = this;
    const sub = this.nSub, h = this.dt / sub;
    // dT_i/dt = 1/(ρc) Σ V_j 2k (T_i − T_j) (r_ij·∇W)/(r²+η²), V_j from the scaled density.
    const coef = 2 * mat.k / (mat.rho * mat.c) * h;
    for (let s = 0; s < sub; s++) {
      dT.fill(0);
      for (let k = 0; k < np; k++) {
        const i = pi[k], j = pj[k];
        const q = coef * (T[i] - T[j]) * pf[k];
        dT[i] += q * m / rho[j]; dT[j] -= q * m / rho[i];
      }
      for (let i = 0; i < N; i++) T[i] += dT[i];
    }
  }

  // Close an averaging window: mean tool force [N for the set width] over the window.
  sample() {
    if (this.impT <= 0) return null;
    const w = this.cfg.width * 1e-3;
    const f = this.proc.forces(this.impX / this.impT * w, this.impY / this.impT * w);
    this.qToolT = this.qTool / this.impT * w;
    this.impX = 0; this.impY = 0; this.impT = 0; this.qTool = 0;
    let tmax = -Infinity;
    for (let i = 0; i < this.N; i++) if (this.T[i] > tmax) tmax = this.T[i];
    const hst = this.hist;
    hst.axis.push(this.proc.axis(this)); hst.fc.push(f.a); hst.ft.push(f.b); hst.tmax.push(tmax);
    hst.trake.push(this.tRake); hst.ttool.push(this.heat.maxT());
    hst.hnom.push(this.proc instanceof Mill ? this.proc.hNom() * 1e3 : this.cfg.h);
    return { fc: f.a, ft: f.b, tmax };
  }

  // Chip thickness: largest distance from the rake face among chip particles 1–2.2 h up the face.
  chipThickness() {
    const t = this.tool, h = this.h;
    const ds = [];
    for (let i = 0; i < this.N; i++) {
      if (this.y[i] < 0.25 * h) continue;
      const rx = this.x[i] - t.ex, ry = this.y[i] - t.ey;
      const s = rx * t.u1x + ry * t.u1y;
      if (s < h || s > 2.2 * h) continue;
      const d = rx * t.n1x + ry * t.n1y - t.r;
      if (d > 0 && d < 8 * h) ds.push(d);
    }
    if (ds.length < 3) return 0;
    ds.sort((a, b) => a - b);
    return ds[Math.floor(0.97 * (ds.length - 1))] + 0.5 * this.dx;
  }

  // Summary. Orthogonal: steady-state averages over the second half of the cut.
  // Milling: peaks over the tooth pass and cutting coefficients fitted to F = K·b·h + Ke·b.
  summary() {
    const hs = this.hist, n = hs.fc.length, cfg = this.cfg, b = cfg.width;
    const avg = (arr, from) => { let s = 0, c = 0; for (let i = from; i < arr.length; i++) { s += arr[i]; c++; } return c ? s / c : 0; };
    let tmax = -Infinity, epMax = 0, edMax = 0, heat = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.T[i] > tmax) tmax = this.T[i];
      if (this.ep[i] > epMax) epMax = this.ep[i];
      if (this.epd[i] > edMax) edMax = this.epd[i];
      heat += this.T[i] - cfg.T0;
    }
    // Energy balance: heat now in the workpiece and chip plus heat sent to the tool, over tool work.
    heat = heat * this.mReal * this.mat.c + this.heatTool;
    const base = {
      mode: cfg.mode, tmax, epMax, edMax, qTool: this.qToolT, progress: Math.min(1, this.proc.progress(this)),
      t: this.t, steps: this.steps, N: this.N, dx: this.dx * 1e6, ms: this.ms, nSub: this.nSub,
      kcRef: this.mat.kcRef, done: this.done, heatRatio: this.workIn > 0 ? heat / this.workIn : 0,
      toolT: this.heat.maxT(), toolSteadyT: this.heat.steadyT ? this.heat.maxT(this.heat.steadyT) : null,
      trakeMax: Math.max(cfg.T0, ...hs.trake),
    };
    let wearCrater = 0, wearFlank = 0;
    if (this.done) for (const r of this.heat.profile()) {
      if (r.s > 0 && r.wear > wearCrater) wearCrater = r.wear;
      if (r.s <= 0 && r.wear > wearFlank) wearFlank = r.wear;
    }
    base.wearCrater = wearCrater; base.wearFlank = wearFlank;
    if (this.proc instanceof Mill) {
      const pr = this.proc;
      // Least squares over samples with h > 15 % of hmax (entry/exit transients excluded).
      const fit = (F) => {
        let sh = 0, sf = 0, shh = 0, shf = 0, c = 0;
        for (let i = 0; i < n; i++) {
          const hh = hs.hnom[i];
          if (hh < 0.15 * pr.hRef * 1e3) continue;
          sh += hh; sf += F[i] / b; shh += hh * hh; shf += hh * F[i] / b; c++;
        }
        const det = c * shh - sh * sh;
        if (c < 4 || Math.abs(det) < 1e-12) return [0, 0];
        return [(c * shf - sh * sf) / det, (shh * sf - sh * shf) / det];   // [K N/mm², Ke N/mm]
      };
      const [Ktc, Kte] = fit(hs.fc), [Krc, Kre] = fit(hs.ft);
      return { ...base, ftMax: Math.max(0, ...hs.fc), frMax: Math.max(0, ...hs.ft), hmax: pr.hRef * 1e3,
        Ktc, Kte, Krc, Kre, angle: pr.axis(this), arc: pr.Delta * 180 / PI, trake: base.trakeMax };
    }
    let from = 0;
    const prog = this.proc.progress(this);
    while (from < n - 1 && hs.axis[from] < Math.min(0.5, 0.5 * prog) * cfg.cutLen) from++;
    const fc = avg(hs.fc, from), ft = avg(hs.ft, from);
    const hc = this.chipThickness();
    const a = this.tool.a;
    let phi = 0;
    if (hc > 0) { const rc = this.h / hc; phi = Math.atan(rc * Math.cos(a) / (1 - rc * Math.sin(a))); }
    const phiM = PI / 4 - (Math.atan(cfg.mu) - a) / 2;
    // Saw-tooth measure: relative fluctuation of the cutting force in the second half.
    let v = 0; for (let i = from; i < n; i++) v += (hs.fc[i] - fc) ** 2;
    const fcStd = n - from > 1 ? Math.sqrt(v / (n - from - 1)) : 0;
    return {
      ...base, fc, ft, kc: fc / (b * cfg.h), hc: hc * 1e3, ratio: hc > 0 ? hc / this.h : 0,
      phi: phi * 180 / PI, phiMerchant: phiM * 180 / PI, trake: avg(hs.trake, from), fcVar: fc > 0 ? fcStd / fc : 0,
      travel: prog * cfg.cutLen,
    };
  }
}
