// Stability limit at one spindle speed by time-domain simulation: the depth of cut at which the
// same cutting engine as the simulation starts to chatter, found by bisection. Unlike the lobe
// diagram (linear, zero-order) it includes the process damping of the flank, the size effect and
// the tooth leaving the cut, so it shows how much deeper low-speed cutting stays stable.
import { CuttingEngine, BINS } from './cutting.js';

// chatter index above which the cut counts as chattering. The runs are without runout: it scatters
// the tooth-passing samples once per revolution (read as chatter by the index) and moves the
// limit itself very little
const CHATTER_IDX = 0.45;

// tool: {N, R, helixDeg, type, fluteLen, runout [µm]}; modal: modes at S; mat; [phiSt, phiEx];
// fz [mm]; opts: { aMax, revs, iters, nonlinear }. Returns { alim, bracket: [stable, chatter] }.
export function chatterAt(tool, modal, mat, S, arc, fz, ap, { revs = 120, nonlinear = true } = {}) {
  const e = new CuttingEngine();
  e.configure({ N: tool.N, R: tool.R, helixDeg: tool.helixDeg, type: tool.type, fluteLen: Math.max(tool.fluteLen, ap + 1), runout: 0, nonlinear }, modal, mat, S);
  for (let b = 0; b < BINS; b++) { const phi = (b + 0.5) / BINS * 2 * Math.PI; e.Hb[b] = phi >= arc[0] && phi <= arc[1] ? 0 : -1e3; }
  e.setEngagement([1, 0], fz, -ap, ap);
  e.vx = 0.01; // a small kick
  e.run(e.stepsPerTooth * tool.N * revs);
  return e.chatterIndex().index > CHATTER_IDX;
}

export function timeDomainLimit(tool, modal, mat, S, arc, fz, { aMin = 0.05, aMax = 20, iters = 8, ...o } = {}) {
  if (!chatterAt(tool, modal, mat, S, arc, fz, aMax, o)) return { alim: aMax, bracket: [aMax, Infinity] };
  let lo = aMin, hi = aMax;
  for (let i = 0; i < iters; i++) {
    const m = Math.sqrt(lo * hi);
    if (chatterAt(tool, modal, mat, S, arc, fz, m, o)) hi = m; else lo = m;
  }
  return { alim: Math.sqrt(lo * hi), bracket: [lo, hi] };
}
