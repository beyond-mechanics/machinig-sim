import { LUT_DR } from './assembly.js';

// Workpiece as a Z-heightfield (single-direction dexel model). Exact for 3-axis machining
// with vertical tools because no undercut can be produced.

const EDGE_TIE = 2 * 0.0015; // R² − r² below this × R: within 1.5 µm of the cutter edge

export class Stock {
  constructor(w, l, h, cell = 0.3) {
    this.x0 = 0; this.y0 = 0; this.w = w; this.l = l;
    this.zTop = 0; this.zBottom = -h;
    this.nx = Math.round(w / cell) + 1;
    this.ny = Math.round(l / cell) + 1;
    this.hx = w / (this.nx - 1);
    this.hy = l / (this.ny - 1);
    this.H = new Float32Array(this.nx * this.ny).fill(this.zTop);
    this.err = new Float32Array(this.nx * this.ny);   // vibration at the moment of cutting [µm]
    this.wallErr = new Float32Array(this.nx * this.ny); // workpiece (wall) deflection at the moment of cutting [µm]
    // feed marks on the floor: phase position [mm] of the trailing-edge arc through each cell and
    // the mark spacing [mm] (0 = no mark). Marks are the arcs that the cutter's trailing edge
    // leaves once per revolution (radial runout makes one tooth dominate), feed/rev apart.
    this.markS = new Float32Array(this.nx * this.ny);
    this.markF = new Float32Array(this.nx * this.ny);
    // where the machined wall next to a standing cell is, below the grid resolution: distance
    // [mm] from the cell centre to the closest cutter edge that passed it (Infinity: none).
    // Comparing it between the simulated and the commanded cut gives µm-level wall errors.
    this.wallD = new Float32Array(this.nx * this.ny).fill(Infinity);
    // program line that last cut each cell, and the one that set its wall distance (0 = none)
    this.lineCut = new Int32Array(this.nx * this.ny);
    this.lineWall = new Int32Array(this.nx * this.ny);
    this.curLine = 0;
    this.removed = 0;
    // block maxima for interference queries; stamping only lowers heights, so a block is
    // recomputed lazily the next time a query needs it
    this.B = 8;
    this.bnx = Math.ceil(this.nx / this.B); this.bny = Math.ceil(this.ny / this.B);
    this.bmax = new Float32Array(this.bnx * this.bny);
    this.bdirty = new Uint8Array(this.bnx * this.bny).fill(1);
    this.clearDirty();
  }
  markBlocks(i0, j0, i1, j1) {
    const B = this.B;
    for (let bj = (j0 / B) | 0; bj <= ((j1 / B) | 0); bj++) for (let bi = (i0 / B) | 0; bi <= ((i1 / B) | 0); bi++) this.bdirty[bj * this.bnx + bi] = 1;
  }
  blockMax(bi, bj) {
    const k = bj * this.bnx + bi;
    if (this.bdirty[k]) {
      const B = this.B, H = this.H, n = this.nx;
      let m = -Infinity;
      for (let j = bj * B; j < Math.min(this.ny, bj * B + B); j++) for (let i = bi * B; i < Math.min(n, bi * B + B); i++) if (H[j * n + i] > m) m = H[j * n + i];
      this.bmax[k] = m; this.bdirty[k] = 0;
    }
    return this.bmax[k];
  }
  // highest material inside the circle (cx, cy, r) and where it is; -Infinity if none.
  // Blocks entirely inside the circle answer from their maxima, edge blocks cell by cell.
  maxInDisk(cx, cy, r, above = -Infinity) {
    const B = this.B, hx = this.hx, hy = this.hy, H = this.H, n = this.nx;
    const i0 = Math.max(0, Math.floor((cx - r) / hx)), i1 = Math.min(this.nx - 1, Math.ceil((cx + r) / hx));
    const j0 = Math.max(0, Math.floor((cy - r) / hy)), j1 = Math.min(this.ny - 1, Math.ceil((cy + r) / hy));
    let best = -Infinity, bx = 0, by = 0;
    if (i0 > i1 || j0 > j1) return { h: best, x: bx, y: by };
    const r2 = r * r;
    for (let bj = (j0 / B) | 0; bj <= ((j1 / B) | 0); bj++) for (let bi = (i0 / B) | 0; bi <= ((i1 / B) | 0); bi++) {
      const m = this.blockMax(bi, bj);
      if (m <= Math.max(best, above)) continue;
      // farthest corner inside the circle → the whole block counts
      const xa = bi * B * hx - cx, xb = Math.min(n - 1, bi * B + B - 1) * hx - cx;
      const ya = bj * B * hy - cy, yb = Math.min(this.ny - 1, bj * B + B - 1) * hy - cy;
      const far = Math.max(xa * xa, xb * xb) + Math.max(ya * ya, yb * yb);
      if (far <= r2) { best = m; bx = cx + (xa + xb) / 2; by = cy + (ya + yb) / 2; continue; }
      for (let j = Math.max(j0, bj * B); j <= Math.min(j1, bj * B + B - 1); j++) {
        const dy = j * hy - cy;
        for (let i = Math.max(i0, bi * B); i <= Math.min(i1, bi * B + B - 1); i++) {
          const dx = i * hx - cx, h = H[j * n + i];
          if (h > best && dx * dx + dy * dy <= r2) { best = h; bx = i * hx; by = j * hy; }
        }
      }
    }
    return { h: best, x: bx, y: by };
  }
  clearDirty() { this.dirty = { i0: Infinity, j0: Infinity, i1: -1, j1: -1 }; }
  inside(x, y) { return x >= 0 && y >= 0 && x <= this.w && y <= this.l; }
  // bilinear sample; outside the stock returns -Infinity (no material)
  sample(x, y) {
    const fx = x / this.hx, fy = y / this.hy;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return -Infinity;
    const i = Math.min(this.nx - 2, fx | 0), j = Math.min(this.ny - 2, fy | 0);
    const tx = fx - i, ty = fy - j, n = this.nx, H = this.H;
    const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  // floor height for particles: stock height or the machine table outside it
  floor(x, y) {
    const s = this.sample(x, y);
    return s === -Infinity ? this.zBottom : s;
  }
  // record a value on the wall surface just outside the cutter, on the side facing (nx, ny):
  // lateral wall offsets are far below the grid size, so they are shown as a map instead
  markWall(cx, cy, R, nx, ny, val) {
    const w = 2 * Math.max(this.hx, this.hy), Ro = R + w;
    const i0 = Math.max(0, Math.floor((cx - Ro) / this.hx)), i1 = Math.min(this.nx - 1, Math.ceil((cx + Ro) / this.hx));
    const j0 = Math.max(0, Math.floor((cy - Ro) / this.hy)), j1 = Math.min(this.ny - 1, Math.ceil((cy + Ro) / this.hy));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = i * this.hx - cx, dy = j * this.hy - cy, r = Math.hypot(dx, dy);
      if (r <= R || r > Ro || (dx * nx + dy * ny) < 0.5 * r) continue;
      this.wallErr[j * this.nx + i] = val;
    }
    if (i0 <= i1 && j0 <= j1) {
      const d = this.dirty;
      d.i0 = Math.min(d.i0, i0); d.j0 = Math.min(d.j0, j0); d.i1 = Math.max(d.i1, i1); d.j1 = Math.max(d.j1, j1);
    }
  }
  // remove material under the tool. type 'flat' | 'ball'. Returns removed volume [mm³].
  // mark: {ux, uy, f} feed direction and feed per revolution for the floor marks
  // lut: optional height of the cutter surface above the tip by radius (step LUT_DR), for
  // corner-radius and imported tool shapes
  stamp(cx, cy, tipZ, R, type, errVal, mark = null, lut = null) {
    if (tipZ >= this.zTop) return 0;
    // walls up to two cells outside the cutter record how close its edge came
    const Rw = R + 2 * Math.max(this.hx, this.hy), Rw2 = Rw * Rw;
    const i0 = Math.max(0, Math.floor((cx - Rw) / this.hx)), i1 = Math.min(this.nx - 1, Math.ceil((cx + Rw) / this.hx));
    const j0 = Math.max(0, Math.floor((cy - Rw) / this.hy)), j1 = Math.min(this.ny - 1, Math.ceil((cy + Rw) / this.hy));
    if (i0 > i1 || j0 > j1) return 0;
    const H = this.H, E = this.err, n = this.nx, R2 = R * R, MS = this.markS, MF = this.markF, WD = this.wallD, LC = this.lineCut, LW = this.lineWall, line = this.curLine;
    const mf = mark && mark.f > 0 && type === 'flat' && !lut ? mark.f : 0;
    // height of the cutter edge at its rim: a cell outside the rim standing higher is a wall
    const zRim = tipZ + (lut ? lut[lut.length - 1] : type === 'ball' ? R : 0);
    let vol = 0, touched = false;
    for (let j = j0; j <= j1; j++) {
      const dy = j * this.hy - cy;
      for (let i = i0; i <= i1; i++) {
        const dx = i * this.hx - cx;
        const r2 = dx * dx + dy * dy;
        const k = j * n + i;
        // a node on the cutter edge stays, within the chord error of arcs (gcode.js CHORD_TOL):
        // the same tie the target keeps on its boundary
        if (r2 >= R2 - EDGE_TIE * R) {
          if (r2 <= Rw2 && H[k] > zRim) {
            const d = Math.sqrt(r2) - R;
            if (d < WD[k]) { WD[k] = d; LW[k] = line; touched = true; }
          }
          continue;
        }
        const z = lut ? tipZ + lut[Math.min(lut.length - 1, Math.round(Math.sqrt(r2) / LUT_DR))] : type === 'ball' ? tipZ + R - Math.sqrt(R2 - r2) : tipZ;
        if (H[k] > z) { vol += H[k] - z; H[k] = Math.max(z, this.zBottom); E[k] = errVal; WD[k] = Infinity; LC[k] = line; touched = true; }
        // the last pass over a floor at this depth leaves its trailing-edge arcs
        if (mf && H[k] > z - 0.002) {
          const xs = i * this.hx, ys = j * this.hy, p = -dx * mark.uy + dy * mark.ux;
          MS[k] = xs * mark.ux + ys * mark.uy + Math.sqrt(Math.max(0, R2 - p * p)); MF[k] = mf; touched = true;
        }
      }
    }
    if (touched) {
      const d = this.dirty;
      d.i0 = Math.min(d.i0, i0); d.j0 = Math.min(d.j0, j0); d.i1 = Math.max(d.i1, i1); d.j1 = Math.max(d.j1, j1);
      this.markBlocks(i0, j0, i1, j1);
    }
    vol *= this.hx * this.hy;
    this.removed += vol;
    return vol;
  }
}
