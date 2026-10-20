// Importing arbitrary programs and workpieces: G-code dialect, tool comments, STL stock.
import assert from 'assert/strict';
import { parseGcode, discretize, parseToolComment, decodeText } from '../src/gcode.js';
import { parseStl, buildStock, originPreset, stockFromPath } from '../src/workpiece.js';
import { Simulator } from '../src/sim.js';

const near = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`);

// ---------- tool comments ----------
{
  const f = parseToolComment('T1 D=10. CR=0. - ZMIN=-12. - flat end mill');
  assert.deepEqual([f.T, f.D, f.type], [1, 10, 'flat']);
  const b = parseToolComment('T2 D=6. CR=3. - ZMIN=-5. - ball end mill');
  assert.deepEqual([b.T, b.D, b.type], [2, 6, 'ball']);
  const own = parseToolComment('TOOL T3 D8 N4 FLAT L20 SO35');
  assert.deepEqual([own.T, own.D, own.N, own.fluteLen, own.stickout], [3, 8, 4, 20, 35]);
  const mc = parseToolComment(' T4 | 12. FLAT ENDMILL | H4 ');
  assert.deepEqual([mc.T, mc.D], [4, 12]);
  const jp = parseToolComment('T5 φ4 ボールエンドミル 2枚刃');
  assert.deepEqual([jp.T, jp.D, jp.type, jp.N], [5, 4, 'ball', 2]);
  assert.equal(parseToolComment('ROUGHING DEPTH 5'), null);
  assert.equal(parseToolComment('T6 no size'), null);
  console.log('tool comments ok');
}

// ---------- dialect ----------
{
  // CAM-style header, N numbers, work offset, tool length comp, G28 home and G95
  const { moves, warnings, meta } = parseGcode(`%
O1000 (SAMPLE)
(T1 D=10. CR=0. - flat end mill)
N10 G90 G94 G17 G21
N20 G28 G91 Z0.
N30 G90
N40 T1 M6
N50 S8000 M3
N60 G54 G0 X10. Y5.
N70 G43 Z15. H1
N80 G1 Z-2. F500.
N90 G95 X30. F0.05
N100 G94 G28 G91 Z0.
M30
X999`);
  assert.equal(meta.tools[1].D, 10);
  const last = moves[moves.length - 1];
  assert.equal(last.to.z, 50, 'G28 goes to the home height');
  const g95 = moves.find(m => m.line === 12);
  near(g95.F, 0.05 * 8000, 1e-9, 'G95 feed per rev → mm/min');
  assert.equal(g95.tool, 1);
  assert.ok(!moves.some(m => m.to.x === 999), 'stops at M30');
  assert.ok(!warnings.some(w => /G43|G54|G28/.test(w)), warnings.join());
  console.log('header/G28/G95 ok', warnings);
}
{
  // G18 arc: start below the centre, clockwise seen from +Y passes through −Z
  const { moves } = parseGcode('G90 G18\nG0 X0 Y0 Z0\nG2 X10 Z0 I5 K0 F100');
  const pts = discretize(moves, 0.2);
  const mid = pts.reduce((a, p) => (p.z < a.z ? p : a));
  near(mid.z, -5, 0.05, 'G18 arc depth'); near(mid.x, 5, 0.2, 'G18 arc x');
  assert.ok(pts.every(p => p.y === 0));
  // G19 with R
  const g19 = discretize(parseGcode('G19 G0 X0 Y0 Z0\nG3 Y10 Z0 R5 F100').moves, 0.2);
  const top = g19.reduce((a, p) => (p.z > a.z ? p : a));
  assert.ok(Math.abs(top.z) > 4.9 || Math.abs(g19.reduce((a, p) => Math.min(a, p.z), 0)) > 4.9);
  assert.ok(g19.every(p => p.x === 0));
  console.log('G18/G19 arcs ok');
}
{
  // drilling cycles: G81 with G99 then G98, G83 pecks, repeats in G91
  const { moves } = parseGcode(`G90 G0 Z20
