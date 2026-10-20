// Simulation orchestrator: walks the tool along the discretized path, updates the
// engagement map from the stock, runs the cutting dynamics, removes material at the
// actual (deflected) tool position and feeds chips into the particle system.

import { parseGcode, discretize, segmentTime } from './gcode.js';
import { Stock } from './stock.js';
import { buildStock, stockExtents, cellFor, stockFromPath, originPreset, bestOrigin, ORIGIN_LABEL, rasterize } from './workpiece.js';
import { applyCutterComp } from './cuttercomp.js';
import { LineReport } from './report.js';
import { CuttingEngine, BINS, END_BINS, END_RINGS } from './cutting.js';
import { ChipSystem, chipEjection, chipShape, bulkRadius, nozzlePose, NOZZLE_DEFAULT } from './chips.js';
import { toolModel, toolStress } from './tool.js';
import { outline, clearanceBands, tipLut, cutterRadiusAt, holderSegs, toolFromStl, holderFromStl, HOLDERS, LUT_DR } from './assembly.js';
import { stabilityLobes, alimAt } from './sld.js';
import { MATERIALS } from './materials.js';
import { wallAt, FN_CAP } from './wall.js';
import { modeSet, staticK } from './frf.js';
import { modesAt, speedDependent, tipFactor, SOFT_DEFAULT } from './spindle.js';

// a material with its shearing coefficients replaced (predicted from its constants, or
// identified); the same object for the same values, so per-material caches stay put
const coefMats = new Map();
function withCoefs(mat, c) {
  if (!c) return mat;
  const key = `${mat.name}|${c.Ktc}|${c.Krc}|${c.Kac}|${c.Kte}|${c.Kre}|${c.Kae}|${c.mc}`;
  let m = coefMats.get(key);
  if (!m) {
    m = { ...mat, Ktc: c.Ktc, Krc: c.Krc, Kac: c.Kac, mc: c.mc ?? mat.mc, coefSource: c.source };
    for (const k of ['Kte', 'Kre', 'Kae']) if (c[k] != null) m[k] = c[k];
    coefMats.set(key, m);
  }
  return m;
}
import { cuttingTemperature, wearRate, wornEdge, VB_LIMIT, T0, edgeCycle } from './thermal.js';

// speed-dependent lobe diagram: an FRF every LOBE_NODE min⁻¹, the curve sampled every LOBE_STEP
const LOBE_NODE = 1000, LOBE_STEP = 25;

export class Simulator {
  constructor() {
    this.engine = new CuttingEngine();
    this.chips = new ChipSystem();
    this.cfg = {
      tool: { D: 10, N: 3, helixDeg: 30, rakeDeg: 10, type: 'flat', fluteLen: 25, stickout: 30, kSpindle: 50000, VB0: 0, runout: 5 }, // runout [µm]
      modal: { auto: true, k: 0, fn: 0, zeta: 0.04 },
      // bearing/holder stiffness loss at speed (spindle.js); drop 0 = dynamics independent of speed
      spindleSoft: { ...SOFT_DEFAULT },
      material: 'A5052', coolant: 'air', nozzle: { ...NOZZLE_DEFAULT }, workpieceFlex: true, cuttingNonlinear: true,
      feedOverride: 1, spindleOverride: 1,
      dynBudget: 220000, // slice-force evaluations per frame (≈ 5 ms of JS)
      cell: 0.3,
    };
    this.speed = 1;
    this.program = '';
  }

