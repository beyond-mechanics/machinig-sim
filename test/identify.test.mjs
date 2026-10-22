// Cutting coefficients from cutting tests: the unit forces of the simulator's own model match
// Altintas' closed form for a slot, and least squares over noisy mean forces at four feeds
// gives back the coefficients they were made with (any immersion, with runout and size effect).
import assert from 'node:assert/strict';
import { unitForces, identify, parseTests, COEF_KEYS } from '../src/identify.js';
import { MATERIALS } from '../src/materials.js';

// 1. slot, no runout, linear model: F̄_feed = N·a·Krc·c/4 + N·a·Kre/π, F̄_normal = N·a·Ktc·c/4
//    + N·a·Kte/π, F̄_axial = N·a·Kac·c/π + N·a·Kae/2 (on the workpiece); also with an axial depth
//    that is not a whole number of slices
for (const ap of [2, 1.3]) {
  const tool = { D: 10, N: 3, helixDeg: 30, fluteLen: 25 }, c = 0.05, N = 3;
  const U = unitForces(tool, { fz: c, ap, ae: 10, mode: 'slot' });
  const want = { Ktc: [0, -N * ap * c / 4, 0], Krc: [N * ap * c / 4, 0, 0], Kac: [0, 0, N * ap * c / Math.PI], Kte: [0, -N * ap / Math.PI, 0], Kre: [N * ap / Math.PI, 0, 0], Kae: [0, 0, N * ap / 2] };
  COEF_KEYS.forEach((k, j) => { const mag = Math.max(...want[k].map(Math.abs)); want[k].forEach((w, i) => assert.ok(Math.abs(U[j][i] - w) < 0.01 * mag, `${k} component ${i}: ${U[j][i]} vs ${w} (ap ${ap})`)); });
}
console.log('slot unit forces = closed form (ap 2 and 1.3 mm)');

// 2. recover the coefficients from noisy tests
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
function synth(tool, m, mode, ae, mc, noise) {
  return [0.02, 0.04, 0.06, 0.08].map(fz => {
    const t = { fz, ap: 2, ae, mode }, U = unitForces(tool, t, mc);
    [t.Fx, t.Fy, t.Fz] = [0, 1, 2].map(k => COEF_KEYS.reduce((s, key, j) => s + m[key] * U[j][k], 0) * (1 + noise * rnd()));
    return t;
  });
}
for (const [name, mode, ae, runout, mc] of [['slot', 'slot', 10, 0, 0], ['down 3 mm, runout 5 µm, size effect', 'down', 3, 5, 0.14], ['up 5 mm', 'up', 5, 0, 0]]) {
  const tool = { D: 10, N: 3, helixDeg: 30, fluteLen: 25, runout }, m = MATERIALS.S50C;
  const tests = synth(tool, m, mode, ae, mc, 0.02);
  const r = identify(tool, tests, { ...m, Ktc: 1000, Krc: 300, Kac: 100, Kte: 10, Kre: 10, Kae: 1 }, mc);
  console.log(`${name.padEnd(36)} ${COEF_KEYS.map(k => `${k} ${r.coefs[k].toFixed(k.endsWith('c') ? 0 : 1)}`).join(' ')}  R² ${r.r2.toFixed(5)}`);
  for (const k of ['Ktc', 'Krc', 'Kte']) assert.ok(Math.abs(r.coefs[k] / m[k] - 1) < 0.1, `${name}: ${k}`);
  assert.ok(Math.abs(r.coefs.Kac / m.Kac - 1) < 0.15, `${name}: Kac`);
  assert.ok(r.r2 > 0.999 && !r.edgeFixed);
}

// 3. one feed only: the edge terms are held, the shearing terms still fitted
{
  const tool = { D: 10, N: 3, helixDeg: 30, fluteLen: 25 }, m = MATERIALS.A5052;
  const tests = synth(tool, m, 'slot', 10, 0, 0).slice(1, 2);
  const r = identify(tool, tests, m, 0);
  assert.ok(r.edgeFixed && r.coefs.Kte === m.Kte && Math.abs(r.coefs.Ktc / m.Ktc - 1) < 1e-3);
}

// 4. reading the table
{
  const { tests, bad } = parseTests('# fz ap ae Fx Fy Fz\n0.05, 2, 10, 150, -230, 70\nfz ap\n0.04\t2\t10\t140\t-200\t60\n1 2 x 4 5 6', 'down');
  assert.equal(tests.length, 2); assert.equal(tests[1].Fy, -200); assert.equal(tests[0].mode, 'down'); assert.deepEqual(bad, [5]);
}
console.log('identify tests passed');
