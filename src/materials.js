// Mechanistic cutting coefficients (linear edge-force model, Altintas).
// Ktc/Krc/Kac: shearing coefficients [N/mm²], Kte/Kre/Kae: edge coefficients [N/mm].
// Values are representative literature-level figures for carbide end mills; real values
// depend on tool geometry, coating and wear, so treat them as a starting point to calibrate.
export const MATERIALS = {
  A5052: { name: 'A5052 アルミ合金', Ktc: 700, Krc: 210, Kac: 120, Kte: 20, Kre: 25, Kae: 5, rho: 2680, E: 70300, chip: [0.80, 0.81, 0.83], hot: false, vc: 400 },
  A7075: { name: 'A7075 超々ジュラルミン', Ktc: 796, Krc: 168, Kac: 222, Kte: 27.7, Kre: 30.8, Kae: 1.8, rho: 2810, E: 71700, chip: [0.78, 0.79, 0.80], hot: false, vc: 350 },
  S50C: { name: 'S50C 機械構造用炭素鋼', Ktc: 2100, Krc: 850, Kac: 400, Kte: 35, Kre: 45, Kae: 10, rho: 7850, E: 205000, chip: [0.55, 0.45, 0.35], hot: true, vc: 150 },
  SUS304: { name: 'SUS304 ステンレス', Ktc: 2600, Krc: 1100, Kac: 500, Kte: 40, Kre: 55, Kae: 12, rho: 7930, E: 193000, chip: [0.60, 0.58, 0.55], hot: true, vc: 90 },
  Ti64: { name: 'Ti-6Al-4V チタン合金', Ktc: 1950, Krc: 650, Kac: 520, Kte: 25, Kre: 40, Kae: 10, rho: 4430, E: 114000, chip: [0.62, 0.60, 0.58], hot: true, vc: 60 },
};
