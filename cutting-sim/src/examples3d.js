// Example tools and works for the STL mode (mm, z up), made in code so that the page offers them
// without files; scripts/make-examples.mjs writes the same shapes to examples/*.stl.
import { orient } from './mesh.js';

const box = (x0, y0, z0, x1, y1, z1) => {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.flatMap((t) => t.flatMap((i) => v[i]));
};
// Prism: a CCW polygon in (a, b) swept over c ∈ [c0, c1]; map(a, b, c) → [x, y, z]. Fan triangulation
// of the caps (the polygons here are convex).
const prism = (poly, c0, c1, map) => {
  const t = [], n = poly.length, P = (i, c) => map(poly[i][0], poly[i][1], c);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; t.push(...P(i, c0), ...P(j, c0), ...P(j, c1), ...P(i, c0), ...P(j, c1), ...P(i, c1)); }
  for (let i = 1; i < n - 1; i++) { t.push(...P(0, c0), ...P(i + 1, c0), ...P(i, c0)); t.push(...P(0, c1), ...P(i, c1), ...P(i + 1, c1)); }
  return t;
};

// 1. Planing: work 1.0 × 0.4 × 0.4 mm (x, y, z), top at z = 0; a 5° rake, 7° clearance tool with its
// edge along y at x = −0.05, z = −0.1 (h = 0.1 mm), cutting toward +x.
const planeWork = () => box(0, 0, -0.4, 1.0, 0.4, 0);
const planeTool = () => {
  const a = 5 * Math.PI / 180, g = 7 * Math.PI / 180, Ht = 0.5, L = 0.6;
  // (x, z) in the tool, CCW seen from −y … sweep along y. Edge at the origin.
  const poly = [[0, 0], [-Ht * Math.tan(a), Ht], [-L, Ht], [-L, L * Math.tan(g)]];
  return prism(poly, -0.2, 0.6, (px, pz, y) => [px - 0.05, y, pz - 0.1]);
};

// 2. Side milling: work 1.4 × 0.25 × 0.15 mm (x ∈ [0.3, 1.7], z ∈ [−0.15, 0]); a φ2 two-flute end mill with 30°
// helix, axis vertical at (1.0, −0.8): radial depth ae = 0.2 mm into the y = 0 face. Turning
// clockwise seen from above (M03, right-hand cutter), feeding +x: up milling on this side.
const millWork = () => box(0.3, 0, -0.15, 1.7, 0.25, 0);
// The cutter is turned 70° ahead (clockwise) so that a tooth enters the work a few degrees after
// the start instead of after a quarter turn.
const PRE = -70 * Math.PI / 180;
const millTool = () => {
  const R = 1.0, Rc = 0.62, beta = 30 * Math.PI / 180, z0 = -0.45, z1 = 0.15, nz = 24, nt = 180;
  // Cross-section r(θ) for a CW tool: each tooth tip leads at θ_k and its flank relief trails
  // anticlockwise behind it; the flute (rake face) is just clockwise of the tip.
  const r = (th) => {
    let u = ((th % Math.PI) + Math.PI) % Math.PI;            // 0 at a tip, growing behind it (CCW)
    if (u < 0.75 * Math.PI) return R - (R - Rc) * Math.pow(u / (0.75 * Math.PI), 1.6) * 0.9 - 0.004 * u;
    if (u < 0.96 * Math.PI) return Rc + 0.05 * Math.sin((u - 0.75 * Math.PI) / (0.21 * Math.PI) * Math.PI);
    return Rc + (R - Rc) * (u - 0.96 * Math.PI) / (0.04 * Math.PI);   // rake face, nearly radial
  };
  const t = [], P = (i, k) => {
    const z = z0 + (z1 - z0) * k / nz, tw = -(z - z0) * Math.tan(beta) / R;   // CW tool, right-hand helix
    const th = 2 * Math.PI * i / nt, rr = r(th);
    return [1.0 + rr * Math.cos(th + tw + PRE), -0.8 + rr * Math.sin(th + tw + PRE), z];
  };
  for (let k = 0; k < nz; k++) for (let i = 0; i < nt; i++) {
    const j = (i + 1) % nt;
    t.push(...P(i, k), ...P(j, k), ...P(j, k + 1), ...P(i, k), ...P(j, k + 1), ...P(i, k + 1));
  }
  for (let i = 0; i < nt; i++) {
    const j = (i + 1) % nt, cb = [1.0, -0.8, z0], ct = [1.0, -0.8, z1];
    t.push(...cb, ...P(j, 0), ...P(i, 0)); t.push(...ct, ...P(i, nz), ...P(j, nz));
  }
  return t;
};

