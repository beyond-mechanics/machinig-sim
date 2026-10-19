// Tool and holder import: stepped-beam stiffness, STL silhouettes, tip shapes, interference.
import assert from 'assert/strict';
import { toolModel } from '../src/tool.js';
import { assemblyModel, holderSegs, silhouette, toolFromStl, tipLut, LUT_DR, parseToolLibrary, outline } from '../src/assembly.js';
import { Simulator } from '../src/sim.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b} (±${tol})`);
const base = { D: 10, N: 3, helixDeg: 30, type: 'flat', fluteLen: 25, stickout: 30, kSpindle: 50000 };

// ---------- stiffness ----------
{
  // a uniform beam (flutes over the whole stickout) must give 3EI/L³ in series with the spindle
  const t = { ...base, fluteLen: 30, shankD: 10.001 };
  const m = assemblyModel(t);
  const I = Math.PI * 8 ** 4 / 64, kBeam = 3 * 600000 * I / 30 ** 3;
  near(m.kTool, kBeam, kBeam * 0.005, 'stepped integration vs 3EI/L³');
  near(m.k, 1 / (1 / kBeam + 1 / 50000), 30, 'series with the spindle');
  // with no holder and a plain shank the original uniform model (and its tuned defaults) stays
  const legacy = toolModel(base);
  near(legacy.k, 10570, 10); near(legacy.fn, 2200, 5);
  // a full-diameter shank is stiffer than treating it as flutes; a holder adds compliance
  const shank = toolModel({ ...base, shankD: 10.0001 }), shrink = toolModel({ ...base, holderSegs: holderSegs('shrink', 10) });
  assert.ok(shank.k > legacy.k && shrink.k < shank.k, `${shank.k} ${shrink.k}`);
  // long reach: a necked tool is softer than a full shank, and both are far softer than short
  const long = toolModel({ ...base, stickout: 60, holderSegs: holderSegs('shrink', 10) });
  const neck = toolModel({ ...base, stickout: 60, fluteLen: 15, neckD: 9, neckLen: 55, holderSegs: holderSegs('shrink', 10) });
  assert.ok(neck.k < long.k && long.k < shrink.k / 2);
  console.log(`k: uniform ${(m.kTool / 1e3).toFixed(2)} (theory ${(kBeam / 1e3).toFixed(2)}) N/µm, shrink-fit L30 ${(shrink.k / 1e3).toFixed(1)} N/µm ${shrink.fn.toFixed(0)} Hz, L60 ${(long.k / 1e3).toFixed(2)} N/µm, necked ${(neck.k / 1e3).toFixed(2)} N/µm`);
}

// ---------- meshes ----------
// revolve a profile [[z, r], ...] (z up from the tip) into an STL-like triangle soup
function revolve(prof, n = 64, dx = 0, dy = 0) {
  const tris = [];
  const P = (r, a, z) => [dx + r * Math.cos(a), dy + r * Math.sin(a), z];
  for (let k = 0; k < prof.length - 1; k++) {
    const [z0, r0] = prof[k], [z1, r1] = prof[k + 1];
    for (let i = 0; i < n; i++) {
      const a = i / n * 2 * Math.PI, b = (i + 1) / n * 2 * Math.PI;
      tris.push(P(r0, a, z0), P(r0, b, z0), P(r1, b, z1), P(r0, a, z0), P(r1, b, z1), P(r1, a, z1));
    }
  }
  const flat = new Float32Array(tris.flat());
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < flat.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], flat[i + k]); max[k] = Math.max(max[k], flat[i + k]); }
  return { tris: flat, min, max, count: flat.length / 9 };
}
{
  // a 118° drill φ8 with a φ8 shank, placed off the origin: the axis comes from the bounding box
  const tipH = 4 / Math.tan(59 * Math.PI / 180);
  const drill = revolve([[0, 0], [tipH, 4], [40, 4], [70, 4]], 96, 30, -12);
  const t = toolFromStl(drill, 40);
  near(t.D, 8, 0.02, 'drill diameter');
  const lut = tipLut({ ...base, ...t });
  near(lut[Math.round(2 / LUT_DR)], tipH / 2, 0.05, 'cone half way');
  near(lut[lut.length - 1], tipH, 0.1, 'cone rim (one silhouette step)');
  // a φ10 ball end mill
  const ball = [];
  for (let k = 0; k <= 30; k++) { const a = k / 30 * Math.PI / 2; ball.push([5 - 5 * Math.cos(a), 5 * Math.sin(a)]); }
  ball.push([30, 5]);
  const bt = toolFromStl(revolve(ball, 96), 20);
  const bl = tipLut({ ...base, ...bt });
  for (const r of [1, 3, 4.5]) near(bl[Math.round(r / LUT_DR)], 5 - Math.sqrt(25 - r * r), 0.06, `ball lut r=${r}`);
  const sil = silhouette(revolve([[0, 20], [60, 20], [60, 31.5], [100, 31.5]], 64));
  near(sil.r[Math.round(30 / sil.dz)], 20, 0.05); near(sil.r[Math.round(80 / sil.dz)], 31.5, 0.05);
  console.log('STL silhouettes ok');
}

