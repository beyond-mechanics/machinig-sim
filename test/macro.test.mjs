// Custom macro B: expressions, variables in words, IF/GOTO, WHILE/DO/END, bad syntax reported.
import assert from 'node:assert/strict';
import { evalExpr, substitute } from '../src/macro.js';
import { parseGcode } from '../src/gcode.js';

const v = new Map([[1, 5], [2, -2.5]]);
assert.equal(evalExpr('#1*2+SIN[30]', v), 10.5);
assert.equal(evalExpr('[#1+1]/2 GT 2', v), 1);
assert.equal(evalExpr('FIX[-2.7]+FUP[2.1]+ROUND[2.5]', v), -2 + 3 + 3);
assert.equal(evalExpr('#[#1-4]', v), 5); // #1
assert.equal(substitute('G1X-#2Y[#1*2]Z#9F100', v), 'G1X2.5Y10.0F100'); // vacant #9: Z left out

// a row of five holes 12 mm apart with a WHILE loop, then a depth chosen by IF/GOTO
const prog = `G21 G90 G17
S6000 M3
#1 = 0 (hole counter)
#5 = 12
WHILE [#1 LT 5] DO1
G0 X[#1 * #5] Y10 Z2
G1 Z-3 F200
G0 Z2
#1 = #1 + 1
END1
#2 = 7
IF [#2 GT 5] GOTO 20
G1 Z-1
N20 G1 X70 Z-#2
M30`;
const { moves, warnings } = parseGcode(prog);
const drills = moves.filter(m => m.line === 7);
assert.deepEqual(drills.map(m => m.to.x), [0, 12, 24, 36, 48], 'five holes along X');
assert.ok(!moves.some(m => m.line === 13), 'IF jumped over line 13');
assert.equal(moves[moves.length - 1].to.z, -7);
assert.equal(warnings.length, 0, warnings.join(' / '));

// a bad expression is reported and its block skipped; a loop without end stops at the line cap
const bad = parseGcode('#1 = [2 +\nG0 X1 Y1 Z1\nM30');
assert.ok(bad.warnings.some(w => /マクロ/.test(w)) && bad.moves.length === 1);
const forever = parseGcode('N1 G91 G0 X0.001\nGOTO 1');
assert.ok(forever.warnings.some(w => /打ち切り/.test(w)));
console.log(`macro: ${drills.length} holes from a WHILE loop, IF/GOTO jumps, ${bad.warnings.length} warning for a bad expression`);
// G65: a hole macro called with its arguments, local variables restored afterwards
{
  const g = parseGcode(`G21 G90 G17
S6000 M3
#1 = 99
G65 P9100 X10 Y20 Z-4 L1
G65 P9100 X30 Y20 Z-6
G0 X#1
M30
O9100 (HOLE: X=#24 Y=#25 DEPTH=#26)
G0 X#24 Y#25 Z2
G1 Z#26 F200
G0 Z2
M99`);
  const holes = g.moves.filter(m => m.line === 10);
  assert.deepEqual(holes.map(m => [m.to.x, m.to.z]), [[10, -4], [30, -6]]);
  assert.equal(g.moves[g.moves.length - 1].to.x, 99, 'the caller keeps its #1');
  assert.equal(g.warnings.length, 0, g.warnings.join(' / '));
}
// review fixes: N numbers within the program, DO numbers per call level, N before G65,
// vacant variables, /0 as an error, ROUND of negatives, M99 P
{
  const xs = g => g.moves.map(m => `${m.to.x},${m.to.y}`).join(' ');
  let g = parseGcode('G21 G90\nS5000 M3\nN10 G0 X1\nG65 P9000\nM30\nO9000\nN5 G0 X2\n#1=#1+1\nIF[#1 GE 2] GOTO 10\nGOTO 5\nN10 G0 Y7\nM99');
  assert.equal(xs(g), '1,0 2,0 2,7', 'GOTO 10 inside O9000 goes to its own N10');
  g = parseGcode('G21 G90\nS5000 M3\n#100=0\nWHILE[#100 LT 2] DO1\nG65 P9000\n#100=#100+1\nEND1\nG0 X99\nM30\nO9000\n#2=0\nWHILE[#2 LT 1] DO1\nG0 Y[#100+1]\n#2=#2+1\nEND1\nM99');
  assert.equal(xs(g), '0,1 0,2 99,2', 'the caller keeps its DO1');
  g = parseGcode('G21 G90\nS5000 M3\nN100 G65 P9000 X10\nM30\nO9000\nG0 X#24 Y#25\nIF[#26 EQ #0] GOTO 9\nG0 Y5\nN9 M99');
  assert.equal(xs(g), '10,0', 'N100 G65 calls; a vacant #25 leaves Y out; vacant EQ #0');
  g = parseGcode('G21 G90\nS5000 M3\nG65 P9000 Z0\nM30\nO9000\nIF[#26 EQ #0] GOTO 9\nG0 Y5\nN9 M99');
  assert.equal(xs(g), '0,5', 'Z0 given is not vacant');
  g = parseGcode('G21 G90\nS5000 M3\n#1=0\nG1 X[10/#1] Y3 F100\nG0 X[ROUND[-2.5]]');
  assert.equal(xs(g), '-3,0'); assert.match(g.warnings[0], /計算できない/);
  g = parseGcode('G21 G90\nS5000 M3\nM98 P100\nG0 X1\nN50 G0 X50\nM30\nO100\nG0 Y1\nM99 P50');
  assert.equal(xs(g), '0,1 50,1', 'M99 P50 returns to N50');
}
console.log('macro tests passed');
