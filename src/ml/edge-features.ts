/**
 * Candidate-transition (edge) features for MixGraph and the TransitionNet context. Computed from
 * the two tracks' analysis summaries and a candidate plan only — no audio — so they are cheap
 * enough to score every candidate the planner generates.
 */
import type { AnalysisSummary } from '../dsp/analyze'
import { camelotDistance } from '../dsp/key'
import { ALL_STYLES, BEATMATCHED, beatmatchable, SLAM, tempoMatch, type TransitionPlan } from '../dj/transitions'

export const STYLE_INDEX = ALL_STYLES

export const EDGE_FEATURES = [
  'bpmA', 'tempoDevPct', 'octave', 'canMatch',
  'keyDist', 'keyConfMin', 'bpmConfMin', 'dbConfMin',
  'lufsDiff', 'energyDiff', 'vocalOutA', 'vocalInB', 'vocalProduct',
  'introBarsB', 'outroBarsA',
  'eOutRel', 'eInRel',
  'outPos', 'inPos', 'outBarsLeft', 'inCueBars',
  'outPhraseDist', 'inPhraseDist', 'outBarPhase', 'inBarPhase',
  'landsOnDrop', 'nDropsB', 'nearBreakdownB',
  'overlapBars', 'beatmatched', 'slam',
  'ruleTempo', 'ruleKey', 'ruleEnergy', 'ruleVocals', 'ruleConfidence', 'ruleTruncation', 'ruleVariety', 'ruleTotal',
  ...ALL_STYLES.map((s) => `style_${s}`),
] as const

function energyAt(s: AnalysisSummary, t: number): number | null {
  if (!s.phraseEnergy?.length) return null
  let k = -1
  for (let i = 0; i < s.phrasesSec.length; i++) if (s.phrasesSec[i] <= t + 0.05) k = i
  return k >= 0 ? s.phraseEnergy[k] ?? null : null
}

const nearestDist = (xs: number[], t: number) => xs.reduce((m, x) => Math.min(m, Math.abs(x - t)), Infinity)

export function edgeFeatures(sa: AnalysisSummary, sb: AnalysisSummary, plan: TransitionPlan): number[] {
  const { ratio, octave } = sa.bpm > 0 && sb.bpm > 0 ? tempoMatch(sa.bpm, sb.bpm) : { ratio: 1, octave: 1 }
  const beatA = sa.bpm > 0 ? 60 / sa.bpm : 0.5
  const beatB = sb.bpm > 0 ? 60 / sb.bpm : 0.5
  const barA = 4 * beatA
  const barB = 4 * beatB
  const keyDist = sa.keyConf >= 0.1 && sb.keyConf >= 0.1 ? camelotDistance(sa.camelot, sb.camelot) : 3
  const eOut = energyAt(sa, plan.outCueSec)
  const eIn = energyAt(sb, plan.inCueSec)
  const inLand = plan.inCueSec + (SLAM.has(plan.style) ? plan.handoffBeat * beatB : 0)
  const drops = sb.dropsSec ?? []
  const phase = (t: number, first: number, bar: number, dbPhase: number, beat: number) => {
    const p = (((t - first - dbPhase * beat) / bar) % 1 + 1) % 1
    return Math.min(p, 1 - p)
  }
  const c = plan.costs
  const v: number[] = [
    sa.bpm,
    Math.abs(ratio - 1) * 100,
    octave === 1 ? 0 : 1,
    beatmatchable(sa) && beatmatchable(sb) && Math.abs(ratio - 1) <= 0.06 ? 1 : 0,
    keyDist,
    Math.min(sa.keyConf, sb.keyConf),
    Math.min(sa.bpmConf, sb.bpmConf),
    Math.min(sa.downbeatConf, sb.downbeatConf),
    sb.lufs - sa.lufs,
    sb.energyMean - sa.energyMean,
    sa.vocalOut,
    sb.vocalIn,
    sa.vocalOut * sb.vocalIn,
    sb.introBars,
    sa.outroBars,
    eOut === null ? 0 : eOut - sa.energyMean,
    eIn === null ? 0 : eIn - sb.energyMean,
    plan.outCueSec / Math.max(1, sa.durationSec),
    plan.inCueSec / Math.max(1, sb.durationSec),
    (sa.durationSec - plan.outCueSec) / barA,
    plan.inCueSec / barB,
    Math.min(8, nearestDist(sa.phrasesSec, plan.outCueSec) / barA),
    Math.min(8, nearestDist(sb.phrasesSec, plan.inCueSec) / barB),
    phase(plan.outCueSec, sa.firstBeat, barA, sa.downbeatPhase, beatA),
    phase(plan.inCueSec, sb.firstBeat, barB, sb.downbeatPhase, beatB),
    drops.some((d) => Math.abs(d - inLand) < beatB) ? 1 : 0,
    drops.length,
    (sb.breakdownsSec ?? []).some((d) => Math.abs(d - plan.inCueSec) < 4 * barB) ? 1 : 0,
    plan.overlapBars,
    BEATMATCHED.has(plan.style) ? 1 : 0,
    SLAM.has(plan.style) ? 1 : 0,
    c.tempo, c.key, c.energy, c.vocals, c.confidence, c.truncation, c.variety, c.total,
    ...ALL_STYLES.map((s) => (s === plan.style ? 1 : 0)),
  ]
  return v.map((x) => (Number.isFinite(x) ? x : 0))
}