// ---------- simulator: tip shape, interference, libraries ----------
{
  // bull nose R1 φ10: the slot floor keeps the corner radius at the edge
  const sim = new Simulator();
  sim.load('(STOCK 60 40 20)\n(TOOL T1 D10 N3 FLAT L25)\nT1 M6\nS10000 M3\nG0 X-10 Y20 Z5\nG0 Z-3\nG1 X70 F800\nG0 Z5\nM30');
  sim.tools[1].type = 'bull'; sim.tools[1].cornerR = 1; sim.reconfigure();
  assert.equal(sim.activeTool.type, 'bull');
  sim.speed = 25; let g = 0; while (!sim.done && g++ < 20000) sim.step(1 / 30);
  near(sim.stock.sample(30, 20), -3, 0.02, 'flat centre');
  near(sim.stock.sample(30, 20 + 4.5), -3 + 1 - Math.sqrt(1 - 0.5 ** 2), 0.08, 'corner radius');
  console.log('bull nose floor ok');
}
const deepPocket = `(STOCK 80 80 60)
(TOOL T1 D10 N3 FLAT L25 SO30)
T1 M6
S8000 M3
G0 X40 Y40 Z5
G1 Z-40 F200
G1 X50 F600
G0 Z50
M30`;
{
  // a 40 mm deep cut with 30 mm stickout puts a shrink-fit holder into the stock
  const sim = new Simulator(); sim.cfg.tool.holder = 'shrink';
  sim.load(deepPocket); sim.speed = 25;
  let g = 0, minC = Infinity; while (!sim.done && g++ < 20000) { sim.step(1 / 30); if (sim.display.clearance != null) minC = Math.min(minC, sim.display.clearance); }
  const msgs = [...sim.alerts.values()].map(a => a.msg);
  assert.ok(msgs.some(m => m.startsWith('ホルダー')), msgs.join());
  assert.ok(sim.hits.length > 0 && minC < -5, `${minC}`);
  // the same program with a 50 mm stickout clears (the shank is as wide as the cutter)
  const ok = new Simulator(); ok.cfg.tool.holder = 'shrink';
  ok.load(deepPocket.replace('SO30', 'SO50')); ok.speed = 25;
  g = 0; minC = Infinity; while (!ok.done && g++ < 20000) { ok.step(1 / 30); if (ok.display.clearance != null) minC = Math.min(minC, ok.display.clearance); }
  assert.ok(![...ok.alerts.keys()].some(k => k.startsWith('hit-')), [...ok.alerts.values()].map(a => a.msg).join());
  assert.ok(minC > 0, `clearance ${minC}`);
  console.log(`interference: holder ${msgs.find(m => m.startsWith('ホルダー'))}; with SO50 min clearance ${minC.toFixed(1)} mm`);
}
{
  const json = JSON.stringify({ data: [
    { type: 'flat end mill', unit: 'millimeters', description: '10mm 3FL', vendor: 'ACME', geometry: { DC: 10, NOF: 3, LCF: 22, LB: 45, OAL: 75, SFDM: 10, RE: 0 },
      holder: { description: 'BT40 shrink', segments: [{ height: 60, 'lower-diameter': 20, 'upper-diameter': 40 }, { height: 20, 'lower-diameter': 63, 'upper-diameter': 63 }] }, 'post-process': { number: 1 } },
    { type: 'bull nose end mill', unit: 'inches', geometry: { DC: 0.5, NOF: 4, LCF: 1, LB: 2, SFDM: 0.5, RE: 0.03 }, 'post-process': { number: 7 } },
    { type: 'holder', description: 'just a holder' },
    { type: 'probe', geometry: { DC: 6 } },
  ] });
  const { tools, skipped } = parseToolLibrary(json);
  assert.equal(tools.length, 2); assert.deepEqual(skipped, ['probe']);
  assert.deepEqual([tools[0].T, tools[0].D, tools[0].N, tools[0].fluteLen, tools[0].stickout], [1, 10, 3, 22, 45]);
  assert.deepEqual(tools[0].holderSegs, [[60, 20, 40], [20, 63, 63]]);
  near(tools[1].D, 12.7, 1e-9); assert.equal(tools[1].type, 'bull'); near(tools[1].cornerR, 0.762, 1e-9);
  // the library entry wins over the program comment and brings its own holder
  const sim = new Simulator();
  sim.assets = { library: Object.fromEntries(tools.map(t => [t.T, t])) };
  sim.load(deepPocket);
  assert.equal(sim.activeTool.stickout, 45); assert.equal(sim.activeTool.fluteLen, 22);
  const hb = outline(sim.activeTool).filter(b => b.part === 'holder');
  assert.equal(hb.length, 2); near(hb[0].z0, 45, 1e-9);
  console.log('tool library ok');
}
{
  // an imported holder mesh sets the interference outline; an imported cutter its edge
  const sim = new Simulator();
  sim.assets = { stlHolder: revolve([[0, 12], [50, 20], [50, 31.5], [80, 31.5]], 48), stlTool: revolve([[0, 0], [2.4, 4], [40, 4], [60, 4]], 48) };
  sim.cfg.tool.fluteLen = 30; sim.cfg.tool.stickout = 35;
  sim.load('(STOCK 50 50 30)\nS3000 M3\nG0 X25 Y25 Z5\nG1 Z-10 F100\nG0 Z20\nM30');
  const t = sim.activeTool;
  near(t.D, 8, 0.02); assert.ok(t.lut && t.rAt);
  const hb = t.outline.filter(b => b.part === 'holder');
  near(hb[0].z0, 35, 1e-9); near(Math.max(...hb.map(b => b.r)), 31.5, 0.05);
  sim.speed = 10; let g = 0; while (!sim.done && g++ < 20000) sim.step(1 / 30);
  near(sim.stock.sample(25, 25), -10, 0.2, 'drill point bottom (grid nodes 0.15 mm off the axis)');
  near(sim.stock.sample(27, 25), -10 + 2.4 / 2, 0.2, 'cone flank');
  console.log('STL tool and holder ok');
}
console.log('tooling tests passed');