  // setup.stock: workpiece spec (workpiece.js) or null to take it from a (STOCK ...) comment, or
  // failing that from the extent of the cutting moves. setup.origin: position of the program
  // zero in the stock frame (stock top-left-front corner = 0,0,0).
  load(program, setup = {}) {
    this.program = program;
    let parsed = parseGcode(program);
    const warnings = [];
    let spec = setup.stock || parsed.meta.stock || null, origin = setup.origin && setup.origin !== 'auto' ? setup.origin : null;
    if (!spec) {
      const auto = stockFromPath(discretize(parsed.moves, 2));
      if (auto) { spec = auto.spec; origin = origin || auto.origin; warnings.push(`素材の指定が無いため、切削送りの範囲から ${spec.w}×${spec.l}×${spec.h} mm の直方体を仮定しました`); }
      else spec = { type: 'box', w: 120, l: 80, h: 30 };
    }
    if (typeof origin === 'string' && origin !== 'auto') origin = originPreset(spec, origin);
    if (!origin) {
      const R = Math.max(this.cfg.tool.D, ...Object.values(parsed.meta.tools).map(t => t.D)) / 2;
      const fit = bestOrigin(spec, discretize(parsed.moves, 2), R);
      origin = fit.origin;
      if (fit.kind !== 'corner') warnings.push(`プログラム原点を「${ORIGIN_LABEL[fit.kind]}」に合わせました (切削送りが素材に最もよく収まる位置)`);
    }
    // work coordinate systems: G54 is the program zero above, the others come from the setup
    // (their zero in the stock frame); a system the setup does not give coincides with G54
    const wcs = { G54: origin };
    for (const [name, z] of Object.entries(setup.wcs || {})) if (name !== 'G54' && z && [z.x, z.y, z.z].every(Number.isFinite)) wcs[name] = z;
    // or as offsets from G54 (the setup sheet's way of putting it)
    for (const [name, d] of Object.entries(setup.wcsDelta || {})) if (name !== 'G54' && d && [d.x, d.y, d.z].every(Number.isFinite)) wcs[name] = { x: origin.x + d.x, y: origin.y + d.y, z: origin.z + d.z };
    this.wcs = wcs;
    // start and home 50 mm above the stock top, which is at program Z = -origin.z
    parsed = parseGcode(program, { start: { x: 0, y: 0, z: 50 - origin.z }, wcs });
    this.wcsUsed = parsed.meta.workOffsets.length ? parsed.meta.workOffsets : ['G54'];
    this.warnings = [...warnings, ...parsed.warnings];
    this.stockSpec = spec; this.origin = origin;
    this.stockSize = stockExtents(spec);
    this.stockCell = cellFor(spec, this.cfg.cell);
    if (this.stockCell > this.cfg.cell) this.warnings.unshift(`素材が大きいため格子を ${this.stockCell} mm に粗くしました`);
    this.baseH = buildStock(spec, this.cfg.cell).H;
    // target shape (finished part) in program coordinates, as the CAM model shares the program zero
    this.target = setup.target || null;
    this.targetH = null;
    if (this.target) {
      const g = new Stock(this.stockSize.w, this.stockSize.l, this.stockSize.h, this.stockCell);
      this.targetH = new Float32Array(g.H.length);
      rasterize(this.target.tris, g, origin.x, origin.y, origin.z, this.targetH);
      for (let k = 0; k < this.targetH.length; k++) this.targetH[k] = Math.min(g.zTop, Math.max(g.zBottom, this.targetH[k] === -Infinity ? g.zBottom : this.targetH[k]));
    }
    this.tools = parsed.meta.tools;
    // cutter compensation with each tool's radius (library, program comment or panel tool)
    let moves = parsed.moves;
    if (moves.some(m => m.comp)) {
      const radius = new Map();
      const c = applyCutterComp(moves, mv => { if (!radius.has(mv.tool)) radius.set(mv.tool, this.toolFor(mv.tool ?? null).D / 2); return radius.get(mv.tool); });
      moves = c.moves;
      this.warnings.push(...c.warnings);
    }
    this.path = discretize(moves, 0.5);
    // each point into the stock frame through its own system's zero and the G52 local shift
    for (const p of this.path) {
      const z = wcs[p.wcs] || origin, l = p.local || { x: 0, y: 0, z: 0 };
      p.x += z.x + l.x; p.y += z.y + l.y; p.z += z.z + l.z;
    }
    this.times = [0];
    for (let i = 1; i < this.path.length; i++) this.times.push(this.times[i - 1] + segmentTime(this.path[i - 1], this.path[i]));
    this.totalTime = this.times[this.times.length - 1] || 0;
    this.reset();
  }

  reset() {
    this.lastCutLine = null;
    const s = this.stockSize;
    this.stock = new Stock(s.w, s.l, s.h, this.stockCell || this.cfg.cell);
    if (this.baseH && this.baseH.length === this.stock.H.length) this.stock.H.set(this.baseH);
    // the same stock cut exactly as commanded (rigid tool, no vibration): the reference for
    // what deflection and chatter did to the part
    this.ideal = new Stock(s.w, s.l, s.h, this.stockCell || this.cfg.cell);
    this.ideal.H.set(this.stock.H);
    const n = this.stock.H.length;
    this.stock.devIdeal = new Float32Array(n);  // simulated − commanded [mm], + = material left
    this.stock.devTarget = new Float32Array(n); // simulated − target [mm], + = material left
    this.devSummary = null; this.devTick = 0;
    this.report = new LineReport();
    // the whole map once: material the program never reaches still counts against the target
    this.updateDeviation({ i0: 0, j0: 0, i1: this.stock.nx - 1, j1: this.stock.ny - 1 });
    this.chips.reset();
    this.seg = 1; this.segS = 0; this.mtime = 0; this.done = this.path.length < 2;
    this.pos = this.path.length ? { ...this.path[0] } : { x: 0, y: 0, z: 50 };
    this.u = [1, 0];
    this.wall = null;
    this.alerts = new Map();
    this.display = blankDisplay();
    this.ema = null;
    this.lastS = -1;
    this.activeT = this.path.find(p => p.tool != null)?.tool ?? null;
    this.hits = []; this.hitDepth = {}; this.frameClear = Infinity; this.collide = null;
    // flank wear [mm] per tool (T number), carried through the whole program
    this.wear = new Map();
    this.temp = { tool: T0, chip: T0 };
    this.reconfigure();
  }

