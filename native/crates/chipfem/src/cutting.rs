//! Orthogonal cutting: the work, the tool, the run with remeshing, and what comes out of it.
//!
//! The work is a block x ∈ [0, L], y ∈ [−H, 0] held on its bottom (both directions) and its left
//! end (x); the tool's lowest point is at y = −h (h: uncut chip thickness) and it moves along −x
//! at the cutting speed. No separation criterion: the rounded edge splits the material into the
//! chip and the machined surface, and the remesher keeps the elements around it usable.

use crate::material::Material;
use crate::mesh::Mesh;
use crate::remesh::{boundary_loop, mesh_polygon, mesh_polygon_min, resample};
use crate::solver::{Bc, Solver};
use crate::tool::Tool;
use crate::toolheat::{ToolHeat, ToolMaterial};

#[derive(Clone, Debug)]
pub struct CutParams {
    /// cutting speed [m/min]
    pub vc: f64,
    /// uncut chip thickness [mm]
    pub h: f64,
    /// rake and clearance angles [°], edge radius [mm]
    pub rake_deg: f64,
    pub clearance_deg: f64,
    pub re: f64,
    /// Coulomb friction on the tool, and the friction stress limit as a share of the shear flow
    /// stress (None: Coulomb alone)
    pub mu: f64,
    pub shear_factor: Option<f64>,
    /// length of cut [mm]
    pub length: f64,
    /// element size at the edge and far from it [mm]
    pub h_min: f64,
    pub h_max: f64,
    /// mass scaling factor
    pub mass_scale: f64,
    /// initial temperature [°C]
    pub t0: f64,
    /// refinement along the rake face: over `rake_band`·h from the edge (0: none), the elements
    /// next to the face at `rake_layer`·h_min
    pub rake_band: f64,
    pub rake_layer: f64,
    /// conduct heat into a carbide tool (false: adiabatic tool)
    pub tool_heat: bool,
    /// all the friction heat into the work (else half of it, the rest to the tool)
    pub friction_heat_to_work: bool,
}

impl CutParams {
    pub fn new(vc: f64, h: f64, rake_deg: f64) -> CutParams {
        CutParams {
            vc,
            h,
            rake_deg,
            clearance_deg: 7.0,
            re: 0.02,
            mu: 0.3,
            shear_factor: Some(1.0),
            length: 1.0,
            h_min: (h / 8.0).min(0.012),
            h_max: (h * 0.8).max(0.04),
            mass_scale: 100.0,
            t0: 20.0,
            rake_band: 3.0,
            rake_layer: 0.5,
            tool_heat: false,
            friction_heat_to_work: true,
        }
    }
}

/// one sample of the run, averaged over the interval since the previous one
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub t: f64,
    /// length cut so far [mm]
    pub cut: f64,
    /// cutting (along the speed) and thrust (normal to the machined surface) force [N/mm width]
    pub fc: f64,
    pub ft: f64,
    /// highest temperature and plastic strain in the work [°C, −]
    pub t_max: f64,
    pub ep_max: f64,
    /// chip thickness [mm] (0 before a chip is there)
    pub chip: f64,
    pub elements: usize,
    pub remeshes: usize,
    /// highest tool temperature [°C] (the initial temperature for an adiabatic tool)
    pub t_tool: f64,
}

pub struct Cutting {
    pub p: CutParams,
    pub solver: Solver,
    pub width: f64,
    pub depth: f64,
    pub history: Vec<Sample>,
    pub remeshes: usize,
    /// remeshes left out because the boundary could not be meshed
    pub skipped: usize,
    /// wall time spent in the solver steps and in remeshing [s]
    pub time_step: f64,
    pub time_remesh: f64,
    acc: [f64; 2],
    acc_n: usize,
}

