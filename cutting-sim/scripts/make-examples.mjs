// Writes the example STL files of examples/ (mm, binary STL) from src/examples3d.js: a planing
// tool and its work block, a two-flute helical end mill (φ2) placed in the side of a block, and a
// two-lip drill point. Run: node scripts/make-examples.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { EXAMPLES } from '../src/examples3d.js';

const out = (name, t) => {
  const n = t.length / 9, buf = Buffer.alloc(84 + 50 * n);
  buf.write(`cutting-sim example ${name}`.slice(0, 79), 0);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + 50 * i, a = t.slice(9 * i, 9 * i + 9);
    const ux = a[3] - a[0], uy = a[4] - a[1], uz = a[5] - a[2], vx = a[6] - a[0], vy = a[7] - a[1], vz = a[8] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(a[k], o + 12 + 4 * k);
  }
  mkdirSync('examples', { recursive: true });
  writeFileSync(`examples/${name}`, buf);
  console.log(name, n, 'triangles');
};
for (const [k, e] of Object.entries(EXAMPLES)) { out(`${k}_work.stl`, e.work()); out(`${k}_tool.stl`, e.tool()); }
