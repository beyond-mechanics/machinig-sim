import { Simulator } from './sim.js';
import { SimHost } from './host.js';
import { wallProfile, wallSides } from './roughness.js';
import { parseFrfCsv, fitModes, exampleCsv, staticK, dominant } from './frf.js';
import { View } from './view.js';
import { MATERIALS } from './materials.js';
import { SAMPLES } from './samples.js';
import { decodeText } from './gcode.js';
import { parseStl } from './workpiece.js';
import { HOLDERS, parseToolLibrary } from './assembly.js';
import { ALLOWABLE_STRESS } from './tool.js';
import { alimAt } from './sld.js';
import { refreshTheme, drawForces, drawOrbit, drawSpectrum, drawLobes, drawRoughness } from './charts.js';

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

let stockMode = 'prog', stlSpec = null, codeLines = [];
function stockSetup() {
  const num = id => +$(id).value;
  let stock = null;
  if (stockMode === 'box') stock = { type: 'box', w: num('stW'), l: num('stL'), h: num('stH') };
  else if (stockMode === 'cyl') stock = { type: 'cyl', d: num('cD'), h: num('cH') };
  else if (stockMode === 'stl' && stlSpec) stock = stlSpec;
  const kind = $('orgSel').value;
  const origin = kind === 'manual' ? { x: num('oX'), y: num('oY'), z: num('oZ') } : kind;
  return { stock, origin };
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
  $('gcInfo').textContent = SAMPLES[e.target.value].name;
  $('code').value = SAMPLES[e.target.value].code;
  loadProgram();
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
    Object.assign(m, { auto: false, modesX: mx, modesY: my, k: Math.round(Math.min(staticK(mx), staticK(my))), fn: Math.round(dom.fn), zeta: +dom.zeta.toFixed(3) });
    $('mAuto').checked = false;
    host.config(true); syncModalInputs();
    $('frfClear').disabled = false;
    $('frfInfo').textContent = `${name} (${d.f.length} 点, ${d.unit}) から同定\nX: ${fmtModes(mx)}\nY: ${fmtModes(my)}`;
  } catch (err) { $('frfInfo').textContent = `読み込めませんでした: ${err.message}`; }
}
function clearFrf() {
  if (!sim.cfg.modal.modesX) return;
  sim.cfg.modal.modesX = sim.cfg.modal.modesY = null;
  $('frfClear').disabled = true; $('frfInfo').innerHTML = frfHint;
}
$('frfLoad').onclick = () => $('frfFile').click();
$('frfFile').onchange = async e => { const f = e.target.files[0]; if (f) applyFrf(await f.text(), f.name); e.target.value = ''; };
$('frfExample').onclick = () => applyFrf(exampleCsv(), '例: ホルダ+工具の2モード');
$('frfClear').onclick = () => { clearFrf(); sim.cfg.modal.auto = true; $('mAuto').checked = true; host.config(true); syncModalInputs(); };
document.querySelectorAll('[data-cool]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-cool]').forEach(x => x.setAttribute('aria-pressed', x === b));
  sim.cfg.coolant = b.dataset.cool;
  host.config();
});
$('exag').oninput = e => { view.exag = +e.target.value; $('exagOut').textContent = `×${e.target.value}`; };
$('showChips').onchange = e => { view.showChips = e.target.checked; };
$('showPath').onchange = e => { view.showPath = e.target.checked; };
$('workFlex').onchange = e => { sim.cfg.workpieceFlex = e.target.checked; host.config(true); };
$('cutNl').onchange = e => { sim.cfg.cuttingNonlinear = e.target.checked; host.config(true); };
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view.setView(b.dataset.view));
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-color]').forEach(x => x.setAttribute('aria-pressed', x === b));
  view.colorMode = b.dataset.color;
  $('legend').hidden = view.colorMode === 'material';
  $('legend1').textContent = view.colorMode === 'vibration' ? '40 µm' : view.colorMode === 'wall' ? '50 µm' : `${sim.stock.zTop - sim.stock.zBottom} mm`;
  view.updateStock(true);
});
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
  view.updateNozzle(sim.cfg.coolant, sim.pos);
  view.updateSpray(sim.cfg.coolant, sim.pos, running && sim.S > 0);
  view.updateChips(sim.chips, sim.mat);
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
  setV('vD', d.defl.toFixed(1), 'µm'); $('sD').textContent = sim.cfg.modal.modesX ? `実測FRF · X ${sim.cfg.modal.modesX.length} / Y ${sim.cfg.modal.modesY.length} モード` : `k = ${(sim.cfg.modal.k / 1000).toFixed(1)} N/µm · fn ${sim.cfg.modal.fn} Hz`;
  setV('vW', d.wallDefl.toFixed(1), 'µm');
  $('sW').textContent = !sim.cfg.workpieceFlex ? '計算オフ' : d.wall ? `壁厚 ${d.wall.t.toFixed(1)} · 高さ ${d.wall.hWall.toFixed(0)} mm · k ${(d.wall.k / 1000).toFixed(1)} N/µm` : '剛体として扱い中';
  setV('vV', d.vib.toFixed(1), 'µm'); $('sV').textContent = `同期外成分 ${d.once.toFixed(1)} µm`;
  setV('vS', d.stress.toFixed(0), 'MPa');
  $('stS').textContent = `許容目安 1500 MPa${d.clearance != null ? ` · ${d.clearance < 0 ? `干渉 ${(-d.clearance).toFixed(1)} mm` : `すきま ${d.clearance.toFixed(1)} mm`}` : ''}`;
  const sr = d.stress / ALLOWABLE_STRESS;
  $('mS').style.width = `${Math.min(100, sr * 100)}%`;
  $('mS').style.background = sr > 1 ? 'var(--bad)' : sr > 0.6 ? 'var(--warn)' : 'var(--ok)';
  setV('vM', d.mrr.toFixed(1), 'cm³/min'); $('sM').textContent = `ap ${d.ap.toFixed(2)} mm · fz ${d.fz.toFixed(3)} mm`;
  const cs = sim.chips.stats;
  const evacPct = cs.producedVol > 0 ? Math.min(100, (cs.producedVol - cs.restVol) / cs.producedVol * 100) : 0;
  setV('vC', evacPct.toFixed(0), '% 排出'); $('sC').textContent = `素材上に残留 ${cs.restVol.toFixed(0)} mm³ · 再切削 ${cs.recut} 回`;
  // alerts
  const box = $('alerts'); box.innerHTML = '';
  for (const a of sim.alerts.values()) if (sim.mtime - a.t < 3) { const div = document.createElement('div'); div.className = 'alert'; div.textContent = a.msg; box.appendChild(div); }
}
function setV(id, v, unit) { const el = $(id); el.firstChild.nodeValue = v; el.lastChild.textContent = unit; }

let lastRough = null;
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
  lobeBox = drawLobes($('cvLobes'), lobes, { S, ap, stable: ap <= lim }, LOBE_RANGE);
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
  const immDeg = ((d.phiEx - d.phiSt) * 180 / Math.PI).toFixed(0);
  $('hLobe').textContent = `接触角 ${immDeg}° · 限界 ${lim === Infinity ? '—' : lim.toFixed(2) + ' mm'}`;
}

setStockMode('prog'); $('orgSel').onchange();
loadProgram();
setSpindle(baseS);
window.machiningSim = sim; window.machiningView = view; // handy for poking at the model from the browser console
requestAnimationFrame(frameLoop);
