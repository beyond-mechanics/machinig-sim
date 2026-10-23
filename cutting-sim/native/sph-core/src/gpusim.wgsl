// A whole step of the 3D SPH solver on the GPU, in f32 (src/gpusim.rs drives it): the passes of
// Sim::step in src/sim.rs, one invocation per particle walking its own pair entries. STL mode
// (a tool mesh moving straight, turning while fed, or drilling).

struct Params {
    n: u32, steps: u32, flags: u32, nsub: u32,
    dt: f32, m: f32, m_real: f32, g: f32,
    k: f32, rho0: f32, cs: f32, hk: f32,
    ad: f32, iwdx: f32, ep_keep: f32, dx: f32,
    av_a: f32, av_b: f32, xs: f32, coef: f32,
    // material
    ma: f32, mb: f32, mn: f32, mc: f32,
    mm: f32, tm: f32, tr: f32, mvc: f32,
    rhoc: f32, cp: f32, ta: f32, tb: f32,
    tcc: f32, td: f32, d1: f32, d2: f32,
    d3: f32, d4: f32, d5: f32, efs: f32,
    beta: f32, pcut: f32, mu0: f32, mu_exp: f32,
    // tool pose (positions are from the centre c; see gpusim.rs)
    tx0: f32, ty0: f32, tz0: f32, ax: f32,
    ay: f32, ca: f32, sa: f32, w: f32,
    base: f32, tvz: f32, far: f32, cell: f32,
    bb0: f32, bb1: f32, bb2: f32, bb3: f32,
    bb4: f32, bb5: f32, lo0: i32, lo1: i32,
    lo2: i32, dm0: i32, dm1: i32, dm2: i32,
    // contact
    fw: f32, v_esc2: f32, area: f32, v_slow2: f32,
    d_free: f32, d_wake: f32, d_sleep: f32, d0: f32,
    lim2: f32, pad0: f32, pad1: f32, pad2: f32,
}

// flags
const F_SLEEP: u32 = 1u;
const F_WAKE: u32 = 2u;
const F_FRAC: u32 = 4u;
const F_MUV: u32 = 8u;
const F_TANH: u32 = 16u;
const F_SHEP: u32 = 32u;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4<f32>>;   // v, ρ
@group(0) @binding(3) var<storage, read_write> flg: array<u32>;         // fixed | contact << 8 | dead << 16 | touched << 24
@group(0) @binding(4) var<storage, read_write> sig: array<f32>;         // sxx syy szz sxy syz sxz
@group(0) @binding(5) var<storage, read_write> prs: array<f32>;
@group(0) @binding(6) var<storage, read_write> tmp: array<f32>;
@group(0) @binding(7) var<storage, read_write> ep: array<f32>;
@group(0) @binding(8) var<storage, read_write> epd: array<f32>;
@group(0) @binding(9) var<storage, read_write> dmg: array<f32>;
@group(0) @binding(10) var<storage, read_write> seqv: array<f32>;
@group(0) @binding(11) var<storage, read_write> srv: array<f32>;
@group(0) @binding(12) var<storage, read_write> pk: array<f32>;
@group(0) @binding(13) var<storage, read_write> lm: array<f32>;
@group(0) @binding(14) var<storage, read_write> ac: array<f32>;
@group(0) @binding(15) var<storage, read_write> mstart: array<u32>;
@group(0) @binding(16) var<storage, read_write> mpair: array<vec2<u32>>;
@group(0) @binding(17) var<storage, read_write> ef: array<f32>;
@group(0) @binding(18) var<storage, read_write> hstart: array<u32>;
@group(0) @binding(19) var<storage, read_write> hlist: array<u32>;
@group(0) @binding(20) var<storage, read_write> hij: array<vec2<u32>>;
@group(0) @binding(21) var<storage, read_write> ht: array<f32>;         // rx ry rz g1 g2 g3 W ef per held pair
@group(0) @binding(22) var<storage, read_write> scr: array<f32>;
@group(0) @binding(23) var<storage, read_write> xr: array<vec4<f32>>;
@group(0) @binding(24) var<storage, read_write> sdft: array<i32>;
@group(0) @binding(25) var<storage, read_write> sdfp: array<f32>;
@group(0) @binding(26) var<storage, read_write> part: array<f32>;       // 8 sums per workgroup
@group(0) @binding(27) var<storage, read_write> outv: array<f32>;
@group(0) @binding(28) var<storage, read_write> flagb: array<atomic<u32>>;