// 3. Drilling: work 1.6 × 1.6 × 0.5 mm, top at z = 0; a φ1 two-lip drill point (118°) sunk into the work at
// (0.8, 0.8) so that the whole lip cuts (tip 0.35 mm deep, the outer corners 0.05 mm), feeding −z.
const drillWork = () => box(0, 0, -0.5, 1.6, 1.6, 0);
const drillTool = () => {
  const R = 0.5, half = 59 * Math.PI / 180, cone = R / Math.tan(half), nt = 120, nr = 10, top = 0.5;
  // Point cone with two lips: the surface between the lips is relieved (lifted) as it trails.
  const lift = (th) => { const u = ((th % Math.PI) + Math.PI) % Math.PI; return 0.06 * u / Math.PI; };
  const P = (i, k) => {
    const th = 2 * Math.PI * i / nt, rr = R * k / nr;
    const z = -0.35 + (rr / R) * cone + lift(th) * (rr / R);
    return [0.8 + rr * Math.cos(th), 0.8 + rr * Math.sin(th), z];
  };
  const t = [];
  for (let k = 0; k < nr; k++) for (let i = 0; i < nt; i++) {
    const j = (i + 1) % nt;
    if (k === 0) t.push(...P(i, 0), ...P(i, 1), ...P(j, 1));
    else t.push(...P(i, k), ...P(i, k + 1), ...P(j, k + 1), ...P(i, k), ...P(j, k + 1), ...P(j, k));
  }
  // Body: cylinder from the outer lip edge up to `top`, closed by a flat cap.
  for (let i = 0; i < nt; i++) {
    const j = (i + 1) % nt, a = P(i, nr), b = P(j, nr), th = 2 * Math.PI * i / nt, th2 = 2 * Math.PI * j / nt;
    const at = [0.8 + R * Math.cos(th), 0.8 + R * Math.sin(th), top], bt = [0.8 + R * Math.cos(th2), 0.8 + R * Math.sin(th2), top];
    t.push(...a, ...at, ...bt, ...a, ...bt, ...b);
    t.push(0.8, 0.8, top, ...bt, ...at);
  }
  return t;
};

const mk = (f) => () => orient(Float64Array.from(f()));
// cfg: the motion and feeds each example is set up for (the tool sits where the first cut starts).
export const EXAMPLES = {
  plane: { name: '平削り（すくい角 5°、h = 0.1 mm）', tool: mk(planeTool), work: mk(planeWork), cfg: { motion: 'linear', travel: 0.6, dxUm: 25 } },
  mill: { name: 'エンドミル φ2・2枚刃・ねじれ 30°（ae 0.2 × ap 0.15 mm、fz 0.1）', tool: mk(millTool), work: mk(millWork), cfg: { motion: 'mill', z: 2, fz: 0.1, angle: 70, dxUm: 20, axis: [1.0, -0.8] } },
  drill: { name: 'ドリル φ1・先端角 118°', tool: mk(drillTool), work: mk(drillWork), cfg: { motion: 'drill', fr: 0.05, angle: 360, dxUm: 40, axis: [0.8, 0.8] } },
};
