/**
 * ITU-R BS.1770-4 loudness: K-weighting (high-shelf + RLB high-pass, designed
 * per sample rate by bilinear transform as in pyloudnorm), 400 ms blocks with
 * 75 % overlap, absolute gate −70 LUFS and relative gate −10 LU. Short-term
 * loudness uses 3 s windows. True peak: 4× oversampling with a windowed-sinc
 * interpolator, evaluated around the loudest sample blocks.
 */

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

// Brecht De Man's parameterisation (as used by pyloudnorm); reproduces the ITU 48 kHz
// reference coefficients exactly and generalises to other sample rates.
export function highShelf(rate: number, fc = 1681.974450955533, gainDb = 3.999843853973347, q = 0.7071752369554196): Biquad {
  const K = Math.tan((Math.PI * fc) / rate)
  const Vh = 10 ** (gainDb / 20)
  const Vb = Vh ** 0.4996667741545416
  const a0 = 1 + K / q + K * K
  return {
    b0: (Vh + (Vb * K) / q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / q + K * K) / a0,
  }
}

export function highPass(rate: number, fc = 38.13547087602444, q = 0.5003270373238773): Biquad {
  const K = Math.tan((Math.PI * fc) / rate)
  const a0 = 1 + K / q + K * K
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / q + K * K) / a0 }
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

export interface LoudnessReport {
  integratedLufs: number
  /** Short-term (3 s) loudness sampled once per second. */
  shortTermLufs: Float32Array
  loudnessRangeLu: number
  samplePeakDb: number
  truePeakDbtp: number
  rmsDb: number
  crestDb: number
}

const BLOCK_SEC = 0.4

function meanSquares(weighted: Float32Array[], start: number, len: number): number {
  let total = 0
  for (const ch of weighted) {
    let s = 0
    const end = Math.min(ch.length, start + len)
    for (let i = start; i < end; i++) s += ch[i] * ch[i]
    total += s / len
  }
  return total
}

const lufsOf = (ms: number) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12))

export function measureLoudness(channels: Float32Array[], rate: number): LoudnessReport {
  const hs = highShelf(rate)
  const hp = highPass(rate)
  const weighted = channels.map((ch) => filter(filter(ch, hs), hp))
  const n = channels[0].length
  const block = Math.round(BLOCK_SEC * rate)
  const step = Math.round(block / 4)
  const blocks: number[] = []
  for (let s = 0; s + block <= n; s += step) blocks.push(meanSquares(weighted, s, block))
  const abs = blocks.filter((ms) => lufsOf(ms) > -70)
  let integrated = -Infinity
  if (abs.length) {
    const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
    const gated = abs.filter((ms) => lufsOf(ms) > rel)
    if (gated.length) integrated = lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length)
  }

  const st = Math.round(3 * rate)
  const shortTerm: number[] = []
  for (let s = 0; s + st <= n; s += rate) shortTerm.push(lufsOf(meanSquares(weighted, s, st)))
  if (!shortTerm.length && n > 0) shortTerm.push(lufsOf(meanSquares(weighted, 0, n)))

  // Loudness range (EBU Tech 3342): 10th–95th percentile of gated short-term values.
  const stGated = shortTerm.filter((v) => v > -70)
  let lra = 0
  if (stGated.length > 2) {
    const relGate = lufsOf(stGated.map((v) => 10 ** ((v + 0.691) / 10)).reduce((a, b) => a + b, 0) / stGated.length) - 20
    const sorted = stGated.filter((v) => v > relGate).sort((a, b) => a - b)
    if (sorted.length > 2) lra = sorted[Math.floor(0.95 * (sorted.length - 1))] - sorted[Math.floor(0.1 * (sorted.length - 1))]
  }

  let peak = 0
  let ss = 0
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i])
      if (a > peak) peak = a
      ss += ch[i] * ch[i]
    }
  }
  const rms = Math.sqrt(ss / (n * channels.length || 1))
  const tp = truePeak(channels, peak)
  const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12))
  return {
    integratedLufs: integrated,
    shortTermLufs: Float32Array.from(shortTerm),
    loudnessRangeLu: lra,
    samplePeakDb: db(peak),
    truePeakDbtp: db(tp),
    rmsDb: db(rms),
    crestDb: db(peak) - db(rms),
  }
}

/** 4× oversampled peak around every sample within 1 dB of the sample peak. */
export function truePeak(channels: Float32Array[], samplePeak: number): number {
  const taps = 12
  const phases = 4
  const kernel: number[][] = []
  for (let p = 1; p < phases; p++) {
    const frac = p / phases
    const row: number[] = []
    for (let k = -taps + 1; k <= taps; k++) {
      const t = k - frac
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / taps)
      row.push(t === 0 ? 1 : (Math.sin(Math.PI * t) / (Math.PI * t)) * w)
    }
    kernel.push(row)
  }
  const thresh = samplePeak * 0.89
  let tp = samplePeak
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) < thresh) continue
      for (let j = i - 1; j <= i; j++) {
        for (const row of kernel) {
          let acc = 0
          for (let k = 0; k < row.length; k++) {
            const idx = j + (k - taps + 1)
            if (idx >= 0 && idx < ch.length) acc += ch[idx] * row[k]
          }
          if (Math.abs(acc) > tp) tp = Math.abs(acc)
        }
      }
    }
  }
  return tp
}
