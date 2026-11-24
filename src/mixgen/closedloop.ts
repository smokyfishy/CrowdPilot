/**
 * Closed-loop transition optimisation: generate → render → evaluate → refine → re-plan.
 *
 * For every transition of the planner's current best set:
 *   1. take several musically viable candidates of that pair (cue regions, 16/32/48/64 bars, legacy
 *      techniques) from the global planner's edge list;
 *   2. give long-form candidates several performance strategies (TransitionNet v2 proposal first when
 *      its checkpoint is loaded, then the rule-feasible strategies);
 *   3. render each with the production renderer (16 kHz mono preview with post-fader deck signals,
 *      8 bars before → overlap → 8 bars after);
 *   4. measure it (src/mixgen/audio-quality.ts; + DJCritic as a capped, separately logged term);
 *   5. reject hard failures, refine the best (cue ±1 phrase, overlap ±16 bars, vocal/effect/bass
 *      parameters) and re-render;
 *   6. write the measured cost of EVERY evaluated slot back into the global planner, add a penalty to
 *      pairs whose best transition still sounds poor, and re-plan the whole set (which may change cues,
 *      overlap, technique, neighbours or the order itself).
 * Bounded by a preview budget; previews are cached by (slot, controls).
 */
import { renderTransition } from '../dj/render'
import type { TransitionPlan } from '../dj/transitions'
import { applyDeckEdits, applyReverbWash, routeStems, type StemInfo, type TechniquePlan } from './techniques'
import { evaluateTransition, type QualityResult } from './audio-quality'
import { buildPerformance, feasibleStrategies, longformEligible, NEUTRAL, type LongformParams, type Strategy } from './longform'
import { overlapCompat } from './profile'
import { edgeSig, planSet, type Edge, type PlannedSet, type SetPlanOptions, type SetTrack } from './setplan'
import { validPlan } from './ml'
import type { ResolvedSpec } from './spec'
import { avoided, matchesAny, techniquesOfStrategy } from './technique-match'

export const PREVIEW_RATE = 16000

export interface PreviewAudioHost {
  /** Whole-track mono audio at PREVIEW_RATE. */
  audio(key: string): Promise<Float32Array>
  /** Mono stems at PREVIEW_RATE (local worker only): vocals + instrumental, plus drums/bass/other for 4-stem separations. */
  stems?(key: string): Promise<{ vocals: Float32Array; inst: Float32Array; drums?: Float32Array; bass?: Float32Array; other?: Float32Array } | null>
}

export interface Proposal {
  strategy: Strategy
  params: Partial<LongformParams>
  source: 'transitionnet-v2'
  /** Incoming cue shift in bars (TransitionNet v2 cue head); 0 = keep the planner's cue. */
  cueShift?: number
}

export interface ClosedLoopOptions {
  rounds?: number
  /** Max previews rendered in total. */
  budget?: number
  candidatesPerEdge?: number
  strategiesPerCandidate?: number
  refinements?: number
  /** Score above which an edge counts as poor (pair penalty → re-plan). */
  poorThreshold?: number
  /** Score below which refinement is skipped. */
  goodThreshold?: number
  /** Planner cost units per quality-score unit. */
  lambda?: number
  critic?: (plan: TransitionPlan, mix: Float32Array, rate: number, t0: number, t1: number) => { quality: number; artifact: number } | null
  /** TransitionNet v2 proposal for a long-form window, or null when unavailable. */
  propose?: (ctx: { a: SetTrack; b: SetTrack; base: TransitionPlan }) => Proposal | null
  /** TransitionNet v1: learned fader/EQ/filter trajectories for a short beat-matched template (validated), or null. */
  tnV1?: (p: TransitionPlan, a: SetTrack, b: SetTrack) => TransitionPlan | null
  /** MixGraph human cue prior: the pair's candidate with the most human-like cue/overlap, or null. */
  humanPick?: (list: Edge[], a: SetTrack, b: SetTrack) => Edge | null
  stems?: Map<string, StemInfo>
  log?: (m: string) => void
  progress?: (done: number, total: number, detail: string) => void
  signal?: AbortSignal
  /** Measurements shared across calls (browser: review step → render step of the same job). */
  memory?: ClosedLoopMemory
  /** Parallel off-thread preview measurement (browser worker pool). */
  evaluator?: PreviewEvaluator
}

export interface ClosedLoopMemory {
  cache: Map<string, QualityResult>
  measured: Map<string, { base: number; plan: TransitionPlan; q: QualityResult; label: string }>
  scores: number[]
  pairPenalty: Map<string, number>
  extraEdges: Map<string, TransitionPlan[]>
  previews: number
  /** Learned-model usage accumulated over every call that shares this memory (review + render passes). */
  modelUse?: ClosedLoopResult['modelUse']
  /** The last finished result: a later pass that keeps exactly this order reuses it (no second search). */
  result?: ClosedLoopResult
}

