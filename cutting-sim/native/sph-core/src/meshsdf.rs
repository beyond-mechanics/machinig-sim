// Signed distance field of the tool mesh, as MeshSDF in src/mesh.js: exact distances from a BVH,
// sign from angle-weighted pseudonormals, sampled lazily in bricks of 9³ nodes (f32) and
// interpolated trilinearly. The setup (welding, normals, BVH) comes from the JS side; the brick
// cache is a dense grid of once-cells over the region that can be asked for, so that threads
// can sample (and fill bricks) at the same time.
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;
use crate::util::js_hypot3;

#[derive(Deserialize)]
pub struct ToolDump {
    #[serde(rename = "V")] pub v: Vec<f64>,
    #[serde(rename = "F")] pub f: Vec<u32>,
    #[serde(rename = "fn")] pub fnrm: Vec<f64>,
    pub vn: Vec<f64>,
    pub en: Vec<[f64; 5]>,
    pub bb: [f64; 6],
    pub cell: f64,
    pub nb: Vec<f64>,
    pub nl: Vec<i32>,
    pub nr: Vec<i32>,
    pub ns: Vec<i32>,
    pub nn: Vec<i32>,
    pub order: Vec<u32>,
}

const B: i64 = 8;
const NB: usize = 9;

pub struct MeshSdf {
    t: ToolDump,
    en: HashMap<u64, [f64; 3]>,
    pub bb: [f64; 6],
    cell: f64,
    // Brick grid: indices lo..lo+dim on each axis.
    lo: [i64; 3],
    dim: [i64; 3],
    bricks: Vec<OnceLock<Box<[f32]>>>,
}

impl MeshSdf {
    // far: the largest distance outside the box at which bricks are still sampled.
    pub fn new(t: ToolDump, far: f64) -> Self {
        let mut en = HashMap::new();
        for e in &t.en { en.insert(((e[0] as u64) << 32) | e[1] as u64, [e[2], e[3], e[4]]); }
        let (bb, cell) = (t.bb, t.cell);
        let bs = cell * B as f64;
        let mut lo = [0i64; 3];
        let mut dim = [0i64; 3];
        for k in 0..3 {
            let a = ((bb[k] - far) / cell).floor() as i64;
            let b = ((bb[k + 3] + far) / cell).floor() as i64;
            lo[k] = a.div_euclid(B) - 1;
            dim[k] = b.div_euclid(B) + 2 - lo[k];
        }
        let _ = bs;
        let n = (dim[0] * dim[1] * dim[2]) as usize;
        let mut bricks = Vec::with_capacity(n);
        bricks.resize_with(n, OnceLock::new);
        MeshSdf { t, en, bb, cell, lo, dim, bricks }
    }

    pub fn bricks_built(&self) -> usize { self.bricks.iter().filter(|b| b.get().is_some()).count() }

