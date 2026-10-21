// Tool-tip dynamics that change with spindle speed.
// At speed, angular-contact spindle bearings lose stiffness: the centrifugal force on the balls
// and the thermal growth change the contact angle and relieve the preload, and a taper holder
// (BT/HSK) loosens as the spindle bore expands. Measured tool-tip FRFs at speed show the modes
// that the spindle carries dropping by several per cent to ~20 % towards the top speed.
// Model: bearing/holder stiffness k_s(S) = k_s0 / (1 + c·(S/S_ref)²), c set by the loss at S_ref.
// The tool tip sees it through its compliance chain 1/k = 1/k_tool + 1/k_s, so a slender tool
// (compliance mostly its own bending) changes little and a stubby one follows the spindle.
// Each mode keeps its mass: k' = k·f, fn' = fn·√f with f = k_tip(S) / k_tip(0).
// Measured FRFs at several speeds (cfg.modal.speedFrfs) replace the model: modes are
// interpolated linearly between the speeds (by mode order when the mode counts match,
// otherwise the nearest measurement), held constant outside the measured range.
// The gyroscopic split of forward/backward whirl is left out: for an end mill it is small
// next to the bearing effect, and it couples x and y, which the modal model keeps separate.

export const SOFT_DEFAULT = { drop: 0.25, Sref: 30000 }; // 25 % less bearing stiffness at 30 000 min⁻¹

// bearing stiffness ratio k_s(S) / k_s0
export function bearingFactor(S, soft = SOFT_DEFAULT) {
  const d = Math.min(0.9, Math.max(0, soft?.drop ?? 0));
  if (!d || !(S > 0)) return 1;
  const c = d / (1 - d);
  return 1 / (1 + c * (S / (soft.Sref || 30000)) ** 2);
}

// tool-tip stiffness ratio k_tip(S) / k_tip(0) for a tool of stiffness kTool on a spindle kSp [N/mm]
export function tipFactor(S, kTool, kSp, soft = SOFT_DEFAULT) {
  const b = bearingFactor(S, soft);
  if (b === 1 || !(kTool > 0) || !(kSp > 0)) return 1;
  return (1 / kTool + 1 / kSp) / (1 / kTool + 1 / (kSp * b));
}

const scaleModes = (modes, f) => modes.map(m => ({ k: m.k * f, fn: m.fn * Math.sqrt(f), zeta: m.zeta }));

function lerpModes(a, b, t) {
  if (a.length !== b.length) return t < 0.5 ? a : b;
  return a.map((m, i) => ({ k: m.k + (b[i].k - m.k) * t, fn: m.fn + (b[i].fn - m.fn) * t, zeta: m.zeta + (b[i].zeta - m.zeta) * t }));
}

// Modal set {x, y} at spindle speed S. modal: cfg.modal ({k, fn, zeta, modesX?, modesY?,
// speedFrfs?}); chain: {kTool, kSp} of the tool model for the speed model.
export function modesAt(modal, S, chain, soft = SOFT_DEFAULT) {
  const one = [{ k: modal.k, fn: modal.fn, zeta: modal.zeta }];
  const list = modal.speedFrfs;
  if (list?.length) {
    const L = [...list].sort((p, q) => p.S - q.S);
    const pick = e => ({ x: e.modesX, y: e.modesY?.length ? e.modesY : e.modesX });
    if (S <= L[0].S) return pick(L[0]);
    if (S >= L[L.length - 1].S) return pick(L[L.length - 1]);
    let j = 1; while (L[j].S < S) j++;
    const a = pick(L[j - 1]), b = pick(L[j]), t = (S - L[j - 1].S) / (L[j].S - L[j - 1].S);
    return { x: lerpModes(a.x, b.x, t), y: lerpModes(a.y, b.y, t) };
  }
  const x0 = modal.modesX?.length ? modal.modesX : one;
  const y0 = modal.modesY?.length ? modal.modesY : x0;
  const f = chain ? tipFactor(S, chain.kTool, chain.kSp, soft) : 1;
  return f === 1 ? { x: x0, y: y0 } : { x: scaleModes(x0, f), y: scaleModes(y0, f) };
}

// whether the dynamics depend on the speed at all (the lobe diagram is then built per speed)
export const speedDependent = (modal, soft) => !!modal.speedFrfs?.length || (soft?.drop ?? 0) > 0;
