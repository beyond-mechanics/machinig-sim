// Three.js rendering (global THREE, r128). Z is up, units mm.
import { MAX_CHIPS, nozzlePose, freeJet, COOLANTS } from './chips.js';

export class View {
  constructor(canvas) {
    const T = THREE;
    this.canvas = canvas;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    // colours are authored in sRGB and lit in linear space; filmic tone mapping keeps the
    // bright studio highlights on polished metal from clipping
    this.renderer.outputEncoding = T.sRGBEncoding;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(38, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.orbit = { target: new T.Vector3(60, 40, -10), dist: 230, az: -0.95, el: 0.72 };
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.scene.environment = buildEnvironment(this.renderer);
    this.scene.add(new T.HemisphereLight(lin(0xdfe8f2), lin(0x3a3f47), 0.5));
    // key light casts shadows (tool on the stock, walls into pockets); its frustum follows the stock
    const sun = new T.DirectionalLight(0xffffff, 0.8); sun.position.set(-80, -120, 200);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.3;
    this.scene.add(sun, sun.target); this.sun = sun;
    const rim = new T.DirectionalLight(lin(0xffe2b0), 0.35); rim.position.set(150, 120, 80); this.scene.add(rim);
    this.colorMode = 'material';
    // deviation colouring: full colour at ±devScale [mm], neutral within ±devTol
    this.devScale = 0.05; this.devTol = 0.002;
    this.exag = 100;
    this.showChips = true; this.showPath = true;
    this.buildTool();
    this.buildChips();
    this.buildNozzle();
    this.buildSpray();
    this.buildPool();
    this.buildSparks();
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
    g.setAttribute('mark', new T.BufferAttribute(new Float32Array(n * 2), 2).setUsage(T.DynamicDrawUsage));
    g.setAttribute('rough', new T.BufferAttribute(new Float32Array(n), 1).setUsage(T.DynamicDrawUsage));
    g.setIndex(new T.BufferAttribute(idx, 1).setUsage(T.DynamicDrawUsage));
    this.topGeo = g;
    this.top = new T.Mesh(g, stockMaterial());
    this.top.castShadow = this.top.receiveShadow = true;
    // side walls follow the edge heights
    const per = 2 * (nx + ny);
    const wg = new T.BufferGeometry();
    wg.setAttribute('position', new T.BufferAttribute(new Float32Array(per * 2 * 3), 3).setUsage(T.DynamicDrawUsage));
    const wi = [];
    for (let s = 0; s < per - 1; s++) { const a = s * 2, b = a + 1, c = a + 2, d = a + 3; wi.push(a, c, b, b, c, d); }
    wg.setIndex(wi);
    this.wallGeo = wg;
    const base = new T.Color(...(mat.surf || mat.chip)).multiplyScalar(0.8).convertSRGBToLinear();
    this.walls = new T.Mesh(wg, new T.MeshStandardMaterial({ color: base, metalness: 0.45, roughness: 0.62, side: T.DoubleSide }));
    this.walls.castShadow = this.walls.receiveShadow = true;
    // machine table under the stock
    const table = new T.Mesh(new T.PlaneGeometry(stock.w + 160, stock.l + 160), new T.MeshStandardMaterial({ color: lin(0x5a636e), metalness: 0.4, roughness: 0.7 }));
    table.position.set(stock.w / 2, stock.l / 2, stock.zBottom - 0.05);
    table.receiveShadow = true;
    // fit the shadow frustum to the stock plus the tool above it
    const sc = this.sun.shadow.camera, half = Math.hypot(stock.w, stock.l) / 2 + 40;
    sc.left = sc.bottom = -half; sc.right = sc.top = half; sc.near = 1; sc.far = 800; sc.updateProjectionMatrix();
    this.sun.target.position.set(stock.w / 2, stock.l / 2, stock.zBottom / 2);
    this.sun.position.set(stock.w / 2 - 120, stock.l / 2 - 180, 300);
    const grid = new T.GridHelper(Math.max(stock.w, stock.l) + 160, 24, lin(0x7c8794), lin(0x6a737e));
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
    // ambient occlusion looks up to AO_REACH cells away, so a cut changes the shading around it
    i0 = Math.max(0, i0 - AO_REACH); j0 = Math.max(0, j0 - AO_REACH); i1 = Math.min(nx - 1, i1 + AO_REACH); j1 = Math.min(ny - 1, j1 + AO_REACH);
    const pos = this.topGeo.attributes.position, nor = this.topGeo.attributes.normal, col = this.topGeo.attributes.color;
    const P = pos.array, N = nor.array, C = col.array;
    const mk = this.topGeo.attributes.mark, rg = this.topGeo.attributes.rough, M = mk.array, RG = rg.array;
    const base = this.mat.surf || this.mat.chip, depth = s.zTop - s.zBottom;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i, z = H[k];
      P[k * 3 + 2] = z;
      // a wall foot sits where the cutter edge actually passed, not on the grid point
      if (!this.bentSet?.has(k)) { const f = wallFoot(s, i, j); P[k * 3] = f[0]; P[k * 3 + 1] = f[1]; }
      // Sobel gradient: smooths the one-cell staircase of a wall that runs off the grid lines
      const im = Math.max(0, i - 1), ip = Math.min(nx - 1, i + 1), jm = Math.max(0, j - 1) * nx, jp = Math.min(ny - 1, j + 1) * nx, jc = j * nx;
      let gx = ((H[jm + im] + 2 * H[jc + im] + H[jp + im]) - (H[jm + ip] + 2 * H[jc + ip] + H[jp + ip])) / (8 * s.hx);
      let gy = ((H[jm + im] + 2 * H[jm + i] + H[jm + ip]) - (H[jp + im] + 2 * H[jp + i] + H[jp + ip])) / (8 * s.hy);
      const L = Math.hypot(gx, gy, 1);
      N[k * 3] = gx / L; N[k * 3 + 1] = gy / L; N[k * 3 + 2] = 1 / L;
      let r, g, b;
      const cut = z < s.zTop - 0.005;
      if (this.colorMode === 'vibration' && cut) [r, g, b] = ramp(Math.min(1, s.err[k] / 40));
      else if (this.colorMode === 'wall') [r, g, b] = s.wallErr[k] > 0.5 ? ramp(Math.min(1, s.wallErr[k] / 50)) : [base[0] * 0.6, base[1] * 0.6, base[2] * 0.62];
      else if (this.colorMode === 'depth') [r, g, b] = ramp(Math.min(1, (s.zTop - z) / depth));
      else if ((this.colorMode === 'devIdeal' || this.colorMode === 'devTarget') && s.devIdeal) [r, g, b] = diverge((this.colorMode === 'devIdeal' ? s.devIdeal : s.devTarget)[k], this.devTol, this.devScale);
      else if (cut) { r = base[0] * 0.98; g = base[1] * 0.98; b = base[2] * 1.0; }
      else { r = base[0] * 0.78; g = base[1] * 0.78; b = base[2] * 0.8; }
      // cavity shading: full in the material view, a light touch under the data colours
      const ao = occlusion(s, i, j), aoK = this.colorMode === 'material' ? ao : 0.8 + 0.2 * ao;
      C[k * 3] = toLin(r) * aoK; C[k * 3 + 1] = toLin(g) * aoK; C[k * 3 + 2] = toLin(b) * aoK;
      // machined faces are bright and fairly smooth; chatter leaves a dull, rough band;
      // raw stock keeps its matte rolled surface
      const vib = Math.min(1, s.err[k] / 30);
      RG[k] = cut ? 0.26 + 0.42 * vib : 0.62;
      M[k * 2] = s.markS[k]; M[k * 2 + 1] = this.colorMode === 'material' && cut ? s.markF[k] : 0;
    }
    // Split each grid square along the diagonal that joins the two corners closest in height:
    // a curved or diagonal wall then keeps its rim vertices joined to each other (and its feet
    // to each other) instead of zig-zagging across the step. Winding stays counter-clockwise.
    const I = this.topGeo.index.array, qi0 = Math.max(0, i0 - 1), qj0 = Math.max(0, j0 - 1), qi1 = Math.min(nx - 2, i1), qj1 = Math.min(ny - 2, j1);
    for (let j = qj0; j <= qj1; j++) for (let i = qi0; i <= qi1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1, q = (j * (nx - 1) + i) * 6;
      if (Math.abs(H[a] - H[d]) <= Math.abs(H[b] - H[c])) { I[q] = a; I[q + 1] = b; I[q + 2] = d; I[q + 3] = a; I[q + 4] = d; I[q + 5] = c; }
      else { I[q] = a; I[q + 1] = b; I[q + 2] = c; I[q + 3] = b; I[q + 4] = d; I[q + 5] = c; }
    }
    const ix = this.topGeo.index;
    ix.updateRange.offset = all ? 0 : qj0 * (nx - 1) * 6; ix.updateRange.count = all ? -1 : (qj1 - qj0 + 1) * (nx - 1) * 6; ix.needsUpdate = true;
    // restoring/applying the wall bend touches rows outside the dirty rectangle
    if (this.deformRows) { j0 = Math.min(j0, this.deformRows[0]); j1 = Math.max(j1, this.deformRows[1]); this.deformRows = null; }
    const off = j0 * nx * 3, cnt = (j1 - j0 + 1) * nx * 3;
    for (const a of [pos, nor, col]) { a.updateRange.offset = all ? 0 : off; a.updateRange.count = all ? -1 : cnt; a.needsUpdate = true; }
    mk.updateRange.offset = all ? 0 : off / 3 * 2; mk.updateRange.count = all ? -1 : cnt / 3 * 2; mk.needsUpdate = true;
    rg.updateRange.offset = all ? 0 : off / 3; rg.updateRange.count = all ? -1 : cnt / 3; rg.needsUpdate = true;
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

  // Bend the thin wall in the mesh (exaggerated). wall: {cx,cy,nx,ny,t,a,hWall,bEff,base} or null,
  // delta: wall deflection at the load height [mm], already exaggerated.
  updateWallDeform(wall, delta) {
    const s = this.stock, P = this.topGeo.attributes.position.array, { nx, H } = s;
    let jMin = Infinity, jMax = -1;
    // restore last frame's bent vertices to the grid
    if (this.bent) {
      for (const k of this.bent) { const i = k % nx, j = (k - i) / nx; const f = wallFoot(s, i, j); P[k * 3] = f[0]; P[k * 3 + 1] = f[1]; jMin = Math.min(jMin, j); jMax = Math.max(jMax, j); }
      this.bent = null; this.bentSet = null;
    }
    if (wall && Math.abs(delta) > 0.01) {
      this.bent = []; this.bentSet = new Set();
      const half = Math.min(wall.bEff, 60) * 0.75, reach = half + wall.t + 2;
      const tx = -wall.ny, ty = wall.nx, a = Math.max(wall.a, 0.5);
      const i0 = Math.max(0, Math.floor((wall.cx - reach) / s.hx)), i1 = Math.min(nx - 1, Math.ceil((wall.cx + reach) / s.hx));
      const j0 = Math.max(0, Math.floor((wall.cy - reach) / s.hy)), j1 = Math.min(s.ny - 1, Math.ceil((wall.cy + reach) / s.hy));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * nx + i, z = H[k] - wall.base;
        if (z <= 0) continue;
        const dx = i * s.hx - wall.cx, dy = j * s.hy - wall.cy;
        const along = dx * wall.nx + dy * wall.ny, side = dx * tx + dy * ty;
        if (along < -0.5 || along > wall.t + 0.5 || Math.abs(side) > half) continue;
        // cantilever shape: z²(3a−z)/2a³ up to the load, straight above it
        const f = z <= a ? z * z * (3 * a - z) / (2 * a ** 3) : 1 + 1.5 * (z - a) / a;
        const fall = Math.cos(Math.PI / 2 * side / half) ** 2;
        const d = delta * f * fall;
        P[k * 3] += wall.nx * d; P[k * 3 + 1] += wall.ny * d;
        this.bent.push(k); this.bentSet.add(k);
        jMin = Math.min(jMin, j); jMax = Math.max(jMax, j);
      }
    }
    if (jMax >= 0) {
      this.deformRows = [jMin, jMax];
      const d = s.dirty; d.i0 = 0; d.i1 = nx - 1; d.j0 = Math.min(d.j0, jMin); d.j1 = Math.max(d.j1, jMax);
    }
  }

