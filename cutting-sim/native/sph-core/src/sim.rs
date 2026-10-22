// The 3D SPH solver of src/sph3d.js in STL mode ('mesh': any tool and work from STL files, the tool
// moving along +x, milling about z with feed along +x, or drilling down −z), stepped natively.
//
// The physics and the order of every floating-point sum follow the JS solver, so that a run here
// matches a run there to rounding (the only differences come from pow/exp/log of the C library).
// What differs is the bookkeeping, made for threads: the JS loops scatter each pair's terms to
// both of its particles; here every particle gathers its own terms from a per-particle list of its
// pairs, kept in the JS pair order. Each particle is then written by one thread only, and the
// result does not depend on the number of threads.
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use crate::material::Mat;
use crate::meshsdf::{MeshSdf, ToolDump};
use crate::util::{js_hypot2, js_hypot3, Shared};

const PI: f64 = std::f64::consts::PI;
const DEG: f64 = PI / 180.0;

#[derive(Deserialize)]
pub struct Arrays {
    pub x: Vec<f64>, pub y: Vec<f64>, pub z: Vec<f64>, pub vx: Vec<f64>, pub vy: Vec<f64>, pub vz: Vec<f64>,
    pub rho: Vec<f64>, pub p: Vec<f64>, #[serde(rename = "T")] pub t: Vec<f64>, pub ep: Vec<f64>, pub epd: Vec<f64>,
    pub seq: Vec<f64>, pub sr: Vec<f64>, pub z0: Vec<f64>, pub dmg: Vec<f64>,
    pub sxx: Vec<f64>, pub syy: Vec<f64>, pub szz: Vec<f64>, pub sxy: Vec<f64>, pub syz: Vec<f64>, pub sxz: Vec<f64>,
    pub fixed: Vec<u8>, pub contact: Vec<u8>, pub dead: Vec<u8>, pub touched: Vec<u8>,
}

#[derive(Deserialize, Clone, Copy)]
#[allow(non_snake_case)]
pub struct Scalars {
    pub dt: f64, pub m: f64, pub mReal: f64, pub G: f64, pub K: f64, pub rho0: f64, pub cs: f64, pub hk: f64, pub ad: f64,
    pub Wdx: f64, pub epKeep: f64, pub nSub: u32, pub dx: f64, pub h: f64, pub V: f64, pub om: f64, pub sg: f64, pub vf: f64,
    pub ax: f64, pub ay: f64, pub Rt: f64, pub ms: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Cfg {
    pub motion: String, pub angle: f64, pub travel: f64, pub mu: f64, pub friction: String, pub mu_exp: f64,
    pub heat_to_work: f64, pub beta: f64, pub fracture: bool, pub ef_scale: f64, pub av_alpha: f64, pub av_beta: f64,
    #[serde(rename = "T0")] pub t0: f64, pub sleep: bool,
}

#[derive(Deserialize)]
pub struct Dump {
    pub n: usize, pub steps: u64, pub t: f64, pub arr: Arrays, pub sc: Scalars, pub cfg: Cfg, pub mat: Mat, pub tool: ToolDump,
}

#[derive(Serialize, Default, Clone)]
pub struct Hist { pub axis: Vec<f64>, pub fc: Vec<f64>, pub ft: Vec<f64>, pub fr: Vec<f64>, pub mz: Vec<f64>, pub tmax: Vec<f64> }

#[derive(Clone, Copy, PartialEq)]
enum Motion { Linear, Mill, Drill }

// Pairs of two held particles, found at the last search: kernel terms stored then (JS keeps them
// until the next search, even if a particle wakes meanwhile), and for every particle the slots of
// its pairs in the JS order (CSR: list[start[p]..start[p + 1]]).
#[derive(Default)]
struct Held { i: Vec<u32>, j: Vec<u32>, t: Vec<[f64; 8]>, start: Vec<u32>, list: Vec<u32> }
// Candidate pairs with a moving particle, in the JS order, and for every particle its own entries
// (pi, pj) in that order. Their kernel terms are evaluated where they are used.
#[derive(Default)]
struct Moving { i: Vec<u32>, j: Vec<u32>, start: Vec<u32>, ea: Vec<u32>, eb: Vec<u32> }

fn csr(i: &[u32], j: &[u32], n: usize) -> (Vec<u32>, Vec<u32>) {
    let mut cnt = vec![0u32; n + 1];
    for k in 0..i.len() { cnt[i[k] as usize + 1] += 1; cnt[j[k] as usize + 1] += 1; }
    for p in 1..=n { cnt[p] += cnt[p - 1]; }
    let start = cnt.clone();
    let mut list = vec![0u32; cnt[n] as usize];
    for k in 0..i.len() {
        let (a, b) = (i[k] as usize, j[k] as usize);
        list[cnt[a] as usize] = k as u32; cnt[a] += 1;
        list[cnt[b] as usize] = k as u32; cnt[b] += 1;
    }
    (start, list)
}
impl Held {
    #[inline] fn of(&self, p: usize) -> &[u32] { &self.list[self.start[p] as usize..self.start[p + 1] as usize] }
}
impl Moving {
    #[inline] fn range(&self, p: usize) -> std::ops::Range<usize> { self.start[p] as usize..self.start[p + 1] as usize }
}

pub struct Sim {
    pub n: usize,
    pub x: Vec<f64>, pub y: Vec<f64>, pub z: Vec<f64>, pub vx: Vec<f64>, pub vy: Vec<f64>, pub vz: Vec<f64>,
    pub rho: Vec<f64>, pub p: Vec<f64>, pub temp: Vec<f64>, pub ep: Vec<f64>, pub epd: Vec<f64>, pub seq: Vec<f64>, pub sr: Vec<f64>,
    pub z0: Vec<f64>, pub dmg: Vec<f64>, pub s: [Vec<f64>; 6],
    pub fixed: Vec<u8>, pub contact: Vec<u8>, pub dead: Vec<u8>, pub touched: Vec<u8>,
    q: Vec<f64>, lm: Vec<f64>, pk: Vec<f64>, ac: Vec<f64>,
    // Conduction factor of every moving entry this step (NaN: not a pair now), from the momentum pass.
    ef: Vec<f64>,
    pub sc: Scalars, pub cfg: Cfg, pub mat: Mat, pub sdf: MeshSdf,
    motion: Motion,
    fixp: Held, movp: Moving,
    // Positions and supports before the last integration, kept for the chip analysis of a sampling step.
    snap: Option<(Vec<f64>, Vec<f64>, Vec<f64>, Vec<u8>)>, want_snap: bool,
    xr: Option<(Vec<f64>, Vec<f64>, Vec<f64>)>, dead_ref: u64, last_sort: Option<u64>,
    pub n_dead: u64, pub n_evac: u64,
    pub steps: u64, pub t: f64, pub done: bool,
    ang: f64, mx: f64, mz: f64, ca: f64, sa: f64,
    imp: [f64; 4], imp_t: f64, pub work_in: f64, pub heat_tool: f64,
    pub hist: Hist, last_sample: f64, pub pieces: usize, pub failed: usize, pub searches: u64,
    // Wall time per phase [s]: pairs, L/M, Shepard, stress, momentum, conduction, integration, samples.
    pub prof: [f64; 8],
}

impl Sim {
    pub fn new(d: Dump) -> Sim {
        let n = d.n;
        let a = d.arr;
        let motion = match d.cfg.motion.as_str() { "linear" => Motion::Linear, "mill" => Motion::Mill, _ => Motion::Drill };
        let far = 3.0 * d.sc.dx;
        let n_dead = a.dead.iter().filter(|&&v| v == 1).count() as u64;
        let n_evac = a.dead.iter().filter(|&&v| v == 2).count() as u64;
        let mut s = Sim {
            n, x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz, rho: a.rho, p: a.p, temp: a.t, ep: a.ep, epd: a.epd,
            seq: a.seq, sr: a.sr, z0: a.z0, dmg: a.dmg, s: [a.sxx, a.syy, a.szz, a.sxy, a.syz, a.sxz],
            fixed: a.fixed, contact: a.contact, dead: a.dead, touched: a.touched,
            q: vec![0.0; 4 * n], lm: vec![0.0; 19 * n], pk: vec![0.0; 9 * n], ac: vec![0.0; 6 * n], ef: Vec::new(),
            sc: d.sc, cfg: d.cfg, mat: d.mat, sdf: MeshSdf::new(d.tool, far), motion,
            fixp: Held::default(), movp: Moving::default(), snap: None, want_snap: false,
            xr: None, dead_ref: 0, last_sort: None, n_dead, n_evac, steps: d.steps, t: d.t, done: false,
            ang: 0.0, mx: 0.0, mz: 0.0, ca: 1.0, sa: 0.0, imp: [0.0; 4], imp_t: 0.0, work_in: 0.0, heat_tool: 0.0,
            hist: Hist::default(), last_sample: 0.0, pieces: 0, failed: 0, searches: 0, prof: [0.0; 8],
        };
        s.pose(s.t);
        s.last_sample = s.progress();
        s
    }

