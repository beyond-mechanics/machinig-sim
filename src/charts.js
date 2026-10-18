// Small canvas charts for forces, tool-tip orbit, vibration spectrum and stability lobes.
import { alimAt } from './sld.js';

let C = {};
export function refreshTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  C = { fg: v('--ink'), mute: v('--ink-mute'), grid: v('--rule'), panel: v('--panel'), a: v('--series-a'), b: v('--series-b'), c: v('--series-c'), accent: v('--accent'), bad: v('--bad'), ok: v('--ok'), mono: v('--font-mono') };
}

function setup(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = `11px ${C.mono}`;
  return { g, w, h };
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function frame(g, box, xLabel, yLabel, yTicks, xTicks) {
  g.strokeStyle = C.grid; g.lineWidth = 1; g.fillStyle = C.mute;
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const [v, y] of yTicks) { g.beginPath(); g.moveTo(box.x, y + 0.5); g.lineTo(box.x + box.w, y + 0.5); g.stroke(); g.fillText(v, box.x - 4, y); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const [v, x] of xTicks) g.fillText(v, x, box.y + box.h + 4);
  g.textAlign = 'left'; g.textBaseline = 'top';
  if (yLabel) g.fillText(yLabel, box.x, 2);
  g.textAlign = 'right';
  if (xLabel) g.fillText(xLabel, box.x + box.w, box.y + box.h + 16);
}

function legend(g, items, x, y) {
  g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const [name, col] of items) {
    g.fillStyle = col; g.fillRect(x, y - 1.5, 10, 3);
    g.fillStyle = C.mute; g.fillText(name, x + 14, y);
    x += g.measureText(name).width + 30;
  }
}

function recent(hist, key, n) {
  const out = new Float32Array(n), m = Math.min(n, hist.count);
  for (let k = 0; k < m; k++) out[n - m + k] = hist[key][(hist.i - m + k + hist.n) % hist.n];
  return { arr: out, m };
}

export function drawForces(cv, eng) {
  const { g, w, h } = setup(cv);
  const box = { x: 40, y: 18, w: w - 52, h: h - 42 };
  if (!eng.stepsPerTooth) return;
  const spr = Math.round(eng.stepsPerTooth * eng.N / eng.decim);
  const n = Math.min(eng.hist.n, spr * 3);
  const series = [['Fx', C.a], ['Fy', C.b], ['Fz', C.c]].map(([k, c]) => ({ k, c, ...recent(eng.hist, k, n) }));
  let mx = 0; for (const s of series) for (let i = n - s.m; i < n; i++) mx = Math.max(mx, Math.abs(s.arr[i]));
  const Y = niceMax(mx * 1.05);
  const ys = v => box.y + box.h / 2 - v / Y * box.h / 2;
  const msPer = eng.dt * eng.decim * 1e3;
  const xt = []; for (let r = 0; r <= 3; r++) xt.push([`${(-(3 - r) * spr * msPer).toFixed(0)}`, box.x + box.w * r / 3]);
  frame(g, box, 'ms (直近3回転)', 'N', [[`${Y}`, ys(Y)], ['0', ys(0)], [`${-Y}`, ys(-Y)]], xt);
  for (const s of series) {
    g.strokeStyle = s.c; g.lineWidth = 1.4; g.beginPath();
    for (let i = n - s.m; i < n; i++) { const x = box.x + box.w * i / (n - 1); i === n - s.m ? g.moveTo(x, ys(s.arr[i])) : g.lineTo(x, ys(s.arr[i])); }
    g.stroke();
  }
  legend(g, series.map(s => [s.k, s.c]), box.x + 22, 7);
}

