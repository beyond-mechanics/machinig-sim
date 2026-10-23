// Triangle meshes for the 3D import mode: STL reading, a signed distance field of the tool
// (exact distances from a BVH, sign from angle-weighted pseudonormals, Bærentzen & Aanæs 2005,
// sampled lazily in small bricks and interpolated trilinearly), and filling a closed workpiece
// mesh with particles (ray parity along x).

// STL, binary or ASCII → Float64Array of triangles (9 numbers each), in the file's units × scale.
export function parseSTL(buf, scale = 1) {
  const u8 = new Uint8Array(buf);
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 512))).trimStart();
  const nb = u8.length >= 84 ? new DataView(buf).getUint32(80, true) : -1;
  const binary = u8.length >= 84 && 84 + 50 * nb === u8.length;
  let t;
  if (binary || !head.startsWith('solid')) {
    if (!(84 + 50 * nb <= u8.length)) throw new Error('STL を読めませんでした（バイナリの長さが合いません）。');
    const dv = new DataView(buf);
    t = new Float64Array(9 * nb);
    for (let i = 0; i < nb; i++) for (let k = 0; k < 9; k++) t[9 * i + k] = dv.getFloat32(84 + 50 * i + 12 + 4 * k, true) * scale;
  } else {
    const text = new TextDecoder().decode(u8), v = [];
    for (const m of text.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)) v.push(+m[1] * scale, +m[2] * scale, +m[3] * scale);
    if (v.length % 9) throw new Error('STL の頂点の数が 3 の倍数ではありません。');
    t = Float64Array.from(v);
  }
  if (!t.length) throw new Error('STL に三角形がありません。');
  for (let i = 0; i < t.length; i++) if (!Number.isFinite(t[i])) throw new Error('STL に数値でない座標があります。');
  return t;
}

export function bounds(t) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], t[i + k]); b[3 + k] = Math.max(b[3 + k], t[i + k]); }
  return b;
}

// Signed volume (divergence theorem): > 0 for an outward-oriented closed mesh.
export function volume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(i, i + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

// Outward orientation (a mesh with negative volume is turned inside out). Returns a new array.
export function orient(t) {
  const o = Float64Array.from(t);
  if (volume(t) >= 0) return o;
  for (let i = 0; i < o.length; i += 9) for (let k = 0; k < 3; k++) { const a = o[i + 3 + k]; o[i + 3 + k] = o[i + 6 + k]; o[i + 6 + k] = a; }
  return o;
}

// Largest distance of the mesh surface from the vertical axis through (ax, ay), per height bin
// of size dz from z0: the envelope a spinning tool sweeps. Triangles are sampled finer than dz.
export function radialEnvelope(t, ax, ay, z0, dz, nb) {
  const env = new Float64Array(nb).fill(-1);
  const put = (x, y, z) => { const k = Math.floor((z - z0) / dz); if (k >= 0 && k < nb) env[k] = Math.max(env[k], Math.hypot(x - ax, y - ay)); };
  for (let i = 0; i < t.length; i += 9) {
    const L = Math.max(Math.hypot(t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]), Math.hypot(t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]), Math.hypot(t[i + 6] - t[i + 3], t[i + 7] - t[i + 4], t[i + 8] - t[i + 5]));
    const n = Math.min(200, Math.max(1, Math.ceil(L / (0.5 * dz))));
    for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) {
      const u = a / n, v = b / n, w = 1 - u - v;
      put(w * t[i] + u * t[i + 3] + v * t[i + 6], w * t[i + 1] + u * t[i + 4] + v * t[i + 7], w * t[i + 2] + u * t[i + 5] + v * t[i + 8]);
    }
  }
  return env;
}

