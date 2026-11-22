/**
 * MixGraph transition layer: enumerates REGION-level transition candidates
 * between two tracks (multiple edges per pair: different cue points, overlap
 * lengths and techniques), scores them with explicit weighted costs, and
 * emits an executable plan (beat-relative automation curves) plus an
 * explanation. Deterministic; no learned model is involved in this baseline.
 */
import type { AnalysisSummary } from '../dsp/analyze'
import { camelotDistance } from '../dsp/key'

export type TransitionStyle = 'cut' | 'short_fade' | 'long_blend' | 'bass_swap' | 'percussion_led' | 'unmatched_fade' | 'sequential'

export const STYLE_LABEL: Record<TransitionStyle, string> = {
  cut: 'Phrase-aligned cut',
  short_fade: 'Short beat-matched fade',
  long_blend: 'Long phrase blend',
  bass_swap: 'Bass swap',
  percussion_led: 'Percussion-led blend',
  unmatched_fade: 'Quick fade (no beat-match)',
  sequential: 'Standard playback (no mix)',
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

export const DEFAULT_WEIGHTS: PlannerWeights = { tempo: 0.25, key: 1.0, energy: 0.08, vocals: 1.2, confidence: 1.0, truncation: 0.02, variety: 0.4 }

export interface PlannerOptions {
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

/** Equal-power fade sampled every beat (Web Audio interpolates linearly between points). */
function eqPower(fromBeat: number, toBeat: number, rising: boolean, steps = 16): CurvePoint[] {
  const pts: CurvePoint[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const v = rising ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2)
    pts.push({ beat: fromBeat + t * (toBeat - fromBeat), value: v })
  }
  return pts
}

function step(beats: number, at: number, from: number, to: number, rampBeats = 0.5): CurvePoint[] {
  return [
    { beat: 0, value: from },
    { beat: Math.max(0, at - rampBeats / 2), value: from },
    { beat: Math.min(beats, at + rampBeats / 2), value: to },
    { beat: beats, value: to },
  ]
}

/** Automation templates per style; `beats` = overlap length in beats. */
export function automationFor(style: TransitionStyle, beats: number): { out: DeckAutomation; in: DeckAutomation; handoffBeat: number } {
  const B = Math.max(beats, 0)
  switch (style) {
    case 'cut':
    case 'sequential': {
      const tiny = 0.05 // ~25 ms anti-click ramp
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: tiny, value: 0 }], low: flat(tiny, 0), mid: flat(tiny, 0), high: flat(tiny, 0) },
        in: { gain: [{ beat: 0, value: 0 }, { beat: tiny, value: 1 }], low: flat(tiny, 0), mid: flat(tiny, 0), high: flat(tiny, 0) },
        handoffBeat: 0,
      }
    }
    case 'short_fade':
    case 'unmatched_fade':
      return {
        out: { gain: eqPower(0, B, false), low: step(B, B / 2, 0, KILL, B / 4), mid: flat(B, 0), high: flat(B, 0) },
        in: { gain: eqPower(0, B, true), low: step(B, B / 2, KILL, 0, B / 4), mid: flat(B, 0), high: flat(B, 0) },
        handoffBeat: B / 2,
      }
    case 'long_blend': {
      const half = B / 2
      return {
        out: {
          gain: [{ beat: 0, value: 1 }, { beat: half, value: 1 }, ...eqPower(half, B, false, 12).slice(1)],
          low: step(B, half, 0, KILL, 1),
          mid: [{ beat: 0, value: 0 }, { beat: half, value: 0 }, { beat: B * 0.85, value: -12 }, { beat: B, value: -24 }],
          high: [{ beat: 0, value: 0 }, { beat: B * 0.75, value: 0 }, { beat: B, value: -18 }],
        },
        in: {
          gain: [...eqPower(0, half, true, 12), { beat: B, value: 1 }],
          low: step(B, half, KILL, 0, 1),
          mid: [{ beat: 0, value: -12 }, { beat: half * 0.75, value: 0 }, { beat: B, value: 0 }],
          high: [{ beat: 0, value: -6 }, { beat: half * 0.5, value: 0 }, { beat: B, value: 0 }],
        },
        handoffBeat: half,
      }
    }
    case 'bass_swap': {
      const swap = B / 2
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: swap, value: 1 }, ...eqPower(swap, B, false, 8).slice(1)], low: step(B, swap, 0, KILL, 0.5), mid: flat(B, 0), high: flat(B, 0) },
        in: { gain: [...eqPower(0, swap, true, 8), { beat: B, value: 1 }], low: step(B, swap, KILL, 0, 0.5), mid: flat(B, 0), high: flat(B, 0) },
        handoffBeat: swap,
      }
    }
    case 'percussion_led': {
      const swap = B / 2
      return {
        out: { gain: [{ beat: 0, value: 1 }, { beat: swap, value: 1 }, ...eqPower(swap, B, false, 8).slice(1)], low: step(B, swap, 0, KILL, 0.5), mid: [{ beat: 0, value: 0 }, { beat: swap, value: 0 }, { beat: B, value: -18 }], high: flat(B, 0) },
        in: {
          gain: [...eqPower(0, swap / 2, true, 6), { beat: B, value: 1 }],
          low: step(B, swap, KILL, 0, 0.5),
          mid: [{ beat: 0, value: KILL }, { beat: swap * 0.75, value: KILL }, { beat: swap, value: 0 }, { beat: B, value: 0 }],
          high: flat(B, 0),
        },
        handoffBeat: swap,
      }
    }
  }
}

