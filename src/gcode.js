// G-code parser and path discretizer for 3-axis milling (G17 / XY plane).
// Supported: G0 G1 G2 G3 (I/J or R), G17 G20 G21 G90 G91, F S, M3 M4 M5 M30.
// Unsupported words are ignored with a warning (cutter comp, canned cycles, etc.).

const IGNORED_G = new Set([17, 40, 43, 49, 54, 55, 56, 57, 58, 59, 80, 94, 28, 53, 64, 61]);

export function parseGcode(text, start = { x: 0, y: 0, z: 50 }) {
  const st = { ...start, abs: true, unit: 1, motion: 0, F: 1000, S: 10000, spindle: false };
  const moves = [];
  const warnings = [];
  const meta = {};
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    let raw = lines[ln];
    const stock = raw.match(/\(\s*STOCK\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/i);
    if (stock) meta.stock = { w: +stock[1], l: +stock[2], h: +stock[3] };
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const words = [...line.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)].map(m => [m[1], parseFloat(m[2])]);
    if (!words.length) continue;
    const w = {};
    let hasMotionWord = false;
    for (const [k, v] of words) {
      if (k === 'G') {
        if ([0, 1, 2, 3].includes(v)) { st.motion = v; hasMotionWord = true; }
        else if (v === 20) st.unit = 25.4;
        else if (v === 21) st.unit = 1;
        else if (v === 90) st.abs = true;
        else if (v === 91) st.abs = false;
        else if (v === 18 || v === 19) warnings.push(`${ln + 1}行: G${v} 平面は未対応 (G17のみ)`);
        else if (v === 41 || v === 42) warnings.push(`${ln + 1}行: 工具径補正 G${v} は未対応 (無視)`);
        else if (v >= 73 && v <= 89) warnings.push(`${ln + 1}行: 固定サイクル G${v} は未対応`);
        else if (!IGNORED_G.has(v)) warnings.push(`${ln + 1}行: G${v} は無視`);
      } else if (k === 'M') {
        if (v === 3 || v === 4) st.spindle = true;
        else if (v === 5) st.spindle = false;
        else if (v === 30 || v === 2) { ln = lines.length; break; }
      } else w[k] = v;
    }
    if (w.F !== undefined) st.F = w.F * st.unit;
    if (w.S !== undefined) st.S = w.S;
    const hasAxis = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;
    if (!hasAxis && !(hasMotionWord && (w.I !== undefined || w.J !== undefined))) continue;
    const u = st.unit;
    const to = {
      x: w.X === undefined ? st.x : (st.abs ? w.X * u : st.x + w.X * u),
      y: w.Y === undefined ? st.y : (st.abs ? w.Y * u : st.y + w.Y * u),
      z: w.Z === undefined ? st.z : (st.abs ? w.Z * u : st.z + w.Z * u),
    };
    const from = { x: st.x, y: st.y, z: st.z };
    const mv = { rapid: st.motion === 0, from, to, F: st.F, S: st.S, spindle: st.spindle, line: ln + 1 };
    if (st.motion === 2 || st.motion === 3) {
      let cx, cy;
      if (w.R !== undefined) {
        const r = w.R * u, dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy);
        if (d < 1e-9 || d > 2 * Math.abs(r) + 1e-6) { warnings.push(`${ln + 1}行: 円弧Rが不正`); continue; }
        const hgt = Math.sqrt(Math.max(0, r * r - d * d / 4));
        // left of chord for (CCW, R>0) or (CW, R<0)
        const sgn = ((st.motion === 3) === (r > 0)) ? 1 : -1;
        cx = from.x + dx / 2 - sgn * hgt * dy / d;
        cy = from.y + dy / 2 + sgn * hgt * dx / d;
      } else {
        cx = from.x + (w.I || 0) * u;
        cy = from.y + (w.J || 0) * u;
      }
      mv.arc = { cx, cy, cw: st.motion === 2 };
    }
    if (!st.spindle && !mv.rapid) warnings.push(`${ln + 1}行: 主軸停止中の切削送り`);
    moves.push(mv);
    st.x = to.x; st.y = to.y; st.z = to.z;
  }
  return { moves, warnings: [...new Set(warnings)].slice(0, 30), meta };
}

// Convert moves into a polyline. Each point carries the attributes of the segment ending at it.
export function discretize(moves, maxSeg = 0.5) {
  if (!moves.length) return [];
  const pts = [{ ...moves[0].from, rapid: true, F: moves[0].F, S: moves[0].S, line: moves[0].line }];
  for (const mv of moves) {
    const attr = { rapid: mv.rapid, F: mv.F, S: mv.S, line: mv.line };
    if (mv.arc) {
      const { cx, cy, cw } = mv.arc;
      const r = Math.hypot(mv.from.x - cx, mv.from.y - cy);
      const a0 = Math.atan2(mv.from.y - cy, mv.from.x - cx);
      let a1 = Math.atan2(mv.to.y - cy, mv.to.x - cx);
      let sweep = a1 - a0;
      if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
      else if (sweep <= 1e-9) sweep += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) * r / maxSeg));
      for (let i = 1; i <= n; i++) {
        const a = a0 + sweep * i / n;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: mv.from.z + (mv.to.z - mv.from.z) * i / n, ...attr });
      }
      // snap to exact end point
      Object.assign(pts[pts.length - 1], mv.to);
    } else {
      pts.push({ ...mv.to, ...attr });
    }
  }
  return pts;
}

export const RAPID_RATE = 15000; // mm/min

export function segmentTime(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const rate = b.rapid ? RAPID_RATE : Math.max(1, b.F);
  return d / (rate / 60);
}
