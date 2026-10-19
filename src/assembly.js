// Tool assembly: cutter, neck/shank and holder as one rotationally symmetric outline.
// The outline drives material removal (the tip shape), interference checks (everything above
// the flutes must clear the stock), stiffness (a stepped cantilever) and the 3D view.
// Sources: panel parameters + a holder preset, an STL of the tool and/or holder (revolved
// silhouette about the Z axis, tip at the bottom), or an Autodesk Fusion tool library (JSON).
// Lengths mm; z is measured up from the tool tip.

export const LUT_DR = 0.02; // radial step of the tip-shape table [mm]

// Holder presets, generic dimensions for a BT40/HSK63-size spindle. Segments run upward from
// the holder nose (the gauge face the stickout is measured from): [height, lower Ø, upper Ø].
// 'auto' scales the nose with the shank so small tools get slim holders.
export const HOLDERS = {
  none: { name: 'なし (簡易: 工具のみ)', segs: null },
  shrink: { name: '焼きばめ (スリム)', segs: d => [[6, d + 9, d + 10], [64, d + 10, Math.max(d + 10, 44) ], [12, 50, 50], [20, 63, 63]] },
  er: { name: 'ER コレットチャック (ER32)', segs: () => [[22, 50, 50], [8, 46, 40], [40, 40, 40], [20, 63, 63]] },
  milling: { name: 'ミーリングチャック (φ32 用)', segs: () => [[70, 60, 62], [10, 62, 62], [20, 63, 63]] },
  sidelock: { name: 'サイドロック', segs: d => [[45, Math.max(d + 18, 30), Math.max(d + 18, 30)], [20, 50, 50], [20, 63, 63]] },
};
export const SPINDLE_NOSE = { h: 40, d: 150 }; // spindle housing above the flange, for interference

// radius of the cutting-edge envelope at height z above the tip (0 ≤ z ≤ fluteLen)
export function cutterRadiusAt(t, z) {
  const R = t.D / 2;
  if (t.edge) return sampleEdge(t.edge, z);
  if (t.type === 'ball') return z >= R ? R : Math.sqrt(Math.max(0, R * R - (R - z) ** 2));
  const rc = t.type === 'bull' ? Math.min(R, t.cornerR || 0) : 0;
  if (rc > 0 && z < rc) return R - rc + Math.sqrt(Math.max(0, rc * rc - (rc - z) ** 2));
  return R;
}
function sampleEdge(e, z) {
  const f = z / e.dz, i = Math.min(e.r.length - 2, Math.max(0, Math.floor(f)));
  const u = Math.min(1, Math.max(0, f - i));
  return e.r[i] * (1 - u) + e.r[i + 1] * u;
}

// height of the cutter surface above the tip at radius r: the shape the tool leaves in the floor
export function tipLut(t) {
  const R = t.D / 2, n = Math.ceil(R / LUT_DR) + 1, lut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.min(R, i * LUT_DR);
    if (t.edge) {
      // lowest height at which the envelope reaches this radius
      const e = t.edge; let z = e.dz * (e.r.length - 1);
      for (let k = 0; k < e.r.length; k++) if (e.r[k] >= r - 1e-6) { z = k === 0 ? 0 : (k - 1 + (r - e.r[k - 1]) / Math.max(1e-9, e.r[k] - e.r[k - 1])) * e.dz; break; }
      lut[i] = z;
    } else if (t.type === 'ball') lut[i] = R - Math.sqrt(Math.max(0, R * R - r * r));
    else if (t.type === 'bull' && t.cornerR > 0) {
      const rc = Math.min(R, t.cornerR), r0 = R - rc;
      lut[i] = r <= r0 ? 0 : rc - Math.sqrt(Math.max(0, rc * rc - (r - r0) ** 2));
    }
  }
  return lut;
}

// Bands above the flutes: [{z0, z1, r, part}] from the flute top to the spindle nose.
// part: 'shank' (tool body below the holder) or 'holder'.
export function clearanceBands(t) {
  const out = [];
  for (const b of outline(t)) if (b.part !== 'flute') out.push(b);
  return out;
}

