// Chip particles: each particle stands for one or more real chips. Gravity, drag toward a
// local fluid velocity (spindle swirl, air blast or flood coolant), collision with the
// heightfield and the rotating tool. Lengths mm, time s.

export const MAX_CHIPS = 5000;
const G = 9810;

export class ChipSystem {
  constructor() {
    const n = MAX_CHIPS;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.heat = new Float32Array(n);
    this.state = new Uint8Array(n); // 0 empty, 1 flying, 2 resting on stock, 3 evacuated (on table)
    this.rest = new Float32Array(n); this.recutCool = new Float32Array(n);
    this.rot = new Float32Array(n * 3);
    this.next = 0;
    this.reset();
  }
  reset() {
    this.state.fill(0);
    this.pending = []; this.pendingVol = 0;
    this.stats = { producedVol: 0, evacVol: 0, restVol: 0, recut: 0, count: 0, inPocket: 0 };
    this.vol = new Float32Array(MAX_CHIPS);
  }
  // queue a chip event in world coordinates
  emit(pos, vel, vol, heat) {
    this.stats.producedVol += vol;
    this.pending.push({ pos, vel, vol, heat });
  }
  // spawn at most `limit` particles per frame, merging volume into the spawned ones
  flush(limit = 12) {
    const q = this.pending;
    if (!q.length) return;
    const stride = Math.max(1, Math.ceil(q.length / limit));
    for (let s = 0; s < q.length; s += stride) {
      let vol = 0;
      for (let k = s; k < Math.min(q.length, s + stride); k++) vol += q[k].vol;
      const e = q[s];
      const i = this.alloc();
      this.p.set(e.pos, i * 3); this.v.set(e.vel, i * 3);
      this.vol[i] = vol;
      // visual size: a curled chip whose length scales with volume, clamped for legibility
      this.size[i] = Math.min(2.2, Math.max(0.35, Math.cbrt(vol) * 1.6));
      this.heat[i] = e.heat;
      this.state[i] = 1; this.rest[i] = 0; this.recutCool[i] = 0.25; // fresh chips are not recuts
      this.rot[i * 3] = Math.random() * 6.28; this.rot[i * 3 + 1] = Math.random() * 6.28; this.rot[i * 3 + 2] = (Math.random() - 0.5) * 40;
    }
    this.pending = [];
  }
  alloc() {
    // prefer an empty slot, else recycle the oldest evacuated, else overwrite round-robin
    for (let k = 0; k < MAX_CHIPS; k++) {
      const i = (this.next + k) % MAX_CHIPS;
      if (this.state[i] === 0 || this.state[i] === 3) { this.next = (i + 1) % MAX_CHIPS; return i; }
    }
    const i = this.next; this.next = (i + 1) % MAX_CHIPS; return i;
  }