fn fixed_of(f: u32) -> u32 { return f & 255u; }
fn dead_of(f: u32) -> u32 { return (f >> 16u) & 255u; }

struct K { ok: bool, r: vec3<f32>, g: vec3<f32>, w: f32, e: f32 }

fn kern(i: u32, j: u32) -> K {
    var k: K;
    k.ok = false;
    if (fixed_of(flg[i]) >= 2u && fixed_of(flg[j]) >= 2u) { return k; }
    let r = pos[i].xyz - pos[j].xyz;
    let r2 = dot(r, r);
    if (r2 >= 4.0 * P.hk * P.hk || r2 == 0.0) { return k; }
    let rr = sqrt(r2);
    let inv = 1.0 / P.hk;
    let s = rr * inv;
    var w: f32;
    var dw: f32;
    if (s < 1.0) {
        w = P.ad * (1.0 - 1.5 * s * s + 0.75 * s * s * s);
        dw = P.ad * inv * (-3.0 * s + 2.25 * s * s);
    } else {
        let t = 2.0 - s;
        w = P.ad * 0.25 * t * t * t;
        dw = -P.ad * inv * 0.75 * t * t;
    }
    k.ok = true;
    k.r = r;
    k.g = r * (dw / rr);
    k.w = w;
    k.e = dw * rr / (r2 + 0.01 * P.hk * P.hk);
    return k;
}

// 1. Velocity gradient, correction matrix and dρ/dt.
@compute @workgroup_size(64)
fn k_lm(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    var o: array<f32, 19>;
    for (var c = 0u; c < 19u; c++) { o[c] = 0.0; }
    for (var e = mstart[p]; e < mstart[p + 1u]; e++) {
        let ij = mpair[e];
        let k = kern(ij.x, ij.y);
        if (!k.ok) { continue; }
        let qi = vel[ij.x];
        let qj = vel[ij.y];
        let vo = select(P.m / qi.w, P.m / qj.w, p == ij.x);
        let dv = qi.xyz - qj.xyz;
        let g = k.g;
        let r = k.r;
        o[0] -= vo * dv.x * g.x; o[1] -= vo * dv.x * g.y; o[2] -= vo * dv.x * g.z;
        o[3] -= vo * dv.y * g.x; o[4] -= vo * dv.y * g.y; o[5] -= vo * dv.y * g.z;
        o[6] -= vo * dv.z * g.x; o[7] -= vo * dv.z * g.y; o[8] -= vo * dv.z * g.z;
        o[9] -= vo * r.x * g.x; o[10] -= vo * r.x * g.y; o[11] -= vo * r.x * g.z;
        o[12] -= vo * r.y * g.x; o[13] -= vo * r.y * g.y; o[14] -= vo * r.y * g.z;
        o[15] -= vo * r.z * g.x; o[16] -= vo * r.z * g.y; o[17] -= vo * r.z * g.z;
        o[18] += P.m * dot(dv, g);
    }
    for (var h = hstart[p]; h < hstart[p + 1u]; h++) {
        let k = hlist[h];
        let ij = hij[k];
        if (fixed_of(flg[ij.x]) >= 2u && fixed_of(flg[ij.y]) >= 2u) { continue; }
        let vo = select(P.m / vel[ij.x].w, P.m / vel[ij.y].w, p == ij.x);
        let r = vec3<f32>(ht[8u * k], ht[8u * k + 1u], ht[8u * k + 2u]);
        let g = vec3<f32>(ht[8u * k + 3u], ht[8u * k + 4u], ht[8u * k + 5u]);
        o[9] -= vo * r.x * g.x; o[10] -= vo * r.x * g.y; o[11] -= vo * r.x * g.z;
        o[12] -= vo * r.y * g.x; o[13] -= vo * r.y * g.y; o[14] -= vo * r.y * g.z;
        o[15] -= vo * r.z * g.x; o[16] -= vo * r.z * g.y; o[17] -= vo * r.z * g.z;
    }
    for (var c = 0u; c < 19u; c++) { lm[19u * p + c] = o[c]; }
}

