// Native edition of the machining simulator. The window shows the web version's milling
// simulator and the chip-formation FEM; the FEM runs here in Rust (crate chipfem) and reports
// its progress to the page as events.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chipfem::cutting::{CutParams, Cutting, Sample};
use chipfem::Material;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State, Window};

#[derive(Deserialize)]
struct Request {
    material: String,
    vc: f64,
    h: f64,
    rake: f64,
    clearance: f64,
    re: f64,
    mu: f64,
    length: f64,
}

#[derive(Serialize, Clone)]
struct Point {
    cut: f64,
    fc: f64,
    ft: f64,
    chip: f64,
    t_max: f64,
    ep_max: f64,
    elements: usize,
}

impl From<&Sample> for Point {
    fn from(s: &Sample) -> Point {
        Point { cut: s.cut, fc: s.fc, ft: s.ft, chip: s.chip, t_max: s.t_max, ep_max: s.ep_max, elements: s.elements }
    }
}

/// the mesh with its fields, for drawing
#[derive(Serialize, Clone)]
struct Fields {
    x: Vec<[f64; 2]>,
    tri: Vec<[usize; 3]>,
    /// nodal temperature [°C], element plastic strain, element von Mises stress [MPa]
    temp: Vec<f64>,
    ep: Vec<f64>,
    mises: Vec<f64>,
    tool: [f64; 5],
}

#[derive(Serialize)]
struct Outcome {
    steady: Point,
    shear_angle: f64,
    history: Vec<Point>,
    fields: Fields,
    seconds: f64,
    stopped: bool,
}

fn fields(c: &Cutting) -> Fields {
    let s = &c.solver;
    let t = s.tool.as_ref().unwrap();
    let mises = s
        .sigma
        .iter()
        .map(|g| {
            let p = (g[0] + g[1] + g[2]) / 3.0;
            let (a, b, z) = (g[0] - p, g[1] - p, g[2] - p);
            (1.5 * (a * a + b * b + z * z + 2.0 * g[3] * g[3])).sqrt()
        })
        .collect();
    Fields { x: s.mesh.x.clone(), tri: s.mesh.tri.clone(), temp: s.temp.clone(), ep: s.ep.clone(), mises, tool: [t.c[0], t.c[1], t.re, t.rake, t.clearance] }
}

#[derive(Default)]
struct Run {
    stop: Arc<AtomicBool>,
}

#[tauri::command]
async fn orthogonal(window: Window, run: State<'_, Run>, req: Request) -> Result<Outcome, String> {
    let mat = Material::preset(&req.material).ok_or_else(|| format!("材料 {} はありません", req.material))?;
    let stop = run.stop.clone();
    stop.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = CutParams::new(req.vc, req.h, req.rake);
        p.clearance_deg = req.clearance;
        p.re = req.re;
        p.mu = req.mu;
        p.length = req.length;
        let t0 = std::time::Instant::now();
        let mut c = Cutting::new(mat, p);
        let mut last_draw = std::time::Instant::now();
        let every = req.length / 40.0;
        c.run(every, |s, c| {
            let _ = window.emit("fem-progress", Point::from(s));
            // the field picture about twice a second
            if last_draw.elapsed().as_millis() > 500 {
                let _ = window.emit("fem-fields", fields(c));
                last_draw = std::time::Instant::now();
            }
            !stop.load(Ordering::SeqCst)
        });
        let st = c.steady(0.4);
        let r = c.p.h / st.chip.max(1e-9);
        let a = c.p.rake_deg.to_radians();
        Outcome {
            shear_angle: (r * a.cos() / (1.0 - r * a.sin())).atan().to_degrees(),
            steady: Point::from(&st),
            history: c.history.iter().map(Point::from).collect(),
            fields: fields(&c),
            seconds: t0.elapsed().as_secs_f64(),
            stopped: stop.load(Ordering::SeqCst),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop(run: State<'_, Run>) {
    run.stop.store(true, Ordering::SeqCst);
}

fn main() {
    tauri::Builder::default()
        .manage(Run::default())
        .invoke_handler(tauri::generate_handler![orthogonal, stop])
        .run(tauri::generate_context!())
        .expect("failed to start the application");
}
