//! Milling coefficients from the FEM for one material:
//!   cargo run --release --example coefs -- [material] [vc m/min] [rake °] [helix °] [μ] [h1,h2,...]
use chipfem::coefs::milling_coefs;
use chipfem::cutting::CutParams;
use chipfem::Material;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let key = a.get(1).map(String::as_str).unwrap_or("S50C");
    let vc: f64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(200.0);
    let rake: f64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let helix: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(30.0);
    let mu: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(0.6);
    let hs: Vec<f64> = a.get(6).map(|s| s.split(',').filter_map(|v| v.parse().ok()).collect()).unwrap_or(vec![0.09, 0.12, 0.16, 0.2]);
    let mat = Material::preset(key).expect("material");
    let mut base = CutParams::new(vc, 0.1, rake);
    base.mu = mu;
    let t0 = std::time::Instant::now();
    let r = milling_coefs(&mat, &base, &hs, helix, |k, n, row, _| {
        println!("  run {}/{}: h {:.3} mm → Fc {:.1} Ft {:.1} N/mm, chip {:.3} mm, Tmax {:.0} °C  [{:.0} s]", k + 1, n, row.h, row.fc, row.ft, row.chip, row.t_max, t0.elapsed().as_secs_f64());
        true
    })
    .unwrap();
    println!("\n   h      τs[MPa]  φ[°]   λ[°]   Ktc    Krc    Kac   Fc ±%  steady");
    for q in &r.rows {
        println!("  {:.3}  {:7.0}  {:5.1}  {:5.1}  {:5.0}  {:5.0}  {:5.0}  {:5.1}  {}", q.h, q.tau_s, q.phi.to_degrees(), q.lambda.to_degrees(), q.ktc, q.krc, q.kac, q.fc_cv * 100.0, q.steady);
    }
    println!("\n{key} Vc {vc} m/min, rake {rake}°, helix {helix}°, μ {mu}: Ktc {:.0} Krc {:.0} Kac {:.0} N/mm² (at h 0.05), Kte {:.1} Kre {:.1} N/mm, mc {:.3}; line fits R² {:.3} / {:.3}  [{:.0} s]",
        r.ktc, r.krc, r.kac, r.kte, r.kre, r.mc, r.r2[0], r.r2[1], t0.elapsed().as_secs_f64());
}
