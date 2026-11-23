/**
 * The learned DJ, wired into live planning:
 *
 *   MixGraph       re-ranks the planner's candidate transitions (cue pair × technique) with a
 *                  learned render-quality model + a human-DJ cue/overlap prior (djmix), on top of
 *                  the deterministic rule cost (which keeps host constraints, tempo/key rules and
 *                  technique variety).
 *   TransitionNet  predicts the continuous automation (fader/EQ/filter/echo trajectories) for
 *                  blends and the action parameters (echo subdivision/feedback/send, roll pattern
 *                  and riser, brake timing, scratch timing/strokes, drop-swap filter) for creative
 *                  techniques.
 *   DJCritic       scores rendered candidate previews (mix-only features) — objective quality and
 *                  artifact probability — and picks the best validated candidate.
 *
 * Every component is optional: when its model is missing, not promoted, or throws, the
 * deterministic planner/templates are used unchanged (music never stops for a model).
 */
import { applyReverbWash, type TechniquePlan } from '../mixgen/techniques'
import type { AnalysisSummary } from '../dsp/analyze'
import { renderTransition } from '../dj/render'
import { BEATMATCHED, SLAM, type TransitionPlan } from '../dj/transitions'
import { applyStyleParams, applyTrajectories, CTRL_CHANNELS, CTRL_POINTS, DEFAULT_PARAMS, PARAM_SPEC, TRAJECTORY_STYLES, type ParamVector, type Trajectories } from './controls'
import { criticFeatures, featureVector } from './critic-features'
import { edgeFeatures } from './edge-features'
import { gbdtPredict, gbdtRaw, type GbdtModel } from './gbdt'
import { mlpForward, type MlpModel } from './mlp'

export interface RegistryEntry {
  file: string
  sha256: string
  promoted: boolean
  version: string
}
export type Registry = Record<'mixgraph_quality' | 'mixgraph_human_cue' | 'transitionnet' | 'critic_quality' | 'critic_artifact', RegistryEntry> & { transitionnet_v2?: RegistryEntry }

export interface DjModels {
  mixgraph?: { quality: GbdtModel & { alpha: number; beta: number }; human: GbdtModel }
  transitionNet?: MlpModel & { echoSubs: number[] }
  critic?: { quality: GbdtModel; artifact: GbdtModel }
  /** TransitionNet v2: long-form strategy + stage parameters + cue shift (src/ml/transitionnet-v2.ts). */
  transitionNetV2?: MlpModel
  /** Which components are active (promoted, or all in experimental mode). */
  active: { mixgraph: boolean; transitionNet: boolean; critic: boolean }
}

export type MlMode = 'promoted' | 'experimental' | 'off'

export async function loadDjModels(mode: MlMode, base = '/models/ml/', fetchFn: typeof fetch = fetch): Promise<DjModels> {
  const none: DjModels = { active: { mixgraph: false, transitionNet: false, critic: false } }
  if (mode === 'off') return none
  try {
    const reg = (await (await fetchFn(`${base}registry.json`)).json()) as Registry
    const enabled = (k: keyof Registry) => !!reg[k] && (mode === 'experimental' || !!reg[k]?.promoted)
    const get = async <T>(k: keyof Registry): Promise<T | undefined> => {
      if (!enabled(k)) return undefined
      try {
        return (await (await fetchFn(base + reg[k]!.file)).json()) as T
      } catch {
        return undefined
      }
    }
    const [mq, mh, tn, cq, ca, tn2] = await Promise.all([
      get<GbdtModel & { alpha: number; beta: number }>('mixgraph_quality'),
      get<GbdtModel>('mixgraph_human_cue'),
      get<MlpModel & { echoSubs: number[] }>('transitionnet'),
      get<GbdtModel>('critic_quality'),
      get<GbdtModel>('critic_artifact'),
      get<MlpModel>('transitionnet_v2'),
    ])
    const m: DjModels = { active: { mixgraph: !!(mq && mh), transitionNet: !!tn, critic: !!(cq && ca) } }
    if (mq && mh) m.mixgraph = { quality: mq, human: mh }
    if (tn) m.transitionNet = tn
    if (cq && ca) m.critic = { quality: cq, artifact: ca }
    if (tn2) m.transitionNetV2 = tn2
    return m
  } catch {
    return none
  }
}

// ───────────────────────── MixGraph ─────────────────────────

