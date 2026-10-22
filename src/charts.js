// Small canvas charts for forces, tool-tip orbit, vibration spectrum and stability lobes.
import { alimAt } from './sld.js';

let C = {};
export function refreshTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  C = { fg: v('--ink'), mute: v('--ink-mute'), grid: v('--rule'), panel: v('--panel'), a: v('--series-a'), b: v('--series-b'), c: v('--series-c'), accent: v('--accent'), bad: v('--bad'), ok: v('--ok'), warn: v('--warn'), mono: v('--font-mono') };
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
// rest: optional lobes of the tool at rest, drawn dashed behind the speed-dependent ones
// td: time-domain limits [{rpm, alim, open}] (stabtd.js), drawn as points joined by a line
export function drawLobes(cv, lobes, op, rpmRange, rest = null, td = null) {
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
  if (rest) {
    g.strokeStyle = C.mute; g.lineWidth = 1; g.setLineDash([4, 3]); g.beginPath();
    for (let px = 0; px <= box.w; px += 2) { const r = r0 + px / box.w * (r1 - r0), a = alimAt(rest, r), y = ys(a === Infinity ? Y : a); px ? g.lineTo(box.x + px, y) : g.moveTo(box.x + px, y); }
    g.stroke(); g.setLineDash([]);
  }
  g.strokeStyle = C.fg; g.lineWidth = 1.4; g.beginPath();
  env.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
  if (td?.length) {
    const pts = td.filter(p => p.rpm >= r0 && p.rpm <= r1).sort((a, b) => a.rpm - b.rpm);
    g.strokeStyle = C.warn; g.fillStyle = C.warn; g.lineWidth = 1.2; g.beginPath();
    pts.forEach((p, i) => { const x = xs(p.rpm), y = ys(p.alim); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    for (const p of pts) { g.beginPath(); g.arc(xs(p.rpm), ys(p.alim), p.open ? 4 : 3, 0, 6.3); p.open ? g.stroke() : g.fill(); }
  }
  // operating point (below the diagram's speeds: a marker at its left edge)
  if (!(op.S >= rpmRange[0])) {
    const y = ys(Math.min(op.ap, Y));
    g.fillStyle = C.mute; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(op.S > 0 ? `◀ ${Math.round(op.S)} min⁻¹ (線図より低速) / ${op.ap.toFixed(2)} mm` : '主軸停止 (0 min⁻¹)', box.x + 4, y - 4);
  } else if (op.S > 0) {
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

// Orthogonal cutting cross-section at the mean chip of the current cut: workpiece, shear plane,
// chip and tool with a temperature field built from the thermal model's zone temperatures
// (shear zone, rake contact, flank). Geometry from Merchant's shear angle; the field shape is
// an illustrative decay away from each heat source, its levels are the model's temperatures.
// s: {h [mm], hc [mm], phiDeg, rakeDeg, Tsh, Ttool, T0, VB [mm]}
const HEAT = {
  light: [[0, '#fbe9dd'], [0.35, '#f4a77e'], [0.7, '#d95926'], [1, '#7c2a0b']],
  dark: [[0, '#3a271d'], [0.35, '#8f3f1c'], [0.7, '#e2652f'], [1, '#ffd2b8']],
};
let probe = null;
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function ramp(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], f = (t - t0) / (t1 - t0), a = hexRgb(c0), b = hexRgb(c1);
    return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
  }
  return hexRgb(stops[stops.length - 1][1]);
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return [Math.hypot(px - ax - t * dx, py - ay - t * dy), t];
}

export function drawSection(cv, s) {
  const { g, w, h } = setup(cv);
  probe = null;
  if (!s) { g.fillStyle = C.mute; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('切削中に刃先の断面と温度分布を表示します', w / 2, h / 2); return; }
  const dark = hexRgb(C.panel || '#ffffff').reduce((a, b) => a + b) < 384;
  const stops = dark ? HEAT.dark : HEAT.light;
  const barW = 64, box = { x: 8, y: 8, w: w - barW - 16, h: h - 16 };
  const H = s.h, a = s.rakeDeg * Math.PI / 180, phi = s.phiDeg * Math.PI / 180, cl = 7 * Math.PI / 180;
  const hc = s.hc, lc = 2 * hc;
  const sc = box.h / (Math.max(H, hc) * 5.2);          // px per mm
  const ox = box.x + box.w * 0.62, oy = box.y + box.h * 0.66; // tool tip on screen
  const X = px => (px - ox) / sc, Y = py => (oy - py) / sc;   // screen → mm (y up)
  const Tmax = Math.max(s.Ttool, s.Tsh, s.T0 + 1), Tlo = s.T0;
  // geometry in mm, tip at the origin, workpiece moving towards −x
  const rk = [Math.sin(a), Math.cos(a)];                // rake face direction from the tip
  const fl = [Math.cos(cl), Math.sin(cl)];              // flank direction
  const sx = -H / Math.tan(phi);                        // shear plane meets the free surface at (sx, H)
  const nR = [-Math.cos(a), Math.sin(a)];               // rake face normal pointing into the chip
  const field = (x, y) => {
    // tool: right of the rake face and above the flank
    const rr = x * nR[0] + y * nR[1], ff = x * -fl[1] + y * fl[0];
    if (rr < 0 && ff > 0) {
      const [d] = segDist(x, y, 0, 0, rk[0] * lc, rk[1] * lc);
      const [dv] = segDist(x, y, 0, 0, Math.max(s.VB, 0.01), 0);
      return { zone: 'tool', T: Tlo + (s.Ttool - Tlo) * Math.max(Math.exp(-d / (1.2 * lc)), 0.6 * Math.exp(-dv / (0.6 * lc))) };
    }
    // signed distance to the shear plane (positive on the chip side)
    const spx = -sx, spy = -H, spl = Math.hypot(spx, spy);
    const ds = ((y - H) * spx - (x - sx) * spy) / spl;
    const along = (x - 0) * rk[0] + y * rk[1];
    if (rr >= 0 && rr <= hc && ds >= 0 && y >= 0) {
      const g2 = along < lc ? Math.min(1, 0.45 + along / lc) : Math.exp(-(along - lc) / (0.8 * lc));
      return { zone: 'chip', T: s.Tsh + (s.Ttool - s.Tsh) * Math.exp(-rr / (0.22 * hc)) * g2 };
    }
    if (y < 0 || (y <= H && ds < 0)) {
      const [d] = segDist(x, y, sx, H, 0, 0);
      const [dv] = segDist(x, y, 0, 0, Math.max(s.VB, 0.01) + 0.3 * H, 0);
      return { zone: 'work', T: Tlo + (s.Tsh - Tlo) * Math.max(Math.exp(-d / (0.45 * H)), 0.5 * Math.exp(-dv / (0.35 * H))) };
    }
    return null;
  };
  // temperature image at half resolution
  const dpr = cv.width / w, step = 2;
  const nx = Math.ceil(box.w / step), ny = Math.ceil(box.h / step);
  const img = g.createImageData(Math.round(nx * step * dpr), Math.round(ny * step * dpr));
  const iw = img.width;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const f = field(X(box.x + (i + 0.5) * step), Y(box.y + (j + 0.5) * step));
    if (!f) continue;
    const c = ramp(stops, (f.T - Tlo) / (Tmax - Tlo));
    const x0 = Math.round(i * step * dpr), x1 = Math.round((i + 1) * step * dpr), y0 = Math.round(j * step * dpr), y1 = Math.round((j + 1) * step * dpr);
    for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < iw; xx++) {
      const k = (yy * iw + xx) * 4; img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, Math.round(box.x * dpr), Math.round(box.y * dpr));
  g.save(); g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();
  const P = (x, y) => [ox + x * sc, oy - y * sc];
  // outlines: tool, shear plane, chip back, flank wear land
  g.strokeStyle = C.fg; g.lineWidth = 1.5;
  const L = 20 * Math.max(H, hc);
  g.beginPath(); g.moveTo(...P(rk[0] * L, rk[1] * L)); g.lineTo(...P(0, 0)); g.lineTo(...P(fl[0] * L, fl[1] * L)); g.stroke();
  g.setLineDash([4, 3]); g.lineWidth = 1;
  g.beginPath(); g.moveTo(...P(0, 0)); g.lineTo(...P(sx, H)); g.stroke();
  g.setLineDash([]);
  g.beginPath(); g.moveTo(...P(sx, H)); g.lineTo(...P(sx + rk[0] * L, H + rk[1] * L)); g.stroke();
  if (s.VB > 0.002) { g.strokeStyle = C.bad; g.lineWidth = 3; g.beginPath(); g.moveTo(...P(0, 0)); g.lineTo(...P(s.VB, 0)); g.stroke(); }
  // labels in text ink
  g.fillStyle = C.fg; g.font = `11px ${C.mono}`; g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText('工具', ...P(rk[0] * 2.5 * hc + 1.2 * hc, 2.6 * hc));
  g.textAlign = 'right';
  const cl0 = 2.2 * Math.max(H, hc);
  g.fillText(`切りくず hc ${hc.toFixed(3)} mm`, ...P(rk[0] * cl0 + nR[0] * hc * 1.25, rk[1] * cl0 + nR[1] * hc * 1.25));
  g.textAlign = 'right';
  g.fillText(`せん断角 ${s.phiDeg.toFixed(0)}°`, ...P(sx - 0.15 * H, 0.5 * H));
  g.fillText(`h ${H.toFixed(3)} mm`, ...P(sx - 0.15 * H, 1.4 * H));
  g.textAlign = 'left';
  g.fillText('被削材 (← 工具に対して流れる向き)', ...P(-14 * H, -0.9 * H));
  if (s.VB > 0.002) { g.fillText(`VB ${(s.VB * 1000).toFixed(0)} µm`, ...P(0.2 * H, -0.5 * H)); }
  g.restore();
  // colour bar
  const bx = w - barW + 4, by = box.y + 14, bh = box.h - 28;
  for (let k = 0; k < bh; k++) { const c = ramp(stops, 1 - k / bh); g.fillStyle = `rgb(${c})`; g.fillRect(bx, by + k, 10, 1); }
  g.fillStyle = C.mute; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText('°C', bx, box.y + 4);
  for (const t of [0, 0.5, 1]) g.fillText(`${Math.round(Tlo + (Tmax - Tlo) * t)}`, bx + 14, by + bh * (1 - t));
  probe = (px, py) => { if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) return null; return field(X(px), Y(py)); };
}

