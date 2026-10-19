// Chip evacuation: drag law and terminal velocity, jet and wall-jet fields, the coolant layer,
// retention in a closed pocket per coolant, heap contacts, sleeping, and the time budget.
import assert from 'node:assert/strict';
import { ChipSystem, chipShape, chipEjection, freeJet, nozzlePose, bulkRadius, Pool, MAX_CHIPS, G, RHO_AIR, RHO_LIQ } from '../src/chips.js';
import { Stock } from '../src/stock.js';
import { MATERIALS } from '../src/materials.js';

const AL = MATERIALS.A5052;
const farTool = { x: -500, y: -500, tipZ: 500, R: 5, len: 30, omega: 0, sinCos: 0.43, cutTop: 500, cutting: false, ux: 1, uy: 0 };
function pocketStock(depth = 12) {
  // 80 × 60 × 30 block with a closed 40 × 24 pocket in the middle
  const s = new Stock(80, 60, 30, 0.3);
  for (let x = 25; x <= 55; x += 0.5) for (let y = 23; y <= 37; y += 0.5) s.stamp(x, y, -depth, 5, 'flat', 0);
  return s;
}

// ---------- 1. drag: terminal velocity matches √(2·m·g'/(ρ·Cd·A)) in air and in coolant ----------
{
  const hc = 0.07, sh = chipShape(AL, hc);
  const m = AL.rho * 1e-9 * 1, A = AL.kA * 1 / hc; // a 1 mm³ chip: area per volume = kA / hc
  for (const rhoF of [RHO_AIR, RHO_LIQ]) {
    const cs = new ChipSystem();
    const stock = new Stock(50, 50, 10, 1);
    cs.emit([25, 25, 6000], [0, 0, 0], 1, 0, sh); cs.flush();
    cs.fluid = function () { const F = this.F; F[0] = F[1] = F[2] = F[4] = 0; F[3] = rhoF; return F; };
    for (let k = 0; k < 120; k++) cs.update(1 / 60, { stock, tool: farTool, coolant: 'dry', nozzle: null });
    const gEff = G * (1 - rhoF / (AL.rho * 1e-9));
    const vt = Math.sqrt(2 * m * gEff / (rhoF * 1.2 * A));
    const v = -cs.v[2];
    console.log(`terminal velocity in ${rhoF === RHO_AIR ? 'air    ' : 'coolant'}: ${v.toFixed(1)} mm/s (analytic ${vt.toFixed(1)})`);
    assert.ok(Math.abs(v - vt) / vt < 0.01, 'terminal velocity');
  }
}

// ---------- 2. chip ejection along the rake face with Stabler's flow angle ----------
{
  const R = 5, omega = 12000 * 2 * Math.PI / 60, Vc = omega * R, lam = AL.lam, eta = 30 * Math.PI / 180;
  // slot exit (φ = π): the chip leaves backwards along the slot, lifted by the helix
  const e = chipEjection({ phi: Math.PI, ux: 1, uy: 0, vx: 0, vy: 1 }, R, omega, 30, lam);
  assert.ok(e.vel[0] < -0.9 * Vc && Math.abs(e.vel[1]) < 1e-6 * Vc, 'leaves along −feed at a slot exit');
  assert.ok(Math.abs(e.vel[2] - Vc * Math.sin(eta) / lam) < 1e-6, 'axial lift Vc·sinη/λ');
  console.log(`ejection: ${(Math.hypot(...e.vel) / 1000).toFixed(2)} m/s at Vc ${(Vc / 1000).toFixed(2)} m/s, lift ${(e.vel[2] / 1000).toFixed(2)} m/s`);
}

// ---------- 3. round free jet: Uc ∝ d0/x and conserved momentum ----------
{
  const U0 = 120e3, d0 = 2.5, M0 = U0 * U0 * Math.PI * d0 * d0 / 4;
  let ref = null;
  for (const x of [30, 60, 120, 240]) {
    const { Uc, b } = freeJet(x, U0, d0);
    let M = 0; const dr = b / 400;
    for (let r = dr / 2; r < 6 * b; r += dr) { const u = Uc * Math.exp(-Math.LN2 * r * r / (b * b)); M += u * u * 2 * Math.PI * r * dr; }
    if (ref === null) ref = Uc * x;
    console.log(`air jet x=${x} mm: Uc ${(Uc / 1000).toFixed(1)} m/s, half-width ${b.toFixed(1)} mm, momentum ${(M / M0).toFixed(3)} of nozzle`);
    assert.ok(Math.abs(Uc * x - ref) / ref < 1e-9, 'centreline decays as 1/x');
    assert.ok(Math.abs(M / M0 - 1) < 0.01, 'momentum flux conserved');
  }
  assert.ok(Math.abs(freeJet(5, U0, d0).Uc - U0) < 1e-6, 'potential core keeps U0');
  assert.equal(freeJet(200, 4000, 5, true).Uc, 4000, 'liquid stream keeps its speed');
}

