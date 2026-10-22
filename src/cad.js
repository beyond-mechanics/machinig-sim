// CAD models (STEP / IGES / BREP) as triangle meshes, for the stock, the target shape and the
// tool or holder. The B-rep is triangulated in the browser by OpenCascade compiled to
// WebAssembly (occt-import-js, ~8 MB), fetched from the CDN the first time a CAD file is opened.
// The surfaces are meshed to 0.02 mm chord error and 0.25 rad, well under the 0.3 mm grid of
// the stock, in millimetres whatever unit the file was written in.
import { meshInfo } from './workpiece.js';

export const CAD_RE = /\.(step|stp|iges|igs|brep|brp)$/i;
const VERSION = '0.0.23', BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${VERSION}/dist/`;
const PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.02, angularDeflection: 0.25 };

let occtPromise = null;
// the converter: in the browser from the CDN; elsewhere pass a factory (e.g. the npm package)
export function loadOcct(factory) {
  if (factory) return factory();
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      if (globalThis.occtimportjs) return resolve();
      const s = document.createElement('script');
      s.src = BASE + 'occt-import-js.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('STEP の変換部品 (occt-import-js) を取得できませんでした。ネット接続を確かめるか、STL で書き出してください'));
      document.head.appendChild(s);
    }).then(() => globalThis.occtimportjs({ locateFile: f => BASE + f }));
    occtPromise.catch(() => { occtPromise = null; }); // try again next time
  }
  return occtPromise;
}

// all meshes of a converter result as one triangle soup
export function trianglesFromOcct(result) {
  let n = 0;
  for (const m of result.meshes) n += m.index.array.length;
  const tris = new Float32Array(n * 3);
  let q = 0;
  for (const m of result.meshes) {
    const P = m.attributes.position.array, I = m.index.array;
    for (let i = 0; i < I.length; i++) { const v = I[i] * 3; tris[q++] = P[v]; tris[q++] = P[v + 1]; tris[q++] = P[v + 2]; }
  }
  return tris;
}

export function parseCadWith(occt, buf, name = '') {
  const fn = /\.(iges|igs)$/i.test(name) ? 'ReadIgesFile' : /\.(brep|brp)$/i.test(name) ? 'ReadBrepFile' : 'ReadStepFile';
  const r = occt[fn](new Uint8Array(buf), PARAMS);
  if (!r || !r.success) throw new Error('CAD ファイルを読めませんでした (形式か中身を確かめてください)');
  if (!r.meshes?.length) throw new Error('CAD ファイルに面 (ソリッド・サーフェス) がありません');
  return { ...meshInfo(trianglesFromOcct(r)), unitMm: true, parts: r.meshes.length };
}

export async function parseCad(buf, name, factory) {
  return parseCadWith(await loadOcct(factory), buf, name);
}