// Shepard filter of the density (every 20 steps): into scr, then copied.
@compute @workgroup_size(64)
fn k_shep(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    var num = P.m * P.ad;
    var den = P.m * P.ad / vel[p].w;
    for (var h = hstart[p]; h < hstart[p + 1u]; h++) {
        let k = hlist[h];
        let ij = hij[k];
        let w = ht[8u * k + 6u];
        num += P.m * w;
        den += P.m * w / vel[select(ij.x, ij.y, p == ij.x)].w;
    }
    for (var e = mstart[p]; e < mstart[p + 1u]; e++) {
        let ij = mpair[e];
        let k = kern(ij.x, ij.y);
        if (!k.ok) { continue; }
        num += P.m * k.w;
        den += P.m * k.w / vel[select(ij.x, ij.y, p == ij.x)].w;
    }
    scr[p] = num / den;
}

@compute @workgroup_size(64)
fn k_shep2(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    vel[p].w = scr[p];
}

// Johnson-Cook (or the tanh model) flow stress [Pa], as Mat::flow_stress.
fn flow_stress(e: f32, ed: f32, t: f32) -> f32 {
    let tanh_m = (P.flags & F_TANH) != 0u;
    var hard = P.ma;
    if (e > 0.0) {
        var hh = pow(e, P.mn);
        if (tanh_m) { hh *= exp(-pow(e, P.ta)); }
        hard += P.mb * hh;
    }
    var rate = 1.0;
    if (ed > 1.0) { rate = 1.0 + P.mc * log(ed); }
    let ts = clamp((t - P.tr) / (P.tm - P.tr), 0.0, 1.0);
    var soft = max(1.0 - pow(ts, P.mm), 0.01);
    if (tanh_m) {
        let trr = min((t + 273.15) / (P.tm + 273.15), 1.0);
        let d = 1.0 - pow(trr, P.td);
        let s = pow(trr, P.tb);
        soft *= d + (1.0 - d) * tanh(1.0 / pow(e + s, P.tcc));
    }
    return hard * rate * soft * 1e6;
}

fn friction_at(v: f32) -> f32 {
    let r = v / (0.5 * P.mvc / 60.0);
    return P.mu0 * min(1.5, max(0.3, pow(max(r, 1e-6), -P.mu_exp)));
}

