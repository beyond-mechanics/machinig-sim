// Seeking: jumping ahead runs the program to that time (same material removed as playing it),
// jumping back starts over, and no chips are left hanging from the jump.
import assert from 'node:assert/strict';
import { Simulator } from '../src/sim.js';
import { SAMPLES } from '../src/samples.js';

const played = new Simulator();
played.load(SAMPLES.demo.code); played.speed = 4;
while (played.mtime < 50) played.step(1 / 60);

const sim = new Simulator();
sim.load(SAMPLES.demo.code);
const t0 = performance.now();
sim.seekTo(played.mtime);
const ms = performance.now() - t0;
console.log(`seek to ${played.mtime.toFixed(2)} s took ${ms.toFixed(0)} ms: removed ${sim.stock.removed.toFixed(0)} vs played ${played.stock.removed.toFixed(0)} mm³, line ${sim.line} vs ${played.line}, chips ${sim.chips.stats.count}`);
assert.ok(Math.abs(sim.mtime - played.mtime) < 0.05, 'lands on the time');
assert.ok(Math.abs(sim.stock.removed / played.stock.removed - 1) < 0.02, 'same material removed');
assert.equal(sim.line, played.line);
assert.equal(sim.chips.stats.count ?? 0, 0, 'no chips from the jump');
const r = sim.report.summary();
assert.ok(Math.abs(r.time - sim.mtime) < 0.05, 'the report covers the jumped time');
// back to 10 s: starts over
sim.seekTo(10);
assert.ok(Math.abs(sim.mtime - 10) < 0.05 && sim.stock.removed < played.stock.removed * 0.5, 'jumping back starts over');
// past the end: done
sim.seekTo(1e9);
assert.ok(sim.done);
console.log('seek tests passed');
