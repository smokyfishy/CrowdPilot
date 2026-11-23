/**
 * Professional DJ intelligence: Music Analysis → Global DJ Planning → Long-Form TransitionNet →
 * Candidate Audio Rendering → Quality Evaluation → Re-planning/Refinement → final MixPlan.
 *
 * One orchestrator shared by the mix pipeline (browser + Node + research hosts) and the evaluation
 * harness (evaluation/mixgen.prodj.eval.ts), so the comparison measures exactly what ships.
 * Components can be switched off individually for the controlled comparison:
 *   global      set planner (src/mixgen/setplan.ts) instead of beam order + per-pair cue DP
 *   longform    staged 16–64-bar performances (src/mixgen/longform.ts) for eligible transitions
 *   closedLoop  render/evaluate/refine/re-plan (src/mixgen/closedloop.ts)
 */
import { summarize, type TrackAnalysis } from '../dsp/analyze'
import { beatmatchable, type TransitionPlan } from '../dj/transitions'
import { energyScores, type EnergyDescriptor } from './energy'
import { buildTimeline, planMix, type MixPlan, type PlannedTrack } from './mixplan'
import { buildProfile, overlapCompat } from './profile'
import { planSet, narrativeFor, type Edge, type SetTrack } from './setplan'
import { buildPerformance, feasibleStrategies, longformEligible } from './longform'
import { closedLoop, type ClosedLoopMemory, type ClosedLoopResult, type PreviewAudioHost, type Proposal } from './closedloop'
import { orderSet, type OrderTrack } from './select'
import { rankCandidatesWith, validPlan, type MlDecision, type MlRuntime } from './ml'
import { applyTransitionNet, criticFromMix, mixgraphRank, transitionNetPredict } from '../ml/dj-brain'
import { longformFeatures, transitionNetV2Predict } from '../ml/transitionnet-v2'
import type { StemInfo } from './techniques'
import type { ResolvedSpec } from './spec'

export interface ProDjEntry {
  key: string
  title: string
  artist: string
  genres: string[]
  analysis: TrackAnalysis
  energy: EnergyDescriptor
  /** Selection preference (pinned tracks carry a large bonus). */
  pref: number
  trimDb: number
}

export interface ProDjModes {
  global: boolean
  longform: boolean
  closedLoop: boolean
}

export const PRO_DJ_DEFAULT: ProDjModes = { global: true, longform: true, closedLoop: true }

export interface ProDjInput {
  entries: ProDjEntry[]
  spec: ResolvedSpec
  count: number
  fixedOrder?: string[]
  ml?: MlRuntime
  stems?: Map<string, StemInfo>
  audio?: PreviewAudioHost
  modes: ProDjModes
  budget?: number
  rounds?: number
  /** TransitionNet v2 proposer (src/ml) when its checkpoint is loaded. */
  propose?: (ctx: { a: SetTrack; b: SetTrack; base: TransitionPlan }) => Proposal | null
  log?: (m: string) => void
  progress?: (done: number, total: number, detail: string) => void
  signal?: AbortSignal
  memory?: ClosedLoopMemory
}

export interface ProDjTrace {
  modes: ProDjModes
  planner: 'global-set' | 'legacy'
  narrative: Array<{ slot: number; role: string; targetEnergy: number }>
  setPlan?: { explored: number; pairsEvaluated: number; candidates: Array<{ order: string[]; cost: number }>; parts: Record<string, number> }
  transitions: Array<{
    pair: string
    style: string
    overlapBars: number
    outCueSec: number
    inCueSec: number
    edgeParts?: Edge['parts']
    compat?: Record<string, number>
    performance?: TransitionPlan['performance']
    measured?: { score?: number; hardFail?: boolean; components?: Record<string, number> }
  }>
  closedLoop?: Omit<ClosedLoopResult, 'set'>
  components: Array<{ name: string; kind: 'trained' | 'rules' | 'measurement'; used: boolean; note: string }>
}

