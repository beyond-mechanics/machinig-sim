// GPU prototype (wgpu: DirectX 12 on Windows, Vulkan, Metal): the two pair passes of a step
// (velocity gradient and momentum, about two thirds of the step time) in f32 compute shaders,
// timed and checked against the CPU passes on the same state. Not used by the app yet.

use crate::sim::Sim;
use std::time::Instant;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params { n: u32, per: f32, hk: f32, ad: f32, m: f32, alpha: f32, beta: f32, cs: f32, iwdx: f32, xs: f32, eta: f32, pad: f32 }

pub struct Report {
    pub adapter: String, pub backend: String, pub n: usize, pub entries: usize, pub held: usize,
    pub cpu_ms: f64, pub gpu_ms: f64, pub upload_ms: f64, pub download_ms: f64,
    // max |gpu − cpu| / max |cpu| over each group of outputs
    pub err_l: f64, pub err_m: f64, pub err_drho: f64, pub err_acc: f64, pub err_xsph: f64,
}

struct Gpu { device: wgpu::Device, queue: wgpu::Queue, info: wgpu::AdapterInfo }

fn open() -> Result<Gpu, String> {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default()
    })).map_err(|e| format!("GPU が見つかりません: {e}"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("sph"), required_limits: adapter.limits(), ..Default::default()
    })).map_err(|e| format!("GPU を開けません: {e}"))?;
    Ok(Gpu { device, queue, info })
}

fn f32s(v: impl Iterator<Item = f64>) -> Vec<f32> { v.map(|x| x as f32).collect() }

// Relative error of a group of outputs: stride s, components c0..c1.
fn rel(cpu: &[f64], gpu: &[f32], s: usize, c0: usize, c1: usize) -> f64 {
    let (mut d, mut a) = (0.0f64, 0.0f64);
    for p in 0..cpu.len() / s {
        for c in c0..c1 {
            let (x, y) = (cpu[s * p + c], gpu[s * p + c] as f64);
            if x.is_finite() { a = a.max(x.abs()); d = d.max((x - y).abs()); }
        }
    }
    if a > 0.0 { d / a } else { d }
}