    // Exact signed distance at p: [d, nx, ny, nz] with n the outward direction.
    pub fn exact(&self, px: f64, py: f64, pz: f64) -> [f64; 4] {
        let t = &self.t;
        let nb = &t.nb;
        let box2 = |i: usize| {
            let mut d = 0.0;
            for k in 0..3 {
                let c = if k == 0 { px } else if k == 1 { py } else { pz };
                let (lo, hi) = (nb[6 * i + k], nb[6 * i + 3 + k]);
                let e = if c < lo { lo - c } else if c > hi { c - hi } else { 0.0 };
                d += e * e;
            }
            d
        };
        let mut stack = [0usize; 128];
        let mut sp = 0;
        stack[sp] = 0; sp += 1;
        let (mut best, mut bf, mut bfeat, mut bq) = (f64::INFINITY, usize::MAX, 0u8, [0.0; 3]);
        while sp > 0 {
            sp -= 1;
            let i = stack[sp];
            if box2(i) >= best { continue; }
            if t.nn[i] != 0 {
                let s = t.ns[i] as usize;
                for k in s..s + t.nn[i] as usize {
                    let f = t.order[k] as usize;
                    let (d2, q, feat) = self.closest(f, px, py, pz);
                    if d2 < best { best = d2; bf = f; bfeat = feat; bq = q; }
                }
            } else {
                let (a, b) = (t.nl[i] as usize, t.nr[i] as usize);
                let (da, db) = (box2(a), box2(b));
                if da < db { stack[sp] = b; stack[sp + 1] = a; } else { stack[sp] = a; stack[sp + 1] = b; }
                sp += 2;
            }
        }
        let fi = &t.f;
        let ids = [fi[3 * bf] as usize, fi[3 * bf + 1] as usize, fi[3 * bf + 2] as usize];
        let (nx, ny, nz);
        if bfeat == 0 { nx = t.fnrm[3 * bf]; ny = t.fnrm[3 * bf + 1]; nz = t.fnrm[3 * bf + 2]; }
        else if bfeat <= 3 { let v = 3 * ids[bfeat as usize - 1]; nx = t.vn[v]; ny = t.vn[v + 1]; nz = t.vn[v + 2]; }
        else {
            let (a, b) = (ids[bfeat as usize - 4] as u64, ids[(bfeat as usize - 3) % 3] as u64);
            let key = if a < b { (a << 32) | b } else { (b << 32) | a };
            let e = self.en[&key];
            nx = e[0]; ny = e[1]; nz = e[2];
        }
        let (rx, ry, rz) = (px - bq[0], py - bq[1], pz - bq[2]);
        let d = best.sqrt();
        let sg = if rx * nx + ry * ny + rz * nz >= 0.0 { 1.0 } else { -1.0 };
        if d > 1e-12 { [sg * d, sg * rx / d, sg * ry / d, sg * rz / d] }
        else { let l = js_hypot3(nx, ny, nz); let l = if l == 0.0 { 1.0 } else { l }; [sg * d, nx / l, ny / l, nz / l] }
    }

