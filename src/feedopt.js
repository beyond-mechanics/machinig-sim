// Feed optimisation from the machining report: each cutting line gets the feed at which its
// peak cutting force reaches a target, so light cuts (thin finishing passes, air-heavy corners)
// run faster and overloaded ones slow down, as force-based feed-rate optimisers do.
// The force of a line at feed factor k follows the simulator's own force law per unit width,
//   F(k)/F(1) = g(k·h)/g(h),  g(h) = Ktc·(h₀/h)^mc·h + Kte
// with h the line's mean chip thickness (the edge term does not scale with feed, so a light cut
// needs more than proportional feed to load the tool). Lines that chattered keep their feed at
// most (chatter is set by the depth of cut, and a higher feed only adds forced vibration); the
// tool-stress limit caps the force too (the stress scales with the force).
// The program is rewritten by scaling the F words: a cutting line whose feed changes gets an F
// word, and the next line that should run at the original feed gets it back (F is modal).

const H_REF = 0.05, H_MIN = 0.002;

export function forceRatio(mat, h, k, nonlinear = true) {
  const mc = nonlinear ? (mat.mc ?? 0) : 0;
  const g = x => { const hh = Math.max(x, H_MIN); return mat.Ktc * (mc ? Math.pow(H_REF / hh, mc) : 1) * hh + mat.Kte; };
  return g(k * h) / g(h);
}

// report: LineReport; opts: { Ftarget [N], maxUp, maxDown, stressLimit [MPa], nonlinear,
// air: { lines: Set of feed-move lines, k, Fmax [mm/min], F: line → feed } to speed up feed moves
// that cut nothing (approaches, links in the air) }
// Returns { lines: Map(line → {k, F0, F1, why}), time0, time1 }
export function optimizeFeeds(report, mat, opts) {
  const { Ftarget, maxUp = 1.5, maxDown = 0.5, stressLimit = Infinity, nonlinear = true, air = null } = opts;
  const lines = new Map();
  let time0 = 0, time1 = 0;
  for (const r of report.lines.values()) {
    time0 += r.t;
    if (air && !(r.cut > 0) && air.lines.has(r.line) && r.t > 0) {
      // a feed move that never touched the material: faster, up to the air-feed limit
      const F = air.F(r.line), k = Math.round(Math.max(1, Math.min(air.k, F > 0 ? air.Fmax / F : air.k)) * 100) / 100;
      if (k > 1) { lines.set(r.line, { k, F0: 0, F1: 0, why: '空送り' }); time1 += r.t / k; continue; }
    }
    if (!(r.cut > 0) || !(r.F > 1) || !(r.h > 0)) { time1 += r.t; continue; }
    // the force this line may reach: the target, and the stress limit scaled back to a force
    let Fmax = Ftarget;
    if (r.stress > 0 && Number.isFinite(stressLimit)) Fmax = Math.min(Fmax, r.F * stressLimit / r.stress);
    let hiK = maxUp, why = '';
    if (r.chatter > 0) { hiK = Math.min(hiK, 1); why = 'びびり (送りは上げない)'; }
    const F = k => r.F * forceRatio(mat, r.h, k, nonlinear);
    let k;
    if (F(hiK) <= Fmax) { k = hiK; if (!why) why = hiK === maxUp ? '上限まで' : ''; }
    else if (F(maxDown) >= Fmax) { k = maxDown; why = why || '下限 (目標を超える)'; }
    else {
      let a = maxDown, b = hiK;
      for (let it = 0; it < 40; it++) { const m = 0.5 * (a + b); if (F(m) > Fmax) b = m; else a = m; }
      k = a;
    }
    k = Math.round(k * 100) / 100;
    if (Math.abs(k - 1) < 0.02) k = 1;
    // the feed moves of the line take 1/k of their time (rapids and dwell are not scaled)
    time1 += r.t - r.cut + r.cut / k;
    lines.set(r.line, { k, F0: r.F, F1: F(k), why });
  }
  return { lines, time0, time1 };
}

// default target: the heaviest line that cut cleanly (a chatter peak is no force to aim at)
export function defaultTarget(report) {
  let best = 0, any = 0;
  for (const r of report.lines.values()) {
    if (!(r.cut > 0)) continue;
    any = Math.max(any, r.F);
    if (!(r.chatter > 0)) best = Math.max(best, r.F);
  }
  return best || any;
}

const stripComments = s => s.replace(/\([^)]*\)/g, '').replace(/;.*/, '');
const fmt = v => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(Math.abs(v) < 10 ? 3 : 1).replace(/\.?0+$/, ''));

