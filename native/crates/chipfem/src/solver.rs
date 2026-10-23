//! Explicit dynamic plane-strain FEM, updated Lagrangian, linear triangles.
//!
//! - Kinematics: per element the velocity gradient L, rate of deformation D = sym L and spin
//!   W = skew L (thickness 1 mm, ε_zz = 0).
//! - Deviatoric stress: hypoelastic with the Jaumann rate, J2 plasticity with the Johnson–Cook
//!   flow stress by radial return; the plastic strain increment solves
//!   q_trial − 3GΔε_p = σ_y(ε_p + Δε_p, Δε_p/Δt, T) (bracketed Newton).
//! - Pressure: average nodal pressure (Bonet & Burton 1998): the volumetric strain is averaged to
//!   the nodes and back, which keeps linear triangles from locking under the nearly
//!   incompressible plastic flow; p = −K·ε_v,avg, plus a bulk viscosity against ringing.
//! - Heat: the Taylor–Quinney share β of the plastic work and the friction heat go to the nodes,
//!   which conduct (explicit, element gradients); the flow stress sees the element's mean
//!   nodal temperature.
//! - Time: central differences with lumped masses; mass scaling (a factor on all masses) lengthens
//!   the stable step for cutting, where inertia is small next to the forces (the thermal problem
//!   uses the physical mass).
//! - Tool: rigid (tool.rs), kinematic contact: a node found inside after the step is put back on
//!   the surface, its relative normal velocity removed, and Coulomb friction limits its
//!   tangential impulse by μ times the normal one.

use crate::material::Material;
use crate::mesh::{min_altitude, tri_geom, Mesh};
use crate::tool::Tool;
use crate::toolheat::ToolHeat;
use rayon::prelude::*;

/// prescribed velocity of one degree of freedom
#[derive(Clone, Copy, Debug)]
pub struct Bc {
    pub node: usize,
    pub dof: usize,
    pub vel: f64,
}

#[derive(Clone, Copy, Default)]
struct ElemWork {
    area: f64,
    /// internal force on the element's three nodes
    f: [[f64; 2]; 3],
    /// heat into each node this step [mJ]
    q: [f64; 3],
    tr_d: f64,
}

pub struct Solver {
    pub mat: Material,
    pub mesh: Mesh,
    pub v: Vec<[f64; 2]>,
    /// nodal temperature [°C]
    pub temp: Vec<f64>,
    /// element state: deviatoric stress (xx, yy, zz, xy), volumetric log strain, plastic strain
    /// and its rate, full stress (xx, yy, zz, xy) for output
    pub s: Vec<[f64; 4]>,
    pub ev: Vec<f64>,
    pub ep: Vec<f64>,
    pub epdot: Vec<f64>,
    pub sigma: Vec<[f64; 4]>,
    pub bcs: Vec<Bc>,
    pub tool: Option<Tool>,
    /// heat conduction in the tool (None: the tool is adiabatic and its share of the friction
    /// heat is lost)
    pub tool_heat: Option<ToolHeat>,
    pub mass_scale: f64,
    pub cfl: f64,
    pub dt: f64,
    pub t: f64,
    pub steps: u64,
    /// bulk viscosity: linear and quadratic coefficients
    pub q1: f64,
    pub q2: f64,
    pub thermal: bool,
    /// outputs: internal force per node, force on the tool [N per mm width], energies [mJ]
    pub fint: Vec<[f64; 2]>,
    pub tool_force: [f64; 2],
    pub plastic_work: f64,
    /// stable explicit step of the tool's heat conduction
    pub tool_dt: f64,
    /// stop at the first non-finite value (CHIPFEM_DEBUG)
    pub debug_nan: bool,
    pub friction_work: f64,
    /// contact stresses along the tool surface, summed over time (None: not recorded)
    pub profile: Option<ContactProfile>,
    mass: Vec<f64>,
    mass_phys: Vec<f64>,
    adj: (Vec<usize>, Vec<usize>),
    work: Vec<ElemWork>,
    /// the two boundary neighbours of each boundary node (usize::MAX inside)
    bnb: Vec<[usize; 2]>,
}

