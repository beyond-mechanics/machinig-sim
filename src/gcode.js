// G-code parser and path discretizer for 3-axis milling (Fanuc-style dialect).
// Supported: G0 G1 G2 G3 (I/J/K or R, helical) in G17/G18/G19, G20 G21 G90 G91 G94 G95,
// canned cycles G73 G81-G89 with G98/G99 and K/L repeats, G28/G53 (to the home height),
// tool changes (T.. M6) with tool definitions read from comments, F S M3 M4 M5 M30, subprograms
// (O-number labels, M98 P… L… / P<times><number>, M99 return), custom macro B variables, IF/GOTO
// and WHILE/DO/END (macro.js).
// Work coordinate systems G54-G59 and G54.1 P1-P48: each move records its system (mv.wcs);
// opts.wcs gives every system's zero in a common frame, so a change of system re-expresses the
// current position (incremental moves stay right). G52 shifts the local zero of the system.
// Cutter compensation G41/G42/G40 is recorded on each move (mv.comp, mv.compD) and applied by
// cuttercomp.js once the tool radii are known. Macros and subprograms are ignored with a warning.
import { macroStatement, substitute } from './macro.js';

const IGNORED_G = new Set([43, 44, 49, 54, 55, 56, 57, 58, 59, 61, 64, 80, 94, 15, 69, 50, 13, 12]);
const CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
// plane → [first axis, second axis, normal]; each triple is right-handed, so G2 is clockwise
// when looking from the positive normal, and the arc-centre words follow the axes
const PLANES = { 17: ['x', 'y', 'z'], 18: ['z', 'x', 'y'], 19: ['y', 'z', 'x'] };
const CENTRE = { x: 'I', y: 'J', z: 'K' };
const PECK_CLEAR = 0.5; // retract/approach clearance of peck cycles [mm] (machine parameter on real controls)

