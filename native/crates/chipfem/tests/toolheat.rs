//! The tool's thermal mesh: a usable explicit step, and conduction to the held far end.
use chipfem::cutting::{CutParams, Cutting};
use chipfem::Material;

#[test]
fn tool_mesh_allows_a_step_near_the_mechanical_one() {
    let c = Cutting::new(Material::preset("S50C").unwrap(), CutParams::new(200.0, 0.06, 5.0));
    let th = c.solver.tool_heat.as_ref().unwrap();
    println!("tool mesh: {} nodes, {} elements, {} surface nodes; thermal step {:.2e} s, mechanical {:.2e} s", th.mesh.x.len(), th.mesh.tri.len(), th.surface.len(), c.solver.tool_dt, c.solver.dt);
    assert!(c.solver.tool_dt > 0.2 * c.solver.dt);
}
