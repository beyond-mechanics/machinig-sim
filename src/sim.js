// Simulation orchestrator: walks the tool along the discretized path, updates the
// engagement map from the stock, runs the cutting dynamics, removes material at the
// actual (deflected) tool position and feeds chips into the particle system.

import { parseGcode, discretize, segmentTime } from './gcode.js';
import { Stock } from './stock.js';
import { CuttingEngine, BINS, END_BINS, END_RINGS } from './cutting.js';
import { ChipSystem } from './chips.js';
import { toolModel, toolStress } from './tool.js';
import { stabilityLobes, alimAt } from './sld.js';
import { MATERIALS } from './materials.js';
import { wallAt, FN_CAP } from './wall.js';
import { modeSet, staticK } from './frf.js';
import { cuttingTemperature, wearRate, wornEdge, VB_LIMIT, T0 } from './thermal.js';

export class Simulator {
  constructor() {
    this.engine = new CuttingEngine();
    this.chips = new ChipSystem();
    this.cfg = {
      tool: { D: 10, N: 3, helixDeg: 30, rakeDeg: 10, type: 'flat', fluteLen: 25, stickout: 30, kSpindle: 50000, VB0: 0 },
      modal: { auto: true, k: 0, fn: 0, zeta: 0.04 },
      material: 'A5052', coolant: 'air', workpieceFlex: true, cuttingNonlinear: true,
      feedOverride: 1, spindleOverride: 1,
      dynBudget: 220000, // slice-force evaluations per frame (≈ 5 ms of JS)
      cell: 0.3,
    };
    this.speed = 1;
    this.program = '';
  }

  load(program, stockSize) {
    this.program = program;
    const parsed = parseGcode(program, { x: 0, y: 0, z: 50 });
    this.warnings = parsed.warnings;
    this.stockSize = parsed.meta.stock || stockSize || { w: 120, l: 80, h: 30 };
    this.path = discretize(parsed.moves, 0.5);
    this.times = [0];
    for (let i = 1; i < this.path.length; i++) this.times.push(this.times[i - 1] + segmentTime(this.path[i - 1], this.path[i]));
    this.totalTime = this.times[this.times.length - 1] || 0;
    this.reset();
  }

  reset() {
    const s = this.stockSize;
    this.stock = new Stock(s.w, s.l, s.h, this.cfg.cell);
    this.chips.reset();
    this.seg = 1; this.segS = 0; this.mtime = 0; this.done = this.path.length < 2;
    this.pos = this.path.length ? { ...this.path[0] } : { x: 0, y: 0, z: 50 };
    this.u = [1, 0];
    this.wall = null;
    this.alerts = new Map();
    this.display = blankDisplay();
    this.ema = null;
    this.lastS = -1;
    this.VB = this.cfg.tool.VB0 || 0; // flank wear [mm], carried through the whole program
    this.temp = { tool: T0, chip: T0 };
    this.reconfigure();
  }

  // recompute tool/modal model and lobes; called when parameters change
  reconfigure() {
    const t = this.cfg.tool;
    t.R = t.D / 2;
    this.tm = toolModel(t);
    if (this.cfg.modal.auto) { this.cfg.modal.k = Math.round(this.tm.k); this.cfg.modal.fn = Math.round(this.tm.fn); }
    this.mat = MATERIALS[this.cfg.material];
    this.lastS = -1;
    this.lobeKey = '';
  }

  modalNow() {
    const m = this.cfg.modal;
    return { k: m.k, fn: m.fn, zeta: m.zeta, modesX: m.modesX || null, modesY: m.modesY || null };
  }
  // all modes of the tool tip in x and y
  modes() { return modeSet(this.modalNow()); }
  toolStaticK() { const m = this.modes(); return Math.min(staticK(m.x), staticK(m.y)); }

  ensureEngine(S) {
    if (Math.abs(S - this.lastS) < 1) return;
    const t = this.cfg.tool;
    this.engine.configure({ N: t.N, R: t.R, helixDeg: t.helixDeg, type: t.type, fluteLen: t.fluteLen, nonlinear: this.cfg.cuttingNonlinear }, this.modalNow(), this.mat, S, this.cfg.workpieceFlex ? FN_CAP : 0);
    this.lastS = S;
  }

