// Continuous surface of the 3D particles (as the 2D field picture, one dimension up): each
// particle spreads its value with the kernel w = (1 − r²/R²)² onto a grid of cell dx/2, and the
// body is the level set where the kernel sum is 0.45 of its interior value, extracted with naive
// surface nets (one vertex per cube that the surface crosses, at the mean of the edge crossings;
// one quad per crossed grid edge). Each vertex carries the field value u ∈ [0, 1] and a shade
// (darker where the particles are held), so the view can colour it with bands or a smooth map.

// Interior kernel sum on a lattice of spacing dx: ∫ w dV / dx³ = 32πR³ / (105 dx³).
const kernelSum = (R, dx) => 32 * Math.PI * R * R * R / (105 * dx * dx * dx);

// f: frame (x, y, z, flag, dx); sel: particle indices; vals: field values. Returns null when the
// grid would be too large.
export function surfaceNets(f, sel, vals, lo, hi, maxCells = 6e6) {
  const dx = f.dx, R = 1.6 * dx, c = 0.5 * dx, rc = Math.ceil(R / c), iR2 = 1 / (R * R);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const i of sel) {
    const px = f.x[i], py = f.y[i], pz = f.z[i];
    if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
  }
  if (!sel.length) return null;
  const pad = R + 2 * c;
  x0 -= pad; y0 -= pad; z0 -= pad;
  const nx = Math.ceil((x1 + pad - x0) / c) + 1, ny = Math.ceil((y1 + pad - y0) / c) + 1, nz = Math.ceil((z1 + pad - z0) / c) + 1;
  if (nx * ny * nz > maxCells) return null;
  const nxy = nx * ny, n = nxy * nz;
  const S = new Float32Array(n), Sv = new Float32Array(n), Sf = new Float32Array(n);
  const inv = 1 / (hi - lo);
  for (const i of sel) {
    const px = f.x[i], py = f.y[i], pz = f.z[i], gi = Math.round((px - x0) / c), gj = Math.round((py - y0) / c), gk = Math.round((pz - z0) / c);
    let u = (vals[i] - lo) * inv; u = u < 0 ? 0 : u > 1 ? 1 : u;
    const held = f.flag[i] === 1;
    for (let k = gk - rc; k <= gk + rc; k++) {
      const dz = z0 + k * c - pz, dz2 = dz * dz;
      if (dz2 >= R * R) continue;
      for (let j = gj - rc; j <= gj + rc; j++) {
        const dy = y0 + j * c - py, d2 = dz2 + dy * dy;
        if (d2 >= R * R) continue;
        const row = j * nx + k * nxy;
        for (let ii = gi - rc; ii <= gi + rc; ii++) {
          const ddx = x0 + ii * c - px, q = 1 - (d2 + ddx * ddx) * iR2;
          if (q <= 0) continue;
          const w = q * q, a = row + ii;
          S[a] += w; Sv[a] += w * u; if (held) Sf[a] += w;
        }
      }
    }
  }
  const iso = 0.45 * kernelSum(R, dx);
  // One vertex per crossed cube (indexed by its lower corner node).
  const vid = new Int32Array(n).fill(-1), pos = [], uv = [], col = [], nrm = [];
  const corner = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];
  const cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = i + j * nx + k * nxy;
    let mask = 0;
    for (let q = 0; q < 8; q++) if (S[a + corner[q]] > iso) mask |= 1 << q;
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [p, q] of EDGES) {
      const ip = (mask >> p) & 1, iq = (mask >> q) & 1;
      if (ip === iq) continue;
      const vp = S[a + corner[p]], vq = S[a + corner[q]], t = (iso - vp) / (vq - vp);
      sx += cx[p] + t * (cx[q] - cx[p]); sy += cy[p] + t * (cy[q] - cy[p]); sz += cz[p] + t * (cz[q] - cz[p]); cnt++;
    }
    const fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
    // Field value and shade at the vertex: trilinear in the cube.
    // Normal: down the gradient of the kernel sum (trilinear in the cube). Normals averaged over
    // faces go wrong on chips only a few particles thick, where both sides share vertices.
    let w = 0, wv = 0, wf = 0, gx = 0, gy = 0, gz = 0;
    for (let q = 0; q < 8; q++) {
      const ax = cx[q] ? fx : 1 - fx, ay = cy[q] ? fy : 1 - fy, az = cz[q] ? fz : 1 - fz, b = ax * ay * az, m = a + corner[q], v = S[m];
      w += b * v; wv += b * Sv[m]; wf += b * Sf[m];
      gx += (cx[q] ? 1 : -1) * ay * az * v; gy += (cy[q] ? 1 : -1) * ax * az * v; gz += (cz[q] ? 1 : -1) * ax * ay * v;
    }
    const gl = Math.hypot(gx, gy, gz) || 1;
    nrm.push(-gx / gl, -gy / gl, -gz / gl);
    vid[a] = pos.length / 3;
    pos.push(x0 + (i + fx) * c, y0 + (j + fy) * c, z0 + (k + fz) * c);
    uv.push(w > 0 ? wv / w : 0, 0.5);
    const sh = w > 0 && wf / w > 0.5 ? 0.6 : 1;
    col.push(sh, sh, sh);
  }
  // One quad per crossed grid edge, between the four cubes around it; outward = towards the
  // node outside the body.
  const idx = [];
  const quad = (q0, q1, q2, q3, flip) => {
    const A = vid[q0], B = vid[q1], C = vid[q2], D = vid[q3];
    if (A < 0 || B < 0 || C < 0 || D < 0) return;
    if (flip) idx.push(A, C, B, A, D, C); else idx.push(A, B, C, A, C, D);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = i + j * nx + k * nxy, in0 = S[a] > iso;
    // x edge (a, a+1): cubes in the (y, z) plane.
    if (in0 !== (S[a + 1] > iso)) quad(a - nx - nxy, a - nxy, a, a - nx, !in0);
    // y edge (a, a+nx): cubes in the (z, x) plane.
    if (in0 !== (S[a + nx] > iso)) quad(a - nxy - 1, a - 1, a, a - nxy, !in0);
    // z edge (a, a+nxy): cubes in the (x, y) plane.
    if (in0 !== (S[a + nxy] > iso)) quad(a - 1 - nx, a - nx, a, a - 1, !in0);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), col: new Float32Array(col), idx: new Uint32Array(idx) };
}
