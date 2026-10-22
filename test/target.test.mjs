// Cutter compensation geometry, and the comparison of the simulated part with the commanded
// (ideal) cut and with a target STL.
import assert from 'node:assert/strict';
import { parseGcode, discretize } from '../src/gcode.js';
import { applyCutterComp } from '../src/cuttercomp.js';
import { Simulator } from '../src/sim.js';
import { SAMPLES } from '../src/samples.js';

// 1. compensation: a 40 mm square run counter-clockwise; G41 offsets inwards (sharp corners),
//    G42 outwards (corners rounded at the tool radius); a circle shrinks / grows by the radius
{
  const sq = g => `G90 G0 X-20 Y-20 Z5\nG1 Z-1 F500\n${g} D1 G1 X0 Y0\nX40\nY40\nX0\nY0\nG40 G1 X-20 Y-20\nM30`;
  const dist = (x, y) => {
    const dx = Math.max(-x, 0, x - 40), dy = Math.max(-y, 0, y - 40);
    return dx > 0 || dy > 0 ? Math.hypot(dx, dy) : -Math.min(x, 40 - x, y, 40 - y);
  };
  for (const [g, want] of [['G41', -5], ['G42', 5]]) {
    const c = applyCutterComp(parseGcode(sq(g)).moves, () => 5);
    const pts = discretize(c.moves, 0.5).filter(q => q.z === -1).slice(2, -2);
    const d = pts.map(q => dist(q.x, q.y));
    console.log(`${g} square: offset ${Math.min(...d).toFixed(6)} … ${Math.max(...d).toFixed(6)} mm`);
    assert.equal(c.warnings.length, 0);
    assert.ok(d.every(v => Math.abs(v - want) < 1e-6), `${g} keeps the tool radius from the contour`);
  }
  const circ = g => `G0 X0 Y0 Z5\nG1 Z-1 F500\n${g} G1 X20 Y0\nG3 X20 Y0 I-20 J0\nG40 G1 X0 Y0\nM30`;
  for (const [g, want] of [['G41', 15], ['G42', 25]]) {
    const pts = discretize(applyCutterComp(parseGcode(circ(g)).moves, () => 5).moves, 0.5).slice(3, -2);
    assert.ok(pts.every(q => Math.abs(Math.hypot(q.x, q.y) - want) < 1e-6), `${g} circle radius ${want}`);
  }
  // line into an arc (D shape): the inside corner meets where the offset line cuts the offset arc
  const dshape = `G0 X10 Y10 Z5\nG1 Z-1\nG41 G1 X0 Y0\nX40\nG3 X0 Y0 R20\nG40 G1 X10 Y10\nM30`;
  const pts = discretize(applyCutterComp(parseGcode(dshape).moves, () => 5).moves, 2);
  assert.ok(pts.some(q => Math.abs(q.x - (20 + Math.sqrt(200))) < 1e-6 && Math.abs(q.y - 5) < 1e-6), 'line-arc inside corner');
  // an arc smaller than the tool cannot be followed from inside
  const small = applyCutterComp(parseGcode(`G0 X0 Y0 Z5\nG1 Z-1\nG41 G1 X3 Y0\nG3 X3 Y0 I-3 J0\nG40 G1 X0 Y0`).moves, () => 5);
  assert.ok(small.warnings.some(w => w.includes('工具半径以下')), 'warns when the arc collapses');
}

// a 50 × 50 stock; target: base at Z-3 with a 30 × 30 boss to the top, as top-facing triangles
const quad = (x0, y0, x1, y1, z) => [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
const target = { tris: new Float32Array([...quad(0, 0, 50, 50, -3), ...quad(10, 10, 40, 40, 0)]) };
target.count = target.tris.length / 9;
const program = comp => `(STOCK 50 50 10)
(TOOL T1 D12 N3 FLAT L20 SO30)
G21 G90 T1 M6 S10000 M3
G0 X-10 Y-10 Z5
G1 Z-3 F600
${comp ? 'G42 D1 ' : ''}G1 X10 Y10 F800
X40
Y40
X10
Y10
${comp ? 'G40 ' : ''}G1 X-10 Y-10
G0 Z5
M30`;
function run(code, cfg = {}) {
  const sim = new Simulator();
  Object.assign(sim.cfg, cfg);
  sim.load(code, { origin: 'corner', target });
  sim.speed = 4;
  while (!sim.done) sim.step(1 / 60);
  return sim;
}

// a near-rigid tool isolates the geometry from deflection and chatter (those are test 4)
const RIGID = { modal: { auto: false, k: 5e6, fn: 6000, zeta: 0.1 } };

// 2. with compensation: nothing gouged, the boss and its walls within tolerance; only the four
//    stock corners the round tool cannot reach keep material
{
  const sim = run(program(true), RIGID);
  const r = sim.display.dev.target, s = sim.stock;
  console.log(`G42 boss: largest gouge ${(r.gouge * 1000).toFixed(1)} µm, largest material left ${r.left.toFixed(2)} mm at (${r.atLeft.x.toFixed(1)}, ${r.atLeft.y.toFixed(1)}), within ±${sim.display.dev.tol} mm: ${(r.inTol / r.n * 100).toFixed(1)}%`);
  assert.ok(r.gouge > -0.05, 'no gouge with cutter compensation');
  const nearCorner = Math.min(r.atLeft.x, 50 - r.atLeft.x) < 5 && Math.min(r.atLeft.y, 50 - r.atLeft.y) < 5;
  assert.ok(nearCorner, 'material left only in the stock corners');
  // boss top and the base next to the boss walls match the target
  let worst = 0;
  for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) {
    const x = i * s.hx, y = j * s.hy;
    const inBand = x > 5 && x < 45 && y > 5 && y < 45; // away from the unreachable corners
    if (inBand) worst = Math.max(worst, Math.abs(s.devTarget[j * s.nx + i]));
  }
  console.log(`  worst deviation around the boss: ${(worst * 1000).toFixed(1)} µm`);
  assert.ok(worst < 0.05, 'boss within 50 µm');
}

