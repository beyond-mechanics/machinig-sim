// UI: condition form, particle field view (Canvas 2D), charts and readouts.
import { MATERIALS } from './materials.js';
import { DEFAULTS } from './sph.js';
import { chamferProfile, breakerProfile, importProfile, wornProfile, importWorkpiece } from './profile.js';
import { makeTool, toolOutline } from './tool.js';
import { View3D } from './view3d.js';
import { renderField, legendGradient, bandsOf } from './fieldview.js';
import { parseSTL, bounds, volume, weld } from './mesh.js';
import { EXAMPLES } from './examples3d.js';

const $ = (id) => document.getElementById(id);
const workerUrl = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
const worker = new Worker(workerUrl);

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
  seq: { label: 'ミーゼス応力', unit: 'MPa', map: 'turbo', fmt: (v) => v.toFixed(0), smooth: 1.6 },
  ep: { label: '相当塑性ひずみ', unit: '', map: 'turbo', fmt: (v) => v.toFixed(2) },
  sr: { label: 'ひずみ速度', unit: 'log₁₀ 1/s', map: 'turbo', fmt: (v) => v.toFixed(1), log: true },
  p: { label: '静水圧', unit: 'MPa', map: 'div', fmt: (v) => v.toFixed(0), smooth: 1.6 },
  D: { label: '損傷度', unit: '1 で割れ始め', map: 'turbo', fmt: (v) => v.toFixed(1) },
};

// ---- State ----
let frame = null, field = 'T', zoom = 'tip', status = 'idle', cfg = null, mode = 'ortho', runN = 0;
// Field picture: 'bands' (contour bands, as in FE post-processing), 'smooth', or 'particles'.
let render = 'bands';
try { render = localStorage.getItem('cutting-sim.render') || render; } catch (e) { /* storage blocked */ }
const is3 = (m = mode) => m === '3d' || m === 'helix' || m === 'mesh';   // 3D solver modes
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
  if (mode === 'mesh') stlInfo();
  reset();
});

function readCfg() {
  const num = (id) => parseFloat($(id).value);
  const shape = $('shape').value;
  if (mode === 'helix') return {
    mode, mat: matSel.value, vc: num('vc'), rake: num('rake'), clearance: num('clear'), edgeRadius: num('edge'), mu: num('mu'), friction: $('fric').value, nh: num('res'),
    D: num('dia'), z: num('flutes'), fz: num('fz'), ae: num('ae'), ap: num('ap'), helix: num('helix'), floor: $('floor').checked, dir: $('dir').value, track: num('track'), passes: num('passes'), fracture: $('fracture').checked, efScale: num('efs'), flowScale: num('fls'),
  };
  if (mode === 'mesh') {
    const mot = $('smotion').value, off = [num('sox'), num('soy'), num('soz')].map((v) => (v || 0) * 1e-3);
    const toM = (t, o) => { if (!t) return null; const r = new Float64Array(t.length); for (let i = 0; i < t.length; i++) r[i] = t[i] * 1e-3 + o[i % 3]; return r; };
    return {
      mode, mat: matSel.value, vc: num('vc'), mu: num('mu'), friction: $('fric').value, fracture: $('fracture').checked, efScale: num('efs'), flowScale: num('fls'),
      motion: mot, spin: parseFloat($('sspin').value), z: num('sflutes'), fz: num('sfz'), fr: num('sfr'), travel: num('stravel'), angle: num('sangle'), dxUm: num('sdx'), hold: $('shold').value,
      toolTris: toM(stl.tool && stl.tool.t, off), workTris: toM(stl.work && stl.work.t, [0, 0, 0]), maxN: STL_MAX, axis: stlAxis() && stlAxis().map((v) => v * 1e-3),
    };
  }
  if (mode === '3d') return {
    mode, mat: matSel.value, vc: num('vc'), h: num('h'), b: num('b3'), lambda: num('lambda'), rake: num('rake'),
    clearance: num('clear'), edgeRadius: num('edge'), mu: num('mu'), friction: $('fric').value, nh: num('res'), cutLen: num('len'), sides: $('sides').value, fracture: $('fracture').checked, efScale: num('efs'), flowScale: num('fls'),
  };
  return {
    mode, mat: matSel.value, vc: num('vc'), h: num('h'), rake: num('rake'), clearance: num('clear'),
    edgeRadius: num('edge'), mu: num('mu'), friction: $('fric').value, width: num('width'), cutLen: num('len'), nh: num('res'),
    D: num('dia'), z: num('flutes'), fz: num('fz'), ae: num('ae'), dir: $('dir').value, track: num('track'), passes: num('passes'),
    tool: shape === 'custom' && !custom.profile ? 'wedge' : shape, land: num('land'), landDeg: num('landDeg'),
    gw: num('gw'), gd: num('gd'), wallDeg: num('wallDeg'), wh: num('wh'), profile: shape === 'custom' ? custom.profile : null,
    fracture: $('fracture').checked, efScale: num('efs'), flowScale: num('fls'), work: useWork() ? work.loops : null,
    residual: mode === 'ortho' && $('residual').checked && !useWork(), preheat: mode === 'ortho' && $('preheat').checked ? 2 : 0,
  };
}
for (const id of ['vc', 'h', 'rake', 'clear', 'edge', 'mu', 'fric', 'width', 'len', 'res', 'dia', 'flutes', 'fz', 'ae', 'dir', 'track', 'passes',
  'land', 'landDeg', 'gw', 'gd', 'wallDeg', 'wh', 'fracture', 'efs', 'fls', 'b3', 'lambda', 'sides', 'ap', 'helix', 'floor', 'residual', 'preheat',
  'sspin', 'sflutes', 'sfz', 'sfr', 'stravel', 'sangle', 'shold']) $(id).addEventListener('change', reset);

