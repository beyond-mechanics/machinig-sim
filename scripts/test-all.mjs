// Runs every test/*.test.mjs in its own process and prints a summary (npm test).
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';

const files = readdirSync('test').filter(f => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of files) {
  const t = Date.now(), r = spawnSync(process.execPath, [`test/${f}`], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(24)} ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (!ok) console.log((r.stdout + r.stderr).split('\n').slice(-15).join('\n'));
}
console.log(`${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
