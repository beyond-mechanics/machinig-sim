// Chip evacuation. Each particle stands for one or more real chips of the same shape: its
// aerodynamics come from one real chip (mass and projected area from the chip volume and the
// deformed chip thickness), its volume and contact radius from all the chips it carries.
// Fluid force is quadratic drag ½·ρ_f·Cd·A·|u−v|(u−v) with buoyancy and added mass, integrated
// implicitly so that chips in liquid (relaxation time well under a millisecond) stay stable.
// The fluid velocity is assembled from engineering correlations instead of a CFD solution, so
// it stays real time: a round free jet (air: momentum-conserving turbulent jet, liquid: coherent
// stream), the radial wall jet it turns into on impact (blocked by heightfield walls, washing up
// them and over rims), a shallow-water coolant layer over the stock (pools in pockets, drains
// off edges), the swirl around the spindle and eddy fluctuations as a random walk.
// Chips collide with the heightfield (restitution + Coulomb friction), the rotating tool and
// each other (position-based soft spheres on a spatial hash), and sleep when at rest until the
// flow beats static friction, their support goes or the tool touches them.
// Units: mm, s, kg (forces in kg·mm/s² = mN).

export const MAX_CHIPS = 5000;
export const G = 9810;                // mm/s²
export const RHO_AIR = 1.2e-9;        // kg/mm³
export const RHO_LIQ = 1.0e-6;        // water-miscible coolant (emulsion)
export const CD = 1.2;                // tumbling thin plates / curls, Re 10²–10⁴
const CA = 0.5;                       // added-mass coefficient
const E_WALL = 0.3, E_CHIP = 0.1;     // restitution chip–metal, chip–chip
const R_MIN = 0.25, R_MAX = 1.5;      // contact radius clamp [mm] (also the hash cell, so kept small)
const PACK = 0.64;                    // loose chips fill a sphere pile like random packing
const RAKE = 8 * Math.PI / 180;       // radial rake of a typical carbide end mill
const TURB_T = 0.012;                 // Lagrangian time scale of the eddies [s]
const NEAR_BED = 0.6;                 // flow at a resting chip's height vs. the free value
const WET_MU = 0.6;                   // coolant film lowers friction
const CAVITY = 0.15;                  // cavity flow below a skimming stream, relative to it

// d0 nozzle (hole) diameter [mm], U0 exit velocity [mm/s]. Air: shop air through a ~2.5 mm
// nozzle at ~0.4 MPa. Flood: one ~5 mm nozzle at 4 m/s (≈ 4.7 L/min). Through-tool: two 1 mm
// holes in the tool at ≈ 3 MPa (≈ 40 m/s after losses, 3.8 L/min).
export const COOLANTS = {
  dry: null,
  air: { jet: 'nozzle', liquid: false, d0: 2.5, U0: 120e3 },
  flood: { jet: 'nozzle', liquid: true, d0: 5, U0: 4e3 },
  through: { jet: 'tool', liquid: true, d0: 1.0, holes: 2, U0: 40e3 },
};
export const coolantFlow = c => c ? (c.holes || 1) * Math.PI * c.d0 ** 2 / 4 * c.U0 : 0; // mm³/s

// spindle-mounted nozzle: azimuth [deg] around the tool, height above the tip and horizontal
// distance [mm]; it always aims at the tool tip
export const NOZZLE_DEFAULT = { az: 218, h: 55, dist: 57 };
export function nozzlePose(tip, noz = NOZZLE_DEFAULT) {
  const a = (noz.az ?? NOZZLE_DEFAULT.az) * Math.PI / 180, d = noz.dist ?? NOZZLE_DEFAULT.dist, h = noz.h ?? NOZZLE_DEFAULT.h;
  const x = tip.x + d * Math.cos(a), y = tip.y + d * Math.sin(a), z = tip.z + h;
  const L = Math.sqrt(d * d + h * h);
  return { x, y, z, ex: (tip.x - x) / L, ey: (tip.y - y) / L, ez: (tip.z - z) / L, L };
}

// Round free jet. Air in air: turbulent jet, Gaussian profile u = Uc·exp(−ln2·r²/b²) with
// half-width b = 0.094·x; momentum ∫u²dA = π·Uc²·b²/(2 ln2) is conserved, so Uc·b is constant
// and Uc = U0·6.26·d0/x after the potential core. Liquid in air: a coherent stream that keeps
// its speed and widens only slightly before it breaks up.
const JET_S = 0.094;
const JET_B0 = Math.sqrt(Math.LN2 / 2); // half-width carrying the top-hat nozzle momentum (0.589·d0)
export function freeJet(x, U0, d0, liquid = false) {
  if (liquid) return { Uc: U0, b: d0 / 2 + 0.01 * x };
  const b = Math.max(JET_B0 * d0, JET_S * x);
  return { Uc: U0 * JET_B0 * d0 / b, b };
}

// one chip's drag parameter β = Cd·A/m [mm²/kg] from its deformed thickness hc [mm]:
// m = ρ·L·b·hc and A = kA·L·b, so A/m = kA/(ρ·hc)
export function chipShape(mat, hc) {
  const rho = (mat.rho || 2700) * 1e-9;
  return { beta: CD * (mat.kA ?? 0.35) / (rho * Math.max(0.005, hc)), rhoc: rho, Rb: mat.Rb ?? 5, mu: mat.mu ?? 0.5 };
}
// contact radius of a particle carrying `vol` mm³ of solid chips
export const bulkRadius = (vol, Rb) => Math.min(R_MAX, Math.max(R_MIN, Math.cbrt(3 * PACK * vol * Rb / (4 * Math.PI))));

// Velocity of a chip as it leaves the flute. The chip slides up the rake face at V_c/λ relative
// to the tooth (chip compression ratio λ); with a helical edge it flows at the chip-flow angle
// η ≈ helix angle (Stabler's rule), i.e. up the flute. The radial (inward) part is taken by the
// gullet that curls the chip, so in the world frame it leaves with the edge speed along the
// cutting direction, slowed by the rake component, plus the axial lift. c: chip event with the
// exit angle φ and the feed frame (u, v); returns the tangent t, normal n and velocity.
export function chipEjection(c, R, omega, helixDeg, lam) {
  const sn = Math.sin(c.phi), cs = Math.cos(c.phi);
  const nx = sn * c.ux + cs * c.vx, ny = sn * c.uy + cs * c.vy;   // outward edge normal
  const tx = cs * c.ux - sn * c.vx, ty = cs * c.uy - sn * c.vy;   // edge velocity direction
  const Vc = omega * R, eta = helixDeg * Math.PI / 180;
  const vt = Vc * (1 - Math.sin(RAKE) * Math.cos(eta) / lam), vz = Vc * Math.sin(eta) / lam;
  return { nx, ny, tx, ty, vel: [tx * vt, ty * vt, vz] };
}

const HASH_N = 1 << 14;
const NIT = 3; // contact projection iterations per step
// Teschner's primes, then a Fibonacci multiply keeping the high bits (the low bits of the plain
// XOR collide badly for the small coordinate ranges of one stock)
const hashKey = (x, y, z) => Math.imul(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791), 0x9E3779B1) >>> 18;

