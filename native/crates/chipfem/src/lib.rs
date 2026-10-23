//! chipfem — 2D plane-strain explicit FEM of orthogonal cutting for the machining simulator.
//! Milestone 1: the solver core (linear triangles with average nodal pressure, Johnson–Cook
//! plasticity, heat, rigid rounded-edge tool with friction). Chip formation with remeshing
//! follows in milestone 2.
pub mod material;
pub mod mesh;
pub mod solver;
pub mod remesh;
pub mod tool;
pub mod toolheat;
pub mod cutting;
pub mod coefs;

pub use material::{JohnsonCook, Material};
pub use mesh::Mesh;
pub use solver::{Bc, Solver};
pub use tool::Tool;
