// Workpiece (stock) definitions: box, round bar standing on the table, or any STL mesh.
// Everything ends up as the Z-heightfield of stock.js: the top surface seen from above.
// The stock frame has its left-front corner at X0 Y0 and its top at Z0; the program frame is
// placed in it by `origin`, the position of the program zero measured in the stock frame.

import { Stock } from './stock.js';

const MAX_CELLS = 1.5e6;

export function parseStl(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let tris;
  const nBin = bytes.length >= 84 ? dv.getUint32(80, true) : -1;
  if (nBin >= 0 && 84 + nBin * 50 === bytes.length) {
    tris = new Float32Array(nBin * 9);
    for (let t = 0; t < nBin; t++) {
      const o = 84 + t * 50 + 12; // skip the normal
      for (let k = 0; k < 9; k++) tris[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
  } else {
    const text = new TextDecoder('latin1').decode(bytes);
    if (!/^\s*solid/i.test(text) || !/vertex/i.test(text)) throw new Error('STL として読めません (バイナリ/ASCII のどちらでもない)');
    const v = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)].map(m => [+m[1], +m[2], +m[3]]);
    tris = new Float32Array(Math.floor(v.length / 3) * 9);
    for (let i = 0; i < tris.length / 3; i++) tris.set(v[i], i * 3);
  }
  if (!tris.length) throw new Error('三角形がありません');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    const x = tris[i + k];
    if (!Number.isFinite(x)) throw new Error('座標に数値でない値があります');
    if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x;
  }
  return { tris, min, max, count: tris.length / 9 };
}

// size of the stock frame box
export function stockExtents(spec) {
  if (spec.type === 'cyl') return { w: spec.d, l: spec.d, h: spec.h };
  if (spec.type === 'stl') return { w: spec.max[0] - spec.min[0], l: spec.max[1] - spec.min[1], h: spec.max[2] - spec.min[2] };
  return { w: spec.w, l: spec.l, h: spec.h };
}

// grid spacing: the default unless the stock would need more than MAX_CELLS cells
export function cellFor(spec, cell = 0.3) {
  const { w, l } = stockExtents(spec);
  const need = Math.sqrt(w * l / MAX_CELLS);
  return need > cell ? Math.ceil(need * 20) / 20 : cell;
}

// program-zero presets: stock top corner (the app's original convention), top centre, or the
// mesh's own coordinates (the CAM model and the program share one origin)
export function originPreset(spec, kind) {
  const { w, l } = stockExtents(spec);
  if (kind === 'center') return { x: w / 2, y: l / 2, z: 0 };
  if (kind === 'model' && spec.type === 'stl') return { x: -spec.min[0], y: -spec.min[1], z: -spec.max[2] };
  if (kind === 'center-bottom') return { x: w / 2, y: l / 2, z: -stockExtents(spec).h };
  return { x: 0, y: 0, z: 0 };
}

export function buildStock(spec, cell = 0.3) {
  const { w, l, h } = stockExtents(spec);
  const s = new Stock(w, l, h, cellFor(spec, cell));
  if (spec.type === 'cyl') {
    const r = spec.d / 2, H = s.H;
    for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++)
      if (Math.hypot(i * s.hx - r, j * s.hy - r) > r + 1e-6) H[j * s.nx + i] = s.zBottom;
  } else if (spec.type === 'stl') {
    rasterizeTop(spec, s);
  }
  return s;
}

// highest triangle above each grid node; nodes no triangle covers are empty (table height).
// Holes, pockets and through-holes open to the top are kept; anything under an overhang is filled.
export function rasterizeTop(spec, s) {
  rasterize(spec.tris, s, -spec.min[0], -spec.min[1], -spec.max[2]);
}

// the same for a mesh placed in the stock frame by the shift (ox, oy, oz), into H (default s.H)
export function rasterize(tris, s, ox, oy, oz, H = s.H) {
  const nx = s.nx, ny = s.ny, hx = s.hx, hy = s.hy;
  H.fill(-Infinity);
  const eps = 1e-6 * Math.max(s.w, s.l, 1);
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t] + ox, ay = tris[t + 1] + oy, az = tris[t + 2] + oz;
    const bx = tris[t + 3] + ox, by = tris[t + 4] + oy, bz = tris[t + 5] + oz;
    const cx = tris[t + 6] + ox, cy = tris[t + 7] + oy, cz = tris[t + 8] + oz;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue; // vertical faces do not show from above
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - eps) / hx)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) + eps) / hx));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - eps) / hy)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) + eps) / hy));
    // barycentric tolerance scaled to the triangle so shared edges never leave a crack
    const tol = eps * 4 / Math.sqrt(Math.abs(det));
    for (let j = j0; j <= j1; j++) {
      const py = j * hy;
      for (let i = i0; i <= i1; i++) {
        const px = i * hx;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -tol || l2 < -tol || l3 < -tol) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        const k = j * nx + i;
        if (z > H[k]) H[k] = z;
      }
    }
  }
  for (let k = 0; k < H.length; k++) H[k] = Math.min(s.zTop, Math.max(s.zBottom, H[k] === -Infinity ? s.zBottom : H[k]));
}

// a stock box under the cutting moves, top at program Z0, for programs that do not say what
// the stock is. The outermost cutting moves sit on the stock edge so that every pass cuts.
export function stockFromPath(path) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity;
  for (let i = 1; i < path.length; i++) {
    if (path[i].rapid) continue;
    for (const c of [path[i], path[i - 1]]) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); z0 = Math.min(z0, c.z); }
  }
  if (x0 === Infinity) return null;
  return { spec: { type: 'box', w: round(Math.max(1, x1 - x0)), l: round(Math.max(1, y1 - y0)), h: Math.max(5, Math.ceil(-z0 + 5)) }, origin: { x: round(-x0), y: round(-y0), z: 0 } };
}
export const ORIGIN_LABEL = { corner: '上面の左手前の角', center: '上面の中心', 'center-bottom': '下面の中心', model: 'STL の座標そのまま' };

// pick the program-zero preset under which the cutting moves lie inside the stock best,
// measured by length along the feed moves (their end points often overrun the stock edge).
// A tool centre up to a radius R outside the stock still cuts (outer contours).
export function bestOrigin(spec, path, R = 5) {
  const { w, l, h } = stockExtents(spec);
  R += 0.5;
  const kinds = [...(spec.type === 'stl' ? ['model'] : []), 'corner', 'center', 'center-bottom'];
  const segs = [];
  for (let i = 1; i < path.length; i++) if (!path[i].rapid) segs.push([path[i - 1], path[i]]);
  const stride = Math.max(1, Math.floor(segs.length / 4000));
  let best = { kind: kinds[0], origin: originPreset(spec, kinds[0]), score: -1 };
  for (const kind of kinds) {
    const o = originPreset(spec, kind);
    let inside = 0, total = 0;
    for (let s = 0; s < segs.length; s += stride) {
      const [a, b] = segs[s], len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      for (let k = 0; k < 8; k++) {
        const f = (k + 0.5) / 8, x = a.x + (b.x - a.x) * f + o.x, y = a.y + (b.y - a.y) * f + o.y, z = a.z + (b.z - a.z) * f + o.z;
        total += len;
        if (x >= -R && x <= w + R && y >= -R && y <= l + R && z <= 0.5 && z >= -h - 0.5) inside += len;
      }
    }
    const score = total ? inside / total : 0;
    // the earlier presets win unless a later one is clearly better
    if (score > best.score + 0.05) best = { kind, origin: o, score };
  }
  return best;
}
const round = v => Math.round(v * 1000) / 1000;