/// Contact along the tool surface, summed over the steps in bins of the coordinate s along the
/// rake face (s = 0 where the rake face meets the edge radius, negative on the edge): normal and
/// friction force (on the tool, along t = (n_y, −n_x): up the rake face, + where the chip drags
/// the tool along its flow), the friction limit m·k·length, contact length, sticking, temperature
/// (each times dt; divide by the summed time).
#[derive(Clone, Debug)]
pub struct ContactProfile {
    pub s0: f64,
    pub ds: f64,
    /// per bin: [time, F_n, F_t, m·k·ℓ, ℓ, sticking time, T·time]
    pub bins: Vec<[f64; 7]>,
}

impl ContactProfile {
    pub fn new(s0: f64, s1: f64, ds: f64) -> ContactProfile {
        ContactProfile { s0, ds, bins: vec![[0.0; 7]; ((s1 - s0) / ds).ceil() as usize] }
    }
}

/// radial return: new deviatoric stress, plastic strain increment, flow stress
#[inline]
fn update_stress(mat: &Material, g: f64, s: [f64; 4], d: [f64; 3], w: f64, dt: f64, ep: f64, t: f64) -> ([f64; 4], f64, f64) {
    let [dxx, dyy, dxy] = d;
    let tr = dxx + dyy;
    let dev = [dxx - tr / 3.0, dyy - tr / 3.0, -tr / 3.0, dxy];
    let rot = [2.0 * w * s[3], -2.0 * w * s[3], 0.0, w * (s[1] - s[0])];
    let mut st = [0.0; 4];
    for k in 0..4 {
        st[k] = s[k] + dt * (rot[k] + 2.0 * g * dev[k]);
    }
    let q = (1.5 * (st[0] * st[0] + st[1] * st[1] + st[2] * st[2] + 2.0 * st[3] * st[3])).sqrt();
    let jc = &mat.jc;
    let sy0 = jc.flow(ep, 0.0, t);
    if q <= sy0 {
        return (st, 0.0, sy0);
    }
    // g(Δ) = q − 3GΔ − σ_y(ε_p + Δ, Δ/dt, T): positive at 0, negative at q/3G
    let f = |x: f64| q - 3.0 * g * x - jc.flow(ep + x, x / dt, t);
    let (mut lo, mut hi) = (0.0, q / (3.0 * g));
    let mut x = (q - sy0) / (3.0 * g);
    for _ in 0..40 {
        let fx = f(x);
        if fx > 0.0 { lo = x } else { hi = x }
        if (hi - lo) <= 1e-12 * hi.max(1e-30) {
            break;
        }
        let h = 1e-7 * x.max(1e-12);
        let dfx = (f(x + h) - fx) / h;
        let xn = x - fx / dfx;
        x = if dfx < 0.0 && xn > lo && xn < hi { xn } else { 0.5 * (lo + hi) };
    }
    let sy = jc.flow(ep + x, x / dt, t);
    let k = 1.0 - 3.0 * g * x / q;
    ([st[0] * k, st[1] * k, st[2] * k, st[3] * k], x, sy)
}

impl Solver {
    pub fn new(mat: Material, mesh: Mesh, t0: f64) -> Solver {
        let n = mesh.x.len();
        let ne = mesh.tri.len();
        let mut s = Solver {
            mat,
            v: vec![[0.0; 2]; n],
            temp: vec![t0; n],
            s: vec![[0.0; 4]; ne],
            ev: vec![0.0; ne],
            ep: vec![0.0; ne],
            epdot: vec![0.0; ne],
            sigma: vec![[0.0; 4]; ne],
            bcs: Vec::new(),
            tool: None,
            tool_heat: None,
            tool_dt: f64::INFINITY,
            debug_nan: std::env::var("CHIPFEM_DEBUG").is_ok(),
            mass_scale: 1.0,
            cfl: 0.5,
            dt: 0.0,
            t: 0.0,
            steps: 0,
            q1: 0.06,
            q2: 1.2,
            thermal: true,
            fint: vec![[0.0; 2]; n],
            tool_force: [0.0; 2],
            plastic_work: 0.0,
            friction_work: 0.0,
            profile: None,
            mass: Vec::new(),
            mass_phys: Vec::new(),
            adj: (Vec::new(), Vec::new()),
            work: vec![ElemWork::default(); ne],
            bnb: Vec::new(),
            mesh,
        };
        s.rebuild();
        s
    }

