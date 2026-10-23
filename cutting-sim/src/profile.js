// Tool cross-section profiles: built-in edge preparations and imported outlines (DXF, SVG, CSV).
// Every profile ends up as a closed counter-clockwise polygon in the tool's local frame [m]:
// the tool cuts toward +u, the work is below, and the cutting edge is the lowest point, placed
// at the origin. An open outline (just the cutting part: flank → edge → rake) is closed with a
// large tool body behind and above it.
const DEG = Math.PI / 180;
const BODY = 3e-3;                      // size of the body added behind an open outline [m]

// Round the corner at index i of an open polyline with radius r (arc of n segments).
function fillet(pts, i, r, n = 10) {
  if (!(r > 0)) return pts;
  const A = pts[i - 1], B = pts[i], C = pts[i + 1];
  const ax = A[0] - B[0], ay = A[1] - B[1], cx = C[0] - B[0], cy = C[1] - B[1];
  const la = Math.hypot(ax, ay), lc = Math.hypot(cx, cy);
  const u1 = [ax / la, ay / la], u2 = [cx / lc, cy / lc];
  const th = 0.5 * Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (th < 1e-6 || th > Math.PI / 2 - 1e-6) return pts;
  const d = Math.min(r / Math.tan(th), 0.45 * Math.min(la, lc)), rr = d * Math.tan(th);
  const bx = u1[0] + u2[0], by = u1[1] + u2[1], bl = Math.hypot(bx, by);
  const oc = [B[0] + bx / bl * rr / Math.sin(th), B[1] + by / bl * rr / Math.sin(th)];
  const t1 = [B[0] + u1[0] * d, B[1] + u1[1] * d], t2 = [B[0] + u2[0] * d, B[1] + u2[1] * d];
  let a1 = Math.atan2(t1[1] - oc[1], t1[0] - oc[0]), a2 = Math.atan2(t2[1] - oc[1], t2[0] - oc[0]);
  let da = a2 - a1; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
  const arc = [];
  for (let k = 0; k <= n; k++) arc.push([oc[0] + rr * Math.cos(a1 + da * k / n), oc[1] + rr * Math.sin(a1 + da * k / n)]);
  return [...pts.slice(0, i), ...arc, ...pts.slice(i + 1)];
}

// Close an open outline (flank end first, rake end last) with a body behind and above it.
function closeBody(open) {
  let minU = Infinity, maxW = -Infinity;
  for (const [u, w] of open) { minU = Math.min(minU, u); maxW = Math.max(maxW, w); }
  const U = Math.min(minU - 0.3e-3, -BODY), W = Math.max(maxW + 0.3e-3, BODY);
  const a = open[0], b = open[open.length - 1];
  return [...open, [b[0], W], [U, W], [U, a[1]]];
}

// Flank and rake directions from the edge for rake α and clearance γ.
const flankDir = (g) => [-Math.cos(g * DEG), Math.sin(g * DEG)];
const rakeDir = (a) => [-Math.sin(a * DEG), Math.cos(a * DEG)];
const add = (p, d, l) => [p[0] + d[0] * l, p[1] + d[1] * l];

// Negative land (chamfer, T-land): a land of width bl [mm] at angle landDeg, then the rake face.
export function chamferProfile({ rake, clearance, r, land, landDeg }) {
  const E = [0, 0], F = add(E, flankDir(clearance), 2e-3);
  const L = add(E, rakeDir(landDeg), land * 1e-3), T = add(L, rakeDir(rake), 2e-3);
  return finish(closeBody(fillet([F, E, L, T], 1, r * 1e-6)));
}