// Tool definitions written as comments by CAM posts and by hand. Returns {T, D, type, N?, fluteLen?, stickout?, label}.
// (TOOL T1 D10 N3 FLAT L25 SO30)                 this app's own form
// (T1 D=10. CR=0. - ZMIN=-12. - flat end mill)   Autodesk Fusion / HSM posts
// ( T1 | 10. FLAT ENDMILL | H1 )                  Mastercam-like posts
// (T2 φ6 ボールエンドミル 2枚刃)                     free text with T number and diameter
export function parseToolComment(text) {
  const c = text.trim();
  const tm = c.match(/(?:^|[\s|(])T\s*(\d+)\b/i);
  if (!tm) return null;
  const num = s => parseFloat(s);
  let D = null;
  const dm = c.match(/(?:\bD(?:IA\.?|IAMETER)?\s*[=:]?\s*|[φΦØø⌀]\s*)(\d+\.?\d*|\.\d+)/i)
    || c.match(/\|\s*(\d+\.?\d*)\s*(?:MM)?\s*(?:FLAT|BALL|BULL|END|DRILL|SQUARE)/i);
  if (dm) D = num(dm[1]);
  if (!(D > 0)) return null;
  const cr = c.match(/\bCR\s*=?\s*(\d+\.?\d*)/i);
  let type = 'flat';
  if (/BALL|ボール|球/i.test(c) || (cr && Math.abs(num(cr[1]) - D / 2) < 1e-3)) type = 'ball';
  const drill = /DRILL|ドリル|SPOT|CENTER|センター/i.test(c);
  const t = { T: +tm[1], D, type, label: c.replace(/\s+/g, ' ').slice(0, 60) };
  const nm = c.match(/\bN\s*=?\s*(\d)\b/i) || c.match(/(\d)\s*(?:FL\b|FLUTES?|枚)/i) || c.match(/\bZ\s*=\s*(\d)\b/i);
  if (nm) t.N = +nm[1];
  else if (drill) t.N = 2;
  const lm = c.match(/\bL\s*=?\s*(\d+\.?\d*)/i);
  if (lm) t.fluteLen = num(lm[1]);
  const so = c.match(/\b(?:SO|STICKOUT|OH)\s*=?\s*(\d+\.?\d*)/i);
  if (so) t.stickout = num(so[1]);
  if (drill) t.drill = true;
  if (cr && type === 'flat' && num(cr[1]) > 0) t.cornerR = num(cr[1]);
  return t;
}

// opts.start: position before the first move (program coordinates); opts.homeZ: height that
// G28/G53 Z moves go to (the machine's Z home is unknown, so it is taken as a safe height)
// opts.wcs: { G54: {x,y,z}, G55: … } zero of each system in one common frame (missing ones
// coincide with G54)
// G65 argument addresses → local variables (Fanuc argument specification I)
const ARG_VAR = { A: 1, B: 2, C: 3, I: 4, J: 5, K: 6, D: 7, E: 8, F: 9, H: 11, M: 13, Q: 17, R: 18, S: 19, T: 20, U: 21, V: 22, W: 23, X: 24, Y: 25, Z: 26 };

export function parseGcode(text, opts = {}) {
  const start = opts.start || { x: 0, y: 0, z: 50 };
  const W = opts.wcs || {};
  const zeroOf = name => W[name] || W.G54 || { x: 0, y: 0, z: 0 };
  const homeZ = opts.homeZ ?? start.z;
  const st = { x: start.x, y: start.y, z: start.z, abs: true, unit: 1, motion: 0, plane: 17, perRev: false, F: 1000, S: 10000, spindle: false, T: null, pendingT: null, cycle: null, retractR: false, comp: null, compD: null, wcs: 'G54', local: { x: 0, y: 0, z: 0 } };
  const moves = [];
  const warnings = [];
  const meta = { tools: {}, workOffsets: new Set(), toolOrder: [] };
  const lines = text.split(/\r?\n/);
  const warn = (ln, msg) => warnings.push(`${ln + 1}行: ${msg}`);
  let noDecimal = false;
  const push = (ln, to, rapid, extra) => {
    const from = { x: st.x, y: st.y, z: st.z };
    if (to.x === from.x && to.y === from.y && to.z === from.z && !extra?.arc) return;
    const mv = { rapid, from, to: { ...to }, F: st.F, S: st.S, spindle: st.spindle, line: ln + 1, tool: st.T, comp: st.comp, compD: st.compD, wcs: st.wcs, local: st.local, ...extra };
    if (!st.spindle && !rapid) warn(ln, '主軸停止中の切削送り');
    moves.push(mv);
    st.x = to.x; st.y = to.y; st.z = to.z;
  };
  // subprograms (Fanuc): O-number labels, M98 P… L… calls them, M99 returns
  const labels = new Map();
  lines.forEach((l, i) => { const m = l.replace(/\([^)]*\)/g, '').trim().toUpperCase().match(/^[O:]\s*0*(\d+)/); if (m && !labels.has(+m[1])) labels.set(+m[1], i); });
  const calls = [];
  // custom macro: variables, N-number jump targets, WHILE loops by DO number
  const clean = l => { let c = l.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase().trim(); if (c.startsWith('/')) c = c.slice(1).trim(); return c; };
  const vars = new Map(Object.entries(opts.vars || {}).map(([k, v]) => [+k, v]));
  const nLabels = new Map(), loops = new Map();
  lines.forEach((l, i) => { const m = clean(l).match(/^N\s*(\d+)/); if (m && !nLabels.has(+m[1])) nLabels.set(+m[1], i); });
  let executed = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    if (++executed > 2e6) { warn(ln, 'サブプログラムの呼び出しが多すぎるため打ち切り'); break; }
    const raw = lines[ln];
    for (const cm of raw.matchAll(/\(([^)]*)\)/g)) {
      const body = cm[1];
      const stock = body.match(/^\s*STOCK\s+(CYL\S*\s+)?([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?\s*$/i);
      if (stock) meta.stock = stock[1] ? { type: 'cyl', d: +stock[2], h: +stock[3] } : { type: 'box', w: +stock[2], l: +stock[3], h: +stock[4] };
      const tool = parseToolComment(body);
      if (tool && !meta.tools[tool.T]) meta.tools[tool.T] = tool;
    }
    let line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase().trim();
    if (line.startsWith('/')) line = line.slice(1); // block delete switch assumed off
    if (!line || line.startsWith('%')) continue;
    if (/[#[\]]/.test(line) || /^(N\s*\d+\s*)?(IF\s*\[|GOTO|WHILE\s*\[|END\s*\d)/.test(line)) {
      // custom macro: statements change the variables or the flow; other blocks get their values
      try {
        const r = macroStatement(line, vars);
        if (r) {
          if (r.goto !== undefined) {
            const at = nLabels.get(r.goto);
            if (at === undefined) { warn(ln, `GOTO ${r.goto} の飛び先 N${r.goto} がありません (ここで終了)`); break; }
            ln = at - 1;
          } else if (r.whileFalse !== undefined) {
            // past the matching END
            const m = r.whileFalse, open = new RegExp(`^(N\\s*\\d+\\s*)?WHILE\\b.*\\bDO\\s*${m}$`), close = new RegExp(`^(N\\s*\\d+\\s*)?END\\s*${m}$`);
            let d = 0, j = ln + 1;
            for (; j < lines.length; j++) { const L = clean(lines[j]); if (open.test(L)) d++; else if (close.test(L)) { if (!d) break; d--; } }
            ln = j;
          } else if (r.loopStart !== undefined) loops.set(r.loopStart, ln);
          else if (r.loopEnd !== undefined) { const at = loops.get(r.loopEnd); if (at !== undefined) ln = at - 1; }
          continue;
        }
        line = substitute(line, vars);
      } catch (err) { warn(ln, `マクロ: ${err.message} (この行は無視)`); continue; }
    }
    if (/^G\s*0*65(?!\d)/.test(line)) {
      // G65 P<program> L<times> <arguments>: a subprogram with its own local variables #1–#33,
      // the arguments set by address (A → #1, B → #2, … Z → #26)
      const args = {};
      for (const m of line.slice(line.search(/65/) + 2).matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) args[m[1]] = parseFloat(m[2]);
      const at = args.P === undefined ? undefined : labels.get(Math.round(args.P));
      if (at === undefined) { warn(ln, `G65 のマクロ O${args.P ?? '?'} が見つかりません (この呼び出しは無視)`); continue; }
      if (calls.length >= 8) { warn(ln, 'マクロ呼び出しの入れ子が深すぎます (8 段まで)'); continue; }
      const saved = [];
      for (let n = 1; n <= 33; n++) { saved.push(vars.get(n)); vars.delete(n); }
      for (const [k, v] of Object.entries(args)) if (ARG_VAR[k]) vars.set(ARG_VAR[k], v);
      calls.push({ ret: ln, left: Math.max(1, Math.round(args.L ?? 1)) - 1, start: at, locals: saved, args });
      ln = at;
      continue;
    }
    const words = [...line.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)].map(m => [m[1], parseFloat(m[2]), m[2]]);
    if (!words.length) continue;
    const w = {};
    let hasMotionWord = false, home = false, cycleWord = false, m6 = false, end = false, newWcs = null, local = false, sub = null;
    for (const [k, v, s] of words) {
      if (k === 'G') {
        if ([0, 1, 2, 3].includes(v)) { st.motion = v; hasMotionWord = true; st.cycle = null; }
        else if (v === 17 || v === 18 || v === 19) st.plane = v;
        else if (v === 20) st.unit = 25.4;
        else if (v === 21) st.unit = 1;
        else if (v === 90) st.abs = true;
        else if (v === 91) st.abs = false;
        else if (v === 94) st.perRev = false;
        else if (v === 95) st.perRev = true;
        else if (v === 98) st.retractR = false;
        else if (v === 99) st.retractR = true;
        else if (v === 28 || v === 53 || v === 30) home = true;
        else if (v === 80) st.cycle = null;
        else if (CYCLES.has(v)) {
          if (v === 74 || v === 76 || v === 87 || v === 88) warn(ln, `固定サイクル G${v} は G81 として扱います`);
          st.cycle = { g: v, initZ: st.cycle ? st.cycle.initZ : st.z, R: st.cycle?.R, Z: st.cycle?.Z, Q: st.cycle?.Q, P: st.cycle?.P };
          cycleWord = true;
        }
        else if (v >= 54 && v <= 59 && Number.isInteger(v)) newWcs = `G${v}`;
        else if (Math.abs(v - 54.1) < 1e-6) newWcs = 'G54.1';
        else if (v === 52) local = true;
        else if (v === 41 || v === 42) { if (st.plane !== 17) warn(ln, `工具径補正 G${v} は G17 平面のみ対応`); else st.comp = v; }
        else if (v === 40) st.comp = null;
        else if (v === 68 || v === 51 || v === 16) warn(ln, `座標変換 G${v} は未対応`);
        else if (v === 4 || v === 10 || v === 65) { /* dwell, data setting, macro call: no motion */ }
        else if (!IGNORED_G.has(v)) warn(ln, `G${v} は無視`);
      } else if (k === 'M') {
        if (v === 3 || v === 4) st.spindle = true;
        else if (v === 5) st.spindle = false;
        else if (v === 6) m6 = true;
        else if (v === 98) sub = 'call';
        else if (v === 99) sub = 'return';
        else if (v === 30 || v === 2) end = true;
      } else if (k === 'T') st.pendingT = v;
      else {
        w[k] = v;
        if ('XYZ'.includes(k) && !s.includes('.') && Math.abs(v) >= 1000) noDecimal = true;
      }
    }
    if (newWcs) {
      // G54.1 P n: the extended systems; the P word belongs to it on this block
      if (newWcs === 'G54.1') { newWcs = w.P !== undefined ? `G54.1P${Math.round(w.P)}` : 'G54.1P1'; delete w.P; }
      if (newWcs !== st.wcs) {
        // the tool stays where it is: express its position in the new system
        const a = zeroOf(st.wcs), b = zeroOf(newWcs);
        st.x += a.x - b.x; st.y += a.y - b.y; st.z += a.z - b.z;
        st.wcs = newWcs;
      }
      meta.workOffsets.add(newWcs);
    }
    if (local) {
      // G52: local zero inside the current system (absolute shift; G52 X0 Y0 Z0 cancels)
      const u0 = st.unit, nl = { x: w.X !== undefined ? w.X * u0 : st.local.x, y: w.Y !== undefined ? w.Y * u0 : st.local.y, z: w.Z !== undefined ? w.Z * u0 : st.local.z };
      st.x -= nl.x - st.local.x; st.y -= nl.y - st.local.y; st.z -= nl.z - st.local.z;
      st.local = nl;
      delete w.X; delete w.Y; delete w.Z;
      meta.localShift = true;
    }
    if (m6 && st.pendingT !== null) {
      st.T = st.pendingT;
      if (!meta.toolOrder.includes(st.T)) meta.toolOrder.push(st.T);
    }
    if (w.D !== undefined) st.compD = w.D;
    if (w.F !== undefined) st.F = w.F * st.unit;
    if (w.S !== undefined) st.S = w.S;
    const feed = () => st.perRev ? st.F * st.S : st.F;
    const u = st.unit;
    const hasAxis = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;
    const target = () => ({
      x: w.X === undefined ? st.x : (st.abs ? w.X * u : st.x + w.X * u),
      y: w.Y === undefined ? st.y : (st.abs ? w.Y * u : st.y + w.Y * u),
      z: w.Z === undefined ? st.z : (st.abs ? w.Z * u : st.z + w.Z * u),
    });
    const F0 = st.F; st.F = feed();
    if (home) {
      // G28/G30/G53: only the Z part is meaningful without the machine's coordinate system
      if (w.Z !== undefined) push(ln, { x: st.x, y: st.y, z: homeZ + zeroOf('G54').z - zeroOf(st.wcs).z - st.local.z }, true);
      if (w.X !== undefined || w.Y !== undefined) warn(ln, '原点復帰の X/Y は無視 (機械座標が不明なため)');
    } else if (st.cycle && (cycleWord || hasAxis || w.R !== undefined)) {
      runCycle(ln, w, u);
    } else if (hasAxis || (hasMotionWord && (w.I !== undefined || w.J !== undefined || w.K !== undefined))) {
      const to = target();
      const extra = {};
      if (st.motion === 2 || st.motion === 3) {
        const arc = arcCentre(ln, to, w, u);
        if (arc) extra.arc = arc; else { st.F = F0; continue; }
      }
      push(ln, to, st.motion === 0, extra);
    }
    st.F = F0;
    if (end) break;
    if (sub === 'call') {
      // M98 P<program> L<times>, or the packed P<times><program 4 digits> of later controls
      let P = w.P, L = w.L ?? 1;
      if (P !== undefined && w.L === undefined && P >= 10000) { L = Math.floor(P / 10000); P %= 10000; }
      const at = P === undefined ? undefined : labels.get(Math.round(P));
      if (at === undefined) warn(ln, `サブプログラム O${P ?? '?'} が見つかりません (この呼び出しは無視)`);
      else if (calls.length >= 8) warn(ln, 'サブプログラムの入れ子が深すぎます (8 段まで)');
      else if (L >= 1) { calls.push({ ret: ln, left: Math.round(L) - 1, start: at }); ln = at; }
    } else if (sub === 'return') {
      const c = calls[calls.length - 1];
      if (!c) break; // M99 in the main program: the end (its loop back to the start is not run)
      if (c.left > 0) {
        c.left--; ln = c.start;
        if (c.locals) { for (let n = 1; n <= 33; n++) vars.delete(n); for (const [k, v] of Object.entries(c.args)) if (ARG_VAR[k]) vars.set(ARG_VAR[k], v); }
      } else {
        calls.pop(); ln = c.ret;
        // a G65 call gives the caller its local variables back
        if (c.locals) c.locals.forEach((v, i) => (v === undefined ? vars.delete(i + 1) : vars.set(i + 1, v)));
      }
    }
  }
  if (noDecimal) warnings.push('小数点のない座標値を mm として扱いました (最小設定単位 0.001 mm の機械では値が1000倍になります)');
  const unset = [...meta.workOffsets].filter(n => n !== 'G54' && !W[n]);
  if (unset.length) warnings.push(`ワーク座標系 ${unset.join(' ')} の原点が未設定のため G54 と同じ位置として扱います (プログラムタブで設定できます)`);
  const undefinedTools = meta.toolOrder.filter(t => !meta.tools[t]);
  if (undefinedTools.length && Object.keys(meta.tools).length) warnings.push(`工具 ${undefinedTools.map(t => 'T' + t).join(' ')} の寸法がコメントに無いため「加工条件」の工具で計算します`);
  meta.workOffsets = [...meta.workOffsets];
  return { moves, warnings: [...new Set(warnings)].slice(0, 40), meta };

  function arcCentre(ln, to, w, u) {
    const [a, b] = PLANES[st.plane];
    const from = { x: st.x, y: st.y, z: st.z };
    const cw = st.motion === 2;
    if (w.R !== undefined) {
      const r = w.R * u, da = to[a] - from[a], db = to[b] - from[b], d = Math.hypot(da, db);
      if (d < 1e-9 || d > 2 * Math.abs(r) + 1e-6) { warn(ln, '円弧Rが不正'); return null; }
      const hgt = Math.sqrt(Math.max(0, r * r - d * d / 4));
      // left of chord for (CCW, R>0) or (CW, R<0)
      const sgn = (!cw === (r > 0)) ? 1 : -1;
      return { axes: PLANES[st.plane], ca: from[a] + da / 2 - sgn * hgt * db / d, cb: from[b] + db / 2 + sgn * hgt * da / d, cw };
    }
    return { axes: PLANES[st.plane], ca: from[a] + (w[CENTRE[a]] || 0) * u, cb: from[b] + (w[CENTRE[b]] || 0) * u, cw };
  }

  // drilling cycles are expanded into plain moves along Z (G17 only)
  function runCycle(ln, w, u) {
    const c = st.cycle;
    if (st.plane !== 17) { warn(ln, '固定サイクルは G17 平面のみ対応'); return; }
    if (w.R !== undefined) c.R = st.abs ? w.R * u : c.initZ + w.R * u;
    if (w.Q !== undefined) c.Q = Math.abs(w.Q * u);
    if (w.P !== undefined) c.P = w.P;
    if (w.Z !== undefined) c.Z = st.abs ? w.Z * u : (c.R ?? c.initZ) + w.Z * u;
    if (c.R === undefined) c.R = c.initZ;
    if (c.Z === undefined) { warn(ln, '固定サイクルの穴底 Z がありません'); return; }
    const reps = Math.max(1, Math.round(w.K ?? w.L ?? 1));
    for (let r = 0; r < reps; r++) {
      const x = w.X === undefined ? st.x : (st.abs ? w.X * u : st.x + w.X * u);
      const y = w.Y === undefined ? st.y : (st.abs ? w.Y * u : st.y + w.Y * u);
      push(ln, { x, y, z: st.z }, true);
      push(ln, { x, y, z: c.R }, true);
      const g = c.g, q = c.Q > 0 && (g === 83 || g === 73) ? c.Q : 0;
      if (q) {
        let depth = c.R;
        while (depth > c.Z + 1e-9) {
          const next = Math.max(c.Z, depth - q);
          if (depth < c.R) push(ln, { x, y, z: g === 83 ? depth + PECK_CLEAR : depth }, true);
          push(ln, { x, y, z: next }, false);
          if (next > c.Z) push(ln, { x, y, z: g === 83 ? c.R : next + PECK_CLEAR }, true);
          depth = next;
        }
      } else push(ln, { x, y, z: c.Z }, false);
      const outFeed = g === 84 || g === 85 || g === 89 || g === 74;
      push(ln, { x, y, z: c.R }, !outFeed);
      if (!st.retractR) push(ln, { x, y, z: c.initZ }, true);
      if (st.abs) break; // repeats only make sense with incremental X/Y
    }
  }
}