// 2. Constitutive update (also refreshes ρ in vel.w for the momentum pass).
@compute @workgroup_size(64)
fn k_const(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= P.n) { return; }
    let o = 19u * i;
    let s0 = 6u * i;
    let q = 9u * i;
    let f = flg[i];
    var rho = vel[i].w;
    var p = prs[i];
    if (fixed_of(f) >= 2u || dead_of(f) != 0u) {
        let ir2 = 1.0 / (rho * rho);
        pk[q] = (sig[s0] - p) * ir2; pk[q + 1u] = (sig[s0 + 1u] - p) * ir2; pk[q + 2u] = (sig[s0 + 2u] - p) * ir2;
        pk[q + 3u] = sig[s0 + 3u] * ir2; pk[q + 4u] = sig[s0 + 4u] * ir2; pk[q + 5u] = sig[s0 + 5u] * ir2;
        pk[q + 6u] = 0.0; pk[q + 7u] = 0.0; pk[q + 8u] = 0.0;
        return;
    }
    var l = mat3x3<f32>(lm[o], lm[o + 3u], lm[o + 6u], lm[o + 1u], lm[o + 4u], lm[o + 7u], lm[o + 2u], lm[o + 5u], lm[o + 8u]);
    // l[c][r] = L_rc (column-major); M likewise.
    let mm = mat3x3<f32>(lm[o + 9u], lm[o + 12u], lm[o + 15u], lm[o + 10u], lm[o + 13u], lm[o + 16u], lm[o + 11u], lm[o + 14u], lm[o + 17u]);
    let det = determinant(mm);
    if (det > 0.3) {
        // L ← L M⁻¹ (row r of L times M⁻¹)
        let a = mm[0][0]; let b = mm[1][0]; let c = mm[2][0];
        let d = mm[0][1]; let e = mm[1][1]; let ff = mm[2][1];
        let gg = mm[0][2]; let hh = mm[1][2]; let ii = mm[2][2];
        let id = 1.0 / det;
        let inv = mat3x3<f32>(
            (e * ii - ff * hh) * id, -(d * ii - ff * gg) * id, (d * hh - e * gg) * id,
            -(b * ii - c * hh) * id, (a * ii - c * gg) * id, -(a * hh - b * gg) * id,
            (b * ff - c * e) * id, -(a * ff - c * d) * id, (a * e - b * d) * id);
        l = l * inv;
    }
    let l00 = l[0][0]; let l01 = l[1][0]; let l02 = l[2][0];
    let l10 = l[0][1]; let l11 = l[1][1]; let l12 = l[2][1];
    let l20 = l[0][2]; let l21 = l[1][2]; let l22 = l[2][2];
    let tr3 = l00 + l11 + l22;
    let dxx = l00 - tr3 / 3.0; let dyy = l11 - tr3 / 3.0; let dzz = l22 - tr3 / 3.0;
    let dxy = 0.5 * (l01 + l10); let dyz = 0.5 * (l12 + l21); let dxz = 0.5 * (l02 + l20);
    let wxy = 0.5 * (l01 - l10); let wyz = 0.5 * (l12 - l21); let wxz = 0.5 * (l02 - l20);
    let dt = P.dt;
    rho += lm[o + 18u] * dt;
    p = P.k * (rho / P.rho0 - 1.0);
    var dm = dmg[i];
    var fs = 1.0;
    if (dm >= 1.5) { fs = 0.0; } else if (dm > 1.0) { fs = 3.0 - 2.0 * dm; }
    let pc = P.pcut * fs;
    if (p < pc) { p = pc; rho = P.rho0 * (1.0 + pc / P.k); }
    var sxx = sig[s0]; var syy = sig[s0 + 1u]; var szz = sig[s0 + 2u];
    var sxy = sig[s0 + 3u]; var syz = sig[s0 + 4u]; var sxz = sig[s0 + 5u];
    let axx = wxy * sxy + wxz * sxz;
    let ayy = -wxy * sxy + wyz * syz;
    let azz = -wxz * sxz - wyz * syz;
    let axy = wxy * syy + wxz * syz;
    let ayx = -wxy * sxx + wyz * sxz;
    let ayz = -wxy * sxz + wyz * szz;
    let azy = -wxz * sxy - wyz * syy;
    let axz = wxy * syz + wxz * szz;
    let azx = -wxz * sxx - wyz * sxy;
    let g2 = 2.0 * P.g;
    sxx += dt * (g2 * dxx + 2.0 * axx); syy += dt * (g2 * dyy + 2.0 * ayy); szz += dt * (g2 * dzz + 2.0 * azz);
    sxy += dt * (g2 * dxy + axy + ayx); syz += dt * (g2 * dyz + ayz + azy); sxz += dt * (g2 * dxz + axz + azx);
    let seq = sqrt(1.5 * (sxx * sxx + syy * syy + szz * szz + 2.0 * (sxy * sxy + syz * syz + sxz * sxz)));
    var e = ep[i];
    var ed = epd[i];
    var t = tmp[i];
    let sy = flow_stress(e, ed, t) * fs;
    var dep = 0.0;
    if (seq > sy) {
        let scl = sy / seq;
        sxx *= scl; syy *= scl; szz *= scl; sxy *= scl; syz *= scl; sxz *= scl;
        if (sy > 0.0) { dep = (seq - sy) / (3.0 * P.g); }
        e += dep;
        t += P.beta * sy * dep / P.rhoc;
        if ((P.flags & F_FRAC) != 0u && fs > 0.0 && det > 0.6 && ((f >> 8u) & 255u) == 0u) {
            let eta = -p / max(sy, 1e6);
            if (eta > 0.0) {
                let tsd = clamp((t - P.tr) / (P.tm - P.tr), 0.0, 1.0);
                var r = 0.0;
                if (ed > 1.0) { r = log(ed); }
                let efr = max(0.02, (P.d1 + P.d2 * exp(P.d3 * eta)) * (1.0 + P.d4 * r) * (1.0 + P.d5 * tsd) * P.efs);
                dm += dep / efr;
            }
        }
    }
    ed = P.ep_keep * ed + (1.0 - P.ep_keep) * dep / dt;
    srv[i] = sqrt(2.0 / 3.0) * sqrt(dxx * dxx + dyy * dyy + dzz * dzz + 2.0 * (dxy * dxy + dyz * dyz + dxz * dxz));
    sig[s0] = sxx; sig[s0 + 1u] = syy; sig[s0 + 2u] = szz; sig[s0 + 3u] = sxy; sig[s0 + 4u] = syz; sig[s0 + 5u] = sxz;
    seqv[i] = min(seq, sy);
    ep[i] = e; epd[i] = ed; tmp[i] = t; dmg[i] = dm; prs[i] = p;
    vel[i].w = rho;
    let ir2 = 1.0 / (rho * rho);
    pk[q] = (sxx - p) * ir2; pk[q + 1u] = (syy - p) * ir2; pk[q + 2u] = (szz - p) * ir2;
    pk[q + 3u] = sxy * ir2; pk[q + 4u] = syz * ir2; pk[q + 5u] = sxz * ir2;
    pk[q + 6u] = select(0.0, -0.3 * (sxx - p) * ir2, sxx - p > 0.0);
    pk[q + 7u] = select(0.0, -0.3 * (syy - p) * ir2, syy - p > 0.0);
    pk[q + 8u] = select(0.0, -0.3 * (szz - p) * ir2, szz - p > 0.0);
}