export function newClosedLoopMemory(): ClosedLoopMemory {
  return { cache: new Map(), measured: new Map(), scores: [], pairPenalty: new Map(), extraEdges: new Map(), previews: 0 }
}

export interface EvaluatedCandidate {
  pair: string
  sig: string
  label: string
  score: number
  hardFail: boolean
  failures: string[]
  components: Record<string, number>
  overlapBars: number
  strategy?: string
  source: 'rules' | 'transitionnet-v2' | 'transitionnet-v1' | 'legacy'
  round: number
  refined: boolean
  critic?: { quality: number; artifact: number }
}

export interface ClosedLoopResult {
  set: PlannedSet
  rounds: number
  previews: number
  evaluated: EvaluatedCandidate[]
  /** Per final transition: chosen measured quality (undefined if never rendered — budget). */
  chosen: Array<{ pair: string; sig: string; score?: number; hardFail?: boolean; label: string; metrics?: QualityResult['metrics']; components?: Record<string, number> }>
  replans: Array<{ round: number; order: string[]; cost: number; poorPairs: string[] }>
  notes: string[]
  /** Per learned model: candidates it produced that were rendered and measured, and how many ended in the final set. */
  modelUse: { transitionnetV2: { proposals: number; rendered: number; final: number }; transitionnetV1: { variants: number; rendered: number; final: number }; humanCue: { candidates: number; rendered: number; final: number }; critic: { scored: number } }
  /** Wall-clock split of the loop (ms): audio/stem loading, preview rendering, measurement, planning. */
  timing?: { audioMs: number; renderMs: number; measureMs: number; totalMs: number }
}

interface Measured {
  /** Planner cost the measurement corrects (predicted cost of the slot it was rendered for). */
  base: number
  plan: TransitionPlan
  q: QualityResult
  label: string
}

const labelOf = (p: TransitionPlan) =>
  p.performance ? `${p.overlapBars}-bar ${p.performance.strategy}${p.performance.source === 'transitionnet-v2' ? ' (TN v2)' : ''}` : `${p.overlapBars}-bar ${p.style}${(p as TechniquePlan).tech ? ` + ${(p as TechniquePlan).tech!.technique}` : ''}${(p as TransitionPlan & { mlSource?: string }).mlSource === 'transitionnet' ? ' (TN v1)' : ''}`

type StemSet = { vocals: Float32Array; inst: Float32Array; drums?: Float32Array; bass?: Float32Array; other?: Float32Array }

/** The audio a preview needs: both decks (and stems) cropped to the window, with crop offsets (samples). */
export interface PreviewCrops {
  A: Float32Array
  B: Float32Array
  /** Sample offset of A / B in their tracks. */
  ca0: number
  cb0: number
  o0: number
  o1: number
  i0: number
  i1: number
  sa?: StemSet
  sb?: StemSet
}

/** Crops what a preview of `plan` reads (deck edits read anywhere in the track, so those keep the full track). */
export async function previewCrops(plan: TransitionPlan, a: SetTrack, b: SetTrack, host: PreviewAudioHost): Promise<PreviewCrops> {
  const rate = PREVIEW_RATE
  const pre = 8 * a.summary.barSec
  const post = 8 * a.summary.barSec
  const tech = (plan as TechniquePlan).tech
  const fullA = await host.audio(a.key)
  const fullB = await host.audio(b.key)
  const o0 = Math.max(0, Math.floor((plan.outCueSec - pre - 1) * rate))
  const o1 = Math.min(fullA.length, Math.ceil((plan.outCueSec + plan.durationSec + post + 1) * rate))
  const i0 = Math.max(0, Math.floor((plan.inCueSec - 1) * rate))
  const i1 = Math.min(fullB.length, Math.ceil((plan.inCueSec + (plan.durationSec + post) * Math.max(1, plan.tempoRatio) + 2) * rate))
  const editsA = !!tech?.deckEdits?.out?.length
  const editsB = !!tech?.deckEdits?.in?.length
  const [ca0, ca1, cb0, cb1] = [editsA ? 0 : o0, editsA ? fullA.length : o1, editsB ? 0 : i0, editsB ? fullB.length : i1]
  const crops: PreviewCrops = { A: fullA.subarray(ca0, ca1), B: fullB.subarray(cb0, cb1), ca0, cb0, o0, o1, i0, i1 }
  if (tech?.stems && host.stems) {
    const [sa, sb] = [await host.stems(a.key), await host.stems(b.key)]
    const cut = (x: StemSet, c0: number, c1: number): StemSet => ({ vocals: x.vocals.subarray(c0, c1), inst: x.inst.subarray(c0, c1), ...(x.drums && x.bass && x.other ? { drums: x.drums.subarray(c0, c1), bass: x.bass.subarray(c0, c1), other: x.other.subarray(c0, c1) } : {}) })
    if (sa && sb) {
      crops.sa = cut(sa, ca0, ca1)
      crops.sb = cut(sb, cb0, cb1)
    }
  }
  return crops
}

