// UI: condition form, particle field view (Canvas 2D), force / temperature charts, readouts.
import { MATERIALS } from './materials.js';
import { DEFAULTS } from './sph.js';

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
};

// ---- State ----
let frame = null, field = 'T', zoom = 'tip', status = 'idle', cfg = null;
const view = $('view'), vctx = view.getContext('2d');

// ---- Conditions form ----
const matSel = $('mat');
for (const [k, m] of Object.entries(MATERIALS)) matSel.add(new Option(m.name, k));
matSel.value = DEFAULTS.mat;
function applyMaterialDefaults() {
  const m = MATERIALS[matSel.value];
  $('vc').value = m.vc; $('mu').value = m.mu;
}
applyMaterialDefaults();
matSel.addEventListener('change', () => { applyMaterialDefaults(); reset(); });

function readCfg() {
  const num = (id) => parseFloat($(id).value);
  return {
    mat: matSel.value, vc: num('vc'), h: num('h'), rake: num('rake'), clearance: num('clear'),
    edgeRadius: num('edge'), mu: num('mu'), width: num('width'), cutLen: num('len'), nh: num('res'),
  };
}
for (const id of ['vc', 'h', 'rake', 'clear', 'edge', 'mu', 'width', 'len', 'res']) $(id).addEventListener('change', reset);

function reset() {
  cfg = readCfg();
  status = 'idle'; frame = null;
  worker.postMessage({ type: 'init', cfg });
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
  draw();
});

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
  if (f === 'T') { lo = 20; hi = Math.max(hi, 100); }
  if (f === 'seq' || f === 'ep') lo = 0;
  if (f === 'sr') { lo = Math.max(lo, 0); hi = Math.max(hi, lo + 1); }
  if (f === 'p') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -m; hi = m; }
  if (!(hi > lo)) hi = lo + 1;
  return [lo, hi];
}

function draw() {
  const dpr = window.devicePixelRatio || 1, W = view.clientWidth, H = view.clientHeight;
  if (view.width !== Math.round(W * dpr) || view.height !== Math.round(H * dpr)) { view.width = Math.round(W * dpr); view.height = Math.round(H * dpr); }
  const cw = view.width, ch = view.height;
  vctx.clearRect(0, 0, cw, ch);
  if (!frame) return;
  const hmm = cfg.h, [tx, ty] = frame.tip;
  // Window in mm: whole block, or a box around the cutting edge.
  let wx0, wx1, wy0, wy1;
  if (zoom === 'all') { wx0 = Math.min(-0.15, tx - 3 * hmm); wx1 = frame.L + 0.02; wy0 = -frame.H - 0.02; wy1 = Math.max(0.35, 4.5 * hmm); }
  else { wx0 = tx - 4.5 * hmm; wx1 = tx + 4.5 * hmm; wy0 = ty - 2.2 * hmm; wy1 = ty + 4.8 * hmm; }
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
  // Tool.
  const css = getComputedStyle(document.documentElement);
  vctx.beginPath();
  frame.outline.forEach(([a, b], i) => { const X = ox + a * s, Y = oy - b * s; if (i) vctx.lineTo(X, Y); else vctx.moveTo(X, Y); });
  vctx.closePath();
  const g = vctx.createLinearGradient(ox + (tx - 3 * hmm) * s, 0, ox + tx * s, 0);
  g.addColorStop(0, css.getPropertyValue('--tool-a')); g.addColorStop(1, css.getPropertyValue('--tool-b'));
  vctx.fillStyle = g; vctx.fill();
  vctx.lineWidth = 1.5 * dpr; vctx.strokeStyle = css.getPropertyValue('--tool-edge'); vctx.stroke();
  // Original surface and cut depth guide lines.
  vctx.setLineDash([4 * dpr, 4 * dpr]); vctx.strokeStyle = css.getPropertyValue('--guide'); vctx.lineWidth = dpr;
  vctx.beginPath(); vctx.moveTo(0, oy + hmm * s); vctx.lineTo(cw, oy + hmm * s); vctx.stroke(); vctx.setLineDash([]);
  // Scale bar: 50 µm or 100 µm.
  const bar = zoom === 'all' ? 0.1 : 0.05, bl = bar * s;
  vctx.fillStyle = css.getPropertyValue('--ink'); vctx.fillRect(cw - bl - 16 * dpr, ch - 22 * dpr, bl, 3 * dpr);
  vctx.font = `${11 * dpr}px ${css.getPropertyValue('--font-mono')}`; vctx.textAlign = 'right';
  vctx.fillText(`${bar * 1000} µm`, cw - 16 * dpr, ch - 28 * dpr);
  // Legend.
  const f = FIELDS[field];
  $('lg-bar').style.background = cssGrad(f.map);
  $('lg-lo').textContent = f.fmt(lo); $('lg-hi').textContent = f.fmt(hi);
  $('lg-name').textContent = f.unit ? `${f.label} [${f.unit}]` : f.label;
}
new ResizeObserver(() => { draw(); drawCharts(); }).observe(view);

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
  pr.textContent = `${frame.T[best].toFixed(0)} °C · σ ${frame.seq[best].toFixed(0)} MPa · ε ${frame.ep[best].toFixed(2)} · ε̇ ${frame.sr[best].toExponential(1)} /s · p ${frame.p[best].toFixed(0)} MPa`;
});
view.addEventListener('pointerleave', () => { $('probe').hidden = true; });

