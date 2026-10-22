// Steps the JS solver and the native core from the same state and compares the particles.
// node native/scripts/compare.mjs <example> <steps> <sphcli> [threads] [dxUm]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cutting3D } from '../../src/sph3d.js';
import { exampleCfg, dumpState } from './dump.mjs';

const [name = 'drill', steps = '50', cli, threads = '4', dxUm] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'sphcmp-'));
const s = new Cutting3D(exampleCfg(name, dxUm ? { dxUm: +dxUm } : {}));
writeFileSync(join(dir, 'state.json'), JSON.stringify(dumpState(s)));
let t0 = performance.now();
for (let k = 0; k < +steps; k++) s.stepSample();
const js = (performance.now() - t0) / +steps;
execFileSync(cli, [join(dir, 'state.json'), '--steps', steps, '--threads', threads, '--out', join(dir, 'r.json'), '--state', join(dir, 'f.json')], { stdio: 'inherit' });
const r = JSON.parse(readFileSync(join(dir, 'r.json'))), f = JSON.parse(readFileSync(join(dir, 'f.json')));
const fields = { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, rho: s.rho, p: s.p, T: s.T, ep: s.ep, dmg: s.dmg, sxx: s.s[0], sxy: s.s[3] };
const out = {};
for (const [k, a] of Object.entries(fields)) {
  let md = 0, scale = 0, ndiff = 0;
  for (let i = 0; i < s.N; i++) { const d = Math.abs(a[i] - f[k][i]); if (d > md) md = d; if (d > 0) ndiff++; scale = Math.max(scale, Math.abs(a[i])); }
  out[k] = { rel: scale ? +(md / scale).toExponential(2) : md, ndiff };
}
let fixedDiff = 0, deadDiff = 0;
for (let i = 0; i < s.N; i++) { if (s.fixed[i] !== f.fixed[i]) fixedDiff++; if (s.dead[i] !== f.dead[i]) deadDiff++; }
const h = s.hist;
console.log(JSON.stringify({ steps: +steps, jsMsPerStep: +js.toFixed(1), nativeMsPerStep: +r.msPerStep.toFixed(1), speedup: +(js / r.msPerStep).toFixed(1), fixedDiff, deadDiff, fields: out,
  forceJs: h.fc.map((v, i) => [v, h.ft[i], h.fr[i]]).slice(-2), forceNative: r.hist.fc.map((v, i) => [v, r.hist.ft[i], r.hist.fr[i]]).slice(-2) }, null, 1));
// A few steps from the same state must agree to rounding (later, round-off grows as in any explicit run).
const worst = Math.max(...Object.values(out).map((v) => v.rel));
if (+steps <= 5 && (worst > 1e-14 || fixedDiff || deadDiff)) { console.error(`native core differs from JS: ${worst}`); process.exit(1); }