S3000 M3
G99 G81 X10 Y10 Z-5 R2 F100
X20
G98 X30
G80
G0 Z30
G83 X40 Y10 Z-10 R2 Q4 F100
G80`);
  const holes = moves.filter(m => !m.rapid && m.to.z === -5);
  assert.equal(holes.length, 3, 'three G81 holes');
  const after2 = moves.filter(m => m.line === 4);
  assert.equal(after2[after2.length - 1].to.z, 2, 'G99 returns to R');
  const after3 = moves.filter(m => m.line === 5);
  assert.equal(after3[after3.length - 1].to.z, 20, 'G98 returns to the initial level');
  const pecks = moves.filter(m => m.line === 8 && !m.rapid);
  assert.deepEqual(pecks.map(m => m.to.z), [-2, -6, -10], 'G83 pecks of 4 mm');
  assert.equal(moves.filter(m => m.line === 8).slice(-1)[0].to.z, 30);
  const inc = parseGcode('G90 G0 X0 Y0 Z10\nM3\nG91 G99 G81 X10 Z-5 R-8 K3 F100\nG80').moves;
  assert.deepEqual(inc.filter(m => !m.rapid).map(m => [m.to.x, m.to.z]), [[10, -3], [20, -3], [30, -3]]);
  console.log('canned cycles ok');
}
{
  const { warnings } = parseGcode('G90 X1000 Y20\n#100=5\nG1 X#100\nM98 P100');
  assert.ok(warnings.some(w => /小数点/.test(w)));
  assert.ok(warnings.some(w => /マクロ/.test(w)));
  assert.ok(warnings.some(w => /O100/.test(w)), 'M98 to a missing subprogram is reported');
  // Shift_JIS comment
  const sjis = new Uint8Array([0x28, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x29, 0x0a, 0x47, 0x30]); // (テスト)\nG0
  assert.equal(decodeText(sjis), '(テスト)\nG0');
  assert.equal(decodeText(new TextEncoder().encode('(φ10)')), '(φ10)');
  console.log('warnings/encodings ok');
}

// ---------- STL stock ----------
function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.map(t => t.map(i => v[i]));
}
function binaryStl(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, k) => t.forEach((p, i) => p.forEach((c, j) => dv.setFloat32(84 + k * 50 + 12 + (i * 3 + j) * 4, c, true))));
  return buf;
}
const asciiStl = tris => 'solid t\n' + tris.map(t => ` facet normal 0 0 1\n  outer loop\n${t.map(p => `   vertex ${p.join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n') + '\nendsolid t\n';
// an L-shaped casting in CAD coordinates: 60×40 base 10 high plus a 20×40 block up to 25
const L = [...boxTris(-30, -20, 100, 30, 20, 110), ...boxTris(10, -20, 110, 30, 20, 125)];
{
  const bin = parseStl(binaryStl(L)), asc = parseStl(new TextEncoder().encode(asciiStl(L)));
  assert.equal(bin.count, 24); assert.equal(asc.count, 24);
  assert.deepEqual(bin.min, [-30, -20, 100]); assert.deepEqual(bin.max, [30, 20, 125]);
  for (const spec of [{ type: 'stl', ...bin }, { type: 'stl', ...asc }]) {
    const s = buildStock(spec, 0.5);
    assert.equal(s.w, 60); assert.equal(s.l, 40); assert.equal(s.zBottom, -25);
    near(s.sample(10, 20), -15, 1e-6, 'low step');
    near(s.sample(50, 20), 0, 1e-6, 'high block');
    near(s.sample(0, 0), -15, 1e-6, 'corner covered');
    near(s.sample(60, 40), 0, 1e-6, 'far corner covered');
    let gaps = 0; for (let k = 0; k < s.H.length; k++) if (s.H[k] === s.zBottom) gaps++;
    assert.equal(gaps, 0, 'no cracks on shared edges');
  }
  const o = originPreset({ type: 'stl', ...bin }, 'model');
  assert.deepEqual(o, { x: 30, y: 20, z: -125 });
  // a ring (through-hole): nodes inside the hole are empty
  const ring = [];
  const n = 48, r0 = 8, r1 = 20;
  for (let i = 0; i < n; i++) {
    const a = i / n * 2 * Math.PI, b = (i + 1) / n * 2 * Math.PI;
    const P = (r, t, z) => [r * Math.cos(t), r * Math.sin(t), z];
    ring.push([P(r0, a, 10), P(r1, a, 10), P(r1, b, 10)], [P(r0, a, 10), P(r1, b, 10), P(r0, b, 10)]);
  }
  const rs = buildStock({ type: 'stl', ...parseStl(binaryStl(ring)) }, 0.5);
  near(rs.sample(rs.w / 2, rs.l / 2), rs.zBottom, 1e-9, 'hole empty');
  near(rs.sample(rs.w / 2 + 14, rs.l / 2), 0, 1e-9, 'ring top');
  console.log('STL rasterization ok');
}

// ---------- simulator with imported stock, origin and tool changes ----------
{
  const spec = { type: 'stl', ...parseStl(binaryStl(L)) };
  const prog = `(T1 D=10. CR=0. - flat end mill)
(T2 D=6. CR=3. - ball end mill)
G90 G21 G17
T1 M6
S12000 M3
G0 X-40 Y0 Z130
G0 Z123
G1 X40 F1500
G0 Z140
T2 M6
S15000 M3
G0 X-40 Y-10 Z108
G1 X40 F1200
G0 Z140
M30`;
  const sim = new Simulator();
  sim.load(prog, { stock: spec, origin: originPreset(spec, 'model') });
  assert.equal(sim.stock.nx, 201);
  assert.equal(sim.activeT, 1); assert.equal(sim.activeTool.D, 10);
  // the program's start/home height is above the model top, not inside it
  assert.ok(sim.path[0].z > 0, `start z ${sim.path[0].z}`);
  const seen = new Set();
  sim.speed = 20;
  let guard = 0;
  while (!sim.done && guard++ < 20000) { sim.step(1 / 30); seen.add(`${sim.activeT}:${sim.activeTool.D}:${sim.activeTool.type}`); }
  assert.ok(seen.has('1:10:flat') && seen.has('2:6:ball'), [...seen].join());
  // T1 skimmed 2 mm off the high block, T2 cut the base 2 mm deep (ball tip at Z108 = 2 below 110)
  near(sim.stock.sample(50, 20), -2, 0.05, 'T1 depth');
  near(sim.stock.sample(20, 10), -15 - 2, 0.05, 'T2 ball bottom');
  assert.ok(sim.stock.sample(20, 10 + 2.9) > -17, 'ball profile, not flat');
  console.log('simulator import ok, removed', sim.stock.removed.toFixed(0), 'mm³');
}
{
  // no stock given: a box under the cutting moves, origin moved so they land inside it
  const sim = new Simulator();
  sim.load('G90 G0 X-50 Y-20 Z5\nM3 S10000\nG1 Z-3 F500\nG1 X50 F1000\nG1 Y20\nG0 Z5');
  assert.deepEqual([sim.stockSize.w, sim.stockSize.l, sim.stockSize.h], [100, 40, 8]);
  assert.ok(sim.warnings[0].includes('仮定'));
  const auto = stockFromPath(sim.path);
  near(auto.origin.x, 0, 1e-9, "already in the stock frame");
  // cylinder stock from a comment
  const cyl = new Simulator();
  cyl.load('(STOCK CYL 50 20)\nG0 X0 Y0 Z5');
  assert.equal(cyl.stockSize.w, 50);
  near(cyl.stock.sample(25, 25), 0, 1e-9); near(cyl.stock.sample(1, 1), -20, 1e-9, 'outside the bar');
  // a program written about the top centre of a 100×60 box: the origin is found automatically
  const c = new Simulator();
  c.load('G90 G0 X-40 Y-20 Z5\nM3 S10000\nG1 Z-2 F500\nG1 X40\nG1 Y20\nG1 X-40\nG0 Z5', { stock: { type: 'box', w: 100, l: 60, h: 20 } });
  assert.deepEqual(c.origin, { x: 50, y: 30, z: 0 });
  assert.ok(c.warnings.some(w => w.includes('上面の中心')));
  const m = new Simulator();
  m.load('G0 X0 Y0 Z5', { stock: { type: 'box', w: 100, l: 60, h: 20 }, origin: { x: 10, y: 10, z: -20 } });
  near(m.path[0].z, 50, 1e-9, 'start 50 above the top in the stock frame');
  console.log('auto/cylinder stock and origin ok');
}
{
  // the bundled samples are written about the stock corner, except the CAM-style one (top centre)
  const { SAMPLES } = await import('../src/samples.js');
  for (const [k, smp] of Object.entries(SAMPLES)) {
    const sim = new Simulator(); sim.load(smp.code);
    assert.deepEqual(sim.origin, k === 'cam' ? { x: 50, y: 35, z: 0 } : { x: 0, y: 0, z: 0 }, k);
  }
  console.log('sample origins ok');
}
console.log('import tests passed');

// ---------- mesh files: OBJ, units, up axis, rotation ----------
{
  const { parseObj, parseMesh, orientMesh } = await import('../src/workpiece.js');
  // a 100 × 50 × 20 mm block written in metres, Y up (height along Y), as a CAD export
  const v = [[0, 0, 0], [0.1, 0, 0], [0.1, 0.02, 0], [0, 0.02, 0], [0, 0, 0.05], [0.1, 0, 0.05], [0.1, 0.02, 0.05], [0, 0.02, 0.05]];
  const f = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]];
  const obj = '# block\n' + v.map(p => `v ${p.join(' ')}`).join('\n') + '\n' + f.map(q => `f ${q.map(i => `${i}//1`).join(' ')}`).join('\n');
  const m = parseMesh(new TextEncoder().encode(obj), 'block.obj');
  assert.equal(m.count, 12, 'quads fanned into triangles');
  const o = orientMesh(m, { unit: 'auto', up: 'Y' });
  const size = o.max.map((x, k) => +(x - o.min[k]).toFixed(6));
  assert.equal(o.scale, 1000, 'metres detected');
  assert.deepEqual(size, [100, 50, 20], 'Y-up height becomes Z');
  const r = orientMesh(m, { unit: 'm', up: 'Y', rotZ: 90 });
  assert.deepEqual(r.max.map((x, k) => +(x - r.min[k]).toFixed(6)), [50, 100, 20], 'turned 90° about Z');
  assert.throws(() => parseObj(new TextEncoder().encode('v 0 0 0\nf 1 2 3')), /頂点/);
  // and it builds a stock whose top is the block's top
  const { buildStock } = await import('../src/workpiece.js');
  const st = buildStock({ type: 'stl', ...o }, 1);
  assert.equal(st.w, 100); assert.equal(st.l, 50);
  assert.ok(st.H.every(h => Math.abs(h) < 1e-6), 'flat top at Z0');
  console.log('mesh import: OBJ, metres → mm, Y up → Z up, rotation OK');
}
