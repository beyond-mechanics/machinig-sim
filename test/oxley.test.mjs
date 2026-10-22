// Cutting coefficients from the work material's constants (Oxley + Johnson–Cook): the solution
// satisfies both of Oxley's equilibrium conditions, follows the known trends of orthogonal
// cutting, and lands near the measured-coefficient table for the materials that have one.
import assert from 'node:assert/strict';
import { oxley, obliqueCoefs, predictCoefs, JC } from '../src/oxley.js';
import { MATERIALS } from '../src/materials.js';

const D = Math.PI / 180;
const orth = (k, t1, { V = 200, rake = 6 } = {}) => oxley(JC[k], MATERIALS[k], { V: V / 60, t1, w: 1, alpha: rake * D });

// 1. AISI 1045 (S50C), the usual test case of the theory: both conditions met, φ and the chip
//    ratio in the range reported for steel (φ 15–30°, chip 1.5–3.5 times thicker than the cut)
{
  const r = orth('S50C', 0.15, { V: 200, rake: -7 });
  console.log(`1045 V200 t0.15 α−7°: Fc ${(r.Fc * 1.6).toFixed(0)} N, Ft ${(r.Ft * 1.6).toFixed(0)} N per 1.6 mm, φ ${(r.phi / D).toFixed(1)}°, C0 ${r.C0.toFixed(2)}, δ ${r.delta.toFixed(3)}, T_AB ${r.TAB.toFixed(0)} °C, T_int ${r.Tint.toFixed(0)} °C`);
  assert.ok(Math.abs(r.tauInt / r.kChip - 1) < 0.01, 'interface stress = chip flow stress');
  assert.ok(Math.abs(r.sNA / r.sN - 1) < 0.02, 'edge normal stress = interface normal stress');
  assert.ok(r.phi > 15 * D && r.phi < 30 * D);
  assert.ok(r.t2 / 0.15 > 1.5 && r.t2 / 0.15 < 3.5);
  assert.ok(r.TAB > 250 && r.TAB < 600 && r.Tint > r.TAB && r.Tint < JC.S50C.Tm);
  assert.ok(r.Fc * 1.6 > 400 && r.Fc * 1.6 < 800, 'cutting force of the reported magnitude');
}

// 2. trends: thicker chips cut at lower specific force (size effect), a larger rake angle opens
//    the shear angle and lowers the force, a higher speed heats and softens the shear zone
{
  const a = orth('S50C', 0.05), b = orth('S50C', 0.2);
  assert.ok(b.Fc / 0.2 < a.Fc / 0.05, 'size effect');
  const r0 = orth('S50C', 0.1, { rake: 0 }), r15 = orth('S50C', 0.1, { rake: 15 });
  assert.ok(r15.phi > r0.phi && r15.Fc < r0.Fc, 'rake angle');
  const v1 = orth('S50C', 0.1, { V: 100 }), v2 = orth('S50C', 0.1, { V: 400 });
  assert.ok(v2.Tint > v1.Tint && v2.Fc < v1.Fc, 'speed');
  console.log(`trends: Kc ${(a.Fc / 0.05).toFixed(0)} → ${(b.Fc / 0.2).toFixed(0)} N/mm² (h 0.05 → 0.2), φ ${(r0.phi / D).toFixed(1)} → ${(r15.phi / D).toFixed(1)}° (rake 0 → 15°), T_int ${v1.Tint.toFixed(0)} → ${v2.Tint.toFixed(0)} °C (V 100 → 400)`);
}

// 3. the oblique transformation reduces to the orthogonal force at zero inclination, and the
//    helix turns part of the force into the axial direction
{
  const r = orth('S50C', 0.1), c0 = obliqueCoefs(r, 6 * D, 0), c30 = obliqueCoefs(r, 6 * D, 30 * D);
  assert.ok(Math.abs(c0.Ktc / (r.Fc / 0.1) - 1) < 1e-6 && Math.abs(c0.Krc / (r.Ft / 0.1) - 1) < 1e-6 && Math.abs(c0.Kac) < 1e-9);
  assert.ok(c30.Kac > 0.15 * c30.Ktc);
}

// 4. milling coefficients for every material: within a factor of two of the table (which comes
//    from cutting tests with real, slightly rounded edges), steel within 15 %; harder materials higher
const got = {};
for (const k of Object.keys(JC)) {
  const m = MATERIALS[k], p = predictCoefs(JC[k], m, { Vc: m.vc, rakeDeg: 10, helixDeg: 30 });
  got[k] = p;
  console.log(`${k.padEnd(6)} Ktc ${p.Ktc.toFixed(0).padStart(5)} (table ${m.Ktc})  Krc ${p.Krc.toFixed(0).padStart(5)} (${m.Krc})  Kac ${p.Kac.toFixed(0).padStart(4)} (${m.Kac})  mc ${p.mc.toFixed(2)}  φ ${(p.at.phi / D).toFixed(1)}°  T_int ${p.at.Tint.toFixed(0)} °C`);
  assert.ok(p.Ktc / m.Ktc > 0.5 && p.Ktc / m.Ktc < 2, `${k} Ktc`);
  assert.ok(p.Krc > 0 && p.Krc < p.Ktc && p.Kac > 0, `${k} components`);
  assert.ok(p.mc >= 0 && p.mc < 0.5, `${k} size effect`);
}
assert.ok(Math.abs(got.S50C.Ktc / MATERIALS.S50C.Ktc - 1) < 0.15);
assert.ok(got.SUS304.Ktc > got.S50C.Ktc && got.S50C.Ktc > got.A5052.Ktc, 'stainless > carbon steel > aluminium');
console.log('ok');
