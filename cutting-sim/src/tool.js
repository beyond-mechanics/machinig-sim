// Rigid cutting tool (one tooth): a wedge with rake angle α, clearance angle γ and a rounded
// cutting edge of radius r. Geometry lives in a local frame (u, w): the tool cuts in +u, the rake
// face faces +u and runs up +w from the edge. The local origin is the centre of the edge circle,
// which is also the tip of the sharp wedge shrunk by r, so the surface is {dWedge = r}.
// Pose in the world: origin (ex, ey) and rotation th (local u axis = (cos th, sin th)).
// Rigid motion: velocity of a tool point p = (vx, vy) + om × (p − (ox, oy)).
// Positions in metres.
// With `profile` (closed polygon [[u, w], ...] counter-clockwise around the tool body, cutting edge
// at its lowest point, see profile.js) the tool takes that shape instead of the wedge; rakeDeg is
// then only the nominal rake used for the chip-thickness and Merchant estimates.
// wmin, umax: lowest and frontmost local coordinates, used to place the tool against the work.
export function makeTool({ rakeDeg, clearanceDeg, edgeRadius, profile = null, cell = 20e-6 }) {
  const a = rakeDeg * Math.PI / 180, g = clearanceDeg * Math.PI / 180;
  // Unit directions along the rake face (up) and clearance face (back, -u) from the tip.
  const u1x = -Math.sin(a), u1y = Math.cos(a);
  const u2x = -Math.cos(g), u2y = Math.sin(g);
  // Outward normals: rake face faces +u, clearance face faces down.
  const n1x = Math.cos(a), n1y = Math.sin(a);
  const n2x = Math.sin(g), n2y = -Math.cos(g);
  const t = {
    a, g, r: edgeRadius, u1x, u1y, u2x, u2y, n1x, n1y, n2x, n2y,
    ex: 0, ey: 0, th: 0, ct: 1, st: 0, vx: 0, vy: 0, om: 0, ox: 0, oy: 0,
    out: new Float64Array(5), poly: null, wmin: -edgeRadius, umax: edgeRadius,
  };
  if (profile) buildPoly(t, profile, cell);
  return t;
}

// Polygon tool: segment table, vertex pseudo-normals (sign test), arc length from the edge, and
// a bucket grid listing the segments within one bucket of each bucket for fast queries.
function buildPoly(t, pts, g) {
  const n = pts.length, P = { n, ax: new Float64Array(n), ay: new Float64Array(n), dx: new Float64Array(n), dy: new Float64Array(n),
    l2: new Float64Array(n), nx: new Float64Array(n), ny: new Float64Array(n), vnx: new Float64Array(n), vny: new Float64Array(n), s0: new Float64Array(n) };
  let per = 0, e = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1e-12;
    P.ax[i] = ax; P.ay[i] = ay; P.dx[i] = dx; P.dy[i] = dy; P.l2[i] = l * l;
    P.nx[i] = dy / l; P.ny[i] = -dx / l;                 // outward for a counter-clockwise loop
    P.s0[i] = per; per += l;
    if (ay < pts[e][1] - 1e-9 || (Math.abs(ay - pts[e][1]) <= 1e-9 && ax > pts[e][0])) e = i;
  }
  for (let i = 0; i < n; i++) {
    const k = (i + n - 1) % n, vx = P.nx[i] + P.nx[k], vy = P.ny[i] + P.ny[k], l = Math.hypot(vx, vy) || 1;
    P.vnx[i] = vx / l; P.vny[i] = vy / l;
  }
  P.per = per; P.sE = P.s0[e];
  let u0 = Infinity, w0 = Infinity, u1 = -Infinity, w1 = -Infinity;
  for (const [u, w] of pts) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
  // Bucket size: about two particle spacings, coarser for very large outlines.
  g = Math.max(g, Math.sqrt((u1 - u0 + 2 * g) * (w1 - w0 + 2 * g) / 2.5e5));
  P.g = g; P.gu = u0 - g; P.gw = w0 - g;
  const nu = P.nu = Math.ceil((u1 - u0) / g) + 3, nw = P.nw = Math.ceil((w1 - w0) / g) + 3;
  const lists = Array.from({ length: nu * nw }, () => []), reach = g * (1 + Math.SQRT1_2);
  for (let i = 0; i < n; i++) {
    const ax = P.ax[i], ay = P.ay[i], bx = ax + P.dx[i], by = ay + P.dy[i];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - P.gu) / g)), i1 = Math.min(nu - 1, Math.floor((Math.max(ax, bx) + reach - P.gu) / g));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - P.gw) / g)), j1 = Math.min(nw - 1, Math.floor((Math.max(ay, by) + reach - P.gw) / g));
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
      const cu = P.gu + (ii + 0.5) * g, cw = P.gw + (jj + 0.5) * g;
      let tt = ((cu - ax) * P.dx[i] + (cw - ay) * P.dy[i]) / P.l2[i]; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
      if (Math.hypot(cu - ax - tt * P.dx[i], cw - ay - tt * P.dy[i]) <= reach) lists[ii + jj * nu].push(i);
    }
  }
  P.start = new Int32Array(nu * nw + 1);
  for (let k = 0; k < nu * nw; k++) P.start[k + 1] = P.start[k] + lists[k].length;
  P.seg = new Int32Array(P.start[nu * nw]);
  P.inside = new Uint8Array(nu * nw);
  for (let k = 0; k < nu * nw; k++) {
    P.seg.set(lists[k], P.start[k]);
    P.inside[k] = pointInPoly(pts, P.gu + (k % nu + 0.5) * g, P.gw + (Math.floor(k / nu) + 0.5) * g) ? 1 : 0;
  }
  P.pts = pts;
  t.poly = P; t.wmin = w0; t.umax = u1;
  t.lastSeg = 0; t.lastT = 0;
}

