//! The warmed-up tool's temperature (steady conduction from the contact): bounded by the contact
//! temperatures, hottest at the contact, room temperature at the held end.
use chipfem::cutting::{CutParams, Cutting};
use chipfem::Material;

#[test]
fn warmed_up_tool_lies_between_the_contact_and_the_held_end() {
    let mut p = CutParams::new(200.0, 0.1, 5.0);
    p.mu = 0.6;
    p.length = 0.5;
    let mut c = Cutting::new(Material::preset("S50C").unwrap(), p);
    c.run(0.05, |_, _| true);
    let th = c.tool_steady(2.0);
    let t_work = c.solver.temp.iter().cloned().fold(f64::MIN, f64::max);
    let t_tool = th.max_temp();
    let t_min = th.temp.iter().cloned().fold(f64::MAX, f64::min);
    println!("tool: {} nodes, highest {:.0} °C, lowest {:.0} °C; work highest {:.0} °C", th.mesh.x.len(), t_tool, t_min, t_work);
    assert!(t_tool > 200.0 && t_tool <= t_work + 1e-6, "tool {t_tool} °C, work {t_work} °C");
    assert!((t_min - 20.0).abs() < 1e-6, "the held end is at room temperature");
    // the hottest point of the tool is on its surface near the edge (within 0.5 mm)
    let (i, _) = th.temp.iter().enumerate().fold((0, f64::MIN), |b, (i, &t)| if t > b.1 { (i, t) } else { b });
    assert!(th.surface.contains(&i));
    let x = th.mesh.x[i];
    assert!(x[0].hypot(x[1]) < 0.5);
}
