//! Remeshing of the work: when the Lagrangian mesh is too distorted (or the fine region has to
//! follow the tool), the body is meshed anew and the state carried over.
//!
//! 1. The boundary loop of the present mesh is resampled with the target element size h(p)
//!    (small at the cutting edge, growing away from it); corners are kept.
//! 2. Seed points fill the inside on a quadtree graded by h(p).
//! 3. Constrained Delaunay triangulation of the seeds with the boundary as constraint edges, then
//!    Delaunay refinement to a minimum angle (spade), outer faces dropped.
//! 4. Nodal velocity and temperature are interpolated (barycentric) from the old element that
//!    contains each new node; the element state (stress, volumetric strain, plastic strain and its
//!    rate) is taken from the old element that contains the new element's centroid.

use crate::mesh::{tri_geom, Mesh};
use spade::{AngleLimit, ConstrainedDelaunayTriangulation, Point2, RefinementParameters, Triangulation};

/// The boundary as one closed loop of node ids (counter-clockwise: the body on the left).
pub fn boundary_loop(mesh: &Mesh) -> Vec<usize> {
    use std::collections::HashMap;
    let edges = mesh.boundary_edges();
    let next: HashMap<usize, usize> = edges.iter().map(|e| (e[0], e[1])).collect();
    // the longest loop (a well-formed body has exactly one)
    let mut seen = std::collections::HashSet::new();
    let mut best: Vec<usize> = Vec::new();
    for e in &edges {
        if seen.contains(&e[0]) {
            continue;
        }
        let mut lp = vec![e[0]];
        seen.insert(e[0]);
        let mut a = e[1];
        while a != e[0] {
            if !seen.insert(a) {
                break;
            }
            lp.push(a);
            match next.get(&a) {
                Some(&b) => a = b,
                None => break,
            }
        }
        if lp.len() > best.len() {
            best = lp;
        }
    }
    best
}

/// point in polygon (even–odd)
fn inside(poly: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut c = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
        j = i;
    }
    c
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let l2 = d[0] * d[0] + d[1] * d[1];
    let t = if l2 > 0.0 { (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - a[0] - t * d[0]).hypot(p[1] - a[1] - t * d[1])
}

/// Resample a closed polygon with spacing h(p), keeping corners (turning angle above `corner`)
/// and the points `keep` says must stay.
pub fn resample(poly: &[[f64; 2]], h: &dyn Fn([f64; 2]) -> f64, corner: f64, keep: &dyn Fn([f64; 2]) -> bool) -> Vec<[f64; 2]> {
    let n = poly.len();
    let is_feature = |i: usize| {
        let (a, b, c) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
        let u = [b[0] - a[0], b[1] - a[1]];
        let v = [c[0] - b[0], c[1] - b[1]];
        let ang = (u[0] * v[1] - u[1] * v[0]).atan2(u[0] * v[0] + u[1] * v[1]).abs();
        ang > corner || keep(b)
    };
    let feats: Vec<usize> = (0..n).filter(|&i| is_feature(i)).collect();
    let feats = if feats.is_empty() { vec![0] } else { feats };
    let mut out = Vec::new();
    for k in 0..feats.len() {
        let (i0, i1) = (feats[k], feats[(k + 1) % feats.len()]);
        // the chain i0 → i1 (wrapping)
        let mut chain = vec![poly[i0]];
        let mut i = (i0 + 1) % n;
        loop {
            chain.push(poly[i]);
            if i == i1 {
                break;
            }
            i = (i + 1) % n;
        }
        // ∫ ds / h along the chain, sampled finely
        let mut acc = vec![0.0];
        let mut pts = vec![chain[0]];
        for w in chain.windows(2) {
            let (a, b) = (w[0], w[1]);
            let len = (b[0] - a[0]).hypot(b[1] - a[1]);
            let sub = ((len / (0.25 * h(a).min(h(b)))).ceil() as usize).max(1);
            for s in 1..=sub {
                let t = s as f64 / sub as f64;
                let p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                let q = pts[pts.len() - 1];
                let ds = (p[0] - q[0]).hypot(p[1] - q[1]);
                let mid = [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0];
                acc.push(acc[acc.len() - 1] + ds / h(mid));
                pts.push(p);
            }
        }
        let total = acc[acc.len() - 1];
        let m = (total.round() as usize).max(1);
        out.push(chain[0]);
        let mut j = 0;
        for s in 1..m {
            let target = total * s as f64 / m as f64;
            while acc[j + 1] < target {
                j += 1;
            }
            let t = (target - acc[j]) / (acc[j + 1] - acc[j]);
            out.push([pts[j][0] + t * (pts[j + 1][0] - pts[j][0]), pts[j][1] + t * (pts[j + 1][1] - pts[j][1])]);
        }
    }
    out
}

