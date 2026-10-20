// Starting cutting conditions for a material and a tool: the spindle speed from the
// recommended cutting speed, the feed per tooth from a per-material fraction of the diameter
// (slotting), raised for a light radial engagement so that the maximum chip thickness stays the
// same (radial chip thinning: h_max = fz·sin φ_e for a radial depth under half the diameter),
// and the depth of cut the stability lobes allow at that speed. These are the usual catalogue
// starting points; the simulation then shows what they do on this machine and tool.

export const S_MIN = 2000, S_MAX = 30000;

// engagement arc [φ_st, φ_ex] of down milling at radial depth ae (a slot for ae ≥ D)
export function arcOf(ae, D) {
  if (!(ae < D)) return [0, Math.PI];
  return [Math.PI - Math.acos(1 - 2 * ae / D), Math.PI];
}

// mat: material (vc [m/min], fzD); tool: {D, N}; ae [mm]. Returns { Vc, S, fz, F, hmax }
export function startConditions(mat, tool, ae = tool.D) {
  const S = Math.round(Math.min(S_MAX, Math.max(S_MIN, mat.vc * 1000 / (Math.PI * tool.D))) / 10) * 10;
  const Vc = Math.PI * tool.D * S / 1000;
  const fz0 = (mat.fzD ?? 0.004) * tool.D;
  const [st, ex] = arcOf(ae, tool.D), arc = ex - st;
  // the thickest chip of the arc: fz at φ = π/2 when the arc reaches it, else fz·sin φ_e
  const thin = arc >= Math.PI / 2 ? 1 : Math.sin(arc);
  const fz = Math.min(fz0 / Math.max(thin, 0.2), 3 * fz0);
  return { Vc, S, fz, F: Math.round(fz * tool.N * S), hmax: fz * thin, arc: [st, ex] };
}
