import { Simulator } from './sim.js';
import { SimHost } from './host.js';
import { wallProfile, wallSides } from './roughness.js';
import { parseFrfCsv, fitModes, exampleCsv, staticK, dominant } from './frf.js';
import { View } from './view.js';
import { MATERIALS, parseCoeffs, coefsFromFile } from './materials.js';
import { COOLANTS } from './chips.js';
import { SAMPLES } from './samples.js';
import { decodeText } from './gcode.js';
import { parseMesh, orientMesh } from './workpiece.js';
import { parseCad, CAD_RE } from './cad.js';
import { HOLDERS, parseToolLibrary } from './assembly.js';
import { ALLOWABLE_STRESS } from './tool.js';
import { alimAt } from './sld.js';
import { speedDependent } from './spindle.js';
import { VB_LIMIT, T0, SWING_CRACK } from './thermal.js';
import { LineReport } from './report.js';
import { JC, predictCoefs } from './oxley.js';
import { identify, parseTests, unitForces, COEF_KEYS } from './identify.js';
import { optimizeFeeds, rewriteFeeds, defaultTarget, optimizeSpindle, rewriteSpindle } from './feedopt.js';
import { adviceFor } from './advice.js';
import { startConditions, arcOf } from './conditions.js';
import { timeDomainLimit } from './stabtd.js';
import { refreshTheme, drawForces, drawOrbit, drawSpectrum, drawLobes, drawRoughness, drawSection, sectionProbe, drawRevolution } from './charts.js';
import { parseRecord, syncAverage, simRevolution, align, shifted, compare, fitRecord, syntheticRecord, asyncPeak } from './validate.js';

const $ = id => document.getElementById(id);
const sim = new Simulator();
const host = new SimHost(sim);
const view = new View($('view'));
let running = false, baseS = 12000, viewToolVersion = -1;

// ---------- setup ----------
for (const [k, m] of Object.entries(MATERIALS)) $('material').add(new Option(m.name, k));
$('sample').add(new Option('サンプルプログラムを選ぶ…', '')); $('sample').options[0].disabled = true;
for (const [k, s] of Object.entries(SAMPLES)) $('sample').add(new Option(s.name, k));
$('sample').value = 'demo';
$('code').value = SAMPLES.demo.code;

let stockShape = '', stockMode = 'prog', stlSpec = null, targetSpec = null, codeLines = [];
// work coordinate systems other than G54: offset from G54 [mm], kept across reloads
const wcsDelta = {};
function stockSetup() {
  const num = id => +$(id).value;
  let stock = null;
  if (stockMode === 'box') stock = { type: 'box', w: num('stW'), l: num('stL'), h: num('stH') };
  else if (stockMode === 'cyl') stock = { type: 'cyl', d: num('cD'), h: num('cH') };
  else if (stockMode === 'stl' && stlSpec) stock = stlSpec;
  const kind = $('orgSel').value;
  const origin = kind === 'manual' ? { x: num('oX'), y: num('oY'), z: num('oZ') } : kind;
  return { stock, origin, target: targetSpec, wcsDelta };
}
function loadProgram() {
  const setup = stockSetup();
  host.load($('code').value, setup);
  codeLines = $('code').value.split('\n');
  stabCache.clear();
  // a feed optimisation belongs to the program it was made from
  { foText = null; $('foLoad').disabled = $('foSave').disabled = true; $('foOut').innerHTML = ''; }
  baseS = firstSpindle(sim.path) || 12000;
  sim.cfg.spindleOverride = +$('ovS').value / baseS;
  host.config();
  view.setStock(sim.stock, sim.mat);
  view.setTool(sim.activeTool); viewToolVersion = sim.toolVersion;
  view.setPath(sim.path); pathColorKey = '';
  const w = $('warnings'); w.innerHTML = '';
  const msgs = [...sim.warnings];
  if (stockMode === 'stl' && !stlSpec) msgs.unshift('STL が未選択のため、プログラムの指定で素材を作りました');
  for (const msg of msgs) { const li = document.createElement('li'); li.textContent = msg; w.appendChild(li); }
  // the origin actually used, in the inputs (they stay as typed in manual mode)
  if ($('orgSel').value !== 'manual') for (const k of ['x', 'y', 'z']) $('o' + k.toUpperCase()).value = +sim.origin[k].toFixed(3);
  const sz = sim.stockSize, sp = sim.stockSpec;
  const shape = sp.type === 'cyl' ? `丸棒 φ${sp.d} × ${sp.h} mm` : sp.type === 'stl' ? `${/\.obj$/i.test(sp.name || '') ? 'OBJ' : CAD_RE.test(sp.name || '') ? 'STEP' : 'STL'} ${sp.name || ''} ${sz.w.toFixed(1)} × ${sz.l.toFixed(1)} × ${sz.h.toFixed(1)} mm (${sp.count.toLocaleString()} 三角形${sp.scale && sp.scale !== 1 ? `、×${sp.scale} で mm に換算` : ''})` : `直方体 ${sz.w} × ${sz.l} × ${sz.h} mm`;
  $('stockInfo').textContent = `${shape} · 格子 ${sim.stockCell} mm`; stockShape = shape;
  showTools();
  showWcs();
  syncModalInputs();
  updateMatHint();
  showJc();
  showStart();
  document.querySelector('[data-color="devTarget"]').disabled = !targetSpec;
  if (!targetSpec && view.colorMode === 'devTarget') setColorMode('devIdeal');
}
function showTools() {
  const used = [...new Set(sim.path.map(p => p.tool).filter(t => t != null))];
  $('toolBox').hidden = !used.length;
  const ul = $('toolList'); ul.innerHTML = '';
  for (const T of used) {
    const t = sim.toolFor(T), def = sim.tools?.[T];
    const li = document.createElement('li');
    const lib = sim.assets?.library?.[T];
    li.textContent = lib ? `T${T}: φ${+t.D.toFixed(3)} ${t.type === 'ball' ? 'ボール' : t.type === 'bull' ? `ラジアス R${+(t.cornerR || 0).toFixed(2)}` : 'フラット'} ${t.N}枚刃 · 突出し ${+t.stickout.toFixed(1)} mm · ${t.holderName || 'ホルダーなし'} (ライブラリ)`
      : def ? `T${T}: φ${t.D} ${t.type === 'ball' ? 'ボール' : 'フラット'} ${t.N}枚刃 · 刃長 ${t.fluteLen} · 突出し ${t.stickout} mm${def.drill ? ' (ドリルはフラットとして計算)' : ''}${def.cornerR ? ` (コーナーR${def.cornerR} はフラットとして計算)` : ''}`
      : `T${T}: 寸法の記載なし → 加工条件の工具 φ${t.D}`;
    ul.appendChild(li);
  }
}
// one row per work coordinate system the program uses (besides G54): its offset from G54
function showWcs() {
  const used = (sim.wcsUsed || []).filter(n => n !== 'G54'), box = $('wcsRows');
  box.innerHTML = '';
  for (const name of used) {
    // an entry exists only once a value was typed (until then the program warns it is unset)
    const d = wcsDelta[name] || { x: 0, y: 0, z: 0 };
    const row = document.createElement('div'); row.className = 'wcsrow';
    const lab = document.createElement('span'); lab.textContent = name; row.appendChild(lab);
    for (const k of ['x', 'y', 'z']) {
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.1'; inp.value = d[k];
      inp.id = `wcs-${name}-${k}`; inp.setAttribute('aria-label', `${name} の Δ${k.toUpperCase()} [mm]`); inp.title = `G54 からの Δ${k.toUpperCase()} [mm]`;
      inp.onchange = () => { const v = +inp.value; if (Number.isFinite(v)) { d[k] = v; wcsDelta[name] = d; loadProgram(); } };
      // written by the program's G10: shown, not edited here
      if (sim.wcsG10?.has(name)) { const z = sim.wcs[name], o = sim.origin; inp.value = +(z[k] - o[k]).toFixed(3); inp.disabled = true; inp.title = `プログラムの G10 で設定 (G54 からの Δ${k.toUpperCase()})`; }
      row.appendChild(inp);
    }
    // or picked on the 3D view: the offset from G54 to the clicked point
    const pb = document.createElement('button'); pb.textContent = '⌖'; pb.title = `${name} の原点を 3D 画面でクリックして指定`; pb.setAttribute('aria-label', pb.title);
    pb.onclick = () => startPick(`${name} の原点`, p => {
      const o = sim.origin; wcsDelta[name] = { x: +(p.x - o.x).toFixed(3), y: +(p.y - o.y).toFixed(3), z: +(p.z - o.z).toFixed(3) };
      loadProgram();
      return `${name} を${p.snap ? `素材の${p.snap}` : 'クリックした点'}に (G54 から Δ ${wcsDelta[name].x} ${wcsDelta[name].y} ${wcsDelta[name].z})`;
    });
    if (sim.wcsG10?.has(name)) pb.disabled = true;
    row.appendChild(pb);
    box.appendChild(row);
  }
  if (used.length) { const hdr = document.createElement('div'); hdr.className = 'wcsrow'; hdr.innerHTML = '<span></span><span>ΔX</span><span>ΔY</span><span>ΔZ</span><span></span>'; box.prepend(hdr); }
  $('wcsBox').hidden = !used.length;
  // axes at the work zeros only when the program switches between systems
  view.setWcs((sim.wcsUsed || []).length > 1 ? sim.wcsUsed.map(n => ({ name: n, ...(sim.wcs[n] || sim.origin) })) : []);
}
function firstSpindle(path) { const p = path.find(q => !q.rapid); return p ? p.S : path[0]?.S; }

function restart() { host.reset(); view.setStock(sim.stock, sim.mat); }

// ---------- controls ----------
$('btnPlay').onclick = () => {
  if (sim.done) restart();
  running = !running;
  host.setRunning(running);
  $('btnPlay').textContent = running ? '❚❚ 一時停止' : '▶ 再開';
};
$('btnReset').onclick = () => { restart(); running = false; host.setRunning(false); $('btnPlay').textContent = '▶ 開始'; };
$('speed').onchange = e => host.setSpeed(+e.target.value);
host.setSpeed(+$('speed').value);
$('btnLoad').onclick = () => { loadProgram(); running = true; host.setRunning(true); $('btnPlay').textContent = '❚❚ 一時停止'; };
$('sample').onchange = e => {
  setStockMode('prog'); $('orgSel').value = 'auto'; $('orgSel').onchange();
  const sm = SAMPLES[e.target.value];
  $('gcInfo').textContent = sm.name;
  $('code').value = sm.code;
  // a sample written for a material selects it
  if (sm.material && sm.material !== sim.cfg.material) { $('material').value = sm.material; $('material').onchange({ target: $('material') }); }
  // a sample brings its own work offsets (or none)
  for (const k of Object.keys(wcsDelta)) delete wcsDelta[k];
  Object.assign(wcsDelta, JSON.parse(JSON.stringify(sm.wcsDelta || {})));
  // a sample brings its own target shape (or none)
  targetSpec = sm.target ? sm.target() : null; targetRaw = null;
  $('tgClear').disabled = !targetSpec;
  $('tgInfo').textContent = targetSpec ? `${targetSpec.name} · ${targetSpec.count} 三角形` : '目標形状なし';
  loadProgram();
  if (targetSpec) setColorMode('devTarget');
  setSpindle(baseS);
};

