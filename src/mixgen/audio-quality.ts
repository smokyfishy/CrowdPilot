/**
 * Transition audio-quality evaluation on RENDERED previews (closed-loop "listen" step).
 *
 * A candidate is rendered with the production renderer (src/dj/render.ts, `stems: true` for the
 * post-fader deck signals) over several bars before the transition, the whole overlap and several
 * bars after. This module measures it. These are EXPLICIT, documented signal measurements with
 * conservative thresholds — not a model of human taste:
 *
 *   beat alignment        kick-band onset cross-correlation lag between the two post-fader decks
 *   phrase alignment      cue offsets from each track's analysed phrase/bar grid (analysis-level)
 *   harmonic clash        chroma correlation of the two post-fader decks over the overlap
 *   vocal clash           per-bar vocal-band (300 Hz–3 kHz) level of each deck × its vocal activity
 *                         (stems when separated, else the analyzer's heuristic) — both audible = clash
 *   bass masking          share of low-band (<150 Hz) energy carried by BOTH decks at once
 *   percussion coherence  onset-envelope flam (9–80 ms) excess and pulse clarity (DJCritic features)
 *   energy continuity     level dip/bump inside the transition vs the surrounding music
 *   loudness consistency  level before vs after the transition
 *   clipping / silence    clipped samples, peak, limiter reduction, gaps
 *   time-stretch          tempo-change size + transient-crest loss of the stretched incoming deck
 *   stem artifacts        separation bleed of any stems actually routed
 *   effects               echo/filter/loop rules (echo over the incoming vocal, filter on a drop …)
 *   layering / smoothness bars where both decks carry full mids (overcrowding), level steps in excess of
 *                         the steps the music itself has before the transition
 *
 * DJCritic (LightGBM, trained on synthetic objective severity, NOT promoted) contributes a separate,
 * capped term when present and is always reported apart from the explicit score.
 */
import { curveAt } from '../dj/automation'
import { BEATMATCHED, SLAM, type TransitionPlan } from '../dj/transitions'
import { criticFeatures, type CriticFeatures } from '../ml/critic-features'
import { fft, hann } from '../dsp/fft'
import { barAt, type TrackProfile } from './profile'
import type { StemInfo, TechniquePlan } from './techniques'

export interface PreviewRender {
  mix: Float32Array
  stemA: Float32Array
  stemB: Float32Array
  rate: number
  /** Sample where the transition starts / ends in the preview. */
  t0: number
  t1: number
  clippedSamples: number
  peak: number
  limiterGainReductionDb: number
  /** Raw (unstretched, pre-fader) incoming audio of the same region, for transient comparison (optional). */
  rawIn?: Float32Array
}

export interface QualityMetrics {
  beatOffsetMs: number
  phraseErrBeats: number
  harmonicCorr: number
  vocalClash: number
  bassDoubling: number
  flamExcess: number
  hatFlamExcess: number
  clarityRatio: number
  dipDb: number
  bumpDb: number
  prePostDb: number
  silenceSec: number
  clippedSamples: number
  limiterDb: number
  stretchPct: number
  transientLoss: number
  stemBleed: number
  effectIssues: string[]
  crowdedBars: number
  maxLevelStepDb: number
  /** Level 8 bars after the transition minus 8 bars before (dB). */
  levelChange8Db: number
  /** Level step inside the transition in excess of the music's own steps before it (DJCritic feature). */
  stepExcessDb: number
  alignBand: 'kick' | 'hats' | 'none'
  overlapBars: number
}

export interface QualityResult {
  /** Lower is better. Explicit-metric penalty (+ capped critic term if given). Length earns nothing. */
  score: number
  hardFail: boolean
  failures: string[]
  components: Record<string, number>
  metrics: QualityMetrics
  critic?: { quality: number; artifact: number }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

function biquad(x: Float32Array, rate: number, hz: number, type: 'low' | 'high', passes = 2): Float32Array {
  const w = (2 * Math.PI * hz) / rate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const [b0, b1, b2] = type === 'low' ? [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0] : [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0]
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  let y = x
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(y.length)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = y[i]
      y2 = y1
      y1 = v
      out[i] = v
    }
    y = out
  }
  return y
}

function energyFrames(x: Float32Array, a: number, b: number, hop: number): number[] {
  const out: number[] = []
  for (let i = a; i + hop <= b; i += hop) {
    let s = 0
    for (let k = i; k < i + hop; k++) s += (x[k] ?? 0) * (x[k] ?? 0)
    out.push(s / hop)
  }
  return out
}

const dB = (p: number) => 10 * Math.log10(p + 1e-12)

