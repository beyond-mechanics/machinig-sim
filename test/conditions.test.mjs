// Starting conditions: speed from the recommended cutting speed, feed from the material's
// fraction of the diameter, and the same maximum chip thickness at a light radial depth.
import assert from 'node:assert/strict';
import { startConditions, arcOf } from '../src/conditions.js';
import { MATERIALS } from '../src/materials.js';

const tool = { D: 10, N: 3 };
const s = startConditions(MATERIALS.S50C, tool);
assert.equal(s.S, Math.round(150 * 1000 / (Math.PI * 10) / 10) * 10);
assert.ok(Math.abs(s.fz - 0.04) < 1e-9 && s.F === Math.round(0.04 * 3 * s.S));
// ae 0.1D: the arc is short, so fz rises until the thickest chip is the slot's
const l = startConditions(MATERIALS.S50C, tool, 1), arc = arcOf(1, 10);
assert.ok(Math.abs(arc[1] - arc[0] - Math.acos(1 - 0.2)) < 1e-12);
assert.ok(Math.abs(l.hmax - s.hmax) < 1e-9 && l.fz > 1.5 * s.fz);
// aluminium: limited by the spindle's top speed
const a = startConditions(MATERIALS.A5052, { D: 3, N: 2 });
assert.equal(a.S, 30000); assert.ok(a.Vc < MATERIALS.A5052.vc);
for (const [k, m] of Object.entries(MATERIALS)) assert.ok(m.fzD > 0 && m.fzD < 0.02, k);
console.log(`S50C φ10 3 枚: slot S ${s.S} fz ${s.fz.toFixed(3)} F ${s.F}; ae 1 mm fz ${l.fz.toFixed(3)} F ${l.F}`);
console.log('conditions tests passed');
