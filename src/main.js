import { Simulator } from './sim.js';
import { SimHost } from './host.js';
import { wallProfile, wallSides } from './roughness.js';
import { parseFrfCsv, fitModes, exampleCsv, staticK, dominant } from './frf.js';
import { View } from './view.js';
import { MATERIALS } from './materials.js';
import { COOLANTS } from './chips.js';
import { SAMPLES } from './samples.js';
import { decodeText } from './gcode.js';
import { parseStl } from './workpiece.js';
import { HOLDERS, parseToolLibrary } from './assembly.js';
import { ALLOWABLE_STRESS } from './tool.js';
import { alimAt } from './sld.js';
import { speedDependent } from './spindle.js';
import { VB_LIMIT, T0 } from './thermal.js';
import { refreshTheme, drawForces, drawOrbit, drawSpectrum, drawLobes, drawRoughness, drawSection, sectionProbe } from './charts.js';

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

let stockMode = 'prog', stlSpec = null, targetSpec = null, codeLines = [];
function stockSetup() {
  const num = id => +$(id).value;
  let stock = null;
  if (stockMode === 'box') stock = { type: 'box', w: num('stW'), l: num('stL'), h: num('stH') };
  else if (stockMode === 'cyl') stock = { type: 'cyl', d: num('cD'), h: num('cH') };
  else if (stockMode === 'stl' && stlSpec) stock = stlSpec;
  const kind = $('orgSel').value;
  const origin = kind === 'manual' ? { x: num('oX'), y: num('oY'), z: num('oZ') } : kind;
  return { stock, origin, target: targetSpec };
}
function loadProgram() {
  const setup = stockSetup();
  host.load($('code').value, setup);
  codeLines = $('code').value.split('\n');
  baseS = firstSpindle(sim.path) || 12000;
  sim.cfg.spindleOverride = +$('ovS').value / baseS;
  host.config();
  view.setStock(sim.stock, sim.mat);
  view.setTool(sim.activeTool); viewToolVersion = sim.toolVersion;
  view.setPath(sim.path);
  const w = $('warnings'); w.innerHTML = '';
  const msgs = [...sim.warnings];
  if (stockMode === 'stl' && !stlSpec) msgs.unshift('STL が未選択のため、プログラムの指定で素材を作りました');
  for (const msg of msgs) { const li = document.createElement('li'); li.textContent = msg; w.appendChild(li); }
  // the origin actually used, in the inputs (they stay as typed in manual mode)
  if ($('orgSel').value !== 'manual') for (const k of ['x', 'y', 'z']) $('o' + k.toUpperCase()).value = +sim.origin[k].toFixed(3);
  const sz = sim.stockSize, sp = sim.stockSpec;
  const shape = sp.type === 'cyl' ? `丸棒 φ${sp.d} × ${sp.h} mm` : sp.type === 'stl' ? `STL ${sp.name || ''} ${sz.w.toFixed(1)} × ${sz.l.toFixed(1)} × ${sz.h.toFixed(1)} mm (${sp.count.toLocaleString()} 三角形)` : `直方体 ${sz.w} × ${sz.l} × ${sz.h} mm`;
  $('stockInfo').textContent = `${shape} · 格子 ${sim.stockCell} mm`;
  showTools();
  syncModalInputs();
  updateMatHint();
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
  // a sample brings its own target shape (or none)
  targetSpec = sm.target ? sm.target() : null;
  $('tgClear').disabled = !targetSpec;
  $('tgInfo').textContent = targetSpec ? `${targetSpec.name} · ${targetSpec.count} 三角形` : '目標形状なし';
  loadProgram();
  if (targetSpec) setColorMode('devTarget');
  setSpindle(baseS);
};