/// A new mesh of the region bounded by `poly` (counter-clockwise), graded by h(p).
pub fn mesh_polygon(poly: &[[f64; 2]], h: &dyn Fn([f64; 2]) -> f64, h_max: f64) -> Mesh {
    // seeds on a graded quadtree, away from the boundary
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for p in poly {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let mut seeds = Vec::new();
    let mut stack = vec![(lo, (hi[0] - lo[0]).max(hi[1] - lo[1]))];
    let near_boundary = |p: [f64; 2], d: f64| {
        let n = poly.len();
        (0..n).any(|i| seg_dist(p, poly[i], poly[(i + 1) % n]) < d)
    };
    while let Some((o, size)) = stack.pop() {
        let c = [o[0] + size / 2.0, o[1] + size / 2.0];
        let hc = h(c);
        if size > hc * 1.2 {
            let s2 = size / 2.0;
            for (dx, dy) in [(0.0, 0.0), (s2, 0.0), (0.0, s2), (s2, s2)] {
                stack.push(([o[0] + dx, o[1] + dy], s2));
            }
            continue;
        }
        if c[0] <= hi[0] && c[1] <= hi[1] && inside(poly, c) && !near_boundary(c, 0.7 * hc) {
            seeds.push(c);
        }
    }
    let mut verts: Vec<Point2<f64>> = poly.iter().map(|p| Point2::new(p[0], p[1])).collect();
    let nb = verts.len();
    verts.extend(seeds.iter().map(|p| Point2::new(p[0], p[1])));
    let edges: Vec<[usize; 2]> = (0..nb).map(|i| [i, (i + 1) % nb]).collect();
    let mut cdt = ConstrainedDelaunayTriangulation::<Point2<f64>>::bulk_load_cdt(verts, edges).expect("boundary polygon crosses itself");
    let res = cdt.refine(
        RefinementParameters::<f64>::new()
            .exclude_outer_faces(true)
            .keep_constraint_edges()
            .with_angle_limit(AngleLimit::from_deg(24.0))
            .with_max_allowed_area(0.5 * h_max * h_max)
            .with_max_additional_vertices(200_000),
    );
    let excluded: std::collections::HashSet<_> = res.excluded_faces.iter().map(|f| f.index()).collect();
    let x: Vec<[f64; 2]> = cdt.vertices().map(|v| [v.position().x, v.position().y]).collect();
    let mut tri = Vec::new();
    for f in cdt.inner_faces() {
        if excluded.contains(&f.fix().index()) {
            continue;
        }
        let v = f.vertices().map(|v| v.fix().index());
        let (a, _) = tri_geom(x[v[0]], x[v[1]], x[v[2]]);
        if a.abs() < 1e-14 {
            continue;
        }
        tri.push(if a > 0.0 { v } else { [v[0], v[2], v[1]] });
    }
    // drop vertices no triangle uses (outside the body)
    let mut used = vec![usize::MAX; x.len()];
    let mut nx = Vec::new();
    for t in &tri {
        for &a in t {
            if used[a] == usize::MAX {
                used[a] = nx.len();
                nx.push(x[a]);
            }
        }
    }
    let tri = tri.iter().map(|t| [used[t[0]], used[t[1]], used[t[2]]]).collect();
    Mesh { x: nx, tri }
}

/// Point location in a triangle mesh on a uniform bucket grid.
pub struct Locator<'a> {
    mesh: &'a Mesh,
    lo: [f64; 2],
    cell: f64,
    nx: usize,
    ny: usize,
    buckets: Vec<Vec<usize>>,
}

