/**
 * Learned-DJ integration for the mix generator (models from src/ml, weights in public/models/ml).
 *
 *   ordering     MixGraph quality model → predicted transition severity for every ordered pair
 *                (best candidate) → added to the beam search's pair cost.
 *   ranking      MixGraph re-ranks each pair's candidates (cue × technique × overlap) before the
 *                duration DP: score = style/energy cost + alpha·severity − beta·humanLogit.
 *   automation   TransitionNet predicts fader/EQ/filter/echo trajectories (blends) and technique
 *                parameters (creative styles); outputs are validated (constrainTrajectories +
 *                renderer bounds) before they replace the hand templates.
 *   selection    DJCritic renders each pair's alternatives at the chosen cue/overlap (16 kHz mono
 *                previews) and picks the lowest predicted quality score, rejecting artifact > 0.8.
 *
 * Every decision is recorded in an MlTrace (model → inputs → prediction → decision → DSP params)
 * that is stored in the mix manifest. When a model is unavailable or fails, the rule-based path
 * runs and the fallback is logged in the trace — never silently.
 */
import type { AnalysisSummary } from '../dsp/analyze'
import { resample } from '../dsp/resample'
import { automationFor, BEATMATCHED, OVERLAP_BARS, type TransitionPlan } from '../dj/transitions'
import { curveAt } from '../dj/automation'
import { CTRL_CHANNELS, type ParamVector } from '../ml/controls'
import type { TechniquePlan } from './techniques'
import { applyTransitionNet, criticScore, mixgraphRank, transitionNetPredict, type DjModels, type MlMode, type Registry } from '../ml/dj-brain'

export interface MlOptions {
  /** 'off' = rules only; 'promoted' = registry-promoted components; 'experimental' = every component with weights. */
  mode: MlMode
  /** Per-component switches (applied on top of `mode`; used for ablations). */
  mixgraph: boolean
  transitionNet: boolean
  critic: boolean
  ordering: boolean
  /** MixGraph mixing weights (held-out validated: alpha 4, human prior weight 0). */
  alpha: number
  beta: number
  /** Weight of the predicted pair severity in the ordering beam search. */
  orderWeight: number
  /** DJCritic: max alternatives rendered per transition. */
  criticAlternatives: number
  /** TransitionNet v2 proposals for long-form performances (used only when its checkpoint loads). */
  transitionNetV2: boolean
}

/**
 * Defaults follow the ablation on real recordings (docs/AI_MIX_GENERATOR.md): MixGraph and DJCritic
 * improved loudness continuity and critic score; TransitionNet v1 increased bassline overlap (×11 alone),
 * so it is integrated but OFF by default until its v2 retrain passes the same ablation.
 */
export const ML_DEFAULTS: MlOptions = {
  mode: 'experimental',
  mixgraph: true,
  transitionNet: false,
  critic: true,
  ordering: true,
  alpha: 4,
  beta: 0,
  orderWeight: 4,
  criticAlternatives: 4,
  transitionNetV2: false,
}

export interface MlModelInfo {
  name: string
  file?: string
  version?: string
  sha256?: string
  promoted?: boolean
  loaded: boolean
  used: boolean
  kind: string
}

export interface MlDecision {
  stage: 'ordering' | 'ranking' | 'automation' | 'selection' | 'planning' | 'performance' | 'closed_loop'
  model: string
  pair?: string
  inputs: Record<string, number | string>
  prediction: Record<string, number | string>
  decision: string
  dsp?: Record<string, number | string | number[]>
}

export interface MlTrace {
  mode: MlMode
  options: MlOptions
  models: MlModelInfo[]
  decisions: MlDecision[]
  fallbacks: string[]
  timingsMs: Record<string, number>
  counts: Record<string, number>
}

export interface MlRuntime {
  models: DjModels
  options: MlOptions
  trace: MlTrace
  /** True when the component is loaded AND switched on. */
  on: { mixgraph: boolean; transitionNet: boolean; critic: boolean; ordering: boolean; transitionNetV2: boolean }
}

const KIND: Record<string, string> = {
  mixgraph_quality: 'LightGBM (render-quality severity)',
  mixgraph_human_cue: 'LightGBM (human cue prior)',
  transitionnet: 'MLP (automation trajectories + technique parameters)',
  critic_quality: 'LightGBM (rendered-preview quality)',
  critic_artifact: 'LightGBM (artifact probability)',
  transitionnet_v2: 'MLP (long-form strategy + stage parameters + cue shift)',
}

