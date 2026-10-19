// Rigid cutting tool (one tooth): a wedge with rake angle α, clearance angle γ and a rounded
// cutting edge of radius r. Geometry lives in a local frame (u, w): the tool cuts in +u, the rake
// face faces +u and runs up +w from the edge. The local origin is the centre of the edge circle,
// which is also the tip of the sharp wedge shrunk by r, so the surface is {dWedge = r}.
// Pose in the world: origin (ex, ey) and rotation th (local u axis = (cos th, sin th)).
// Rigid motion: velocity of a tool point p = (vx, vy) + om × (p − (ox, oy)).
// Positions in metres.
export function makeTool({ rakeDeg, clearanceDeg, edgeRadius }) {
  const a = rakeDeg * Math.PI / 180, g = clearanceDeg * Math.PI / 180;
  // Unit directions along the rake face (up) and clearance face (back, -u) from the tip.
  const u1x = -Math.sin(a), u1y = Math.cos(a);
  const u2x = -Math.cos(g), u2y = Math.sin(g);
  // Outward normals: rake face faces +u, clearance face faces down.
  const n1x = Math.cos(a), n1y = Math.sin(a);
  const n2x = Math.sin(g), n2y = -Math.cos(g);
  return {
    a, g, r: edgeRadius, u1x, u1y, u2x, u2y, n1x, n1y, n2x, n2y,
    ex: 0, ey: 0, th: 0, ct: 1, st: 0, vx: 0, vy: 0, om: 0, ox: 0, oy: 0,
    out: new Float64Array(5),
  };
}

export function setPose(t, ex, ey, th) {
  t.ex = ex; t.ey = ey; t.th = th; t.ct = Math.cos(th); t.st = Math.sin(th);
}

// Signed distance in the local frame. Writes [d, nu, nw] into o and returns d.
export function localSdf(t, ru, rw, o) {
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