impl Cutting {
    pub fn new(mat: Material, p: CutParams) -> Cutting {
        let width = p.length + 6.0 * p.h + 4.0 * p.re;
        let depth = (5.0 * p.h).max(0.3);
        let rake = p.rake_deg.to_radians();
        let tool = Tool {
            rake,
            clearance: p.clearance_deg.to_radians(),
            re: p.re,
            // the edge just clear of the work's end, its lowest point at y = −h
            c: [width + p.re + 0.002, -p.h + p.re],
            v: [-p.vc * 1000.0 / 60.0, 0.0],
            mu: p.mu,
            shear_factor: p.shear_factor,
            heat_share: if p.friction_heat_to_work { 1.0 } else { 0.5 },
        };
        let poly = [[0.0, -depth], [width, -depth], [width, 0.0], [0.0, 0.0]];
        let mut cut = Cutting { solver: Solver::new(mat, Mesh::default_box(), p.t0), width, depth, history: Vec::new(), remeshes: 0, skipped: 0, time_step: 0.0, time_remesh: 0.0, acc: [0.0; 2], acc_n: 0, p };
        if cut.p.tool_heat {
            // the tool's near-edge part, a few chip thicknesses long (the rest stays cool)
            let th = ToolHeat::new(&tool, ToolMaterial::carbide(), (12.0 * cut.p.h).max(0.6), cut.p.h_min, cut.p.t0);
            cut.solver.tool_dt = th.stable_dt();
            cut.solver.tool_heat = Some(th);
        }
        cut.solver.tool = Some(tool);
        cut.solver.mass_scale = cut.p.mass_scale;
        let sized = cut.size_fn();
        let ring = resample(&poly, &sized, 0.5, &|_| false);
        let mesh = mesh_polygon(&ring, &sized, cut.p.h_max).expect("the initial block meshes");
        let n = mesh.x.len();
        cut.solver.mesh = mesh;
        cut.solver.v = vec![[0.0; 2]; n];
        cut.solver.temp = vec![cut.p.t0; n];
        let ne = cut.solver.mesh.tri.len();
        cut.solver.s = vec![[0.0; 4]; ne];
        cut.solver.ev = vec![0.0; ne];
        cut.solver.ep = vec![0.0; ne];
        cut.solver.epdot = vec![0.0; ne];
        cut.solver.sigma = vec![[0.0; 4]; ne];
        cut.solver.rebuild();
        cut.apply_bcs();
        cut
    }

    /// target element size: fine at the edge, growing with the distance from it
    fn size_fn(&self) -> impl Fn([f64; 2]) -> f64 {
        let (c, rake) = self.solver.tool.as_ref().map(|t| (t.c, t.rake)).unwrap_or(([0.0, 0.0], 0.0));
        let (hmin, hmax, h, re) = (self.p.h_min, self.p.h_max, self.p.h, self.p.re);
        let (band, layer) = (self.p.rake_band, self.p.rake_layer);
        let (sa, ca) = rake.sin_cos();
        let (tr, nr) = ([sa, ca], [-ca, sa]);
        move |q: [f64; 2]| {
            let r = ((q[0] - c[0]).hypot(q[1] - c[1]) - re).max(0.0);
            // the primary shear zone and the chip near the edge stay fine over about 2h
            let mut size = (hmin + 0.35 * (r - 1.5 * h).max(0.0)).clamp(hmin, hmax);
            // the secondary shear zone: a thin layer along the rake face over the contact length,
            // where the chip sticks and shears (its heating decides the interface temperature)
            if band > 0.0 {
                let d = [q[0] - c[0] - re * nr[0], q[1] - c[1] - re * nr[1]];
                let along = d[0] * tr[0] + d[1] * tr[1];
                let off = -(d[0] * nr[0] + d[1] * nr[1]);
                if along > -re && along < band * h && off > -0.5 * hmin && off < 0.5 * h {
                    // the layer next to the face at `layer`·h_min, growing to h_min half a chip
                    // thickness out
                    let f = (off.max(0.0) / (0.5 * h)).min(1.0);
                    size = size.min(hmin * (layer + (1.0 - layer) * f));
                }
            }
            size
        }
    }

