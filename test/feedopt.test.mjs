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
// F words with a trailing decimal point (F150.) and a leading one (F.5) keep a valid number
{
  const out = rewriteFeeds('G1 X10 F100.\nG1 X20', new Set([1, 2]), new Map([[1, 1.255], [2, 1.255]])).split('\n');
  assert.deepEqual(out, ['G1 X10 F125.5', 'G1 X20']);
}
// spindle speed: one factor for the program that moves the worst line into a pocket
{
  const { optimizeSpindle, rewriteSpindle } = await import('../src/feedopt.js');
  // a lobe with a pocket at 9500 (limit 3 mm) and 0.8 mm elsewhere
  const lim = S => (Math.abs(S - 9500) < 400 ? 3 : 0.8);
  const r = optimizeSpindle([{ ap: 1.5, S: 8000, lim }, { ap: 0.5, S: 8000, lim }]);
  assert.ok(r.worst0 > 1 && r.worst < 1 && Math.abs(r.q * 8000 - 9500) < 400, JSON.stringify(r));
  assert.equal(rewriteSpindle('S8000 M3 (S is spindle)\nG1 X10 F800.', 1.2), 'S9600 M3 (S is spindle)\nG1 X10 F960');
  assert.equal(rewriteSpindle('G95 S8000\nG1 X10 F0.1', 1.2), 'G95 S9600\nG1 X10 F0.1', 'per-revolution feed stays');
}
// round trip on the demo: the lobes of each line's engagement pick a speed, and the program run
// again at that speed chatters (much) less
{
  const { optimizeSpindle, rewriteSpindle } = await import('../src/feedopt.js');
  const { alimAt } = await import('../src/sld.js');
  const run = code => { const s = new Simulator(); s.load(code); s.speed = 20; let n = 0; while (!s.done && n++ < 20000) s.step(1 / 60); return s; };
  const a = run(SAMPLES.demo.code), lines = [];
  for (const r of a.report.lines.values()) {
    if (!(r.cut > 0) || !(r.ap > 0.01)) continue;
    const pt = a.path.find(p => p.line === r.line && !p.rapid), lob = a.lobes(r.pst, r.pex);
    lines.push({ ap: r.ap, S: pt.S, lim: S => alimAt(lob, S) });
  }
  const o = optimizeSpindle(lines, { qMin: 0.7, qMax: 1.3 });
  const b = run(rewriteSpindle(SAMPLES.demo.code, o.q)), s0 = a.report.summary(), s1 = b.report.summary();
  console.log(`spindle ×${o.q} (worst ap/limit ${o.worst0.toFixed(2)} → ${o.worst.toFixed(2)}): chatter ${(s0.chatterShare * 100).toFixed(0)} % → ${(s1.chatterShare * 100).toFixed(0)} %, time ${s0.time.toFixed(1)} → ${s1.time.toFixed(1)} s`);
  assert.ok(o.worst < o.worst0 && s1.chatterShare < 0.5 * s0.chatterShare);
}
// review fixes: a line out of the spindle range does not block the rest; code after a comment
{
  const { optimizeSpindle, rewriteSpindle } = await import('../src/feedopt.js');
  const lim = S => (Math.abs(S - 9500) < 400 ? 3 : 0.8);
  const r = optimizeSpindle([{ ap: 1.5, S: 8000, lim }, { ap: 0.5, S: 1500, lim }]);
  assert.ok(r.worst < 1, JSON.stringify(r));
  assert.equal(rewriteSpindle('N30 (ROUGH) S8000 M03 (S1)\nG1 X1 F100 ; F2', 1.5), 'N30 (ROUGH) S12000 M03 (S1)\nG1 X1 F150 ; F2');
}
console.log('feedopt tests passed');