// 3. Momentum and XSPH; keeps each entry's conduction factor (0: not a pair now).
@compute @workgroup_size(64)
fn k_mom(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    var f = vec3<f32>(0.0);
    var u = vec3<f32>(0.0);
    let eta = 0.01 * P.hk * P.hk;
    for (var e = mstart[p]; e < mstart[p + 1u]; e++) {
        let ij = mpair[e];
        let i = ij.x;
        let j = ij.y;
        let k = kern(i, j);
        if (!k.ok) { ef[e] = 0.0; continue; }
        ef[e] = k.e;
        let si = 9u * i;
        let sj = 9u * j;
        var txx = pk[si] + pk[sj];
        var tyy = pk[si + 1u] + pk[sj + 1u];
        var tzz = pk[si + 2u] + pk[sj + 2u];
        let txy = pk[si + 3u] + pk[sj + 3u];
        let tyz = pk[si + 4u] + pk[sj + 4u];
        let txz = pk[si + 5u] + pk[sj + 5u];
        let qi = vel[i];
        let qj = vel[j];
        let dv = qi.xyz - qj.xyz;
        let rs = qi.w + qj.w;
        let vr = dot(dv, k.r);
        if (vr < 0.0) {
            let mu = P.hk * vr / (dot(k.r, k.r) + eta);
            let pv = (-P.av_a * P.cs * mu + P.av_b * mu * mu) * 2.0 / rs;
            txx -= pv; tyy -= pv; tzz -= pv;
        }
        var fq = k.w * P.iwdx;
        fq *= fq; fq *= fq;
        txx += fq * (pk[si + 6u] + pk[sj + 6u]);
        tyy += fq * (pk[si + 7u] + pk[sj + 7u]);
        tzz += fq * (pk[si + 8u] + pk[sj + 8u]);
        let g = k.g;
        let fe = P.m * vec3<f32>(txx * g.x + txy * g.y + txz * g.z, txy * g.x + tyy * g.y + tyz * g.z, txz * g.x + tyz * g.y + tzz * g.z);
        let wx = select(P.xs * k.w * 2.0 / rs, 0.0, dmg[i] >= 1.5 || dmg[j] >= 1.5);
        let ue = -dv * wx;
        if (p == i) { f += fe; u += ue; } else { f -= fe; u -= ue; }
    }
    ac[6u * p] = f.x; ac[6u * p + 1u] = f.y; ac[6u * p + 2u] = f.z;
    ac[6u * p + 3u] = u.x; ac[6u * p + 4u] = u.y; ac[6u * p + 5u] = u.z;
}

// 4. Heat conduction, one substep: the change into scr, then added.
@compute @workgroup_size(64)
fn k_cond(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    var d = 0.0;
    for (var h = hstart[p]; h < hstart[p + 1u]; h++) {
        let k = hlist[h];
        let ij = hij[k];
        let qq = P.coef * (tmp[ij.x] - tmp[ij.y]) * ht[8u * k + 7u];
        if (p == ij.x) { d += qq * P.m / vel[ij.y].w; } else { d -= qq * P.m / vel[ij.x].w; }
    }
    for (var e = mstart[p]; e < mstart[p + 1u]; e++) {
        let fe = ef[e];
        if (fe == 0.0) { continue; }
        let ij = mpair[e];
        let qq = P.coef * (tmp[ij.x] - tmp[ij.y]) * fe;
        if (p == ij.x) { d += qq * P.m / vel[ij.y].w; } else { d -= qq * P.m / vel[ij.x].w; }
    }
    scr[p] = d;
}

@compute @workgroup_size(64)
fn k_cond2(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    tmp[p] += scr[p];
}

