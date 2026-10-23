// A generic vertical machining centre around the cut (not modelled on any maker's machine):
// a moving-column design, so the bed, the T-slot table and the work stay put while the column
// travels in X and Y and the spindle head in Z, which is how the simulator moves the tool.
// Bed with chip troughs on both sides, telescopic way covers between the table and the column,
// the column with its ribs, the spindle head with a cartridge spindle and its nose, and the
// enclosure's back panels. Painted castings in a light machine grey, stainless covers.
// Sizes in mm, the work frame (stock top at z = 0).

const lin = c => new THREE.Color(c).convertSRGBToLinear();

// painted cast iron: a light machine grey, slightly mottled (a tiny canvas tiled)
function paint(color, rough = 0.55) {
  const T = THREE, c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), img = x.createImageData(64, 64);
  let s = 7;
  for (let i = 0; i < 64 * 64; i++) {
    s = (s * 16807) % 2147483647;
    const v = 236 + (s % 19);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(6, 6); t.encoding = T.sRGBEncoding;
  return new T.MeshStandardMaterial({ color: lin(color), map: t, metalness: 0.05, roughness: rough });
}

export class Machine {
  constructor(scene) {
    const T = THREE;
    this.scene = scene;
    this.mat = {
      casting: paint(0xd6d9d4),                       // machine grey
      dark: paint(0x4a4f56, 0.6),                     // covers of the head, the bed sides
      steel: new T.MeshStandardMaterial({ color: lin(0xb9bfc6), metalness: 0.9, roughness: 0.32 }), // stainless way covers
      nose: new T.MeshStandardMaterial({ color: lin(0xc3c8ce), metalness: 0.75, roughness: 0.3 }),  // ground spindle nose
      trough: new T.MeshStandardMaterial({ color: lin(0x9aa1a9), metalness: 0.8, roughness: 0.45 }),
      panel: paint(0x9da3a8, 0.75),
      accent: new T.MeshStandardMaterial({ color: lin(0x2f6f9f), metalness: 0.2, roughness: 0.5 }),  // a blue trim stripe
    };
    this.fixed = new T.Group();   // bed, troughs, back panels (set with the stock)
    this.column = new T.Group();  // moves in X and Y with the tool; its head moves in Z
    scene.add(this.fixed, this.column);
    this.buildColumn();
  }

  dispose(g) {
    for (const c of [...g.children]) { g.remove(c); c.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
  }

  // each mesh gets its own copy of the material, so that it can fade alone (see occlude)
  box(g, mat, sx, sy, sz, x, y, z, cast = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat.clone());
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true;
    g.add(m); return m;
  }

  // the fixed part around a stock of w × l on a table whose top is at z0 (table W × L, centred
  // on the stock)
  setStock(stock, table) {
    const T = THREE, M = this.mat, g = this.fixed;
    this.dispose(g);
    const cx = stock.w / 2, cy = stock.l / 2, W = table.W, L = table.L, zt = table.bottom;
    // the column stands on the bed top, 160 mm below the table (the table sits on a riser)
    const zb = zt - 160;
    this.cx = cx; this.cy = cy; this.zt = zb;
    // bed: a long casting under the table and the column, its top at zb
    const bedW = W + 420, bedL = L + 900, bedH = 420, bedY = cy + 330;
    this.box(g, M.dark, bedW, bedL, bedH, cx, bedY, zb - bedH / 2);
    // the table's riser (ribbed casting)
    this.box(g, M.casting, W * 0.82, L * 0.86, 160, cx, cy, zb + 80);
    for (const s of [-1, 1]) for (let k = -2; k <= 2; k++) this.box(g, M.casting, 26, L * 0.86 + 20, 120, cx + s * W * 0.41 + s * 13, cy, zb + 60).position.x += 0 * k;
    // chip troughs either side of the riser: stainless sheets sloping down to a channel at the
    // bed's edge (where a conveyor would take the chips out)
    for (const s of [-1, 1]) {
      const span = (bedW - W * 0.82) / 2 - 40, mid = cx + s * (W * 0.41 + span / 2);
      const tr = this.box(g, M.trough, span + 20, L + 160, 5, mid, cy, zb + 40, false);
      tr.rotation.y = s * Math.atan2(70, span);
      this.box(g, M.trough, 50, bedL - 40, 30, cx + s * (bedW / 2 - 55), bedY, zb - 10, false);   // channel
      this.box(g, M.dark, 24, bedL, 220, cx + s * (bedW / 2 - 12), bedY, zb + 110 - 40);           // splash guard rail
    }
    // telescopic way covers on the bed top between the riser and the column: stepped stainless
    const yc0 = cy + L * 0.43, n = 6;
    for (let k = 0; k < n; k++) {
      const h = 70 - k * 7, len = 80;
      this.box(g, M.steel, W * 0.6 - k * 8, len, h, cx, yc0 + 10 + k * (len - 10) + len / 2, zb + h / 2, false);
    }
    // the front: a low stainless splash plate and the chip conveyor's trough
    this.box(g, M.trough, bedW - 60, 40, 60, cx, cy - L / 2 - 120, zb + 10, false);
    // the enclosure's back: panels with a blue stripe and a lamp
    const yb = cy + L / 2 + 760;
    for (let k = -2; k <= 2; k++) this.box(g, M.panel, 396, 12, 1500, cx + k * 400, yb, zb + 650, false);
    this.box(g, M.accent, 2000, 14, 40, cx, yb - 8, zb + 360, false);
    const lamp = new T.Mesh(new T.PlaneGeometry(600, 120), new T.MeshBasicMaterial({ color: lin(0xf4f8ff) }));
    lamp.position.set(cx - 300, yb - 10, zb + 1200); lamp.rotation.x = Math.PI / 2; g.add(lamp);
  }

