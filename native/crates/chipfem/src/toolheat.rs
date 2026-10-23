//! Heat conduction in the cutting tool. The tool stays rigid and moves without turning, so its
//! thermal mesh lives in the tool's own frame (origin at the centre of the edge radius) and only
//! its temperatures change. It takes heat from the work through the contact (conduction across
//! the interface and its share of the friction heat) and conducts it into its body; the far end
//! of the meshed part (`length` from the edge) is held at the initial temperature, standing for
//! the rest of the tool and the holder.
//!
//! Interface exchange between a work node in contact and the nearest tool surface node:
//! Q = G·(T_w − T_t), G = h_c·ℓ·Δt (contact conductance h_c, the node's share ℓ of the contact
//! length), limited to half of the series heat capacity so that one step never overshoots the
//! common temperature (explicit and stable whatever h_c).

use crate::mesh::{tri_geom, Mesh};
use crate::remesh::{mesh_polygon, resample};
use crate::tool::Tool;

#[derive(Clone, Debug)]
pub struct ToolMaterial {
    /// density [t/mm³], specific heat [mJ/(t·K)], conductivity [mJ/(s·mm·K)]
    pub rho: f64,
    pub cp: f64,
    pub k: f64,
}

impl ToolMaterial {
    /// cemented carbide (WC–Co, about 10 % Co)
    pub fn carbide() -> ToolMaterial {
        ToolMaterial { rho: 14.5e-9, cp: 220e6, k: 80.0 }
    }
}

pub struct ToolHeat {
    pub mat: ToolMaterial,
    /// mesh in the tool frame (origin: centre of the edge radius)
    pub mesh: Mesh,
    pub temp: Vec<f64>,
    /// heat capacity of each node [mJ/K]
    cap: Vec<f64>,
    /// nodes on the faces the work can touch (rake face, edge, clearance face)
    pub surface: Vec<usize>,
    /// nodes held at the initial temperature (the far end)
    fixed: Vec<bool>,
    /// element conduction: area·k and the shape-function gradients
    elem: Vec<(f64, [[f64; 2]; 3])>,
    /// heat waiting to be added to each node this step [mJ]
    pending: Vec<f64>,
    /// contact conductance [mW/(mm²·K)] (1e5 = 10⁸ W/(m²·K): near-perfect contact)
    pub h_contact: f64,
    t0: f64,
}

impl ToolHeat {
    /// Mesh the tool's near-edge part: faces `length` long from the edge, element size h_min at
    /// the edge growing away from it.
    pub fn new(tool: &Tool, mat: ToolMaterial, length: f64, h_min: f64, t0: f64) -> ToolHeat {
        let (sa, ca) = tool.rake.sin_cos();
        let (sg, cg) = tool.clearance.sin_cos();
        let (tr, nr, tc, nc) = ([sa, ca], [-ca, sa], [cg, sg], [sg, -cg]);
        let re = tool.re;
        // outline: far end of the rake face → edge arc (outside of the edge) → far end of the
        // clearance face → back corner
        let mut poly = vec![[re * nr[0] + length * tr[0], re * nr[1] + length * tr[1]]];
        let a0 = nr[1].atan2(nr[0]);
        let mut a1 = nc[1].atan2(nc[0]);
        while a1 < a0 {
            a1 += 2.0 * std::f64::consts::PI;
        }
        let n_arc = 16;
        for k in 0..=n_arc {
            let a = a0 + (a1 - a0) * k as f64 / n_arc as f64;
            poly.push([re * a.cos(), re * a.sin()]);
        }
        poly.push([re * nc[0] + length * tc[0], re * nc[1] + length * tc[1]]);
        poly.push([length * (tr[0] + tc[0]), length * (tr[1] + tc[1])]);
        // counter-clockwise
        let area2: f64 = (0..poly.len()).map(|i| { let (p, q) = (poly[i], poly[(i + 1) % poly.len()]); p[0] * q[1] - q[0] * p[1] }).sum();
        if area2 < 0.0 {
            poly.reverse();
        }
        let h_max = (length / 8.0).max(h_min);
        let size = move |p: [f64; 2]| (h_min + 0.25 * (p[0].hypot(p[1]) - re).max(0.0)).min(h_max);
        let ring = resample(&poly, &size, 0.3, &|_| false);
        let mesh = mesh_polygon(&ring, &size, h_max).expect("the tool outline meshes");
        let n = mesh.x.len();
        let mut cap = vec![0.0; n];
        let mut elem = Vec::with_capacity(mesh.tri.len());
        for t in &mesh.tri {
            let (a, g) = tri_geom(mesh.x[t[0]], mesh.x[t[1]], mesh.x[t[2]]);
            for &i in t {
                cap[i] += mat.rho * mat.cp * a / 3.0;
            }
            elem.push((a * mat.k, g));
        }
        // the work touches the tool within the faces' first part; the far end is held
        let dist_face = |p: [f64; 2], t: [f64; 2], nrm: [f64; 2]| {
            let q = [p[0] - re * nrm[0], p[1] - re * nrm[1]];
            let along = q[0] * t[0] + q[1] * t[1];
            let off = q[0] * nrm[0] + q[1] * nrm[1];
            (along, off.abs())
        };
        let mut surface = Vec::new();
        let mut fixed = vec![false; n];
        let bnodes: std::collections::HashSet<usize> = mesh.boundary_edges().iter().flat_map(|e| [e[0], e[1]]).collect();
        for &i in &bnodes {
            let p = mesh.x[i];
            let r = p[0].hypot(p[1]);
            let (ar, or) = dist_face(p, tr, nr);
            let (ac, oc) = dist_face(p, tc, nc);
            let on_rake = or < 1e-6 && ar >= -1e-9 && ar < 0.9 * length;
            let on_clear = oc < 1e-6 && ac >= -1e-9 && ac < 0.9 * length;
            let on_edge = (r - re).abs() < 1e-6;
            if on_rake || on_clear || on_edge {
                surface.push(i);
            } else {
                fixed[i] = true;
            }
        }
        ToolHeat { mat, temp: vec![t0; n], cap, surface, fixed, elem, pending: vec![0.0; n], h_contact: 1e5, t0, mesh }
    }

