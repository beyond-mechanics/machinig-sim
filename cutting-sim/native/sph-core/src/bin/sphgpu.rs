// GPU prototype benchmark: runs a state for some steps on the CPU, then times the two pair passes
// of a step on the CPU and on the GPU from the same state and compares the results.
// sphgpu <state.json> [--warm N] [--iters N] [--threads T]
use serde_json::json;
use sph_core::sim::{Dump, Sim};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: sphgpu <state.json> [--warm N] [--iters N] [--threads T]");
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let warm: u64 = opt("--warm").map_or(200, |v| v.parse().unwrap());
    let iters: usize = opt("--iters").map_or(20, |v| v.parse().unwrap());
    if let Some(t) = opt("--threads") { rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap(); }
    let d: Dump = serde_json::from_slice(&std::fs::read(path).expect("read state")).expect("parse state");
    let mut s = Sim::new(d);
    for _ in 0..warm { if s.done { break; } s.step_sample(); }
    match sph_core::gpu::bench(&mut s, iters) {
        Ok(r) => println!("{}", serde_json::to_string_pretty(&json!({
            "adapter": r.adapter, "backend": r.backend, "particles": r.n, "entries": r.entries, "heldPairs": r.held,
            "threads": rayon::current_num_threads(), "steps": s.steps,
            "cpuMs": r.cpu_ms, "gpuMs": r.gpu_ms, "speedup": r.cpu_ms / r.gpu_ms,
            "uploadMs": r.upload_ms, "downloadMs": r.download_ms,
            "relErr": { "L": r.err_l, "M": r.err_m, "drho": r.err_drho, "acc": r.err_acc, "xsph": r.err_xsph },
        })).unwrap()),
        Err(e) => { eprintln!("{e}"); std::process::exit(2); }
    }
}