export function drawOrbit(cv, eng) {
  const { g, w, h } = setup(cv);
  if (!eng.stepsPerTooth) return;
  const spr = Math.round(eng.stepsPerTooth * eng.N / eng.decim);
  const n = Math.min(eng.hist.n, spr * 4);
  const X = recent(eng.hist, 'x', n), Yv = recent(eng.hist, 'y', n);
  let mx = 2; for (let i = n - X.m; i < n; i++) mx = Math.max(mx, Math.abs(X.arr[i]), Math.abs(Yv.arr[i]));
  const R = niceMax(mx * 1.1);
  const size = Math.min(w - 50, h - 34), cx = 40 + size / 2 + Math.max(0, (w - 50 - size) / 2), cy = 18 + size / 2;
  g.strokeStyle = C.grid; g.lineWidth = 1;
  g.strokeRect(cx - size / 2 + 0.5, cy - size / 2 + 0.5, size, size);
  g.beginPath(); g.moveTo(cx - size / 2, cy + 0.5); g.lineTo(cx + size / 2, cy + 0.5); g.moveTo(cx + 0.5, cy - size / 2); g.lineTo(cx + 0.5, cy + size / 2); g.stroke();
  g.fillStyle = C.mute; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText(`µm  ±${R}`, 4, 2);
  g.fillText('X →', cx + size / 2 - 26, cy + 4);
  g.fillText('Y ↑', cx + 4, cy - size / 2 + 2);
  g.strokeStyle = C.a; g.lineWidth = 1.2; g.beginPath();
  const s = size / 2 / R;
  for (let i = n - X.m; i < n; i++) { const px = cx + X.arr[i] * s, py = cy - Yv.arr[i] * s; i === n - X.m ? g.moveTo(px, py) : g.lineTo(px, py); }
  g.stroke();
  // once-per-tooth samples: a tight cluster means forced vibration, a scattered ring means chatter
  const ts = eng.toothSamples, m = Math.min(ts.count, 24);
  g.fillStyle = C.accent;
  for (let k = 0; k < m; k++) { const j = (ts.i - 1 - k + ts.n) % ts.n; g.beginPath(); g.arc(cx + ts.x[j] * 1e6 * s, cy - ts.y[j] * 1e6 * s, 2.4, 0, 6.3); g.fill(); }
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// fn: natural frequency or list of them [Hz]
export function drawSpectrum(cv, eng, fn) {
  const fns = [].concat(fn);
  const { g, w, h } = setup(cv);
  const box = { x: 40, y: 18, w: w - 52, h: h - 42 };
  if (!eng.stepsPerTooth) return;
  const n = 2048, X = recent(eng.hist, 'x', n), Yv = recent(eng.hist, 'y', n);
  const re = new Float32Array(n), im = new Float32Array(n);
  let mean = 0; for (let i = 0; i < n; i++) mean += X.arr[i]; mean /= n;
  for (let i = 0; i < n; i++) { const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); re[i] = (X.arr[i] - mean) * win; }
  fft(re, im);
  const fs = 1 / (eng.dt * eng.decim);
  const fMax = Math.min(fs / 2, Math.max(Math.max(...fns) * 2.2, 3000));
  const kMax = Math.floor(fMax / fs * n);
  const amp = new Float32Array(kMax);
  let mx = 1e-6; for (let k = 1; k < kMax; k++) { amp[k] = Math.hypot(re[k], im[k]) * 4 / n; mx = Math.max(mx, amp[k]); }
  const Y = niceMax(mx);
  const xs = f => box.x + f / fMax * box.w, ys = v => box.y + box.h - v / Y * box.h;
  const xt = []; const step = niceMax(fMax / 5);
  for (let f = 0; f <= fMax; f += step) xt.push([f >= 1000 ? `${f / 1000}k` : `${f}`, xs(f)]);
  frame(g, box, 'Hz', 'µm (X方向)', [[`${Y}`, ys(Y)], ['0', ys(0)]], xt);
  // tooth passing harmonics and natural frequency
  const ftp = eng.S * eng.N / 60;
  g.setLineDash([3, 3]); g.strokeStyle = C.mute;
  for (let k = 1; ftp * k < fMax; k++) { g.beginPath(); g.moveTo(xs(ftp * k), box.y); g.lineTo(xs(ftp * k), box.y + box.h); g.stroke(); }
  g.strokeStyle = C.bad;
  for (const f of fns) if (f < fMax) { g.beginPath(); g.moveTo(xs(f), box.y); g.lineTo(xs(f), box.y + box.h); g.stroke(); }
  g.setLineDash([]);
  g.fillStyle = C.a; g.globalAlpha = 0.25;
  g.beginPath(); g.moveTo(xs(0), ys(0));
  for (let k = 1; k < kMax; k++) g.lineTo(xs(k * fs / n), ys(amp[k]));
  g.lineTo(xs((kMax - 1) * fs / n), ys(0)); g.fill();
  g.globalAlpha = 1; g.strokeStyle = C.a; g.lineWidth = 1.3; g.beginPath();
  for (let k = 1; k < kMax; k++) { const x = xs(k * fs / n), y = ys(amp[k]); k === 1 ? g.moveTo(x, y) : g.lineTo(x, y); }
  g.stroke();
  legend(g, [['刃通過周波数', C.mute], ['固有振動数', C.bad]], box.x + 70, 7);
}

