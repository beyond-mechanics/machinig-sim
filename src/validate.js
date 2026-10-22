// Validation against a measured cutting-force record (table dynamometer).
// A record is folded onto the spindle angle and averaged over its revolutions (synchronous
// averaging): what repeats every revolution stays (the cutting force of each tooth, runout),
// noise and anything not locked to the spindle (chatter, structure ringing) averages out and is
// reported apart as the asynchronous part. The simulator gives the same revolution for the same
// test; the two are lined up in angle (the record's start angle is unknown) and compared.
// From the averaged waveform the six edge-force coefficients follow by linear least squares
// (the waveform is linear in them, as the mean force is in identify.js, but its shape tells the
// shearing terms, ∝ h, from the edge terms, constant while a tooth is in the cut, at one feed),
// and the radial runout (magnitude and direction) by a search over the tooth-to-tooth pattern.
// Frame and sign as in identify.js: feed along +X, Y 90° to its left, Z up, force on the workpiece.
import { CuttingEngine, BINS } from './cutting.js';
import { COEF_KEYS, immersion } from './identify.js';

export const NB = 360;                 // angle bins per revolution
const RIGID = { k: 1e9, fn: 1000, zeta: 0.5 };
const COMP = ['Fx', 'Fy', 'Fz'];

// CSV: "t,Fx,Fy[,Fz]" in s and N (comma, tab, semicolon or spaces; a header row is skipped),
// with the test on "# key=value" lines: S [min⁻¹], fz [mm/tooth], ap, ae [mm], mode slot|down|up,
// and optionally D, N, helix [°], runout [µm] of the tool. Returns { test, t, F: [Fx, Fy, Fz], bad }.
export function parseRecord(text) {
  const test = {}, t = [], F = [[], [], []], bad = [];
  let hasZ = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const c = line.match(/^\s*#(.*)$/);
    if (c) {
      for (const m of c[1].matchAll(/([A-Za-z]+)\s*=\s*([^\s,;]+)/g)) {
        const k = m[1].toLowerCase(), v = m[2];
        if (k === 'mode') test.mode = v.toLowerCase();
        else if (Number.isFinite(+v)) test[{ s: 'S', d: 'D', n: 'N' }[k] || k] = +v;
      }
      return;
    }
    const s = line.trim();
    if (!s) return;
    const v = s.split(/[\s,;]+/).map(Number);
    if (v.length < 3 || v.slice(0, 3).some(x => !Number.isFinite(x))) { if (!/^[A-Za-z"]/.test(s)) bad.push(i + 1); return; }
    t.push(v[0]); F[0].push(v[1]); F[1].push(v[2]);
    if (v.length > 3 && Number.isFinite(v[3])) { F[2].push(v[3]); hasZ = true; } else F[2].push(0);
  });
  test.mode = ['slot', 'down', 'up'].includes(test.mode) ? test.mode : 'slot';
  return { test, t, F, hasZ, bad };
}

// fold onto the spindle angle: { avg: [3][NB], revs, asyncRms: [3], ppAvg: [3] } — the angle is
// taken from the record's own clock and S, so revolution 0 starts at the record's first sample
export function syncAverage(t, F, S) {
  const sum = F.map(() => new Float64Array(NB)), cnt = new Float64Array(NB);
  const rev = S / 60, t0 = t[0];
  for (let i = 0; i < t.length; i++) {
    const a = (t[i] - t0) * rev, b = Math.min(NB - 1, Math.floor((a - Math.floor(a)) * NB));
    for (let c = 0; c < 3; c++) sum[c][b] += F[c][i];
    cnt[b]++;
  }
  // bins the record never hit (a coarse sampling rate) take the neighbours' mean
  const avg = sum.map(s => Float64Array.from(s, (v, b) => (cnt[b] ? v / cnt[b] : NaN)));
  for (const a of avg) for (let b = 0; b < NB; b++) if (Number.isNaN(a[b])) {
    let l = b, r = b; while (Number.isNaN(a[(l + NB) % NB]) && l > b - NB) l--; while (Number.isNaN(a[r % NB]) && r < b + NB) r++;
    a[b] = (a[(l + NB) % NB] + a[r % NB]) / 2;
  }
  // what does not repeat every revolution (noise, chatter, ringing)
  const asyncRms = [0, 1, 2].map(c => {
    let s = 0;
    for (let i = 0; i < t.length; i++) { const a = (t[i] - t0) * rev, b = Math.min(NB - 1, Math.floor((a - Math.floor(a)) * NB)); s += (F[c][i] - avg[c][b]) ** 2; }
    return Math.sqrt(s / Math.max(1, t.length));
  });
  const revs = t.length > 1 ? (t[t.length - 1] - t0) * rev : 0;
  return { avg, revs, asyncRms, cnt };
}

// one revolution from the simulator's cutting model, rigid tool: [3][NB] force on the workpiece.
// tool: {D, N, helixDeg, type, fluteLen, runout [µm], runoutPhase [rad]}; test: {fz, ap, ae, mode, S}
export function simRevolution(tool, mat, test) {
  const [st, ex] = immersion(test.mode, test.ae, tool.D);
  const e = new CuttingEngine();
  e.configure({ N: tool.N, R: tool.D / 2, helixDeg: tool.helixDeg ?? 30, type: tool.type || 'flat', fluteLen: Math.max(tool.fluteLen || 0, test.ap + 1),
    runout: (tool.runout ?? 0) / 1000, runoutPhase: tool.runoutPhase ?? 0, nonlinear: (mat.mc ?? 0) > 0 }, RIGID, { Ci: 0, ...mat }, test.S || 6000);
  for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi >= st && phi <= ex ? 0 : -1e3; }
  e.setEngagement([1, 0], test.fz, -test.ap, test.ap);
  e.decim = 1;
  e.run(e.stepsPerRev * 2);
  e.hist.i = 0; e.hist.count = 0;
  const n = e.stepsPerRev;
  if (n > e.hist.n) throw new Error('1 回転のステップ数が履歴より多い');
  e.run(n);
  // steps → angle bins (forces on the workpiece: the reaction to those on the tool)
  return COMP.map(k => Float64Array.from({ length: NB }, (_, b) => {
    const x = (b + 0.5) / NB * n - 0.5, i0 = Math.floor(x), f = x - i0, a = e.hist[k][(i0 + n) % n], c = e.hist[k][(i0 + 1) % n];
    return -(a + (c - a) * f);
  }));
}

// best circular shift s (bins) of the simulated revolution onto the measured one (Fx and Fy)
export function align(meas, sim) {
  let best = 0, bestV = -Infinity;
  for (let s = 0; s < NB; s++) {
    let v = 0;
    for (let c = 0; c < 2; c++) { const m = meas[c], p = sim[c]; for (let b = 0; b < NB; b++) v += m[b] * p[(b - s + NB) % NB]; }
    if (v > bestV) { bestV = v; best = s; }
  }
  return best;
}
export const shifted = (sim, s) => sim.map(a => Float64Array.from({ length: NB }, (_, b) => a[(b - s + NB) % NB]));

// per component: mean, peak-to-peak (measured and simulated), RMS error relative to the measured
// peak-to-peak, correlation
export function compare(meas, sim, comps = [0, 1, 2]) {
  return comps.map(c => {
    const m = meas[c], p = sim[c];
    const mean = a => a.reduce((s, v) => s + v, 0) / NB, pp = a => Math.max(...a) - Math.min(...a);
    const mm = mean(m), pm = mean(p);
    let se = 0, sxy = 0, sxx = 0, syy = 0;
    for (let b = 0; b < NB; b++) { const dm = m[b] - mm, dp = p[b] - pm; se += (m[b] - p[b]) ** 2; sxy += dm * dp; sxx += dm * dm; syy += dp * dp; }
    return { comp: COMP[c], meanM: mm, meanS: pm, ppM: pp(m), ppS: pp(p), rmsPct: Math.sqrt(se / NB) / Math.max(1e-9, pp(m)) * 100, r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0 };
  });
}

// least squares of the six coefficients on the aligned waveform (unit waveforms per coefficient)
function fitCoefs(tool, test, meas, comps, mc, Ci = 0) {
  const U = COEF_KEYS.map(key => simRevolution(tool, { Ktc: 0, Krc: 0, Kac: 0, Kte: 0, Kre: 0, Kae: 0, [key]: 1, mc, Ci }, test));
  // the shift is found once on the sum of the unit waveforms weighted by typical sizes; it is
  // re-found below with the fitted coefficients
  const rows = [], y = [];
  const build = s => { rows.length = 0; y.length = 0; for (const c of comps) for (let b = 0; b < NB; b++) { rows.push(U.map(u => u[c][(b - s + NB) % NB])); y.push(meas[c][b]); } };
  const solveLS = () => {
    const n = 6, nrm = [...Array(n)].map((_, j) => Math.hypot(...rows.map(r => r[j])) || 1);
    const A = [...Array(n)].map((_, a) => [...Array(n)].map((_, b) => rows.reduce((s, r) => s + r[a] / nrm[a] * r[b] / nrm[b], 0)));
    const v = [...Array(n)].map((_, a) => rows.reduce((s, r, i) => s + r[a] / nrm[a] * y[i], 0));
    // Gauss–Jordan
    const M = A.map((r, i) => [...r, v[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) { M[c][c] = 1e-12; }
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i] / nrm[i]);
  };
  const sse = x => rows.reduce((s, r, i) => s + (y[i] - r.reduce((q, v, j) => q + v * x[j], 0)) ** 2, 0);
  // try every shift on a coarse grid, then refine around the best
  let best = null;
  const tryShift = s => { build(s); const x = solveLS(), e = sse(x); if (!best || e < best.e) best = { s, x, e }; };
  for (let s = 0; s < NB; s += 4) tryShift(s);
  const s0 = best.s;
  for (let s = s0 - 3; s <= s0 + 3; s++) tryShift((s + NB) % NB);
  return { coefs: Object.fromEntries(COEF_KEYS.map((k, j) => [k, best.x[j]])), shift: best.s, sse: best.e };
}

// coefficients and runout from one averaged revolution. Runout: a grid over its size (0 to
// runoutMax µm) and direction; for each, the coefficients by least squares; the best fit wins.
// Returns { coefs, runout, runoutPhase, shift, sim, cmp }.
export function fitRecord(tool, mat, test, meas, { comps = [0, 1, 2], runoutMax = 30, onProgress } = {}) {
  const mc = mat.mc ?? 0;
  // runout changes the tooth-to-tooth pattern only; scan it with the present coefficients (cheap),
  // then fit the coefficients at the best few candidates
  const cand = [];
  const phases = Array.from({ length: 24 }, (_, i) => i / 24 * 2 * Math.PI);
  const sizes = [0, 1, 2, 3, 4, 6, 8, 10, 13, 16, 20, 25, 30].filter(e => e <= runoutMax);
  for (const e of sizes) for (const g of (e ? phases : [0])) {
    const sim = simRevolution({ ...tool, runout: e, runoutPhase: g }, mat, test);
    // the overall level is the coefficients' business: compare shapes after the best scale
    const s = align(meas, sim);
    let num = 0, den = 0;
    for (const c of comps) for (let b = 0; b < NB; b++) { const p = sim[c][(b - s + NB) % NB]; num += meas[c][b] * p; den += p * p; }
    const k = den > 0 ? num / den : 1;
    let err = 0;
    for (const c of comps) for (let b = 0; b < NB; b++) err += (meas[c][b] - k * sim[c][(b - s + NB) % NB]) ** 2;
    cand.push({ e, g, err });
  }
  cand.sort((a, b) => a.err - b.err);
  let best = null;
  const top = cand.slice(0, 3);
  top.forEach((c, i) => {
    onProgress?.(i / top.length);
    const t = { ...tool, runout: c.e, runoutPhase: c.g };
    const f = fitCoefs(t, test, meas, comps, mc, mat.Ci ?? 0);
    if (!best || f.sse < best.sse) best = { ...f, runout: c.e, runoutPhase: c.g };
  });
  // the grid is coarse (a runout between its sizes would be absorbed by biased coefficients):
  // refine size and direction by a pattern search on the full fit
  const evalAt = (e, g) => { const f = fitCoefs({ ...tool, runout: e, runoutPhase: g }, test, meas, comps, mc, mat.Ci ?? 0); return { ...f, runout: e, runoutPhase: g }; };
  let de = 1, dg = 7.5 * Math.PI / 180;
  for (let it = 0; it < 4; it++) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [a, c] of [[de, 0], [-de, 0], [0, dg], [0, -dg]]) {
        const e = best.runout + a, g = best.runoutPhase + c;
        if (e < 0 || e > runoutMax || (best.runout === 0 && c)) continue;
        const f = evalAt(e, g);
        if (f.sse < best.sse * (1 - 1e-6)) { best = f; moved = true; }
      }
      onProgress?.(0.5 + it / 8);
    }
    de /= 2; dg /= 2;
  }
  best.runout = Math.round(best.runout * 10) / 10;
  best.runoutPhase = ((best.runoutPhase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const coefs = { ...mat, ...best.coefs };
  const sim = shifted(simRevolution({ ...tool, runout: best.runout, runoutPhase: best.runoutPhase }, coefs, test), best.shift);
  return { coefs: best.coefs, runout: best.runout, runoutPhase: best.runoutPhase, shift: best.shift, sim, cmp: compare(meas, sim, comps) };
}

// A synthetic record for trying the tools out (clearly not a measurement): the simulator's own
// revolution with the given coefficients and runout, sampled at fs, with white noise and an
// optional asynchronous ringing. Returns CSV text.
export function syntheticRecord(tool, mat, test, { fs = 20000, revs = 20, noise = 0.03, ring = 0, ringHz = 2317, seed = 1 } = {}) {
  const sim = simRevolution(tool, mat, test);
  const pp = Math.max(...sim[0]) - Math.min(...sim[0]);
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const T = revs * 60 / test.S, n = Math.floor(T * fs), start = rnd();
  const lines = ['# 合成データ (シミュレーターで作った例。実測ではありません)',
    `# S=${test.S} fz=${test.fz} ap=${test.ap} ae=${test.ae} mode=${test.mode} D=${tool.D} N=${tool.N} helix=${tool.helixDeg ?? 30}`,
    't,Fx,Fy,Fz'];
  for (let i = 0; i < n; i++) {
    const t = i / fs, a = (t * test.S / 60 + start) % 1, x = a * NB - 0.5, b0 = Math.floor(x), f = x - b0;
    const at = c => sim[c][(b0 + NB) % NB] * (1 - f) + sim[c][(b0 + 1) % NB] * f;
    const r = ring * pp * Math.sin(2 * Math.PI * ringHz * t);
    lines.push([t.toFixed(6), ...[0, 1, 2].map(c => (at(c) + noise * pp * gauss() + (c < 2 ? r : 0)).toFixed(2))].join(','));
  }
  return lines.join('\n');
}

// The part of the record that does not repeat every revolution, as a spectrum: its largest peak
// away from the tooth-passing harmonics is chatter or a structure ringing (a stable cut leaves
// noise only). Returns { f [Hz], amp [N] (peak amplitude), share (of the asynchronous RMS) } or null.
export function asyncPeak(t, F, S, N, avg, comps = [0, 1]) {
  const n0 = t.length;
  if (n0 < 64) return null;
  const fs = (n0 - 1) / (t[n0 - 1] - t[0]);
  let n = 1; while (n * 2 <= n0) n *= 2;
  const rev = S / 60, t0 = t[0];
  const P = new Float64Array(n / 2);
  for (const c of comps) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (t[i] - t0) * rev, b = Math.min(NB - 1, Math.floor((a - Math.floor(a)) * NB));
      re[i] = (F[c][i] - avg[c][b]) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))); // Hann
    }
    fft(re, im);
    for (let k = 1; k < n / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
  }
  const df = fs / n, ftp = rev * N;
  let best = -1, tot = 0;
  for (let k = 1; k < n / 2; k++) {
    tot += P[k];
    const f = k * df, h = f / ftp;
    // skip the tooth-passing harmonics (± 2 bins): what the average missed of them is not chatter
    if (Math.abs(h - Math.round(h)) * ftp < 2 * df && Math.round(h) > 0) continue;
    if (f < 5 * df) continue;
    if (best < 0 || P[k] > P[best]) best = k;
  }
  if (best < 0 || !(tot > 0)) return null;
  // the peak with its two neighbours (Hann spreads a tone over three bins)
  const pk = P[best - 1] + P[best] + (P[best + 1] || 0);
  // amplitude of a tone: Hann coherent gain 0.5, so |X| ≈ A·n/4 per component
  // (the three bins of a Hann-windowed tone hold 1 + ¼ + ¼ of its centre-bin energy)
  return { f: best * df, amp: Math.sqrt(pk / 1.5 / comps.length) * 4 / n, share: pk / tot, fs };
}

// radix-2 in-place FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
