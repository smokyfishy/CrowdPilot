/**
 * MixGraph transition layer: enumerates REGION-level transition candidates
 * between two tracks (multiple edges per pair: different cue points, overlap
 * lengths and techniques), scores them with explicit weighted costs, and
 * emits an executable plan (beat-relative automation curves) plus an
 * explanation. Deterministic; no learned model is involved in this baseline.
 */
import type { AnalysisSummary } from '../dsp/analyze'
import { camelotDistance } from '../dsp/key'
import type { PerfOp } from './fx'

export type TransitionStyle =
  | 'cut'
  | 'short_fade'
  | 'long_blend'
  | 'bass_swap'
  | 'percussion_led'
  | 'unmatched_fade'
  | 'sequential'
  // creative / performance techniques
  | 'drop_swap'
  | 'filter_sweep'
  | 'echo_out'
  | 'loop_roll'
  | 'brake'
  | 'scratch_cut'

export const STYLE_LABEL: Record<TransitionStyle, string> = {
  cut: 'Phrase-aligned cut',
  short_fade: 'Short beat-matched fade',
  long_blend: 'Long phrase blend',
  bass_swap: 'Bass swap',
  percussion_led: 'Percussion-led blend',
  unmatched_fade: 'Quick fade (no beat-match)',
  sequential: 'Standard playback (no mix)',
  drop_swap: 'Drop swap (build into drop)',
  filter_sweep: 'Filter sweep blend',
  echo_out: 'Echo-out',
  loop_roll: 'Loop roll into the drop',
  brake: 'Vinyl brake',
  scratch_cut: 'Scratch + echo cut',
}

export interface PlanTrack {
  itemId: string
  trackKey: string
  title: string
  mixable: boolean
  summary?: AnalysisSummary
  durationSec: number
}

/** A point on an automation curve: `beat` relative to the transition start, `value` linear 0..1 (gain) or dB (eq). */
export interface CurvePoint {
  beat: number
  value: number
}

export interface DeckAutomation {
  gain: CurvePoint[]
  low: CurvePoint[]
  mid: CurvePoint[]
  high: CurvePoint[]
}

export interface CostBreakdown {
  tempo: number
  key: number
  energy: number
  vocals: number
  confidence: number
  truncation: number
  variety: number
  total: number
}

export interface TransitionPlan {
  fromItemId: string
  toItemId: string
  style: TransitionStyle
  /** Seconds into the outgoing track (its own timeline) where the transition starts. */
  outCueSec: number
  /** Seconds into the incoming track (its own timeline) that align with outCueSec. */
  inCueSec: number
  overlapBars: number
  /** Playback-rate ratio applied to the incoming track during the overlap (tempo match), 1 = none. */
  tempoRatio: number
  /** Bars after the overlap over which the incoming tempo returns to its original (0 = stays). */
  tempoRecoveryBars: number
  /** Beat period (s) of the outgoing track; automation beats are in this unit. */
  beatSec: number
  durationSec: number
  /** Beat (relative to transition start) at which room state should switch to the incoming track. */
  handoffBeat: number
  out: DeckAutomation
  in: DeckAutomation
  costs: CostBreakdown
  risks: string[]
  reasons: string[]
  /** Bipolar DJ filter knob curves (-1 low-pass ... 0 off ... +1 high-pass). */
  filter?: { out?: CurvePoint[]; in?: CurvePoint[] }
  /** Tempo-synced echo send on the outgoing deck (tails keep ringing after the dry signal stops). */
  echo?: { send: CurvePoint[]; delayBeats: number; feedback: number }
  /** Performance moves on the outgoing deck (roll/brake/spinback/scratch), beats relative to the transition start. */
  outPerf?: { startBeat: number; beats: number; ops: PerfOp[] }
}

export interface PlannerWeights {
  tempo: number
  key: number
  energy: number
  vocals: number
  confidence: number
  truncation: number
  variety: number
}

export const DEFAULT_WEIGHTS: PlannerWeights = { tempo: 0.25, key: 1.0, energy: 0.08, vocals: 1.2, confidence: 1.0, truncation: 0.02, variety: 0.8 }

export interface PlannerOptions {
  /** Include blend cues that finish on a detected incoming drop. */
  preferDropLandings?: boolean
  maxTempoDeviation: number // 0.06 = ±6 %
  weights: PlannerWeights
  /** Styles recently used (most recent first), for variety. */
  recentStyles: TransitionStyle[]
  /** Desired energy direction for the next transition: +1 build, 0 hold, −1 cool down. */
  energyDirection: number
  /** Allowed styles (host can restrict). */
  allowedStyles?: TransitionStyle[]
}