// ---- STL mode: an imported tool and work (closed meshes, z up), or one of the built-in examples ----
const stl = { tool: null, work: null, ok: false };   // tool / work: { t: triangles [mm], name, open, tri }
const STL_MAX = 150000;   // particles
const UNIT = { mm: 1, um: 1e-3, in: 25.4 };
for (const [k, e] of Object.entries(EXAMPLES)) $('sex').appendChild(new Option(e.name, k));
const meshPart = (t, name, file) => ({ t, name, file, open: weld(t).open, tri: t.length / 9 });
async function loadStl(key, f) {
  try { stl[key] = meshPart(parseSTL(await f.arrayBuffer(), UNIT[$('sunit').value]), f.name, f); }
  catch (err) { stl[key] = { err: `${f.name}：${err.message}`, file: f }; }
}
for (const [id, key] of [['stool', 'tool'], ['swork', 'work']]) $(id).addEventListener('change', async () => {
  const f = $(id).files[0];
  if (!f) return;
  $('sex').value = '';
  await loadStl(key, f);
  stlInfo(); reset();
});
$('sunit').addEventListener('change', async () => {
  for (const k of ['tool', 'work']) if (stl[k] && stl[k].file) await loadStl(k, stl[k].file);
  stlInfo(); reset();
});
$('sex').addEventListener('change', () => {
  const e = EXAMPLES[$('sex').value];
  if (!e) return;
  stl.tool = meshPart(e.tool(), '例の工具'); stl.work = meshPart(e.work(), '例のワーク');
  $('stool').value = ''; $('swork').value = ''; $('sunit').value = 'mm';
  const c = e.cfg;
  $('smotion').value = c.motion; $('sdx').value = c.dxUm;
  if (c.travel) $('stravel').value = c.travel;
  if (c.angle) $('sangle').value = c.angle;
  if (c.z) $('sflutes').value = c.z;
  if (c.fz) $('sfz').value = c.fz;
  if (c.fr) $('sfr').value = c.fr;
  for (const id of ['sox', 'soy', 'soz']) $(id).value = 0;
  $('shold').value = c.hold || 'bottom';
  $('sax').value = c.axis ? c.axis[0] : ''; $('say').value = c.axis ? c.axis[1] : '';
  showShapeRows(); stlInfo(); reset();
});
$('smotion').addEventListener('change', () => { showShapeRows(); stlInfo(); reset(); });
for (const id of ['sdx', 'sox', 'soy', 'soz', 'sax', 'say']) $(id).addEventListener('change', () => { stlInfo(); reset(); });
for (const id of ['vc', 'sflutes', 'sfz', 'sfr', 'stravel']) $(id).addEventListener('change', stlInfo);
// Spin axis given in the form [mm], or null for the centre of the tool's outline.
function stlAxis() {
  const x = parseFloat($('sax').value), y = parseFloat($('say').value);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
function stlCount() {
  const dx = parseFloat($('sdx').value) * 1e-3;
  return stl.work && stl.work.t ? Math.round(Math.abs(volume(stl.work.t)) / (dx * dx * dx)) : 0;
}
// What was read, the particle count, the spindle speed and feed it gives, and what looks wrong.
function stlInfo() {
  const el = $('sinfo'), msg = [], bad = [];
  const mm = (b) => `${(b[3] - b[0]).toFixed(2)} × ${(b[4] - b[1]).toFixed(2)} × ${(b[5] - b[2]).toFixed(2)} mm`;
  const off = ['sox', 'soy', 'soz'].map((id) => parseFloat($(id).value) || 0);
  for (const [k, lab] of [['tool', '工具'], ['work', 'ワーク']]) {
    const m = stl[k];
    if (!m) { msg.push(`${lab}：未選択`); continue; }
    if (m.err) { bad.push(m.err); continue; }
    const b = bounds(m.t);
    if (k === 'tool') for (let i = 0; i < 3; i++) { b[i] += off[i]; b[i + 3] += off[i]; }
    m.b = b;
    msg.push(`${lab}：${m.name}、三角形 ${m.tri.toLocaleString()}、${mm(b)}`);
    if (m.open) bad.push(`${lab}の形が閉じていません（相手のない縁 ${m.open} 本）。閉じた STL にしてください`);
  }
  const a = stl.tool && stl.tool.b, w = stl.work && stl.work.b;
  if (a && w && !stl.tool.err && !stl.work.err) {
    const n = stlCount();
    msg.push(`粒子 約 ${n.toLocaleString()} 個`);
    if (n > STL_MAX) bad.push(`粒子が ${STL_MAX.toLocaleString()} 個を超えます。間隔を広げるか、ワークを小さくしてください`);
    const reach = $('smotion').value === 'linear' ? parseFloat($('stravel').value) || 0 : 0;   // the straight tool sweeps +x
    if (a[3] + reach < w[0] || a[0] > w[3] || a[4] < w[1] || a[1] > w[4] || a[5] < w[2] || a[2] > w[5]) bad.push('工具とワークが離れています。工具をワークに食い込ませた位置に置いてください');
    const mot = $('smotion').value;
    if (mot !== 'linear') {
      const ga = stlAxis(), ax = ga ? ga[0] : 0.5 * (a[0] + a[3]), ay = ga ? ga[1] : 0.5 * (a[1] + a[4]), t = stl.tool.t;
      let R = 0;
      for (let i = 0; i < t.length; i += 3) R = Math.max(R, Math.hypot(t[i] + off[0] - ax, t[i + 1] + off[1] - ay));
      const rpm = parseFloat($('vc').value) * 1e3 / (2 * Math.PI * R);
      const vf = (mot === 'mill' ? parseFloat($('sfz').value) * parseFloat($('sflutes').value) : parseFloat($('sfr').value)) * rpm;
      msg.push(`回転軸 (${ax.toFixed(2)}, ${ay.toFixed(2)})、半径 ${R.toFixed(3)} mm → ${Math.round(rpm).toLocaleString()} min⁻¹、送り ${Math.round(vf).toLocaleString()} mm/min`);
    }
  } else bad.length || msg.push('工具とワークの両方を選んでください');
  el.textContent = [...msg, ...bad].join('。') + '。';
  el.classList.toggle('err', bad.length > 0);
  stl.ok = !!(a && w) && bad.length === 0;
}

// ---- Workpiece cross-section (orthogonal cutting): a flat block or an imported outline ----
const work = { text: null, name: '', rot: 0, flip: false, loops: null, info: null };
const WORK_MAX = 60000;   // particles
const useWork = () => mode === 'ortho' && $('wshape').value === 'custom' && !!work.loops && workCount() <= WORK_MAX;
function workCount() {
  if (!work.info) return 0;
  const dx = parseFloat($('h').value) / parseFloat($('res').value);
  return Math.round(work.info.area * 1e6 / (dx * dx));
}
function loadWork() {
  const info = $('winfo');
  info.classList.remove('err');
  if (work.text == null) { work.loops = null; work.info = null; info.textContent = 'ファイルを選んでください。'; drawWork(); return; }
  try {
    const r = importWorkpiece(work.text, { name: work.name, unit: $('wunit').value, rot: work.rot, flip: work.flip });
    work.loops = r.loops; work.info = r.info;
    const i = r.info, n = workCount();
    info.textContent = `${work.name}：輪郭 ${i.loops} 本${i.loops > 1 ? '（内側は穴）' : ''}、幅 ${(i.width * 1e3).toFixed(2)} × 高さ ${(i.height * 1e3).toFixed(2)} mm、粒子 約 ${n.toLocaleString()} 個` +
      (n > WORK_MAX ? `。${WORK_MAX.toLocaleString()} 個を超えるので計算できません（解像度を下げるか、ワークを小さく）` : '');
    if (n > WORK_MAX) info.classList.add('err');
  } catch (err) {
    work.loops = null; work.info = null; info.textContent = err.message; info.classList.add('err');
  }
  drawWork();
}
// Section with the tool path (y = −h) and the cut length.
function drawWork() {
  const cv = $('wpreview'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || cv.hidden) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  if (!work.loops) return;
  const i = work.info, h = parseFloat($('h').value) * 1e-3, L = parseFloat($('len').value) * 1e-3;
  const spanX = Math.max(i.width, L) * 1.1, spanY = i.height * 1.25 + 2 * h;
  const s = Math.min((W - 12) / spanX, (H - 22) / spanY), X = (x) => 6 + x * s, Y = (y) => 16 + (h * 1.2 - y) * s;
  c.beginPath();
  for (const l of work.loops) l.forEach(([x, y], k) => (k ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))));
  c.closePath(); c.fillStyle = css.getPropertyValue('--rule'); c.fill('evenodd');
  c.strokeStyle = css.getPropertyValue('--ink-mute'); c.lineWidth = 1; c.stroke();
  c.setLineDash([4, 3]); c.strokeStyle = css.getPropertyValue('--accent') || '#c33'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(X(0), Y(-h)); c.lineTo(X(L), Y(-h)); c.stroke(); c.setLineDash([]);
  c.fillStyle = css.getPropertyValue('--ink-mute'); c.font = `11px ${css.getPropertyValue('--font-mono')}`;
  c.textAlign = 'left'; c.fillText(`刃先の通り道（y = −h、${(L * 1e3).toFixed(1)} mm）→`, 6, 11);
}
$('wshape').addEventListener('change', () => { showShapeRows(); loadWork(); reset(); });
$('wfile').addEventListener('change', async () => {
  const f = $('wfile').files[0];
  if (!f) return;
  work.text = await f.text(); work.name = f.name; work.rot = 0; work.flip = false;
  loadWork();
  // Cut across the part by default: its width less a little run-out.
  if (work.info) $('len').value = Math.min(4, Math.max(0.2, Math.floor((work.info.width * 1e3 - 0.1) * 10) / 10));
  reset();
});
$('wunit').addEventListener('change', () => { loadWork(); reset(); });
$('wrot').addEventListener('click', () => { work.rot = (work.rot + 1) % 4; loadWork(); reset(); });
$('wflip').addEventListener('click', () => { work.flip = !work.flip; loadWork(); reset(); });
for (const id of ['h', 'res', 'len']) $(id).addEventListener('change', () => { if (work.loops) loadWork(); });

