// Tool-tip frequency response functions: modal sets per direction, FRF evaluation, CSV import
// of a measured (hammer test) FRF and a peak-picking fit back to modes.
// Mode: {k [N/mm], fn [Hz], zeta}. FRF values in mm/N.

// modal: {k, fn, zeta} for a symmetric single mode, optionally with modesX / modesY arrays
export function modeSet(modal) {
  const one = [{ k: modal.k, fn: modal.fn, zeta: modal.zeta }];
  const x = modal.modesX?.length ? modal.modesX : one;
  const y = modal.modesY?.length ? modal.modesY : x;
  return { x, y };
}

// G(f) = Σ 1 / (k (1 - r² + 2iζr)), [re, im] in mm/N
export function frf(modes, f) {
  let re = 0, im = 0;
  for (const m of modes) {
    const r = f / m.fn, a = 1 - r * r, b = 2 * m.zeta * r, d = m.k * (a * a + b * b);
    re += a / d; im -= b / d;
  }
  return [re, im];
}

// static stiffness of a mode set [N/mm]
export const staticK = modes => 1 / modes.reduce((s, m) => s + 1 / m.k, 0);

// mode with the largest dynamic compliance 1/(2kζ): the one that limits stability
export const dominant = modes => modes.reduce((a, b) => (b.k * b.zeta < a.k * a.zeta ? b : a));

// CSV columns: f [Hz], Re Gxx, Im Gxx[, Re Gyy, Im Gyy]. Header lines and comments are
// skipped. Units m/N, or µm/N when the magnitudes are clearly too large for m/N.
export function parseFrfCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(/[,;\t ]+/).filter(Boolean).map(Number);
    if (c.length >= 3 && c.every(Number.isFinite) && c[0] > 0) rows.push(c);
  }
  if (rows.length < 10) throw new Error('数値の行が足りません (周波数, 実部, 虚部 の列が必要)');
  rows.sort((a, b) => a[0] - b[0]);
  const mags = rows.map(r => Math.hypot(r[1], r[2])).sort((a, b) => a - b);
  const scale = mags[mags.length >> 1] > 1e-3 ? 1e-3 : 1e3; // → mm/N
  const f = rows.map(r => r[0]);
  const xx = rows.map(r => [r[1] * scale, r[2] * scale]);
  const yy = rows.every(r => r.length >= 5) ? rows.map(r => [r[3] * scale, r[4] * scale]) : null;
  return { f, xx, yy, unit: scale === 1e3 ? 'm/N' : 'µm/N' };
}

// Peak picking on -Im G: each local maximum above 5 % of the largest becomes a mode,
// ζ from the half-power width of the peak and k from the peak height -Im = 1/(2kζ).
export function fitModes(f, G, maxModes = 4) {
  const n = f.length, q = G.map(g => -g[1]);
  const top = Math.max(...q);
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (q[i] > 0.05 * top && q[i] >= q[i - 1] && q[i] > q[i + 1]) peaks.push(i);
  const modes = [];
  for (const i of peaks) {
    const half = q[i] / 2;
    let a = i, b = i;
    while (a > 0 && q[a] > half) a--;
    while (b < n - 1 && q[b] > half) b++;
    // interpolate the half-power crossings
    const fa = a === i ? f[i] : f[a] + (half - q[a]) / (q[a + 1] - q[a] || 1) * (f[a + 1] - f[a]);
    const fb = b === i ? f[i] : f[b - 1] + (q[b - 1] - half) / (q[b - 1] - q[b] || 1) * (f[b] - f[b - 1]);
    const fn = f[i], zeta = Math.min(0.3, Math.max(0.003, (fb - fa) / (2 * fn)));
    modes.push({ fn, zeta, k: 1 / (2 * zeta * q[i]), peak: q[i] });
  }
  modes.sort((a, b) => b.peak - a.peak);
  return modes.slice(0, maxModes).map(({ k, fn, zeta }) => ({ k, fn, zeta })).sort((a, b) => a.fn - b.fn);
}

// Example: an asymmetric two-mode tool tip (holder mode + tool mode), as a measured CSV in m/N
export function exampleCsv() {
  const X = [{ k: 18000, fn: 1150, zeta: 0.05 }, { k: 11000, fn: 2250, zeta: 0.035 }];
  const Y = [{ k: 22000, fn: 1250, zeta: 0.05 }, { k: 13000, fn: 2400, zeta: 0.03 }];
  const lines = ['# f[Hz], Re Gxx, Im Gxx, Re Gyy, Im Gyy [m/N]'];
  for (let f = 200; f <= 5000; f += 5) {
    const gx = frf(X, f), gy = frf(Y, f);
    lines.push([f, gx[0] * 1e-3, gx[1] * 1e-3, gy[0] * 1e-3, gy[1] * 1e-3].map(v => +v.toPrecision(6)).join(','));
  }
  return lines.join('\n');
}