pub fn bench(s: &mut Sim, iters: usize) -> Result<Report, String> {
    let g = open()?;
    let n = s.n;
    s.build_pairs();

    // CPU, the same passes as in a step.
    s.pass_lm();
    s.pass_momentum();
    let t = Instant::now();
    for _ in 0..iters { s.pass_lm(); s.pass_momentum(); }
    let cpu_ms = 1e3 * t.elapsed().as_secs_f64() / iters as f64;

    // Static data: the pair lists (rebuilt on the CPU at every neighbour search).
    let dev = &g.device;
    let st = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
    let buf = |label: &str, data: &[u8]| dev.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: data, usage: st });
    let nonempty = |v: Vec<u32>| if v.is_empty() { vec![0u32; 2] } else { v };
    let mp: Vec<u32> = nonempty(s.movp.ea.iter().zip(&s.movp.eb).flat_map(|(&a, &b)| [a, b]).collect());
    let hij: Vec<u32> = nonempty(s.fixp.i.iter().zip(&s.fixp.j).flat_map(|(&a, &b)| [a, b]).collect());
    let ht: Vec<f32> = { let v = f32s(s.fixp.t.iter().flat_map(|t| t[..6].to_vec())); if v.is_empty() { vec![0.0; 6] } else { v } };
    let b_mstart = buf("mstart", bytemuck::cast_slice(&s.movp.start));
    let b_mpair = buf("mpair", bytemuck::cast_slice(&mp));
    let b_hstart = buf("hstart", bytemuck::cast_slice(&s.fixp.start));
    let b_hlist = buf("hlist", bytemuck::cast_slice(&nonempty(s.fixp.list.clone())));
    let b_hij = buf("hij", bytemuck::cast_slice(&hij));
    let b_ht = buf("ht", bytemuck::cast_slice(&ht));

    // Data of every step: positions from the centre (f32 keeps 7 digits of them), v and ρ, stress terms.
    let c = [0, 1, 2].map(|k| { let a = [&s.x, &s.y, &s.z][k]; (a.iter().cloned().fold(f64::INFINITY, f64::min) + a.iter().cloned().fold(f64::NEG_INFINITY, f64::max)) / 2.0 });
    let pos = |s: &Sim| -> Vec<f32> { (0..n).flat_map(|i| [(s.x[i] - c[0]) as f32, (s.y[i] - c[1]) as f32, (s.z[i] - c[2]) as f32, if s.fixed[i] >= 2 { 1.0 } else { 0.0 }]).collect() };
    let (pos0, q0, pk0, dmg0) = (pos(s), f32s(s.q.iter().cloned()), f32s(s.pk.iter().cloned()), f32s(s.dmg.iter().cloned()));
    let b_pos = buf("pos", bytemuck::cast_slice(&pos0));
    let b_q = buf("q", bytemuck::cast_slice(&q0));
    let b_pk = buf("pk", bytemuck::cast_slice(&pk0));
    let b_dmg = buf("dmg", bytemuck::cast_slice(&dmg0));
    let out = |label: &str, len: usize| dev.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: 4 * len as u64, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let b_lm = out("lm", 19 * n);
    let b_ac = out("ac", 6 * n);
    let sc = &s.sc;
    let hk = sc.hk;
    let par = Params {
        n: n as u32, per: s.per.unwrap_or(0.0) as f32, hk: hk as f32, ad: sc.ad as f32, m: sc.m as f32,
        alpha: s.cfg.av_alpha as f32, beta: s.cfg.av_beta as f32, cs: sc.cs as f32, iwdx: (1.0 / sc.Wdx) as f32,
        xs: (0.5 * sc.m) as f32, eta: (0.01 * hk * hk) as f32, pad: 0.0,
    };
    let b_par = dev.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("params"), contents: bytemuck::bytes_of(&par), usage: wgpu::BufferUsages::UNIFORM });

    let module = dev.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("sph"), source: wgpu::ShaderSource::Wgsl(include_str!("gpu.wgsl").into()) });
    let pipe = |entry: &str| dev.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(entry), layout: None, module: &module, entry_point: Some(entry), compilation_options: Default::default(), cache: None,
    });
    let (p_lm, p_mo) = (pipe("pass_lm"), pipe("pass_momentum"));
    let group = |p: &wgpu::ComputePipeline, binds: &[(u32, &wgpu::Buffer)]| dev.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &p.get_bind_group_layout(0),
        entries: &binds.iter().map(|&(k, b)| wgpu::BindGroupEntry { binding: k, resource: b.as_entire_binding() }).collect::<Vec<_>>(),
    });
    let g_lm = group(&p_lm, &[(0, &b_par), (1, &b_pos), (2, &b_q), (3, &b_mstart), (4, &b_mpair), (5, &b_hstart), (6, &b_hlist), (7, &b_hij), (8, &b_ht), (11, &b_lm)]);
    let g_mo = group(&p_mo, &[(0, &b_par), (1, &b_pos), (2, &b_q), (3, &b_mstart), (4, &b_mpair), (9, &b_pk), (10, &b_dmg), (12, &b_ac)]);
    let wg = (n as u32).div_ceil(64);
    let wait = || { dev.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).map_err(|e| format!("GPU: {e}")) };
    let run = |k: usize| {
        let mut enc = dev.create_command_encoder(&Default::default());
        for _ in 0..k {
            let mut cp = enc.begin_compute_pass(&Default::default());
            cp.set_pipeline(&p_lm); cp.set_bind_group(0, &g_lm, &[]); cp.dispatch_workgroups(wg, 1, 1);
            cp.set_pipeline(&p_mo); cp.set_bind_group(0, &g_mo, &[]); cp.dispatch_workgroups(wg, 1, 1);
        }
        g.queue.submit([enc.finish()]);
    };
    run(1);
    wait()?;
    let t = Instant::now();
    run(iters);
    wait()?;
    let gpu_ms = 1e3 * t.elapsed().as_secs_f64() / iters as f64;

    // What a hybrid step would move every step: the per-step data up, the results down.
    let t = Instant::now();
    for (b, d) in [(&b_pos, &pos0), (&b_q, &q0), (&b_pk, &pk0), (&b_dmg, &dmg0)] { g.queue.write_buffer(b, 0, bytemuck::cast_slice(d)); }
    g.queue.submit([]);
    wait()?;
    let upload_ms = 1e3 * t.elapsed().as_secs_f64();
    let t = Instant::now();
    let read = |b: &wgpu::Buffer, len: usize| -> Result<Vec<f32>, String> {
        let rb = dev.create_buffer(&wgpu::BufferDescriptor { label: None, size: 4 * len as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = dev.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(b, 0, &rb, 0, 4 * len as u64);
        g.queue.submit([enc.finish()]);
        rb.map_async(wgpu::MapMode::Read, .., |r| r.expect("map"));
        wait()?;
        let v = bytemuck::cast_slice::<u8, f32>(&rb.get_mapped_range(..).map_err(|e| format!("GPU: {e:?}"))?).to_vec();
        Ok(v)
    };
    let (lm, ac) = (read(&b_lm, 19 * n)?, read(&b_ac, 6 * n)?);
    let download_ms = 1e3 * t.elapsed().as_secs_f64();

    Ok(Report {
        adapter: g.info.name.clone(), backend: format!("{:?}", g.info.backend), n, entries: s.movp.ea.len(), held: s.fixp.i.len(),
        cpu_ms, gpu_ms, upload_ms, download_ms,
        err_l: rel(&s.lm, &lm, 19, 0, 9), err_m: rel(&s.lm, &lm, 19, 9, 18), err_drho: rel(&s.lm, &lm, 19, 18, 19),
        err_acc: rel(&s.ac, &ac, 6, 0, 3), err_xsph: rel(&s.ac, &ac, 6, 3, 6),
    })
}
