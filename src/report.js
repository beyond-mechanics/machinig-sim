// Machining report: what happened on each program line. Time and cutting time come from the
// simulation substeps; peak force, vibration, deflection, tool-tip temperature, tool stress and
// the time spent chattering come from each frame's statistics, credited to the line being
// worked on at the end of the frame (at high playback speeds a frame spans several lines).

const FIELDS = ['t', 'cut', 'F', 'vib', 'defl', 'temp', 'stress', 'chatter', 'marginal', 'swing'];

export class LineReport {
  constructor() { this.lines = new Map(); this.tools = new Map(); }
  rec(line) {
    let r = this.lines.get(line);
    if (!r) { r = { line, t: 0, cut: 0, F: 0, vib: 0, defl: 0, temp: 0, stress: 0, chatter: 0, marginal: 0, swing: 0 }; this.lines.set(line, r); }
    return r;
  }
  // machine time on a line (cutting or not)
  time(line, dt, cutting) { const r = this.rec(line); r.t += dt; if (cutting) r.cut += dt; }
  // one frame's peaks for the line; state 'chatter' | 'marginal' | …, dt: machine time of the frame
  sample(line, v, state, dt) {
    const r = this.rec(line);
    r.F = Math.max(r.F, v.F); r.vib = Math.max(r.vib, v.vib); r.defl = Math.max(r.defl, v.defl);
    r.temp = Math.max(r.temp, v.temp); r.stress = Math.max(r.stress, v.stress); r.swing = Math.max(r.swing, v.swing || 0);
    if (state === 'chatter') r.chatter += dt; else if (state === 'marginal') r.marginal += dt;
  }
  toolWear(T, VB) { this.tools.set(T ?? '-', VB); }

  // plain data for the main thread: [line, …FIELDS] rows and the wear per tool
  pack() { return { rows: [...this.lines.values()].map(r => [r.line, ...FIELDS.map(k => r[k])]), tools: [...this.tools] }; }
  static unpack(p) {
    const rep = new LineReport();
    for (const row of p?.rows || []) { const r = rep.rec(row[0]); FIELDS.forEach((k, i) => { r[k] = row[i + 1] ?? 0; }); }
    for (const [T, VB] of p?.tools || []) rep.tools.set(T, VB);
    return rep;
  }

  // Lines that need a look, worst first: chatter, tool stress near the limit, a very hot edge,
  // a large temperature swing of the edge (thermal cracking), large vibration.
  // limits: { stress [MPa], temp [°C], swing [°C] }
  summary(limits = { stress: 1500, temp: 900, swing: 400 }) {
    const rows = [...this.lines.values()];
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const top = k => rows.reduce((a, r) => (r[k] > (a?.[k] ?? -Infinity) ? r : a), null);
    const issues = [];
    for (const r of rows) {
      if (!(r.cut > 0)) continue; // rapids and moves in the air
      const why = [];
      let score = 0;
      if (r.chatter > 0) { why.push('びびり'); score += 3 + r.chatter / Math.max(r.cut, 1e-6); }
      else if (r.marginal > 0.25 * r.cut && r.cut > 0) { why.push('振動注意'); score += 1; }
      if (r.stress > 0.8 * limits.stress) { why.push(r.stress > limits.stress ? '応力超過' : '応力高め'); score += r.stress > limits.stress ? 4 : 1.5; }
      if (r.temp > limits.temp) { why.push('高温'); score += 1.5; }
      if (r.swing > (limits.swing ?? 400)) { why.push('熱亀裂注意'); score += 0.8; }
      if (r.vib > 20) { why.push('振動大'); score += 0.5 + r.vib / 100; }
      if (why.length) issues.push({ ...r, why, score });
    }
    issues.sort((a, b) => b.score - a.score);
    const cut = sum('cut');
    return {
      time: sum('t'), cut, chatterShare: cut > 0 ? sum('chatter') / cut : 0,
      peakF: top('F'), peakTemp: top('temp'), peakStress: top('stress'), peakVib: top('vib'),
      tools: [...this.tools], issues,
    };
  }

  // CSV of every line (the program text alongside when given)
  csv(programLines = []) {
    const head = '行,Gコード,時間[s],切削時間[s],最大切削抵抗[N],振動振幅[µm],工具たわみ[µm],刃先温度[°C],刃先温度の変動幅[°C],工具応力[MPa],びびり時間[s],振動注意時間[s]';
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    const rows = [...this.lines.values()].sort((a, b) => a.line - b.line).map(r =>
      [r.line, q((programLines[r.line - 1] || '').trim()), r.t.toFixed(3), r.cut.toFixed(3), r.F.toFixed(1), r.vib.toFixed(1), r.defl.toFixed(1), r.temp.toFixed(0), r.swing.toFixed(0), r.stress.toFixed(0), r.chatter.toFixed(3), r.marginal.toFixed(3)].join(','));
    return '﻿' + [head, ...rows].join('\n'); // BOM so spreadsheet apps read the Japanese header
  }
}