// 3. the same contour without compensation runs the tool centre on the part edge: 5 mm gouge
{
  const sim = run(program(false), RIGID);
  const r = sim.display.dev.target;
  console.log(`no compensation: largest gouge ${r.gouge.toFixed(2)} mm at line ${r.atGouge.line}`);
  assert.ok(r.gouge < -2.5, 'the boss is cut into');
  assert.ok(r.atGouge.line >= 6 && r.atGouge.line <= 10, 'reported on the approach or a contour line');
}

// 4. against the commanded cut: a slender tool bends away from the wall and leaves µm of
//    material; a stiff one does not
{
  const side = `(STOCK 60 30 20)
G21 G90 S12000 M3
G0 X-8 Y-3 Z5
G1 Z-12 F600
G1 X68 F1500
G0 Z5
M30`;
  const wallErr = cfg => {
    const sim = new Simulator();
    // the thin-wall model is off: this is about the tool bending
    sim.cfg.workpieceFlex = false;
    if (cfg.tool) Object.assign(sim.cfg.tool, cfg.tool);
    if (cfg.modal) sim.cfg.modal = cfg.modal;
    sim.load(side, { origin: 'corner' }); sim.speed = 2;
    while (!sim.done) sim.step(1 / 60);
    return sim.display.dev.ideal;
  };
  const slender = wallErr({ tool: { stickout: 45 } }), stiff = wallErr({ modal: { auto: false, k: 5e6, fn: 6000, zeta: 0.1 } });
  console.log(`side milling vs commanded: slender tool ${(slender.left * 1000).toFixed(1)} / ${(slender.gouge * 1000).toFixed(1)} µm, stiff tool ${(stiff.left * 1000).toFixed(1)} / ${(stiff.gouge * 1000).toFixed(1)} µm`);
  const big = v => Math.max(v.left, -v.gouge);
  assert.ok(big(slender) > 0.005 && big(slender) < 0.3, 'slender tool: µm-level wall error');
  assert.ok(big(stiff) < big(slender) / 5, 'stiff tool: much smaller');
}
// 5. the built-in sample: clean as written; without G42 on the first contour the boss is cut into
{
  const go = code => { const sim = new Simulator(); sim.load(code, { target: SAMPLES.boss.target() }); sim.speed = 8; while (!sim.done) sim.step(1 / 60); return sim.display.dev.target; };
  const ok = go(SAMPLES.boss.code);
  const lines = SAMPLES.boss.code.split('\n'), first = lines.findIndex(l => l.startsWith('G42'));
  const bad = go(lines.map((l, i) => i === first ? l.replace('G42 D1 ', '') : l).join('\n'));
  console.log(`sample as written: left ${(ok.left * 1000).toFixed(1)} µm, gouge ${(-ok.gouge * 1000).toFixed(1)} µm, ${(ok.inTol / ok.n * 100).toFixed(1)}% in tolerance; first G42 removed: gouge ${(-bad.gouge).toFixed(2)} mm at line ${bad.atGouge.line}`);
  assert.ok(ok.left < 0.05 && ok.inTol / ok.n > 0.99, 'sample program matches its target');
  assert.ok(bad.gouge < -2.4 && bad.atGouge.line === first + 1, 'missing G42 is caught on its line');
}
// 6. material the program never reaches counts against the target from the start
{
  const sim = new Simulator();
  sim.load('(STOCK 50 50 10)\nG0 X0 Y0 Z5\nM30', { origin: 'corner', target });
  const r = sim.deviationSummary();
  console.log(`program that cuts nothing: material left ${r.target.left.toFixed(2)} mm, ${(r.target.inTol / r.target.n * 100).toFixed(1)}% in tolerance`);
  assert.ok(Math.abs(r.target.left - 3) < 1e-6 && r.target.inTol === 0, 'uncut base reported as material left');
}
console.log('target tests passed');

// against the commanded cut: a chattering slot reads its lateral overcut (the wall pushed out by
// the vibration, well under the slot depth), and a stable cut reads µm, not a speckle cell's
// whole column
{
  const { Simulator: Sim } = await import('../src/sim.js');
  const slot = (tool, S, F, z) => `(STOCK 90 90 15)\n(TOOL T1 ${tool})\nG21 G90 G17\nT1 M6\nS${S} M3\nG0 X66 Y45 Z2\nG1 Z${z} F300\nG1 X74 F${F}\nG0 Z5\nG0 X-90 Y60\nM30`;
  const run = c => { const s = new Sim(); s.load(c, {}); while (!s.done) s.step(0.05); const d = s.deviationSummary().ideal; return { left: d.left, gouge: -d.gouge, chatter: s.report.lines.get(8).chatter }; };
  const a = run(slot('D6 N3 FLAT L20 SO30', 10000, 900, -3));
  assert.ok(a.chatter > 0 && a.gouge > 0.2 && a.gouge < 1.5, `chatter: lateral overcut ${a.gouge}`);
  const b = run(slot('D6 N3 FLAT L15 SO20', 16000, 1440, -1.5));
  assert.ok(b.left < 0.1 && b.gouge < 0.1, `stable: ${b.left} / ${b.gouge}`);
  console.log(`commanded-cut deviation: chatter ${a.gouge.toFixed(2)} mm lateral, stable ${(Math.max(b.left, b.gouge) * 1000).toFixed(0)} µm`);
}
