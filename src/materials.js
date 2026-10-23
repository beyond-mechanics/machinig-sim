// Mechanistic cutting coefficients (linear edge-force model, Altintas).
// Ktc/Krc/Kac: shearing coefficients [N/mm²], Kte/Kre/Kae: edge coefficients [N/mm].
// Values are representative literature-level figures for carbide end mills; real values
// depend on tool geometry, coating and wear, so treat them as a starting point to calibrate.
// mc: size-effect exponent of the shearing coefficients, K(h) = K·(h0/h)^mc with h0 = 0.05 mm,
//     the residual curvature left after the edge terms (exponential force model).
// curl: chip form [turns, pitch per turn / radius, curl radius factor] — continuous curly
//       helices for aluminium, short C chips for carbon steel, long tight strings for stainless,
//       short segmented arcs for titanium.
// muRake: rake-face friction coefficient (shear angle and rake heat), cp [J/kg·K], kth [W/m·K]: chip/work thermal properties,
// Tm: solidus [°C] (the chip softens there, so the interface temperature saturates below it),
// fzD: starting feed per tooth for a carbide end mill in a slot, as a fraction of its diameter,
// life: contact time [min] to VB 0.3 mm at Vc = vc, h = 0.05 mm (wear-law calibration).
// Ci: process-damping (flank indentation) coefficient [N/m]; damping force = Ci·b·v_n / V_c.
// surf: colour of the machined surface (sRGB); chip: colour of the chips (oxidised for steels).
// Chip evacuation (chips.js):
// lam: chip compression ratio h_c/h (deformed / undeformed thickness); chips slide up the rake
//      face at V_c/lam and are lam times thicker than the cut, which sets their drag per mass.
// Rb: bulk factor of loose chips (bulk volume / solid volume, "chip space number"); sets the
//     room a chip needs in a flute or a pile. Short milling chips, so lower than turning values.
// kA: mean projected area of one tumbling chip as a fraction of one face of the flattened
//     ribbon (a flat plate tumbling at random would give 0.5; curls and C shapes shield themselves).
// mu: Coulomb friction of a chip sliding on machined metal (dry; coolant lowers it).
export const MATERIALS = {
  A5052: { fzD: 0.008, surf: [0.82, 0.83, 0.85], Tm: 607, muRake: 0.7, cp: 900, kth: 138, life: 240, name: 'A5052 アルミ合金', Ktc: 700, Krc: 210, Kac: 120, Kte: 20, Kre: 25, Kae: 5, mc: 0.10, Ci: 2e4, curl: [2.4, 0.55, 1.0], rho: 2680, E: 70300, chip: [0.80, 0.81, 0.83], hot: false, vc: 400, lam: 2.6, Rb: 6, kA: 0.30, mu: 0.55 },
  A7075: { fzD: 0.008, surf: [0.80, 0.81, 0.83], Tm: 477, muRake: 0.7, cp: 960, kth: 130, life: 180, name: 'A7075 超々ジュラルミン', Ktc: 796, Krc: 168, Kac: 222, Kte: 27.7, Kre: 30.8, Kae: 1.8, mc: 0.10, Ci: 2e4, curl: [1.5, 0.4, 0.9], rho: 2810, E: 71700, chip: [0.78, 0.79, 0.80], hot: false, vc: 350, lam: 2.0, Rb: 5, kA: 0.32, mu: 0.5 },
  S50C: { fzD: 0.004, surf: [0.60, 0.61, 0.63], Tm: 1450, muRake: 0.6, cp: 480, kth: 45, life: 45, name: 'S50C 機械構造用炭素鋼', Ktc: 2100, Krc: 850, Kac: 400, Kte: 35, Kre: 45, Kae: 10, mc: 0.14, Ci: 1.5e5, curl: [0.8, 0.15, 0.8], rho: 7850, E: 205000, chip: [0.55, 0.45, 0.35], hot: true, vc: 150, lam: 2.4, Rb: 4, kA: 0.40, mu: 0.4 },
  SUS304: { fzD: 0.003, surf: [0.70, 0.70, 0.71], Tm: 1400, muRake: 0.65, cp: 500, kth: 16, life: 30, name: 'SUS304 ステンレス', Ktc: 2600, Krc: 1100, Kac: 500, Kte: 40, Kre: 55, Kae: 12, mc: 0.12, Ci: 2e5, curl: [3.8, 0.35, 0.75], rho: 7930, E: 193000, chip: [0.60, 0.58, 0.55], hot: true, vc: 90, lam: 2.2, Rb: 6, kA: 0.30, mu: 0.45 },
  SCM440: { fzD: 0.0035, surf: [0.60, 0.61, 0.63], Tm: 1480, muRake: 0.6, cp: 475, kth: 42.6, life: 40, name: 'SCM440 クロムモリブデン鋼 (調質)', Ktc: 2300, Krc: 900, Kac: 450, Kte: 38, Kre: 50, Kae: 10, mc: 0.14, Ci: 1.6e5, curl: [0.8, 0.15, 0.8], rho: 7850, E: 205000, chip: [0.50, 0.40, 0.32], hot: true, vc: 160, lam: 2.3, Rb: 4, kA: 0.40, mu: 0.4 },
  SKD61: { fzD: 0.0025, surf: [0.58, 0.59, 0.60], Tm: 1480, muRake: 0.55, cp: 460, kth: 24.3, life: 25, name: 'SKD61 熱間金型鋼 (焼入れ 45 HRC 前後)', Ktc: 2900, Krc: 1300, Kac: 500, Kte: 45, Kre: 65, Kae: 12, mc: 0.12, Ci: 2e5, curl: [0.5, 0.1, 0.7], rho: 7800, E: 210000, chip: [0.45, 0.38, 0.33], hot: true, vc: 120, lam: 1.8, Rb: 3.5, kA: 0.42, mu: 0.4 },
  IN718: { fzD: 0.002, surf: [0.66, 0.66, 0.66], Tm: 1336, muRake: 0.5, cp: 435, kth: 11.4, life: 15, name: 'インコネル 718 耐熱合金', Ktc: 3100, Krc: 1300, Kac: 700, Kte: 45, Kre: 60, Kae: 12, mc: 0.12, Ci: 3e5, curl: [1.0, 0.15, 0.7], rho: 8190, E: 200000, chip: [0.55, 0.50, 0.45], hot: true, vc: 40, lam: 2.0, Rb: 4, kA: 0.40, mu: 0.45 },
  Ti64: { fzD: 0.0035, surf: [0.56, 0.55, 0.53], Tm: 1604, muRake: 0.5, cp: 560, kth: 7, life: 20, name: 'Ti-6Al-4V チタン合金', Ktc: 1950, Krc: 650, Kac: 520, Kte: 25, Kre: 40, Kae: 10, mc: 0.12, Ci: 2.5e5, curl: [0.55, 0.08, 0.7], rho: 4430, E: 114000, chip: [0.62, 0.60, 0.58], hot: true, vc: 60, lam: 1.3, Rb: 3, kA: 0.45, mu: 0.45 },
};

