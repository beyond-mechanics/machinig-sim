// Feed optimisation: the force law used to pick the feeds, the rewriting of the program's modal
// F words, and a full round trip on the demo program (shorter time, no heavier peak force).
import assert from 'node:assert/strict';
import { forceRatio, optimizeFeeds, rewriteFeeds, defaultTarget } from '../src/feedopt.js';
import { LineReport } from '../src/report.js';
import { Simulator } from '../src/sim.js';
import { SAMPLES } from '../src/samples.js';
import { MATERIALS } from '../src/materials.js';

// 1. force law: a pure shearing cut scales with the feed (less than proportionally with the size
//    effect); the edge term does not scale, so a light cut gains less force per feed
{
  const m = { Ktc: 2000, Kte: 0, mc: 0 };
  assert.ok(Math.abs(forceRatio(m, 0.05, 1.5, false) - 1.5) < 1e-9);
  assert.ok(Math.abs(forceRatio({ ...m, mc: 0.2 }, 0.05, 1.5) - 1.5 ** 0.8) < 1e-9);
  const e = { Ktc: 2000, Kte: 40, mc: 0 };
  assert.ok(forceRatio(e, 0.005, 2, false) < forceRatio(e, 0.1, 2, false));
}

// 2. per-line feeds: light lines go up to the cap, a heavy line comes down to the target,
//    a chattering line is not sped up, a line near the stress limit is held by it
{
  const rep = new LineReport();
  const add = (line, F, h, extra = {}) => { const r = rep.rec(line); Object.assign(r, { t: 2, cut: 2, F, h, hw: 2, stress: F, ...extra }); };
  add(10, 100, 0.03); add(11, 400, 0.05); add(12, 150, 0.04, { chatter: 0.5 }); add(13, 250, 0.05, { stress: 1100 });
  rep.rec(14).t = 1; // a rapid
  const mat = MATERIALS.S50C, opt = optimizeFeeds(rep, mat, { Ftarget: 300, maxUp: 1.5, maxDown: 0.5, stressLimit: 1200 });
  const k = l => opt.lines.get(l).k;
  assert.equal(k(10), 1.5);
  assert.ok(k(11) < 1 && Math.abs(opt.lines.get(11).F1 - 300) < 6, 'heavy line down to the target');
  assert.equal(k(12), 1, 'chatter: not faster');
  assert.ok(k(13) > 1 && opt.lines.get(13).F1 * 1100 / 250 <= 1200 * 1.02, 'stress limit');
  // the feed moves take 1/k of their time, the rapid is unchanged
  const t1 = 1 + [10, 11, 12, 13].reduce((s, l) => s + 2 / k(l), 0);
  assert.ok(Math.abs(opt.time0 - 9) < 1e-9 && Math.abs(opt.time1 - t1) < 1e-9);
  assert.equal(defaultTarget(rep), 400, 'heaviest line that did not chatter');
}

// 3. rewriting: F is modal, so a changed line carries its F and the next line at the old feed
//    gets it back; lines with their own F are rewritten in place; comments are kept
{
  const text = ['G0 X0 Y0', 'G1 Z-1 F500 (plunge)', 'G1 X10', 'G1 X20', 'G1 X30 ; finish', 'F800', 'G1 X40', 'G0 Z5'].join('\n');
  const feed = new Set([2, 3, 4, 5, 7]);
  const out = rewriteFeeds(text, feed, new Map([[3, 1.5], [4, 1.5], [7, 0.5]])).split('\n');
  assert.deepEqual(out, ['G0 X0 Y0', 'G1 Z-1 F500 (plunge)', 'G1 X10 F750', 'G1 X20', 'G1 X30 F500 ; finish', 'F800', 'G1 X40 F400', 'G0 Z5']);
  assert.equal(rewriteFeeds(text, feed, new Map()), text, 'no change, same text');
}

// 4. round trip on the demo program
{
  const run = code => { const s = new Simulator(); s.load(code); s.speed = 20; let n = 0; while (!s.done && n++ < 20000) s.step(1 / 60); return s; };
  const code = SAMPLES.demo.code, a = run(code), target = defaultTarget(a.report);
  const opt = optimizeFeeds(a.report, a.mat, { Ftarget: target, maxUp: 1.5, maxDown: 0.5, stressLimit: 1200, nonlinear: a.cfg.cuttingNonlinear });
  const code2 = rewriteFeeds(code, new Set(a.path.filter(p => !p.rapid).map(p => p.line)), new Map([...opt.lines].map(([l, o]) => [l, o.k])));
  const b = run(code2), s0 = a.report.summary(), s1 = b.report.summary();
  const peak = rep => Math.max(...[...rep.lines.values()].filter(r => !(r.chatter > 0) && r.cut > 0).map(r => r.F));
  console.log(`demo: ${s0.time.toFixed(1)} s → ${s1.time.toFixed(1)} s (predicted ${opt.time1.toFixed(1)} s); clean-cut peak ${peak(a.report).toFixed(0)} → ${peak(b.report).toFixed(0)} N (target ${target.toFixed(0)} N)`);
  assert.ok(s1.time < 0.95 * s0.time, 'faster');
  assert.ok(Math.abs(s1.time - opt.time1) < 0.05 * s0.time, 'time as predicted');
  assert.ok(peak(b.report) < 1.15 * target, 'no line much above the target');
}
console.log('feedopt tests passed');
