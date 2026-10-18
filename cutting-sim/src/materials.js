// Workpiece materials for orthogonal cutting.
// Johnson-Cook flow stress: σy = (A + B·εp^n)(1 + C·ln(ε̇p/ε̇0))(1 − T*^m), T* = (T − Tr)/(Tm − Tr).
// A, B in MPa; E in GPa; rho kg/m³; k W/(m·K); c J/(kg·K); Tm, Tr in °C; ε̇0 = 1 /s.
// JC sets are widely used literature values (1045: Jaspers & Dautzenberg, Ti-6Al-4V: Lee & Lin,
// Al6061-T6: Lesuer, IN718: Pereira/DeMange, SUS304: Umbrello). Treat them as a starting point:
// published sets for the same alloy differ by 20 % or more.
// kcRef: handbook-level specific cutting force [N/mm²] at h = 0.1 mm, for a sanity check only.
export const MATERIALS = {
  S45C: { name: 'S45C / AISI 1045 炭素鋼', rho: 7850, E: 205, nu: 0.29, k: 50, c: 486,
    A: 553.1, B: 600.8, n: 0.234, C: 0.0134, m: 1.0, Tm: 1460, Tr: 20, vc: 200, mu: 0.4, kcRef: 2100 },
  SUS304: { name: 'SUS304 ステンレス鋼', rho: 7900, E: 200, nu: 0.29, k: 16.2, c: 500,
    A: 310, B: 1000, n: 0.65, C: 0.07, m: 1.0, Tm: 1400, Tr: 20, vc: 150, mu: 0.45, kcRef: 2500 },
  Ti64: { name: 'Ti-6Al-4V チタン合金', rho: 4430, E: 113.8, nu: 0.342, k: 7.3, c: 560,
    A: 782.7, B: 498.4, n: 0.28, C: 0.028, m: 1.0, Tm: 1660, Tr: 20, vc: 60, mu: 0.4, kcRef: 1900 },
  Al6061: { name: 'A6061-T6 アルミ合金', rho: 2700, E: 68.9, nu: 0.33, k: 167, c: 896,
    A: 324, B: 114, n: 0.42, C: 0.002, m: 1.34, Tm: 582, Tr: 20, vc: 400, mu: 0.3, kcRef: 800 },
  IN718: { name: 'Inconel 718 ニッケル基合金', rho: 8190, E: 206, nu: 0.3, k: 11.4, c: 435,
    A: 1241, B: 622, n: 0.6522, C: 0.0134, m: 1.3, Tm: 1297, Tr: 20, vc: 40, mu: 0.4, kcRef: 3200 },
};

// Flow stress [Pa] for plastic strain ep, plastic strain rate epdot [1/s], temperature T [°C].
export function flowStress(mat, ep, epdot, T) {
  const hard = mat.A + mat.B * (ep > 0 ? Math.pow(ep, mat.n) : 0);
  const rate = epdot > 1 ? 1 + mat.C * Math.log(epdot) : 1;
  let ts = (T - mat.Tr) / (mat.Tm - mat.Tr);
  ts = ts < 0 ? 0 : ts > 1 ? 1 : ts;
  const soft = Math.max(1 - Math.pow(ts, mat.m), 0.01);
  return hard * rate * soft * 1e6;
}
