//! Milling coefficients from orthogonal-cutting FEM runs — what the milling simulator needs,
//! predicted from the work material's constants alone.
//!
//! 1. The FEM cuts at several uncut chip thicknesses h (same speed, tool and friction).
//! 2. Forces per unit width are fitted as F = K·h + K_e: the intercepts are the edge (ploughing)
//!    forces of the rounded edge, Kte and Kre [N/mm], which a sharp-tool theory such as Oxley's
//!    cannot give.
//! 3. The shearing parts F − K_e at each h give the orthogonal shear stress τ_s, shear angle φ
//!    (from the chip thickness ratio) and friction angle λ = α + atan(F_t/F_c).
//! 4. The oblique transformation with the helix as the inclination angle and Stabler's chip-flow
//!    rule (Budak, Altintas & Armarego 1996) turns them into Ktc, Krc, Kac [N/mm²] at each h — the
//!    same transformation the web version applies to its Oxley prediction (src/oxley.js).
//! 5. The size effect K(h) = K(h_ref)·(h_ref/h)^mc is fitted log–log, reported at h_ref = 0.05 mm.

use crate::cutting::{CutParams, Cutting};
use crate::material::Material;

pub const H_REF: f64 = 0.05;

#[derive(Clone, Debug)]
pub struct CoefRow {
    pub h: f64,
    /// forces per mm width [N/mm], chip thickness [mm], highest temperature [°C]
    pub fc: f64,
    pub ft: f64,
    pub chip: f64,
    pub t_max: f64,
    /// orthogonal shear stress [MPa], shear and friction angles [rad]
    pub tau_s: f64,
    pub phi: f64,
    pub lambda: f64,
    /// milling coefficients at this h [N/mm²]
    pub ktc: f64,
    pub krc: f64,
    pub kac: f64,
    /// coefficient of variation of the cutting force over the averaged part [−]
    pub fc_cv: f64,
    /// the run reached a steady state (finite, force within ±10 %, below 0.95 T_m); only these
    /// enter the fit
    pub steady: bool,
}

#[derive(Clone, Debug)]
pub struct MillingCoefs {
    pub ktc: f64,
    pub krc: f64,
    pub kac: f64,
    pub kte: f64,
    pub kre: f64,
    pub kae: f64,
    pub mc: f64,
    pub rows: Vec<CoefRow>,
    /// coefficient of determination of the two straight-line fits (Fc, Ft against h)
    pub r2: [f64; 2],
}

/// Oblique transformation: (Ktc, Krc, Kac) from τ_s [MPa], φ, λ [rad], normal rake α_n and
/// inclination i [rad]; chip flow angle η = i (Stabler).
pub fn oblique(tau_s: f64, phi: f64, lambda: f64, alpha_n: f64, i: f64) -> (f64, f64, f64) {
    let eta = i;
    let bn = (lambda.tan() * eta.cos()).atan();
    let c = ((phi + bn - alpha_n).cos().powi(2) + eta.tan().powi(2) * bn.sin().powi(2)).sqrt();
    let s = tau_s / phi.sin() / c;
    (
        s * ((bn - alpha_n).cos() + i.tan() * eta.tan() * bn.sin()),
        s * (bn - alpha_n).sin() / i.cos(),
        s * ((bn - alpha_n).cos() * i.tan() - eta.tan() * bn.sin()),
    )
}

/// least-squares line y = a·x + b → (a, b, R²)
fn line(x: &[f64], y: &[f64]) -> (f64, f64, f64) {
    let n = x.len() as f64;
    let (mx, my) = (x.iter().sum::<f64>() / n, y.iter().sum::<f64>() / n);
    let sxy: f64 = x.iter().zip(y).map(|(a, b)| (a - mx) * (b - my)).sum();
    let sxx: f64 = x.iter().map(|a| (a - mx).powi(2)).sum();
    let syy: f64 = y.iter().map(|b| (b - my).powi(2)).sum();
    let a = sxy / sxx;
    (a, my - a * mx, if syy > 0.0 { sxy * sxy / (sxx * syy) } else { 1.0 })
}

