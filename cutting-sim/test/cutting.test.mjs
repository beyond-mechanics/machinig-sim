// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { CuttingSim } from '../src/sph.js';
import { MATERIALS, flowStress } from '../src/materials.js';
import { makeTool, toolSdf, setPose, localSdf, arcPos } from '../src/tool.js';
import { importProfile, breakerProfile, rakeOf } from '../src/profile.js';

const run = (cfg) => { const s = new CuttingSim(cfg); while (!s.done) s.stepSample(); return s; };

test('tool signed distance: rounded edge, rake face and interior', () => {
  const t = makeTool({ rakeDeg: 0, clearanceDeg: 7, edgeRadius: 10e-6 });
  assert.ok(Math.abs(toolSdf(t, 30e-6, 0) - 20e-6) < 1e-12);           // in front of the edge circle
  assert.ok(Math.abs(toolSdf(t, 25e-6, 100e-6) - 15e-6) < 1e-12);      // in front of a vertical rake face
  assert.ok(Math.abs(toolSdf(t, 0, -30e-6) - 20e-6) < 1e-9);           // below the edge
  assert.ok(toolSdf(t, -20e-6, 20e-6) < 0);                             // inside the body
  assert.ok(Math.abs(t.out[1] - 1) < 1e-12);                            // nearest face is the rake face
  // Rotated a quarter turn: the rake face now faces +y.
  setPose(t, 0, 0, Math.PI / 2);
  assert.ok(Math.abs(toolSdf(t, 0, 30e-6) - 20e-6) < 1e-12);
  assert.ok(Math.abs(t.out[2] - 1) < 1e-9);
});

