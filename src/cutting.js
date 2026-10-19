// Time-domain milling dynamics: mechanistic cutting forces on axial slices of a helical
// end mill, a multi-mode (x and y separately) tool-tip modal model and regenerative chip thickness through a
// one-tooth-period delay. An optional 1-DOF workpiece mode (thin wall) moves along the wall
// normal; chip thickness uses the tool-to-wall relative displacement.
// With tool.nonlinear (default) the shearing coefficients follow an exponential size effect
// K(h) = K·(h0/h)^mc and the flank adds process damping Ci·b·v_n/V_c against the normal
// vibration velocity, which stabilises low-speed cutting.
// Lengths in mm, forces in N, modal states in metres (SI).

import { modeSet } from './frf.js';

export const BINS = 180; // angular resolution of the engagement map
export const H_REF = 0.05; // chip thickness at which the size-effect coefficients equal K [mm]
const H_MIN = 0.002;       // below this the exponential law is not extrapolated [mm]

export class CuttingEngine {
  constructor() {
    this.Hb = new Float32Array(BINS);
    this.stats = newStats();
    this.hist = { n: 4096, i: 0, count: 0, Fx: new Float32Array(4096), Fy: new Float32Array(4096), Fz: new Float32Array(4096), x: new Float32Array(4096), y: new Float32Array(4096) };
    this.toothSamples = { n: 64, i: 0, count: 0, x: new Float32Array(64), y: new Float32Array(64) };
    // tool position each time a tooth passes the +v side (φ = 0) and the −v side (φ = π) of the
    // cutter: these are the moments the two side walls are generated (surface roughness)
    this.wallSamples = { n: 64, i: 0, count: 0, x: new Float32Array(64), y: new Float32Array(64) };
    this.wallSamplesPi = { n: 64, i: 0, count: 0, x: new Float32Array(64), y: new Float32Array(64) };
    this.chipEvents = [];
  }

  // tool: {N, R, helixDeg, type, fluteLen}, modal: {k [N/mm], fn [Hz], zeta[, modesX, modesY]}, mat, S [rpm]
  // fnMax: highest frequency to resolve (tool or workpiece mode)
  configure(tool, modal, mat, S, fnMax = 0) {
    this.tool = tool; this.mat = mat; this.modal = modal;
    this.N = tool.N; this.R = tool.R; this.tanB = Math.tan(tool.helixDeg * Math.PI / 180);
    this.S = Math.max(100, S);
    this.omega = this.S * 2 * Math.PI / 60;
    const Ttooth = 60 / (this.S * this.N);
    const ms = modeSet(modal);
    const fTop = Math.max(...ms.x.map(m => m.fn), ...ms.y.map(m => m.fn));
    this.stepsPerTooth = Math.max(48, Math.ceil(Ttooth * Math.max(fTop, fnMax) * 24));
    this.dt = Ttooth / this.stepsPerTooth;
    this.Ttooth = Ttooth;
    // each mode is a mass-spring-damper driven by the full force; displacement is their sum
    const pack = modes => {
      const k = Float64Array.from(modes, m => m.k * 1e3);
      const mass = Float64Array.from(modes, (m, i) => k[i] / (2 * Math.PI * m.fn) ** 2);
      const c = Float64Array.from(modes, (m, i) => 2 * m.zeta * Math.sqrt(k[i] * mass[i]));
      return { k, m: mass, c, q: new Float64Array(modes.length), v: new Float64Array(modes.length) };
    };
    this.mx = pack(ms.x); this.my = pack(ms.y);
    this.x0 = 0; this.y0 = 0; this.vx0 = 0; this.vy0 = 0;
    // surface left by the previous tooth, per slice / tooth / step-in-period (multiple regeneration)
    this.dz = Math.max(0.25, tool.fluteLen / 48);
    this.maxSlices = Math.ceil(tool.fluteLen / this.dz);
    // indexed by [slice][angular position within one revolution]; each tooth reads what the
    // tooth ahead of it left at the same angle one tooth period earlier
    this.stepsPerRev = this.N * this.stepsPerTooth;
    this.surf = new Float32Array(this.maxSlices * this.stepsPerRev);
    this.pr = 0;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.t = 0;
    this.setWork(null);
    this.toothEngaged = new Uint8Array(this.N);
    this.toothVol = new Float64Array(this.N);
    this.toothPhi = new Float64Array(this.N);
    this.toothZ = new Float64Array(this.N);
    this.decim = Math.max(1, Math.round(this.stepsPerTooth / 40));
    // step within a tooth period at which some tooth sits at φ = π
    this.piStep = Math.round(((Math.PI % (2 * Math.PI / this.N)) / (2 * Math.PI / this.N)) * this.stepsPerTooth) % this.stepsPerTooth;
    for (const b of [this.wallSamples, this.wallSamplesPi]) { b.i = 0; b.count = 0; }
    this.stepCount = 0;
  }

