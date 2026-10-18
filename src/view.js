// Three.js rendering (global THREE, r128). Z is up, units mm.
import { MAX_CHIPS } from './chips.js';

export class View {
  constructor(canvas) {
    const T = THREE;
    this.canvas = canvas;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(38, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.orbit = { target: new T.Vector3(60, 40, -10), dist: 230, az: -0.95, el: 0.72 };
    this.scene.add(new T.HemisphereLight(0xdfe8f2, 0x3a3f47, 0.75));
    const sun = new T.DirectionalLight(0xffffff, 0.75); sun.position.set(-80, -120, 200); this.scene.add(sun);
    const rim = new T.DirectionalLight(0xffe2b0, 0.35); rim.position.set(150, 120, 80); this.scene.add(rim);
    this.colorMode = 'material';
    this.exag = 100;
    this.showChips = true; this.showPath = true;
    this.buildTool();
    this.buildChips();
    this.buildNozzle();
    this.bindControls();
  }

  // ---------- stock ----------
  setStock(stock, mat) {
    const T = THREE;
    if (this.stockGroup) { this.scene.remove(this.stockGroup); this.stockGroup.traverse(o => o.geometry && o.geometry.dispose()); }
    this.stock = stock; this.mat = mat;
    const { nx, ny } = stock, n = nx * ny;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = i * stock.hx; pos[k * 3 + 1] = j * stock.hy; pos[k * 3 + 2] = stock.H[k];
      nor[k * 3 + 2] = 1;
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = c;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('normal', new T.BufferAttribute(nor, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(col, 3).setUsage(T.DynamicDrawUsage));
    g.setIndex(new T.BufferAttribute(idx, 1));
    this.topGeo = g;
    const m = new T.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5 });
    this.top = new T.Mesh(g, m);
    // side walls follow the edge heights
    const per = 2 * (nx + ny);
    const wg = new T.BufferGeometry();
    wg.setAttribute('position', new T.BufferAttribute(new Float32Array(per * 2 * 3), 3).setUsage(T.DynamicDrawUsage));
    const wi = [];
    for (let s = 0; s < per - 1; s++) { const a = s * 2, b = a + 1, c = a + 2, d = a + 3; wi.push(a, c, b, b, c, d); }
    wg.setIndex(wi);
    this.wallGeo = wg;
    const base = new T.Color(...mat.chip).multiplyScalar(0.8);
    this.walls = new T.Mesh(wg, new T.MeshStandardMaterial({ color: base, metalness: 0.3, roughness: 0.65, side: T.DoubleSide }));
    // machine table under the stock
    const table = new T.Mesh(new T.PlaneGeometry(stock.w + 160, stock.l + 160), new T.MeshStandardMaterial({ color: 0x5a636e, metalness: 0.4, roughness: 0.7 }));
    table.position.set(stock.w / 2, stock.l / 2, stock.zBottom - 0.05);
    const grid = new T.GridHelper(Math.max(stock.w, stock.l) + 160, 24, 0x7c8794, 0x6a737e);
    grid.rotation.x = Math.PI / 2; grid.position.set(stock.w / 2, stock.l / 2, stock.zBottom);
    this.stockGroup = new T.Group();
    this.stockGroup.add(this.top, this.walls, table, grid);
    this.scene.add(this.stockGroup);
    this.updateStock(true);
    this.orbit.target.set(stock.w / 2, stock.l / 2, stock.zBottom / 2);
    this.orbit.dist = Math.max(stock.w, stock.l) * 2.1;
  }