// Coefficients identified by cutting-sim (its "係数を JSON で書き出す" file): the material it
// names maps to the closest one here, and every finite coefficient it carries replaces the
// table value (a 2D end-mill section has no axial terms, so Kac/Kae stay as tabled).
const FROM_CUTTING_SIM = { S45C: 'S50C', SUS304: 'SUS304', Ti64: 'Ti64', Ti64s: 'Ti64', Al7075: 'A7075', Al6061: 'A5052', Al2024: 'A5052', Al5083: 'A5052' };
export function parseCoeffs(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('JSON として読めません'); }
  if (!d || typeof d.coefficients !== 'object' || !d.coefficients) throw new Error('coefficients がありません（cutting-sim の係数ファイルではないようです）');
  const coeffs = {};
  for (const k of ['Ktc', 'Krc', 'Kac', 'Kte', 'Kre', 'Kae']) {
    const v = d.coefficients[k];
    if (typeof v === 'number' && Number.isFinite(v)) coeffs[k] = v;
  }
  if (!(coeffs.Ktc > 0)) throw new Error('Ktc が正の数ではありません');
  return { material: FROM_CUTTING_SIM[d.material] || null, from: d.material || '?', mode: d.mode || '?', coeffs };
}
// As a per-material coefficient set (sim.cfg.coefs[key]): terms the file leaves out stay as tabled.
export function coefsFromFile(r, base) {
  const c = { Ktc: base.Ktc, Krc: base.Krc, Kac: base.Kac, mc: base.mc, ...r.coeffs, source: '切削シミュの係数' };
  return c;
}