    /// supports: bottom fixed, left end fixed along x
    fn apply_bcs(&mut self) {
        let s = &mut self.solver;
        s.bcs.clear();
        let tol = 1e-7;
        for (i, p) in s.mesh.x.iter().enumerate() {
            if p[1] < -self.depth + tol {
                s.bcs.push(Bc { node: i, dof: 0, vel: 0.0 });
                s.bcs.push(Bc { node: i, dof: 1, vel: 0.0 });
            } else if p[0] < tol {
                s.bcs.push(Bc { node: i, dof: 0, vel: 0.0 });
            }
        }
    }

    pub fn remesh(&mut self) {
        let lp = boundary_loop(&self.solver.mesh);
        let poly: Vec<[f64; 2]> = lp.iter().map(|&i| self.solver.mesh.x[i]).collect();
        let sized = self.size_fn();
        let d = self.depth;
        // the supported edges keep their corners
        let keep = move |p: [f64; 2]| p[1] < -d + 1e-7 || p[0] < 1e-7;
        let ring = resample(&poly, &sized, 0.6, &keep);
        // a boundary that touches itself (a chip curling onto the work) cannot be meshed: keep the
        // present mesh this time
        let Some(mesh) = mesh_polygon_min(&ring, &sized, self.p.h_max, 0.15 * self.p.h_min * self.p.h_min) else {
            self.skipped += 1;
            if std::env::var("CHIPFEM_DEBUG").is_ok() {
                eprintln!("remesh skipped at cut {:.3} mm (quality {:.3})", self.cut_length(), self.solver.min_quality());
            }
            return;
        };
        if !self.solver.transfer_to(mesh) {
            self.skipped += 1;
            return;
        }
        self.apply_bcs();
        self.remeshes += 1;
    }

    /// length cut so far [mm]
    pub fn cut_length(&self) -> f64 {
        let t = self.solver.tool.as_ref().unwrap();
        (self.width + self.p.re + 0.002) - t.c[0]
    }

    /// Chip thickness: the farthest the chip's free side gets from the rake face, between 2h and
    /// 4h up the face from the edge.
    pub fn chip_thickness(&self) -> f64 {
        let t = self.solver.tool.as_ref().unwrap();
        let (sa, ca) = t.rake.sin_cos();
        let (tr, nr) = ([sa, ca], [-ca, sa]);
        let p0 = [t.c[0] + t.re * nr[0], t.c[1] + t.re * nr[1]];
        let mut best: f64 = 0.0;
        for p in &self.solver.mesh.x {
            let q = [p[0] - p0[0], p[1] - p0[1]];
            let along = q[0] * tr[0] + q[1] * tr[1];
            if along > 2.0 * self.p.h && along < 4.0 * self.p.h && p[1] > 0.0 {
                best = best.max(q[0] * nr[0] + q[1] * nr[1]);
            }
        }
        best
    }

    /// Run until the cut length is reached (or `stop` says so), sampling every `every` mm of cut.
    /// A run can be continued with a longer `p.length` (sampling goes on from the present cut).
    pub fn run(&mut self, every: f64, mut on_sample: impl FnMut(&Sample, &Cutting) -> bool) {
        let mut next = ((self.cut_length() / every).floor() + 1.0) * every;
        let mut since = 0usize;
        let mut q_after = self.solver.min_quality();
        let mut dt_after = self.solver.dt;
        loop {
            let t_step = std::time::Instant::now();
            self.solver.step();
            self.time_step += t_step.elapsed().as_secs_f64();
            since += 1;
            self.acc[0] += self.solver.tool_force[0];
            self.acc[1] += self.solver.tool_force[1];
            self.acc_n += 1;
            // remesh before an element gets too flat (its quality half of what the last remesh
            // gave, or near flat), and often enough that the fine region follows the edge; a
            // fixed threshold would trigger again right after a remesh whose own worst element is
            // already below it (fine grading near the edge), smearing the fields every few steps
            // (at least 50 steps apart: a remesh that leaves a poor element must not repeat
            // every few steps, smearing the fields)
            // (an element close to flat is remeshed at once)
            {
                let q = self.solver.min_quality();
                // (also when the stable time step has halved: small elements squashed at the edge
                // would otherwise slow the run to a crawl)
                let due = since >= 50 && since % 10 == 0 && (q < (0.5 * q_after).min(0.3) || self.solver.dt < 0.5 * dt_after || since >= 400);
                if due || q < 0.08 {
                    let t_r = std::time::Instant::now();
                    self.remesh();
                    self.time_remesh += t_r.elapsed().as_secs_f64();
                    q_after = self.solver.min_quality();
                    dt_after = self.solver.dt;
                    since = 0;
                }
            }
            let cut = self.cut_length();
            if cut >= next || cut >= self.p.length {
                let s = Sample {
                    t: self.solver.t,
                    cut,
                    fc: self.acc[0] / self.acc_n as f64,
                    ft: self.acc[1] / self.acc_n as f64,
                    t_max: self.solver.temp.iter().cloned().fold(f64::MIN, f64::max),
                    ep_max: self.solver.ep.iter().cloned().fold(0.0, f64::max),
                    chip: self.chip_thickness(),
                    elements: self.solver.mesh.tri.len(),
                    remeshes: self.remeshes,
                    t_tool: self.solver.tool_heat.as_ref().map_or(self.p.t0, |th| th.max_temp()),
                };
                self.acc = [0.0; 2];
                self.acc_n = 0;
                self.history.push(s.clone());
                next += every;
                if !on_sample(&s, self) || cut >= self.p.length {
                    break;
                }
            }
        }
    }