    fn pose(&mut self, time: f64) {
        let sc = &self.sc;
        self.ang = sc.sg * sc.om * time;
        self.mx = match self.motion { Motion::Linear => sc.V * time, Motion::Mill => sc.vf * time, Motion::Drill => 0.0 };
        self.mz = if self.motion == Motion::Drill { -sc.vf * time } else { 0.0 };
        self.ca = self.ang.cos(); self.sa = self.ang.sin();
    }

    pub fn progress(&self) -> f64 {
        if self.motion == Motion::Linear { self.mx / (self.cfg.travel * 1e-3) } else { self.ang.abs() / (self.cfg.angle * DEG) }
    }
    fn progress_at(&self, time: f64) -> f64 {
        let sc = &self.sc;
        if self.motion == Motion::Linear { sc.V * time / (self.cfg.travel * 1e-3) } else { (sc.sg * sc.om * time).abs() / (self.cfg.angle * DEG) }
    }

    // Tool distance at a world point: ([d, nx, ny, nz], tool surface velocity there).
    #[inline]
    fn tool_at(&self, px: f64, py: f64, pz: f64) -> ([f64; 4], [f64; 3]) {
        let sc = &self.sc;
        let (x_, y_) = (px - self.mx - sc.ax, py - sc.ay);
        let (ca, sa) = (self.ca, self.sa);
        let s = self.sdf.sample(sc.ax + ca * x_ + sa * y_, sc.ay - sa * x_ + ca * y_, pz - self.mz, 3.0 * sc.dx);
        let q = [s[0], ca * s[1] - sa * s[2], sa * s[1] + ca * s[2], s[3]];
        let w = sc.sg * sc.om;
        let base = match self.motion { Motion::Linear => sc.V, Motion::Mill => sc.vf, Motion::Drill => 0.0 };
        (q, [base - w * y_, w * x_, if self.motion == Motion::Drill { -sc.vf } else { 0.0 }])
    }

    // Sort the particles by neighbour cell (counting sort) so that pair loops walk memory nearly in order.
    fn reorder(&mut self, keys: &[u32], nc: usize) {
        let n = self.n;
        let mut cnt = vec![0u32; nc + 2];
        let kk: Vec<u32> = (0..n).map(|i| if self.dead[i] != 0 { nc as u32 + 1 } else { keys[i] }).collect();
        for i in 0..n { cnt[kk[i] as usize + 1] += 1; }
        for c in 1..=nc + 1 { cnt[c] += cnt[c - 1]; }
        let mut perm = vec![0u32; n];
        for i in 0..n { let c = kk[i] as usize; perm[cnt[c] as usize] = i as u32; cnt[c] += 1; }
        let pf = |a: &mut Vec<f64>| { let t: Vec<f64> = perm.iter().map(|&k| a[k as usize]).collect(); *a = t; };
        let pu = |a: &mut Vec<u8>| { let t: Vec<u8> = perm.iter().map(|&k| a[k as usize]).collect(); *a = t; };
        let [s0, s1, s2, s3, s4, s5] = &mut self.s;
        let mut fs: Vec<&mut Vec<f64>> = vec![&mut self.x, &mut self.y, &mut self.z, &mut self.vx, &mut self.vy, &mut self.vz, &mut self.rho, &mut self.p,
            &mut self.temp, &mut self.ep, &mut self.epd, &mut self.seq, &mut self.sr, &mut self.z0, &mut self.dmg, s0, s1, s2, s3, s4, s5];
        fs.par_iter_mut().for_each(|a| pf(a));
        let mut us: Vec<&mut Vec<u8>> = vec![&mut self.fixed, &mut self.contact, &mut self.dead, &mut self.touched];
        us.par_iter_mut().for_each(|a| pu(a));
    }