// full silhouette as bands from the tip up: flute, neck, shank, holder, spindle
export function outline(t) {
  return t.outline || (t.stlTool || t.stlHolder ? stlOutline(t) : paramOutline(t));
}
function paramOutline(t) {
  const R = t.D / 2, fl = t.fluteLen, so = Math.max(t.stickout, fl);
  const bands = [{ z0: 0, z1: fl, r: R, part: 'flute' }];
  const shankR = (t.shankD || t.D) / 2, neckR = t.neckD ? t.neckD / 2 : 0;
  const neckTop = neckR ? Math.min(so, Math.max(fl, t.neckLen || fl)) : fl;
  if (neckTop > fl) bands.push({ z0: fl, z1: neckTop, r: neckR, part: 'shank' });
  if (so > neckTop) bands.push({ z0: neckTop, z1: so, r: shankR, part: 'shank' });
  let z = so;
  if (t.holderSegs) for (const [h, d0, d1] of t.holderSegs) { bands.push({ z0: z, z1: z + h, r: Math.max(d0, d1) / 2, r0: d0 / 2, r1: d1 / 2, part: 'holder' }); z += h; }
  if (t.holderSegs) bands.push({ z0: z, z1: z + SPINDLE_NOSE.h, r: SPINDLE_NOSE.d / 2, part: 'spindle' });
  return bands;
}

// holder segments for a preset and shank
export function holderSegs(key, shankD) {
  const h = HOLDERS[key];
  return h && h.segs ? h.segs(shankD).map(s => s.map(v => Math.round(v * 10) / 10)) : null;
}

// ---------- STL silhouettes ----------
// Revolved silhouette of a mesh about the vertical axis through its XY bounding-box centre:
// the largest distance from the axis at each height, from plane sections of every triangle
// (the distance to a line is convex along a segment, so the section end points bound it).
export function silhouette(mesh, dz = 0.1) {
  const { tris, min, max } = mesh;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, z0 = min[2];
  const n = Math.max(2, Math.ceil((max[2] - z0) / dz) + 1);
  const r = new Float32Array(n);
  for (let t = 0; t < tris.length; t += 9) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 3; k++) { const z = tris[t + k * 3 + 2]; lo = Math.min(lo, z); hi = Math.max(hi, z); }
    const i0 = Math.max(0, Math.ceil((lo - z0) / dz - 1e-6)), i1 = Math.min(n - 1, Math.floor((hi - z0) / dz + 1e-6));
    for (let i = i0; i <= i1; i++) {
      const zp = z0 + i * dz;
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3;
        const ax = tris[t + a * 3] - cx, ay = tris[t + a * 3 + 1] - cy, az = tris[t + a * 3 + 2];
        const bx = tris[t + b * 3] - cx, by = tris[t + b * 3 + 1] - cy, bz = tris[t + b * 3 + 2];
        if ((az - zp) * (bz - zp) > 0) continue;
        const u = Math.abs(bz - az) < 1e-12 ? 0 : (zp - az) / (bz - az);
        const d = Math.hypot(ax + (bx - ax) * u, ay + (by - ay) * u);
        if (u >= -1e-9 && u <= 1 + 1e-9 && d > r[i]) r[i] = d;
        if (Math.abs(bz - az) < 1e-12) { r[i] = Math.max(r[i], Math.hypot(ax, ay), Math.hypot(bx, by)); }
      }
    }
  }
  return { dz, r, height: max[2] - z0, offAxis: Math.hypot(cx, cy) };
}

// bands from a silhouette, merging heights whose radius differs by less than tol
function bandsFrom(sil, zStart, part, tol = 0.05, partAt = null) {
  const out = [];
  let b = null;
  for (let i = 0; i < sil.r.length - 1; i++) {
    const z0 = zStart + i * sil.dz, z1 = z0 + sil.dz, r = Math.max(sil.r[i], sil.r[i + 1]);
    const p = partAt ? partAt(z0) : part;
    // a band spans heights whose radii all lie within tol, so tapers become steps, not cylinders
    if (b && b.part === p && Math.max(b.r, r) - Math.min(b.rMin, r) < tol) { b.z1 = z1; b.r = Math.max(b.r, r); b.rMin = Math.min(b.rMin, r); }
    else { b = { z0, z1, r, rMin: r, part: p }; out.push(b); }
  }
  return out;
}

