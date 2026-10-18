// Rigid cutting tool for orthogonal cutting: a wedge with rake angle α, clearance angle γ
// and a rounded cutting edge of radius r. The tool moves in +x; the rake face faces +x.
// Positions are in metres. (ex, ey) is the centre of the edge circle, which is also the tip of
// the sharp wedge shrunk by r, so the tool surface is {p : dWedge(p − e) = r}.
export function makeTool({ rakeDeg, clearanceDeg, edgeRadius }) {
  const a = rakeDeg * Math.PI / 180, g = clearanceDeg * Math.PI / 180;
  // Unit directions along the rake face (up) and clearance face (back, -x) from the tip.
  const u1x = -Math.sin(a), u1y = Math.cos(a);
  const u2x = -Math.cos(g), u2y = Math.sin(g);
  // Outward normals: rake face faces +x, clearance face faces down.
  const n1x = Math.cos(a), n1y = Math.sin(a);
  const n2x = Math.sin(g), n2y = -Math.cos(g);
  return { a, g, r: edgeRadius, u1x, u1y, u2x, u2y, n1x, n1y, n2x, n2y, ex: 0, ey: 0, out: new Float64Array(3) };
}

// Signed distance from (px, py) to the tool surface (negative inside) and outward normal.
// Writes [d, nx, ny] into tool.out and returns d.
export function toolSdf(t, px, py) {
  const rx = px - t.ex, ry = py - t.ey, o = t.out;
  const d1 = rx * t.n1x + ry * t.n1y, d2 = rx * t.n2x + ry * t.n2y;
  if (d1 <= 0 && d2 <= 0) {
    // Inside the shrunk wedge: nearest face is the one with the larger (less negative) distance.
    if (d1 > d2) { o[1] = t.n1x; o[2] = t.n1y; o[0] = d1 - t.r; }
    else { o[1] = t.n2x; o[2] = t.n2y; o[0] = d2 - t.r; }
    return o[0];
  }
  // Outside: distance to the nearer of the two face rays.
  let s1 = rx * t.u1x + ry * t.u1y; if (s1 < 0) s1 = 0;
  let s2 = rx * t.u2x + ry * t.u2y; if (s2 < 0) s2 = 0;
  const ax = rx - s1 * t.u1x, ay = ry - s1 * t.u1y, bx = rx - s2 * t.u2x, by = ry - s2 * t.u2y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < lb) { o[1] = ax / la; o[2] = ay / la; o[0] = la - t.r; }
  else { o[1] = bx / lb; o[2] = by / lb; o[0] = lb - t.r; }
  return o[0];
}

// Tool outline for drawing: rake face up to height hTop, round edge, clearance face back by len.
export function toolOutline(t, len) {
  const pts = [];
  const top = [t.ex + t.u1x * len + t.n1x * t.r, t.ey + t.u1y * len + t.n1y * t.r];
  pts.push(top);
  const a1 = Math.atan2(t.n1y, t.n1x), a2 = Math.atan2(t.n2y, t.n2x);
  let da = a2 - a1; if (da > 0) da -= 2 * Math.PI;
  for (let i = 0; i <= 16; i++) {
    const ang = a1 + da * i / 16;
    pts.push([t.ex + Math.cos(ang) * t.r, t.ey + Math.sin(ang) * t.r]);
  }
  pts.push([t.ex + t.u2x * len + t.n2x * t.r, t.ey + t.u2y * len + t.n2y * t.r]);
  // Close the body behind the two faces.
  const back = pts[pts.length - 1];
  pts.push([back[0], top[1]]);
  return pts;
}