  updateStock(all = false) {
    const s = this.stock, { nx, ny, H } = s;
    let { i0, j0, i1, j1 } = s.dirty;
    if (all) { i0 = 0; j0 = 0; i1 = nx - 1; j1 = ny - 1; }
    if (i1 < 0) return;
    i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1); i1 = Math.min(nx - 1, i1 + 1); j1 = Math.min(ny - 1, j1 + 1);
    const pos = this.topGeo.attributes.position, nor = this.topGeo.attributes.normal, col = this.topGeo.attributes.color;
    const P = pos.array, N = nor.array, C = col.array;
    const base = this.mat.chip, depth = s.zTop - s.zBottom;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i, z = H[k];
      P[k * 3 + 2] = z;
      const zl = H[j * nx + Math.max(0, i - 1)], zr = H[j * nx + Math.min(nx - 1, i + 1)];
      const zd = H[Math.max(0, j - 1) * nx + i], zu = H[Math.min(ny - 1, j + 1) * nx + i];
      let gx = (zl - zr) / (2 * s.hx), gy = (zd - zu) / (2 * s.hy);
      const L = Math.hypot(gx, gy, 1);
      N[k * 3] = gx / L; N[k * 3 + 1] = gy / L; N[k * 3 + 2] = 1 / L;
      let r, g, b;
      const cut = z < s.zTop - 0.005;
      if (this.colorMode === 'vibration' && cut) [r, g, b] = ramp(Math.min(1, s.err[k] / 40));
      else if (this.colorMode === 'depth') [r, g, b] = ramp(Math.min(1, (s.zTop - z) / depth));
      else if (cut) { r = base[0] * 1.12; g = base[1] * 1.12; b = base[2] * 1.15; }
      else { r = base[0] * 0.78; g = base[1] * 0.78; b = base[2] * 0.8; }
      C[k * 3] = r; C[k * 3 + 1] = g; C[k * 3 + 2] = b;
    }
    const off = j0 * nx * 3, cnt = (j1 - j0 + 1) * nx * 3;
    for (const a of [pos, nor, col]) { a.updateRange.offset = all ? 0 : off; a.updateRange.count = all ? -1 : cnt; a.needsUpdate = true; }
    this.updateWalls();
    s.clearDirty();
  }

  updateWalls() {
    const s = this.stock, { nx, ny, H } = s, P = this.wallGeo.attributes.position.array;
    let v = 0;
    const put = (i, j) => {
      const x = i * s.hx, y = j * s.hy, z = H[j * nx + i];
      P[v++] = x; P[v++] = y; P[v++] = z; P[v++] = x; P[v++] = y; P[v++] = s.zBottom;
    };
    for (let i = 0; i < nx; i++) put(i, 0);
    for (let j = 0; j < ny; j++) put(nx - 1, j);
    for (let i = nx - 1; i >= 0; i--) put(i, ny - 1);
    for (let j = ny - 1; j >= 0; j--) put(0, j);
    this.wallGeo.attributes.position.needsUpdate = true;
    this.wallGeo.computeVertexNormals();
  }

  // ---------- tool ----------
  buildTool() {
    const T = THREE;
    this.pivot = new T.Group();   // at the holder face; tilting it shows deflection
    this.spin = new T.Group();
    this.pivot.add(this.spin);
    this.scene.add(this.pivot);
    this.fluteMat = new T.MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.85, roughness: 0.28 });
    this.holderMat = new T.MeshStandardMaterial({ color: 0x2f3338, metalness: 0.7, roughness: 0.35 });
  }

  setTool(t) {
    const T = THREE;
    this.toolCfg = t;
    for (const c of [...this.spin.children]) { this.spin.remove(c); c.geometry.dispose(); }
    const R = t.D / 2;
    // fluted section with helical grooves, built along +z from the tip
    const segZ = 48, segA = 48, fl = t.fluteLen;
    const g = new T.CylinderGeometry(R, R, fl, segA, segZ, false);
    g.rotateX(Math.PI / 2); g.translate(0, 0, fl / 2);
    const p = g.attributes.position;
    const tanB = Math.tan(t.helixDeg * Math.PI / 180);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = Math.hypot(x, y);
      if (r < 1e-6) continue;
      let a = Math.atan2(y, x) + z * tanB / R;
      // groove profile: N flutes, each a smooth dip in radius
      const ph = ((a * t.N / (2 * Math.PI)) % 1 + 1) % 1;
      const dip = Math.max(0, Math.sin(ph * Math.PI * 2)) ** 3 * 0.22;
      let rr = R * (1 - dip);
      if (t.type === 'ball' && z < R) rr *= Math.sqrt(Math.max(0, 1 - ((R - z) / R) ** 2));
      const s = rr / r;
      p.setXY(i, x * s, y * s);
    }
    g.computeVertexNormals();
    const flute = new T.Mesh(g, this.fluteMat);
    const shankLen = Math.max(1, t.stickout - fl);
    const sg = new T.CylinderGeometry(R, R, shankLen, 32); sg.rotateX(Math.PI / 2); sg.translate(0, 0, fl + shankLen / 2);
    const shank = new T.Mesh(sg, this.fluteMat);
    // collet nut + holder body above the stickout
    const hg1 = new T.CylinderGeometry(R * 1.9, R * 2.3, 14, 40); hg1.rotateX(Math.PI / 2); hg1.translate(0, 0, t.stickout + 7);
    const hg2 = new T.CylinderGeometry(R * 3.4, R * 2.4, 22, 40); hg2.rotateX(Math.PI / 2); hg2.translate(0, 0, t.stickout + 25);
    const hg3 = new T.CylinderGeometry(R * 4.4, R * 4.4, 30, 40); hg3.rotateX(Math.PI / 2); hg3.translate(0, 0, t.stickout + 51);
    this.spin.add(flute, shank, new T.Mesh(hg1, this.holderMat), new T.Mesh(hg2, this.holderMat), new T.Mesh(hg3, this.holderMat));
    // tool hangs from the pivot: children are offset by -stickout
    this.spin.position.set(0, 0, -t.stickout);
  }

  // tool tip nominal position, deflection [mm] (already exaggerated), spin angle
  updateTool(pos, dx, dy, angle) {
    const L = this.toolCfg.stickout;
    this.pivot.position.set(pos.x, pos.y, pos.z + L);
    const sx = Math.max(-0.9, Math.min(0.9, dy / L)), sy = Math.max(-0.9, Math.min(0.9, dx / L));
    this.pivot.rotation.set(Math.asin(sx), -Math.asin(sy), 0);
    this.spin.rotation.z = -angle; // clockwise seen from above
  }

  // ---------- coolant nozzle ----------
  buildNozzle() {
    const T = THREE;
    this.nozzle = new T.Group();
    const body = new T.Mesh(new T.CylinderGeometry(1.4, 1.8, 18, 16), new T.MeshStandardMaterial({ color: 0x3b6f9e, metalness: 0.3, roughness: 0.5 }));
    body.rotation.x = Math.PI / 2;
    this.jet = new T.Mesh(new T.ConeGeometry(1, 1, 24, 1, true), new T.MeshBasicMaterial({ color: 0x8ec9ff, transparent: true, opacity: 0.18, depthWrite: false, side: T.DoubleSide }));
    this.nozzle.add(body);
    this.scene.add(this.nozzle, this.jet);
  }
  updateNozzle(coolant, tip) {
    const T = THREE;
    const on = coolant !== 'dry';
    this.nozzle.visible = on; this.jet.visible = on;
    if (!on) return;
    const from = new T.Vector3(tip.x - 45, tip.y - 35, tip.z + 55), to = new T.Vector3(tip.x, tip.y, tip.z);
    const dir = to.clone().sub(from); const L = dir.length(); dir.normalize();
    this.nozzle.position.copy(from);
    this.nozzle.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), dir);
    const w = coolant === 'flood' ? 6 + L * 0.25 : 3 + L * 0.12;
    this.jet.scale.set(w, L, w);
    this.jet.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), dir);
    this.jet.position.copy(from).addScaledVector(dir, L / 2);
    this.jet.material.color.set(coolant === 'flood' ? 0x6fb7ff : 0xdcefff);
    this.jet.material.opacity = coolant === 'flood' ? 0.28 : 0.12;
  }

  // ---------- chips ----------
  buildChips() {
    const T = THREE;
    const g = new T.TorusGeometry(1, 0.22, 4, 10, Math.PI * 1.4);
    this.chipMesh = new T.InstancedMesh(g, new T.MeshStandardMaterial({ metalness: 0.75, roughness: 0.35 }), MAX_CHIPS);
    this.chipMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.chipMesh.frustumCulled = false;
    this.chipMesh.setColorAt(0, new T.Color(1, 1, 1));
    this.scene.add(this.chipMesh);
    this._m = new T.Matrix4(); this._q = new T.Quaternion(); this._e = new T.Euler(); this._s = new T.Vector3(); this._p = new T.Vector3(); this._c = new T.Color();
  }
  updateChips(cs, mat) {
    const mesh = this.chipMesh;
    mesh.visible = this.showChips;
    if (!this.showChips) return;
    const zero = this._m.makeScale(0, 0, 0).clone();
    const base = mat.chip;
    for (let i = 0; i < MAX_CHIPS; i++) {
      if (!cs.state[i]) { mesh.setMatrixAt(i, zero); continue; }
      const o = i * 3;
      this._p.set(cs.p[o], cs.p[o + 1], cs.p[o + 2]);
      this._e.set(cs.rot[o], cs.rot[o + 1], cs.rot[o] * 0.7);
      this._q.setFromEuler(this._e);
      const sz = cs.size[i];
      this._s.set(sz, sz, sz * 1.2);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
      // hot steel chips glow straw → blue, aluminium stays silver
      const h = cs.heat[i];
      if (mat.hot && h > 0.05) this._c.setRGB(base[0] + h * 0.5, base[1] + h * 0.25, base[2] - h * 0.1);
      else this._c.setRGB(base[0], base[1], base[2]);
      mesh.setColorAt(i, this._c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ---------- tool path ----------
  setPath(path) {
    const T = THREE;
    if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); }
    const pos = [], col = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const c = b.rapid ? [0.85, 0.35, 0.3] : [0.25, 0.6, 0.95];
      col.push(...c, ...c);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    this.pathLine = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
    this.pathLine.visible = this.showPath;
    this.scene.add(this.pathLine);
  }

  // ---------- camera ----------
  bindControls() {
    const el = this.canvas;
    const pts = new Map();
    let last = null;
    el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey }); last = null; });
    el.addEventListener('pointerup', e => { pts.delete(e.pointerId); last = null; });
    el.addEventListener('pointercancel', e => { pts.delete(e.pointerId); last = null; });
    el.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (last) this.orbit.dist = clamp(this.orbit.dist * last / d, 20, 2000);
        last = d; return;
      }
      if (p.btn === 2 || p.btn === 1 || p.shift) this.pan(dx, dy);
      else { this.orbit.az -= dx * 0.008; this.orbit.el = clamp(this.orbit.el + dy * 0.008, -0.2, 1.55); }
    });
    el.addEventListener('wheel', e => { e.preventDefault(); this.orbit.dist = clamp(this.orbit.dist * Math.exp(e.deltaY * 0.001), 20, 2000); }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }
  pan(dx, dy) {
    const T = THREE, o = this.orbit;
    const right = new T.Vector3(Math.cos(o.az + Math.PI / 2), Math.sin(o.az + Math.PI / 2), 0);
    const fwd = new T.Vector3(Math.cos(o.az), Math.sin(o.az), 0);
    const k = o.dist * 0.0016;
    o.target.addScaledVector(right, dx * k).addScaledVector(fwd, dy * k);
  }
  setView(name) {
    const o = this.orbit;
    if (name === 'top') { o.el = 1.55; o.az = -Math.PI / 2; }
    else if (name === 'front') { o.el = 0.05; o.az = -Math.PI / 2; }
    else { o.el = 0.72; o.az = -0.95; }
  }

  render() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.round(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    }
    const o = this.orbit;
    this.camera.position.set(o.target.x + o.dist * Math.cos(o.el) * Math.cos(o.az), o.target.y + o.dist * Math.cos(o.el) * Math.sin(o.az), o.target.z + o.dist * Math.sin(o.el));
    this.camera.lookAt(o.target);
    if (this.pathLine) this.pathLine.visible = this.showPath;
    this.renderer.render(this.scene, this.camera);
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// perceptual-ish ramp: deep blue → teal → amber → red
function ramp(t) {
  const stops = [[0.16, 0.27, 0.55], [0.13, 0.6, 0.62], [0.95, 0.72, 0.2], [0.85, 0.2, 0.15]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
