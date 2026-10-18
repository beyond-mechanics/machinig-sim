// Time-domain milling dynamics: mechanistic cutting forces on axial slices of a helical
// end mill, a 2-DOF (x, y) tool-tip modal model and regenerative chip thickness through a
// one-tooth-period delay. Lengths in mm, forces in N, modal states in metres (SI).

export const BINS = 180; // angular resolution of the engagement map

export class CuttingEngine {
  constructor() {
    this.Hb = new Float32Array(BINS);
    this.stats = newStats();
    this.hist = { n: 4096, i: 0, count: 0, Fx: new Float32Array(4096), Fy: new Float32Array(4096), Fz: new Float32Array(4096), x: new Float32Array(4096), y: new Float32Array(4096) };
    this.toothSamples = { n: 64, i: 0, count: 0, x: new Float32Array(64), y: new Float32Array(64) };
    this.chipEvents = [];
  }

  // tool: {N, R, helixDeg, type, fluteLen}, modal: {k [N/mm], fn [Hz], zeta}, mat, S [rpm]
  configure(tool, modal, mat, S) {
    this.tool = tool; this.mat = mat; this.modal = modal;
    this.N = tool.N; this.R = tool.R; this.tanB = Math.tan(tool.helixDeg * Math.PI / 180);
    this.S = Math.max(100, S);
    this.omega = this.S * 2 * Math.PI / 60;
    const Ttooth = 60 / (this.S * this.N);
    this.stepsPerTooth = Math.max(48, Math.ceil(Ttooth * modal.fn * 24));
    this.dt = Ttooth / this.stepsPerTooth;
    this.Ttooth = Ttooth;
    const kSI = modal.k * 1e3;
    const w = 2 * Math.PI * modal.fn;
    this.m = kSI / (w * w);
    this.kSI = kSI;
    this.c = 2 * modal.zeta * Math.sqrt(kSI * this.m);
    // surface left by the previous tooth, per slice / tooth / step-in-period (multiple regeneration)
    this.dz = Math.max(0.25, tool.fluteLen / 48);
    this.maxSlices = Math.ceil(tool.fluteLen / this.dz);
    // indexed by [slice][angular position within one revolution]; each tooth reads what the
    // tooth ahead of it left at the same angle one tooth period earlier
    this.stepsPerRev = this.N * this.stepsPerTooth;
    this.surf = new Float32Array(this.maxSlices * this.stepsPerRev);
    this.pr = 0;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.t = 0;
    this.toothEngaged = new Uint8Array(this.N);
    this.toothVol = new Float64Array(this.N);
    this.toothPhi = new Float64Array(this.N);
    this.toothZ = new Float64Array(this.N);
    this.decim = Math.max(1, Math.round(this.stepsPerTooth / 40));
    this.stepCount = 0;
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
      if (this.tool.type === 'ball' && zr < R) { r = Math.sqrt(Math.max(1e-6, R * R - (R - zr) ** 2)); kap = r / R; }
      this.sliceR[k] = r; this.sliceKap[k] = kap;
      this.sliceLag[k] = zr * this.tanB / R;
    }
  }

  // Integrate nSteps. Returns nothing; results accumulate in this.stats / hist / chipEvents.
  run(nSteps) {
    const { N, Hb, mat, dt, m, kSI, c, surf, stepsPerTooth, stepsPerRev, nz, db, sliceZ, sliceLag, sliceR, sliceKap } = this;
    const ux = this.ux, uy = this.uy, vx = this.vx_, vy = this.vy_, fz = this.fz;
    const Ktc = mat.Ktc, Krc = mat.Krc, Kac = mat.Kac, Kte = mat.Kte, Kre = mat.Kre, Kae = mat.Kae;
    const TWO_PI = 2 * Math.PI, binScale = BINS / TWO_PI, pitch = TWO_PI / N;
    const st = this.stats, hist = this.hist, ts = this.toothSamples;
    const dphi = this.omega * dt;
    const hMax = Math.max(0.1, 3 * fz);
    let x = this.x, y = this.y, vxs = this.vx, vys = this.vy, t = this.t, pr = this.pr;
    for (let s = 0; s < nSteps; s++) {
      const theta = pr * dphi;
      const xm = x * 1e3, ym = y * 1e3; // tool deflection [mm]
      let Fx = 0, Fy = 0, Fz = 0, T = 0, Fr2z = 0, Fsum = 0;
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
          const Ft = Ktc * h * db + Kte * db;
          const Fr = Krc * h * db + Kre * db;
          const Fa = Kac * h * db + Kae * db;
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
      const ax = (Fx - c * vxs - kSI * x) / m;
      const ay = (Fy - c * vys - kSI * y) / m;
      vxs += ax * dt; vys += ay * dt;
      x += vxs * dt; y += vys * dt;
      if (++pr === stepsPerRev) pr = 0;
      if (pr % stepsPerTooth === 0) {
        ts.x[ts.i] = x; ts.y[ts.i] = y; ts.i = (ts.i + 1) % ts.n; ts.count++;
      }
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
        hist.Fx[j] = Fx; hist.Fy[j] = Fy; hist.Fz[j] = Fz; hist.x[j] = x * 1e6; hist.y[j] = y * 1e6;
        hist.i = (j + 1) % hist.n; hist.count++;
      }
    }
    this.x = x; this.y = y; this.vx = vxs; this.vy = vys; this.t = t; this.pr = pr;
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
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, sumZc: 0, wZc: 0 };
}