export async function createMlRuntime(load: (mode: MlMode) => Promise<DjModels>, registry: () => Promise<Registry | null>, opts: Partial<MlOptions> = {}): Promise<MlRuntime> {
  const options = { ...ML_DEFAULTS, ...opts }
  const t0 = Date.now()
  let models: DjModels = { active: { mixgraph: false, transitionNet: false, critic: false } }
  const fallbacks: string[] = []
  try {
    models = await load(options.mode)
  } catch (e) {
    fallbacks.push(`model loading failed (${(e as Error).message}); rules only`)
  }
  let reg: Registry | null = null
  try {
    reg = await registry()
  } catch {
    reg = null
  }
  if (models.mixgraph) {
    models.mixgraph.quality.alpha = options.alpha
    models.mixgraph.quality.beta = options.beta
  }
  const on = {
    mixgraph: options.mode !== 'off' && options.mixgraph && !!models.mixgraph,
    transitionNet: options.mode !== 'off' && options.transitionNet && !!models.transitionNet,
    critic: options.mode !== 'off' && options.critic && !!models.critic,
    ordering: options.mode !== 'off' && options.ordering && !!models.mixgraph,
    transitionNetV2: options.mode !== 'off' && options.transitionNetV2 && !!models.transitionNetV2,
  }
  const names = ['mixgraph_quality', 'mixgraph_human_cue', 'transitionnet', 'transitionnet_v2', 'critic_quality', 'critic_artifact'] as const
  const loaded = (n: string) => (n.startsWith('mixgraph') ? !!models.mixgraph : n === 'transitionnet' ? !!models.transitionNet : n === 'transitionnet_v2' ? !!models.transitionNetV2 : !!models.critic)
  const used = (n: string) => (n === 'mixgraph_quality' ? on.mixgraph || on.ordering : n === 'mixgraph_human_cue' ? (on.mixgraph || on.ordering) && options.beta !== 0 : n === 'transitionnet' ? on.transitionNet : n === 'transitionnet_v2' ? on.transitionNetV2 : on.critic)
  const trace: MlTrace = {
    mode: options.mode,
    options,
    models: names.map((n) => ({ name: n, file: reg?.[n]?.file, version: reg?.[n]?.version, sha256: reg?.[n]?.sha256, promoted: reg?.[n]?.promoted, loaded: loaded(n), used: used(n), kind: KIND[n] })).filter((x) => x.name !== 'transitionnet_v2' || x.loaded),
    decisions: [],
    fallbacks,
    timingsMs: { load: Date.now() - t0 },
    counts: {},
  }
  if (options.mode === 'off') trace.fallbacks.push('ML mode off: rule-based planner only')
  for (const [k, v] of Object.entries(on)) if (!v && options.mode !== 'off' && (options as unknown as Record<string, boolean>)[k]) trace.fallbacks.push(`${k}: model not available in mode "${options.mode}" — rules used`)
  if (on.mixgraph && options.beta === 0) trace.fallbacks.push('mixgraph_human_cue loaded but weight 0 (it hurt held-out severity)')
  return { models, options, trace, on }
}

const bump = (rt: MlRuntime, k: string, n = 1) => (rt.trace.counts[k] = (rt.trace.counts[k] ?? 0) + n)
const timed = <T>(rt: MlRuntime, k: string, f: () => T): T => {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  try {
    return f()
  } finally {
    rt.trace.timingsMs[k] = (rt.trace.timingsMs[k] ?? 0) + ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
  }
}

/** Plans scored by MixGraph on their UNMODIFIED rule costs (as trained); extra cost = style/energy terms. */
export type ScoredPlan = TransitionPlan & { ruleCost?: number; mlSeverity?: number; mlSource?: 'transitionnet' | 'rules' }

/**
 * planMix hook: MixGraph ranking + TransitionNet controls for one pair's candidates.
 * Returns the candidates re-ordered with `costs.total` = extra + alpha·severity (−beta·human).
 */
