// Runs a state written by native/scripts/dump.mjs to the end (or for a number of steps) and writes
// the force history, a summary and, on request, the final particle state.
// sphcli <state.json> [--steps N] [--threads T] [--out result.json] [--state final.json]
use serde_json::json;
use sph_core::sim::{Dump, Sim};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: sphcli <state.json> [--steps N] [--threads T] [--out result.json] [--state final.json]");
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let max_steps: u64 = opt("--steps").map_or(u64::MAX, |v| v.parse().unwrap());
    if let Some(t) = opt("--threads") { rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap(); }
    let t0 = Instant::now();
    let d: Dump = serde_json::from_slice(&std::fs::read(path).expect("read state")).expect("parse state");
    let mut s = Sim::new(d);
    let load = t0.elapsed().as_secs_f64();
    let t1 = Instant::now();
    let mut k = 0u64;
    let mut last = Instant::now();
    while !s.done && k < max_steps {
        s.step_sample();
        k += 1;
        if last.elapsed().as_secs_f64() > 10.0 {
            last = Instant::now();
            eprintln!("step {} progress {:.1}% {:.1} ms/step", s.steps, 100.0 * s.progress(), 1e3 * t1.elapsed().as_secs_f64() / k as f64);
        }
    }
    let run = t1.elapsed().as_secs_f64();
    // Means as the JS summary: a drill over the last quarter of the samples, otherwise where |F| is
    // at least a tenth of its peak.
    let h = &s.hist;
    let mag: Vec<f64> = (0..h.fc.len()).map(|i| (h.fc[i] * h.fc[i] + h.ft[i] * h.ft[i] + h.fr[i] * h.fr[i]).sqrt()).collect();
    let pk = mag.iter().cloned().fold(0.0, f64::max);
    let n0 = (0.75 * mag.len() as f64).floor() as usize;
    let on: Vec<bool> = (0..mag.len()).map(|i| if s.is_drill() { i >= n0 } else { pk > 0.0 && mag[i] >= 0.1 * pk }).collect();
    let mean = |a: &[f64]| { let (mut t, mut c) = (0.0, 0); for i in 0..a.len() { if on[i] { t += a[i]; c += 1; } } if c > 0 { t / c as f64 } else { 0.0 } };
    let (fp, mp) = s.pairs();
    let out = json!({
        "steps": s.steps, "stepsRun": k, "done": s.done, "progress": s.progress(), "N": s.n,
        "loadS": load, "runS": run, "msPerStep": 1e3 * run / k.max(1) as f64, "threads": rayon::current_num_threads(),
        "searches": s.searches, "profMs": s.prof.iter().map(|v| 1e3 * v / k.max(1) as f64).collect::<Vec<_>>(), "pairsHeld": fp, "pairsMoving": mp, "bricks": s.sdf.bricks_built(),
        "summary": { "fx": mean(&h.fc), "fy": mean(&h.ft), "fz": mean(&h.fr), "torque": mean(&h.mz), "tmax": s.max_temp(),
            "rpm": s.rpm(), "angle": s.angle_deg(), "travel": s.travel_mm(), "pieces": s.pieces, "failed": s.failed, "evacuated": s.n_evac, "dead": s.n_dead },
        "hist": h,
    });
    let o = opt("--out").unwrap_or_else(|| "result.json".into());
    std::fs::write(&o, serde_json::to_string(&out).unwrap()).unwrap();
    eprintln!("{} steps in {:.1} s ({:.2} ms/step, {} threads) -> {}", k, run, 1e3 * run / k.max(1) as f64, rayon::current_num_threads(), o);
    if let Some(f) = opt("--state") {
        let st = json!({ "x": s.x, "y": s.y, "z": s.z, "vx": s.vx, "vy": s.vy, "vz": s.vz, "rho": s.rho, "p": s.p, "T": s.temp, "ep": s.ep, "dmg": s.dmg,
            "sxx": s.s[0], "sxy": s.s[3], "fixed": s.fixed, "dead": s.dead });
        std::fs::write(f, serde_json::to_string(&st).unwrap()).unwrap();
    }
}