  // ---------- tool ----------
  buildTool() {
    const T = THREE;
    this.pivot = new T.Group();   // at the holder face; tilting it shows deflection
    this.spin = new T.Group();
    this.pivot.add(this.spin);
    this.scene.add(this.pivot);
    // ground carbide: polished land and rake face, duller flute gullet (vertex shade)
    this.fluteMat = new T.MeshStandardMaterial({ color: lin(0xc4cad2), vertexColors: true, metalness: 0.9, roughness: 0.24, transparent: true });
    this.shankMat = new T.MeshStandardMaterial({ color: lin(0xaeb5bd), metalness: 0.85, roughness: 0.35 });
    this.holderMat = new T.MeshStandardMaterial({ color: lin(0x2f3338), metalness: 0.7, roughness: 0.35 });
  }

  setTool(t) {
    const T = THREE;
    this.toolCfg = t;
    for (const c of [...this.spin.children]) { this.spin.remove(c); c.geometry.dispose(); }
    if (this.blurGroup) { this.pivot.remove(this.blurGroup); this.blurGroup.traverse(o => o.geometry && o.geometry.dispose()); }
    const R = t.D / 2, N = t.N, fl = t.fluteLen;
    const g = fluteGeometry(t);
    const flute = new T.Mesh(g, this.fluteMat);
    this.holderMat.color.copy(lin(0x2f3338)); this.holderMat.emissive.set(0x000000);
    const bands = t.outline || [];
    if (t.stlMesh) {
      // imported cutter: the mesh itself (it spins, so its flutes show)
      this.spin.add(new T.Mesh(meshGeometry(t.stlMesh, 0), this.fluteMat));
    } else {
      this.spin.add(flute);
      // neck and shank from the outline (or a plain shank up to the stickout)
      const body = bands.filter(b => b.part === 'shank');
      if (!body.length) body.push({ z0: fl, z1: Math.max(fl + 1, t.stickout), r: R });
      for (const b of body) {
        const sg = new T.CylinderGeometry(b.r, b.r, b.z1 - b.z0, 48); sg.rotateX(Math.PI / 2); sg.translate(0, 0, (b.z0 + b.z1) / 2);
        this.spin.add(new T.Mesh(sg, this.shankMat));
      }
    }
    if (t.stlHolderMesh) this.spin.add(new T.Mesh(meshGeometry(t.stlHolderMesh, t.stickout), this.holderMat));
    else if (bands.some(b => b.part === 'holder')) {
      // holder as a lathe profile through its segments (tapers included)
      const pts = [];
      for (const b of bands) if (b.part === 'holder') { pts.push(new T.Vector2(b.r0 ?? b.r, b.z0), new T.Vector2(b.r1 ?? b.r, b.z1)); }
      pts.unshift(new T.Vector2(Math.max(0.1, (t.shankD || t.D) / 2), pts[0].y));
      pts.push(new T.Vector2(0.1, pts[pts.length - 1].y));
      const lg = new T.LatheGeometry(pts, 64); lg.rotateX(Math.PI / 2);
      this.spin.add(new T.Mesh(lg, this.holderMat));
    } else {
      // no holder chosen: the original stylised collet nut + holder body above the stickout
      const hg1 = new T.CylinderGeometry(R * 1.9, R * 2.3, 14, 40); hg1.rotateX(Math.PI / 2); hg1.translate(0, 0, t.stickout + 7);
      const hg2 = new T.CylinderGeometry(R * 3.4, R * 2.4, 22, 40); hg2.rotateX(Math.PI / 2); hg2.translate(0, 0, t.stickout + 25);
      const hg3 = new T.CylinderGeometry(R * 4.4, R * 4.4, 30, 40); hg3.rotateX(Math.PI / 2); hg3.translate(0, 0, t.stickout + 51);
      this.spin.add(new T.Mesh(hg1, this.holderMat), new T.Mesh(hg2, this.holderMat), new T.Mesh(hg3, this.holderMat));
    }
    this.spin.traverse(o => { if (o.isMesh) o.castShadow = true; });
    // tool hangs from the pivot: children are offset by -stickout
    this.spin.position.set(0, 0, -t.stickout);
    // motion blur: what the eye integrates over a frame at speed. Nested translucent shells
    // whose opacity is the fraction of a revolution the flutes fill at that radius.
    this.blurGroup = new T.Group();
    this.blurShells = [];
    const occ = r => { let n = 0; for (let k = 0; k < 400; k++) if (fluteProfile(k / 400).r >= r) n++; return n / 400; };
    for (const rf of [1, 0.93, 0.85, 0.77, 0.69]) {
      const cg = new T.CylinderGeometry(R * rf, R * rf, fl, 48, 1, true); cg.rotateX(Math.PI / 2); cg.translate(0, 0, fl / 2 - t.stickout);
      const m = new T.Mesh(cg, new T.MeshStandardMaterial({ color: lin(0xb4bbc4), metalness: 0.8, roughness: 0.45, transparent: true, opacity: 0, depthWrite: false }));
      m.userData.occ = occ(rf - 0.04); m.renderOrder = 2;
      this.blurShells.push(m); this.blurGroup.add(m);
    }
    this.blurGroup.visible = false;
    this.pivot.add(this.blurGroup);
    this.flute = flute;
  }