// Closedness check: every edge shared by exactly two triangles (after welding vertices).
export function weld(t) {
  const b = bounds(t), size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1, q = 1e-7 * size;
  const map = new Map(), V = [], F = new Int32Array(t.length / 3);
  for (let i = 0; i < t.length; i += 3) {
    const key = `${Math.round(t[i] / q)},${Math.round(t[i + 1] / q)},${Math.round(t[i + 2] / q)}`;
    let id = map.get(key);
    if (id === undefined) { id = V.length / 3; V.push(t[i], t[i + 1], t[i + 2]); map.set(key, id); }
    F[i / 3] = id;
  }
  const edges = new Map();
  let degenerate = 0;
  for (let f = 0; f < F.length / 3; f++) {
    const a = F[3 * f], bb = F[3 * f + 1], c = F[3 * f + 2];
    if (a === bb || bb === c || a === c) { degenerate++; continue; }
    for (const [p, r] of [[a, bb], [bb, c], [c, a]]) { const k = p < r ? `${p}_${r}` : `${r}_${p}`; edges.set(k, (edges.get(k) || 0) + 1); }
  }
  let open = 0;
  for (const n of edges.values()) if (n !== 2) open++;
  return { V: Float64Array.from(V), F, open, degenerate };
}

// ---- Signed distance field of a closed mesh ----
export class MeshSDF {
  // tris [m]; cell: sampling step of the bricks [m]; far: distance returned well outside.
  constructor(tris, cell) {
    tris = orient(tris);
    const { V, F } = weld(tris);
    this.V = V; this.F = F; this.nf = F.length / 3; this.cell = cell; this.B = 8;
    this.bb = bounds(tris);
    this.bricks = new Map(); this.nodes = 0;
    this.normals();
    this.buildBVH();
    this.q = new Float64Array(4);
  }
  // Face normals, angle-weighted vertex normals and edge normals (sum of the two faces).
  normals() {
    const { V, F, nf } = this;
    const fn = this.fn = new Float64Array(3 * nf), vn = this.vn = new Float64Array(V.length), en = this.en = new Map();
    for (let f = 0; f < nf; f++) {
      const ia = 3 * F[3 * f], ib = 3 * F[3 * f + 1], ic = 3 * F[3 * f + 2];
      const ux = V[ib] - V[ia], uy = V[ib + 1] - V[ia + 1], uz = V[ib + 2] - V[ia + 2], wx = V[ic] - V[ia], wy = V[ic + 1] - V[ia + 1], wz = V[ic + 2] - V[ia + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz;
      const ids = [F[3 * f], F[3 * f + 1], F[3 * f + 2]];
      for (let k = 0; k < 3; k++) {
        const p = 3 * ids[k], a = 3 * ids[(k + 1) % 3], c = 3 * ids[(k + 2) % 3];
        const e1x = V[a] - V[p], e1y = V[a + 1] - V[p + 1], e1z = V[a + 2] - V[p + 2], e2x = V[c] - V[p], e2y = V[c + 1] - V[p + 1], e2z = V[c + 2] - V[p + 2];
        const cs = (e1x * e2x + e1y * e2y + e1z * e2z) / ((Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z)) || 1);
        const ang = Math.acos(Math.max(-1, Math.min(1, cs)));
        vn[p] += ang * nx; vn[p + 1] += ang * ny; vn[p + 2] += ang * nz;
        const i0 = ids[k], i1 = ids[(k + 1) % 3], key = i0 < i1 ? i0 * 4294967296 + i1 : i1 * 4294967296 + i0;
        const e = en.get(key);
        if (e) { e[0] += nx; e[1] += ny; e[2] += nz; } else en.set(key, [nx, ny, nz]);
      }
    }
  }
  // Binary BVH over the faces (median split on the longest axis, leaves of up to 4 faces).
  buildBVH() {
    const { V, F, nf } = this, cen = new Float64Array(3 * nf), fb = new Float64Array(6 * nf);
    for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity;
      for (let v = 0; v < 3; v++) { const c = V[3 * F[3 * f + v] + k]; lo = Math.min(lo, c); hi = Math.max(hi, c); }
      fb[6 * f + k] = lo; fb[6 * f + 3 + k] = hi; cen[3 * f + k] = 0.5 * (lo + hi);
    }
    const order = new Int32Array(nf); for (let i = 0; i < nf; i++) order[i] = i;
    const nodes = [];   // [lo3, hi3, left, right, start, count]
    const build = (s, e) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) { const f = order[i]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], fb[6 * f + k]); hi[k] = Math.max(hi[k], fb[6 * f + 3 + k]); } }
      const id = nodes.length; nodes.push({ lo, hi, l: -1, r: -1, s, n: e - s });
      if (e - s <= 4) return id;
      const ax = hi[0] - lo[0] > hi[1] - lo[1] ? (hi[0] - lo[0] > hi[2] - lo[2] ? 0 : 2) : (hi[1] - lo[1] > hi[2] - lo[2] ? 1 : 2);
      const sub = Array.from(order.subarray(s, e)).sort((a, b) => cen[3 * a + ax] - cen[3 * b + ax]);
      order.set(sub, s);
      const m = (s + e) >> 1;
      nodes[id].l = build(s, m); nodes[id].r = build(m, e); nodes[id].n = 0;
      return id;
    };
    build(0, nf);
    this.order = order;
    const n = nodes.length;
    this.nb = new Float64Array(6 * n); this.nl = new Int32Array(n); this.nr = new Int32Array(n); this.ns = new Int32Array(n); this.nn = new Int32Array(n);
    nodes.forEach((d, i) => { for (let k = 0; k < 3; k++) { this.nb[6 * i + k] = d.lo[k]; this.nb[6 * i + 3 + k] = d.hi[k]; } this.nl[i] = d.l; this.nr[i] = d.r; this.ns[i] = d.s; this.nn[i] = d.n; });
    this.stack = new Int32Array(128);
  }
  // Exact signed distance at p; this.q = [d, nx, ny, nz] with n the outward direction.
  exact(px, py, pz) {
    const { nb, nl, nr, ns, nn, order, stack } = this;
    let best = Infinity, bf = -1, bfeat = 0, bqx = 0, bqy = 0, bqz = 0, sp = 0;
    stack[sp++] = 0;
    const box2 = (i) => {
      let d = 0;
      for (let k = 0; k < 3; k++) { const c = k === 0 ? px : k === 1 ? py : pz, lo = nb[6 * i + k], hi = nb[6 * i + 3 + k]; const e = c < lo ? lo - c : c > hi ? c - hi : 0; d += e * e; }
      return d;
    };
    const cp = this.cp || (this.cp = new Float64Array(4));
    while (sp) {
      const i = stack[--sp];
      if (box2(i) >= best) continue;
      if (nn[i]) {
        for (let k = ns[i]; k < ns[i] + nn[i]; k++) {
          const f = order[k], d2 = this.closest(f, px, py, pz, cp);
          if (d2 < best) { best = d2; bf = f; bfeat = cp[3]; bqx = cp[0]; bqy = cp[1]; bqz = cp[2]; }
        }
      } else {
        const a = nl[i], b = nr[i], da = box2(a), db = box2(b);
        if (da < db) { stack[sp++] = b; stack[sp++] = a; } else { stack[sp++] = a; stack[sp++] = b; }
      }
    }
    // Pseudonormal of the closest feature: face, edge (sum of its faces) or vertex (angle-weighted).
    const F = this.F, ids = [F[3 * bf], F[3 * bf + 1], F[3 * bf + 2]];
    let nx, ny, nz;
    if (bfeat === 0) { nx = this.fn[3 * bf]; ny = this.fn[3 * bf + 1]; nz = this.fn[3 * bf + 2]; }
    else if (bfeat <= 3) { const v = 3 * ids[bfeat - 1]; nx = this.vn[v]; ny = this.vn[v + 1]; nz = this.vn[v + 2]; }
    else { const a = ids[bfeat - 4], b = ids[(bfeat - 3) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a, e = this.en.get(key); nx = e[0]; ny = e[1]; nz = e[2]; }
    const rx = px - bqx, ry = py - bqy, rz = pz - bqz, d = Math.sqrt(best);
    const sg = rx * nx + ry * ny + rz * nz >= 0 ? 1 : -1, q = this.q;
    if (d > 1e-12) { q[1] = sg * rx / d; q[2] = sg * ry / d; q[3] = sg * rz / d; }
    else { const l = Math.hypot(nx, ny, nz) || 1; q[1] = nx / l; q[2] = ny / l; q[3] = nz / l; }
    q[0] = sg * d;
    return q[0];
  }
  // Closest point on face f to p (Ericson, Real-Time Collision Detection 5.1.5): out = [x, y, z,
  // feature] with feature 0 face, 1–3 vertex a/b/c, 4–6 edge ab/bc/ca; returns the squared distance.
  closest(f, px, py, pz, out) {
    const V = this.V, F = this.F, a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
    const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], cx = V[c], cy = V[c + 1], cz = V[c + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let qx, qy, qz, feat;
    if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; feat = 1; }
    else {
      const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; feat = 2; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; feat = 4; }
        else {
          const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; feat = 3; }
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; feat = 6; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz); feat = 5; }
              else { const dn = 1 / (va + vb + vc), v = vb * dn, w = vc * dn; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w; feat = 0; }
            }
          }
        }
      }
    }
    out[0] = qx; out[1] = qy; out[2] = qz; out[3] = feat;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }
  // Brick of (B+1)³ nodes [d, nx, ny, nz] with corner at integer brick index (i, j, k).
  brick(i, j, k) {
    const key = (i + 65536) * 17179869184 + (j + 65536) * 131072 + (k + 65536);
    let b = this.bricks.get(key);
    if (b) return b;
    const B = this.B, n = B + 1, c = this.cell;
    b = new Float32Array(4 * n * n * n);
    for (let c3 = 0; c3 < n; c3++) for (let c2 = 0; c2 < n; c2++) for (let c1 = 0; c1 < n; c1++) {
      const o = 4 * (c1 + n * (c2 + n * c3)), q = this.q;
      this.exact((i * B + c1) * c, (j * B + c2) * c, (k * B + c3) * c);
      b[o] = q[0]; b[o + 1] = q[1]; b[o + 2] = q[2]; b[o + 3] = q[3];
    }
    this.bricks.set(key, b); this.nodes += n * n * n;
    return b;
  }
  // Interpolated signed distance and normal at a point in the mesh frame: out = [d, nx, ny, nz].
  // Points farther than `far` outside the mesh's box get a plain box distance (no brick).
  sample(px, py, pz, far, out) {
    const bb = this.bb;
    const ex = Math.max(bb[0] - px, 0, px - bb[3]), ey = Math.max(bb[1] - py, 0, py - bb[4]), ez = Math.max(bb[2] - pz, 0, pz - bb[5]);
    const db = Math.hypot(ex, ey, ez);
    if (db > far) { out[0] = db; out[1] = 0; out[2] = 0; out[3] = 1; return db; }
    const c = this.cell, B = this.B, n = B + 1;
    const gx = px / c, gy = py / c, gz = pz / c, ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const bi = Math.floor(ix / B), bj = Math.floor(iy / B), bk = Math.floor(iz / B);
    const b = this.brick(bi, bj, bk), lx = ix - bi * B, ly = iy - bj * B, lz = iz - bk * B;
    const fx = gx - ix, fy = gy - iy, fz = gz - iz;
    let d = 0, nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 8; k++) {
      const ox = k & 1, oy = (k >> 1) & 1, oz = k >> 2, w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
      const o = 4 * ((lx + ox) + n * ((ly + oy) + n * (lz + oz)));
      d += w * b[o]; nx += w * b[o + 1]; ny += w * b[o + 2]; nz += w * b[o + 3];
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = d; out[1] = nx / l; out[2] = ny / l; out[3] = nz / l;
    return d;
  }
}

