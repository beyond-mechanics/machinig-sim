// Cutting coefficients predicted from the work material's constants, without a cutting test.
// Oxley's predictive machining theory for orthogonal cutting (Oxley 1989), with the work
// material's flow stress given by Johnson–Cook (Lalwani, Mehta & Jain 2009):
//   σ = (A + B·εⁿ)·(1 + C·ln ε̇)·(1 − T*ᵐ),  T* = (T − T_r)/(T_m − T_r),  ε̇₀ = 1 s⁻¹
// Primary zone (shear plane AB of length l = t₁/sin φ, thickness l/C₀):
//   γ_AB = cos α / (2 sin φ cos(φ − α)),  γ̇_AB = C₀·V_s / l,  ε = γ/√3, ε̇ = γ̇/√3
//   T_AB = T_w + η·(1 − β)·F_s·V_s / (ρ S t₁ w V)   (β: Boothroyd's share of heat into the work)
//   n_eq = n·B·εⁿ / (A + B·εⁿ),  tan θ = 1 + 2(π/4 − φ) − C₀·n_eq,  λ = θ − φ + α
//   F_s = k_AB·l·w,  R = F_s / cos θ,  F_c = R cos(λ − α),  F_t = R sin(λ − α)
// Secondary zone (tool–chip interface, thickness δ·t₂, contact length h):
//   h = t₁ sin θ / (cos λ sin φ) · (1 + C₀ n_eq / (3 tan θ)),  τ_int = F / (h w)
//   T_int = T_w + ΔT_SZ + ψ·ΔT_M,  log(ΔT_M/ΔT_C) = 0.06 − 0.195 δ √(R_T t₂/h) + 0.5 log(R_T t₂/h)
//   ε_int = 2ε_AB + γ_M/(2√3), γ_M = h/(δ t₂),  ε̇_int = V_c / (√3 δ t₂)
// The shear angle φ makes the interface shear stress equal the chip's flow stress there, C₀
// makes the normal stress at the cutting edge from the shear-plane stress field equal the
// interface normal stress, and δ minimises the cutting force.
// Milling coefficients (Ktc, Krc, Kac) follow from the orthogonal shear stress, shear angle and
// friction angle by the oblique transformation with the helix as the inclination angle and
// Stabler's chip-flow rule (Budak, Altintas & Armarego 1996). The tool is taken as sharp: the
// edge (ploughing) coefficients are not predicted and stay as they are.

const SQ3 = Math.sqrt(3), D2R = Math.PI / 180;
const ETA = 0.9, PSI = 0.7, TW = 20;

// Johnson–Cook constants [MPa] (A, B, n, C, m) with the reference and melting temperatures [°C].
// Literature fits from split-Hopkinson-bar tests; A5052 is an estimate from the H34 temper's
// tensile data with the softening of 6061.
export const JC = {
  A5052: { A: 215, B: 280, n: 0.34, C: 0.006, m: 1.2, Tm: 607 },
  A7075: { A: 546, B: 678, n: 0.71, C: 0.024, m: 1.56, Tm: 635 },  // 7075-T6
  S50C: { A: 553.1, B: 600.8, n: 0.234, C: 0.0134, m: 1, Tm: 1460 }, // AISI 1045 (Jaspers & Dautzenberg)
  SUS304: { A: 310, B: 1000, n: 0.65, C: 0.07, m: 1, Tm: 1400 },     // AISI 304
  Ti64: { A: 862, B: 331, n: 0.34, C: 0.012, m: 0.8, Tm: 1604 },     // Ti-6Al-4V (Lee & Lin)
  SCM440: { A: 598, B: 768, n: 0.2092, C: 0.0137, m: 0.807, Tm: 1520 }, // AISI 4140
  SKD61: { A: 908.5, B: 321.3, n: 0.278, C: 0.028, m: 1.18, Tm: 1480 }, // AISI H13, hardened
  IN718: { A: 1241, B: 622, n: 0.6522, C: 0.0134, m: 1.3, Tm: 1336 },   // Inconel 718
};

export function flowStress(jc, eps, epsDot, T) {
  const Ts = Math.min(1, Math.max(0, (T - TW) / ((jc.Tm ?? 1500) - TW)));
  return (jc.A + jc.B * Math.max(eps, 1e-6) ** jc.n) * (1 + jc.C * Math.log(Math.max(epsDot, 1))) * Math.max(1 - Ts ** jc.m, 0.01);
}

