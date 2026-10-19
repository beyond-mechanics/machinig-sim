// Coefficients exported by cutting-sim: parsed, mapped to the matching material and laid over it.
import assert from 'node:assert/strict';
import { parseCoeffs, MATERIALS } from '../src/materials.js';
import { Simulator } from '../src/sim.js';

const file = { source: 'cutting-sim', mode: 'mill', material: 'Al7075', coefficients: { Ktc: 690.4, Krc: 210.2, Kac: null, Kte: 21.5, Kre: 28.1, Kae: null } };
const r = parseCoeffs(JSON.stringify(file));
assert.equal(r.material, 'A7075');
assert.deepEqual(r.coeffs, { Ktc: 690.4, Krc: 210.2, Kte: 21.5, Kre: 28.1 });

const sim = new Simulator();
sim.cfg.material = r.material; sim.cfg.coeffs = r.coeffs; sim.reconfigure();
assert.equal(sim.mat.Ktc, 690.4);
assert.equal(sim.mat.Kac, MATERIALS.A7075.Kac);   // axial terms stay as tabled
assert.equal(MATERIALS.A7075.Ktc, 796);           // the table itself is untouched
sim.cfg.coeffs = null; sim.reconfigure();
assert.equal(sim.mat.Ktc, 796);

assert.equal(parseCoeffs(JSON.stringify({ ...file, material: 'IN718' })).material, null);
assert.throws(() => parseCoeffs('{'), /JSON/);
assert.throws(() => parseCoeffs('{"a":1}'), /coefficients/);
assert.throws(() => parseCoeffs(JSON.stringify({ coefficients: { Ktc: -1 } })), /Ktc/);
console.log('coeffs ok');
