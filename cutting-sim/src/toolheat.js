// Tool temperature field and wear. A finite-difference grid in the tool's local frame (so it
// rotates with an end-mill tooth) covers the cutting edge out to Lb; cells cut by the far box
// edges are held at T0 as the heat sink of the tool body. Heat enters at the contact cells:
//  - the tool's share of frictional heat,
//  - conduction across the interface, q = hc·Lc·(T_chip − T_tool) per contact particle.
// Two results:
//  - transient: the explicit field during the simulated cut (only µs to ms of contact, so the
//    tool is still heating up),
//  - steady: the tool field the time-averaged contact (pressure, slip, chip-side temperature,
//    friction heat) would reach after long cutting, solved with a Robin interface condition.
// Wear: Usui rate dW/dt = Aw·σn·Vs·exp(−Bw/T) per surface cell from the time-averaged contact.
import { localSdf, arcPos } from './tool.js';

export class ToolHeat {
  constructor(tool, tmat, { cell, Lb, T0, hc }) {
    this.tool = tool; this.tmat = tmat; this.T0 = T0; this.hc = hc; this.a = cell;
    this.u0 = -Lb; this.w0 = tool.wmin - 2 * cell;
    const nu = this.nu = Math.ceil((tool.umax + 2 * cell - this.u0) / cell);
    const nw = this.nw = Math.ceil((Lb - this.w0) / cell);
    const n = nu * nw, o = new Float64Array(5);
    this.inside = new Uint8Array(n); this.dir = new Uint8Array(n);
    this.T = new Float64Array(n).fill(T0); this.dT = new Float64Array(n);
    for (let j = 0; j < nw; j++) for (let i = 0; i < nu; i++) {
      const k = i + j * nu, u = this.u0 + (i + 0.5) * cell, w = this.w0 + (j + 0.5) * cell;
      if (localSdf(tool, u, w, o) < 0) {
        this.inside[k] = 1;
        if (i === 0 || j === nw - 1) this.dir[k] = 1;      // heat-sink boundary of the tool body
      }
    }
    // A profile smaller than the box (a whole insert outline) has no cells on the box edges:
    // hold its far part at T0 instead (the seat and clamp take the heat away).
    if (!this.dir.some((v) => v)) for (let j = 0; j < nw; j++) for (let i = 0; i < nu; i++) {
      const k = i + j * nu, u = this.u0 + (i + 0.5) * cell, w = this.w0 + (j + 0.5) * cell;
      if (this.inside[k] && Math.hypot(u, w - tool.wmin) > 0.75 * Lb) this.dir[k] = 1;
    }
    // Surface cells: inside, free (not sink) and next to the outside.
    const surf = [];
    for (let j = 0; j < nw; j++) for (let i = 0; i < nu; i++) {
      const k = i + j * nu;
      if (!this.inside[k] || this.dir[k]) continue;
      const out = (ii, jj) => ii < 0 || jj < 0 || ii >= nu || jj >= nw || !this.inside[ii + jj * nu];
      if (out(i - 1, j) || out(i + 1, j) || out(i, j - 1) || out(i, j + 1)) surf.push(k);
    }
    this.surf = Int32Array.from(surf);
    const ns = surf.length;
    // Arc position along the surface: + up the rake face, − back along the flank, 0 at the edge.
    this.s = new Float64Array(ns);
    for (let q = 0; q < ns; q++) {
      const k = surf[q], u = this.u0 + (k % nu + 0.5) * cell, w = this.w0 + (Math.floor(k / nu) + 0.5) * cell;
      this.s[q] = arcPos(tool, u, w, o);
    }
    // Nearest surface cell for every grid cell (contact points land outside the tool).
    this.near = new Int32Array(n);
    const sx = new Float64Array(ns), sy = new Float64Array(ns);
    for (let q = 0; q < ns; q++) { sx[q] = surf[q] % nu; sy[q] = Math.floor(surf[q] / nu); }
    for (let k = 0; k < n; k++) {
      const i = k % nu, j = Math.floor(k / nu);
      let best = 0, bd = Infinity;
      for (let q = 0; q < ns; q++) { const d = (sx[q] - i) ** 2 + (sy[q] - j) ** 2; if (d < bd) { bd = d; best = q; } }
      this.near[k] = best;
    }
    // Per-surface-cell accumulators (time integrals over the averaging window).
    const z = () => new Float64Array(ns);
    this.aQ = z(); this.aQin = z(); this.aH = z(); this.aHT = z(); this.aFn = z(); this.aFV = z(); this.aTime = 0;
    this.cap = tmat.rho * tmat.c * cell * cell;              // heat capacity per cell per unit width
    this.steadyT = null;
  }

  // Surface cell index (into surf) nearest to a point given in local coordinates.
  cellOf(u, w) {
    let i = Math.floor((u - this.u0) / this.a), j = Math.floor((w - this.w0) / this.a);
    i = i < 0 ? 0 : i >= this.nu ? this.nu - 1 : i;
    j = j < 0 ? 0 : j >= this.nw ? this.nw - 1 : j;
    return this.near[i + j * this.nu];
  }

  // Interface exchange for one contact particle over dt. Returns heat [J/m] taken from the chip.
  contact(q, Tp, Lc, qFric, Fn, vs, dt, acc) {
    const k = this.surf[q], H = this.hc * Lc;
    const qc = H * (Tp - this.T[k]) * dt;
    this.T[k] += (qc + qFric) / this.cap;
    if (acc) {
      this.aQ[q] += qFric; this.aQin[q] += qc + qFric; this.aH[q] += H * dt; this.aHT[q] += H * Tp * dt;
      this.aFn[q] += Fn * dt; this.aFV[q] += Fn * vs * dt;
    }
    return qc;
  }

