// 3D view without WebGL (a browser or a company policy that turns it off): the same calls as
// View3D, drawn on a 2D canvas. Particles are splatted as shaded discs into a depth buffer; the
// tool is drawn over them as translucent triangles, back to front. Orthographic, drag to turn,
// wheel to zoom. Always particles: the continuous surface needs the GPU.

const FOV = 35 * Math.PI / 180;

// Tool triangles in the solver frame (x, y, z), flat: [ax, ay, az, bx, ...].
function toolTris(t) {
  const out = [];
  const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  if (t.mesh) {
    if (!t.tris) return null;
    const [mx, mz, ang, ax, ay] = t.pose, ca = Math.cos(ang), sa = Math.sin(ang), s = t.tris;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i] - ax, y = s[i + 1] - ay;
      out.push(ca * x - sa * y + ax + mx, sa * x + ca * y + ay, s[i + 2] + mz);
    }
    return out;
  }
  if (t.helix) {
    const z0 = -0.4 * t.ap, z1 = 1.4 * t.ap, ns = 16, ol = t.outline, n = ol.length, rings = [];
    const ct = Math.cos(t.theta), st = Math.sin(t.theta);
    for (let k = 0; k <= ns; k++) {
      const z = z0 + (z1 - z0) * k / ns, a = -z * t.kh, ca = Math.cos(a), sa = Math.sin(a);
      rings.push(ol.map(([u, w]) => {
        const qx = t.rr - w, qy = u, px = ca * qx - sa * qy, py = sa * qx + ca * qy;
        return [ct * px - st * py + t.c[0], st * px + ct * py + t.c[1], z];
      }));
    }
    for (let k = 0; k < ns; k++) for (let i = 0; i < n; i++) quad(rings[k][i], rings[k][(i + 1) % n], rings[k + 1][(i + 1) % n], rings[k + 1][i]);
    return out;
  }
  // Wedge: the normal-section outline (u, w) swept along the inclined edge e.
  const n = [Math.cos(t.lam), 0, -Math.sin(t.lam)], e = [Math.sin(t.lam), 0, Math.cos(t.lam)], ol = t.outline, m = ol.length;
  const at = ([u, w], z) => [u * n[0] + z * e[0] + t.pos[0], w + t.pos[1], u * n[2] + z * e[2] + t.pos[2]];
  const A = ol.map((p) => at(p, -t.len / 2)), B = ol.map((p) => at(p, t.len / 2));
  for (let i = 0; i < m; i++) quad(A[i], A[(i + 1) % m], B[(i + 1) % m], B[i]);
  for (let i = 1; i < m - 1; i++) out.push(...A[0], ...A[i], ...A[i + 1], ...B[0], ...B[i], ...B[i + 1]);   // caps (fan)
  return out;
}

