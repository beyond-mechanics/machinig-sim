//! The rigid cutting tool of orthogonal cutting: a wedge with a rounded cutting edge.
//! The work lies at y ≤ 0 with its free surface at y = 0 and the tool moves along −x at the
//! cutting speed, its rake face facing −x (the uncut material); the chip flows up the rake face.
//! Geometry about the centre `c` of the edge radius `re`:
//!   rake face: direction t_r = (sin α, cos α) from the edge (α: rake angle, positive leans back),
//!              outward normal n_r = (−cos α, sin α)
//!   clearance face: direction t_c = (cos γ, sin γ) (γ: clearance angle), outward normal
//!              n_c = (sin γ, −cos γ)
//! The tool body is the inner sharp wedge (apex c, faces offset inward by re) grown by a disc of
//! radius re, so its signed distance is the inner wedge's minus re.

#[derive(Clone, Debug)]
pub struct Tool {
    /// rake and clearance angles [rad], edge radius [mm]
    pub rake: f64,
    pub clearance: f64,
    pub re: f64,
    /// centre of the edge radius [mm] (moves with the tool)
    pub c: [f64; 2],
    /// tool velocity [mm/s]
    pub v: [f64; 2],
    /// Coulomb friction coefficient on the tool faces
    pub mu: f64,
    /// share of the friction heat that goes into the work (the rest into the tool)
    pub heat_share: f64,
}

pub struct Contact {
    /// penetration depth [mm] (> 0 inside the tool)
    pub depth: f64,
    /// outward unit normal of the tool surface at the closest point
    pub n: [f64; 2],
}

impl Tool {
    fn faces(&self) -> ([f64; 2], [f64; 2], [f64; 2], [f64; 2]) {
        let (sa, ca) = self.rake.sin_cos();
        let (sg, cg) = self.clearance.sin_cos();
        ([sa, ca], [-ca, sa], [cg, sg], [sg, -cg])
    }

    /// the tool's lowest point (the tip of the rounded edge seen along −y): where the uncut chip
    /// thickness is measured from
    pub fn tip_y(&self) -> f64 {
        self.c[1] - self.re
    }

    /// penetration of point p into the tool, if any
    pub fn contact(&self, p: [f64; 2]) -> Option<Contact> {
        let (tr, nr, tc, nc) = self.faces();
        let q = [p[0] - self.c[0], p[1] - self.c[1]];
        let d1 = q[0] * nr[0] + q[1] * nr[1];
        let d2 = q[0] * nc[0] + q[1] * nc[1];
        // the region beyond the rake face's far end or under the clearance face's far end is
        // not limited here: the faces run on (the tool is long compared with the chip)
        if d1 <= 0.0 && d2 <= 0.0 {
            // inside the inner wedge: deeper than re below the nearer face
            let (d, n) = if d1 > d2 { (d1, nr) } else { (d2, nc) };
            return Some(Contact { depth: self.re - d, n });
        }
        // outside the inner wedge: distance to the nearer of its two face rays
        let ray = |t: [f64; 2]| {
            let s = (q[0] * t[0] + q[1] * t[1]).max(0.0);
            let r = [q[0] - s * t[0], q[1] - s * t[1]];
            (r[0].hypot(r[1]), r)
        };
        let (a, ra) = ray(tr);
        let (b, rb) = ray(tc);
        let (dist, r) = if a < b { (a, ra) } else { (b, rb) };
        if dist >= self.re || dist < 1e-15 {
            return None;
        }
        Some(Contact { depth: self.re - dist, n: [r[0] / dist, r[1] / dist] })
    }

    pub fn advance(&mut self, dt: f64) {
        self.c[0] += self.v[0] * dt;
        self.c[1] += self.v[1] * dt;
    }
}
