//! Work materials: elastic constants, thermal properties and the Johnson–Cook flow stress
//!   σ_y = (A + B·ε_pⁿ)·(1 + C·ln(ε̇_p/ε̇₀))·(1 − T*ᵐ),  T* = (T − T_r)/(T_m − T_r)
//! The constants are the ones the web version uses for its Oxley prediction (src/oxley.js), so
//! the two predictions can be compared directly.
//!
//! Units (consistent set used throughout the crate): length mm, time s, mass t (tonne),
//! force N, stress MPa, energy mJ, temperature °C. Then density is t/mm³ (steel 7.85e-9),
//! specific heat mJ/(t·K) (= 1e6 × J/(kg·K)), conductivity mJ/(s·mm·K) (= W/(m·K)).

#[derive(Clone, Debug)]
pub struct JohnsonCook {
    pub a: f64,
    pub b: f64,
    pub n: f64,
    pub c: f64,
    /// reference plastic strain rate [1/s]
    pub eps0: f64,
    pub m: f64,
    /// room (reference) and melting temperatures [°C]
    pub t_room: f64,
    pub t_melt: f64,
}

impl JohnsonCook {
    /// flow stress [MPa] at plastic strain ep, plastic strain rate epdot [1/s], temperature t [°C]
    pub fn flow(&self, ep: f64, epdot: f64, t: f64) -> f64 {
        let hard = self.a + self.b * ep.max(1e-9).powf(self.n);
        let rate = 1.0 + self.c * (epdot / self.eps0).max(1.0).ln();
        let ts = ((t - self.t_room) / (self.t_melt - self.t_room)).clamp(0.0, 1.0);
        // near the melting point the softening stops at 10 % of the strength: a solid model cannot
        // melt, and an element at a few per cent strength is squashed flat within a few steps
        // (in cutting the tool–chip interface stays below about 0.9 T_m)
        hard * rate * (1.0 - ts.powf(self.m)).max(0.1)
    }
}

#[derive(Clone, Debug)]
pub struct Material {
    pub name: String,
    /// density [t/mm³]
    pub rho: f64,
    /// Young's modulus [MPa] and Poisson's ratio
    pub e: f64,
    pub nu: f64,
    /// specific heat [mJ/(t·K)] and conductivity [mJ/(s·mm·K)]
    pub cp: f64,
    pub k: f64,
    /// Taylor–Quinney coefficient: share of the plastic work turned into heat
    pub beta: f64,
    pub jc: JohnsonCook,
}

impl Material {
    pub fn shear_modulus(&self) -> f64 {
        self.e / (2.0 * (1.0 + self.nu))
    }
    pub fn bulk_modulus(&self) -> f64 {
        self.e / (3.0 * (1.0 - 2.0 * self.nu))
    }

    /// presets by the web version's material keys
    pub fn preset(key: &str) -> Option<Material> {
        // (rho kg/m³, E MPa, nu, cp J/kgK, k W/mK, A, B, n, C, m, Tm °C)
        let p = match key {
            "S50C" => (7850.0, 205e3, 0.29, 480.0, 45.0, 553.1, 600.8, 0.234, 0.0134, 1.0, 1460.0),
            "SCM440" => (7850.0, 205e3, 0.29, 475.0, 42.6, 598.0, 768.0, 0.2092, 0.0137, 0.807, 1520.0),
            "SUS304" => (7930.0, 193e3, 0.29, 500.0, 16.0, 310.0, 1000.0, 0.65, 0.07, 1.0, 1400.0),
            "SKD61" => (7800.0, 210e3, 0.30, 460.0, 24.3, 908.5, 321.3, 0.278, 0.028, 1.18, 1480.0),
            "IN718" => (8190.0, 200e3, 0.29, 435.0, 11.4, 1241.0, 622.0, 0.6522, 0.0134, 1.3, 1336.0),
            "Ti64" => (4430.0, 114e3, 0.34, 560.0, 7.0, 862.0, 331.0, 0.34, 0.012, 0.8, 1604.0),
            "A7075" => (2810.0, 71.7e3, 0.33, 960.0, 130.0, 546.0, 678.0, 0.71, 0.024, 1.56, 635.0),
            "A5052" => (2680.0, 70.3e3, 0.33, 900.0, 138.0, 215.0, 280.0, 0.34, 0.006, 1.2, 607.0),
            _ => return None,
        };
        let (rho, e, nu, cp, k, a, b, n, c, m, tm) = p;
        Some(Material {
            name: key.to_string(),
            rho: rho * 1e-12,
            e,
            nu,
            cp: cp * 1e6,
            k,
            beta: 0.9,
            jc: JohnsonCook { a, b, n, c, eps0: 1.0, m, t_room: 20.0, t_melt: tm },
        })
    }
}