// ---------- files ----------
// ---------- project: the program with everything set around it, as one JSON file ----------
const PJ_INPUTS = ['stW', 'stL', 'stH', 'cD', 'cH', 'orgSel', 'oX', 'oY', 'oZ', 'stlUnit', 'stlUp', 'stlRot', 'cellSel'];
function projectJson() {
  const cfg = JSON.parse(JSON.stringify(sim.cfg));
  delete cfg.dynBudget;
  return JSON.stringify({ app: 'machining-sim', version: 1, saved: new Date().toISOString(), name: $('gcInfo').dataset.file || SAMPLES[$('sample').value]?.name || '',
    code: $('code').value, stockMode, inputs: Object.fromEntries(PJ_INPUTS.map(id => [id, $(id).value])), wcsDelta, cfg, spindle: +$('ovS').value }, null, 1);
}
function openProject(text) {
  const pj = JSON.parse(text);
  if (pj.app !== 'machining-sim' || typeof pj.code !== 'string') throw new Error('このシミュレーターのプロジェクトではありません');
  // configuration first (nested objects merged so newer fields keep their defaults)
  // (the dynamics and the coefficient overrides are taken whole: what the project had, no more)
  for (const [k, v] of Object.entries(pj.cfg || {})) sim.cfg[k] = k !== 'modal' && v && typeof v === 'object' && !Array.isArray(v) && sim.cfg[k] && typeof sim.cfg[k] === 'object' ? { ...sim.cfg[k], ...v } : v;
  sim.cfg.coefs = pj.cfg?.coefs || {};
  if (pj.cfg?.modal) { const m = pj.cfg.modal; for (const key of ['modesX', 'modesY', 'speedFrfs']) if (!(key in m)) m[key] = null; }
  if (!sim.cfg.modal.modesX && !sim.cfg.modal.speedFrfs) { $('frfClear').disabled = true; $('frfInfo').innerHTML = frfHint; }
  else { $('frfClear').disabled = false; $('frfInfo').textContent = 'プロジェクトの FRF (実測モード) を使っています。'; }
  for (const k of Object.keys(wcsDelta)) delete wcsDelta[k];
  Object.assign(wcsDelta, pj.wcsDelta || {});
  for (const [id, v] of Object.entries(pj.inputs || {})) if ($(id)) $(id).value = v;
  // the stock grid as the configuration has it (a project from before the selector, or a size it lacks)
  { const cs = $('cellSel'), v = String(sim.cfg.cell); if (![...cs.options].some(o => o.value === v)) cs.add(new Option(`${v} mm`, v)); cs.value = v; }
  // the panel controls that mirror cfg
  const t = sim.cfg.tool;
  $('material').value = sim.cfg.material;
  for (const [id, key] of Object.entries(toolInputs)) if (t[key] != null) $(id).value = t[key];
  for (const [id, key] of [['tRake', 'rakeDeg'], ['tRun', 'runout'], ['tCoat', 'coating'], ['tCR', 'cornerR'], ['tShank', 'shankD'], ['tNeckD', 'neckD'], ['tNeckL', 'neckLen'], ['tHolder', 'holder']]) if ($(id)) $(id).value = t[key] ?? '';
  document.querySelectorAll('[data-ttype]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ttype === t.type));
  $('rowCR').hidden = t.type !== 'bull';
  document.querySelectorAll('[data-cool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cool === sim.cfg.coolant));
  $('nozzleBox').hidden = COOLANTS[sim.cfg.coolant]?.jet !== 'nozzle';
  $('mAuto').checked = sim.cfg.modal.auto !== false;
  if (sim.cfg.spindleSoft) $('spSoft').value = Math.round((sim.cfg.spindleSoft.drop ?? 0.25) * 100);
  $('ovF').value = Math.round((sim.cfg.feedOverride ?? 1) * 100); $('ovFOut').textContent = `${$('ovF').value} %`;
  $('tVB0').value = t.VB0 ?? 0; $('tol').value = sim.cfg.tol ?? 0.05;
  if (sim.cfg.nozzle) { $('nzAz').value = sim.cfg.nozzle.az; $('nzH').value = sim.cfg.nozzle.h; nozzleChanged(); }
  $('code').value = pj.code; $('sample').value = '';
  $('gcInfo').dataset.file = pj.name || 'project'; $('gcInfo').textContent = `${pj.name || 'プロジェクト'} · ${pj.code.split('\n').length.toLocaleString()} 行 (プロジェクト)`;
  setStockMode(pj.stockMode === 'stl' && !stlSpec ? 'prog' : pj.stockMode || 'prog'); $('orgSel').onchange();
  view.setCoating(t.coating || 'none');
  host.config(true);
  loadProgram();
  if (pj.spindle > 0) setSpindle(pj.spindle);
  syncModalInputs(); updateMatHint(); showJc();
  $('pjInfo').textContent = `${pj.name || 'プロジェクト'} を開きました (${pj.saved ? new Date(pj.saved).toLocaleString('ja-JP') : ''} 保存)。${pj.stockMode === 'stl' && !stlSpec ? 'STL / STEP の素材は入っていないので、プログラムから素材を決めています。' : ''}`;
}
$('pjSave').onclick = async () => {
  const text = projectJson(), name = ($('gcInfo').dataset.file || 'program').replace(/(_opt)?\.[^.]+$/, '') + '.machsim.json';
  if (downloads) { try { await downloads.save({ filename: name, data: text }); } catch { /* declined */ } return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('pjOpen').onclick = () => $('pjFile').click();
$('pjFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { openProject(await f.text()); } catch (err) { $('pjInfo').textContent = `${f.name} を開けませんでした: ${err.message}`; }
};
async function openProgram(file) {
  const text = decodeText(await file.arrayBuffer());
  $('code').value = text;
  const n = text.split('\n').length;
  $('sample').value = '';
  $('gcInfo').dataset.file = file.name;
  $('gcInfo').textContent = `${file.name} · ${n.toLocaleString()} 行 · ${(file.size / 1024).toFixed(0)} KB`;
  loadProgram();
  setSpindle(baseS);
}
// imported meshes as read (before units / up axis / rotation), so a change of those re-applies
let stlRaw = null, targetRaw = null;
// a mesh file (STL / OBJ) or a CAD model (STEP / IGES, triangulated by OpenCascade on first use)
async function readMeshFile(file, status) {
  const buf = await file.arrayBuffer();
  if (!CAD_RE.test(file.name)) return parseMesh(buf, file.name);
  status?.(`${file.name} を変換しています… (初回は変換部品 約 8 MB を取得します)`);
  await new Promise(r => setTimeout(r, 30)); // let the message show before the conversion blocks
  return parseCad(buf, file.name);
}
// CAD files carry their unit (converted to mm), so "auto" means mm for them
const meshOpts = (rot = true, raw = stlRaw) => ({ unit: $('stlUnit').value === 'auto' && raw?.mesh.unitMm ? 'mm' : $('stlUnit').value, up: $('stlUp').value, rotZ: rot ? +$('stlRot').value : 0 });
function applyStlOrientation() {
  if (!stlRaw) return;
  const m = orientMesh(stlRaw.mesh, meshOpts());
  stlSpec = { type: 'stl', ...m, name: stlRaw.name };
}
async function openStl(file) {
  try {
    stlRaw = { mesh: await readMeshFile(file, t => { $('stockInfo').textContent = t; }), name: file.name };
    applyStlOrientation();
    setStockMode('stl');
    loadProgram();
  } catch (err) { $('stockInfo').textContent = `${file.name} を読み込めませんでした: ${err.message}`; }
}
for (const id of ['stlUnit', 'stlUp', 'stlRot']) $(id).onchange = () => { applyStlOrientation(); applyTargetOrientation(); if (stlRaw || targetRaw) loadProgram(); };
function setStockMode(mode) {
  stockMode = mode;
  document.querySelectorAll('[data-stock]').forEach(b => b.setAttribute('aria-pressed', b.dataset.stock === mode));
  document.querySelectorAll('[data-for]').forEach(d => d.hidden = d.dataset.for !== mode);
  $('orgSel').querySelector('[value="model"]').disabled = mode !== 'stl';
  if (mode !== 'stl' && $('orgSel').value === 'model') $('orgSel').value = 'auto';
}
document.querySelectorAll('[data-stock]').forEach(b => b.onclick = () => {
  setStockMode(b.dataset.stock);
  if (b.dataset.stock === 'stl' && !stlSpec) $('stlFile').click();
});
$('gcOpen').onclick = () => $('gcFile').click();
$('gcFile').onchange = e => { const f = e.target.files[0]; if (f) openProgram(f); e.target.value = ''; };
$('stlOpen').onclick = () => $('stlFile').click();
// target (finished) shape for the deviation map
function applyTargetOrientation() {
  if (!targetRaw) return;
  targetSpec = { ...orientMesh(targetRaw.mesh, meshOpts(false, targetRaw)), name: targetRaw.name };
}
async function openTarget(file) {
  try {
    targetRaw = { mesh: await readMeshFile(file, t => { $('tgInfo').textContent = t; }), name: file.name };
    applyTargetOrientation();
    const m = targetSpec;
    $('tgInfo').textContent = `${file.name} · ${m.count.toLocaleString()} 三角形 · X ${m.min[0].toFixed(1)}〜${m.max[0].toFixed(1)} Y ${m.min[1].toFixed(1)}〜${m.max[1].toFixed(1)} Z ${m.min[2].toFixed(1)}〜${m.max[2].toFixed(1)} mm (プログラム座標)`;
    $('tgClear').disabled = false;
    loadProgram();
    setColorMode('devTarget');
  } catch (err) { $('tgInfo').textContent = `${file.name} を読み込めませんでした: ${err.message}`; }
}
$('tgOpen').onclick = () => $('tgFile').click();
$('tgFile').onchange = e => { const f = e.target.files[0]; if (f) openTarget(f); e.target.value = ''; };
$('tgClear').onclick = () => {
  targetSpec = null; targetRaw = null; $('tgClear').disabled = true;
  $('tgInfo').textContent = '目標形状を外しました。';
  if (view.colorMode === 'devTarget') setColorMode('devIdeal');
  loadProgram();
};
$('tol').onchange = e => { const v = +e.target.value; if (!(v > 0)) return; sim.cfg.tol = v; host.config(); setColorMode(view.colorMode); };
$('stlFile').onchange = e => { const f = e.target.files[0]; if (f) openStl(f); e.target.value = ''; };
// inside the claude.ai viewer a file is offered through the downloads capability; a plain
// download link is the fallback when the page is opened on its own
let downloads = null;
window.claude?.use?.('downloads').then(d => { downloads = d; }).catch(() => {});
$('gcSave').onclick = async () => {
  const name = $('gcInfo').dataset.file || 'program.nc', text = $('code').value;
  if (downloads) { try { await downloads.save({ filename: name, data: text }); } catch { /* declined */ } return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
// a point picked on the 3D view (snapped to the corners, edge midpoints and face centres of
// the stock): the program zero (G54) or another work offset
let pickBtn = null;
function endPick() {
  view.onPick = null; view.onMiss = null; $('view').classList.remove('picking');
  if (pickBtn) { pickBtn.setAttribute('aria-pressed', 'false'); pickBtn = null; }
  $('orgPick').textContent = '3D 画面でクリックして原点を指定';
}
function startPick(what, apply, btn) {
  if (view.onPick) { endPick(); return; }
  pickBtn = btn || null; pickBtn?.setAttribute('aria-pressed', 'true');
  $('view').classList.add('picking');
  $('stockInfo').textContent = `${what}にする点を 3D 画面でクリックしてください (角・辺の中点・面の中心に吸着、Esc で取り消し)`;
  view.onMiss = () => { $('stockInfo').textContent = '素材の上をクリックしてください (Esc で取り消し)'; };
  view.onPick = p => { endPick(); const msg = apply(p); $('stockInfo').textContent += ` · ${msg}`; };
}
$('orgPick').onclick = () => {
  const on = !view.onPick;
  startPick('プログラム原点 (G54)', p => {
    $('orgSel').value = 'manual'; $('orgSel').onchange();
    $('oX').value = +p.x.toFixed(3); $('oY').value = +p.y.toFixed(3); $('oZ').value = +p.z.toFixed(3);
    loadProgram();
    return `原点を${p.snap ? `素材の${p.snap}` : 'クリックした点'} (X ${p.x.toFixed(2)} Y ${p.y.toFixed(2)} Z ${p.z.toFixed(2)}) にしました`;
  }, $('orgPick'));
  if (on) $('orgPick').textContent = 'クリック待ち… (もう一度押すと取り消し)';
};
addEventListener('keydown', e => {
  if (e.key === 'Escape' && view.onPick) { endPick(); return; }
  // shortcuts while no field has the focus: Space play / pause, Home / End to the start / end
  if (e.defaultPrevented) return;
  const t = e.target, typing = t && t.closest?.('input, textarea, select, button, summary, a, tr, [contenteditable], [role="slider"]');
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); $('btnPlay').click(); }
  else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
  else if (e.key === 'End') { e.preventDefault(); seekTo(sim.totalTime || 0); }
});
// the stock grid: finer shows small parts and walls better, at about (0.3 / cell)³ the cost
$('cellSel').onchange = e => { const v = +e.target.value; if (!(v > 0)) return; sim.cfg.cell = v; host.config(); loadProgram(); };
$('orgSel').onchange = () => { const manual = $('orgSel').value === 'manual'; for (const id of ['oX', 'oY', 'oZ']) $(id).readOnly = !manual; };
for (const id of ['oX', 'oY', 'oZ']) $(id).addEventListener('input', () => { $('orgSel').value = 'manual'; });
// drop a program or an STL anywhere on the page
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropzone').hidden = true;
  const files = [...e.dataTransfer.files];
  const isMesh = f => /\.(stl|obj)$/i.test(f.name) || CAD_RE.test(f.name), isProject = f => /\.json$/i.test(f.name);
  const pj = files.find(isProject);
  if (pj) { pj.text().then(t => { try { openProject(t); } catch (err) { $('pjInfo').textContent = `${pj.name} を開けませんでした: ${err.message}`; } document.querySelector('[data-tab="prog"]').click(); }); return; }
  const stl = files.find(isMesh), prog = files.find(f => !isMesh(f));
  (async () => {
    if (stl) await openStl(stl);
    if (prog) await openProgram(prog);
    document.querySelector('[data-tab="prog"]').click();
  })();
});

function setSpindle(S) {
  S = Math.round(Math.max(0, Math.min(30000, S)));
  $('ovS').value = S;
  $('ovSOut').textContent = `${S} min⁻¹`;
  sim.cfg.spindleOverride = S / baseS;
  host.config();
}
$('ovS').oninput = e => setSpindle(+e.target.value);
$('ovF').oninput = e => { sim.cfg.feedOverride = e.target.value / 100; host.config(); $('ovFOut').textContent = `${e.target.value} %`; };
$('btnPocket').onclick = () => {
  const cur = +$('ovS').value || baseS; // from a stopped spindle: start at the program's speed
  const r = sim.bestSpindle(cur);
  setSpindle(r.S);
  $('pocketHint').textContent = `${cur} → ${r.S} min⁻¹(この切込み条件での安定限界 ${r.alim.toFixed(2)} mm)。`;
};
$('material').onchange = e => { sim.cfg.material = e.target.value; host.config(true); view.mat = sim.mat; view.setStock(sim.stock, sim.mat); updateMatHint(); showJc(); showStart(); };
function updateMatHint() {
  const m = sim.mat;
  $('matHint').textContent = `Ktc ${Math.round(m.Ktc)} / Krc ${Math.round(m.Krc)} N/mm²${m.coefSource ? ` (${m.coefSource})` : ''} · 推奨切削速度の目安 ${m.vc} m/min(φ${sim.activeTool.D} で ${Math.round(m.vc * 1000 / (Math.PI * sim.activeTool.D))} min⁻¹)`;
}
// ---- cutting coefficients predicted from the material's constants (Oxley + Johnson–Cook) ----
const JC_FIELDS = [['A', 'A [MPa]', 1], ['B', 'B [MPa]', 1], ['n', 'n', 0.01], ['C', 'C', 0.001], ['m', 'm', 0.01], ['Tm', '融点 [°C]', 1]];
const jcEdit = {};   // edited constants per material
let oxLast = null;
function jcOf(key) { return jcEdit[key] || (jcEdit[key] = { ...(JC[key] || { A: 300, B: 500, n: 0.3, C: 0.01, m: 1, Tm: MATERIALS[key].Tm }) }); }
function showJc() {
  const key = sim.cfg.material, jc = jcOf(key), box = $('jcGrid');
  box.innerHTML = '';
  for (const [k, label, step] of JC_FIELDS) {
    const l = document.createElement('label'), inp = document.createElement('input');
    inp.type = 'number'; inp.step = step; inp.value = jc[k]; inp.id = `jc-${k}`;
    inp.onchange = () => { const v = +inp.value; if (Number.isFinite(v) && v >= 0) jc[k] = v; };
    l.append(label, inp); box.appendChild(l);
  }
  $('coefReset').hidden = !sim.cfg.coefs?.[key];
  $('oxApply').disabled = !(oxLast && oxLast.key === key);
  if (!(oxLast && oxLast.key === key)) $('oxOut').innerHTML = '';
  $('idApply').disabled = !(idLast && idLast.key === key);
  if (!(idLast && idLast.key === key)) $('idOut').innerHTML = '';
}
$('oxRun').onclick = () => {
  const key = sim.cfg.material, base = MATERIALS[key], t = sim.activeTool;
  const S = +$('ovS').value || baseS, Vc = Math.PI * t.D * S / 1000;
  const rakeDeg = sim.cfg.tool.rakeDeg ?? 10, helixDeg = t.helixDeg ?? 30;
  $('oxOut').textContent = '計算中…';
  setTimeout(() => {
    const p = predictCoefs(jcOf(key), base, { Vc, rakeDeg, helixDeg });
    if (!p) { $('oxOut').textContent = 'この条件では解が見つかりませんでした (定数か切削条件を見直してください)。'; oxLast = null; $('oxApply').disabled = true; return; }
    oxLast = { key, p, Vc };
    const a = p.at, f = v => Math.round(v).toLocaleString();
    $('oxOut').innerHTML = `<table class="oxtable"><thead><tr><th></th><th>予測</th><th>表の値</th></tr></thead><tbody>
      <tr><td>Ktc [N/mm²]</td><td>${f(p.Ktc)}</td><td>${f(base.Ktc)}</td></tr>
      <tr><td>Krc [N/mm²]</td><td>${f(p.Krc)}</td><td>${f(base.Krc)}</td></tr>
      <tr><td>Kac [N/mm²]</td><td>${f(p.Kac)}</td><td>${f(base.Kac)}</td></tr>
      <tr><td>寸法効果 mc</td><td>${p.mc.toFixed(2)}</td><td>${base.mc.toFixed(2)}</td></tr></tbody></table>
      <p class="hint">h = 0.05 mm、Vc ${Math.round(Vc)} m/min、すくい角 ${rakeDeg}°、ねじれ角 ${helixDeg}° での値。せん断角 ${(a.phi * 180 / Math.PI).toFixed(1)}°、切りくず厚さ比 ${(a.t2 / 0.05).toFixed(2)}、接触長さ ${a.h.toFixed(3)} mm、せん断面 ${Math.round(a.TAB)} °C、すくい面 ${Math.round(a.Tint)} °C。` +
      ` 比切削抵抗 (h ごと): ${p.rows.map(q => `${q.h} mm → ${f(q.Ktc)}`).join('、')} N/mm²。工具を鋭利とみなすため、エッジ係数 (Kte/Kre) は表の値のままです。</p>`;
    $('oxApply').disabled = false;
  }, 20);
};
$('oxApply').onclick = () => {
  if (!oxLast || oxLast.key !== sim.cfg.material) return;
  const p = oxLast.p, r = v => Math.round(v);
  sim.cfg.coefs = { ...(sim.cfg.coefs || {}), [oxLast.key]: { Ktc: r(p.Ktc), Krc: r(p.Krc), Kac: r(p.Kac), mc: +p.mc.toFixed(3), source: 'Oxley 予測' } };
  host.config(true); updateMatHint(); showJc();
};
// ---- starting conditions for the material and the tool ----
function showStart() {
  if (!$('scBox').open) return;
  const t = sim.activeTool, mat = sim.mat, rows = [];
  const cases = [['溝 (全幅)', t.D], ['側面 ae 0.3D', 0.3 * t.D], ['高速 ae 0.1D', 0.1 * t.D]];
  // a ball nose finishing shallow: the speed from its effective diameter
  if (t.type === 'ball') cases.push([`仕上げ ap ${(0.05 * t.D).toFixed(2)} (実効径)`, 0.1 * t.D, 0.05 * t.D]);
  for (const [label, ae, apB] of cases) {
    const c = startConditions(mat, t, ae, apB || 0), lob = sim.lobes(c.arc[0], c.arc[1]);
    const a = alimAt(lob, c.S);
    // a stable pocket close by, if it allows clearly more
    let bs = c.S, ba = a;
    for (let s2 = c.S * 0.75; s2 <= Math.min(30000, c.S * 1.25); s2 += 25) { const v = alimAt(lob, s2); if (v > ba && v < Infinity) { ba = v; bs = s2; } }
    const pocket = ba > 1.3 * a ? ` (${Math.round(bs / 10) * 10} min⁻¹ なら ${ba.toFixed(2)} mm)` : '';
    rows.push(`<tr><td>${label}</td><td class="n">${c.S.toLocaleString()}</td><td class="n">${c.fz.toFixed(3)}</td><td class="n">${c.F.toLocaleString()}</td><td class="n">${a < Infinity ? a.toFixed(2) : '—'}${pocket}</td></tr>`);
  }
  const c0 = startConditions(mat, t);
  $('scOut').innerHTML = `<table class="oxtable"><thead><tr><th></th><th>S min⁻¹</th><th>fz mm/刃</th><th>F mm/min</th><th>びびらない ap mm</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <p class="hint">${t.type === 'ball' ? `ボールの仕上げは実効径 φ${startConditions(mat, t, 0.1 * t.D, 0.05 * t.D).Deff.toFixed(2)} (切込みの上端の刃の円) で回転数を決めています。` : ''}切削速度 ${Math.round(c0.Vc)} m/min (推奨 ${mat.vc} m/min${Math.abs(c0.Vc - mat.vc) > 1 ? '、主軸の範囲で制限' : ''})、φ${t.D} ${t.N} 枚刃。fz は超硬エンドミルの溝加工の目安で、径方向切込みが小さいときは最大切りくず厚さが同じになるよう上げています (切りくずの薄肉化)。ap はいまの動特性の安定限界線図から (低速ではプロセスダンピングで実際はこれより深く削れることが多い)。</p>`;
}
$('scBox').ontoggle = showStart;
$('scApply').onclick = () => { const c = startConditions(sim.mat, sim.activeTool); setSpindle(c.S); $('pocketHint').textContent = `推奨条件: ${c.S} min⁻¹ (F ${c.F} mm/min が溝加工の目安。送りはプログラムの F を使います)。`; };

// ---- stability limit at the current speed by time-domain simulation ----
$('tdLim').onclick = () => {
  const d = sim.display, S = d.S || +$('ovS').value, arc = [d.phiSt ?? 0, d.phiEx ?? Math.PI];
  const fz = d.fz > 0 ? d.fz : startConditions(sim.mat, sim.activeTool).fz;
  const lin = alimAt(sim.lobes(arc[0], arc[1]), S);
  $('tdOut').textContent = `${Math.round(S)} min⁻¹ で計算中… (数秒)`; $('tdLim').disabled = true;
  setTimeout(() => {
    const r = timeDomainLimit(sim.activeTool, sim.modalNow(S), sim.mat, S, arc, fz, { nonlinear: sim.cfg.cuttingNonlinear });
    const deg = a => (a * 180 / Math.PI).toFixed(0);
    $('tdOut').textContent = `${Math.round(S)} min⁻¹・係合 ${deg(arc[0])}〜${deg(arc[1])}°・fz ${fz.toFixed(3)} mm: 時間領域の限界 ${r.bracket[1] === Infinity ? `${r.alim.toFixed(1)} mm 以上` : `約 ${r.alim.toFixed(2)} mm`} (線図 ${lin < Infinity ? lin.toFixed(2) : '—'} mm)。${sim.cfg.cuttingNonlinear ? 'プロセスダンピング・寸法効果込み。' : ''}`;
    $('tdLim').disabled = false;
  }, 30);
};

// ---- the time-domain limit over the speed range, computed in a worker of its own ----
/* global __STAB_WORKER_SRC__ */
let stabWorker = null, tdCurve = null;
const tdKey = () => { const d = sim.display, t = sim.activeTool; return JSON.stringify([sim.cfg.material, sim.cfg.coefs?.[sim.cfg.material] || null, t.D, t.N, t.helixDeg, t.type, t.fluteLen, t.stickout, (d.phiSt ?? 0).toFixed(2), (d.phiEx ?? Math.PI).toFixed(2), sim.cfg.modal, sim.cfg.spindleSoft, sim.cfg.cuttingNonlinear, tdCurve?.fz]); };
$('tdCurve').onclick = () => {
  if (typeof __STAB_WORKER_SRC__ !== 'string' || typeof Worker === 'undefined') { $('tdOut').textContent = 'このブラウザでは使えません (Web Worker が必要です)。'; return; }
  if (!stabWorker) {
    stabWorker = new Worker(URL.createObjectURL(new Blob([__STAB_WORKER_SRC__], { type: 'text/javascript' })));
    stabWorker.onmessage = ({ data: r }) => {
      if (!tdCurve || r.key !== tdCurve.key) return;
      if (r.done) { updateCharts(); $('tdOut').textContent = `時間領域の限界 (橙の点、白抜きは 20 mm 以上): ${tdCurve.pts.length} 点。線図より上ならプロセスダンピングなどで安定な範囲です。`; $('tdCurve').disabled = false; return; }
      tdCurve.pts.push({ rpm: r.S, alim: r.alim, open: r.open });
      updateCharts(); // also when paused
      $('tdOut').textContent = `時間領域で計算中… ${tdCurve.pts.length} / ${tdCurve.n} 点 (他の操作はそのまま続けられます)`;
    };
  }
  const d = sim.display, arc = [d.phiSt ?? 0, d.phiEx ?? Math.PI], fz = d.fz > 0 ? d.fz : startConditions(sim.mat, sim.activeTool).fz;
  const [r0, r1] = LOBE_RANGE, n = 18, points = [];
  for (let i = 0; i < n; i++) { const S = Math.round(r0 * (r1 / r0) ** (i / (n - 1))); points.push({ S, modal: sim.modalNow(S) }); }
  const t = sim.activeTool;
  tdCurve = { n, pts: [], fz };
  const key = tdCurve.key = tdKey();
  $('tdCurve').disabled = true; $('tdOut').textContent = '時間領域で計算中…';
  stabWorker.postMessage({ key, points, tool: { N: t.N, R: t.R, helixDeg: t.helixDeg, type: t.type, fluteLen: t.fluteLen }, mat: sim.mat, arc, fz, nonlinear: sim.cfg.cuttingNonlinear });
};

// ---- coefficients identified from cutting tests ----
let idLast = null;
const idTool = () => { const t = sim.activeTool; return { D: t.D, N: t.N, helixDeg: t.helixDeg, type: t.type, fluteLen: t.fluteLen, runout: t.runout ?? 0 }; };
const idMc = () => (sim.cfg.cuttingNonlinear ? sim.mat.mc ?? 0 : 0);
$('idExample').onclick = () => {
  // what a dynamometer would read for the table coefficients, with ±3 % scatter
  const m = MATERIALS[sim.cfg.material], tool = idTool(), mode = $('idMode').value, ae = mode === 'slot' ? tool.D : tool.D * 0.3;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.06;
  const lines = ['# 例: 表の係数から作った値 (±3 % のばらつき)', '# fz ap ae Fx Fy Fz'];
  for (const fz of [0.02, 0.04, 0.06, 0.08]) {
    const U = unitForces(tool, { fz, ap: 2, ae, mode }, idMc());
    const F = [0, 1, 2].map(k => COEF_KEYS.reduce((s, key, j) => s + m[key] * U[j][k], 0) * (1 + rnd()));
    lines.push(`${fz} 2 ${ae.toFixed(1)} ${F.map(v => v.toFixed(1)).join(' ')}`);
  }
  $('idData').value = lines.join('\n');
};
$('idRun').onclick = () => {
  const { tests, bad } = parseTests($('idData').value, $('idMode').value);
  if (!tests.length) { $('idOut').textContent = '試験データがありません (1 行に fz ap ae Fx Fy Fz)。'; return; }
  const key = sim.cfg.material, base = MATERIALS[key];
  const r = identify(idTool(), tests, sim.mat, idMc());
  if (!r) { $('idOut').textContent = '解けませんでした (送りや切込みの違う試験を足してください)。'; idLast = null; $('idApply').disabled = true; return; }
  idLast = { key, r };
  const f = v => Math.round(v).toLocaleString(), g = v => v.toFixed(1);
  const unit = k => (k.endsWith('c') ? 'N/mm²' : 'N/mm');
  $('idOut').innerHTML = `<table class="oxtable"><thead><tr><th></th><th>同定</th><th>表の値</th></tr></thead><tbody>${COEF_KEYS.map(k =>
    `<tr><td>${k} [${unit(k)}]</td><td>${k.endsWith('c') ? f(r.coefs[k]) : g(r.coefs[k])}${r.edgeFixed && !k.endsWith('c') ? ' (固定)' : ''}</td><td>${k.endsWith('c') ? f(base[k]) : g(base[k])}</td></tr>`).join('')}</tbody></table>
    <p class="hint">${tests.length} 試験、決定係数 R² ${r.r2.toFixed(4)}、残差 ${r.rms.toFixed(1)} N (RMS)。${r.edgeFixed ? '送りが 1 種類なので、エッジ係数は今の値のままです。' : ''}${bad.length ? `読めなかった行: ${bad.join(', ')}。` : ''}</p>
    <table class="oxtable" aria-label="試験ごとの測定値と計算値"><caption class="hint" style="text-align:left">測定 / 同定値での計算 [N]</caption><thead><tr><th>fz</th><th>Fx</th><th>Fy</th><th>Fz</th></tr></thead><tbody>${r.rows.map(q =>
      `<tr><td>${q.test.fz}</td><td>${g(q.test.Fx)} / ${g(q.pred[0])}</td><td>${g(q.test.Fy)} / ${g(q.pred[1])}</td><td>${g(q.test.Fz)} / ${g(q.pred[2])}</td></tr>`).join('')}</tbody></table>`;
  $('idApply').disabled = false;
};
$('idApply').onclick = () => {
  if (!idLast || idLast.key !== sim.cfg.material) return;
  const c = idLast.r.coefs, r1 = v => Math.round(v * 10) / 10;
  sim.cfg.coefs = { ...(sim.cfg.coefs || {}), [idLast.key]: { Ktc: Math.round(c.Ktc), Krc: Math.round(c.Krc), Kac: Math.round(c.Kac), Kte: r1(c.Kte), Kre: r1(c.Kre), Kae: r1(c.Kae), mc: idMc(), source: '試験から同定' } };
  host.config(true); updateMatHint(); showJc();
};
// ---- validation against a measured force record ----
let vaRec = null, vaFitRes = null;
const saveText = async (name, text, type = 'text/plain') => {
  if (downloads) { try { await downloads.save({ filename: name, data: text }); } catch { /* declined */ } return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
// the tool of the test: the panel tool, with what the record's header says
const vaTool = () => {
  const t = idTool(), h = vaRec?.rec.test || {};
  return { ...t, D: h.D ?? t.D, N: h.N ?? t.N, helixDeg: h.helix ?? t.helixDeg, runout: h.runout ?? t.runout, runoutPhase: sim.cfg.tool.runoutPhase ?? 0 };
};
const vaTest = () => { const h = vaRec.rec.test; return { S: h.S, fz: h.fz, ap: h.ap, ae: h.ae ?? (h.mode === 'slot' ? vaTool().D : undefined), mode: h.mode }; };
function vaLoad(text, label) {
  const rec = parseRecord(text), h = rec.test;
  vaFitRes = null; $('vaApply').disabled = true; $('vaOut').innerHTML = '';
  const missing = ['S', 'fz', 'ap'].filter(k => !(h[k] > 0)).concat(h.mode !== 'slot' && !(h.ae > 0) ? ['ae'] : []);
  if (rec.t.length < 32 || missing.length) {
    vaRec = null; $('cvVa').hidden = true; $('vaFit').disabled = true;
    $('vaInfo').textContent = rec.t.length < 32 ? `データの行が足りません (${rec.t.length} 行)。1 行に t,Fx,Fy,Fz。` : `条件が足りません: ${missing.join(' ')} を「# S=3000 fz=0.05 ap=2 ae=3 mode=down」の形で書いてください。`;
    return;
  }
  const sa = syncAverage(rec.t, rec.F, h.S);
  vaRec = { rec, sa, label };
  vaShow();
}
// the record against the simulator with the present coefficients and tool (or the fitted ones)
function vaShow() {
  const { rec, sa, label } = vaRec, test = vaTest(), tool = vaTool(), comps = rec.hasZ ? [0, 1, 2] : [0, 1];
  let simRev, cmp;
  if (vaFitRes) { simRev = vaFitRes.sim; cmp = vaFitRes.cmp; }
  else { const s0 = simRevolution(tool, sim.mat, test); simRev = shifted(s0, align(sa.avg, s0)); cmp = compare(sa.avg, simRev, comps); }
  $('cvVa').hidden = false; drawRevolution($('cvVa'), sa.avg, simRev, comps);
  const fs = (rec.t.length - 1) / (rec.t[rec.t.length - 1] - rec.t[0]), ftp = test.S / 60 * tool.N;
  const pk = asyncPeak(rec.t, rec.F, test.S, tool.N, sa.avg), ppAll = Math.max(...cmp.map(c => c.ppM));
  const asyncR = Math.hypot(sa.asyncRms[0], sa.asyncRms[1]) / Math.SQRT2;
  const m = sim.modalNow(test.S), fn = m?.modesX?.[0]?.fn ?? m?.fn;
  let asyncTxt = `回転に同期しない成分 ${asyncR.toFixed(1)} N RMS (波形の山谷の ${(asyncR / ppAll * 100).toFixed(0)}%)`;
  if (pk && pk.share > 0.1) asyncTxt += `、${Math.round(pk.f)} Hz に山 (振幅 ${pk.amp.toFixed(1)} N、非同期成分の ${(pk.share * 100).toFixed(0)}%): びびりか機械の共振の疑い${fn && Math.abs(pk.f - fn) < 0.15 * fn ? ` — 工具の固有振動数 ${Math.round(fn)} Hz に近いので再生びびりの可能性が高い` : ''}`;
  else asyncTxt += '、目立つ周波数の山なし (ノイズ程度)';
  $('vaInfo').innerHTML = `${label.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}: ${rec.t.length.toLocaleString()} 点、${fs.toFixed(0)} Hz サンプリング、${sa.revs.toFixed(1)} 回転を平均${fs < 20 * ftp ? ` <b>(サンプリングが刃の通過 ${ftp.toFixed(0)} Hz の 20 倍未満: 波形の山が丸まります)</b>` : ''}。条件 S${test.S} fz ${test.fz} ap ${test.ap} ae ${test.ae ?? '—'} ${{ slot: '溝', down: 'ダウン', up: 'アップ' }[test.mode]}、工具 φ${tool.D} ${tool.N} 枚刃。<br>${asyncTxt}。${rec.bad.length ? ` 読めなかった行 ${rec.bad.length}。` : ''}`;
  const pct = v => `${v.toFixed(1)}%`;
  $('vaOut').innerHTML = `<table class="oxtable" aria-label="実測と計算の比較"><caption class="hint" style="text-align:left">${vaFitRes ? '同定値での計算' : 'いまの係数と工具での計算'} と実測 (1 回転の平均波形)</caption><thead><tr><th></th><th>平均 実測/計算 [N]</th><th>山谷 実測/計算 [N]</th><th>誤差 RMS</th><th>相関</th></tr></thead><tbody>${cmp.map(c =>
    `<tr><td>${c.comp}</td><td>${c.meanM.toFixed(0)} / ${c.meanS.toFixed(0)}</td><td>${c.ppM.toFixed(0)} / ${c.ppS.toFixed(0)}</td><td>${pct(c.rmsPct)}</td><td>${c.r.toFixed(3)}</td></tr>`).join('')}</tbody></table>
    ${vaFitRes ? `<table class="oxtable" aria-label="同定値"><thead><tr><th></th><th>同定</th><th>いま</th></tr></thead><tbody>${COEF_KEYS.map(k => `<tr><td>${k} [${k.endsWith('c') ? 'N/mm²' : 'N/mm'}]</td><td>${vaFitRes.coefs[k].toFixed(k.endsWith('c') ? 0 : 1)}</td><td>${sim.mat[k].toFixed(k.endsWith('c') ? 0 : 1)}</td></tr>`).join('')}
      <tr><td>振れ [µm]</td><td>${vaFitRes.runout} (向き ${Math.round(vaFitRes.runoutPhase * 180 / Math.PI)}°)</td><td>${tool.runout ?? 0}</td></tr></tbody></table>` : ''}
    <p class="hint">誤差 RMS は実測の山谷に対する割合。目安: 10% 以下でよく合っている、相関 0.95 以上で形が合っている。${vaFitRes ? '' : '合わないときは「波形から係数と振れを同定」。'}</p>`;
  $('vaFit').disabled = false;
}
$('vaOpen').onclick = () => $('vaFile').click();
$('vaFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) vaLoad(await f.text(), f.name); };
$('vaSynth').onclick = () => {
  // a made-up record: the panel material with its coefficients changed, 7 µm runout, 4 % noise and
  // a ringing near the tool's mode (to show what the check reports); labelled as synthetic
  const tool = { ...idTool(), runout: 7, runoutPhase: 1.1 }, m = sim.mat, S = Math.round(sim.S || startConditions(m, sim.activeTool).S || 6000);
  const truth = { ...m, Ktc: m.Ktc * 1.15, Krc: m.Krc * 0.85, Kte: m.Kte * 1.4 };
  const mod = sim.modalNow(S), fn = mod?.modesX?.[0]?.fn ?? mod?.fn ?? 1500;
  const test = { S, fz: 0.05, ap: 2, ae: tool.D * 0.3, mode: 'down' };
  vaLoad(syntheticRecord(tool, truth, test, { noise: 0.04, ring: 0.04, ringHz: fn * 0.97 + 7.3, revs: 30 }), '合成データ (実測ではありません)');
};
$('vaTemplate').onclick = () => saveText('cutting_force_template.csv', ['# 切削抵抗の記録 (このシミュレーターの検証用)',
  '# 1 行目以降の # 行に条件: S [min-1] fz [mm/刃] ap ae [mm] mode=slot|down|up (任意で D N helix [°] runout [µm])',
  '# 列: t [s], Fx Fy Fz [N] (工作物に働く力 = テーブル上の動力計の値。X = 送り方向、Y = 送りの左、Z = 上、M03)',
  '# 目安: サンプリングは刃の通過周波数 (S/60 × 刃数) の 20 倍以上、記録は安定した切削中の 20 回転以上',
  '# 以下の 3 行は書き方の例 (数値はダミー)。消して実測で置き換えてください',
  '# S=3000 fz=0.05 ap=2 ae=3 mode=down D=10 N=3 helix=30', 't,Fx,Fy,Fz', '0.000000,0.0,0.0,0.0', '0.000050,0.0,0.0,0.0', '0.000100,0.0,0.0,0.0'].join('\n'), 'text/csv');
$('vaFit').onclick = () => {
  if (!vaRec) return;
  $('vaFit').disabled = true; $('vaOut').innerHTML = '<p class="hint">同定中… (数秒)</p>';
  setTimeout(() => {
    try {
      const comps = vaRec.rec.hasZ ? [0, 1, 2] : [0, 1];
      vaFitRes = { ...fitRecord(vaTool(), sim.mat, vaTest(), vaRec.sa.avg, { comps }), key: sim.cfg.material };
      $('vaApply').disabled = false;
    } catch (err) { $('vaOut').textContent = `同定できませんでした: ${err.message}`; $('vaFit').disabled = false; return; }
    vaShow();
  }, 30);
};
$('vaApply').onclick = () => {
  if (!vaFitRes || vaFitRes.key !== sim.cfg.material) return;
  const c = vaFitRes.coefs, r1 = v => Math.round(v * 10) / 10;
  sim.cfg.coefs = { ...(sim.cfg.coefs || {}), [vaFitRes.key]: { Ktc: Math.round(c.Ktc), Krc: Math.round(c.Krc), Kac: Math.round(c.Kac), Kte: r1(c.Kte), Kre: r1(c.Kre), Kae: r1(c.Kae), mc: sim.mat.mc ?? 0, source: '波形から同定' } };
  sim.cfg.tool.runout = vaFitRes.runout; sim.cfg.tool.runoutPhase = vaFitRes.runoutPhase; $('tRun').value = vaFitRes.runout;
  host.config(true); updateMatHint(); showJc();
  vaFitRes = null; $('vaApply').disabled = true;
  vaShow();
};
// Coefficients from the cutting simulator: switch to the matching material and lay them over it.
const COEF_HINT = $('coefInfo').textContent;
$('coefLoad').onclick = () => $('coefFile').click();
$('coefFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const r = parseCoeffs(await f.text());
    if (r.material) { sim.cfg.material = r.material; $('material').value = r.material; }
    const key = sim.cfg.material;
    sim.cfg.coefs = { ...(sim.cfg.coefs || {}), [key]: coefsFromFile(r, MATERIALS[key]) };
    host.config(true); view.mat = sim.mat; view.setStock(sim.stock, sim.mat); updateMatHint(); showJc(); showStart();
    const list = Object.entries(r.coeffs).map(([k, v]) => `${k} ${v}`).join(' / ');
    $('coefInfo').textContent = `${f.name}（${r.from}、${r.mode}）を ${MATERIALS[key].name} に適用：${list}` +
      (r.material ? '' : '。対応する材料が表にないので、選択中の材料に当てています');
  } catch (err) { $('coefInfo').textContent = `読み込めませんでした：${err.message}`; }
};
// ---- coefficients sent by the native edition's chip-formation FEM (the page runs in its frame) ----
// { type: 'machsim.coefs', material, coefs: {Ktc, Krc, Kac, Kte, Kre, Kae, mc}, source } from the
// parent window of the same origin: the material is selected and its coefficients replaced
window.addEventListener('message', e => {
  const d = e.data;
  if (e.origin !== location.origin || e.source !== window.parent || d?.type !== 'machsim.coefs' || !MATERIALS[d.material]) return;
  const c = d.coefs, r1 = v => Math.round(v * 10) / 10;
  if (![c.Ktc, c.Krc, c.Kac, c.Kte, c.Kre].every(Number.isFinite)) return;
  sim.cfg.material = d.material; $('material').value = d.material;
  sim.cfg.coefs = { ...(sim.cfg.coefs || {}), [d.material]: { Ktc: Math.round(c.Ktc), Krc: Math.round(c.Krc), Kac: Math.round(c.Kac), Kte: r1(c.Kte), Kre: r1(c.Kre), Kae: r1(c.Kae ?? 0), mc: c.mc ?? 0, source: String(d.source || 'FEM') } };
  host.config(true); view.mat = sim.mat; view.setStock(sim.stock, sim.mat); updateMatHint(); showJc(); showStart();
});
$('coefReset').onclick = () => {
  $('coefInfo').textContent = COEF_HINT;
  if (sim.cfg.coefs) delete sim.cfg.coefs[sim.cfg.material];
  host.config(true); updateMatHint(); showJc();
};
document.querySelectorAll('[data-ttype]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-ttype]').forEach(x => x.setAttribute('aria-pressed', x === b));
  sim.cfg.tool.type = b.dataset.ttype;
  $('rowCR').hidden = b.dataset.ttype !== 'bull';
  if (b.dataset.ttype === 'bull') sim.cfg.tool.cornerR = +$('tCR').value;
  toolChanged();
});
$('tCR').onchange = e => { const v = +e.target.value; if (v > 0) { sim.cfg.tool.cornerR = Math.min(v, sim.cfg.tool.D / 2); toolChanged(); } };
// shank, neck and holder of the panel tool (blank = none)
for (const [id, key] of [['tShank', 'shankD'], ['tNeckD', 'neckD'], ['tNeckL', 'neckLen']]) $(id).onchange = e => {
  const v = +e.target.value;
  if (v > 0) sim.cfg.tool[key] = v; else delete sim.cfg.tool[key];
  toolChanged();
};
for (const [k, h] of Object.entries(HOLDERS)) $('tHolder').add(new Option(h.name, k));
$('tHolder').onchange = e => { sim.cfg.tool.holder = e.target.value; toolChanged(); };
// imported meshes and libraries live outside cfg (typed arrays do not survive its JSON copy)
const assets = {};
const toolInfoHint = $('toolInfo').textContent;
function applyAssets(msg) {
  host.setAssets({ ...assets });
  $('assetClear').hidden = !(assets.stlTool || assets.stlHolder || assets.library);
  $('stlToolBtn').setAttribute('aria-pressed', !!assets.stlTool);
  $('stlHolderBtn').setAttribute('aria-pressed', !!assets.stlHolder);
  $('libBtn').setAttribute('aria-pressed', !!assets.library);
  $('toolInfo').textContent = msg || toolInfoHint;
  // an imported cutter fixes the diameter and the tip shape
  $('tD').disabled = !!assets.stlTool;
  document.querySelectorAll('[data-ttype]').forEach(b => { b.disabled = !!assets.stlTool; });
  if (assets.stlTool) $('tD').value = +sim.activeTool.D.toFixed(3); else $('tD').value = sim.cfg.tool.D;
  showTools(); syncModalInputs(); updateMatHint();
}
async function readStl(file) { const m = await readMeshFile(file, t => { $('toolInfo').textContent = t; }); return { ...m, name: file.name }; }
$('stlToolBtn').onclick = () => $('stlToolFile').click();
$('stlHolderBtn').onclick = () => $('stlHolderFile').click();
$('libBtn').onclick = () => $('libFile').click();
$('stlToolFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const m = await readStl(f); assets.stlTool = m;
    const size = m.max.map((v, k) => v - m.min[k]);
    const tall = size[2] >= Math.max(size[0], size[1]);
    applyAssets(`工具 ${f.name}: 長さ ${size[2].toFixed(1)} mm、最大径 φ${sim.activeTool.D.toFixed(2)}${tall ? '' : '\n⚠ Z 方向が一番長くありません。工具の軸を Z にして書き出してください。'}\n刃長は「刃長」の値 (${sim.cfg.tool.fluteLen} mm) を使います。`);
  } catch (err) { $('toolInfo').textContent = `${f.name} を読み込めませんでした: ${err.message}`; }
};
$('stlHolderFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    assets.stlHolder = await readStl(f); assets.stlHolderName = f.name;
    const sz = assets.stlHolder.max[2] - assets.stlHolder.min[2];
    applyAssets(`ホルダー ${f.name}: 高さ ${sz.toFixed(1)} mm。一番下の面を工具の突出し長の位置 (ゲージ面) に置きます。`);
  } catch (err) { $('toolInfo').textContent = `${f.name} を読み込めませんでした: ${err.message}`; }
};
$('libFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const { tools, skipped } = parseToolLibrary(await f.text());
    if (!tools.length) throw new Error('エンドミル・ドリルが見つかりません');
    assets.library = Object.fromEntries(tools.map(t => [t.T, t]));
    applyAssets(`工具ライブラリ ${f.name}: ${tools.map(t => `T${t.T} φ${+t.D.toFixed(3)}`).join('、')}${skipped.length ? `\n読み飛ばし: ${skipped.slice(0, 5).join('、')}` : ''}\nプログラムの T 番号に合う工具をライブラリから使います。`);
  } catch (err) { $('toolInfo').textContent = `${f.name} を読み込めませんでした: ${err.message}`; }
};
$('assetClear').onclick = () => { for (const k of Object.keys(assets)) delete assets[k]; applyAssets(); };
const toolInputs = { tD: 'D', tN: 'N', tHelix: 'helixDeg', tFlute: 'fluteLen', tStick: 'stickout' };
for (const [id, key] of Object.entries(toolInputs)) $(id).onchange = e => {
  const v = +e.target.value; if (!(v > 0) && key !== 'helixDeg') return;
  sim.cfg.tool[key] = key === 'N' ? Math.round(v) : v;
  if (sim.cfg.tool.stickout < sim.cfg.tool.fluteLen) { sim.cfg.tool.stickout = sim.cfg.tool.fluteLen + 2; $('tStick').value = sim.cfg.tool.stickout; }
  toolChanged();
};
// coating: the look of the flutes only (cutting coefficients and wear are the material's)
$('tRun').onchange = e => { const v = +e.target.value; if (!(v >= 0 && v <= 100)) return; sim.cfg.tool.runout = v; host.config(true); };
$('tCoat').onchange = e => { sim.cfg.tool.coating = e.target.value; host.config(true); view.setCoating(e.target.value); };
$('tRake').onchange = e => { const v = +e.target.value; if (!(v >= -10 && v <= 25)) return; sim.cfg.tool.rakeDeg = v; host.config(); };
// initial wear applies from the start of the program
$('tVB0').onchange = e => { const v = +e.target.value; if (!(v >= 0 && v <= 0.5)) return; sim.cfg.tool.VB0 = v; host.config(); restart(); };
function toolChanged() { host.config(true); showTools(); }
$('mAuto').onchange = e => { sim.cfg.modal.auto = e.target.checked; if (e.target.checked) clearFrf(); host.config(true); syncModalInputs(); };
$('mK').onchange = e => { sim.cfg.modal.k = +e.target.value * 1000; manualModal(); };
$('mFn').onchange = e => { sim.cfg.modal.fn = +e.target.value; manualModal(); };
$('mZeta').onchange = e => { sim.cfg.modal.zeta = +e.target.value; clearFrf(); host.config(true); };
function manualModal() { sim.cfg.modal.auto = false; $('mAuto').checked = false; clearFrf(); host.config(true); syncModalInputs(); }
function syncModalInputs() {
  $('mK').value = (sim.cfg.modal.k / 1000).toFixed(1);
  $('mFn').value = sim.cfg.modal.fn;
  $('mZeta').value = sim.cfg.modal.zeta;
  $('mK').disabled = $('mFn').disabled = false;
  // the two-mode model of the tool on its spindle (with the tool model only)
  const sm = sim.cfg.modal.spindleMode, on = !!sm?.on && sim.cfg.modal.auto;
  $('mSp').checked = on; $('mSp').disabled = !sim.cfg.modal.auto;
  $('rowSpFn').hidden = !on; $('mSpInfo').hidden = !on;
  if (on) {
    const ms = sim.modalNow(0).modesX;
    const zs = sm.zeta ?? 0.05, zt = sim.cfg.modal.zeta, part = (m, i) => (zs !== zt ? (m.zeta === zs ? '主軸' : '工具') : i ? '工具' : '主軸');
    $('mSpInfo').textContent = `静止時の工具先端: ${ms.map((m, i) => `${part(m, i)}のモード ${Math.round(m.fn)} Hz (${(m.k / 1000).toFixed(1)} N/µm)`).join('、')}。主軸側の剛性 ${(sim.chain().kSp / 1000).toFixed(0)} N/µm と固有振動数から質量 ${sim.chain().twoDof.mSp.toFixed(2)} kg を決めます。回転による剛性低下は主軸側のばねにだけ効きます。`;
  }
}
$('mSp').onchange = e => { sim.cfg.modal.spindleMode = { ...(sim.cfg.modal.spindleMode || { fn: +$('mSpFn').value, zeta: 0.05 }), on: e.target.checked }; host.config(true); syncModalInputs(); };
$('mSpFn').onchange = e => { const v = +e.target.value; if (!(v >= 200 && v <= 5000)) return; sim.cfg.modal.spindleMode = { ...(sim.cfg.modal.spindleMode || { zeta: 0.05 }), on: true, fn: v }; host.config(true); syncModalInputs(); };
// measured FRF: fit modes per direction, show the dominant one in the single-mode inputs
const frfHint = $('frfInfo').innerHTML;
const fmtModes = ms => ms.map(m => `${Math.round(m.fn)} Hz, ${(m.k / 1000).toFixed(1)} N/µm, ζ ${m.zeta.toFixed(3)}`).join(' ・ ');
function applyFrf(text, name) {
  try {
    const d = parseFrfCsv(text);
    const mx = fitModes(d.f, d.xx), my = d.yy ? fitModes(d.f, d.yy) : mx;
    if (!mx.length || !my.length) throw new Error('共振のピークが見つかりません');
    const m = sim.cfg.modal, dom = dominant([...mx, ...my]);
    const Sm = $('frfS').value === '' ? null : +$('frfS').value;
    if (Sm !== null && Sm >= 0) {
      // measured at speed: one entry per spindle speed, interpolated in between
      m.speedFrfs = [...(m.speedFrfs || []).filter(e => Math.abs(e.S - Sm) > 1), { S: Sm, modesX: mx, modesY: my, name }].sort((a, b) => a.S - b.S);
    }
    Object.assign(m, { auto: false, modesX: mx, modesY: my, k: Math.round(Math.min(staticK(mx), staticK(my))), fn: Math.round(dom.fn), zeta: +dom.zeta.toFixed(3) });
    $('mAuto').checked = false;
    host.config(true); syncModalInputs();
    $('frfClear').disabled = false;
    const list = m.speedFrfs?.length ? `\n回転数別: ${m.speedFrfs.map(e => `${e.S} min⁻¹ (${Math.round(dominant([...e.modesX, ...e.modesY]).fn)} Hz)`).join(' ・ ')}` : '';
    $('frfInfo').textContent = `${name} (${d.f.length} 点, ${d.unit}${Sm !== null ? `, ${Sm} min⁻¹` : ', 静止'}) から同定\nX: ${fmtModes(mx)}\nY: ${fmtModes(my)}${list}`;
    showSpeedInfo();
  } catch (err) { $('frfInfo').textContent = `読み込めませんでした: ${err.message}`; }
}
function clearFrf() {
  if (!sim.cfg.modal.modesX && !sim.cfg.modal.speedFrfs) return;
  sim.cfg.modal.modesX = sim.cfg.modal.modesY = null; sim.cfg.modal.speedFrfs = null;
  $('frfClear').disabled = true; $('frfInfo').innerHTML = frfHint;
}
$('frfLoad').onclick = () => $('frfFile').click();
$('spSoft').onchange = e => { const v = +e.target.value; if (!(v >= 0 && v <= 60)) return; sim.cfg.spindleSoft = { ...sim.cfg.spindleSoft, drop: v / 100 }; host.config(true); showSpeedInfo(); };
// what the speed model does to the tool tip at the current speed
function showSpeedInfo() {
  const S = Math.round(sim.S || +$('ovS').value || 0), m = sim.cfg.modal;
  if (m.speedFrfs?.length) { $('spInfo').textContent = `回転数別の実測 FRF (${m.speedFrfs.length} 件) を使用中。剛性低下のモデルは使いません。`; return; }
  const f = sim.speedFactor(S), d = Math.round((sim.cfg.spindleSoft?.drop ?? 0) * 100);
  const fn0 = sim.modalNow(0).modesX[0].fn, fnS = sim.modalNow(S).modesX[0].fn;
  $('spInfo').textContent = d ? `${S} min⁻¹ で工具先端の剛性 ${((f - 1) * 100).toFixed(1)}%、固有振動数 ${Math.round(fn0)} → ${Math.round(fnS)} Hz (主軸側の剛性 −${d}% @30000 min⁻¹ のモデル)。` : '回転による変化は計算していません (0%)。';
}
$('frfFile').onchange = async e => { const f = e.target.files[0]; if (f) applyFrf(await f.text(), f.name); e.target.value = ''; };
$('frfExample').onclick = () => applyFrf(exampleCsv(), '例: ホルダ+工具の2モード');
$('frfClear').onclick = () => { clearFrf(); sim.cfg.modal.auto = true; $('mAuto').checked = true; host.config(true); syncModalInputs(); };
document.querySelectorAll('[data-cool]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-cool]').forEach(x => x.setAttribute('aria-pressed', x === b));
  sim.cfg.coolant = b.dataset.cool;
  $('nozzleBox').hidden = COOLANTS[sim.cfg.coolant]?.jet !== 'nozzle';
  host.config();
});
function nozzleChanged() {
  sim.cfg.nozzle = { ...sim.cfg.nozzle, az: +$('nzAz').value, h: +$('nzH').value };
  const n = sim.cfg.nozzle, elev = Math.atan2(n.h, n.dist) * 180 / Math.PI;
  $('nzAzOut').textContent = `${n.az}°`; $('nzHOut').textContent = `${n.h} mm (仰角 ${elev.toFixed(0)}°)`;
  host.config();
}
$('nzAz').oninput = nozzleChanged; $('nzH').oninput = nozzleChanged;
$('exag').oninput = e => { view.exag = +e.target.value; $('exagOut').textContent = `×${e.target.value}`; };
$('showChips').onchange = e => { view.showChips = e.target.checked; };
$('showPath').onchange = e => { view.showPath = e.target.checked; };
// tool path coloured by the machining report: peak force on a blue → red ramp up to the
// heaviest line, or the line's state (chatter red, needs a look amber, clean green)
let pathColorKey = '';
function updatePathColors(force = false) {
  const mode = $('pathColor').value, rep = mode === 'kind' ? null : currentReport();
  const key = mode === 'kind' ? 'kind' : `${mode}|${rep ? rep.lines.size : 0}|${reportShown}`;
  if (!force && key === pathColorKey) return;
  pathColorKey = key;
  if (!rep) { view.colorPath(null); return; }
  if (mode === 'force') {
    let top = 0; for (const r of rep.lines.values()) if (r.cut > 0) top = Math.max(top, r.F);
    const ramp = t => [0.2 + 0.75 * t, 0.55 + 0.35 * Math.sin(Math.PI * t) - 0.3 * t, 0.95 - 0.8 * t];
    view.colorPath(l => { const r = rep.lines.get(l); return r && r.cut > 0 && top > 0 ? ramp(Math.min(1, r.F / top)) : r ? [0.45, 0.5, 0.58] : null; });
    $('pathColorHint').textContent = `青 → 赤: 行の最大切削抵抗 (0〜${top.toFixed(0)} N)、灰: 空送り。加工レポートの値です。`;
  } else {
    const bad = new Map(rep.summary({ stress: ALLOWABLE_STRESS, temp: 900, swing: SWING_CRACK }).issues.map(i => [i.line, i.why]));
    view.colorPath(l => { const r = rep.lines.get(l); if (!r || !(r.cut > 0)) return r ? [0.45, 0.5, 0.58] : null; const w = bad.get(l); return !w ? [0.3, 0.8, 0.45] : w.some(x => BAD.has(x)) ? [0.95, 0.25, 0.2] : [0.98, 0.7, 0.15]; });
    $('pathColorHint').textContent = '緑: 問題なし、黄: 注意 (振動注意・応力高め・高温・熱亀裂)、赤: びびり・応力超過、灰: 空送り。';
  }
}
$('pathColor').onchange = () => { if ($('pathColor').value === 'kind') $('pathColorHint').textContent = '加工レポートの行ごとの値で経路を色分けします (計算した行から)。'; updatePathColors(true); };
$('workFlex').onchange = e => { sim.cfg.workpieceFlex = e.target.checked; host.config(true); };
$('cutNl').onchange = e => { sim.cfg.cuttingNonlinear = e.target.checked; host.config(true); };
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view.setView(b.dataset.view));
function setColorMode(mode) {
  document.querySelectorAll('[data-color]').forEach(x => x.setAttribute('aria-pressed', x.dataset.color === mode));
  view.colorMode = mode;
  $('legend').hidden = mode === 'material';
  const dev = mode === 'devIdeal' || mode === 'devTarget';
  $('legendBar').style.background = dev ? 'linear-gradient(90deg, #d12e24, #8f949c 35% 65%, #2461d6)' : '';
  if (dev) {
    // commanded vs simulated: µm scale; target: around the tolerance
    const tol = sim.cfg.tol ?? 0.05;
    view.devScale = mode === 'devIdeal' ? 0.05 : Math.max(4 * tol, 0.02); view.devTol = mode === 'devIdeal' ? 0.002 : tol;
    const f = v => mode === 'devIdeal' ? `${(v * 1000).toFixed(0)} µm` : `${v} mm`;
    $('legend0').textContent = `削り過ぎ −${f(view.devScale)}`;
    $('legend1').textContent = `+${f(view.devScale)} 削り残し`;
  } else {
    $('legend0').textContent = '0';
    $('legend1').textContent = mode === 'vibration' ? '40 µm' : mode === 'wall' ? '50 µm' : `${sim.stock.zTop - sim.stock.zBottom} mm`;
  }
  view.updateStock(true);
}
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => setColorMode(b.dataset.color));
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
});
let lobeBox = null;
$('cvLobes').addEventListener('click', e => {
  if (!lobeBox) return;
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left;
  const t = (x - lobeBox.x) / lobeBox.w;
  if (t >= 0 && t <= 1) setSpindle(LOBE_RANGE[0] + t * (LOBE_RANGE[1] - LOBE_RANGE[0]));
});
const LOBE_RANGE = [4000, 30000];

refreshTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTheme);
new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- loop ----------
const STATE_LABEL = { idle: '待機中', stable: '安定切削', marginal: '振動 注意', chatter: 'びびり発生' };
let lastHits = null;
let last = performance.now(), uiTick = 0, chartTick = 0, spinAngle = 0;
function frameLoop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  host.frame(dt, running);
  if (running && sim.done) { running = false; host.setRunning(false); $('btnPlay').textContent = '▶ もう一度'; }
  const e = sim.engine;
  // true spindle speed scaled by the playback speed; above a few degrees per frame per flute
  // the flutes alias, so the view switches to a motion-blurred cylinder
  const revPerS = running && sim.S > 0 ? sim.S / 60 * sim.speed : 0;
  const dTheta = revPerS * dt * 2 * Math.PI;
  const blur = Math.min(1, Math.max(0, (dTheta * sim.activeTool.N / (2 * Math.PI) - 0.12) / 0.3));
  spinAngle += blur >= 1 ? dt * 2 * Math.PI * 0.7 : dTheta; // when fully blurred, a slow drift keeps the highlights alive
  view.setPathProgress(sim.seg || 0);
  if (sim.toolVersion !== viewToolVersion) { viewToolVersion = sim.toolVersion; view.setTool(sim.activeTool); syncModalInputs(); updateMatHint(); }
  const wall = sim.display.cutting ? sim.wall : null;
  view.updateWallDeform(wall && e.wk ? wall : null, (e.runMeanW || 0) * 1e3 * view.exag);
  view.updateStock();
  view.updateTool(sim.pos, (e.x || 0) * 1e3 * view.exag, (e.y || 0) * 1e3 * view.exag, spinAngle, blur, sim.display.collide);
  if (sim.hits !== lastHits) { lastHits = sim.hits; view.setHits(sim.hits); }
  view.updateNozzle(sim.cfg.coolant, sim.pos, sim.cfg.nozzle);
  view.updateSpray(sim.cfg.coolant, sim.pos, running && sim.S > 0, sim.activeTool.R);
  view.updateChips(sim.chips, sim.mat);
  view.updatePool(sim.chips.pool);
  const dd = sim.display, cl = COOLANTS[sim.cfg.coolant];
  view.updateSparks({ active: running && dd.cutting, pos: sim.pos, R: sim.activeTool.R, ap: dd.ap, ux: e.ux ?? 1, uy: e.uy ?? 0, phiSt: dd.phiSt ?? 0, phiEx: dd.phiEx ?? Math.PI,
    tempChip: dd.tempChip ?? 20, mrr: dd.mrr, burns: sim.cfg.material === 'Ti64', quench: !!cl?.liquid });
  view.render();
  if (now - uiTick > 120) { uiTick = now; updateTiles(); }
  if (now - chartTick > 90) { chartTick = now; updateCharts(); }
  requestAnimationFrame(frameLoop);
}