// one trial of (φ, C₀, δ). th: {rho, cp, kth}; cut: {V [m/s], t1 [mm], w [mm], alpha [rad]}
function trial(jc, th, cut, phi, C0, delta) {
  const { V, alpha: a } = cut, t1 = cut.t1 * 1e-3, w = cut.w * 1e-3;
  const rS = th.rho * th.cp;
  const sp = Math.sin(phi), cpa = Math.cos(phi - a);
  const l = t1 / sp, Vs = V * Math.cos(a) / cpa, Vc = V * sp / cpa;
  const gAB = Math.cos(a) / (2 * sp * cpa), eAB = gAB / SQ3, edAB = C0 * Vs / l / SQ3;
  const RT = rS * V * t1 / th.kth, x = RT * Math.tan(phi);
  const beta = Math.min(1, Math.max(0, x > 10 ? 0.3 - 0.15 * Math.log10(x) : 0.5 - 0.35 * Math.log10(x)));
  // the shear-plane temperature softens the material that heats it: fixed point
  let TAB = TW, kAB = 0, dTSZ = 0;
  for (let it = 0; it < 30; it++) {
    kAB = flowStress(jc, eAB, edAB, TAB) / SQ3 * 1e6; // Pa
    dTSZ = (1 - beta) * kAB * l * w * Vs / (rS * t1 * w * V);
    const Tn = TW + ETA * dTSZ;
    if (Math.abs(Tn - TAB) < 0.05) { TAB = Tn; break; }
    TAB = 0.5 * (TAB + Tn);
  }
  const eB = jc.B * eAB ** jc.n, neq = jc.n * eB / (jc.A + eB);
  const tanT = 1 + 2 * (Math.PI / 4 - phi) - C0 * neq;
  if (!(tanT > 0)) return null;
  const theta = Math.atan(tanT), lam = theta - phi + a;
  if (!(lam > 0 && lam < Math.PI / 2)) return null;
  const Fs = kAB * l * w, R = Fs / Math.cos(theta);
  const Fc = R * Math.cos(lam - a), Ft = R * Math.sin(lam - a), F = R * Math.sin(lam), N = R * Math.cos(lam);
  const sNA = kAB * (1 + Math.PI / 2 - 2 * a - 2 * C0 * neq);
  const t2 = t1 * cpa / sp;
  const h = t1 * Math.sin(theta) / (Math.cos(lam) * sp) * (1 + C0 * neq / (3 * tanT));
  const tauInt = F / (h * w), sN = N / (h * w);
  const dTC = F * Vc / (rS * t1 * w * V), xr = RT * t2 / h;
  const dTM = dTC * 10 ** (0.06 - 0.195 * delta * Math.sqrt(xr) + 0.5 * Math.log10(xr));
  const Tint = TW + dTSZ + PSI * dTM;
  const gM = h / (delta * t2);
  const kChip = flowStress(jc, 2 * eAB + gM / (2 * SQ3), Vc / (SQ3 * delta * t2), Tint) / SQ3 * 1e6;
  return { phi, C0, delta, theta, lam, kAB, Fs, Fc, Ft, F, N, sNA, sN, tauInt, kChip, TAB, Tint, t2: t2 * 1e3, h: h * 1e3, beta, eAB, edAB };
}

// a crossing of f from + to − over [lo, hi] (n steps), refined by bisection; else the
// smallest |f|. Both residuals fall through zero at the physical solution (the interface
// stress drops as the shear angle opens; the edge normal stress drops as C₀ grows). At a tiny
// shear angle the shear zone reaches the melting point and the softened chip gives spurious
// crossings, so the shear angle takes the last crossing (last = true).
function root(f, lo, hi, n, keep, last = false) {
  const val = r => (r ? keep(r) : NaN);
  let best = null, hit = null, pa = lo, ra = f(lo);
  const consider = (p, r) => { if (r && (!best || Math.abs(keep(r)) < Math.abs(keep(best.r)))) best = { p, r }; };
  consider(pa, ra);
  for (let i = 1; i <= n; i++) {
    const pb = lo + (hi - lo) * i / n, rb = f(pb);
    consider(pb, rb);
    if (val(ra) >= 0 && val(rb) <= 0) { hit = [pa, pb, rb]; if (!last) break; }
    pa = pb; ra = rb;
  }
  if (!hit) return best ? { ...best, converged: false } : null;
  let [a, b, r] = hit;
  for (let k = 0; k < 30; k++) {
    const m = 0.5 * (a + b), rm = f(m), gm = val(rm);
    if (!Number.isFinite(gm)) break;
    r = rm;
    if (gm >= 0) a = m; else b = m;
  }
  return { p: 0.5 * (a + b), r, converged: true };
}