/** Kick-band alignment, bass doubling and level steps from the post-fader deck signals. */
export function deckMetrics(stemA: Float32Array, stemB: Float32Array, mix: Float32Array, rate: number, t0: number, t1: number, beatSec: number) {
  const hop = Math.round(rate * 0.01)
  const lowA = biquad(stemA.subarray(Math.max(0, t0 - hop), t1), rate, 150, 'low')
  const lowB = biquad(stemB.subarray(Math.max(0, t0 - hop), t1), rate, 150, 'low')
  const A = energyFrames(lowA, 0, lowA.length, hop)
  const Bn = energyFrames(lowB, 0, lowB.length, hop)
  const fullA = energyFrames(stemA, Math.max(0, t0 - hop), t1, hop)
  const fullB = energyFrames(stemB, Math.max(0, t0 - hop), t1, hop)
  let both = 0
  let tot = 0
  for (let i = 0; i < A.length; i++) {
    both += Math.min(A[i], Bn[i] ?? 0)
    tot += A[i] + (Bn[i] ?? 0)
  }
  const bassDoubling = tot > 0 ? both / tot : 0
  const flux = (e: number[]) => e.map((v, i) => Math.max(0, Math.sqrt(v) - Math.sqrt(e[i - 1] ?? v)))
  // alignment on a 5 ms grid with parabolic sub-frame refinement
  const fine = Math.max(1, Math.round(rate * 0.005))
  const lagOf = (xa: Float32Array, xb: Float32Array, mask5: (i: number) => boolean) => {
    const ea = energyFrames(xa, 0, xa.length, fine)
    const eb = energyFrames(xb, 0, xb.length, fine)
    const fa = flux(ea)
    const fb = flux(eb)
    const maxLag = Math.round(beatSec / 2 / 0.005)
    const cs: number[] = []
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let c = 0
      for (let i = 0; i < fa.length; i++) if (mask5(i) && mask5(i + lag)) c += fa[i] * (fb[i + lag] ?? 0)
      cs.push(c)
    }
    let k = 0
    for (let i = 1; i < cs.length; i++) if (cs[i] > cs[k]) k = i
    // the peak must stand out of the lag curve, otherwise there is no common pulse to align (NaN)
    const m = cs.reduce((p, q) => p + q, 0) / cs.length
    const sd = Math.sqrt(cs.reduce((p, q) => p + (q - m) ** 2, 0) / cs.length)
    if (!(sd > 0) || (cs[k] - m) / sd < 2.5) return NaN
    const y0 = cs[k - 1] ?? cs[k]
    const y2 = cs[k + 1] ?? cs[k]
    const den = y0 - 2 * cs[k] + y2
    const frac = den < 0 ? (0.5 * (y0 - y2)) / den : 0
    return Math.abs((k - maxLag + frac) * 5)
  }
  // Kick band where both decks carry bass; long-form blends keep one deck's lows killed most of the
  // time, so fall back to the hi-hat band (> 2 kHz) where both decks are audible.
  const bothBass = A.map((v, i) => (fullA[i] ?? 0) > 1e-5 && (fullB[i] ?? 0) > 1e-5 && v > 1e-6 && (Bn[i] ?? 0) > 1e-6)
  const at10 = (m: boolean[]) => (i: number) => m[Math.floor(i / 2)] ?? false // 5 ms index → 10 ms mask
  let beatOffsetMs = NaN
  let alignBand: 'kick' | 'hats' | 'none' = 'none'
  if (bothBass.filter(Boolean).length > 400) {
    beatOffsetMs = lagOf(lowA, lowB, at10(bothBass))
    alignBand = 'kick'
  }
  if (!Number.isFinite(beatOffsetMs)) {
    const s0 = Math.max(0, t0 - hop)
    const hA = biquad(stemA.subarray(s0, t1), rate, 2000, 'high')
    const hB = biquad(stemB.subarray(s0, t1), rate, 2000, 'high')
    const hiA = energyFrames(hA, 0, hA.length, hop)
    const hiB = energyFrames(hB, 0, hB.length, hop)
    const both = hiA.map((v, i) => v > 1e-7 && (hiB[i] ?? 0) > 1e-7 && (fullA[i] ?? 0) > 1e-5 && (fullB[i] ?? 0) > 1e-5)
    if (both.filter(Boolean).length > 400) {
      beatOffsetMs = lagOf(hA, hB, at10(both))
      alignBand = Number.isFinite(beatOffsetMs) ? 'hats' : 'none'
    } else alignBand = 'none'
  }
  // largest 400 ms RMS step of the mix inside the transition window (±1 s)
  const w = Math.round(rate * 0.4)
  let prev = NaN
  let maxStep = 0
  for (let i = Math.max(0, t0 - rate); i + w < Math.min(mix.length, t1 + rate); i += w) {
    let s = 0
    for (let k = i; k < i + w; k++) s += mix[k] * mix[k]
    const d = dB(s / w)
    if (Number.isFinite(prev) && d > -45 && prev > -45) maxStep = Math.max(maxStep, Math.abs(d - prev))
    prev = d
  }
  return { bassDoubling, beatOffsetMs, alignBand, maxLevelStepDb: maxStep }
}