export function rankCandidatesWith(rt: MlRuntime) {
  return (cands: TransitionPlan[], a: AnalysisSummary, b: AnalysisSummary, pairIndex: number): TransitionPlan[] => {
    let out: ScoredPlan[] = cands as ScoredPlan[]
    if (rt.on.mixgraph) {
      try {
        const asTrained = out.map((p) => ({ ...p, costs: { ...p.costs, total: p.ruleCost ?? p.costs.total } }))
        const ranked = timed(rt, 'mixgraph', () => mixgraphRank(asTrained, a, b, rt.models.mixgraph!))
        bump(rt, 'mixgraph_candidates', ranked.length)
        const extraOf = new Map(out.map((p, i) => [asTrained[i], p.costs.total - (p.ruleCost ?? p.costs.total)]))
        out = ranked.map((r) => {
          const extra = extraOf.get(r.plan) ?? 0
          const total = (r.plan.costs.total + extra) + rt.options.alpha * r.predictedSeverity - rt.options.beta * r.humanLogit
          return { ...r.plan, ruleCost: r.plan.costs.total, mlSeverity: r.predictedSeverity, costs: { ...r.plan.costs, total } }
        })
        out.sort((x, y) => x.costs.total - y.costs.total)
        const best = out[0]
        const ruleBest = [...cands].sort((x, y) => x.costs.total - y.costs.total)[0]
        rt.trace.decisions.push({
          stage: 'ranking',
          model: 'mixgraph_quality',
          pair: `${pairIndex + 1}→${pairIndex + 2}`,
          inputs: { candidates: out.length, bpmOut: a.bpm, bpmIn: b.bpm, keyOut: a.camelot, keyIn: b.camelot },
          prediction: { bestSeverity: round(best.mlSeverity ?? 0), worstSeverity: round(Math.max(...out.map((p) => p.mlSeverity ?? 0))) },
          decision: `top candidate ${best.style} ${best.overlapBars} bars @ ${best.outCueSec.toFixed(1)}s→${best.inCueSec.toFixed(1)}s${ruleBest && (ruleBest.style !== best.style || Math.abs(ruleBest.outCueSec - best.outCueSec) > 0.5) ? ` (rules alone preferred ${ruleBest.style} @ ${ruleBest.outCueSec.toFixed(1)}s)` : ' (same as rules)'}`,
        })
      } catch (e) {
        rt.trace.fallbacks.push(`mixgraph ranking failed for pair ${pairIndex + 1}: ${(e as Error).message}; rule order kept`)
      }
    }
    if (rt.on.transitionNet) {
      out = out.map((p) => {
        if ((p as TechniquePlan).tech) return { ...p, mlSource: 'rules' as const } // technique automation is not TransitionNet's domain
        try {
          const pred = timed(rt, 'transitionnet', () => transitionNetPredict(rt.models.transitionNet!, a, b, p))
          const next = applyTransitionNet(p, pred)
          if (next === p) return { ...p, mlSource: 'rules' as const }
          if (!validPlan(next)) {
            rt.trace.fallbacks.push(`TransitionNet output rejected by validation (pair ${pairIndex + 1}, ${p.style}); template kept`)
            return { ...p, mlSource: 'rules' as const }
          }
          bump(rt, 'transitionnet_applied')
          return { ...(next as ScoredPlan), ruleCost: p.ruleCost, mlSeverity: p.mlSeverity, mlSource: 'transitionnet' as const, tnParams: pred.params }
        } catch (e) {
          rt.trace.fallbacks.push(`TransitionNet failed (pair ${pairIndex + 1}): ${(e as Error).message}; template kept`)
          return p
        }
      })
    }
    return out
  }
}

