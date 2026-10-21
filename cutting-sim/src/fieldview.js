// Continuous field picture of the particles (Canvas 2D), in the manner of an FE contour plot:
// each particle spreads its value with a smooth kernel onto a fine grid, the grid is sampled per
// screen pixel (bilinear), and the body ends where the kernel sum drops to half its interior value,
// so the chip, the free surface and broken pieces get a clean outline. 'bands' quantises the value
// into discrete colour bands with thin lines between them; 'smooth' keeps the continuous colour.

const BANDS = 12;
const off = document.createElement('canvas');

// Interior kernel sum for w = (1 − r²/R²)² on a lattice of spacing dx: ∫ w dA / dx² = πR²/(3dx²).
const kernelSum = (R, dx) => Math.PI * R * R / (3 * dx * dx);

export function bandsOf(style) { return style === 'bands' ? BANDS : 0; }

// ctx: the view's context; t: { s, ox, oy, dpr } (mm → device px); vals: per-particle values;
// lut: 256 [r, g, b]; style 'bands' | 'smooth'.
export function renderField(ctx, frame, t, vals, lo, hi, lut, style, smooth = 1) {
  const { s, ox, oy, dpr } = t, cw = ctx.canvas.width, ch = ctx.canvas.height;
  // Work in CSS pixels (cheap), then draw scaled to the device canvas.
  const W = Math.max(1, Math.round(cw / dpr)), H = Math.max(1, Math.round(ch / dpr)), sp = s / dpr;
  const dx = frame.dx, R = 1.6 * dx, cell = dx / 4, n = frame.x.length;
  // World window of the screen (mm), padded by the kernel radius.
  const wx0 = -ox / s - R, wx1 = (cw - ox) / s + R, wy1 = oy / s + R, wy0 = (oy - ch) / s - R;
  const nx = Math.ceil((wx1 - wx0) / cell) + 1, ny = Math.ceil((wy1 - wy0) / cell) + 1;
  if (nx * ny > 4e6) return false;   // zoomed far out: let the caller draw particles
  // The body (and the fixed-particle shade) from a kernel of radius R; the value from a wider one
  // (smooth·R) for the noisy fields, stress and pressure, which scatter from particle to particle.
  const Sw = new Float32Array(nx * ny), Sv = new Float32Array(nx * ny), Sf = new Float32Array(nx * ny);
  const Rv = smooth * R, Swv = smooth > 1 ? new Float32Array(nx * ny) : Sw;
  const rc = Math.ceil(Rv / cell), iR2 = 1 / (R * R), iRv2 = 1 / (Rv * Rv);
  for (let i = 0; i < n; i++) {
    const px = frame.x[i], py = frame.y[i];
    if (px < wx0 || px > wx1 || py < wy0 || py > wy1) continue;
    const gi = Math.round((px - wx0) / cell), gj = Math.round((py - wy0) / cell), v = vals[i], fx = frame.flag[i] === 1 ? 1 : 0;
    const i0 = Math.max(0, gi - rc), i1 = Math.min(nx - 1, gi + rc), j0 = Math.max(0, gj - rc), j1 = Math.min(ny - 1, gj + rc);
    for (let j = j0; j <= j1; j++) {
      const dy = wy0 + j * cell - py, dy2 = dy * dy, row = j * nx;
      for (let k = i0; k <= i1; k++) {
        const ddx = wx0 + k * cell - px, r2 = ddx * ddx + dy2, q = 1 - r2 * iR2;
        if (q > 0) { const w = q * q; Sw[row + k] += w; if (fx) Sf[row + k] += w; if (Swv === Sw) { Sv[row + k] += w * v; continue; } }
        if (Swv === Sw) continue;
        const qv = 1 - r2 * iRv2;
        if (qv > 0) { const w = qv * qv; Swv[row + k] += w; Sv[row + k] += w * v; }
      }
    }
  }
  const S0 = kernelSum(R, dx), edge0 = 0.4 * S0, edge1 = 0.52 * S0, nb = bandsOf(style), inv = 1 / (hi - lo);
  off.width = W; off.height = H;
  const octx = off.getContext('2d'), img = octx.createImageData(W, H), buf = new Uint32Array(img.data.buffer);
  const band = new Int16Array(W * H).fill(-1);
  const gx0 = -wx0 / cell, gy0 = -wy0 / cell;   // screen px → grid index: (X/sp − ox/s − wx0)/cell
  const oxs = ox / s, oys = oy / s;
  for (let Y = 0; Y < H; Y++) {
    const gy = (oys - (Y + 0.5) / sp) / cell + gy0;
    const j = Math.floor(gy); if (j < 0 || j >= ny - 1) continue;
    const fy = gy - j, r0 = j * nx, r1 = r0 + nx;
    for (let X = 0; X < W; X++) {
      const gx = ((X + 0.5) / sp - oxs) / cell + gx0;
      const k = Math.floor(gx); if (k < 0 || k >= nx - 1) continue;
      const fx = gx - k, a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
      const w = a * Sw[r0 + k] + b * Sw[r0 + k + 1] + c * Sw[r1 + k] + d * Sw[r1 + k + 1];
      if (w < edge0) continue;
      const wv = Swv === Sw ? w : a * Swv[r0 + k] + b * Swv[r0 + k + 1] + c * Swv[r1 + k] + d * Swv[r1 + k + 1];
      const v = (a * Sv[r0 + k] + b * Sv[r0 + k + 1] + c * Sv[r1 + k] + d * Sv[r1 + k + 1]) / wv;
      const f = (a * Sf[r0 + k] + b * Sf[r0 + k + 1] + c * Sf[r1 + k] + d * Sf[r1 + k + 1]) / w;
      let u = (v - lo) * inv; u = u > 0 ? (u > 1 ? 1 : u) : 0;   // NaN (an empty or stale frame) → 0
      let ti;
      if (nb) { const bi = Math.min(nb - 1, Math.floor(u * nb)); band[Y * W + X] = bi; ti = Math.round(bi / (nb - 1) * 255); }
      else { ti = Math.round(u * 255); band[Y * W + X] = 0; }
      const col = lut[ti], m = f > 0.5 ? 0.55 : 1;
      const al = w >= edge1 ? 255 : Math.round(255 * (w - edge0) / (edge1 - edge0));   // soft outline
      buf[Y * W + X] = (al << 24) | ((col[2] * m) << 16) | ((col[1] * m) << 8) | (col[0] * m);
    }
  }
  // Thin dark lines between bands and along the free surface (inside pixels next to outside ones).
  for (let Y = 0; Y < H - 1; Y++) for (let X = 0; X < W - 1; X++) {
    const p = Y * W + X, b0 = band[p];
    if (b0 < 0) continue;
    const br = band[p + 1], bd = band[p + W];
    const outline = br < 0 || bd < 0 || (X > 0 && band[p - 1] < 0) || (Y > 0 && band[p - W] < 0);
    if (outline || (nb && (br !== b0 || bd !== b0))) {
      const c = buf[p], m = outline ? 0.3 : 0.62;
      buf[p] = (c & 0xff000000) | ((((c >> 16) & 255) * m) << 16) | ((((c >> 8) & 255) * m) << 8) | ((c & 255) * m);
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, W, H, 0, 0, cw, ch);
  ctx.restore();
  return true;
}

// CSS gradient for the legend: hard stops per band, or the continuous map.
export function legendGradient(lut, nb) {
  if (!nb) return `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => `rgb(${lut[Math.round(t * 255)]}) ${t * 100}%`).join(', ')})`;
  const st = [];
  for (let b = 0; b < nb; b++) { const c = `rgb(${lut[Math.round(b / (nb - 1) * 255)]})`; st.push(`${c} ${(b / nb * 100).toFixed(2)}%`, `${c} ${((b + 1) / nb * 100).toFixed(2)}%`); }
  return `linear-gradient(90deg, ${st.join(', ')})`;
}