export interface ProDjResult {
  order: string[]
  plan: MixPlan
  planned: PlannedTrack[]
  trace: ProDjTrace
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

export async function planProDj(input: ProDjInput): Promise<ProDjResult> {
  const { spec, modes, ml } = input
  const log = input.log ?? (() => {})
  const scores = energyScores(input.entries.map((e) => e.energy))
  const tracks: SetTrack[] = input.entries.map((e, i) => {
    const s = summarize(e.analysis)
    return {
      key: e.key,
      title: e.title,
      summary: s,
      trimDb: e.trimDb,
      netBeats: e.analysis.netBeats,
      profile: buildProfile(e.analysis, input.stems?.get(e.key)),
      energy: scores[i],
      dropStrength: e.energy.dropStrength,
      pref: e.pref,
      artist: e.artist,
      genres: e.genres,
      gridOk: beatmatchable(s),
    }
  })
  const byKey = new Map(tracks.map((t) => [t.key, t]))
  const count = Math.min(input.count, tracks.length)
  const narrative = narrativeFor(spec, count)
  const components: ProDjTrace['components'] = []
  const mixgraphOn = !!(ml?.on.mixgraph && ml.models.mixgraph)
  const learnedSeverity = mixgraphOn
    ? (p: TransitionPlan, a: SetTrack, b: SetTrack) => {
        // MixGraph was trained on the 12 base styles up to 32 bars: longer windows are scored as 32-bar
        // long blends (a proxy, so every edge carries a comparable learned term)
        const asTrained = p.style === 'staged_blend' || p.overlapBars > 32 ? { ...p, style: p.style === 'staged_blend' ? ('long_blend' as const) : p.style, overlapBars: Math.min(32, p.overlapBars) } : p
        return mixgraphRank([asTrained], a.summary, b.summary, ml!.models.mixgraph!)[0]?.predictedSeverity
      }
    : undefined
  components.push({ name: 'MixGraph (LightGBM render-severity)', kind: 'trained', used: mixgraphOn, note: mixgraphOn ? 'adds predicted severity to every edge (weight 4; windows > 32 bars scored as 32-bar blends); unpromoted in the registry' : 'not loaded' })
  const propose = input.propose ?? (ml?.on.transitionNetV2 && ml.models.transitionNetV2 ? proposerFromMl(ml) : undefined)
  const trace: ProDjTrace = { modes, planner: modes.global ? 'global-set' : 'legacy', narrative: narrative.map((nv, i) => ({ slot: i + 1, role: nv.role, targetEnergy: r3(nv.energy) })), transitions: [], components }

  let order: string[]
  let plans: TransitionPlan[]
  let candidates: TransitionPlan[][] = []
  let edges: Edge[] | undefined
  let loop: ClosedLoopResult | undefined
  const setOpts = {
    count,
    fixedOrder: input.fixedOrder,
    longform: modes.longform || modes.global,
    pairOpts: { techniques: { enabled: true, stems: input.stems }, preferLongDropBlends: true },
    learnedSeverity,
    log,
  }
  if (modes.global) {
    components.push({ name: 'Global set planner (joint order × cues × overlap beam search)', kind: 'rules', used: true, note: 'heuristic set-level objective + bar-level overlap compatibility; not a trained model' })
    if (modes.closedLoop && input.audio) {
      const criticOn = !!(ml?.on.critic && ml.models.critic)
      components.push({ name: 'Closed-loop audio evaluation', kind: 'measurement', used: true, note: 'explicit signal metrics on rendered previews (production renderer); conservative thresholds, not human taste' })
      components.push({ name: 'DJCritic (LightGBM)', kind: 'trained', used: criticOn, note: criticOn ? 'capped term in the preview score; trained on synthetic objective severity; unpromoted' : 'not loaded' })
      const tnV1On = !!(ml?.on.transitionNet && ml.models.transitionNet)
      const humanOn = !!(ml?.models.mixgraph && (ml.on.mixgraph || ml.on.ordering))
      components.push({ name: 'TransitionNet v1 (MLP trajectories)', kind: 'trained', used: tnV1On, note: tnV1On ? 'adds a learned-trajectory variant to short beat-matched templates; rendered and measured against the template (it raised bass doubling in the earlier ablation, so it never bypasses the loop)' : 'not loaded / off' })
      components.push({ name: 'MixGraph human cue prior (LightGBM)', kind: 'trained', used: humanOn, note: humanOn ? 'proposes the most human-DJ-like cue/overlap slot per pair as an extra closed-loop candidate (not a cost term: as a cost term it hurt held-out severity)' : 'not loaded' })
      loop = await closedLoop(tracks, spec, setOpts, input.audio, {
        tnV1: tnV1On
          ? (p, a, b) => {
              if (p.overlapBars < 4 || p.overlapBars > 32 || (p as TransitionPlan & { tech?: unknown }).tech) return null
              try {
                const next = applyTransitionNet(p, transitionNetPredict(ml!.models.transitionNet!, a.summary, b.summary, p))
                if (next === p || !validPlan(next)) return null
                return { ...next, mlSource: 'transitionnet' } as TransitionPlan
              } catch {
                return null
              }
            }
          : undefined,
        humanPick: humanOn
          ? (list, a, b) => {
              const cands = list.filter((e) => e.plan.overlapBars <= 32 && e.plan.style !== 'staged_blend').slice(0, 24)
              if (cands.length < 2) return null
              const ranked = mixgraphRank(cands.map((e) => e.plan), a.summary, b.summary, ml!.models.mixgraph!)
              const best = ranked.reduce((m, r) => (r.humanLogit > m.humanLogit ? r : m), ranked[0])
              return cands.find((e) => e.plan === best.plan) ?? null
            }
          : undefined,
        budget: input.budget,
        rounds: input.rounds,
        critic: criticOn ? (p, mix, rate, t0, t1) => criticFromMix(ml!.models.critic!, p, mix, rate, t0, t1) : undefined,
        propose,
        stems: input.stems,
        log,
        progress: input.progress,
        signal: input.signal,
        memory: input.memory,
      })
      order = loop.set.order
      edges = loop.set.edges
      trace.setPlan = { explored: 0, pairsEvaluated: 0, candidates: loop.replans.map((r) => ({ order: r.order, cost: r.cost })), parts: roundParts(loop.set.parts) }
    } else {
      const res = planSet(tracks, spec, setOpts)
      const set = res.sets[0]
      if (!set) throw new Error('set planning found no feasible arrangement')
      order = set.order
      edges = set.edges
      trace.setPlan = { explored: res.explored, pairsEvaluated: res.pairsEvaluated, candidates: res.sets.map((s) => ({ order: s.order, cost: r3(s.cost) })), parts: roundParts(set.parts) }
      candidates = order.slice(0, -1).map((k, i) => (res.edgeLists.get(`${k}|${order[i + 1]}`) ?? []).slice(0, 12).map((e) => e.plan))
    }
    plans = edges.map((e) => e.plan)
  } else {
    // legacy order + per-pair cue DP (the existing CrowdPilot planner)
    components.push({ name: 'Legacy planner (beam order + per-pair cue DP)', kind: 'rules', used: true, note: 'pairwise; used for the controlled comparison' })
    const orderTracks: OrderTrack[] = tracks.map((t) => ({ key: t.key, pref: t.pref, bpm: t.summary.bpm, bpmConf: t.summary.bpmConf, camelot: t.summary.camelot, keyConf: t.summary.keyConf, energy: t.energy, dropStrength: t.dropStrength, vocal: (t.summary.vocalIn + t.summary.vocalOut) / 2, artist: t.artist, durationSec: t.summary.durationSec, gridOk: t.gridOk }))
    order = orderSet(orderTracks, spec, { count, fixedOrder: input.fixedOrder }).order
    const legacy = planMix(order.map((k) => byKey.get(k)!), spec, { ...(ml && (ml.on.mixgraph || ml.on.transitionNet) ? { rankCandidates: rankCandidatesWith(ml) } : {}), techniques: { enabled: true, stems: input.stems } })
    plans = legacy.transitions.map((t) => t.plan)
    candidates = legacy.candidates
  }
  // Long-form performances for eligible edges that do not have one yet (no closed loop, or never rendered).
  if (modes.longform) {
    components.push({ name: 'Long-form staged performance generator', kind: propose ? 'trained' : 'rules', used: true, note: propose ? 'TransitionNet v2 proposes strategy + shape parameters (+ cue shift); stage timing solved from bar-level content; the closed loop renders it against rule alternatives' : 'rule solver: stage timing from bar-level content; neutral shape parameters' })
    plans = plans.map((p, i) => {
      if (p.performance || !longformEligible(p)) return p
      const a = byKey.get(order[i])!
      const b = byKey.get(order[i + 1])!
      const compat = overlapCompat(a.profile, b.profile, p.outCueSec, p.inCueSec, p.overlapBars)
      const stems = { a: input.stems?.get(a.key), b: input.stems?.get(b.key) }
      const prop = propose?.({ a, b, base: p })
      const strategy = prop?.strategy ?? feasibleStrategies(compat, { stems, dropAtEnd: p.incomingDropSec !== undefined })[0]
      const perf = buildPerformance({ base: p, pa: a.profile, pb: b.profile, strategy, params: prop?.params, stems, source: prop ? 'transitionnet-v2' : 'rules', compat })
      return validPlan(perf) ? perf : p
    })
  }
  const planned: PlannedTrack[] = order.map((k) => {
    const t = byKey.get(k)!
    return { key: t.key, title: t.title, summary: t.summary, trimDb: t.trimDb, netBeats: t.netBeats }
  })
  const tl = buildTimeline(planned, plans)
  const notes: string[] = []
  if (Math.abs(tl.durationSec - spec.targetDurationSec) > 0.03 * spec.targetDurationSec) notes.push(`Duration ${Math.round(tl.durationSec)} s vs requested ${spec.targetDurationSec} s.`)
  if (loop) notes.push(...loop.notes)
  const plan: MixPlan = { tracks: tl.tracks, transitions: tl.transitions, durationSec: tl.durationSec, targetDurationSec: spec.targetDurationSec, totalCost: 0, notes, candidates: candidates.length ? candidates : plans.map((p) => [p]) }
  trace.transitions = plans.map((p, i) => {
    const e = edges?.[i]
    const a = byKey.get(order[i])!
    const b = byKey.get(order[i + 1])!
    const c = e?.compat ?? (p.overlapBars >= 8 ? overlapCompat(a.profile, b.profile, p.outCueSec, p.inCueSec, p.overlapBars) : undefined)
    const m = loop?.chosen[i]
    return {
      pair: `${i + 1}→${i + 2}`,
      style: p.style,
      overlapBars: p.overlapBars,
      outCueSec: r3(p.outCueSec),
      inCueSec: r3(p.inCueSec),
      edgeParts: e ? (roundParts(e.parts) as Edge['parts']) : undefined,
      compat: c ? { bassConflict: r3(c.bassConflict), vocalClash: r3(c.vocalClash), harmonicClash: r3(c.harmonicClash), percOverload: r3(c.percOverload), energyMismatch: r3(c.energyMismatch), bassSwapBar: c.bassSwapBar } : undefined,
      performance: p.performance,
      measured: m ? { score: m.score, hardFail: m.hardFail, components: m.components } : undefined,
    }
  })
  if (loop) {
    const { set: _s, ...rest } = loop
    trace.closedLoop = rest
  }
  return { order, plan, planned, trace }
}

function roundParts(p: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r3(v)]))
}