// ---------- 4. wall jet: blocked by walls, washes up them, escapes over the rim ----------
{
  // two 30 × 30 pockets 8 mm deep separated by a 6 mm rib; an air jet straight down into the first
  const stock = new Stock(100, 60, 30, 0.3);
  for (let x = 13; x <= 37; x += 0.5) for (let y = 18; y <= 42; y += 0.5) stock.stamp(x, y, -8, 5, 'flat', 0);
  for (let x = 63; x <= 87; x += 0.5) for (let y = 18; y <= 42; y += 0.5) stock.stamp(x, y, -8, 5, 'flat', 0);
  const cs = new ChipSystem();
  const tool = { ...farTool, x: 25, y: 30, tipZ: -8, omega: 0 };
  cs.prepare(1 / 60, { stock, tool, coolant: 'air', nozzle: nozzlePose({ x: 25, y: 30, z: -8 }, { az: 0, h: 60, dist: 0.01 }) });
  const at = (x, y, z) => [...cs.fluid(x, y, z)];
  const floorJet = at(35, 30, -7.5), up = at(39, 30, -5), rim = at(48, 30, 0.6), rib = at(60, 30, 0.6), behind = at(70, 30, -7.5), table = at(25, -10, -29);
  console.log(`wall jet: pocket floor ${(floorJet[0] / 1000).toFixed(1)} m/s, up the wall ${(up[2] / 1000).toFixed(1)} m/s, over the rim ${(rim[0] / 1000).toFixed(1)} m/s, beyond the rib ${(rib[0] / 1000).toFixed(1)} m/s, in the next pocket ${Math.hypot(...behind.slice(0, 3)).toFixed(0)} mm/s, on the table ${Math.hypot(...table.slice(0, 3)).toFixed(0)} mm/s`);
  assert.ok(floorJet[0] > 2000, 'radial wall jet on the pocket floor');
  assert.ok(up[2] > 1000, 'up-wash at the pocket wall');
  assert.ok(rim[0] > 500, 'continues outward over the rim');
  assert.equal(Math.hypot(...behind.slice(0, 3)), 0, 'no flow through the rib into the next pocket floor');
  assert.equal(Math.hypot(...table.slice(0, 3)), 0, 'the sheet separates at the stock edge');
}

// ---------- 5. coolant layer: fills a pocket, drains off the top, conserves mass ----------
{
  const stock = pocketStock(12), P = new Pool(stock), A = P.cx * P.cy;
  const vol = () => P.depth.reduce((a, d) => a + d, 0) * A;
  let injected = 0;
  for (let t = 0; t < 2; t += 1 / 60) { P.step(1 / 60, { x: 40, y: 30, Q: 78500, r: 3 }, true); injected += 78500 / 60; }
  const kTop = P.cell(8, 8), kPocket = P.cell(40, 30);
  const film = P.depth[kTop], during = vol();
  for (let t = 0; t < 4; t += 1 / 60) P.step(1 / 60, null, true);
  const surf = P.bed[kPocket] + P.depth[kPocket];
  console.log(`pool: film on the top ${film.toFixed(2)} mm while flooding, ${P.depth[kTop].toFixed(3)} mm 4 s after; pocket surface ${surf.toFixed(2)} (rim 0); held ${(vol() / 1000).toFixed(1)} of ${(injected / 1000).toFixed(1)} cm³ injected`);
  assert.ok(during <= injected * 1.0001, 'no water is created');
  assert.ok(film > 0.5 && film < 6, 'a few-mm film runs over the top while flooding');
  assert.ok(P.depth[kTop] < 0.2, 'the top drains off the edges');
  assert.ok(Math.abs(surf) < 1, 'the closed pocket stays full to about the rim (sloshing spills a little)');
}