/** Same features as ml/mixgraph/exp1_lgbm.py:cue_feats (beat-indexed cue positions + overlap). */
export function humanCueFeatures(sa: AnalysisSummary, sb: AnalysisSummary, plan: Pick<TransitionPlan, 'outCueSec' | 'inCueSec' | 'overlapBars'>): number[] {
  const beatA = 60 / Math.max(1e-3, sa.bpm)
  const beatB = 60 / Math.max(1e-3, sb.bpm)
  const nA = Math.max(1, Math.floor((sa.durationSec - sa.firstBeat) / beatA))
  const nB = Math.max(1, Math.floor((sb.durationSec - sb.firstBeat) / beatB))
  const inBeat = Math.max(0, (plan.inCueSec - sb.firstBeat) / beatB)
  const outStart = Math.max(0, (plan.outCueSec - sa.firstBeat) / beatA)
  const overlap = plan.overlapBars * 4
  const tail = nA - (outStart + Math.max(0, overlap))
  const ib = Math.round(inBeat)
  const ob = Math.round(outStart)
  const ov = Math.round(overlap)
  const mod = (x: number, m: number) => (((x % m) + m) % m === 0 ? 1 : 0)
  const dev = Math.min(...[0.5, 1, 2].map((o) => Math.abs(sa.bpm / (sb.bpm * o) - 1)))
  return [
    Math.log1p(Math.max(0, inBeat)), inBeat / Math.max(1, nB),
    mod(ib, 4), mod(ib, 8), mod(ib, 16), mod(ib, 32),
    outStart / Math.max(1, nA), mod(ob, 4), mod(ob, 16), mod(ob, 32),
    Math.log1p(Math.max(0, tail)), tail / Math.max(1, nA), Math.log1p(Math.max(0, overlap)),
    mod(ov, 16), mod(ov, 32), overlap < 0 ? 1 : 0,
    sa.bpm, dev, Math.log1p(nA), Math.log1p(nB),
  ]
}

export interface Ranked {
  plan: TransitionPlan
  score: number
  predictedSeverity: number
  humanLogit: number
}

/** Learned re-ranking of planner candidates (lower score = better). Hard constraints are not touched: only feasible candidates are scored. */
export function mixgraphRank(cands: TransitionPlan[], sa: AnalysisSummary, sb: AnalysisSummary, m: NonNullable<DjModels['mixgraph']>): Ranked[] {
  const out = cands.map((plan) => {
    const humanLogit = gbdtRaw(m.human, humanCueFeatures(sa, sb, plan))[0]
    const predictedSeverity = gbdtPredict(m.quality, [...edgeFeatures(sa, sb, plan), humanLogit])
    return { plan, predictedSeverity, humanLogit, score: plan.costs.total + m.quality.alpha * predictedSeverity - m.quality.beta * humanLogit }
  })
  out.sort((p, q) => p.score - q.score || p.plan.outCueSec - q.plan.outCueSec)
  return out
}

// ───────────────────────── TransitionNet ─────────────────────────

export interface TnOutput {
  trajectories: Trajectories
  params: ParamVector
}

export function transitionNetPredict(tn: MlpModel & { echoSubs: number[] }, sa: AnalysisSummary, sb: AnalysisSummary, plan: TransitionPlan): TnOutput {
  const o = mlpForward(tn, edgeFeatures(sa, sb, plan))
  const traj = {} as Trajectories
  CTRL_CHANNELS.forEach((c, k) => {
    const raw = o.traj.slice(k * CTRL_POINTS, (k + 1) * CTRL_POINTS)
    traj[c] = c === 'filterOut' || c === 'filterIn' ? raw.map(Math.tanh) : raw.map((v) => 1 / (1 + Math.exp(-v)))
  })
  const params = { ...DEFAULT_PARAMS }
  PARAM_SPEC.forEach(([name, lo, hi], k) => {
    params[name] = lo + (hi - lo) * o.params[k]
  })
  // discrete heads: echo subdivision and roll pattern (argmax)
  const argmax = (v: number[]) => v.reduce((b, x, i) => (x > v[b] ? i : b), 0)
  params.echoDelayBeats = tn.echoSubs[argmax(o.echoSub)]
  params.rollPattern = argmax(o.rollPattern)
  return { trajectories: traj, params }
}