function pointInPoly(pts, u, w) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ui, wi] = pts[i], [uj, wj] = pts[j];
    if ((wi > w) !== (wj > w) && u < (uj - ui) * (w - wi) / (wj - wi) + ui) c = !c;
  }
  return c;
}

function polySdf(t, u, w, o, exact = false) {
  const P = t.poly, g = P.g;
  const i = Math.floor((u - P.gu) / g), j = Math.floor((w - P.gw) / g);
  const inGrid = !exact && i >= 0 && j >= 0 && i < P.nu && j < P.nw, k = i + j * P.nu;
  let a = 0, b = P.n, list = null;
  if (inGrid) {
    a = P.start[k]; b = P.start[k + 1]; list = P.seg;
    if (a === b) {                                       // farther than one bucket from the outline
      if (!P.inside[k]) { o[0] = g; o[1] = 0; o[2] = 0; return g; }
      a = 0; b = P.n; list = null;                        // deep inside: exact search
    }
  }
  let best = Infinity, bs = 0, bt = 0;
  for (let q = a; q < b; q++) {
    const s = list ? list[q] : q;
    const ex = u - P.ax[s], ew = w - P.ay[s];
    let tt = (ex * P.dx[s] + ew * P.dy[s]) / P.l2[s]; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    const rx = ex - tt * P.dx[s], ry = ew - tt * P.dy[s], d2 = rx * rx + ry * ry;
    if (d2 < best) { best = d2; bs = s; bt = tt; }
  }
  const s = bs, cx = P.ax[s] + bt * P.dx[s], cy = P.ay[s] + bt * P.dy[s];
  let nx, ny;
  if (bt <= 0) { nx = P.vnx[s]; ny = P.vny[s]; }
  else if (bt >= 1) { const v = (s + 1) % P.n; nx = P.vnx[v]; ny = P.vny[v]; }
  else { nx = P.nx[s]; ny = P.ny[s]; }
  const rx = u - cx, ry = w - cy, d = Math.sqrt(best);
  let sign = rx * nx + ry * ny >= 0 ? 1 : -1;
  if (inGrid && d > g) sign = P.inside[k] ? -1 : 1;
  t.lastSeg = s; t.lastT = bt;
  if (d > 1e-12) { o[1] = sign * rx / d; o[2] = sign * ry / d; } else { o[1] = nx; o[2] = ny; }
  o[0] = sign * d;
  return o[0];
}

