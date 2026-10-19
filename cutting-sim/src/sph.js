// 2D plane-strain cutting solver (orthogonal cutting or one end-mill tooth): updated-Lagrangian SPH, explicit time integration.
//  - Elasto-plastic solid: hypoelastic Jaumann-rate deviatoric stress + linear EOS pressure,
//    radial return to the Johnson-Cook flow stress (strain hardening, rate, thermal softening).
//  - Thermo-mechanical coupling: Taylor-Quinney plastic heating, frictional heating at the rake
//    face, SPH heat conduction (Cleary-Monaghan Laplacian, sub-cycled to its own stability limit).
//  - Corrected kernel gradient for the velocity gradient, Monaghan artificial viscosity and
//    Gray-Monaghan artificial stress against tensile instability.
//  - Rigid tool with rounded edge, Coulomb friction capped at the shear flow stress, and its own
//    temperature field and Usui wear estimate (toolheat.js).
//  - Ductile fracture: Johnson-Cook damage D = Σ Δεp/εf(η, ε̇, T) with linear softening after
//    initiation; a failed particle keeps only compressive pressure, so cracks open and chips break.
//  - Tool shape: the analytic wedge, a built-in edge preparation or an imported outline (profile.js).
//  - Mass scaling (density × ms for inertia only) keeps the explicit step affordable; the default
//    keeps inertial stress ρ·ms·V² near 4 % of the yield stress so the cut stays quasi-static.
// Units: SI internally (m, s, Pa, K-differences in °C). Forces are per metre of width.
import { MATERIALS, TOOLS, flowStress } from './materials.js';
import { makeTool, toolSdf } from './tool.js';
import { chamferProfile, breakerProfile, rakeOf } from './profile.js';
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
  // Tool shape: 'wedge' (rake, clearance, edge radius), 'chamfer' (negative land of width land [mm]
  // at landDeg), 'breaker' (land, groove width gw / depth gd [mm], wall angle wallDeg and height
  // wh [mm]) or 'custom' (profile: closed polygon [[u, w] m], from profile.js importProfile).
  tool: 'wedge', land: 0.1, landDeg: -20, gw: 0.35, gd: 0.05, wallDeg: 35, wh: 0.06, profile: null,
  // Ductile fracture (Johnson-Cook damage) and a multiplier on the fracture strain.
  fracture: true, efScale: 1, flowScale: 1,
  // Thermal expansion in the pressure (needed for the residual stress of the machined surface).
  thermalExp: false,
  // Residual stress (orthogonal cutting): thermal expansion on, a deeper work piece, and after the
  // cut an unloading and cooling phase of relaxSteps steps before the depth profile is taken.
  residual: false, relaxSteps: 5000,
  // End mill: keep following the chip for this many degrees after the tooth leaves the work.
  track: 10, passes: 1,
};

const PI = Math.PI;

