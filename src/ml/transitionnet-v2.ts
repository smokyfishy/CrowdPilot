/**
 * TransitionNet v2 — long-form performance proposer.
 *
 * Input: the MixGraph edge features of the window (as a long blend; src/ml/edge-features.ts) plus
 * bar-level window features from the two recordings (src/mixgen/profile.ts → overlapCompat).
 * Output heads:
 *   strategy   logits over the 7 long-form strategies (masked to the strategies the window supports)
 *   params     12 continuous stage/shape parameters (sigmoid, 0..1) — see LongformParams
 *   cueShift   logits over incoming cue shift {−8, 0, +8 bars}
 * The stage solver (src/mixgen/longform.ts) turns a proposal into executable lanes; the closed loop
 * still renders it against the rule alternatives. Trained by ml/transitionnet/train_v2.py on
 * synthetic known-control renders (evaluation/ml/synth_v2.eval.ts), track-level splits.
 */
import type { AnalysisSummary } from '../dsp/analyze'
import type { TransitionPlan } from '../dj/transitions'
import { edgeFeatures } from './edge-features'
import { mlpForward, type MlpModel } from './mlp'
import type { OverlapCompat } from '../mixgen/profile'
import { PARAM_KEYS, STRATEGIES, type LongformParams, type Strategy } from '../mixgen/longform'

export const WINDOW_FEATURES = [
  'bars64', 'bassConflict', 'vocalClash', 'harmonicClash', 'percOverload', 'energyMismatch', 'outRunsOut', 'inRunsOut',
  'bassSwapRel', 'hasVocalHandoff', 'vocalHandoffRel', 'melodicOk', 'dropAtEnd',
  'bassA1', 'bassA2', 'bassB1', 'bassB2', 'vocA1', 'vocA2', 'vocB1', 'vocB2', 'percA1', 'percA2', 'percB1', 'percB2', 'midA1', 'midA2', 'midB1', 'midB2', 'harmMean',
  'regionBDropInWin', 'regionABreakdownInWin',
] as const

export const CUE_SHIFTS = [-8, 0, 8] as const

const mean = (xs: number[]) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0)

export function windowFeatures(plan: TransitionPlan, c: OverlapCompat): number[] {
  const n = c.perBar.length
  const h = Math.max(1, Math.floor(n / 2))
  const half = (f: (x: OverlapCompat['perBar'][number]) => number, second: boolean) => mean(c.perBar.slice(second ? h : 0, second ? n : h).map(f))
  return [
    plan.overlapBars / 64,
    c.bassConflict, c.vocalClash, c.harmonicClash, c.percOverload, c.energyMismatch, c.outRunsOut / 8, c.inRunsOut / 8,
    c.bassSwapBar / Math.max(1, plan.overlapBars), c.vocalHandoffBar === null ? 0 : 1, c.vocalHandoffBar === null ? 0.5 : c.vocalHandoffBar / Math.max(1, plan.overlapBars), c.melodicLayerOk ? 1 : 0,
    plan.incomingDropSec !== undefined ? 1 : 0,
    half((x) => x.bassA, false), half((x) => x.bassA, true), half((x) => x.bassB, false), half((x) => x.bassB, true),
    half((x) => x.vocA, false), half((x) => x.vocA, true), half((x) => x.vocB, false), half((x) => x.vocB, true),
    half((x) => x.percA, false), half((x) => x.percA, true), half((x) => x.percB, false), half((x) => x.percB, true),
    half((x) => x.midA, false), half((x) => x.midA, true), half((x) => x.midB, false), half((x) => x.midB, true),
    mean(c.perBar.map((x) => x.harm)),
    c.perBar.some((x) => x.regionB === 'drop') ? 1 : 0,
    c.perBar.some((x) => x.regionA === 'breakdown') ? 1 : 0,
  ]
}

/** Full v2 input vector: edge features of the window scored as a long blend + window features. */
export function longformFeatures(sa: AnalysisSummary, sb: AnalysisSummary, plan: TransitionPlan, c: OverlapCompat): number[] {
  const asBlend: TransitionPlan = { ...plan, style: 'long_blend', overlapBars: Math.min(32, plan.overlapBars) }
  return [...edgeFeatures(sa, sb, asBlend), ...windowFeatures(plan, c)]
}

export interface V2Proposal {
  strategy: Strategy
  params: LongformParams
  cueShift: number
  strategyProbs: Record<string, number>
}

export function transitionNetV2Predict(m: MlpModel, x: number[], feasible: Strategy[]): V2Proposal {
  const o = mlpForward(m, x)
  const logits = o.strategy
  const allowed = STRATEGIES.map((s) => feasible.includes(s))
  let best = -1
  let mx = -Infinity
  for (let i = 0; i < STRATEGIES.length; i++) if (allowed[i] && logits[i] > mx) {
    mx = logits[i]
    best = i
  }
  const ex = STRATEGIES.map((_, i) => (allowed[i] ? Math.exp(logits[i] - mx) : 0))
  const z = ex.reduce((p, q) => p + q, 0) || 1
  const params = Object.fromEntries(PARAM_KEYS.map((k, i) => [k, Math.min(1, Math.max(0, o.params[i]))])) as unknown as LongformParams
  const cs = o.cueShift ?? [0, 1, 0]
  const ci = cs.indexOf(Math.max(...cs))
  return {
    strategy: STRATEGIES[best >= 0 ? best : STRATEGIES.indexOf(feasible[0])],
    params,
    cueShift: CUE_SHIFTS[ci] ?? 0,
    strategyProbs: Object.fromEntries(STRATEGIES.map((s, i) => [s, Math.round((ex[i] / z) * 1000) / 1000])),
  }
}