// Signed arc length along the tool surface from the cutting edge for a local point:
// + up the rake face, − back along the flank.
export function arcPos(t, u, w, o = t.out) {
  if (!t.poly) {
    const s1 = u * t.u1x + w * t.u1y, s2 = u * t.u2x + w * t.u2y;
    return s1 >= s2 ? Math.max(s1, 0) : -Math.max(s2, 0);
  }
  polySdf(t, u, w, o, true);                             // exact nearest segment, any distance
  const P = t.poly;
  let s = P.s0[t.lastSeg] + t.lastT * Math.sqrt(P.l2[t.lastSeg]) - P.sE;
  if (s > 0.5 * P.per) s -= P.per; else if (s <= -0.5 * P.per) s += P.per;
  return s;
}

export function setPose(t, ex, ey, th) {
  t.ex = ex; t.ey = ey; t.th = th; t.ct = Math.cos(th); t.st = Math.sin(th);
}

// Signed distance in the local frame. Writes [d, nu, nw] into o and returns d.
export function localSdf(t, ru, rw, o) {
  if (t.poly) return polySdf(t, ru, rw, o);
  const d1 = ru * t.n1x + rw * t.n1y, d2 = ru * t.n2x + rw * t.n2y;
  if (d1 <= 0 && d2 <= 0) {
    // Inside the shrunk wedge: nearest face is the one with the larger (less negative) distance.
    if (d1 > d2) { o[1] = t.n1x; o[2] = t.n1y; o[0] = d1 - t.r; }
    else { o[1] = t.n2x; o[2] = t.n2y; o[0] = d2 - t.r; }
    return o[0];
  }
  // Outside: distance to the nearer of the two face rays.
  let s1 = ru * t.u1x + rw * t.u1y; if (s1 < 0) s1 = 0;
  let s2 = ru * t.u2x + rw * t.u2y; if (s2 < 0) s2 = 0;
  const ax = ru - s1 * t.u1x, ay = rw - s1 * t.u1y, bx = ru - s2 * t.u2x, by = rw - s2 * t.u2y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < lb) { o[1] = ax / la; o[2] = ay / la; o[0] = la - t.r; }
  else { o[1] = bx / lb; o[2] = by / lb; o[0] = lb - t.r; }
  return o[0];
}

// Signed distance from world point (px, py) to the tool surface (negative inside).
// Writes [d, nx, ny, u, w] into tool.out (world normal, local coordinates) and returns d.
export function toolSdf(t, px, py) {
  const dx = px - t.ex, dy = py - t.ey, o = t.out;
  const ru = dx * t.ct + dy * t.st, rw = -dx * t.st + dy * t.ct;
  localSdf(t, ru, rw, o);
  const nu = o[1], nw = o[2];
  o[1] = nu * t.ct - nw * t.st; o[2] = nu * t.st + nw * t.ct; o[3] = ru; o[4] = rw;
  return o[0];
}

// Tool outline for drawing (world coordinates): rake face up to len, round edge, clearance face.
export function toolOutline(t, len) {
  if (t.poly) return t.poly.pts.map(([u, w]) => [t.ex + u * t.ct - w * t.st, t.ey + u * t.st + w * t.ct]);
  const loc = [];
  loc.push([t.u1x * len + t.n1x * t.r, t.u1y * len + t.n1y * t.r]);
  const a1 = Math.atan2(t.n1y, t.n1x), a2 = Math.atan2(t.n2y, t.n2x);
  let da = a2 - a1; if (da > 0) da -= 2 * Math.PI;
  for (let i = 0; i <= 16; i++) {
    const ang = a1 + da * i / 16;
    loc.push([Math.cos(ang) * t.r, Math.sin(ang) * t.r]);
  }
  const back = [t.u2x * len + t.n2x * t.r, t.u2y * len + t.n2y * t.r];
  loc.push(back);
  // Close the body behind the two faces.
  loc.push([back[0], loc[0][1]]);
  return loc.map(([u, w]) => [t.ex + u * t.ct - w * t.st, t.ey + u * t.st + w * t.ct]);
}