  // wall: {k [N/mm], m [kg], zeta, nx, ny} or null for a rigid workpiece
  setWork(wall) {
    if (!wall) { this.runMeanW = 0; this.wk = 0; this.wm = 1; this.wc = 0; this.w = 0; this.wv = 0; this.wnx = 1; this.wny = 0; return; }
    // carry the wall state over only while the normal stays roughly the same
    if (this.wk && wall.nx * this.wnx + wall.ny * this.wny < 0.8) { this.w = 0; this.wv = 0; }
    this.wk = wall.k * 1e3; this.wm = wall.m; this.wc = 2 * wall.zeta * Math.sqrt(this.wk * wall.m);
    this.wnx = wall.nx; this.wny = wall.ny;
  }

  // Hb filled by caller: material height at the cutter periphery for each local angle bin.
  // u: unit feed direction (xy), fz: feed per tooth [mm], tipZ, ap: engaged axial depth.
  setEngagement(u, fz, tipZ, ap) {
    this.ux = u[0]; this.uy = u[1]; this.vx_ = -u[1]; this.vy_ = u[0];
    this.fz = fz; this.tipZ = tipZ;
    const nz = ap <= 0 ? 0 : Math.min(this.maxSlices, Math.ceil(ap / this.dz));
    this.nz = nz;
    this.db = this.dz;
    this.sliceZ = new Float64Array(nz);
    this.sliceLag = new Float64Array(nz);
    this.sliceR = new Float64Array(nz);
    this.sliceKap = new Float64Array(nz);
    const R = this.R;
    for (let k = 0; k < nz; k++) {
      const zr = (k + 0.5) * this.dz;
      this.sliceZ[k] = tipZ + zr;
      let r = R, kap = 1;
      if (this.tool.rAt) {
        // general edge shape: radius from the profile, κ from its slope (90° on a straight side)
        r = Math.max(1e-3, this.tool.rAt(zr));
        const dr = (this.tool.rAt(zr + 0.05) - this.tool.rAt(Math.max(0, zr - 0.05))) / (zr < 0.05 ? 0.05 + zr : 0.1);
        kap = 1 / Math.sqrt(1 + dr * dr);
      } else if (this.tool.type === 'ball' && zr < R) { r = Math.sqrt(Math.max(1e-6, R * R - (R - zr) ** 2)); kap = r / R; }
      this.sliceR[k] = r; this.sliceKap[k] = kap;
      this.sliceLag[k] = zr * this.tanB / R;
    }
  }