/** Renderer-level safety validation of a (possibly model-controlled) plan. */
export function validPlan(p: TransitionPlan): boolean {
  const ok = (c: Array<{ beat: number; value: number }> | undefined, lo: number, hi: number) => !c || (c.length > 0 && c.every((x, i) => Number.isFinite(x.value) && Number.isFinite(x.beat) && x.value >= lo - 1e-6 && x.value <= hi + 1e-6 && (i === 0 || x.beat >= c[i - 1].beat - 1e-9)))
  if (!(p.durationSec >= 0) || !Number.isFinite(p.tempoRatio) || Math.abs(p.tempoRatio - 1) > 0.1001) return false // ±10 % = short tempo rides in energetic/creative sets
  for (const d of [p.out, p.in]) if (!ok(d.gain, 0, 1.0001) || !ok(d.low, -40, 6) || !ok(d.mid, -40, 6) || !ok(d.high, -40, 6)) return false
  if (p.filter && (!ok(p.filter.out, -1, 1) || !ok(p.filter.in, -1, 1))) return false
  for (const e of [p.echo, p.echoIn]) if (e && (!ok(e.send, 0, 1) || !(e.feedback >= 0 && e.feedback <= 0.9) || !(e.delayBeats > 0 && e.delayBeats <= 4))) return false
  if (p.crossfader && !ok(p.crossfader, -1, 1)) return false
  if (p.overlapBars > 64) return false
  const B = p.overlapBars * 4
  if (p.tempo) {
    // the lane must hold the planned ratio over the overlap (the timeline depends on it) and stay within ±10 %
    if (!ok(p.tempo, 0.899, 1.101)) return false
    for (const beat of [0, B / 2, B]) if (Math.abs(curveAt(p.tempo, beat, 1) - p.tempoRatio) > 1e-3) return false
  }
  if (p.outLoop && !(p.outLoop.lengthBeats >= 1 && p.outLoop.lengthBeats <= 64 && p.outLoop.startBeat >= p.outLoop.lengthBeats - p.outCueSec / p.beatSec && p.outLoop.endBeat > p.outLoop.startBeat)) return false
  // the outgoing must end silent and the incoming at full level (no dropouts or stuck faders); the crossfader counts
  if (p.durationSec > 0) {
    const xf = p.crossfader?.length ? curveAt(p.crossfader, B, 0) : 0
    const outEnd = p.out.gain[p.out.gain.length - 1].value * Math.min(1, 1 - xf)
    const inEnd = p.in.gain[p.in.gain.length - 1].value * Math.min(1, 1 + xf)
    if (outEnd > 0.05 || inEnd < 0.9) return false
  }
  return true
}