// text: the program; feedLines: Set of line numbers (1-based) that make feed moves;
// factor: line → k. Returns the rewritten program text.
// The modal F is followed in text order. Where the order the control runs the blocks in differs
// (calls M98 G65, returns M99, jumps GOTO WHILE END, the start of an O block) the programmed feed is
// put back first, on a block of its own, and nothing is assumed about the feed after it.
const FLOW = /^(N\s*\d+\s*)?(IF\s*\[|GOTO|WHILE\s*\[|END\s*\d|[O:]\s*\d)|\bM\s*0*9[89](?!\d)|\bG\s*0*65(?!\d)/i;
export function rewriteFeeds(text, feedLines, factor) {
  const src = text.split('\n'), out = [];
  let progF = null, outF = null;   // modal F as programmed and as written out
  const restore = () => { if (progF !== null && outF !== null && Math.abs(outF - progF) > 1e-9) out.push(`F${fmt(progF)}`); outF = progF; };
  src.forEach((line, i) => {
    const n = i + 1, code = stripComments(line), m = code.match(/F\s*([-+]?(?:\d+\.?\d*|\.\d+))/i); // F100, F100., F.5
    const flow = FLOW.test(code.trim());
    if (flow) { restore(); out.push(line); progF = outF = null; return; }
    // other macro blocks (F[#3], #1 = …, X#1) are left as they are: the programmed feed comes back
    // before them, and after an F of their own (F#3) the feed is unknown
    if (/[#[]/.test(code)) {
      restore(); out.push(line);
      if (/F\s*[#[]/i.test(code)) progF = outF = null; else if (m) progF = outF = +m[1];
      return;
    }
    if (m) progF = +m[1];
    if (!feedLines.has(n) || progF === null) {
      if (m) outF = progF;
      out.push(line);
      return;
    }
    const want = progF * (factor.get(n) ?? 1);
    // nothing to write: the modal feed is already right and the line's own F (if any) says so
    if (outF !== null && Math.abs(want - outF) < 1e-9 && (!m || Math.abs(progF - want) < 1e-9)) { out.push(line); return; }
    outF = want;
    if (m) {
      // replace the F word in the code part (keep comments as they are)
      const idx = line.search(new RegExp(`F\\s*${m[1].replace(/[.+]/g, '\\$&')}`, 'i'));
      out.push(idx >= 0 ? line.slice(0, idx) + 'F' + fmt(want) + line.slice(idx + m[0].length) : line + ` F${fmt(want)}`);
    } else {
      // append before a trailing comment
      const c = line.search(/[;(]/);
      out.push(c >= 0 ? `${line.slice(0, c).trimEnd()} F${fmt(want)} ${line.slice(c)}` : `${line.trimEnd()} F${fmt(want)}`);
    }
  });
  return out.join('\n');
}

// Spindle speed against chatter: one speed factor q for the whole program, chosen so that the
// worst line, max over lines of ap / a_lim(q·S_line) for its engagement, is as small as possible
// (a stable pocket shared by the lines that matter). lines: [{ap, S, lim(S) → a_lim}],
// q in [qMin, qMax], speeds capped at sMax. Returns { q, worst0, worst } (worst < 1: all stable).
export function optimizeSpindle(lines, { qMin = 0.75, qMax = 1.25, sMax = 30000, sMin = 2000, step = 0.005 } = {}) {
  const worst = q => {
    // lines outside the spindle range at this factor (a slow drilling cycle) are left out
    let w = 0, n = 0;
    for (const l of lines) { const S = q * l.S; if (S > sMax || S < sMin) continue; n++; const a = l.lim(S); w = Math.max(w, a > 0 ? l.ap / a : Infinity); }
    return n ? w : Infinity;
  };
  const w0 = worst(1);
  let best = 1, bw = w0;
  for (let q = qMin; q <= qMax + 1e-9; q += step) { const w = worst(q); if (w < bw - 1e-9) { bw = w; best = q; } }
  return { q: Math.round(best * 1000) / 1000, worst0: w0, worst: bw };
}

// S words scaled by q, and the F words by the same q so the feed per tooth stays (not under G95,
// where F is already per revolution): returns text
export function rewriteSpindle(text, q) {
  let perRev = false;
  return text.split('\n').map(line => {
    // code between the comments: (…) anywhere on the line, ; to its end
    const parts = line.split(/(\([^)]*\)|;.*$)/);
    for (let i = 0; i < parts.length; i += 2) {
      if (/[#[]/.test(parts[i])) continue; // macro: S#1, F[…] are left as they are
      const g = parts[i].match(/G\s*0*9([45])(?!\d)/i);
      if (g) perRev = g[1] === '5';
      parts[i] = parts[i].replace(/([SF])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi, (m, w, v) => (w.toUpperCase() === 'S' ? `${w}${Math.round(+v * q)}` : perRev ? m : `${w}${fmt(+v * q)}`));
    }
    return parts.join('');
  }).join('\n');
}