  lobes(phiSt, phiEx) {
    const key = `${phiSt.toFixed(2)}|${phiEx.toFixed(2)}|${this.cfg.modal.k}|${this.cfg.modal.fn}|${this.cfg.modal.zeta}|${JSON.stringify(this.cfg.modal.modesX)}|${JSON.stringify(this.cfg.modal.modesY)}|${this.cfg.material}|${this.cfg.tool.N}`;
    if (key !== this.lobeKey) {
      this.lobeKey = key;
      this.lobeCache = stabilityLobes({ ...this.modalNow(), N: this.cfg.tool.N, Ktc: this.mat.Ktc, Krc: this.mat.Krc, phiSt, phiEx, lobes: 30, rpmMin: 2000, rpmMax: 40000 });
    }
    return this.lobeCache;
  }

  // spindle speed with the highest stable depth within ±range of the current speed
  bestSpindle(S, range = 0.35) {
    const d = this.display;
    const lobes = this.lobes(d.phiSt ?? 0, d.phiEx ?? Math.PI);
    let best = S, bestA = alimAt(lobes, S);
    for (let s = S * (1 - range); s <= Math.min(40000, S * (1 + range)); s += 25) {
      const a = alimAt(lobes, s);
      if (a > bestA && a < Infinity) { bestA = a; best = s; }
    }
    return { S: Math.round(best / 10) * 10, alim: bestA };
  }

  // sample stock height on the cutter periphery for each local angle bin
  fillEngagement(cx, cy, u) {
    const Hb = this.engine.Hb, R = this.cfg.tool.R, vx = -u[1], vy = u[0];
    const cell = Math.max(this.stock.hx, this.stock.hy);
    // Sample just inside the cutter radius and one cell ahead along the feed. The grid smears
    // finished walls by up to a cell; sampling on the radius itself would read them as material
    // and add spurious edge forces. The cost is missing the last ~15° next to a finished wall,
    // where the chip is thinnest anyway.
    const r = R - 0.5 * cell, ax = cx + u[0] * cell, ay = cy + u[1] * cell;
    let hmax = -Infinity;
    for (let b = 0; b < BINS; b++) {
      const phi = (b + 0.5) / BINS * 2 * Math.PI;
      const sn = Math.sin(phi), cs = Math.cos(phi);
      const h = this.stock.sample(ax + r * (sn * u[0] + cs * vx), ay + r * (sn * u[1] + cs * vy));
      // only the leading half (sinφ > 0) can be in front of the cutter
      Hb[b] = sn > 0.02 ? h : -Infinity;
      if (Hb[b] > hmax) hmax = Hb[b];
    }
    return hmax;
  }

  // material depth above the end face on a polar grid (angle bins × rings) in the cutter's
  // feed frame; returns the largest depth. Rings stop half a cell inside the radius for the
  // same reason as fillEngagement (finished walls smeared by the grid).
  fillEndEngagement(cx, cy, tipZ, u) {
    const Eb = this.engine.Eb, R = this.cfg.tool.R, vx = -u[1], vy = u[0], ball = this.cfg.tool.type === 'ball';
    const rOut = R - 0.5 * Math.max(this.stock.hx, this.stock.hy);
    let dmax = 0;
    for (let b = 0; b < END_BINS; b++) {
      const phi = (b + 0.5) / END_BINS * 2 * Math.PI, sn = Math.sin(phi), cs = Math.cos(phi);
      const ex = sn * u[0] + cs * vx, ey = sn * u[1] + cs * vy;
      for (let j = 0; j < END_RINGS; j++) {
        const r = (j + 0.5) / END_RINGS * rOut;
        const zEdge = ball ? tipZ + R - Math.sqrt(R * R - r * r) : tipZ;
        const d = Math.max(0, this.stock.sample(cx + r * ex, cy + r * ey) - zEdge);
        Eb[b * END_RINGS + j] = d;
        if (d > dmax) dmax = d;
      }
    }
    return { dmax, rOut };
  }

  // engagement angles at the bottom slice, for the lobe diagram
  immersion(tipZ) {
    const Hb = this.engine.Hb, z = tipZ + 0.1;
    let st = null, ex = null;
    for (let b = 0; b < BINS / 2; b++) if (Hb[b] > z) { const phi = (b + 0.5) / BINS * 2 * Math.PI; if (st === null) st = phi; ex = phi; }
    return st === null ? null : { st: Math.max(0, st - Math.PI / BINS), ex: Math.min(Math.PI, ex + Math.PI / BINS) };
  }

