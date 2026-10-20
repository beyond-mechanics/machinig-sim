// Custom macro B: expressions, variables in words, IF/GOTO, WHILE/DO/END, bad syntax reported.
import assert from 'node:assert/strict';
import { evalExpr, substitute } from '../src/macro.js';
import { parseGcode } from '../src/gcode.js';

const v = new Map([[1, 5], [2, -2.5]]);
assert.equal(evalExpr('#1*2+SIN[30]', v), 10.5);
assert.equal(evalExpr('[#1+1]/2 GT 2', v), 1);
assert.equal(evalExpr('FIX[-2.7]+FUP[2.1]+ROUND[2.5]', v), -2 + 3 + 3);
assert.equal(evalExpr('#[#1-4]', v), 5); // #1
assert.equal(substitute('G1X-#2Y[#1*2]Z#9F100', v), 'G1X2.5Y10.0Z0.0F100');

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
console.log('macro tests passed');