export const DEFAULT_OPTIONS: PlannerOptions = {
  maxTempoDeviation: 0.06,
  weights: DEFAULT_WEIGHTS,
  recentStyles: [],
  energyDirection: 0,
}

const KILL = -40 // dB used for an EQ "kill"

function flat(beats: number, value: number): CurvePoint[] {
  return [
    { beat: 0, value },
    { beat: beats, value },
  ]
}

/** Linear amplitude (0..1) → dB for EQ band curves (floor = KILL). */
function ampDb(a: number): number {
  return a <= 0.01 ? KILL : Math.max(KILL, 20 * Math.log10(a))
}

/** Smoothstep (musical S-curve) between 0 and 1. */
function smooth(t: number): number {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}

/**
 * Dense curve from a shape function f(t∈[0,1]) between beats b0..b1, held flat outside.
 * `db` converts amplitude to dB (for EQ bands). Points every 1/4 beat (≥ 8 points) so the
 * engine's linear ramps between points approximate the intended shape closely.
 */
function curve(total: number, b0: number, b1: number, from: number, to: number, f: (t: number) => number, db = false): CurvePoint[] {
  const conv = (a: number) => (db ? ampDb(a) : a)
  const pts: CurvePoint[] = [{ beat: 0, value: conv(from) }]
  const n = Math.max(8, Math.ceil((b1 - b0) * 4))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    pts.push({ beat: b0 + t * (b1 - b0), value: conv(from + (to - from) * f(t)) })
  }
  pts.push({ beat: Math.max(total, b1), value: conv(to) })
  return pts.filter((p, i, arr) => i === 0 || p.beat >= arr[i - 1].beat)
}

const lin = (t: number) => t
const HEADROOM = 0.89 // −1 dB on each deck while both are at full level

/**
 * Bass handoff in LINEAR amplitude: out 1→0 while in 0→1 over `len` beats centred on `at`.
 * For beat-aligned kicks/basslines the summed low band stays ≈ constant (no dip, no doubling).
 */
function bassHandoff(total: number, at: number, len: number): { out: CurvePoint[]; in: CurvePoint[] } {
  const b0 = Math.max(0, at - len / 2)
  const b1 = Math.min(total, at + len / 2)
  return { out: curve(total, b0, b1, 1, 0, lin, true), in: curve(total, b0, b1, 0, 1, lin, true) }
}

export interface Automation {
  out: DeckAutomation
  in: DeckAutomation
  handoffBeat: number
  /** Beat (relative to the transition start) where the incoming cue/downbeat lands. */
  inStartBeat?: number
  filter?: TransitionPlan['filter']
  echo?: TransitionPlan['echo']
  outPerf?: TransitionPlan['outPerf']
}

const silentIn = (B: number, at: number): DeckAutomation => ({
  gain: [{ beat: 0, value: 0 }, { beat: Math.max(0, at - 0.02), value: 0 }, { beat: at, value: 1 }, { beat: Math.max(B, at), value: 1 }],
  low: flat(B, 0),
  mid: flat(B, 0),
  high: flat(B, 0),
})

/**
 * Continuous parameters of the creative techniques. Defaults reproduce the hand-designed
 * templates; TransitionNet predicts them per transition (see src/ml/transition-net.ts).
 */
export interface StyleParams {
  /** Echo subdivision (beats), feedback (0–0.85), send peak (0–1), and how many beats before the cut the send opens. */
  echoDelayBeats?: number
  echoFeedback?: number
  echoSend?: number
  echoLead?: number
  /** Loop-roll slice sizes (beats, shrinking) and the high-pass depth of the riser (0–0.95). */
  rollSizes?: number[]
  rollFilter?: number
  /** Brake: beat it starts (≥ 0) and its length (beats). */
  brakeAt?: number
  brakeBeats?: number
  /** Scratch: start beat, length (beats), forward/back strokes. */
  scratchAt?: number
  scratchBeats?: number
  scratchStrokes?: number
  /** Drop swap: starting low-pass depth on the incoming build (−0.95…0). */
  dropFilter?: number
}

const clampN = (v: number | undefined, lo: number, hi: number, d: number) => (v === undefined || !Number.isFinite(v) ? d : Math.min(hi, Math.max(lo, v)))