export class CuttingSim {
  constructor(cfg = {}) {
    const c = this.cfg = { ...DEFAULTS, ...cfg };
    if (c.residual && c.mode === 'ortho') { c.thermalExp = true; c.depth = Math.max(c.depth || 0, 0.8, 5 * c.h); }
    // flowScale: multiplier on the whole flow stress (A and B), to calibrate against a measured force.
    const mat = this.mat = c.flowScale > 0 && c.flowScale !== 1 ? { ...MATERIALS[c.mat], A: MATERIALS[c.mat].A * c.flowScale, B: MATERIALS[c.mat].B * c.flowScale } : MATERIALS[c.mat];
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

    const shape = { rake: c.rake, clearance: c.clearance, r: c.edgeRadius, land: c.land, landDeg: c.landDeg,
      gw: c.gw, gd: c.gd, wallDeg: c.wallDeg, wh: c.wh };
    const profile = c.tool === 'chamfer' ? chamferProfile(shape) : c.tool === 'breaker' ? breakerProfile(shape)
      : c.tool === 'custom' && c.profile ? c.profile : null;
    const tool = this.tool = makeTool({ rakeDeg: c.rake, clearanceDeg: c.clearance, edgeRadius: c.edgeRadius * 1e-6, profile, cell: 2 * dx });
    tool.rFace = tool.r;
    if (tool.poly) {
      // Effective rake of the outline where the chip leaves the edge; the rake face line then runs
      // through the edge point (local origin) for the chip-thickness measure.
      tool.a = rakeOf(tool, h); tool.rFace = 0;
      tool.u1x = -Math.sin(tool.a); tool.u1y = Math.cos(tool.a); tool.n1x = Math.cos(tool.a); tool.n1y = Math.sin(tool.a);
    }
    this.dmg = f(N); this.frag = new Int32Array(N); this.nEvac = 0; this.chipInfo = null;
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
    this.hist = { axis: [], fc: [], ft: [], tmax: [], trake: [], ttool: [], hnom: [], pass: [] };
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

  // Neighbour pairs from a Verlet list: candidates within 2h + skin, searched again only when
  // some particle has moved more than half the skin (or one was removed); every step keeps the
  // candidates inside the kernel support and evaluates the kernel and its gradient ∇_i W_ij.
  buildPairs() {
    const { N, x, y, hk, dead } = this, skin = 0.3 * hk;
    let need = !this.xr || this.nDead + this.nEvac !== this.deadRef;
    if (!need) {
      const lim = 0.25 * skin * skin, xr = this.xr, yr = this.yr;
      for (let i = 0; i < N; i++) {
        if (dead[i]) continue;
        const dx = x[i] - xr[i], dy = y[i] - yr[i];
        if (dx * dx + dy * dy > lim) { need = true; break; }
      }
    }
    if (need) {
      this.searchPairs(2 * hk + skin);
      this.xr = x.slice(); this.yr = y.slice(); this.deadRef = this.nDead + this.nEvac;
    }
    // Pairs with a moving particle first (npMove), then pairs of two held particles (supports or
    // the frozen surface), which the momentum loop skips.
    const { ci, cj, nc, fixed } = this, r2max = 4 * hk * hk, inv = 1 / hk, ad = this.ad, eta = 0.01 * hk * hk;
    if (!this.qi || this.qi.length < nc) this.qi = new Int32Array(nc + 1024);
    const qi = this.qi;
    let np = 0, nq = 0;
    for (let pass = 0; pass < 2; pass++) for (let q = 0, qn = pass ? nq : nc; q < qn; q++) {
      const k = pass ? qi[q] : q, i = ci[k], j = cj[k];
      if (!pass) {
        if (dead[i] || dead[j]) continue;
        if (fixed[i] && fixed[j]) { qi[nq++] = k; continue; }
      } else if (q === 0) this.npMove = np;
      const rx = x[i] - x[j], ry = y[i] - y[j], r2 = rx * rx + ry * ry;
      if (r2 >= r2max || r2 === 0) continue;
      if (np >= this.cap) this.growPairs();
      const r = Math.sqrt(r2), qq = r * inv;
      let w, dw;
      if (qq < 1) { w = ad * (1 - 1.5 * qq * qq + 0.75 * qq * qq * qq); dw = ad * inv * (-3 * qq + 2.25 * qq * qq); }
      else { const s = 2 - qq; w = ad * 0.25 * s * s * s; dw = -ad * inv * 0.75 * s * s; }
      this.pi[np] = i; this.pj[np] = j;
      this.gx[np] = dw * rx / r; this.gy[np] = dw * ry / r;
      this.pw[np] = w; this.pf[np] = dw * r / (r2 + eta);
      np++;
    }
    if (!nq) this.npMove = np;
    this.np = np;
  }

  // Cell-list search for all candidate pairs closer than `cell`.
  searchPairs(cell) {
    const { N, x, y, dead } = this;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
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
      const c = Math.floor((x[i] - x0) / cell) + Math.floor((y[i] - y0) / cell) * cw;
      next[i] = head[c]; head[c] = i;
    }
    if (!this.ci) { this.ccap = this.cap; this.ci = new Int32Array(this.ccap); this.cj = new Int32Array(this.ccap); }
    const r2max = cell * cell;
    let nc = 0;
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      for (let i = head[cx + cy * cw]; i >= 0; i = next[i]) {
        for (let oy = 0; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (oy === 0 && ox < 0) continue;
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || nx >= cw || ny >= ch) continue;
          for (let j = ox === 0 && oy === 0 ? next[i] : head[nx + ny * cw]; j >= 0; j = next[j]) {
            const rx = x[i] - x[j], ry = y[i] - y[j];
            if (rx * rx + ry * ry >= r2max) continue;
            if (nc >= this.ccap) {
              const a = this.ci, b = this.cj;
              this.ccap *= 2; this.ci = new Int32Array(this.ccap); this.cj = new Int32Array(this.ccap);
              this.ci.set(a); this.cj.set(b);
            }
            this.ci[nc] = i; this.cj[nc] = j; nc++;
          }
        }
      }
    }
    this.nc = nc;
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
    // Thermal expansion (cfg.thermalExp): the volumetric strain 3α ΔT enters the pressure only.
    const thE = cfg.thermalExp ? 3 * (mat.cte || 0) * 1e-6 : 0, T0 = cfg.T0;
    const dmg = this.dmg, frac = cfg.fracture && mat.D1 != null, dd = mat, efs = cfg.efScale, Tr = mat.Tr, Tm = mat.Tm;
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
      p[i] = K * (rho[i] / rho0 - 1 + thE * (T[i] - T0));
      // Damage softening: full strength up to D = 1, then linear loss of strength until D = 1.5.
      const fs = dmg[i] <= 1 ? 1 : dmg[i] >= 1.5 ? 0 : 3 - 2 * dmg[i];
      const pc = pCut * fs;
      if (p[i] < pc) { p[i] = pc; rho[i] = rho0 * (1 + pc / K - thE * (T[i] - T0)); }  // tensile cut-off (none once failed)
      const ddx = dxx - tr / 3, ddy = dyy - tr / 3, ddz = -tr / 3;
      let a = sxx[i], b = syy[i], cz = szz[i], s = sxy[i];
      const na = a + dt * (2 * G * ddx + 2 * s * w);
      const nb = b + dt * (2 * G * ddy - 2 * s * w);
      const nz = cz + dt * (2 * G * ddz);
      const ns = s + dt * (2 * G * dxy + w * (b - a));
      a = na; b = nb; cz = nz; s = ns;
      const seq = Math.sqrt(1.5 * (a * a + b * b + cz * cz + 2 * s * s));
      const sy = flowStress(mat, ep[i], epd[i], T[i]) * fs;
      let dep = 0;
      if (seq > sy) {
        const sc = seq > 0 ? sy / seq : 0;
        a *= sc; b *= sc; cz *= sc; s *= sc;
        dep = sy > 0 ? (seq - sy) / (3 * G) : 0;
        ep[i] += dep;
        T[i] += cfg.beta * sy * dep / (mat.rho * mat.c);
        // Johnson-Cook fracture strain, accumulated only under a tensile mean stress (η > 0):
        // the constants come from tensile tests, and applied to the compressed primary and
        // secondary shear zones they would turn the whole chip to powder. Particles at a free or
        // contact surface (incomplete kernel support, det M < 0.6) are skipped: their SPH density,
        // hence pressure, reads falsely tensile; cracks start one layer inside instead.
        if (frac && fs > 0 && det > 0.6 && !this.contact[i]) {
          const eta = -p[i] / Math.max(sy, 1e6);
          if (eta > 0) {
            let ts = (T[i] - Tr) / (Tm - Tr); ts = ts < 0 ? 0 : ts > 1 ? 1 : ts;
            const r = epd[i] > 1 ? Math.log(epd[i]) : 0;
            const ef = Math.max(0.02, (dd.D1 + dd.D2 * Math.exp(dd.D3 * eta)) * (1 + dd.D4 * r) * (1 + dd.D5 * ts) * efs);
            dmg[i] += (seq - sy) / (3 * G) / ef;
          }
        }
      } else if (sy === 0) { a = 0; b = 0; cz = 0; s = 0; }
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
    for (let k = 0, nm = this.npMove; k < nm; k++) {
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
      // XSPH: move particles with a locally averaged velocity to keep the lattice orderly
      // (not across a crack: failed particles do not drag their neighbours along).
      if (dmg[i] >= 1.5 || dmg[j] >= 1.5) continue;
      const wx = xs * pw[k] * 2 / (rho[i] + rho[j]);
      const ux = (vx[j] - vx[i]) * wx, uy = (vy[j] - vy[i]) * wx;
      cx[i] += ux; cy[i] += uy; cx[j] -= ux; cy[j] -= uy;
    }
    this.conduct();

    // 4. Integrate, then enforce tool contact and supports.
    const tool = this.tool, proc = this.proc, heat = this.heat, dx = this.dx, d0 = 0.5 * dx, out = tool.out;
    if (!this.relax) proc.pose(this, this.t + dt);    // unloading: the tool stays where it ended, out of contact
    const mu = cfg.mu, fw = cfg.heatToWork, cMat = mat.c, mReal = this.mReal, acc = proc.accumulate(this);
    const tvx0 = tool.vx, tvy0 = tool.vy, om = tool.om, ox = tool.ox, oy = tool.oy;
    let ix = 0, iy = 0, qt = 0, work = 0, tRake = cfg.T0;
    const dead = this.dead, vEsc2 = 100 * this.V * this.V;
    for (let i = 0; i < N; i++) {
      if (!fixed[i] && !this.relax && proc.freezes(this, x[i], y[i])) fixed[i] = 2;
      if (fixed[i] || dead[i]) { vx[i] = 0; vy[i] = 0; this.contact[i] = 0; continue; }
      vx[i] += ax[i] * dt; vy[i] += ay[i] * dt;
      // A particle ejected far faster than the tool has lost its neighbours: retire it.
      if (vx[i] * vx[i] + vy[i] * vy[i] > vEsc2) { dead[i] = 1; this.nDead++; vx[i] = 0; vy[i] = 0; continue; }
      x[i] += (vx[i] + cx[i]) * dt; y[i] += (vy[i] + cy[i]) * dt;
      if (this.relax) { this.contact[i] = 0; continue; }
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
        const fsd = this.dmg[i] <= 1 ? 1 : Math.max(0, 3 - 2 * this.dmg[i]);
        const tauMax = cfg.mShear * flowStress(mat, ep[i], epd[i], T[i]) * fsd / Math.sqrt(3);
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
    if (this.relax) { this.relaxStep(); return; }
    heat.step(dt);
    if (acc) heat.aTime += dt;
    this.impX += ix; this.impY += iy; this.impT += dt; this.qTool += qt; this.tRake = tRake;
    this.workIn += work; this.heatTool += qt;
    this.t += dt; this.steps++;
    if (proc.nextPass) proc.nextPass(this);
    if (proc.progress(this) >= 1) this.finish();
  }

  // Called once at the end: steady tool temperature and wear from the averaged contact.
  finish() {
    if (this.done || this.relax) return;
    if (this.proc instanceof Ortho) this.heat.steady();
    // End mill: mean tool temperature of the periodic steady state, each tooth heated once a turn.
    else this.periodicT = this.heat.steady(this.proc.passes * 2 * PI / this.proc.om);
    if (this.cfg.residual && this.proc instanceof Ortho) { this.startRelax(); return; }
    this.done = true;
  }

  // Residual stress: drop the chip and the uncut layer, end the tool contact, release the frozen
  // surface, then cool every particle to room temperature (instantly, as a ramp) with damped
  // motion so the machined layer settles under its own plastic misfit and thermal shrinkage.
  startRelax() {
    this.cutSummary = this.summary();
    const { N, y, fixed, dead, h } = this;
    for (let i = 0; i < N; i++) {
      if (!dead[i] && y[i] > -h) { dead[i] = 2; this.nEvac++; }
      if (fixed[i] === 2) fixed[i] = 0;
    }
    this.relax = { n: 0, xEnd: this.tool.ex };
  }
  relaxStep() {
    const { N, vx, vy, T, cfg } = this, r = this.relax;
    for (let i = 0; i < N; i++) { vx[i] *= 0.995; vy[i] *= 0.995; T[i] = cfg.T0 + (T[i] - cfg.T0) * 0.998; }
    this.t += this.dt; this.steps++;
    if (++r.n >= cfg.relaxSteps) { this.residual = this.residualProfile(); this.done = true; }
  }
  // Depth profile below the machined surface (σxx along the cut, σyy normal to it) over the
  // steady part of the cut, in bins of two particle spacings.
  residualProfile() {
    const { N, x, y, sxx, syy, p, dead, fixed, h, dx } = this, xEnd = this.relax.xEnd, bw = 2 * dx, bins = [];
    for (let i = 0; i < N; i++) {
      if (dead[i] || fixed[i] === 1 || x[i] < 0.3 * xEnd || x[i] > xEnd - 2 * h) continue;
      const d = -h - y[i];
      if (d < 0) continue;
      const k = Math.floor(d / bw), b = bins[k] || (bins[k] = [0, 0, 0]);
      b[0] += sxx[i] - p[i]; b[1] += syy[i] - p[i]; b[2]++;
    }
    const out = [];
    for (let k = 0; k < bins.length; k++) if (bins[k] && bins[k][2]) out.push({ d: (k + 0.5) * bw * 1e6, sxx: bins[k][0] / bins[k][2] * 1e-6, syy: bins[k][1] / bins[k][2] * 1e-6 });
    return out;
  }

  // Run until a new averaging window is due (about 160 per cut), then close it.
  stepSample() {
    this.step();
    if (this.relax) return;
    const p = this.proc.progress(this);
    if (p - this.lastSample >= 1 / (160 * (this.proc.passes || 1)) || this.done) { this.sample(); this.lastSample = p; }
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
    this.analyzeChips();
    const hst = this.hist;
    hst.axis.push(this.proc.axis(this)); hst.fc.push(f.a); hst.ft.push(f.b); hst.tmax.push(tmax);
    hst.trake.push(this.tRake); hst.ttool.push(this.heat.maxT());
    hst.hnom.push(this.proc instanceof Mill ? this.proc.hNom() * 1e3 : this.cfg.h);
    hst.pass.push(this.proc.k || 0);
    return { fc: f.a, ft: f.b, tmax };
  }

  // Chip pieces: connected groups of intact particles (pairs closer than 1.6 Δx, neither failed).
  // A group holding no supported particle has broken off. Pieces farther than rEvac from the
  // cutting edge have left the cutting zone: they are counted as evacuated and removed.
  analyzeChips() {
    const { N, x, y, vx, vy, dmg, fixed, dead, pi, pj, np, dx } = this, par = this.frag;
    for (let i = 0; i < N; i++) par[i] = i;
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const r2 = (1.6 * dx) ** 2;
    for (let k = 0; k < np; k++) {
      const i = pi[k], j = pj[k];
      if (dmg[i] >= 1.5 || dmg[j] >= 1.5 || dead[i] || dead[j]) continue;
      if ((x[i] - x[j]) ** 2 + (y[i] - y[j]) ** 2 > r2) continue;
      const a = find(i), b = find(j); if (a !== b) par[a] = b;
    }
    const g = new Map();
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      const r = find(i);
      let e = g.get(r);
      if (!e) { e = { n: 0, sx: 0, sy: 0, vx: 0, vy: 0, base: false, ids: [] }; g.set(r, e); }
      e.n++; e.sx += x[i]; e.sy += y[i]; e.vx += vx[i]; e.vy += vy[i]; e.ids.push(i);
      if (fixed[i]) e.base = true;
    }
    const t = this.tool, rEvac = Math.max(1.2e-3, 12 * this.h);
    let pieces = 0, big = null;
    for (const e of g.values()) {
      if (e.base) continue;
      const cx = e.sx / e.n, cy = e.sy / e.n;
      if (e.n >= 6) {
        pieces++;
        if (!big || e.n > big.n) big = { n: e.n, vx: e.vx / e.n, vy: e.vy / e.n, x: cx, y: cy };
      }
      if (Math.hypot(cx - t.ex, cy - t.ey) > rEvac) { for (const i of e.ids) dead[i] = 2; this.nEvac += e.n; }
    }
    this.chipInfo = { pieces, big, failed: this.countFailed() };
  }

  countFailed() { let c = 0; for (let i = 0; i < this.N; i++) if (!this.dead[i] && this.dmg[i] >= 1) c++; return c; }

  // Chip up-curl radius (orthogonal cutting): circle fitted to the chip above the work surface.
  curlRadius() {
    const h = this.h, xs = [], ys = [];
    for (let i = 0; i < this.N; i++) if (!this.dead[i] && this.y[i] > h) { xs.push(this.x[i]); ys.push(this.y[i]); }
    const n = xs.length;
    if (n < 20) return null;
    const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0, ext = 0;
    for (let k = 0; k < n; k++) {
      const u = xs[k] - mx, v = ys[k] - my;
      suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
      ext = Math.max(ext, Math.hypot(u, v));
    }
    if (ext < 1.5 * h) return null;
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-30) return Infinity;
    const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
    const uc = (b1 * svv - b2 * suv) / det, vc = (b2 * suu - b1 * suv) / det;
    const R = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
    return R > 30 * h ? Infinity : R;
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
      const d = rx * t.n1x + ry * t.n1y - t.rFace;
      if (d > 0 && d < 8 * h) ds.push(d);
    }
    if (ds.length < 3) return 0;
    ds.sort((a, b) => a - b);
    return ds[Math.floor(0.97 * (ds.length - 1))] + 0.5 * this.dx;
  }

  // Summary. Orthogonal: steady-state averages over the second half of the cut.
  // Milling: peaks over the tooth pass and cutting coefficients fitted to F = K·b·h + Ke·b.
  summary() {
    if (this.relax) {
      const r = this.residual, base = { ...this.cutSummary, done: this.done, relax: this.relax.n / this.cfg.relaxSteps, steps: this.steps, t: this.t };
      if (!r) return base;
      const surf = r[0].sxx;
      let pk = r[0];
      for (const b of r) if (b.sxx < pk.sxx) pk = b;
      return { ...base, residual: r, rsSurf: surf, rsMin: pk.sxx, rsMinDepth: pk.d };
    }
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
      pieces: this.chipInfo ? this.chipInfo.pieces : 0, failed: this.chipInfo ? this.chipInfo.failed : 0,
      evacuated: this.nEvac, toolRake: this.tool.a * 180 / PI,
    };
    let wearCrater = 0, wearFlank = 0, pMax = 0, contactLen = null;
    const prof = this.done ? this.heat.profile() : [];
    for (const r of prof) {
      if (r.s > 0 && r.wear > wearCrater) wearCrater = r.wear;
      if (r.s <= 0 && r.wear > wearFlank) wearFlank = r.wear;
      if (r.s > 0 && r.p > pMax) pMax = r.p;
    }
    // Tool-chip contact length on the rake face: the farthest point (arc length from the edge)
    // still carrying 5 % of the peak mean pressure.
    if (pMax > 0) { contactLen = 0; for (const r of prof) if (r.s > 0 && r.p > 0.05 * pMax) contactLen = Math.max(contactLen, r.s * 1e-3); }
    base.wearCrater = wearCrater; base.wearFlank = wearFlank; base.contactLen = contactLen;
    if (this.proc instanceof Mill) {
      const pr = this.proc;
      // Least squares over samples with 15 % < h < 90 % of hmax. Near h = 0 the edge only ploughs;
      // near hmax the tooth meets the free top face (the exit of up milling, where the chip lets go
      // and the force drops; the entry of down milling, an impact). With both ends left in, up
      // milling gave Ktc 453 and down milling 1,100 N/mm² for the same A7075 cut; without the top
      // end, 1,217 and 1,143.
      const fit = (F) => {
        let sh = 0, sf = 0, shh = 0, shf = 0, c = 0;
        for (let i = 0; i < n; i++) {
          const hh = hs.hnom[i];
          if (hh < 0.15 * pr.hRef * 1e3 || hh > 0.9 * pr.hRef * 1e3 || hs.pass[i] !== pr.k) continue;   // the last tooth only
          sh += hh; sf += F[i] / b; shh += hh * hh; shf += hh * F[i] / b; c++;
        }
        const det = c * shh - sh * sh;
        if (c < 4 || Math.abs(det) < 1e-12) return [0, 0];
        return [(c * shf - sh * sf) / det, (shh * sf - sh * shf) / det];   // [K N/mm², Ke N/mm]
      };
      const [Ktc, Kte] = fit(hs.fc), [Krc, Kre] = fit(hs.ft);
      // Ejection of the largest free chip piece: speed and angle from the cutter tangent at the
      // exit point (positive = outward, away from the cutter).
      let ejectV = null, ejectAng = null;
      const big = this.chipInfo && this.chipInfo.big;
      if (big && pr.beta > pr.b1) {
        const tx = -Math.sin(pr.b1), ty = Math.cos(pr.b1), rx = Math.cos(pr.b1), ry = Math.sin(pr.b1);
        ejectV = Math.hypot(big.vx, big.vy) * 60;
        ejectAng = Math.atan2(big.vx * rx + big.vy * ry, big.vx * tx + big.vy * ty) * 180 / PI;
      }
      // Peak tangential force of each tooth (several teeth: the later ones cut the surface left behind).
      const passMax = [];
      for (let i = 0; i < n; i++) passMax[hs.pass[i]] = Math.max(passMax[hs.pass[i]] || 0, hs.fc[i]);
      return { ...base, ftMax: Math.max(0, ...hs.fc), frMax: Math.max(0, ...hs.ft), hmax: pr.hRef * 1e3, passMax, passes: pr.passes, span: pr.span(),
        // Periodic steady state: the mean field, plus the rise one contact gives a cold tool (superposed).
        toolMeanT: this.periodicT ? this.heat.maxT(this.periodicT) : null,
        // (capped at the hottest chip contact: the surface cannot get hotter than what heats it).
        toolPeakT: this.periodicT ? Math.min(base.trakeMax, this.heat.maxT(this.periodicT) + Math.max(cfg.T0, ...hs.ttool) - cfg.T0) : null,
        Ktc, Kte, Krc, Kre, angle: pr.axis(this), arc: pr.Delta * 180 / PI, trake: base.trakeMax, ejectV, ejectAng,
        track: cfg.track };
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
      travel: prog * cfg.cutLen, curl: ((r) => (r == null || !isFinite(r) ? r : r * 1e3))(this.curlRadius()),
    };
  }
}