  // advance by one animation frame of wall-clock time dtReal [s]
  step(dtReal) {
    if (this.done) { this.updateChips(dtReal); return; }
    const tool = this.cfg.tool, R = tool.R;
    let budgetT = dtReal * this.speed;  // machine time to cover this frame
    const stampStep = Math.min(this.stock.hx, 0.4) * 0.6;
    // estimate substeps so that the dynamics budget can be spread over the frame
    const cur = this.path[this.seg] || this.path[this.path.length - 1];
    const rate = cur.rapid ? 15000 : cur.F * this.cfg.feedOverride;
    const nSubEst = Math.max(1, Math.ceil(budgetT * rate / 60 / stampStep));
    let dynLeft = this.cfg.dynBudget;
    const frameStats = { removed: 0, cutTime: 0, tCut: 0, dynTime: 0 };
    let guard = 0;
    while (budgetT > 1e-9 && !this.done && guard++ < 4000) {
      const a = this.path[this.seg - 1], b = this.path[this.seg];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const v = (b.rapid ? 15000 : b.F * this.cfg.feedOverride) / 60; // mm/s
      const dsMax = b.rapid ? 1.0 : stampStep;
      let ds = Math.min(dsMax, segLen - this.segS, v * budgetT);
      if (segLen - this.segS <= 1e-9) { this.nextSeg(); continue; }
      const dtm = ds / v;
      budgetT -= dtm; this.mtime += dtm;
      this.segS += ds;
      const f = segLen > 0 ? this.segS / segLen : 1;
      const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
      this.line = b.line;
      const dxy = Math.hypot(b.x - a.x, b.y - a.y);
      if (dxy > 1e-6) this.u = [(b.x - a.x) / dxy, (b.y - a.y) / dxy];
      const S = b.S * this.cfg.spindleOverride;
      this.S = S;
      this.F = b.F * this.cfg.feedOverride;
      this.ensureEngine(S);
      const e = this.engine;
      e.setWear(wornEdge(this.mat, this.VB));
      // engagement & dynamics
      // vertical moves: only the end (bottom) edges cut
      const vertical = dxy < 1e-6;
      const hmax = vertical ? -Infinity : this.fillEngagement(p.x, p.y, this.u);
      const ap = Math.min(tool.fluteLen, Math.max(0, hmax - p.z));
      this.ap = ap;
      // descending (plunge / ramp / helix): axial feed per tooth for the end edges
      const fza = !b.rapid && b.z < a.z ? (this.F / (S * tool.N)) * ((a.z - b.z) / segLen) : 0;
      const end = fza > 0 ? this.fillEndEngagement(p.x, p.y, p.z, this.u) : null;
      const endCut = !!end && end.dmax > 2e-4;
      this.plunging = endCut;
      if (vertical && b.z < a.z && b.rapid && this.stock.sample(p.x, p.y) - p.z > 0.01) this.alert('rapid', '早送り(G0)で材料に突入しています');
      if (!vertical && ap > 0.01 && b.rapid) this.alert('rapid', '早送り(G0)で材料に干渉しています');
      if ((ap > 0.01 || endCut) && !b.rapid) {
        const fzEff = dxy > 1e-6 ? (this.F / (S * tool.N)) * (dxy / segLen) : 0;
        e.setEngagement(this.u, fzEff, p.z, ap);
        e.setEndEngagement(endCut ? fza : 0, end ? end.rOut : 0);
        this.fz = fzEff; this.fza = fza;
        // thin-wall compliance at the force centroid (uniform helix: mid-depth)
        this.wall = this.cfg.workpieceFlex && ap > 0.01 ? wallAt(this.stock, p, R, e.Hb, this.u, p.z + ap / 2, this.mat, this.toolStaticK()) : null;
        e.setWork(this.wall);
        // dynamics time for this substep: compressed when the frame budget is short
        const want = Math.max(1, Math.round(dtm / e.dt));
        const cost = tool.N * Math.max(1, e.nz + (endCut ? END_RINGS : 0));
        const share = Math.max(e.stepsPerTooth / 4, dynLeft / cost / Math.max(1, nSubEst - guard + 1));
        const n = Math.max(1, Math.min(want, Math.floor(share)));
        dynLeft -= n * cost;
        const before = e.chipEvents.length;
        e.run(n);
        const compress = want / n;
        this.spawnChips(e, before, compress, p);
        frameStats.cutTime += dtm; frameStats.dynTime += n * e.dt;
        if (endCut && ap <= 0.01) { this.display.phiSt = 0; this.display.phiEx = Math.PI; }
        const imm = ap > 0.01 ? this.immersion(p.z) : null;
        if (imm) { this.display.phiSt = imm.st; this.display.phiEx = imm.ex; }
        // shank / holder collision: material above the flutes inside the tool radius
        if (hmax > p.z + tool.fluteLen + 0.05) this.alert('shank', '切れ刃長を超える切込み: シャンク干渉');
      } else {
        // free decay of the tool vibration when out of cut
        e.x *= 0.5; e.y *= 0.5; e.vx *= 0.5; e.vy *= 0.5;
        e.w *= 0.5; e.wv *= 0.5;
        if (e.wk && Math.abs(e.w) < 1e-7) { this.wall = null; e.setWork(null); }
      }
      // actual tool centre includes deflection + vibration (µm → mm)
      // relative to the workpiece: a wall pushed away by w is cut less (it springs back thicker)
      const dx = (e.x - e.w * e.wnx) * 1e3, dy = (e.y - e.w * e.wny) * 1e3;
      const errVal = Math.hypot(e.x, e.y) * 1e6;
      frameStats.removed += this.stock.stamp(p.x + dx, p.y + dy, p.z, R, tool.type, errVal, { ux: this.u[0], uy: this.u[1], f: (this.fz || 0) * tool.N });
      if (this.wall && e.wk) this.stock.markWall(p.x + dx, p.y + dy, R, e.wnx, e.wny, Math.max(0, e.runMeanW * 1e6));
      this.pos = p;
      if (this.segS >= segLen - 1e-9) this.nextSeg();
    }
    this.collect(frameStats, dtReal);
    this.updateChips(dtReal);
  }