  // Explicit conduction inside the tool (stable for α·dt/a² ≤ 1/4, far above the SPH step).
  step(dt) {
    const { nu, nw, inside, dir, T, dT } = this, f = this.tmat.k / (this.tmat.rho * this.tmat.c) * dt / (this.a * this.a);
    dT.fill(0);
    for (let j = 0; j < nw; j++) for (let i = 0; i < nu; i++) {
      const k = i + j * nu;
      if (!inside[k] || dir[k]) continue;
      let s = 0;
      if (i > 0 && inside[k - 1]) s += T[k - 1] - T[k];
      if (i < nu - 1 && inside[k + 1]) s += T[k + 1] - T[k];
      if (j > 0 && inside[k - nu]) s += T[k - nu] - T[k];
      if (j < nw - 1 && inside[k + nu]) s += T[k + nu] - T[k];
      dT[k] = f * s;
    }
    for (let k = 0; k < T.length; k++) T[k] += dT[k];
  }

  maxT(arr = this.T) {
    let m = -Infinity;
    for (let k = 0; k < arr.length; k++) if (this.inside[k] && arr[k] > m) m = arr[k];
    return m;
  }

  // Steady tool temperature for the time-averaged interface (Gauss-Seidel with SOR), kept for the
  // wear estimate. With period (a milling tooth heated once a turn): the mean field of the
  // periodic steady state, from the heat that actually entered each cell spread over the period.
  // (Averaging the interface conductance instead would be wrong there: with hc this large the
  // tool would creep up to the chip temperature at any duty, while really the surface touches
  // the chip only briefly and the heat it takes in is what the contact gave.)
  steady(period) {
    const { nu, nw, inside, dir, surf, aTime } = this, kt = this.tmat.k;
    if (!(aTime > 0)) return null;
    const n = nu * nw, T = Float64Array.from(this.T), F = new Float64Array(n), H = new Float64Array(n), HT = new Float64Array(n);
    for (let q = 0; q < surf.length; q++) {
      const k = surf[q];
      if (period) F[k] += this.aQin[q] / period;
      else { F[k] += this.aQ[q] / aTime; H[k] += this.aH[q] / aTime; HT[k] += this.aHT[q] / aTime; }
    }
    for (let k = 0; k < n; k++) if (dir[k]) T[k] = this.T0;
    for (let it = 0; it < 4000; it++) {
      let change = 0;
      for (let j = 0; j < nw; j++) for (let i = 0; i < nu; i++) {
        const k = i + j * nu;
        if (!inside[k] || dir[k]) continue;
        let s = 0, c = 0;
        if (i > 0 && inside[k - 1]) { s += T[k - 1]; c++; }
        if (i < nu - 1 && inside[k + 1]) { s += T[k + 1]; c++; }
        if (j > 0 && inside[k - nu]) { s += T[k - nu]; c++; }
        if (j < nw - 1 && inside[k + nu]) { s += T[k + nu]; c++; }
        const tn = (kt * s + F[k] + HT[k]) / (kt * c + H[k]);
        const d = 1.9 * (tn - T[k]);
        T[k] += d; if (Math.abs(d) > change) change = Math.abs(d);
      }
      if (change < 1e-3) break;
    }
    if (!period) this.steadyT = T;
    return T;
  }

  // Profiles along the tool surface (sorted by arc position): temperatures, pressure, wear rate.
  profile() {
    const { surf, aTime, a } = this, Tst = this.steadyT, tm = this.tmat;
    const rows = [];
    for (let q = 0; q < surf.length; q++) {
      const k = surf[q];
      const p = aTime > 0 ? this.aFn[q] / aTime / a : 0;           // mean normal pressure [Pa]
      const pv = aTime > 0 ? this.aFV[q] / aTime / a : 0;          // mean pressure × slip [Pa·m/s]
      const Tw = Tst ? Tst[k] : this.T[k];
      const wear = tm.Aw * pv * Math.exp(-tm.Bw / (Tw + 273.15)) * 6e7;   // µm/min
      rows.push({ s: this.s[q] * 1e6, T: this.T[k], Tst: Tst ? Tst[k] : null, p: p * 1e-6, wear });
    }
    rows.sort((x, y) => x.s - y.s);
    // Merge cells at the same arc position (two layers at a corner) by keeping the hotter one.
    const outRows = [];
    for (const r of rows) {
      const last = outRows[outRows.length - 1];
      if (last && Math.abs(last.s - r.s) < 0.3 * a * 1e6) { if (r.wear > last.wear) last.wear = r.wear; if (r.p > last.p) last.p = r.p; if ((r.Tst ?? r.T) > (last.Tst ?? last.T)) { last.T = r.T; last.Tst = r.Tst; } }
      else outRows.push({ ...r });
    }
    // Three-cell moving average of pressure and wear: single cells at the edge corner are noisy.
    const sm = outRows.map((r, i) => {
      const a = outRows[Math.max(0, i - 1)], b = outRows[Math.min(outRows.length - 1, i + 1)];
      return { ...r, p: (a.p + r.p + b.p) / 3, wear: (a.wear + r.wear + b.wear) / 3 };
    });
    return sm;
  }
}
