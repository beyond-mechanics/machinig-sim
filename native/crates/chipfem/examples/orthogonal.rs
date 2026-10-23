//! Orthogonal cutting run from the command line:
//!   cargo run --release --example orthogonal -- [material] [vc m/min] [h mm] [rake °] [length mm] [out.svg] [μ]
//! Prints the forces, chip thickness and temperature as the cut proceeds and writes the
//! temperature and plastic strain fields at the end as an SVG.
use chipfem::cutting::{CutParams, Cutting};
use chipfem::Material;
use std::fmt::Write as _;

fn colour(t: f64) -> String {
    // dark blue → cyan → yellow → red
    let stops = [(0.0, [20.0, 30.0, 110.0]), (0.35, [30.0, 170.0, 200.0]), (0.7, [250.0, 220.0, 60.0]), (1.0, [210.0, 40.0, 30.0])];
    let t = t.clamp(0.0, 1.0);
    let k = stops.iter().position(|s| s.0 >= t).unwrap_or(3).max(1);
    let (a, b) = (stops[k - 1], stops[k]);
    let f = (t - a.0) / (b.0 - a.0);
    let c: Vec<u8> = (0..3).map(|i| (a.1[i] + f * (b.1[i] - a.1[i])) as u8).collect();
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn field_svg(c: &Cutting, vals: &[f64], vmax: f64, title: &str, ox: f64, oy: f64, scale: f64, out: &mut String) {
    let m = &c.solver.mesh;
    let tool = c.solver.tool.as_ref().unwrap();
    // window around the edge
    let (x0, y1) = (tool.c[0] - 6.0 * c.p.h, tool.c[1] + 5.0 * c.p.h);
    let tx = |p: [f64; 2]| (ox + (p[0] - x0) * scale, oy + (y1 - p[1]) * scale);
    writeln!(out, "<text x='{ox}' y='{}' font-size='13' font-family='sans-serif'>{title}</text>", oy - 6.0).unwrap();
    for (e, t) in m.tri.iter().enumerate() {
        let pts: Vec<(f64, f64)> = t.iter().map(|&i| tx(m.x[i])).collect();
        if pts.iter().any(|p| p.0 < ox - 1.0 || p.0 > ox + 9.0 * c.p.h * scale || p.1 < oy - 1.0 || p.1 > oy + 9.0 * c.p.h * scale) {
            continue;
        }
        let col = colour(vals[e] / vmax);
        writeln!(out, "<polygon points='{:.1},{:.1} {:.1},{:.1} {:.1},{:.1}' fill='{col}' stroke='{col}' stroke-width='0.3'/>", pts[0].0, pts[0].1, pts[1].0, pts[1].1, pts[2].0, pts[2].1).unwrap();
    }
    // the tool outline: rake face, edge arc, clearance face
    let (sa, ca) = tool.rake.sin_cos();
    let (sg, cg) = tool.clearance.sin_cos();
    let r = tool.re;
    let nr = [-ca, sa];
    let nc = [sg, -cg];
    let a0 = nr[1].atan2(nr[0]);
    let mut a1 = nc[1].atan2(nc[0]);
    if a1 > a0 {
        a1 -= 2.0 * std::f64::consts::PI;
    }
    let mut path = Vec::new();
    let top = [tool.c[0] + r * nr[0] + 8.0 * c.p.h * sa, tool.c[1] + r * nr[1] + 8.0 * c.p.h * ca];
    path.push(tx(top));
    for k in 0..=12 {
        let a = a0 + (a1 - a0) * k as f64 / 12.0;
        path.push(tx([tool.c[0] + r * a.cos(), tool.c[1] + r * a.sin()]));
    }
    path.push(tx([tool.c[0] + r * nc[0] + 5.0 * c.p.h * cg, tool.c[1] + r * nc[1] + 5.0 * c.p.h * sg]));
    let d: Vec<String> = path.iter().map(|p| format!("{:.1},{:.1}", p.0, p.1)).collect();
    writeln!(out, "<polygon points='{}' fill='#9aa3ad' stroke='#333' stroke-width='1'/>", d.join(" ")).unwrap();
    // the rounded edge itself (the polygon above only runs along its outside)
    let (cx, cy) = tx(tool.c);
    writeln!(out, "<circle cx='{cx:.1}' cy='{cy:.1}' r='{:.1}' fill='#9aa3ad'/>", r * scale).unwrap();
    writeln!(out, "<text x='{ox}' y='{}' font-size='11' font-family='sans-serif'>0 … {vmax:.0}</text>", oy + 9.0 * c.p.h * scale + 14.0).unwrap();
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let key = a.get(1).map(String::as_str).unwrap_or("S50C");
    let vc: f64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(200.0);
    let h: f64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(0.1);
    let rake: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let len: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let out = a.get(6).cloned().unwrap_or_else(|| "orthogonal.svg".into());
    let mat = Material::preset(key).expect("material key: S50C SCM440 SUS304 SKD61 IN718 Ti64 A7075 A5052");
    let mut p = CutParams::new(vc, h, rake);
    p.length = len;
    if let Some(mu) = a.get(7).and_then(|s| s.parse().ok()) {
        p.mu = mu;
    }
    // sensitivity checks: element size at the edge and mass scaling from the environment
    if let Some(v) = std::env::var("CHIPFEM_HMIN").ok().and_then(|s| s.parse().ok()) {
        p.h_min = v;
    }
    if let Some(v) = std::env::var("CHIPFEM_MASS_SCALE").ok().and_then(|s| s.parse().ok()) {
        p.mass_scale = v;
    }
    // friction stress limit m·k (CHIPFEM_SHEAR=none: Coulomb alone)
    if let Ok(v) = std::env::var("CHIPFEM_SHEAR") {
        p.shear_factor = v.parse().ok();
    }
    let mut c = Cutting::new(mat, p);
    println!("{key}: Vc {vc} m/min, h {h} mm, rake {rake}°, edge radius {} mm, μ {}; {} elements", c.p.re, c.p.mu, c.solver.mesh.tri.len());
    println!("  cut[mm]  Fc[N/mm]  Ft[N/mm]  chip[mm]  Tmax[°C]  εp max  elements remeshes  Ttool[°C]");
    let t0 = std::time::Instant::now();
    c.run(len / 20.0, |s, c| {
        println!("  {:6.3}  {:8.1}  {:8.1}  {:8.4}  {:8.0}  {:6.2}  {:8} {:8}  {:8.0}", s.cut, s.fc, s.ft, s.chip, s.t_max, s.ep_max, s.elements, s.remeshes, s.t_tool);
        if std::env::var("CHIPFEM_DEBUG").is_ok() {
            // where the hottest node is: relative to the edge centre, the time step
            let sv = &c.solver;
            let (i, t) = sv.temp.iter().enumerate().fold((0, f64::MIN), |b, (i, &t)| if t > b.1 { (i, t) } else { b });
            let tc = sv.tool.as_ref().unwrap().c;
            let p = sv.mesh.x[i];
            eprintln!("    hottest node {i}: {t:.0} °C at ({:+.4}, {:+.4}) from the edge centre; dt {:.2e} s, steps {}, quality {:.3}", p[0] - tc[0], p[1] - tc[1], sv.dt, sv.steps, sv.min_quality());
        }
        true
    });
    let st = c.steady(0.4);
    let r = c.p.h / st.chip.max(1e-9);
    let a_r = c.p.rake_deg.to_radians();
    let phi = (r * a_r.cos() / (1.0 - r * a_r.sin())).atan().to_degrees();
    println!("steady (last 40 %): Fc {:.1} N/mm, Ft {:.1} N/mm, chip {:.4} mm (ratio {:.2}, shear angle {:.1}°), Tmax {:.0} °C, tool {:.0} °C  [{:.1} s]", st.fc, st.ft, st.chip, r, phi, st.t_max, st.t_tool, t0.elapsed().as_secs_f64());
    // fields: temperature (element mean of the nodes) and plastic strain
    let m = &c.solver.mesh;
    let te: Vec<f64> = m.tri.iter().map(|t| t.iter().map(|&i| c.solver.temp[i]).sum::<f64>() / 3.0).collect();
    let scale = 520.0 / (9.0 * c.p.h);
    let mut svg = String::new();
    writeln!(svg, "<svg xmlns='http://www.w3.org/2000/svg' width='1120' height='620' style='background:#fff'>").unwrap();
    let tmax = te.iter().cloned().fold(0.0, f64::max);
    field_svg(&c, &te, tmax.max(100.0), &format!("温度 [°C] — {key} Vc {vc} m/min h {h} mm"), 20.0, 30.0, scale, &mut svg);
    let emax = c.solver.ep.iter().cloned().fold(0.0, f64::max).min(4.0);
    field_svg(&c, &c.solver.ep, emax.max(0.5), "相当塑性ひずみ [-]", 580.0, 30.0, scale, &mut svg);
    svg.push_str("</svg>\n");
    std::fs::write(&out, svg).unwrap();
    println!("wrote {out}");
    // the fields as the app's screen gets them (CHIPFEM_JSON=path)
    if let Ok(path) = std::env::var("CHIPFEM_JSON") {
        let s = &c.solver;
        let t = s.tool.as_ref().unwrap();
        let mises: Vec<f64> = s.sigma.iter().map(|g| { let p = (g[0] + g[1] + g[2]) / 3.0; let (a, b, z) = (g[0] - p, g[1] - p, g[2] - p); (1.5 * (a * a + b * b + z * z + 2.0 * g[3] * g[3])).sqrt() }).collect();
        let list = |v: &[f64]| v.iter().map(|x| format!("{x:.4}")).collect::<Vec<_>>().join(",");
        let xs = s.mesh.x.iter().map(|p| format!("[{:.6},{:.6}]", p[0], p[1])).collect::<Vec<_>>().join(",");
        let tri = s.mesh.tri.iter().map(|t| format!("[{},{},{}]", t[0], t[1], t[2])).collect::<Vec<_>>().join(",");
        let json = format!("{{\"x\":[{xs}],\"tri\":[{tri}],\"temp\":[{}],\"ep\":[{}],\"mises\":[{}],\"tool\":[{},{},{},{},{}]}}", list(&s.temp), list(&s.ep), list(&mises), t.c[0], t.c[1], t.re, t.rake, t.clearance);
        std::fs::write(&path, json).unwrap();
        println!("wrote {path}");
    }
}
