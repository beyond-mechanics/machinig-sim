// UI: condition form, particle field view (Canvas 2D), charts and readouts.
import { MATERIALS } from './materials.js';
import { DEFAULTS } from './sph.js';
import { chamferProfile, breakerProfile, importProfile } from './profile.js';
import { makeTool, toolOutline } from './tool.js';
import { View3D } from './view3d.js';

const $ = (id) => document.getElementById(id);
const worker = new Worker(URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' })));

// ---- Colour maps ----
function turbo(t) {
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return [r, g, b].map((v) => Math.round(255 * Math.min(1, Math.max(0, v))));
}
function diverging(t) { // blue – near-white – red, for pressure (compression positive)
  const a = [[44, 92, 168], [236, 236, 232], [186, 52, 42]];
  const s = t < 0.5 ? t * 2 : (t - 0.5) * 2, p = t < 0.5 ? a[0] : a[1], q = t < 0.5 ? a[1] : a[2];
  return p.map((v, i) => Math.round(v + (q[i] - v) * s));
}
const LUT = { turbo: [], div: [] };
for (let i = 0; i < 256; i++) { LUT.turbo.push(turbo(0.06 + 0.94 * i / 255)); LUT.div.push(diverging(i / 255)); }
const cssGrad = (name) => `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => { const c = LUT[name][Math.round(t * 255)]; return `rgb(${c}) ${t * 100}%`; }).join(', ')})`;

const FIELDS = {
  T: { label: '温度', unit: '°C', map: 'turbo', fmt: (v) => v.toFixed(0) },
  seq: { label: 'ミーゼス応力', unit: 'MPa', map: 'turbo', fmt: (v) => v.toFixed(0) },
  ep: { label: '相当塑性ひずみ', unit: '', map: 'turbo', fmt: (v) => v.toFixed(2) },
  sr: { label: 'ひずみ速度', unit: 'log₁₀ 1/s', map: 'turbo', fmt: (v) => v.toFixed(1), log: true },
  p: { label: '静水圧', unit: 'MPa', map: 'div', fmt: (v) => v.toFixed(0) },
  D: { label: '損傷度', unit: '1 で割れ始め', map: 'turbo', fmt: (v) => v.toFixed(1) },
};

// ---- State ----
let frame = null, field = 'T', zoom = 'tip', status = 'idle', cfg = null, mode = 'ortho';
const is3 = (m = mode) => m === '3d' || m === 'helix';   // 3D solver modes
const view = $('view'), vctx = view.getContext('2d');

// ---- Conditions form ----
const matSel = $('mat');
const groups = {};
for (const [k, m] of Object.entries(MATERIALS)) {
  if (!groups[m.group]) { groups[m.group] = document.createElement('optgroup'); groups[m.group].label = m.group; matSel.appendChild(groups[m.group]); }
  groups[m.group].appendChild(new Option(m.name, k));
}
matSel.value = DEFAULTS.mat;
function applyMaterialDefaults() {
  const m = MATERIALS[matSel.value];
  $('vc').value = m.vc; $('mu').value = m.mu;
  if (m.rake != null) $('rake').value = m.rake;
  if (m.nh && mode === 'ortho') $('res').value = String(m.nh);
}
applyMaterialDefaults();
showShapeRows();
matSel.addEventListener('change', () => { applyMaterialDefaults(); reset(); });

for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => {
  // The 3D end mill needs about four particles across the chip, so it starts on a small cutter.
  // Down milling: on a small cutter, up milling loses the chip early near the exit.
  if (b.dataset.mode === 'helix' && mode !== 'helix') { $('dia').value = '2'; $('ae').value = '0.2'; $('dir').value = 'down'; }
  if (b.dataset.mode === 'mill' && mode === 'helix') { $('dia').value = '6'; $('ae').value = '0.3'; }
  mode = b.dataset.mode;
  for (const c of document.querySelectorAll('[data-mode]')) c.setAttribute('aria-pressed', c === b);
  $('res').value = mode === 'ortho' ? '8' : mode === 'helix' ? '4' : '5';
  if (mode === '3d') $('len').value = '0.4';
  showShapeRows();
  reset();
});

function readCfg() {
  const num = (id) => parseFloat($(id).value);
  const shape = $('shape').value;
  if (mode === 'helix') return {
    mode, mat: matSel.value, vc: num('vc'), rake: num('rake'), clearance: num('clear'), edgeRadius: num('edge'), mu: num('mu'), nh: num('res'),
    D: num('dia'), z: num('flutes'), fz: num('fz'), ae: num('ae'), ap: num('ap'), helix: num('helix'), dir: $('dir').value, track: num('track'),
  };
  if (mode === '3d') return {
    mode, mat: matSel.value, vc: num('vc'), h: num('h'), b: num('b3'), lambda: num('lambda'), rake: num('rake'),
    clearance: num('clear'), edgeRadius: num('edge'), mu: num('mu'), nh: num('res'), cutLen: num('len'), sides: $('sides').value,
  };
  return {
    mode, mat: matSel.value, vc: num('vc'), h: num('h'), rake: num('rake'), clearance: num('clear'),
    edgeRadius: num('edge'), mu: num('mu'), width: num('width'), cutLen: num('len'), nh: num('res'),
    D: num('dia'), z: num('flutes'), fz: num('fz'), ae: num('ae'), dir: $('dir').value, track: num('track'),
    tool: shape === 'custom' && !custom.profile ? 'wedge' : shape, land: num('land'), landDeg: num('landDeg'),
    gw: num('gw'), gd: num('gd'), wallDeg: num('wallDeg'), wh: num('wh'), profile: shape === 'custom' ? custom.profile : null,
    fracture: $('fracture').checked, efScale: num('efs'),
  };
}
for (const id of ['vc', 'h', 'rake', 'clear', 'edge', 'mu', 'width', 'len', 'res', 'dia', 'flutes', 'fz', 'ae', 'dir', 'track',
  'land', 'landDeg', 'gw', 'gd', 'wallDeg', 'wh', 'fracture', 'efs', 'b3', 'lambda', 'sides', 'ap', 'helix']) $(id).addEventListener('change', reset);

