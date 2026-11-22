/**
 * DJCritic input features, computed from the RENDERED MIX ONLY (mono). Being mix-only, the same
 * features apply to CrowdPilot's candidate previews, to DJtransGAN output and to any external
 * mix excerpt whose transition window is known.
 *
 * Windows (samples): PRE = [t0 − 8 s, t0), TR = [t0, t1), POST = [t1, t1 + 8 s). For a cut
 * (t1 − t0 < 1 s) TR is widened to ±1 s around the cut so the join itself is measured.
 *
 * Every feature is a contrast between the transition and the surrounding music, so a track
 * that is simply loud, dense or dissonant is not penalised for being itself.
 */
import { frameFeatures } from '../dsp/features'

export const CRITIC_FEATURES = [
  'dipDb', 'bumpDb', 'stepDb', 'prePostDb',
  'lowDipDb', 'lowBumpDb', 'highDipDb', 'highBumpDb',
  'flamTr', 'flamExcess', 'hatFlamExcess',
  'clarityTr', 'clarityRatio',
  'silenceSec', 'gapCount',
  'clipFrac', 'peakDb',
  'chromaEntExcess', 'chromaChange',
  'fluxSpike', 'centroidJump',
  'trSec', 'beatSec',
] as const
export type CriticFeatureName = (typeof CRITIC_FEATURES)[number]
export type CriticFeatures = Record<CriticFeatureName, number>

const db = (p: number) => 10 * Math.log10(p + 1e-10)

function onePole(x: Float32Array, rate: number, hz: number, type: 'low' | 'high'): Float32Array {
  // 2nd-order Butterworth (RBJ), applied twice → 4th order.
  const w = (2 * Math.PI * hz) / rate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const [b0, b1, b2] = type === 'low' ? [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0] : [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0]
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  let y = x
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; out[i] = v
    }
    y = out
  }
  return y
}

/** Short-term level (dB) in `win`-sample windows every `hop` samples. */
function levels(x: Float32Array, win: number, hop: number): Float32Array {
  const n = Math.max(1, Math.floor((x.length - win) / hop) + 1)
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    let s = 0
    const a = k * hop
    for (let i = a; i < Math.min(x.length, a + win); i++) s += x[i] * x[i]
    out[k] = db(s / win)
  }
  return out
}

/** Log-compressed half-wave-rectified energy-difference envelope at `hop` samples. */
function onsetEnv(x: Float32Array, hop: number): Float32Array {
  const n = Math.floor(x.length / hop)
  const e = new Float32Array(n)
  let prev = 0
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let i = k * hop; i < (k + 1) * hop; i++) s += x[i] * x[i]
    const v = Math.log1p(1e4 * s)
    e[k] = Math.max(0, v - prev)
    prev = v
  }
  return e
}

/** Max normalised autocorrelation for lags in [l0, l1] over e[a, b). */
function acMax(e: Float32Array, a: number, b: number, l0: number, l1: number): number {
  a = Math.max(0, a)
  b = Math.min(e.length, b)
  if (b - a < l1 * 2) return 0
  let mean = 0
  for (let i = a; i < b; i++) mean += e[i]
  mean /= b - a
  let r0 = 0
  for (let i = a; i < b; i++) r0 += (e[i] - mean) ** 2
  if (r0 <= 1e-12) return 0
  let best = 0
  for (let l = l0; l <= l1; l++) {
    let s = 0
    for (let i = a; i + l < b; i++) s += (e[i] - mean) * (e[i + l] - mean)
    best = Math.max(best, s / r0)
  }
  return best
}

const median = (xs: ArrayLike<number>, a: number, b: number) => {
  const v = Array.from(xs).slice(Math.max(0, a), Math.max(0, b)).filter(Number.isFinite).sort((p, q) => p - q)
  return v.length ? v[Math.floor(v.length / 2)] : NaN
}
const pct = (xs: ArrayLike<number>, a: number, b: number, q: number) => {
  const v = Array.from(xs).slice(Math.max(0, a), Math.max(0, b)).filter(Number.isFinite).sort((p, q2) => p - q2)
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : NaN
}
const range = (xs: ArrayLike<number>, a: number, b: number, f: (p: number, q: number) => number, init: number) => {
  let r = init
  for (let i = Math.max(0, a); i < Math.min(xs.length, b); i++) if (Number.isFinite(xs[i])) r = f(r, xs[i])
  return r
}

export interface CriticInput {
  /** Mono mix. */
  mix: Float32Array
  rate: number
  /** Transition start / end (samples into `mix`). */
  t0: number
  t1: number
  /** Beat period (s) if known, else estimated from PRE. */
  beatSec?: number
}

/**
 * Mix-only transition features. Rate 22.05–48 kHz; internally decimated by an integer factor to
 * ≈ 22 kHz (by block averaging, which is enough for envelopes and band levels).
 */
