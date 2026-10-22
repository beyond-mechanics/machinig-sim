// Small helpers shared by the solver.

// Math.hypot as V8 computes it (scaled by the largest term, Kahan-compensated sum), so that the
// native core follows the JS solver bit for bit where it can.
#[inline]
pub fn js_hypot3(a: f64, b: f64, c: f64) -> f64 {
    let (a, b, c) = (a.abs(), b.abs(), c.abs());
    if a.is_infinite() || b.is_infinite() || c.is_infinite() { return f64::INFINITY; }
    let max = a.max(b).max(c);
    if max == 0.0 { return 0.0; }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for v in [a, b, c] {
        let n = v / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}
#[inline]
pub fn js_hypot2(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_infinite() || b.is_infinite() { return f64::INFINITY; }
    let max = a.max(b);
    if max == 0.0 { return 0.0; }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}

// A raw pointer for parallel loops in which every index is written by exactly one thread.
#[derive(Clone, Copy)]
pub struct Shared<T>(pub *mut T);
unsafe impl<T> Send for Shared<T> {}
unsafe impl<T> Sync for Shared<T> {}
impl<T> Shared<T> {
    pub fn new(v: &mut [T]) -> Self { Shared(v.as_mut_ptr()) }
    #[inline] pub unsafe fn at(&self, i: usize) -> &mut T { &mut *self.0.add(i) }
}