impl<'a> Locator<'a> {
    pub fn new(mesh: &'a Mesh) -> Locator<'a> {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in &mesh.x {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        let area = (hi[0] - lo[0]) * (hi[1] - lo[1]);
        let cell = (area / mesh.tri.len().max(1) as f64).sqrt() * 2.0;
        let nx = ((hi[0] - lo[0]) / cell).ceil() as usize + 1;
        let ny = ((hi[1] - lo[1]) / cell).ceil() as usize + 1;
        let mut buckets = vec![Vec::new(); nx * ny];
        for (e, t) in mesh.tri.iter().enumerate() {
            let (mut a, mut b) = ([f64::MAX; 2], [f64::MIN; 2]);
            for &i in t {
                for k in 0..2 {
                    a[k] = a[k].min(mesh.x[i][k]);
                    b[k] = b[k].max(mesh.x[i][k]);
                }
            }
            let i0 = ((a[0] - lo[0]) / cell) as usize;
            let i1 = ((b[0] - lo[0]) / cell) as usize;
            let j0 = ((a[1] - lo[1]) / cell) as usize;
            let j1 = ((b[1] - lo[1]) / cell) as usize;
            for j in j0..=j1.min(ny - 1) {
                for i in i0..=i1.min(nx - 1) {
                    buckets[j * nx + i].push(e);
                }
            }
        }
        Locator { mesh, lo, cell, nx, ny, buckets }
    }

    /// barycentric coordinates of p in triangle e
    fn bary(&self, e: usize, p: [f64; 2]) -> [f64; 3] {
        let [a, b, c] = self.mesh.tri[e].map(|i| self.mesh.x[i]);
        let d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        let l1 = ((b[0] - p[0]) * (c[1] - p[1]) - (c[0] - p[0]) * (b[1] - p[1])) / d;
        let l2 = ((c[0] - p[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (c[1] - p[1])) / d;
        [l1, l2, 1.0 - l1 - l2]
    }

    /// the element containing p (or, outside the mesh, the nearest one) and the barycentric
    /// coordinates, clamped into it
    pub fn locate(&self, p: [f64; 2]) -> (usize, [f64; 3]) {
        let ci = (((p[0] - self.lo[0]) / self.cell).floor().max(0.0) as usize).min(self.nx - 1);
        let cj = (((p[1] - self.lo[1]) / self.cell).floor().max(0.0) as usize).min(self.ny - 1);
        let mut best = (usize::MAX, [0.0; 3], f64::MAX);
        for ring in 0..(self.nx.max(self.ny)) {
            let (i0, i1) = (ci.saturating_sub(ring), (ci + ring).min(self.nx - 1));
            let (j0, j1) = (cj.saturating_sub(ring), (cj + ring).min(self.ny - 1));
            for j in j0..=j1 {
                for i in i0..=i1 {
                    if ring > 0 && i != i0 && i != i1 && j != j0 && j != j1 {
                        continue;
                    }
                    for &e in &self.buckets[j * self.nx + i] {
                        let l = self.bary(e, p);
                        let out = (-l[0]).max(-l[1]).max(-l[2]);
                        if out <= 1e-12 {
                            return (e, l);
                        }
                        if out < best.2 {
                            best = (e, l, out);
                        }
                    }
                }
            }
            if best.0 != usize::MAX && ring >= 1 {
                break;
            }
        }
        let mut l = best.1.map(|v| v.max(0.0));
        let s: f64 = l.iter().sum();
        for v in &mut l {
            *v /= s;
        }
        (best.0, l)
    }
}