function updateTiles() {
  const d = sim.display;
  $('statePill').dataset.s = d.state; $('statePill').textContent = STATE_LABEL[d.state];
  $('tileVib').dataset.s = d.state;
  $('clock').textContent = `${sim.mtime.toFixed(1)} / ${sim.totalTime.toFixed(1)} s`;
  const pct = Math.min(100, sim.mtime / (sim.totalTime || 1) * 100);
  $('prog').style.width = `${pct}%`; $('progBar').setAttribute('aria-valuenow', pct.toFixed(0));
  const tl = sim.activeT != null ? `T${sim.activeT} ` : '';
  $('lineInfo').textContent = sim.line ? `${tl}${sim.line}行  ${codeLines[sim.line - 1]?.trim() ?? ''}` : 'プログラム先頭';
  setV('vF', d.F.toFixed(0), 'N'); $('sF').textContent = `最大 ${d.Fmax.toFixed(0)} N · 軸方向 ${d.Fz.toFixed(0)} N`;
  setV('vT', d.torque.toFixed(2), 'N·m'); $('sT').textContent = `${d.power.toFixed(2)} kW · ${Math.round(d.S)} min⁻¹`;
  // the tool tip as it is at the current speed
  const mNow = sim.modalNow(sim.S || +$('ovS').value), xNow = mNow.modesX;
  setV('vD', d.defl.toFixed(1), 'µm'); $('sD').textContent = sim.cfg.modal.modesX || sim.cfg.modal.speedFrfs ? `実測FRF · X ${xNow.length} / Y ${mNow.modesY.length} モード${sim.cfg.modal.speedFrfs ? ' (回転数別)' : ''}` : `k = ${(xNow[0].k / 1000).toFixed(1)} N/µm · fn ${Math.round(xNow[0].fn)} Hz${Math.abs(xNow[0].fn - sim.cfg.modal.fn) >= 1 ? ' (回転中)' : ''}`;
  setV('vW', d.wallDefl.toFixed(1), 'µm');
  $('sW').textContent = !sim.cfg.workpieceFlex ? '計算オフ' : d.wall ? `壁厚 ${d.wall.t.toFixed(1)} · 高さ ${d.wall.hWall.toFixed(0)} mm · k ${(d.wall.k / 1000).toFixed(1)} N/µm` : '剛体として扱い中';
  setV('vV', d.vib.toFixed(1), 'µm'); $('sV').textContent = `同期外成分 ${d.once.toFixed(1)} µm`;
  setV('vS', d.stress.toFixed(0), 'MPa');
  $('stS').textContent = `許容目安 1500 MPa${d.clearance != null ? ` · ${d.clearance < 0 ? `干渉 ${(-d.clearance).toFixed(1)} mm` : `すきま ${d.clearance.toFixed(1)} mm`}` : ''}`;
  const sr = d.stress / ALLOWABLE_STRESS;
  $('mS').style.width = `${Math.min(100, sr * 100)}%`;
  $('mS').style.background = sr > 1 ? 'var(--bad)' : sr > 0.6 ? 'var(--warn)' : 'var(--ok)';
  setV('vM', d.mrr.toFixed(1), 'cm³/min'); $('sM').textContent = `ap ${d.ap.toFixed(2)} mm · fz ${d.fz.toFixed(3)} mm`;
  // milling: the peak of the edge's cycle over a revolution; otherwise the quasi-steady value
  const cy = d.cutting && d.tempCycle?.swing > 1 ? d.tempCycle : null, peak = cy ? cy.max : d.tempTool;
  setV('vH', peak.toFixed(0), '°C');
  $('sH').textContent = cy ? `1 回転で ${cy.min.toFixed(0)}〜${cy.max.toFixed(0)} °C (変動 ${cy.swing.toFixed(0)} °C) · 連続切削なら ${d.tempTool.toFixed(0)} °C`
    : d.cutting ? `切りくず ${d.tempChip.toFixed(0)} °C · 平均 h ${(d.hMean * 1000).toFixed(0)} µm` : `切りくず ${d.tempChip.toFixed(0)} °C`;
  $('sH').title = cy ? `切削中の平均 ${cy.onMean.toFixed(0)} °C (摩耗の計算に使う)、接触 ${cy.tOn.toFixed(2)} ms/回転、切りくず ${d.tempChip.toFixed(0)} °C、熱応力の振幅 約 ${Math.round(cy.stress / 10) * 10} MPa。変動が ${SWING_CRACK} °C を超えると熱亀裂 (くし状の割れ) が出やすくなります。` : '';
  $('tileHeat').dataset.s = peak > 900 ? 'chatter' : peak > 700 || (cy?.swing ?? 0) > SWING_CRACK ? 'marginal' : 'stable';
  setV('vWr', (d.VB * 1000).toFixed(1), 'µm');
  const wr = d.VB / VB_LIMIT;
  $('mWr').style.width = `${Math.min(100, wr * 100)}%`;
  $('mWr').style.background = wr > 1 ? 'var(--bad)' : wr > 0.6 ? 'var(--warn)' : 'var(--ok)';
  const tName = sim.activeT != null ? `T${sim.activeT} · ` : '';
  $('sWr').textContent = tName + (d.lifeMin < Infinity ? `この条件の残り寿命 ${d.lifeMin > 600 ? '10 h 超' : d.lifeMin.toFixed(1) + ' 分'}` : `寿命 VB ${VB_LIMIT * 1000} µm`);
  showDeviation(d.dev);
  showSpeedInfo();
  updateReport(); updatePathColors();
  const cs = sim.chips.stats;
  // share of the chip volume that has left the workpiece (chips still in flight over it are not yet out)
  const evacPct = cs.producedVol > 0 ? Math.min(100, cs.evacVol / cs.producedVol * 100) : 0;
  const recutPct = cs.producedVol > 0 ? cs.recutVol / cs.producedVol * 100 : 0;
  setV('vC', evacPct.toFixed(0), '% 排出');
  $('sC').textContent = `残留 ${cs.restVol.toFixed(0)} mm³ · 再切削 ${cs.recut} 回`;
  $('sC').title = `素材上に止まっている切粉 ${cs.restVol.toFixed(0)} mm³ (うち溝・ポケット内 ${(cs.pocketVol ?? 0).toFixed(0)} mm³)\n再切削 ${cs.recut} 回 (切粉体積の ${recutPct.toFixed(1)}%)\n刃溝の充填率 ${Math.round(d.pack * 100)}% (1刃の切粉のかさ / 刃溝容積)`;
  const j = cs.jet;
  $('coolHint').textContent = !COOLANTS[sim.cfg.coolant] ? 'ノズルなし: 切粉は刃から飛び出す勢いと工具の旋回流だけで動きます。'
    : !j ? '' : j.miss ? '噴流が素材に当たっていません。'
    : j.shadow ? `噴流がポケットの縁 (Z ${j.z.toFixed(1)}) に当たり、底まで届いていません。ノズルを高くしてください。`
    : `${COOLANTS[sim.cfg.coolant].jet === 'tool' ? '工具先端から' : '工具付近で'} ${j.U.toFixed(j.U < 10 ? 1 : 0)} m/s で衝突し、床に沿って広がります。`;
  // alerts
  const box = $('alerts'); box.innerHTML = '';
  for (const a of sim.alerts.values()) if (sim.mtime - a.t < 3) { const div = document.createElement('div'); div.className = 'alert'; div.textContent = a.msg; box.appendChild(div); }
}
// dimension error: against the target when one is loaded, else against the commanded cut
function showDeviation(dev) {
  const r = dev?.target || dev?.ideal;
  if (!r) { setV('vDv', '—', ''); $('sDv').textContent = targetSpec ? '加工が進むと目標形状と比べます' : '切削後に指令経路と比べます'; $('tileDev').dataset.s = 'stable'; return; }
  const um = v => Math.abs(v) < 1 ? `${(v * 1000).toFixed(Math.abs(v) < 0.01 ? 1 : 0)} µm` : `${v.toFixed(2)} mm`;
  const at = a => a?.line ? ` (${a.line}行)` : '';
  const worst = Math.max(r.left, -r.gouge);
  const [num, unit] = um(worst).split(' ');
  setV('vDv', num, unit);
  const tol = dev.tol;
  $('tileDev').dataset.s = worst > tol ? 'chatter' : worst > tol / 2 ? 'marginal' : 'stable';
  const head = dev.target ? `目標比 · 公差内 ${(r.inTol / Math.max(1, r.n) * 100).toFixed(1)}%` : '指令比';
  $('sDv').textContent = `${head} · 削り残し ${um(r.left)}${at(r.atLeft)} · 削り過ぎ ${um(-r.gouge)}${at(r.atGouge)}`;
}
// ---------- seeking ----------
// jump to machine time t [s]: backwards means cutting again from the start
function seekTo(t) {
  t = Math.max(0, Math.min(sim.totalTime || 0, t));
  if (t < sim.mtime - 1e-6 || sim.done) restart();
  host.seek(t);
  $('lineInfo').textContent = `${t.toFixed(1)} s まで計算中…`;
}
// machine time at which program line n starts cutting (its first move)
function lineStart(n) {
  const p = sim.path;
  for (let i = 1; i < p.length; i++) if (p[i].line === n) return sim.times[i - 1];
  return null;
}
{
  const bar = $('progBar');
  const at = ev => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (sim.totalTime || 0); };
  bar.addEventListener('pointerdown', ev => { bar.setPointerCapture(ev.pointerId); bar.dataset.drag = '1'; });
  bar.addEventListener('pointerup', ev => { if (bar.dataset.drag) { delete bar.dataset.drag; seekTo(at(ev)); } });
  bar.addEventListener('keydown', ev => {
    const step = (sim.totalTime || 0) * (ev.shiftKey ? 0.1 : 0.02);
    if (ev.key === 'ArrowRight') { ev.preventDefault(); seekTo(sim.mtime + step); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); seekTo(sim.mtime - step); }
    else if (ev.key === 'Home') { ev.preventDefault(); seekTo(0); }
    else if (ev.key === 'End') { ev.preventDefault(); seekTo(sim.totalTime || 0); }
  });
}