    /// the surface node nearest to a point given in the tool frame
    pub fn nearest_surface(&self, p: [f64; 2]) -> usize {
        let mut best = (self.surface[0], f64::MAX);
        for &i in &self.surface {
            let q = self.mesh.x[i];
            let d = (q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2);
            if d < best.1 {
                best = (i, d);
            }
        }
        best.0
    }

    pub fn capacity(&self, i: usize) -> f64 {
        self.cap[i]
    }

    pub fn add_heat(&mut self, i: usize, q: f64) {
        self.pending[i] += q;
    }

    /// one explicit conduction step of dt [s] with the heat added since the last one
    pub fn step(&mut self, dt: f64) {
        let mut flow = std::mem::take(&mut self.pending);
        for (e, t) in self.mesh.tri.iter().enumerate() {
            let (ak, g) = self.elem[e];
            let (mut gx, mut gy) = (0.0, 0.0);
            for k in 0..3 {
                gx += self.temp[t[k]] * g[k][0];
                gy += self.temp[t[k]] * g[k][1];
            }
            for k in 0..3 {
                flow[t[k]] -= dt * ak * (g[k][0] * gx + g[k][1] * gy);
            }
        }
        for i in 0..self.temp.len() {
            self.temp[i] = if self.fixed[i] { self.t0 } else { self.temp[i] + flow[i] / self.cap[i] };
        }
        flow.iter_mut().for_each(|v| *v = 0.0);
        self.pending = flow;
    }

    /// the explicit step this mesh allows: ρc·a²/(4k) over its elements
    pub fn stable_dt(&self) -> f64 {
        let rc = self.mat.rho * self.mat.cp;
        self.mesh
            .tri
            .iter()
            .map(|t| crate::mesh::min_altitude(self.mesh.x[t[0]], self.mesh.x[t[1]], self.mesh.x[t[2]]))
            .map(|a| 0.25 * rc * a * a / self.mat.k)
            .fold(f64::INFINITY, f64::min)
    }

    /// Steady temperature with the given surface temperatures (Dirichlet; NaN: insulated) and
    /// the far end held: Gauss–Seidel on the conduction equations until the largest change is
    /// below 0.01 K.
    pub fn solve_steady(&mut self, surface_temp: &[(usize, f64)]) {
        let n = self.temp.len();
        // node–node conductances (assembled once)
        let mut diag = vec![0.0; n];
        let mut off: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
        for (e, t) in self.mesh.tri.iter().enumerate() {
            let (ak, g) = self.elem[e];
            for a in 0..3 {
                for b in 0..3 {
                    let k = ak * (g[a][0] * g[b][0] + g[a][1] * g[b][1]);
                    if a == b {
                        diag[t[a]] += k;
                    } else {
                        off[t[a]].push((t[b], k));
                    }
                }
            }
        }
        let mut held = self.fixed.clone();
        for &(i, t) in surface_temp {
            if t.is_finite() {
                self.temp[i] = t;
                held[i] = true;
            }
        }
        for i in 0..n {
            if self.fixed[i] {
                self.temp[i] = self.t0;
            }
        }
        for _ in 0..200_000 {
            let mut change: f64 = 0.0;
            for i in 0..n {
                if held[i] || diag[i] <= 0.0 {
                    continue;
                }
                let s: f64 = off[i].iter().map(|&(j, k)| k * self.temp[j]).sum();
                let t = -s / diag[i];
                // over-relaxation speeds the long, thin conduction paths
                let t = self.temp[i] + 1.8 * (t - self.temp[i]);
                change = change.max((t - self.temp[i]).abs());
                self.temp[i] = t;
            }
            if change < 0.01 {
                break;
            }
        }
    }

    pub fn max_temp(&self) -> f64 {
        self.temp.iter().cloned().fold(f64::MIN, f64::max)
    }
}
