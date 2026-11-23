/**
 * TransitionNet control representation.
 *
 * Continuous automation is a set of beat-aligned trajectories: CTRL_POINTS values per channel,
 * evenly spaced from beat 0 to beat B of the overlap (B = overlapBars × 4). Gains and EQ band
 * levels are linear amplitudes in [0, 1] (EQ converted to dB, ≤ 0, kill at −40 dB); filter is
 * the bipolar knob in [−1, 1]; echo send in [0, 1].
 *
 * Blend techniques (fades, bass swaps, long blends, percussion-led, filter sweeps) take their
 * fader / EQ / filter / send trajectories from the model. Slam techniques (echo-out, loop roll,
 * brake, scratch) and drop swaps keep their event timing (the slam beat is a structural
 * decision) and take their continuous parameters (echo subdivision/feedback/send/lead, roll
 * slice pattern and riser depth, brake start/length, scratch start/length/strokes, drop-swap
 * filter depth) from the model through `StyleParams`.
 */
import type { CurvePoint, StyleParams, TransitionPlan, TransitionStyle } from '../dj/transitions'
import { automationFor } from '../dj/transitions'

export const CTRL_POINTS = 33
export const CTRL_CHANNELS = ['outGain', 'inGain', 'outLow', 'inLow', 'outMid', 'inMid', 'outHigh', 'inHigh', 'filterOut', 'filterIn', 'echoSend'] as const
export type CtrlChannel = (typeof CTRL_CHANNELS)[number]
export type Trajectories = Record<CtrlChannel, number[]>

/** Styles whose fader/EQ/filter automation comes from learned trajectories. */
export const TRAJECTORY_STYLES: ReadonlySet<TransitionStyle> = new Set(['short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade', 'filter_sweep'])

/** Scalar parameters predicted for each technique, in model order, with their valid ranges. */
export const PARAM_SPEC = [
  ['echoDelayBeats', 0.25, 1],
  ['echoFeedback', 0.2, 0.85],
  ['echoSend', 0.3, 1],
  ['echoLead', 0.5, 3.5],
  ['rollFilter', 0, 0.95],
  ['rollPattern', 0, 3],
  ['brakeAt', 0, 3],
  ['brakeBeats', 0.5, 3.5],
  ['scratchAt', 0, 2.5],
  ['scratchBeats', 1, 3.5],
  ['scratchStrokes', 2, 10],
  ['dropFilter', -0.95, 0],
] as const
export type ParamName = (typeof PARAM_SPEC)[number][0]
export type ParamVector = Record<ParamName, number>

export const ROLL_PATTERNS: number[][] = [
  [1, 0.5, 0.25, 0.125],
  [0.5, 0.25, 0.125, 0.0625],
  [1, 1, 0.5, 0.25],
  [0.5, 0.5, 0.25, 0.125],
]

export const DEFAULT_PARAMS: ParamVector = {
  echoDelayBeats: 0.75,
  echoFeedback: 0.55,
  echoSend: 0.9,
  echoLead: 1.5,
  rollFilter: 0.7,
  rollPattern: 0,
  brakeAt: 1,
  brakeBeats: 2,
  scratchAt: 1.5,
  scratchBeats: 2.5,
  scratchStrokes: 5,
  dropFilter: -0.7,
}

