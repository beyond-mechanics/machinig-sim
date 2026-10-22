// Subprograms: M98 calls an O-numbered block L times (or the packed P<times><number>), M99
// returns; nested calls; the moves keep the line numbers of the subprogram's own lines.
import assert from 'node:assert/strict';
import { parseGcode } from '../src/gcode.js';

const prog = `O1000 (MAIN)
G21 G90 G17
S8000 M3
G0 X0 Y0 Z5
M98 P2000 L3
G0 X50
M98 P0024000
M98 P3000
G0 Z50
M30
O2000 (ONE SLOT, STEPPING DOWN IN G91)
G91 G1 Z-1 F300
G1 X10 F800
G0 Z1
G0 X-10
G90
M99
O4000
G91 G0 Y5
G90
M99
O3000
M98 P4000
M99`;
const { moves, warnings } = parseGcode(prog);
const feeds = moves.filter(m => !m.rapid);
// 3 passes of O2000: each a plunge and a slot
assert.equal(feeds.filter(m => m.line === 13).length, 3, 'slot line run 3 times');
assert.deepEqual(feeds.filter(m => m.line === 12).map(m => +m.to.z.toFixed(3)), [4, 4, 4], 'G91 steps from where each pass starts');
// P0024000: O4000 twice → two Y steps; O3000 calls it once more (nested)
const ysteps = moves.filter(m => m.line === 19);
assert.equal(ysteps.length, 3);
assert.equal(+moves[moves.length - 1].to.y.toFixed(3), 15);
assert.ok(!warnings.some(w => /見つかりません|深すぎ/.test(w)), warnings.join(' / '));
// a missing subprogram is reported and skipped
const r = parseGcode('G0 X0 Y0 Z5\nM98 P9999\nG0 X5\nM30');
assert.ok(r.warnings.some(w => /O9999/.test(w)) && r.moves.length >= 1);
console.log(`subprograms: ${moves.length} moves, slot line run ${feeds.filter(m => m.line === 13).length}×, Y steps ${ysteps.length}`);
console.log('subprog tests passed');
