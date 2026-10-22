// Native solver: in the desktop app (Tauri, native/app) or behind the local engine server
// (sphserve), 3D runs (STL, oblique cutting, helical end mill) are computed by the Rust core instead of this page's worker. The worker
// still sets the run up and turns the core's frames into the usual ones, so the rest of the page
// does not know the difference; the 2D modes run in the worker as before.

export function nativeBackend() {
  const T = typeof window !== 'undefined' && window.__TAURI__;
  if (T && T.core) return { name: 'アプリ', init: (json) => T.core.invoke('sim_init', { state: json }), run: (ms) => T.core.invoke('sim_run', { ms }) };
  if (typeof window !== 'undefined' && window.__SPH_NATIVE__ === 'http') {
    const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body }); if (!r.ok) throw new Error(await r.text()); return r; };
    return { name: 'ローカルサーバー', init: async (json) => (await post('api/init', json)).json(), run: async (ms) => (await post(`api/run?ms=${ms}`)).arrayBuffer() };
  }
  return null;
}

// A stand-in for the worker with the same postMessage / onmessage, which sends those runs to
// the backend. Without a backend, the worker itself.
export function wrapWorker(worker, backend) {
  if (!backend) return worker;
  const w = { onmessage: null, onerror: null, native: backend.name };
  let native = false, running = false, runN = 0, wall = 0, gen = 0, ready = null, setReady = null;
  const fail = (err) => { running = false; if (window.cutFatal) window.cutFatal(`ネイティブ計算: ${err && err.message || err}`); };
  worker.onerror = (e) => { if (w.onerror) w.onerror(e); };
  worker.onmessage = (e) => {
    if (e.data.type === 'nativeState') { const p = backend.init(e.data.json); p.catch(fail); setReady(p); return; }
    if (w.onmessage) w.onmessage(e);
  };
  async function loop(g) {
    try { await ready; } catch (e) { return; }
    // About 4 frames a second: each one is copied into the worker and drawn, which costs the
    // core CPU time on a machine with few cores (and much more with software WebGL).
    while (running && g === gen) {
      const t = performance.now();
      let buf;
      try { buf = await backend.run(250); } catch (e) { fail(e); return; }
      if (g !== gen) return;                                  // reset meanwhile
      wall += performance.now() - t;
      if (new Float64Array(buf, 0, 16)[3] === 1) running = false;
      worker.postMessage({ type: 'nativeFrame', buf, running, runN, wall }, [buf]);
    }
  }
  w.postMessage = (msg) => {
    if (msg.type === 'init') {
      gen++; running = false; wall = 0;
      native = msg.cfg.mode === 'mesh' || msg.cfg.mode === '3d' || msg.cfg.mode === 'helix';
      if (native) ready = new Promise((r) => { setReady = r; });
      worker.postMessage(native ? { ...msg, cfg: { ...msg.cfg, native: true } } : msg);
      return;
    }
    if (native && msg.type === 'run') { runN = msg.n || 0; if (!running) { running = true; loop(gen); } return; }
    if (native && msg.type === 'pause') { running = false; worker.postMessage({ type: 'nativePause', wall, runN }); return; }
    worker.postMessage(msg);
  };
  return w;
}