export function toStyleParams(style: TransitionStyle, v: ParamVector): StyleParams {
  const p: StyleParams = {}
  if (style === 'echo_out' || style === 'scratch_cut' || style === 'drop_swap') {
    // snap the echo to a musical subdivision (1/4, dotted 1/8, 1/2, 3/4, 1 beat)
    const subs = [0.25, 0.5, 0.75, 1]
    p.echoDelayBeats = subs.reduce((b, s) => (Math.abs(s - v.echoDelayBeats) < Math.abs(b - v.echoDelayBeats) ? s : b), subs[0])
    p.echoFeedback = v.echoFeedback
    p.echoSend = v.echoSend
    if (style === 'echo_out') p.echoLead = v.echoLead
  }
  if (style === 'loop_roll') {
    p.rollFilter = v.rollFilter
    p.rollSizes = ROLL_PATTERNS[Math.max(0, Math.min(ROLL_PATTERNS.length - 1, Math.round(v.rollPattern)))]
  }
  if (style === 'brake') {
    p.brakeAt = Math.round(v.brakeAt * 2) / 2
    p.brakeBeats = v.brakeBeats
  }
  if (style === 'scratch_cut') {
    p.scratchAt = Math.round(v.scratchAt * 4) / 4
    p.scratchBeats = v.scratchBeats
    p.scratchStrokes = Math.round(v.scratchStrokes)
  }
  if (style === 'drop_swap') p.dropFilter = v.dropFilter
  return p
}

function sample(curve: CurvePoint[] | undefined, beat: number, d: number): number {
  if (!curve?.length) return d
  if (beat <= curve[0].beat) return curve[0].value
  for (let i = 1; i < curve.length; i++) {
    if (beat <= curve[i].beat) {
      const a = curve[i - 1]
      const b = curve[i]
      const span = b.beat - a.beat
      return span <= 0 ? b.value : a.value + ((b.value - a.value) * (beat - a.beat)) / span
    }
  }
  return curve[curve.length - 1].value
}

const dbToAmp = (v: number) => (v <= -40 ? 0 : 10 ** (v / 20))
const ampToDb = (a: number) => (a <= 0.01 ? -40 : Math.max(-40, 20 * Math.log10(a)))

/** Beat-aligned trajectories of an existing plan (teacher targets / baseline). */
export function planToTrajectories(plan: Pick<TransitionPlan, 'overlapBars' | 'out' | 'in' | 'filter' | 'echo'>): Trajectories {
  const B = plan.overlapBars * 4
  const t: Trajectories = Object.fromEntries(CTRL_CHANNELS.map((c) => [c, [] as number[]])) as unknown as Trajectories
  for (let k = 0; k < CTRL_POINTS; k++) {
    const beat = (B * k) / (CTRL_POINTS - 1)
    t.outGain.push(sample(plan.out.gain, beat, 1))
    t.inGain.push(sample(plan.in.gain, beat, 0))
    t.outLow.push(dbToAmp(sample(plan.out.low, beat, 0)))
    t.inLow.push(dbToAmp(sample(plan.in.low, beat, 0)))
    t.outMid.push(dbToAmp(sample(plan.out.mid, beat, 0)))
    t.inMid.push(dbToAmp(sample(plan.in.mid, beat, 0)))
    t.outHigh.push(dbToAmp(sample(plan.out.high, beat, 0)))
    t.inHigh.push(dbToAmp(sample(plan.in.high, beat, 0)))
    t.filterOut.push(sample(plan.filter?.out, beat, 0))
    t.filterIn.push(sample(plan.filter?.in, beat, 0))
    t.echoSend.push(sample(plan.echo?.send, beat, 0))
  }
  return t
}

/**
 * Valid-state projection: clamps every channel to its DSP range, limits the per-step change of
 * faders/EQ (no zipper jumps: max 0.5 amplitude per step), pins the endpoints (outgoing starts
 * at full level, ends silent; incoming starts silent, ends at full level with flat EQ and the
 * filter open), and keeps the summed fader level ≤ 1.8 (both decks at ≈ −1 dB, as the hand templates
 * hold them mid-blend) so blends cannot pile up.
 */