test('tool outline import: DXF lines are chained, closed with a body and give a polygon tool', () => {
  // Open outline in mm drawn as three loose LINEs: flank (6°), a 0.05 mm land at −15°, rake face at 10°.
  const d = (a) => a * Math.PI / 180, F = [-1.5 * Math.cos(d(6)), 1.5 * Math.sin(d(6))];
  const L = [0.05 * Math.sin(d(15)), 0.05 * Math.cos(d(15))], T = [L[0] - 1.2 * Math.sin(d(10)), L[1] + 1.2 * Math.cos(d(10))];
  const line = (p, q) => `0\nLINE\n8\n0\n10\n${p[0]}\n20\n${p[1]}\n11\n${q[0]}\n21\n${q[1]}\n`;
  const dxf = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${line(L, T)}${line([0, 0], F)}${line([0, 0], L)}0\nENDSEC\n0\nEOF\n`;
  const { profile, info } = importProfile(dxf, { name: 'tool.dxf' });
  assert.equal(info.unit, 'mm'); assert.equal(info.closed, false);
  const t = makeTool({ rakeDeg: 0, clearanceDeg: 7, edgeRadius: 0, profile, cell: 20e-6 }), o = t.out;
  assert.ok(Math.abs(localSdf(t, 0, -30e-6, o) - 30e-6) < 1e-9, 'below the edge');
  assert.ok(localSdf(t, -100e-6, 100e-6, o) < 0, 'inside the body');
  assert.ok(Math.abs(arcPos(t, 20e-6, 300e-6) - 300e-6) < 15e-6, 'arc position up the rake face');
  assert.ok(arcPos(t, -400e-6, 0) < -350e-6, 'arc position along the flank');
  const rake = rakeOf(t, 0.1e-3) * 180 / Math.PI;
  assert.ok(rake > -15 && rake < 10, `effective rake ${rake.toFixed(1)}°`);
  // A mirrored drawing (cutting toward −x) is refused with a hint.
  assert.throws(() => importProfile(dxf, { name: 'tool.dxf', flip: true }), /反転/);
  // The breaker outline is a counter-clockwise loop with the edge at the origin.
  const b = breakerProfile({ rake: 5, clearance: 7, r: 10, land: 0.1, gw: 0.35, gd: 0.05, wallDeg: 35, wh: 0.06 });
  let a = 0; for (let i = 0; i < b.length; i++) { const q = b[(i + 1) % b.length]; a += b[i][0] * q[1] - q[0] * b[i][1]; }
  assert.ok(a > 0); assert.ok(Math.min(...b.map((p) => p[1])) === 0);
});

test('flow stress: Johnson-Cook trends and strain softening of the tanh model', () => {
  const m = MATERIALS.S45C;
  assert.equal(flowStress(m, 0, 1, 20), m.A * 1e6);
  assert.ok(Math.abs(flowStress(m, 1, 1, 20) - (m.A + m.B) * 1e6) < 1);
  assert.ok(flowStress(m, 0, 1e4, 20) > flowStress(m, 0, 1, 20));
  assert.ok(flowStress(m, 0, 1, 740) < 0.55 * flowStress(m, 0, 1, 20));
  // Aluminium grades: initial yield from 7075-T6 (strongest) down to non-heat-treated 5083.
  const st = (k) => flowStress(MATERIALS[k], 0, 1, 20);
  assert.ok(st('Al7075') > st('Al2024') && st('Al2024') > st('Al6061') && st('Al6061') > st('Al5083'));
  // Ti-6Al-4V tanh model softens with strain at cutting temperatures; plain JC keeps hardening.
  const ts = MATERIALS.Ti64s, tj = MATERIALS.Ti64;
  assert.ok(flowStress(ts, 2, 1e4, 600) < 0.85 * flowStress(ts, 0.3, 1e4, 600));
  assert.ok(flowStress(tj, 2, 1e4, 600) > flowStress(tj, 0.3, 1e4, 600));
});

test('S45C reference cut: forces, chip, temperatures, tool heat and wear', () => {
  const s = run({ mat: 'S45C', vc: 200, h: 0.1, rake: 5, nh: 6, cutLen: 0.4 });
  const r = s.summary();
  assert.equal(s.nDead, 0, 'no particles ejected');
  // Specific cutting force of medium carbon steel at h = 0.1 mm: about 1,800–2,600 N/mm².
  assert.ok(r.kc > 1500 && r.kc < 2800, `kc ${r.kc.toFixed(0)}`);
  assert.ok(r.ft > 0.1 * r.fc && r.ft < r.fc, `Ft/Fc ${(r.ft / r.fc).toFixed(2)}`);
  assert.ok(r.ratio > 1.3 && r.ratio < 2.8, `chip ratio ${r.ratio.toFixed(2)}`);
  assert.ok(r.tmax > 350 && r.tmax < 1000, `Tmax ${r.tmax.toFixed(0)}`);
  // Most cutting work ends up as heat (plastic heating at 90 %, friction at 100 %).
  assert.ok(r.heatRatio > 0.7 && r.heatRatio < 1.0, `heat / work ${r.heatRatio.toFixed(2)}`);
  // The tool heats up at the contact, the steady estimate exists and stays below the chip side.
  assert.ok(r.toolT > 250 && r.toolT < 900, `tool T ${r.toolT.toFixed(0)}`);
  assert.ok(r.toolSteadyT > 250 && r.toolSteadyT < r.tmax + 50, `tool steady T ${r.toolSteadyT.toFixed(0)}`);
  // Crater wear sits on the rake face behind the edge, where the chip is hottest.
  const prof = s.heat.profile(), peak = prof.reduce((a, b) => (b.wear > a.wear ? b : a));
  assert.ok(peak.s > 0 && peak.s < 300, `crater peak at ${peak.s.toFixed(0)} µm`);
  assert.ok(r.wearCrater > r.wearFlank, `crater ${r.wearCrater.toFixed(2)} flank ${r.wearFlank.toFixed(2)}`);
});

test('larger rake angle lowers the cutting force and thickens the shear angle', () => {
  const a = run({ mat: 'S45C', rake: -5, nh: 6, cutLen: 0.35 }).summary();
  const b = run({ mat: 'S45C', rake: 15, nh: 6, cutLen: 0.35 }).summary();
  assert.ok(b.fc < 0.92 * a.fc, `Fc ${a.fc.toFixed(0)} → ${b.fc.toFixed(0)}`);
  assert.ok(b.phi > a.phi, `φ ${a.phi.toFixed(1)} → ${b.phi.toFixed(1)}`);
});

test('higher cutting speed raises the cutting temperature', () => {
  const lo = run({ mat: 'S45C', vc: 80, nh: 6, cutLen: 0.35 }).summary();
  const hi = run({ mat: 'S45C', vc: 300, nh: 6, cutLen: 0.35 }).summary();
  assert.ok(hi.trake > lo.trake + 50, `rake T ${lo.trake.toFixed(0)} → ${hi.trake.toFixed(0)}`);
});

test('end mill, A7075: force follows the chip thickness; up and down milling mirror each other', () => {
  const base = { mode: 'mill', mat: 'Al7075', vc: 400, D: 6, z: 3, fz: 0.1, ae: 0.3, nh: 5 };
  const up = run({ ...base, dir: 'up' }), dn = run({ ...base, dir: 'down', track: 0 });
  for (const s of [up, dn]) assert.equal(s.nDead, 0);
  const peakAt = (s) => { const h = s.hist; let k = 0; h.fc.forEach((v, i) => { if (v > h.fc[k]) k = i; }); return h.axis[k]; };
  const ru = up.summary(), arc = ru.arc;
  // Up milling: thickness grows to the exit (peak late); down milling: peak right after entry.
  assert.ok(peakAt(up) > 0.6 * arc, `up peak at ${peakAt(up).toFixed(1)}° of ${arc.toFixed(1)}°`);
  assert.ok(peakAt(dn) < -0.4 * arc, `down peak at ${peakAt(dn).toFixed(1)}°`);
  // Fitted cutting coefficients in the range of aluminium mechanistic data (Ktc ≈ 800 N/mm²).
  assert.ok(ru.Ktc > 400 && ru.Ktc < 2000, `Ktc ${ru.Ktc.toFixed(0)}`);
  assert.ok(ru.Kte > 0 && ru.Kte < 80, `Kte ${ru.Kte.toFixed(1)}`);
  assert.ok(ru.heatRatio > 0.7 && ru.heatRatio < 1.1, `heat / work ${ru.heatRatio.toFixed(2)}`);
  // After the tooth leaves the work the chip breaks free and is thrown off at about the cutting speed.
  assert.ok(ru.pieces >= 1, `chip pieces ${ru.pieces}`);
  assert.ok(ru.ejectV > 0.5 * 400 && ru.ejectV < 2 * 400, `ejection ${ru.ejectV && ru.ejectV.toFixed(0)} m/min`);
});

test('chip breaker groove curls the chip; fracture leaves the S45C chip continuous', () => {
  const s = run({ mat: 'S45C', tool: 'breaker', nh: 5, cutLen: 1.2 });
  const r = s.summary();
  assert.equal(s.nDead, 0);
  assert.ok(Number.isFinite(r.curl) && r.curl > 0.05 && r.curl < 1, `curl radius ${r.curl} mm`);
  assert.ok(r.kc > 1300 && r.kc < 2800, `kc ${r.kc.toFixed(0)}`);
  assert.equal(r.pieces, 0, 'continuous chip');
  assert.ok(r.failed < 0.05 * s.N, `failed particles ${r.failed}`);
});
