// Hand-over between the JS solver and the native core (native/sph-core): the state of a Cutting3D
// in STL mode as JSON (the setup stays here: filling the work, supports, the tool's distance
// field), and the binary frames the core answers with, copied back into the same Cutting3D so
// that views and summary are computed as for a run in the worker. Layout: native/sph-core/src/engine.rs.

export function dumpState(s) {
  const A = (a) => Array.from(a), c = s.cfg, t = s.msdf;
  const keys = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'rho', 'p', 'T', 'ep', 'epd', 'seq', 'sr', 'z0', 'dmg', 'fixed', 'contact', 'dead', 'touched'];
  const arr = {};
  for (const k of keys) arr[k] = A(s[k]);
  ['sxx', 'syy', 'szz', 'sxy', 'syz', 'sxz'].forEach((k, i) => { arr[k] = A(s.s[i]); });
  const en = [];
  for (const [key, v] of t.en) en.push([Math.floor(key / 4294967296), key % 4294967296, ...v]);
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k] ?? null]));
  return {
    n: s.N, steps: s.steps, t: s.t, arr,
    sc: pick(s, ['dt', 'm', 'mReal', 'G', 'K', 'rho0', 'cs', 'hk', 'ad', 'Wdx', 'epKeep', 'nSub', 'dx', 'h', 'V', 'om', 'sg', 'vf', 'ax', 'ay', 'Rt', 'ms']),
    cfg: { ...pick(c, ['motion', 'angle', 'travel', 'mu', 'friction', 'muExp', 'heatToWork', 'beta', 'fracture', 'efScale', 'avAlpha', 'avBeta', 'T0']), sleep: c.sleep !== false },
    mat: pick(s.mat, ['A', 'B', 'n', 'C', 'm', 'Tm', 'Tr', 'vc', 'rho', 'c', 'k', 'D1', 'D2', 'D3', 'D4', 'D5', 'model', 'a', 'b', 'cc', 'd']),
    tool: { V: A(t.V), F: A(t.F), fn: A(t.fn), vn: A(t.vn), en, bb: A(t.bb), cell: t.cell,
      nb: A(t.nb), nl: A(t.nl), nr: A(t.nr), ns: A(t.ns), nn: A(t.nn), order: A(t.order) },
  };
}

// Copies a frame into s; returns the core's own figures (threads, ms per step).
export function applyFrame(s, buf) {
  const h = new Float64Array(buf, 0, 16), nh = h[10], N = h[11];
  if (h[0] !== 1 || N !== s.N) throw new Error('ネイティブ計算の結果が合いません。');
  let o = 16;
  const take = (k) => { const a = new Float64Array(buf, 8 * o, k); o += k; return a; };
  const hist = {};
  for (const k of ['axis', 'fc', 'ft', 'fr', 'mz', 'tmax']) hist[k] = Array.from(take(nh));
  hist.ttool = hist.fc.map(() => null); hist.flow = hist.fc.map(() => null); hist.area = []; hist.len = []; hist.pass = [];
  for (const k of ['x', 'y', 'z', 'T', 'seq', 'ep', 'sr', 'p', 'dmg']) s[k].set(take(N));
  const u = new Uint8Array(buf, 8 * o, 3 * N);
  s.fixed.set(u.subarray(0, N)); s.contact.set(u.subarray(N, 2 * N)); s.dead.set(u.subarray(2 * N));
  s.steps = h[1]; s.t = h[2]; s.done = h[3] === 1; s.nDead = h[4]; s.nEvac = h[5]; s.heatTool = h[6]; s.workIn = h[7];
  s.chipInfo = { pieces: h[8], failed: h[9] };
  s.hist = hist;
  s.pose(s.t);
  return { threads: h[12], msPerStep: h[13] };
}