/** 12-bin chroma (energy-weighted) of x[a, b): 2048-point FFT frames, 110 Hz–2 kHz, one frame per ~0.5 s. */
function chromaOf(x: Float32Array, rate: number, a: number, b: number): number[] {
  const N = 2048
  const c = new Array(12).fill(0)
  const win = hann(N)
  const pcs: number[] = []
  for (let k = 0; k < N / 2; k++) {
    const f = (k * rate) / N
    pcs.push(f < 110 || f > 2000 ? -1 : ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12)
  }
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const step = Math.max(N, Math.round(rate * 0.5))
  for (let s = a; s + N <= b; s += step) {
    for (let i = 0; i < N; i++) {
      re[i] = (x[s + i] ?? 0) * win[i]
      im[i] = 0
    }
    fft(re, im)
    for (let k = 1; k < N / 2; k++) if (pcs[k] >= 0) c[pcs[k]] += re[k] * re[k] + im[k] * im[k]
  }
  const norm = Math.sqrt(c.reduce((p, q) => p + q * q, 0)) || 1
  return c.map((v) => v / norm)
}

function crest(x: Float32Array, a: number, b: number, rate: number): number {
  const hop = Math.round(rate * 0.01)
  const e = energyFrames(x, a, b, hop).map((v) => Math.sqrt(v))
  const fl = e.map((v, i) => Math.max(0, v - (e[i - 1] ?? v)))
  if (!fl.length) return 0
  const mean = fl.reduce((p, q) => p + q, 0) / fl.length
  const sorted = [...fl].sort((p, q) => p - q)
  return mean > 1e-9 ? sorted[Math.floor(sorted.length * 0.98)] / mean : 0
}

export interface QualityContext {
  plan: TransitionPlan
  pa?: TrackProfile
  pb?: TrackProfile
  stems?: { a?: StemInfo; b?: StemInfo }
  critic?: { quality: number; artifact: number }
}

/** Per-bar vocal-band level of a deck signal (dB), on the transition bar grid. */
function barBandDb(x: Float32Array, rate: number, t0: number, barSamples: number, bars: number): number[] {
  const bp = biquad(biquad(x.subarray(t0, t0 + barSamples * bars), rate, 300, 'high', 1), rate, 3000, 'low', 1)
  const out: number[] = []
  for (let k = 0; k < bars; k++) {
    let s = 0
    const a = k * barSamples
    const b = Math.min(bp.length, a + barSamples)
    for (let i = a; i < b; i++) s += bp[i] * bp[i]
    out.push(dB(s / Math.max(1, b - a)))
  }
  return out
}

