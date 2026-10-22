//! Orthogonal cutting of S50C (AISI 1045) against Oxley's predictive theory as the web version
//! computes it (src/oxley.js with the same Johnson–Cook constants): Vc 200 m/min, h 0.1 mm,
//! rake 5°: Fc 195.9 N/mm, Ft 92.8 N/mm, chip 0.229 mm, shear angle 24.3°, friction angle 30.4°
//! (μ ≈ 0.59). The FEM uses μ = 0.6 and a 0.02 mm edge radius (Oxley's tool is sharp).
use chipfem::cutting::{CutParams, Cutting};
use chipfem::Material;

#[test]
fn s50c_orthogonal_cut_agrees_with_oxley() {
    let mut p = CutParams::new(200.0, 0.1, 5.0);
    p.mu = 0.6;
    p.length = 1.0;
    let mut c = Cutting::new(Material::preset("S50C").unwrap(), p);
    c.run(0.05, |_, _| true);
    let s = c.steady(0.4);
    let phi = {
        let r = 0.1 / s.chip;
        let a = 5f64.to_radians();
        (r * a.cos() / (1.0 - r * a.sin())).atan().to_degrees()
    };
    println!("FEM: Fc {:.1} Ft {:.1} N/mm, chip {:.3} mm, φ {:.1}°, Tmax {:.0} °C, {} remeshes", s.fc, s.ft, s.chip, phi, s.t_max, s.remeshes);
    assert!((s.fc / 195.9 - 1.0).abs() < 0.2, "Fc {}", s.fc);
    assert!((s.ft / 92.8 - 1.0).abs() < 0.3, "Ft {}", s.ft);
    assert!((s.chip / 0.229 - 1.0).abs() < 0.15, "chip {}", s.chip);
    assert!((phi - 24.3).abs() < 4.0, "shear angle {phi}");
    assert!(s.t_max > 500.0 && s.t_max < 1200.0, "Tmax {}", s.t_max);
    // the body stays whole: a single boundary loop with every node on an element
    assert!(c.solver.min_quality() > 0.0);
}