  // the tool a T number stands for: a tool-library entry or a definition in the program
  // comments on top of the tool set up in the panel (which also serves every undefined T).
  // The holder is the library entry's own, else the panel's preset or imported mesh.
  toolFor(T) {
    const base = this.cfg.tool, a = this.assets || {};
    const d = T != null ? (a.library?.[T] || this.tools?.[T]) : null;
    let t;
    if (!d) {
      t = { ...base, T };
      if (a.stlTool) Object.assign(t, toolFromStl(a.stlTool, base.fluteLen), { type: 'profile', stlTool: true, stlMesh: a.stlTool });
    } else {
      t = { ...base, T, D: d.D, type: d.type, N: d.N ?? base.N, fluteLen: d.fluteLen ?? base.fluteLen, stickout: d.stickout ?? base.stickout, label: d.label,
        cornerR: d.cornerR, shankD: d.shankD, neckD: d.neckD, neckLen: d.neckLen, drill: d.drill };
      if (d.helixDeg != null) t.helixDeg = d.helixDeg;
    }
    if (t.stickout < t.fluteLen + 2) t.stickout = t.fluteLen + 2;
    if (d?.holderSegs) { t.holderSegs = d.holderSegs; t.holderName = d.holderName; }
    else if (a.stlHolder) { t.stlHolder = holderFromStl(a.stlHolder); t.stlHolderMesh = a.stlHolder; t.holderName = a.stlHolderName || 'STL'; }
    else if (base.holder && base.holder !== 'none') { t.holderSegs = holderSegs(base.holder, t.shankD || t.D); t.holderName = HOLDERS[base.holder].name; }
    if (t.stlTool === true) t.stlTool = { bands: t.bands };
    t.outline = outline(t);
    t.bands = clearanceBands(t);
    // the engine and the stamp need the edge shape only when it is not flat or a full ball
    if (t.type === 'bull' || t.edge) { t.lut = tipLut(t); t.rAt = z => cutterRadiusAt(t, z); }
    return t;
  }
  // flank wear of the active tool; a tool starts with the panel's initial wear
  get VB() { const k = this.activeT ?? 'panel'; if (!this.wear.has(k)) this.wear.set(k, this.cfg.tool.VB0 || 0); return this.wear.get(k); }
  set VB(v) { this.wear.set(this.activeT ?? 'panel', v); }

  // imported meshes and tool libraries (kept out of cfg, which travels as JSON)
  setAssets(a) { this.assets = a; this.reconfigure(); }
  setActiveTool(T) {
    if (T === this.activeT) return;
    this.activeT = T;
    this.reconfigure();
    // a different tool: its vibration and chip history do not carry over
    const e = this.engine;
    e.x = e.y = e.vx = e.vy = 0;
    // a fresh edge comes in cold
    this.temp = { tool: T0, chip: T0 };
  }

  // recompute tool/modal model and lobes; called when parameters change
  reconfigure() {
    this.cfg.tool.R = this.cfg.tool.D / 2;
    const t = this.activeTool = this.toolFor(this.activeT ?? null);
    t.R = t.D / 2;
    // height of the end edges above the tip at radius r (the floor shape the tool leaves)
    this.tipZAt = t.lut ? r => t.lut[Math.min(t.lut.length - 1, Math.round(r / LUT_DR))]
      : t.type === 'ball' ? r => t.R - Math.sqrt(Math.max(0, t.R * t.R - r * r)) : () => 0;
    this.toolVersion = (this.toolVersion || 0) + 1;
    this.tm = toolModel(t);
    if (this.cfg.modal.auto) { this.cfg.modal.k = Math.round(this.tm.k); this.cfg.modal.fn = Math.round(this.tm.fn); }
    this.mat = withCoefs(MATERIALS[this.cfg.material], this.cfg.coefs?.[this.cfg.material]);
    this.lastS = -1;
    this.lobeCaches = null;
  }

  // tool-tip modes at spindle speed S (default: the current speed); S = 0 is the tool at rest,
  // as a hammer test measures it
  modalNow(S = this.S || 0) {
    const m = this.cfg.modal;
    const ms = modesAt(m, S, this.chain(), this.cfg.spindleSoft);
    return { k: m.k, fn: m.fn, zeta: m.zeta, modesX: ms.x, modesY: ms.y };
  }
  // compliance chain of the active tool for the speed model: its own bending and the spindle
  chain() {
    if (!this.tm) return null;
    const kSp = this.activeTool?.kSpindle ?? this.cfg.tool.kSpindle, sm = this.cfg.modal.spindleMode;
    // optional spindle/holder mode: its mass from the spindle stiffness and its natural frequency
    const twoDof = sm?.on ? { mTool: this.tm.mEff, mSp: kSp * 1e3 / (2 * Math.PI * (sm.fn || 1200)) ** 2, zSp: sm.zeta ?? 0.05 } : null;
    return { kTool: this.tm.kTool, kSp, twoDof };
  }
  // tool-tip stiffness at speed relative to rest
  speedFactor(S = this.S || 0) {
    if (this.cfg.modal.speedFrfs?.length) return null; // measured at speed: no model factor
    const c = this.chain();
    return c ? tipFactor(S, c.kTool, c.kSp, this.cfg.spindleSoft) : 1;
  }
  // all modes of the tool tip in x and y
  modes(S) { return modeSet(this.modalNow(S)); }
  toolStaticK() { const m = this.modes(); return Math.min(staticK(m.x), staticK(m.y)); }

