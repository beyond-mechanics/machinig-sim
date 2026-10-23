// 3D view of the particles and the tool (Three.js, orbit to rotate): the inclined wedge of oblique
// cutting, the helical tooth of an end mill, or an imported STL tool (solver frame with z along the
// cutter axis or up, shown upright: view = (x, z, −y)).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { surfaceNets } from './surface3d.js';

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
    // Continuous surface (render 'bands' / 'smooth'): coloured through a 1D texture of the map, so
    // that bands keep sharp edges across the triangles.
    this.sgeo = new THREE.BufferGeometry();
    this.smat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
    this.surf = new THREE.Mesh(this.sgeo, this.smat); this.surf.visible = false;
    this.root.add(this.surf);
    this.lutKey = ''; this.surfAt = 0;
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
    if (t.mesh) {
      // Where the tool meets the work: its axis at the top of the work; the whole work for 'all'.
      // 'tip': the work, close up, a little towards the tool; 'all': the work and the whole tool.
      const wb = t.wb, span = Math.max(wb[3] - wb[0], wb[4] - wb[1], wb[5] - wb[2]);
      const wc = new THREE.Vector3(0.5 * (wb[0] + wb[3]), 0.5 * (wb[1] + wb[4]), 0.5 * (wb[2] + wb[5]));
      const tc = new THREE.Vector3(t.pose[3] + t.pose[0], t.pose[4], wb[5] + t.pose[1]);
      target = wc.clone().lerp(tc, zoom === 'tip' ? 0.3 : 0.5);
      dist = zoom === 'tip' ? Math.max(1.25 * span, 30 * h) : 2.4 * Math.max(span, wc.distanceTo(tc) * 1.5);
      target.applyMatrix4(this.root.matrix);
      // From the side of the work away from the tool (ahead of a planing tool, outside a side mill),
      // a little from above; straight above-and-aside for a drill over the work.
      const away = new THREE.Vector3(wc.x - tc.x, wc.y - tc.y, 0);
      if (away.length() < 0.2 * span) away.set(0.75, -0.9, 0);
      away.normalize().add(new THREE.Vector3(0.35 * away.y, -0.35 * away.x, 0));
      dir = new THREE.Vector3(away.x, away.y, 0.75).normalize().transformDirection(this.root.matrix);
    } else if (t.helix) {
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

  // Imported tool (mesh mode): the STL triangles in the tool's own frame, built once per run; the
  // pivot sits on the spin axis and carries the feed and the turn.
  setMesh(t) {
    const key = `m|${t.id}`;
    if (key !== this.toolKey && t.tris) {
      if (this.toolMesh) { this.root.remove(this.toolMesh); this.toolMesh.traverse((o) => o.geometry && o.geometry.dispose()); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(t.tris, 3));
      g.translate(-t.pose[3], -t.pose[4], 0);
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.32, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
      const pivot = new THREE.Group(), body = new THREE.Mesh(g, mat);
      body.renderOrder = 1; pivot.add(body);
      this.toolMesh = pivot; this.root.add(pivot); this.toolKey = key;
      this.framed = false;   // a new run: aim at it
    }
    if (!this.toolMesh || this.toolKey !== key) return;
    const [mx, mz, ang, ax, ay] = t.pose;
    this.toolMesh.position.set(ax + mx, ay, mz);
    this.toolMesh.rotation.set(0, 0, ang);
  }

  // Extruded wedge: the normal-section outline swept along the inclined edge.
  setTool(t) {
    if (t.helix) { this.setHelix(t); return; }
    if (t.mesh) { this.setMesh(t); return; }
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

  // Nothing to show (a run that cannot start): drop the particles and the tool.
  clear() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    if (this.toolMesh) { this.root.remove(this.toolMesh); this.toolMesh.traverse((o) => o.geometry && o.geometry.dispose()); this.toolMesh = null; this.toolKey = ''; }
    this.framed = false;
    this.render();
  }

  // Particles coloured by a field; `section` keeps only a slice through the strip's middle
  // (end mill: the plane at mid height, as in the 2D section).
  // Texture of the colour map: nb hard bands, or 256 smooth steps.
  setLut(lut, nb) {
    const key = `${nb}|${lut[0]}|${lut[255]}|${lut[128]}`;
    if (key === this.lutKey) return;
    const w = nb || 256, d = new Uint8Array(4 * w);
    for (let b = 0; b < w; b++) { const c = lut[nb ? Math.round(b / (nb - 1) * 255) : b]; d.set([c[0], c[1], c[2], 255], 4 * b); }
    if (this.smat.map) this.smat.map.dispose();
    const t = new THREE.DataTexture(d, w, 1, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = nb ? THREE.NearestFilter : THREE.LinearFilter;
    t.needsUpdate = true;
    this.smat.map = t; this.lutKey = key;
    // Bands: thin dark lines where the value crosses a band boundary (a screen-space width from
    // the derivative of the texture coordinate), as on an FE contour plot.
    this.smat.onBeforeCompile = (sh) => {
      if (!nb) return;
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { float bu = vMapUv.x * ${nb.toFixed(1)}, d = abs(fract(bu + 0.5) - 0.5), fw = max(fwidth(bu), 1e-4);
          if (bu > 0.5 && bu < ${(nb - 0.5).toFixed(1)}) diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.4 * fw, 1.4 * fw, d)); }`);
    };
    this.smat.customProgramCacheKey = () => `bands${nb}`;
    this.smat.needsUpdate = true;
  }

  update(f, vals, lo, hi, lut, section, nb = -1) {
    const t = f.tool;
    this.setFrame(!!(t.helix || t.mesh));
    const n = f.x.length, sel = [];
    // Section: the mid-height plane of the end mill, the vertical plane through the axis of an
    // imported tool, the middle of the oblique strip.
    const halfT = 0.75 * f.dx, zc = t.helix ? 0.5 * t.ap : 0, sc = t.mesh ? f.y : f.z, yc = t.mesh ? t.pose[4] : zc;
    for (let i = 0; i < n; i++) if (!section || Math.abs(sc[i] - yc) < halfT) sel.push(i);
    // Surface: rebuilt at most a few times a second while running (it costs more than the points).
    let surf = false;
    if (nb >= 0) {
      const now = performance.now();
      if (!f.running || now - this.surfAt > 400 || !this.surf.visible || this.surfKey !== `${nb}|${section}`) {
        const r = surfaceNets(f, sel, vals, lo, hi);
        if (r) {
          this.setLut(lut, nb);
          const g = this.sgeo;
          g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
          g.setAttribute('uv', new THREE.BufferAttribute(r.uv, 2));
          g.setAttribute('color', new THREE.BufferAttribute(r.col, 3));
          g.setIndex(new THREE.BufferAttribute(r.idx, 1));
          g.setAttribute('normal', new THREE.BufferAttribute(r.nrm, 3)); g.computeBoundingSphere();
          this.surfAt = now; this.surfKey = `${nb}|${section}`; surf = true;
        }
      } else surf = true;
    }
    this.surf.visible = surf; this.points.visible = !surf;
    if (surf) {
      this.setTool(f.tool);
      if (!this.framed) this.frame(f);
      this.render();
      return;
    }
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