// Tool from an STL of the cutter (and shank), tip down. fluteLen comes from the panel since
// a mesh does not say where the cutting edges end. Returns the fields to merge into the tool.
export function toolFromStl(mesh, fluteLen) {
  const sil = silhouette(mesh);
  const fl = Math.min(fluteLen, sil.height);
  const nEdge = Math.max(2, Math.round(fl / sil.dz) + 1);
  const edge = { dz: sil.dz, r: Float32Array.from({ length: nEdge }, (_, i) => sil.r[Math.min(i, sil.r.length - 1)]) };
  let R = 0; for (const v of edge.r) R = Math.max(R, v);
  // shank: the radius just above the flutes, for the stiffness of the free length
  const iS = Math.min(sil.r.length - 1, nEdge + Math.round(2 / sil.dz));
  return {
    D: Math.round(2 * R * 1000) / 1000, edge, shankD: 2 * sil.r[iS], length: sil.height, sil,
    bands: bandsFrom(sil, 0, null, 0.05, z => (z < fl ? 'flute' : 'shank')),
  };
}

// holder STL, nose (lowest point) at the gauge face
export function holderFromStl(mesh) {
  const sil = silhouette(mesh, 0.25);
  return { sil, height: sil.height, bands: bandsFrom(sil, 0, 'holder', 0.5) };
}

// Assemble the outline for a tool whose cutter and/or holder came from STL
export function stlOutline(t) {
  const so = t.stickout;
  let bands;
  if (t.stlTool) {
    // the tool body above the stickout sits inside the holder bore
    bands = t.stlTool.bands.filter(b => b.z0 < so).map(b => ({ ...b, z1: Math.min(b.z1, so) }));
  } else bands = paramOutline({ ...t, holderSegs: null });
  if (t.stlHolder) {
    for (const b of t.stlHolder.bands) bands.push({ ...b, z0: b.z0 + so, z1: b.z1 + so });
    const top = so + t.stlHolder.height;
    bands.push({ z0: top, z1: top + SPINDLE_NOSE.h, r: SPINDLE_NOSE.d / 2, part: 'spindle' });
  } else if (t.holderSegs) {
    let z = so;
    for (const [h, d0, d1] of t.holderSegs) { bands.push({ z0: z, z1: z + h, r: Math.max(d0, d1) / 2, r0: d0 / 2, r1: d1 / 2, part: 'holder' }); z += h; }
    bands.push({ z0: z, z1: z + SPINDLE_NOSE.h, r: SPINDLE_NOSE.d / 2, part: 'spindle' });
  }
  return bands;
}

// ---------- Autodesk Fusion tool library (JSON) ----------
const FUSION_TYPES = { 'flat end mill': 'flat', 'ball end mill': 'ball', 'bull nose end mill': 'bull', 'radius mill': 'bull', drill: 'flat', 'spot drill': 'flat', 'face mill': 'flat', 'chamfer mill': 'flat', 'lollipop mill': 'ball' };
export function parseToolLibrary(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : j.data || j.tools || [];
  const tools = [], skipped = [];
  for (const e of list) {
    const g = e.geometry || {}, type = String(e.type || '').toLowerCase();
    if (type === 'holder' || type === 'probe' || !(g.DC > 0)) { if (type && type !== 'holder') skipped.push(e.description || type); continue; }
    const unit = /inch/i.test(e.unit || '') ? 25.4 : 1;
    const T = e['post-process']?.number ?? tools.length + 1;
    const D = g.DC * unit, LCF = (g.LCF || g.DC * 2) * unit;
    const t = {
      T, D, N: g.NOF || 2, type: FUSION_TYPES[type] || 'flat', fluteLen: LCF,
      stickout: (g.LB || g.OAL * 0.6 || LCF * 1.5) * unit,
      shankD: (g.SFDM || g.DC) * unit, helixDeg: g.HA ?? (type.includes('drill') ? 30 : 30),
      label: `${e.description || type} (${e.vendor || 'Fusion'})`,
    };
    if (g.RE > 0) { t.cornerR = g.RE * unit; if (t.type === 'flat' && Math.abs(g.RE * unit - D / 2) > 1e-3) t.type = 'bull'; }
    if (type.includes('drill')) t.drill = true;
    if (g['shoulder-length'] > LCF / unit && g['shoulder-diameter'] > 0 && g['shoulder-diameter'] * unit < t.shankD) {
      t.neckD = g['shoulder-diameter'] * unit; t.neckLen = g['shoulder-length'] * unit;
    }
    const segs = e.holder?.segments;
    if (Array.isArray(segs) && segs.length) {
      t.holderSegs = segs.map(s => [s.height * unit, s['lower-diameter'] * unit, s['upper-diameter'] * unit]);
      t.holderName = e.holder.description || 'ライブラリのホルダー';
    }
    tools.push(t);
  }
  return { tools, skipped };
}