  // Integrate nSteps. Returns nothing; results accumulate in this.stats / hist / chipEvents.
  run(nSteps) {
    const { N, Hb, mat, dt, surf, stepsPerTooth, stepsPerRev, nz, db, sliceZ, sliceLag, sliceR, sliceKap } = this;
    const ux = this.ux, uy = this.uy, vx = this.vx_, vy = this.vy_, fz = this.fz;
    const Ktc = mat.Ktc, Krc = mat.Krc, Kac = mat.Kac, Kte = mat.Kte, Kre = mat.Kre, Kae = mat.Kae;
    const nl = this.tool.nonlinear !== false;
    const mc = nl ? (mat.mc ?? 0) : 0;
    // process damping per slice [N·s/m] = Ci·b / V_c, V_c = ω·r
    const pdK = nl ? (mat.Ci ?? 0) * db * 1e-3 / (this.omega * 1e-3) : 0;
    const wnx_ = this.wnx, wny_ = this.wny;
    const TWO_PI = 2 * Math.PI, binScale = BINS / TWO_PI, pitch = TWO_PI / N;
    const st = this.stats, hist = this.hist, ts = this.toothSamples;
    const dphi = this.omega * dt;
    const hMax = Math.max(0.1, 3 * fz);
    const MX = this.mx, MY = this.my, nmx = MX.k.length, nmy = MY.k.length;
    // a state set from outside (a test kick) since the last run goes into the first mode
    MX.q[0] += this.x - this.x0; MY.q[0] += this.y - this.y0; MX.v[0] += this.vx - this.vx0; MY.v[0] += this.vy - this.vy0;
    let x = this.x, y = this.y, vxs = this.vx, vys = this.vy, t = this.t, pr = this.pr;
    const wk = this.wk, wm = this.wm, wc = this.wc, wnx = this.wnx, wny = this.wny;
    let w = this.w, wv = this.wv, wSum = 0;
    for (let s = 0; s < nSteps; s++) {
      const theta = pr * dphi;
      // tool position relative to the (possibly deflected) workpiece [mm]
      const rx = x - w * wnx, ry = y - w * wny;
      const xm = rx * 1e3, ym = ry * 1e3;
      let Fx = 0, Fy = 0, Fz = 0, T = 0, Fr2z = 0, Fsum = 0;
      // relative tool-to-wall velocity [m/s] for process damping
      const rvx = vxs - wv * wnx_, rvy = vys - wv * wny_;
      for (let i = 0; i < N; i++) {
        let engaged = 0, ph = 0, zsum = 0;
        let pi = pr + i * stepsPerTooth; if (pi >= stepsPerRev) pi -= stepsPerRev;
        for (let k = 0; k < nz; k++) {
          let phi = (theta + i * pitch - sliceLag[k]) % TWO_PI;
          if (phi < 0) phi += TWO_PI;
          const sn = Math.sin(phi), cs = Math.cos(phi);
          const nxg = sn * ux + cs * vx, nyg = sn * uy + cs * vy;
          const rn = xm * nxg + ym * nyg;
          const idx = k * stepsPerRev + pi;
          const prev = surf[idx];
          const feedH = fz * sn * sliceKap[k];
          if (Hb[(phi * binScale) | 0] <= sliceZ[k] || sn <= 0) { surf[idx] = rn; continue; }
          let h = feedH + rn - prev;
          // tooth out of cut: the old surface survives one more feed step
          if (h <= 0) { surf[idx] = prev - feedH; continue; }
          surf[idx] = rn;
          // physical cap: beyond this the real tool breaks or jumps out; keeps severe chatter bounded
          if (h > hMax) h = hMax;
          const se = mc ? Math.pow(H_REF / (h > H_MIN ? h : H_MIN), mc) : 1;
          const Ft = Ktc * se * h * db + Kte * db;
          let Fr = Krc * se * h * db + Kre * db;
          const Fa = Kac * se * h * db + Kae * db;
          // flank indentation resists motion along the edge normal (process damping)
          if (pdK) Fr += pdK / sliceR[k] * (rvx * nxg + rvy * nyg);
          const txg = cs * ux - sn * vx, tyg = cs * uy - sn * vy;
          Fx += -Ft * txg - Fr * nxg;
          Fy += -Ft * tyg - Fr * nyg;
          Fz -= Fa;
          T += Ft * sliceR[k];
          const fr = Math.hypot(Ft, Fr);
          Fsum += fr; Fr2z += fr * (sliceZ[k] - this.tipZ);
          engaged = 1; ph = phi; zsum = sliceZ[k];
          this.toothVol[i] += h * db * sliceR[k] * dphi;
        }
        if (engaged) { this.toothPhi[i] = ph; this.toothZ[i] = zsum; }
        else if (this.toothEngaged[i]) {
          if (this.toothVol[i] > 0) this.chipEvents.push({ vol: this.toothVol[i], phi: this.toothPhi[i], z: this.toothZ[i], ux, uy, vx, vy });
          this.toothVol[i] = 0;
        }
        this.toothEngaged[i] = engaged;
      }
      // modal integration (semi-implicit Euler), SI
      x = 0; y = 0; vxs = 0; vys = 0;
      for (let j = 0; j < nmx; j++) {
        MX.v[j] += (Fx - MX.c[j] * MX.v[j] - MX.k[j] * MX.q[j]) / MX.m[j] * dt;
        MX.q[j] += MX.v[j] * dt; x += MX.q[j]; vxs += MX.v[j];
      }
      for (let j = 0; j < nmy; j++) {
        MY.v[j] += (Fy - MY.c[j] * MY.v[j] - MY.k[j] * MY.q[j]) / MY.m[j] * dt;
        MY.q[j] += MY.v[j] * dt; y += MY.q[j]; vys += MY.v[j];
      }
      if (wk) {
        // reaction on the wall: opposite to the force on the tool, projected on the wall normal
        const Fw = -(Fx * wnx + Fy * wny);
        wv += (Fw - wc * wv - wk * w) / wm * dt;
        w += wv * dt;
        // the wall cannot be pushed further than the material the cutter is engaged in
        if (w > 5e-4) { w = 5e-4; if (wv > 0) wv = 0; } else if (w < -2e-4) { w = -2e-4; if (wv < 0) wv = 0; }
        st.sumW += w; st.maxW = Math.max(st.maxW, Math.abs(w)); wSum += w;
      }
      if (++pr === stepsPerRev) pr = 0;
      const ph = pr % stepsPerTooth;
      if (ph === 0) {
        ts.x[ts.i] = x - w * wnx; ts.y[ts.i] = y - w * wny; ts.i = (ts.i + 1) % ts.n; ts.count++;
        const b = this.wallSamples; b.x[b.i] = x - w * wnx; b.y[b.i] = y - w * wny; b.i = (b.i + 1) % b.n; b.count++;
      }
      if (ph === this.piStep) { const b = this.wallSamplesPi; b.x[b.i] = x - w * wnx; b.y[b.i] = y - w * wny; b.i = (b.i + 1) % b.n; b.count++; }
      t += dt;
      // statistics
      const Fxy = Math.hypot(Fx, Fy);
      st.n++; st.sumF += Fxy; st.maxF = Math.max(st.maxF, Fxy);
      st.sumFx += Fx; st.sumFy += Fy; st.sumFz += Fz; st.maxFz = Math.max(st.maxFz, -Fz);
      st.sumT += T; st.maxT = Math.max(st.maxT, T);
      st.sumX += x; st.sumY += y;
      st.minX = Math.min(st.minX, x); st.maxX = Math.max(st.maxX, x);
      st.minY = Math.min(st.minY, y); st.maxY = Math.max(st.maxY, y);
      if (Fsum > 0) { st.sumZc += Fr2z / Fsum * Fxy; st.wZc += Fxy; }
      if (++this.stepCount % this.decim === 0) {
        const j = hist.i;
        hist.Fx[j] = Fx; hist.Fy[j] = Fy; hist.Fz[j] = Fz; hist.x[j] = (x - w * wnx) * 1e6; hist.y[j] = (y - w * wny) * 1e6;
        hist.i = (j + 1) % hist.n; hist.count++;
      }
    }
    this.x = this.x0 = x; this.y = this.y0 = y; this.vx = this.vx0 = vxs; this.vy = this.vy0 = vys; this.t = t; this.pr = pr; this.w = w; this.wv = wv;
    this.runMeanW = nSteps ? wSum / nSteps : 0; // mean wall deflection over this call [m]
  }