  ensureEngine(S) {
    if (Math.abs(S - this.lastS) < 1) return;
    const t = this.activeTool;
    this.engine.configure({ N: t.N, R: t.R, helixDeg: t.helixDeg, type: t.type, rAt: t.rAt, fluteLen: t.fluteLen, nonlinear: this.cfg.cuttingNonlinear, runout: (t.runout ?? 0) / 1000 }, this.modalNow(S), this.mat, S, this.cfg.workpieceFlex ? FN_CAP : 0);
    this.lastS = S;
  }

  // Stability lobes for the current engagement. When the dynamics depend on the speed, each
  // speed has its own lobe diagram: the limit at S is read from the diagram of the FRF at S
  // (one composite curve). staticOnly: the diagram of the tool at rest, for comparison.
  lobes(phiSt, phiEx, staticOnly = false) {
    const m = this.cfg.modal, dep = !staticOnly && speedDependent(m, this.cfg.spindleSoft);
    const key = `${phiSt.toFixed(2)}|${phiEx.toFixed(2)}|${m.k}|${m.fn}|${m.zeta}|${JSON.stringify(m.modesX)}|${JSON.stringify(m.modesY)}|${JSON.stringify(m.speedFrfs)}|${this.cfg.material}|${this.activeTool.N}|${dep ? JSON.stringify(this.cfg.spindleSoft) + this.tm?.kTool : 'static'}|${JSON.stringify(m.auto ? m.spindleMode : null)}`;
    const cache = this.lobeCaches || (this.lobeCaches = new Map());
    if (cache.has(key)) return cache.get(key);
    if (cache.size > 8) cache.clear();
    const base = { N: this.activeTool.N, Ktc: this.mat.Ktc, Krc: this.mat.Krc, phiSt, phiEx, lobes: 30, rpmMin: 2000, rpmMax: 40000 };
    let out;
    if (!dep) out = stabilityLobes({ ...this.modalNow(0), ...base });
    else {
      // one diagram per LOBE_NODE of speed (the FRF changes by well under 1 % across it),
      // each read only around its own speed
      const curve = [], lo = base.rpmMin * 0.8, hi = base.rpmMax * 1.1;
      for (let S0 = lo; S0 < hi; S0 += LOBE_NODE) {
        const lob = stabilityLobes({ ...this.modalNow(S0 + LOBE_NODE / 2), ...base, rpmMin: S0, rpmMax: S0 + LOBE_NODE });
        for (let S = S0; S < Math.min(hi, S0 + LOBE_NODE); S += LOBE_STEP) {
          const a = alimAt(lob, S);
          curve.push({ rpm: S, alim: a === Infinity ? 1e3 : a });
        }
      }
      out = [curve];
    }
    cache.set(key, out);
    return out;
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
    const Hb = this.engine.Hb, R = this.activeTool.R, vx = -u[1], vy = u[0];
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
    const Eb = this.engine.Eb, t = this.activeTool, R = t.R, vx = -u[1], vy = u[0], zAt = this.tipZAt;
    const rOut = R - 0.5 * Math.max(this.stock.hx, this.stock.hy);
    let dmax = 0;
    for (let b = 0; b < END_BINS; b++) {
      const phi = (b + 0.5) / END_BINS * 2 * Math.PI, sn = Math.sin(phi), cs = Math.cos(phi);
      const ex = sn * u[0] + cs * vx, ey = sn * u[1] + cs * vy;
      for (let j = 0; j < END_RINGS; j++) {
        const r = (j + 0.5) / END_RINGS * rOut;
        const zEdge = tipZ + zAt(r);
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
    const tool = this.activeTool, R = tool.R;
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
      if (b.tool !== undefined && b.tool !== this.activeT) this.setActiveTool(b.tool);
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
        e.setEndEngagement(endCut ? fza : 0, end ? end.rOut : 0, this.tipZAt);
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
        if (this.seeking) e.chipEvents.length = before; // no chips while jumping ahead
        else this.spawnChips(e, before, compress, p);
        frameStats.cutTime += dtm; frameStats.dynTime += n * e.dt;
        if (endCut && ap <= 0.01) { this.display.phiSt = 0; this.display.phiEx = Math.PI; }
        const imm = ap > 0.01 ? this.immersion(p.z) : null;
        if (imm) { this.display.phiSt = imm.st; this.display.phiEx = imm.ex; }
        // shank / holder collision: material above the flutes inside the tool radius
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
      this.stock.curLine = this.ideal.curLine = this.line || 0;
      this.ideal.stamp(p.x, p.y, p.z, R, tool.type === 'profile' ? 'flat' : tool.type, 0, null, tool.lut || null);
      frameStats.removed += this.stock.stamp(p.x + dx, p.y + dy, p.z, R, tool.type === 'profile' ? 'flat' : tool.type, errVal, { ux: this.u[0], uy: this.u[1], f: (this.fz || 0) * tool.N }, tool.lut || null);
      // the shank and holder move with the deflected tool
      this.checkClearance({ x: p.x + dx, y: p.y + dy, z: p.z }, b.rapid);
      if (this.wall && e.wk) this.stock.markWall(p.x + dx, p.y + dy, R, e.wnx, e.wny, Math.max(0, e.runMeanW * 1e6));
      this.pos = p;
      const cutNow = (ap > 0.01 || endCut) && !b.rapid;
      this.report.time(b.line, dtm, cutNow);
      if (cutNow) this.lastCutLine = b.line;
      if (this.segS >= segLen - 1e-9) this.nextSeg();
    }
    this.updateDeviation(this.stock.dirty);
    this.collect(frameStats, dtReal);
    this.updateChips(dtReal);
  }

  // Deviation maps over the rectangle that changed (it may extend a cell either side).
  // Floors and 3D surfaces: the height difference, exact. Walls: the difference of the closest
  // cutter edge (stock.wallD), below the grid spacing. Where the simulated edge crossed a cell
  // the commanded one left standing (or the reverse), the error is at least that cell's distance
  // to the other edge; the height difference there is the wall height and says nothing.
  // Against the target, cells where the commanded cut already disagrees at a wall step of the
  // target are only known to a grid cell: ± half a cell.
  updateDeviation(rect) {
    const s = this.stock, id = this.ideal, T = this.targetH;
    if (!s.devIdeal || rect.i1 < 0) return;
    const nx = s.nx, half = Math.max(s.hx, s.hy) / 2;
    const i0 = Math.max(0, rect.i0 - 1), i1 = Math.min(nx - 1, rect.i1 + 1), j0 = Math.max(0, rect.j0 - 1), j1 = Math.min(s.ny - 1, rect.j1 + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i;
      const Da = s.wallD[k], Di = id.wallD[k], fa = Da !== Infinity, fi = Di !== Infinity;
      const V = s.H[k] - id.H[k];
      let dev;
      if (Math.abs(V) <= 1e-4) dev = fa && fi ? Da - Di : 0;
      // (the tool has no axial dynamics, so a height difference at a wall cell is a flip; a
      // later, deeper pass may have set the wall distance of a flipped cell again)
      else if (V < 0 && fi) dev = -Math.max(Di, 1e-3);
      else if (V > 0 && fa) dev = Math.max(Da, 1e-3);
      else dev = V;
      s.devIdeal[k] = dev;
      if (T) {
        if (Math.abs(id.H[k] - T[k]) <= 1e-3) s.devTarget[k] = dev;
        else {
          const Vt = s.H[k] - T[k];
          // a wall step of the target next to this cell (≥ 1 mm between neighbours)
          const t = T[k], step = Math.max(i > 0 ? Math.abs(t - T[k - 1]) : 0, i < nx - 1 ? Math.abs(t - T[k + 1]) : 0, j > 0 ? Math.abs(t - T[k - nx]) : 0, j < s.ny - 1 ? Math.abs(t - T[k + nx]) : 0);
          s.devTarget[k] = step >= 1 && Math.abs(Vt) > half ? Math.sign(Vt) * half : Vt;
        }
      }
    }
  }

  // Summary of the deviation maps over the cells that were machined or that the target says
  // must be: largest material left / gouge (with where and which line), share within tolerance.
  deviationSummary(tol = this.cfg.tol ?? 0.05) {
    const s = this.stock, T = this.targetH;
    if (!s.devIdeal) return null;
    const res = { ideal: { left: 0, gouge: 0, kLeft: -1, kGouge: -1 }, target: T ? { left: 0, gouge: 0, kLeft: -1, kGouge: -1, n: 0, inTol: 0 } : null };
    const top = s.zTop - 1e-3;
    for (let k = 0; k < s.H.length; k++) {
      const machined = s.H[k] < top || Number.isFinite(s.wallD[k]);
      if (machined) {
        const v = s.devIdeal[k], r = res.ideal;
        if (v > r.left) { r.left = v; r.kLeft = k; }
        if (v < r.gouge) { r.gouge = v; r.kGouge = k; }
      }
      if (T && (machined || T[k] < top)) {
        const v = s.devTarget[k], r = res.target;
        r.n++; if (Math.abs(v) <= tol) r.inTol++;
        if (v > r.left) { r.left = v; r.kLeft = k; }
        if (v < r.gouge) { r.gouge = v; r.kGouge = k; }
      }
    }
    // the line responsible: the one that cut the cell for a height error, the one that left
    // the wall for a wall error
    const where = (k, ref) => k < 0 ? null : { x: (k % s.nx) * s.hx - this.origin.x, y: Math.floor(k / s.nx) * s.hy - this.origin.y, z: s.H[k] - this.origin.z,
      line: (Math.abs(s.H[k] - ref[k]) > 1e-4 ? s.lineCut[k] : s.lineWall[k]) || s.lineCut[k] || s.lineWall[k] };
    res.ideal.atLeft = where(res.ideal.kLeft, this.ideal.H); res.ideal.atGouge = where(res.ideal.kGouge, this.ideal.H);
    if (T) { res.target.atLeft = where(res.target.kLeft, T); res.target.atGouge = where(res.target.kGouge, T); }
    res.tol = tol;
    return res;
  }

  // Everything above the flutes (neck, shank, holder, spindle nose) must clear the stock.
  // Checked at every substep while any of it is below the stock top; the minimum clearance
  // over the frame goes to the display.
  checkClearance(p, rapid) {
    const bands = this.activeTool.bands, s = this.stock;
    if (!bands.length || p.z + bands[0].z0 > s.zTop + 0.01) return;
    for (const b of bands) {
      const bottom = p.z + b.z0;
      if (bottom > s.zTop) break;
      // half a cell inside: the grid leaves the cells just outside a finished wall standing,
      // so a shank as wide as the cutter would otherwise always "touch" the wall it cut
      const m = s.maxInDisk(p.x, p.y, b.r - 0.5 * Math.max(s.hx, s.hy));
      if (m.h === -Infinity) continue;
      const gap = bottom - m.h;
      if (gap < this.frameClear) this.frameClear = gap;
      if (gap < -0.02) {
        const what = b.part === 'holder' ? 'ホルダー' : b.part === 'spindle' ? '主軸' : (this.activeTool.neckD && b.r < (this.activeTool.shankD || this.activeTool.D) / 2 ? '首' : 'シャンク');
        // report the deepest interference of this part so far, not the latest graze
        const prev = this.hitDepth[b.part] || 0;
        if (-gap >= prev) { this.hitDepth[b.part] = -gap; this.alert('hit-' + b.part, `${what}が素材に干渉 (最大 ${(-gap).toFixed(1)} mm 食い込み・${this.line}行${rapid ? '・早送り' : ''})`); }
        else this.alerts.get('hit-' + b.part).t = this.mtime;
        this.hits.push({ x: m.x, y: m.y, z: m.h, part: b.part, line: this.line });
        if (this.hits.length > 200) this.hits.shift();
        this.collide = b.part;
      }
    }
  }

  // Run ahead to machine time t [s] as fast as possible (from the start when t is behind):
  // the full material removal and thermal / wear history, the dynamics thinned out to a few
  // steps per tooth per substep, no chips. A frame of up to 2 s of machine time per step.
  seekTo(t) {
    if (t < this.mtime - 1e-6) this.reset();
    const speed = this.speed, budget = this.cfg.dynBudget;
    this.seeking = true; this.speed = 1; this.cfg.dynBudget = 5e4;
    let guard = 0;
    // steps of a quarter second of machine time: as fine as fast playback, so the machining report
    // (frame statistics credited per line) comes out the same as when the program is played
    while (!this.done && this.mtime < t - 1e-6 && guard++ < 100000) this.step(Math.min(0.25, t - this.mtime));
    this.seeking = false; this.speed = speed; this.cfg.dynBudget = budget;
    this.chips.reset();
  }

  nextSeg() {
    this.seg++; this.segS = 0;
    if (this.seg >= this.path.length) { this.done = true; this.seg = this.path.length - 1; }
  }

  spawnChips(e, from, compress, p) {
    const ev = e.chipEvents;
    if (ev.length <= from) return;
    const tool = this.activeTool, R = tool.R, mat = this.mat;
    const Vc = e.omega * R; // mm/s
    // glow from the computed chip temperature (dull red from ~450 °C)
    const heat = Math.min(1, Math.max(0.05, (this.temp.chip - 250) / 600));
    // mean undeformed chip thickness over the engagement arc, thickened by the compression ratio
    const d = this.display, st = d.phiSt ?? 0, ex = Math.max(st + 0.05, d.phiEx ?? Math.PI);
    const fz = this.fz || 0, cosD = Math.cos(st) - Math.cos(ex);
    const lam = mat.lam ?? 2, hm = fz * cosD / (ex - st);
    const shape = chipShape(mat, lam * Math.max(0.003, hm));
    this.flutePacking(fz, cosD, ex - st, this.ap || 0);
    const ap = this.ap || 0;
    for (let k = from; k < ev.length; k++) {
      const c = ev[k];
      const ej = chipEjection(c, R, e.omega, tool.helixDeg, lam);
      // leave from the exit edge, carried a little along the cutting direction so the chip
      // starts clear of the cutter (|offset| > R + r) and inside the cut
      const vol = c.vol * compress, r = bulkRadius(vol, shape.Rb), off = 2 * Math.sqrt(R * r) + 0.3;
      const zc = Math.max(p.z + r, (p.z + c.z) / 2, p.z + Math.min(ap, 2 * r) / 2);
      const pos = [p.x + ej.nx * (R - r) + ej.tx * off, p.y + ej.ny * (R - r) + ej.ty * off, zc];
      // scatter: ±15 % speed, ~10° in direction
      const k1 = 0.85 + 0.3 * Math.random(), sc = 0.17 * Vc;
      const vel = [ej.vel[0] * k1 + (Math.random() - 0.5) * sc, ej.vel[1] * k1 + (Math.random() - 0.5) * sc, ej.vel[2] * k1 + (Math.random() - 0.5) * sc * 0.5];
      this.chips.emit(pos, vel, vol, heat, shape);
    }
    ev.length = 0;
  }

  // Flute chip packing (切りくず詰まり): bulk chip volume per tooth (solid volume × bulk factor
  // Rb) against the gullet volume over the engaged length. The solid chip per tooth is
  // fz·ap·R·(cosφst − cosφex); the gullet is about half the annulus between the core (0.62R)
  // and R per flute. Only enclosed cuts (≥ 120° immersion) trap the chip in the flute until
  // the tooth exits; deep cuts (ap > 1.5D) must also lift it along a longer flute.
  flutePacking(fz, cosD, arc, ap) {
    const t = this.activeTool, R = t.R, Rb = this.mat.Rb ?? 5;
    const gullet = 0.5 * Math.PI * R * R * (1 - 0.62 ** 2) / t.N;
    const P = Rb * fz * R * cosD / gullet;
    this.display.pack += (P - this.display.pack) * 0.3;
    const limit = ap > 3 * R ? 0.45 : 0.6;
    if (arc >= 2 * Math.PI / 3 && this.display.pack > limit) this.alert('pack', `切りくず詰まりの恐れ: 1刃の切りくずの嵩が刃溝の ${Math.round(this.display.pack * 100)}% (目安 ${Math.round(limit * 100)}%以下)`);
  }

  updateChips(dtReal) {
    const tool = this.activeTool, e = this.engine;
    this.chips.flush(10);
    const eta = tool.helixDeg * Math.PI / 180;
    const t = { x: this.pos.x + e.x * 1e3, y: this.pos.y + e.y * 1e3, tipZ: this.pos.z, R: tool.R, len: tool.stickout, omega: this.S > 0 ? (e.omega || 0) : 0, sinCos: Math.sin(eta) * Math.cos(eta), cutTop: this.pos.z + (this.ap || 0), cutting: (this.ap || 0) > 0.01, ux: this.u[0], uy: this.u[1] };
    // chips move in machine time, capped so that fast-forward stays smooth
    const dt = Math.min(dtReal * this.speed, 0.04);
    this.chips.update(dt, { stock: this.stock, tool: t, coolant: this.cfg.coolant, nozzle: nozzlePose({ x: t.x, y: t.y, z: t.tipZ }, this.cfg.nozzle) });
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
    if (!cutting) d.pack *= 0.8;
    // deviation summary about twice a second of real time, and at the end of the program
    if (++this.devTick % 30 === 0 || this.done) d.dev = this.deviationSummary();
    // cutting temperature of the mean chip and flank wear over the time the teeth were in contact
    const contact = cutting ? st.engTeeth / (st.n * e.N) : 0;
    let wearRateNow = 0;
    if (cutting && st.sumB > 0) {
      const Vc = (e.omega || 0) * this.activeTool.R * 1e-3; // m/s
      const T = cuttingTemperature(this.mat, st.sumHb / st.sumB, Vc, this.activeTool.rakeDeg ?? 10);
      // each edge is in the cut for `contact` of the revolution: the temperature cycle, and the
      // mean while cutting for the wear law (below the steady value when the contact is short)
      const cyc = edgeCycle(T.tool, this.S || 0, contact, 2 * T.hc, this.cfg.coolant);
      const ease = (a, b) => a + (b - a) * 0.3;
      const pc = this.temp.cycle || cyc;
      this.temp = { tool: ease(this.temp.tool, T.tool), chip: ease(this.temp.chip, T.chip), shear: T.shear, phi: T.phi, hc: T.hc, h: st.sumHb / st.sumB,
        cycle: { max: ease(pc.max, cyc.max), min: ease(pc.min, cyc.min), swing: ease(pc.swing, cyc.swing), stress: ease(pc.stress, cyc.stress), onMean: ease(pc.onMean, cyc.onMean), tOn: cyc.tOn } };
      wearRateNow = wearRate(this.mat, Vc, cyc.onMean) * contact; // mm per second of machining
      this.VB += wearRateNow * fs.cutTime;
    } else {
      // the edge cools between cuts (display only; wear is not accumulated)
      this.temp.tool += (T0 - this.temp.tool) * 0.1; this.temp.chip += (T0 - this.temp.chip) * 0.1;
      this.temp.cycle = null;
    }
    d.lifeMin = wearRateNow > 0 ? Math.max(0, VB_LIMIT - this.VB) / wearRateNow / 60 : Infinity;
    const stress = this.tm.assembly ? this.sectionStress(m.Fmax, m.zc, m.Tmax) : toolStress(this.activeTool, this.tm.I, this.tm.De, m.Fmax, m.zc, m.Tmax);
    const clear = this.frameClear; this.frameClear = Infinity;
    d.clearance = clear === Infinity ? (d.clearance ?? null) : clear;
    d.collide = this.collide; this.collide = null;
    Object.assign(d, {
      cutting, F: m.F, Fmax: m.Fmax, Fz: m.Fz, torque: m.T / 1000, // N·m
      power: m.T * (e.omega || 0) / 1e6, // kW
      defl: m.defl, vib: m.vib, stress: stress.vm, mrr: m.mrr,
      wallDefl: m.wall, wallMax: m.wallMax, wall: this.wall && cutting ? this.wall : null,
      ap: this.ap || 0, S: this.S || 0, F_: this.F || 0, fz: this.fz || 0, fza: this.plunging ? this.fza : 0,
      tempTool: this.temp.tool, tempCycle: cutting ? this.temp.cycle || null : null, tempChip: this.temp.chip, tempShear: this.temp.shear ?? T0, hMean: this.temp.h || 0, shearDeg: (this.temp.phi || 0) * 180 / Math.PI, VB: this.VB, contact,
      // chatter = vibration that is not synchronous with tooth passing (once-per-tooth scatter)
      state: !cutting ? 'idle' : (d.chatterIdx > 0.55 && d.once > 3) ? 'chatter' : (d.chatterIdx > 0.35 && d.once > 1.5) ? 'marginal' : 'stable',
    });
    // the frame's cutting statistics belong to the line that cut (the frame may end on a retract)
    if (cutting) this.report.sample(this.lastCutLine ?? this.line, { F: cur.Fmax, vib: cur.vib, defl: cur.defl, temp: this.temp.cycle?.max ?? this.temp.tool, stress: stress.vm, swing: this.temp.cycle?.swing || 0, h: st.sumB > 0 ? st.sumHb / st.sumB : 0 }, d.state, fs.cutTime);
    if (this.activeT !== undefined) this.report.toolWear(this.activeT, this.VB, this.activeTool?.VB0 ?? this.cfg.tool.VB0 ?? 0);
    if (this.VB > VB_LIMIT) this.alert('wear', `逃げ面摩耗 VB ${this.VB.toFixed(2)} mm: 工具寿命 (VB ${VB_LIMIT} mm) を超過`);
    if (cutting && this.temp.tool > 900) this.alert('heat', `刃先温度 ${this.temp.tool.toFixed(0)} °C: 拡散摩耗・刃先の塑性変形が急増する領域`);
    if (stress.vm > 1500) this.alert('stress', '工具応力が許容値(目安1500 MPa)を超過: 折損リスク');
  }

  // stepped tool: the worst section is the top of the flutes, of a neck, or the holder face
  sectionStress(F, zc, T) {
    const t = this.activeTool;
    let worst = { vm: 0 };
    for (const b of t.outline) {
      if (b.part !== 'flute' && b.part !== 'shank') continue;
      const De = 2 * b.r * (b.part === 'flute' ? 0.8 : 1), I = Math.PI * De ** 4 / 64;
      const r = toolStress({ stickout: Math.min(b.z1, t.stickout) }, I, De, F, zc, T);
      if (r.vm > worst.vm) worst = { ...r, z: b.z1 };
    }
    return worst;
  }

  alert(key, msg) { this.alerts.set(key, { msg, t: this.mtime }); }
}

function blankDisplay() {
  return { cutting: false, F: 0, Fmax: 0, Fz: 0, torque: 0, power: 0, defl: 0, vib: 0, stress: 0, mrr: 0, ap: 0, S: 0, F_: 0, fz: 0, chatterIdx: 0, once: 0, pack: 0, tempTool: T0, tempChip: T0, tempShear: T0, hMean: 0, shearDeg: 0, VB: 0, contact: 0, lifeMin: Infinity, fza: 0, wallDefl: 0, wallMax: 0, wall: null, state: 'idle', phiSt: 0, phiEx: Math.PI };
}