// ---- Tool shape: built-in edge preparations or an imported outline, with a preview ----
const custom = { text: null, name: '', rot: 0, flip: false, profile: null, wornMin: 0 };
// Visibility: data-only lists the modes an element belongs to, data-shape the tool shapes
// (3D supports only the standard wedge).
function showShapeRows() {
  const sh = mode === 'mesh' ? 'mesh' : is3() ? 'wedge' : $('shape').value;
  const ws = $('wshape').value, mot = $('smotion').value;
  for (const el of document.querySelectorAll('[data-only], [data-shape], [data-wshape], [data-motion]')) {
    const okMode = !el.dataset.only || el.dataset.only.split(' ').includes(mode);
    const okShape = !el.dataset.shape || el.dataset.shape.split(' ').includes(sh);
    const okWork = !el.dataset.wshape || el.dataset.wshape === ws;
    const okMot = !el.dataset.motion || el.dataset.motion.split(' ').includes(mot);
    el.hidden = !(okMode && okShape && okWork && okMot);
  }
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
  custom.text = await f.text(); custom.name = f.name; custom.rot = 0; custom.flip = false; custom.wornMin = 0;
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

// The last finished run of each mode, drawn dashed under the current one for comparison.
let prev = null;
function reset() {
  if (frame && frame.summary && frame.summary.done) prev = { mode: cfg.mode, hist: frame.hist };
  cfg = readCfg();
  drawPreview(); drawWork();
  status = 'idle'; frame = null;
  // STL mode without a usable tool and work: nothing to compute yet (the form says why).
  if (cfg.mode === 'mesh') stlInfo();
  if (cfg.mode === 'mesh' && !stl.ok) { cfg.blocked = true; if (v3) v3.clear(); buildCells(); updateRunButton(); drawCharts(); return; }
  worker.postMessage({ type: 'init', cfg });
  buildCells();
  updateRunButton();
}
$('run').addEventListener('click', () => {
  if (status === 'running') { worker.postMessage({ type: 'pause' }); status = 'paused'; }
  else if (status === 'done') { reset(); worker.postMessage({ type: 'run', n: ++runN }); status = 'running'; }
  else { worker.postMessage({ type: 'run', n: ++runN }); status = 'running'; }
  updateRunButton();
});
$('reset').addEventListener('click', reset);
function updateRunButton() {
  const b = $('run');
  b.textContent = status === 'running' ? '一時停止' : status === 'paused' ? '再開' : status === 'done' ? 'もう一度' : '切削開始';
  b.disabled = !!(cfg && cfg.blocked);
  const pill = $('state');
  pill.dataset.s = status;
  pill.textContent = { idle: '待機', running: '計算中', paused: '一時停止', done: '完了' }[status];
  const w = frame && frame.warm;
  if (w && w[1] > 0 && status !== 'done' && status !== 'idle') pill.textContent += w[0] < w[1] ? `（工具を温め中 ${w[0] + 1}/${w[1]}）` : '（温めた工具で本番）';
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
for (const b of document.querySelectorAll('[data-render]')) {
  b.setAttribute('aria-pressed', b.dataset.render === render);
  b.addEventListener('click', () => {
    render = b.dataset.render;
    for (const c of document.querySelectorAll('[data-render]')) c.setAttribute('aria-pressed', c === b);
    try { localStorage.setItem('cutting-sim.render', render); } catch (e) { /* storage blocked */ }
    draw();
  });
}
let section = false, meshTris = null;
$('section').addEventListener('click', () => { section = !section; $('section').setAttribute('aria-pressed', section); draw(); });

worker.onmessage = (e) => {
  if (e.data.type !== 'frame') return;
  frame = e.data;
  // The imported tool's triangles come with the first frame of a run only: keep them for the view.
  const tl = frame.tool;
  if (tl && tl.mesh) { if (tl.tris) meshTris = { id: tl.id, tris: tl.tris }; else if (meshTris && meshTris.id === tl.id) tl.tris = meshTris.tris; }
  // A frame sent before the worker saw the latest run request (the one from a reset just before
  // the click, when an edited field loses focus to the button) must not read as a pause.
  if (status === 'running' && !frame.running && frame.runN === runN) status = frame.summary.done ? 'done' : 'paused';
  // Draw only the newest frame, once per display refresh: frames can arrive faster than a 3D
  // surface is drawn, and a backlog would make the page lag ever further behind.
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; if (!frame) return; updateRunButton(); draw(); drawCharts(); readouts(); });
};
let drawPending = false;

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
// Upsampled 6× with bilinear interpolation (cells outside the tool take their inside neighbours),
// so the bands and their lines run as smoothly as in the workpiece.
function toolBitmap(lo, hi, nb) {
  const g = frame.toolGrid, lut = LUT.turbo, up = 6, W = g.nu * up, H = g.nw * up;
  toolCanvas.width = W; toolCanvas.height = H;
  const c = toolCanvas.getContext('2d'), img = c.createImageData(W, H), d = img.data;
  // Fill outside cells with the mean of their inside neighbours (one ring) so interpolation near
  // the surface does not pull in the 0 of empty cells.
  const T = Float32Array.from(g.T), ins = Uint8Array.from(g.inside);
  for (let j = 0; j < g.nw; j++) for (let i = 0; i < g.nu; i++) {
    const k = i + j * g.nu; if (g.inside[k]) continue;
    let sum = 0, n = 0;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < g.nu && jj < g.nw && g.inside[ii + jj * g.nu]) { sum += g.T[ii + jj * g.nu]; n++; } }
    if (n) { T[k] = sum / n; ins[k] = 2; }
  }
  const band = new Int16Array(W * H).fill(-1), inv = 1 / (hi - lo);
  for (let Y = 0; Y < H; Y++) {
    const gy = (Y + 0.5) / up - 0.5, j = Math.max(0, Math.min(g.nw - 2, Math.floor(gy))), fy = Math.min(1, Math.max(0, gy - j));
    for (let X = 0; X < W; X++) {
      const gx = (X + 0.5) / up - 0.5, i = Math.max(0, Math.min(g.nu - 2, Math.floor(gx))), fx = Math.min(1, Math.max(0, gx - i));
      const k = i + j * g.nu, cells = [k, k + 1, k + g.nu, k + g.nu + 1], wts = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let v = 0, w = 0;
      for (let q = 0; q < 4; q++) if (ins[cells[q]]) { v += wts[q] * T[cells[q]]; w += wts[q]; }
      if (!(w > 0)) continue;
      let u = (v / w - lo) * inv; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const bi = nb ? Math.min(nb - 1, Math.floor(u * nb)) : 0;
      const col = lut[nb ? Math.round(bi / (nb - 1) * 255) : Math.round(u * 255)], o = (X + Y * W) * 4;
      band[X + Y * W] = bi; d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }
  if (nb) for (let Y = 0; Y < H - 1; Y++) for (let X = 0; X < W - 1; X++) {
    const p = X + Y * W, b0 = band[p];
    if (b0 < 0) continue;
    const br = band[p + 1], bd = band[p + W];
    if ((br >= 0 && br !== b0) || (bd >= 0 && bd !== b0)) { const o = p * 4; d[o] *= 0.62; d[o + 1] *= 0.62; d[o + 2] *= 0.62; }
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
  const nb = render === 'particles' ? 0 : bandsOf(render);
  if (render === 'particles' || !renderField(vctx, frame, xf, vals, lo, hi, lut, render, FIELDS[field].smooth || 1)) drawParticles(vals, lo, hi, lut);
  drawOverlays(lo, hi, nb, wx0, wx1);
}
function drawParticles(vals, lo, hi, lut) {
  const { s, ox, oy } = xf, cw = view.width, ch = view.height;
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
}
function drawOverlays(lo, hi, nb, wx0, wx1) {
  const { s, ox, oy, dpr } = xf, cw = view.width, ch = view.height, hmm = frame.h, [tx, ty, , th] = frame.tip;
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
    const tg = frame.toolGrid, bmp = toolBitmap(lo, hi, nb);
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
  $('lg-bar').style.background = legendGradient(LUT[f.map], nb);
  $('lg-lo').textContent = f.fmt(lo); $('lg-hi').textContent = f.fmt(hi);
  $('lg-name').textContent = (f.unit ? `${f.label} [${f.unit}]` : f.label) + (field === 'T' ? (frame.toolGrid.steady ? '・工具は定常推定' : '・工具を含む') : '');
}
new ResizeObserver(() => { draw(); drawCharts(); }).observe(view);

function draw3d() {
  const vals = fieldValues(field), [lo, hi] = range(field, vals), f = FIELDS[field];
  view3d().update(frame, vals, lo, hi, LUT[f.map], section, render === 'particles' ? -1 : bandsOf(render));
  $('lg-bar').style.background = legendGradient(LUT[f.map], render === 'particles' ? 0 : bandsOf(render));
  $('lg-lo').textContent = f.fmt(lo); $('lg-hi').textContent = f.fmt(hi);
  $('lg-name').textContent = (f.unit ? `${f.label} [${f.unit}]` : f.label) + (section ? '・中央断面' : '') + '・ドラッグで回転';
}
new ResizeObserver(() => { if (cfg) drawPreview(); }).observe($('preview'));
new ResizeObserver(() => drawWork()).observe($('wpreview'));

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
function lineChart(canvas, xs, series, { xmin = 0, xmax, unit, xlabel, empty, signed = false, marks = [] }) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  const L = 48, R = 12, T = 18, B = 26, pw = W - L - R, ph = H - T - B;
  // signed: the axis also covers negative values (residual stress).
  let ymax = 0, ymin = 0;
  for (const s of series) for (const v of s.data) { if (v > ymax) ymax = v; if (signed && v < ymin) ymin = v; }
  if (!(ymax > 0) && !(ymin < 0)) ymax = 1;
  const ystep = niceStep(ymax - ymin, 4); ymax = Math.ceil(ymax / ystep - 1e-9) * ystep; ymin = Math.floor(ymin / ystep + 1e-9) * ystep;
  const span = xmax - xmin, xstep = niceStep(span, pw < 320 ? 3 : 5);
  const X = (v) => L + (v - xmin) / span * pw, Y = (v) => T + ph - (v - ymin) / (ymax - ymin) * ph;
  c.font = `11px ${css.getPropertyValue('--font-mono')}`; c.fillStyle = css.getPropertyValue('--ink-mute');
  c.strokeStyle = css.getPropertyValue('--rule'); c.lineWidth = 1;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let v = ymin; v <= ymax + 1e-9; v += ystep) {
    c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + pw, Y(v)); c.stroke();
    c.fillText(ystep < 0.01 ? v.toFixed(3) : ystep < 0.1 ? v.toFixed(2) : ystep < 1 ? v.toFixed(1) : v.toFixed(0), L - 6, Y(v));
  }
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (let v = Math.ceil(xmin / xstep) * xstep; v <= xmax + 1e-9; v += xstep) c.fillText(Math.abs(v) < 1e-9 ? '0' : xstep < 0.1 ? v.toFixed(2) : xstep < 1 ? v.toFixed(1) : v.toFixed(0), X(v), T + ph + 6);
  c.textAlign = 'left'; c.fillText(unit, 4, 0);
  c.textAlign = 'right'; c.fillText(xlabel, L + pw, 0);
  // marks: vertical dashed lines with a label (where the next tooth starts).
  c.textAlign = 'left'; c.setLineDash([3, 3]);
  for (const m of marks) {
    if (m.x < xmin || m.x > xmax) continue;
    c.beginPath(); c.moveTo(X(m.x), T); c.lineTo(X(m.x), T + ph); c.stroke();
    c.fillText(m.label, X(m.x) + 3, T + 2);
  }
  c.setLineDash([]);
  if (empty && !series.some((s) => s.data.length)) { c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(empty, L + pw / 2, T + ph / 2); return; }
  for (const s of series) {
    if (!s.data.length) continue;
    const sx = s.xs || xs;
    c.strokeStyle = css.getPropertyValue(s.color); c.lineWidth = s.dash ? 1.25 : 2; c.setLineDash(s.dash ? [5, 4] : []); c.beginPath();
    let started = false;
    s.data.forEach((v, i) => { if (v == null || sx[i] < xmin || sx[i] > xmax) return; if (started) c.lineTo(X(sx[i]), Y(v)); else { c.moveTo(X(sx[i]), Y(v)); started = true; } });
    c.stroke(); c.setLineDash([]);
    if (s.dash) continue;
    const i = s.data.length - 1;
    if (s.data[i] != null && s.dot !== false) { c.fillStyle = css.getPropertyValue(s.color); c.beginPath(); c.arc(X(xs[i]), Y(s.data[i]), 3, 0, 7); c.fill(); }
  }
}
// Wear rate along the tool surface (the mean section in 3D), once the cut is done.
function wearChart() {
  const pr = frame && frame.profile ? frame.profile.filter((r) => r.s > -400 && r.s < 500) : [];
  const ps = pr.map((r) => r.s), xr = pr.length ? [Math.min(...ps), Math.max(...ps)] : [-200, 300];
  lineChart($('chart-w'), ps, [{ data: pr.map((r) => r.wear), color: '--s3', dot: false }],
    { xmin: xr[0], xmax: xr[1], unit: 'µm/min', xlabel: '逃げ面 ← 刃先からの距離 [µm] → すくい面', empty: '計算が終わると表示します' });
}
function drawCharts() {
  const d3 = cfg && cfg.mode === '3d', hx = cfg && cfg.mode === 'helix';
  const on = prev && cfg && prev.mode === cfg.mode && $('overlay').checked;
  const pv = (key, color) => (on && prev.hist[key] ? [{ data: prev.hist[key], xs: prev.hist.axis, color, dash: true }] : []);
  $('cf-prev').hidden = !on;
  $('cf-c-wrap').hidden = !(d3 || hx || (cfg && cfg.mode === 'mesh'));
  if (cfg && cfg.mode === 'mesh') {
    const h = frame && frame.mesh ? frame.hist : { axis: [], fc: [], ft: [], fr: [], tmax: [], mz: [] }, lin = cfg.motion === 'linear';
    const xmax = lin ? Math.max(cfg.travel, ...h.axis) : Math.max(cfg.angle, ...h.axis);
    const xl = lin ? '横軸 工具の移動量 [mm]' : '横軸 工具の回転角 [°]';
    lineChart($('chart-f'), h.axis, [...pv('fc', '--s1'), ...pv('ft', '--s2'), ...pv('fr', '--s3'), { data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }, { data: h.fr, color: '--s3' }], { xmax, unit: 'N', xlabel: xl, signed: true });
    lineChart($('chart-t'), h.axis, [...pv('tmax', '--s3'), { data: h.tmax, color: '--s3' }], { xmax, unit: '°C', xlabel: xl });
    lineChart($('chart-ts'), h.axis, lin ? [] : [...pv('mz', '--s1'), { data: (h.mz || []).map((v) => v * 1e3), color: '--s1' }],
      { xmax, unit: 'mN·m', xlabel: xl, empty: lin ? '直進する工具にはトルクがありません' : '計算を始めると表示します' });
    $('cf-a').textContent = 'Fx'; $('cf-b').textContent = 'Fy'; $('cf-c').textContent = 'Fz';
    $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span>';
    $('h-ts').innerHTML = '主軸トルク<span><i style="background: var(--s1)"></i>回転を妨げる向きが正</span>';
    return;
  }
  if (hx) {
    const h = frame && frame.dim === 3 ? frame.hist : { axis: [], fc: [], ft: [], fr: [], tmax: [], flow: [] };
    const sm = frame && frame.dim === 3 ? frame.summary : null, np = sm && sm.passes > 1 ? sm.passes : 1;
    const xmax = sm ? Math.max(1, (np - 1) * sm.span + sm.arc + sm.lag + sm.track + 6) : 40;
    const xl = np > 1 ? '横軸 刃の回転角 [°]（下端の刃、刃ごとに続けて表示）' : '横軸 刃の回転角 [°]（下端の刃、最下点から）';
    const marks = [];
    if (np > 1 && h.pass) for (let i = 1; i < h.pass.length; i++) if (h.pass[i] !== h.pass[i - 1]) marks.push({ x: h.axis[i], label: `${h.pass[i] + 1}刃目` });
    lineChart($('chart-f'), h.axis, [...pv('fc', '--s1'), ...pv('ft', '--s2'), ...pv('fr', '--s3'), { data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }, { data: h.fr, color: '--s3' }], { xmax, unit: 'N', xlabel: xl, marks });
    lineChart($('chart-t'), h.axis, [...pv('tmax', '--s3'), ...pv('ttool', '--s2'), { data: h.tmax, color: '--s3' }, { data: h.ttool || [], color: '--s2' }], { xmax, unit: '°C', xlabel: xl, marks });
    wearChart();
    lineChart($('chart-ts'), h.axis, [{ data: h.flow.map((v) => (v == null ? null : Math.max(0, v))), color: '--s1' }, { data: h.axis.map(() => cfg.helix), color: '--s2', dot: false }],
      { xmax, unit: '°', xlabel: xl, empty: '切りくずができると表示します', marks });
    $('cf-a').textContent = '接線分力 Ft'; $('cf-b').textContent = '半径分力 Fr'; $('cf-c').textContent = '軸方向分力 Fa';
    $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span><span><i style="background: var(--s2)"></i>工具の最高</span>';
    $('h-ts').innerHTML = '切りくず流出角 ηc<span><i style="background: var(--s1)"></i>計算値</span><span><i style="background: var(--s2)"></i>ねじれ角 β</span>';
    return;
  }
  if (d3) {
    const h = frame && frame.dim === 3 ? frame.hist : { axis: [], fc: [], ft: [], fr: [], tmax: [], flow: [] };
    const xmax = frame && frame.dim === 3 ? Math.max(cfg.cutLen, frame.summary.travel, ...h.axis) : cfg.cutLen;
    const xl = '横軸 工具の移動量 [mm]';
    lineChart($('chart-f'), h.axis, [...pv('fc', '--s1'), ...pv('ft', '--s2'), ...pv('fr', '--s3'), { data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }, { data: h.fr, color: '--s3' }], { xmax, unit: 'N', xlabel: xl });
    lineChart($('chart-t'), h.axis, [...pv('tmax', '--s3'), ...pv('ttool', '--s2'), { data: h.tmax, color: '--s3' }, { data: h.ttool || [], color: '--s2' }], { xmax, unit: '°C', xlabel: xl });
    wearChart();
    lineChart($('chart-ts'), h.axis, [{ data: h.flow.map((v) => (v == null ? null : Math.max(0, v))), color: '--s1' }, { data: h.axis.map(() => cfg.lambda), color: '--s2', dot: false }],
      { xmax, unit: '°', xlabel: xl, empty: '切りくずができると表示します' });
    $('cf-a').textContent = '主分力 Fc'; $('cf-b').textContent = '背分力 Ft'; $('cf-c').textContent = '横分力 Fr';
    $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span><span><i style="background: var(--s2)"></i>工具の最高</span>';
    $('h-ts').innerHTML = '切りくず流出角 ηc<span><i style="background: var(--s1)"></i>計算値</span><span><i style="background: var(--s2)"></i>傾き角 λ（Stabler の法則）</span>';
    return;
  }
  $('h-t').innerHTML = '温度<span><i style="background: var(--s3)"></i>被削材の最高</span><span><i style="background: var(--s1)"></i>すくい面接触部</span><span><i style="background: var(--s2)"></i>工具の最高</span>';
  $('h-ts').innerHTML = '工具表面の温度<span><i style="background: var(--s2)"></i>切削終了時点</span><span><i style="background: var(--s1)"></i>定常推定</span>';
  const mill = cfg && cfg.mode === 'mill';
  const h = frame ? frame.hist : { axis: [], fc: [], ft: [], tmax: [], trake: [], ttool: [] };
  const np = mill && frame ? frame.summary.passes || 1 : 1;
  const xmax = mill ? (frame ? Math.max(1, (np - 1) * frame.summary.span + frame.summary.arc + frame.summary.track + 6) : 40) : cfg ? cfg.cutLen : 1;
  const xl = mill ? (np > 1 ? '横軸 刃の回転角 [°]（刃ごとに続けて表示）' : '横軸 刃の回転角 [°]') : '横軸 切削長さ [mm]';
  const marks = [];
  if (np > 1 && h.pass) for (let i = 1; i < h.pass.length; i++) if (h.pass[i] !== h.pass[i - 1]) marks.push({ x: h.axis[i], label: `${h.pass[i] + 1}刃目` });
  lineChart($('chart-f'), h.axis, [...pv('fc', '--s1'), ...pv('ft', '--s2'), { data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }], { xmax, unit: 'N', xlabel: xl, marks });
  lineChart($('chart-t'), h.axis, [...pv('tmax', '--s3'), ...pv('trake', '--s1'), ...pv('ttool', '--s2'), { data: h.tmax, color: '--s3' }, { data: h.trake, color: '--s1' }, { data: h.ttool, color: '--s2' }], { xmax, unit: '°C', xlabel: xl, marks });
  const pr = frame && frame.profile ? frame.profile.filter((r) => r.s > -400 && r.s < 500) : [];
  const ps = pr.map((r) => r.s), xr = pr.length ? [Math.min(...ps), Math.max(...ps)] : [-200, 300];
  lineChart($('chart-ts'), ps, [{ data: pr.map((r) => r.T), color: '--s2', dot: false }, { data: pr.map((r) => r.Tst), color: '--s1', dot: false }],
    { xmin: xr[0], xmax: xr[1], unit: '°C', xlabel: '逃げ面 ← 刃先からの距離 [µm] → すくい面', empty: '計算が終わると表示します' });
  lineChart($('chart-w'), ps, [{ data: pr.map((r) => r.wear), color: '--s3', dot: false }],
    { xmin: xr[0], xmax: xr[1], unit: 'µm/min', xlabel: '逃げ面 ← 刃先からの距離 [µm] → すくい面', empty: '計算が終わると表示します' });
  const rs = frame && frame.summary.residual ? frame.summary.residual.filter((b) => b.d < 400) : [];
  lineChart($('chart-rs'), rs.map((b) => b.d), [{ data: rs.map((b) => b.sxx), color: '--s1', dot: false }, { data: rs.map((b) => b.syy), color: '--s2', dot: false }],
    { xmax: rs.length ? rs[rs.length - 1].d : 400, unit: 'MPa（+ 引張）', xlabel: '加工面からの深さ [µm]', empty: cfg && cfg.residual ? '切削後の除荷・冷却が終わると表示します' : '「残留応力」をオンにすると計算します', signed: true });
  $('cf-a').textContent = mill ? '接線分力 Ft' : '主分力 Fc';
  $('cf-b').textContent = mill ? '半径分力 Fr' : '背分力 Ft';
}

