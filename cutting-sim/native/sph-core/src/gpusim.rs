// The whole step on the GPU (wgpu, f32; the shaders are gpusim.wgsl), STL mode. The particles live
// on the GPU; the CPU Sim keeps the bookkeeping (time, pose, samples, the force history) and does
// what is done now and then: the neighbour search (after a particle has moved half the skin) and
// the samples (about 100 per run). For those the particles are copied back.
//
// Per step the GPU returns only the step's sums (impulse, torque, work, tool heat, deaths) and
// whether a new search is due. Results agree with the CPU solver to f32 rounding, which grows over
// a run like any rounding difference in an explicit solver; the forces are compared in sphcli --gpu.

use super::{Motion, Sim};
use std::time::Instant;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    n: u32, steps: u32, flags: u32, nsub: u32,
    dt: f32, m: f32, m_real: f32, g: f32,
    k: f32, rho0: f32, cs: f32, hk: f32,
    ad: f32, iwdx: f32, ep_keep: f32, dx: f32,
    av_a: f32, av_b: f32, xs: f32, coef: f32,
    ma: f32, mb: f32, mn: f32, mc: f32,
    mm: f32, tm: f32, tr: f32, mvc: f32,
    rhoc: f32, cp: f32, ta: f32, tb: f32,
    tcc: f32, td: f32, d1: f32, d2: f32,
    d3: f32, d4: f32, d5: f32, efs: f32,
    beta: f32, pcut: f32, mu0: f32, mu_exp: f32,
    tx0: f32, ty0: f32, tz0: f32, ax: f32,
    ay: f32, ca: f32, sa: f32, w: f32,
    base: f32, tvz: f32, far: f32, cell: f32,
    bb: [f32; 6], lo: [i32; 3], dm: [i32; 3],
    fw: f32, v_esc2: f32, area: f32, v_slow2: f32,
    d_free: f32, d_wake: f32, d_sleep: f32, d0: f32,
    lim2: f32, pad: [f32; 3],
}

const F_SLEEP: u32 = 1;
const F_WAKE: u32 = 2;
const F_FRAC: u32 = 4;
const F_MUV: u32 = 8;
const F_TANH: u32 = 16;
const F_SHEP: u32 = 32;

// Binding numbers of gpusim.wgsl.
const B_POS: usize = 1; const B_VEL: usize = 2; const B_FLG: usize = 3; const B_SIG: usize = 4; const B_PRS: usize = 5;
const B_TMP: usize = 6; const B_EP: usize = 7; const B_EPD: usize = 8; const B_DMG: usize = 9; const B_SEQ: usize = 10;
const B_SR: usize = 11; const B_PK: usize = 12; const B_LM: usize = 13; const B_AC: usize = 14; const B_MSTART: usize = 15;
const B_MPAIR: usize = 16; const B_EF: usize = 17; const B_HSTART: usize = 18; const B_HLIST: usize = 19; const B_HIJ: usize = 20;
const B_HT: usize = 21; const B_SCR: usize = 22; const B_XR: usize = 23; const B_SDFT: usize = 24; const B_SDFP: usize = 25;
const B_PART: usize = 26; const B_OUT: usize = 27; const B_FLAG: usize = 28;
const NB: usize = 29;

