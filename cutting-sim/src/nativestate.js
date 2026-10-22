// Hand-over between the JS solver and the native core (native/sph-core): the state of a Cutting3D
// in STL mode as JSON (the setup stays here: filling the work, supports, the tool's distance
// field), and the binary frames the core answers with, copied back into the same Cutting3D so
// that views and summary are computed as for a run in the worker. Layout: native/sph-core/src/engine.rs.

export function dumpState(s) {
  const A = (a) => Array.from(a), c = s.cfg;
  const keys = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'rho', 'p', 'T', 'ep', 'epd', 'seq', 'sr', 'z0', 'dmg', 'fixed', 'contact', 'dead'];
  const arr = {};
  for (const k of keys) arr[k] = A(s[k]);
  arr.touched = s.touched ? A(s.touched) : new Array(s.N).fill(0);
  ['sxx', 'syy', 'szz', 'sxy', 'syz', 'sxz'].forEach((k, i) => { arr[k] = A(s.s[i]); });
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k] ?? null]));
  const pickN = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k] ?? 0]));   // numbers a mode does not use: 0
  const mode = s.meshMode ? 'mesh' : s.helix ? 'helix' : 'oblique';
  const out = {
    mode, n: s.N, steps: s.steps, t: s.t, arr,
    sc: { ...pickN(s, ['dt', 'm', 'mReal', 'G', 'K', 'rho0', 'cs', 'hk', 'ad', 'Wdx', 'epKeep', 'nSub', 'dx', 'h', 'V', 'om', 'sg', 'vf', 'ax', 'ay', 'Rt', 'ms',
      'x0', 'oy', 'tvx', 'tvz', 'nx_', 'nz_', 'ex_', 'ez_', 'lead', 'lam', 'bz', 'Lz', 'kh', 'rr']), periodic: s.periodic ? 1 : 0 },
    cfg: { ...pick(c, ['motion', 'angle', 'travel', 'mu', 'friction', 'muExp', 'heatToWork', 'beta', 'fracture', 'efScale', 'avAlpha', 'avBeta', 'T0', 'cutLen']), sleep: c.sleep !== false },
    mat: pick(s.mat, ['A', 'B', 'n', 'C', 'm', 'Tm', 'Tr', 'vc', 'rho', 'c', 'k', 'D1', 'D2', 'D3', 'D4', 'D5', 'model', 'a', 'b', 'cc', 'd']),
  };
  if (s.meshMode) {
    const t = s.msdf, en = [];
    for (const [key, v] of t.en) en.push([Math.floor(key / 4294967296), key % 4294967296, ...v]);
    out.tool = { V: A(t.V), F: A(t.F), fn: A(t.fn), vn: A(t.vn), en, bb: A(t.bb), cell: t.cell,
      nb: A(t.nb), nl: A(t.nl), nr: A(t.nr), ns: A(t.ns), nn: A(t.nn), order: A(t.order) };
  } else {
    // Cutting edge section (tool.js): the rounded wedge, or a polygon outline with its bucket grid.
    const t = s.tool, P = t.poly;
    out.wedge = { ...pick(t, ['r', 'u1x', 'u1y', 'u2x', 'u2y', 'n1x', 'n1y', 'n2x', 'n2y']),
      poly: P ? { ...pick(P, ['n', 'g', 'gu', 'gw', 'nu', 'nw']), ...Object.fromEntries(['ax', 'ay', 'dx', 'dy', 'l2', 'nx', 'ny', 'vnx', 'vny', 'start', 'seg', 'inside'].map((k) => [k, A(P[k])])) } : null };
    // Tool temperature grid (toolheat.js); its state comes back with every frame.
    const h = s.heat;
    if (s.helix) out.mill = { ...pick(s.mill, ['R', 'fz', 'ae', 's', 'b0', 'b1', 'bStart', 'bEnd', 'passes', 'k', 'tk', 'om', 'vf', 'hRef']), z: c.z };
    out.heat = { ...pick(h, ['nu', 'nw', 'u0', 'w0', 'a', 'cap', 'hc', 'aTime']), k: h.tmat.k, rho: h.tmat.rho, c: h.tmat.c,
      ...Object.fromEntries(['inside', 'dir', 'T', 'near', 'surf', 'aQ', 'aQin', 'aH', 'aHT', 'aFn', 'aFV'].map((k) => [k, A(h[k])])) };
  }
  return out;
}

// Copies a frame into s; returns the core's own figures (threads, ms per step, on the GPU).
export function applyFrame(s, buf) {
  const h = new Float64Array(buf, 0, 16), nh = h[10], N = h[11];
  if (h[0] !== 1 || N !== s.N) throw new Error('ネイティブ計算の結果が合いません。');
  let o = 16;
  const take = (k) => { const a = new Float64Array(buf, 8 * o, k); o += k; return a; };
  const hist = {};
  for (const k of ['axis', 'fc', 'ft', 'fr', 'mz', 'tmax', 'ttool', 'flow', 'area', 'len', 'pass']) hist[k] = Array.from(take(nh), (v) => (Number.isNaN(v) ? null : v));
  if (!s.helix) { hist.area = []; hist.len = []; hist.pass = []; }
  if (!s.meshMode) delete hist.mz;
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'T', 'seq', 'ep', 'sr', 'p', 'dmg']) s[k].set(take(N));
  if (h[15] & 1) {
    const ht = s.heat, ns = ht.surf.length;
    ht.aTime = take(1)[0];
    ht.T.set(take(ht.T.length));
    for (const k of ['aQ', 'aQin', 'aH', 'aHT', 'aFn', 'aFV']) ht[k].set(take(ns));
  }
  if (h[15] & 2) { const m = take(2); s.mill.k = m[0]; s.mill.tk = m[1]; }
  const u = new Uint8Array(buf, 8 * o, 3 * N);
  s.fixed.set(u.subarray(0, N)); s.contact.set(u.subarray(N, 2 * N)); s.dead.set(u.subarray(2 * N));
  s.steps = h[1]; s.t = h[2]; s.done = h[3] === 1; s.nDead = h[4]; s.nEvac = h[5]; s.heatTool = h[6]; s.workIn = h[7];
  s.chipInfo = { pieces: h[8], failed: h[9] };
  s.hist = hist;
  s.pose(s.t);
  // As the JS solver at the end of a straight cut: the steady tool temperature for the wear estimate.
  if (s.done && !s.helix && !s.meshMode && s.heat && !s.heat.steadyT) s.heat.steady();
  return { threads: h[12], msPerStep: h[13], gpu: (h[15] & 4) !== 0 };
}
