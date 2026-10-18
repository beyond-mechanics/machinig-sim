import { Simulator } from './sim.js';
import { SimHost } from './host.js';
import { parseFrfCsv, fitModes, exampleCsv, staticK, dominant } from './frf.js';
import { View } from './view.js';
import { MATERIALS } from './materials.js';
import { SAMPLES } from './samples.js';
import { ALLOWABLE_STRESS } from './tool.js';
import { alimAt } from './sld.js';
import { refreshTheme, drawForces, drawOrbit, drawSpectrum, drawLobes } from './charts.js';

const $ = id => document.getElementById(id);
const sim = new Simulator();
const host = new SimHost(sim);
const view = new View($('view'));
let running = false, baseS = 12000;

// ---------- setup ----------
for (const [k, m] of Object.entries(MATERIALS)) $('material').add(new Option(m.name, k));
for (const [k, s] of Object.entries(SAMPLES)) $('sample').add(new Option(s.name, k));
$('code').value = SAMPLES.demo.code;

function loadProgram() {
  host.load($('code').value);
  baseS = firstSpindle(sim.path) || 12000;
  sim.cfg.spindleOverride = +$('ovS').value / baseS;
  host.config();
  view.setStock(sim.stock, sim.mat);
  view.setTool(sim.cfg.tool);
  view.setPath(sim.path);
  const w = $('warnings'); w.innerHTML = '';
  for (const msg of sim.warnings) { const li = document.createElement('li'); li.textContent = msg; w.appendChild(li); }
  syncModalInputs();
  updateMatHint();
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
  $('code').value = SAMPLES[e.target.value].code;
  loadProgram();
  setSpindle(baseS);
};

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
  $('matHint').textContent = `Ktc ${m.Ktc} / Krc ${m.Krc} N/mm² · 推奨切削速度の目安 ${m.vc} m/min(φ${sim.cfg.tool.D} で ${Math.round(m.vc * 1000 / (Math.PI * sim.cfg.tool.D))} min⁻¹)`;
}
document.querySelectorAll('[data-ttype]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-ttype]').forEach(x => x.setAttribute('aria-pressed', x === b));
  sim.cfg.tool.type = b.dataset.ttype; toolChanged();
});
const toolInputs = { tD: 'D', tN: 'N', tHelix: 'helixDeg', tFlute: 'fluteLen', tStick: 'stickout' };
for (const [id, key] of Object.entries(toolInputs)) $(id).onchange = e => {
  const v = +e.target.value; if (!(v > 0) && key !== 'helixDeg') return;
  sim.cfg.tool[key] = key === 'N' ? Math.round(v) : v;
  if (sim.cfg.tool.stickout < sim.cfg.tool.fluteLen) { sim.cfg.tool.stickout = sim.cfg.tool.fluteLen + 2; $('tStick').value = sim.cfg.tool.stickout; }
  toolChanged();
};
function toolChanged() { host.config(true); view.setTool(sim.cfg.tool); syncModalInputs(); updateMatHint(); }
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
  const blur = Math.min(1, Math.max(0, (dTheta * sim.cfg.tool.N / (2 * Math.PI) - 0.12) / 0.3));
  spinAngle += blur >= 1 ? dt * 2 * Math.PI * 0.7 : dTheta; // when fully blurred, a slow drift keeps the highlights alive
  const wall = sim.display.cutting ? sim.wall : null;
  view.updateWallDeform(wall && e.wk ? wall : null, (e.runMeanW || 0) * 1e3 * view.exag);
  view.updateStock();
  view.updateTool(sim.pos, e.x * 1e3 * view.exag, e.y * 1e3 * view.exag, spinAngle, blur);
  view.updateNozzle(sim.cfg.coolant, sim.pos);
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
  const lines = $('code').value.split('\n');
  $('lineInfo').textContent = sim.line ? `N${sim.line}  ${lines[sim.line - 1]?.trim() ?? ''}` : 'プログラム先頭';
  setV('vF', d.F.toFixed(0), 'N'); $('sF').textContent = `最大 ${d.Fmax.toFixed(0)} N · 軸方向 ${d.Fz.toFixed(0)} N`;
  setV('vT', d.torque.toFixed(2), 'N·m'); $('sT').textContent = `${d.power.toFixed(2)} kW · ${Math.round(d.S)} min⁻¹`;
  setV('vD', d.defl.toFixed(1), 'µm'); $('sD').textContent = sim.cfg.modal.modesX ? `実測FRF · X ${sim.cfg.modal.modesX.length} / Y ${sim.cfg.modal.modesY.length} モード` : `k = ${(sim.cfg.modal.k / 1000).toFixed(1)} N/µm · fn ${sim.cfg.modal.fn} Hz`;
  setV('vW', d.wallDefl.toFixed(1), 'µm');
  $('sW').textContent = !sim.cfg.workpieceFlex ? '計算オフ' : d.wall ? `壁厚 ${d.wall.t.toFixed(1)} · 高さ ${d.wall.hWall.toFixed(0)} mm · k ${(d.wall.k / 1000).toFixed(1)} N/µm` : '剛体として扱い中';
  setV('vV', d.vib.toFixed(1), 'µm'); $('sV').textContent = `同期外成分 ${d.once.toFixed(1)} µm`;
  setV('vS', d.stress.toFixed(0), 'MPa');
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
  const immDeg = ((d.phiEx - d.phiSt) * 180 / Math.PI).toFixed(0);
  $('hLobe').textContent = `接触角 ${immDeg}° · 限界 ${lim === Infinity ? '—' : lim.toFixed(2) + ' mm'}`;
}

loadProgram();
setSpindle(baseS);
window.machiningSim = sim; window.machiningView = view; // handy for poking at the model from the browser console
requestAnimationFrame(frameLoop);
