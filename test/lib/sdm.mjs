// Zeroth-order semi-discretization (Insperger & Stépán 2002, 2004) for a 1-DOF milling model in
// the feed direction: m ẍ + c ẋ + k x = −a·h(t)·(x(t) − x(t−T)), with the specific cutting
// force h(t) = Σ g(φj) sin φj (Kt cos φj + Kn sin φj). Used as an independent reference for
// the stability limit (it captures period-doubling lobes the zero-order solution misses).

function expm(M) { // small dense matrix exponential: scaling and squaring + Taylor
  const n = M.length;
  let norm = 0; for (const r of M) norm = Math.max(norm, r.reduce((s, v) => s + Math.abs(v), 0));
  const sq = Math.max(0, Math.ceil(Math.log2(norm + 1e-300)) + 1);
  const A = M.map(r => r.map(v => v / 2 ** sq));
  let E = A.map((r, i) => r.map((_, j) => (i === j ? 1 : 0))), term = E.map(r => r.slice());
  for (let k = 1; k <= 18; k++) { term = mul(term, A).map(r => r.map(v => v / k)); E = E.map((r, i) => r.map((v, j) => v + term[i][j])); }
  for (let s = 0; s < sq; s++) E = mul(E, E);
  return E;
}
function mul(A, B) {
  const n = A.length, m = B[0].length, p = B.length, C = Array.from({ length: n }, () => new Float64Array(m));
  for (let i = 0; i < n; i++) for (let k = 0; k < p; k++) { const a = A[i][k]; if (a) for (let j = 0; j < m; j++) C[i][j] += a * B[k][j]; }
  return C.map(r => Array.from(r));
}

// spectral radius of the monodromy matrix for depth a [m]
export function sdmRho({ m, k, zeta, Kt, Kn, N, phiSt, phiEx, rpm, a, steps = 40 }) {
  const wn = Math.sqrt(k / m), T = 60 / (rpm * N), dt = T / steps, Om = rpm * 2 * Math.PI / 60;
  const n = steps + 2;
  let Phi = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let i = 0; i < steps; i++) {
    // average specific force over the step
    let h = 0; const sub = 8;
    for (let s = 0; s < sub; s++) {
      const t = (i + (s + 0.5) / sub) * dt;
      for (let j = 0; j < N; j++) {
        const phi = ((Om * t + 2 * Math.PI * j / N) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        if (phi >= phiSt && phi <= phiEx) h += Math.sin(phi) * (Kt * Math.cos(phi) + Kn * Math.sin(phi));
      }
    }
    h /= sub;
    const w = a * h / m;
    // augmented exponential gives P = e^{A dt} and R = ∫ e^{A s} ds · b, b = [0, w]
    const E = expm([[0, dt, 0], [(-wn * wn - w) * dt, -2 * zeta * wn * dt, w * dt], [0, 0, 0]]);
    const G = Array.from({ length: n }, () => new Array(n).fill(0));
    G[0][0] = E[0][0]; G[0][1] = E[0][1]; G[1][0] = E[1][0]; G[1][1] = E[1][1];
    // delayed position ≈ mean of the two samples bracketing t − T
    G[0][n - 2] += E[0][2] / 2; G[0][n - 1] += E[0][2] / 2; G[1][n - 2] += E[1][2] / 2; G[1][n - 1] += E[1][2] / 2;
    G[2][0] = 1;
    for (let r = 3; r < n; r++) G[r][r - 1] = 1;
    Phi = mul(G, Phi);
  }
  // spectral radius by repeated squaring with normalisation (Gelfand's formula)
  let logScale = 0, M = Phi;
  const K = 9;
  for (let s = 0; s < K; s++) {
    M = mul(M, M); logScale *= 2;
    let nm = 0; for (const r of M) for (const v of r) nm = Math.max(nm, Math.abs(v));
    M = M.map(r => r.map(v => v / nm)); logScale += Math.log(nm);
  }
  return Math.exp(logScale / 2 ** K);
}

// stability limit [m] by bisection on the depth
export function sdmLimit(p, aMax = 0.02) {
  let lo = 0, hi = aMax;
  if (sdmRho({ ...p, a: hi }) < 1) return Infinity;
  for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; (sdmRho({ ...p, a: mid }) < 1 ? (lo = mid) : (hi = mid)); }
  return (lo + hi) / 2;
}