// temperature under a pointer position (CSS px within the canvas), from the last drawSection
export function sectionProbe(px, py) { return probe ? probe(px, py) : null; }

// one spindle revolution of force: measured (solid) and simulated (dashed), Fx Fy (Fz)
export function drawRevolution(cv, meas, sim, comps = [0, 1, 2]) {
  const { g, w, h } = setup(cv);
  const box = { x: 40, y: 18, w: w - 52, h: h - 42 };
  const cols = [C.a, C.b, C.c], names = ['Fx', 'Fy', 'Fz'], n = meas[0].length;
  let mx = 0; for (const c of comps) for (const a of [meas[c], sim?.[c]]) if (a) for (const v of a) mx = Math.max(mx, Math.abs(v));
  const Y = niceMax(mx * 1.05), ys = v => box.y + box.h / 2 - v / Y * box.h / 2, xs = b => box.x + box.w * (b + 0.5) / n;
  frame(g, box, '主軸の回転角 [°]', 'N', [[`${Y}`, ys(Y)], ['0', ys(0)], [`${-Y}`, ys(-Y)]], [0, 90, 180, 270, 360].map(d => [`${d}`, box.x + box.w * d / 360]));
  const line = (a, col, dash) => {
    g.strokeStyle = col; g.lineWidth = dash ? 1.2 : 1.6; g.setLineDash(dash ? [5, 4] : []);
    g.beginPath(); for (let b = 0; b < n; b++) b ? g.lineTo(xs(b), ys(a[b])) : g.moveTo(xs(b), ys(a[b])); g.stroke();
  };
  for (const c of comps) { line(meas[c], cols[c], false); if (sim) line(sim[c], cols[c], true); }
  g.setLineDash([]);
  legend(g, [...comps.map(c => [names[c], cols[c]]), ['破線=計算', C.mute]], box.x + 22, 7);
}
