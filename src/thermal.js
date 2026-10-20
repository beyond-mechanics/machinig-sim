// Cutting temperature and tool wear from the mean chip of the current cut.
// Temperature: orthogonal-cutting energy balance on the equivalent chip (thickness h, speed Vc).
//   shear angle  Merchant φ = π/4 + (α − β)/2, β = atan μ (mat.muRake)
//   shear zone   ΔTs = (1 − Γ)·Fs·Vs / (ρc·Vc·h), Γ = heat into the work (Boothroyd)
//   rake face    ΔTf = 0.754·q·l / (k·√L), Jaeger's band source moving with the chip
//                (q: friction heat flux over the contact length 2·hc, l: half length, L = Vch·l / 2κ)
// The sum saturates smoothly at 0.95·Tm of the work material (thermal softening of the chip).
// The shearing force components come from the same mechanistic coefficients as the dynamics
// (Ktc, Krc for the rake face; the edge terms Kte, Kre act on the flank and heat it less).
// Wear: Usui's law dVB/dt = A·Vc·exp(−λ/θ) with Usui's two λ (5302 K below 1150 K, 21950 K
// above, continuous at 1150 K). A is calibrated per material so that the reference cut
// (Vc = mat.vc, h = 0.05 mm, rake 10°) reaches VB = 0.3 mm after mat.life minutes of contact.
// A worn flank adds a contact land: Kte += 0.1·Ktc·VB, Kre += 0.2·Ktc·VB.
// All values are representative; real tools need a calibration cut.

export const T0 = 20;            // ambient [°C]
export const VB_LIMIT = 0.3;     // end-of-life flank wear [mm] (ISO 8688)
const H_REF = 0.05;              // reference chip for the wear calibration [mm]
const LAMBDA_LO = 5302, LAMBDA_HI = 21950, THETA_SW = 1150; // Usui [K]

// h [mm], Vc [m/s], rakeDeg. Returns °C values and the chip geometry.
export function cuttingTemperature(mat, h, Vc, rakeDeg = 10) {
  if (!(h > 0) || !(Vc > 0)) return { tool: T0, shear: T0, chip: T0, phi: 0, hc: 0, gamma: 0 };
  const a = rakeDeg * Math.PI / 180, beta = Math.atan(mat.muRake ?? 0.6);
  const phi = Math.max(0.15, Math.PI / 4 + (a - beta) / 2);
  const hm = h * 1e-3;                                 // m
  const Fc = mat.Ktc * h * 1e3, Ft = mat.Krc * h * 1e3; // per unit width [N/m]
  const Fs = Fc * Math.cos(phi) - Ft * Math.sin(phi);
  const Ff = Fc * Math.sin(a) + Ft * Math.cos(a);
  const Vs = Vc * Math.cos(a) / Math.cos(phi - a), Vch = Vc * Math.sin(phi) / Math.cos(phi - a);
  const rc = mat.rho * mat.cp, kth = mat.kth, kap = kth / rc;
  const RT = rc * Vc * hm / kth;
  const gamma = Math.min(0.9, Math.max(0.05, 0.5 - 0.35 * Math.log10(RT * Math.tan(phi))));
  const dTs = (1 - gamma) * Math.max(0, Fs) * Vs / (rc * Vc * hm);
  const hc = hm * Math.cos(phi - a) / Math.sin(phi);
  const lc = 2 * hc, l = lc / 2;
  const q = Ff * Vch / lc;
  const L = Vch * l / (2 * kap);
  const dTf = 0.754 * q * l / kth / Math.sqrt(Math.max(L, 5));
  // the chip softens near its solidus, which caps the interface temperature (smooth saturation)
  const Tcap = 0.95 * (mat.Tm ?? 1500);
  const sat = T => T0 + (Tcap - T0) * Math.tanh((T - T0) / (Tcap - T0));
  const shear = sat(T0 + dTs);
  return { tool: sat(T0 + dTs + dTf), shear, chip: sat(T0 + dTs + 0.5 * dTf), phi, hc: hc * 1e3, gamma };
}

function usui(Vc, tempC) {
  const th = tempC + 273.15;
  // continuous at the switch temperature
  return th < THETA_SW ? Vc * Math.exp(-LAMBDA_LO / th) : Vc * Math.exp(-LAMBDA_LO / THETA_SW + LAMBDA_HI / THETA_SW - LAMBDA_HI / th);
}

const calib = new Map();
// flank wear rate [mm per second of contact]
export function wearRate(mat, Vc, tempC) {
  let A = calib.get(mat);
  if (A === undefined) {
    const Vr = mat.vc / 60, Tr = cuttingTemperature(mat, H_REF, Vr).tool;
    A = VB_LIMIT / (mat.life * 60 * usui(Vr, Tr));
    calib.set(mat, A);
  }
  return A * usui(Vc, tempC);
}

// edge-force increase from the flank wear land [N/mm]
export function wornEdge(mat, VB) {
  return { Kte: mat.Kte + 0.1 * mat.Ktc * VB, Kre: mat.Kre + 0.2 * mat.Ktc * VB };
}
