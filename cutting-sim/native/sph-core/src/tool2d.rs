// Cutting edge section of src/tool.js: the rounded wedge (rake and clearance faces, edge radius)
// or a polygon outline with its bucket grid (built on the JS side). Signed distance in the local
// frame (u along the cutting direction, w up the rake face).
use serde::Deserialize;
use crate::util::js_hypot2;

#[derive(Deserialize)]
pub struct Poly {
    pub n: usize, pub g: f64, pub gu: f64, pub gw: f64, pub nu: i64, pub nw: i64,
    pub ax: Vec<f64>, pub ay: Vec<f64>, pub dx: Vec<f64>, pub dy: Vec<f64>, pub l2: Vec<f64>,
    pub nx: Vec<f64>, pub ny: Vec<f64>, pub vnx: Vec<f64>, pub vny: Vec<f64>,
    pub start: Vec<u32>, pub seg: Vec<u32>, pub inside: Vec<u8>,
}

#[derive(Deserialize)]
pub struct Wedge {
    pub r: f64, pub u1x: f64, pub u1y: f64, pub u2x: f64, pub u2y: f64, pub n1x: f64, pub n1y: f64, pub n2x: f64, pub n2y: f64,
    pub poly: Option<Poly>,
}

impl Wedge {
    // Signed distance and outward normal [d, nu, nw] at a local point.
    pub fn sdf(&self, ru: f64, rw: f64) -> [f64; 3] {
        if let Some(p) = &self.poly { return poly_sdf(p, ru, rw); }
        let d1 = ru * self.n1x + rw * self.n1y;
        let d2 = ru * self.n2x + rw * self.n2y;
        if d1 <= 0.0 && d2 <= 0.0 {
            return if d1 > d2 { [d1 - self.r, self.n1x, self.n1y] } else { [d2 - self.r, self.n2x, self.n2y] };
        }
        let mut s1 = ru * self.u1x + rw * self.u1y; if s1 < 0.0 { s1 = 0.0; }
        let mut s2 = ru * self.u2x + rw * self.u2y; if s2 < 0.0 { s2 = 0.0; }
        let (ax, ay, bx, by) = (ru - s1 * self.u1x, rw - s1 * self.u1y, ru - s2 * self.u2x, rw - s2 * self.u2y);
        let (la, lb) = (js_hypot2(ax, ay), js_hypot2(bx, by));
        if la < lb { [la - self.r, ax / la, ay / la] } else { [lb - self.r, bx / lb, by / lb] }
    }
}

fn poly_sdf(p: &Poly, u: f64, w: f64) -> [f64; 3] {
    let g = p.g;
    let i = ((u - p.gu) / g).floor() as i64;
    let j = ((w - p.gw) / g).floor() as i64;
    let in_grid = i >= 0 && j >= 0 && i < p.nu && j < p.nw;
    let k = (i + j * p.nu) as usize;
    let (mut a, mut b, mut list) = (0usize, p.n, false);
    if in_grid {
        a = p.start[k] as usize; b = p.start[k + 1] as usize; list = true;
        if a == b {
            if p.inside[k] == 0 { return [g, 0.0, 0.0]; }
            a = 0; b = p.n; list = false;
        }
    }
    let (mut best, mut bs, mut bt) = (f64::INFINITY, 0usize, 0.0);
    for q in a..b {
        let s = if list { p.seg[q] as usize } else { q };
        let (ex, ew) = (u - p.ax[s], w - p.ay[s]);
        let mut tt = (ex * p.dx[s] + ew * p.dy[s]) / p.l2[s];
        tt = if tt < 0.0 { 0.0 } else if tt > 1.0 { 1.0 } else { tt };
        let (rx, ry) = (ex - tt * p.dx[s], ew - tt * p.dy[s]);
        let d2 = rx * rx + ry * ry;
        if d2 < best { best = d2; bs = s; bt = tt; }
    }
    let s = bs;
    let (cx, cy) = (p.ax[s] + bt * p.dx[s], p.ay[s] + bt * p.dy[s]);
    let (nx, ny) = if bt <= 0.0 { (p.vnx[s], p.vny[s]) } else if bt >= 1.0 { let v = (s + 1) % p.n; (p.vnx[v], p.vny[v]) } else { (p.nx[s], p.ny[s]) };
    let (rx, ry, d) = (u - cx, w - cy, best.sqrt());
    let mut sign = if rx * nx + ry * ny >= 0.0 { 1.0 } else { -1.0 };
    if in_grid && d > g { sign = if p.inside[k] != 0 { -1.0 } else { 1.0 }; }
    if d > 1e-12 { [sign * d, sign * rx / d, sign * ry / d] } else { [sign * d, nx, ny] }
}