/** ProDJ decisions in the manifest's decision log (shown by the existing diagnostics panel). */
export function proDjDecisions(t: ProDjTrace): MlDecision[] {
  const out: MlDecision[] = []
  out.push({
    stage: 'planning',
    model: t.planner === 'global-set' ? 'global set planner (rules + bar-level compatibility)' : 'legacy planner',
    inputs: { slots: t.narrative.length, roles: t.narrative.map((n) => n.role).join(' → ') },
    prediction: Object.fromEntries(Object.entries(t.setPlan?.parts ?? {}).map(([k, v]) => [k, v])),
    decision: t.setPlan ? `chose 1 of ${t.setPlan.candidates.length} complete-set arrangement(s)/re-plans; costs ${t.setPlan.candidates.map((c) => c.cost).join(', ')}` : 'pairwise order + cue DP',
  })
  for (const tr of t.transitions) {
    out.push({
      stage: 'performance',
      model: tr.performance ? (tr.performance.source === 'transitionnet-v2' ? 'TransitionNet v2 + stage solver' : 'stage solver (rules)') : 'legacy controls',
      pair: tr.pair,
      inputs: { overlapBars: tr.overlapBars, outCueSec: tr.outCueSec, inCueSec: tr.inCueSec, ...(tr.compat ?? {}) },
      prediction: tr.measured?.components ?? {},
      decision: tr.performance
        ? `${tr.overlapBars}-bar ${tr.performance.strategy}: ${tr.performance.stages.map((s) => `${s.kind} ${s.startBar}–${s.endBar}`).join(', ')}${tr.measured?.score !== undefined ? ` · measured score ${tr.measured.score}${tr.measured.hardFail ? ' (hard fail)' : ''}` : ''}`
        : `${tr.style} ${tr.overlapBars} bars${tr.measured?.score !== undefined ? ` · measured score ${tr.measured.score}` : ''}`,
      dsp: tr.performance ? { bassSwapBar: tr.performance.bassSwapBar, vocalMode: tr.performance.vocalMode } : undefined,
    })
  }
  if (t.closedLoop) {
    out.push({
      stage: 'closed_loop',
      model: 'rendered-preview evaluation (explicit metrics' + (t.components.some((c) => c.name.startsWith('DJCritic') && c.used) ? ' + DJCritic' : '') + ')',
      inputs: { previews: t.closedLoop.previews, rounds: t.closedLoop.rounds, candidates: t.closedLoop.evaluated.length },
      prediction: { hardFailsRejected: t.closedLoop.evaluated.filter((e) => e.hardFail).length, refinements: t.closedLoop.evaluated.filter((e) => e.refined).length },
      decision: t.closedLoop.replans.map((r) => `round ${r.round}: cost ${r.cost}${r.poorPairs.length ? `, ${r.poorPairs.length} poor pair(s) penalised` : ''}`).join(' · ') + (t.closedLoop.notes.length ? ` · ${t.closedLoop.notes.join(' · ')}` : ''),
    })
  }
  return out
}

/** TransitionNet v2 proposer for long-form windows (strategy masked to what the window supports). */
export function proposerFromMl(ml: MlRuntime) {
  return (ctx: { a: SetTrack; b: SetTrack; base: TransitionPlan }): Proposal | null => {
    try {
      const { a, b, base } = ctx
      const c = overlapCompat(a.profile, b.profile, base.outCueSec, base.inCueSec, base.overlapBars)
      const feasible = feasibleStrategies(c, { dropAtEnd: base.incomingDropSec !== undefined })
      const t0 = Date.now()
      const p = transitionNetV2Predict(ml.models.transitionNetV2!, longformFeatures(a.summary, b.summary, base, c), feasible)
      ml.trace.timingsMs.transitionnet_v2 = (ml.trace.timingsMs.transitionnet_v2 ?? 0) + (Date.now() - t0)
      ml.trace.counts.transitionnet_v2 = (ml.trace.counts.transitionnet_v2 ?? 0) + 1
      return { strategy: p.strategy, params: p.params, source: 'transitionnet-v2', cueShift: p.cueShift }
    } catch (e) {
      ml.trace.fallbacks.push(`TransitionNet v2 failed: ${(e as Error).message}; rule solver used`)
      return null
    }
  }
}