/** Compact DSP-parameter summary of a plan for the trace (what the renderer will execute). */
export function dspSummary(p: TransitionPlan): Record<string, number | string | number[]> {
  const pick = (c: Array<{ beat: number; value: number }>) => [0, 0.25, 0.5, 0.75, 1].map((f) => round(c[Math.min(c.length - 1, Math.round(f * (c.length - 1)))]?.value ?? 0, 2))
  const s: Record<string, number | string | number[]> = {
    style: p.style,
    overlapBars: p.overlapBars,
    tempoRatio: round(p.tempoRatio, 4),
    outGain: pick(p.out.gain),
    inGain: pick(p.in.gain),
    outLowDb: pick(p.out.low),
    inLowDb: pick(p.in.low),
  }
  if (p.filter?.out) s.filterOut = pick(p.filter.out)
  if (p.filter?.in) s.filterIn = pick(p.filter.in)
  if (p.echo) s.echo = `${p.echo.delayBeats} beats, fb ${round(p.echo.feedback, 2)}`
  if (p.outPerf) s.perf = p.outPerf.ops.map((o) => o.kind).join('+')
  return s
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d

// ───────────────────────── ordering ─────────────────────────

/**
 * MixGraph pair compatibility: predicted severity of the best candidate transition for each
 * ordered pair (lower = more compatible). Used as an extra pair cost in the beam search.
 */
export function pairSeverity(rt: MlRuntime, keys: string[], summaries: Map<string, AnalysisSummary>, candidates: (a: AnalysisSummary, b: AnalysisSummary) => TransitionPlan[]): Map<string, number> {
  const out = new Map<string, number>()
  if (!rt.on.ordering) return out
  timed(rt, 'ordering', () => {
    for (const ka of keys)
      for (const kb of keys) {
        if (ka === kb) continue
        const sa = summaries.get(ka)!
        const sb = summaries.get(kb)!
        try {
          const cands = candidates(sa, sb).slice(0, 24)
          if (!cands.length || cands[0].style === 'sequential') continue
          const ranked = mixgraphRank(cands, sa, sb, rt.models.mixgraph!)
          out.set(`${ka}|${kb}`, Math.min(...ranked.map((r) => r.predictedSeverity)))
        } catch {
          /* pair left unscored → rule cost only */
        }
      }
  })
  bump(rt, 'ordering_pairs', out.size)
  return out
}

// ───────────────────────── DJCritic selection ─────────────────────────

export interface CriticAudio {
  /** Mono 16 kHz PCM of each track (whole track, or a crop starting at outStart/inStart seconds). */
  out: Float32Array
  in: Float32Array
  outStart?: number
  inStart?: number
}

export function monoAt(channels: Float32Array[], rate: number, target = 16000): Float32Array {
  const n = channels[0].length
  const m = new Float32Array(n)
  for (const c of channels) for (let i = 0; i < n; i++) m[i] += c[i] / channels.length
  return rate === target ? m : resample(m, rate, target)
}

/** Alternatives must preserve the timeline already solved by the mix planner. */
export function sameTransitionSlot(a: TransitionPlan, b: TransitionPlan): boolean {
  return Math.abs(a.outCueSec - b.outCueSec) < 0.01
    && Math.abs(a.inCueSec - b.inCueSec) < 0.01
    && a.incomingDropSec === b.incomingDropSec
    && a.incomingDropOffsetSec === b.incomingDropOffsetSec
    && a.overlapBars === b.overlapBars
    && Math.abs(a.durationSec - b.durationSec) < 0.01
    && Math.abs(a.tempoRatio - b.tempoRatio) < 1e-6
}

/**
 * Chooses among alternatives that keep the SAME cue points and overlap length (so the mix timeline
 * and duration are unchanged): the chosen plan, its rule-template version, and other techniques at
 * that cue. Each is rendered as a 16 kHz preview and scored; lowest quality score wins, candidates
 * with measured defects or high artifact probability cannot win on model quality alone.
 */
/**
 * `guard` (creative / energetic sets): the critic acts as a quality GUARD, not a taste-maker — it keeps
 * the planner's creative choice unless that choice is predicted to carry an artifact (> 0.5) or to be
 * clearly worse (quality more than 0.25 above the best alternative). The objective it was trained on
 * prefers the safest technique, which would otherwise flatten every creative transition.
 */
export function criticSelect(rt: MlRuntime, chosen: ScoredPlan, alternatives: TransitionPlan[], audio: CriticAudio | ((p: TransitionPlan) => CriticAudio), trims: { out: number; in: number }, pairLabel: string, guard = false): TransitionPlan {
  if (!rt.on.critic) return chosen
  const pool: TransitionPlan[] = [chosen]
  const controls = (p: TransitionPlan) =>
    JSON.stringify([p.style, p.out, p.in, p.handoffBeat, p.filter, p.echo, p.outPerf, (p as TechniquePlan).tech])
  const seen = new Set([controls(chosen)])
  for (const a of alternatives) {
    if (pool.length >= rt.options.criticAlternatives) break
    if (!sameTransitionSlot(chosen, a) || !validPlan(a)) continue
    const key = controls(a)
    if (seen.has(key)) continue
    seen.add(key)
    pool.push(a)
  }
  if (pool.length < 2) {
    bump(rt, 'critic_single')
    return chosen
  }
  try {
    const audioOf = typeof audio === 'function' ? audio : () => audio
    const scores = pool.map((p) => {
      const au = audioOf(p) // a technique's preview includes its own stem routing / deck edits
      return timed(rt, 'critic', () => criticScore(rt.models.critic!, p, au.out, au.outStart ?? 0, au.in, au.inStart ?? 0, 16000, trims))
    })
    bump(rt, 'critic_previews', pool.length)
    const measuredSafe = scores.map((s, i) => ({ s, i })).filter(({ s }) => s.previewDefects.length === 0)
    const eligible = measuredSafe.filter(({ s }) => Number.isFinite(s.quality) && Number.isFinite(s.artifact) && s.artifact <= 0.8)
    const template = (p: TransitionPlan) => !(p as TechniquePlan).tech && (p as ScoredPlan).mlSource !== 'transitionnet'
    const fallback = measuredSafe.find(({ i }) => template(pool[i]))?.i
      ?? measuredSafe[0]?.i
      ?? pool.findIndex(template)
    let choice = eligible.length
      ? eligible.reduce((best, entry) => entry.s.quality < best.s.quality ? entry : best).i
      : Math.max(0, fallback)
    let guardNote = eligible.length ? '' : ' (no candidate passed both measured and model checks; conservative fallback)'
    if (guard && eligible.length && choice !== 0 && eligible.some(({ i }) => i === 0) && scores[0].artifact <= 0.5 && scores[0].quality <= scores[choice].quality + 0.25) {
      guardNote = ` — guard mode: kept the creative choice (Δquality ${(scores[0].quality - scores[choice].quality).toFixed(3)} ≤ 0.25, artifact ${scores[0].artifact.toFixed(2)} ≤ 0.5)`
      choice = 0
    }
    const label = (p: TransitionPlan) => ((p as TechniquePlan).tech ? `${(p as TechniquePlan).tech!.technique} on ${p.style}` : `${p.style}${(p as ScoredPlan).mlSource === 'transitionnet' ? ' (TransitionNet)' : ' (template)'}`)
    rt.trace.decisions.push({
      stage: 'selection',
      model: 'critic_quality+critic_artifact',
      pair: pairLabel,
      inputs: { alternatives: pool.length, previewRateHz: 16000, outCueSec: round(chosen.outCueSec, 2), inCueSec: round(chosen.inCueSec, 2) },
      prediction: Object.fromEntries(pool.flatMap((p, i) => [[`${i}:${label(p)} quality`, round(scores[i].quality)], [`${i}:${label(p)} artifact`, round(scores[i].artifact, 3)], [`${i}:${label(p)} preview defects`, scores[i].previewDefects.join(', ') || 'none']])),
      decision: (choice === 0 ? `kept ${label(pool[0])}` : `switched to ${label(pool[choice])} (was ${label(pool[0])})`) + guardNote,
      dsp: dspSummary(pool[choice]),
    })
    if (choice !== 0) bump(rt, 'critic_switched')
    return pool[choice]
  } catch (e) {
    rt.trace.fallbacks.push(`DJCritic failed for ${pairLabel}: ${(e as Error).message}; planner choice kept`)
    return chosen
  }
}

/** Records the final per-transition controls the renderer will execute (TransitionNet vs template). */
export function traceAutomation(rt: MlRuntime, p: TransitionPlan, pairLabel: string): void {
  const sp = p as ScoredPlan & { tnParams?: ParamVector }
  rt.trace.decisions.push({
    stage: 'automation',
    model: sp.mlSource === 'transitionnet' ? 'transitionnet' : 'rules (template)',
    pair: pairLabel,
    inputs: { style: p.style, overlapBars: p.overlapBars, beatmatched: BEATMATCHED.has(p.style) ? 'yes' : 'no', channels: CTRL_CHANNELS.length },
    prediction: sp.tnParams ? Object.fromEntries(Object.entries(sp.tnParams).map(([k, v]) => [k, round(v, 3)])) : {},
    decision: sp.mlSource === 'transitionnet' ? 'renderer executes TransitionNet controls' : 'renderer executes the hand template',
    dsp: dspSummary(p),
  })
}

/**
 * DJCritic alternatives that keep the chosen cue points, overlap length and tempo ratio (so the
 * timeline is unchanged): other techniques of the same family at this overlap, their TransitionNet
 * versions, and the hand-template version of a TransitionNet-controlled plan.
 */
export function buildAlternatives(rt: MlRuntime, chosen: ScoredPlan, a: AnalysisSummary, b: AnalysisSummary, allow: (s: TransitionPlan['style']) => boolean): TransitionPlan[] {
  const B = chosen.overlapBars * 4
  const fam: TransitionPlan['style'][] = BEATMATCHED.has(chosen.style) ? ['long_blend', 'bass_swap', 'percussion_led', 'short_fade', 'filter_sweep'] : ['echo_out', 'loop_roll', 'unmatched_fade', 'brake', 'scratch_cut']
  const out: ScoredPlan[] = []
  const variant = (style: TransitionPlan['style']): ScoredPlan => {
    const auto = automationFor(style, B)
    const v: ScoredPlan & { tech?: unknown } = { ...chosen, style, out: auto.out, in: auto.in, handoffBeat: auto.handoffBeat, reasons: [...chosen.reasons.filter((r) => !r.startsWith('TransitionNet')), 'DJCritic alternative'], mlSource: 'rules' }
    delete v.tech
    delete (v as ScoredPlan & { tnParams?: ParamVector }).tnParams
    if (auto.filter) v.filter = auto.filter
    else delete v.filter
    if (auto.echo) v.echo = auto.echo
    else delete v.echo
    if (auto.outPerf) v.outPerf = auto.outPerf
    else delete v.outPerf
    return v
  }
  // the plain transition is always an alternative (a technique must beat it, or a creative brief must want it)
  if (chosen.mlSource === 'transitionnet' || (chosen as TechniquePlan).tech) out.push(variant(chosen.style))
  for (const s of fam) {
    if (s === chosen.style || !allow(s) || !OVERLAP_BARS[s].includes(chosen.overlapBars)) continue
    const v = variant(s)
    out.push(v)
    if (rt.on.transitionNet) {
      try {
        const tn = applyTransitionNet(v, transitionNetPredict(rt.models.transitionNet!, a, b, v))
        if (tn !== v && validPlan(tn)) out.push({ ...(tn as ScoredPlan), mlSource: 'transitionnet' })
      } catch {
        /* template variant still available */
      }
    }
  }
  return out
}