/** Renders a preview from crops (pure: runs on the page or in a preview worker). */
export function renderPreviewCropped(plan: TransitionPlan, a: { trimDb: number; summary: { barSec: number } }, b: { trimDb: number }, c: PreviewCrops) {
  const rate = PREVIEW_RATE
  const pre = 8 * a.summary.barSec
  const post = 8 * a.summary.barSec
  const tech = (plan as TechniquePlan).tech
  let A = [c.A]
  let Bd = [c.B]
  if (tech?.stems && c.sa && c.sb) {
    const arr = (x: StemSet) => ({ vocals: [x.vocals], inst: [x.inst], ...(x.drums && x.bass && x.other ? { drums: [x.drums], bass: [x.bass], other: [x.other] } : {}) })
    const sA = c.ca0 / rate
    const sB = c.cb0 / rate
    A = routeStems(A, arr(c.sa), rate, plan.outCueSec - 0.1 - sA, plan.outCueSec + plan.durationSec + 0.1 - sA, (t) => (t + sA - plan.outCueSec) / plan.beatSec, tech.stems.out)
    Bd = routeStems(Bd, arr(c.sb), rate, plan.inCueSec - 0.1 - sB, plan.inCueSec + plan.durationSec * plan.tempoRatio + 0.1 - sB, (t) => (t + sB - plan.inCueSec) / (plan.beatSec * plan.tempoRatio), tech.stems.in)
  }
  if (tech?.deckEdits?.out?.length) A = applyDeckEdits(A, rate, tech.deckEdits.out)
  if (tech?.deckEdits?.in?.length) Bd = applyDeckEdits(Bd, rate, tech.deckEdits.in)
  const outCrop = A[0].subarray(c.o0 - c.ca0, c.o1 - c.ca0)
  const inCrop = Bd[0].subarray(c.i0 - c.cb0, c.i1 - c.cb0)
  const local: TransitionPlan = {
    ...plan,
    outCueSec: plan.outCueSec - c.o0 / rate,
    inCueSec: plan.inCueSec - c.i0 / rate,
    incomingDropSec: plan.incomingDropSec === undefined ? undefined : plan.incomingDropSec - c.i0 / rate,
  }
  const r = renderTransition({ rate, out: [outCrop], in: [inCrop], plan: local, outTrimDb: a.trimDb, inTrimDb: b.trimDb, preRollSec: pre, postRollSec: post, stems: true })
  if (tech?.reverb) applyReverbWash(r, plan.beatSec, tech.reverb)
  const t0 = r.transitionStartSample
  const t1 = t0 + Math.round(plan.durationSec * rate)
  const rawStart = Math.round((local.inCueSec + plan.durationSec * plan.tempoRatio) * rate)
  return {
    mix: r.channels[0],
    stemA: r.stemA!,
    stemB: r.stemB!,
    rate,
    t0,
    t1,
    clippedSamples: r.clippedSamples,
    peak: r.peak,
    limiterGainReductionDb: r.limiterGainReductionDb,
    rawIn: inCrop.subarray(Math.min(inCrop.length, rawStart), Math.min(inCrop.length, rawStart + 6 * rate)),
  }
}

/** Renders a candidate preview with the production renderer (stems/deck edits/reverb applied like renderMix). */
export async function renderPreview(plan: TransitionPlan, a: SetTrack, b: SetTrack, host: PreviewAudioHost) {
  return renderPreviewCropped(plan, a, b, await previewCrops(plan, a, b, host))
}

/**
 * Off-thread preview measurement (browser worker pool): renders the crops and measures them exactly
 * like the in-page path. Returns null when it cannot (the page then measures it itself).
 */
export type PreviewEvaluator = (job: {
  plan: TransitionPlan
  a: { key: string; trimDb: number; summary: { barSec: number }; profile: SetTrack['profile']; netBeats?: SetTrack['netBeats'] }
  b: { key: string; trimDb: number; summary: { barSec: number }; profile: SetTrack['profile']; netBeats?: SetTrack['netBeats'] }
  crops: PreviewCrops
  stems: { a?: StemInfo; b?: StemInfo }
  critic: boolean
}) => Promise<QualityResult | null>

/** Reshape a beat-matched candidate: shift cues by whole phrases and/or change its overlap length. */
function reshape(p: TransitionPlan, a: SetTrack, b: SetTrack, d: { outBars?: number; inBars?: number; bars?: number }): TransitionPlan | null {
  const bars = d.bars ?? p.overlapBars
  if (bars < 16 || bars > 64) return null
  const outCueSec = p.outCueSec + (d.outBars ?? 0) * a.summary.barSec
  const inCueSec = p.inCueSec + (d.inBars ?? 0) * b.summary.barSec
  const durationSec = bars * 4 * p.beatSec
  if (outCueSec < a.summary.durationSec * 0.35 || outCueSec + durationSec > a.summary.durationSec + 8 * a.summary.barSec) return null
  if (inCueSec < Math.max(0, (b.summary.silentLeadSec ?? 0) - 0.05) || inCueSec + durationSec * p.tempoRatio > b.summary.durationSec * 0.8) return null
  const q: TransitionPlan = { ...p, outCueSec, inCueSec, overlapBars: bars, durationSec, reasons: [...p.reasons, 'closed-loop refinement'] }
  // a shifted window no longer lands on the same drop
  if (q.incomingDropSec !== undefined && (d.inBars || d.bars)) {
    delete q.incomingDropSec
    delete q.incomingDropOffsetSec
  }
  return q
}