  // red markers where the shank, holder or spindle touched the stock
  setHits(hits) {
    const T = THREE;
    if (!this.hitPts) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(200 * 3), 3).setUsage(T.DynamicDrawUsage));
      this.hitPts = new T.Points(g, new T.PointsMaterial({ color: lin(0xff3b30), size: 2.2, sizeAttenuation: true, depthTest: false, transparent: true, opacity: 0.9 }));
      this.hitPts.renderOrder = 5; this.hitPts.frustumCulled = false;
      this.scene.add(this.hitPts);
    }
    const n = Math.min(200, hits?.length || 0), P = this.hitPts.geometry.attributes.position;
    for (let i = 0; i < n; i++) P.setXYZ(i, hits[i].x, hits[i].y, hits[i].z + 0.3);
    this.hitPts.geometry.setDrawRange(0, n);
    P.needsUpdate = true;
  }

  // tool tip nominal position, deflection [mm] (already exaggerated), spin angle
  // blur: 0 (flutes visible) … 1 (spinning too fast for the eye: a translucent cylinder)
  updateTool(pos, dx, dy, angle, blur = 0, collide = null) {
    const L = this.toolCfg.stickout;
    // interference: the colliding part glows red for a moment
    if (collide) this.hitGlow = 1;
    this.hitGlow = Math.max(0, (this.hitGlow || 0) - 0.04);
    this.holderMat.emissive.setRGB(0.7 * this.hitGlow, 0, 0);
    this.shankMat.emissive.setRGB(0.5 * this.hitGlow, 0, 0);
    this.pivot.position.set(pos.x, pos.y, pos.z + L);
    const sx = Math.max(-0.9, Math.min(0.9, dy / L)), sy = Math.max(-0.9, Math.min(0.9, dx / L));
    this.pivot.rotation.set(Math.asin(sx), -Math.asin(sy), 0);
    this.spin.rotation.z = -angle; // clockwise seen from above
    this.blurGroup.visible = blur > 0.01;
    this.fluteMat.opacity = 1 - 0.8 * blur;
    this.fluteMat.depthWrite = blur < 0.5;
    for (const m of this.blurShells) m.material.opacity = blur * Math.min(0.85, m.userData.occ * 0.9);
  }

  // ---------- coolant nozzle ----------
  buildNozzle() {
    const T = THREE;
    this.nozzle = new T.Group();
    const body = new T.Mesh(new T.CylinderGeometry(1.4, 1.8, 18, 16), new T.MeshStandardMaterial({ color: lin(0x3b6f9e), metalness: 0.3, roughness: 0.5 }));
    body.rotation.x = Math.PI / 2;
    this.jet = new T.Mesh(new T.ConeGeometry(1, 1, 24, 1, true), new T.MeshBasicMaterial({ color: lin(0x8ec9ff), transparent: true, opacity: 0.18, depthWrite: false, side: T.DoubleSide }));
    this.nozzle.add(body);
    this.scene.add(this.nozzle, this.jet);
  }
  updateNozzle(coolant, tip, noz) {
    const T = THREE, c = COOLANTS[coolant];
    const on = !!c && c.jet === 'nozzle';
    this.nozzle.visible = on; this.jet.visible = on;
    if (!on) return;
    const n = nozzlePose(tip, noz);
    const from = new T.Vector3(n.x, n.y, n.z), dir = new T.Vector3(n.ex, n.ey, n.ez), L = n.L;
    this.nozzle.position.copy(from);
    this.nozzle.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), dir);
    // cone out to the tool: the air jet spreads as a turbulent jet, the liquid stream barely
    const w = c.liquid ? freeJet(L, c.U0, c.d0, true).b : freeJet(L, c.U0, c.d0).b;
    this.jet.scale.set(w, L, w);
    this.jet.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), dir);
    this.jet.position.copy(from).addScaledVector(dir, L / 2);
    this.jet.material.color.copy(lin(c.liquid ? 0x6fb7ff : 0xdcefff));
    this.jet.material.opacity = c.liquid ? 0.1 : 0.05; // the spray particles carry the look
  }

  // ---------- chips ----------
  buildChips() {
    const T = THREE;
    // three shape variants per material, each an instanced ribbon helix; chip i goes to
    // variant i % 3 so a pile shows the natural scatter of chip forms
    this.chipVariants = [];
    this.chipCap = Math.ceil(MAX_CHIPS / 3);
    this.chipMat = new T.MeshStandardMaterial({ metalness: 0.8, roughness: 0.32, side: T.DoubleSide });
    for (let v = 0; v < 3; v++) {
      const mesh = new T.InstancedMesh(new T.BufferGeometry(), this.chipMat, this.chipCap);
      mesh.castShadow = true;
      mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.setColorAt(0, new T.Color(1, 1, 1));
      this.scene.add(mesh); this.chipVariants.push(mesh);
    }
    this.chipStyle = '';
    this._m = new T.Matrix4(); this._q = new T.Quaternion(); this._e = new T.Euler(); this._s = new T.Vector3(); this._p = new T.Vector3(); this._c = new T.Color();
    this._zero = new T.Matrix4().makeScale(0, 0, 0);
  }
  setChipStyle(mat) {
    const key = mat.name;
    if (key === this.chipStyle) return;
    this.chipStyle = key;
    const [turns, pitch, rad] = mat.curl || [1.4, 0.3, 1];
    [0.7, 1, 1.35].forEach((k, v) => {
      const mesh = this.chipVariants[v];
      mesh.geometry.dispose();
      mesh.geometry = ribbonHelix(turns * k, pitch * (2 - k) * 0.8 + pitch * 0.2, rad * (1.15 - 0.15 * k));
    });
  }
  updateChips(cs, mat) {
    const vs = this.chipVariants;
    for (const m of vs) m.visible = this.showChips;
    if (!this.showChips) return;
    this.setChipStyle(mat);
    const base = mat.chip, cap = this.chipCap;
    for (let i = 0; i < MAX_CHIPS; i++) {
      const mesh = vs[i % 3], slot = (i / 3) | 0;
      if (slot >= cap) continue;
      if (!cs.state[i]) { mesh.setMatrixAt(slot, this._zero); continue; }
      const o = i * 3;
      this._p.set(cs.p[o], cs.p[o + 1], cs.p[o + 2]);
      this._e.set(cs.rot[o], cs.rot[o + 1], cs.rot[o] * 0.7);
      this._q.setFromEuler(this._e);
      const sz = cs.size[i];
      this._s.set(sz, sz, sz);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(slot, this._m);
      // hot steel chips show temper colours (straw → blue), aluminium stays silver
      const h = cs.heat[i];
      if (mat.hot && h > 0.05) this._c.setRGB(base[0] + h * 0.5, base[1] + h * 0.25, base[2] - h * 0.1);
      else this._c.setRGB(base[0], base[1], base[2]);
      this._c.convertSRGBToLinear();
      mesh.setColorAt(slot, this._c);
    }
    for (const m of vs) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }

  // ---------- coolant spray ----------
  // Purely visual droplets (flood) or oil mist (air blast) from the nozzle along the jet,
  // falling under gravity and splashing on the stock or the table.
  buildSpray() {
    const T = THREE, n = 3000;
    this.spray = { n, p: new Float32Array(n * 3), v: new Float32Array(n * 3), life: new Float32Array(n), next: 0, acc: 0 };
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(this.spray.p, 3).setUsage(T.DynamicDrawUsage));
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 32, 32);
    this.sprayPts = new T.Points(g, new T.PointsMaterial({ size: 0.7, map: new T.CanvasTexture(c), transparent: true, depthWrite: false, color: lin(0x7fc4ff), opacity: 0.6 }));
    this.sprayPts.frustumCulled = false;
    this.scene.add(this.sprayPts);
    this.sprayT = performance.now();
  }
  updateSpray(coolant, tip, active, R = 5) {
    const now = performance.now(), dt = Math.min(0.05, (now - this.sprayT) / 1000); this.sprayT = now;
    const S = this.spray, P = S.p, V = S.v, L = S.life, c = COOLANTS[coolant], liquid = !!c?.liquid;
    const through = c?.jet === 'tool';
    const on = active && !!c && (through || this.nozzle.visible);
    this.sprayPts.visible = on || L.some(l => l > 0);
    if (!this.sprayPts.visible) return;
    const m = this.sprayPts.material;
    m.size = liquid ? 1.4 : 0.6; m.color.copy(lin(liquid ? 0x7fc4ff : 0xf2f6fa)); m.opacity = liquid ? 0.6 : 0.3;
    if (on) {
      S.acc += dt * (liquid ? 1800 : 900);
      const from = this.nozzle.position, dx = tip.x - from.x, dy = tip.y - from.y, dz = tip.z - from.z;
      const len = Math.hypot(dx, dy, dz), sp = liquid ? 900 : 1600, spread = liquid ? 0.12 : 0.22;
      while (S.acc >= 1) {
        S.acc -= 1;
        const i = S.next, o = i * 3; S.next = (S.next + 1) % S.n;
        if (through) {
          // through-tool: leaves from under the cutter end as a radial sheet that splashes up
          const a = Math.random() * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a), u = 1500 + Math.random() * 1500;
          P[o] = tip.x + ca * R; P[o + 1] = tip.y + sa * R; P[o + 2] = tip.z + 0.3;
          V[o] = ca * u; V[o + 1] = sa * u; V[o + 2] = 300 + Math.random() * 900;
          L[i] = 0.5;
        } else {
          P[o] = from.x; P[o + 1] = from.y; P[o + 2] = from.z;
          V[o] = (dx / len + (Math.random() - 0.5) * spread) * sp;
          V[o + 1] = (dy / len + (Math.random() - 0.5) * spread) * sp;
          V[o + 2] = (dz / len + (Math.random() - 0.5) * spread) * sp;
          L[i] = liquid ? 0.9 : 0.35;
        }
      }
    }
    const drag = liquid ? 0.4 : 6; // mist slows quickly in air
    for (let i = 0; i < S.n; i++) {
      if (L[i] <= 0) { P[i * 3 + 2] = -1e5; continue; }
      L[i] -= dt;
      const o = i * 3;
      V[o] -= V[o] * drag * dt; V[o + 1] -= V[o + 1] * drag * dt; V[o + 2] -= (9810 + V[o + 2] * drag) * dt;
      const ox = P[o], oy = P[o + 1];
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      const fz = this.stock ? this.stock.floor(P[o], P[o + 1]) : 0;
      if (P[o + 2] < fz) {
        if (this.stock && fz > this.stock.floor(ox, oy) + 0.5) {
          // hit a wall: bounce back and run up it
          P[o] = ox; P[o + 1] = oy; V[o] *= -0.3; V[o + 1] *= -0.3; V[o + 2] = Math.abs(V[o + 2]) * 0.3 + 400;
          continue;
        }
        // splash: lose most of the speed, scatter sideways, die soon after
        P[o + 2] = fz + 0.05; V[o + 2] = Math.abs(V[o + 2]) * 0.15;
        V[o] = V[o] * 0.3 + (Math.random() - 0.5) * 150; V[o + 1] = V[o + 1] * 0.3 + (Math.random() - 0.5) * 150;
        L[i] = Math.min(L[i], 0.12);
      }
    }
    this.sprayPts.geometry.attributes.position.needsUpdate = true;
  }

  // ---------- sparks ----------
  // Glowing chip fragments thrown off the engaged part of the cutter along the cutting
  // velocity, when the chip is hot enough to glow (the thermal model's chip temperature).
  // Drawn as short additive streaks coloured by temperature; they cool and fall as they fly.
  buildSparks() {
    const T = THREE, n = 1500;
    this.sparks = { n, p: new Float32Array(n * 3), v: new Float32Array(n * 3), T: new Float32Array(n), life: new Float32Array(n), next: 0, acc: 0 };
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 6), 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 6), 3).setUsage(T.DynamicDrawUsage));
    this.sparkLines = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.sparkLines.frustumCulled = false;
    this.scene.add(this.sparkLines);
    this.sparkT = performance.now();
  }
  // c: {active, pos, R, ap, ux, uy, phiSt, phiEx, tempChip [°C], mrr [cm³/min], burns, quench}
  updateSparks(c) {
    const now = performance.now(), dt = Math.min(0.05, (now - this.sparkT) / 1000); this.sparkT = now;
    const S = this.sparks, P = S.p, V = S.v, L = S.life, TT = S.T;
    // titanium chips burn in air: white sparks well below the chip's own temperature
    const Teff = c.tempChip + (c.burns ? 450 : 0);
    const rate = c.active ? 12 * Math.max(0.3, c.mrr) * clamp((Teff - 450) / 350, 0, 1.6) * (c.quench ? 0.15 : 1) : 0;
    S.acc = Math.min(S.acc + rate * dt, 200);
    const vx = -c.uy, vy = c.ux;
    while (S.acc >= 1) {
      S.acc -= 1;
      const i = S.next, o = i * 3; S.next = (S.next + 1) % S.n;
      // a point of the engaged arc where the chip leaves the cut: the top of the cut, just
      // outside the cutter (inside the cut it would still be in the material)
      const phi = c.phiSt + Math.random() * Math.max(0.05, c.phiEx - c.phiSt), sn = Math.sin(phi), cs = Math.cos(phi);
      const nx = sn * c.ux + cs * vx, ny = sn * c.uy + cs * vy, tx = cs * c.ux - sn * vx, ty = cs * c.uy - sn * vy;
      const rr = c.R + 0.3 + Math.random() * 0.5;
      P[o] = c.pos.x + nx * rr; P[o + 1] = c.pos.y + ny * rr;
      P[o + 2] = Math.max(c.pos.z + Math.max(0.2, c.ap), this.stock ? this.stock.floor(P[o], P[o + 1]) : -Infinity) + 0.2;
      // along the cutting velocity, fanned out and lifted by the helix (shown slowed down)
      const sp = 700 + Math.random() * 900, fan = (Math.random() - 0.5) * 0.9;
      V[o] = (tx + nx * (0.25 + fan)) * sp; V[o + 1] = (ty + ny * (0.25 + fan)) * sp; V[o + 2] = (0.25 + Math.random() * 0.5) * sp;
      TT[i] = Teff * (0.9 + Math.random() * 0.2);
      L[i] = 0.15 + Math.random() * 0.35;
    }
    const pos = this.sparkLines.geometry.attributes.position.array, col = this.sparkLines.geometry.attributes.color.array;
    let any = false;
    for (let i = 0; i < S.n; i++) {
      const o = i * 3, q = i * 6;
      if (L[i] <= 0) { pos[q + 2] = pos[q + 5] = -1e5; continue; }
      any = true;
      L[i] -= dt; TT[i] -= 900 * dt; // radiates and cools in flight
      V[o] *= 1 - 1.5 * dt; V[o + 1] *= 1 - 1.5 * dt; V[o + 2] = V[o + 2] * (1 - 1.5 * dt) - 9810 * dt;
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      if (this.stock && P[o + 2] < this.stock.floor(P[o], P[o + 1])) { L[i] = 0; continue; }
      // head and a tail one exposure behind it: the streak a camera would see
      const k = 0.01;
      pos[q] = P[o]; pos[q + 1] = P[o + 1]; pos[q + 2] = P[o + 2];
      pos[q + 3] = P[o] - V[o] * k; pos[q + 4] = P[o + 1] - V[o + 1] * k; pos[q + 5] = P[o + 2] - V[o + 2] * k;
      const [r, g, b] = glow(TT[i]);
      col[q] = r; col[q + 1] = g; col[q + 2] = b; col[q + 3] = r * 0.25; col[q + 4] = g * 0.2; col[q + 5] = b * 0.15;
    }
    this.sparkLines.visible = any;
    this.sparkLines.geometry.attributes.position.needsUpdate = true;
    this.sparkLines.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- coolant pool ----------
  // Free surface of the shallow coolant layer (chips.js Pool): one vertex per coarse cell. Dry
  // cells sink below the stock surface, so the water edge is a shoreline cut by the depth test.
  buildPool() {
    const T = THREE;
    this.poolMat = new T.MeshStandardMaterial({ color: lin(0x5aa2dc), transparent: true, opacity: 0.2, roughness: 0.12, metalness: 0.0, depthWrite: false });
    this.poolMesh = null; this.poolKey = '';
  }
  updatePool(pool) {
    const T = THREE;
    if (!pool || !pool.depth) { if (this.poolMesh) this.poolMesh.visible = false; return; }
    const { nx, ny, cx, cy, bed, depth } = pool, key = `${nx}x${ny}x${cx}x${cy}`;
    if (key !== this.poolKey) {
      if (this.poolMesh) { this.scene.remove(this.poolMesh); this.poolMesh.geometry.dispose(); }
      const g = new T.BufferGeometry(), pos = new Float32Array(nx * ny * 3), idx = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = (j * nx + i) * 3; pos[k] = (i + 0.5) * cx; pos[k + 1] = (j + 0.5) * cy; }
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, b, d, a, d, c); }
      g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
      g.setIndex(idx);
      this.poolMesh = new T.Mesh(g, this.poolMat);
      this.poolMesh.renderOrder = 2;
      this.scene.add(this.poolMesh);
      this.poolKey = key;
    }
    const P = this.poolMesh.geometry.attributes.position.array;
    let wet = false;
    for (let k = 0; k < nx * ny; k++) {
      const d = depth[k];
      if (d > 0.15) { P[k * 3 + 2] = bed[k] + d; wet = true; } else P[k * 3 + 2] = bed[k] - 3;
    }
    this.poolMesh.visible = wet;
    if (!wet) return;
    this.poolMesh.geometry.attributes.position.needsUpdate = true;
    this.poolMesh.geometry.computeVertexNormals();
  }

  // ---------- tool path ----------
  setPath(path) {
    const T = THREE;
    if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); }
    const pos = [], col = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const c = (b.rapid ? [0.85, 0.35, 0.3] : [0.25, 0.6, 0.95]).map(toLin);
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