  // column and head, in the frame of the spindle axis (x = y = 0 at the axis): the column body
  // stands on the bed (its group is lifted in update), the head's nose face is at its z = 0
  buildColumn() {
    const T = THREE, M = this.mat;
    this.dispose(this.column);
    this.colBody = new T.Group();
    this.head = new T.Group();
    this.column.add(this.colBody, this.head);
    // column behind the axis: front face 300 mm behind it, ribs on the sides
    const cw = 460, cd = 420, chH = this.colH = 1300, yf = 300;
    this.box(this.colBody, M.casting, cw, cd, chH, 0, yf + cd / 2, chH / 2);
    for (const s of [-1, 1]) for (let k = 0; k < 4; k++) this.box(this.colBody, M.casting, 18, cd * 0.8, 40, s * (cw / 2 + 9), yf + cd / 2, 150 + k * 300);
    this.box(this.colBody, M.dark, cw * 0.55, 30, chH, 0, yf - 2, chH / 2); // the Z guideway cover on its face
    // head: a box on the column's face, the spindle cartridge below it, the nose at z = 0
    const hw = 320, hh = 460;
    // (the head reaches from the column's face forward past the spindle axis)
    const hy0 = -170, hy1 = yf + 10;
    this.box(this.head, M.casting, hw, hy1 - hy0, hh, 0, (hy0 + hy1) / 2, 140 + hh / 2);
    this.box(this.head, M.dark, hw + 4, 8, 120, 0, hy0 - 3, 140 + hh - 80); // a dark band (motor cover)
    const lathe = (pts, mat) => {
      const g = new T.LatheGeometry(pts.map(([r, z]) => new T.Vector2(r, z)), 96); g.rotateX(Math.PI / 2);
      const m = new T.Mesh(g, mat); m.castShadow = true; this.head.add(m); return m;
    };
    // cartridge (Ø180) and the nose ring (Ø150) with its face at z = 0, drive keys
    const nose = M.nose.clone();
    lathe([[0.1, 0], [75, 0], [75, 18], [80, 22], [90, 22], [90, 140], [0.1, 140]], nose);
    for (const s of [-1, 1]) this.box(this.head, nose, 16, 25, 10, s * 40, 0, 5);
    // the head's own materials, so that it can fade without the rest
    this.headMats = [];
    this.head.traverse(o => { if (o.isMesh && !this.headMats.includes(o.material)) this.headMats.push(o.material); });
  }

  // the spindle axis at (x, y), its nose at z; fade: 0 opaque … 1 nearly invisible
  update(x, y, zNose, fade = this.fade || 0) {
    this.fade = fade;
    this.column.position.set(x, y, 0);
    this.colBody.position.z = this.zt ?? -100;   // on the bed
    this.head.position.z = zNose;
  }

  // Fade whatever stands between the camera and the point it looks at (the column seen from
  // behind, the enclosure's back panels, the bed from below), and the head by `fade`: the cut
  // stays in view from any side.
  occlude(cam, target) {
    const T = THREE;
    this._ray = this._ray || new T.Ray(); this._box = this._box || new T.Box3(); this._hit = this._hit || new T.Vector3();
    const dir = cam.clone().sub(target), len = dir.length();
    this._ray.set(target, dir.normalize());
    const headOp = 1 - 0.85 * (this.fade || 0);
    for (const g of [this.fixed, this.column]) g.traverse(o => {
      if (!o.isMesh) return;
      this._box.setFromObject(o);
      const p = this._ray.intersectBox(this._box, this._hit);
      let op = p && p.distanceTo(target) < len ? 0.15 : 1;
      if (this.headMats.includes(o.material)) op = Math.min(op, headOp);
      const m = o.material;
      if (m.opacity !== op) { m.transparent = op < 0.999; m.opacity = op; m.depthWrite = op > 0.5; }
    });
  }
}