    /// masses, adjacency and time step from the present mesh (after creation or a remesh)
    pub fn rebuild(&mut self) {
        let n = self.mesh.x.len();
        let mut m = vec![0.0; n];
        for (e, t) in self.mesh.tri.iter().enumerate() {
            let a = self.mesh.area(e);
            assert!(a > 0.0, "element {e} is inverted or degenerate");
            for &i in t {
                m[i] += self.mat.rho * a / 3.0;
            }
        }
        self.mass_phys = m.clone();
        self.mass = m.iter().map(|v| v * self.mass_scale).collect();
        self.adj = self.mesh.node_elements();
        self.work = vec![ElemWork::default(); self.mesh.tri.len()];
        self.fint = vec![[0.0; 2]; n];
        let mut bnb = vec![[usize::MAX; 2]; n];
        for [a, b] in self.mesh.boundary_edges() {
            bnb[a][1] = b;
            bnb[b][0] = a;
        }
        self.bnb = bnb;
        self.dt = self.stable_dt();
    }

    pub fn set_mass_scale(&mut self, f: f64) {
        self.mass_scale = f;
        self.rebuild();
    }

    /// dilatational wave speed in the (mass-scaled) material
    pub fn wave_speed(&self) -> f64 {
        let (k, g) = (self.mat.bulk_modulus(), self.mat.shear_modulus());
        ((k + 4.0 / 3.0 * g) / (self.mat.rho * self.mass_scale)).sqrt()
    }

    pub fn stable_dt(&self) -> f64 {
        let c = self.wave_speed();
        let x = &self.mesh.x;
        let h = self.mesh.tri.par_iter().map(|t| min_altitude(x[t[0]], x[t[1]], x[t[2]])).reduce(|| f64::INFINITY, f64::min);
        self.cfl * h / c
    }

