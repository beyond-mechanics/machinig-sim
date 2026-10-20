// Mechanistic cutting coefficients (linear edge-force model, Altintas).
// Ktc/Krc/Kac: shearing coefficients [N/mm²], Kte/Kre/Kae: edge coefficients [N/mm].
// Values are representative literature-level figures for carbide end mills; real values
// depend on tool geometry, coating and wear, so treat them as a starting point to calibrate.
// mc: size-effect exponent of the shearing coefficients, K(h) = K·(h0/h)^mc with h0 = 0.05 mm,
//     the residual curvature left after the edge terms (exponential force model).
// curl: chip form [turns, pitch per turn / radius, curl radius factor] — continuous curly
//       helices for aluminium, short C chips for carbon steel, long tight strings for stainless,
//       short segmented arcs for titanium.
// mu: rake-face friction coefficient, cp [J/kg·K], kth [W/m·K]: chip/work thermal properties,
// Tm: solidus [°C] (the chip softens there, so the interface temperature saturates below it),
// life: contact time [min] to VB 0.3 mm at Vc = vc, h = 0.05 mm (wear-law calibration).
// Ci: process-damping (flank indentation) coefficient [N/m]; damping force = Ci·b·v_n / V_c.
export const MATERIALS = {
  A5052: { Tm: 607, mu: 0.7, cp: 900, kth: 138, life: 240, name: 'A5052 アルミ合金', Ktc: 700, Krc: 210, Kac: 120, Kte: 20, Kre: 25, Kae: 5, mc: 0.10, Ci: 2e4, curl: [2.4, 0.55, 1.0], rho: 2680, E: 70300, chip: [0.80, 0.81, 0.83], hot: false, vc: 400 },
  A7075: { Tm: 477, mu: 0.7, cp: 960, kth: 130, life: 180, name: 'A7075 超々ジュラルミン', Ktc: 796, Krc: 168, Kac: 222, Kte: 27.7, Kre: 30.8, Kae: 1.8, mc: 0.10, Ci: 2e4, curl: [1.5, 0.4, 0.9], rho: 2810, E: 71700, chip: [0.78, 0.79, 0.80], hot: false, vc: 350 },
  S50C: { Tm: 1450, mu: 0.6, cp: 480, kth: 45, life: 45, name: 'S50C 機械構造用炭素鋼', Ktc: 2100, Krc: 850, Kac: 400, Kte: 35, Kre: 45, Kae: 10, mc: 0.14, Ci: 1.5e5, curl: [0.8, 0.15, 0.8], rho: 7850, E: 205000, chip: [0.55, 0.45, 0.35], hot: true, vc: 150 },
  SUS304: { Tm: 1400, mu: 0.65, cp: 500, kth: 16, life: 30, name: 'SUS304 ステンレス', Ktc: 2600, Krc: 1100, Kac: 500, Kte: 40, Kre: 55, Kae: 12, mc: 0.12, Ci: 2e5, curl: [3.8, 0.35, 0.75], rho: 7930, E: 193000, chip: [0.60, 0.58, 0.55], hot: true, vc: 90 },
  Ti64: { Tm: 1604, mu: 0.5, cp: 560, kth: 7, life: 20, name: 'Ti-6Al-4V チタン合金', Ktc: 1950, Krc: 650, Kac: 520, Kte: 25, Kre: 40, Kae: 10, mc: 0.12, Ci: 2.5e5, curl: [0.55, 0.08, 0.7], rho: 4430, E: 114000, chip: [0.62, 0.60, 0.58], hot: true, vc: 60 },
};