// Chip-breaker groove: land (width land, rake), circular groove (width gw, depth gd) and the
// breaker wall rising at wallDeg to height wh above the land line. Lengths in mm, r in µm.
export function breakerProfile({ rake, clearance, r, land, gw, gd, wallDeg, wh }) {
  const t1 = rakeDir(rake), n1 = [t1[1], -t1[0]];                // up the face, out of the tool
  const E = [0, 0], F = add(E, flankDir(clearance), 2e-3);
  const L = add(E, t1, land * 1e-3), B = add(L, t1, gw * 1e-3);
  const c = gw * 1e-3, d = Math.min(gd, 0.49 * gw) * 1e-3, R = (c * c / 4 + d * d) / (2 * d);
  const M = add(L, t1, c / 2), O = add(M, n1, R - d);            // groove centre, outside the tool
  const groove = [];
  const aL = Math.atan2(L[1] - O[1], L[0] - O[0]), aB = Math.atan2(B[1] - O[1], B[0] - O[0]);
  let da = aB - aL; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
  for (let k = 1; k < 16; k++) groove.push([O[0] + R * Math.cos(aL + da * k / 16), O[1] + R * Math.sin(aL + da * k / 16)]);
  const wd = [t1[0] * Math.cos(wallDeg * DEG) + n1[0] * Math.sin(wallDeg * DEG), t1[1] * Math.cos(wallDeg * DEG) + n1[1] * Math.sin(wallDeg * DEG)];
  const Wt = add(B, wd, wh * 1e-3 / Math.sin(wallDeg * DEG)), Tp = add(Wt, t1, 0.6e-3);
  let pts = [F, E, L, ...groove, B, Wt, Tp];
  pts = fillet(pts, pts.indexOf(Wt), 20e-6);                       // round the wall top a little
  return finish(closeBody(fillet(pts, 1, r * 1e-6)));
}

// ---- Imported outlines ----

const UNIT = { um: 1e-6, mm: 1e-3, in: 25.4e-3 };

// CSV / text: "x, y" per line; a blank line starts a new polyline.
export function parseCSV(text) {
  const lines = [], out = [];
  let cur = [];
  for (const raw of text.split(/\r?\n/)) {
    const nums = raw.split(/[,;\s\t]+/).filter(Boolean).map(Number);
    if (nums.length >= 2 && nums.every(Number.isFinite)) cur.push([nums[0], nums[1]]);
    else if (!raw.trim() && cur.length) { lines.push(cur); cur = []; }
  }
  if (cur.length) lines.push(cur);
  for (const p of lines) if (p.length >= 2) out.push(p);
  return { lines: out, unit: null };
}