/** Plan with TransitionNet's predicted controls (cuts keep their fixed click-free envelope). */
export function applyTransitionNet(plan: TransitionPlan, out: TnOutput): TransitionPlan {
  if (TRAJECTORY_STYLES.has(plan.style)) return { ...applyTrajectories(plan, out.trajectories), reasons: [...plan.reasons, 'TransitionNet automation'] }
  if (SLAM.has(plan.style) || plan.style === 'drop_swap') return { ...applyStyleParams(plan, out.params), reasons: [...plan.reasons, 'TransitionNet technique parameters'] }
  return plan
}

// ───────────────────────── DJCritic ─────────────────────────

export interface CriticScore {
  quality: number
  artifact: number
  previewDefects: string[]
  ms: number
}

/**
 * Renders a candidate preview (mono, `rate`) from cropped deck audio and scores it.
 * `outAudio`/`inAudio` start at `outStartSec`/`inStartSec` of their tracks.
 */
export function criticScore(
  m: NonNullable<DjModels['critic']>,
  plan: TransitionPlan,
  outAudio: Float32Array,
  outStartSec: number,
  inAudio: Float32Array,
  inStartSec: number,
  rate: number,
  trims: { out: number; in: number },
): CriticScore {
  const t0 = performance.now()
  const local: TransitionPlan = { ...plan, outCueSec: plan.outCueSec - outStartSec, inCueSec: plan.inCueSec - inStartSec, incomingDropSec: plan.incomingDropSec === undefined ? undefined : plan.incomingDropSec - inStartSec }
  const wash = (plan as TechniquePlan).tech?.reverb
  const r = renderTransition({ rate, out: [outAudio], in: [inAudio], plan: local, outTrimDb: trims.out, inTrimDb: trims.in, preRollSec: 8, postRollSec: 8, stems: !!wash })
  if (wash) applyReverbWash(r, plan.beatSec, wash)
  const ts = r.transitionStartSample
  const te = ts + Math.round(plan.durationSec * rate)
  const f = criticFeatures({ mix: r.channels[0], rate, t0: ts, t1: te, beatSec: plan.beatSec })
  const x = [...featureVector(f), SLAM.has(plan.style) ? 1 : 0, BEATMATCHED.has(plan.style) ? 1 : 0, plan.overlapBars]
  const previewDefects: string[] = []
  if (r.channels[0].some((sample) => !Number.isFinite(sample))) previewDefects.push('non-finite audio')
  if (f.silenceSec >= 1) previewDefects.push('gap of at least 1 second')
  if (r.clippedSamples > 0 || r.channels[0].some((sample) => Math.abs(sample) >= 1)) previewDefects.push('clipped preview')
  if (r.limiterGainReductionDb > 6) previewDefects.push('limiter reduction over 6 dB')
  return { quality: gbdtPredict(m.quality, x), artifact: gbdtPredict(m.artifact, x), previewDefects, ms: performance.now() - t0 }
}

/** DJCritic on an already-rendered mono preview (the closed loop renders once and reuses it). */
export function criticFromMix(m: NonNullable<DjModels['critic']>, plan: TransitionPlan, mix: Float32Array, rate: number, t0: number, t1: number): { quality: number; artifact: number } {
  const c0 = Math.max(0, t0 - Math.round(8.5 * rate))
  const c1 = Math.min(mix.length, Math.max(t1, t0 + rate) + Math.round(8.5 * rate))
  const f = criticFeatures({ mix: mix.subarray(c0, c1), rate, t0: t0 - c0, t1: t1 - c0, beatSec: plan.beatSec })
  const x = [...featureVector(f), SLAM.has(plan.style) ? 1 : 0, BEATMATCHED.has(plan.style) ? 1 : 0, Math.min(32, plan.overlapBars)]
  return { quality: gbdtPredict(m.quality, x), artifact: gbdtPredict(m.artifact, x) }
}

/** Audio window a preview needs from each deck (seconds in each track's own timeline). */
export function previewWindow(plan: TransitionPlan): { out: [number, number]; in: [number, number] } {
  const pre = 8
  const post = 8
  const perfPad = 0
  return {
    out: [Math.max(0, plan.outCueSec - pre - 0.5), plan.outCueSec + plan.durationSec + post + perfPad + 1],
    in: [Math.max(0, plan.inCueSec - 0.5), plan.inCueSec + (plan.durationSec + post) * Math.max(1, plan.tempoRatio) + 1],
  }
}