/** Automation templates per style; `beats` = overlap length in beats. Each style has its own control shape. */
export function automationFor(style: TransitionStyle, beats: number, p: StyleParams = {}): Automation {
  const B = Math.max(beats, 0)
  switch (style) {
    case 'echo_out': {
      // The last bar of the outgoing rings out through a dotted-1/8 echo; the incoming drops in
      // on the next downbeat (works even when tempos are too far apart to beat-match).
      const at = Math.min(4, B)
      const lead = clampN(p.echoLead, 0.5, Math.max(0.5, at - 0.25), 1.5)
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: at - 0.05, value: 1 }, { beat: at, value: 0 }, { beat: B, value: 0 }], low: curve(B, at - 2, at, 1, 0.3, lin, true), mid: flat(B, 0), high: flat(B, 0) },
        in: silentIn(B, at),
        handoffBeat: at,
        inStartBeat: at,
        echo: {
          send: [{ beat: 0, value: 0 }, { beat: at - lead, value: 0 }, { beat: at - 0.25, value: clampN(p.echoSend, 0.3, 1, 0.9) }, { beat: at + 0.1, value: 0 }, { beat: B, value: 0 }],
          delayBeats: clampN(p.echoDelayBeats, 0.25, 1, 0.75),
          feedback: clampN(p.echoFeedback, 0.2, 0.85, 0.55),
        },
      }
    }
    case 'loop_roll': {
      // Beat-repeat roll 1 -> 1/2 -> 1/4 -> 1/8 beat over two bars while a high-pass sweeps up,
      // then the incoming slams in on the downbeat.
      const at = B
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: at - 0.03, value: 1 }, { beat: at, value: 0 }], low: flat(B, 0), mid: flat(B, 0), high: flat(B, 0) },
        in: silentIn(B, at),
        handoffBeat: at,
        inStartBeat: at,
        filter: { out: curve(B, 0, at, 0, clampN(p.rollFilter, 0, 0.95, 0.7), lin) },
        outPerf: { startBeat: 0, beats: at, ops: [{ kind: 'roll', atBeat: 0, sizes: (p.rollSizes?.length ? p.rollSizes : [1, 0.5, 0.25, 0.125]).map((v) => clampN(v, 0.0625, 2, 0.25)), stepBeats: at / (p.rollSizes?.length || 4) }] },
      }
    }
    case 'brake': {
      // Vinyl brake over two beats, a beat of air, the incoming on the next downbeat.
      const at = Math.max(4, B)
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: at, value: 1 }, { beat: at + 0.02, value: 0 }], low: flat(at, 0), mid: flat(at, 0), high: flat(at, 0) },
        in: silentIn(at, at),
        handoffBeat: at,
        inStartBeat: at,
        outPerf: (() => {
          const bb = clampN(p.brakeBeats, 0.5, at - 0.5, 2)
          return { startBeat: 0, beats: at, ops: [{ kind: 'brake' as const, atBeat: clampN(p.brakeAt, 0, at - bb, 1), beats: bb }] }
        })(),
      }
    }
    case 'scratch_cut': {
      // Baby-scratch flourish on the outgoing, echo tail, the incoming on the downbeat.
      const at = Math.max(4, B)
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: at - 0.05, value: 1 }, { beat: at, value: 0 }], low: flat(at, 0), mid: flat(at, 0), high: flat(at, 0) },
        in: silentIn(at, at),
        handoffBeat: at,
        inStartBeat: at,
        outPerf: (() => {
          const sb = clampN(p.scratchBeats, 1, at - 0.5, 2.5)
          return { startBeat: 0, beats: at, ops: [{ kind: 'scratch' as const, atBeat: clampN(p.scratchAt, 0, at - sb, 1.5), beats: sb, strokes: Math.round(clampN(p.scratchStrokes, 2, 10, 5)) }] }
        })(),
        echo: { send: [{ beat: 0, value: 0 }, { beat: at - 0.6, value: 0 }, { beat: at - 0.1, value: clampN(p.echoSend, 0.3, 1, 0.8) }, { beat: at + 0.1, value: 0 }], delayBeats: clampN(p.echoDelayBeats, 0.25, 1, 0.5), feedback: clampN(p.echoFeedback, 0.2, 0.85, 0.5) },
      }
    }
    case 'filter_sweep': {
      // The incoming opens from a low-pass while the outgoing climbs a high-pass; bass handoff mid-way.
      const mid = B / 2
      const bass = bassHandoff(B, mid, 4)
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: B * 0.6, value: HEADROOM }, ...curve(B, B * 0.6, B, HEADROOM, 0, smooth).slice(1)], low: bass.out, mid: flat(B, 0), high: flat(B, 0) },
        in: { gain: [...curve(B, 0, B * 0.4, 0, HEADROOM, smooth).slice(0, -1), { beat: B * 0.75, value: 1 }, { beat: B, value: 1 }], low: bass.in, mid: flat(B, 0), high: flat(B, 0) },
        handoffBeat: mid,
        filter: { out: curve(B, B * 0.3, B, 0, 0.85, smooth), in: curve(B, 0, B * 0.6, -0.85, 0, smooth) },
      }
    }
    case 'drop_swap': {
      // The incoming BUILD plays under the outgoing (lows killed, low-pass opening); on the
      // incoming drop the outgoing is cut with an echo tail and the incoming bass slams in.
      const end = B
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: end - 0.05, value: HEADROOM }, { beat: end, value: 0 }], low: curve(B, end - 4, end, 1, 0.5, lin, true), mid: flat(B, 0), high: flat(B, 0) },
        in: {
          gain: [...curve(B, 0, B * 0.5, 0, 0.8, smooth).slice(0, -1), { beat: end - 0.05, value: 0.85 }, { beat: end, value: 1 }],
          low: [{ beat: 0, value: KILL }, { beat: end - 0.05, value: KILL }, { beat: end, value: 0 }],
          mid: flat(B, 0),
          high: flat(B, 0),
        },
        handoffBeat: end,
        filter: { in: curve(B, 0, end - 1, clampN(p.dropFilter, -0.95, 0, -0.7), 0, smooth) },
        echo: { send: [{ beat: 0, value: 0 }, { beat: end - 1, value: 0 }, { beat: end - 0.1, value: clampN(p.echoSend, 0.3, 1, 0.8) }, { beat: end + 0.1, value: 0 }], delayBeats: clampN(p.echoDelayBeats, 0.25, 1, 0.75), feedback: clampN(p.echoFeedback, 0.2, 0.85, 0.5) },
      }
    }
    case 'cut':
    case 'sequential': {
      // Deliberate cut on a downbeat: ~60 ms outgoing release, ~30 ms incoming attack (click-free).
      const out = 0.125
      const inn = 0.0625
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: out, value: 0 }], low: flat(out, 0), mid: flat(out, 0), high: flat(out, 0) },
        in: { gain: [{ beat: 0, value: 0 }, { beat: inn, value: 1 }], low: flat(out, 0), mid: flat(out, 0), high: flat(out, 0) },
        handoffBeat: 0,
      }
    }
    case 'short_fade': {
      // 4-bar beat-matched S-curve blend with a 1-bar bass handoff in the middle.
      const bass = bassHandoff(B, B / 2, Math.min(4, B / 2))
      return {
        out: { gain: curve(B, 0, B, 1, 0, smooth), low: bass.out, mid: flat(B, 0), high: flat(B, 0) },
        in: { gain: curve(B, 0, B, 0, 1, smooth), low: bass.in, mid: flat(B, 0), high: flat(B, 0) },
        handoffBeat: B / 2,
      }
    }
    case 'unmatched_fade': {
      // Tempos too far apart to beat-match: never overlap two basslines or kicks. The outgoing
      // track loses its lows first and fades; the incoming enters after the low-end has gone.
      return {
        out: { gain: curve(B, B * 0.15, B, 1, 0, smooth), low: curve(B, 0, B * 0.5, 1, 0, lin, true), mid: flat(B, 0), high: flat(B, 0) },
        in: { gain: curve(B, B * 0.45, B, 0, 1, smooth), low: curve(B, B * 0.55, B, 0, 1, lin, true), mid: flat(B, 0), high: flat(B, 0) },
        handoffBeat: B * 0.6,
      }
    }
    case 'long_blend': {
      // Incoming layers in over the first ~40 % (no bass, mids tucked), 1-bar bass handoff at the
      // midpoint, then the outgoing loses mids/highs and fades over the last 40 %.
      const mid = B / 2
      const bass = bassHandoff(B, mid, 4)
      return {
        out: {
          gain: [{ beat: 0, value: 1 }, { beat: B * 0.25, value: HEADROOM }, { beat: B * 0.6, value: HEADROOM }, ...curve(B, B * 0.6, B, HEADROOM, 0, smooth).slice(1)],
          low: bass.out,
          mid: curve(B, B * 0.55, B, 1, 0.35, lin, true),
          high: curve(B, B * 0.7, B, 1, 0.5, lin, true),
        },
        in: {
          gain: [...curve(B, 0, B * 0.4, 0, HEADROOM, smooth).slice(0, -1), { beat: B * 0.6, value: HEADROOM }, { beat: B * 0.75, value: 1 }, { beat: B, value: 1 }],
          low: bass.in,
          mid: curve(B, B * 0.1, B * 0.45, 0.5, 1, lin, true),
          high: curve(B, 0, B * 0.3, 0.7, 1, lin, true),
        },
        handoffBeat: mid,
      }
    }
    case 'bass_swap': {
      // Incoming rises over the first half with lows removed; a crisp 2-beat bass swap on the
      // centre bar line; outgoing (now bass-less) fades over the second half.
      const swap = B / 2
      const bass = bassHandoff(B, swap, 2)
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: swap, value: HEADROOM }, ...curve(B, swap, B, HEADROOM, 0, smooth).slice(1)], low: bass.out, mid: flat(B, 0), high: flat(B, 0) },
        in: { gain: [...curve(B, 0, swap, 0, HEADROOM, smooth).slice(0, -1), { beat: Math.min(B, swap + 4), value: 1 }, { beat: B, value: 1 }], low: bass.in, mid: flat(B, 0), high: flat(B, 0) },
        handoffBeat: swap,
      }
    }
    case 'percussion_led': {
      // Hats/percussion of the incoming first (lows+mids removed), mids blend in, 1-bar bass
      // handoff at the midpoint, outgoing mids tucked while it fades.
      const swap = B / 2
      const bass = bassHandoff(B, swap, 4)
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: swap, value: HEADROOM }, ...curve(B, swap, B, HEADROOM, 0, smooth).slice(1)], low: bass.out, mid: curve(B, swap, B, 1, 0.3, lin, true), high: flat(B, 0) },
        in: {
          gain: [...curve(B, 0, B * 0.2, 0, HEADROOM, smooth).slice(0, -1), { beat: Math.min(B, swap + 4), value: 1 }, { beat: B, value: 1 }],
          low: bass.in,
          mid: curve(B, B * 0.25, B * 0.45, 0, 1, lin, true),
          high: flat(B, 0),
        },
        handoffBeat: swap,
      }
    }
  }
}