export function criticFeatures(inp: CriticInput): CriticFeatures {
  const dec = Math.max(1, Math.round(inp.rate / 22050))
  const rate = inp.rate / dec
  let x = inp.mix
  if (dec > 1) {
    x = new Float32Array(Math.floor(inp.mix.length / dec))
    for (let i = 0; i < x.length; i++) {
      let s = 0
      for (let j = 0; j < dec; j++) s += inp.mix[i * dec + j]
      x[i] = s / dec
    }
  }
  let t0 = Math.round(inp.t0 / dec)
  let t1 = Math.round(inp.t1 / dec)
  if (t1 - t0 < rate) {
    const c = Math.round((t0 + t1) / 2)
    t0 = c - Math.round(rate)
    t1 = c + Math.round(rate)
  }
  t0 = Math.max(0, Math.min(x.length - 1, t0))
  t1 = Math.max(t0 + 1, Math.min(x.length, t1))
  const ctx = Math.round(8 * rate)
  const preA = Math.max(0, t0 - ctx)
  const postB = Math.min(x.length, t1 + ctx)

  // ── levels (400 ms windows, 100 ms hop) broadband + bands ──
  const lw = Math.round(0.4 * rate)
  const lh = Math.round(0.1 * rate)
  const lo = onePole(x, rate, 150, 'low')
  const hi = onePole(x, rate, 2500, 'high')
  const L = levels(x, lw, lh)
  const LL = levels(lo, lw, lh)
  const LH = levels(hi, lw, lh)
  const fi = (s: number) => Math.floor(s / lh)
  const fPreA = fi(preA), fT0 = fi(t0), fT1 = Math.max(fi(t0) + 1, fi(t1) - Math.ceil(lw / lh) + 1), fPostB = fi(postB) - Math.ceil(lw / lh) + 1
  const stats = (A: Float32Array) => {
    const pre = median(A, fPreA, fT0 - 3)
    const post = median(A, fi(t1) + 1, fPostB)
    const base = [pre, post].filter(Number.isFinite)
    const lowBase = base.length ? Math.min(...base) : NaN
    const highBase = base.length ? Math.max(...base) : NaN
    // robust extremes (10th / 90th percentile) so one quiet/loud beat of the music itself is not a "dip"
    const tmin = fT1 > fT0 ? pct(A, fT0, fT1, 0.1) : NaN
    const tmax = fT1 > fT0 ? pct(A, fT0, fT1, 0.9) : NaN
    return { pre, post, dip: Number.isFinite(lowBase) && Number.isFinite(tmin) ? Math.max(0, lowBase - tmin) : 0, bump: Number.isFinite(highBase) && Number.isFinite(tmax) ? Math.max(0, tmax - highBase) : 0 }
  }
  const sB = stats(L)
  const sL = stats(LL)
  const sH = stats(LH)
  // abrupt level steps around the transition vs typical steps in PRE
  const steps = (a: number, b: number) => {
    const out: number[] = []
    for (let k = Math.max(1, a); k < Math.min(L.length, b); k++) out.push(Math.abs(L[k] - L[k - 1]))
    return out
  }
  const preSteps = steps(fPreA, fT0)
  const trSteps = steps(fT0 - 5, fi(t1) + 5)
  const p95 = preSteps.length ? [...preSteps].sort((p, q) => p - q)[Math.floor(0.95 * preSteps.length)] : 0
  const stepDb = Math.max(0, (trSteps.length ? Math.max(...trSteps) : 0) - p95)

  // ── flams: kick-band / hat-band onset envelope autocorrelation at 9–80 ms ──
  const eh = 64
  const ek = onsetEnv(lo, eh)
  const ehat = onsetEnv(hi, eh)
  const l0 = Math.max(1, Math.round((0.009 * rate) / eh))
  const l1 = Math.round((0.08 * rate) / eh)
  const ei = (s: number) => Math.floor(s / eh)
  const flamTr = acMax(ek, ei(t0), ei(t1), l0, l1)
  const flamBase = Math.max(acMax(ek, ei(preA), ei(t0), l0, l1), acMax(ek, ei(t1), ei(postB), l0, l1))
  const hatTr = acMax(ehat, ei(t0), ei(t1), l0, l1)
  const hatBase = Math.max(acMax(ehat, ei(preA), ei(t0), l0, l1), acMax(ehat, ei(t1), ei(postB), l0, l1))

  // ── pulse clarity at the beat lag ──
  let beatSec = inp.beatSec ?? 0
  if (!(beatSec > 0.25 && beatSec < 1)) {
    // estimate from PRE: best autocorrelation lag in 0.33–0.6 s
    let best = 0.48
    let bv = -Infinity
    for (let l = Math.round((0.33 * rate) / eh); l <= Math.round((0.6 * rate) / eh); l++) {
      const v = acMax(ek, ei(preA), ei(t0), l, l)
      if (v > bv) { bv = v; best = (l * eh) / rate }
    }
    beatSec = best
  }
  const bl = Math.round((beatSec * rate) / eh)
  const clarity = (a: number, b: number) => acMax(ek, a, b, Math.max(1, bl - 1), bl + 1)
  const clarityTr = clarity(ei(t0), ei(t1))
  const clarityBase = Math.max(1e-3, (clarity(ei(preA), ei(t0)) + clarity(ei(t1), ei(postB))) / 2)

  // ── silence / gaps (50 ms windows) in [t0 − 1 s, t1 + 1 s] ──
  const gw = Math.round(0.05 * rate)
  const G = levels(x, gw, gw)
  const g0 = Math.floor(Math.max(0, t0 - rate) / gw)
  const g1 = Math.ceil(Math.min(x.length, t1 + rate) / gw)
  const gBase = median(G, Math.floor(preA / gw), Math.floor(t0 / gw))
  let run = 0
  let maxRun = 0
  let gaps = 0
  for (let k = g0; k < Math.min(G.length, g1); k++) {
    const quiet = G[k] < -50 || (Number.isFinite(gBase) && G[k] < gBase - 30)
    if (quiet) {
      run++
      if (run === 3) gaps++
    } else run = 0
    maxRun = Math.max(maxRun, run)
  }

  // ── peaks ──
  let clip = 0
  let peak = 0
  for (let i = Math.max(0, t0 - rate); i < Math.min(x.length, t1 + rate); i++) {
    const v = Math.abs(x[i])
    if (v > peak) peak = v
    if (v >= 0.98) clip++
  }

  // ── spectral: chroma entropy, flux spikes, centroid jump (hop 512) ──
  const ff = frameFeatures(x.subarray(preA, postB), rate, 512)
  const fr = (s: number) => Math.floor((s - preA) / 512)
  const ent = (k: number) => {
    let h = 0
    for (let c = 0; c < 12; c++) {
      const p = ff.chroma[k * 12 + c]
      if (p > 1e-9) h -= p * Math.log(p)
    }
    return h / Math.log(12)
  }
  const meanOver = (f: (k: number) => number, a: number, b: number) => {
    let s = 0
    let n = 0
    for (let k = Math.max(0, a); k < Math.min(ff.frames, b); k++) { s += f(k); n++ }
    return n ? s / n : NaN
  }
  const entTr = meanOver(ent, fr(t0), fr(t1))
  const entBase = (meanOver(ent, 0, fr(t0)) + meanOver(ent, fr(t1), ff.frames)) / 2
  const chromaMean = (a: number, b: number) => {
    const m = new Float64Array(12)
    for (let k = Math.max(0, a); k < Math.min(ff.frames, b); k++) for (let c = 0; c < 12; c++) m[c] += ff.chroma[k * 12 + c]
    const n = Math.hypot(...m) || 1
    return Array.from(m, (v) => v / n)
  }
  const cPre = chromaMean(0, fr(t0))
  const cPost = chromaMean(fr(t1), ff.frames)
  const chromaChange = 1 - cPre.reduce((s, v, i) => s + v * cPost[i], 0)
  const fluxTr = range(ff.onset, fr(t0) - 20, fr(t1) + 20, Math.max, 0)
  const flux99 = pct(ff.onset, 0, fr(t0), 0.99)
  const cen = Array.from(ff.centroid, (c) => Math.log2(Math.max(50, c)))
  const centroidJump = Math.abs((median(cen, fr(t1), ff.frames) || 0) - (median(cen, 0, fr(t0)) || 0))

  const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d)
  return {
    dipDb: fin(sB.dip),
    bumpDb: fin(sB.bump),
    stepDb: fin(stepDb),
    prePostDb: fin(sB.post - sB.pre),
    lowDipDb: fin(sL.dip),
    lowBumpDb: fin(sL.bump),
    highDipDb: fin(sH.dip),
    highBumpDb: fin(sH.bump),
    flamTr: fin(flamTr),
    flamExcess: fin(flamTr - flamBase),
    hatFlamExcess: fin(hatTr - hatBase),
    clarityTr: fin(clarityTr),
    clarityRatio: fin(clarityTr / clarityBase, 1),
    silenceSec: (maxRun * gw) / rate,
    gapCount: gaps,
    clipFrac: clip / Math.max(1, Math.min(x.length, t1 + rate) - Math.max(0, t0 - rate)),
    peakDb: 20 * Math.log10(peak + 1e-9),
    chromaEntExcess: fin(entTr - entBase),
    chromaChange: fin(chromaChange),
    fluxSpike: fin(fluxTr / Math.max(1e-3, fin(flux99, 1)), 1),
    centroidJump: fin(centroidJump),
    trSec: (inp.t1 - inp.t0) / inp.rate,
    beatSec,
  }
}

export function featureVector(f: CriticFeatures): number[] {
  return CRITIC_FEATURES.map((k) => f[k])
}
