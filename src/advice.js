// What to change on a line the machining report flags, with numbers where the models give them:
// the feed that brings the tool stress back under its limit (force law of feedopt.js), the
// spindle speed that brings the edge temperature or its swing down (cutting temperature model),
// and where to look for chatter and vibration. The advice is a first step to try, not a guarantee:
// each change is checked by running the program again.
import { forceRatio } from './feedopt.js';
import { cuttingTemperature, T0 } from './thermal.js';

// largest k in [lo, 1] with f(k) ≤ 0 (f increasing in k); null when even lo is not enough
function lowest(f, lo = 0.3) {
  if (f(1) <= 0) return 1;
  if (f(lo) > 0) return null;
  let a = lo, b = 1;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (a + b); if (f(m) > 0) b = m; else a = m; }
  return a;
}
const r2 = v => Math.round(v * 100) / 100;

// r: report row (with why[]); ctx: { mat, nonlinear, S (min⁻¹ on the line), F (feed on the line
// [mm/min]), D (tool diameter), rakeDeg, limits: { stress, temp, swing } }
export function adviceFor(r, ctx) {
  const out = [];
  const { mat, limits } = ctx;
  const has = w => r.why.includes(w);
  // chatter first: it is set by the depth of cut and the speed, and it drives the other peaks
  if (has('びびり')) {
    // with the lobes of the line's engagement: the limit here and a better speed nearby
    const st = ctx.stability?.(r, ctx.S);
    if (st && r.ap > 0) out.push(`この係合 (ap ${r.ap.toFixed(2)} mm) の安定限界は ${ctx.S ? `S${Math.round(ctx.S)} で ` : ''}${st.alim.toFixed(2)} mm: 切込みを ${st.alim.toFixed(2)} mm 以下に${st.pocketS ? `、または S${st.pocketS} (限界 ${st.pocketA.toFixed(2)} mm) へ` : ''}`);
    else out.push('切込みを減らすか、安定限界線図の山 (安定ポケット) へ主軸回転を移す (加工条件タブの「安定ポケットに合わせる」)');
  }
  else if (has('振動注意')) out.push('安定限界に近い: 切込みを 1〜2 割減らすか、安定ポケットへ主軸回転を移す');
  if (has('応力超過') || has('応力高め')) {
    const target = 0.8 * limits.stress;
    const k = r.h > 0 ? lowest(q => r.stress * forceRatio(mat, r.h, q, ctx.nonlinear) - target) : null;
    if (k && k < 1) out.push(`送りを ×${r2(k)}${ctx.F ? ` (${Math.round(ctx.F)} → ${Math.round(ctx.F * k)} mm/min)` : ''} で工具応力が許容の 8 割`);
    else if (!k) out.push('送りだけでは下げきれない: 切込み (ap・ae) を減らす、突出しを短く、太い工具に');
    out.push('突出しを短くすると応力とたわみが下がる');
  }
  // temperature and its swing: both fall with the cutting speed (the chip thickness is kept)
  const hot = has('高温'), crack = has('熱亀裂注意');
  if ((hot || crack) && ctx.S > 0 && r.h > 0) {
    const Vc = Math.PI * ctx.D * ctx.S / 60000; // m/s
    const T1 = cuttingTemperature(mat, r.h, Vc, ctx.rakeDeg).tool;
    const rise = q => cuttingTemperature(mat, r.h, Vc * q, ctx.rakeDeg).tool;
    // the swing scales with the rise of the quasi-steady temperature
    const need = q => Math.max(hot ? rise(q) - limits.temp * (T1 / Math.max(r.temp, 1)) : -1,
      crack ? (rise(q) - T0) / (T1 - T0) * r.swing - limits.swing : -1);
    const q = lowest(need, 0.3);
    if (q && q < 1) out.push(`主軸回転を ×${r2(q)} (S${Math.round(ctx.S)} → S${Math.round(ctx.S * q)}、送りも同じ比で下げて 1 刃送りを保つ) で${hot ? '刃先温度' : ''}${hot && crack ? 'と' : ''}${crack ? '温度の変動' : ''}が目安以下`);
    else if (!q) out.push('切削速度を大きく下げる必要がある: 被削材に合った工具 (コーティング) か条件を見直す');
    if (crack) out.push('断続切削の熱亀裂: 刃先が冷える時間を減らす (径方向切込みを大きく、刃数を減らす) か、クーラントの断続的な当たりを避ける (エアブロー)');
  }
  if (has('振動大') && !has('びびり')) out.push('強制振動が大きい: 突出しを短く、工具の振れを確認、送りを下げる');
  return out;
}