export const OVERLAP_BARS: Record<TransitionStyle, number[]> = {
  cut: [0],
  sequential: [0],
  short_fade: [4],
  unmatched_fade: [2],
  long_blend: [16, 32],
  bass_swap: [8, 16],
  percussion_led: [16],
  drop_swap: [8, 16],
  filter_sweep: [16],
  echo_out: [2],
  loop_roll: [2],
  brake: [1],
  scratch_cut: [1],
}

export const BEATMATCHED: ReadonlySet<TransitionStyle> = new Set(['short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'drop_swap', 'filter_sweep'])
/** Styles where the incoming starts on a downbeat after the outgoing's flourish (no overlap of beats). */
export const SLAM: ReadonlySet<TransitionStyle> = new Set(['echo_out', 'loop_roll', 'brake', 'scratch_cut'])
export const ALL_STYLES: TransitionStyle[] = ['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade', 'drop_swap', 'filter_sweep', 'echo_out', 'loop_roll', 'brake', 'scratch_cut']

/** Tempo ratio that maps the incoming track onto the outgoing tempo, trying ½× and 2× (octave errors). */
export function tempoMatch(outBpm: number, inBpm: number): { ratio: number; octave: number } {
  let best = { ratio: outBpm / inBpm, octave: 1 }
  for (const octave of [0.5, 2]) {
    const ratio = outBpm / (inBpm * octave)
    if (Math.abs(ratio - 1) < Math.abs(best.ratio - 1)) best = { ratio, octave }
  }
  return best
}

export function sequentialPlan(a: PlanTrack, b: PlanTrack, reason: string): TransitionPlan {
  const auto = automationFor('sequential', 0)
  return {
    fromItemId: a.itemId,
    toItemId: b.itemId,
    style: 'sequential',
    outCueSec: a.durationSec,
    inCueSec: 0,
    overlapBars: 0,
    tempoRatio: 1,
    tempoRecoveryBars: 0,
    beatSec: 0.5,
    durationSec: 0,
    ...auto,
    costs: { tempo: 0, key: 0, energy: 0, vocals: 0, confidence: 0, truncation: 0, variety: 0, total: 0 },
    risks: [],
    reasons: [reason],
  }
}

/** Is the analysis good enough to beat-match this track? */
export function beatmatchable(s: AnalysisSummary | undefined): boolean {
  // Calibrated on 30 real house/techno tracks vs Beat This!: tracks with a correct tempo scored
  // 0.29–0.56, wrong-octave tempos mostly < 0.06. Downbeat confidence does NOT gate beat-matching.
  return !!s && s.bpm > 0 && s.bpmConf >= 0.3 && s.stable
}

/** All candidate edges A→B (region-level, multi-edge), sorted by total cost. */
export function candidateTransitions(a: PlanTrack, b: PlanTrack, opts: PlannerOptions = DEFAULT_OPTIONS): TransitionPlan[] {
  if (!a.mixable || !b.mixable || !a.summary || !b.summary) {
    const why = !a.mixable || !b.mixable ? 'One of the tracks has no authorized waveform access (standard playback only).' : 'Analysis is not ready yet.'
    return [sequentialPlan(a, b, why)]
  }
  const sa = a.summary
  const sb = b.summary
  const w = opts.weights
  const beatSec = sa.bpm > 0 ? 60 / sa.bpm : 0.5
  const barSec = beatSec * 4
  const { ratio, octave } = sb.bpm > 0 && sa.bpm > 0 ? tempoMatch(sa.bpm, sb.bpm) : { ratio: 1, octave: 1 }
  const deviation = Math.abs(ratio - 1)
  const canMatch = beatmatchable(sa) && beatmatchable(sb) && deviation <= opts.maxTempoDeviation
  const keyDist = sa.keyConf >= 0.1 && sb.keyConf >= 0.1 ? camelotDistance(sa.camelot, sb.camelot) : 3
  const outs = uniqueSorted([...sa.cueOut, ...sa.phrasesSec.filter((t) => t >= sa.durationSec * 0.55)]).filter((t) => t < sa.durationSec - barSec)
  const ins = uniqueSorted([...sb.cueIn, ...sb.phrasesSec.filter((t) => t <= sb.durationSec * 0.35)])
  if (!outs.length) outs.push(Math.max(0, sa.durationSec - 16 * barSec))
  if (!ins.length) ins.push(sb.firstBeat + sb.downbeatPhase * (60 / Math.max(1, sb.bpm)))
  // Never cue into leading silence of the incoming or past the start of the outgoing's tail silence.
  const leadB = Math.max(0, (sb.silentLeadSec ?? 0) - 0.05) // a cue may coincide with where the music starts
  const tailA = sa.durationSec - (sa.silentTailSec ?? 0)
  for (let i = ins.length - 1; i >= 0; i--) if (ins[i] < leadB && ins.length > 1) ins.splice(i, 1)
  if (ins.length === 1 && ins[0] < leadB) {
    const bb = 60 / Math.max(1, sb.bpm)
    ins[0] = sb.firstBeat + Math.ceil((leadB - sb.firstBeat) / (4 * bb)) * 4 * bb
  }

  const inBeat = sb.bpm > 0 ? 60 / sb.bpm : beatSec
  const drops = (sb.dropsSec ?? []).filter((d) => d > 8 * inBeat && d < sb.durationSec * 0.7)
  const styles = (opts.allowedStyles ?? ALL_STYLES).filter(
    (s) => s !== 'sequential' && (BEATMATCHED.has(s) ? canMatch : true),
  )
  const plans: TransitionPlan[] = []
  for (const style of styles) {
    for (const bars of OVERLAP_BARS[style]) {
      const beats = bars * 4
      const overlapSec = beats * beatSec
      for (const outCue of outs.slice(0, 6)) {
        if (outCue + overlapSec > Math.min(sa.durationSec - 0.05, tailA)) continue // must finish before the outgoing ends (or goes silent)
        // Incoming cue candidates. drop_swap: the incoming DROP lands at the end of the overlap.
        // Slam styles: the incoming downbeat (a phrase start, or a drop for energy) lands on the
        // slam beat, so its playback starts that many beats earlier (silently).
        const auto0 = automationFor(style, beats)
        // Offer a drop-aligned finish for a clean blend as well as a dedicated drop swap.
        const dropFinishCues = opts.preferDropLandings && BEATMATCHED.has(style) && sb.downbeatConf >= 0.3 && keyDist <= 2
          ? drops.map((drop) => drop - overlapSec * ratio).filter((cue) => cue >= leadB).slice(0, 2)
          : []
        const inCands =
          style === 'drop_swap'
            ? drops.map((d) => d - overlapSec * ratio).filter((c) => c >= 0)
            : SLAM.has(style)
              ? uniqueSorted([...ins.slice(0, 3), ...drops.slice(0, 2)]).map((c) => c - (auto0.inStartBeat ?? 0) * inBeat).filter((c) => c >= 0)
              : uniqueSorted([...ins.slice(0, 4), ...dropFinishCues])
        for (const inCue of inCands) {
          const inDur = overlapSec * (BEATMATCHED.has(style) ? ratio : 1)
          if (inCue + inDur > sb.durationSec * 0.8) continue
          if (inCue + (auto0.inStartBeat ?? 0) * inBeat < leadB) continue // incoming would start in silence
          const risks: string[] = []
          const reasons: string[] = []
          // ── costs ──
          const tempo = BEATMATCHED.has(style) ? w.tempo * (deviation * 100) : 0
          const keyWeight = style === 'cut' || SLAM.has(style) ? 0.1 : style === 'unmatched_fade' ? 0.4 : Math.min(1.5, bars / 16 + 0.3)
          const key = w.key * keyWeight * Math.max(0, keyDist - 1)
          const levelDiff = Math.abs(sa.lufs - sb.lufs)
          const dir = sb.energyMean - sa.energyMean
          const energy = w.energy * (levelDiff + Math.max(0, -dir * opts.energyDirection) * 2)
          const vocals = w.vocals * sa.vocalOut * sb.vocalIn * Math.min(1, bars / 8)
          // Tempo/beat confidence matters for every beat-matched style; bar-phase (downbeat)
          // uncertainty is a graded penalty that grows with overlap length, never a veto.
          const tempoUnc = 1 - Math.min(1, Math.min(sa.bpmConf, sb.bpmConf) / 0.6)
          const barUnc = 1 - Math.min(1, Math.min(sa.downbeatConf, sb.downbeatConf) / 0.3)
          const confPenalty = BEATMATCHED.has(style) ? 0.6 * tempoUnc + 0.35 * barUnc * Math.min(1, bars / 16) : 0
          const confidence = w.confidence * confPenalty
          // Silence/low-energy guard: never cue into or out of near-silence.
          const eOut = energyAt(sa, outCue)
          const eIn = energyAt(sb, inCue)
          const silence = (eOut !== null && eOut < sa.energyMean - 18 ? 2 : 0) + (eIn !== null && eIn < sb.energyMean - 24 && style !== 'percussion_led' ? 1 : 0)
          // a cut or slam into/out of near-silence is never musical: hard exclusion
          if (silence && (style === 'cut' || SLAM.has(style))) continue
          const skippedOut = Math.max(0, sa.durationSec - (outCue + overlapSec))
          const skippedIn = inCue
          const truncation = w.truncation * (Math.max(0, skippedOut - 32 * barSec) + skippedIn)
          const variety = w.variety * (opts.recentStyles[0] === style ? 1 : opts.recentStyles.slice(0, 3).includes(style) ? 0.4 : 0)
          // style-specific musical penalties
          let musical = 0
          if (style === 'long_blend' && keyDist > 2) musical += 1.5
          if (style === 'cut' && sa.outroBars > 0) musical += 0.3
          if (style === 'percussion_led' && sb.introBars < 8) musical += 0.8
          // Cuts and un-matched fades are last resorts when a beat-matched blend is feasible.
          if (style === 'unmatched_fade') musical += canMatch ? 2.2 : 1.0
          if (style === 'cut') musical += canMatch ? 2.8 : 1.2
          // Creative techniques: priced so a set rotates through them (variety weight) and so the
          // tempo-free ones beat plain cuts/fades when the pair cannot be beat-matched.
          const energetic = opts.energyDirection > 0 ? -0.4 : 0
          const landsOnDrop = drops.some((d) => Math.abs(d - (inCue + (auto0.inStartBeat ?? 0) * inBeat)) < inBeat)
          const finishesOnDrop = opts.preferDropLandings && BEATMATCHED.has(style) && sb.downbeatConf >= 0.3 && keyDist <= 2
            && drops.some((drop) => Math.abs(drop - (inCue + inDur)) <= inBeat / 4)
          if (finishesOnDrop && style !== 'drop_swap' && silence === 0) {
            musical -= 0.6
            reasons.push('incoming drop lands at the end of the blend')
          }
          if (style === 'echo_out') musical += canMatch ? 1.9 : 0.5
          if (style === 'loop_roll') musical += (canMatch ? 1.3 : 0.7) + (landsOnDrop ? -0.3 : 0.2) + energetic
          if (style === 'brake') musical += (canMatch ? 1.6 : 0.8) + energetic
          if (style === 'scratch_cut') musical += (canMatch ? 1.6 : 0.9) + (landsOnDrop ? -0.2 : 0.2)
          if (style === 'filter_sweep') musical += 0.15
          if (style === 'drop_swap') musical += -0.6 + energetic
          musical += silence
          const total = tempo + key + energy + vocals + confidence + truncation + variety + musical
          if (deviation > 0.03 && BEATMATCHED.has(style)) risks.push(`tempo shift ${(deviation * 100).toFixed(1)}%`)
          if (octave !== 1) risks.push(`incoming tempo treated as ${octave === 2 ? 'double' : 'half'}-time`)
          if (keyDist >= 3 && style !== 'cut') risks.push(`key clash risk (${sa.camelot} → ${sb.camelot})`)
          if (sa.vocalOut * sb.vocalIn > 0.25 && bars >= 8) risks.push('possible vocal overlap (heuristic)')
          if (Math.min(sa.downbeatConf, sb.downbeatConf) < 0.15 && style !== 'cut') risks.push('bar phase uncertain (beats aligned)')
          if (silence) risks.push('low-energy region at a cue')
          if (keyDist <= 1) reasons.push(`harmonic match ${sa.camelot} → ${sb.camelot}`)
          if (BEATMATCHED.has(style)) reasons.push(`beat-matched at ${sa.bpm.toFixed(1)} BPM (${((ratio - 1) * 100).toFixed(1)}%)`)
          if (style === 'cut') reasons.push('clean phrase cut on a downbeat')
          if (style === 'drop_swap') reasons.push('incoming build under the outgoing, swap on the drop')
          if (SLAM.has(style)) reasons.push(landsOnDrop ? 'incoming slams in on its drop' : 'incoming enters on a phrase downbeat')
          const auto = auto0
          plans.push({
            fromItemId: a.itemId,
            toItemId: b.itemId,
            style,
            outCueSec: outCue,
            inCueSec: inCue,
            overlapBars: bars,
            tempoRatio: BEATMATCHED.has(style) ? ratio : 1,
            tempoRecoveryBars: BEATMATCHED.has(style) && deviation > 0.002 ? 16 : 0,
            beatSec,
            durationSec: overlapSec,
            handoffBeat: auto.handoffBeat,
            out: auto.out,
            in: auto.in,
            costs: { tempo, key, energy, vocals, confidence, truncation, variety, total },
            risks,
            reasons,
            ...(auto.filter ? { filter: auto.filter } : {}),
            ...(auto.echo ? { echo: auto.echo } : {}),
            ...(auto.outPerf ? { outPerf: auto.outPerf } : {}),
          })
        }
      }
    }
  }
  if (!plans.length) return [sequentialPlan(a, b, 'No feasible cue pair inside the tracks.')]
  plans.sort((p, q) => p.costs.total - q.costs.total || p.outCueSec - q.outCueSec)
  return plans
}

function energyAt(s: AnalysisSummary, t: number): number | null {
  if (!s.phraseEnergy?.length) return null
  let k = -1
  for (let i = 0; i < s.phrasesSec.length; i++) if (s.phrasesSec[i] <= t + 0.05) k = i
  return k >= 0 ? s.phraseEnergy[k] ?? null : null
}

function uniqueSorted(xs: number[]): number[] {
  const out: number[] = []
  for (const x of [...xs].sort((a, b) => a - b)) if (!out.length || Math.abs(out[out.length - 1] - x) > 0.5) out.push(x)
  return out
}

/** Best plan plus up to `k` alternatives with different styles. */
export function bestTransition(a: PlanTrack, b: PlanTrack, opts: PlannerOptions = DEFAULT_OPTIONS, k = 3): { best: TransitionPlan; alternatives: TransitionPlan[] } {
  const all = candidateTransitions(a, b, opts)
  const seen = new Set<TransitionStyle>([all[0].style])
  const alternatives: TransitionPlan[] = []
  for (const p of all.slice(1)) {
    if (alternatives.length >= k) break
    if (!seen.has(p.style)) {
      seen.add(p.style)
      alternatives.push(p)
    }
  }
  return { best: all[0], alternatives }
}

/** Effective seconds of the track that will be heard before the next transition starts. */
export function effectivePlaySec(inCueSec: number, outCueSec: number): number {
  return Math.max(0, outCueSec - inCueSec)
}
