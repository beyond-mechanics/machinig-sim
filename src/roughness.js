// Side-wall surface roughness from the cutting kinematics at a resolution far below the stock
// grid. Each tooth passing the wall side of the cutter leaves an arc of radius R centred
// where the tool actually was at that moment (feed position plus vibration); the finished
// wall is the envelope of the last teeth's arcs. Without vibration this reduces to the
// classic scallop height fz²/(8R).

// samples: ring buffer of tool positions [m] taken each time a tooth passed the wall side
// u: feed direction (unit, xy), side: +1 for the wall on the +v side (v = u rotated +90°),
// −1 for the −v side, R [mm], fz [mm]. Returns a profile in µm along ~n·fz of feed.
export function wallProfile(samples, u, side, R, fz, nTeeth = 24, res = 600) {
  const m = Math.min(samples.count, samples.n, nTeeth);
  if (m < 3 || !(fz > 0)) return null;
  const vx = -u[1] * side, vy = u[0] * side;
  const xs = [], ds = [];
  // oldest first; tooth k is fed k·fz along the feed
  for (let k = 0; k < m; k++) {
    const j = (samples.i - m + k + samples.n) % samples.n;
    const dx = samples.x[j] * 1e3, dy = samples.y[j] * 1e3; // mm
    xs.push(k * fz + dx * u[0] + dy * u[1]);
    ds.push(dx * vx + dy * vy);     // displacement towards the wall [mm]
  }
  // evaluate the envelope over the middle teeth (both neighbours present)
  const x0 = xs[1], x1 = xs[m - 2], z = new Float64Array(res), xg = new Float64Array(res);
  for (let i = 0; i < res; i++) {
    const x = x0 + (x1 - x0) * i / (res - 1);
    let reach = -Infinity;
    for (let k = 0; k < m; k++) {
      const a = x - xs[k];
      if (Math.abs(a) >= R) continue;
      reach = Math.max(reach, ds[k] + Math.sqrt(R * R - a * a));
    }
    xg[i] = x - x0; z[i] = reach;
  }
  // height of the remaining material relative to the deepest cut [µm] (peaks are positive)
  let zmax = -Infinity; for (const v of z) zmax = Math.max(zmax, v);
  let mean = 0; for (let i = 0; i < res; i++) { z[i] = (zmax - z[i]) * 1e3; mean += z[i]; }
  mean /= res;
  let Ra = 0, Rz = 0; for (const v of z) { Ra += Math.abs(v - mean); Rz = Math.max(Rz, v); }
  Ra /= res;
  return { x: xg, z, Ra, Rz, Rth: fz * fz / (8 * R) * 1e3, length: x1 - x0 };
}

// The side(s) where the wall is generated: φ = 0 is on the +v side, φ = π on the −v side.
export function wallSides(phiSt, phiEx) {
  const out = [];
  if (phiSt <= 0.05) out.push(1);
  if (phiEx >= Math.PI - 0.05) out.push(-1);
  return out;
}
