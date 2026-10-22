// The solver behind the UI: set up from the JS state (src/native.js sends it), stepped for a slice
// of wall time at a time, each slice answered with a binary frame that the worker (src/worker.js,
// 'nativeFrame') copies into its own Cutting3D so that the views and the summary stay the JS ones.
//
// Frame layout, little-endian:
//   f64 × 16  header: 1 (version), steps, t, done, nDead, nEvac, heatTool, workIn, pieces, failed,
//             nHist, N, threads, ms per step, bricks, flags (1: a tool heat block follows, 2: a mill block)
//   f64 × 11·nHist  history: axis, fc, ft, fr, mz, tmax, ttool, flow, area, len, pass (NaN: none)
//   f64 × 12·N  x, y, z, vx, vy, vz, T, seq, ep, sr, p, dmg
//   tool heat (oblique cutting, helix): f64 aTime, f64 × cells T, f64 × 6·surface cells aQ, aQin, aH, aHT, aFn, aFV
//   mill (helix): f64 tooth k, f64 its start time tk
//   u8 × 3·N   fixed, contact, dead (padded to 8 bytes)
use crate::sim::{Dump, Sim};
use std::time::Instant;

pub struct Engine { pub sim: Option<Sim>, run_s: f64, run_steps: u64 }

impl Default for Engine { fn default() -> Self { Engine { sim: None, run_s: 0.0, run_steps: 0 } } }

impl Engine {
    pub fn init(&mut self, json: &[u8]) -> Result<usize, String> {
        let d: Dump = serde_json::from_slice(json).map_err(|e| format!("状態を読めませんでした: {e}"))?;
        let s = Sim::new(d);
        let n = s.n;
        self.sim = Some(s); self.run_s = 0.0; self.run_steps = 0;
        Ok(n)
    }

    // Steps for about `ms` of wall time (at least one step) and returns the frame.
    pub fn run(&mut self, ms: f64) -> Result<Vec<u8>, String> {
        let s = self.sim.as_mut().ok_or("初期化されていません")?;
        let t0 = Instant::now();
        let mut k = 0u64;
        while !s.done && (k == 0 || t0.elapsed().as_secs_f64() * 1e3 < ms) { s.step_sample(); k += 1; }
        self.run_s += t0.elapsed().as_secs_f64(); self.run_steps += k;
        Ok(self.frame())
    }

    pub fn frame(&self) -> Vec<u8> {
        let s = self.sim.as_ref().unwrap();
        let (n, h) = (s.n, &s.hist);
        let nh = h.fc.len();
        let mut out: Vec<u8> = Vec::with_capacity(8 * (16 + 11 * nh + 12 * n) + 3 * n + 8);
        let mut put = |v: f64| out.extend_from_slice(&v.to_le_bytes());
        let ms = if self.run_steps > 0 { 1e3 * self.run_s / self.run_steps as f64 } else { 0.0 };
        for v in [1.0, s.steps as f64, s.t, s.done as u8 as f64, s.n_dead as f64, s.n_evac as f64, s.heat_tool, s.work_in, s.pieces as f64, s.failed as f64,
            nh as f64, n as f64, rayon::current_num_threads() as f64, ms, s.sdf.as_ref().map_or(0, |m| m.bricks_built()) as f64, (s.heat.is_some() as u8 + 2 * s.mill.is_some() as u8) as f64] { put(v); }
        for a in [&h.axis, &h.fc, &h.ft, &h.fr, &h.mz, &h.tmax, &h.ttool, &h.flow, &h.area, &h.len, &h.pass] { for &v in a.iter() { put(v); } }
        for a in [&s.x, &s.y, &s.z, &s.vx, &s.vy, &s.vz, &s.temp, &s.seq, &s.ep, &s.sr, &s.p, &s.dmg] { for &v in a.iter() { put(v); } }
        if let Some(ht) = &s.heat {
            put(ht.a_time);
            for a in [&ht.t, &ht.a_q, &ht.a_qin, &ht.a_h, &ht.a_ht, &ht.a_fn, &ht.a_fv] { for &v in a.iter() { put(v); } }
        }
        if let Some(m) = &s.mill { put(m.k as f64); put(m.tk); }
        for a in [&s.fixed, &s.contact, &s.dead] { out.extend_from_slice(a); }
        while out.len() % 8 != 0 { out.push(0); }
        out
    }
}