export class View3DCanvas {
  constructor(el) {
    this.el = el; this.flat = true;
    this.cv = document.createElement('canvas'); this.cv.style.width = '100%'; this.cv.style.height = '100%'; this.cv.style.display = 'block';
    this.cv.style.touchAction = 'none';
    el.appendChild(this.cv);
    this.note = document.createElement('div');
    this.note.textContent = 'WebGL が使えないため簡易表示（粒子のみ）';
    this.note.style.cssText = 'position:absolute;bottom:8px;right:10px;font-size:12px;color:var(--ink-mute,#555);background:var(--panel,#fff);opacity:.85;padding:2px 6px;border-radius:4px;pointer-events:none';
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(this.note);
    this.ctx = this.cv.getContext('2d');
    this.target = [0, 0, 0]; this.yaw = 0.6; this.pitch = 0.45; this.dist = 1;
    this.zoom = 'tip'; this.framed = false; this.helix = null; this.last = null; this.tris = null; this.trisId = null;
    let drag = null;
    this.cv.addEventListener('pointerdown', (ev) => { drag = [ev.clientX, ev.clientY]; this.cv.setPointerCapture(ev.pointerId); });
    this.cv.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      this.yaw -= (ev.clientX - drag[0]) * 0.008; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + (ev.clientY - drag[1]) * 0.008));
      drag = [ev.clientX, ev.clientY]; this.render();
    });
    this.cv.addEventListener('pointerup', () => { drag = null; });
    this.cv.addEventListener('wheel', (ev) => { ev.preventDefault(); this.dist *= ev.deltaY > 0 ? 1.12 : 1 / 1.12; this.render(); }, { passive: false });
    new ResizeObserver(() => this.render()).observe(el);
  }

  // Solver frame → view (y up): identity for oblique cutting; (x, z, −y) for the end mill and STL.
  world(x, y, z) { return this.helix ? [x, z, -y] : [x, y, z]; }
  setFrame(helix) { if (this.helix !== helix) { this.helix = helix; this.framed = false; } }

  // Same aims as View3D.frame, as a target, a distance and a direction (yaw, pitch).
  frame(f, zoom = this.zoom) {
    this.zoom = zoom;
    const t = f.tool, h = f.h, [L, H, B] = f.box;
    let tg, dist, dir;
    if (t.mesh) {
      const wb = t.wb, span = Math.max(wb[3] - wb[0], wb[4] - wb[1], wb[5] - wb[2]);
      const wc = [0.5 * (wb[0] + wb[3]), 0.5 * (wb[1] + wb[4]), 0.5 * (wb[2] + wb[5])], tc = [t.pose[3] + t.pose[0], t.pose[4], wb[5] + t.pose[1]];
      const k = zoom === 'tip' ? 0.3 : 0.5, d = Math.hypot(wc[0] - tc[0], wc[1] - tc[1], wc[2] - tc[2]);
      tg = this.world(wc[0] + k * (tc[0] - wc[0]), wc[1] + k * (tc[1] - wc[1]), wc[2] + k * (tc[2] - wc[2]));
      dist = zoom === 'tip' ? Math.max(1.25 * span, 30 * h) : 2.4 * Math.max(span, d * 1.5);
      let ax = wc[0] - tc[0], ay = wc[1] - tc[1];
      if (Math.hypot(ax, ay) < 0.2 * span) { ax = 0.75; ay = -0.9; }
      const l = Math.hypot(ax, ay); ax /= l; ay /= l;
      dir = this.world(ax + 0.35 * ay, ay - 0.35 * ax, 0.75);
    } else if (t.helix) {
      const th = t.theta - 0.5 * t.ap * t.kh, ct = Math.cos(th), st = Math.sin(th);
      tg = zoom === 'tip' ? this.world(t.c[0] + t.R * ct, t.c[1] + t.R * st, 0.5 * t.ap) : this.world(0, -0.5 * H, 0.5 * t.ap);
      dist = zoom === 'tip' ? Math.max(20 * h, 4 * t.ap) : 1.6 * Math.max(L, 3 * t.ap);
      dir = this.world(-st + 0.45 * ct, ct + 0.45 * st, 0.6);
    } else {
      tg = zoom === 'tip' ? [t.pos[0] + 0.8 * h, 0.6 * h, t.pos[2]] : [0.5 * L, -0.3 * H, 0];
      dist = zoom === 'tip' ? Math.max(16 * h, 4.5 * B) : 1.5 * Math.max(L, 3 * B);
      dir = [0.8, 0.5, 0.55];
    }
    const dl = Math.hypot(...dir);
    this.target = tg; this.dist = dist;
    this.yaw = Math.atan2(dir[0], dir[2]); this.pitch = Math.asin(dir[1] / dl);
    this.framed = true;
    this.render();
  }

  clear() { this.last = null; this.tris = null; this.trisId = null; this.framed = false; this.render(); }

  update(f, vals, lo, hi, lut, section) {
    const t = f.tool;
    this.setFrame(!!(t.helix || t.mesh));
    const n = f.x.length, halfT = 0.75 * f.dx, zc = t.helix ? 0.5 * t.ap : 0, sc = t.mesh ? f.y : f.z, yc = t.mesh ? t.pose[4] : zc;
    const sel = [];
    for (let i = 0; i < n; i++) if (!section || Math.abs(sc[i] - yc) < halfT) sel.push(i);
    // An imported tool's triangles come with the first frame of a run only: keep them.
    if (t.mesh) { if (t.tris) { this.tris = t.tris; this.trisId = t.id; } }
    this.last = { f, vals, lo, hi, lut, sel, tool: t.mesh ? { ...t, tris: this.trisId === t.id ? this.tris : null } : t };
    if (!this.framed) this.frame(f); else this.render();
  }

  render() {
    const cv = this.cv, dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(this.el.clientWidth * dpr), h = Math.round(this.el.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = this.ctx;
    g.clearRect(0, 0, w, h);
    const L = this.last;
    if (!L) return;
    // Camera basis: d towards the viewer, r to the right, u up.
    const cp = Math.cos(this.pitch), d = [cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw)];
    let r = [d[2], 0, -d[0]]; const rl = Math.hypot(r[0], r[2]) || 1; r = [r[0] / rl, 0, r[2] / rl];
    const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
    const s = h / (2 * this.dist * Math.tan(FOV / 2)), cx = 0.5 * w, cy = 0.5 * h, [tx, ty, tz] = this.target;
    const proj = (p) => { const x = p[0] - tx, y = p[1] - ty, z = p[2] - tz; return [cx + s * (x * r[0] + y * r[1] + z * r[2]), cy - s * (x * u[0] + y * u[1] + z * u[2]), x * d[0] + y * d[1] + z * d[2]]; };
    // Particles: discs with a little sphere shading, nearest wins.
    const { f, vals, lo, hi, lut, sel } = L, img = g.createImageData(w, h), px = new Uint32Array(img.data.buffer), zb = new Float32Array(w * h).fill(-Infinity);
    const rad = Math.max(1, 0.6 * f.dx * s), ri = Math.ceil(rad), inv = 255 / (hi - lo || 1);
    for (const i of sel) {
      const [sx, sy, sz] = proj(this.world(f.x[i], f.y[i], f.z[i]));
      if (sx < -ri || sy < -ri || sx > w + ri || sy > h + ri) continue;
      let k = Math.round((vals[i] - lo) * inv); k = k < 0 ? 0 : k > 255 ? 255 : k;
      const c = lut[k], dim = f.flag[i] === 1 ? 0.55 : 1;
      const x0 = Math.max(0, Math.floor(sx - ri)), x1 = Math.min(w - 1, Math.ceil(sx + ri)), y0 = Math.max(0, Math.floor(sy - ri)), y1 = Math.min(h - 1, Math.ceil(sy + ri));
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const ex = (xx - sx) / rad, ey = (yy - sy) / rad, q = 1 - ex * ex - ey * ey;
        if (q < 0) continue;
        const a = xx + yy * w, zz = sz + Math.sqrt(q) * f.dx * 0.6;
        if (zz <= zb[a]) continue;
        zb[a] = zz;
        const sh = dim * (0.62 + 0.38 * Math.sqrt(q) - 0.12 * (ex + ey));
        const R = Math.min(255, c[0] * sh), G = Math.min(255, c[1] * sh), B = Math.min(255, c[2] * sh);
        px[a] = 0xff000000 | (B << 16) | (G << 8) | R;
      }
    }
    g.putImageData(img, 0, 0);
    // Tool: translucent grey triangles, back to front, shaded by how much they face the viewer.
    const tt = toolTris(L.tool);
    if (tt && tt.length) {
      const tris = [];
      for (let i = 0; i < tt.length; i += 9) {
        const a = proj(this.world(tt[i], tt[i + 1], tt[i + 2])), b = proj(this.world(tt[i + 3], tt[i + 4], tt[i + 5])), c = proj(this.world(tt[i + 6], tt[i + 7], tt[i + 8]));
        const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]), ar = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - a[0], c[1] - a[1]);
        tris.push([a, b, c, (a[2] + b[2] + c[2]) / 3, ar > 0 ? Math.abs(cr) / ar : 0]);
      }
      tris.sort((p, q) => p[3] - q[3]);
      // Many small triangles overlap many times over: thinner each, so a fine STL stays see-through.
      const al = Math.max(0.06, Math.min(0.35, 0.35 * Math.sqrt(1500 / tris.length)));
      for (const [a, b, c, , lit] of tris) {
        const v = Math.round(120 + 100 * lit);
        g.fillStyle = `rgba(${v},${v + 6},${v + 14},${al})`;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.closePath(); g.fill();
      }
    }
  }
}