// ---------- stiffness of the assembly ----------
const E_CARBIDE = 600000, E_STEEL = 210000; // MPa
const RHO_CARBIDE = 14500e-9, RHO_STEEL = 7850e-9; // kg/mm³

// Tip compliance of a stepped cantilever clamped at the spindle (top of the holder) under a
// unit lateral load at the tip: δ = ∫ x²/(E I(x)) dx (bending only; shear is small for L/D > 3).
// The flutes count with an equivalent diameter of 0.8·D. Modal mass by Rayleigh's quotient
// with the static deflection as the mode shape. Returns the same fields as tool.js toolModel.
export function assemblyModel(t) {
  const bands = outline(t).filter(b => b.part !== 'spindle');
  const so = t.stickout;
  const L = bands.length ? bands[bands.length - 1].z1 : so;
  const N = 600, dx = L / N;
  const EI = new Float64Array(N), rhoA = new Float64Array(N);
  let bi = 0;
  for (let i = 0; i < N; i++) {
    const z = (i + 0.5) * dx;
    while (bi < bands.length - 1 && z > bands[bi].z1) bi++;
    const b = bands[bi];
    const d = 2 * b.r * (b.part === 'flute' ? 0.8 : 1);
    const holder = z > so;
    EI[i] = (holder ? E_STEEL : E_CARBIDE) * Math.PI * d ** 4 / 64;
    rhoA[i] = (holder ? RHO_STEEL : RHO_CARBIDE) * Math.PI * d * d / 4;
  }
  // deflection under unit tip load: w(z) by double integration of M/EI from the clamp
  const M = i => (i + 0.5) * dx; // moment arm from the tip [mm] × 1 N
  const slope = new Float64Array(N + 1), w = new Float64Array(N + 1);
  for (let i = N - 1; i >= 0; i--) slope[i] = slope[i + 1] + M(i) / EI[i] * dx;
  for (let i = N - 1; i >= 0; i--) w[i] = w[i + 1] + (slope[i] + slope[i + 1]) / 2 * dx;
  const delta = w[0]; // mm/N
  const kBody = 1 / delta;
  const k = 1 / (delta + 1 / t.kSpindle);
  // Rayleigh: kinetic energy of the body in its static deflected shape, plus the same lumped
  // holder/spindle participation the uniform-beam model uses (≈50 g by default) so that both
  // models agree on the dominant mode of a short tool
  const wTip = delta + 1 / t.kSpindle;
  let mEff = 0;
  // (the lumped mass stands for the rigid motion on the spindle spring, so only bending counts here)
  for (let i = 0; i < N; i++) { const wi = (w[i] + w[i + 1]) / 2; mEff += rhoA[i] * (wi / wTip) ** 2 * dx; }
  mEff += t.mHolder ?? 0.05;
  const fn = Math.sqrt(k * 1e3 / mEff) / (2 * Math.PI);
  // stress check sections: flute top (0.8D) and the holder face (shank)
  const shankR = bands.find(b => b.part === 'shank' && b.z1 >= so - 1e-6)?.r ?? t.D / 2;
  const De = 2 * shankR, I = Math.PI * De ** 4 / 64;
  const Df = 0.8 * t.D, If = Math.PI * Df ** 4 / 64;
  return { De, I, kTool: kBody, k, fn, mEff, assembly: true, flute: { De: Df, I: If, z: t.fluteLen }, length: L };
}
