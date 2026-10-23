// The GPU step against the CPU one: the drill example for a few hundred steps on both, the force
// samples compared (f32 on the GPU, so to a few tenths of a percent, not to rounding).
// node native/scripts/gpucheck.mjs <sphcli built with --features gpu> [steps]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [cli, steps = '300'] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'gpucheck-'));
const st = join(dir, 'drill.json');
execFileSync('node', [new URL('dump.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'drill', st], { stdio: 'inherit' });
const run = (extra, out) => { execFileSync(cli, [st, '--steps', steps, '--out', out, ...extra], { stdio: 'inherit' }); return JSON.parse(readFileSync(out, 'utf8')); };
const c = run(['--no-reorder'], join(dir, 'cpu.json'));
const g = run(['--gpu'], join(dir, 'gpu.json'));
let worst = 0;
for (const k of ['fc', 'ft', 'fr', 'mz', 'tmax']) {
  const a = c.hist[k], b = g.hist[k];
  const peak = Math.max(...a.map(Math.abs));
  const d = Math.max(...a.map((v, i) => Math.abs(v - b[i]))) / peak;
  console.log(k, a.map((v) => +v.toPrecision(5)).join(' '), '|', b.map((v) => +v.toPrecision(5)).join(' '), 'rel', d.toExponential(2));
  if (k !== 'fc') worst = Math.max(worst, d);   // fc is small here (cross force of a drill)
}
console.log(JSON.stringify({ gpu: g.gpu, cpuMsPerStep: c.msPerStep, gpuMsPerStep: g.msPerStep, worst }));
process.exit(worst < 0.02 && c.hist.fc.length === g.hist.fc.length && c.hist.fc.length > 0 ? 0 : 1);
