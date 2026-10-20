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

// ---- interrupted cutting: the edge temperature over one revolution ----
// In milling each edge is in the cut for a share of the revolution and cools for the rest, so
// the rake face cycles between a peak at the end of the contact and a low just before the next
// one. The temperature above (cuttingTemperature) is the quasi-steady value of a continuous cut.
// The tool is a semi-infinite carbide body heated over the contact zone, taken as a disc of
// radius a = contact length (2·hc). The centre of a disc source of constant flux rises as
// (Carslaw & Jaeger) θ(t)/θ_ss = g(t) = (2√(κt)/a)·(1/√π − ierfc(a / 2√(κt))),
// which starts as the 1-D semi-infinite rise and settles at the steady value within ~a²/κ
// (≈ 0.4 ms for a 0.1 mm contact). Heating for t_on once per period P is the superposition
// Σₙ [g(t + nP) − g(t + nP − t_on)] (periodic steady state; the tail of the series in closed form
// from g ≈ 1 − a/√(πκt)). Coolant cools the face while it is out of the cut: the excess at the
// low falls by exp(β²)·erfc(β), β = h·√(κ·t_off)/k (a convectively cooled semi-infinite surface).
// The swing ΔT drives thermal cracking of carbide (comb cracks across the edge); with the surface
// layer held by the cooler bulk the thermal stress is about E·α·ΔT/(1 − ν).
export const CARBIDE = { k: 80, rho: 14500, cp: 220, E: 600e3, alpha: 5.5e-6, nu: 0.22 }; // W/mK, kg/m³, J/kgK, MPa, 1/K
export const SWING_CRACK = 400; // °C: swings beyond about this crack carbide edges in a few hundred cycles (guide)
// surface heat transfer while out of the cut [W/m²K]
const H_COOL = { dry: 50, air: 1500, flood: 1.2e4, through: 2.5e4 };

function erfc(x) {
  // Numerical Recipes erfcc, fractional error < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const ierfc = x => Math.exp(-x * x) / Math.sqrt(Math.PI) - x * erfc(x);
// normalised step response of the disc centre, t in units of a²/κ
function gStep(t) {
  if (!(t > 0)) return 0;
  const s = Math.sqrt(t);
  return 2 * s * (1 / Math.sqrt(Math.PI) - ierfc(1 / (2 * s)));
}

// Tss: quasi-steady edge temperature [°C]; S [min⁻¹]; duty: share of the revolution in the cut;
// lc: contact length [mm]; coolant: 'dry' | 'air' | 'flood' | 'through'.
// Returns { max, min, mean, onMean (mean while in the cut), swing [°C], stress [MPa] (thermal
// stress amplitude), tOn [ms] }.
export function edgeCycle(Tss, S, duty, lc, coolant = 'dry', tool = CARBIDE) {
  const dT = Math.max(0, Tss - T0);
  if (!(S > 0) || !(duty > 0) || !(lc > 0) || !(dT > 0)) return { max: Tss, min: Tss, mean: Tss, onMean: Tss, swing: 0, stress: 0, tOn: 0 };
  const kap = tool.k / (tool.rho * tool.cp), a = lc * 1e-3, tau = a * a / kap; // s
  const P = 60 / S / tau, d = Math.min(1, duty), on = d * P;                  // in units of τ
  if (d >= 1) return { max: Tss, min: Tss, mean: Tss, onMean: Tss, swing: 0, stress: 0, tOn: 60 / S * 1e3 };
  // θ(t)/θ_ss in the periodic steady state, t in [0, P) from the start of the contact
  const N = 120, c = 1 / Math.sqrt(Math.PI);
  const theta = t => {
    let v = 0;
    for (let n = 0; n < N; n++) v += gStep(t + n * P) - gStep(t + n * P - on);
    // tail n ≥ N: g(t) − g(t − on) ≈ c·(1/√(t − on) − 1/√t), summed as an integral from N − ½
    const x0 = t + (N - 0.5) * P;
    return v + 2 * c / P * (Math.sqrt(x0) - Math.sqrt(x0 - on));
  };
  const hi = theta(on), lo0 = theta(P);
  // mean over the contact (Simpson): the temperature the wear law sees while the edge cuts
  const M = 12;
  let onMean = 0;
  for (let q = 0; q <= M; q++) onMean += (q === 0 || q === M ? 1 : q % 2 ? 4 : 2) * theta(on * q / M);
  onMean /= 3 * M;
  const h = H_COOL[coolant] ?? H_COOL.dry, beta = h * Math.sqrt(kap * (60 / S) * (1 - d)) / tool.k;
  const lo = lo0 * Math.exp(beta * beta) * erfc(beta);
  const max = T0 + dT * hi, min = T0 + dT * lo, swing = max - min;
  return { max, min, mean: T0 + dT * d, onMean: T0 + dT * onMean, swing, stress: tool.E * tool.alpha * swing / (1 - tool.nu), tOn: on * tau * 1e3 };
}