// ---- Tool shape: built-in edge preparations or an imported outline, with a preview ----
const custom = { text: null, name: '', rot: 0, flip: false, profile: null };
// Visibility: data-only lists the modes an element belongs to, data-shape the tool shapes
// (3D supports only the standard wedge).
function showShapeRows() {
  const sh = is3() ? 'wedge' : $('shape').value;
  for (const el of document.querySelectorAll('[data-only], [data-shape]')) {
    const okMode = !el.dataset.only || el.dataset.only.split(' ').includes(mode);
    const okShape = !el.dataset.shape || el.dataset.shape.split(' ').includes(sh);
    el.hidden = !(okMode && okShape);
  }
  for (const b of $('fields').children) b.hidden = is3() && b.dataset.f === 'D';
  if (is3() && field === 'D') field = 'T';
  view.hidden = is3(); $('view3d').hidden = !is3();
  if (is3()) view3d();
}
let v3 = null;
const view3d = () => v3 || (v3 = new View3D($('view3d')));
$('shape').addEventListener('change', () => { showShapeRows(); reset(); });
function loadCustom() {
  const info = $('pinfo');
  if (custom.text == null) { custom.profile = null; info.textContent = 'ファイルを選んでください。'; info.classList.remove('err'); return; }
  try {
    const r = importProfile(custom.text, { name: custom.name, unit: $('punit').value, rot: custom.rot, flip: custom.flip });
    custom.profile = r.profile;
    const i = r.info;
    info.textContent = `${custom.name}：${i.points.toLocaleString()} 点、大きさ ${(i.size * 1e3).toFixed(2)} mm（単位 ${{ mm: 'mm', um: 'µm', in: 'inch' }[i.unit]}）、${i.closed ? '閉じた輪郭' : '開いた線に工具本体を補完'}`;
    info.classList.remove('err');
  } catch (err) {
    custom.profile = null; info.textContent = err.message; info.classList.add('err');
  }
}
$('pfile').addEventListener('change', async () => {
  const f = $('pfile').files[0];
  if (!f) return;
  custom.text = await f.text(); custom.name = f.name; custom.rot = 0; custom.flip = false;
  loadCustom(); reset();
});
$('punit').addEventListener('change', () => { loadCustom(); reset(); });
$('prot').addEventListener('click', () => { custom.rot = (custom.rot + 1) % 4; loadCustom(); reset(); });
$('pflip').addEventListener('click', () => { custom.flip = !custom.flip; loadCustom(); reset(); });

