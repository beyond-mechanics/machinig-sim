// End mill as a cantilever beam in series with a spindle/holder spring.
// Gives tool-tip stiffness, first natural frequency and bending/torsion stress.

const E_CARBIDE = 600000;    // MPa
const RHO_CARBIDE = 14500;   // kg/m³
export const ALLOWABLE_STRESS = 1500; // MPa, conservative working limit for carbide in bending (TRS ≈ 3500)

export function toolModel(t) {
  const D = t.D, L = t.stickout;
  const De = 0.8 * D;                       // equivalent diameter of the fluted section
  const I = Math.PI * De ** 4 / 64;         // mm⁴
  const kTool = 3 * E_CARBIDE * I / L ** 3; // N/mm
  const kTotal = 1 / (1 / kTool + 1 / t.kSpindle);
  // first cantilever mode of the tool alone (SI units)
  const EI = E_CARBIDE * 1e6 * I * 1e-12;
  const rhoA = RHO_CARBIDE * Math.PI * (De * 1e-3) ** 2 / 4;
  const wTool = 1.875 ** 2 * Math.sqrt(EI / rhoA) / (L * 1e-3) ** 2;
  // modal mass at the tip: tool's own participating mass plus the part of the holder/spindle
  // that moves with the dominant bending mode (lumped, ~50 g by default)
  const mEff = kTool * 1e3 / wTool ** 2 + (t.mHolder ?? 0.05);
  const fn = Math.sqrt(kTotal * 1e3 / mEff) / (2 * Math.PI);
  return { De, I, kTool, k: kTotal, fn, mEff };
}

// Bending + torsion at the holder face. F: radial resultant [N] acting at height zc above
// the tip, T: torque [N·mm]. Returns von Mises stress [MPa].
export function toolStress(t, I, De, F, zc, T) {
  const arm = Math.max(0, t.stickout - zc);
  const sigma = F * arm * (De / 2) / I;
  const tau = T * (De / 2) / (2 * I);
  return { sigma, tau, vm: Math.sqrt(sigma * sigma + 3 * tau * tau) };
}