    /// The tool's temperature once it has warmed up (steady heat flow): the tool surface where
    /// the work touches it takes the work's temperature there (the cut itself ran with an
    /// adiabatic tool, which is what a warmed-up tool amounts to over a fraction of a millisecond),
    /// the rest of the faces are insulated, and the tool `length` from the edge is held at the
    /// initial temperature (the shank and holder as a heat sink).
    pub fn tool_steady(&self, length: f64) -> ToolHeat {
        let tool = self.solver.tool.as_ref().unwrap();
        let mut th = ToolHeat::new(tool, ToolMaterial::carbide(), length, self.p.h_min, self.p.t0);
        // work surface nodes and their temperatures, in the tool frame
        let bnodes: Vec<usize> = {
            let mut v: Vec<usize> = self.solver.mesh.boundary_edges().iter().map(|e| e[0]).collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let near = 0.75 * self.p.h_min;
        let mut st = Vec::with_capacity(th.surface.len());
        for &j in &th.surface {
            let q = th.mesh.x[j];
            let p = [q[0] + tool.c[0], q[1] + tool.c[1]];
            // the work's surface temperature at this point: inverse-distance mean of the work
            // surface nodes within reach (none: the face is free there)
            let (mut w, mut s) = (0.0, 0.0);
            for &i in &bnodes {
                let x = self.solver.mesh.x[i];
                let d = (x[0] - p[0]).hypot(x[1] - p[1]);
                if d < near {
                    let wi = 1.0 / (d + 0.1 * near);
                    w += wi;
                    s += wi * self.solver.temp[i];
                }
            }
            st.push((j, if w > 0.0 { s / w } else { f64::NAN }));
        }
        th.solve_steady(&st);
        th
    }

    /// Steady-state values: the mean over the last `share` of the history.
    pub fn steady(&self, share: f64) -> Sample {
        let n = self.history.len();
        let k = ((n as f64 * share).ceil() as usize).clamp(1, n.max(1));
        let tail = &self.history[n - k..];
        let m = tail.len() as f64;
        let mut s = Sample { cut: self.cut_length(), elements: self.solver.mesh.tri.len(), remeshes: self.remeshes, ..Default::default() };
        for x in tail {
            s.fc += x.fc / m;
            s.ft += x.ft / m;
            s.chip += x.chip / m;
            s.t_max += x.t_max / m;
            s.ep_max += x.ep_max / m;
            s.t_tool += x.t_tool / m;
        }
        s
    }
}

impl Mesh {
    /// a placeholder before the real mesh is built
    pub fn default_box() -> Mesh {
        Mesh::rect(0.0, 0.0, 1.0, 1.0, 1, 1, None)
    }
}
