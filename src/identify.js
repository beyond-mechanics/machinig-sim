// Cutting coefficients identified from cutting tests (mean forces at several feeds).
// The linear edge-force model is linear in its six coefficients, Ktc Krc Kac (shearing) and
// Kte Kre Kae (edge), so the mean force of a test is Σ K_j·F_j, where F_j is the mean force the
// simulator's own cutting model gives with that one coefficient set to 1 and the others to 0.
// Computing F_j with the same model (helix lag, runout, ball-nose radius, size effect) makes the
// identified values consistent with how the simulator uses them, whatever the tool and immersion.
// The six follow by least squares over all tests and all three components (Altintas' mean-force
// method generalised). Telling the shearing terms from the edge terms needs at least two feeds;
// with one feed the edge terms are held at their current values.
// Test frame: feed along +X, Y 90° to its left (counter-clockwise seen from above), Z up; forces
// are those on the workpiece (what a table dynamometer reads), the reaction to those on the tool.
import { CuttingEngine, BINS } from './cutting.js';

export const COEF_KEYS = ['Ktc', 'Krc', 'Kac', 'Kte', 'Kre', 'Kae'];
const RIGID = { k: 1e9, fn: 1000, zeta: 0.5 };

// engagement of a test: mode 'slot' | 'down' | 'up', ae [mm] radial depth
export function immersion(mode, ae, D) {
  if (mode === 'slot' || !(ae < D)) return [0, Math.PI];
  const pe = Math.acos(1 - 2 * ae / D);
  return mode === 'down' ? [Math.PI - pe, Math.PI] : [0, pe];
}

// mean force on the workpiece [N] for one coefficient at 1 (unit forces of a test).
// tool: {D, N, helixDeg, type, fluteLen, runout [µm]}; test: {fz, ap, ae, mode}; mc: size-effect exponent
export function unitForces(tool, test, mc = 0) {
  const [st, ex] = immersion(test.mode, test.ae, tool.D);
  const out = [];
  for (const key of COEF_KEYS) {
    const mat = { Ktc: 0, Krc: 0, Kac: 0, Kte: 0, Kre: 0, Kae: 0, [key]: 1, mc, Ci: 0 };
    const e = new CuttingEngine();
    e.configure({ N: tool.N, R: tool.D / 2, helixDeg: tool.helixDeg ?? 30, type: tool.type || 'flat', fluteLen: Math.max(tool.fluteLen || 0, test.ap + 1), runout: (tool.runout ?? 0) / 1000, nonlinear: mc > 0 }, RIGID, mat, 6000);
    for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi >= st && phi <= ex ? 0 : -1e3; }
    e.setEngagement([1, 0], test.fz, -test.ap, test.ap);
    e.run(e.stepsPerRev * 2); e.takeStats();
    e.run(e.stepsPerRev);
    const s = e.takeStats();
    out.push([-s.sumFx / s.n, -s.sumFy / s.n, -s.sumFz / s.n]);
  }
  return out;
}

// solve the normal equations (Gauss–Jordan with partial pivoting)
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// tests: [{fz, ap, ae, mode, Fx, Fy, Fz}]; current: the material's present coefficients (held
// for the edge terms with a single feed). Returns { coefs, rows: [{test, pred}], r2, rms, edgeFixed }.
export function identify(tool, tests, current, mc = 0) {
  if (!tests.length) return null;
  const U = tests.map(t => unitForces(tool, t, mc));
  const feeds = new Set(tests.map(t => t.fz.toFixed(4)));
  const edgeFixed = feeds.size < 2;
  const free = edgeFixed ? [0, 1, 2] : [0, 1, 2, 3, 4, 5];
  // rows: one per test and component; columns: the free coefficients
  const A = [], y = [];
  tests.forEach((t, i) => ['Fx', 'Fy', 'Fz'].forEach((c, k) => {
    let rhs = t[c];
    if (edgeFixed) for (const j of [3, 4, 5]) rhs -= current[COEF_KEYS[j]] * U[i][j][k];
    A.push(free.map(j => U[i][j][k])); y.push(rhs);
  }));
  // each column scaled to unit norm first: shearing and edge columns differ by ~1/fz
  const nrm = free.map((_, c) => Math.hypot(...A.map(r => r[c])) || 1);
  const As = A.map(r => r.map((v, c) => v / nrm[c]));
  const AtA = free.map((_, a) => free.map((_, b) => As.reduce((s, r) => s + r[a] * r[b], 0)));
  const Aty = free.map((_, a) => As.reduce((s, r, i) => s + r[a] * y[i], 0));
  const xs = solve(AtA, Aty);
  if (!xs) return null;
  const coefs = { ...Object.fromEntries(COEF_KEYS.map(k => [k, current[k]])) };
  free.forEach((j, c) => { coefs[COEF_KEYS[j]] = xs[c] / nrm[c]; });
  const rows = tests.map((t, i) => ({ test: t, pred: [0, 1, 2].map(k => COEF_KEYS.reduce((s, key, j) => s + coefs[key] * U[i][j][k], 0)) }));
  const res = rows.flatMap(r => [r.test.Fx - r.pred[0], r.test.Fy - r.pred[1], r.test.Fz - r.pred[2]]);
  const all = rows.flatMap(r => [r.test.Fx, r.test.Fy, r.test.Fz]), mean = all.reduce((s, v) => s + v, 0) / all.length;
  const ssr = res.reduce((s, v) => s + v * v, 0), sst = all.reduce((s, v) => s + (v - mean) ** 2, 0);
  return { coefs, rows, r2: sst > 0 ? 1 - ssr / sst : 1, rms: Math.sqrt(ssr / res.length), edgeFixed };
}

// "fz ap ae Fx Fy Fz" per line (comma, tab or spaces; # comments); mode for all rows
export function parseTests(text, mode = 'slot') {
  const tests = [], bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.replace(/#.*/, '').trim();
    if (!s) return;
    const v = s.split(/[\s,;]+/).map(Number);
    if (v.length < 6 || v.slice(0, 6).some(x => !Number.isFinite(x)) || !(v[0] > 0) || !(v[1] > 0) || !(v[2] > 0)) { if (!/^[a-zA-Zぁ-んァ-ヶ一-龠]/.test(s)) bad.push(i + 1); return; }
    tests.push({ fz: v[0], ap: v[1], ae: v[2], Fx: v[3], Fy: v[4], Fz: v[5], mode });
  });
  return { tests, bad };
}