    /// one explicit step
    pub fn step(&mut self) {
        let dt = self.dt;
        let mat = &self.mat;
        let (g, kb) = (mat.shear_modulus(), mat.bulk_modulus());
        let rho_s = mat.rho * self.mass_scale;
        let c = self.wave_speed();
        let x = &self.mesh.x;
        let v = &self.v;
        let temp = &self.temp;
        let tri = &self.mesh.tri;
        let beta = mat.beta;
        let kth = if self.thermal { mat.k } else { 0.0 };
        let rho_cp = mat.rho * mat.cp;

        // 1. deviatoric stress, plastic strain and heat per element
        let pw: f64 = self
            .work
            .par_iter_mut()
            .zip(self.s.par_iter_mut())
            .zip(self.ev.par_iter_mut())
            .zip(self.ep.par_iter_mut())
            .zip(self.epdot.par_iter_mut())
            .enumerate()
            .map(|(e, ((((w, s), ev), ep), epd))| {
                let [a, b, cc] = tri[e];
                let (area, gr) = tri_geom(x[a], x[b], x[cc]);
                let nodes = [a, b, cc];
                let (mut lxx, mut lxy, mut lyx, mut lyy) = (0.0, 0.0, 0.0, 0.0);
                let (mut gtx, mut gty, mut te) = (0.0, 0.0, 0.0);
                for k in 0..3 {
                    let vi = v[nodes[k]];
                    lxx += vi[0] * gr[k][0];
                    lxy += vi[0] * gr[k][1];
                    lyx += vi[1] * gr[k][0];
                    lyy += vi[1] * gr[k][1];
                    let ti = temp[nodes[k]];
                    gtx += ti * gr[k][0];
                    gty += ti * gr[k][1];
                    te += ti / 3.0;
                }
                let d = [lxx, lyy, 0.5 * (lxy + lyx)];
                let spin = 0.5 * (lxy - lyx);
                let (sn, dep, sy) = update_stress(mat, g, *s, d, spin, dt, *ep, te);
                *s = sn;
                *ep += dep;
                *epd = dep / dt;
                let tr = lxx + lyy;
                *ev += tr * dt;
                let plastic = sy * dep * area;
                // explicit conduction is stable while dt ≤ ρc·a²/(4k) (a: shortest altitude); an
                // element squashed thin between remeshes would break that long before the
                // mechanical step does, so its conductivity is capped there (a few elements, for a
                // few steps, instead of a temperature blow-up)
                let alt = 2.0 * area / [(x[b][0] - x[a][0]).hypot(x[b][1] - x[a][1]), (x[cc][0] - x[b][0]).hypot(x[cc][1] - x[b][1]), (x[a][0] - x[cc][0]).hypot(x[a][1] - x[cc][1])].iter().cloned().fold(0.0, f64::max);
                let kth_e = if kth > 0.0 { kth.min(0.25 * rho_cp * alt * alt / dt) } else { 0.0 };
                // heat: plastic work share, conduction −A·k·∇N_i·∇T
                for k in 0..3 {
                    w.q[k] = beta * plastic / 3.0 - dt * area * kth_e * (gr[k][0] * gtx + gr[k][1] * gty);
                }
                w.area = area;
                w.tr_d = tr;
                // forces are completed after the pressure (step 2); keep the gradients' work here
                w.f = gr;
                plastic
            })
            .sum();
        self.plastic_work += pw;

        // 2. average nodal volumetric strain → element pressure → nodal internal forces
        let (off, ids) = (&self.adj.0, &self.adj.1);
        let work = &self.work;
        let ev = &self.ev;
        let ev_node: Vec<f64> = (0..x.len())
            .into_par_iter()
            .map(|i| {
                let (mut s, mut a) = (0.0, 0.0);
                for &e in &ids[off[i]..off[i + 1]] {
                    s += work[e].area * ev[e];
                    a += work[e].area;
                }
                if a > 0.0 { s / a } else { 0.0 }
            })
            .collect();
        let (q1, q2) = (self.q1, self.q2);
        self.work.par_iter_mut().zip(self.sigma.par_iter_mut()).zip(self.s.par_iter()).enumerate().for_each(|(e, ((w, sig), s))| {
            let t = tri[e];
            let evb = (ev_node[t[0]] + ev_node[t[1]] + ev_node[t[2]]) / 3.0;
            let l = w.area.sqrt();
            // bulk viscosity (linear always, quadratic in compression)
            let mut qv = -q1 * rho_s * c * l * w.tr_d;
            if w.tr_d < 0.0 {
                qv += q2 * q2 * rho_s * l * l * w.tr_d * w.tr_d;
            }
            let p = -kb * evb + qv;
            *sig = [s[0] - p, s[1] - p, s[2] - p, s[3]];
            let gr = w.f;
            for k in 0..3 {
                w.f[k] = [w.area * (sig[0] * gr[k][0] + sig[3] * gr[k][1]), w.area * (sig[3] * gr[k][0] + sig[1] * gr[k][1])];
            }
        });
        let work = &self.work;
        let fint: Vec<([f64; 2], f64)> = (0..x.len())
            .into_par_iter()
            .map(|i| {
                let (mut f, mut q) = ([0.0; 2], 0.0);
                for &e in &ids[off[i]..off[i + 1]] {
                    let k = tri[e].iter().position(|&n| n == i).unwrap();
                    f[0] += work[e].f[k][0];
                    f[1] += work[e].f[k][1];
                    q += work[e].q[k];
                }
                (f, q)
            })
            .collect();

        // 3. velocities, prescribed velocities, positions
        let n = x.len();
        for i in 0..n {
            let (f, _) = fint[i];
            self.fint[i] = f;
            self.v[i][0] -= dt * f[0] / self.mass[i];
            self.v[i][1] -= dt * f[1] / self.mass[i];
        }
        for b in &self.bcs {
            self.v[b.node][b.dof] = b.vel;
        }
        // 4. the tool moves; nodes that would end inside it are put back on its surface
        self.tool_force = [0.0; 2];
        let mut heat_fric = vec![0.0; 0];
        if let Some(tool) = self.tool.as_mut() {
            tool.advance(dt);
            heat_fric = vec![0.0; n];
            for i in 0..n {
                let p = [self.mesh.x[i][0] + dt * self.v[i][0], self.mesh.x[i][1] + dt * self.v[i][1]];
                // only the work's surface touches the tool (an inside node caught by an edge that
                // slipped between two surface nodes would be pushed through its neighbours)
                if self.bnb[i][0] == usize::MAX {
                    continue;
                }
                let Some(ct) = tool.contact(p) else { continue };
                let nn = ct.n;
                let m = self.mass[i];
                // relative velocity after the correction must not approach the surface
                let vr = [self.v[i][0] - tool.v[0], self.v[i][1] - tool.v[1]];
                let vn = vr[0] * nn[0] + vr[1] * nn[1];
                // normal velocity change that puts the node back on the surface by the step's end
                let dvn = ct.depth / dt;
                let imp_n = m * dvn;
                let vt = [vr[0] - vn * nn[0], vr[1] - vn * nn[1]];
                // the node's share of the contact length
                let len = {
                    let nb = self.bnb[i];
                    let xs = &self.mesh.x;
                    let half = |j: usize| if j == usize::MAX { 0.0 } else { 0.5 * (xs[j][0] - xs[i][0]).hypot(xs[j][1] - xs[i][1]) };
                    half(nb[0]) + half(nb[1])
                };
                // the tool surface node it touches (for the heat exchange)
                let tj = self.tool_heat.as_ref().filter(|_| self.thermal).map(|th| th.nearest_surface([p[0] - tool.c[0], p[1] - tool.c[1]]));
                let vts = vt[0].hypot(vt[1]);
                let mut dvt = [0.0; 2];
                let mut shear_lim = f64::NAN;
                let mut stuck = false;
                if vts > 1e-12 {
                    let mut lim = tool.mu * imp_n / m;
                    if let Some(mf) = tool.shear_factor {
                        // τ ≤ m·k over the node's share of the boundary, k = σ̄/√3 of its elements
                        let (off, ids) = (&self.adj.0, &self.adj.1);
                        let els = &ids[off[i]..off[i + 1]];
                        let q: f64 = els.iter().map(|&e| { let d = self.s[e]; (1.5 * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + 2.0 * d[3] * d[3])).sqrt() }).sum::<f64>() / els.len().max(1) as f64;
                        shear_lim = mf * q / 3f64.sqrt() * len;
                        lim = lim.min(shear_lim * dt / m);
                    }
                    let k = if vts <= lim { 1.0 } else { lim / vts };
                    stuck = k >= 1.0;
                    dvt = [-k * vt[0], -k * vt[1]];
                    // friction work: friction force × the slip that is left after it (a sticking
                    // node, k = 1, does not slip and makes no friction heat: its shearing is the
                    // plastic work of the layer next to the tool; counting the tangential velocity
                    // the step built up as slip would turn numerical impacts into heat)
                    let ft = m * k * vts;
                    let slip = vts * (1.0 - k);
                    let wf = ft * slip;
                    self.friction_work += wf;
                    heat_fric[i] = tool.heat_share * wf;
                    if let (Some(j), Some(th)) = (tj, self.tool_heat.as_mut()) {
                        th.add_heat(j, (1.0 - tool.heat_share) * wf);
                    }
                }
                // conduction across the interface, limited so that one step cannot overshoot
                if let (Some(j), Some(th)) = (tj, self.tool_heat.as_mut()) {
                    let cw = self.mass_phys[i] * self.mat.cp;
                    let ct = th.capacity(j);
                    let g = (th.h_contact * len * dt).min(0.5 * cw * ct / (cw + ct));
                    let q = g * (self.temp[i] - th.temp[j]);
                    heat_fric[i] -= q;
                    th.add_heat(j, q);
                }
                if let Some(pr) = self.profile.as_mut() {
                    let (tr, _, _, _) = tool.faces();
                    let sq = (p[0] - tool.c[0]) * tr[0] + (p[1] - tool.c[1]) * tr[1];
                    let b = ((sq - pr.s0) / pr.ds).floor();
                    if b >= 0.0 && (b as usize) < pr.bins.len() {
                        let e = &mut pr.bins[b as usize];
                        // friction force on the tool along t = (n_y, −n_x) (up the rake face)
                        let ftan = -m * (dvt[0] * nn[1] - dvt[1] * nn[0]) / dt;
                        let t = self.temp[i];
                        for (k, v) in [dt, imp_n / dt, ftan, if shear_lim.is_finite() { shear_lim } else { 0.0 }, len, if stuck { 1.0 } else { 0.0 }, t].iter().enumerate() {
                            e[k] += if k == 0 { *v } else { v * dt };
                        }
                    }
                }
                let dv = [dvn * nn[0] + dvt[0], dvn * nn[1] + dvt[1]];
                self.v[i][0] += dv[0];
                self.v[i][1] += dv[1];
                // force on the tool: the reaction to the impulse given to the node
                self.tool_force[0] -= m * dv[0] / dt;
                self.tool_force[1] -= m * dv[1] / dt;
            }
        }
        for i in 0..n {
            self.mesh.x[i][0] += dt * self.v[i][0];
            self.mesh.x[i][1] += dt * self.v[i][1];
        }
        // 5. temperatures
        if self.thermal {
            let cp = self.mat.cp;
            for i in 0..n {
                let qf = if heat_fric.is_empty() { 0.0 } else { heat_fric[i] };
                self.temp[i] += (fint[i].1 + qf) / (self.mass_phys[i] * cp);
            }
            if let Some(th) = self.tool_heat.as_mut() {
                // sub-steps when the tool mesh needs a shorter explicit step than the mechanics
                assert!(dt.is_finite() && dt > 0.0, "time step {dt} (the mesh has no usable element)");
                let sub = ((dt / self.tool_dt).ceil().max(1.0) as usize).min(1000);
                th.step(dt / sub as f64);
                for _ in 1..sub {
                    th.step(dt / sub as f64);
                }
            }
        }
        if self.debug_nan {
            // the first non-finite value and where it is
            let bad_t = self.temp.iter().position(|t| !t.is_finite());
            let bad_v = self.v.iter().position(|v| !(v[0].is_finite() && v[1].is_finite()));
            let bad_s = self.s.iter().position(|s| !s.iter().all(|x| x.is_finite()));
            let bad_tool = self.tool_heat.as_ref().and_then(|th| th.temp.iter().position(|t| !t.is_finite()));
            if let Some(i) = bad_v {
                let (off, ids) = (&self.adj.0, &self.adj.1);
                let areas: Vec<f64> = ids[off[i]..off[i + 1]].iter().map(|&e| self.mesh.area(e)).collect();
                let tc = self.tool.as_ref().map(|t| t.c).unwrap_or([0.0; 2]);
                let inside = self.tool.as_ref().map(|t| t.contact(self.mesh.x[i]).map(|c| (c.depth, c.n)));
                eprintln!("node {i}: x {:?} (from the edge centre {:+.5} {:+.5}), mass {:e}, fint {:?}, element areas {:?}, boundary neighbours {:?}, contact {:?}",
                    self.mesh.x[i], self.mesh.x[i][0] - tc[0], self.mesh.x[i][1] - tc[1], self.mass[i], self.fint[i], areas, self.bnb[i], inside.map(|o| o.map(|(d, n)| (d, n))));
            }
            if bad_t.is_some() || bad_v.is_some() || bad_s.is_some() || bad_tool.is_some() {
                panic!("non-finite at step {}: temperature node {:?}, velocity node {:?}, stress element {:?}, tool node {:?}", self.steps, bad_t, bad_v, bad_s, bad_tool);
            }
        }
        self.t += dt;
        self.steps += 1;
        if self.steps % 50 == 0 {
            self.dt = self.stable_dt();
        }
    }

    /// Worst element quality, 4√3·A / Σl² (1 for an equilateral triangle, 0 when flat); negative
    /// if an element turned inside out.
    pub fn min_quality(&self) -> f64 {
        let x = &self.mesh.x;
        self.mesh
            .tri
            .par_iter()
            .map(|t| {
                let (a, b, c) = (x[t[0]], x[t[1]], x[t[2]]);
                let (area, _) = tri_geom(a, b, c);
                let l2 = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (c[0] - b[0]).powi(2) + (c[1] - b[1]).powi(2) + (a[0] - c[0]).powi(2) + (a[1] - c[1]).powi(2);
                4.0 * 3f64.sqrt() * area / l2
            })
            .reduce(|| f64::INFINITY, f64::min)
    }

    /// Carry the state over to a new mesh of the same body (remesh.rs): nodal velocity and
    /// temperature interpolated, element state from the old element at the new centroid. Nodes
    /// that land inside the tool are moved onto its surface.
    /// Returns false (and changes nothing) when moving the nodes out of the tool would turn an
    /// element inside out.
    pub fn transfer_to(&mut self, mut new: Mesh) -> bool {
        use crate::remesh::Locator;
        if let Some(tool) = &self.tool {
            for p in new.x.iter_mut() {
                if let Some(ct) = tool.contact(*p) {
                    p[0] += ct.depth * ct.n[0];
                    p[1] += ct.depth * ct.n[1];
                }
            }
        }
        if (0..new.tri.len()).any(|e| !(new.area(e) > 1e-14)) {
            return false;
        }
        let loc = Locator::new(&self.mesh);
        let old_tri = &self.mesh.tri;
        let (v, temp): (Vec<[f64; 2]>, Vec<f64>) = new
            .x
            .par_iter()
            .map(|&p| {
                let (e, l) = loc.locate(p);
                let t = old_tri[e];
                let mut vv = [0.0; 2];
                let mut tt = 0.0;
                for k in 0..3 {
                    vv[0] += l[k] * self.v[t[k]][0];
                    vv[1] += l[k] * self.v[t[k]][1];
                    tt += l[k] * self.temp[t[k]];
                }
                (vv, tt)
            })
            .unzip();
        let src: Vec<usize> = new
            .tri
            .par_iter()
            .map(|t| {
                let c = [(new.x[t[0]][0] + new.x[t[1]][0] + new.x[t[2]][0]) / 3.0, (new.x[t[0]][1] + new.x[t[1]][1] + new.x[t[2]][1]) / 3.0];
                loc.locate(c).0
            })
            .collect();
        self.s = src.iter().map(|&e| self.s[e]).collect();
        self.ev = src.iter().map(|&e| self.ev[e]).collect();
        self.ep = src.iter().map(|&e| self.ep[e]).collect();
        self.epdot = src.iter().map(|&e| self.epdot[e]).collect();
        self.sigma = src.iter().map(|&e| self.sigma[e]).collect();
        drop(loc);
        self.v = v;
        self.temp = temp;
        self.mesh = new;
        self.rebuild();
        true
    }

    /// heat stored in the nodes above the initial temperature t0 [mJ]
    pub fn heat_content(&self, t0: f64) -> f64 {
        self.temp.iter().zip(&self.mass_phys).map(|(t, m)| (t - t0) * m * self.mat.cp).sum()
    }
}