// Outline of the chosen shape in the tool frame [m], cutting edge (lowest point) at the origin.
function shapeOutline(c) {
  const sp = { rake: c.rake, clearance: c.clearance, r: c.edgeRadius, land: c.land, landDeg: c.landDeg, gw: c.gw, gd: c.gd, wallDeg: c.wallDeg, wh: c.wh };
  if (c.tool === 'chamfer') return chamferProfile(sp);
  if (c.tool === 'breaker') return breakerProfile(sp);
  if (c.tool === 'custom' && c.profile) return c.profile;
  const t = makeTool({ rakeDeg: c.rake, clearanceDeg: c.clearance, edgeRadius: c.edgeRadius * 1e-6 });
  return toolOutline(t, 3e-3).map(([u, w]) => [u, w + t.r]);
}
function drawPreview() {
  const cv = $('preview'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  const h = (mode === 'mill' ? cfg.fz : cfg.h) * 1e-3, span = Math.max(7 * h, 0.5e-3);
  const s = Math.min(W / span, H / (span * H / W)), u0 = -0.62 * span, w0 = -0.18 * span * H / W;
  const X = (u) => (u - u0) * s, Y = (w) => H - (w - w0) * s;
  // Work below the machined surface and the layer still to be cut (thickness h) ahead of the edge.
  c.fillStyle = css.getPropertyValue('--rule'); c.fillRect(0, Y(0), W, H - Y(0));
  c.globalAlpha = 0.5; c.fillRect(X(0), Y(h), W - X(0), Y(0) - Y(h)); c.globalAlpha = 1;
  const pts = shapeOutline(cfg);
  c.beginPath(); pts.forEach(([u, w], i) => (i ? c.lineTo(X(u), Y(w)) : c.moveTo(X(u), Y(w)))); c.closePath();
  c.fillStyle = css.getPropertyValue('--tool-b'); c.fill();
  c.strokeStyle = css.getPropertyValue('--tool-edge'); c.lineWidth = 1.5; c.stroke();
  c.fillStyle = css.getPropertyValue('--ink-mute'); c.font = `11px ${css.getPropertyValue('--font-mono')}`;
  c.textAlign = 'left'; c.fillText(`切削方向 →    h = ${(h * 1e3).toFixed(2)} mm`, 6, 14);
  const bar = span > 1e-3 ? 0.2e-3 : 0.1e-3;
  c.fillRect(W - 8 - bar * s, H - 10, bar * s, 2); c.textAlign = 'right'; c.fillText(`${bar * 1e3} mm`, W - 8, H - 14);
}

function reset() {
  cfg = readCfg();
  drawPreview();
  status = 'idle'; frame = null;
  worker.postMessage({ type: 'init', cfg });
  buildCells();
  updateRunButton();
}
$('run').addEventListener('click', () => {
  if (status === 'running') { worker.postMessage({ type: 'pause' }); status = 'paused'; }
  else if (status === 'done') { reset(); worker.postMessage({ type: 'run' }); status = 'running'; }
  else { worker.postMessage({ type: 'run' }); status = 'running'; }
  updateRunButton();
});
$('reset').addEventListener('click', reset);
function updateRunButton() {
  const b = $('run');
  b.textContent = status === 'running' ? '一時停止' : status === 'paused' ? '再開' : status === 'done' ? 'もう一度' : '切削開始';
  const pill = $('state');
  pill.dataset.s = status;
  pill.textContent = { idle: '待機', running: '計算中', paused: '一時停止', done: '完了' }[status];
}

// Field and zoom toggles.
const fieldBar = $('fields');
for (const [k, f] of Object.entries(FIELDS)) {
  const b = document.createElement('button');
  b.className = 'chipbtn'; b.textContent = f.label; b.dataset.f = k; b.setAttribute('aria-pressed', k === field);
  b.addEventListener('click', () => { field = k; for (const c of fieldBar.children) c.setAttribute('aria-pressed', c.dataset.f === k); draw(); });
  fieldBar.appendChild(b);
}
for (const b of document.querySelectorAll('[data-zoom]')) b.addEventListener('click', () => {
  zoom = b.dataset.zoom;
  for (const c of document.querySelectorAll('[data-zoom]')) c.setAttribute('aria-pressed', c === b);
  if (is3() && frame && frame.dim === 3) view3d().frame(frame, zoom);
  draw();
});
let section = false;
$('section').addEventListener('click', () => { section = !section; $('section').setAttribute('aria-pressed', section); draw(); });

worker.onmessage = (e) => {
  if (e.data.type !== 'frame') return;
  frame = e.data;
  if (status === 'running' && !frame.running) status = frame.summary.done ? 'done' : 'paused';
  updateRunButton();
  draw(); drawCharts(); readouts();
};

// ---- Field view ----
let xf = null; // current world → screen transform
function fieldValues(f) {
  const a = frame[f];
  if (!FIELDS[f].log) return a;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.log10(Math.max(a[i], 1));
  return out;
}
function range(f, vals) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vals.length; i++) { if (frame.flag[i] === 1) continue; const v = vals[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (f === 'T') { lo = 20; hi = Math.max(hi, 100); const tg = frame.toolGrid; if (tg) for (let k = 0; k < tg.T.length; k++) if (tg.inside[k] && tg.T[k] > hi) hi = tg.T[k]; }
  if (f === 'seq' || f === 'ep') lo = 0;
  if (f === 'sr') { lo = Math.max(lo, 0); hi = Math.max(hi, lo + 1); }
  if (f === 'D') { lo = 0; hi = 1.5; }
  if (f === 'p') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -m; hi = m; }
  if (!(hi > lo)) hi = lo + 1;
  return [lo, hi];
}

