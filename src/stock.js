// Workpiece as a Z-heightfield (single-direction dexel model). Exact for 3-axis machining
// with vertical tools because no undercut can be produced.

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
    this.removed = 0;
    this.clearDirty();
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
  stamp(cx, cy, tipZ, R, type, errVal, mark = null) {
    if (tipZ >= this.zTop) return 0;
    const i0 = Math.max(0, Math.floor((cx - R) / this.hx)), i1 = Math.min(this.nx - 1, Math.ceil((cx + R) / this.hx));
    const j0 = Math.max(0, Math.floor((cy - R) / this.hy)), j1 = Math.min(this.ny - 1, Math.ceil((cy + R) / this.hy));
    if (i0 > i1 || j0 > j1) return 0;
    const H = this.H, E = this.err, n = this.nx, R2 = R * R, MS = this.markS, MF = this.markF;
    const mf = mark && mark.f > 0 && type === 'flat' ? mark.f : 0;
    let vol = 0, touched = false;
    for (let j = j0; j <= j1; j++) {
      const dy = j * this.hy - cy;
      for (let i = i0; i <= i1; i++) {
        const dx = i * this.hx - cx;
        const r2 = dx * dx + dy * dy;
        if (r2 > R2) continue;
        const z = type === 'ball' ? tipZ + R - Math.sqrt(R2 - r2) : tipZ;
        const k = j * n + i;
        if (H[k] > z) { vol += H[k] - z; H[k] = Math.max(z, this.zBottom); E[k] = errVal; touched = true; }
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
    }
    vol *= this.hx * this.hy;
    this.removed += vol;
    return vol;
  }
}