// ---------- 6. closed pocket: what stays in it, by coolant ----------
function pocketRun(coolant, noz = { az: 218, h: 55, dist: 57 }) {
  const stock = pocketStock(12), cs = new ChipSystem();
  const R = 5, omega = 12000 * 2 * Math.PI / 60, fz = 0.04, lam = AL.lam;
  const shape = chipShape(AL, lam * fz * 2 / Math.PI);
  const path = [[30, 28], [50, 28], [50, 32], [30, 32], [30, 28]], per = 48, sp = 25;
  const at = s => { s %= per; for (let k = 1; k < path.length; k++) { const [ax, ay] = path[k - 1], [bx, by] = path[k], L = Math.hypot(bx - ax, by - ay); if (s <= L) return { x: ax + (bx - ax) * s / L, y: ay + (by - ay) * s / L, ux: (bx - ax) / L, uy: (by - ay) / L }; s -= L; } };
  let acc = 0;
  const dt = 1 / 60, z = -12;
  for (let t = 0; t < 4; t += dt) {
    const p = at(t * sp);
    if (t < 1) {
      for (acc += 600 * dt; acc >= 1; acc--) {
        const c = { phi: Math.PI * (0.9 + 0.1 * Math.random()), ux: p.ux, uy: p.uy, vx: -p.uy, vy: p.ux };
        const ej = chipEjection(c, R, omega, 30, lam), vol = fz * 2 * R * 2, r = bulkRadius(vol, shape.Rb), off = 2 * Math.sqrt(R * r) + 0.3;
        cs.emit([p.x + ej.nx * (R - r) + ej.tx * off, p.y + ej.ny * (R - r) + ej.ty * off, z + 1], ej.vel.map(v => v * (0.85 + 0.3 * Math.random())), vol, 0, shape);
      }
      cs.flush(10);
    }
    const tool = { x: p.x, y: p.y, tipZ: z, R, len: 30, omega, sinCos: 0.43, cutTop: z + 2, cutting: t < 1, ux: p.ux, uy: p.uy };
    cs.update(dt, { stock, tool, coolant, nozzle: nozzlePose({ x: p.x, y: p.y, z }, noz) });
  }
  return cs.stats.pocketVol / cs.stats.producedVol;
}
{
  const res = {};
  for (const c of ['dry', 'air', 'flood', 'through']) res[c] = pocketRun(c);
  res.airLow = pocketRun('air', { az: 218, h: 12, dist: 57 });
  console.log('left in a 12 mm closed pocket:', Object.entries(res).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', '));
  assert.ok(res.dry > 0.3, 'dry: a deep closed pocket keeps a good part of its chips');
  for (const c of ['air', 'flood', 'through']) assert.ok(res[c] < 0.5 * res.dry, `${c} clears the pocket better than dry`);
  assert.ok(res.airLow > res.air + 0.2, 'a low nozzle is shadowed by the rim and clears less');
}

// ---------- 7. heaps: chips pile up without sinking into each other, then sleep ----------
{
  const stock = pocketStock(12), cs = new ChipSystem(), sh = chipShape(AL, 0.07);
  for (let f = 0; f < 300; f++) {
    if (f < 120) { for (let k = 0; k < 15; k++) cs.emit([36 + Math.random() * 8, 27 + Math.random() * 6, 2 + Math.random() * 8], [0, 0, 0], 0.8, 0, sh); cs.flush(15); }
    cs.update(1 / 60, { stock, tool: farTool, coolant: 'dry', nozzle: null });
  }
  const ov = []; let zTop = -Infinity, n = 0;
  for (let i = 0; i < MAX_CHIPS; i++) {
    if (!cs.state[i]) continue;
    n++; zTop = Math.max(zTop, cs.p[i * 3 + 2]);
    for (let j = i + 1; j < MAX_CHIPS; j++) {
      if (!cs.state[j]) continue;
      const d = Math.hypot(cs.p[i * 3] - cs.p[j * 3], cs.p[i * 3 + 1] - cs.p[j * 3 + 1], cs.p[i * 3 + 2] - cs.p[j * 3 + 2]), s = cs.r[i] + cs.r[j];
      if (d < s) ov.push((s - d) / s);
    }
  }
  ov.sort((a, b) => a - b);
  const p99 = ov[Math.floor(ov.length * 0.99)] ?? 0, max = ov[ov.length - 1] ?? 0;
  console.log(`heap: ${n} chips (r ${cs.r[0].toFixed(2)} mm) ${cs.stats.awake} awake, top ${(zTop + 12).toFixed(1)} mm above the floor, overlap p99 ${(p99 * 100).toFixed(0)}% max ${(max * 100).toFixed(0)}% of the contact distance`);
  assert.ok(zTop + 12 > 6 * cs.r[0], 'chips stack into a heap');
  assert.ok(p99 < 0.2 && max < 0.45, 'no deep overlaps');
  assert.ok(cs.stats.awake < 0.02 * n, 'the heap goes to sleep');
}

