// GPU prototype of the two pair passes of Sim::step (src/sim.rs, pass_lm and pass_momentum), in
// f32. One invocation per particle walks its own entries, as the CPU gather does.

struct Params {
    n: u32, per: f32, hk: f32, ad: f32,
    m: f32, alpha: f32, beta: f32, cs: f32,
    iwdx: f32, xs: f32, eta: f32, pad: f32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<vec4<f32>>;      // x, y, z (from the centre), 1 if held
@group(0) @binding(2) var<storage, read> q: array<vec4<f32>>;        // vx, vy, vz, rho
@group(0) @binding(3) var<storage, read> mstart: array<u32>;         // entries of particle p: mstart[p]..mstart[p+1]
@group(0) @binding(4) var<storage, read> mpair: array<vec2<u32>>;    // (i, j) of every entry
@group(0) @binding(5) var<storage, read> hstart: array<u32>;         // held pairs of particle p
@group(0) @binding(6) var<storage, read> hlist: array<u32>;
@group(0) @binding(7) var<storage, read> hij: array<vec2<u32>>;
@group(0) @binding(8) var<storage, read> ht: array<f32>;             // rx ry rz g1 g2 g3 of every held pair
@group(0) @binding(9) var<storage, read> pk: array<f32>;             // 9 per particle
@group(0) @binding(10) var<storage, read> dmg: array<f32>;
@group(0) @binding(11) var<storage, read_write> lm: array<f32>;      // 19 per particle
@group(0) @binding(12) var<storage, read_write> ac: array<f32>;      // 6 per particle

struct K { ok: bool, r: vec3<f32>, g: vec3<f32>, w: f32 }

fn kern(i: u32, j: u32) -> K {
    var k: K;
    k.ok = false;
    let a = pos[i];
    let b = pos[j];
    if (a.w > 0.5 && b.w > 0.5) { return k; }
    var r = a.xyz - b.xyz;
    if (P.per > 0.0) {
        if (r.z > 0.5 * P.per) { r.z -= P.per; } else if (r.z < -0.5 * P.per) { r.z += P.per; }
    }
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
    return k;
}

@compute @workgroup_size(64)
fn pass_lm(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    var o: array<f32, 19>;
    for (var c = 0u; c < 19u; c++) { o[c] = 0.0; }
    for (var e = mstart[p]; e < mstart[p + 1u]; e++) {
        let ij = mpair[e];
        let k = kern(ij.x, ij.y);
        if (!k.ok) { continue; }
        let qi = q[ij.x];
        let qj = q[ij.y];
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
    // Pairs of two held particles: only the correction matrix of the supports.
    for (var h = hstart[p]; h < hstart[p + 1u]; h++) {
        let k = hlist[h];
        let ij = hij[k];
        if (pos[ij.x].w > 0.5 && pos[ij.y].w > 0.5) { continue; }
        let vo = select(P.m / q[ij.x].w, P.m / q[ij.y].w, p == ij.x);
        let r = vec3<f32>(ht[6u * k], ht[6u * k + 1u], ht[6u * k + 2u]);
        let g = vec3<f32>(ht[6u * k + 3u], ht[6u * k + 4u], ht[6u * k + 5u]);
        o[9] -= vo * r.x * g.x; o[10] -= vo * r.x * g.y; o[11] -= vo * r.x * g.z;
        o[12] -= vo * r.y * g.x; o[13] -= vo * r.y * g.y; o[14] -= vo * r.y * g.z;
        o[15] -= vo * r.z * g.x; o[16] -= vo * r.z * g.y; o[17] -= vo * r.z * g.z;
    }
    for (var c = 0u; c < 19u; c++) { lm[19u * p + c] = o[c]; }
}

@compute @workgroup_size(64)
fn pass_momentum(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    if (p >= P.n) { return; }
    var f = vec3<f32>(0.0);
    var u = vec3<f32>(0.0);
    for (var e = mstart[p]; e < mstart[p + 1u]; e++) {
        let ij = mpair[e];
        let i = ij.x;
        let j = ij.y;
        let k = kern(i, j);
        if (!k.ok) { continue; }
        let si = 9u * i;
        let sj = 9u * j;
        var txx = pk[si] + pk[sj];
        var tyy = pk[si + 1u] + pk[sj + 1u];
        var tzz = pk[si + 2u] + pk[sj + 2u];
        let txy = pk[si + 3u] + pk[sj + 3u];
        let tyz = pk[si + 4u] + pk[sj + 4u];
        let txz = pk[si + 5u] + pk[sj + 5u];
        let qi = q[i];
        let qj = q[j];
        let dv = qi.xyz - qj.xyz;
        let rs = qi.w + qj.w;
        let vr = dot(dv, k.r);
        if (vr < 0.0) {
            let mu = P.hk * vr / (dot(k.r, k.r) + P.eta);
            let pv = (-P.alpha * P.cs * mu + P.beta * mu * mu) * 2.0 / rs;
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