// Tool temperature: the tool grid painted into a small bitmap, drawn in the tool's frame and
// clipped to the tool outline.
const toolCanvas = document.createElement('canvas');
function toolBitmap(lo, hi) {
  const g = frame.toolGrid, lut = LUT.turbo;
  toolCanvas.width = g.nu; toolCanvas.height = g.nw;
  const c = toolCanvas.getContext('2d'), img = c.createImageData(g.nu, g.nw), d = img.data;
  for (let j = 0; j < g.nw; j++) for (let i = 0; i < g.nu; i++) {
    const k = i + j * g.nu, o = k * 4;   // row j = w index; the draw transform flips w up
    if (!g.inside[k]) continue;
    let t = Math.round((g.T[k] - lo) / (hi - lo) * 255); t = t < 0 ? 0 : t > 255 ? 255 : t;
    const col = lut[t]; d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return toolCanvas;
}

function draw() {
  if (frame && frame.dim === 3) { draw3d(); return; }
  const dpr = window.devicePixelRatio || 1, W = view.clientWidth, H = view.clientHeight;
  if (view.width !== Math.round(W * dpr) || view.height !== Math.round(H * dpr)) { view.width = Math.round(W * dpr); view.height = Math.round(H * dpr); }
  const cw = view.width, ch = view.height;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, cw, ch);
  if (!frame) return;
  const hmm = frame.h, [tx, ty, , th] = frame.tip;
  // Window in mm: whole block, or a box around the cutting edge.
  let wx0, wx1, wy0, wy1;
  if (zoom === 'all') [wx0, wx1, wy0, wy1] = frame.view;
  else {
    const ux = Math.cos(th), uy = Math.sin(th), cx0 = tx - 0.5 * hmm * ux - 1.2 * hmm * uy, cy0 = ty - 0.5 * hmm * uy + 1.2 * hmm * ux;
    wx0 = cx0 - 4.5 * hmm; wx1 = cx0 + 4.5 * hmm; wy0 = cy0 - 3.5 * hmm; wy1 = cy0 + 3.5 * hmm;
  }
  const s = Math.min(cw / (wx1 - wx0), ch / (wy1 - wy0));
  const ox = (cw - s * (wx1 - wx0)) / 2 - wx0 * s, oy = (ch - s * (wy1 - wy0)) / 2 + wy1 * s;
  xf = { s, ox, oy, dpr };
  const vals = fieldValues(field), [lo, hi] = range(field, vals), lut = LUT[FIELDS[field].map];
  const img = vctx.createImageData(cw, ch), buf = new Uint32Array(img.data.buffer);
  const half = Math.max(1, frame.dx * s * 0.5);
  const n = frame.x.length, inv = 255 / (hi - lo);
  for (let i = 0; i < n; i++) {
    const px = ox + frame.x[i] * s, py = oy - frame.y[i] * s;
    if (px < -half || py < -half || px > cw + half || py > ch + half) continue;
    let t = Math.round((vals[i] - lo) * inv); t = t < 0 ? 0 : t > 255 ? 255 : t;
    const c = lut[t];
    let col = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
    if (frame.flag[i] === 1) col = (255 << 24) | ((c[2] * 0.55) << 16) | ((c[1] * 0.55) << 8) | (c[0] * 0.55);
    const x0 = Math.max(0, Math.floor(px - half)), x1 = Math.min(cw, Math.ceil(px + half));
    const y0 = Math.max(0, Math.floor(py - half)), y1 = Math.min(ch, Math.ceil(py + half));
    for (let yy = y0; yy < y1; yy++) buf.fill(col, yy * cw + x0, yy * cw + x1);
  }
  vctx.putImageData(img, 0, 0);
  const css = getComputedStyle(document.documentElement);
  // Cutter circle (end mill).
  if (frame.mill) {
    const m = frame.mill;
    vctx.setLineDash([4 * dpr, 4 * dpr]); vctx.strokeStyle = css.getPropertyValue('--guide'); vctx.lineWidth = dpr;
    vctx.beginPath(); vctx.arc(ox + m.cx * s, oy - m.cy * s, m.R * s, 0, 2 * Math.PI); vctx.stroke(); vctx.setLineDash([]);
  }
  // Tool body, then its temperature field when temperature is shown.
  const path = new Path2D();
  frame.outline.forEach(([a, b], i) => { const X = ox + a * s, Y = oy - b * s; if (i) path.lineTo(X, Y); else path.moveTo(X, Y); });
  path.closePath();
  const g = vctx.createLinearGradient(ox + (tx - 3 * hmm) * s, 0, ox + tx * s, 0);
  g.addColorStop(0, css.getPropertyValue('--tool-a')); g.addColorStop(1, css.getPropertyValue('--tool-b'));
  vctx.fillStyle = g; vctx.fill(path);
  if (field === 'T') {
    const tg = frame.toolGrid, bmp = toolBitmap(lo, hi);
    vctx.save(); vctx.clip(path);
    // Local (u, w) → screen: origin at the edge centre, u along th, w normal to it, y flipped.
    const c = Math.cos(th), sn = Math.sin(th);
    vctx.setTransform(c * s, -sn * s, -sn * s, -c * s, ox + tx * s, oy - ty * s);
    vctx.imageSmoothingEnabled = true;
    vctx.drawImage(bmp, tg.u0, tg.w0, tg.nu * tg.a, tg.nw * tg.a);
    vctx.restore();
  }
  vctx.lineWidth = 1.5 * dpr; vctx.strokeStyle = css.getPropertyValue('--tool-edge'); vctx.stroke(path);
  // Cut depth guide line (orthogonal cutting).
  if (!frame.mill) {
    vctx.setLineDash([4 * dpr, 4 * dpr]); vctx.strokeStyle = css.getPropertyValue('--guide'); vctx.lineWidth = dpr;
    vctx.beginPath(); vctx.moveTo(0, oy + hmm * s); vctx.lineTo(cw, oy + hmm * s); vctx.stroke(); vctx.setLineDash([]);
  }
  // Scale bar.
  const span = (wx1 - wx0), bar = span > 1.5 ? 0.2 : span > 0.6 ? 0.1 : span > 0.25 ? 0.05 : 0.02, bl = bar * s;
  vctx.fillStyle = css.getPropertyValue('--ink'); vctx.fillRect(cw - bl - 16 * dpr, ch - 22 * dpr, bl, 3 * dpr);
  vctx.font = `${11 * dpr}px ${css.getPropertyValue('--font-mono')}`; vctx.textAlign = 'right';
  vctx.fillText(`${Math.round(bar * 1000)} µm`, cw - 16 * dpr, ch - 28 * dpr);
  // Legend.
  const f = FIELDS[field];
  $('lg-bar').style.background = cssGrad(f.map);
  $('lg-lo').textContent = f.fmt(lo); $('lg-hi').textContent = f.fmt(hi);
  $('lg-name').textContent = (f.unit ? `${f.label} [${f.unit}]` : f.label) + (field === 'T' ? (frame.toolGrid.steady ? '・工具は定常推定' : '・工具を含む') : '');
}
new ResizeObserver(() => { draw(); drawCharts(); }).observe(view);

