// Background worker for time-domain stability limits (stabtd.js): one message lists the speeds,
// each result is posted as soon as it is found, so the lobe chart fills in while the user works.
import { timeDomainLimit } from './stabtd.js';

let job = 0;
self.onmessage = async ({ data: m }) => {
  const id = ++job;
  for (const p of m.points) {
    if (id !== job) return; // a newer request replaced this one
    const r = timeDomainLimit(m.tool, p.modal, m.mat, p.S, m.arc, m.fz, { nonlinear: m.nonlinear });
    self.postMessage({ key: m.key, S: p.S, alim: r.alim, open: r.bracket[1] === Infinity });
    await new Promise(res => setTimeout(res, 0)); // let a new request in
  }
  if (id === job) self.postMessage({ key: m.key, done: true });
};