// Tool distance field in the mesh frame: (d, normal), as MeshSdf::sample.
fn sdf(px: f32, py: f32, pz: f32) -> vec4<f32> {
    let ex = max(max(P.bb0 - px, 0.0), px - P.bb3);
    let ey = max(max(P.bb1 - py, 0.0), py - P.bb4);
    let ez = max(max(P.bb2 - pz, 0.0), pz - P.bb5);
    let db = sqrt(ex * ex + ey * ey + ez * ez);
    if (db > P.far) { return vec4<f32>(db, 0.0, 0.0, 1.0); }
    let gx = px / P.cell; let gy = py / P.cell; let gz = pz / P.cell;
    let ix = i32(floor(gx)); let iy = i32(floor(gy)); let iz = i32(floor(gz));
    let bi = ix >> 3u; let bj = iy >> 3u; let bk = iz >> 3u;           // floor division by 8
    let a = bi - P.lo0; let b = bj - P.lo1; let c = bk - P.lo2;
    if (a < 0 || b < 0 || c < 0 || a >= P.dm0 || b >= P.dm1 || c >= P.dm2) { return vec4<f32>(P.far, 0.0, 0.0, 1.0); }
    let slot = sdft[a + P.dm0 * (b + P.dm1 * c)];
    if (slot == -1) { return vec4<f32>(P.far, 0.0, 0.0, 1.0); }
    if (slot < 0) { return vec4<f32>(-P.far, 0.0, 0.0, 1.0); }
    let lx = u32(ix - bi * 8); let ly = u32(iy - bj * 8); let lz = u32(iz - bk * 8);
    let fx = gx - f32(ix); let fy = gy - f32(iy); let fz = gz - f32(iz);
    let base = u32(slot) * 2916u;                                       // 4 · 9³
    var s = vec4<f32>(0.0);
    for (var k = 0u; k < 8u; k++) {
        let ox = k & 1u; let oy = (k >> 1u) & 1u; let oz = k >> 2u;
        let w = select(1.0 - fx, fx, ox == 1u) * select(1.0 - fy, fy, oy == 1u) * select(1.0 - fz, fz, oz == 1u);
        let o = base + 4u * ((lx + ox) + 9u * ((ly + oy) + 9u * (lz + oz)));
        s += w * vec4<f32>(sdfp[o], sdfp[o + 1u], sdfp[o + 2u], sdfp[o + 3u]);
    }
    var l = length(s.yzw);
    if (l == 0.0) { l = 1.0; }
    return vec4<f32>(s.x, s.yzw / l);
}

struct Tool { d: f32, n: vec3<f32>, tv: vec3<f32> }

fn tool_at(x: vec3<f32>) -> Tool {
    let x_ = x.x - P.tx0;
    let y_ = x.y - P.ty0;
    let s = sdf(P.ax + P.ca * x_ + P.sa * y_, P.ay - P.sa * x_ + P.ca * y_, x.z + P.tz0);
    var t: Tool;
    t.d = s.x;
    t.n = vec3<f32>(P.ca * s.y - P.sa * s.z, P.sa * s.y + P.ca * s.z, s.w);
    t.tv = vec3<f32>(P.base - P.w * y_, P.w * x_, P.tvz);
    return t;
}