  nextSeg() {
    this.seg++; this.segS = 0;
    if (this.seg >= this.path.length) { this.done = true; this.seg = this.path.length - 1; }
  }

  spawnChips(e, from, compress, p) {
    const ev = e.chipEvents;
    if (ev.length <= from) return;
    const tool = this.cfg.tool, R = tool.R;
    const Vc = e.omega * R; // mm/s
    // glow from the computed chip temperature (dull red from ~450 °C)
    const heat = Math.min(1, Math.max(0.05, (this.temp.chip - 250) / 600));
    for (let k = from; k < ev.length; k++) {
      const c = ev[k];
      const sn = Math.sin(c.phi), cs = Math.cos(c.phi);
      const nx = sn * c.ux + cs * c.vx, ny = sn * c.uy + cs * c.vy;
      const tx = cs * c.ux - sn * c.vx, ty = cs * c.uy - sn * c.vy;
      const pos = [p.x + nx * (R + 0.7), p.y + ny * (R + 0.7), c.z];
      const r = () => 0.8 + Math.random() * 0.4;
      // chips leave roughly along the cutting velocity, lifted by the helix
      const vel = [ (tx * 0.35 + nx * 0.15) * Vc * r(), (ty * 0.35 + ny * 0.15) * Vc * r(), Vc * 0.12 * Math.tan(tool.helixDeg * Math.PI / 180) * r() + 300 ];
      this.chips.emit(pos, vel, c.vol * compress, heat);
    }
    ev.length = 0;
  }

  updateChips(dtReal) {
    const tool = this.cfg.tool, e = this.engine;
    this.chips.flush(10);
    const t = { x: this.pos.x + e.x * 1e3, y: this.pos.y + e.y * 1e3, tipZ: this.pos.z, R: tool.R, len: tool.stickout, omega: e.omega || 0, cutTop: this.pos.z + (this.ap || 0), cutting: (this.ap || 0) > 0.01 };
    // chips move in machine time, capped so that fast-forward stays smooth
    const dt = Math.min(dtReal * this.speed, 0.04);
    this.chips.update(dt, { stock: this.stock, tool: t, coolant: this.cfg.coolant, rho: this.mat.rho, nozzle: { x: t.x - 45, y: t.y - 35, z: t.tipZ + 55 } });
  }

