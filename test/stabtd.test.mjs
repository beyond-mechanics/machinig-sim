// Stability limit by time-domain bisection: near the lobe diagram at high speed, far above it at
// low speed in steel (process damping), and back to the lobe diagram without process damping.
import assert from 'node:assert/strict';
import { timeDomainLimit } from '../src/stabtd.js';
import { stabilityLobes, alimAt } from '../src/sld.js';
import { toolModel } from '../src/tool.js';
import { MATERIALS } from '../src/materials.js';

const tool = { D: 10, R: 5, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25, stickout: 30, kSpindle: 50000 };
const tm = toolModel(tool), modal = { k: tm.k, fn: tm.fn, zeta: 0.04 }, m = MATERIALS.S50C, arc = [Math.PI / 2, Math.PI];
const lin = S => alimAt(stabilityLobes({ ...modal, N: 3, Ktc: m.Ktc, Krc: m.Krc, phiSt: arc[0], phiEx: arc[1], lobes: 30, rpmMin: S * 0.97, rpmMax: S * 1.03 }), S);
const hi = timeDomainLimit(tool, modal, m, 8000, arc, 0.05), lo = timeDomainLimit(tool, modal, m, 2500, arc, 0.05);
const loLin = timeDomainLimit(tool, modal, m, 2500, arc, 0.05, { nonlinear: false });
console.log(`8000 min⁻¹: time domain ${hi.alim.toFixed(2)} mm, lobes ${lin(8000).toFixed(2)} mm; 2500 min⁻¹: ${lo.alim.toFixed(2)} mm with process damping, ${loLin.alim.toFixed(2)} mm without, lobes ${lin(2500).toFixed(2)} mm`);
assert.ok(Math.abs(hi.alim / lin(8000) - 1) < 0.4, 'high speed: close to the lobes');
assert.ok(lo.alim > 4 * lin(2500), 'low speed: process damping');
assert.ok(Math.abs(loLin.alim / lin(2500) - 1) < 0.4, 'linear model: back to the lobes');
// a tool with runout: the search ignores it (its once-per-revolution scatter is not chatter)
{
  const r = timeDomainLimit({ ...tool, runout: 5 }, modal, m, 12000, [0, Math.PI], 0.04);
  const l = alimAt(stabilityLobes({ ...modal, N: 3, Ktc: m.Ktc, Krc: m.Krc, phiSt: 0, phiEx: Math.PI, lobes: 30, rpmMin: 11600, rpmMax: 12400 }), 12000);
  console.log(`slot 12000 min⁻¹, tool with 5 µm runout: ${r.alim.toFixed(2)} mm (lobes ${l.toFixed(2)} mm)`);
  assert.ok(r.alim > 0.6 * l && r.alim < 3 * l);
}
console.log('stabtd tests passed');