  // Ratio of once-per-tooth-period scatter to total vibration: ~0 for forced vibration, large for chatter.
  chatterIndex() {
    const ts = this.toothSamples, h = this.hist;
    const n = Math.min(ts.count, 24);
    if (n < 8) return { index: 0, amp: 0 };
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { const j = (ts.i - 1 - k + ts.n) % ts.n; mx += ts.x[j]; my += ts.y[j]; }
    mx /= n; my /= n;
    let v = 0;
    for (let k = 0; k < n; k++) { const j = (ts.i - 1 - k + ts.n) % ts.n; v += (ts.x[j] - mx) ** 2 + (ts.y[j] - my) ** 2; }
    const sOnce = Math.sqrt(v / n) * 1e6; // µm
    // total vibration over the same window (decimated history)
    const m = Math.min(h.count, Math.round(n * this.stepsPerTooth / this.decim));
    let ax = 0, ay = 0;
    for (let k = 0; k < m; k++) { const j = (h.i - 1 - k + h.n) % h.n; ax += h.x[j]; ay += h.y[j]; }
    ax /= m || 1; ay /= m || 1;
    let w = 0;
    for (let k = 0; k < m; k++) { const j = (h.i - 1 - k + h.n) % h.n; w += (h.x[j] - ax) ** 2 + (h.y[j] - ay) ** 2; }
    const sAll = Math.sqrt(w / (m || 1));
    return { index: sOnce / (sAll + 0.05), amp: sAll, once: sOnce };
  }

  takeStats() { const s = this.stats; this.stats = newStats(); return s; }
}

function newStats() {
  return { n: 0, sumF: 0, maxF: 0, sumFx: 0, sumFy: 0, sumFz: 0, maxFz: 0, sumT: 0, maxT: 0, sumX: 0, sumY: 0,
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, sumZc: 0, wZc: 0, sumW: 0, maxW: 0 };
}
