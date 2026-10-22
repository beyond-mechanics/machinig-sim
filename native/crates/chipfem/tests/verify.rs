//! Verification of the solver core against closed-form answers.
use chipfem::{Bc, Material, Mesh, Solver, Tool};

fn steel_no_rate() -> Material {
    let mut m = Material::preset("S50C").unwrap();
    m.jc.c = 0.0;
    m
}

/// Plane-strain compression between frictionless platens: homogeneous, so
///   ε_eq = (2/√3)|ln(h/h0)|,  |σ_yy| = (2/√3)·σ_y(ε_eq)
/// and, adiabatic with β = 1, the heat stored equals the plastic work.
#[test]
fn plane_strain_compression_follows_johnson_cook() {
    let mut mat = steel_no_rate();
    mat.beta = 1.0;
    mat.k = 0.0; // adiabatic
    // softening off for the stress check: melting point far away
    mat.jc.t_melt = 1e9;
    let mesh = Mesh::rect(0.0, 0.0, 1.0, 1.0, 10, 10, None);
    let n = mesh.x.len();
    let mut s = Solver::new(mat.clone(), mesh, 20.0);
    s.set_mass_scale(1e4);
    let v = 100.0; // mm/s
    for i in 0..n {
        let p = s.mesh.x[i];
        if p[1] < 1e-9 {
            s.bcs.push(Bc { node: i, dof: 1, vel: 0.0 });
        }
        if p[1] > 1.0 - 1e-9 {
            s.bcs.push(Bc { node: i, dof: 1, vel: -v });
        }
        if p[0] < 1e-9 && p[1] < 1e-9 {
            s.bcs.push(Bc { node: i, dof: 0, vel: 0.0 });
        }
    }
    let top: Vec<usize> = (0..n).filter(|&i| s.mesh.x[i][1] > 1.0 - 1e-9).collect();
    let mut checked = 0;
    let mut worst: f64 = 0.0;
    for target in [0.05, 0.1, 0.2, 0.3] {
        while 1.0 - s.mesh.x[top[0]][1] < target {
            s.step();
        }
        let h = s.mesh.x[top[0]][1];
        let width = top.iter().map(|&i| s.mesh.x[i][0]).fold(f64::MIN, f64::max) - top.iter().map(|&i| s.mesh.x[i][0]).fold(f64::MAX, f64::min);
        let fy: f64 = top.iter().map(|&i| s.fint[i][1]).sum();
        let sigma = -fy / width; // compressive stress on the top face (the platen pushes down)
        let eeq = 2.0 / 3f64.sqrt() * (-h.ln());
        let expect = 2.0 / 3f64.sqrt() * mat.jc.flow(eeq, 0.0, 20.0);
        let err = (sigma / expect - 1.0).abs();
        worst = worst.max(err);
        println!("strain {target:.2}: σ = {sigma:.1} MPa, Johnson–Cook {expect:.1} MPa ({:+.2} %)", (sigma / expect - 1.0) * 100.0);
        checked += 1;
    }
    assert_eq!(checked, 4);
    assert!(worst < 0.03, "stress off by {:.1} %", worst * 100.0);
    let heat = s.heat_content(20.0);
    println!("plastic work {:.3} mJ, heat {:.3} mJ", s.plastic_work, heat);
    assert!((heat / s.plastic_work - 1.0).abs() < 1e-6);
    // the plastic work agrees with ∫σ dε over the volume (1 mm² × 1 mm), from the curve
    let h = s.mesh.x[top[0]][1];
    let e_end = 2.0 / 3f64.sqrt() * (-h.ln());
    let steps = 2000;
    let w: f64 = (0..steps).map(|k| { let e = (k as f64 + 0.5) / steps as f64 * e_end; mat.jc.flow(e, 0.0, 20.0) * e_end / steps as f64 }).sum();
    println!("∫σ_y dε_eq = {w:.3} mJ");
    assert!((s.plastic_work / w - 1.0).abs() < 0.05);
}

/// The rake face (α = 0) pushes the end of an elastic bar: plane strain with free top and
/// bottom, F = E/(1 − ν²)·(u/L)·H per mm width.
#[test]
fn rake_face_pushes_an_elastic_bar() {
    let mat = steel_no_rate();
    let (l, hgt) = (1.0, 0.5);
    let mesh = Mesh::rect(0.0, -hgt, l, hgt, 20, 10, None);
    let n = mesh.x.len();
    let mut s = Solver::new(mat.clone(), mesh, 20.0);
    s.thermal = false;
    s.set_mass_scale(1e4);
    for i in 0..n {
        let p = s.mesh.x[i];
        if p[0] < 1e-9 {
            s.bcs.push(Bc { node: i, dof: 0, vel: 0.0 });
            if p[1] < -hgt + 1e-9 {
                s.bcs.push(Bc { node: i, dof: 1, vel: 0.0 });
            }
        }
    }
    let re = 0.01;
    let v = 1.0;
    // rake face x = c.x − re starts at the bar's end; the edge is below the bar
    s.tool = Some(Tool { rake: 0.0, clearance: 0.1, re, c: [l + re, -hgt - 0.05], v: [-v, 0.0], mu: 0.0, shear_factor: None, heat_share: 0.5 });
    let u = 0.002;
    let mut fsum = 0.0;
    let mut cnt = 0;
    while s.t < u / v {
        s.step();
        if s.t > 0.9 * u / v {
            fsum += s.tool_force[0];
            cnt += 1;
        }
    }
    let f = fsum / cnt as f64;
    let ep = mat.e / (1.0 - mat.nu * mat.nu);
    let expect = ep * (0.95 * u / l) * hgt;
    println!("push: F = {f:.2} N/mm, plane-strain bar {expect:.2} N/mm ({:+.1} %)", (f / expect - 1.0) * 100.0);
    assert!((f / expect - 1.0).abs() < 0.05);
}

/// The clearance face slides along the top of a block while pressing into it: the friction
/// force is μ times the normal force.
#[test]
fn clearance_face_slides_with_coulomb_friction() {
    let mat = steel_no_rate();
    let mesh = Mesh::rect(0.0, -0.4, 2.0, 0.4, 40, 8, None);
    let n = mesh.x.len();
    let mut s = Solver::new(mat, mesh, 20.0);
    s.thermal = false;
    s.set_mass_scale(1e4);
    for i in 0..n {
        if s.mesh.x[i][1] < -0.4 + 1e-9 {
            s.bcs.push(Bc { node: i, dof: 0, vel: 0.0 });
            s.bcs.push(Bc { node: i, dof: 1, vel: 0.0 });
        }
    }
    let re = 0.02;
    let mu = 0.3;
    // flat clearance face (γ = 0) at y = c.y − re = 0, pressing down slowly and sliding along −x
    s.tool = Some(Tool { rake: 0.0, clearance: 0.0, re, c: [0.6, re], v: [-20.0, -0.5], mu, shear_factor: None, heat_share: 0.5 });
    let mut fx = 0.0;
    let mut fy = 0.0;
    while s.t < 0.004 {
        s.step();
        if s.t > 0.002 {
            fx += s.tool_force[0];
            fy += s.tool_force[1];
        }
    }
    println!("slide: friction {fx:.1}, normal {fy:.1} (sums), ratio {:.3}, μ {mu}", (fx / fy).abs());
    assert!(fy > 0.0, "the block pushes the tool up");
    assert!(((fx / fy).abs() / mu - 1.0).abs() < 0.08);
    assert!(fx > 0.0, "friction drags the tool back along +x");
    assert!(s.friction_work > 0.0);
}