export function constrainTrajectories(t: Trajectories): Trajectories {
  const n = CTRL_POINTS
  const out = Object.fromEntries(CTRL_CHANNELS.map((c) => [c, t[c].slice(0, n).map((v) => (Number.isFinite(v) ? v : 0))])) as unknown as Trajectories
  for (const c of CTRL_CHANNELS) {
    const lo = c === 'filterOut' || c === 'filterIn' ? -1 : 0
    out[c] = out[c].map((v) => Math.min(1, Math.max(lo, v)))
  }
  for (const c of ['outGain', 'inGain', 'outLow', 'inLow', 'outMid', 'inMid', 'outHigh', 'inHigh'] as const) {
    for (let k = 1; k < n; k++) {
      const d = out[c][k] - out[c][k - 1]
      if (Math.abs(d) > 0.5) out[c][k] = out[c][k - 1] + Math.sign(d) * 0.5
    }
  }
  out.outGain[0] = 1
  out.inGain[0] = 0
  out.outGain[n - 1] = 0
  out.inGain[n - 1] = 1
  for (const c of ['inLow', 'inMid', 'inHigh'] as const) out[c][n - 1] = 1
  out.filterIn[n - 1] = 0
  out.filterOut[0] = 0
  out.echoSend[n - 1] = 0
  for (let k = 0; k < n; k++) {
    const s = out.outGain[k] + out.inGain[k]
    if (s > 1.8) {
      out.outGain[k] *= 1.8 / s
      out.inGain[k] *= 1.8 / s
    }
  }
  return out
}

/** Writes trajectories into a plan's fader/EQ/filter/echo automation (beats 0..B). */
export function applyTrajectories(plan: TransitionPlan, traj: Trajectories): TransitionPlan {
  const t = constrainTrajectories(traj)
  const B = plan.overlapBars * 4
  const pts = (vals: number[], f: (v: number) => number = (v) => v): CurvePoint[] => vals.map((v, k) => ({ beat: (B * k) / (CTRL_POINTS - 1), value: f(v) }))
  const anyNonZero = (v: number[]) => v.some((x) => Math.abs(x) > 1e-3)
  const next: TransitionPlan = {
    ...plan,
    out: { gain: pts(t.outGain), low: pts(t.outLow, ampToDb), mid: pts(t.outMid, ampToDb), high: pts(t.outHigh, ampToDb) },
    in: { gain: pts(t.inGain), low: pts(t.inLow, ampToDb), mid: pts(t.inMid, ampToDb), high: pts(t.inHigh, ampToDb) },
  }
  const filter: TransitionPlan['filter'] = {}
  if (anyNonZero(t.filterOut)) filter.out = pts(t.filterOut)
  if (anyNonZero(t.filterIn)) filter.in = pts(t.filterIn)
  if (filter.out || filter.in) next.filter = filter
  else delete next.filter
  if (anyNonZero(t.echoSend)) next.echo = { send: pts(t.echoSend), delayBeats: plan.echo?.delayBeats ?? 0.75, feedback: Math.min(0.6, plan.echo?.feedback ?? 0.45) }
  else delete next.echo
  // handoff = where the incoming fader first passes the outgoing one
  const cross = t.inGain.findIndex((v, k) => v >= t.outGain[k])
  next.handoffBeat = cross >= 0 ? (B * cross) / (CTRL_POINTS - 1) : plan.handoffBeat
  return next
}

/** Re-derives a creative technique's automation with predicted parameters (event timing kept). */
export function applyStyleParams(plan: TransitionPlan, v: ParamVector): TransitionPlan {
  if (TRAJECTORY_STYLES.has(plan.style) || plan.style === 'cut' || plan.style === 'sequential') return plan
  const auto = automationFor(plan.style, plan.overlapBars * 4, toStyleParams(plan.style, v))
  const next: TransitionPlan = { ...plan, out: auto.out, in: auto.in, handoffBeat: auto.handoffBeat }
  if (auto.filter) next.filter = auto.filter
  else delete next.filter
  if (auto.echo) next.echo = auto.echo
  else delete next.echo
  if (auto.outPerf) next.outPerf = auto.outPerf
  else delete next.outPerf
  return next
}

/** Mean absolute second difference over fader/EQ trajectories (control smoothness metric). */
export function roughness(t: Trajectories): number {
  let s = 0
  let n = 0
  for (const c of ['outGain', 'inGain', 'outLow', 'inLow', 'outMid', 'inMid', 'outHigh', 'inHigh'] as const) {
    for (let k = 2; k < CTRL_POINTS; k++) {
      s += Math.abs(t[c][k] - 2 * t[c][k - 1] + t[c][k - 2])
      n++
    }
  }
  return n ? s / n : 0
}

/** Seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Musically constrained trajectory variant for render-and-verify data generation: a smooth
 * time-warp of the template (moves the bass swap / fader crossing earlier or later), a shape
 * change of the fades, EQ tuck depths, and an optional filter move. Never arbitrary noise.
 */
export function perturbTrajectories(base: Trajectories, style: TransitionStyle, r: () => number): Trajectories {
  const n = CTRL_POINTS
  const u = (lo: number, hi: number) => lo + (hi - lo) * r()
  const warpMid = u(0.35, 0.65) // where the template's midpoint moves to
  const warp = (x: number) => (x <= 0.5 ? (x / 0.5) * warpMid : warpMid + ((x - 0.5) / 0.5) * (1 - warpMid))
  const inv = (y: number) => (y <= warpMid ? 0.5 * (y / warpMid) : 0.5 + 0.5 * ((y - warpMid) / (1 - warpMid)))
  const at = (vals: number[], x: number) => {
    const f = x * (n - 1)
    const i = Math.min(n - 2, Math.floor(f))
    const w = f - i
    return vals[i] * (1 - w) + vals[i + 1] * w
  }
  const out = {} as Trajectories
  for (const c of CTRL_CHANNELS) out[c] = Array.from({ length: n }, (_, k) => at(base[c], inv(k / (n - 1))))
  // bass handoff sharpness: compress/expand the low-band transition around its centre
  const sharp = u(0.5, 2)
  for (const c of ['outLow', 'inLow'] as const) out[c] = out[c].map((v) => Math.min(1, Math.max(0, 0.5 + (v - 0.5) * sharp)))
  // fader curve shape (power), applied in the faders' own range
  const g = u(0.7, 1.4)
  out.outGain = out.outGain.map((v) => Math.min(1, Math.max(0, v)) ** g)
  out.inGain = out.inGain.map((v) => Math.min(1, Math.max(0, v)) ** (1 / g))
  // EQ tucks: outgoing mids/highs during the second half, incoming highs during the first
  const midTuck = u(0, 0.6)
  const hiTuck = u(0, 0.5)
  const inHiTuck = u(0, 0.4)
  for (let k = 0; k < n; k++) {
    const x = k / (n - 1)
    if (x > warpMid) out.outMid[k] *= 1 - midTuck * ((x - warpMid) / (1 - warpMid))
    if (x > warpMid) out.outHigh[k] *= 1 - hiTuck * ((x - warpMid) / (1 - warpMid))
    if (x < warpMid) out.inHigh[k] *= 1 - inHiTuck * (1 - x / warpMid)
  }
  // optional filter moves (filter sweep always has them; other blends sometimes)
  if (style === 'filter_sweep' || r() < 0.25) {
    const hp = style === 'filter_sweep' ? u(0.5, 0.95) : u(0, 0.6)
    const lp = style === 'filter_sweep' ? -u(0.5, 0.95) : -u(0, 0.6)
    for (let k = 0; k < n; k++) {
      const x = k / (n - 1)
      out.filterOut[k] = x > warpMid ? hp * ((x - warpMid) / (1 - warpMid)) ** 1.5 : 0
      out.filterIn[k] = x < warpMid ? lp * (1 - x / warpMid) ** 1.5 : 0
    }
  }
  void warp
  return constrainTrajectories(out)
}

/** Random creative-technique parameter vector within PARAM_SPEC ranges, centred on the defaults. */
export function perturbParams(r: () => number): ParamVector {
  const v = { ...DEFAULT_PARAMS }
  for (const [name, lo, hi] of PARAM_SPEC) {
    const d = DEFAULT_PARAMS[name]
    // half the time near the default, half anywhere in range
    v[name] = r() < 0.5 ? Math.min(hi, Math.max(lo, d + (r() - 0.5) * 0.4 * (hi - lo))) : lo + r() * (hi - lo)
  }
  return v
}