// Lattice points (spacing dx, cell centres) inside a closed mesh: ray parity along +x for every
// (y, z) row. box [x0, y0, z0, x1, y1, z1] keeps only the points in it (the lattice stays that of
// the whole mesh). Returns Float64Array [x, y, z, …], or null past max points.
export function fillMesh(tris, dx, max = Infinity, box = null) {
  const b = bounds(tris), y0 = b[1], z0 = b[2];
  const ny = Math.max(1, Math.ceil((b[4] - y0) / dx)), nz = Math.max(1, Math.ceil((b[5] - z0) / dx));
  const k = box || [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity];
  const ylo = Math.max(0, Math.ceil((k[1] - y0) / dx - 0.5)), yhi = Math.min(ny - 1, Math.floor((k[4] - y0) / dx - 0.5));
  const zlo = Math.max(0, Math.ceil((k[2] - z0) / dx - 0.5)), zhi = Math.min(nz - 1, Math.floor((k[5] - z0) / dx - 0.5));
  const rows = new Map();   // row index → crossing x values
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2], bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5], cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    const jy0 = Math.max(ylo, Math.ceil((Math.min(ay, by, cy) - y0) / dx - 0.5)), jy1 = Math.min(yhi, Math.floor((Math.max(ay, by, cy) - y0) / dx - 0.5));
    const jz0 = Math.max(zlo, Math.ceil((Math.min(az, bz, cz) - z0) / dx - 0.5)), jz1 = Math.min(zhi, Math.floor((Math.max(az, bz, cz) - z0) / dx - 0.5));
    const den = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
    if (Math.abs(den) < 1e-30) continue;                     // parallel to the rays
    for (let jz = jz0; jz <= jz1; jz++) for (let jy = jy0; jy <= jy1; jy++) {
      // Slightly off-centre so that rays do not run exactly through shared edges and vertices.
      const Y = y0 + (jy + 0.5) * dx + 1.3e-7 * dx, Z = z0 + (jz + 0.5) * dx + 0.7e-7 * dx;
      const u = ((Y - ay) * (cz - az) - (cy - ay) * (Z - az)) / den, v = ((by - ay) * (Z - az) - (Y - ay) * (bz - az)) / den;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const X = ax + u * (bx - ax) + v * (cx - ax), key = jy + ny * jz;
      let r = rows.get(key); if (!r) { r = []; rows.set(key, r); } r.push(X);
    }
  }
  const out = [];
  const x0 = Math.floor(b[0] / dx) * dx;
  for (const [key, xs] of rows) {
    xs.sort((p, q) => p - q);
    const jy = key % ny, jz = (key - jy) / ny, Y = y0 + (jy + 0.5) * dx, Z = z0 + (jz + 0.5) * dx;
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const a = Math.max(xs[s], k[0]), e = Math.min(xs[s + 1], k[3]);
      for (let X = x0 + (Math.ceil((a - x0) / dx - 0.5) + 0.5) * dx; X < e; X += dx) out.push(X, Y, Z);
      if (out.length / 3 > max) return null;
    }
  }
  return Float64Array.from(out);
}

