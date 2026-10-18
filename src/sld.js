// Stability lobe diagram, zero-order (average tooth period) solution of Altintas & Budak (1995).
// Symmetric single-mode tool tip in x and y. Returns lobes as arrays of {rpm, alim[mm]}.

export function directionalCoeffs(Kr, phiSt, phiEx) {
  const F = (p) => ({
    xx: 0.5 * (Math.cos(2 * p) - 2 * Kr * p + Kr * Math.sin(2 * p)),
    xy: 0.5 * (-Math.sin(2 * p) - 2 * p + Kr * Math.cos(2 * p)),
    yx: 0.5 * (-Math.sin(2 * p) + 2 * p + Kr * Math.cos(2 * p)),
    yy: 0.5 * (-Math.cos(2 * p) - 2 * Kr * p - Kr * Math.sin(2 * p)),
  });
  const a = F(phiEx), b = F(phiSt);
  return { xx: a.xx - b.xx, xy: a.xy - b.xy, yx: a.yx - b.yx, yy: a.yy - b.yy };
}

// complex helpers [re, im]
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const csqrt = (a) => { const r = Math.hypot(a[0], a[1]); const re = Math.sqrt((r + a[0]) / 2); const im = Math.sign(a[1] || 1) * Math.sqrt(Math.max(0, (r - a[0]) / 2)); return [re, im]; };

export function stabilityLobes({ k, fn, zeta, N, Ktc, Krc, phiSt, phiEx, lobes = 8, rpmMin = 1000, rpmMax = 40000 }) {
  const al = directionalCoeffs(Krc / Ktc, phiSt, phiEx);
  const det = al.xx * al.yy - al.xy * al.yx;
  const wn = 2 * Math.PI * fn;
  const out = [];
  const pts = [];
  for (let s = 0; s < 400; s++) {
    const wc = wn * (0.9 + 0.8 * s / 399);
    const r = wc / wn;
    const Phi = cdiv([1, 0], [k * (1 - r * r), k * 2 * zeta * r]); // mm/N
    const a0 = cmul(cmul(Phi, Phi), [det, 0]);
    const a1 = [(al.xx + al.yy) * Phi[0], (al.xx + al.yy) * Phi[1]];
    const disc = csqrt([cmul(a1, a1)[0] - 4 * a0[0], cmul(a1, a1)[1] - 4 * a0[1]]);
    let best = null;
    for (const sg of [1, -1]) {
      const num = [-(a1[0] + sg * disc[0]), -(a1[1] + sg * disc[1])];
      const L = cdiv(num, [2 * a0[0], 2 * a0[1]]);
      if (L[0] >= 0) continue;
      const kap = L[1] / L[0];
      const alim = -2 * Math.PI * L[0] * (1 + kap * kap) / (N * Ktc);
      if (alim > 0 && (!best || alim < best.alim)) best = { alim, kap };
    }
    if (best) pts.push({ wc, alim: best.alim, psi: Math.atan(best.kap) });
  }
  for (let j = 0; j < lobes; j++) {
    const lobe = [];
    for (const p of pts) {
      const eps = Math.PI - 2 * p.psi;
      const T = (eps + 2 * j * Math.PI) / p.wc;
      const rpm = 60 / (N * T);
      if (rpm >= rpmMin * 0.8 && rpm <= rpmMax * 1.2) lobe.push({ rpm, alim: p.alim });
    }
    lobe.sort((a, b) => a.rpm - b.rpm);
    if (lobe.length) out.push(lobe);
  }
  return out;
}

// Limiting depth at a given speed: minimum over lobes that cover this rpm.
export function alimAt(lobes, rpm) {
  let best = Infinity;
  for (const lobe of lobes) {
    for (let i = 1; i < lobe.length; i++) {
      const a = lobe[i - 1], b = lobe[i];
      if (rpm >= a.rpm && rpm <= b.rpm) {
        const t = (rpm - a.rpm) / (b.rpm - a.rpm || 1);
        best = Math.min(best, a.alim + (b.alim - a.alim) * t);
      }
    }
  }
  return best;
}