// ---------- machining report ----------
const BAD = new Set(['びびり', '応力超過']);
// the worker's report, unpacked once per packet (it comes about twice a second)
let packSeen = null, packRep = null;
function currentReport() {
  if (!host.threaded) return sim.report;
  if (!sim.reportPack) return null;
  if (sim.reportPack !== packSeen) { packSeen = sim.reportPack; packRep = LineReport.unpack(packSeen); }
  return packRep;
}
let reportShown = '', reportPackShown = null;
// a finished run kept as the reference the next runs are compared with
let baseline = null, lastNums = null;
// what the advice needs about a line: its speed and feed, and its stability lobes
function adviceCtx(line) {
  const pt = sim.path.find(p => p.line === line && !p.rapid);
  return {
    mat: sim.mat, nonlinear: sim.cfg.cuttingNonlinear, S: pt ? pt.S * (sim.cfg.spindleOverride ?? 1) : 0, F: pt ? pt.F * (sim.cfg.feedOverride ?? 1) : 0,
    D: sim.activeTool.D, rakeDeg: sim.cfg.tool.rakeDeg ?? 10, limits: { stress: ALLOWABLE_STRESS, temp: 900, swing: SWING_CRACK },
    stability: (r, S) => {
      if (!(S > 0) || !(r.pex > r.pst)) return null;
      const ck = `${r.pst.toFixed(2)}|${r.pex.toFixed(2)}|${Math.round(S)}|${r.ap.toFixed(2)}|${sim.toolVersion}|${sim.cfg.material}`;
      if (stabCache.has(ck)) return stabCache.get(ck);
      if (stabCache.size > 500) stabCache.clear();
      const res = stabilityOf(r, S); stabCache.set(ck, res); return res;
    },
  };
}
const stabCache = new Map();
// the limit of a line's engagement at its speed, and a stable pocket nearby (cached per run)
function stabilityOf(r, S) {
  const lob = sim.lobes(r.pst, r.pex), alim = alimAt(lob, S);
  if (!(alim < Infinity)) return null;
  let pocketS = 0, pocketA = alim;
  for (let s2 = Math.max(2000, S * 0.75); s2 <= Math.min(30000, S * 1.25); s2 += 50) { const a = alimAt(lob, s2); if (a > pocketA && a < Infinity) { pocketA = a; pocketS = s2; } }
  return { alim, pocketS: pocketA > 1.3 * alim && pocketA > r.ap ? Math.round(pocketS / 10) * 10 : 0, pocketA };
}
const partsPerTool = (VB, VB0 = 0) => { const n = Math.floor((VB_LIMIT - VB0) / (VB - VB0)); return n > 9999 ? '1 万' : n.toLocaleString(); };
function updateReport() {
  const rep = currentReport();
  if (!rep || !rep.lines.size) {
    if (reportShown !== 'empty') { reportShown = 'empty'; $('rSum').innerHTML = ''; $('rTable').tBodies[0].innerHTML = ''; $('hReport').textContent = '加工が始まると、プログラムの行ごとにまとめます'; }
    return;
  }
  // rebuilt when a new report arrives (threaded) or at most twice a second (local stepping)
  const now = performance.now(), fresh = host.threaded ? packSeen : Math.floor(now / 500);
  const pre = `${sim.done}|${!!baseline}`;
  if (reportShown && reportShown.startsWith(pre + '#') && reportPackShown === fresh) return;
  reportPackShown = fresh;
  const r = rep.summary({ stress: ALLOWABLE_STRESS, temp: 900, swing: SWING_CRACK });
  const key = `${pre}#${r.time.toFixed(1)}|${r.issues.length}`;
  if (key === reportShown) return;
  reportShown = key;
  const lineOf = n => (codeLines[n - 1] || '').trim();
  const at = rec => rec ? ` (${rec.line}行)` : '';
  const items = [
    ['加工時間', `${r.time.toFixed(1)} s`], ['うち切削', `${r.cut.toFixed(1)} s`], ['空送り (削らない送り)', `${r.air.toFixed(1)} s`],
    ['びびりの時間', `${(r.chatterShare * 100).toFixed(0)} %`],
    ['最大切削抵抗', r.peakF ? `${r.peakF.F.toFixed(0)} N${at(r.peakF)}` : '—'],
    ['最大振動', r.peakVib ? `${r.peakVib.vib.toFixed(1)} µm${at(r.peakVib)}` : '—'],
    ['最高刃先温度', r.peakTemp?.temp > 25 ? `${r.peakTemp.temp.toFixed(0)} °C${at(r.peakTemp)}` : '—'],
    ['最大工具応力', r.peakStress ? `${r.peakStress.stress.toFixed(0)} MPa${at(r.peakStress)}` : '—'],
    // wear per run, and how many parts the tool lasts at this rate (flank wear grows about
    // linearly with the contact time in the wear law, so the parts scale with VB_LIMIT / VB)
    ...r.tools.map(([T, [VB, VB0]]) => [`摩耗 ${T === '-' ? '工具' : 'T' + T}`, `VB ${(VB * 1000).toFixed(1)} µm${sim.done && VB - VB0 > 1e-6 ? ` · 約 ${partsPerTool(VB, VB0)} 個/本` : ''}`]),
  ];
  // numbers to compare against a saved run (all better when lower)
  const nums = { 加工時間: r.time, うち切削: r.cut, '空送り (削らない送り)': r.air, びびりの時間: r.chatterShare * 100, 最大切削抵抗: r.peakF?.F, 最大振動: r.peakVib?.vib, 最高刃先温度: r.peakTemp?.temp, 最大工具応力: r.peakStress?.stress };
  for (const [T, [VB, VB0]] of r.tools) nums[`摩耗 ${T === '-' ? '工具' : 'T' + T}`] = (VB - VB0) * 1000;
  lastNums = { nums, name: `${$('gcInfo').dataset.file || SAMPLES[$('sample').value]?.name || 'プログラム'} · ${Math.round(sim.display.S || +$('ovS').value)} min⁻¹`.slice(0, 48), mat: sim.mat.name };
  const dl = $('rSum'); dl.innerHTML = '';
  for (const [k, v] of items) {
    const d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dd.title = v; d.append(dt, dd);
    const b = baseline?.nums[k], c = nums[k];
    if (b != null && c != null && sim.done) {
      const cmp = document.createElement('span'), fx = v => v.toFixed(Math.abs(v) < 10 ? 1 : 0);
      if (b > 1e-9) {
        const rel = (c - b) / b;
        cmp.className = `cmp ${Math.abs(rel) < 0.02 ? '' : rel < 0 ? 'better' : 'worse'}`;
        cmp.textContent = `基準 ${fx(b)} → ${Math.abs(rel) < 0.005 ? '±0' : `${rel > 0 ? '+' : ''}${(rel * 100).toFixed(0)} %`}`;
      } else {
        // a zero baseline (no chatter, no wear): the change itself
        cmp.className = `cmp ${c > 1e-6 ? 'worse' : ''}`;
        cmp.textContent = `基準 0 → ${c > 1e-6 ? `+${fx(c)}` : '±0'}`;
      }
      dd.title += ` (基準: ${baseline.name})`; dd.appendChild(cmp);
    }
    dl.appendChild(d);
  }
  const tb = $('rTable').tBodies[0]; tb.innerHTML = '';
  for (const it of r.issues.slice(0, 30)) {
    const tr = document.createElement('tr'); tr.tabIndex = 0;
    const td = (v, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; c.textContent = v; tr.appendChild(c); return c; };
    const pc = td(''), pb = document.createElement('button'); pb.className = 'play'; pb.textContent = '▶'; pb.title = `${it.line}行から再生`; pb.setAttribute('aria-label', `${it.line}行から再生`);
    pb.onclick = ev => { ev.stopPropagation(); const t0 = lineStart(it.line); if (t0 !== null) { seekTo(t0); running = true; host.setRunning(true); $('btnPlay').textContent = '❚❚ 一時停止'; } };
    pc.appendChild(pb);
    td(it.line); td(lineOf(it.line), 'code');
    const tags = td('');
    for (const w of it.why) { const sp = document.createElement('span'); sp.className = `tag ${BAD.has(w) ? 'bad' : 'warn'}`; sp.textContent = w; tags.appendChild(sp); }
    td(it.F.toFixed(0), 'n'); td(it.vib.toFixed(1), 'n'); td(it.temp > 25 ? it.temp.toFixed(0) : '—', 'n'); td(it.stress.toFixed(0), 'n'); td(it.cut.toFixed(2), 'n');
    // what to change, with numbers where the models give them
    const adv = adviceFor(it, adviceCtx(it.line));
    const ac = td('', 'advice');
    adv.forEach((a, i) => { if (i) ac.appendChild(document.createElement('br')); ac.appendChild(document.createTextNode(a)); });
    const go = () => gotoLine(it.line);
    tr.onclick = go; tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    tb.appendChild(tr);
  }
  $('hReport').textContent = `${sim.done ? '完了' : '加工中'} · 注意が必要な行 ${r.issues.length}`;
  if (!r.issues.length) { const tr = document.createElement('tr'); const c = document.createElement('td'); c.colSpan = 10; c.textContent = sim.done ? '注意が必要な行はありません' : 'まだ注意が必要な行はありません'; tr.appendChild(c); tb.appendChild(tr); }
}
// select a program line in the editor (program tab)
function gotoLine(n) {
  document.querySelector('[data-tab="prog"]').click();
  const ta = $('code'), lines = ta.value.split('\n');
  let a = 0; for (let i = 0; i < n - 1 && i < lines.length; i++) a += lines[i].length + 1;
  ta.focus(); ta.setSelectionRange(a, a + (lines[n - 1] || '').length);
  ta.scrollTop = Math.max(0, (n - 4) * parseFloat(getComputedStyle(ta).lineHeight || '16'));
}
$('rBase').onclick = () => {
  if (baseline) { baseline = null; $('rBase').textContent = 'この結果を比較の基準にする'; }
  else if (lastNums && sim.done) { baseline = JSON.parse(JSON.stringify(lastNums)); $('rBase').textContent = `比較の基準を外す (${baseline.name})`; }
  else { $('rHint').textContent = 'プログラムを最後まで計算してから基準にしてください。'; return; }
  reportShown = ''; updateReport();
};
// ---------- setup sheet: one printable page for the shop floor ----------
const COOL_NAME = { dry: 'ドライ', air: 'エアブロー', flood: 'クーラント', through: 'スルースピンドル' };
function setupSheet() {
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rep = currentReport(), sum = rep?.lines.size ? rep.summary({ stress: ALLOWABLE_STRESS, temp: 900, swing: SWING_CRACK }) : null;
  const name = $('gcInfo').dataset.file || SAMPLES[$('sample').value]?.name || 'プログラム';
  const o = sim.origin, feeds = sim.path.filter(p => !p.rapid);
  const Ss = feeds.map(p => p.S * (sim.cfg.spindleOverride ?? 1)), Fs = feeds.map(p => p.F * (sim.cfg.feedOverride ?? 1));
  const range = (a, u) => { if (!a.length) return '—'; const lo = Math.round(Math.min(...a)), hi = Math.round(Math.max(...a)); return `${lo.toLocaleString()}${hi > lo ? `〜${hi.toLocaleString()}` : ''} ${u}`; };
  const wcsRows = (sim.wcsUsed || ['G54']).map(n => { const p = n === 'G54' ? o : sim.wcs?.[n] || o; return `<tr><td>${esc(n)}</td><td>${p.x.toFixed(3)}</td><td>${p.y.toFixed(3)}</td><td>${p.z.toFixed(3)}</td><td>${n === 'G54' ? '' : `Δ ${(p.x - o.x).toFixed(3)} ${(p.y - o.y).toFixed(3)} ${(p.z - o.z).toFixed(3)}`}</td></tr>`; }).join('');
  const usedT = [...new Set(sim.path.map(p => p.tool))];
  const wear = new Map(sum?.tools || []);
  const toolRows = usedT.map(T => { const t = sim.toolFor(T ?? null), w = wear.get(T ?? '-'); return `<tr><td>${T == null ? '(T 番号なし)' : 'T' + T}</td><td>φ${+t.D.toFixed(3)} ${t.type === 'ball' ? 'ボール' : t.type === 'bull' ? 'ラジアス' : 'フラット'} ${t.N} 枚刃</td><td>${+t.stickout.toFixed(1)}</td><td>${esc(t.holderName || '')}</td><td>${w ? `${(w[1] * 1000).toFixed(1)} → ${(w[0] * 1000).toFixed(1)} µm${w[0] - w[1] > 1e-6 ? ` (約 ${partsPerTool(w[0], w[1])} 個/本)` : ''}` : '—'}</td></tr>`; }).join('');
  const issues = (sum?.issues || []).slice(0, 12).map(it => `<tr><td>${it.line}</td><td class="code">${esc((codeLines[it.line - 1] || '').trim())}</td><td>${esc(it.why.join('・'))}</td><td>${esc(adviceFor(it, adviceCtx(it.line)).join(' / '))}</td></tr>`).join('');
  view.render();
  let img = '';
  try { img = view.canvas.toDataURL('image/jpeg', 0.85); } catch { /* tainted or lost context */ }
  const kv = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>段取りシート ${esc(name)}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;color:#111;margin:24px;max-width:900px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #999}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f2f2f2;width:9em}td.code{font-family:ui-monospace,monospace}
img{max-width:100%;border:1px solid #bbb;margin-top:6px}.meta{color:#555}@media print{body{margin:10mm}}</style></head><body>
<h1>段取りシート</h1><p class="meta">${esc(name)} · ${new Date().toLocaleString('ja-JP')} · 3軸加工シミュレーターで作成 (計算値は目安です)</p>
<h2>概要</h2><table>${kv('被削材', esc(sim.mat.name) + (sim.mat.coefSource ? `(切削係数: ${esc(sim.mat.coefSource)})` : ''))}${kv('素材', esc(stockShape))}${kv('クーラント', COOL_NAME[sim.cfg.coolant] || esc(sim.cfg.coolant))}
${kv('主軸回転', range(Ss, 'min⁻¹'))}${kv('送り速度', range(Fs, 'mm/min'))}${kv('加工時間', sum ? `${sum.time.toFixed(1)} s (うち切削 ${sum.cut.toFixed(1)} s)${sim.done ? '' : ' ※途中まで'}` : `${sim.totalTime.toFixed(1)} s (見込み)`)}
${sum ? kv('最大切削抵抗', sum.peakF ? `${sum.peakF.F.toFixed(0)} N (${sum.peakF.line} 行)` : '—') + kv('びびり', `切削時間の ${(sum.chatterShare * 100).toFixed(0)} %`) : ''}</table>
<h2>ワーク座標系 (素材上面の左手前の角から mm)</h2><table><tr><th>座標系</th><th>X</th><th>Y</th><th>Z</th><th>G54 からのずれ</th></tr>${wcsRows}</table>
<h2>工具</h2><table><tr><th>工具</th><th>形状</th><th>突出し mm</th><th>ホルダー</th><th>摩耗 VB (この加工)</th></tr>${toolRows}</table>
${issues ? `<h2>注意が必要な行</h2><table><tr><th>行</th><th>Gコード</th><th>状態</th><th>対策の目安</th></tr>${issues}</table>` : ''}
${img ? `<h2>加工結果</h2><img src="${img}" alt="加工結果の 3D 表示">` : ''}
</body></html>`;
}
$('rSheet').onclick = async () => {
  const text = setupSheet(), name = ($('gcInfo').dataset.file || 'program').replace(/(_opt)?\.[^.]+$/, '') + '_setup.html';
  if (downloads) { try { await downloads.save({ filename: name, data: text }); } catch { /* declined */ } return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/html' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('rCsv').onclick = async () => {
  const rep = currentReport(); if (!rep) return;
  const name = ($('gcInfo').dataset.file || 'program').replace(/\.[^.]+$/, '') + '_report.csv', text = rep.csv(codeLines);
  if (downloads) { try { await downloads.save({ filename: name, data: text }); } catch { /* declined */ } return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
// ---------- first-visit guide (dismissed once per browser) ----------
{
  let seen = false;
  try { seen = localStorage.getItem('machsim.guide') === '1'; } catch { /* storage blocked */ }
  $('guide').hidden = seen;
  $('guideClose').onclick = () => { $('guide').hidden = true; try { localStorage.setItem('machsim.guide', '1'); } catch { /* storage blocked */ } };
}

// ---------- feed optimisation ----------
let foText = null, foQ = 1; // foQ: spindle factor of a spindle optimisation (applied to the speed slider too)
$('foRun').onclick = () => {
  const rep = currentReport();
  foText = null; $('foLoad').disabled = $('foSave').disabled = true;
  if (!rep || !rep.lines.size || !sim.done) { $('foOut').innerHTML = '<p class="hint">プログラムを最後まで計算してから最適化してください (再生して最後まで、または進行バーで End キー)。</p>'; return; }
  const target = +$('foTarget').value > 0 ? +$('foTarget').value : defaultTarget(rep);
  const feedLines = new Set(sim.path.filter(p => !p.rapid).map(p => p.line));
  const lineF = new Map(); for (const p of sim.path) if (!p.rapid && !lineF.has(p.line)) lineF.set(p.line, p.F * (sim.cfg.feedOverride ?? 1));
  const air = $('foAir').checked ? { lines: feedLines, k: 3, Fmax: 5000, F: l => lineF.get(l) || 0 } : null;
  const opt = optimizeFeeds(rep, sim.mat, { Ftarget: target, maxUp: +$('foUp').value, maxDown: +$('foDown').value, stressLimit: 0.8 * ALLOWABLE_STRESS, nonlinear: sim.cfg.cuttingNonlinear, air });
  const factor = new Map([...opt.lines].map(([l, o]) => [l, o.k]));
  foText = rewriteFeeds(codeLines.join('\n'), feedLines, factor); foQ = 1; // the program that was run, not later edits
  const changed = [...opt.lines].filter(([, o]) => o.k !== 1).sort((a, b) => a[0] - b[0]);
  const up = changed.filter(([, o]) => o.k > 1).length, down = changed.length - up;
  const dt = opt.time1 - opt.time0;
  const rows = changed.slice(0, 40).map(([l, o]) => `<tr><td>${l}</td><td class="code">${(codeLines[l - 1] || '').trim().replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')}</td><td class="n">×${o.k.toFixed(2)}</td><td class="n">${o.why === '空送り' ? '—' : `${o.F0.toFixed(0)} → ${o.F1.toFixed(0)}`}</td><td>${o.why}</td></tr>`).join('');
  $('foOut').innerHTML = `<p class="hint">目標 ${target.toFixed(0)} N で、送りを上げる行 ${up}・下げる行 ${down}。加工時間の見込み ${opt.time0.toFixed(1)} s → <b>${opt.time1.toFixed(1)} s</b> (${dt <= 0 ? '' : '+'}${(dt / Math.max(opt.time0, 1e-9) * 100).toFixed(0)} %)。読み込んで計算し直すと、実際の切削抵抗と時間を確かめられます。</p>` +
    (changed.length ? `<div class="rtable-wrap"><table class="rtable" aria-label="送りを変える行"><thead><tr><th>行</th><th>Gコード</th><th class="n">送り</th><th class="n">最大切削抵抗 N</th><th>備考</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">変える行はありません。</p>');
  $('foLoad').disabled = $('foSave').disabled = !changed.length;
};
$('soRun').onclick = () => {
  const rep = currentReport();
  foText = null; $('foLoad').disabled = $('foSave').disabled = true;
  if (!rep || !rep.lines.size || !sim.done) { $('foOut').innerHTML = '<p class="hint">プログラムを最後まで計算してから最適化してください。</p>'; return; }
  const ov = sim.cfg.spindleOverride ?? 1, lines = [];
  for (const r of rep.lines.values()) {
    if (!(r.cut > 0) || !(r.ap > 0.01) || !(r.pex > r.pst)) continue;
    const pt = sim.path.find(p => p.line === r.line && !p.rapid); if (!pt) continue;
    const lob = sim.lobes(r.pst, r.pex);
    lines.push({ line: r.line, ap: r.ap, S: pt.S * ov, lim: S => alimAt(lob, S) });
  }
  if (!lines.length) { $('foOut').innerHTML = '<p class="hint">切削した行がありません。</p>'; return; }
  const o = optimizeSpindle(lines, { qMin: 0.7, qMax: 1.3 });
  const S0 = lines[0].S, worstLine = q => lines.reduce((a, l) => { const v = l.ap / l.lim(q * l.S); return v > a.v ? { v, l } : a; }, { v: 0, l: null });
  const w0 = worstLine(1), w1 = worstLine(o.q);
  const ratio = v => (v < Infinity ? v.toFixed(2) : '—');
  if (Math.abs(o.q - 1) < 0.005) { $('foOut').innerHTML = `<p class="hint">今の回転数が一番安定です (最も厳しい行 ${w0.l?.line} 行: 切込み ÷ 限界 ${ratio(w0.v)})。</p>`; return; }
  foText = rewriteSpindle(codeLines.join('\n'), o.q); foQ = o.q;
  $('foOut').innerHTML = `<p class="hint">回転数を <b>×${o.q.toFixed(3)}</b> (例: S${Math.round(S0)} → S${Math.round(S0 * o.q)}) に、送りも同じ比で。最も厳しい行の「切込み ÷ 安定限界」: ${ratio(w0.v)} (${w0.l?.line} 行) → <b>${ratio(w1.v)}</b> (${w1.l?.line} 行)。${o.worst < 1 ? 'すべての行が線図の上で安定になります。' : '1 を超える行が残ります (切込みも見直してください)。'}加工時間は ${o.q > 1 ? '短く' : '長く'}なります (×${(1 / o.q).toFixed(2)})。読み込んで計算し直すと確かめられます。</p>`;
  $('foLoad').disabled = $('foSave').disabled = false;
};
$('foLoad').onclick = () => {
  if (!foText) return;
  $('code').value = foText;
  const f = $('gcInfo').dataset.file; if (f && !/_opt\./.test(f)) $('gcInfo').dataset.file = f.replace(/(\.[^.]+)?$/, m => '_opt' + (m || '.nc'));
  // the speed slider is absolute: it follows the new speed, or the old one would stay in force
  const q = foQ, S0 = +$('ovS').value;
  loadProgram();
  if (q !== 1) setSpindle(S0 * q);
  $('foOut').innerHTML = '<p class="hint">最適化したプログラムを読み込みました。再生すると、加工レポートで結果を確かめられます。</p>';
  foText = null; $('foLoad').disabled = $('foSave').disabled = true;
};
$('foSave').onclick = async () => {
  if (!foText) return;
  const name = ($('gcInfo').dataset.file || 'program').replace(/(_opt)?\.[^.]+$/, '') + '_opt.nc';
  if (downloads) { try { await downloads.save({ filename: name, data: foText }); } catch { /* declined */ } return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([foText], { type: 'text/plain' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
function setV(id, v, unit) { const el = $(id); el.firstChild.nodeValue = v; el.lastChild.textContent = unit; }

let lastRough = null, lastSec = null, secHover = false;
const ZONE = { tool: '工具', chip: '切りくず', work: '被削材' };
$('cvSec').addEventListener('pointermove', ev => {
  const r = ev.currentTarget.getBoundingClientRect(), p = sectionProbe(ev.clientX - r.left, ev.clientY - r.top);
  secHover = !!p;
  if (p) $('hSec').textContent = `${ZONE[p.zone]} ${p.T.toFixed(0)} °C`;
});
$('cvSec').addEventListener('pointerleave', () => { secHover = false; });
function updateCharts() {
  const e = sim.engine, d = sim.display;
  drawForces($('cvForce'), e);
  drawOrbit($('cvOrbit'), e);
  drawSpectrum($('cvSpec'), e, sim.cfg.modal.modesX ? [...new Set([...sim.cfg.modal.modesX, ...sim.cfg.modal.modesY].map(m => Math.round(m.fn)))] : sim.cfg.modal.fn);
  $('hSpec').textContent = e.S ? `刃通過 ${(e.S * e.N / 60).toFixed(0)} Hz` : '';
  $('hF').textContent = d.cutting ? `平均 ${d.F.toFixed(0)} N` : '';
  const lobes = sim.lobes(d.phiSt ?? 0, d.phiEx ?? Math.PI);
  const S = d.S || +$('ovS').value;
  const ap = d.cutting ? d.ap : 0;
  const lim = alimAt(lobes, S);
  // with speed-dependent dynamics, the diagram of the tool at rest stays as a dashed reference
  const rest = speedDependent(sim.cfg.modal, sim.cfg.spindleSoft) ? sim.lobes(d.phiSt ?? 0, d.phiEx ?? Math.PI, true) : null;
  lobeBox = drawLobes($('cvLobes'), lobes, { S, ap, stable: ap <= lim }, LOBE_RANGE, rest, tdCurve && tdCurve.key === tdKey() ? tdCurve.pts : null);
  // side-wall roughness: the rougher of the walls this cut generates
  let prof = null;
  if (d.cutting && e.wallSamples && d.fz > 0) {
    for (const side of wallSides(d.phiSt ?? 0, d.phiEx ?? Math.PI)) {
      const p = wallProfile(side > 0 ? e.wallSamples : e.wallSamplesPi, [e.ux, e.uy], side, sim.activeTool.R, d.fz);
      if (p && (!prof || p.Rz > prof.Rz)) prof = p;
    }
  }
  // keep showing the last wall that was cut while the tool is elsewhere
  const fresh = !!prof;
  if (prof) lastRough = prof; else prof = sim.mtime > 0 ? lastRough : (lastRough = null);
  drawRoughness($('cvRough'), prof);
  $('hRough').textContent = prof ? `${fresh ? '' : '直前の側面 · '}Rz ${prof.Rz.toFixed(2)} µm · Ra ${prof.Ra.toFixed(2)} µm (理論 ${prof.Rth.toFixed(2)})` : '';
  // orthogonal cutting section at the mean chip
  const sec = d.cutting && d.hMean > 0 ? { h: d.hMean, hc: d.hMean * Math.cos((d.shearDeg - (sim.cfg.tool.rakeDeg ?? 10)) * Math.PI / 180) / Math.sin(d.shearDeg * Math.PI / 180), phiDeg: d.shearDeg, rakeDeg: sim.cfg.tool.rakeDeg ?? 10, Tsh: d.tempShear, Ttool: d.tempTool, T0, VB: d.VB } : lastSec;
  if (sec) lastSec = sec;
  drawSection($('cvSec'), sim.mtime > 0 ? sec : (lastSec = null));
  if (!secHover) $('hSec').textContent = sec ? `刃先 ${sec.Ttool.toFixed(0)} °C · せん断域 ${sec.Tsh.toFixed(0)} °C` : '';
  const immDeg = ((d.phiEx - d.phiSt) * 180 / Math.PI).toFixed(0);
  $('hLobe').textContent = `接触角 ${immDeg}° · 限界 ${lim === Infinity ? '—' : lim.toFixed(2) + ' mm'}${rest ? ' · 破線は静止時の FRF' : ''}`;
}

setStockMode('prog'); $('orgSel').onchange();
loadProgram();
setSpindle(baseS);
window.machiningSim = sim; window.machiningView = view; // handy for poking at the model from the browser console
requestAnimationFrame(frameLoop);