// returns the plotting box so clicks can be mapped back to rpm
export function drawLobes(cv, lobes, op, rpmRange) {
  const { g, w, h } = setup(cv);
  const box = { x: 40, y: 18, w: w - 52, h: h - 42 };
  const [r0, r1] = rpmRange;
  const xs = r => box.x + (r - r0) / (r1 - r0) * box.w;
  // scale to the envelope: peaks can be very tall, so show up to ~4x the lowest limit
  let eMin = Infinity, eMax = 0;
  for (let px = 0; px <= 200; px++) { const a = alimAt(lobes, r0 + px / 200 * (r1 - r0)); if (a < Infinity) { eMin = Math.min(eMin, a); eMax = Math.max(eMax, a); } }
  const Y = niceMax(Math.max(op.ap * 1.3, Math.min(eMax, (eMin < Infinity ? eMin : 1) * 4), 1));
  const ys = a => box.y + box.h - Math.min(a, Y) / Y * box.h;
  const xt = []; const step = niceMax((r1 - r0) / 5);
  for (let r = Math.ceil(r0 / step) * step; r <= r1; r += step) xt.push([`${r / 1000}k`, xs(r)]);
  frame(g, box, 'min⁻¹', 'ap 安定限界 mm', [[`${Y}`, ys(Y)], [`${Y / 2}`, ys(Y / 2)], ['0', ys(0)]], xt);
  // stable region under the envelope
  g.fillStyle = C.ok; g.globalAlpha = 0.14;
  g.beginPath(); g.moveTo(box.x, ys(0));
  const env = [];
  for (let px = 0; px <= box.w; px += 2) { const r = r0 + px / box.w * (r1 - r0); const a = alimAt(lobes, r); env.push([box.x + px, ys(a === Infinity ? Y : a)]); }
  for (const [x, y] of env) g.lineTo(x, y);
  g.lineTo(box.x + box.w, ys(0)); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = C.fg; g.lineWidth = 1.4; g.beginPath();
  env.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
  // operating point
  if (op.S > 0) {
    const x = xs(op.S), y = ys(op.ap);
    g.fillStyle = op.stable ? C.ok : C.bad; g.strokeStyle = C.panel; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, 5, 0, 6.3); g.fill(); g.stroke();
    g.fillStyle = C.fg; g.textAlign = x > box.x + box.w - 90 ? 'right' : 'left'; g.textBaseline = 'bottom';
    g.fillText(`${Math.round(op.S)} min⁻¹ / ${op.ap.toFixed(2)} mm`, x + (g.textAlign === 'left' ? 8 : -8), y - 4);
  }
  return box;
}

// Side-wall profile from the tooth-arc envelope (roughness.js); dashed line: ideal scallop height
export function drawRoughness(cv, prof) {
  const { g, w, h } = setup(cv);
  const box = { x: 40, y: 18, w: w - 52, h: h - 42 };
  if (!prof) { g.fillStyle = C.mute; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('側面を削っているときに表示します', w / 2, h / 2); return; }
  const Y = niceMax(Math.max(prof.Rz, prof.Rth) * 1.15 || 0.01);
  const L = prof.length, xs = x => box.x + x / L * box.w, ys = v => box.y + v / Y * box.h; // depth downwards
  const xt = []; const step = niceMax(L / 4);
  for (let x = 0; x <= L + 1e-9; x += step) xt.push([`${+x.toFixed(3)}`, xs(x)]);
  frame(g, box, '送り方向 mm', 'µm (壁の凹凸)', [['0', ys(0)], [`${Y}`, ys(Y)]], xt);
  g.setLineDash([3, 3]); g.strokeStyle = C.mute;
  g.beginPath(); g.moveTo(box.x, ys(prof.Rth)); g.lineTo(box.x + box.w, ys(prof.Rth)); g.stroke();
  g.setLineDash([]);
  // material side filled
  g.fillStyle = C.a; g.globalAlpha = 0.25;
  g.beginPath(); g.moveTo(xs(0), box.y);
  for (let i = 0; i < prof.x.length; i++) g.lineTo(xs(prof.x[i]), ys(prof.z[i]));
  g.lineTo(xs(L), box.y); g.fill();
  g.globalAlpha = 1; g.strokeStyle = C.a; g.lineWidth = 1.3; g.beginPath();
  for (let i = 0; i < prof.x.length; i++) { const px = xs(prof.x[i]), py = ys(prof.z[i]); i ? g.lineTo(px, py) : g.moveTo(px, py); }
  g.stroke();
}
