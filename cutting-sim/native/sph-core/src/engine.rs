// The solver behind the UI: set up from the JS state (src/native.js sends it), stepped for a slice
// of wall time at a time, each slice answered with a binary frame that the worker (src/worker.js,
// 'nativeFrame') copies into its own Cutting3D so that the views and the summary stay the JS ones.
//
// Frame layout, little-endian:
//   f64 × 16  header: 1 (version), steps, t, done, nDead, nEvac, heatTool, workIn, pieces, failed,
//             nHist, N, threads, ms per step, bricks, flags (1: a tool heat block follows, 2: a mill block,
//             4: computed on the GPU)
//   f64 × 11·nHist  history: axis, fc, ft, fr, mz, tmax, ttool, flow, area, len, pass (NaN: none)
//   f64 × 12·N  x, y, z, vx, vy, vz, T, seq, ep, sr, p, dmg
//   tool heat (oblique cutting, helix): f64 aTime, f64 × cells T, f64 × 6·surface cells aQ, aQin, aH, aHT, aFn, aFV
//   mill (helix): f64 tooth k, f64 its start time tk
//   u8 × 3·N   fixed, contact, dead (padded to 8 bytes)
use crate::sim::{Dump, Sim};
use std::time::Instant;

pub struct Engine {
    pub sim: Option<Sim>,
    // STL mode on the GPU when there is one (and SPH_GPU is not 0); the GPU's run holds the Sim.
    #[cfg(feature = "gpu")]
    pub gpu: Option<crate::sim::gpusim::GpuSim>,
    // Why the GPU is not used (none found, another mode, switched off), for the page.
    pub gpu_note: String,
    run_s: f64, run_steps: u64,
}

impl Default for Engine {
    fn default() -> Self { Engine { sim: None, #[cfg(feature = "gpu")] gpu: None, gpu_note: String::new(), run_s: 0.0, run_steps: 0 } }
}

impl Engine {
    pub fn init(&mut self, json: &[u8]) -> Result<usize, String> {
        let d: Dump = serde_json::from_slice(json).map_err(|e| format!("状態を読めませんでした: {e}"))?;
        let s = Sim::new(d);
        let n = s.n;
        self.run_s = 0.0; self.run_steps = 0;
        self.gpu_note.clear();
        #[cfg(feature = "gpu")]
        {
            self.gpu = None;
            let off = std::env::var("SPH_GPU").map_or(false, |v| v == "0");
            if off { self.gpu_note = "GPU は使わない設定です（SPH_GPU=0）".into(); }
            else if s.sdf.is_none() { self.gpu_note = "GPU 計算は今は STL 取り込みモードだけです".into(); }
            else {
                match crate::sim::gpusim::GpuSim::new(s) {
                    Ok(g) => { self.gpu = Some(g); self.sim = None; return Ok(n); }
                    Err(e) => {
                        // The GPU run took the state: set it up again for the CPU.
                        self.gpu_note = e;
                        let d: Dump = serde_json::from_slice(json).map_err(|e| format!("状態を読めませんでした: {e}"))?;
                        self.sim = Some(Sim::new(d));
                        return Ok(n);
                    }
                }
            }
        }
        self.sim = Some(s);
        Ok(n)
    }

    pub fn on_gpu(&self) -> bool {
        #[cfg(feature = "gpu")]
        { return self.gpu.is_some(); }
        #[cfg(not(feature = "gpu"))]
        false
    }
    // The GPU's name, or empty.
    pub fn gpu_name(&self) -> String {
        #[cfg(feature = "gpu")]
        { return self.gpu.as_ref().map_or(String::new(), |g| g.adapter.clone()); }
        #[cfg(not(feature = "gpu"))]
        String::new()
    }
    fn state(&self) -> &Sim {
        #[cfg(feature = "gpu")]
        { if let Some(g) = &self.gpu { return &g.s; } }
        self.sim.as_ref().unwrap()
    }

    // Steps for about `ms` of wall time (at least one step) and returns the frame.
    pub fn run(&mut self, ms: f64) -> Result<Vec<u8>, String> {
        let t0 = Instant::now();
        let mut k = 0u64;
        #[cfg(feature = "gpu")]
        if let Some(g) = self.gpu.as_mut() {
            while !g.s.done && (k == 0 || t0.elapsed().as_secs_f64() * 1e3 < ms) { g.step_sample(); k += 1; }
            self.run_s += t0.elapsed().as_secs_f64(); self.run_steps += k;
            g.download_particles();
            return Ok(self.frame());
        }
        let s = self.sim.as_mut().ok_or("初期化されていません")?;
        while !s.done && (k == 0 || t0.elapsed().as_secs_f64() * 1e3 < ms) { s.step_sample(); k += 1; }
        self.run_s += t0.elapsed().as_secs_f64(); self.run_steps += k;
        Ok(self.frame())
    }

    pub fn frame(&self) -> Vec<u8> {
        let s = self.state();
        let (n, h) = (s.n, &s.hist);
        let nh = h.fc.len();
        let mut out: Vec<u8> = Vec::with_capacity(8 * (16 + 11 * nh + 12 * n) + 3 * n + 8);
        let mut put = |v: f64| out.extend_from_slice(&v.to_le_bytes());
        let ms = if self.run_steps > 0 { 1e3 * self.run_s / self.run_steps as f64 } else { 0.0 };
        for v in [1.0, s.steps as f64, s.t, s.done as u8 as f64, s.n_dead as f64, s.n_evac as f64, s.heat_tool, s.work_in, s.pieces as f64, s.failed as f64,
            nh as f64, n as f64, rayon::current_num_threads() as f64, ms, s.sdf.as_ref().map_or(0, |m| m.bricks_built()) as f64, (s.heat.is_some() as u8 + 2 * s.mill.is_some() as u8 + 4 * self.on_gpu() as u8) as f64] { put(v); }
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
