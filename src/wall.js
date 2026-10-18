// Local compliance of a thin wall that the cutter is pushing against.
// The wall is read from the heightfield: thickness along the contact normal, free height
// above the higher of the two floors, and length along the wall. It is then treated as a
// cantilever plate strip of effective width b_eff loaded at the force centroid height.

const FN_CAP = 5000; // Hz; stiffer/lighter walls are effectively rigid at this time step

export function wallAt(stock, p, R, Hb, u, zLoad, mat, kTool) {
  const vx = -u[1], vy = u[0];
  const B = Hb.length;
  // contact point: middle of the engaged arc at the load height
  let sx = 0, sy = 0;
  for (let b = 0; b < B / 2; b++) {
    if (Hb[b] <= zLoad) continue;
    const phi = (b + 0.5) / B * 2 * Math.PI, sn = Math.sin(phi), cs = Math.cos(phi);
    sx += sn * u[0] + cs * vx; sy += sn * u[1] + cs * vy;
  }
  const L = Math.hypot(sx, sy);
  if (L < 1e-9) return null;
  const n0 = Math.atan2(sy, sx);
  const cx = p.x + R * sx / L, cy = p.y + R * sy / L;
  // the wall normal: the thinnest crossing near the contact normal (a wider search would
  // pick the strip of material that is being cut away instead of the wall itself)
  let best = null;
  for (let d = -40; d <= 40; d += 5) {
    const a = n0 + d * Math.PI / 180;
    const t = thickness(stock, cx, cy, Math.cos(a), Math.sin(a), zLoad);
    if (t > 0 && (!best || t < best.t)) best = { t, nx: Math.cos(a), ny: Math.sin(a) };
  }
  if (!best) return null;
  return measure(stock, p, cx, cy, R, best.nx, best.ny, best.t, zLoad, mat, kTool);
}

function thickness(stock, cx, cy, nx, ny, zLoad) {
  const step = Math.min(stock.hx, stock.hy) * 0.5;
  for (let s = step; s <= 20; s += step) {
    if (stock.sample(cx + nx * s, cy + ny * s) < zLoad) return s;
  }
  return -1;   // thick or solid: rigid
}

function measure(stock, p, cx, cy, R, nx, ny, t, zLoad, mat, kTool) {
  const step = Math.min(stock.hx, stock.hy) * 0.5;
  // far-side floor just beyond the wall
  let far = Infinity;
  for (let s = t; s <= t + 3; s += step) far = Math.min(far, stock.floor(cx + nx * s, cy + ny * s));
  const base = Math.max(p.z, far);
  const mx = cx + nx * t / 2, my = cy + ny * t / 2;
  const top = stock.sample(mx, my);
  const hWall = top - base;
  const a = Math.min(Math.max(zLoad - base, 0.3), Math.max(hWall, 0.3));
  // slivers thinner than two grid cells are about to become chips, not walls
  if (hWall < 0.5 || t < 2 * step * 2) return null;
  // length along the wall at the load height
  const tx = -ny, ty = nx;
  let L = 0;
  for (const sg of [1, -1]) {
    for (let s = step; s <= 60; s += step) {
      if (stock.sample(mx + tx * s * sg, my + ty * s * sg) < zLoad) break;
      L += step;
    }
  }
  if (L < 2 * t) return null;
  const bEff = Math.min(L, 2 * a + t + R);
  const I = bEff * t ** 3 / 12;                // mm⁴
  const k = 3 * mat.E * I / a ** 3;            // N/mm
  if (k > 20 * kTool) return null;
  // tip-equivalent mass of a cantilever ≈ 0.24 of its mass
  let m = 0.24 * mat.rho * 1e-9 * t * bEff * hWall;   // kg
  let fn = Math.sqrt(k * 1e3 / m) / (2 * Math.PI);
  if (fn > FN_CAP) { fn = FN_CAP; m = k * 1e3 / (2 * Math.PI * FN_CAP) ** 2; }
  return { k, m, fn, zeta: 0.02, nx, ny, t, hWall, a, bEff, base, cx, cy };
}

export { FN_CAP };