// Colour of incandescent metal [°C] (rough blackbody, linear RGB scaled for additive streaks):
// invisible below ~420 °C, red at 600, orange at 850, yellow-white above 1200.
function glow(T) {
  const t = clamp((T - 420) / 800, 0, 1.4);
  return [clamp(t * 3, 0, 2), clamp((t - 0.3) * 1.8, 0, 1.4), clamp((t - 0.8) * 1.8, 0, 1)];
}

// Position of a grid vertex for drawing. stock.wallD of a standing cell says how far from its
// centre the cutter edge really passed (below the grid spacing). Drawn on grid points, a wall
// would slope across a whole cell and a diagonal or curved wall would show the grid's
// staircase on its rim and its foot. So both are moved onto the cut surface: the rim vertex
// (standing, with lower neighbours) by its own distance towards them, the foot vertex (cut,
// with standing neighbours) to where each neighbour's distance puts the surface. The wall
// then stands upright at its true place and follows the cutter's path smoothly.
// all 8 neighbours: on a curved wall many feet touch the wall only across a corner
const FOOT = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const _foot = [0, 0];
function wallFoot(s, i, j) {
  const { nx, ny, H, hx, hy } = s, k = j * nx + i, z = H[k], x = i * hx, y = j * hy;
  _foot[0] = x; _foot[1] = y;
  if (!s.wallD) return _foot;
  const own = s.wallD[k];
  let rx = 0, ry = 0, nr = 0, sx = 0, sy = 0, nf = 0;
  for (const [di, dj] of FOOT) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
    const q = jj * nx + ii, dz = H[q] - z, ex = di * hx, ey = dj * hy, step = Math.hypot(ex, ey);
    if (dz <= -0.2) { rx += ex / step; ry += ey / step; nr++; }   // lower neighbour: this is a rim
    else if (dz >= 0.2 && s.wallD[q] < step) {                    // standing neighbour: this is a foot
      const f = Math.max(0.02 * step, s.wallD[q]) / step;
      sx += ii * hx - ex * f; sy += jj * hy - ey * f; nf++;
    }
  }
  if (nr && own < 1.5 * Math.min(hx, hy)) { // a diagonal neighbour of the cut is up to √2 cells away
    const L = Math.hypot(rx, ry);
    if (L > 0) { _foot[0] = x + rx / L * own; _foot[1] = y + ry / L * own; }
  } else if (nf) { _foot[0] = sx / nf; _foot[1] = sy / nf; }
  return _foot;
}