/// Run the FEM at each h and derive the milling coefficients. `base` gives speed, rake, edge
/// radius and friction (its h and length are set per run); `on_run(k, n, row)` reports progress
/// and returns false to stop.
pub fn milling_coefs(mat: &Material, base: &CutParams, hs: &[f64], helix_deg: f64, mut on_run: impl FnMut(usize, usize, &CoefRow, &Cutting) -> bool) -> Option<MillingCoefs> {
    let alpha = base.rake_deg.to_radians();
    let inc = helix_deg.to_radians();
    let mut raw = Vec::new();
    for (k, &h) in hs.iter().enumerate() {
        let mut p = CutParams::new(base.vc, h, base.rake_deg);
        p.clearance_deg = base.clearance_deg;
        p.re = base.re;
        p.mu = base.mu;
        p.shear_factor = base.shear_factor;
        p.mass_scale = base.mass_scale;
        // forces as in steady cutting: the run lasts a fraction of a millisecond, in which a
        // conducting tool would still be cold and draw the interface heat away (the chip side
        // would cool and cut harder than it does once the tool has warmed up, after seconds); so
        // the tool is adiabatic and the friction heat goes into the chip, as in Oxley's theory
        p.tool_heat = false;
        p.friction_heat_to_work = true;
        // long enough for the chip to reach a steady state (several chip thicknesses)
        p.length = (8.0 * h).max(0.8);
        let mut c = Cutting::new(mat.clone(), p);
        c.run(c.p.length / 20.0, |_, _| true);
        let s = c.steady(0.4);
        // steadiness over the averaged part
        let n = c.history.len();
        let tail = &c.history[n - ((n as f64 * 0.4).ceil() as usize).clamp(1, n)..];
        let mean = tail.iter().map(|q| q.fc).sum::<f64>() / tail.len() as f64;
        let sd = (tail.iter().map(|q| (q.fc - mean).powi(2)).sum::<f64>() / tail.len() as f64).sqrt();
        let fc_cv = sd / mean.abs().max(1e-9);
        let hot = tail.iter().map(|q| q.t_max).fold(f64::MIN, f64::max);
        let steady = [s.fc, s.ft, s.chip].iter().all(|v| v.is_finite()) && s.chip > 0.0 && fc_cv < 0.1 && hot < 0.95 * mat.jc.t_melt;
        let row = CoefRow { h, fc: s.fc, ft: s.ft, chip: s.chip, t_max: s.t_max, tau_s: 0.0, phi: 0.0, lambda: 0.0, ktc: 0.0, krc: 0.0, kac: 0.0, fc_cv, steady };
        if !on_run(k, hs.len(), &row, &c) {
            return None;
        }
        raw.push(row);
    }
    // the fit uses the steady runs only
    let good: Vec<&CoefRow> = raw.iter().filter(|r| r.steady).collect();
    if good.len() < 2 {
        return None;
    }
    let x: Vec<f64> = good.iter().map(|r| r.h).collect();
    let (_, kte, r2c) = line(&x, &good.iter().map(|r| r.fc).collect::<Vec<_>>());
    let (_, kre, r2t) = line(&x, &good.iter().map(|r| r.ft).collect::<Vec<_>>());
    let (kte, kre) = (kte.max(0.0), kre.max(0.0));
    for r in raw.iter_mut().filter(|r| r.steady) {
        let (fcs, fts) = (r.fc - kte, r.ft - kre);
        // shear angle from the chip thickness ratio r_c = h / t₂
        let rc = r.h / r.chip.max(1e-9);
        r.phi = (rc * alpha.cos() / (1.0 - rc * alpha.sin())).atan();
        r.lambda = alpha + (fts / fcs).atan();
        r.tau_s = (fcs * r.phi.cos() - fts * r.phi.sin()) * r.phi.sin() / r.h;
        let (a, b, c) = oblique(r.tau_s, r.phi, r.lambda, alpha, inc);
        r.ktc = a;
        r.krc = b;
        r.kac = c;
    }
    // size effect: log–log fit of Ktc against h, reported at H_REF
    let good: Vec<&CoefRow> = raw.iter().filter(|r| r.steady).collect();
    let lx: Vec<f64> = good.iter().map(|r| (H_REF / r.h).ln()).collect();
    let ly: Vec<f64> = good.iter().map(|r| r.ktc.ln()).collect();
    let (slope, icpt, _) = line(&lx, &ly);
    let mc = slope.max(0.0);
    let at_ref = |f: &dyn Fn(&CoefRow) -> f64| {
        // each coefficient scaled to H_REF with the same exponent
        let v: f64 = good.iter().map(|r| f(r) * (r.h / H_REF).powf(mc)).sum::<f64>() / good.len() as f64;
        v
    };
    let _ = icpt;
    Some(MillingCoefs {
        ktc: at_ref(&|r| r.ktc),
        krc: at_ref(&|r| r.krc),
        kac: at_ref(&|r| r.kac),
        kte,
        kre,
        kae: 0.0,
        mc,
        rows: raw,
        r2: [r2c, r2t],
    })
}
