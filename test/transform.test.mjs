// G68 coordinate rotation and G51.1 mirror images: end points, arc centres and directions,
// the compensation side, and the tool staying put when a transformation starts.
import assert from 'node:assert/strict';
import { parseGcode } from '../src/gcode.js';

const r3 = p => [p.x, p.y, p.z].map(v => Math.round(v * 1000) / 1000 + 0);
// 1. G68 R90 about (10, 0): X20 Y0 → (10, 10); incremental moves follow the rotated axes
{
  const g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X10 Y0 Z5\nG68 X10 Y0 R90\nG1 X20 Y0 F500\nG91 G1 X5\nG90 G69\nG0 X0 Y0');
  assert.deepEqual(g.moves.map(m => r3(m.to)), [[10, 0, 5], [10, 10, 5], [10, 15, 5], [0, 0, 5]]);
  assert.equal(g.warnings.length, 0, g.warnings.join(' / '));
}
// 2. the same pocket called four times at 0, 90, 180, 270° (a common bolt-circle pattern)
{
  const g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X0 Y0 Z5\n#1=0\nWHILE[#1 LT 4] DO1\nG68 X0 Y0 R[#1*90]\nM98 P100\nG69\n#1=#1+1\nEND1\nM30\nO100\nG0 X20 Y0\nG1 Z-1 F200\nG0 Z5\nM99');
  const holes = g.moves.filter(m => m.line === 14).map(m => r3(m.to).slice(0, 2));
  assert.deepEqual(holes, [[20, 0], [0, 20], [-20, 0], [0, -20]]);
}
// 3. G51.1 X0: X mirrored, a G2 arc becomes G3 about the mirrored centre, G41 becomes G42
{
  const g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X0 Y0 Z5\nG51.1 X0\nG41 G1 X10 Y0 F500\nG2 X20 Y0 I5 J0\nG40 G1 X30\nG50.1\nG0 X40');
  const [, a, b, c, d] = g.moves;
  assert.deepEqual(r3(a.to), [-10, 0, 5]); assert.equal(a.comp, 42);
  assert.deepEqual([b.arc.ca, b.arc.cb, b.arc.cw], [-15, 0, false]);
  assert.deepEqual(r3(c.to), [-30, 0, 5]); assert.deepEqual(r3(d.to), [40, 0, 5]);
}
// 4. starting a transformation does not move the tool
{
  const g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X10 Y5 Z5\nG68 X0 Y0 R30\nG91 G1 Z-1 F100');
  assert.deepEqual(r3(g.moves[1].from), [10, 5, 5]); assert.deepEqual(r3(g.moves[1].to), [10, 5, 4]);
}
// the rest of a transformation block still runs (G69 with motion, G55 and M98 with G68), and a
// change of system or G52 under rotation keeps the tool where it is
{
  let g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X0 Y0 Z5\nG68 X0 Y0 R90\nG69 G0 X50 Y50');
  assert.deepEqual(r3(g.moves[g.moves.length - 1].to), [50, 50, 5]);
  g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X0 Y0 Z5\nG55 G68 X0 Y0 R30\nG0 X1', { wcs: { G55: { x: 100, y: 0, z: 0 } } });
  assert.deepEqual(g.meta.workOffsets, ['G55']);
  g = parseGcode('G21 G90 G17\nS6000 M3\nG0 X0 Y0 Z5\nG68 X0 Y0 R90 M98 P100\nM30\nO100\nG0 X10\nM99');
  assert.deepEqual(r3(g.moves[1].to), [0, 10, 5]);
  g = parseGcode('G21 G90 G17\nS6000 M3\nG68 X0 Y0 R90\nG0 X10 Y0 Z5\nG52 X5\nG91 G1 X1 F100');
  const m = g.moves[g.moves.length - 1], at = p => r3({ x: p.x + m.local.x, y: p.y + m.local.y, z: p.z });
  assert.deepEqual(at(m.from), [0, 10, 5]); assert.deepEqual(at(m.to), [0, 11, 5]);
}
console.log('transform tests passed');