// Orthogonal solution. cut: {V [m/s], t1 [mm], w [mm], alpha [rad]}
export function oxley(jc, th, cut) {
  const atC0 = (C0, delta) => root(phi => trial(jc, th, cut, phi, C0, delta), 3 * D2R, 50 * D2R, 47, r => r.tauInt - r.kChip, true);
  const atDelta = delta => {
    const s = root(C0 => atC0(C0, delta)?.r ?? null, 1, 12, 22, r => r.sNA - r.sN);
    return s && { ...s.r, converged: s.converged };
  };
  // δ: the force is flat near its minimum, so a coarse scan with a golden-section finish
  let best = null;
  for (let d = 0.01; d <= 0.2001; d += 0.01) {
    const r = atDelta(d);
    if (r && (!best || r.Fc < best.Fc)) best = r;
  }
  if (!best) return null;
  let a = Math.max(0.003, best.delta - 0.01), b = Math.min(0.25, best.delta + 0.01);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 12; k++) {
    const c = b - g * (b - a), d = a + g * (b - a), rc = atDelta(c), rd = atDelta(d);
    if ((rc?.Fc ?? Infinity) < (rd?.Fc ?? Infinity)) { b = d; if (rc && rc.Fc < best.Fc) best = rc; } else { a = c; if (rd && rd.Fc < best.Fc) best = rd; }
  }
  return best;
}

// oblique transformation of an orthogonal solution: coefficients [N/mm²] for inclination i [rad]
export function obliqueCoefs(r, alphaN, i) {
  const tauS = r.kAB * 1e-6, phiN = r.phi, eta = i;   // Stabler: chip flow angle = inclination
  const bN = Math.atan(Math.tan(r.lam) * Math.cos(eta));
  const c = Math.sqrt(Math.cos(phiN + bN - alphaN) ** 2 + Math.tan(eta) ** 2 * Math.sin(bN) ** 2);
  const s = tauS / Math.sin(phiN) / c;
  return {
    Ktc: s * (Math.cos(bN - alphaN) + Math.tan(i) * Math.tan(eta) * Math.sin(bN)),
    Krc: s * Math.sin(bN - alphaN) / Math.cos(i),
    Kac: s * (Math.cos(bN - alphaN) * Math.tan(i) - Math.tan(eta) * Math.sin(bN)),
  };
}

export const H_REF = 0.05; // mm, chip thickness of the reported coefficients (the size-effect reference)
// below ~0.05 mm the sharp-tool theory has no solution for most δ (the edge radius takes over)
const H_FIT = [0.05, 0.1, 0.15, 0.2];

// Milling coefficients for a material at cutting speed Vc [m/min] with normal rake rakeDeg and
// helix helixDeg. Returns { Ktc, Krc, Kac, mc, at: orthogonal solution at H_REF, rows: per h }.
export function predictCoefs(jc, th, { Vc, rakeDeg = 10, helixDeg = 30 }) {
  const alpha = rakeDeg * D2R, i = helixDeg * D2R, V = Vc / 60;
  const rows = [];
  for (const t1 of H_FIT) {
    const r = oxley(jc, th, { V, t1, w: 1, alpha });
    if (r) rows.push({ h: t1, ...obliqueCoefs(r, alpha, i), Kc0: r.Fc / t1, Kt0: r.Ft / t1, r });
  }
  const ref = rows.find(q => q.h === H_REF);
  if (!ref || rows.length < 2) return null;
  // size effect K(h) = K(h₀)·(h₀/h)^mc, least squares in log–log
  const X = rows.map(q => Math.log(H_REF / q.h)), Y = rows.map(q => Math.log(q.Ktc / ref.Ktc));
  const mc = Math.max(0, X.reduce((s, x, k) => s + x * Y[k], 0) / X.reduce((s, x) => s + x * x, 0));
  return { Ktc: ref.Ktc, Krc: ref.Krc, Kac: ref.Kac, mc, at: ref.r, rows };
}