// Ambient occlusion from the heightfield (horizon based): in 8 directions, the steepest rise
// of the surrounding material seen from this vertex within AO_REACH cells; the sine of that
// horizon angle, averaged, is the share of sky the walls hide. Floors darken towards walls
// and into corners, the foot of a wall most.
const AO_STEPS = [1, 2, 4, 8, 16], AO_REACH = 16;
const AO_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].map(([a, b]) => { const l = Math.hypot(a, b); return [a / l, b / l]; });
function occlusion(s, i, j) {
  const { nx, ny, H, hx } = s, z = H[j * nx + i];
  let occ = 0;
  for (const [dx, dy] of AO_DIRS) {
    let m = 0;
    for (const st of AO_STEPS) {
      const ii = Math.round(i + dx * st), jj = Math.round(j + dy * st);
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) break;
      const t = (H[jj * nx + ii] - z) / (st * hx);
      if (t > m) m = t;
    }
    occ += m / Math.sqrt(1 + m * m);
  }
  return 1 - 0.95 * occ / AO_DIRS.length;
}
// sRGB-authored colour → linear (the renderer outputs sRGB)
const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
const toLin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

// Image-based lighting for the metals: a machine-shop studio, prefiltered once into a PMREM
// environment map. Grey enclosure walls and a dark floor, with HDR softboxes (well above 1)
// overhead and at the sides: polished carbide and machined faces show crisp highlights and
// the dark reflections that make metal read as metal.
function buildEnvironment(renderer) {
  const T = THREE, env = new T.Scene();
  const g = new T.SphereGeometry(100, 48, 24), col = [];
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getZ(i) / 100; // z up
    // floor 0.02 → horizon 0.22 → ceiling 0.35 (linear)
    const c = t < 0 ? 0.02 + 0.2 * Math.pow(1 + t, 3) : 0.22 + 0.13 * t;
    col.push(c, c * 1.03, c * 1.08);
  }
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  env.add(new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
  const box = (x, y, z, sx, sy, k, warm = false) => {
    const m = new T.Mesh(new T.PlaneGeometry(sx, sy), new T.MeshBasicMaterial({ color: new T.Color(warm ? 1 : 0.94, warm ? 0.93 : 0.97, warm ? 0.84 : 1).multiplyScalar(k), side: T.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
  };
  box(-20, -30, 90, 70, 30, 7, true);  // overhead key
  box(35, 25, 85, 30, 60, 4);          // overhead fill
  box(-95, 10, 25, 12, 70, 3);         // side strips: long edge highlights on the tool
  box(90, -30, 30, 12, 60, 2.2);
  box(10, 95, 20, 60, 10, 1.4);        // back
  const pm = new T.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.015).texture;
  pm.dispose();
  return tex;
}

// Stock top surface: per-vertex roughness (dull where chatter hit) and the feed marks the
// trailing edge leaves on flat floors, drawn procedurally at their true spacing and faded
// out where they are finer than a pixel (zoom in to see them).
function stockMaterial() {
  const T = THREE;
  const m = new T.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.5, envMapIntensity: 0.7 });
  m.extensions = { derivatives: true };
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 mark; attribute float rough; varying vec2 vMark; varying float vRough; varying float vUp; varying vec3 vWPos; varying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = mark; vRough = rough; vUp = normal.z; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vMark; varying float vRough; varying float vUp; varying vec3 vWPos; varying vec3 vWN;
        float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = vRough;
        bool raw = vRough > 0.6;
        if (raw) {
          // uncut stock: rolled / ground plate, fine streaks along X and a mottled sheen
          float streak = vnoise(vec2(vWPos.x * 0.6, vWPos.y * 40.0));
          float mott = vnoise(vWPos.xy * 0.35);
          diffuseColor.rgb *= 0.9 + 0.12 * streak + 0.06 * mott;
          roughnessFactor += 0.12 * (streak - 0.5);
        }
        float markAmp = 0.0, markPh = 0.0;
        if (vMark.y > 0.0) {
          markPh = vMark.x / vMark.y;
          float fw = fwidth(markPh);
          // only where an arc spans several pixels: finer marks alias into moire
          markAmp = smoothstep(0.35, 0.12, fw) * smoothstep(0.92, 0.99, vUp);
          // sharp crest of each arc, as left by the trailing edge
          float crest = pow(abs(cos(3.14159265 * markPh)), 6.0);
          diffuseColor.rgb *= 1.0 - 0.22 * markAmp * crest;
          roughnessFactor += 0.18 * markAmp * crest;
        }
        if (!raw && vUp < 0.55) {
          // machined wall: the helical tooth marks (~0.08 mm apart), inclined at the helix angle
          vec3 n = normalize(vWN);
          vec2 tdir = normalize(vec2(-n.y, n.x) + vec2(1e-6));
          float ph = (dot(vWPos.xy, tdir) + vWPos.z * 0.577) / 0.08;
          float fw = fwidth(ph), amp = smoothstep(0.4, 0.12, fw) * (1.0 - smoothstep(0.35, 0.55, vUp));
          float line = pow(abs(cos(3.14159265 * ph)), 4.0);
          diffuseColor.rgb *= 1.0 - 0.12 * amp * line;
          roughnessFactor += 0.1 * amp * line;
          // and the sheen of a cut face varies a little along it
          diffuseColor.rgb *= 0.95 + 0.08 * vnoise(vec2(dot(vWPos.xy, tdir) * 0.8, vWPos.z * 3.0));
        }`);
  };
  return m;
}

// A chip as a thin ribbon wound into a helix (unit size; scaled per instance). turns: number of
// coils, pitch: axial rise per turn relative to the coil radius, rad: coil radius factor.
function ribbonHelix(turns, pitch, rad) {
  const T = THREE, seg = Math.max(8, Math.ceil(turns * 18)), w = 0.22, t = 0.05;
  const pos = [], idx = [];
  const r0 = 0.6 * rad, len = 2 * Math.PI * turns;
  for (let k = 0; k <= seg; k++) {
    const a = len * k / seg;
    const r = r0 * (1 - 0.25 * k / seg); // coils tighten towards the free end
    // rise per turn: the curl pitch plus the ribbon width so coils do not overlap
    const rise = pitch * r0 + (turns > 1 ? w * 1.1 : 0);
    const c = Math.cos(a), s = Math.sin(a), z = rise * (a / (2 * Math.PI) - turns / 2);
    // ribbon width along the coil axis, thickness radial
    for (const [dr, dz] of [[-t / 2, -w / 2], [-t / 2, w / 2], [t / 2, w / 2], [t / 2, -w / 2]]) pos.push((r + dr) * c, (r + dr) * s, z + dz);
  }
  for (let k = 0; k < seg; k++) for (let f = 0; f < 4; f++) {
    const a = k * 4 + f, b = k * 4 + (f + 1) % 4, c = a + 4, d = b + 4;
    idx.push(a, c, b, b, c, d);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Fluted section built on the helix: column c of every flute is one point u of the cross-section
// (fluteProfile), rotated with height by z·tanβ/R, so the cutting edge, the land and the rake face
// run along mesh lines instead of zig-zagging across a cylinder's grid. Each flute has its own
// columns at u = 0 and u = 1, a seam at the cutting edge that keeps the edge sharp.
function fluteGeometry(t) {
  const T = THREE, R = t.D / 2, N = t.N, fl = t.fluteLen, tanB = Math.tan(t.helixDeg * Math.PI / 180);
  const cols = 120, rows = Math.max(60, Math.min(260, Math.ceil(fl / 0.15)));
  const us = [];
  for (let c = 0; c <= cols; c++) us.push(warpU(c / cols));
  const pos = [], col = [], idx = [];
  const radiusAt = (u, z) => {
    let rr = R * fluteProfile(u).r;
    if (t.type === 'ball' && z < R) rr *= Math.sqrt(Math.max(0, 1 - ((R - z) / R) ** 2));
    else if (t.rAt) rr *= Math.max(0.02, t.rAt(z)) / R;
    return rr;
  };
  for (let f = 0; f < N; f++) {
    const base = pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const z = fl * r / rows;
      for (let c = 0; c <= cols; c++) {
        const u = us[c], a = 2 * Math.PI * (f + u) / N - z * tanB / R, rr = radiusAt(u, z);
        pos.push(rr * Math.cos(a), rr * Math.sin(a), z);
        const sh = fluteProfile(u).shade;
        col.push(sh, sh, sh * 1.02);
      }
    }
    const w = cols + 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = base + r * w + c, b = a + 1, d = a + w, e = d + 1;
      idx.push(a, b, d, b, e, d); // counter-clockwise seen from outside
    }
  }
  // end face: a fan to the axis at z = 0 (seen only from below)
  const centre = pos.length / 3;
  pos.push(0, 0, 0); col.push(0.8, 0.8, 0.82);
  const w = cols + 1, perFlute = (rows + 1) * w;
  for (let f = 0; f < N; f++) for (let c = 0; c < cols; c++) idx.push(centre, f * perFlute + c + 1, f * perFlute + c); // faces down
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// denser sampling of the cross-section near the cutting edge and on the rake face, where the
// profile turns fastest
function warpU(x) {
  const knots = [[0, 0], [0.12, 0.035], [0.3, 0.16], [0.45, 0.42], [0.8, 0.9], [1, 1]];
  for (let k = 1; k < knots.length; k++) if (x <= knots[k][0]) { const [x0, u0] = knots[k - 1], [x1, u1] = knots[k]; return u0 + (u1 - u0) * (x - x0) / (x1 - x0); }
  return 1;
}

// End-mill cross-section over one flute pitch, u = 0 at the cutting edge and increasing
// against the rotation: cylindrical land (margin), primary and secondary clearance down to
// the heel, the flute gullet around the core, and the rake face rising back to the edge.
// Returns radius as a fraction of R and a shade (polished land/rake, duller gullet).
// BufferGeometry from an STL triangle soup, centred on its vertical axis with its lowest point at z0
function meshGeometry(mesh, z0) {
  const T = THREE, { tris, min, max } = mesh;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  const pos = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) { pos[i] = tris[i] - cx; pos[i + 1] = tris[i + 1] - cy; pos[i + 2] = tris[i + 2] - min[2] + z0; }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('color', new T.BufferAttribute(new Float32Array(pos.length).fill(0.82), 3));
  g.computeVertexNormals();
  return g;
}

function fluteProfile(u) {
  const core = 0.62;
  if (u < 0.035) return { r: 1, shade: 1.05 };                                     // land
  if (u < 0.16) return { r: 1 - 0.035 * (u - 0.035) / 0.125, shade: 0.95 };          // primary clearance
  if (u < 0.42) return { r: 0.965 - 0.075 * (u - 0.16) / 0.26, shade: 0.88 };        // secondary clearance
  if (u < 0.9) {                                                                     // gullet: smooth bowl to the core
    const v = (u - 0.42) / 0.48, d = Math.sin(Math.PI * Math.min(1, v * 1.15)) ** 0.8;
    return { r: 0.89 - (0.89 - core) * d * (v < 0.87 ? 1 : 1 - (v - 0.87) / 0.13 * 0.2), shade: 0.72 };
  }
  // rake face: steep, nearly radial rise to the edge (positive rake)
  const w = (u - 0.9) / 0.1;
  return { r: core + 0.05 + (1 - core - 0.05) * w ** 0.7, shade: 1.0 };
}

// red (gouge, negative) — grey within tolerance — blue (material left, positive)
const DEV_NEUTRAL = [0.56, 0.58, 0.61], DEV_GOUGE = [0.82, 0.18, 0.14], DEV_LEFT = [0.14, 0.38, 0.84];
function diverge(v, tol, scale) {
  const a = Math.abs(v);
  if (!(a > tol)) return DEV_NEUTRAL;
  const t = Math.min(1, 0.35 + 0.65 * (a - tol) / Math.max(1e-9, scale - tol)), c = v < 0 ? DEV_GOUGE : DEV_LEFT;
  return [0, 1, 2].map(i => DEV_NEUTRAL[i] + (c[i] - DEV_NEUTRAL[i]) * t);
}

// perceptual-ish ramp: deep blue → teal → amber → red
function ramp(t) {
  const stops = [[0.16, 0.27, 0.55], [0.13, 0.6, 0.62], [0.95, 0.72, 0.2], [0.85, 0.2, 0.15]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