pub struct GpuSim {
    pub s: Sim,
    pub adapter: String,
    dev: wgpu::Device,
    queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    pipes: Vec<(&'static str, wgpu::ComputePipeline)>,
    par: Params,
    b_par: wgpu::Buffer,
    bufs: Vec<Option<wgpu::Buffer>>,
    group: Option<wgpu::BindGroup>,
    snap_pos: wgpu::Buffer, snap_flg: wgpu::Buffer,
    stage: wgpu::Buffer,
    c: [f64; 3],
    searches: u64,
    pending_search: bool,
    // Wall time [s]: GPU steps (with their readback), searches, samples, copies.
    pub prof: [f64; 4],
}

fn pipe_names() -> [&'static str; 9] { ["k_lm", "k_shep", "k_shep2", "k_const", "k_mom", "k_cond", "k_cond2", "k_int", "k_red"] }

impl GpuSim {
    pub fn new(mut s: Sim) -> Result<GpuSim, String> {
        if !matches!(s.motion, Motion::Linear | Motion::Mill | Motion::Drill) { return Err("GPU 計算は今は STL 取り込みモードだけです".into()); }
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default()
        })).map_err(|e| format!("GPU が見つかりません: {e}"))?;
        let info = adapter.get_info();
        let (dev, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("sph"), required_limits: adapter.limits(), ..Default::default()
        })).map_err(|e| format!("GPU を開けません: {e}"))?;
        if adapter.limits().max_storage_buffers_per_shader_stage < 28 { return Err(format!("この GPU はバッファの数が足りません（{}）", adapter.limits().max_storage_buffers_per_shader_stage)); }

        let n = s.n;
        s.no_reorder = true;
        // Positions from the middle of the work keep their digits in f32.
        let mid = |a: &[f64]| (a.iter().cloned().fold(f64::INFINITY, f64::min) + a.iter().cloned().fold(f64::NEG_INFINITY, f64::max)) / 2.0;
        let c = [mid(&s.x), mid(&s.y), mid(&s.z)];

        let mut entries = vec![wgpu::BindGroupLayoutEntry {
            binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None,
        }];
        for b in 1..NB as u32 {
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: b, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None }, count: None,
            });
        }
        let layout = dev.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("sph"), entries: &entries });
        let pl = dev.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("sph"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let module = dev.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("gpusim"), source: wgpu::ShaderSource::Wgsl(include_str!("gpusim.wgsl").into()) });
        let pipes = pipe_names().iter().map(|&e| (e, dev.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(e), layout: Some(&pl), module: &module, entry_point: Some(e), compilation_options: Default::default(), cache: None,
        }))).collect();

        // The tool's distance field: the bricks near its surface, all built now.
        let sdf = s.sdf.as_ref().unwrap();
        let far = 3.0 * s.sc.dx;
        let (table, pool, lo, dim) = sdf.gpu_grid(far);
        let bb = sdf.bb;

        let sc = s.sc;
        let mat = &s.mat;
        let mut flags = 0;
        if s.cfg.sleep { flags |= F_SLEEP; }
        if s.cfg.fracture && mat.d1.is_some() { flags |= F_FRAC; }
        if s.cfg.friction == "speed" { flags |= F_MUV; }
        if mat.is_tanh() { flags |= F_TANH; }
        let skin = 0.3 * sc.hk;
        let par = Params {
            n: n as u32, nsub: sc.nSub, flags,
            dt: sc.dt as f32, m: sc.m as f32, m_real: sc.mReal as f32, g: sc.G as f32, k: sc.K as f32, rho0: sc.rho0 as f32, cs: sc.cs as f32, hk: sc.hk as f32,
            ad: sc.ad as f32, iwdx: (1.0 / sc.Wdx) as f32, ep_keep: sc.epKeep as f32, dx: sc.dx as f32,
            av_a: s.cfg.av_alpha as f32, av_b: s.cfg.av_beta as f32, xs: (0.5 * sc.m) as f32,
            coef: (2.0 * mat.k / (mat.rho * mat.cp) * sc.dt / sc.nSub as f64) as f32,
            ma: mat.a as f32, mb: mat.b as f32, mn: mat.n as f32, mc: mat.c_rate as f32, mm: mat.m as f32, tm: mat.tm as f32, tr: mat.tr as f32, mvc: mat.vc as f32,
            rhoc: (mat.rho * mat.cp) as f32, cp: mat.cp as f32, ta: mat.ta.unwrap_or(0.0) as f32, tb: mat.tb.unwrap_or(0.0) as f32,
            tcc: mat.cc.unwrap_or(0.0) as f32, td: mat.d.unwrap_or(0.0) as f32,
            d1: mat.d1.unwrap_or(0.0) as f32, d2: mat.d2.unwrap_or(0.0) as f32, d3: mat.d3.unwrap_or(0.0) as f32, d4: mat.d4.unwrap_or(0.0) as f32, d5: mat.d5.unwrap_or(0.0) as f32,
            efs: s.cfg.ef_scale as f32, beta: s.cfg.beta as f32, pcut: (-2.0 * mat.a * 1e6) as f32, mu0: s.cfg.mu as f32, mu_exp: s.cfg.mu_exp as f32,
            ax: sc.ax as f32, ay: sc.ay as f32, w: (sc.sg * sc.om) as f32,
            base: match s.motion { Motion::Linear => sc.V, Motion::Mill => sc.vf, _ => 0.0 } as f32,
            tvz: if s.motion == Motion::Drill { -sc.vf as f32 } else { 0.0 },
            far: far as f32, cell: sdf.cell_size() as f32,
            bb: bb.map(|v| v as f32), lo: lo.map(|v| v as i32), dm: dim.map(|v| v as i32),
            fw: s.cfg.heat_to_work as f32, v_esc2: (100.0 * sc.V * sc.V) as f32, area: (sc.dx * sc.dx) as f32, v_slow2: ((0.02 * sc.V) * (0.02 * sc.V)) as f32,
            d_free: (8.0 * sc.dx) as f32, d_wake: (10.0 * sc.dx) as f32, d_sleep: (14.0 * sc.dx) as f32, d0: (0.5 * sc.dx) as f32,
            lim2: (0.25 * skin * skin) as f32,
            ..Default::default()
        };
        let b_par = dev.create_buffer(&wgpu::BufferDescriptor { label: Some("params"), size: std::mem::size_of::<Params>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let snap_pos = Self::raw(&dev, "snap_pos", 16 * n);
        let snap_flg = Self::raw(&dev, "snap_flg", 4 * n);
        let stage = dev.create_buffer(&wgpu::BufferDescriptor { label: Some("stage"), size: 64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let adapter_name = format!("{} ({:?})", info.name, info.backend);
        let mut g = GpuSim {
            s, adapter: adapter_name, dev, queue, layout, pipes, par, b_par, bufs: (0..NB).map(|_| None).collect(), group: None,
            snap_pos, snap_flg, stage, c, searches: u64::MAX, pending_search: true, prof: [0.0; 4],
        };
        let ng = n.div_ceil(64);
        for (b, len) in [(B_PK, 9 * n), (B_LM, 19 * n), (B_AC, 6 * n), (B_SCR, n), (B_XR, 4 * n), (B_PART, 8 * ng), (B_OUT, 8), (B_FLAG, 4)] {
            g.bufs[b] = Some(Self::raw(&g.dev, "work", 4 * len));
        }
        g.bufs[B_SDFT] = Some(g.init_buf("sdft", bytemuck::cast_slice(&table)));
        g.bufs[B_SDFP] = Some(g.init_buf("sdfp", bytemuck::cast_slice(if pool.is_empty() { &[0f32; 4][..] } else { &pool })));
        g.upload_particles();
        Ok(g)
    }

    fn raw(dev: &wgpu::Device, label: &str, bytes: usize) -> wgpu::Buffer {
        dev.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes.max(16) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false })
    }
    fn init_buf(&self, label: &str, data: &[u8]) -> wgpu::Buffer {
        if data.len() < 16 { let mut v = data.to_vec(); v.resize(16, 0); return self.init_buf(label, &v); }
        self.dev.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: data,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC })
    }
    // Writes into binding b, making the buffer anew when it is too small (then the bind group too).
    fn put(&mut self, b: usize, data: &[u8]) {
        let fits = self.bufs[b].as_ref().map_or(false, |x| x.size() as usize >= data.len().max(16));
        if fits { self.queue.write_buffer(self.bufs[b].as_ref().unwrap(), 0, data); return; }
        let mut v = data.to_vec();
        v.resize((data.len() * 5 / 4).max(16).next_multiple_of(4), 0);
        self.bufs[b] = Some(self.init_buf("data", &v));
        self.group = None;
    }

    fn wait(&self) { let _ = self.dev.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }); }

    fn read(&self, b: &wgpu::Buffer, bytes: usize) -> Vec<u8> {
        let rb = self.dev.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = self.dev.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(b, 0, &rb, 0, bytes as u64);
        self.queue.submit([enc.finish()]);
        rb.map_async(wgpu::MapMode::Read, .., |r| r.expect("GPU read"));
        self.wait();
        let v = rb.get_mapped_range(..).expect("GPU read").to_vec();
        v
    }
    // Several buffers in one copy and one wait: (binding, bytes) each.
    fn read_many(&self, list: &[(usize, usize)]) -> Vec<Vec<u8>> {
        let total: usize = list.iter().map(|l| l.1).sum();
        let rb = self.dev.create_buffer(&wgpu::BufferDescriptor { label: None, size: total as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = self.dev.create_command_encoder(&Default::default());
        let mut off = 0;
        for &(b, bytes) in list { enc.copy_buffer_to_buffer(self.bufs[b].as_ref().unwrap(), 0, &rb, off as u64, bytes as u64); off += bytes; }
        self.queue.submit([enc.finish()]);
        rb.map_async(wgpu::MapMode::Read, .., |r| r.expect("GPU read"));
        self.wait();
        let v = rb.get_mapped_range(..).expect("GPU read");
        let mut out = Vec::new();
        let mut off = 0;
        for &(_, bytes) in list { out.push(v[off..off + bytes].to_vec()); off += bytes; }
        out
    }

    fn flags_of(s: &Sim, i: usize) -> u32 { s.fixed[i] as u32 | (s.contact[i] as u32) << 8 | (s.dead[i] as u32) << 16 | (s.touched[i] as u32) << 24 }

    fn upload_flags(&mut self) {
        let f: Vec<u32> = (0..self.s.n).map(|i| Self::flags_of(&self.s, i)).collect();
        self.put(B_FLG, bytemuck::cast_slice(&f));
    }

    // All particle fields to the GPU.
    pub fn upload_particles(&mut self) {
        let t = Instant::now();
        let (s, c) = (&self.s, self.c);
        let n = s.n;
        let pos: Vec<f32> = (0..n).flat_map(|i| [(s.x[i] - c[0]) as f32, (s.y[i] - c[1]) as f32, (s.z[i] - c[2]) as f32, 0.0]).collect();
        let vel: Vec<f32> = (0..n).flat_map(|i| [s.vx[i] as f32, s.vy[i] as f32, s.vz[i] as f32, s.rho[i] as f32]).collect();
        let sig: Vec<f32> = (0..n).flat_map(|i| (0..6).map(move |k| s.s[k][i] as f32)).collect();
        let f = |a: &[f64]| -> Vec<f32> { a.iter().map(|&v| v as f32).collect() };
        let (prs, tmp, ep, epd, dmg, seq, sr) = (f(&s.p), f(&s.temp), f(&s.ep), f(&s.epd), f(&s.dmg), f(&s.seq), f(&s.sr));
        self.put(B_POS, bytemuck::cast_slice(&pos));
        self.put(B_VEL, bytemuck::cast_slice(&vel));
        self.put(B_SIG, bytemuck::cast_slice(&sig));
        for (b, v) in [(B_PRS, prs), (B_TMP, tmp), (B_EP, ep), (B_EPD, epd), (B_DMG, dmg), (B_SEQ, seq), (B_SR, sr)] { self.put(b, bytemuck::cast_slice(&v)); }
        self.upload_flags();
        self.prof[3] += t.elapsed().as_secs_f64();
    }

    fn unpack_flags(&mut self, f: &[u32]) {
        let s = &mut self.s;
        for i in 0..s.n { let v = f[i]; s.fixed[i] = v as u8; s.contact[i] = (v >> 8) as u8; s.dead[i] = (v >> 16) as u8; s.touched[i] = (v >> 24) as u8; }
    }
    fn unpack_pos(&mut self, p: &[f32]) {
        let (s, c) = (&mut self.s, self.c);
        for i in 0..s.n { s.x[i] = p[4 * i] as f64 + c[0]; s.y[i] = p[4 * i + 1] as f64 + c[1]; s.z[i] = p[4 * i + 2] as f64 + c[2]; }
    }

    // All particle fields back into the Sim (for a frame or a sample).
    pub fn download_particles(&mut self) {
        let t = Instant::now();
        let n = self.s.n;
        let r = self.read_many(&[(B_POS, 16 * n), (B_VEL, 16 * n), (B_SIG, 24 * n), (B_FLG, 4 * n), (B_PRS, 4 * n), (B_TMP, 4 * n), (B_EP, 4 * n),
            (B_EPD, 4 * n), (B_DMG, 4 * n), (B_SEQ, 4 * n), (B_SR, 4 * n)]);
        let f = |k: usize| -> Vec<f32> { bytemuck::pod_collect_to_vec(&r[k]) };
        let (pos, vel, sig, prs, tmp, ep, epd, dmg, seq, sr) = (f(0), f(1), f(2), f(4), f(5), f(6), f(7), f(8), f(9), f(10));
        let flg: Vec<u32> = bytemuck::pod_collect_to_vec(&r[3]);
        self.unpack_pos(&pos);
        self.unpack_flags(&flg);
        let s = &mut self.s;
        for i in 0..n {
            s.vx[i] = vel[4 * i] as f64; s.vy[i] = vel[4 * i + 1] as f64; s.vz[i] = vel[4 * i + 2] as f64; s.rho[i] = vel[4 * i + 3] as f64;
            for k in 0..6 { s.s[k][i] = sig[6 * i + k] as f64; }
            s.p[i] = prs[i] as f64; s.temp[i] = tmp[i] as f64; s.ep[i] = ep[i] as f64; s.epd[i] = epd[i] as f64;
            s.dmg[i] = dmg[i] as f64; s.seq[i] = seq[i] as f64; s.sr[i] = sr[i] as f64;
        }
        self.prof[3] += t.elapsed().as_secs_f64();
    }

    // Neighbour search on the CPU from the current positions; the pair lists go to the GPU.
    fn search(&mut self) {
        let t = Instant::now();
        let n = self.s.n;
        let r = self.read_many(&[(B_POS, 16 * n), (B_FLG, 4 * n)]);
        let pos: Vec<f32> = bytemuck::pod_collect_to_vec(&r[0]);
        let flg: Vec<u32> = bytemuck::pod_collect_to_vec(&r[1]);
        self.unpack_pos(&pos);
        self.unpack_flags(&flg);
        self.s.xr = None;
        self.s.build_pairs();
        let (mp, fp) = (&self.s.movp, &self.s.fixp);
        let mpair: Vec<u32> = mp.ea.iter().zip(&mp.eb).flat_map(|(&a, &b)| [a, b]).collect();
        let hij: Vec<u32> = fp.i.iter().zip(&fp.j).flat_map(|(&a, &b)| [a, b]).collect();
        let ht: Vec<f32> = fp.t.iter().flat_map(|t| t.iter().map(|&v| v as f32).collect::<Vec<_>>()).collect();
        let (mstart, hstart, hlist) = (mp.start.clone(), fp.start.clone(), fp.list.clone());
        let ne = mp.ea.len();
        self.put(B_MSTART, bytemuck::cast_slice(&mstart));
        self.put(B_MPAIR, bytemuck::cast_slice(&mpair));
        self.put(B_HSTART, bytemuck::cast_slice(&hstart));
        self.put(B_HLIST, bytemuck::cast_slice(&hlist));
        self.put(B_HIJ, bytemuck::cast_slice(&hij));
        self.put(B_HT, bytemuck::cast_slice(&ht));
        if self.bufs[B_EF].as_ref().map_or(true, |b| (b.size() as usize) < 4 * ne.max(4)) { self.bufs[B_EF] = Some(Self::raw(&self.dev, "ef", 4 * (ne * 5 / 4 + 4))); self.group = None; }
        let mut enc = self.dev.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(self.bufs[B_POS].as_ref().unwrap(), 0, self.bufs[B_XR].as_ref().unwrap(), 0, 16 * n as u64);
        self.queue.submit([enc.finish()]);
        self.searches = self.s.searches;
        self.pending_search = false;
        self.prof[1] += t.elapsed().as_secs_f64();
    }

    fn bind(&mut self) {
        if self.group.is_some() { return; }
        let mut entries = vec![wgpu::BindGroupEntry { binding: 0, resource: self.b_par.as_entire_binding() }];
        for b in 1..NB { entries.push(wgpu::BindGroupEntry { binding: b as u32, resource: self.bufs[b].as_ref().expect("buffer").as_entire_binding() }); }
        self.group = Some(self.dev.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("sph"), layout: &self.layout, entries: &entries }));
    }

    // One step, as Sim::step (pose and bookkeeping here, the particles on the GPU).
    fn step(&mut self, want_snap: bool) {
        let s = &mut self.s;
        if s.done { return; }
        if self.pending_search || s.n_dead + s.n_evac != s.dead_ref { self.search(); }
        let t0 = Instant::now();
        self.bind();
        let s = &mut self.s;
        let sc = s.sc;
        s.pose(s.t + sc.dt);
        let p = &mut self.par;
        p.steps = s.steps as u32;
        p.flags &= !(F_WAKE | F_SHEP);
        if s.steps % 10 == 0 { p.flags |= F_WAKE; }
        if s.steps % 20 == 0 { p.flags |= F_SHEP; }
        let c = self.c;
        p.tx0 = (s.mx + sc.ax - c[0]) as f32; p.ty0 = (sc.ay - c[1]) as f32; p.tz0 = (c[2] - s.mz) as f32;
        p.ca = s.ca as f32; p.sa = s.sa as f32;
        self.queue.write_buffer(&self.b_par, 0, bytemuck::bytes_of(&self.par));
        let n = s.n;
        let wg = (n as u32).div_ceil(64);
        let mut enc = self.dev.create_command_encoder(&Default::default());
        enc.clear_buffer(self.bufs[B_FLAG].as_ref().unwrap(), 0, None);
        if want_snap {
            enc.copy_buffer_to_buffer(self.bufs[B_POS].as_ref().unwrap(), 0, &self.snap_pos, 0, 16 * n as u64);
            enc.copy_buffer_to_buffer(self.bufs[B_FLG].as_ref().unwrap(), 0, &self.snap_flg, 0, 4 * n as u64);
        }
        {
            let mut cp = enc.begin_compute_pass(&Default::default());
            cp.set_bind_group(0, self.group.as_ref(), &[]);
            let pipe = |name: &str| &self.pipes.iter().find(|p| p.0 == name).unwrap().1;
            let run = |cp: &mut wgpu::ComputePass, name: &str, groups: u32| { cp.set_pipeline(pipe(name)); cp.dispatch_workgroups(groups, 1, 1); };
            run(&mut cp, "k_lm", wg);
            if self.par.flags & F_SHEP != 0 { run(&mut cp, "k_shep", wg); run(&mut cp, "k_shep2", wg); }
            run(&mut cp, "k_const", wg);
            run(&mut cp, "k_mom", wg);
            for _ in 0..sc.nSub { run(&mut cp, "k_cond", wg); run(&mut cp, "k_cond2", wg); }
            run(&mut cp, "k_int", wg);
            run(&mut cp, "k_red", 1);
        }
        enc.copy_buffer_to_buffer(self.bufs[B_OUT].as_ref().unwrap(), 0, &self.stage, 0, 32);
        enc.copy_buffer_to_buffer(self.bufs[B_FLAG].as_ref().unwrap(), 0, &self.stage, 32, 4);
        self.queue.submit([enc.finish()]);
        self.stage.map_async(wgpu::MapMode::Read, .., |r| r.expect("GPU read"));
        self.wait();
        let (r, flag) = {
            let v = self.stage.get_mapped_range(..).expect("GPU read");
            let f: &[f32] = bytemuck::cast_slice(&v[..32]);
            let r: [f64; 8] = std::array::from_fn(|k| f[k] as f64);
            (r, u32::from_le_bytes([v[32], v[33], v[34], v[35]]))
        };
        self.stage.unmap();
        let s = &mut self.s;
        s.n_dead += r[6].round() as u64;
        for k in 0..4 { s.imp[k] += r[k]; }
        s.imp_t += sc.dt; s.work_in += r[4]; s.heat_tool += r[5];
        s.t += sc.dt; s.steps += 1;
        if s.progress() >= 1.0 { s.done = true; }
        self.pending_search = flag != 0;
        self.prof[0] += t0.elapsed().as_secs_f64();
    }

    // As Sim::step_sample: a step, and a sample of the forces (with the chip analysis) now and then.
    pub fn step_sample(&mut self) {
        let s = &self.s;
        let every = 1.0 / 100.0;
        let pn = s.progress_at(s.t + s.sc.dt);
        let want_snap = s.cfg.fracture && (pn - s.last_sample >= every || pn >= 1.0);
        self.step(want_snap);
        let p = self.s.progress();
        if p - self.s.last_sample >= every || self.s.done {
            let t = Instant::now();
            self.download_particles();
            let n = self.s.n;
            if want_snap {
                let sp: Vec<f32> = bytemuck::pod_collect_to_vec(&self.read(&self.snap_pos, 16 * n));
                let sf: Vec<u32> = bytemuck::pod_collect_to_vec(&self.read(&self.snap_flg, 4 * n));
                let c = self.c;
                self.s.snap = Some(((0..n).map(|i| sp[4 * i] as f64 + c[0]).collect(), (0..n).map(|i| sp[4 * i + 1] as f64 + c[1]).collect(),
                    (0..n).map(|i| sp[4 * i + 2] as f64 + c[2]).collect(), (0..n).map(|i| sf[i] as u8).collect()));
            }
            self.s.sample();
            self.s.last_sample = p;
            if self.s.cfg.fracture {
                let evac = self.s.n_evac;
                self.s.analyze_chips();
                if self.s.n_evac != evac { self.upload_flags(); }
            }
            self.prof[2] += t.elapsed().as_secs_f64();
        }
    }
}