// ---- Readouts ----
const f0 = (v) => v.toFixed(0), f1 = (v) => v.toFixed(1), f3 = (v) => v.toFixed(3);
const CELLS = {
  mesh: [
    ['Fx の平均', (s) => f1(s.fx), 'N', (s) => `最大 ${f1(s.fxMax)} N。工具が受ける力（ファイルの x 軸）`],
    ['Fy の平均', (s) => f1(s.fy), 'N', (s) => `最大 ${f1(s.fyMax)} N`],
    ['Fz の平均', (s) => f1(s.fz), 'N', (s) => `最大 ${f1(s.fzMax)} N`],
    ['主軸トルク', (s) => (s.motion === 'linear' ? '—' : f1(s.torque * 1e3)), 'mN·m', (s) => (s.motion === 'linear' ? '直進する工具' : `最大 ${f1(s.torqueMax * 1e3)} mN·m、動力 ${f1(s.power)} W`)],
    ['回転数', (s) => (s.motion === 'linear' ? '—' : f0(s.rpm)), 'min⁻¹', (s) => (s.motion === 'linear' ? `切削速度で +x へ直進` : `外径 φ${f3(2 * s.Rt)} mm で切削速度、送り ${f0(s.vf)} mm/min`)],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', () => '工具は断熱（摩擦熱の工具への分担は差し引く）'],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', () => '切りくずの裏面付近'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量 / 工具がした仕事'],
    ['分断した切りくず片', (s) => f0(s.pieces), '個', (s) => `工具から離れて排出 ${s.evacuated} 粒子 · 割れた粒子 ${s.failed}`],
    ['進み具合', (s) => f0(s.progress * 100), '%', (s) => (s.motion === 'linear' ? `移動 ${f3(s.travel)} mm` : `回転角 ${f0(s.angle)}°`)],
    ['粒子数', (s) => s.N.toLocaleString(), '個', (s) => `間隔 ${s.dx.toFixed(0)} µm · 距離場のブロック ${s.bricks}`],
    ['質量スケーリング', (s) => `×${f0(s.ms)}`, '', () => '慣性だけ密度を上げて高速化'],
  ],
  '3d': [
    ['主分力 Fc', (s) => f1(s.fc), 'N', () => '後半区間の平均'],
    ['背分力 Ft', (s) => f1(s.ft), 'N', () => '工具を押し上げる向き'],
    ['横分力 Fr', (s) => f1(s.fr), 'N', () => '切削方向に直角、表面内の向き'],
    ['比切削抵抗 kc', (s) => f0(s.kc), 'N/mm²', (s) => `便覧値の目安 ${s.kcRef}`],
    ['切りくず流出角 ηc', (s) => (s.flow == null ? '—' : f1(s.flow)), '°', (s) => `傾き角 λ = ${s.lambda}°（Stabler：ηc ≈ λ）`],
    ['切りくず厚さ hc', (s) => (s.ratio > 0 ? f3(s.hc) : '—'), 'mm', (s) => `切りくず厚さ比 ${s.ratio > 0 ? s.ratio.toFixed(2) : '—'}（中央部）`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', () => '切りくずのすくい面側'],
    ['工具の最高温度', (s) => f0(s.toolSteadyT ?? s.toolT), '°C', (s) => (s.toolSteadyT != null ? `定常推定。切削終了時点 ${f0(s.toolT)} °C` : '切削中の値（定常推定は終了後）')],
    ['クレーター摩耗速度', (s) => (s.done ? f1(s.wearCrater) : '—'), 'µm/min', (s) => `逃げ面 ${s.done ? f1(s.wearFlank) : '—'} µm/min、Usui 式`],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', () => '切りくずの裏面付近'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量（工具へ流れた分を含む） / 工具がした仕事'],
    ['工具の移動量', (s) => f3(s.travel), 'mm', () => '傾けた刃が全幅にかかるまでを含む'],
    ['分断した切りくず片', (s) => f0(s.pieces), '個', (s) => `刃から離れて排出 ${s.evacuated} 粒子 · 割れた粒子 ${s.failed}`],
    ['粒子数', (s) => s.N.toLocaleString(), '個', (s) => `間隔 ${s.dx.toFixed(0)} µm`],
    ['質量スケーリング', (s) => `×${f0(s.ms)}`, '', () => '慣性だけ密度を上げて高速化'],
  ],
  helix: [
    ['接線分力 Ft の最大', (s) => f1(s.ftMax), 'N', (s) => (s.passes > 1 ? `刃ごと ${s.passMax.map(f1).join(' → ')} N。係数は最後の刃から` : '1刃の通過中、刃の各点の接線方向の和')],
    ['半径分力 Fr の最大', (s) => f1(s.frMax), 'N', () => '工具の中心へ向かう向きが正'],
    ['軸方向分力 Fa', (s) => f1(s.faMax), 'N', () => '絶対値の最大。被削材をシャンク側へ引く向きが正'],
    ['接線方向の切削係数', (s) => (s.done ? f0(s.Ktc) : '—'), 'N/mm²', (s) => `エッジ係数 Kte ${s.done ? f1(s.Kte) : '—'} N/mm`],
    ['半径方向の切削係数', (s) => (s.done ? f0(s.Krc) : '—'), 'N/mm²', (s) => `エッジ係数 Kre ${s.done ? f1(s.Kre) : '—'} N/mm`],
    ['軸方向の切削係数', (s) => (s.done ? f0(s.Kac) : '—'), 'N/mm²', (s) => `エッジ係数 Kae ${s.done ? f1(s.Kae) : '—'} N/mm`],
    ['切りくず流出角 ηc', (s) => (s.flow == null ? '—' : f1(s.flow)), '°', (s) => `ねじれ角 β = ${s.helix}°（Stabler：ηc ≈ β）`],
    ['最大切取り厚さ', (s) => f3(s.hmax), 'mm', (s) => `接触角 ${f1(s.arc)}°、刃の遅れ ${f1(s.lag)}°`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', () => '切りくずのすくい面側'],
    ['工具の最高温度', (s) => f0(s.toolT), '°C', () => '1刃の通過中の値（高さ方向の平均断面）'],
    ['クレーター摩耗速度', (s) => (s.done ? f1(s.wearCrater) : '—'), 'µm/min', (s) => `逃げ面 ${s.done ? f1(s.wearFlank) : '—'} µm/min、接触中の値`],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量（工具へ流れた分を含む） / 工具がした仕事'],
    ['分断した切りくず片', (s) => f0(s.pieces), '個', (s) => `刃から離れて排出 ${s.evacuated} 粒子 · 割れた粒子 ${s.failed}`],
    ['粒子数', (s) => s.N.toLocaleString(), '個', (s) => `間隔 ${s.dx.toFixed(0)} µm · 質量スケーリング ×${f0(s.ms)}`],
  ],
  ortho: [
    ['主分力 Fc', (s) => f0(s.fc), 'N', () => '後半区間の平均'],
    ['背分力 Ft', (s) => f0(s.ft), 'N', () => '工具を押し上げる向き'],
    ['比切削抵抗 kc', (s) => f0(s.kc), 'N/mm²', (s) => `便覧値の目安 ${s.kcRef}`],
    ['切りくず厚さ hc', (s) => (s.ratio > 0 ? f3(s.hc) : '—'), 'mm', (s) => `切りくず厚さ比 ${s.ratio > 0 ? s.ratio.toFixed(2) : '—'}`],
    ['工具と切りくずの接触長さ', (s) => (s.contactLen != null ? f3(s.contactLen) : '—'), 'mm', (s) => (s.contactLen != null ? `切取り厚さの ${(s.contactLen / cfg.h).toFixed(1)} 倍。すくい面で平均圧力が最大の 5 % を超える範囲` : '計算が終わると表示')],
    ['せん断角 φ', (s) => (s.phi > 0 ? f1(s.phi) : '—'), '°', (s) => `Merchant の式 ${f1(s.phiMerchant)}°`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', (s) => `すくい面接触部 ${f0(s.trake)} °C`],
    ['工具の最高温度', (s) => f0(s.toolSteadyT ?? s.toolT), '°C', (s) => (s.toolSteadyT != null ? `定常推定。切削終了時点 ${f0(s.toolT)} °C` : '切削中の値（定常推定は終了後）')],
    ['クレーター摩耗速度', (s) => (s.done ? f1(s.wearCrater) : '—'), 'µm/min', () => 'すくい面の最大、Usui 式'],
    ['逃げ面摩耗速度', (s) => (s.done ? f1(s.wearFlank) : '—'), 'µm/min', () => '逃げ面の最大、Usui 式'],
    ['最大相当塑性ひずみ', (s) => f1(s.epMax), '', (s) => `最大ひずみ速度 ${s.edMax.toExponential(1)} /s`],
    ['工具へ流れる熱', (s) => f1(s.qTool), 'W', () => '摩擦熱の分担と接触面の熱伝導'],
    ['エネルギー収支', (s) => f0(s.heatRatio * 100), '%', () => '発熱量 / 工具がした仕事'],
    ['切りくずのカール半径', (s) => (s.curl == null ? '—' : isFinite(s.curl) ? f3(s.curl) : '∞'), 'mm', (s) => (s.curl == null ? '切りくずが伸びると表示' : isFinite(s.curl) ? '円で近似した上向きカール' : 'ほぼまっすぐ')],
    ['分断した切りくず片', (s) => f0(s.pieces), '個', (s) => `排出 ${s.evacuated} 粒子 · 割れた粒子 ${s.failed}`],
    ['残留応力（表面、切削方向）', (s) => (s.residual ? f0(s.rsSurf) : '—'), 'MPa',
      (s) => (s.residual ? `切削長の4区間でのばらつき ±${s.rsSpread == null ? '—' : f0(s.rsSpread)} MPa。圧縮の最大 ${f0(s.rsMin)} MPa（深さ ${f0(s.rsMinDepth)} µm）` : s.relax != null ? `除荷・冷却中 ${f0(s.relax * 100)} %` : '「残留応力」をオンにすると切削後に計算')],
    ['実効すくい角', (s) => f1(s.toolRake), '°', () => '刃先から 0.3〜1.0 h の工具表面'],
  ],
  mill: [
    ['接線分力 Ft の最大', (s) => f0(s.ftMax), 'N', (s) => (s.passes > 1 ? `刃ごと ${s.passMax.map(f0).join(' → ')} N` : '1刃の通過中')],
    ['半径分力 Fr の最大', (s) => f0(s.frMax), 'N', (s) => (s.passes > 1 ? `${s.passes} 刃の通過中。係数は最後の刃から` : '1刃の通過中')],
    ['最大切取り厚さ', (s) => f3(s.hmax), 'mm', (s) => `接触角 ${f1(s.arc)}°`],
    ['接線方向の切削係数', (s) => (s.done ? f0(s.Ktc) : '—'), 'N/mm²', (s) => `エッジ係数 Kte ${s.done ? f1(s.Kte) : '—'} N/mm`],
    ['半径方向の切削係数', (s) => (s.done ? f0(s.Krc) : '—'), 'N/mm²', (s) => `エッジ係数 Kre ${s.done ? f1(s.Kre) : '—'} N/mm`],
    ['最高温度（被削材）', (s) => f0(s.tmax), '°C', (s) => `すくい面接触部の最大 ${f0(s.trake)} °C`],
    ['工具の最高温度', (s) => f0(s.toolT), '°C', (s) => (s.toolMeanT != null ? `1刃の通過中（冷えた工具から）。回し続けると工具の平均温度は ${f0(s.toolMeanT)} °C まで上がり、接触のたびに表面は約 ${f0(s.toolPeakT)} °C` : '1刃の通過中の値')],
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
      dir: c.dir, rake: c.rake, edgeRadius: c.edgeRadius, flowScale: c.flowScale },
    coefficients: { Ktc: r(s.Ktc), Krc: r(s.Krc), Kac: c.mode === 'helix' ? r(s.Kac) : null, Kte: r(s.Kte), Kre: r(s.Kre), Kae: c.mode === 'helix' ? r(s.Kae) : null },
    units: { K_c: 'N/mm²', K_e: 'N/mm' },
  };
  const text = JSON.stringify(out, null, 2);
  const name = `coeffs_${c.mat}_${c.mode}.json`;
  if (downloads) {
    // Published page: the viewer confirms the save.
    downloads.save({ filename: name, data: text }).then(
      () => { $('exhint').textContent = 'JSON を保存しました。'; },
      (e) => { $('exhint').textContent = e && e.code === 'declined' ? '保存を取りやめました。' : 'この表示では保存できません。'; });
  } else {
    // Offline file: a plain download link.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    $('exhint').textContent = 'JSON を保存しました。';
  }
  // Also to the clipboard where the page may write it (embedded pages often may not).
  const clip = navigator.clipboard && navigator.clipboard.writeText(text);
  if (clip) clip.then(() => { $('exhint').textContent = 'JSON を保存し、クリップボードにもコピーしました。'; }, () => {});
}
let downloads = null;
if (window.claude && window.claude.use) window.claude.use('downloads').then((d) => { downloads = d; }, () => {});
$('export').addEventListener('click', exportCoeffs);

// Result as CSV: the summary values as comment lines, then the time histories (one row per sample).
const HCOL = { axis: null, tmax: 'Tmax_work [C]', trake: 'T_rake [C]',
  ttool: 'Tmax_tool [C]', hnom: 'h_nominal [mm]', flow: 'chip_flow_angle [deg]', area: 'chip_area [mm2]', len: 'edge_length [mm]' };
function saveResult() {
  const s = frame.summary, h = frame.hist, c = cfg;
  const msh = c.mode === 'mesh';
  const axis = c.mode === 'mill' || c.mode === 'helix' || (msh && c.motion !== 'linear') ? 'rotation [deg]' : c.mode === '3d' || msh ? 'tool travel [mm]' : 'cut length [mm]';
  // Conditions without the outlines and meshes themselves (the STL names stand for them).
  const cond = JSON.stringify(c, (k, v) => (k === 'profile' || k === 'work' || k === 'toolTris' || k === 'workTris' ? undefined : v));
  const lines = [`# cutting-sim ${c.mode} ${c.mat}`, `# conditions ${cond}`];
  if (msh) lines.push(`# tool ${stl.tool && stl.tool.name}, work ${stl.work && stl.work.name}`);
  for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && isFinite(v)) lines.push(`# ${k} = ${+v.toPrecision(6)}`);
  const keys = Object.keys(h).filter((k) => Array.isArray(h[k]) && h[k].length === h.axis.length && h[k].length && h[k].some((v) => v != null));
  const mill = c.mode === 'mill' || c.mode === 'helix';
  const force = msh ? { fc: 'Fx [N]', ft: 'Fy [N]', fr: 'Fz [N]', mz: 'spindle_torque [N m]' } : { fc: mill ? 'Ft_tangential [N]' : 'Fc_cutting [N]', ft: mill ? 'Fr_radial [N]' : 'Ft_thrust [N]', fr: mill ? 'Fa_axial [N]' : 'Fr_lateral [N]' };
  lines.push(keys.map((k) => (k === 'axis' ? axis : force[k] || HCOL[k] || k)).join(','));
  for (let i = 0; i < h.axis.length; i++) lines.push(keys.map((k) => (h[k][i] == null ? '' : +h[k][i].toPrecision(6))).join(','));
  const text = lines.join('\n') + '\n', name = `cutting_${c.mode}_${c.mat}.csv`;
  if (downloads) downloads.save({ filename: name, data: text }).then(() => { $('savehint').textContent = 'CSV を保存しました。'; },
    (e) => { $('savehint').textContent = e && e.code === 'declined' ? '保存を取りやめました。' : 'この表示では保存できません。'; });
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); $('savehint').textContent = 'CSV を保存しました。'; }
}
$('saveres').addEventListener('click', saveResult);
$('overlay').addEventListener('change', drawCharts);

