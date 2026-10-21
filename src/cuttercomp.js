// Cutter radius compensation (G41 left / G42 right of the direction of travel, G40 cancel) in
// the G17 plane. The programmed contour is offset by the tool radius: an inside corner trims
// both offset elements to their intersection, an outside corner goes round the programmed
// corner on an arc of the tool radius. The block that switches compensation on moves to the
// offset start of the first contour element; the G40 block leaves the offset path for its
// programmed (uncompensated) end point. Z-only blocks inside the compensated stretch stay at
// the current offset point.

const EPS = 1e-9;

// moves: parser output with mv.comp (41 | 42 | null). radiusOf(mv): offset [mm] for that move.
// Returns { moves, warnings }.
export function applyCutterComp(moves, radiusOf) {
  const out = [], warnings = [];
  const warn = (mv, msg) => warnings.push(`${mv.line}行: ${msg}`);
  let i = 0;
  while (i < moves.length) {
    if (!moves[i].comp) { out.push(moves[i]); i++; continue; }
    // a compensated stretch: startup block, compensated blocks, then the cancel block (if any)
    const start = i;
    let end = i;
    while (end + 1 < moves.length && moves[end + 1].comp) end++;
    const cancel = end + 1 < moves.length ? moves[end + 1] : null;
    const run = moves.slice(start, end + 1);
    const res = compensate(run, cancel, radiusOf, warn);
    out.push(...res);
    i = cancel ? end + 2 : end + 1;
  }
  return { moves: out, warnings };
}

function compensate(run, cancel, radiusOf, warn) {
  const m0 = run[0];
  const s = m0.comp === 41 ? 1 : -1;
  const r = radiusOf(m0);
  if (m0.arc && m0.arc.axes && m0.arc.axes[2] !== 'z') { warn(m0, '工具径補正は G17 平面のみ対応 (補正なしで扱います)'); return cancel ? [...run, cancel] : run; }
  // contour elements: the compensated blocks after the startup block that move in XY
  const elems = [];
  for (let k = 1; k < run.length; k++) {
    const mv = run[k];
    const dxy = Math.hypot(mv.to.x - mv.from.x, mv.to.y - mv.from.y);
    if (!mv.arc && dxy < 1e-7) continue;
    if (mv.arc && mv.arc.axes && mv.arc.axes[2] !== 'z') { warn(mv, '工具径補正中の G18/G19 円弧は補正なしで扱います'); continue; }
    elems.push(element(mv, k));
  }
  if (!elems.length) {
    warn(m0, '工具径補正の区間に XY の移動がありません');
    return cancel ? [...run, cancel] : run;
  }
  // offset every element, then settle each corner
  const off = elems.map(e => offsetElement(e, s, r, warn));
  const joins = []; // joins[q]: extra moves between element q and q+1
  for (let q = 0; q + 1 < elems.length; q++) joins.push(corner(elems[q], elems[q + 1], off[q], off[q + 1], s, r, warn));

  const result = [];
  let cur = { ...m0.from };
  const emit = (mv, to, arc) => {
    const o = { ...mv, from: { ...cur }, to: { ...to } };
    if (arc) o.arc = arc; else delete o.arc;
    result.push(o); cur = { ...to };
  };
  // startup: from the uncompensated position to the offset start of the first element
  const first = off[0];
  emit(m0, { x: first.a.x, y: first.a.y, z: m0.to.z });
  let e = 0;
  for (let k = 1; k < run.length; k++) {
    const mv = run[k];
    if (e < elems.length && elems[e].k === k) {
      const o = off[e];
      if (Math.hypot(o.a.x - cur.x, o.a.y - cur.y) > 1e-7) emit(mv, { x: o.a.x, y: o.a.y, z: mv.from.z }); // gap left by a trimmed corner
      if (o.type === 'arc') emit(mv, { x: o.b.x, y: o.b.y, z: mv.to.z }, o.R > EPS ? { axes: ['x', 'y', 'z'], ca: o.c.x, cb: o.c.y, cw: o.cw, sweep: o.sweep } : null);
      else emit(mv, { x: o.b.x, y: o.b.y, z: mv.to.z });
      if (e < joins.length) for (const j of joins[e]) emit(mv, { x: j.to.x, y: j.to.y, z: mv.to.z }, j.arc);
      e++;
    } else {
      // Z-only (or skipped) block: stays on the offset point
      emit(mv, { x: cur.x, y: cur.y, z: mv.to.z });
    }
  }
  if (cancel) emit(cancel, { ...cancel.to });
  return result;
}

