// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { CuttingSim } from '../src/sph.js';
import { MATERIALS, flowStress } from '../src/materials.js';
import { makeTool, toolSdf, setPose, localSdf, arcPos, toolOutline } from '../src/tool.js';
import { importProfile, breakerProfile, rakeOf, wornProfile } from '../src/profile.js';

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

test('worn tool outline: no wear keeps the shape, flank wear lifts the edge and a crater recesses the rake face', () => {
  const t = makeTool({ rakeDeg: 5, clearanceDeg: 7, edgeRadius: 10e-6 });
  const base = toolOutline(t, 3e-3).map(([u, w]) => [u, w + t.r]);
  const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
  const fresh = wornProfile(base, [], 1), a0 = area(fresh);           // resampled near the edge
  assert.ok(Math.abs(a0 - Math.abs(area(base))) < 1e-12, 'no wear, same area');
  // 2 µm/min over the first 100 µm of the rake face, 1 µm/min on the first 30 µm of the flank, for 5 min.
  const rows = [];
  for (let s = -200; s <= 300; s += 5) rows.push({ s, wear: s >= 0 && s <= 100 ? 2 : s < 0 && s >= -30 ? 1 : 0 });
  const worn = wornProfile(base, rows, 5);
  const lost = a0 - area(worn);
  assert.ok(lost > 0.7 * 1100e-12 && lost < 1.3 * 1100e-12, `material removed ${(lost * 1e12).toFixed(0)} µm² (about 10 × 100 + 5 × 30 − corner)`);
  // The rake face 50 µm up is 10 µm further inside the tool than the unworn face 250 µm up (the
  // worn outline is placed with its new lowest point at the origin, so compare within each outline).
  const rakeU = (p, w) => { let best = null; for (const [u, ww] of p) if (Math.abs(ww - w) < 3e-6 && u > -80e-6 && (best == null || u > best)) best = u; return best; };
  const d = (rakeU(fresh, 50e-6) - rakeU(fresh, 250e-6)) - (rakeU(worn, 50e-6) - rakeU(worn, 250e-6));
  assert.ok(d > 7e-6 && d < 13e-6, `crater depth ${(d * 1e6).toFixed(1)} µm`);
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
  // Tool-chip contact on the rake face: 1.5-3 h for steel (Toropov-Ko gives 2.6 h here).
  assert.ok(r.contactLen > 1.2 * 0.1 && r.contactLen < 3 * 0.1, `contact length ${r.contactLen} mm`);
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

test('higher cutting speed raises the cutting temperature and, with sliding friction, lowers kc', () => {
  const lo = run({ mat: 'S45C', vc: 80, nh: 6, cutLen: 0.35 }).summary();
  const hi = run({ mat: 'S45C', vc: 300, nh: 6, cutLen: 0.35 }).summary();
  assert.ok(hi.trake > lo.trake + 50, `rake T ${lo.trake.toFixed(0)} → ${hi.trake.toFixed(0)}`);
  // The chip slides faster, μ falls (0.3 power): kc 8–30 % lower (Kienzle's carbide factor: 12 %).
  assert.ok(hi.muMean < 0.85 * lo.muMean, `μ ${lo.muMean.toFixed(2)} → ${hi.muMean.toFixed(2)}`);
  assert.ok(hi.kc < 0.92 * lo.kc && hi.kc > 0.7 * lo.kc, `kc ${lo.kc.toFixed(0)} → ${hi.kc.toFixed(0)}`);
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
  // Periodic steady tool temperature: warmer than room, well below the chip contact (short duty).
  assert.ok(ru.toolMeanT > 40 && ru.toolMeanT < 0.6 * ru.trakeMax, `tool mean ${ru.toolMeanT.toFixed(0)} °C, contact ${ru.trakeMax.toFixed(0)} °C`);
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

test('residual stress, S45C: the profile does not depend on where the surface is frozen', () => {
  const run = (k) => { const s = new CuttingSim({ mat: 'S45C', residual: true, freezeK: k }); while (!s.done) s.stepSample(); return s.summary(); };
  const a = run(3), b = run(6);
  for (const r of [a, b]) {
    assert.ok(r.residual.length > 10 && r.residual[r.residual.length - 1].d > 500, 'profile reaches 0.5 mm');
    assert.ok(r.kc > 1600 && r.kc < 2600, `kc ${r.kc.toFixed(0)} with thermal expansion`);
    assert.ok(Math.abs(r.residual.at(-1).sxx) < 100, `deep σxx ${r.residual.at(-1).sxx.toFixed(0)} MPa`);
    assert.ok(r.rsSpread < 60, `surface scatter along the cut ±${r.rsSpread.toFixed(0)} MPa`);
  }
  // Surface and 30 µm within 60 MPa of each other (h/8; frozen at h + r instead, the surface is +280 MPa).
  // Converged, but not yet the measured tension of a 1045 surface (+200 to +600 MPa): see the README.
  const at = (r, d) => r.residual.reduce((q, b) => (Math.abs(b.d - d) < Math.abs(q.d - d) ? b : q)).sxx;
  assert.ok(Math.abs(a.rsSurf - b.rsSurf) < 60, `surface ${a.rsSurf.toFixed(0)} / ${b.rsSurf.toFixed(0)} MPa`);
  assert.ok(Math.abs(at(a, 30) - at(b, 30)) < 60, `30 µm ${at(a, 30).toFixed(0)} / ${at(b, 30).toFixed(0)} MPa`);
});

test('3D oblique cutting (wide plate): chip flow angle follows Stabler, ηc ≈ λ', async () => {
  const { Cutting3D } = await import('../src/sph3d.js');
  const run3 = (cfg) => { const s = new Cutting3D(cfg); while (!s.done) s.stepSample(); return s; };
  const a = run3({ mat: 'S45C', lambda: 0, cutLen: 0.3 }), b = run3({ mat: 'S45C', lambda: 30, cutLen: 0.3 });
  const ra = a.summary(), rb = b.summary();
  for (const s of [a, b]) assert.equal(s.nDead, 0);
  // Orthogonal limit: same specific force as the 2D solver's range, no side force or side flow.
  assert.ok(ra.kc > 1500 && ra.kc < 2800, `kc ${ra.kc.toFixed(0)}`);
  assert.ok(Math.abs(ra.fr) < 0.05 * ra.fc, `Fr ${ra.fr.toFixed(2)}`);
  assert.ok(Math.abs(ra.flow) < 3, `ηc ${ra.flow.toFixed(1)}° at λ = 0`);
  // Tool heat from the contact averaged along the edge: a steady tool temperature like 2D's.
  assert.ok(ra.toolSteadyT > 250 && ra.toolSteadyT < 900, `tool steady ${ra.toolSteadyT && ra.toolSteadyT.toFixed(0)} °C`);
  assert.ok(ra.heatRatio > 0.7 && ra.heatRatio < 1.05, `heat / work ${ra.heatRatio.toFixed(2)}`);
  // Inclined edge: chip flow angle within ±25 % of λ, a side force appears.
  assert.ok(rb.flow > 22.5 && rb.flow < 37.5, `ηc ${rb.flow.toFixed(1)}° at λ = 30°`);
  assert.ok(rb.fr > 0.15 * rb.fc, `Fr ${rb.fr.toFixed(1)} vs Fc ${rb.fc.toFixed(1)}`);
});

test('3D helical end mill (A7075, φ2, down milling): the helix spreads the entry and sends the chip up the flute', async () => {
  const { Cutting3D } = await import('../src/sph3d.js');
  const run3 = (cfg) => { const s = new Cutting3D(cfg); while (!s.done) s.stepSample(); return s; };
  const cfg = { mode: 'helix', mat: 'Al7075', vc: 300, D: 2, z: 3, fz: 0.1, ae: 0.2, ap: 0.3, dir: 'down', nh: 4, track: 5 };
  const a = run3({ ...cfg, helix: 0 }), b = run3({ ...cfg, helix: 30 });
  const ra = a.summary(), rb = b.summary();
  for (const s of [a, b]) assert.equal(s.nDead, 0);
  // Rotation angle of the tangential force peak.
  const peakAt = (s) => { const h = s.hist, pk = Math.max(...h.fc); return h.axis[h.fc.indexOf(pk)]; };
  // Straight tooth: the force follows the chip thickness, no axial force, no axial chip flow.
  // (Fitted past the force peak only: the chip takes ~10° after the entry to form, which the old
  // whole-arc fit averaged in at 1,080; the slope where the force follows the chip is ~2,100.)
  assert.ok(ra.Ktc > 300 && ra.Ktc < 2500, `Ktc ${ra.Ktc.toFixed(0)}`);
  assert.ok(Math.abs(ra.faMax) < 0.05 * ra.ftMax, `Fa ${ra.faMax.toFixed(2)}`);
  assert.ok(Math.abs(ra.flow) < 5, `ηc ${ra.flow.toFixed(1)}° at β = 0`);
  // Helix: the upper part of the tooth enters later (lag ~10°), so the force peak comes later and
  // lower; the chip pushes towards the shank and flows up the flute. (A linear force model puts
  // the peak a whole lag later; here the straight tooth itself takes ~10° after entry to build its
  // chip, which overlaps the lag, and the shift is a quarter of it: 2.4° of 9.9° at h/4.)
  assert.ok(peakAt(b) > peakAt(a) + 0.2 * rb.lag, `peak at ${peakAt(a).toFixed(1)}° → ${peakAt(b).toFixed(1)}° (lag ${rb.lag.toFixed(1)}°)`);
  assert.ok(rb.ftMax < 0.95 * ra.ftMax, `peak Ft ${ra.ftMax.toFixed(1)} → ${rb.ftMax.toFixed(1)} N`);
  assert.ok(rb.faMax > 0.15 * rb.ftMax, `Fa ${rb.faMax.toFixed(1)} vs Ft ${rb.ftMax.toFixed(1)}`);
  assert.ok(rb.flow > 0.8 * 30 && rb.flow < 2 * 30, `ηc ${rb.flow.toFixed(1)}° at β = 30°`);
});

test('end mill geometry: the previous tooth path is a trochoid, so the chip is fz·|cos β| thick all along the arc', async () => {
  const { Mill } = await import('../src/process.js');
  for (const dir of ['up', 'down']) {
    const m = new Mill({ D: 10, z: 2, fz: 0.1, ae: 1, dir });
    const dx = 2e-6, cy = m.R - m.ae, worst = { d: 0 };
    const bins = new Map();
    for (const [x, y] of m.build(dx, 0.2e-3)) {
      // angle about the tooth's own (drifting) centre when it passes the point
      let th = Math.atan2(y - cy, x), ox = m.drift(th);
      th = Math.atan2(y - cy, x - ox); ox = m.drift(th);
      const r = Math.hypot(x - ox, y - cy);
      if (r >= m.R) continue;
      const k = Math.round(th / (2 * Math.PI / 180));
      bins.set(k, Math.max(bins.get(k) || 0, m.R - r));
    }
    for (const [k, h] of bins) {
      const nom = m.fz * Math.abs(Math.cos(k * 2 * Math.PI / 180));
      if (Math.abs(h - nom) > Math.abs(worst.d)) Object.assign(worst, { d: h - nom, k });
    }
    // Within a few µm (bin width and particle spacing); a fixed-circle previous path is 12 µm off at the exit.
    assert.ok(Math.abs(worst.d) < 5e-6, `${dir}: ${(worst.d * 1e6).toFixed(1)} µm off at ${worst.k * 2 + 90}°`);
  }
});

test('preheat: cutting again from the steady tool temperature heats the tool and the rake contact, kc stays', () => {
  const cfg = { mat: 'S45C', vc: 300, nh: 6 };
  const a = run(cfg), b = run({ ...cfg, toolT: a.heat.steadyT });
  const ma = a.summary(), mb = b.summary();
  // A cold tool draws heat out of the chip: from its own steady temperature the tool runs 80–120 °C hotter.
  assert.ok(mb.toolSteadyT > ma.toolSteadyT + 40, `tool ${ma.toolSteadyT.toFixed(0)} → ${mb.toolSteadyT.toFixed(0)} °C`);
  assert.ok(mb.tContact > ma.tContact + 30, `contact ${ma.tContact.toFixed(0)} → ${mb.tContact.toFixed(0)} °C`);
  assert.ok(Math.abs(mb.kc / ma.kc - 1) < 0.06, `kc ${ma.kc.toFixed(0)} → ${mb.kc.toFixed(0)}`);
});

test('imported workpiece: closed outlines fill even-odd (a circle is a hole), top at y = 0, supports at the bottom and far end', async () => {
  const { importWorkpiece } = await import('../src/profile.js');
  const { Ortho } = await import('../src/process.js');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 H0.7 V0.04 H1.6 V0.6 H0 Z"/><circle cx="1.1" cy="0.17" r="0.07"/></svg>';
  const { loops, info } = importWorkpiece(svg, { name: 'w.svg', unit: 'mm' });
  assert.equal(loops.length, 2);
  assert.ok(Math.abs(info.width - 1.6e-3) < 1e-9 && Math.abs(info.height - 0.6e-3) < 1e-9);
  const dx = 0.01e-3, o = new Ortho({ h: 0.1, work: loops }), pts = o.build(dx);
  const solid = 1.6 * 0.6 - 0.9 * 0.04 - Math.PI * 0.07 ** 2;   // mm²
  assert.ok(Math.abs(pts.length * (dx * 1e3) ** 2 / solid - 1) < 0.01, `${pts.length} particles for ${solid.toFixed(3)} mm²`);
  assert.ok(!pts.some(([x, y]) => Math.hypot(x - 1.1e-3, y + 0.17e-3) < 0.06e-3), 'the hole is empty');
  assert.ok(!pts.some(([x, y]) => x > 0.71e-3 && y > -0.035e-3), 'the step is cut away');
  assert.ok(pts.some(([x, y, f]) => f === 1 && y < -0.58e-3) && pts.some(([x, y, f]) => f === 1 && x > 1.58e-3));
  assert.ok(!pts.some(([x, y, f]) => f === 1 && y > -0.1e-3 && x > 0.05e-3 && x < 1.5e-3), 'no supports in the cut layer');
});

test('STL mesh: exact distance and normal of a box, fill count matches the volume, binary STL round trip', async () => {
  const { MeshSDF, fillMesh, parseSTL, volume } = await import('../src/mesh.js');
  const { EXAMPLES } = await import('../src/examples3d.js');
  const w = EXAMPLES.plane.work();                                         // 1.0 × 0.4 × 0.4 mm box
  assert.ok(Math.abs(volume(w) - 0.16) < 1e-9);
  const sdf = new MeshSDF(w, 0.01);
  sdf.exact(0.5, 0.2, 0.1);                                                // 0.1 above the top face
  assert.ok(Math.abs(sdf.q[0] - 0.1) < 1e-9 && Math.abs(sdf.q[3] - 1) < 1e-9);
  sdf.exact(0.5, 0.2, -0.3);                                               // inside, 0.1 above the bottom
  assert.ok(Math.abs(sdf.q[0] + 0.1) < 1e-9);
  const fill = fillMesh(w, 0.05);
  assert.equal(fill.length / 3, Math.round(0.16 / 0.05 ** 3));
  const n = w.length / 9, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + 50 * i + 12 + 4 * k, w[9 * i + k], true);
  const back = parseSTL(buf, 1e-3);
  assert.ok(Math.abs(volume(back) - 0.16e-9) < 1e-15);
  // A box keeps exactly the points of the whole fill that lie in it.
  const box = [0.22, 0.1, -0.31, 0.61, 0.33, 0.5], inBox = (a) => a[0] >= box[0] && a[0] < box[3] && a[1] >= box[1] && a[1] <= box[4] && a[2] >= box[2] && a[2] <= box[5];
  const pick = (f) => Array.from({ length: f.length / 3 }, (_, i) => [f[3 * i], f[3 * i + 1], f[3 * i + 2]].map((v) => +v.toFixed(9)).join());
  const part = fillMesh(w, 0.05, Infinity, box);
  assert.deepEqual(pick(part).sort(), pick(fill).filter((k) => inBox(k.split(',').map(Number))).sort());
  assert.ok(part.length > 0 && part.length < fill.length);
});

test('STL mode: a large work is cropped to the reach of the tool, with its cut faces held', async () => {
  const { Cutting3D } = await import('../src/sph3d.js');
  const { EXAMPLES } = await import('../src/examples3d.js');
  const { bounds } = await import('../src/mesh.js');
  const e = EXAMPLES.drill, ew = bounds(e.work());
  const v = [[-15, -43, -50], [25, -43, -50], [25, 37, -50], [-15, 37, -50], [-15, -43, 10], [25, -43, 10], [25, 37, 10], [-15, 37, 10]];
  const big = Float64Array.from([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].flatMap((q) => q.flatMap((i) => v[i])));
  const d = [5 - 0.5 * (ew[0] + ew[3]), -3 - 0.5 * (ew[1] + ew[4]), 10 - ew[5]];   // the tool at the top centre of the 40 × 80 × 60 mm block
  const m = (t, o) => Float64Array.from(t, (x, i) => (x + o[i % 3]) * 1e-3);
  const s = new Cutting3D({ mode: 'mesh', mat: 'S45C', vc: 200, dxUm: 40, toolTris: m(e.tool(), d), workTris: m(big, [0, 0, 0]), motion: 'drill', fr: 0.2, angle: 60,
    axis: [(e.cfg.axis[0] + d[0]) * 1e-3, (e.cfg.axis[1] + d[1]) * 1e-3], crop: true });
  assert.ok(s.N > 1000 && s.N < 60000, `N ${s.N}`);
  const wb = s.wb.map((x) => x * 1e3);
  assert.ok(wb[3] - wb[0] < 2.5 && wb[4] - wb[1] < 2.5 && Math.abs(wb[5] - 10) < 1e-9, `box ${wb}`);   // the top face stays the real one
  let side = 0, top = 0;
  for (let i = 0; i < s.N; i++) {
    const x = s.x[i] * 1e3, z = s.z[i] * 1e3;
    if (x < wb[0] + 0.1) side += s.fixed[i] ? 1 : 0;
    if (z > wb[5] - 0.05 && Math.hypot(x - 5, s.y[i] * 1e3 + 3) < 0.8) top += s.fixed[i] ? 1 : 0;
  }
  assert.ok(side > 0, 'cut faces held');
  assert.equal(top, 0, 'the real top face near the tool stays free');
});

test('STL mode: planing with the example tool forms a chip, the force settles, and the surface view closes', async () => {
  const { Cutting3D } = await import('../src/sph3d.js');
  const { EXAMPLES } = await import('../src/examples3d.js');
  const { surfaceNets } = await import('../src/surface3d.js');
  const m = (t) => t.map((v) => v * 1e-3), e = EXAMPLES.plane;
  const s = new Cutting3D({ mode: 'mesh', mat: 'S45C', vc: 200, dxUm: 40, toolTris: m(e.tool()), workTris: m(e.work()), motion: 'linear', travel: 0.35 });
  while (!s.done) s.stepSample();
  const sm = s.summary(), h = s.hist.fc, n = h.length;
  assert.ok(sm.fx < -30 && sm.fx > -250, `Fx ${sm.fx}`);                    // kc·b·h ≈ 2100·0.4·0.1 = 84 N
  assert.ok(sm.fz > 0, `Fz ${sm.fz}`);                                      // the work pushes the tool up
  assert.ok(Math.abs(sm.fy) < 0.2 * Math.abs(sm.fx), `Fy ${sm.fy}`);         // symmetric across the width
  // The last third of the cut does not keep climbing (frozen material ahead of the tool would).
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(avg(h.slice(Math.round(0.8 * n)))) < 1.25 * Math.abs(avg(h.slice(Math.round(0.55 * n), Math.round(0.75 * n)))), 'force keeps rising');
  let up = 0;
  for (let i = 0; i < s.N; i++) if (!s.dead[i] && s.z[i] > 0.04e-3) up++;   // chip above the top surface
  assert.ok(up > 20, `chip particles ${up}`);
  // Surface nets: every edge is shared by exactly two triangles.
  const f = { x: Array.from(s.x, (v) => v * 1e3), y: Array.from(s.y, (v) => v * 1e3), z: Array.from(s.z, (v) => v * 1e3), flag: s.fixed, dx: s.dx * 1e3 };
  const sel = []; for (let i = 0; i < s.N; i++) if (!s.dead[i]) sel.push(i);
  const r = surfaceNets(f, sel, s.T, 20, 600), edges = new Map();
  for (let i = 0; i < r.idx.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = r.idx[i + k], b = r.idx[i + (k + 1) % 3], key = a < b ? a * 1e7 + b : b * 1e7 + a;
    edges.set(key, (edges.get(key) || 0) + 1);
  }
  let odd = 0; for (const c of edges.values()) if (c % 2) odd++;
  assert.equal(odd, 0);
});