const _F = new Float64Array(5); // fluid sample: ux, uy, uz, ρ_f, σ (eddy velocity rms)

export class ChipSystem {
  constructor() {
    const n = MAX_CHIPS;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3); this.tu = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.r = new Float32Array(n); this.heat = new Float32Array(n);
    this.vol = new Float32Array(n); this.beta = new Float32Array(n); this.rhoc = new Float32Array(n); this.mu = new Float32Array(n);
    this.sig = new Float32Array(n); this.push = new Float32Array(n); this.touched = new Uint8Array(n); this.prev = new Float32Array(n * 3);
    this.pairI = new Int32Array(1 << 15); this.pairJ = new Int32Array(1 << 15);
    this.state = new Uint8Array(n); // 0 empty, 1 moving, 2 asleep on the stock, 3 evacuated (at rest on the table)
    this.ground = new Uint8Array(n);
    this.rest = new Float32Array(n); this.recutCool = new Float32Array(n);
    this.rot = new Float32Array(n * 3);
    this.next = 0;
    this.F = _F;
    this.hash = null; this.tick = 0;
    this.reset();
  }
  reset() {
    this.state.fill(0);
    this.pending = []; this.retired = 0; this.lastSpawn = -1;
    this.pool = null; this.jet = null; this.wall = null; this.swirl = null; this.toolBox = null;
    this.stats = { producedVol: 0, evacVol: 0, restVol: 0, pocketVol: 0, recut: 0, recutVol: 0, count: 0, awake: 0, inPocket: 0, jet: null };
  }
  // queue a chip event in world coordinates; shape: chipShape() of the chip
  emit(pos, vel, vol, heat, shape) {
    this.stats.producedVol += vol;
    this.pending.push({ pos, vel, vol, heat, shape });
  }
  // spawn at most `limit` particles per call, merging the volume of neighbouring events
  flush(limit = 12) {
    const q = this.pending;
    if (!q.length) return;
    const stride = Math.max(1, Math.ceil(q.length / limit));
    for (let s = 0; s < q.length; s += stride) {
      let vol = 0;
      for (let k = s; k < Math.min(q.length, s + stride); k++) vol += q[k].vol;
      const e = q[s], sh = e.shape || chipShape({}, 0.05);
      const i = this.alloc();
      if (i < 0) {
        // every slot holds a chip on the stock: the volume joins the newest particle
        const j = this.lastSpawn;
        if (j >= 0 && this.state[j]) this.vol[j] += vol; // (its contact radius stays: the hash cell is sized by the largest)
        else this.retired += vol;
        continue;
      }
      this.p.set(e.pos, i * 3); this.v.set(e.vel, i * 3);
      this.tu[i * 3] = this.tu[i * 3 + 1] = this.tu[i * 3 + 2] = 0;
      this.vol[i] = vol; this.beta[i] = sh.beta; this.rhoc[i] = sh.rhoc; this.mu[i] = sh.mu;
      this.r[i] = bulkRadius(vol, sh.Rb);
      this.size[i] = 1.5 * this.r[i]; // ribbon helix of unit size has a coil radius ≈ 0.6
      this.heat[i] = e.heat; this.sig[i] = 0;
      this.state[i] = 1; this.rest[i] = 0; this.ground[i] = 0; this.recutCool[i] = 0.25; // fresh chips are not recuts
      this.rot[i * 3] = Math.random() * 6.28; this.rot[i * 3 + 1] = Math.random() * 6.28; this.rot[i * 3 + 2] = (Math.random() - 0.5) * 40;
      this.lastSpawn = i;
    }
    this.pending = [];
  }
  alloc() {
    // an empty slot, else the oldest chip already on the table (its volume stays counted as evacuated)
    for (let k = 0; k < MAX_CHIPS; k++) {
      const i = (this.next + k) % MAX_CHIPS;
      if (this.state[i] === 0) { this.next = (i + 1) % MAX_CHIPS; return i; }
    }
    for (let k = 0; k < MAX_CHIPS; k++) {
      const i = (this.next + k) % MAX_CHIPS;
      if (this.state[i] === 3) { this.retired += this.vol[i]; this.state[i] = 0; this.next = (i + 1) % MAX_CHIPS; return i; }
    }
    return -1;
  }

  // env: {stock, tool:{x, y, tipZ, R, len, omega, tanH, cutTop, cutting, ux, uy}, coolant, nozzle: nozzlePose()}
  update(dt, env) {
    if (!(dt > 0)) return;
    const { stock } = env;
    this.prepare(dt, env);
    const st = this.state, n = MAX_CHIPS;
    // eddy velocities: Ornstein–Uhlenbeck process with the local rms σ, once per call
    const a = Math.exp(-dt / TURB_T), b = Math.sqrt(1 - a * a);
    for (let i = 0; i < n; i++) {
      if (st[i] !== 1) continue;
      const o = i * 3, s = this.sig[i] * b * 2;
      this.tu[o] = this.tu[o] * a + s * (Math.random() + Math.random() + Math.random() - 1.5);
      this.tu[o + 1] = this.tu[o + 1] * a + s * (Math.random() + Math.random() + Math.random() - 1.5);
      this.tu[o + 2] = this.tu[o + 2] * a + s * (Math.random() + Math.random() + Math.random() - 1.5);
    }
    // global steps for the chip–chip contacts; each chip substeps further by its own speed
    const nG = Math.max(1, Math.ceil(dt / 0.005)), h = dt / nG;
    this.hashBuilt = false;
    for (let g = 0; g < nG; g++) {
      let awake = 0;
      this.prev.set(this.p);
      for (let i = 0; i < n; i++) if (st[i] === 1) { this.integrate(i, h, env); awake++; }
      if (!awake) break;
      this.contacts(h, stock, this.prev);
    }
    this.sleepers(env);
    this.collectStats(stock);
  }

  // ---------- fluid fields ----------
  prepare(dt, env) {
    const { stock, tool: tl } = env;
    const cool = COOLANTS[env.coolant] || null;
    this.cool = cool;
    this.tool = tl;
    // spindle swirl: the fluted tool drags the surrounding fluid round; near the flutes the fluid
    // moves at about half the surface speed, decaying faster than a potential vortex (R/r)²
    this.swirl = tl.omega > 0 ? { x: tl.x, y: tl.y, z0: tl.tipZ - 2, z1: tl.tipZ + tl.len, R: tl.R, ut: 0.5 * tl.omega * tl.R, rmax2: (4 * tl.R) ** 2 } : null;
    this.jet = null; this.wall = null;
    let info = null;
    if (cool && cool.jet === 'nozzle' && env.nozzle) {
      const nz = env.nozzle;
      // march along the axis to the first heightfield hit beyond (or before) the tool tip
      const sMax = nz.L * 1.8 + 30, ds = 0.5;
      let sImp = -1;
      for (let s = ds; s < sMax; s += ds) {
        const x = nz.x + nz.ex * s, y = nz.y + nz.ey * s, z = nz.z + nz.ez * s;
        if (z <= stock.floor(x, y)) { sImp = s; break; }
      }
      this.jet = { ox: nz.x, oy: nz.y, oz: nz.z, ex: nz.ex, ey: nz.ey, ez: nz.ez, U0: cool.U0, d0: cool.d0, liquid: cool.liquid, sEnd: sImp > 0 ? sImp + 1 : sMax };
      if (sImp > 0) {
        const fj = freeJet(sImp, cool.U0, cool.d0, cool.liquid);
        const ix = nz.x + nz.ex * sImp, iy = nz.y + nz.ey * sImp;
        // equivalent top-hat diameter with the same momentum flux
        const deq = cool.liquid ? 2 * fj.b : fj.b * Math.sqrt(2 / Math.LN2);
        const ch = Math.sqrt(nz.ex * nz.ex + nz.ey * nz.ey);
        this.buildWall(stock, ix, iy, stock.floor(ix, iy), 0.5, fj.Uc, deq, ch, Math.atan2(nz.ey, nz.ex), cool);
        info = { U: fj.Uc / 1000, x: ix, y: iy, z: nz.z + nz.ez * sImp, shadow: nz.z + nz.ez * sImp > tl.tipZ + 1.5 && stock.floor(tl.x, tl.y) < stock.zTop - 1 };
      } else info = { U: 0, shadow: false, miss: true };
    } else if (cool && cool.jet === 'tool' && tl.omega > 0) {
      // through-tool: coherent jets from the tool end, impinging right below and leaving radially
      // from under the cutter
      const fl = stock.floor(tl.x, tl.y), sImp = Math.max(0, tl.tipZ - fl);
      const deq = cool.d0 * Math.sqrt(cool.holes || 1);
      this.jet = { ox: tl.x, oy: tl.y, oz: tl.tipZ, ex: 0, ey: 0, ez: -1, U0: cool.U0, d0: deq, liquid: true, sEnd: sImp + 1 };
      this.buildWall(stock, tl.x, tl.y, Math.min(fl, tl.tipZ), tl.R, cool.U0, deq, 0, 0, cool);
      info = { U: cool.U0 / 1000, x: tl.x, y: tl.y, z: Math.min(fl, tl.tipZ), shadow: false };
    }
    this.stats.jet = info;
    // coolant layer
    if (cool && cool.liquid && !this.pool) this.pool = new Pool(stock);
    if (this.pool) {
      if (this.pool.stock !== stock) this.pool = new Pool(stock);
      // material removed since the last call: refresh the bed over the tool's sweep
      const R = tl.R + 1, tb = this.toolBox;
      const box = [tl.x - R, tl.x + R, tl.y - R, tl.y + R];
      if (tb) { box[0] = Math.min(box[0], tb[0]); box[1] = Math.max(box[1], tb[1]); box[2] = Math.min(box[2], tb[2]); box[3] = Math.max(box[3], tb[3]); }
      this.pool.bedRegion(stock, ...box);
      const src = cool && cool.liquid && info && info.U > 0 ? { x: info.x, y: info.y, Q: coolantFlow(cool), r: Math.max(2, cool.jet === 'tool' ? tl.R : this.jet.d0) } : null;
      this.pool.step(dt, src, !!(cool && cool.liquid));
    }
    this.toolBox = [tl.x - tl.R - 1, tl.x + tl.R + 1, tl.y - tl.R - 1, tl.y + tl.R + 1];
  }

  // Radial wall jet around an impingement point, tabulated per direction and radius. Peak
  // velocity decays as Um = U·d_eq/r (radial momentum conserved) in a layer δ = 0.09·r thick.
  // An oblique jet sends more of its flow forward. Along each ray the flow follows the running
  // maximum of the floor: a wall stops it, turns it up the wall (losing momentum) and lets it
  // carry on at the rim's level; behind a drop (off the stock) the sheet has separated.
  buildWall(stock, cx, cy, z0, r0, U, deq, ch, thJ, cool) {
    const D = 48, dr = 1, K = 120;
    const w = this.wall && this.wall.lev ? this.wall : { lev: new Float32Array(D * K), um: new Float32Array(D * K) };
    Object.assign(w, { cx, cy, z0, r0, D, K, dr, deq, rMax: r0 + K * dr, dScale: D / (2 * Math.PI), liquid: cool.liquid, Q: coolantFlow(cool) });
    for (let d = 0; d < D; d++) {
      const th = d / D * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
      const bias = 1 + 0.8 * ch * Math.cos(th - thJ);
      let lv = z0, loss = 1;
      for (let k = 0; k < K; k++) {
        const r = r0 + (k + 0.5) * dr, h = stock.floor(cx + r * c, cy + r * s);
        if (h > lv) { if (h > lv + 1) loss *= 0.7; lv = h; }
        w.lev[d * K + k] = lv;
        w.um[d * K + k] = U * Math.min(1, deq / r) * loss * bias;
      }
    }
    w.band = Math.max(1, Math.round(2 / dr));
    this.wall = w;
  }

  // fluid velocity, density and eddy rms at a point → this.F
  fluid(x, y, z) {
    let ux = 0, uy = 0, uz = 0, rho = RHO_AIR, sig = 0;
    const sw = this.swirl;
    if (sw && z > sw.z0 && z < sw.z1) {
      const dx = x - sw.x, dy = y - sw.y, r2 = dx * dx + dy * dy;
      if (r2 < sw.rmax2 && r2 > 1e-6) {
        const r = Math.sqrt(r2), q = sw.R / Math.max(r, sw.R), ut = sw.ut * q * q;
        ux += dy / r * ut; uy -= dx / r * ut; sig += 0.1 * ut;
      }
    }
    const j = this.jet;
    if (j) {
      const px = x - j.ox, py = y - j.oy, pz = z - j.oz;
      const s = px * j.ex + py * j.ey + pz * j.ez;
      if (s > 0 && s < j.sEnd) {
        const q2 = px * px + py * py + pz * pz - s * s;
        if (j.liquid) {
          const a = j.d0 / 2 + 0.01 * s + 0.3;
          if (q2 < a * a) { ux += j.ex * j.U0; uy += j.ey * j.U0; uz += j.ez * j.U0; rho = RHO_LIQ; sig += 0.05 * j.U0; }
        } else {
          const b = Math.max(JET_B0 * j.d0, JET_S * s), e = q2 / (b * b);
          if (e < 6) {
            const Uc = j.U0 * JET_B0 * j.d0 / b, f = Math.exp(-Math.LN2 * e), u = Uc * f;
            ux += j.ex * u; uy += j.ey * u; uz += j.ez * u; sig += 0.25 * Uc * Math.sqrt(f);
          }
        }
      }
    }
    const w = this.wall;
    if (w) {
      const dx = x - w.cx, dy = y - w.cy, r2 = dx * dx + dy * dy;
      if (r2 < w.rMax * w.rMax && r2 > 1e-6) {
        const r = Math.sqrt(r2), k = Math.max(0, Math.min(w.K - 1, ((r - w.r0) / w.dr) | 0));
        let d = Math.round(Math.atan2(dy, dx) * w.dScale); if (d < 0) d += w.D; if (d >= w.D) d -= w.D;
        const base = d * w.K, L = w.lev[base + k];
        if (z >= L - 0.5) {
          // the up-wash layer on a wall ahead is about as thick as the wall jet itself
          const del = 0.09 * r + 0.5 * w.deq;
          const kb = Math.min(w.K - 1, k + Math.max(w.band, Math.round(del / w.dr))), Lb = w.lev[base + kb];
          let ur = 0, uw = 0, dz;
          if (Lb > L + 0.5 && z < Lb) {
            // wall ahead: the jet washes up it
            const U = w.um[base + k];
            dz = 0; uw = 0.7 * U * r / (r + z - L); ur = 0.15 * U;
          } else {
            const up = z >= Lb && Lb > L + 0.5, U = w.um[base + (up ? kb : k)];
            dz = z - (up ? Lb : L);
            if (dz < 2.5 * del) ur = U * Math.exp(-(dz * dz) / (del * del));
          }
          if (ur > 0 || uw > 0) {
            ux += dx / r * ur; uy += dy / r * ur; uz += uw;
            const um = ur + uw;
            sig += 0.2 * um;
            // liquid wall jet: a film of thickness Q/(2π·r·U) (at least half a millimetre)
            if (w.liquid && dz < Math.max(0.5, Math.min(4, w.Q / (2 * Math.PI * r * Math.max(um, 50)))) + 0.5) rho = RHO_LIQ;
          }
        }
      }
    }
    const P = this.pool;
    if (P) {
      const k = P.cell(x, y);
      if (k >= 0) {
        const d = P.depth[k];
        if (d > 0.05 && z < P.bed[k] + d) {
          rho = RHO_LIQ;
          // below the spill level the cavity recirculates at ~15 % of the flow skimming over it
          // (lid-driven cavity)
          const c = z < P.spill[k] - 0.5 ? CAVITY : 1;
          const u = P.u[k] * c, v = P.v[k] * c;
          ux += u; uy += v; sig += 0.15 * Math.sqrt(u * u + v * v);
        }
      }
    }
    const F = this.F;
    F[0] = ux; F[1] = uy; F[2] = uz; F[3] = rho; F[4] = sig;
    return F;
  }

  // ---------- one chip over h ----------
  integrate(i, h, env) {
    const { stock } = env, tl = env.tool, F = this.F;
    const o = i * 3, r = this.r[i], beta = this.beta[i], rc = this.rhoc[i];
    let px = this.p[o], py = this.p[o + 1], pz = this.p[o + 2];
    let vx = this.v[o], vy = this.v[o + 1], vz = this.v[o + 2];
    const tx = this.tu[o], ty = this.tu[o + 1], tz = this.tu[o + 2];
    // substeps so that a step never moves more than ~0.7 r (walls and the tool are not tunnelled)
    const sp = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
    const ns = Math.min(24, Math.max(1, Math.ceil(sp * h / Math.max(0.3, 0.7 * r)))), hs = h / ns;
    // a slow chip that was supported last step does not sink into its support: the support
    // takes any net downward velocity (it would only push the chip back, and that sag is what
    // makes position-based heaps sink into themselves), while a net lift still raises it.
    // Without support the flag clears and it falls the next step.
    const held = this.ground[i] && sp < 50;
    let ground = 0, sigma = 0, liquid = false;
    for (let s = 0; s < ns; s++) {
      this.fluid(px, py, pz);
      const rf = F[3], ratio = rf / rc, den = 1 + CA * ratio;
      liquid = rf > RHO_AIR * 2; sigma = F[4];
      const ux = F[0] + tx, uy = F[1] + ty, uz = F[2] + tz;
      const wx = ux - vx, wy = uy - vy, wz = uz - vz;
      // drag (linearised implicitly about |w|), gravity less buoyancy, over (1 + added mass)
      const k = 0.5 * rf * beta * Math.sqrt(wx * wx + wy * wy + wz * wz) / den;
      const gz = -G * (1 - ratio) / den, ik = 1 / (1 + k * hs);
      vx = (vx + hs * k * ux) * ik; vy = (vy + hs * k * uy) * ik; vz = (vz + hs * (k * uz + gz)) * ik;
      if (held && vz < 0) vz = 0;
      let nx = px + vx * hs, ny = py + vy * hs, nz = pz + vz * hs;
      // rotating tool: the flutes strike the chip out of the cutter envelope
      const dxT = nx - tl.x, dyT = ny - tl.y, rT2 = dxT * dxT + dyT * dyT, Rr = tl.R + r;
      if (rT2 < Rr * Rr && nz > tl.tipZ - 0.5 * r && nz < tl.tipZ + tl.len) {
        const rT = Math.sqrt(rT2) || 1e-3, ex = rT2 > 1e-6 ? dxT / rT : 1, ey = rT2 > 1e-6 ? dyT / rT : 0;
        nx = tl.x + ex * (Rr + 0.05); ny = tl.y + ey * (Rr + 0.05);
        if (tl.omega > 0) {
          // struck by an edge moving clockwise at ωR: leaves with part of that speed, outward
          // and lifted by the helical flute face
          const vt = tl.omega * tl.R, kick = 0.3 + 0.3 * Math.random();
          vx = ey * vt * kick + ex * vt * 0.12; vy = -ex * vt * kick + ey * vt * 0.12;
          vz = Math.max(vz, 0) + vt * kick * 0.5 * tl.sinCos;
          if (tl.cutting && nz < tl.cutTop + r && this.recutCool[i] <= 0 && ex * tl.ux + ey * tl.uy > -0.3) {
            this.stats.recut++; this.stats.recutVol += this.vol[i]; this.recutCool[i] = 0.3;
          }
        } else {
          const vn = vx * ex + vy * ey; if (vn < 0) { vx -= vn * ex; vy -= vn * ey; }
        }
      }
      // heightfield: a wall ahead at the chip's height, else the floor below
      const vh = Math.sqrt(vx * vx + vy * vy);
      if (vh > 1e-3) {
        const fx = nx + vx / vh * r * 0.7, fy = ny + vy / vh * r * 0.7, flF = stock.floor(fx, fy);
        if (flF > nz && flF - stock.floor(px, py) > Math.max(0.05, 1.2 * Math.hypot(fx - px, fy - py))) {
          // wall: horizontal normal from the height gradient, pointing to the low side
          const e = 0.4;
          let gx = stock.floor(fx - e, fy) - stock.floor(fx + e, fy), gy = stock.floor(fx, fy - e) - stock.floor(fx, fy + e);
          let gm = Math.sqrt(gx * gx + gy * gy);
          if (gm < 1e-6) { gx = -vx; gy = -vy; gm = vh; }
          gx /= gm; gy /= gm;
          const vn = vx * gx + vy * gy;
          if (vn < 0) {
            vx -= (1 + E_WALL) * vn * gx; vy -= (1 + E_WALL) * vn * gy;
            const mu = this.mu[i] * (liquid ? WET_MU : 1);
            // Coulomb friction on the tangential part, limited by the normal impulse
            const tvx = vx - (vx * gx + vy * gy) * gx, tvy = vy - (vx * gx + vy * gy) * gy, tm = Math.sqrt(tvx * tvx + tvy * tvy + vz * vz);
            if (tm > 1e-6) { const f = Math.max(0, 1 - mu * (1 + E_WALL) * -vn / tm); vx = vx * f + (1 - f) * (vx - tvx); vy = vy * f + (1 - f) * (vy - tvy); vz *= f; }
          }
          nx = px; ny = py;
        }
      }
      let fl = stock.floor(nx, ny);
      if (fl > nz - r) {
        // rising floor under the centre: a slope steeper than ~50° is a wall (the heightfield
        // smears walls over one cell, and creeping up that ramp step by step would let chips
        // climb out of pockets), stay put
        const fo = stock.floor(px, py), run = Math.hypot(nx - px, ny - py);
        if (fl - fo > 0.05 && fl - fo > 1.2 * run) { nx = px; ny = py; fl = fo; vx *= -E_WALL; vy *= -E_WALL; }
      }
      if (nz - r < fl + 0.02) {
        // on the floor (within a small skin, so a resting chip stays in contact)
        if (nz - r < fl) nz = fl + r;
        const mu = this.mu[i] * (liquid ? WET_MU : 1);
        let dvh = 0;
        if (vz < 0) { const vn = -vz; vz = vn > 150 ? vn * E_WALL : 0; dvh = mu * (1 + E_WALL) * vn; }
        // sliding friction: normal force from gravity less buoyancy
        dvh += mu * G * (1 - ratio) / den * hs;
        const vh2 = Math.sqrt(vx * vx + vy * vy);
        if (vh2 > 0) { const f = Math.max(0, 1 - dvh / vh2); vx *= f; vy *= f; }
        ground = 1;
      }
      px = nx; py = ny; pz = nz;
    }
    this.p[o] = px; this.p[o + 1] = py; this.p[o + 2] = pz;
    this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz;
    this.sig[i] = sigma; this.ground[i] = ground;
    if (this.recutCool[i] > 0) this.recutCool[i] -= h;
    this.heat[i] = Math.max(0, this.heat[i] - h * (liquid ? 6 : 1.5));
    this.rot[o + 2] *= liquid ? 0.97 : 0.995;
    this.rot[o] += this.rot[o + 2] * h;
    if (pz < stock.zBottom - 50 || Math.abs(px - stock.w / 2) > stock.w + 200 || Math.abs(py - stock.l / 2) > stock.l + 200) {
      this.state[i] = 0; this.retired += this.vol[i];
    }
  }

  // drag on a resting chip beats static friction (μs ≈ 1.25 μk)?
  mobile(i, F) {
    const rf = F[3], ratio = rf / this.rhoc[i];
    const u = (Math.sqrt(F[0] * F[0] + F[1] * F[1] + F[2] * F[2]) + F[4]) * NEAR_BED;
    const mu = 1.25 * this.mu[i] * (rf > RHO_AIR * 2 ? WET_MU : 1);
    return 0.5 * rf * this.beta[i] * u * u > mu * G * (1 - ratio);
  }

  // ---------- chip–chip contacts ----------
  // Position-based soft spheres: overlaps are pushed apart (inverse-mass weighted, sleeping
  // chips are immovable), the approaching normal velocity is removed with a small restitution
  // and Coulomb friction limits the tangential impulse. Neighbours come from a hashed 3D grid
  // whose cell is the largest diameter present, so deep piles stay O(n).
  buildHash() {
    const st = this.state, p = this.p, R = this.r;
    let rmax = R_MIN;
    for (let i = 0; i < MAX_CHIPS; i++) if ((st[i] === 1 || st[i] === 2) && R[i] > rmax) rmax = R[i];
    const H = this.hash || (this.hash = { start: new Int32Array(HASH_N + 1), items: new Int32Array(MAX_CHIPS), key: new Int32Array(MAX_CHIPS), fill: new Int32Array(HASH_N) });
    const { start, items, key, fill } = H, cs = 2 * rmax, inv = 1 / cs;
    H.inv = inv;
    start.fill(0);
    for (let i = 0; i < MAX_CHIPS; i++) {
      key[i] = -1;
      if (st[i] !== 1 && st[i] !== 2) continue;
      const k = hashKey(Math.floor(p[i * 3] * inv), Math.floor(p[i * 3 + 1] * inv), Math.floor(p[i * 3 + 2] * inv));
      key[i] = k; start[k + 1]++;
    }
    for (let c = 0; c < HASH_N; c++) start[c + 1] += start[c];
    fill.set(start.subarray(0, HASH_N));
    for (let i = 0; i < MAX_CHIPS; i++) if (key[i] >= 0) items[fill[key[i]]++] = i;
    this.hashBuilt = true;
    return H;
  }
  contacts(h, stock, prev) {
    const H = this.buildHash(), { start, items, inv } = H;
    const st = this.state, p = this.p, v = this.v, R = this.r, vol = this.vol, push = this.push, touched = this.touched;
    void v;
    touched.fill(0);
    // candidate pairs once per step (within a margin of touching), then the iterations run on them
    let np = 0, PI = this.pairI, PJ = this.pairJ;
    for (let i = 0; i < MAX_CHIPS; i++) {
      if (st[i] !== 1) continue;
      const oi = i * 3;
      const ix = Math.floor(p[oi] * inv), iy = Math.floor(p[oi + 1] * inv), iz = Math.floor(p[oi + 2] * inv);
      for (let cz = iz - 1; cz <= iz + 1; cz++) for (let cy = iy - 1; cy <= iy + 1; cy++) for (let cx = ix - 1; cx <= ix + 1; cx++) {
        const cc = hashKey(cx, cy, cz);
        for (let q = start[cc]; q < start[cc + 1]; q++) {
          const j = items[q];
          if (j === i || (st[j] === 1 && j < i) || !st[j]) continue;
          const oj = j * 3, dx = p[oi] - p[oj], dy = p[oi + 1] - p[oj + 1], dz = p[oi + 2] - p[oj + 2], s = 1.3 * (R[i] + R[j]);
          if (dx * dx + dy * dy + dz * dz >= s * s) continue;
          if (np === PI.length) { const a = new Int32Array(np * 2), b = new Int32Array(np * 2); a.set(PI); b.set(PJ); PI = this.pairI = a; PJ = this.pairJ = b; }
          PI[np] = i; PJ[np] = j; np++;
        }
      }
    }
    // a tool ploughing through a heap can wake thousands of chips: then one pass fewer
    const nit = np > 20000 ? NIT - 1 : NIT;
    for (let it = 0; it < nit; it++) {
      if (it === nit - 1) push.fill(0); // deepest overlap left before the last pass
      {
        for (let pq = 0; pq < np; pq++) {
          {
            const i = PI[pq], j = PJ[pq];
            const oi = i * 3, wi = 1 / vol[i], mu = this.mu[i];
            const oj = j * 3;
            const dx = p[oi] - p[oj], dy = p[oi + 1] - p[oj + 1], dz = p[oi + 2] - p[oj + 2];
            const s = R[i] + R[j];
            let d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= s * s) {
              // just touching from above still counts as support (see integrate: no sag)
              if (dz > 0.2 * s && d2 < (s + 0.05) * (s + 0.05)) this.ground[i] = 1;
              else if (-dz > 0.2 * s && st[j] === 1 && d2 < (s + 0.05) * (s + 0.05)) this.ground[j] = 1;
              continue;
            }
            if (it === 0 && d2 < 0.25 * s * s) {
              // came in fast: back up along this step's motion to where the spheres first touched
              // (a swept test, so chips do not tunnel into a heap)
              const mx = p[oi] - prev[oi], my = p[oi + 1] - prev[oi + 1], mz = p[oi + 2] - prev[oi + 2];
              const qx = prev[oi] - p[oj], qy = prev[oi + 1] - p[oj + 1], qz = prev[oi + 2] - p[oj + 2];
              const A = mx * mx + my * my + mz * mz, B = mx * qx + my * qy + mz * qz, C = qx * qx + qy * qy + qz * qz - s * s;
              const disc = B * B - A * C;
              if (A > 1e-12 && C > 0 && disc > 0) {
                const t = Math.max(0, (-B - Math.sqrt(disc)) / A);
                p[oi] = prev[oi] + mx * t; p[oi + 1] = prev[oi + 1] + my * t; p[oi + 2] = prev[oi + 2] + mz * t;
                const ex = p[oi] - p[oj], ey = p[oi + 1] - p[oj + 1], ez = p[oi + 2] - p[oj + 2];
                d2 = ex * ex + ey * ey + ez * ez;
                if (d2 >= s * s * 0.999) { touched[i] = 1; if (ez > 0.2 * s) this.ground[i] = 1; continue; }
              }
            }
            const ddx = p[oi] - p[oj], ddy = p[oi + 1] - p[oj + 1], ddz = p[oi + 2] - p[oj + 2];
            let d = Math.sqrt(d2), nx, ny, nz;
            if (d > 1e-6) { nx = ddx / d; ny = ddy / d; nz = ddz / d; }
            else { const a = Math.random() * 6.283; nx = Math.cos(a); ny = Math.sin(a); nz = 0; d = 0; }
            // shock propagation: in a stack the lower chip acts heavier, so a heap holds up with
            // a couple of iterations instead of sagging into itself
            const awakeJ = st[j] === 1;
            let wI = wi, wj = awakeJ ? 1 / vol[j] : 0;
            if (awakeJ) { if (nz > 0.3) wj *= 0.15; else if (nz < -0.3) wI *= 0.15; }
            const ws = wI + wj;
            if (it === nit - 1) { const o = (s - d) / s; if (o > push[i]) push[i] = o; if (awakeJ && o > push[j]) push[j] = o; }
            // a hard knock wakes a sleeping chip
            if (!awakeJ && it === 0 && v[oi] * nx + v[oi + 1] * ny + v[oi + 2] * nz < -250) { st[j] = 1; this.rest[j] = 0; }
            const corr = (s - d) * 0.9 / ws;
            // position-based Coulomb friction: cancel the relative tangential slip of this step
            // while it is within μ·(normal correction), else take μ·correction off it
            let rx = p[oi] - prev[oi], ry = p[oi + 1] - prev[oi + 1], rz = p[oi + 2] - prev[oi + 2];
            if (awakeJ) { rx -= p[oj] - prev[oj]; ry -= p[oj + 1] - prev[oj + 1]; rz -= p[oj + 2] - prev[oj + 2]; }
            const rn = rx * nx + ry * ny + rz * nz, tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz;
            const tm = Math.sqrt(tx * tx + ty * ty + tz * tz), lim = corr * ws * mu;
            const f = tm > 1e-9 ? (tm < 1.25 * lim ? 1 : lim / tm) / ws : 0;
            p[oi] += (nx * corr - tx * f) * wI; p[oi + 1] += (ny * corr - ty * f) * wI; p[oi + 2] += (nz * corr - tz * f) * wI;
            if (awakeJ) { p[oj] -= (nx * corr - tx * f) * wj; p[oj + 1] -= (ny * corr - ty * f) * wj; p[oj + 2] -= (nz * corr - tz * f) * wj; touched[j] = 1; }
            touched[i] = 1;
            if (nz > 0.2) this.ground[i] = 1;
            else if (nz < -0.2 && awakeJ) this.ground[j] = 1;
          }
        }
      }
    }
    // chips in contact take their velocity from the corrected motion (inelastic, as chips in a
    // heap are); pushes must not leave chips under the floor; then decide who comes to rest
    for (let i = 0; i < MAX_CHIPS; i++) {
      if (st[i] !== 1) continue;
      const o = i * 3;
      if (touched[i]) { v[o] = (p[o] - prev[o]) / h; v[o + 1] = (p[o + 1] - prev[o + 1]) / h; v[o + 2] = (p[o + 2] - prev[o + 2]) / h; }
      let fl = stock.floor(p[o], p[o + 1]);
      const fo = stock.floor(prev[o], prev[o + 1]);
      if (fl > p[o + 2] - R[i] && fl - fo > 0.05 && fl - fo > 1.2 * Math.hypot(p[o] - prev[o], p[o + 1] - prev[o + 1])) {
        // pushed into a wall: keep the old xy rather than lifting the chip onto the rim
        p[o] = prev[o]; p[o + 1] = prev[o + 1]; v[o] = v[o + 1] = 0; fl = stock.floor(p[o], p[o + 1]);
      }
      if (p[o + 2] - R[i] < fl) { p[o + 2] = fl + R[i]; if (v[o + 2] < 0) v[o + 2] = 0; this.ground[i] = 1; }
      const sp = Math.abs(v[o]) + Math.abs(v[o + 1]) + Math.abs(v[o + 2]);
      if (this.ground[i] && sp < 30) {
        this.rest[i] += h;
        // a chip wedged into a gap narrower than itself keeps an overlap the projection cannot
        // remove: raise it until it sits on its neighbours
        if (push[i] >= 0.2 && this.rest[i] > 0.3) this.unjam(i, H);
        if (this.rest[i] > 0.15 && push[i] < 0.2) {
          const inside = stock.inside(p[o], p[o + 1]);
          if (!inside && p[o + 2] < stock.zTop) this.sleep(i, 3);
          else if (inside && !this.mobile(i, this.fluid(p[o], p[o + 1], p[o + 2]))) this.sleep(i, 2);
        }
      } else this.rest[i] = 0;
    }
  }
  unjam(i, H) {
    const p = this.p, R = this.r, st = this.state, o = i * 3, r = R[i], inv = H.inv;
    for (let k = 0; k < 12; k++) {
      const ix = Math.floor(p[o] * inv), iy = Math.floor(p[o + 1] * inv), iz = Math.floor(p[o + 2] * inv);
      let worst = 0;
      for (let cz = iz - 1; cz <= iz + 1; cz++) for (let cy = iy - 1; cy <= iy + 1; cy++) for (let cx = ix - 1; cx <= ix + 1; cx++) {
        const cc = hashKey(cx, cy, cz);
        for (let q = H.start[cc]; q < H.start[cc + 1]; q++) {
          const j = H.items[q]; if (j === i || !st[j]) continue;
          const oj = j * 3, s = r + R[j], d = Math.hypot(p[o] - p[oj], p[o + 1] - p[oj + 1], p[o + 2] - p[oj + 2]);
          if (s - d > worst) worst = s - d;
        }
      }
      if (worst < 0.1 * r) break;
      p[o + 2] += Math.max(0.1 * r, 0.5 * worst);
    }
    this.push[i] = 0; this.ground[i] = 1; this.rest[i] = 0;
    this.v[o] = this.v[o + 1] = this.v[o + 2] = 0;
  }
  sleep(i, s) { const o = i * 3; this.v[o] = this.v[o + 1] = this.v[o + 2] = 0; this.state[i] = s; this.rest[i] = 0; }

  // sleeping chips wake when the tool reaches them, their support is gone or the flow moves them
  sleepers(env) {
    const { stock } = env, tl = env.tool, st = this.state, p = this.p, R = this.r;
    let H = null;
    this.tick = (this.tick + 1) | 0;
    for (let i = 0; i < MAX_CHIPS; i++) {
      if (st[i] !== 2) continue;
      const o = i * 3, x = p[o], y = p[o + 1], z = p[o + 2], r = R[i];
      const dx = x - tl.x, dy = y - tl.y, Rr = tl.R + r + 0.3;
      if (dx * dx + dy * dy < Rr * Rr && z > tl.tipZ - r && z < tl.tipZ + tl.len) { st[i] = 1; continue; }
      // resting on other chips: anything underneath within reach? (a quarter of them per call;
      // supports only go when the tool cuts them or the chips below wake)
      if ((i & 3) === (this.tick & 3) && z - r - stock.floor(x, y) > 0.35) {
        if (!H) H = this.hashBuilt ? this.hash : this.buildHash();
        const inv = H.inv, ix = Math.floor(x * inv), iy = Math.floor(y * inv), iz = Math.floor(z * inv);
        let held = false;
        for (let cz = iz - 1; cz <= iz && !held; cz++) for (let cy = iy - 1; cy <= iy + 1 && !held; cy++) for (let cx = ix - 1; cx <= ix + 1 && !held; cx++) {
          const cc = hashKey(cx, cy, cz);
          for (let q = H.start[cc]; q < H.start[cc + 1]; q++) {
            const j = H.items[q]; if (j === i || !st[j]) continue;
            const oj = j * 3, ex = x - p[oj], ey = y - p[oj + 1], ez = z - p[oj + 2], s = r + R[j] + 0.3;
            if (ez > 0 && ex * ex + ey * ey + ez * ez < s * s) { held = true; break; }
          }
        }
        if (!held) { st[i] = 1; continue; }
      }
      if (this.mobile(i, this.fluid(x, y, z))) st[i] = 1;
    }
  }

  collectStats(stock) {
    let restVol = 0, pocketVol = 0, evac = this.retired, inPocket = 0, count = 0, awake = 0;
    const st = this.state, p = this.p;
    for (let i = 0; i < MAX_CHIPS; i++) {
      const s = st[i];
      if (!s) continue;
      count++;
      const o = i * 3;
      if (s === 1) awake++;
      if (s === 2) {
        restVol += this.vol[i];
        if (p[o + 2] < stock.zTop - 0.5) { inPocket++; pocketVol += this.vol[i]; }
      } else if (s === 3 || !stock.inside(p[o], p[o + 1])) evac += this.vol[i];
    }
    Object.assign(this.stats, { restVol, pocketVol, evacVol: evac, inPocket, count, awake });
  }
}