// ---- Charts ----
function niceStep(span, n) {
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}
function lineChart(canvas, xs, series, xmax, unit) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  const L = 48, R = 12, T = 12, B = 28, pw = W - L - R, ph = H - T - B;
  let ymax = 1;
  for (const s of series) for (const v of s.data) if (v > ymax) ymax = v;
  const ystep = niceStep(ymax, 4); ymax = Math.ceil(ymax / ystep) * ystep;
  const xstep = niceStep(xmax, pw < 320 ? 3 : 5);
  c.font = `11px ${css.getPropertyValue('--font-mono')}`; c.fillStyle = css.getPropertyValue('--ink-mute');
  c.strokeStyle = css.getPropertyValue('--rule'); c.lineWidth = 1;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    const y = T + ph - v / ymax * ph;
    c.beginPath(); c.moveTo(L, y); c.lineTo(L + pw, y); c.stroke();
    c.fillText(v.toFixed(ystep < 1 ? 1 : 0), L - 6, y);
  }
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (let v = 0; v <= xmax + 1e-9; v += xstep) c.fillText(v.toFixed(xstep < 0.1 ? 2 : 1), L + v / xmax * pw, T + ph + 6);
  c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(unit, 4, 0);
  c.textAlign = 'right'; c.fillText('横軸 切削長さ [mm]', L + pw, 0);
  for (const s of series) {
    if (!s.data.length) continue;
    c.strokeStyle = css.getPropertyValue(s.color); c.lineWidth = 2; c.beginPath();
    s.data.forEach((v, i) => { const x = L + xs[i] / xmax * pw, y = T + ph - v / ymax * ph; if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke();
    const i = s.data.length - 1, x = L + xs[i] / xmax * pw, y = T + ph - s.data[i] / ymax * ph;
    c.fillStyle = css.getPropertyValue(s.color); c.beginPath(); c.arc(x, y, 3, 0, 7); c.fill();
  }
}
function drawCharts() {
  const h = frame ? frame.hist : { travel: [], fc: [], ft: [], tmax: [], trake: [] };
  const xmax = cfg ? cfg.cutLen : 1;
  lineChart($('chart-f'), h.travel, [{ data: h.fc, color: '--s1' }, { data: h.ft, color: '--s2' }], xmax, 'N');
  lineChart($('chart-t'), h.travel, [{ data: h.tmax, color: '--s3' }, { data: h.trake, color: '--s1' }], xmax, '°C');
}

// ---- Readouts ----
function readouts() {
  const s = frame.summary, has = s.steps > 0;
  const set = (id, v) => { $(id).textContent = has ? v : '—'; };
  set('r-fc', s.fc.toFixed(0)); set('r-ft', s.ft.toFixed(0));
  set('r-kc', s.kc.toFixed(0)); $('r-kcref').textContent = `便覧値の目安 ${s.kcRef}`;
  set('r-hc', s.ratio > 0 ? s.hc.toFixed(3) : '—'); $('r-ratio').textContent = has && s.ratio > 0 ? `切りくず厚さ比 ${s.ratio.toFixed(2)}` : '切りくず厚さ比 —';
  set('r-phi', s.phi > 0 ? s.phi.toFixed(1) : '—'); $('r-phim').textContent = `Merchant の式 ${s.phiMerchant.toFixed(1)}°`;
  set('r-tmax', s.tmax.toFixed(0)); set('r-trake', s.trake.toFixed(0));
  set('r-ep', s.epMax.toFixed(1)); $('r-ed').textContent = has ? `最大ひずみ速度 ${s.edMax.toExponential(1)} /s` : '最大ひずみ速度 —';
  const pct = Math.min(100, s.travel / cfg.cutLen * 100);
  $('prog').style.width = pct + '%';
  $('clock').textContent = `${s.travel.toFixed(3)} / ${cfg.cutLen.toFixed(2)} mm · ${(s.t * 1e6).toFixed(1)} µs · 計算 ${(frame.wall / 1000).toFixed(0)} s`;
  $('meta').textContent = `粒子 ${s.N.toLocaleString()} 個 · 間隔 ${s.dx.toFixed(1)} µm · 質量スケーリング ×${s.ms.toFixed(0)} · Δt ${(frame.dt * 1e9).toFixed(1)} ns · ${s.steps.toLocaleString()} ステップ${s.heatRatio > 0 ? ` · 発熱 / 切削仕事 ${(s.heatRatio * 100).toFixed(0)} %` : ''}`;
}

reset();