  // env: {stock, tool:{x,y,tipZ,R,len,omega,cutTop}, coolant:'dry'|'air'|'flood', nozzle}
  update(dt, env) {
    const { stock } = env;
    const sub = Math.min(12, Math.max(1, Math.ceil(dt / 0.003)));
    const h = dt / sub;
    const flood = env.coolant === 'flood';
    const buoy = flood ? 1 - 1000 / env.rho : 1;
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < MAX_CHIPS; i++) {
        const st = this.state[i];
        if (st === 0 || st === 3) continue;
        const o = i * 3;
        let px = this.p[o], py = this.p[o + 1], pz = this.p[o + 2];
        const f = fluid(px, py, pz, env);
        if (st === 2) {
          // resting chips are woken by strong flow
          if (f[3] > (flood ? 600 : 3500)) { this.state[i] = 1; this.v[o + 2] += 200; }
          else continue;
        }
        let vx = this.v[o], vy = this.v[o + 1], vz = this.v[o + 2];
        // drag relaxation time: thin chips follow air quickly, coolant much faster
        const tau = (flood ? 0.004 : 0.04) * this.size[i] * env.rho / 2700;
        const a = h / (tau + h);
        vx += (f[0] - vx) * a; vy += (f[1] - vy) * a; vz += (f[2] - vz) * a;
        vz -= G * buoy * h;
        let nx = px + vx * h, ny = py + vy * h, nz = pz + vz * h;
        // rotating tool: push out and fling tangentially (clockwise from above)
        const tl = env.tool;
        const dxT = nx - tl.x, dyT = ny - tl.y, rT = Math.hypot(dxT, dyT);
        if (rT < tl.R + 0.3 && nz > tl.tipZ - 0.2 && nz < tl.tipZ + tl.len) {
          const ex = dxT / (rT || 1), ey = dyT / (rT || 1);
          nx = tl.x + ex * (tl.R + 0.35); ny = tl.y + ey * (tl.R + 0.35);
          const vt = tl.omega * tl.R * 0.25;
          vx = ey * vt + ex * 400; vy = -ex * vt + ey * 400; vz = Math.abs(vz) * 0.3 + 150;
          if (tl.cutting && nz < tl.cutTop && this.recutCool[i] <= 0) { this.stats.recut++; this.recutCool[i] = 0.3; }
        }
        if (this.recutCool[i] > 0) this.recutCool[i] -= h;
        // heightfield collision
        const fl = stock.floor(nx, ny);
        if (nz < fl + 0.1) {
          const flOld = stock.floor(px, py);
          if (fl - flOld > 0.4 && pz < fl) {
            // hit a wall: reflect horizontally and stay on the old side
            nx = px; ny = py; vx *= -0.3; vy *= -0.3;
          } else {
            nz = fl + 0.1;
            if (vz < 0) vz = -vz * 0.25;
            vx *= 0.8; vy *= 0.8;
          }
        }
        this.p[o] = nx; this.p[o + 1] = ny; this.p[o + 2] = nz;
        this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz;
        this.heat[i] = Math.max(0, this.heat[i] - h * 1.5);
        this.rot[o + 2] *= 0.995;
        this.rot[o] += this.rot[o + 2] * h;
        const speed = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
        if (nz <= fl + 0.15 && speed < 40) {
          this.rest[i] += h;
          if (this.rest[i] > 0.15) {
            this.v[o] = this.v[o + 1] = this.v[o + 2] = 0;
            this.state[i] = stock.inside(nx, ny) ? 2 : 3;
          }
        } else this.rest[i] = 0;
        if (nz < stock.zBottom - 50 || Math.abs(nx - stock.w / 2) > stock.w + 200 || Math.abs(ny - stock.l / 2) > stock.l + 200) this.state[i] = 0;
      }
    }
    // statistics: volumes by where chips are
    let restVol = 0, evac = 0, inPocket = 0, count = 0;
    for (let i = 0; i < MAX_CHIPS; i++) {
      const st = this.state[i];
      if (!st) continue;
      count++;
      const o = i * 3;
      if (st === 2) {
        restVol += this.vol[i];
        if (this.p[o + 2] < stock.zTop - 0.5) inPocket++;
      } else if (st === 3 || !stock.inside(this.p[o], this.p[o + 1])) evac += this.vol[i];
    }
    Object.assign(this.stats, { restVol, evacVol: evac, inPocket, count });
  }
}

// fluid velocity at a point: [vx, vy, vz, |v|]
const _f = new Float32Array(4);
function fluid(x, y, z, env) {
  let fx = 0, fy = 0, fz = 0;
  const tl = env.tool;
  // spindle-induced swirl near the tool
  const dx = x - tl.x, dy = y - tl.y, r = Math.hypot(dx, dy) || 1;
  if (r < tl.R * 4 && z < tl.tipZ + tl.len && z > tl.tipZ - 3) {
    const vt = tl.omega * tl.R * (tl.R / r) * 0.06 * (env.coolant === 'flood' ? 0.4 : 1);
    fx += dy / r * vt; fy += -dx / r * vt;
  }
  const nz = env.nozzle;
  if (env.coolant !== 'dry' && nz) {
    // jet from the nozzle toward the tool tip, Gaussian cross-section widening with distance
    const ax = tl.x - nz.x, ay = tl.y - nz.y, az = tl.tipZ - nz.z;
    const L = Math.hypot(ax, ay, az), ex = ax / L, ey = ay / L, ez = az / L;
    const px = x - nz.x, py = y - nz.y, pz = z - nz.z;
    const s = px * ex + py * ey + pz * ez;
    if (s > 0) {
      const qx = px - s * ex, qy = py - s * ey, qz = pz - s * ez;
      const d2 = qx * qx + qy * qy + qz * qz;
      const flood = env.coolant === 'flood';
      const w = (flood ? 6 : 3) + s * (flood ? 0.25 : 0.12);
      const U = (flood ? 6000 : 40000) * Math.exp(-d2 / (w * w)) * Math.min(1, 60 / (s + 20));
      fx += ex * U; fy += ey * U; fz += ez * U;
      // after hitting the floor the jet spreads radially outward from the impact point
      if (s > L * 0.8) {
        const rx = x - tl.x, ry = y - tl.y, rr = Math.hypot(rx, ry) || 1;
        const Us = (flood ? 2500 : 9000) * Math.exp(-rr / (flood ? 60 : 25));
        fx += rx / rr * Us; fy += ry / rr * Us;
      }
    }
  }
  _f[0] = fx; _f[1] = fy; _f[2] = fz; _f[3] = Math.hypot(fx, fy, fz);
  return _f;
}