// The part of the work a run can reach: the box the tool sweeps (straight: its outline plus the
// travel along +x; spinning: the circle of its largest radius about the axis, along the feed),
// widened by a margin of 12 spacings or half the tool's radius. Any one length unit. p: motion,
// travel, angle [°], fr (drill, per turn), fz and z (mill), axis [x, y] or null.
export function cutRegion(tris, p, dx) {
  const tb = bounds(tris);
  if (p.motion === 'linear') {
    const m = Math.max(12 * dx, 0.25 * Math.max(tb[4] - tb[1], tb[5] - tb[2]));
    return [tb[0] - m, tb[1] - m, tb[2] - m, tb[3] + p.travel + m, tb[4] + m, tb[5] + m];
  }
  const ax = p.axis ? p.axis[0] : 0.5 * (tb[0] + tb[3]), ay = p.axis ? p.axis[1] : 0.5 * (tb[1] + tb[4]);
  let R = 0;
  for (let i = 0; i < tris.length; i += 3) R = Math.max(R, Math.hypot(tris[i] - ax, tris[i + 1] - ay));
  const m = Math.max(12 * dx, 0.5 * R), turns = p.angle / 360;
  const feed = p.motion === 'mill' ? p.fz * p.z * turns : 0, drop = p.motion === 'drill' ? p.fr * turns : 0;
  return [ax - R - m, ay - R - m, tb[2] - drop - m, ax + feed + R + m, ay + R + m, tb[5] + m];
}
