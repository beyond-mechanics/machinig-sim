import { Simulator } from '../src/sim.js';
import { SAMPLES } from '../src/samples.js';
for (const key of Object.keys(SAMPLES)) {
  const sim = new Simulator();
  sim.load(SAMPLES[key].code);
  sim.speed = 4;
  console.log(`== ${key}: path pts=${sim.path.length} total=${sim.totalTime.toFixed(1)}s warnings=${sim.warnings.length}`, sim.warnings);
  let frames = 0, t0 = performance.now(), lastLine = -1, worst = 0;
  const states = {};
  while (!sim.done && frames < 20000) {
    sim.step(1 / 60); frames++;
    const d = sim.display;
    states[d.state] = (states[d.state] || 0) + 1;
    if (frames % 120 === 0) console.log(`t=${sim.mtime.toFixed(2)} line=${sim.line} ap=${d.ap.toFixed(2)} F=${d.F.toFixed(0)}N Fmax=${d.Fmax.toFixed(0)} T=${d.torque.toFixed(2)}Nm P=${d.power.toFixed(2)}kW defl=${d.defl.toFixed(1)}um vib=${d.vib.toFixed(1)}um ci=${d.chatterIdx.toFixed(2)} ${d.state} σ=${d.stress.toFixed(0)} MRR=${d.mrr.toFixed(1)} chips=${sim.chips.stats.count} pocket=${sim.chips.stats.inPocket} recut=${sim.chips.stats.recut}`);
  }
  const ms = performance.now() - t0;
  console.log(`frames=${frames} avg ${(ms / frames).toFixed(2)} ms/frame; removed=${sim.stock.removed.toFixed(0)} mm3; states`, states, 'alerts', [...sim.alerts.values()].map(a => a.msg));
}
