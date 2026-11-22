/**
 * Iterative radix-2 complex FFT (in place) with cached twiddles and
 * bit-reversal tables per size. Pure TypeScript, no allocations per call.
 */

interface Plan {
  n: number
  rev: Uint32Array
  cos: Float64Array
  sin: Float64Array
}

const plans = new Map<number, Plan>()

function plan(n: number): Plan {
  let p = plans.get(n)
  if (p) return p
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`)
  const bits = Math.log2(n)
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n)
    sin[i] = Math.sin((-2 * Math.PI * i) / n)
  }
  p = { n, rev, cos, sin }
  plans.set(n, p)
  return p
}

/** Forward FFT, in place. `re` and `im` must have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  const { rev, cos, sin } = plan(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]
        const wi = sin[k * step]
        const a = start + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

const windows = new Map<number, Float64Array>()

/** Periodic Hann window (cached). */
export function hann(n: number): Float64Array {
  let w = windows.get(n)
  if (!w) {
    w = new Float64Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
    windows.set(n, w)
  }
  return w
}

/**
 * Reusable real-signal magnitude spectrum: windows `n` samples of `x` starting at
 * `offset` (zero-padded past the ends) and writes |X[k]| for k = 0..n/2 into `out`.
 */
export class MagnitudeSpectrum {
  readonly n: number
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly win: Float64Array

  constructor(n: number) {
    this.n = n
    this.re = new Float64Array(n)
    this.im = new Float64Array(n)
    this.win = hann(n)
  }

  compute(x: Float32Array, offset: number, out: Float32Array): void {
    const { n, re, im, win } = this
    for (let i = 0; i < n; i++) {
      const idx = offset + i
      re[i] = idx >= 0 && idx < x.length ? x[idx] * win[i] : 0
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k])
  }
}
