// Tool temperature grid of src/toolheat.js (set up on the JS side): interface exchange with the
// contact particles and explicit conduction. The steady field and the wear profile stay in JS,
// from the state sent back with every frame.
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ToolHeat {
    pub nu: usize, pub nw: usize, pub u0: f64, pub w0: f64, pub a: f64, pub cap: f64, pub hc: f64, #[serde(rename = "aTime")] pub a_time: f64,
    pub k: f64, pub rho: f64, pub c: f64,
    pub inside: Vec<u8>, pub dir: Vec<u8>, #[serde(rename = "T")] pub t: Vec<f64>, pub near: Vec<u32>, pub surf: Vec<u32>,
    #[serde(rename = "aQ")] pub a_q: Vec<f64>, #[serde(rename = "aQin")] pub a_qin: Vec<f64>, #[serde(rename = "aH")] pub a_h: Vec<f64>,
    #[serde(rename = "aHT")] pub a_ht: Vec<f64>, #[serde(rename = "aFn")] pub a_fn: Vec<f64>, #[serde(rename = "aFV")] pub a_fv: Vec<f64>,
}

impl ToolHeat {
    pub fn cell_of(&self, u: f64, w: f64) -> usize {
        let mut i = ((u - self.u0) / self.a).floor() as i64;
        let mut j = ((w - self.w0) / self.a).floor() as i64;
        i = if i < 0 { 0 } else if i >= self.nu as i64 { self.nu as i64 - 1 } else { i };
        j = if j < 0 { 0 } else if j >= self.nw as i64 { self.nw as i64 - 1 } else { j };
        self.near[(i + j * self.nu as i64) as usize] as usize
    }

    // Interface exchange for one contact particle over dt; returns the heat taken from it.
    #[allow(clippy::too_many_arguments)]
    pub fn contact(&mut self, q: usize, tp: f64, lc: f64, q_fric: f64, fnorm: f64, vs: f64, dt: f64, acc: bool) -> f64 {
        let k = self.surf[q] as usize;
        let h = self.hc * lc;
        let qc = h * (tp - self.t[k]) * dt;
        self.t[k] += (qc + q_fric) / self.cap;
        if acc {
            self.a_q[q] += q_fric; self.a_qin[q] += qc + q_fric; self.a_h[q] += h * dt; self.a_ht[q] += h * tp * dt;
            self.a_fn[q] += fnorm * dt; self.a_fv[q] += fnorm * vs * dt;
        }
        qc
    }

    pub fn step(&mut self, dt: f64) {
        let (nu, nw) = (self.nu, self.nw);
        let f = self.k / (self.rho * self.c) * dt / (self.a * self.a);
        let (t, inside, dir) = (&self.t, &self.inside, &self.dir);
        let mut d = vec![0.0; t.len()];
        for j in 0..nw { for i in 0..nu {
            let k = i + j * nu;
            if inside[k] == 0 || dir[k] != 0 { continue; }
            let mut s = 0.0;
            if i > 0 && inside[k - 1] != 0 { s += t[k - 1] - t[k]; }
            if i < nu - 1 && inside[k + 1] != 0 { s += t[k + 1] - t[k]; }
            if j > 0 && inside[k - nu] != 0 { s += t[k - nu] - t[k]; }
            if j < nw - 1 && inside[k + nu] != 0 { s += t[k + nu] - t[k]; }
            d[k] = f * s;
        }}
        for k in 0..self.t.len() { self.t[k] += d[k]; }
    }

    pub fn max_t(&self) -> f64 {
        let mut m = f64::NEG_INFINITY;
        for k in 0..self.t.len() { if self.inside[k] != 0 && self.t[k] > m { m = self.t[k]; } }
        m
    }
}