export function evaluateTransition(r: PreviewRender, ctx: QualityContext): QualityResult {
  const { plan } = ctx
  const rate = r.rate
  const slam = SLAM.has(plan.style) || plan.style === 'cut'
  const matched = BEATMATCHED.has(plan.style)
  const dm = deckMetrics(r.stemA, r.stemB, r.mix, rate, r.t0, Math.max(r.t1, r.t0 + Math.round(rate * 0.5)), plan.beatSec)
  // DJCritic features only read 8 s before/after the transition window: crop (same values, less work)
  const c0 = Math.max(0, r.t0 - Math.round(8.5 * rate))
  const c1 = Math.min(r.mix.length, Math.max(r.t1, r.t0 + rate) + Math.round(8.5 * rate))
  const cf: CriticFeatures = criticFeatures({ mix: r.mix.subarray(c0, c1), rate, t0: r.t0 - c0, t1: r.t1 - c0, beatSec: plan.beatSec })
  const bars = Math.max(1, plan.overlapBars)
  const barSamples = Math.round(plan.beatSec * 4 * rate)
  // ── vocals: audible vocal-band level × vocal activity, per bar ──
  let vocalClash = 0
  let crowded = 0
  if (plan.overlapBars > 0 && ctx.pa && ctx.pb) {
    const midA = barBandDb(r.stemA, rate, r.t0, barSamples, bars)
    const midB = barBandDb(r.stemB, rate, r.t0, barSamples, bars)
    const a0 = barAt(ctx.pa, plan.outCueSec)
    const b0 = barAt(ctx.pb, plan.inCueSec)
    const ref = Math.max(...midA, ...midB)
    let clash = 0
    for (let k = 0; k < bars; k++) {
      const va = ctx.pa.vocal[a0 + k] ?? 0
      const vb = ctx.pb.vocal[b0 + k] ?? 0
      // audibility relative to the loudest deck band level in the window (0 at −18 dB)
      const aa = clamp01(1 - (ref - midA[k]) / 18)
      const ab = clamp01(1 - (ref - midB[k]) / 18)
      clash += Math.min(va * aa, vb * ab)
      if (aa > 0.75 && ab > 0.75) crowded++
    }
    vocalClash = clash / bars
  }
  // ── harmony over the frames where both decks carry mids ──
  let harmonicCorr = 1
  if (plan.overlapBars >= 4) {
    const a = r.t0
    const b = r.t1
    const ca = chromaOf(r.stemA, rate, a, b)
    const cb = chromaOf(r.stemB, rate, a, b)
    harmonicCorr = ca.reduce((s, v, i) => s + v * cb[i], 0)
  }
  // ── phrase alignment (analysis grid) ──
  let phraseErrBeats = 0
  if (ctx.pa && ctx.pb && plan.overlapBars > 0) {
    const off = (p: TrackProfile, t: number) => {
      const bar = (t - p.barStart) / p.barSec
      const near = p.phraseBars.length ? p.phraseBars.reduce((m, k) => (Math.abs(k - bar) < Math.abs(m - bar) ? k : m), p.phraseBars[0]) : Math.round(bar / 8) * 8
      const dBars = Math.abs(bar - near)
      // being on a downbeat matters most; whole bars off the phrase grid matter less
      const beatFrac = Math.abs(bar - Math.round(bar)) * 4
      return Math.min(beatFrac, 4 - beatFrac) + 0.25 * Math.min(4, dBars)
    }
    phraseErrBeats = off(ctx.pa, plan.outCueSec) + off(ctx.pb, plan.inCueSec)
  }
  // ── time-stretch ──
  const stretchPct = Math.abs(plan.tempoRatio - 1) * 100
  let transientLoss = 0
  if (r.rawIn && stretchPct > 0.5) {
    const post0 = r.t1
    const post1 = Math.min(r.stemB.length, r.t1 + Math.round(rate * 6))
    const cs = crest(r.stemB, post0, post1, rate)
    const cr = crest(r.rawIn, 0, Math.min(r.rawIn.length, post1 - post0), rate)
    transientLoss = cr > 0 ? clamp01(1 - cs / cr) : 0
  }
  // ── stems ──
  const tech = (plan as TechniquePlan).tech
  const stemBleed = tech?.stems ? Math.max(ctx.stems?.a?.bleed ?? 0.3, ctx.stems?.b?.bleed ?? 0.3) : 0
  // ── effects appropriateness (rules over executed controls + analysis) ──
  const effectIssues: string[] = []
  if (ctx.pb && plan.overlapBars > 0) {
    const b0 = barAt(ctx.pb, plan.inCueSec)
    const B = plan.overlapBars * 4
    for (let beat = 0; beat < B; beat += 2) {
      const k = b0 + Math.floor(beat / 4)
      const inVocal = (ctx.pb.vocal[k] ?? 0) >= 0.5
      const inGain = curveAt(plan.in.gain, beat)
      if (plan.echo && curveAt(plan.echo.send, beat) > 0.3 && inVocal && inGain > 0.5) {
        effectIssues.push('echo tail over the incoming vocal')
        break
      }
    }
    if (plan.filter?.in && plan.style !== 'drop_swap') {
      for (let beat = 0; beat < B; beat += 4) {
        const k = b0 + Math.floor(beat / 4)
        if (ctx.pb.region[k] === 'drop' && Math.abs(curveAt(plan.filter.in, beat)) > 0.35 && curveAt(plan.in.gain, beat) > 0.6) {
          effectIssues.push('incoming drop played through a heavy filter')
          break
        }
      }
    }
  }
  // loudness consistency over several bars either side of the transition (8 bars, or what the preview holds)
  const bar = Math.round(plan.beatSec * 4 * rate)
  const rmsDb = (a: number, b: number) => {
    let e = 0
    const lo = Math.max(0, a)
    const hi = Math.min(r.mix.length, b)
    for (let i = lo; i < hi; i++) e += r.mix[i] * r.mix[i]
    return dB(e / Math.max(1, hi - lo))
  }
  const levelChange8Db = rmsDb(r.t1, r.t1 + 8 * bar) - rmsDb(r.t0 - 8 * bar, r.t0)
  const metrics: QualityMetrics = {
    beatOffsetMs: dm.beatOffsetMs,
    phraseErrBeats,
    harmonicCorr,
    vocalClash,
    bassDoubling: dm.bassDoubling,
    flamExcess: cf.flamExcess,
    hatFlamExcess: cf.hatFlamExcess,
    clarityRatio: cf.clarityRatio,
    dipDb: cf.dipDb,
    bumpDb: cf.bumpDb,
    prePostDb: cf.prePostDb,
    silenceSec: cf.silenceSec,
    clippedSamples: r.clippedSamples,
    limiterDb: r.limiterGainReductionDb,
    stretchPct,
    transientLoss,
    stemBleed,
    effectIssues,
    crowdedBars: crowded,
    maxLevelStepDb: dm.maxLevelStepDb,
    levelChange8Db,
    stepExcessDb: cf.stepDb,
    alignBand: dm.alignBand,
    overlapBars: plan.overlapBars,
  }
  // ── penalties (0 = clean); weights are conservative engineering choices, documented in docs/PRO_DJ_REPORT.md ──
  const beatPen = matched && Number.isFinite(dm.beatOffsetMs) ? clamp01((dm.beatOffsetMs - 15) / 35) : 0
  const components: Record<string, number> = {
    beat: 1.5 * beatPen,
    phrase: 0.25 * clamp01(phraseErrBeats / 4),
    harmony: plan.overlapBars >= 4 ? 0.6 * clamp01((0.75 - harmonicCorr) / 0.45) : 0,
    vocals: 1.6 * clamp01(vocalClash / 0.4),
    bass: 1.6 * clamp01((dm.bassDoubling - 0.04) / 0.14),
    percussion: 0.5 * clamp01(cf.flamExcess / 0.25) + 0.3 * clamp01(cf.hatFlamExcess / 0.25) + 0.3 * clamp01((1 - cf.clarityRatio) / 0.5),
    energy: 0.8 * clamp01((cf.dipDb - 2) / 8) + 0.6 * clamp01((cf.bumpDb - 2) / 6),
    loudness: 0.6 * clamp01((Math.abs(levelChange8Db) - 2) / 6),
    silence: 1.5 * clamp01(cf.silenceSec / 1),
    clipping: (r.clippedSamples > 0 ? 1 : 0) + 0.5 * clamp01((r.limiterGainReductionDb - 3) / 6),
    stretch: 0.25 * clamp01((stretchPct - 2) / 6) + 0.4 * transientLoss,
    stems: tech?.stems ? 0.8 * clamp01((stemBleed - 0.1) / 0.2) : 0,
    effects: 0.4 * effectIssues.length,
    layering: 0.6 * clamp01(crowded / Math.max(4, bars * 0.5)) + 0.6 * clamp01((cf.stepDb - 1.5) / 5),
  }
  if (ctx.critic) {
    // capped: the critic models synthetic objective severity, not listener preference
    components.critic = Math.min(0.6, 0.5 * Math.max(0, ctx.critic.quality) + 0.8 * Math.max(0, ctx.critic.artifact - 0.5))
  }
  const failures: string[] = []
  if (r.clippedSamples > 0 || r.peak >= 0.999) failures.push('clipping')
  if (r.limiterGainReductionDb > 6) failures.push('limiter reduction > 6 dB')
  if (!slam && cf.silenceSec >= 0.5) failures.push(`silence ${cf.silenceSec.toFixed(1)} s`)
  if (matched && Number.isFinite(dm.beatOffsetMs) && dm.beatOffsetMs > 50) failures.push(`beat offset ${dm.beatOffsetMs.toFixed(0)} ms`)
  if (dm.bassDoubling > 0.2) failures.push(`bass doubling ${dm.bassDoubling.toFixed(2)}`)
  if (vocalClash > 0.45) failures.push(`vocal clash ${vocalClash.toFixed(2)}`)
  // a drop-locked handoff is allowed the energy jump of the incoming drop
  const dropLanding = plan.incomingDropSec !== undefined
  if (!slam && cf.stepDb > (dropLanding ? 9 : 6)) failures.push(`level step +${cf.stepDb.toFixed(1)} dB above the music's own`)
  if (!slam && cf.dipDb > 9) failures.push(`energy dip ${cf.dipDb.toFixed(1)} dB`)
  const score = Object.values(components).reduce((p, q) => p + q, 0)
  return { score, hardFail: failures.length > 0, failures, components, metrics, critic: ctx.critic }
}