function element(mv, k) {
  const a = { x: mv.from.x, y: mv.from.y }, b = { x: mv.to.x, y: mv.to.y };
  if (!mv.arc) return { type: 'line', a, b, k, mv };
  const c = { x: mv.arc.ca, y: mv.arc.cb }, R = Math.hypot(a.x - c.x, a.y - c.y);
  return { type: 'arc', a, b, c, R, cw: mv.arc.cw, sweep: sweepOf(a, b, c, mv.arc.cw), k, mv };
}

// signed sweep the same way the discretizer reads an arc (a full circle when the ends meet)
function sweepOf(a, b, c, cw) {
  let sw = Math.atan2(b.y - c.y, b.x - c.x) - Math.atan2(a.y - c.y, a.x - c.x);
  if (cw) { if (sw >= -1e-9) sw -= 2 * Math.PI; } else if (sw <= 1e-9) sw += 2 * Math.PI;
  return sw;
}

// unit tangent of an element at its start (at = 0) or end (at = 1)
function tangent(e, at) {
  if (e.type === 'line') { const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, L = Math.hypot(dx, dy) || 1; return { x: dx / L, y: dy / L }; }
  const p = at ? e.b : e.a, ux = (p.x - e.c.x) / e.R, uy = (p.y - e.c.y) / e.R;
  return e.cw ? { x: uy, y: -ux } : { x: -uy, y: ux };
}
const leftOf = t => ({ x: -t.y, y: t.x });

function offsetElement(e, s, r, warn) {
  if (e.type === 'line') {
    const n = leftOf(tangent(e, 0));
    return { type: 'line', a: { x: e.a.x + s * r * n.x, y: e.a.y + s * r * n.y }, b: { x: e.b.x + s * r * n.x, y: e.b.y + s * r * n.y } };
  }
  // left of a CCW arc is towards the centre
  let R = e.R + (e.cw ? s * r : -s * r);
  if (R <= 1e-6) { warn(e.mv, `円弧の半径 ${e.R.toFixed(3)} mm が工具半径以下のため、補正後の円弧がつぶれます (削り過ぎ)`); R = 0; }
  const at = p => ({ x: e.c.x + (p.x - e.c.x) * R / e.R, y: e.c.y + (p.y - e.c.y) * R / e.R });
  return { type: 'arc', a: at(e.a), b: at(e.b), c: e.c, R, cw: e.cw, sweep: e.sweep };
}

// moves that connect offset element o1 to o2 at the programmed corner P; trims o1/o2 in place
function corner(e1, e2, o1, o2, s, r, warn) {
  const t1 = tangent(e1, 1), t2 = tangent(e2, 0);
  const cross = t1.x * t2.y - t1.y * t2.x, dot = t1.x * t2.x + t1.y * t2.y;
  const P = e1.b;
  if (Math.abs(cross) < 1e-9 && dot > 0) return []; // tangent: the offset elements already meet
  const reversal = Math.abs(cross) < 1e-9;
  if (!reversal && s * cross > 0) {
    // inside corner: meet at the intersection of the offset elements nearest the corner
    const X = intersect(o1, o2, P);
    if (!X) { warn(e2.mv, '工具径補正: 内側の角で補正経路が交わりません (工具が入らない形状)'); return [{ to: o2.a }]; }
    const endOk = trimEnd(o1, X), startOk = trimStart(o2, X);
    if (!endOk || !startOk) warn(e2.mv, '工具径補正: 要素が工具半径より短く、補正経路が要素を食い越します (削り過ぎの恐れ)');
    return [];
  }
  // outside corner (or a full reversal): round the programmed corner at the tool radius
  const cw = reversal ? s > 0 : cross < 0;
  const sweep = sweepOf(o1.b, o2.a, P, cw);
  return [{ to: o2.a, arc: { axes: ['x', 'y', 'z'], ca: P.x, cb: P.y, cw, sweep } }];
}