// 5. Integration, tool contact and the supports of one particle; returns its share of
// impulse (3), torque, tool work, tool heat, deaths.
fn integ(i: u32) -> array<f32, 8> {
    var r: array<f32, 8>;
    for (var c = 0u; c < 8u; c++) { r[c] = 0.0; }
    if (i >= P.n) { return r; }
    var f = flg[i];
    var fixed = f & 255u;
    var contact = (f >> 8u) & 255u;
    var dead = (f >> 16u) & 255u;
    var touched = f >> 24u;
    var x = pos[i].xyz;
    var v = vel[i].xyz;
    let dx = P.dx;
    if (fixed == 2u && dead == 0u && tool_at(x).d < 3.0 * dx) { fixed = 0u; }
    if (fixed == 3u && (P.flags & F_WAKE) != 0u && tool_at(x).d < P.d_wake) { fixed = 0u; }
    if (fixed != 0u || dead != 0u) {
        v = vec3<f32>(0.0);
        contact = 0u;
    } else {
        v += vec3<f32>(ac[6u * i], ac[6u * i + 1u], ac[6u * i + 2u]) * P.dt;
        if (dot(v, v) > P.v_esc2) {
            dead = 1u; r[6] = 1.0; v = vec3<f32>(0.0);
        } else {
            x += (v + vec3<f32>(ac[6u * i + 3u], ac[6u * i + 4u], ac[6u * i + 5u])) * P.dt;
            let o = tool_at(x);
            if (o.d >= P.d0) {
                contact = 0u;
                let v2 = dot(v, v);
                if (touched != 0u && o.d > P.d_free && v2 < P.v_slow2) { fixed = 2u; v = vec3<f32>(0.0); }
                else if ((P.flags & F_SLEEP) != 0u && touched == 0u && o.d > P.d_sleep && v2 < P.v_slow2) { fixed = 3u; v = vec3<f32>(0.0); }
            } else {
                contact = 1u;
                touched = 1u;
                let nrm = o.n;
                x += nrm * (P.d0 - o.d);
                let rv = v - o.tv;
                let vn = dot(rv, nrm);
                let jn = P.m * max(-vn, 0.0);
                var tt = rv - vn * nrm;
                let vt = length(tt);
                var jt = 0.0;
                var e_tool = 0.0;
                if (vt > 1e-12) {
                    tt /= vt;
                    let dm = dmg[i];
                    let fsd = select(max(0.0, 3.0 - 2.0 * dm), 1.0, dm <= 1.0);
                    let tau_max = flow_stress(ep[i], epd[i], tmp[i]) * fsd / sqrt(3.0);
                    let mu = select(P.mu0, friction_at(vt), (P.flags & F_MUV) != 0u);
                    jt = min(min(P.m * vt, mu * jn), tau_max * P.area * P.dt);
                    let en = jt * (vt - 0.5 * jt / P.m);
                    tmp[i] += P.fw * en / (P.m_real * P.cp);
                    e_tool = (1.0 - P.fw) * en;
                }
                r[5] = e_tool;
                let dp = jn * nrm - jt * tt;
                if (vn < 0.0) { v -= vn * nrm; }
                v -= jt / P.m * tt;
                r[0] = -dp.x; r[1] = -dp.y; r[2] = -dp.z;
                r[4] = dot(dp, o.tv);
                let xx = x.x - P.tx0;
                let yy = x.y - P.ty0;
                r[3] = -(xx * dp.y - yy * dp.x);
            }
        }
    }
    // Moved more than half the skin since the last neighbour search: search again before the next step.
    let d3 = x - xr[i].xyz;
    if (dead == 0u && dot(d3, d3) > P.lim2) { atomicMax(&flagb[0], 1u); }
    pos[i] = vec4<f32>(x, 0.0);
    vel[i] = vec4<f32>(v, vel[i].w);
    flg[i] = fixed | (contact << 8u) | (dead << 16u) | (touched << 24u);
    return r;
}

var<workgroup> sh: array<f32, 512>;

@compute @workgroup_size(64)
fn k_int(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {
    let r = integ(gid.x);
    for (var c = 0u; c < 8u; c++) { sh[8u * li + c] = r[c]; }
    workgroupBarrier();
    for (var s = 32u; s > 0u; s >>= 1u) {
        if (li < s) { for (var c = 0u; c < 8u; c++) { sh[8u * li + c] += sh[8u * (li + s) + c]; } }
        workgroupBarrier();
    }
    if (li == 0u) { for (var c = 0u; c < 8u; c++) { part[8u * wg.x + c] = sh[c]; } }
}

// The workgroup sums into outv[0..8].
@compute @workgroup_size(64)
fn k_red(@builtin(local_invocation_index) li: u32) {
    let ng = (P.n + 63u) / 64u;
    var a: array<f32, 8>;
    for (var c = 0u; c < 8u; c++) { a[c] = 0.0; }
    for (var g = li; g < ng; g += 64u) { for (var c = 0u; c < 8u; c++) { a[c] += part[8u * g + c]; } }
    for (var c = 0u; c < 8u; c++) { sh[8u * li + c] = a[c]; }
    workgroupBarrier();
    for (var s = 32u; s > 0u; s >>= 1u) {
        if (li < s) { for (var c = 0u; c < 8u; c++) { sh[8u * li + c] += sh[8u * (li + s) + c]; } }
        workgroupBarrier();
    }
    if (li == 0u) { for (var c = 0u; c < 8u; c++) { outv[c] = sh[c]; } }
}