export async function closedLoop(tracks: SetTrack[], spec: ResolvedSpec, setOpts: SetPlanOptions, host: PreviewAudioHost, opts: ClosedLoopOptions = {}): Promise<ClosedLoopResult> {
  const prior = opts.memory?.result
  if (prior && setOpts.fixedOrder && setOpts.fixedOrder.join('|') === prior.set.order.join('|')) {
    opts.log?.('closed loop: order unchanged since the review pass; reusing its measured plan (no second search)')
    return prior
  }
  const res = await closedLoopSearch(tracks, spec, setOpts, host, opts)
  if (opts.memory) opts.memory.result = res
  return res
}

async function closedLoopSearch(tracks: SetTrack[], spec: ResolvedSpec, setOpts: SetPlanOptions, host: PreviewAudioHost, opts: ClosedLoopOptions = {}): Promise<ClosedLoopResult> {
  const R = opts.rounds ?? 3
  const budget = opts.budget ?? 120
  const M = opts.candidatesPerEdge ?? 5
  const S = opts.strategiesPerCandidate ?? 2
  const refinements = opts.refinements ?? 4
  const poor = opts.poorThreshold ?? 2.2
  const good = opts.goodThreshold ?? 0.9
  const lambda = opts.lambda ?? 3
  const log = opts.log ?? (() => {})
  const byKey = new Map(tracks.map((t) => [t.key, t]))
  const mem = opts.memory ?? newClosedLoopMemory()
  const measured: Map<string, Measured> = mem.measured
  const plannerMeasured = new Map<string, { cost: number; plan: TransitionPlan }>()
  const pairPenalty = mem.pairPenalty
  for (const [k, v] of setOpts.pairPenalty ?? []) pairPenalty.set(k, Math.max(v, pairPenalty.get(k) ?? 0))
  const extraEdges = mem.extraEdges
  const cache = mem.cache
  const evaluated: EvaluatedCandidate[] = []
  const replans: ClosedLoopResult['replans'] = []
  const notes: string[] = []
  let previews = 0
  mem.modelUse ??= { transitionnetV2: { proposals: 0, rendered: 0, final: 0 }, transitionnetV1: { variants: 0, rendered: 0, final: 0 }, humanCue: { candidates: 0, rendered: 0, final: 0 }, critic: { scored: 0 } }
  const modelUse = mem.modelUse
  // "final" describes THIS call's final set
  modelUse.transitionnetV2.final = 0
  modelUse.transitionnetV1.final = 0
  modelUse.humanCue.final = 0
  const humanSigs = new Set<string>()
  // a technique the user named is binding: it wins whenever a rendering of it passes every hard check
  const rankP = (q: QualityResult, p: TransitionPlan) => rank(q) - (!q.hardFail && matchesAny(p, spec.techniques.prefer) ? 3 : 0)
  const strategyWanted = (st: string) => spec.techniques.prefer.length > 0 && techniquesOfStrategy(st).some((t) => spec.techniques.prefer.includes(t))
  const isV1 = (p: TransitionPlan) => (p as TransitionPlan & { mlSource?: string }).mlSource === 'transitionnet'
  const isV2 = (p: TransitionPlan) => p.performance?.source === 'transitionnet-v2'
  const ctlKey = (p: TransitionPlan) => JSON.stringify([edgeSig(p.fromItemId, p.toItemId, p), p.style, p.out, p.in, p.filter, p.echo, p.echoIn, p.crossfader, p.outLoop, p.outPerf, (p as TechniquePlan).tech?.stems, (p as TechniquePlan).tech?.deckEdits])

  const tStart = Date.now()
  /** Preview index the current edge may not pass (fair share of the budget per transition). */
  let edgeBudgetEnd = Infinity
  const timing = { audioMs: 0, renderMs: 0, measureMs: 0, totalMs: 0 }
  const inflight = new Map<string, Promise<QualityResult | null>>()
  const evaluate = (p: TransitionPlan, a: SetTrack, b: SetTrack): Promise<QualityResult | null> => {
    const k = ctlKey(p)
    const hit = cache.get(k)
    if (hit) return Promise.resolve(hit)
    const running = inflight.get(k)
    if (running) return running
    if (previews >= budget || previews >= edgeBudgetEnd || opts.signal?.aborted) return Promise.resolve(null)
    if (!validPlan(p)) return Promise.resolve(null)
    previews++
    mem.previews++
    const job = measure(p, a, b, k).finally(() => inflight.delete(k))
    inflight.set(k, job)
    return job
  }
  const measure = async (p: TransitionPlan, a: SetTrack, b: SetTrack, k: string): Promise<QualityResult | null> => {
    if (opts.evaluator) {
      const tA = Date.now()
      const crops = await previewCrops(p, a, b, host)
      const tR = Date.now()
      const q = await opts.evaluator({
        plan: p,
        a: { key: a.key, trimDb: a.trimDb, summary: { barSec: a.summary.barSec }, profile: a.profile, netBeats: a.netBeats },
        b: { key: b.key, trimDb: b.trimDb, summary: { barSec: b.summary.barSec }, profile: b.profile, netBeats: b.netBeats },
        crops,
        stems: { a: opts.stems?.get(a.key), b: opts.stems?.get(b.key) },
        critic: !!opts.critic,
      })
      if (q) {
        timing.audioMs += tR - tA
        timing.renderMs += Date.now() - tR
        if (q.critic) modelUse.critic.scored++
        if (isV2(p)) modelUse.transitionnetV2.rendered++
        if (isV1(p)) modelUse.transitionnetV1.rendered++
        if (humanSigs.has(edgeSig(p.fromItemId, p.toItemId, p))) modelUse.humanCue.rendered++
        cache.set(k, q)
        return q
      }
    }
    // yield between previews so the page (browser host) keeps repainting progress
    await new Promise((res) => setTimeout(res, 0))
    const tA = Date.now()
    await host.audio(a.key)
    await host.audio(b.key)
    if ((p as TechniquePlan).tech?.stems && host.stems) {
      await host.stems(a.key)
      await host.stems(b.key)
    }
    const tR = Date.now()
    const r = await renderPreview(p, a, b, host)
    const tM = Date.now()
    timing.audioMs += tR - tA
    timing.renderMs += tM - tR
    const critic = opts.critic?.(p, r.mix, r.rate, r.t0, r.t1) ?? undefined
    if (critic) modelUse.critic.scored++
    if (isV2(p)) modelUse.transitionnetV2.rendered++
    if (isV1(p)) modelUse.transitionnetV1.rendered++
    if (humanSigs.has(edgeSig(p.fromItemId, p.toItemId, p))) modelUse.humanCue.rendered++
    const q = evaluateTransition(r, { plan: p, pa: a.profile, pb: b.profile, beatsA: a.netBeats, beatsB: b.netBeats, stems: { a: opts.stems?.get(a.key), b: opts.stems?.get(b.key) }, critic })
    cache.set(k, q)
    timing.measureMs += Date.now() - tM
    return q
  }
  /**
   * Measurements CORRECT the planner's prediction on its own scale: cost = predicted + λ·(score − μ),
   * μ = mean score of everything rendered so far (+6 for a hard failure). Unrendered slots keep their
   * prediction, so rendering an edge can make it cheaper or dearer but never just "different units".
   */
  const scores = mem.scores
  const mu = () => (scores.length ? scores.reduce((p, q) => p + q, 0) / scores.length : 1)
  const record = (sig: string, m: Measured) => {
    const prev = measured.get(sig)
    if (!prev || rankP(m.q, m.plan) < rankP(prev.q, prev.plan)) measured.set(sig, m)
  }
  const plannerView = () => {
    const u = mu()
    plannerMeasured.clear()
    for (const [sig, m] of measured) plannerMeasured.set(sig, { cost: m.base + lambda * (m.q.score - u) + (m.q.hardFail ? 6 : 0), plan: m.plan })
    return plannerMeasured
  }

  /** All performance variants of one candidate slot. */
  const variantsOf = (e: Edge, a: SetTrack, b: SetTrack): TransitionPlan[] => variantsAll(e, a, b).filter((v) => !avoided(v, spec.techniques.avoid))
  const variantsAll = (e: Edge, a: SetTrack, b: SetTrack): TransitionPlan[] => {
    const p = e.plan
    if (!longformEligible(p)) {
      const out = [p]
      const v1 = opts.tnV1?.(p, a, b)
      if (v1) {
        modelUse.transitionnetV1.variants++
        out.push(v1)
      }
      return out
    }
    const compat = e.compat ?? overlapCompat(a.profile, b.profile, p.outCueSec, p.inCueSec, p.overlapBars)
    const dropAtEnd = p.incomingDropSec !== undefined
    const stems = { a: opts.stems?.get(a.key), b: opts.stems?.get(b.key) }
    const out: TransitionPlan[] = []
    const proposal = opts.propose?.({ a, b, base: p })
    if (proposal) modelUse.transitionnetV2.proposals++
    if (proposal) {
      out.push(buildPerformance({ base: p, pa: a.profile, pb: b.profile, strategy: proposal.strategy, params: proposal.params, stems, source: 'transitionnet-v2', compat }))
      // the cue head may also propose moving the incoming cue by a phrase (a separate slot, rendered too)
      const shifted = proposal.cueShift ? reshape(p, a, b, { inBars: proposal.cueShift }) : null
      if (shifted) out.push(buildPerformance({ base: shifted, pa: a.profile, pb: b.profile, strategy: proposal.strategy, params: proposal.params, stems, source: 'transitionnet-v2' }))
    }
    // strategies that perform a requested technique are tried first (never crowded out by the strategy limit)
    const feasible = feasibleStrategies(compat, { stems, dropAtEnd })
    for (const st of [...feasible.filter(strategyWanted), ...feasible.filter((x) => !strategyWanted(x))]) {
      if (out.length >= S + (proposal ? 1 : 0)) break
      if (proposal && st === proposal.strategy) continue
      out.push(buildPerformance({ base: p, pa: a.profile, pb: b.profile, strategy: st, params: NEUTRAL, stems, source: 'rules', compat }))
    }
    return out
  }

  const optimiseEdge = async (e: Edge, list: Edge[], round: number, pairLabel: string) => {
    const a = byKey.get(e.plan.fromItemId)!
    const b = byKey.get(e.plan.toItemId)!
    const pair = `${a.key}|${b.key}`
    // candidate slots: the planned edge + diverse alternatives (different lengths / cue regions / families)
    const picks: Edge[] = [e]
    const has = (x: Edge) => picks.some((y) => y.sig === x.sig && y.plan.style === x.plan.style)
    for (const bars of [32, 16, 48, 64]) {
      const alt = list.find((x) => x.plan.overlapBars === bars && longformEligible(x.plan) && !has(x))
      if (alt && picks.length < M) picks.push(alt)
    }
    // the user named a technique: the two best candidates that perform it are measured right after the
    // planned slot (the per-edge budget share cuts the tail of the list, never these)
    const wanted = spec.techniques.prefer.length ? list.filter((x) => matchesAny(x.plan, spec.techniques.prefer) && !has(x)).slice(0, 2) : []
    if (wanted.length) picks.splice(1, 0, ...wanted.filter((w) => !has(w)))
    if (wanted.length) picks.splice(M + 1)
    const shortAlt = list.find((x) => !longformEligible(x.plan) && !has(x))
    if (shortAlt && picks.length < M + 1) picks.push(shortAlt)
    // MixGraph's human cue prior proposes the most DJ-like cue/overlap slot of this pair (rendered and measured like any other)
    const human = opts.humanPick?.(list, a, b)
    if (human) {
      modelUse.humanCue.candidates++
      humanSigs.add(human.sig)
      if (!has(human)) picks.push(human)
    }
    let best: { q: QualityResult; plan: TransitionPlan; edge: Edge } | null = null
    // every candidate rendering of this transition is dispatched at once (parallel with a worker pool;
    // results are then read in the same order as before, so the choice is deterministic)
    const jobs = picks.map((cand) => {
      const vs = variantsOf(cand, a, b)
      return { cand, vs, qs: vs.map((v) => evaluate(v, a, b)) }
    })
    for (const { cand, vs, qs } of jobs) {
      let candBest: { q: QualityResult; plan: TransitionPlan } | null = null
      for (const [vi, v] of vs.entries()) {
        const q = await qs[vi]
        if (!q) continue
        scores.push(q.score)
        evaluated.push({ pair: pairLabel, sig: cand.sig, label: labelOf(v), score: round3(q.score), hardFail: q.hardFail, failures: q.failures, components: roundAll(q.components), overlapBars: v.overlapBars, strategy: v.performance?.strategy, source: v.performance ? v.performance.source : isV1(v) ? 'transitionnet-v1' : 'legacy', round, refined: false, critic: q.critic })
        if (!candBest || rankP(q, v) < rankP(candBest.q, candBest.plan)) candBest = { q, plan: v }
      }
      if (!candBest) continue
      record(cand.sig, { base: cand.cost, plan: candBest.plan, q: candBest.q, label: labelOf(candBest.plan) })
      if (!best || rankP(candBest.q, candBest.plan) < rankP(best.q, best.plan)) best = { ...candBest, edge: cand }
    }
    if (!best) return null
    // refine the winner when it is not already clean
    if (best.q.score > good || best.q.hardFail) {
      const p = best.plan
      const tries: TransitionPlan[] = []
      if (p.performance) {
        const params = { ...NEUTRAL, ...(p.performance.params ?? {}) } as LongformParams
        const stems = { a: opts.stems?.get(a.key), b: opts.stems?.get(b.key) }
        const strategy = p.performance.strategy as Strategy
        const c = best.q.components
        // targeted parameter refinements from the measured faults
        const tweak: Partial<LongformParams> = {}
        if ((c.bass ?? 0) > 0.3) tweak.bassLen = Math.max(0, params.bassLen - 0.35)
        if ((c.vocals ?? 0) > 0.3) {
          tweak.midLayer = Math.max(0, params.midLayer - 0.4)
          tweak.outMidCut = Math.min(1, params.outMidCut + 0.3)
        }
        if ((c.effects ?? 0) > 0) {
          tweak.echoOut = 0
          tweak.filterRide = 0
        }
        if ((c.energy ?? 0) > 0.3 || (c.layering ?? 0) > 0.3) tweak.headroom = Math.min(1, params.headroom + 0.4)
        if ((c.percussion ?? 0) > 0.3) tweak.hatsRamp = Math.min(1, params.hatsRamp + 0.4)
        const base = { ...p, style: 'long_blend' as const }
        if (Object.keys(tweak).length) tries.push(buildPerformance({ base, pa: a.profile, pb: b.profile, strategy, params: { ...params, ...tweak }, stems, source: p.performance.source }))
        // structural refinements: cue ±1 phrase, overlap ±16 bars
        for (const d of [{ inBars: 8 }, { inBars: -8 }, { outBars: 8 }, { bars: p.overlapBars - 16 }, { bars: p.overlapBars + 16 }]) {
          const q = reshape(base, a, b, d)
          if (q) tries.push(buildPerformance({ base: q, pa: a.profile, pb: b.profile, strategy, params: { ...params, ...tweak }, stems, source: p.performance.source }))
        }
      }
      for (const t of tries.slice(0, refinements)) {
        const q = await evaluate(t, a, b)
        if (!q) continue
        scores.push(q.score)
        const sig = edgeSig(a.key, b.key, t)
        evaluated.push({ pair: pairLabel, sig, label: labelOf(t), score: round3(q.score), hardFail: q.hardFail, failures: q.failures, components: roundAll(q.components), overlapBars: t.overlapBars, strategy: t.performance?.strategy, source: t.performance?.source ?? 'rules', round, refined: true, critic: q.critic })
        record(sig, { base: best.edge.cost, plan: t, q, label: labelOf(t) })
        // new slots must exist in the planner's edge lists to be selectable
        if (sig !== best.edge.sig) {
          const list2 = extraEdges.get(pair) ?? []
          list2.push({ ...t, costs: { ...t.costs, total: best.edge.parts.rule } })
          extraEdges.set(pair, list2)
        }
        if (rankP(q, t) < rankP(best.q, best.plan)) best = { q, plan: t, edge: best.edge }
      }
    }
    if (best.q.hardFail || best.q.score > poor) {
      const pen = (pairPenalty.get(pair) ?? 0) + 1.5 + Math.max(0, best.q.score - poor)
      pairPenalty.set(pair, pen)
    }
    return best
  }

  let current: PlannedSet | null = null
  let round = 0
  for (; round < R; round++) {
    const res = planSet(tracks, spec, { ...setOpts, measured: plannerView(), pairPenalty, extraEdges })
    const set = res.sets[0]
    if (!set) throw new Error('set planning found no feasible arrangement')
    const unmeasured = set.edges.filter((e) => !measured.has(e.sig))
    const poorPairs = set.edges.filter((e) => {
      const m = measured.get(e.sig)
      return m && (m.q.hardFail || m.q.score > poor)
    }).map((e) => `${e.plan.fromItemId}|${e.plan.toItemId}`)
    replans.push({ round, order: set.order, cost: round3(set.cost), poorPairs })
    current = set
    if (!unmeasured.length && !poorPairs.length) {
      log(`closed loop: round ${round}: every transition rendered and acceptable — converged`)
      break
    }
    if (previews >= budget) {
      notes.push(`preview budget (${budget}) exhausted in round ${round}; ${unmeasured.length} transition(s) keep predicted costs`)
      break
    }
    let k = 0
    // every transition gets a fair share of what is left (20 % kept for final verification), so the
    // budget never runs out before the last transitions of the set are measured
    const todo = set.edges.filter((e) => !measured.has(e.sig) || poorPairs.includes(`${e.plan.fromItemId}|${e.plan.toItemId}`))
    let left = todo.length
    for (const e of set.edges) {
      opts.progress?.(k++, set.edges.length, `closed loop round ${round + 1}: rendering candidates for transition ${k}/${set.edges.length}`)
      if (measured.has(e.sig) && !poorPairs.includes(`${e.plan.fromItemId}|${e.plan.toItemId}`)) continue
      edgeBudgetEnd = previews + Math.max(3, Math.floor((budget * 0.8 - previews) / Math.max(1, left--)))
      await optimiseEdge(e, res.edgeLists.get(`${e.plan.fromItemId}|${e.plan.toItemId}`) ?? [e], round, `${set.order.indexOf(e.plan.fromItemId) + 1}→${set.order.indexOf(e.plan.toItemId) + 1}`)
    }
    edgeBudgetEnd = Infinity
    log(`closed loop: round ${round}: ${previews} previews so far, ${pairPenalty.size} penalised pair(s)`)
  }
  // Final plan + verification: render every transition of the final set that was never rendered;
  // a failing one is penalised and the set re-planned (bounded), so no unrendered edge slips through.
  let final: PlannedSet = current!
  for (let vround = 0; vround < 6; vround++) {
    // growing pessimism for never-rendered edges, so verification settles on rendered transitions
    const unmeasuredPenalty = vround === 0 ? 0 : lambda * 0.5 * 2 ** (vround - 1)
    final = planSet(tracks, spec, { ...setOpts, measured: plannerView(), pairPenalty, extraEdges, unmeasuredPenalty }).sets[0] ?? final
    const fresh = final.edges.filter((e) => !measured.has(e.sig))
    if (!fresh.length) break
    if (previews >= budget) {
      notes.push(`preview budget (${budget}) exhausted: ${fresh.length} final transition(s) were not rendered (predicted costs only)`)
      break
    }
    let failed = false
    for (const e of fresh) {
      if (previews >= budget) break
      const a = byKey.get(e.plan.fromItemId)!
      const b = byKey.get(e.plan.toItemId)!
      const v = variantsOf(e, a, b)[0]
      const q = await evaluate(v, a, b)
      if (!q) continue
      scores.push(q.score)
      record(e.sig, { base: e.cost, plan: v, q, label: labelOf(v) })
      evaluated.push({ pair: `${final.order.indexOf(a.key) + 1}→${final.order.indexOf(b.key) + 1}`, sig: e.sig, label: labelOf(v), score: round3(q.score), hardFail: q.hardFail, failures: q.failures, components: roundAll(q.components), overlapBars: v.overlapBars, strategy: v.performance?.strategy, source: v.performance ? v.performance.source : 'legacy', round: round + 1 + vround, refined: false, critic: q.critic })
      if (q.hardFail || q.score > poor) {
        failed = true
        pairPenalty.set(`${a.key}|${b.key}`, (pairPenalty.get(`${a.key}|${b.key}`) ?? 0) + 1.5 + Math.max(0, q.score - poor))
      }
    }
    replans.push({ round: round + 1 + vround, order: final.order, cost: round3(final.cost), poorPairs: [] })
    if (!failed) {
      final = planSet(tracks, spec, { ...setOpts, measured: plannerView(), pairPenalty, extraEdges, unmeasuredPenalty: lambda * 0.5 * 2 ** vround }).sets[0] ?? final
      if (final.edges.every((e) => measured.has(e.sig))) break
    }
  }
  for (const e of final.edges) {
    const m = measured.get(e.sig)
    if (m) e.plan = m.plan
    if (m?.q.hardFail) notes.push(`final transition ${labelOf(m.plan)} (${e.plan.fromItemId}→${e.plan.toItemId}) still fails: ${m.q.failures.join(', ')} — no measured alternative was better within the budget`)
  }
  // long-form edges that were never rendered still execute a staged performance (rule solver)
  final.edges = final.edges.map((e) => {
    if (measured.has(e.sig) || !longformEligible(e.plan) || e.plan.performance) return e
    const a = byKey.get(e.plan.fromItemId)!
    const b = byKey.get(e.plan.toItemId)!
    const compat = e.compat ?? overlapCompat(a.profile, b.profile, e.plan.outCueSec, e.plan.inCueSec, e.plan.overlapBars)
    const st = feasibleStrategies(compat, { stems: { a: opts.stems?.get(a.key), b: opts.stems?.get(b.key) }, dropAtEnd: e.plan.incomingDropSec !== undefined })[0]
    const perf = buildPerformance({ base: e.plan, pa: a.profile, pb: b.profile, strategy: st, compat, stems: { a: opts.stems?.get(a.key), b: opts.stems?.get(b.key) } })
    // never ship a control plan the renderer validation rejects: keep the (validated) template instead
    return validPlan(perf) ? { ...e, plan: perf } : e
  })
  const chosen = final.edges.map((e) => {
    const m = measured.get(e.sig)
    return { pair: `${e.plan.fromItemId}|${e.plan.toItemId}`, sig: e.sig, score: m ? round3(m.q.score) : undefined, hardFail: m?.q.hardFail, label: labelOf(e.plan), metrics: m?.q.metrics, components: m ? roundAll(m.q.components) : undefined }
  })
  for (const e of final.edges) {
    if (isV2(e.plan)) modelUse.transitionnetV2.final++
    if (isV1(e.plan)) modelUse.transitionnetV1.final++
    if (humanSigs.has(e.sig)) modelUse.humanCue.final++
  }
  timing.totalMs = Date.now() - tStart
  return { set: final, rounds: round + 1, previews, evaluated, chosen, replans, notes, modelUse: structuredClone(modelUse), timing }
}

/** Hard failures always rank below clean candidates; then lower score wins. Length earns nothing. */
const rank = (q: QualityResult) => (q.hardFail ? 100 : 0) + q.score
const round3 = (x: number) => Math.round(x * 1000) / 1000
const roundAll = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round3(v)]))