    // Closest point on face f to p (Ericson 5.1.5): (squared distance, point, feature) with feature
    // 0 face, 1–3 vertex a/b/c, 4–6 edge ab/bc/ca.
    fn closest(&self, f: usize, px: f64, py: f64, pz: f64) -> (f64, [f64; 3], u8) {
        let v = &self.t.v; let fi = &self.t.f;
        let (a, b, c) = (3 * fi[3 * f] as usize, 3 * fi[3 * f + 1] as usize, 3 * fi[3 * f + 2] as usize);
        let (ax, ay, az, bx, by, bz, cx, cy, cz) = (v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]);
        let (abx, aby, abz, acx, acy, acz) = (bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
        let (apx, apy, apz) = (px - ax, py - ay, pz - az);
        let d1 = abx * apx + aby * apy + abz * apz;
        let d2 = acx * apx + acy * apy + acz * apz;
        let (qx, qy, qz, feat);
        if d1 <= 0.0 && d2 <= 0.0 { qx = ax; qy = ay; qz = az; feat = 1; }
        else {
            let (bpx, bpy, bpz) = (px - bx, py - by, pz - bz);
            let d3 = abx * bpx + aby * bpy + abz * bpz;
            let d4 = acx * bpx + acy * bpy + acz * bpz;
            if d3 >= 0.0 && d4 <= d3 { qx = bx; qy = by; qz = bz; feat = 2; }
            else {
                let vc = d1 * d4 - d3 * d2;
                if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 { let w = d1 / (d1 - d3); qx = ax + w * abx; qy = ay + w * aby; qz = az + w * abz; feat = 4; }
                else {
                    let (cpx, cpy, cpz) = (px - cx, py - cy, pz - cz);
                    let d5 = abx * cpx + aby * cpy + abz * cpz;
                    let d6 = acx * cpx + acy * cpy + acz * cpz;
                    if d6 >= 0.0 && d5 <= d6 { qx = cx; qy = cy; qz = cz; feat = 3; }
                    else {
                        let vb = d5 * d2 - d1 * d6;
                        if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 { let w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; feat = 6; }
                        else {
                            let va = d3 * d6 - d5 * d4;
                            if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 { let w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz); feat = 5; }
                            else { let dn = 1.0 / (va + vb + vc); let (v_, w) = (vb * dn, vc * dn); qx = ax + abx * v_ + acx * w; qy = ay + aby * v_ + acy * w; qz = az + abz * v_ + acz * w; feat = 0; }
                        }
                    }
                }
            }
        }
        let (ex, ey, ez) = (px - qx, py - qy, pz - qz);
        (ex * ex + ey * ey + ez * ez, [qx, qy, qz], feat)
    }

    fn brick(&self, i: i64, j: i64, k: i64) -> &[f32] {
        let (a, b, c) = (i - self.lo[0], j - self.lo[1], k - self.lo[2]);
        assert!(a >= 0 && b >= 0 && c >= 0 && a < self.dim[0] && b < self.dim[1] && c < self.dim[2], "brick outside the grid");
        let slot = &self.bricks[(a + self.dim[0] * (b + self.dim[1] * c)) as usize];
        slot.get_or_init(|| {
            let cell = self.cell;
            let mut out = vec![0f32; 4 * NB * NB * NB];
            for c3 in 0..NB { for c2 in 0..NB { for c1 in 0..NB {
                let o = 4 * (c1 + NB * (c2 + NB * c3));
                let q = self.exact((i * B + c1 as i64) as f64 * cell, (j * B + c2 as i64) as f64 * cell, (k * B + c3 as i64) as f64 * cell);
                out[o] = q[0] as f32; out[o + 1] = q[1] as f32; out[o + 2] = q[2] as f32; out[o + 3] = q[3] as f32;
            }}}
            out.into_boxed_slice()
        })
    }

    // Interpolated signed distance and normal at a point in the mesh frame: [d, nx, ny, nz].
    pub fn sample(&self, px: f64, py: f64, pz: f64, far: f64) -> [f64; 4] {
        let bb = &self.bb;
        let ex = f64::max(f64::max(bb[0] - px, 0.0), px - bb[3]);
        let ey = f64::max(f64::max(bb[1] - py, 0.0), py - bb[4]);
        let ez = f64::max(f64::max(bb[2] - pz, 0.0), pz - bb[5]);
        let db = js_hypot3(ex, ey, ez);
        if db > far { return [db, 0.0, 0.0, 1.0]; }
        let c = self.cell;
        let (gx, gy, gz) = (px / c, py / c, pz / c);
        let (ix, iy, iz) = (gx.floor() as i64, gy.floor() as i64, gz.floor() as i64);
        let (bi, bj, bk) = (ix.div_euclid(B), iy.div_euclid(B), iz.div_euclid(B));
        let b = self.brick(bi, bj, bk);
        let (lx, ly, lz) = ((ix - bi * B) as usize, (iy - bj * B) as usize, (iz - bk * B) as usize);
        let (fx, fy, fz) = (gx - ix as f64, gy - iy as f64, gz - iz as f64);
        let (mut d, mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0, 0.0);
        for k in 0..8usize {
            let (ox, oy, oz) = (k & 1, (k >> 1) & 1, k >> 2);
            let w = (if ox == 1 { fx } else { 1.0 - fx }) * (if oy == 1 { fy } else { 1.0 - fy }) * (if oz == 1 { fz } else { 1.0 - fz });
            let o = 4 * ((lx + ox) + NB * ((ly + oy) + NB * (lz + oz)));
            d += w * b[o] as f64; nx += w * b[o + 1] as f64; ny += w * b[o + 2] as f64; nz += w * b[o + 3] as f64;
        }
        let l = js_hypot3(nx, ny, nz);
        let l = if l == 0.0 { 1.0 } else { l };
        [d, nx / l, ny / l, nz / l]
    }
}