// ---------- files ----------
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
async function openStl(file) {
  try {
    const m = parseStl(await file.arrayBuffer());
    stlSpec = { type: 'stl', ...m, name: file.name };
    setStockMode('stl');
    const size = m.max.map((v, k) => v - m.min[k]);
    if (Math.max(...size) < 2) $('gcInfo').textContent = `${file.name}: 大きさが ${size.map(v => v.toFixed(3)).join(' × ')} です。STL の単位は mm として読みます (m や inch で保存されていないか確認してください)。`;
    loadProgram();
  } catch (err) { $('stockInfo').textContent = `${file.name} を読み込めませんでした: ${err.message}`; }
}
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
async function openTarget(file) {
  try {
    const m = parseStl(await file.arrayBuffer());
    targetSpec = { ...m, name: file.name };
    $('tgInfo').textContent = `${file.name} · ${m.count.toLocaleString()} 三角形 · X ${m.min[0].toFixed(1)}〜${m.max[0].toFixed(1)} Y ${m.min[1].toFixed(1)}〜${m.max[1].toFixed(1)} Z ${m.min[2].toFixed(1)}〜${m.max[2].toFixed(1)} mm (プログラム座標)`;
    $('tgClear').disabled = false;
    loadProgram();
    setColorMode('devTarget');
  } catch (err) { $('tgInfo').textContent = `${file.name} を読み込めませんでした: ${err.message}`; }
}
$('tgOpen').onclick = () => $('tgFile').click();
$('tgFile').onchange = e => { const f = e.target.files[0]; if (f) openTarget(f); e.target.value = ''; };
$('tgClear').onclick = () => {
  targetSpec = null; $('tgClear').disabled = true;
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
  const stl = files.find(f => /\.stl$/i.test(f.name)), prog = files.find(f => !/\.stl$/i.test(f.name));
  (async () => {
    if (stl) await openStl(stl);
    if (prog) await openProgram(prog);
    document.querySelector('[data-tab="prog"]').click();
  })();
});

function setSpindle(S) {
  S = Math.round(Math.max(2000, Math.min(30000, S)));
  $('ovS').value = S;
  $('ovSOut').textContent = `${S} min⁻¹`;
  sim.cfg.spindleOverride = S / baseS;
  host.config();
}
$('ovS').oninput = e => setSpindle(+e.target.value);
$('ovF').oninput = e => { sim.cfg.feedOverride = e.target.value / 100; host.config(); $('ovFOut').textContent = `${e.target.value} %`; };
$('btnPocket').onclick = () => {
  const cur = +$('ovS').value;
  const r = sim.bestSpindle(cur);
  setSpindle(r.S);
  $('pocketHint').textContent = `${cur} → ${r.S} min⁻¹(この切込み条件での安定限界 ${r.alim.toFixed(2)} mm)。`;
};
$('material').onchange = e => { sim.cfg.material = e.target.value; host.config(true); view.mat = sim.mat; view.setStock(sim.stock, sim.mat); updateMatHint(); };
function updateMatHint() {
  const m = sim.mat;
  $('matHint').textContent = `Ktc ${m.Ktc} / Krc ${m.Krc} N/mm² · 推奨切削速度の目安 ${m.vc} m/min(φ${sim.activeTool.D} で ${Math.round(m.vc * 1000 / (Math.PI * sim.activeTool.D))} min⁻¹)`;
}
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
async function readStl(file) { const m = parseStl(await file.arrayBuffer()); return { ...m, name: file.name }; }
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
}
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
  $('prog').style.width = `${Math.min(100, sim.mtime / (sim.totalTime || 1) * 100)}%`;
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
  setV('vH', d.tempTool.toFixed(0), '°C');
  $('sH').textContent = d.cutting ? `切りくず ${d.tempChip.toFixed(0)} °C · 平均 h ${(d.hMean * 1000).toFixed(0)} µm` : `切りくず ${d.tempChip.toFixed(0)} °C`;
  $('tileHeat').dataset.s = d.tempTool > 900 ? 'chatter' : d.tempTool > 700 ? 'marginal' : 'stable';
  setV('vWr', (d.VB * 1000).toFixed(1), 'µm');
  const wr = d.VB / VB_LIMIT;
  $('mWr').style.width = `${Math.min(100, wr * 100)}%`;
  $('mWr').style.background = wr > 1 ? 'var(--bad)' : wr > 0.6 ? 'var(--warn)' : 'var(--ok)';
  const tName = sim.activeT != null ? `T${sim.activeT} · ` : '';
  $('sWr').textContent = tName + (d.lifeMin < Infinity ? `この条件の残り寿命 ${d.lifeMin > 600 ? '10 h 超' : d.lifeMin.toFixed(1) + ' 分'}` : `寿命 VB ${VB_LIMIT * 1000} µm`);
  showDeviation(d.dev);
  showSpeedInfo();
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
  lobeBox = drawLobes($('cvLobes'), lobes, { S, ap, stable: ap <= lim }, LOBE_RANGE, rest);
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