  collect(fs, dtReal) {
    const e = this.engine, st = e.takeStats(), d = this.display;
    const cutting = st.n > 0;
    const cur = {
      F: cutting ? st.sumF / st.n : 0, Fmax: st.maxF, Fz: cutting ? -st.sumFz / st.n : 0,
      T: cutting ? st.sumT / st.n : 0, Tmax: st.maxT,
      defl: cutting ? Math.hypot(st.sumX / st.n, st.sumY / st.n) * 1e6 : 0,
      vib: cutting ? Math.max(st.maxX - st.minX, st.maxY - st.minY) * 1e6 / 2 : 0,
      zc: st.wZc > 0 ? st.sumZc / st.wZc : 0,
      wall: cutting && e.wk ? st.sumW / st.n * 1e6 : 0,
      wallMax: cutting && e.wk ? st.maxW * 1e6 : 0,
      mrr: fs.cutTime > 0 ? fs.removed / (dtReal * this.speed) * 60 / 1000 : 0, // cm³/min
    };
    // smooth for display
    const k = 0.25;
    if (!this.ema) this.ema = { ...cur };
    for (const key in cur) this.ema[key] += (cur[key] - this.ema[key]) * k;
    const m = this.ema;
    const ci = cutting ? e.chatterIndex() : { index: 0, amp: 0 };
    d.chatterIdx += ((cutting ? ci.index : 0) - d.chatterIdx) * 0.2;
    d.once += ((cutting ? ci.once || 0 : 0) - d.once) * 0.2;
    // cutting temperature of the mean chip and flank wear over the time the teeth were in contact
    const contact = cutting ? st.engTeeth / (st.n * e.N) : 0;
    let wearRateNow = 0;
    if (cutting && st.sumB > 0) {
      const Vc = (e.omega || 0) * this.cfg.tool.R * 1e-3; // m/s
      const T = cuttingTemperature(this.mat, st.sumHb / st.sumB, Vc, this.cfg.tool.rakeDeg ?? 10);
      this.temp = { tool: this.temp.tool + (T.tool - this.temp.tool) * 0.3, chip: this.temp.chip + (T.chip - this.temp.chip) * 0.3, shear: T.shear, phi: T.phi, hc: T.hc, h: st.sumHb / st.sumB };
      wearRateNow = wearRate(this.mat, Vc, T.tool) * contact; // mm per second of machining
      this.VB += wearRateNow * fs.cutTime;
    } else {
      // the edge cools between cuts (display only; wear is not accumulated)
      this.temp.tool += (T0 - this.temp.tool) * 0.1; this.temp.chip += (T0 - this.temp.chip) * 0.1;
    }
    d.lifeMin = wearRateNow > 0 ? Math.max(0, VB_LIMIT - this.VB) / wearRateNow / 60 : Infinity;
    const stress = toolStress(this.cfg.tool, this.tm.I, this.tm.De, m.Fmax, m.zc, m.Tmax);
    Object.assign(d, {
      cutting, F: m.F, Fmax: m.Fmax, Fz: m.Fz, torque: m.T / 1000, // N·m
      power: m.T * (e.omega || 0) / 1e6, // kW
      defl: m.defl, vib: m.vib, stress: stress.vm, mrr: m.mrr,
      wallDefl: m.wall, wallMax: m.wallMax, wall: this.wall && cutting ? this.wall : null,
      ap: this.ap || 0, S: this.S || 0, F_: this.F || 0, fz: this.fz || 0, fza: this.plunging ? this.fza : 0,
      tempTool: this.temp.tool, tempChip: this.temp.chip, tempShear: this.temp.shear ?? T0, hMean: this.temp.h || 0, shearDeg: (this.temp.phi || 0) * 180 / Math.PI, VB: this.VB, contact,
      // chatter = vibration that is not synchronous with tooth passing (once-per-tooth scatter)
      state: !cutting ? 'idle' : (d.chatterIdx > 0.55 && d.once > 3) ? 'chatter' : (d.chatterIdx > 0.35 && d.once > 1.5) ? 'marginal' : 'stable',
    });
    if (this.VB > VB_LIMIT) this.alert('wear', `逃げ面摩耗 VB ${this.VB.toFixed(2)} mm: 工具寿命 (VB ${VB_LIMIT} mm) を超過`);
    if (cutting && this.temp.tool > 900) this.alert('heat', `刃先温度 ${this.temp.tool.toFixed(0)} °C: 拡散摩耗・刃先の塑性変形が急増する領域`);
    if (stress.vm > 1500) this.alert('stress', '工具応力が許容値(目安1500 MPa)を超過: 折損リスク');
  }

  alert(key, msg) { this.alerts.set(key, { msg, t: this.mtime }); }
}

function blankDisplay() {
  return { cutting: false, F: 0, Fmax: 0, Fz: 0, torque: 0, power: 0, defl: 0, vib: 0, stress: 0, mrr: 0, ap: 0, S: 0, F_: 0, fz: 0, chatterIdx: 0, once: 0, tempTool: T0, tempChip: T0, tempShear: T0, hMean: 0, shearDeg: 0, VB: 0, contact: 0, lifeMin: Infinity, fza: 0, wallDefl: 0, wallMax: 0, wall: null, state: 'idle', phiSt: 0, phiEx: Math.PI };
}