// ---------- 8. sleeping chips wake for the tool and for a strong enough flow ----------
{
  const stock = new Stock(60, 60, 20, 0.3), sh = chipShape(AL, 0.07);
  const cs = new ChipSystem();
  cs.emit([30, 30, 2], [0, 0, 0], 0.8, 0, sh); cs.flush();
  for (let f = 0; f < 60; f++) cs.update(1 / 60, { stock, tool: farTool, coolant: 'dry', nozzle: null });
  assert.equal(cs.state[0], 2, 'a chip at rest on the stock sleeps');
  cs.update(1 / 60, { stock, tool: { ...farTool, x: 33, y: 30, tipZ: -1, omega: 1256 }, coolant: 'dry', nozzle: null });
  assert.equal(cs.state[0], 1, 'the tool wakes it');
  for (let f = 0; f < 120; f++) cs.update(1 / 60, { stock, tool: farTool, coolant: 'dry', nozzle: null });
  assert.ok(cs.state[0] === 2 || cs.state[0] === 3, 'asleep again');
  const x0 = cs.p[0], y0 = cs.p[1];
  // the swirl of a spindle running 15 mm away does not move it (u ≈ 0.35 m/s against ≈ 2 m/s
  // needed to beat static friction in air); an air jet aimed at it does
  for (let f = 0; f < 10; f++) cs.update(1 / 60, { stock, tool: { ...farTool, x: x0 + 15, y: y0, tipZ: 0, omega: 1256 }, coolant: 'dry', nozzle: null });
  const stillAsleep = cs.state[0] === 2;
  cs.update(1 / 60, { stock, tool: { ...farTool, x: x0 + 2, y: y0, tipZ: 0 }, coolant: 'air', nozzle: nozzlePose({ x: x0 + 2, y: y0, z: 0 }, { az: 180, h: 40, dist: 40 }) });
  console.log(`wake: nearby spindle swirl leaves it asleep: ${stillAsleep}, aimed jet wakes it: ${cs.state[0] === 1}`);
  assert.ok(stillAsleep && cs.state[0] === 1, 'woken only when the drag beats static friction');
}

// ---------- 9. time budget: 5000 chips per update ----------
{
  // a heap in the pocket, chips spread over the top and on the table, then the tool slotting
  // along the top (typical) or ploughing through the heap (worst case) while chips keep coming
  const stock = pocketStock(12), cs = new ChipSystem(), sh = chipShape(AL, 0.07);
  for (let f = 0; f < 420; f++) {
    if (f < 300) {
      for (let k = 0; k < 9; k++) cs.emit([28 + Math.random() * 24, 26 + Math.random() * 8, 5 + Math.random() * 10], [0, 0, 0], 0.8, 0, sh);
      for (let k = 0; k < 8; k++) cs.emit([-20 + Math.random() * 120, -15 + Math.random() * 90, 5], [0, 0, 0], 0.8, 0, sh);
      cs.flush(17);
    }
    cs.update(1 / 60, { stock, tool: farTool, coolant: 'dry', nozzle: null });
  }
  const R = 5, omega = 1256, lam = AL.lam;
  const time = (coolant, y, z) => {
    const ms = [];
    for (let f = 0; f < 120; f++) {
      const x = 30 + 20 * (f / 120), tool = { x, y, tipZ: z, R, len: 30, omega, sinCos: 0.43, cutTop: z + 2, cutting: true, ux: 1, uy: 0 };
      for (let k = 0; k < 10; k++) {
        const ej = chipEjection({ phi: Math.PI, ux: 1, uy: 0, vx: 0, vy: 1 }, R, omega, 30, lam);
        cs.emit([x - 4.5, y - 4, z + 1], ej.vel.map(v => v * (0.85 + 0.3 * Math.random())), 0.8, 0, sh);
      }
      cs.flush(10);
      const t0 = performance.now();
      cs.update(1 / 60, { stock, tool, coolant, nozzle: nozzlePose({ x, y, z }) });
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    return { mean: ms.reduce((a, b) => a + b) / ms.length, p95: ms[Math.floor(ms.length * 0.95)], count: cs.stats.count, awake: cs.stats.awake };
  };
  for (const c of ['dry', 'air', 'flood', 'through']) {
    const t = time(c, 8, -1);
    console.log(`chips.update ${c.padEnd(7)} slotting:        ${t.count} chips (${t.awake} awake) mean ${t.mean.toFixed(2)} ms, p95 ${t.p95.toFixed(2)} ms`);
    assert.ok(t.mean < 6, 'real-time budget');
  }
  const t = time('dry', 30, -12);
  console.log(`chips.update dry     through the heap: ${t.count} chips (${t.awake} awake) mean ${t.mean.toFixed(2)} ms, p95 ${t.p95.toFixed(2)} ms`);
  assert.ok(t.mean < 25, 'worst case stays bounded');
}
console.log('chips tests passed');