// Shallow coolant layer on a coarse grid over the stock ("virtual pipes" shallow water). The bed
// of a cell is the highest stock point in it, so walls hold water back. Flux between cells is
// driven by the surface slope over the crest (the higher bed acts as a weir), with quadratic
// bed friction plus a linear term for the turbulent losses that the coarse grid does not
// resolve (it damps sloshing within ~0.2 s); at the stock edges water leaves at critical depth (free overfall). The depth
// used for the wave speed is capped at 8 mm: deep pools respond slower than real, which only
// matters for their nearly still bottom, and it keeps the explicit step large.
export class Pool {
  constructor(stock) {
    this.stock = stock;
    const c = Math.max(2, Math.sqrt(stock.w * stock.l / 3000));
    this.nx = Math.max(2, Math.round(stock.w / c)); this.ny = Math.max(2, Math.round(stock.l / c));
    this.cx = stock.w / this.nx; this.cy = stock.l / this.ny;
    const n = this.nx * this.ny;
    this.bed = new Float32Array(n); this.depth = new Float32Array(n);
    this.u = new Float32Array(n); this.v = new Float32Array(n);
    this.qx = new Float32Array((this.nx + 1) * this.ny); this.qy = new Float32Array(this.nx * (this.ny + 1));
    this.scale = new Float32Array(n);
    this.spill = new Float32Array(n); this.seen = new Uint8Array(n);
    this.heap = new Int32Array(n); this.hkey = new Float32Array(n);
    this.bedRegion(stock, 0, stock.w, 0, stock.l);
  }
  // Spill level of every cell (priority-flood from the stock edges): the water surface at which
  // the basin holding it overflows. Below it lies a cavity that the through-flow only skims.
  spillLevels() {
    const { nx, ny, bed, spill, seen, heap, hkey } = this;
    seen.fill(0);
    let hn = 0;
    const push = (k, w) => {
      let c = hn++;
      while (c > 0) { const pa = (c - 1) >> 1; if (hkey[pa] <= w) break; heap[c] = heap[pa]; hkey[c] = hkey[pa]; c = pa; }
      heap[c] = k; hkey[c] = w;
    };
    const pop = () => {
      const top = heap[0], k = heap[--hn], w = hkey[hn];
      let c = 0;
      for (;;) {
        let m = 2 * c + 1; if (m >= hn) break;
        if (m + 1 < hn && hkey[m + 1] < hkey[m]) m++;
        if (hkey[m] >= w) break;
        heap[c] = heap[m]; hkey[c] = hkey[m]; c = m;
      }
      heap[c] = k; hkey[c] = w;
      return top;
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) { const k = j * nx + i; seen[k] = 1; spill[k] = bed[k]; push(k, bed[k]); }
    while (hn > 0) {
      const k = pop(), i = k % nx, j = (k / nx) | 0, w = spill[k];
      for (let q = 0; q < 4; q++) {
        const ii = i + (q === 0 ? -1 : q === 1 ? 1 : 0), jj = j + (q === 2 ? -1 : q === 3 ? 1 : 0);
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const kk = jj * nx + ii;
        if (seen[kk]) continue;
        seen[kk] = 1; spill[kk] = Math.max(bed[kk], w); push(kk, spill[kk]);
      }
    }
  }
  cell(x, y) {
    const i = Math.floor(x / this.cx), j = Math.floor(y / this.cy);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }
  bedRegion(stock, x0, x1, y0, y1) {
    const i0 = Math.max(0, Math.floor(x0 / this.cx)), i1 = Math.min(this.nx - 1, Math.floor(x1 / this.cx));
    const j0 = Math.max(0, Math.floor(y0 / this.cy)), j1 = Math.min(this.ny - 1, Math.floor(y1 / this.cy));
    const H = stock.H, fn = stock.nx;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const a0 = Math.floor(i * this.cx / stock.hx), a1 = Math.min(stock.nx - 1, Math.ceil((i + 1) * this.cx / stock.hx));
      const b0 = Math.floor(j * this.cy / stock.hy), b1 = Math.min(stock.ny - 1, Math.ceil((j + 1) * this.cy / stock.hy));
      let m = -Infinity;
      for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) if (H[b * fn + a] > m) m = H[b * fn + a];
      const k = j * this.nx + i;
      if (this.bed[k] !== m) { this.bed[k] = m; this.bedChanged = true; }
    }
  }
  // src: {x, y, Q [mm³/s], r} or null; liquid: false lets the layer dry off
  step(dt, src, liquid) {
    if (this.bedChanged) { this.spillLevels(); this.bedChanged = false; }
    const { nx, ny, cx, cy, bed, depth, qx, qy, scale } = this, A = cx * cy, n = nx * ny, CF = 0.01, KD = 2;
    if (!liquid) for (let k = 0; k < n; k++) depth[k] *= Math.exp(-dt / 2);
    // CFL on the capped wave speed √(g·8 mm) (the source can fill a cell within one step)
    const hMax = 0.45 * Math.min(cx, cy) / Math.sqrt(G * 8);
    const ns = Math.min(60, Math.ceil(dt / hMax)), h = dt / ns;
    // source cells
    let cells = null;
    if (src) {
      cells = [];
      // the jet's own momentum spreads the water as a wall jet long before gravity does, so the
      // inflow is spread over the disc that the film covers within a few milliseconds
      const r = Math.max(src.r, 8, 0.6 * Math.max(cx, cy));
      for (let j = Math.max(0, Math.floor((src.y - r) / cy)); j <= Math.min(ny - 1, Math.floor((src.y + r) / cy)); j++)
        for (let i = Math.max(0, Math.floor((src.x - r) / cx)); i <= Math.min(nx - 1, Math.floor((src.x + r) / cx)); i++)
          if (Math.hypot((i + 0.5) * cx - src.x, (j + 0.5) * cy - src.y) <= r) cells.push(j * nx + i);
      if (!cells.length) { const k = this.cell(src.x, src.y); if (k >= 0) cells.push(k); }
    }
    const sq = Math.sqrt(G);
    for (let s = 0; s < ns; s++) {
      if (cells && cells.length) { const dv = src.Q * h / A / cells.length; for (const k of cells) depth[k] += dv; }
      // x edges: edge e = j*(nx+1)+i lies between cells i-1 and i
      for (let j = 0; j < ny; j++) {
        const row = j * nx, er = j * (nx + 1);
        for (let i = 1; i < nx; i++) {
          const a = row + i - 1, b = a + 1, ea = bed[a] + depth[a], eb = bed[b] + depth[b];
          const hE = Math.max(ea, eb) - Math.max(bed[a], bed[b]);
          if (hE <= 1e-3) { qx[er + i] = 0; continue; }
          let q = qx[er + i] + h * G * Math.min(hE, 8) * (ea - eb) / cx * cy;
          q /= 1 + h * (KD + CF * Math.abs(q) / (hE * hE * cy));
          // no more than critical discharge over the crest (else momentum drains a basin below it)
          const qc = cy * hE * Math.sqrt(G * hE);
          qx[er + i] = q > qc ? qc : q < -qc ? -qc : q;
        }
        // free overfall at the stock edges (outward positive on the right, negative on the left)
        const dl = depth[row], dr = depth[row + nx - 1];
        qx[er] = -0.6 * cy * dl * sq * Math.sqrt(dl);
        qx[er + nx] = 0.6 * cy * dr * sq * Math.sqrt(dr);
      }
      for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = (j - 1) * nx + i, b = a + nx, ea = bed[a] + depth[a], eb = bed[b] + depth[b], e = j * nx + i;
        const hE = Math.max(ea, eb) - Math.max(bed[a], bed[b]);
        if (hE <= 1e-3) { qy[e] = 0; continue; }
        let q = qy[e] + h * G * Math.min(hE, 8) * (ea - eb) / cy * cx;
        q /= 1 + h * (KD + CF * Math.abs(q) / (hE * hE * cx));
        const qc = cx * hE * Math.sqrt(G * hE);
        qy[e] = q > qc ? qc : q < -qc ? -qc : q;
      }
      for (let i = 0; i < nx; i++) {
        const db = depth[i], dt_ = depth[(ny - 1) * nx + i];
        qy[i] = -0.6 * cx * db * sq * Math.sqrt(db);
        qy[ny * nx + i] = 0.6 * cx * dt_ * sq * Math.sqrt(dt_);
      }
      // no cell may give more water than it holds
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i, ex = j * (nx + 1) + i;
        const out = Math.max(0, qx[ex + 1]) + Math.max(0, -qx[ex]) + Math.max(0, qy[k + nx]) + Math.max(0, -qy[k]);
        const have = depth[k] * A;
        scale[k] = out * h > have ? have / (out * h) : 1;
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i <= nx; i++) {
        const e = j * (nx + 1) + i, q = qx[e];
        if (q > 0 && i > 0) qx[e] = q * scale[j * nx + i - 1];
        else if (q < 0 && i < nx) qx[e] = q * scale[j * nx + i];
      }
      for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) {
        const e = j * nx + i, q = qy[e];
        if (q > 0 && j > 0) qy[e] = q * scale[(j - 1) * nx + i];
        else if (q < 0 && j < ny) qy[e] = q * scale[j * nx + i];
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i, ex = j * (nx + 1) + i;
        const net = qx[ex] - qx[ex + 1] + qy[k] - qy[k + nx];
        depth[k] = Math.max(0, depth[k] + h * net / A);
      }
    }
    // depth-averaged velocity at cell centres
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, ex = j * (nx + 1) + i, d = depth[k];
      if (d < 0.05) { this.u[k] = this.v[k] = 0; continue; }
      const u = 0.5 * (qx[ex] + qx[ex + 1]) / (cy * d), v = 0.5 * (qy[k] + qy[k + nx]) / (cx * d);
      this.u[k] = Math.max(-3000, Math.min(3000, u)); this.v[k] = Math.max(-3000, Math.min(3000, v));
    }
  }
}