const CHORD_TOL = 0.001; // largest chord error of an arc [mm]

// Convert moves into a polyline. Each point carries the attributes of the segment ending at it.
export function discretize(moves, maxSeg = 0.5) {
  if (!moves.length) return [];
  const pts = [{ ...moves[0].from, rapid: true, F: moves[0].F, S: moves[0].S, line: moves[0].line, tool: moves[0].tool, wcs: moves[0].wcs, local: moves[0].local }];
  for (const mv of moves) {
    const attr = { rapid: mv.rapid, F: mv.F, S: mv.S, line: mv.line, tool: mv.tool, wcs: mv.wcs, local: mv.local };
    if (mv.arc) {
      const { ca, cb, cw } = mv.arc;
      const [a, b, n] = mv.arc.axes || ['x', 'y', 'z'];
      const r = Math.hypot(mv.from[a] - ca, mv.from[b] - cb);
      const a0 = Math.atan2(mv.from[b] - cb, mv.from[a] - ca);
      const a1 = Math.atan2(mv.to[b] - cb, mv.to[a] - ca);
      let sweep = a1 - a0;
      if (mv.arc.sweep !== undefined) sweep = mv.arc.sweep; // set by cutter compensation (a trimmed arc may be tiny)
      else if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
      else if (sweep <= 1e-9) sweep += 2 * Math.PI;
      // chords no longer than maxSeg and no more than CHORD_TOL inside the arc (a control follows
      // the true arc; coarse chords would cut into an outside corner by their sagitta)
      const dAng = 2 * Math.acos(Math.max(-1, 1 - CHORD_TOL / Math.max(r, CHORD_TOL)));
      const segs = Math.max(Math.abs(sweep) * r < 1e-9 ? 1 : 2, Math.ceil(Math.abs(sweep) * r / maxSeg), Math.ceil(Math.abs(sweep) / dAng));
      for (let i = 1; i <= segs; i++) {
        const ang = a0 + sweep * i / segs;
        const p = { [a]: ca + r * Math.cos(ang), [b]: cb + r * Math.sin(ang), [n]: mv.from[n] + (mv.to[n] - mv.from[n]) * i / segs };
        pts.push({ x: p.x, y: p.y, z: p.z, ...attr });
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

// Text from a file: CNC programs from Japanese controls and CAM are often Shift_JIS
export function decodeText(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder('shift_jis').decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); } }
}