function draw3d() {
  const vals = fieldValues(field), [lo, hi] = range(field, vals), f = FIELDS[field];
  view3d().update(frame, vals, lo, hi, LUT[f.map], section);
  $('lg-bar').style.background = cssGrad(f.map);
  $('lg-lo').textContent = f.fmt(lo); $('lg-hi').textContent = f.fmt(hi);
  $('lg-name').textContent = (f.unit ? `${f.label} [${f.unit}]` : f.label) + (section ? '・中央断面' : '') + '・ドラッグで回転';
}
new ResizeObserver(() => { if (cfg) drawPreview(); }).observe($('preview'));

// Probe: nearest particle under the pointer.
view.addEventListener('pointermove', (e) => {
  if (!frame || !xf) return;
  const r = view.getBoundingClientRect();
  const X = (e.clientX - r.left) * xf.dpr, Y = (e.clientY - r.top) * xf.dpr;
  const wx = (X - xf.ox) / xf.s, wy = (xf.oy - Y) / xf.s;
  let best = -1, bd = (frame.dx * 1.5) ** 2;
  for (let i = 0; i < frame.x.length; i++) { const d = (frame.x[i] - wx) ** 2 + (frame.y[i] - wy) ** 2; if (d < bd) { bd = d; best = i; } }
  const pr = $('probe');
  if (best < 0) { pr.hidden = true; return; }
  pr.hidden = false;
  pr.textContent = `${frame.T[best].toFixed(0)} °C · σ ${frame.seq[best].toFixed(0)} MPa · ε ${frame.ep[best].toFixed(2)} · ε̇ ${frame.sr[best].toExponential(1)} /s · p ${frame.p[best].toFixed(0)} MPa · 損傷 ${frame.D[best].toFixed(2)}`;
});
view.addEventListener('pointerleave', () => { $('probe').hidden = true; });

