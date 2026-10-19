// 3D view of the particles and the tool (Three.js, orbit to rotate): the inclined wedge of oblique
// cutting, or the helical tooth of an end mill (solver frame with z along the cutter axis, shown
// upright: view = (x, z, −y)).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Round, softly shaded point sprite so particles read as small balls.
function spriteTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(26, 24, 4, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.75, 'rgba(225,225,225,1)'); gr.addColorStop(1, 'rgba(160,160,160,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 31, 0, 7); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class View3D {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
    this.camera.position.set(0.9, 0.7, 1.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1, 2, 1.5); this.scene.add(dl);
    this.geo = new THREE.BufferGeometry();
    this.mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, map: spriteTexture(), alphaTest: 0.5, sizeAttenuation: true });
    this.points = new THREE.Points(this.geo, this.mat);
    this.root = new THREE.Group(); this.root.matrixAutoUpdate = false;
    this.root.add(this.points); this.scene.add(this.root);
    this.toolMesh = null; this.toolKey = '';
    this.zoom = 'tip'; this.framed = false;
    new ResizeObserver(() => this.resize()).observe(el);
    const loop = () => { if (!this.el.hidden && this.controls.update()) this.render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  // Solver frame → view: identity for oblique cutting, cutter axis upright for the end mill.
  setFrame(helix) {
    if (this.helix === helix) return;
    this.helix = helix;
    const m = new THREE.Matrix4();
    if (helix) m.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0));
    this.root.matrix.copy(m); this.root.matrixWorldNeedsUpdate = true;
    this.framed = false;
  }

  // Aim at the cutting edge (tip) or at the whole strip.
  frame(f, zoom = this.zoom) {
    this.zoom = zoom;
    const t = f.tool, h = f.h, [L, H, B] = f.box;
    let target, dist, dir;
    if (t.helix) {
      // Tooth tip at mid height, seen from outside the cutter, slightly from above.
      const th = t.theta - 0.5 * t.ap * t.kh;
      target = zoom === 'tip' ? new THREE.Vector3(t.c[0] + t.R * Math.cos(th), t.c[1] + t.R * Math.sin(th), 0.5 * t.ap) : new THREE.Vector3(0, -0.5 * H, 0.5 * t.ap);
      target.applyMatrix4(this.root.matrix);
      dist = zoom === 'tip' ? Math.max(20 * h, 4 * t.ap) : 1.6 * Math.max(L, 3 * t.ap);
      // From ahead of the rake face (cutting direction û), a little outside and above.
      const ct = Math.cos(th), st = Math.sin(th);
      dir = new THREE.Vector3(-st + 0.45 * ct, ct + 0.45 * st, 0.6).normalize().transformDirection(this.root.matrix);
    } else {
      target = zoom === 'tip' ? new THREE.Vector3(t.pos[0] + 0.8 * h, 0.6 * h, t.pos[2]) : new THREE.Vector3(0.5 * L, -0.3 * H, 0);
      dist = zoom === 'tip' ? Math.max(16 * h, 4.5 * B) : 1.5 * Math.max(L, 3 * B);
      dir = new THREE.Vector3(0.8, 0.5, 0.55).normalize();   // ahead of the rake face, above, to the side
    }
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.near = dist / 200; this.camera.far = dist * 20; this.camera.updateProjectionMatrix();
    this.controls.update(); this.render();
    this.framed = true;
  }

  // Helical tooth: the tooth-section outline (u along the cut, w towards the axis) swept along
  // the helix θ(z) = −z·kh about the cutter axis, plus a faint cylinder for the cutter body.
  // Built at θ = 0 about the origin; each frame only moves and turns the pivot.
  setHelix(t) {
    const key = `h|${t.kh}|${t.ap}|${t.rr}|${t.outline.length}`;
    if (key !== this.toolKey) {
      if (this.toolMesh) { this.root.remove(this.toolMesh); this.toolMesh.traverse((o) => o.geometry && o.geometry.dispose()); }
      const z0 = -0.4 * t.ap, z1 = 1.4 * t.ap, ns = 24, ol = t.outline, n = ol.length, pos = [], idx = [];
      for (let k = 0; k <= ns; k++) {
        const z = z0 + (z1 - z0) * k / ns, a = -z * t.kh, ca = Math.cos(a), sa = Math.sin(a);
        for (const [u, w] of ol) { const qx = t.rr - w, qy = u; pos.push(ca * qx - sa * qy, sa * qx + ca * qy, z); }
      }
      for (let k = 0; k < ns; k++) for (let i = 0; i < n; i++) {
        const a = k * n + i, b = k * n + (i + 1) % n, c = a + n, d = b + n;
        idx.push(a, b, d, a, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.55, roughness: 0.35, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
      const pivot = new THREE.Group(), tooth = new THREE.Mesh(g, mat);
      tooth.renderOrder = 1; pivot.add(tooth);
      const cyl = new THREE.CylinderGeometry(t.R, t.R, z1 - z0, 96, 1, true);
      cyl.rotateX(Math.PI / 2); cyl.translate(0, 0, 0.5 * (z0 + z1));
      const body = new THREE.Mesh(cyl, new THREE.MeshBasicMaterial({ color: 0x8090a0, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
      body.renderOrder = 2; pivot.add(body);
      this.toolMesh = pivot; this.root.add(pivot); this.toolKey = key;
    }
    this.toolMesh.position.set(t.c[0], t.c[1], 0);
    this.toolMesh.rotation.set(0, 0, t.theta);
  }

  // Extruded wedge: the normal-section outline swept along the inclined edge.
  setTool(t) {
    if (t.helix) { this.setHelix(t); return; }
    const key = `${t.lam}|${t.outline.length}|${t.outline[0]}|${t.len}`;
    if (key !== this.toolKey) {
      if (this.toolMesh) { this.root.remove(this.toolMesh); this.toolMesh.traverse((o) => o.geometry && o.geometry.dispose()); }
      const shape = new THREE.Shape(t.outline.map(([u, w]) => new THREE.Vector2(u, w)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: t.len, bevelEnabled: false, curveSegments: 4 });
      g.translate(0, 0, -t.len / 2);
      const n = new THREE.Vector3(Math.cos(t.lam), 0, -Math.sin(t.lam)), e = new THREE.Vector3(Math.sin(t.lam), 0, Math.cos(t.lam));
      g.applyMatrix4(new THREE.Matrix4().makeBasis(n, new THREE.Vector3(0, 1, 0), e));
      g.computeVertexNormals();
      this.toolMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.55, roughness: 0.35, transparent: true, opacity: 0.5, depthWrite: false }));
      this.toolMesh.renderOrder = 1;
      this.root.add(this.toolMesh);
      this.toolKey = key;
    }
    this.toolMesh.position.set(t.pos[0], t.pos[1], t.pos[2]);
  }

  // Particles coloured by a field; `section` keeps only a slice through the strip's middle
  // (end mill: the plane at mid height, as in the 2D section).
  update(f, vals, lo, hi, lut, section) {
    this.setFrame(!!f.tool.helix);
    const n = f.x.length, sel = [];
    const halfT = 0.75 * f.dx, zc = f.tool.helix ? 0.5 * f.tool.ap : 0;
    for (let i = 0; i < n; i++) if (!section || Math.abs(f.z[i] - zc) < halfT) sel.push(i);
    const m = sel.length, pos = new Float32Array(3 * m), col = new Float32Array(3 * m), inv = 255 / (hi - lo);
    for (let k = 0; k < m; k++) {
      const i = sel[k];
      pos[3 * k] = f.x[i]; pos[3 * k + 1] = f.y[i]; pos[3 * k + 2] = f.z[i];
      let t = Math.round((vals[i] - lo) * inv); t = t < 0 ? 0 : t > 255 ? 255 : t;
      const c = lut[t], dim = f.flag[i] === 1 ? 0.55 : 1;
      col[3 * k] = c[0] / 255 * dim; col[3 * k + 1] = c[1] / 255 * dim; col[3 * k + 2] = c[2] / 255 * dim;
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geo.computeBoundingSphere();
    this.mat.size = 1.15 * f.dx;
    this.setTool(f.tool);
    if (!this.framed) this.frame(f);
    this.render();
  }
}