    // Cell search for all pairs closer than `cell`, in the JS order (also sorts now and then).
    fn search_pairs(&mut self, cell: f64) -> Vec<(u32, u32)> {
        self.searches += 1;
        let n = self.n;
        let (mut x0, mut y0, mut z0, mut x1, mut y1, mut z1) = (f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for i in 0..n {
            if self.dead[i] != 0 { continue; }
            let (x, y, z) = (self.x[i], self.y[i], self.z[i]);
            if x < x0 { x0 = x; } if x > x1 { x1 = x; }
            if y < y0 { y0 = y; } if y > y1 { y1 = y; }
            if z < z0 { z0 = z; } if z > z1 { z1 = z; }
        }
        let cw = ((x1 - x0) / cell).floor() as i64 + 1;
        let ch = ((y1 - y0) / cell).floor() as i64 + 1;
        let cd = ((z1 - z0) / cell).floor() as i64 + 1;
        let ncell = (cw * ch * cd) as usize;
        let key = |x: f64, y: f64, z: f64| -> u32 {
            (((x - x0) / cell).floor() as i64 + cw * (((y - y0) / cell).floor() as i64 + ch * i64::min(cd - 1, ((z - z0) / cell).floor() as i64))) as u32
        };
        if self.last_sort.map_or(true, |l| self.steps - l >= 50) {
            let keys: Vec<u32> = (0..n).into_par_iter().map(|i| if self.dead[i] != 0 { 0 } else { key(self.x[i], self.y[i], self.z[i]) }).collect();
            self.reorder(&keys, ncell);
            self.last_sort = Some(self.steps);
        }
        // Linked cell lists, newest first, as in JS.
        let mut head = vec![-1i32; ncell];
        let mut next = vec![-1i32; n];
        for i in 0..n {
            if self.dead[i] != 0 { continue; }
            let c = key(self.x[i], self.y[i], self.z[i]) as usize;
            next[i] = head[c]; head[c] = i as i32;
        }
        let r2max = cell * cell;
        let (x, y, z) = (&self.x, &self.y, &self.z);
        let slabs: Vec<Vec<(u32, u32)>> = (0..cd).into_par_iter().map(|kz| {
            let mut out = Vec::new();
            for ky in 0..ch { for kx in 0..cw {
                let c0 = (kx + cw * (ky + ch * kz)) as usize;
                let mut i = head[c0];
                while i >= 0 {
                    let iu = i as usize;
                    for oz in 0..=1i64 { for oy in -1..=1i64 { for ox in -1..=1i64 {
                        if oz == 0 && (oy < 0 || (oy == 0 && ox < 0)) { continue; }
                        let (nxc, nyc, nzc) = (kx + ox, ky + oy, kz + oz);
                        if nxc < 0 || nxc >= cw || nyc < 0 || nyc >= ch || nzc >= cd { continue; }
                        let same = ox == 0 && oy == 0 && oz == 0;
                        let mut j = if same { next[iu] } else { head[(nxc + cw * (nyc + ch * nzc)) as usize] };
                        while j >= 0 {
                            let ju = j as usize;
                            let (rx, ry, rz) = (x[iu] - x[ju], y[iu] - y[ju], z[iu] - z[ju]);
                            if rx * rx + ry * ry + rz * rz < r2max { out.push((i as u32, j as u32)); }
                            j = next[ju];
                        }
                    }}}
                    i = next[iu];
                }
            }}
            out
        }).collect();
        let mut all = Vec::with_capacity(slabs.iter().map(|s| s.len()).sum());
        for s in slabs { all.extend(s); }
        all
    }

    // Kernel terms of a pair (rx, ry, rz, ∇W, W, conduction factor), or None outside the support.
    #[inline(always)]
    fn kernel(x: &[f64], y: &[f64], z: &[f64], hk: f64, ad: f64, i: usize, j: usize) -> Option<[f64; 8]> {
        let (r2max, inv, eta) = (4.0 * hk * hk, 1.0 / hk, 0.01 * hk * hk);
        let (rx, ry, rz) = (x[i] - x[j], y[i] - y[j], z[i] - z[j]);
        let r2 = rx * rx + ry * ry + rz * rz;
        if r2 >= r2max || r2 == 0.0 { return None; }
        let r = r2.sqrt();
        let q = r * inv;
        let (w, dw);
        if q < 1.0 { w = ad * (1.0 - 1.5 * q * q + 0.75 * q * q * q); dw = ad * inv * (-3.0 * q + 2.25 * q * q); }
        else { let s = 2.0 - q; w = ad * 0.25 * s * s * s; dw = -ad * inv * 0.75 * s * s; }
        let g = dw / r;
        Some([rx, ry, rz, g * rx, g * ry, g * rz, w, dw * r / (r2 + eta)])
    }
    // A moving candidate this step: none for two particles frozen since the search.
    #[inline(always)]
    fn moving(&self, i: usize, j: usize) -> Option<[f64; 8]> {
        if self.fixed[i] >= 2 && self.fixed[j] >= 2 { return None; }
        Self::kernel(&self.x, &self.y, &self.z, self.sc.hk, self.sc.ad, i, j)
    }

    // Verlet list as in JS: candidates within 2h + skin, searched again only when a particle has
    // moved more than half the skin or one was removed. Pairs of two held particles are evaluated
    // at the search only; the others where they are used, every step.
    fn build_pairs(&mut self) {
        let n = self.n;
        let skin = 0.3 * self.sc.hk;
        let mut need = self.xr.is_none() || self.n_dead + self.n_evac != self.dead_ref;
        if !need {
            let lim = 0.25 * skin * skin;
            let (xr, yr, zr) = self.xr.as_ref().unwrap();
            need = (0..n).into_par_iter().with_min_len(4096).any(|i| {
                if self.dead[i] != 0 { return false; }
                let (dx, dy, dz) = (self.x[i] - xr[i], self.y[i] - yr[i], self.z[i] - zr[i]);
                dx * dx + dy * dy + dz * dz > lim
            });
        }
        if !need { return; }
        let cand = self.search_pairs(2.0 * self.sc.hk + skin);
        self.xr = Some((self.x.clone(), self.y.clone(), self.z.clone()));
        self.dead_ref = self.n_dead + self.n_evac;
        // Split the candidates into held pairs (evaluated now) and moving ones, keeping the order.
        let (hk, ad) = (self.sc.hk, self.sc.ad);
        let parts: Vec<(Vec<(u32, u32, [f64; 8])>, Vec<(u32, u32)>)> = cand.par_chunks(1 << 16).map(|ch| {
            let (mut f, mut m) = (Vec::new(), Vec::new());
            for &(i, j) in ch {
                let (iu, ju) = (i as usize, j as usize);
                if self.dead[iu] != 0 || self.dead[ju] != 0 { continue; }
                if self.fixed[iu] != 0 && self.fixed[ju] != 0 { if let Some(t) = Self::kernel(&self.x, &self.y, &self.z, hk, ad, iu, ju) { f.push((i, j, t)); } }
                else { m.push((i, j)); }
            }
            (f, m)
        }).collect();
        let mut fp = Held::default();
        let mut mp = Moving::default();
        for (f, m) in parts {
            for (i, j, t) in f { fp.i.push(i); fp.j.push(j); fp.t.push(t); }
            for (i, j) in m { mp.i.push(i); mp.j.push(j); }
        }
        rayon::join(|| { let (s, l) = csr(&fp.i, &fp.j, n); fp.start = s; fp.list = l; },
            || {
                let (s, l) = csr(&mp.i, &mp.j, n);
                mp.ea = l.iter().map(|&k| mp.i[k as usize]).collect();
                mp.eb = l.iter().map(|&k| mp.j[k as usize]).collect();
                mp.start = s;
            });
        self.fixp = fp; self.movp = mp;
    }

    pub fn step(&mut self) {
        if self.done { return; }
        let mut clk = std::time::Instant::now();
        let mut lap = |s: &mut Sim, k: usize| { s.prof[k] += clk.elapsed().as_secs_f64(); clk = std::time::Instant::now(); };
        self.build_pairs();
        lap(self, 0);
        let n = self.n;
        let sc = self.sc;
        let m = sc.m;
        {
            let q = Shared::new(&mut self.q);
            let (vx, vy, vz, rho) = (&self.vx, &self.vy, &self.vz, &self.rho);
            (0..n).into_par_iter().with_min_len(1024).for_each(|i| unsafe {
                *q.at(4 * i) = vx[i]; *q.at(4 * i + 1) = vy[i]; *q.at(4 * i + 2) = vz[i]; *q.at(4 * i + 3) = rho[i];
            });
        }

        // 1. Velocity gradient L = −Σ V_j (v_i − v_j) ⊗ ∇W, correction matrix M and dρ/dt.
        {
            let lm = Shared::new(&mut self.lm);
            let this = &*self;
            let (q, mp, fp, fixed) = (&this.q, &this.movp, &this.fixp, &this.fixed);
            (0..n).into_par_iter().with_min_len(128).for_each(|p| unsafe {
                let mut o = [0.0f64; 19];
                for e in mp.range(p) {
                    let (i, j) = (mp.ea[e] as usize, mp.eb[e] as usize);
                    let Some(t) = this.moving(i, j) else { continue };
                    let (qi, qj) = (4 * i, 4 * j);
                    let vo = if p == i { m / q[qj + 3] } else { m / q[qi + 3] };
                    let (dvx, dvy, dvz) = (q[qi] - q[qj], q[qi + 1] - q[qj + 1], q[qi + 2] - q[qj + 2]);
                    let (rx, ry, rz, g1, g2, g3) = (t[0], t[1], t[2], t[3], t[4], t[5]);
                    let a = [dvx * g1, dvx * g2, dvx * g3, dvy * g1, dvy * g2, dvy * g3, dvz * g1, dvz * g2, dvz * g3];
                    let b = [rx * g1, rx * g2, rx * g3, ry * g1, ry * g2, ry * g3, rz * g1, rz * g2, rz * g3];
                    let dr = m * (a[0] + a[4] + a[8]);
                    for c in 0..9 { o[c] -= vo * a[c]; }
                    for c in 0..9 { o[9 + c] -= vo * b[c]; }
                    o[18] += dr;
                }
                // Pairs of two held particles: only the correction matrix of the supports.
                for &k in fp.of(p) {
                    let k = k as usize;
                    let (i, j) = (fp.i[k] as usize, fp.j[k] as usize);
                    if fixed[i] >= 2 && fixed[j] >= 2 { continue; }
                    let vo = if p == i { m / q[4 * j + 3] } else { m / q[4 * i + 3] };
                    let t = &fp.t[k];
                    let (rx, ry, rz, g1, g2, g3) = (t[0], t[1], t[2], t[3], t[4], t[5]);
                    let b = [rx * g1, rx * g2, rx * g3, ry * g1, ry * g2, ry * g3, rz * g1, rz * g2, rz * g3];
                    for c in 0..9 { o[9 + c] -= vo * b[c]; }
                }
                for c in 0..19 { *lm.at(19 * p + c) = o[c]; }
            });
        }
        lap(self, 1);
        if self.steps % 20 == 0 { self.shepard(); }
        lap(self, 2);

        // 2. Constitutive update.
        self.constitutive();
        lap(self, 3);
        {
            let q = Shared::new(&mut self.q);
            let rho = &self.rho;
            (0..n).into_par_iter().with_min_len(1024).for_each(|i| unsafe { *q.at(4 * i + 3) = rho[i]; });
        }

        // 3. Momentum, XSPH and heat conduction.
        {
            let xs = 0.5 * m;
            let (hk, cs) = (sc.hk, sc.cs);
            let eta = 0.01 * hk * hk;
            let (alpha, beta_v, iwdx) = (self.cfg.av_alpha, self.cfg.av_beta, 1.0 / sc.Wdx);
            let ne = self.movp.ea.len();
            if self.ef.len() != ne { self.ef.resize(ne, f64::NAN); }
            let acc = Shared::new(&mut self.ac);
            let ef = Shared::new(&mut self.ef);
            let this = &*self;
            let (q, pk, mp, dmg) = (&this.q, &this.pk, &this.movp, &this.dmg);
            (0..n).into_par_iter().with_min_len(128).for_each(|p| unsafe {
                let mut a = [0.0f64; 6];
                for e in mp.range(p) {
                    let (i, j) = (mp.ea[e] as usize, mp.eb[e] as usize);
                    let Some(t) = this.moving(i, j) else { *ef.at(e) = f64::NAN; continue };
                    *ef.at(e) = t[7];
                    let (si, sj, qi, qj) = (9 * i, 9 * j, 4 * i, 4 * j);
                    let mut txx = pk[si] + pk[sj];
                    let mut tyy = pk[si + 1] + pk[sj + 1];
                    let mut tzz = pk[si + 2] + pk[sj + 2];
                    let (txy, tyz, txz) = (pk[si + 3] + pk[sj + 3], pk[si + 4] + pk[sj + 4], pk[si + 5] + pk[sj + 5]);
                    let (rx, ry, rz) = (t[0], t[1], t[2]);
                    let (dvx, dvy, dvz) = (q[qi] - q[qj], q[qi + 1] - q[qj + 1], q[qi + 2] - q[qj + 2]);
                    let rs = q[qi + 3] + q[qj + 3];
                    let vr = dvx * rx + dvy * ry + dvz * rz;
                    if vr < 0.0 {
                        let mu = hk * vr / (rx * rx + ry * ry + rz * rz + eta);
                        let pv = (-alpha * cs * mu + beta_v * mu * mu) * 2.0 / rs;
                        txx -= pv; tyy -= pv; tzz -= pv;
                    }
                    let mut fq = t[6] * iwdx; fq *= fq; fq *= fq;
                    txx += fq * (pk[si + 6] + pk[sj + 6]); tyy += fq * (pk[si + 7] + pk[sj + 7]); tzz += fq * (pk[si + 8] + pk[sj + 8]);
                    let (g1, g2, g3) = (t[3], t[4], t[5]);
                    let fx = m * (txx * g1 + txy * g2 + txz * g3);
                    let fy = m * (txy * g1 + tyy * g2 + tyz * g3);
                    let fz = m * (txz * g1 + tyz * g2 + tzz * g3);
                    let wx = if dmg[i] >= 1.5 || dmg[j] >= 1.5 { 0.0 } else { xs * t[6] * 2.0 / rs };
                    let (ux, uy, uz) = (-dvx * wx, -dvy * wx, -dvz * wx);
                    if p == i { a[0] += fx; a[1] += fy; a[2] += fz; a[3] += ux; a[4] += uy; a[5] += uz; }
                    else { a[0] -= fx; a[1] -= fy; a[2] -= fz; a[3] -= ux; a[4] -= uy; a[5] -= uz; }
                }
                for c in 0..6 { *acc.at(6 * p + c) = a[c]; }
            });
        }
        lap(self, 4);
        self.conduct();
        lap(self, 5);

        // 4. Integrate, tool contact, supports.
        self.integrate();
        lap(self, 6);
    }

    fn shepard(&mut self) {
        let (n, m, w0) = (self.n, self.sc.m, self.sc.ad);
        let (mp, fp, rho) = (&self.movp, &self.fixp, &self.rho);
        let this = &*self;
        let new: Vec<f64> = (0..n).into_par_iter().with_min_len(128).map(|p| {
            let (mut num, mut den) = (m * w0, m * w0 / rho[p]);
            for &k in fp.of(p) {
                let k = k as usize;
                let (i, j, w) = (fp.i[k] as usize, fp.j[k] as usize, fp.t[k][6]);
                num += m * w;
                den += m * w / rho[if p == i { j } else { i }];
            }
            for e in mp.range(p) {
                let (i, j) = (mp.ea[e] as usize, mp.eb[e] as usize);
                let Some(t) = this.moving(i, j) else { continue };
                num += m * t[6];
                den += m * t[6] / rho[if p == i { j } else { i }];
            }
            num / den
        }).collect();
        self.rho = new;
    }

    fn conduct(&mut self) {
        let (n, m, sub) = (self.n, self.sc.m, self.sc.nSub);
        let h = self.sc.dt / sub as f64;
        let coef = 2.0 * self.mat.k / (self.mat.rho * self.mat.cp) * h;
        for _ in 0..sub {
            let this = &*self;
            let (mp, fp, rho, t) = (&this.movp, &this.fixp, &this.rho, &this.temp);
            let d: Vec<f64> = (0..n).into_par_iter().with_min_len(128).map(|p| {
                let mut dt = 0.0;
                for &k in fp.of(p) {
                    let k = k as usize;
                    let (i, j) = (fp.i[k] as usize, fp.j[k] as usize);
                    let qq = coef * (t[i] - t[j]) * fp.t[k][7];
                    if p == i { dt += qq * m / rho[j]; } else { dt -= qq * m / rho[i]; }
                }
                for e in mp.range(p) {
                    let f = this.ef[e];
                    if f.is_nan() { continue; }
                    let (i, j) = (mp.ea[e] as usize, mp.eb[e] as usize);
                    let qq = coef * (t[i] - t[j]) * f;
                    if p == i { dt += qq * m / rho[j]; } else { dt -= qq * m / rho[i]; }
                }
                dt
            }).collect();
            self.temp.par_iter_mut().zip(d.par_iter()).for_each(|(t, d)| *t += d);
        }
    }

    fn constitutive(&mut self) {
        let n = self.n;
        let (dt, g, k, rho0) = (self.sc.dt, self.sc.G, self.sc.K, self.sc.rho0);
        let (eps, sq23, pcut) = (0.3, (2.0f64 / 3.0).sqrt(), -2.0 * self.mat.a * 1e6);
        let mat = &self.mat;
        let frac = self.cfg.fracture && mat.d1.is_some();
        let (efs, tr, tm) = (self.cfg.ef_scale, mat.tr, mat.tm);
        let (d1, d2, d3, d4, d5) = (mat.d1.unwrap_or(0.0), mat.d2.unwrap_or(0.0), mat.d3.unwrap_or(0.0), mat.d4.unwrap_or(0.0), mat.d5.unwrap_or(0.0));
        let (beta, ep_keep) = (self.cfg.beta, self.sc.epKeep);
        let rhoc = mat.rho * mat.cp;
        let [s0, s1, s2, s3, s4, s5] = &mut self.s;
        let (sxx_, syy_, szz_, sxy_, syz_, sxz_) = (Shared::new(s0), Shared::new(s1), Shared::new(s2), Shared::new(s3), Shared::new(s4), Shared::new(s5));
        let (rho_, p_, t_, ep_, epd_, dmg_, sr_, seq_, pk_) = (Shared::new(&mut self.rho), Shared::new(&mut self.p), Shared::new(&mut self.temp), Shared::new(&mut self.ep),
            Shared::new(&mut self.epd), Shared::new(&mut self.dmg), Shared::new(&mut self.sr), Shared::new(&mut self.seq), Shared::new(&mut self.pk));
        let (lm, fixed, dead, contact) = (&self.lm, &self.fixed, &self.dead, &self.contact);
        (0..n).into_par_iter().with_min_len(512).for_each(|i| unsafe {
            let (o, pk) = (19 * i, 9 * i);
            let rho = rho_.at(i); let p = p_.at(i);
            let (sxx0, syy0, szz0, sxy0, syz0, sxz0) = (sxx_.at(i), syy_.at(i), szz_.at(i), sxy_.at(i), syz_.at(i), sxz_.at(i));
            if fixed[i] >= 2 || dead[i] != 0 {
                let ir2 = 1.0 / (*rho * *rho);
                *pk_.at(pk) = (*sxx0 - *p) * ir2; *pk_.at(pk + 1) = (*syy0 - *p) * ir2; *pk_.at(pk + 2) = (*szz0 - *p) * ir2;
                *pk_.at(pk + 3) = *sxy0 * ir2; *pk_.at(pk + 4) = *syz0 * ir2; *pk_.at(pk + 5) = *sxz0 * ir2;
                *pk_.at(pk + 6) = 0.0; *pk_.at(pk + 7) = 0.0; *pk_.at(pk + 8) = 0.0;
                return;
            }
            let (mut l00, mut l01, mut l02, mut l10, mut l11, mut l12, mut l20, mut l21, mut l22) = (lm[o], lm[o + 1], lm[o + 2], lm[o + 3], lm[o + 4], lm[o + 5], lm[o + 6], lm[o + 7], lm[o + 8]);
            let (a, b, c, d, e, f, gg, hh, ii) = (lm[o + 9], lm[o + 10], lm[o + 11], lm[o + 12], lm[o + 13], lm[o + 14], lm[o + 15], lm[o + 16], lm[o + 17]);
            let ca = e * ii - f * hh;
            let cb = -(d * ii - f * gg);
            let cc = d * hh - e * gg;
            let det = a * ca + b * cb + c * cc;
            if det > 0.3 {
                let id = 1.0 / det;
                let (i00, i10, i20) = (ca * id, cb * id, cc * id);
                let (i01, i11, i21) = (-(b * ii - c * hh) * id, (a * ii - c * gg) * id, -(a * hh - b * gg) * id);
                let (i02, i12, i22) = ((b * f - c * e) * id, -(a * f - c * d) * id, (a * e - b * d) * id);
                let (mut u0, mut u1, mut u2) = (l00, l01, l02);
                l00 = u0 * i00 + u1 * i10 + u2 * i20; l01 = u0 * i01 + u1 * i11 + u2 * i21; l02 = u0 * i02 + u1 * i12 + u2 * i22;
                u0 = l10; u1 = l11; u2 = l12;
                l10 = u0 * i00 + u1 * i10 + u2 * i20; l11 = u0 * i01 + u1 * i11 + u2 * i21; l12 = u0 * i02 + u1 * i12 + u2 * i22;
                u0 = l20; u1 = l21; u2 = l22;
                l20 = u0 * i00 + u1 * i10 + u2 * i20; l21 = u0 * i01 + u1 * i11 + u2 * i21; l22 = u0 * i02 + u1 * i12 + u2 * i22;
            }
            let tr3 = l00 + l11 + l22;
            let (dxx, dyy, dzz) = (l00 - tr3 / 3.0, l11 - tr3 / 3.0, l22 - tr3 / 3.0);
            let (dxy, dyz, dxz) = (0.5 * (l01 + l10), 0.5 * (l12 + l21), 0.5 * (l02 + l20));
            let (wxy, wyz, wxz) = (0.5 * (l01 - l10), 0.5 * (l12 - l21), 0.5 * (l02 - l20));
            *rho += lm[o + 18] * dt;
            *p = k * (*rho / rho0 - 1.0);
            let dm = dmg_.at(i);
            let fs = if *dm <= 1.0 { 1.0 } else if *dm >= 1.5 { 0.0 } else { 3.0 - 2.0 * *dm };
            let pc = pcut * fs;
            if *p < pc { *p = pc; *rho = rho0 * (1.0 + pc / k); }
            let (mut sxx, mut syy, mut szz, mut sxy, mut syz, mut sxz) = (*sxx0, *syy0, *szz0, *sxy0, *syz0, *sxz0);
            let axx = wxy * sxy + wxz * sxz;
            let ayy = -wxy * sxy + wyz * syz;
            let azz = -wxz * sxz - wyz * syz;
            let axy = wxy * syy + wxz * syz;
            let ayx = -wxy * sxx + wyz * sxz;
            let ayz = -wxy * sxz + wyz * szz;
            let azy = -wxz * sxy - wyz * syy;
            let axz = wxy * syz + wxz * szz;
            let azx = -wxz * sxx - wyz * sxy;
            sxx += dt * (2.0 * g * dxx + 2.0 * axx); syy += dt * (2.0 * g * dyy + 2.0 * ayy); szz += dt * (2.0 * g * dzz + 2.0 * azz);
            sxy += dt * (2.0 * g * dxy + axy + ayx); syz += dt * (2.0 * g * dyz + ayz + azy); sxz += dt * (2.0 * g * dxz + axz + azx);
            let seq = (1.5 * (sxx * sxx + syy * syy + szz * szz + 2.0 * (sxy * sxy + syz * syz + sxz * sxz))).sqrt();
            let (ep, epd, t) = (ep_.at(i), epd_.at(i), t_.at(i));
            let sy = mat.flow_stress(*ep, *epd, *t) * fs;
            let mut dep = 0.0;
            if seq > sy {
                let scl = sy / seq;
                sxx *= scl; syy *= scl; szz *= scl; sxy *= scl; syz *= scl; sxz *= scl;
                dep = if sy > 0.0 { (seq - sy) / (3.0 * g) } else { 0.0 };
                *ep += dep;
                *t += beta * sy * dep / rhoc;
                if frac && fs > 0.0 && det > 0.6 && contact[i] == 0 {
                    let eta = -*p / f64::max(sy, 1e6);
                    if eta > 0.0 {
                        let mut ts = (*t - tr) / (tm - tr);
                        ts = if ts < 0.0 { 0.0 } else if ts > 1.0 { 1.0 } else { ts };
                        let r = if *epd > 1.0 { epd.ln() } else { 0.0 };
                        let ef = f64::max(0.02, (d1 + d2 * (d3 * eta).exp()) * (1.0 + d4 * r) * (1.0 + d5 * ts) * efs);
                        *dm += dep / ef;
                    }
                }
            }
            *epd = ep_keep * *epd + (1.0 - ep_keep) * dep / dt;
            *sr_.at(i) = sq23 * (dxx * dxx + dyy * dyy + dzz * dzz + 2.0 * (dxy * dxy + dyz * dyz + dxz * dxz)).sqrt();
            *sxx0 = sxx; *syy0 = syy; *szz0 = szz; *sxy0 = sxy; *syz0 = syz; *sxz0 = sxz;
            *seq_.at(i) = f64::min(seq, sy);
            let ir2 = 1.0 / (*rho * *rho);
            let pp = *p;
            *pk_.at(pk) = (sxx - pp) * ir2; *pk_.at(pk + 1) = (syy - pp) * ir2; *pk_.at(pk + 2) = (szz - pp) * ir2;
            *pk_.at(pk + 3) = sxy * ir2; *pk_.at(pk + 4) = syz * ir2; *pk_.at(pk + 5) = sxz * ir2;
            *pk_.at(pk + 6) = if sxx - pp > 0.0 { -eps * (sxx - pp) * ir2 } else { 0.0 };
            *pk_.at(pk + 7) = if syy - pp > 0.0 { -eps * (syy - pp) * ir2 } else { 0.0 };
            *pk_.at(pk + 8) = if szz - pp > 0.0 { -eps * (szz - pp) * ir2 } else { 0.0 };
        });
    }

    fn integrate(&mut self) {
        let n = self.n;
        let sc = self.sc;
        let (dt, m, dx, v) = (sc.dt, sc.m, sc.dx, sc.V);
        self.pose(self.t + dt);
        self.snap = if self.want_snap { Some((self.x.clone(), self.y.clone(), self.z.clone(), self.fixed.clone())) } else { None };
        let d0 = 0.5 * dx;
        let (mu0, mu_v, mu_exp, fw) = (self.cfg.mu, self.cfg.friction == "speed", self.cfg.mu_exp, self.cfg.heat_to_work);
        let (v_esc2, area) = (100.0 * v * v, dx * dx);
        let c_mat = self.mat.cp;
        let v_slow2 = (0.02 * v) * (0.02 * v);
        let d_free = 8.0 * dx;
        let sleep = self.cfg.sleep;
        let wake = self.steps % 10 == 0;
        let (d_wake, d_sleep) = (10.0 * dx, 14.0 * dx);
        let sqrt3 = 3.0f64.sqrt();
        let (x_, y_, z_, vx_, vy_, vz_, t_, fixed_, contact_, dead_, touched_) = (Shared::new(&mut self.x), Shared::new(&mut self.y), Shared::new(&mut self.z),
            Shared::new(&mut self.vx), Shared::new(&mut self.vy), Shared::new(&mut self.vz), Shared::new(&mut self.temp), Shared::new(&mut self.fixed),
            Shared::new(&mut self.contact), Shared::new(&mut self.dead), Shared::new(&mut self.touched));
        let this = &*self;
        let (ac, dmg, ep, epd) = (&this.ac, &this.dmg, &this.ep, &this.epd);
        const CH: usize = 2048;
        // Per chunk: impulse (3), torque, tool work, tool heat, new deaths.
        let parts: Vec<[f64; 7]> = (0..n.div_ceil(CH)).into_par_iter().map(|c| unsafe {
            let mut r = [0.0f64; 7];
            for i in c * CH..usize::min(n, (c + 1) * CH) {
                let (x, y, z, vx, vy, vz, t) = (x_.at(i), y_.at(i), z_.at(i), vx_.at(i), vy_.at(i), vz_.at(i), t_.at(i));
                let (fixed, contact, dead, touched) = (fixed_.at(i), contact_.at(i), dead_.at(i), touched_.at(i));
                if *fixed == 2 && *dead == 0 && this.tool_at(*x, *y, *z).0[0] < 3.0 * dx { *fixed = 0; }
                if *fixed == 3 && wake && this.tool_at(*x, *y, *z).0[0] < d_wake { *fixed = 0; }
                if *fixed != 0 || *dead != 0 { *vx = 0.0; *vy = 0.0; *vz = 0.0; *contact = 0; continue; }
                let ai = 6 * i;
                *vx += ac[ai] * dt; *vy += ac[ai + 1] * dt; *vz += ac[ai + 2] * dt;
                if *vx * *vx + *vy * *vy + *vz * *vz > v_esc2 { *dead = 1; r[6] += 1.0; *vx = 0.0; *vy = 0.0; *vz = 0.0; continue; }
                *x += (*vx + ac[ai + 3]) * dt; *y += (*vy + ac[ai + 4]) * dt; *z += (*vz + ac[ai + 5]) * dt;
                let (o, tv) = this.tool_at(*x, *y, *z);
                let dist = o[0];
                if dist >= d0 {
                    *contact = 0;
                    let v2 = *vx * *vx + *vy * *vy + *vz * *vz;
                    if *touched != 0 && dist > d_free && v2 < v_slow2 { *fixed = 2; *vx = 0.0; *vy = 0.0; *vz = 0.0; }
                    else if sleep && *touched == 0 && dist > d_sleep && v2 < v_slow2 { *fixed = 3; *vx = 0.0; *vy = 0.0; *vz = 0.0; }
                    continue;
                }
                *contact = 1;
                *touched = 1;
                let (nx, ny, nz, pen) = (o[1], o[2], o[3], d0 - dist);
                *x += nx * pen; *y += ny * pen; *z += nz * pen;
                let (tvx, tvy, tvz) = (tv[0], tv[1], tv[2]);
                let (rvx, rvy, rvz) = (*vx - tvx, *vy - tvy, *vz - tvz);
                let vn = rvx * nx + rvy * ny + rvz * nz;
                let jn = m * (if vn < 0.0 { -vn } else { 0.0 });
                let (mut tx, mut ty, mut tz) = (rvx - vn * nx, rvy - vn * ny, rvz - vn * nz);
                let vt = js_hypot3(tx, ty, tz);
                let (mut jt, mut e_tool) = (0.0, 0.0);
                if vt > 1e-12 {
                    tx /= vt; ty /= vt; tz /= vt;
                    let fsd = if dmg[i] <= 1.0 { 1.0 } else { f64::max(0.0, 3.0 - 2.0 * dmg[i]) };
                    let tau_max = this.mat.flow_stress(ep[i], epd[i], *t) * fsd / sqrt3;
                    let mu = if mu_v { this.mat.friction_at(mu0, vt, mu_exp) } else { mu0 };
                    jt = f64::min(f64::min(m * vt, mu * jn), tau_max * area * dt);
                    let e = jt * (vt - 0.5 * jt / m);
                    *t += fw * e / (sc.mReal * c_mat);
                    e_tool = (1.0 - fw) * e;
                }
                *t -= 0.0 / (sc.mReal * c_mat);
                r[5] += 0.0 + e_tool;
                let (dpx, dpy, dpz) = (jn * nx - jt * tx, jn * ny - jt * ty, jn * nz - jt * tz);
                if vn < 0.0 { *vx -= vn * nx; *vy -= vn * ny; *vz -= vn * nz; }
                *vx -= jt / m * tx; *vy -= jt / m * ty; *vz -= jt / m * tz;
                r[0] -= dpx; r[1] -= dpy; r[2] -= dpz; r[4] += dpx * tvx + dpy * tvy + dpz * tvz;
                let (xx, yy) = (*x - this.mx - sc.ax, *y - sc.ay);
                r[3] -= xx * dpy - yy * dpx;
            }
            r
        }).collect();
        let mut s = [0.0f64; 7];
        for r in parts { for k in 0..7 { s[k] += r[k]; } }
        self.n_dead += s[6] as u64;
        for k in 0..4 { self.imp[k] += s[k]; }
        self.imp_t += dt; self.work_in += s[4];
        self.heat_tool += s[5];
        self.t += dt; self.steps += 1;
        if self.progress() >= 1.0 { self.done = true; }
    }

    pub fn step_sample(&mut self) {
        // A sampling step keeps the positions the pairs were evaluated at, for the chip analysis.
        let pn = self.progress_at(self.t + self.sc.dt);
        self.want_snap = self.cfg.fracture && (pn - self.last_sample >= 1.0 / 100.0 || pn >= 1.0);
        self.step();
        let p = self.progress();
        if p - self.last_sample >= 1.0 / 100.0 || self.done {
            let clk = std::time::Instant::now();
            self.sample();
            self.last_sample = p;
            if self.cfg.fracture { self.analyze_chips(); }
            self.prof[7] += clk.elapsed().as_secs_f64();
        }
    }

    // Force on the tool in the file's axes and the spindle torque (resisting the spin, N·m).
    fn sample(&mut self) {
        if self.imp_t <= 0.0 { return; }
        let (im, tt) = (self.imp, self.imp_t);
        let f = [im[0] / tt, im[1] / tt, im[2] / tt];
        let mz = -self.sc.sg * im[3] / tt;
        self.imp = [0.0; 4]; self.imp_t = 0.0;
        let tmax = self.max_temp();
        let h = &mut self.hist;
        h.axis.push(if self.motion == Motion::Linear { self.mx * 1e3 } else { self.ang.abs() / DEG });
        h.fc.push(f[0]); h.ft.push(f[1]); h.fr.push(f[2]); h.mz.push(mz); h.tmax.push(tmax);
    }

    pub fn max_temp(&self) -> f64 {
        (0..self.n).into_par_iter().filter(|&i| self.dead[i] == 0).map(|i| self.temp[i]).reduce(|| f64::NEG_INFINITY, f64::max)
    }

    // Chip pieces: groups of intact particles closer than 1.6 Δx; a group with no held particle has
    // broken off, and once it is clear of the tool it is removed.
    fn analyze_chips(&mut self) {
        let n = self.n;
        let mut par: Vec<u32> = (0..n as u32).collect();
        fn find(par: &mut [u32], mut i: usize) -> usize {
            while par[i] as usize != i { par[i] = par[par[i] as usize]; i = par[i] as usize; }
            i
        }
        let r2 = (1.6 * self.sc.dx) * (1.6 * self.sc.dx);
        // The pairs as they were evaluated this step: held ones as stored, moving ones at the
        // positions before the integration.
        let snap = self.snap.take();
        let (sx, sy, sz, sf) = snap.as_ref().map_or((&self.x, &self.y, &self.z, &self.fixed), |s| (&s.0, &s.1, &s.2, &s.3));
        let fp = &self.fixp;
        let link = |i: usize, j: usize, t: &[f64; 8], par: &mut Vec<u32>| {
            if self.dmg[i] >= 1.5 || self.dmg[j] >= 1.5 || self.dead[i] != 0 || self.dead[j] != 0 { return; }
            if t[0] * t[0] + t[1] * t[1] + t[2] * t[2] > r2 { return; }
            let (a, b) = (find(par, i), find(par, j));
            if a != b { par[a] = b as u32; }
        };
        for k in 0..fp.i.len() { link(fp.i[k] as usize, fp.j[k] as usize, &fp.t[k], &mut par); }
        let mp = &self.movp;
        for k in 0..mp.i.len() {
            let (i, j) = (mp.i[k] as usize, mp.j[k] as usize);
            if sf[i] >= 2 && sf[j] >= 2 { continue; }
            if let Some(t) = Self::kernel(sx, sy, sz, self.sc.hk, self.sc.ad, i, j) { link(i, j, &t, &mut par); }
        }
        // Groups by root: count, centroid sums, held flag.
        let mut gid = vec![u32::MAX; n];
        let mut groups: Vec<(usize, f64, f64, f64, bool)> = Vec::new();
        let mut members: Vec<u32> = vec![u32::MAX; n];
        for i in 0..n {
            if self.dead[i] != 0 { continue; }
            let r = find(&mut par, i);
            if gid[r] == u32::MAX { gid[r] = groups.len() as u32; groups.push((0, 0.0, 0.0, 0.0, false)); }
            let g = &mut groups[gid[r] as usize];
            g.0 += 1; g.1 += self.x[i]; g.2 += self.y[i]; g.3 += self.z[i];
            if self.fixed[i] != 0 { g.4 = true; }
            members[i] = gid[r];
        }
        let r_evac = f64::max(1.2e-3, 12.0 * self.sc.h);
        let lim = f64::max(0.3e-3, 30.0 * self.sc.dx);
        let mut pieces = 0;
        let mut gone = vec![false; groups.len()];
        for (g, e) in groups.iter().enumerate() {
            if e.4 { continue; }
            if e.0 >= 6 { pieces += 1; }
            let nn = e.0 as f64;
            let d = if self.tool_at(e.1 / nn, e.2 / nn, e.3 / nn).0[0] > lim { f64::INFINITY } else { 0.0 };
            if d > r_evac { gone[g] = true; self.n_evac += e.0 as u64; }
        }
        for i in 0..n { if members[i] != u32::MAX && gone[members[i] as usize] { self.dead[i] = 2; } }
        self.pieces = pieces;
        self.failed = (0..n).filter(|&i| self.dead[i] == 0 && self.dmg[i] >= 1.0).count();
    }

    pub fn pairs(&self) -> (usize, usize) { (self.fixp.i.len(), (0..self.movp.i.len()).filter(|&k| self.moving(self.movp.i[k] as usize, self.movp.j[k] as usize).is_some()).count()) }
    pub fn rpm(&self) -> f64 { self.sc.om * 60.0 / (2.0 * PI) }
    pub fn angle_deg(&self) -> f64 { self.ang.abs() / DEG }
    pub fn travel_mm(&self) -> f64 { self.mx * 1e3 }
    pub fn is_drill(&self) -> bool { self.motion == Motion::Drill }
    pub fn hypot2(a: f64, b: f64) -> f64 { js_hypot2(a, b) }
}
