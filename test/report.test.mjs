// Machining report per program line: times add up, only cutting lines are flagged, the slot that
// chatters is flagged and the stable one is not, and the report survives the worker hand-off.
import assert from 'node:assert/strict';
import { Simulator } from '../src/sim.js';
import { SAMPLES } from '../src/samples.js';
import { LineReport } from '../src/report.js';

const sim = new Simulator();
sim.load(SAMPLES.demo.code);
sim.speed = 2;
while (!sim.done) sim.step(1 / 60);
const r = sim.report.summary();
const lines = SAMPLES.demo.code.split('\n');
// the three slots of the demo: 0.5 mm (stable at 12000 min⁻¹), 1.0 and 2.0 mm (chatter)
const slots = lines.map((l, i) => [l, i + 1]).filter(([l]) => l === 'G1 X130 F1500').map(([, n]) => n);
const rec = n => sim.report.lines.get(n);
console.log(`time ${r.time.toFixed(1)} s (program ${sim.totalTime.toFixed(1)} s), cutting ${r.cut.toFixed(1)} s, chatter ${(r.chatterShare * 100).toFixed(0)} %; slots ${slots.map(n => `${n}: chatter ${rec(n).chatter.toFixed(2)} s / ${rec(n).cut.toFixed(2)} s`).join(', ')}`);
assert.ok(Math.abs(r.time - sim.totalTime) < 0.05, 'line times add up to the program time');
assert.ok(r.cut <= r.time && r.cut > 0.5 * r.time);
assert.ok(r.issues.every(it => it.cut > 0), 'only cutting lines are flagged');
assert.ok(rec(slots[0]).chatter < 0.1 * rec(slots[0]).cut, 'the 0.5 mm slot is stable');
assert.ok(r.issues.some(it => it.line === slots[2] && it.why.includes('びびり')), 'the 2 mm slot is flagged');
assert.ok(rec(slots[2]).vib > 3 * rec(slots[0]).vib, 'more vibration on the deep slot');
// hand-off to the main thread and the CSV
const back = LineReport.unpack(JSON.parse(JSON.stringify(sim.report.pack())));
assert.deepEqual(back.summary().issues.map(i => i.line), r.issues.map(i => i.line));
const csv = sim.report.csv(lines).split('\n');
assert.ok(csv[0].startsWith('﻿行,Gコード'));
assert.equal(csv.length, sim.report.lines.size + 1);
assert.ok(csv.some(l => l.startsWith(`${slots[2]},"G1 X130 F1500"`)));
console.log('report tests passed');