// Worn tool: move the outline into the tool by the computed wear rate × the chosen time, switch
// to that outline and cut again (repeat to follow the wear step by step).
$('wear').addEventListener('click', () => {
  const min = parseFloat($('wearmin').value);
  if (!(min > 0) || !frame || !frame.profile) return;
  const worn = wornProfile(shapeOutline(cfg), frame.profile, min);
  const total = (cfg.tool === 'custom' && custom.wornMin ? custom.wornMin : 0) + min;
  custom.profile = worn; custom.text = null; custom.wornMin = total; custom.name = `摩耗した工具（累計 ${total} 分）`;
  $('shape').value = 'custom';
  showShapeRows();
  $('pinfo').textContent = `${custom.name}：Usui 式の摩耗速度 × 時間だけ工具表面を後退させた形。摩耗係数は仮の値なので、時間は目安です。`;
  $('pinfo').classList.remove('err');
  reset();
  worker.postMessage({ type: 'run', n: ++runN }); status = 'running'; updateRunButton();
});

function readouts() {
  const s = frame.summary, has = s.steps > 0;
  $('export').disabled = !(s.done && (cfg.mode === 'mill' || cfg.mode === 'helix'));
  $('wear').disabled = !(s.done && cfg.mode === 'ortho' && frame.profile);
  $('saveres').disabled = !s.done;
  CELLS[cfg.mode].forEach(([, v, , sub], i) => {
    $(`rv${i}`).textContent = has ? v(s) : '—';
    $(`rs${i}`).textContent = has ? sub(s) : '—';
  });
  $('prog').style.width = s.progress * 100 + '%';
  $('clock').textContent = (cfg.mode === 'mesh' ? (s.motion === 'linear' ? `移動 ${f3(s.travel)} mm · ` : `回転角 ${f0(s.angle)}° · `) + `${f0(s.progress * 100)} % · ` : cfg.mode === 'helix' ? `回転角 ${f1(s.angle)}° · ${f0(s.progress * 100)} % · ` : cfg.mode === 'mill' ? `回転角 ${f1(s.angle)}° · ` : cfg.mode === '3d' ? `移動 ${f3(s.travel)} mm · ${f0(s.progress * 100)} % · ` : (s.relax != null && !s.residual ? `除荷・冷却 ${f0(s.relax * 100)} % · ` : `${f3(s.travel)} / ${cfg.cutLen.toFixed(2)} mm · `))
    + `${(s.t * 1e6).toFixed(1)} µs · 計算 ${(frame.wall / 1000).toFixed(0)} s`;
  $('meta').textContent = `粒子 ${s.N.toLocaleString()} 個 · 間隔 ${s.dx.toFixed(1)} µm · 質量スケーリング ×${s.ms.toFixed(0)} · Δt ${(frame.dt * 1e9).toFixed(1)} ns · ${s.steps.toLocaleString()} ステップ`
    + (is3(cfg.mode) ? ' · 3D は計算に数分〜十数分かかります' : '');
}