// ---- Charts ----
function niceStep(span, n) {
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}
function lineChart(canvas, xs, series, { xmin = 0, xmax, unit, xlabel, empty }) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  const L = 48, R = 12, T = 18, B = 26, pw = W - L - R, ph = H - T - B;
  let ymax = 0;
  for (const s of series) for (const v of s.data) if (v > ymax) ymax = v;
  if (!(ymax > 0)) ymax = 1;
  const ystep = niceStep(ymax, 4); ymax = Math.ceil(ymax / ystep - 1e-9) * ystep;
  const span = xmax - xmin, xstep = niceStep(span, pw < 320 ? 3 : 5);
  const X = (v) => L + (v - xmin) / span * pw, Y = (v) => T + ph - v / ymax * ph;
  c.font = `11px ${css.getPropertyValue('--font-mono')}`; c.fillStyle = css.getPropertyValue('--ink-mute');
  c.strokeStyle = css.getPropertyValue('--rule'); c.lineWidth = 1;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + pw, Y(v)); c.stroke();
    c.fillText(ystep < 0.01 ? v.toFixed(3) : ystep < 0.1 ? v.toFixed(2) : ystep < 1 ? v.toFixed(1) : v.toFixed(0), L - 6, Y(v));
  }
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (let v = Math.ceil(xmin / xstep) * xstep; v <= xmax + 1e-9; v += xstep) c.fillText(Math.abs(v) < 1e-9 ? '0' : xstep < 0.1 ? v.toFixed(2) : xstep < 1 ? v.toFixed(1) : v.toFixed(0), X(v), T + ph + 6);
  c.textAlign = 'left'; c.fillText(unit, 4, 0);
  c.textAlign = 'right'; c.fillText(xlabel, L + pw, 0);
  if (empty && !series.some((s) => s.data.length)) { c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(empty, L + pw / 2, T + ph / 2); return; }
  for (const s of series) {
    if (!s.data.length) continue;
    c.strokeStyle = css.getPropertyValue(s.color); c.lineWidth = 2; c.beginPath();
    let started = false;
    s.data.forEach((v, i) => { if (v == null) return; if (started) c.lineTo(X(xs[i]), Y(v)); else { c.moveTo(X(xs[i]), Y(v)); started = true; } });
    c.stroke();
    const i = s.data.length - 1;
    if (s.data[i] != null && s.dot !== false) { c.fillStyle = css.getPropertyValue(s.color); c.beginPath(); c.arc(X(xs[i]), Y(s.data[i]), 3, 0, 7); c.fill(); }
  }
}
function drawCharts() {
  const d3 = cfg && cfg.mode === '3d', hx = cfg && cfg.mode === 'helix';
  $('cf-c-wrap').hidden = !(d3 || hx);
  if (hx) {
    const h = frame && frame.dim === 3 ? frame.hist : { axis: [], fc: [], ft: [], fr: [], tmax: [], flow: [] };
    const xmax = frame && frame.dim === 3 ? Math.max(1, frame.summary.arc + frame.summary.lag + frame.summary.track + 6) : 40;
    const xl = '横軸 刃の回転角 [°]（下端の刃、最下点から）';
    lineChart($('chart-f'), h.axis, [{ data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }, { data: h.fr, color: '--s3' }], { xmax, unit: 'N', xlabel: xl });
    lineChart($('chart-t'), h.axis, [{ data: h.tmax, color: '--s3' }], { xmax, unit: '°C', xlabel: xl });
    lineChart($('chart-ts'), h.axis, [{ data: h.flow.map((v) => (v == null ? null : Math.max(0, v))), color: '--s1' }, { data: h.axis.map(() => cfg.helix), color: '--s2', dot: false }],
      { xmax, unit: '°', xlabel: xl, empty: '切りくずができると表示します' });
    $('cf-a').textContent = '接線分力 Ft'; $('cf-b').textContent = '半径分力 Fr'; $('cf-c').textContent = '軸方向分力 Fa';
    $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span>';
    $('h-ts').innerHTML = '切りくず流出角 ηc<span><i style="background: var(--s1)"></i>計算値</span><span><i style="background: var(--s2)"></i>ねじれ角 β</span>';
    return;
  }
  if (d3) {
    const h = frame && frame.dim === 3 ? frame.hist : { axis: [], fc: [], ft: [], fr: [], tmax: [], flow: [] };
    const xmax = frame && frame.dim === 3 ? Math.max(cfg.cutLen, frame.summary.travel, ...h.axis) : cfg.cutLen;
    const xl = '横軸 工具の移動量 [mm]';
    lineChart($('chart-f'), h.axis, [{ data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }, { data: h.fr, color: '--s3' }], { xmax, unit: 'N', xlabel: xl });
    lineChart($('chart-t'), h.axis, [{ data: h.tmax, color: '--s3' }], { xmax, unit: '°C', xlabel: xl });
    lineChart($('chart-ts'), h.axis, [{ data: h.flow.map((v) => (v == null ? null : Math.max(0, v))), color: '--s1' }, { data: h.axis.map(() => cfg.lambda), color: '--s2', dot: false }],
      { xmax, unit: '°', xlabel: xl, empty: '切りくずができると表示します' });
    $('cf-a').textContent = '主分力 Fc'; $('cf-b').textContent = '背分力 Ft'; $('cf-c').textContent = '横分力 Fr';
    $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span>';
    $('h-ts').innerHTML = '切りくず流出角 ηc<span><i style="background: var(--s1)"></i>計算値</span><span><i style="background: var(--s2)"></i>傾き角 λ（Stabler の法則）</span>';
    return;
  }
  $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span><span><i style="background: var(--s1)"></i>すくい面接触部</span><span><i style="background: var(--s2)"></i>工具の最高</span>';
  $('h-ts').innerHTML = '工具表面の温度<span><i style="background: var(--s2)"></i>切削終了時点</span><span><i style="background: var(--s1)"></i>定常推定</span>';
  const mill = cfg && cfg.mode === 'mill';
  const h = frame ? frame.hist : { axis: [], fc: [], ft: [], tmax: [], trake: [], ttool: [] };
  const xmax = mill ? (frame ? Math.max(1, frame.summary.arc + frame.summary.track + 6) : 40) : cfg ? cfg.cutLen : 1;
  const xl = mill ? '横軸 刃の回転角 [°]' : '横軸 切削長さ [mm]';
  lineChart($('chart-f'), h.axis, [{ data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }], { xmax, unit: 'N', xlabel: xl });
  lineChart($('chart-t'), h.axis, [{ data: h.tmax, color: '--s3' }, { data: h.trake, color: '--s1' }, { data: h.ttool, color: '--s2' }], { xmax, unit: '°C', xlabel: xl });
  const pr = frame && frame.profile ? frame.profile.filter((r) => r.s > -400 && r.s < 500) : [];
  const ps = pr.map((r) => r.s), xr = pr.length ? [Math.min(...ps), Math.max(...ps)] : [-200, 300];
  lineChart($('chart-ts'), ps, [{ data: pr.map((r) => r.T), color: '--s2', dot: false }, { data: pr.map((r) => r.Tst), color: '--s1', dot: false }],
    { xmin: xr[0], xmax: xr[1], unit: '°C', xlabel: '逃げ面 ← 刃先からの距離 [µm] → すくい面', empty: '計算が終わると表示します' });
  lineChart($('chart-w'), ps, [{ data: pr.map((r) => r.wear), color: '--s3', dot: false }],
    { xmin: xr[0], xmax: xr[1], unit: 'µm/min', xlabel: '逃げ面 ← 刃先からの距離 [µm] → すくい面', empty: '計算が終わると表示します' });
  $('cf-a').textContent = mill ? '接線分力 Ft' : '主分力 Fc';
  $('cf-b').textContent = mill ? '半径分力 Fr' : '背分力 Ft';
}

