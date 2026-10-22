// Desktop app: the cutting simulator page (cutting-sim/dist) in a native window, with STL-mode
// runs computed by the native core (sph-core) on all CPU cores. The page finds the core through
// window.__TAURI__ (src/native.js) and calls the two commands below.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::json;
use sph_core::engine::Engine;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Response, State};

type Eng = Arc<Mutex<Engine>>;

// Sets a run up from the state the page's worker prepared (JSON).
#[tauri::command]
async fn sim_init(state: String, eng: State<'_, Eng>) -> Result<serde_json::Value, String> {
    let e = eng.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut e = e.lock().unwrap();
        e.init(state.as_bytes()).map(|n| json!({ "n": n, "threads": rayon::current_num_threads(), "gpu": e.gpu_name(), "gpuNote": e.gpu_note }))
    })
        .await
        .map_err(|e| e.to_string())?
}

// Steps for about `ms` of wall time; the binary frame goes back as an ArrayBuffer.
#[tauri::command]
async fn sim_run(ms: f64, eng: State<'_, Eng>) -> Result<Response, String> {
    let e = eng.inner().clone();
    let b = tauri::async_runtime::spawn_blocking(move || e.lock().unwrap().run(ms)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(b))
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(Engine::default())))
        .invoke_handler(tauri::generate_handler![sim_init, sim_run])
        .run(tauri::generate_context!())
        .expect("起動できませんでした");
}
