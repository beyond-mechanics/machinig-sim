// Workpiece materials for orthogonal cutting.
// Johnson-Cook flow stress: σy = (A + B·εp^n)(1 + C·ln(ε̇p/ε̇0))(1 − T*^m), T* = (T − Tr)/(Tm − Tr).
// A, B in MPa; E in GPa; rho kg/m³; k W/(m·K); c J/(kg·K); Tm, Tr in °C; ε̇0 = 1 /s.
// JC sets are widely used literature values (1045: Jaspers & Dautzenberg, Ti-6Al-4V: Lee & Lin,
// Al6061-T6: Lesuer, IN718: Pereira/DeMange, SUS304: Umbrello, A7075-T6: Brar et al.,
// A2024-T3: Lesuer, A5083-H116: Clausen et al.). Treat them as a starting point:
// published sets for the same alloy differ by 20 % or more.
// model 'tanh': Calamaz et al. (2008) strain-softening JC for Ti-6Al-4V, which forms adiabatic
//   shear bands and saw-tooth (serrated) chips:
//   σ = [A + B ε^n exp(−ε^a)][1 + C ln ε̇*][1 − T*^m][D + (1 − D) tanh(1/(ε + S)^c)],
//   D = 1 − (T/Tm)^d, S = (T/Tm)^b with absolute temperatures.
// rake, nh: suggested rake angle and resolution (shear bands need a fine particle spacing);
// av: lower artificial viscosity so it does not smear the shear bands.
// kcRef: handbook-level specific cutting force [N/mm²] at h = 0.1 mm, for a sanity check only.
export const MATERIALS = {
  S45C: { name: 'S45C / AISI 1045 炭素鋼', group: '鋼', rho: 7850, E: 205, nu: 0.29, k: 50, c: 486,
    A: 553.1, B: 600.8, n: 0.234, C: 0.0134, m: 1.0, Tm: 1460, Tr: 20, vc: 200, mu: 0.4, kcRef: 2100 },
  SUS304: { name: 'SUS304 ステンレス鋼', group: '鋼', rho: 7900, E: 200, nu: 0.29, k: 16.2, c: 500,
    A: 310, B: 1000, n: 0.65, C: 0.07, m: 1.0, Tm: 1400, Tr: 20, vc: 150, mu: 0.45, kcRef: 2500 },
  Ti64: { name: 'Ti-6Al-4V チタン合金', group: '耐熱合金', rho: 4430, E: 113.8, nu: 0.342, k: 7.3, c: 560,
    A: 782.7, B: 498.4, n: 0.28, C: 0.028, m: 1.0, Tm: 1660, Tr: 20, vc: 60, mu: 0.4, kcRef: 1900 },
  Ti64s: { name: 'Ti-6Al-4V（ひずみ軟化・鋸歯状切りくず）', group: '耐熱合金', rho: 4430, E: 113.8, nu: 0.342, k: 7.3, c: 560,
    A: 968, B: 380, n: 0.421, C: 0.0197, m: 0.577, Tm: 1630, Tr: 20, vc: 120, mu: 0.6, kcRef: 1900,
    model: 'tanh', a: 2, b: 5, cc: 6, d: 1, rake: 0, nh: 12, av: 0.3 },
  IN718: { name: 'Inconel 718 ニッケル基合金', group: '耐熱合金', rho: 8190, E: 206, nu: 0.3, k: 11.4, c: 435,
    A: 1241, B: 622, n: 0.6522, C: 0.0134, m: 1.3, Tm: 1297, Tr: 20, vc: 40, mu: 0.4, kcRef: 3200 },
  Al6061: { name: 'A6061-T6 アルミ合金', group: 'アルミ合金', rho: 2700, E: 68.9, nu: 0.33, k: 167, c: 896,
    A: 324, B: 114, n: 0.42, C: 0.002, m: 1.34, Tm: 582, Tr: 20, vc: 400, mu: 0.3, kcRef: 800 },
  Al7075: { name: 'A7075-T6 超々ジュラルミン', group: 'アルミ合金', rho: 2810, E: 71.7, nu: 0.33, k: 130, c: 960,
    A: 546, B: 678, n: 0.71, C: 0.024, m: 1.56, Tm: 635, Tr: 20, vc: 400, mu: 0.3, kcRef: 950 },
  Al2024: { name: 'A2024-T3 超ジュラルミン', group: 'アルミ合金', rho: 2780, E: 73.1, nu: 0.33, k: 121, c: 875,
    A: 369, B: 684, n: 0.73, C: 0.0083, m: 1.7, Tm: 502, Tr: 20, vc: 400, mu: 0.3, kcRef: 850 },
  Al5083: { name: 'A5083-H116 アルミ合金（非熱処理）', group: 'アルミ合金', rho: 2660, E: 70.3, nu: 0.33, k: 117, c: 900,
    A: 167, B: 596, n: 0.551, C: 0.001, m: 0.859, Tm: 620, Tr: 20, vc: 400, mu: 0.35, kcRef: 750 },
};

// Tool materials. Usui wear: dW/dt = Aw·σn·Vs·exp(−Bw/T) [m/s] with σn [Pa], Vs [m/s], T [K].
// Bw is the usual high-temperature activation of carbide-on-steel wear; Aw is scaled so that a
// P-grade carbide cutting S45C at 200 m/min wears its crater at a few µm/min. Calibrate both
// against your own wear tests before trusting absolute values.
export const TOOLS = {
  WC: { name: '超硬（WC-Co）', rho: 14500, k: 50, c: 220, Aw: 1.0e-14, Bw: 5302 },
};

const K0 = 273.15;

// Flow stress [Pa] for plastic strain ep, plastic strain rate epdot [1/s], temperature T [°C].
export function flowStress(mat, ep, epdot, T) {
  const tanh = mat.model === 'tanh';
  const hard = mat.A + mat.B * (ep > 0 ? Math.pow(ep, mat.n) * (tanh ? Math.exp(-Math.pow(ep, mat.a)) : 1) : 0);
  const rate = epdot > 1 ? 1 + mat.C * Math.log(epdot) : 1;
  let ts = (T - mat.Tr) / (mat.Tm - mat.Tr);
  ts = ts < 0 ? 0 : ts > 1 ? 1 : ts;
  let soft = Math.max(1 - Math.pow(ts, mat.m), 0.01);
  if (tanh) {
    const tr = Math.min((T + K0) / (mat.Tm + K0), 1);
    const D = 1 - Math.pow(tr, mat.d), S = Math.pow(tr, mat.b);
    soft *= D + (1 - D) * Math.tanh(1 / Math.pow(ep + S, mat.cc));
  }
  return hard * rate * soft * 1e6;
}