// ---- Readouts ----
const f0 = (v) => v.toFixed(0), f1 = (v) => v.toFixed(1), f3 = (v) => v.toFixed(3);
const CELLS = {
  '3d': [
    ['主分力 Fc', (s) => f1(s.fc), 'N', () => '後半区間の平均'],
    ['背分力 Ft', (s) => f1(s.ft), 'N', () => '工具を押し上げる向き'],
    ['横分力 Fr', (s) => f1(s.fr), 'N', () => '切削方向に直角、表面内の向き'],
    ['比切削抵抗 kc', (s) => f0(s.kc), 'N/mm²', (s) => `便覧値の目安 ${s.kcRef}`],
    ['切りくず流出角 ηc', (s) => (s.flow == null ? '—' : f1(s.flow)), '°', (s) => `傾き角 λ = ${s.lambda}°（Stabler：ηc ≈ λ）`],
    ['切りくず厚さ hc', (s) => (s.ratio > 0 ? f3(s.hc) : '—'), 'mm', (s) => `切りくず厚さ比 ${s.ratio > 0 ? s.ratio.toFixed(2) : '—'}（中央部）`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', () => '工具への熱の逃げは含まない'],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', () => '切りくずの裏面付近'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量 / 工具がした仕事'],
    ['工具の移動量', (s) => f3(s.travel), 'mm', () => '傾けた刃が全幅にかかるまでを含む'],
    ['粒子数', (s) => s.N.toLocaleString(), '個', (s) => `間隔 ${s.dx.toFixed(0)} µm`],
    ['質量スケーリング', (s) => `×${f0(s.ms)}`, '', () => '慣性だけ密度を上げて高速化'],
  ],
  helix: [
    ['接線分力 Ft の最大', (s) => f1(s.ftMax), 'N', () => '1刃の通過中、刃の各点の接線方向の和'],
    ['半径分力 Fr の最大', (s) => f1(s.frMax), 'N', () => '工具の中心へ向かう向きが正'],
    ['軸方向分力 Fa', (s) => f1(s.faMax), 'N', () => '絶対値の最大。被削材をシャンク側へ引く向きが正'],
    ['接線方向の切削係数', (s) => (s.done ? f0(s.Ktc) : '—'), 'N/mm²', (s) => `エッジ係数 Kte ${s.done ? f1(s.Kte) : '—'} N/mm`],
    ['半径方向の切削係数', (s) => (s.done ? f0(s.Krc) : '—'), 'N/mm²', (s) => `エッジ係数 Kre ${s.done ? f1(s.Kre) : '—'} N/mm`],
    ['軸方向の切削係数', (s) => (s.done ? f0(s.Kac) : '—'), 'N/mm²', (s) => `エッジ係数 Kae ${s.done ? f1(s.Kae) : '—'} N/mm`],
    ['切りくず流出角 ηc', (s) => (s.flow == null ? '—' : f1(s.flow)), '°', (s) => `ねじれ角 β = ${s.helix}°（Stabler：ηc ≈ β）`],
    ['最大切取り厚さ', (s) => f3(s.hmax), 'mm', (s) => `接触角 ${f1(s.arc)}°、刃の遅れ ${f1(s.lag)}°`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', () => '工具への熱の逃げは含まない'],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', () => '切りくずの裏面付近'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量 / 工具がした仕事'],
    ['粒子数', (s) => s.N.toLocaleString(), '個', (s) => `間隔 ${s.dx.toFixed(0)} µm · 質量スケーリング ×${f0(s.ms)}`],
  ],
  ortho: [
    ['主分力 Fc', (s) => f0(s.fc), 'N', () => '後半区間の平均'],
    ['背分力 Ft', (s) => f0(s.ft), 'N', () => '工具を押し上げる向き'],
    ['比切削抵抗 kc', (s) => f0(s.kc), 'N/mm²', (s) => `便覧値の目安 ${s.kcRef}`],
    ['切りくず厚さ hc', (s) => (s.ratio > 0 ? f3(s.hc) : '—'), 'mm', (s) => `切りくず厚さ比 ${s.ratio > 0 ? s.ratio.toFixed(2) : '—'}`],
    ['せん断角 φ', (s) => (s.phi > 0 ? f1(s.phi) : '—'), '°', (s) => `Merchant の式 ${f1(s.phiMerchant)}°`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', (s) => `すくい面接触部 ${f0(s.trake)} °C`],
    ['工具の最高温度', (s) => f0(s.toolSteadyT ?? s.toolT), '°C', (s) => (s.toolSteadyT != null ? `定常推定。切削終了時点 ${f0(s.toolT)} °C` : '切削中の値（定常推定は終了後）')],
    ['クレーター摩耗速度', (s) => (s.done ? f1(s.wearCrater) : '—'), 'µm/min', () => 'すくい面の最大、Usui 式'],
    ['逃げ面摩耗速度', (s) => (s.done ? f1(s.wearFlank) : '—'), 'µm/min', () => '逃げ面の最大、Usui 式'],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', (s) => `最大ひずみ速度 ${s.edMax.toExponential(1)} /s`],
    ['工具へ流れる熱', (s) => f1(s.qTool), 'W', () => '摩擦熱の分担と接触面の熱伝導'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量 / 工具がした仕事'],
    ['切りくずのカール半径', (s) => (s.curl == null ? '—' : isFinite(s.curl) ? f3(s.curl) : '∞'), 'mm', (s) => (s.curl == null ? '切りくずが伸びると表示' : isFinite(s.curl) ? '円で近似した上向きカール' : 'ほぼまっすぐ')],
    ['分断した切りくず片', (s) => f0(s.pieces), '個', (s) => `刃先から離れて排出 ${s.evacuated} 粒子`],
    ['割れた粒子', (s) => f0(s.failed), '個', () => '損傷度 1 以上（延性破壊）'],
    ['実効すくい角', (s) => f1(s.toolRake), '°', () => '刃先から 0.3〜1.0 h の工具表面'],
  ],
  mill: [
    ['接線分力 Ft の最大', (s) => f0(s.ftMax), 'N', () => '1刃の通過中'],
    ['半径分力 Fr の最大', (s) => f0(s.frMax), 'N', () => '1刃の通過中'],
    ['最大切取り厚さ', (s) => f3(s.hmax), 'mm', (s) => `接触角 ${f1(s.arc)}°`],
    ['接線方向の切削係数', (s) => (s.done ? f0(s.Ktc) : '—'), 'N/mm²', (s) => `エッジ係数 Kte ${s.done ? f1(s.Kte) : '—'} N/mm`],
    ['半径方向の切削係数', (s) => (s.done ? f0(s.Krc) : '—'), 'N/mm²', (s) => `エッジ係数 Kre ${s.done ? f1(s.Kre) : '—'} N/mm`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', (s) => `すくい面接触部の最大 ${f0(s.trake)} °C`],
    ['工具の最高温度', (s) => f0(s.toolT), '°C', () => '1刃の通過中の値'],
    ['クレーター摩耗速度', (s) => (s.done ? f1(s.wearCrater) : '—'), 'µm/min', () => '接触中の値、Usui 式'],
    ['逃げ面摩耗速度', (s) => (s.done ? f1(s.wearFlank) : '—'), 'µm/min', () => '接触中の値、Usui 式'],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', (s) => `最大ひずみ速度 ${s.edMax.toExponential(1)} /s`],
    ['刃の回転角', (s) => f1(s.angle), '°', () => '最下点から'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量 / 工具がした仕事'],
    ['切りくずの排出速度', (s) => (s.ejectV == null ? '—' : f0(s.ejectV)), 'm/min', (s) => (s.ejectAng == null ? '刃が抜けて切りくずが離れると表示' : `出口の接線から ${f0(s.ejectAng)}°（外向きが正）`)],
    ['分断した切りくず片', (s) => f0(s.pieces), '個', (s) => `刃先から離れて排出 ${s.evacuated} 粒子`],
    ['割れた粒子', (s) => f0(s.failed), '個', () => '損傷度 1 以上（延性破壊）'],
    ['実効すくい角', (s) => f1(s.toolRake), '°', () => '刃先から 0.3〜1.0 h の工具表面'],
  ],
};
function buildCells() {
  const root = $('results');
  root.replaceChildren();
  CELLS[cfg.mode].forEach(([k, , unit], i) => {
    const d = document.createElement('div');
    d.className = 'cell';
    d.innerHTML = `<span class="k"></span><span class="v"><b id="rv${i}">—</b>${unit ? `<small>${unit}</small>` : ''}</span><span class="sub" id="rs${i}">—</span>`;
    d.querySelector('.k').textContent = k;
    root.appendChild(d);
  });
}
// Cutting coefficients in the 3-axis simulator's material format (linear edge-force model).
function exportCoeffs() {
  const s = frame.summary, c = cfg, r = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const out = {
    source: 'cutting-sim', mode: c.mode, material: c.mat,
    conditions: { vc: c.vc, D: c.D, flutes: c.z, fz: c.fz, ae: c.ae, ap: c.mode === 'helix' ? c.ap : c.width, helix: c.mode === 'helix' ? c.helix : 0,
      dir: c.dir, rake: c.rake, edgeRadius: c.edgeRadius },
    coefficients: { Ktc: r(s.Ktc), Krc: r(s.Krc), Kac: c.mode === 'helix' ? r(s.Kac) : null, Kte: r(s.Kte), Kre: r(s.Kre), Kae: c.mode === 'helix' ? r(s.Kae) : null },
    units: { K_c: 'N/mm²', K_e: 'N/mm' },
  };
  const text = JSON.stringify(out, null, 2);
  try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (e) { /* clipboard may be blocked */ }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `coeffs_${c.mat}_${c.mode}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  $('exhint').textContent = 'JSON を保存し、クリップボードにもコピーしました。';
}
$('export').addEventListener('click', exportCoeffs);

function readouts() {
  const s = frame.summary, has = s.steps > 0;
  $('export').disabled = !(s.done && (cfg.mode === 'mill' || cfg.mode === 'helix'));
  CELLS[cfg.mode].forEach(([, v, , sub], i) => {
    $(`rv${i}`).textContent = has ? v(s) : '—';
    $(`rs${i}`).textContent = has ? sub(s) : '—';
  });
  $('prog').style.width = s.progress * 100 + '%';
  $('clock').textContent = (cfg.mode === 'helix' ? `回転角 ${f1(s.angle)}° · ${f0(s.progress * 100)} % · ` : cfg.mode === 'mill' ? `回転角 ${f1(s.angle)}° · ` : cfg.mode === '3d' ? `移動 ${f3(s.travel)} mm · ${f0(s.progress * 100)} % · ` : `${f3(s.travel)} / ${cfg.cutLen.toFixed(2)} mm · `)
    + `${(s.t * 1e6).toFixed(1)} µs · 計算 ${(frame.wall / 1000).toFixed(0)} s`;
  $('meta').textContent = `粒子 ${s.N.toLocaleString()} 個 · 間隔 ${s.dx.toFixed(1)} µm · 質量スケーリング ×${s.ms.toFixed(0)} · Δt ${(frame.dt * 1e9).toFixed(1)} ns · ${s.steps.toLocaleString()} ステップ`
    + (is3(cfg.mode) ? ' · 3D は計算に数分〜十数分かかります' : '');
}

reset();
