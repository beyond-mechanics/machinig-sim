//! Triangle meshes: generation of a (graded) rectangle, geometry of a triangle, node → element
//! adjacency and the boundary.

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub x: Vec<[f64; 2]>,
    /// counter-clockwise node triples
    pub tri: Vec<[usize; 3]>,
}

/// Signed area and the gradients of the three linear shape functions of a triangle.
#[inline]
pub fn tri_geom(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> (f64, [[f64; 2]; 3]) {
    let area2 = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    let inv = 1.0 / area2;
    // ∇N_i = (y_j − y_k, x_k − x_j) / 2A over the cyclic triple (i, j, k)
    let g = [
        [(b[1] - c[1]) * inv, (c[0] - b[0]) * inv],
        [(c[1] - a[1]) * inv, (a[0] - c[0]) * inv],
        [(a[1] - b[1]) * inv, (b[0] - a[0]) * inv],
    ];
    (0.5 * area2, g)
}

/// Shortest altitude of a triangle (the length that limits the explicit time step).
#[inline]
pub fn min_altitude(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    let area2 = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs();
    let l = [(b[0] - a[0]).hypot(b[1] - a[1]), (c[0] - b[0]).hypot(c[1] - b[1]), (a[0] - c[0]).hypot(a[1] - c[1])];
    area2 / l[0].max(l[1]).max(l[2])
}

impl Mesh {
    /// Rectangle [x0, x0 + w] × [y0, y0 + h] with nx × ny cells, each cut into two triangles
    /// along alternating diagonals (no preferred direction). `ys`: optional grading of the rows,
    /// a function from 0…1 to 0…1.
    pub fn rect(x0: f64, y0: f64, w: f64, h: f64, nx: usize, ny: usize, ys: Option<&dyn Fn(f64) -> f64>) -> Mesh {
        let mut x = Vec::with_capacity((nx + 1) * (ny + 1));
        for j in 0..=ny {
            let t = j as f64 / ny as f64;
            let fy = ys.map_or(t, |f| f(t));
            for i in 0..=nx {
                x.push([x0 + w * i as f64 / nx as f64, y0 + h * fy]);
            }
        }
        let id = |i: usize, j: usize| j * (nx + 1) + i;
        let mut tri = Vec::with_capacity(2 * nx * ny);
        for j in 0..ny {
            for i in 0..nx {
                let (a, b, c, d) = (id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
                if (i + j) % 2 == 0 {
                    tri.push([a, b, c]);
                    tri.push([a, c, d]);
                } else {
                    tri.push([a, b, d]);
                    tri.push([b, c, d]);
                }
            }
        }
        Mesh { x, tri }
    }

    pub fn area(&self, e: usize) -> f64 {
        let [a, b, c] = self.tri[e];
        tri_geom(self.x[a], self.x[b], self.x[c]).0
    }

    /// node → elements (CSR: offsets, element ids)
    pub fn node_elements(&self) -> (Vec<usize>, Vec<usize>) {
        let n = self.x.len();
        let mut cnt = vec![0usize; n + 1];
        for t in &self.tri {
            for &a in t {
                cnt[a + 1] += 1;
            }
        }
        for i in 0..n {
            cnt[i + 1] += cnt[i];
        }
        let mut fill = cnt.clone();
        let mut ids = vec![0usize; cnt[n]];
        for (e, t) in self.tri.iter().enumerate() {
            for &a in t {
                ids[fill[a]] = e;
                fill[a] += 1;
            }
        }
        (cnt, ids)
    }

    /// boundary edges (in the counter-clockwise sense of their element)
    pub fn boundary_edges(&self) -> Vec<[usize; 2]> {
        use std::collections::HashMap;
        let mut seen: HashMap<(usize, usize), usize> = HashMap::with_capacity(self.tri.len() * 3);
        for t in &self.tri {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                *seen.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
        }
        let mut out = Vec::new();
        for t in &self.tri {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if seen[&(a.min(b), a.max(b))] == 1 {
                    out.push([a, b]);
                }
            }
        }
        out
    }
}
