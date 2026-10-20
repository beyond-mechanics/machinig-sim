// Work coordinate systems: G54-G59 and G54.1 P, the position carried across a change of system,
// G52 local shifts, and the simulator cutting each part at its own zero.
import assert from 'node:assert/strict';
import { parseGcode, discretize } from '../src/gcode.js';
import { Simulator } from '../src/sim.js';

const W = { G54: { x: 0, y: 0, z: 0 }, G55: { x: 60, y: 5, z: -2 }, 'G54.1P2': { x: -10, y: 30, z: 0 } };
// end points of the moves in the common frame (what the simulator does with each move)
const frame = mv => { const z = W[mv.wcs] || W.G54, l = mv.local; return { x: mv.to.x + z.x + l.x, y: mv.to.y + z.y + l.y, z: mv.to.z + z.z + l.z }; };

// 1. each system's coordinates are measured from its own zero
{
  const { moves, meta, warnings } = parseGcode('G90 G54 G0 X10 Y10 Z5\nG55 G0 X10 Y10 Z5\nG54.1 P2 G0 X10 Y10 Z5', { wcs: W });
  assert.deepEqual(meta.workOffsets, ['G54', 'G55', 'G54.1P2']);
  assert.deepEqual(moves.map(m => m.wcs), ['G54', 'G55', 'G54.1P2']);
  assert.deepEqual(moves.map(frame), [{ x: 10, y: 10, z: 5 }, { x: 70, y: 15, z: 3 }, { x: 0, y: 40, z: 5 }]);
  assert.equal(warnings.length, 0);
}

// 2. switching systems does not move the tool: an incremental move continues from where it is
{
  const { moves } = parseGcode('G90 G54 G0 X10 Y10 Z5\nG55\nG91 G0 X1\nG90', { wcs: W });
  assert.deepEqual(frame(moves[1]), { x: 11, y: 10, z: 5 });
  assert.deepEqual(moves[1].from, { x: 10 - 60, y: 10 - 5, z: 5 + 2 }, 'position re-expressed in G55');
}

// 3. G52 shifts the zero inside the system; G52 X0 Y0 Z0 cancels it
{
  const { moves } = parseGcode('G90 G0 X0 Y0 Z5\nG52 X20 Y-5\nG0 X1 Y1\nG52 X0 Y0 Z0\nG0 X1 Y1', { wcs: W });
  assert.deepEqual(frame(moves[1]), { x: 21, y: -4, z: 5 });
  assert.deepEqual(frame(moves[2]), { x: 1, y: 1, z: 5 });
}

// 4. a system without a zero coincides with G54, with a warning
{
  const { moves, warnings } = parseGcode('G90 G56 G0 X10 Y10 Z5', { wcs: W });
  assert.deepEqual(frame(moves[0]), { x: 10, y: 10, z: 5 });
  assert.ok(warnings.some(w => w.includes('G56')));
}

// 5. the simulator cuts the same pocket at G54 and at G55 (60 mm to the right)
{
  const pocket = `G0 X10 Y10 Z2\nG1 Z-2 F600\nG1 X20 F1200\nY20\nX10\nY10\nG0 Z5`;
  const code = `(STOCK 100 40 10)\nG21 G90 S10000 M3\nG54\n${pocket}\nG55\n${pocket}\nM30`;
  const sim = new Simulator();
  sim.load(code, { origin: 'corner', wcs: { G55: { x: 60, y: 0, z: 0 } } });
  sim.speed = 8;
  while (!sim.done) sim.step(1 / 60);
  const s = sim.stock, at = (x, y) => s.H[Math.round(y / s.hy) * s.nx + Math.round(x / s.hx)];
  console.log(`depth at the G54 pocket ${at(15, 15).toFixed(2)}, at the G55 pocket ${at(75, 15).toFixed(2)}, between ${at(45, 15).toFixed(2)} mm; warnings`, sim.warnings);
  assert.ok(Math.abs(at(15, 15) + 2) < 0.01 && Math.abs(at(75, 15) + 2) < 0.01, 'both pockets cut');
  assert.equal(at(45, 15), 0, 'nothing between them');
  assert.deepEqual(sim.wcsUsed, ['G54', 'G55']);
}
console.log('wcs tests passed');

// G10 L2 / L20: offsets written by the program, placed by their difference from G54's G10 value
{
  const prog = 'G21 G90\nG10 L2 P1 X-300 Y-200 Z-400\nG10 L2 P2 X-250 Y-200 Z-402\nG10 L20 P3 X-300 Y-150 Z-400\nG54 G0 X0 Y0 Z5\nG55 G0 X0 Y0 Z5\nG54.1 P3 G0 X0 Y0 Z5\nG91 G10 L2 P2 X1\nG90 G55 G0 X0 Y0';
  const { moves, warnings, meta } = parseGcode(prog, { wcs: W });
  const at = mv => { const z = mv.zero, l = mv.local; return { x: mv.to.x + z.x + l.x, y: mv.to.y + z.y + l.y, z: mv.to.z + z.z + l.z }; };
  assert.deepEqual(moves.map(at), [{ x: 0, y: 0, z: 5 }, { x: 50, y: 0, z: 3 }, { x: 0, y: 50, z: 5 }, { x: 51, y: 0, z: 5 }]); // no Z on the last block: the tool keeps its height
  assert.equal(moves.length, 4, 'G10 blocks make no motion');
  assert.deepEqual(meta.g10Zero.G55, { x: 51, y: 0, z: -2 });
  assert.equal(warnings.length, 0, warnings.join(' / '));
  // without a G10 for G54 the screen's offsets are used, with a warning
  const b = parseGcode('G10 L2 P2 X-250 Y-200 Z-402\nG55 G0 X0 Y0 Z5', { wcs: W });
  assert.deepEqual(frame(b.moves[0]), { x: 60, y: 5, z: 3 });
  assert.ok(b.warnings.some(w => /G10/.test(w)));
}
console.log('G10 offsets ok');