// ---- Condition sweep (orthogonal cutting, its own worker) ----
const SWEEP = {
  h: { label: 'h', unit: 'mm', vals: '0.05, 0.1, 0.15, 0.2' }, vc: { label: '切削速度', unit: 'm/min', vals: '100, 200, 300, 400' },
  rake: { label: 'すくい角', unit: '°', vals: '-5, 0, 5, 10, 15' }, edgeRadius: { label: '刃先丸み', unit: 'µm', vals: '5, 10, 20, 40' },
  mu: { label: 'μ', unit: '', vals: '0.2, 0.4, 0.6, 0.8' },
};
let sweeper = null, sw = null;
$('swkey').addEventListener('change', () => { if (!sw || sw.done) $('swvals').value = SWEEP[$('swkey').value].vals; });
// Kienzle fit by least squares in log–log: ln kc = ln kc1.1 − mc ln h.
function kienzle(rows) {
  const p = rows.filter((r) => r.s && r.v > 0 && r.s.kc > 0);
  if (p.length < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const r of p) { const x = Math.log(r.v), y = Math.log(r.s.kc); sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const n = p.length, b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { kc11: Math.exp((sy - b * sx) / n), mc: -b };
}
// Taylor exponent from the flank wear rate: tool life T ∝ 1 / rate, V·Tⁿ = C, so ln rate = ln V / n + c.
function taylor(rows) {
  const p = rows.filter((r) => r.s && r.v > 0 && r.s.wearFlank > 0);
  if (p.length < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const r of p) { const x = Math.log(r.v), y = Math.log(r.s.wearFlank); sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const n = p.length, b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return b > 0 ? 1 / b : null;
}
function sweepTable() {
  const k = SWEEP[sw.key], body = $('swbody');
  $('swth').textContent = `${k.label}${k.unit ? ' ' + k.unit : ''}`;
  body.textContent = '';
  for (const r of sw.rows) {
    const tr = document.createElement('tr'), s = r.s;
    const cells = [String(r.v), ...(s ? [f1(s.fc / sw.cfg.width), f1(s.ft / sw.cfg.width), f0(s.kc), f1(s.phi), s.ratio.toFixed(2), s.muMean != null ? s.muMean.toFixed(2) : '—', f0(s.tmax), f0(s.toolSteadyT ?? s.toolT), s.wearFlank.toFixed(2)]
      : [r.p == null ? '待ち' : `計算中 ${f0(r.p * 100)} %`, '', '', '', '', '', '', '', ''])];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    body.appendChild(tr);
  }
  const done = sw.rows.filter((r) => r.s), xs = done.map((r) => r.v);
  const lo = Math.min(...sw.rows.map((r) => r.v)), hi = Math.max(...sw.rows.map((r) => r.v));
  lineChart($('chart-sw'), xs, [{ data: done.map((r) => r.s.kc), color: '--s1' }],
    { xmin: Math.min(0, lo), xmax: hi > lo ? hi : lo + 1, unit: 'kc N/mm²', xlabel: `${k.label}${k.unit ? ' [' + k.unit + ']' : ''}`, empty: '計算中' });
  const kz = sw.key === 'h' && sw.done ? kienzle(sw.rows) : null, ty = sw.key === 'vc' && sw.done ? taylor(sw.rows) : null;
  $('swhint').textContent = sw.done
    ? (ty ? `完了。工具寿命を逃げ面摩耗速度に反比例とみた Taylor 指数 n = ${ty.toFixed(2)}（V·Tⁿ = 一定。摩耗係数の校正によらない値）。` : kz ? `完了。Kienzle 式：kc1.1 = ${f0(kz.kc11)} N/mm²、mc = ${kz.mc.toFixed(2)}（材料の便覧値 kc ≈ ${frame ? f0(frame.summary.kcRef) : '—'} N/mm² @ h 0.1）。` : '完了。')
    : `計算中：${sw.rows.filter((r) => r.s).length} / ${sw.rows.length}`;
  $('swcsv').disabled = !done.length;
}
$('swrun').addEventListener('click', () => {
  if (sw && !sw.done) { sweeper.postMessage({ type: 'sweepStop' }); sw.done = true; $('swrun').textContent = 'スイープ開始'; sweepTable(); return; }
  const key = $('swkey').value, values = $('swvals').value.split(/[,\s、]+/).map(Number).filter((v) => isFinite(v));
  if (!values.length) { $('swhint').textContent = '値をカンマ区切りで入れてください。'; return; }
  if (!sweeper) {
    sweeper = new Worker(workerUrl);
    sweeper.onmessage = (e) => {
      const d = e.data;
      if (!sw || sw.done) return;
      if (d.type === 'sweep') { const r = sw.rows[d.i]; r.p = d.progress; if (d.summary) r.s = d.summary; }
      else if (d.type === 'sweepDone') { sw.done = true; $('swrun').textContent = 'スイープ開始'; }
      sweepTable();
    };
  }
  const base = readCfg();
  sw = { key, rows: values.map((v) => ({ v, p: null, s: null })), done: false, cfg: base };
  sweeper.postMessage({ type: 'sweep', cfg: { ...base, mode: 'ortho', residual: false }, key, values });
  $('swrun').textContent = 'スイープを止める';
  sweepTable();
});
$('swcsv').addEventListener('click', () => {
  const k = SWEEP[sw.key];
  const lines = [`${sw.key} [${k.unit}],Fc [N/mm],Ft [N/mm],kc [N/mm2],phi [deg],hc/h,mean mu,Tmax [C],tool Tmax [C],flank wear [um/min]`];
  for (const r of sw.rows) if (r.s) { const s = r.s; lines.push([r.v, s.fc / sw.cfg.width, s.ft / sw.cfg.width, s.kc, s.phi, s.ratio, s.muMean, s.tmax, s.toolSteadyT ?? s.toolT, s.wearFlank].map((v) => (typeof v === 'number' ? +v.toPrecision(5) : v)).join(',')); }
  const text = `# cutting-sim sweep, ${sw.cfg.mat}, ${JSON.stringify({ vc: sw.cfg.vc, h: sw.cfg.h, rake: sw.cfg.rake, edgeRadius: sw.cfg.edgeRadius, mu: sw.cfg.mu, nh: sw.cfg.nh })}\n` + lines.join('\n') + '\n';
  const name = `sweep_${sw.cfg.mat}_${sw.key}.csv`;
  if (downloads) downloads.save({ filename: name, data: text }).then(() => { $('swhint').textContent = 'CSV を保存しました。'; }, (e) => { $('swhint').textContent = e && e.code === 'declined' ? '保存を取りやめました。' : 'この表示では保存できません。'; });
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
});

reset();
