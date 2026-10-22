// Johnson-Cook flow stress and speed-dependent friction, as src/materials.js.
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Mat {
    #[serde(rename = "A")] pub a: f64,
    #[serde(rename = "B")] pub b: f64,
    pub n: f64,
    #[serde(rename = "C")] pub c_rate: f64,
    pub m: f64,
    #[serde(rename = "Tm")] pub tm: f64,
    #[serde(rename = "Tr")] pub tr: f64,
    pub vc: f64,
    pub rho: f64,
    #[serde(rename = "c")] pub cp: f64,
    pub k: f64,
    #[serde(rename = "D1")] pub d1: Option<f64>,
    #[serde(rename = "D2")] pub d2: Option<f64>,
    #[serde(rename = "D3")] pub d3: Option<f64>,
    #[serde(rename = "D4")] pub d4: Option<f64>,
    #[serde(rename = "D5")] pub d5: Option<f64>,
    pub model: Option<String>,
    #[serde(rename = "a")] pub ta: Option<f64>,
    #[serde(rename = "b")] pub tb: Option<f64>,
    pub cc: Option<f64>,
    pub d: Option<f64>,
}

const K0: f64 = 273.15;

impl Mat {
    pub fn is_tanh(&self) -> bool { self.model.as_deref() == Some("tanh") }

    // Flow stress [Pa] for plastic strain ep, plastic strain rate epdot [1/s], temperature T [°C].
    pub fn flow_stress(&self, ep: f64, epdot: f64, t: f64) -> f64 {
        let tanh = self.is_tanh();
        let hard = self.a + self.b * (if ep > 0.0 { ep.powf(self.n) * (if tanh { (-ep.powf(self.ta.unwrap())).exp() } else { 1.0 }) } else { 0.0 });
        let rate = if epdot > 1.0 { 1.0 + self.c_rate * epdot.ln() } else { 1.0 };
        let mut ts = (t - self.tr) / (self.tm - self.tr);
        ts = if ts < 0.0 { 0.0 } else if ts > 1.0 { 1.0 } else { ts };
        let mut soft = f64::max(1.0 - ts.powf(self.m), 0.01);
        if tanh {
            let tr = f64::min((t + K0) / (self.tm + K0), 1.0);
            let d = 1.0 - tr.powf(self.d.unwrap());
            let s = tr.powf(self.tb.unwrap());
            soft *= d + (1.0 - d) * (1.0 / (ep + s).powf(self.cc.unwrap())).tanh();
        }
        hard * rate * soft * 1e6
    }

    pub fn friction_at(&self, mu0: f64, v: f64, s: f64) -> f64 {
        let r = v / (0.5 * self.vc / 60.0);
        mu0 * f64::min(1.5, f64::max(0.3, f64::max(r, 1e-6).powf(-s)))
    }
}