// SVG: path (M L H V C S Q T A Z), polygon, polyline, line, rect, circle, ellipse. Transforms are not applied.
export function parseSVG(text) {
  const lines = [];
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`)); return m ? m[1] : null; };
  const nums = (s) => (s.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  for (const m of text.matchAll(/<(path|polygon|polyline|line|rect|circle|ellipse)\b[^>]*>/gi)) {
    const tag = m[0], kind = m[1].toLowerCase();
    if (kind === 'path') lines.push(...svgPath(attr(tag, 'd') || ''));
    else if (kind === 'polygon' || kind === 'polyline') {
      const v = nums(attr(tag, 'points') || ''), p = [];
      for (let i = 0; i + 1 < v.length; i += 2) p.push([v[i], v[i + 1]]);
      if (kind === 'polygon' && p.length) p.push([...p[0]]);
      if (p.length >= 2) lines.push(p);
    } else if (kind === 'line') {
      const g = (k) => parseFloat(attr(tag, k) || '0');
      lines.push([[g('x1'), g('y1')], [g('x2'), g('y2')]]);
    } else if (kind === 'circle' || kind === 'ellipse') {
      const g = (k) => parseFloat(attr(tag, k) || '0'), cx = g('cx'), cy = g('cy');
      const rx = kind === 'circle' ? g('r') : g('rx'), ry = kind === 'circle' ? rx : g('ry'), p = [];
      for (let k = 0; k <= 60; k++) { const a = 2 * Math.PI * k / 60; p.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
      if (rx > 0 && ry > 0) lines.push(p);
    } else {
      const g = (k) => parseFloat(attr(tag, k) || '0'), x = g('x'), y = g('y'), w = g('width'), h = g('height');
      if (w > 0 && h > 0) lines.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    }
  }
  // SVG y points down: flip so that y is up as in CAD.
  for (const p of lines) for (const q of p) q[1] = -q[1];
  const vb = text.match(/<svg\b[^>]*>/i), wAttr = vb && vb[0].match(/\swidth\s*=\s*["']([\d.]+)\s*(mm|in|um)?["']/);
  return { lines, unit: wAttr && wAttr[2] ? wAttr[2] : null };
}

function svgPath(d) {
  const tok = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cur = null, lcx = 0, lcy = 0, lq = null;
  const num = () => parseFloat(tok[i++]);
  const push = (px, py) => { cur.push([px, py]); x = px; y = py; };
  const bez = (p0, p1, p2, p3) => { for (let k = 1; k <= 12; k++) { const t = k / 12, s = 1 - t; push(s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0], s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1]); } };
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { if (cur && cur.length) { cur.push([sx, sy]); x = sx; y = sy; } cur = null; continue; }
    if (C === 'M') { cur = []; out.push(cur); const px = num() + ox, py = num() + oy; sx = px; sy = py; push(px, py); cmd = rel ? 'l' : 'L'; continue; }
    if (!cur) { cur = [[x, y]]; out.push(cur); }
    if (C === 'L') push(num() + ox, num() + oy);
    else if (C === 'H') push(num() + (rel ? x : 0), y);
    else if (C === 'V') push(x, num() + (rel ? y : 0));
    else if (C === 'C' || C === 'S') {
      let c1;
      if (C === 'C') c1 = [num() + ox, num() + oy]; else c1 = [2 * x - lcx, 2 * y - lcy];
      const c2 = [num() + ox, num() + oy], p = [num() + ox, num() + oy];
      bez([x, y], c1, c2, p); lcx = c2[0]; lcy = c2[1]; continue;
    } else if (C === 'Q' || C === 'T') {
      const q = C === 'Q' ? [num() + ox, num() + oy] : lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y];
      const p = [num() + ox, num() + oy], p0 = [x, y];
      bez(p0, [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])], [p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1])], p);
      lq = q; continue;
    } else if (C === 'A') {
      const rx = Math.abs(num()), ry = Math.abs(num()), phi = num() * DEG, fa = num(), fs = num(), px = num() + ox, py = num() + oy;
      arcTo(x, y, rx, ry, phi, fa, fs, px, py, push);
    } else { i++; continue; }
    lcx = x; lcy = y; lq = null;
  }
  return out.filter((p) => p.length >= 2);
}

// SVG elliptical arc (endpoint form → centre form, SVG spec F.6.5).
function arcTo(x1, y1, rx, ry, phi, fa, fs, x2, y2, push) {
  if (!rx || !ry) { push(x2, y2); return; }
  const c = Math.cos(phi), s = Math.sin(phi), dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = c * dx + s * dy, yp = -s * dx + c * dy;
  const lam = xp * xp / (rx * rx) + yp * yp / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  let k = Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) / (rx * rx * yp * yp + ry * ry * xp * xp)));
  if (fa === fs) k = -k;
  const cxp = k * rx * yp / ry, cyp = -k * ry * xp / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (8 * DEG)));
  for (let q = 1; q <= n; q++) { const t = t1 + dt * q / n; push(cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c); }
}

// DXF (ASCII): LINE, ARC, LWPOLYLINE (with bulges), POLYLINE/VERTEX, SPLINE (control polygon).
export function parseDXF(text) {
  const raw = text.split(/\r?\n/), pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([parseInt(raw[i].trim(), 10), raw[i + 1].trim()]);
  let unit = null;
  for (let i = 0; i < pairs.length - 1; i++) if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
    unit = { 1: 'in', 4: 'mm', 13: 'um' }[parseInt(pairs[i + 1][1], 10)] || null;
  }
  const lines = [];
  let ent = null, poly = null;
  const flush = () => {
    if (!ent) return;
    const e = ent; ent = null;
    if (e.type === 'LINE') lines.push([[e[10], e[20]], [e[11], e[21]]]);
    else if (e.type === 'ARC') {
      let a0 = e[50] * DEG, a1 = e[51] * DEG; if (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(4, Math.ceil((a1 - a0) / (6 * DEG))), p = [];
      for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n; p.push([e[10] + e[40] * Math.cos(a), e[20] + e[40] * Math.sin(a)]); }
      lines.push(p);
    } else if (e.type === 'CIRCLE') {
      const p = [];
      for (let k = 0; k <= 60; k++) { const a = 2 * Math.PI * k / 60; p.push([e[10] + e[40] * Math.cos(a), e[20] + e[40] * Math.sin(a)]); }
      if (e[40] > 0) lines.push(p);
    } else if (e.type === 'LWPOLYLINE' || e.type === 'SPLINE') {
      const p = bulged(e.v, (e[70] & 1) === 1 && e.type === 'LWPOLYLINE');
      if (p.length >= 2) lines.push(p);
    }
  };
  for (const [code, val] of pairs) {
    if (code === 0) {
      flush();
      if (val === 'VERTEX' && poly) { ent = null; poly.v.push({ x: 0, y: 0, b: 0 }); poly.cur = poly.v[poly.v.length - 1]; continue; }
      if (val === 'SEQEND' && poly) { const p = bulged(poly.v, (poly.flags & 1) === 1); if (p.length >= 2) lines.push(p); poly = null; continue; }
      if (val === 'POLYLINE') { poly = { v: [], flags: 0, cur: null }; continue; }
      ent = ['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'SPLINE'].includes(val) ? { type: val, v: [], 10: 0, 20: 0, 11: 0, 21: 0, 40: 0, 50: 0, 51: 0, 70: 0 } : null;
      continue;
    }
    const num = parseFloat(val);
    if (poly && !ent) {
      if (!poly.cur) { if (code === 70) poly.flags = num; continue; }
      if (code === 10) poly.cur.x = num; else if (code === 20) poly.cur.y = num; else if (code === 42) poly.cur.b = num;
      continue;
    }
    if (!ent) continue;
    if ((ent.type === 'LWPOLYLINE' || ent.type === 'SPLINE') && code === 10) ent.v.push({ x: num, y: 0, b: 0 });
    else if ((ent.type === 'LWPOLYLINE' || ent.type === 'SPLINE') && code === 20 && ent.v.length) ent.v[ent.v.length - 1].y = num;
    else if (ent.type === 'LWPOLYLINE' && code === 42 && ent.v.length) ent.v[ent.v.length - 1].b = num;
    else ent[code] = num;
  }
  flush();
  return { lines, unit };
}

// Polyline vertices with DXF bulges (tan of a quarter of the included angle) → points.
function bulged(v, closed) {
  const out = [];
  const n = v.length, segs = closed ? n : n - 1;
  if (!n) return out;
  out.push([v[0].x, v[0].y]);
  for (let i = 0; i < segs; i++) {
    const a = v[i], b = v[(i + 1) % n];
    if (Math.abs(a.b) > 1e-9) {
      const th = 4 * Math.atan(a.b), dx = b.x - a.x, dy = b.y - a.y, c = Math.hypot(dx, dy), R = c / (2 * Math.sin(th / 2));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, h = R * Math.cos(th / 2);
      const cx = mx - dy / c * h, cy = my + dx / c * h;
      const a0 = Math.atan2(a.y - cy, a.x - cx), m = Math.max(3, Math.ceil(Math.abs(th) / (6 * DEG)));
      for (let k = 1; k <= m; k++) out.push([cx + Math.abs(R) * Math.cos(a0 + th * k / m), cy + Math.abs(R) * Math.sin(a0 + th * k / m)]);
    } else out.push([b.x, b.y]);
  }
  return out;
}

// Join polylines whose end points meet into chains; returns [{ pts, closed }].
function chain(lines) {
  let size = 0;
  for (const p of lines) for (const [x, y] of p) size = Math.max(size, Math.abs(x), Math.abs(y));
  const tol = Math.max(size, 1e-9) * 1e-6, same = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const pool = lines.map((p) => p.slice()), out = [];
  while (pool.length) {
    let cur = pool.shift(), grew = true;
    while (grew && !same(cur[0], cur[cur.length - 1])) {
      grew = false;
      for (let k = 0; k < pool.length; k++) {
        const p = pool[k], e = cur[cur.length - 1], s = cur[0];
        if (same(e, p[0])) cur = cur.concat(p.slice(1));
        else if (same(e, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else if (same(s, p[p.length - 1])) cur = p.slice(0, -1).concat(cur);
        else if (same(s, p[0])) cur = p.slice(1).reverse().concat(cur);
        else continue;
        pool.splice(k, 1); grew = true; break;
      }
    }
    const closed = cur.length > 3 && same(cur[0], cur[cur.length - 1]);
    if (closed) cur = cur.slice(0, -1);
    out.push({ pts: cur, closed });
  }
  return out;
}

const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; };
const length = (p) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; };

// Parse a file and turn its outline into a tool profile.
// opts: { name (for the format), unit ('auto' | 'um' | 'mm' | 'in'), rot (quarter turns CCW), flip }
// Returns { profile, info } or throws an Error with a message for the user.
export function importProfile(text, { name = '', unit = 'auto', rot = 0, flip = false } = {}) {
  const ext = name.toLowerCase().split('.').pop();
  const parsed = ext === 'dxf' || /^\s*0\s*\r?\n\s*SECTION/.test(text) ? parseDXF(text)
    : ext === 'svg' || /<svg[\s>]/i.test(text) ? parseSVG(text) : parseCSV(text);
  if (!parsed.lines.length) throw new Error('線や点が見つかりませんでした。');
  const u = unit === 'auto' ? parsed.unit || 'mm' : unit, sc = UNIT[u];
  const chains = chain(parsed.lines);
  const closed = chains.filter((c) => c.closed);
  const pick = closed.length ? closed.reduce((a, b) => (Math.abs(area(b.pts)) > Math.abs(area(a.pts)) ? b : a))
    : chains.reduce((a, b) => (length(b.pts) > length(a.pts) ? b : a));
  let pts = pick.pts.map(([x, y]) => [x * sc, y * sc]);
  // Orientation: quarter turns, then a left-right flip.
  for (let k = 0; k < ((rot % 4) + 4) % 4; k++) pts = pts.map(([x, y]) => [-y, x]);
  if (flip) pts = pts.map(([x, y]) => [-x, y]);
  // Cutting edge = lowest point (the frontmost of near-ties) → origin.
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const [x, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  const size = Math.max(maxX - minX, maxY - minY), tie = 1e-4 * size;
  let e = 0;
  pts.forEach(([x, y], i) => { if (y < minY + tie && (pts[e][1] >= minY + tie || x > pts[e][0])) e = i; });
  const [ex, ey] = pts[e];
  pts = pts.map(([x, y]) => [x - ex, y - ey]);
  // Drop near-duplicate points.
  const clean = [pts[0]];
  for (const p of pts.slice(1)) { const q = clean[clean.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 2e-7) clean.push(p); }
  pts = clean;
  if (pts.length < 3) throw new Error('輪郭の点が少なすぎます。');
  let poly;
  if (pick.closed) {
    poly = area(pts) < 0 ? pts.slice().reverse() : pts;
  } else {
    // Open outline: the flank end comes first, the rake end (the higher end) last.
    if (pts[0][1] > pts[pts.length - 1][1]) pts.reverse();
    // Seen from the edge (origin), the flank end lies clockwise of the rake end when the tool
    // cuts toward +x; the other way round the drawing is mirrored.
    const [fx, fy] = pts[0], [rx, ry] = pts[pts.length - 1];
    if (fx * ry - fy * rx >= 0) throw new Error('切削方向が逆向きのようです。「左右反転」を試してください。');
    poly = closeBody(pts);
  }
  if (poly.length > 6000) throw new Error(`点が多すぎます（${poly.length} 点）。6,000 点以下にしてください。`);
  return { profile: finish(poly), info: { unit: u, closed: pick.closed, points: poly.length, size: size } };
}

// Make sure the edge (lowest point) is at the origin and the loop is counter-clockwise.
function finish(poly) {
  let e = 0;
  poly.forEach(([u, w], i) => { if (w < poly[e][1] - 1e-12 || (Math.abs(w - poly[e][1]) <= 1e-12 && u > poly[e][0])) e = i; });
  const [eu, ew] = poly[e];
  const p = poly.map(([u, w]) => [u - eu, w - ew]);
  return area(p) < 0 ? p.reverse() : p;
}

// Worn tool: the outline moved into the tool body by the wear depth, rate(s) × minutes, where s
// is the arc length from the cutting edge (+ up the rake face, − along the flank) and rows are the
// tool-surface rows of toolheat.js profile() ({ s µm, wear µm/min }). Near the edge the outline is
// resampled every 2 µm; the depth is smoothed over 3 points so the offset stays a simple curve.
export function wornProfile(poly, rows, minutes) {
  const P = finish(poly), n = P.length;
  let e = 0;
  P.forEach(([u, w], i) => { if (w < P[e][1] - 1e-12 || (Math.abs(w - P[e][1]) <= 1e-12 && u > P[e][0])) e = i; });
  // Arc length of every vertex from the edge vertex, along the counter-clockwise loop (towards the rake).
  const L = [];
  let per = 0;
  for (let i = 0; i < n; i++) { const [a, b] = P[i], [c, d] = P[(i + 1) % n]; L.push(Math.hypot(c - a, d - b)); per += L[i]; }
  const pts = [], ss = [];
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const i = (e + k) % n, [a, b] = P[i], [c, d] = P[(i + 1) % n];
    const sg = (v) => (v > 0.5 * per ? v - per : v), near = Math.min(Math.abs(sg(acc)), Math.abs(sg(acc + L[i]))) < 1e-3;
    const m = near ? Math.max(1, Math.ceil(L[i] / 2e-6)) : 1;
    for (let q = 0; q < m; q++) {
      const t = q / m;
      pts.push([a + (c - a) * t, b + (d - b) * t]);
      let sv = acc + L[i] * t; if (sv > 0.5 * per) sv -= per;
      ss.push(sv);
    }
    acc += L[i];
  }
  const rs = rows.map((r) => r.s * 1e-6), rw = rows.map((r) => Math.max(0, r.wear) * 1e-6 * minutes);
  const depthAt = (sv) => {
    if (!rs.length || sv <= rs[0] || sv >= rs[rs.length - 1]) return 0;
    let j = 1; while (rs[j] < sv) j++;
    const t = (sv - rs[j - 1]) / (rs[j] - rs[j - 1]);
    return rw[j - 1] + (rw[j] - rw[j - 1]) * t;
  };
  const N = pts.length, dep = ss.map(depthAt), sm = dep.map((d, i) => (dep[(i + N - 1) % N] + d + dep[(i + 1) % N]) / 3);
  const out = [];
  for (let i = 0; i < N; i++) {
    const [pa, pb] = pts[(i + N - 1) % N], [qa, qb] = pts[(i + 1) % N];
    const tx = qa - pa, ty = qb - pb, tl = Math.hypot(tx, ty) || 1;
    // Outward normal of a counter-clockwise loop is (ty, −tx); the wear moves the surface inward.
    out.push([pts[i][0] - ty / tl * sm[i], pts[i][1] + tx / tl * sm[i]]);
  }
  return finish(out);
}

// Rake angle seen by a chip of thickness h: direction of the outline 0.3 h … 1.0 h up from the edge.
export function rakeOf(tool, h) {
  const P = tool.poly;
  if (!P) return tool.a;
  const at = (s) => {
    let a = P.sE + s; a = ((a % P.per) + P.per) % P.per;
    let i = 0; while (i < P.n - 1 && P.s0[i + 1] <= a) i++;
    const t = (a - P.s0[i]) / Math.sqrt(P.l2[i]);
    return [P.ax[i] + t * P.dx[i], P.ay[i] + t * P.dy[i]];
  };
  const p = at(0.3 * h), q = at(1.0 * h);
  return Math.atan2(-(q[0] - p[0]), q[1] - p[1]);
}

// Workpiece cross-section from a file: every closed outline is kept and filled even-odd, so an
// inner outline is a hole (a cross hole or a slot gives an interrupted cut). Placed with its top
// (highest point) at y = 0 and its left end at x = 0, cutting toward +x; the tool runs at y = −h.
// Returns { loops: [[[x, y] m]], info } or throws an Error with a message for the user.
export function importWorkpiece(text, { name = '', unit = 'auto', rot = 0, flip = false } = {}) {
  const ext = name.toLowerCase().split('.').pop();
  const parsed = ext === 'dxf' || /^\s*0\s*\r?\n\s*SECTION/.test(text) ? parseDXF(text)
    : ext === 'svg' || /<svg[\s>]/i.test(text) ? parseSVG(text) : parseCSV(text);
  if (!parsed.lines.length) throw new Error('線や点が見つかりませんでした。');
  const u = unit === 'auto' ? parsed.unit || 'mm' : unit, sc = UNIT[u];
  // A CSV is one outline: close it.
  const chains = chain(parsed.lines).map((c) => (!c.closed && ext !== 'dxf' && ext !== 'svg' && c.pts.length > 2 ? { pts: c.pts, closed: true } : c));
  let loops = chains.filter((c) => c.closed).map((c) => c.pts.map(([x, y]) => [x * sc, y * sc]));
  if (!loops.length) throw new Error('閉じた輪郭が見つかりませんでした。ワークの断面は閉じた線で描いてください。');
  for (let k = 0; k < ((rot % 4) + 4) % 4; k++) loops = loops.map((l) => l.map(([x, y]) => [-y, x]));
  if (flip) loops = loops.map((l) => l.map(([x, y]) => [-x, y]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const l of loops) for (const [x, y] of l) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  loops = loops.map((l) => l.map(([x, y]) => [x - minX, y - maxY]));
  const n = loops.reduce((a, l) => a + l.length, 0);
  if (n > 20000) throw new Error(`点が多すぎます（${n} 点）。20,000 点以下にしてください。`);
  const W = maxX - minX, H = maxY - minY;
  const solid = loops.reduce((a, l) => a + Math.abs(area(l)), 0);
  return { loops, info: { unit: u, loops: loops.length, points: n, width: W, height: H, area: solid } };
}

// Even-odd point-in-polygon over all loops.
export function insideLoops(loops, x, y) {
  let c = false;
  for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const [xi, yi] = l[i], [xj, yj] = l[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