function trimEnd(o, X) {
  if (o.type === 'line') {
    const L2 = (o.b.x - o.a.x) ** 2 + (o.b.y - o.a.y) ** 2, t = L2 > 0 ? ((X.x - o.a.x) * (o.b.x - o.a.x) + (X.y - o.a.y) * (o.b.y - o.a.y)) / L2 : 0;
    o.b = { ...X };
    return t >= -1e-9;
  }
  if (o.R <= EPS) return false;
  const sw = sweepOf(o.a, X, o.c, o.cw);
  const ok = Math.abs(sw) <= Math.abs(o.sweep) + 1e-7;
  o.b = { ...X }; o.sweep = ok ? sw : 0;
  if (!ok) o.b = { ...o.a };
  return ok;
}
function trimStart(o, X) {
  if (o.type === 'line') {
    const L2 = (o.b.x - o.a.x) ** 2 + (o.b.y - o.a.y) ** 2, t = L2 > 0 ? ((X.x - o.a.x) * (o.b.x - o.a.x) + (X.y - o.a.y) * (o.b.y - o.a.y)) / L2 : 0;
    o.a = { ...X };
    return t <= 1 + 1e-9;
  }
  if (o.R <= EPS) return false;
  const sw = sweepOf(X, o.b, o.c, o.cw);
  const ok = Math.abs(sw) <= Math.abs(o.sweep) + 1e-7;
  o.a = { ...X }; o.sweep = ok ? sw : 0;
  if (!ok) o.a = { ...o.b };
  return ok;
}

// intersection of two offset elements (lines as infinite lines, arcs as full circles) nearest P
function intersect(o1, o2, P) {
  const cands = [];
  if (o1.type === 'line' && o2.type === 'line') {
    const d1 = { x: o1.b.x - o1.a.x, y: o1.b.y - o1.a.y }, d2 = { x: o2.b.x - o2.a.x, y: o2.b.y - o2.a.y };
    const den = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((o2.a.x - o1.a.x) * d2.y - (o2.a.y - o1.a.y) * d2.x) / den;
    return { x: o1.a.x + t * d1.x, y: o1.a.y + t * d1.y };
  }
  if (o1.type === 'line') cands.push(...lineCircle(o1, o2));
  else if (o2.type === 'line') cands.push(...lineCircle(o2, o1));
  else cands.push(...circleCircle(o1, o2));
  let best = null, bd = Infinity;
  for (const X of cands) { const d = Math.hypot(X.x - P.x, X.y - P.y); if (d < bd) { bd = d; best = X; } }
  return best;
}
function lineCircle(l, c) {
  if (c.R <= EPS) return [];
  const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, fx = l.a.x - c.c.x, fy = l.a.y - c.c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - c.R * c.R;
  const D = B * B - 4 * A * C;
  if (A < 1e-18 || D < -1e-12) return [];
  const sq = Math.sqrt(Math.max(0, D));
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].map(t => ({ x: l.a.x + t * dx, y: l.a.y + t * dy }));
}
function circleCircle(p, q) {
  if (p.R <= EPS || q.R <= EPS) return [];
  const dx = q.c.x - p.c.x, dy = q.c.y - p.c.y, d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > p.R + q.R + 1e-9 || d < Math.abs(p.R - q.R) - 1e-9) return [];
  const a = (p.R * p.R - q.R * q.R + d * d) / (2 * d), h = Math.sqrt(Math.max(0, p.R * p.R - a * a));
  const mx = p.c.x + a * dx / d, my = p.c.y + a * dy / d;
  return [{ x: mx + h * dy / d, y: my - h * dx / d }, { x: mx - h * dy / d, y: my + h * dx / d }];
}