const OVERLAP_BARS: Record<TransitionStyle, number[]> = {
  cut: [0],
  sequential: [0],
  short_fade: [4],
  unmatched_fade: [2],
  long_blend: [16, 32],
  bass_swap: [8, 16],
  percussion_led: [16],
}

const BEATMATCHED: ReadonlySet<TransitionStyle> = new Set(['short_fade', 'long_blend', 'bass_swap', 'percussion_led'])

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
  return !!s && s.bpm > 0 && s.bpmConf >= 0.35 && s.stable
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

  const styles = (opts.allowedStyles ?? (['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade'] as TransitionStyle[])).filter(
    (s) => s !== 'sequential' && (BEATMATCHED.has(s) ? canMatch : true),
  )
  const plans: TransitionPlan[] = []
  for (const style of styles) {
    for (const bars of OVERLAP_BARS[style]) {
      const beats = bars * 4
      const overlapSec = beats * beatSec
      for (const outCue of outs.slice(0, 6)) {
        if (outCue + overlapSec > sa.durationSec - 0.05) continue // must finish before the outgoing ends
        for (const inCue of ins.slice(0, 4)) {
          const inDur = overlapSec * (BEATMATCHED.has(style) ? ratio : 1)
          if (inCue + inDur > sb.durationSec * 0.8) continue
          const risks: string[] = []
          const reasons: string[] = []
          // ── costs ──
          const tempo = BEATMATCHED.has(style) ? w.tempo * (deviation * 100) : 0
          const keyWeight = style === 'cut' ? 0.1 : style === 'unmatched_fade' ? 0.4 : Math.min(1.5, bars / 16 + 0.3)
          const key = w.key * keyWeight * Math.max(0, keyDist - 1)
          const levelDiff = Math.abs(sa.lufs - sb.lufs)
          const dir = sb.energyMean - sa.energyMean
          const energy = w.energy * (levelDiff + Math.max(0, -dir * opts.energyDirection) * 2)
          const vocals = w.vocals * sa.vocalOut * sb.vocalIn * Math.min(1, bars / 8)
          const confPenalty = BEATMATCHED.has(style) ? (1 - Math.min(sa.bpmConf, sb.bpmConf)) + (1 - Math.min(sa.downbeatConf, sb.downbeatConf)) * 0.5 : 0
          const confidence = w.confidence * confPenalty * Math.min(1, bars / 8)
          const skippedOut = Math.max(0, sa.durationSec - (outCue + overlapSec))
          const skippedIn = inCue
          const truncation = w.truncation * (Math.max(0, skippedOut - 32 * barSec) + skippedIn)
          const variety = w.variety * (opts.recentStyles[0] === style ? 1 : opts.recentStyles.slice(0, 3).includes(style) ? 0.4 : 0)
          // style-specific musical penalties
          let musical = 0
          if (style === 'long_blend' && keyDist > 2) musical += 1.5
          if (style === 'cut' && sa.outroBars > 0) musical += 0.3
          if (style === 'percussion_led' && sb.introBars < 8) musical += 0.8
          if (style === 'unmatched_fade') musical += 1.2
          if (style === 'cut') musical += 1.0
          const total = tempo + key + energy + vocals + confidence + truncation + variety + musical
          if (deviation > 0.03 && BEATMATCHED.has(style)) risks.push(`tempo shift ${(deviation * 100).toFixed(1)}%`)
          if (octave !== 1) risks.push(`incoming tempo treated as ${octave === 2 ? 'double' : 'half'}-time`)
          if (keyDist >= 3 && style !== 'cut') risks.push(`key clash risk (${sa.camelot} → ${sb.camelot})`)
          if (sa.vocalOut * sb.vocalIn > 0.25 && bars >= 8) risks.push('possible vocal overlap (heuristic)')
          if (Math.min(sa.downbeatConf, sb.downbeatConf) < 0.15 && style !== 'cut') risks.push('downbeat uncertain')
          if (keyDist <= 1) reasons.push(`harmonic match ${sa.camelot} → ${sb.camelot}`)
          if (BEATMATCHED.has(style)) reasons.push(`beat-matched at ${sa.bpm.toFixed(1)} BPM (${((ratio - 1) * 100).toFixed(1)}%)`)
          if (style === 'cut') reasons.push('clean phrase cut on a downbeat')
          const auto = automationFor(style, beats)
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
          })
        }
      }
    }
  }
  if (!plans.length) return [sequentialPlan(a, b, 'No feasible cue pair inside the tracks.')]
  plans.sort((p, q) => p.costs.total - q.costs.total || p.outCueSec - q.outCueSec)
  return plans
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
