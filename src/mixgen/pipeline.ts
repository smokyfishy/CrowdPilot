/**
 * Prompt-to-mix orchestrator. Environment-neutral: the host supplies I/O (acquisition,
 * decoding, analysis, render sink, cache) and the pipeline runs the same stages in the
 * browser render worker (deployed) and the Node research worker (local + E2E tests).
 *
 * Progress events count REAL completed units (queries, acquisitions, analyses, rendered
 * tracks); nothing is estimated or animated.
 */
import { summarize, type TrackAnalysis } from '../dsp/analyze'
import { describeEnergy, energyScores, type EnergyDescriptor } from './energy'
import { decideAccess, mixPermissions, type PolicyContext } from './policy'
import { matchesSongRequest } from './identity'
import { discover, relevant, type DiscoveryProvider } from './discovery'
import { orderSet, preselect, type OrderTrack, type ScoredCandidate } from './select'
import { planMix, type MixPlan, type PlannedTrack } from './mixplan'
import { renderMix, type AudioSink, type PcmTrack, type RenderResult } from './mix-render'
import { beatmatchable, candidateTransitions, DEFAULT_OPTIONS, type PlanTrack, type TransitionPlan } from '../dj/transitions'
import { applyDeckEdits, routeStems, type StemInfo, type TechniquePlan } from './techniques'
import { resample } from '../dsp/resample'
import { buildAlternatives, criticSelect, monoAt, pairSeverity, rankCandidatesWith, sameTransitionSlot, traceAutomation, type CriticAudio, type MlRuntime, type ScoredPlan } from './ml'
import { buildManifest, type MixManifest } from './manifest'
import { validateMix, type ValidationReport } from './validate'
import { resolveSpec, type MixSpec, type ResolvedSpec } from './spec'
import type { AccessDecision, AcquiredAudio, ProgressEvent, TrackCandidate, Unavailability } from './types'

export class AcquisitionError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'not_permitted' | 'network' | 'invalid_audio' | 'integrity',
  ) {
    super(message)
  }
}

export interface PipelineHost {
  providers: DiscoveryProvider[]
  policy: PolicyContext
  /** Acquire original audio (or return the cached copy). Must throw AcquisitionError on failure — never fake. */
  acquire(c: TrackCandidate, access: AccessDecision, attempt: number): Promise<AcquiredAudio>
  /** Decode to PCM at the mix rate (44.1 kHz stereo float). */
  decode(audio: AcquiredAudio): Promise<PcmTrack>
  /** Full analysis (cached by content hash + analyzer version when the host can). */
  analyze(audio: AcquiredAudio, pcm: PcmTrack): Promise<TrackAnalysis>
  sink: AudioSink
  /** Optional render override (browser: runs renderMix inside a Web Worker). */
  render?(plan: MixPlan, load: (key: string) => Promise<PcmTrack>, onProgress: (done: number, total: number, detail: string) => void): Promise<RenderResult>
  progress(ev: ProgressEvent): void
  log?(msg: string): void
  signal?: AbortSignal
  /** Reuse prior stage outputs (regeneration / resume). */
  previous?: { pool?: TrackCandidate[]; analyses?: Map<string, AnalyzedEntry> }
  /** Learned-DJ runtime (src/mixgen/ml.ts). Absent = rules only (logged in the manifest). */
  ml?: MlRuntime
  /** Stem separation (local worker): vocal activity + separation check, and a loader for the stems. */
  stems?: (audio: AcquiredAudio, analysis: TrackAnalysis) => Promise<{ info: StemInfo; load: () => Promise<{ vocals: Float32Array[]; inst: Float32Array[] }> } | null>
  concurrency?: number
}

export interface AnalyzedEntry {
  candidate: TrackCandidate
  access: AccessDecision
  audio: AcquiredAudio
  analysis: TrackAnalysis
  energy: EnergyDescriptor
}

export interface PipelineResult {
  spec: ResolvedSpec
  pool: TrackCandidate[]
  acquisition: Array<{ trackKey: string; title: string; artist: string; source: string; status: string; reason: string }>
  analyses: Map<string, AnalyzedEntry>
  order: string[]
  plan: MixPlan
  render: RenderResult
  manifest: MixManifest
  validation: ValidationReport
  unavailable: Unavailability[]
}

export const TARGET_LUFS = -12

export function trimFor(lufs: number, truePeakDb: number): number {
  if (!Number.isFinite(lufs) || lufs < -60) return 0
  // Loudness match, but never push more than ~4 dB into the master limiter.
  return Math.round(Math.min(TARGET_LUFS - lufs, -1 - truePeakDb + 4, 12) * 10) / 10
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

export interface RunOptions {
  /** Keep this fixed order of track keys (user edits / no reordering). */
  fixedOrder?: string[]
  /** Track keys the user removed or asked to replace (excluded from selection). */
  exclude?: string[]
  /** Track keys that must be included (user pinned). */
  include?: string[]
  /** Stop after planning (review step) without rendering. */
  planOnly?: boolean
  title?: string
}

export async function runPipeline(rawSpec: MixSpec, host: PipelineHost, opts: RunOptions = {}): Promise<PipelineResult | { planOnly: true; spec: ResolvedSpec; order: string[]; plan: MixPlan; analyses: Map<string, AnalyzedEntry>; acquisition: PipelineResult['acquisition']; unavailable: Unavailability[]; pool: TrackCandidate[] }> {
  const log = host.log ?? (() => {})
  const spec = resolveSpec(rawSpec)
  host.progress({ stage: 'understanding', done: 1, total: 1, detail: spec.title })

  // ── 2. discovery ──
  let pool0 = host.previous?.pool
  if (!pool0) {
    const res = await discover(spec, host.providers, { signal: host.signal, onQuery: (d, t) => host.progress({ stage: 'discovering', done: d, total: t }) })
    pool0 = res.pool.filter((c) => relevant(spec, c))
    log(`discovery: ${res.queries} queries → ${res.pool.length} recordings (${JSON.stringify(res.bySource)}), ${res.crossResolved.length} YouTube→authorized matches`)
  } else host.progress({ stage: 'discovering', done: 1, total: 1, detail: 'reused candidate pool' })
  const excluded = new Set(opts.exclude ?? [])
  const candPool = pool0.filter((c) => !excluded.has(c.trackKey))

  // ── 3. resolving: central access policy ──
  const access = new Map<string, AccessDecision>()
  candPool.forEach((c, i) => {
    access.set(c.trackKey, decideAccess(c, host.policy))
    if (i % 10 === 0 || i === candPool.length - 1) host.progress({ stage: 'resolving', done: i + 1, total: candPool.length })
  })
  const mixable = (c: TrackCandidate) => !!access.get(c.trackKey)?.mix && (c.durationSec ?? 200) >= 90
  const pre = preselect(spec, candPool, mixable, 0.75)
  log(`resolving: ${candPool.filter(mixable).length}/${candPool.length} mixable under policy; acquiring ${pre.toAcquire.length}`)
  // Pinned includes first.
  const include = new Set(opts.include ?? [])
  const queue: ScoredCandidate[] = [...pre.ranked.filter((s) => include.has(s.candidate.trackKey)), ...pre.toAcquire.filter((s) => !include.has(s.candidate.trackKey))]
  const reserve = pre.ranked.filter((s) => !queue.includes(s))

  // ── 4+5. acquisition and analysis ──
  const analyses = new Map<string, AnalyzedEntry>(host.previous?.analyses ?? [])
  const acquisition: PipelineResult['acquisition'] = []
  const want = Math.min(pre.ranked.length, Math.ceil(spec.songCount * 1.5))
  const maxAcquire = Math.ceil(spec.songCount * 2.5)
  let acquiredCount = 0
  let analyzedCount = 0
  const total = () => Math.max(queue.length, want)
  const work = async (s: ScoredCandidate) => {
    const c = s.candidate
    const a = access.get(c.trackKey)!
    const prior = analyses.get(c.trackKey)
    if (prior) {
      acquisition.push({ trackKey: c.trackKey, title: c.title, artist: c.artist, source: c.source, status: 'cached', reason: 'reused from cache' })
      acquiredCount++
      analyzedCount++
      host.progress({ stage: 'acquiring', done: acquiredCount, total: total() })
      host.progress({ stage: 'analyzing', done: analyzedCount, total: total() })
      return
    }
    let audio: AcquiredAudio | null = null
    let lastErr: AcquisitionError | Error | null = null
    for (let attempt = 1; attempt <= 3 && !audio; attempt++) {
      try {
        audio = await host.acquire(c, a, attempt)
      } catch (e) {
        lastErr = e as Error
        if (e instanceof AcquisitionError && (e.code === 'not_permitted' || e.code === 'unavailable' || e.code === 'invalid_audio')) break
      }
    }
    if (!audio) {
      const code = lastErr instanceof AcquisitionError ? lastErr.code : 'network'
      acquisition.push({ trackKey: c.trackKey, title: c.title, artist: c.artist, source: c.source, status: code === 'not_permitted' ? 'not_permitted' : code === 'unavailable' ? 'unavailable' : 'failed', reason: lastErr?.message ?? 'unknown' })
      log(`acquire FAILED ${c.trackKey}: ${lastErr?.message}`)
      return
    }
    acquiredCount++
    acquisition.push({ trackKey: c.trackKey, title: c.title, artist: c.artist, source: c.source, status: 'acquired', reason: `${audio.container}${audio.codec ? '/' + audio.codec : ''}, ${(audio.bytes / 1e6).toFixed(1)} MB, sha256 ${audio.sha256.slice(0, 12)}` })
    host.progress({ stage: 'acquiring', done: acquiredCount, total: total(), detail: c.title })
    try {
      const pcm = await host.decode(audio)
      const analysis = await host.analyze(audio, pcm)
      if (analysis.qc.mostlySilent || analysis.qc.durationSec < 60) throw new Error(`audio QC failed: ${analysis.qc.issues.join(', ') || 'too short'}`)
      analyses.set(c.trackKey, { candidate: c, access: a, audio, analysis, energy: describeEnergy(analysis) })
      analyzedCount++
      host.progress({ stage: 'analyzing', done: analyzedCount, total: total(), detail: `${c.title}: ${analysis.grid.bpm.toFixed(1)} BPM ${analysis.key.camelot}` })
    } catch (e) {
      const row = acquisition.find((r) => r.trackKey === c.trackKey)!
      row.status = 'failed'
      row.reason = `invalid audio: ${(e as Error).message}`
      log(`analysis FAILED ${c.trackKey}: ${(e as Error).message}`)
    }
  }
  await pool(queue, host.concurrency ?? 2, work)
  // Top up from the reserve when acquisitions or analyses failed.
  // …and until enough tracks have reliable beat grids for beat-matched blends.
  const gridOkCount = () => [...analyses.values()].filter((e) => beatmatchable(summarize(e.analysis))).length
  while ((analyses.size < want || gridOkCount() < spec.songCount) && reserve.length && queue.length < maxAcquire) {
    const need = Math.max(1, want - analyses.size, spec.songCount - gridOkCount())
    const batch = reserve.splice(0, Math.min(reserve.length, need, maxAcquire - queue.length))
    queue.push(...batch)
    await pool(batch, host.concurrency ?? 2, work)
  }
  let usable = [...analyses.values()].filter((e) => !excluded.has(e.candidate.trackKey))
  // Exact song list: keep one analyzed recording per requested song (preference order from preselect).
  if (!spec.allowSubstitutions && spec.songs.length) {
    const rank = new Map(pre.ranked.map((s, i) => [s.candidate.trackKey, i]))
    const keep: AnalyzedEntry[] = []
    for (const req of spec.songs) {
      const m = usable.filter((e) => matchesSongRequest(req, e.candidate)).sort((a, b) => (rank.get(a.candidate.trackKey) ?? 1e9) - (rank.get(b.candidate.trackKey) ?? 1e9))
      if (m[0] && !keep.includes(m[0])) keep.push(m[0])
    }
    usable = keep
  }
  if (usable.length < 2) throw new Error(`Only ${usable.length} recording(s) could be acquired and analyzed — not enough for a mix. ${acquisition.filter((a) => a.status !== 'acquired').map((a) => `${a.title}: ${a.reason}`).join('; ')}`)

  // ── 6+7. selection and ordering ──
  host.progress({ stage: 'selecting', done: 0, total: 1 })
  const scores = energyScores(usable.map((e) => e.energy))
  const prefBy = new Map(pre.ranked.map((s) => [s.candidate.trackKey, s.score]))
  const maxPref = Math.max(1, ...usable.map((e) => prefBy.get(e.candidate.trackKey) ?? 0))
  const orderTracks: OrderTrack[] = usable.map((e, i) => {
    const s = summarize(e.analysis)
    const base = (prefBy.get(e.candidate.trackKey) ?? 0) / maxPref
    return {
      key: e.candidate.trackKey,
      pref: 2.0 * base + (include.has(e.candidate.trackKey) ? 50 : 0),
      bpm: s.bpm,
      bpmConf: s.bpmConf,
      camelot: s.camelot,
      keyConf: s.keyConf,
      energy: scores[i],
      dropStrength: e.energy.dropStrength,
      vocal: (s.vocalIn + s.vocalOut) / 2,
      artist: e.candidate.identity.artist,
      durationSec: s.durationSec,
      gridOk: beatmatchable(s),
    }
  })
  const count = Math.min(spec.songCount, orderTracks.length)
  host.progress({ stage: 'selecting', done: 1, total: 1, detail: `${count} of ${orderTracks.length} analyzed recordings` })
  const fixed = opts.fixedOrder ?? (!spec.allowReordering && spec.songs.length ? undefined : undefined)
  // Learned pair compatibility (MixGraph) for the beam search, traced against the rule-only order.
  const ml = host.ml
  let pairExtra: ((a: OrderTrack, b: OrderTrack) => number) | undefined
  if (ml?.on.ordering && !fixed) {
    const summaries = new Map(usable.map((e) => [e.candidate.trackKey, summarize(e.analysis)]))
    const pt = (s: ReturnType<typeof summarize>, k: string): PlanTrack => ({ itemId: k, trackKey: k, title: k, mixable: true, summary: s, durationSec: s.durationSec })
    const sev = pairSeverity(ml, [...summaries.keys()], summaries, (sa, sb) => candidateTransitions(pt(sa, 'a'), pt(sb, 'b'), DEFAULT_OPTIONS))
    if (sev.size) pairExtra = (a, b) => ml.options.orderWeight * (sev.get(`${a.key}|${b.key}`) ?? 0.05)
  }
  const ord = orderSet(orderTracks, spec, { count, fixedOrder: fixed, pairExtra })
  if (ml && pairExtra) {
    const rulesOnly = orderSet(orderTracks, spec, { count })
    const changed = rulesOnly.order.join('|') !== ord.order.join('|')
    const name = (k: string) => analyses.get(k)?.candidate.title ?? k
    ml.trace.decisions.push({
      stage: 'ordering',
      model: 'mixgraph_quality',
      inputs: { tracks: orderTracks.length, scoredPairs: ml.trace.counts.ordering_pairs ?? 0, weight: ml.options.orderWeight },
      prediction: { learnedPairCost: Math.round(ord.parts.learned * 1000) / 1000, rulesOnlyCost: Math.round(rulesOnly.cost * 1000) / 1000 },
      decision: changed ? `order changed by the model: ${ord.order.map(name).join(' → ')} (rules alone: ${rulesOnly.order.map(name).join(' → ')})` : 'same order as rules alone',
    })
  }
  host.progress({ stage: 'ordering', done: 1, total: 1, detail: `beam search explored ${ord.explored} states` })
  log(`ordering: cost ${ord.cost.toFixed(2)} parts ${JSON.stringify(ord.parts)}`)

  // ── 8. transitions + duration ──
  const planned: PlannedTrack[] = ord.order.map((k) => {
    const e = analyses.get(k)!
    const s = summarize(e.analysis)
    return { key: k, title: `${e.candidate.artist} – ${e.candidate.title}`, summary: s, trimDb: trimFor(e.analysis.loudness.integratedLufs, e.analysis.loudness.truePeakDbtp), netBeats: e.analysis.netBeats }
  })
  // Stems (local worker only): separated for the ordered set, used for layering/mashup techniques.
  const stemInfo = new Map<string, StemInfo>()
  const stemLoad = new Map<string, () => Promise<{ vocals: Float32Array[]; inst: Float32Array[] }>>()
  if (host.stems) {
    for (const [i, t] of planned.entries()) {
      host.progress({ stage: 'transitions', done: i, total: planned.length, detail: `separating stems ${i + 1}/${planned.length} (vocals / instrumental)` })
      try {
        const e = analyses.get(t.key)!
        const r = await host.stems(e.audio, e.analysis)
        if (r) {
          stemInfo.set(t.key, r.info)
          stemLoad.set(t.key, r.load)
          if (!r.info.clean) log(`stems: ${t.title} failed the separation check (bass bleed ${r.info.bleed}); no layering on this track`)
        }
      } catch (err) {
        log(`stems: ${t.title}: ${(err as Error).message}`)
      }
    }
  }
  const plan = planMix(planned, spec, { ...(ml && (ml.on.mixgraph || ml.on.transitionNet) ? { rankCandidates: rankCandidatesWith(ml) } : {}), techniques: { enabled: true, stems: stemInfo } })
  // DJCritic: choose among same-cue alternatives using rendered previews of the real audio.
  if (ml?.on.critic && plan.transitions.length) {
    const mono = new Map<string, Float32Array>()
    const monoOf = async (k: string) => {
      if (!mono.has(k)) {
        const pcm = await host.decode(analyses.get(k)!.audio)
        mono.set(k, monoAt(pcm.channels, pcm.rate, 16000))
        if (mono.size > 3) mono.delete(mono.keys().next().value!)
      }
      return mono.get(k)!
    }
    const lively = spec.transitionStyle === 'creative' || spec.transitionStyle === 'energetic'
    const allow = (s: string) =>
      !(s === 'filter_sweep' && (spec.transitionStyle === 'smooth' || spec.transitionStyle === 'minimal')) &&
      !((s === 'loop_roll' || s === 'brake') && !lively) &&
      !(s === 'scratch_cut' && !spec.features.includes('scratching'))
    for (const [i, tr] of plan.transitions.entries()) {
      host.progress({ stage: 'transitions', done: i, total: plan.transitions.length, detail: `DJCritic ${i + 1}/${plan.transitions.length}` })
      const a = planned[i]
      const b = planned[i + 1]
      const chosen = tr.plan as TechniquePlan
      const standard = buildAlternatives(ml, chosen as ScoredPlan, a.summary, b.summary, allow)
      const creative = plan.candidates[i].find((p) => {
        const tech = (p as TechniquePlan).tech
        return tech && tech.technique !== chosen.tech?.technique && sameTransitionSlot(chosen, p)
      })
      // Keep a template in the preview budget when a creative or learned control plan is chosen.
      const alts = creative ? [...standard.slice(0, 1), creative, ...standard.slice(1)] : standard
      if (!alts.length) continue
      const audio = { out: await monoOf(a.key), in: await monoOf(b.key) }
      let audioFor: CriticAudio | ((p: TransitionPlan) => CriticAudio) = audio
      const techniques = [chosen, ...alts].map((p) => (p as TechniquePlan).tech)
      if (techniques.some(Boolean)) {
        const [pa, pb] = [await host.decode(analyses.get(a.key)!.audio), await host.decode(analyses.get(b.key)!.audio)]
        const [sa, sb] = techniques.some((tech) => tech?.stems)
          ? [await stemLoad.get(a.key)?.(), await stemLoad.get(b.key)?.()]
          : [undefined, undefined]
        audioFor = (p) => ((p as TechniquePlan).tech ? techPreview(p as TechniquePlan, pa, pb, sa, sb) : audio)
      }
      tr.plan = criticSelect(ml, tr.plan as ScoredPlan, alts, audioFor, { out: a.trimDb, in: b.trimDb }, `${i + 1}→${i + 2}`, lively)
    }
  }
  if (ml) plan.transitions.forEach((tr, i) => traceAutomation(ml, tr.plan, `${i + 1}→${i + 2}`))
  host.progress({ stage: 'transitions', done: plan.transitions.length, total: Math.max(1, planned.length - 1), detail: plan.transitions.map((t) => t.plan.style).join(', ') })
  for (const n of plan.notes) log(`plan: ${n}`)

  // Unavailability, including substitution notes.
  const unavailable = pre.unavailable.map((u) => (spec.allowSubstitutions ? { ...u, substitutedWith: ord.order.slice(0, 3).map((k) => analyses.get(k)!.candidate.artist) } : u))
  if (opts.planOnly) return { planOnly: true, spec, order: ord.order, plan, analyses, acquisition, unavailable, pool: pool0 }

  // ── 9. render ──
  const loaded = new Map<string, PcmTrack>()
  const onRender = (d: number, t: number, detail: string) => host.progress({ stage: 'rendering', done: d, total: t, detail })
  const render = host.render
    ? await host.render(plan, (key) => host.decode(analyses.get(key)!.audio), onRender)
    : await renderMix(
    plan,
    {
      async load(key) {
        const hit = loaded.get(key)
        if (hit) return hit
        const pcm = await host.decode(analyses.get(key)!.audio)
        loaded.set(key, pcm)
        return pcm
      },
      release(key) {
        loaded.delete(key)
      },
      loadStems: async (key) => (stemLoad.get(key) ? await stemLoad.get(key)!() : null),
    },
    host.sink,
    onRender,
  )

  // ── 10. validate ──
  const perms = mixPermissions(ord.order.map((k) => analyses.get(k)!.access))
  const manifest = buildManifest({ spec, plan, render, analyses, order: ord.order, unavailable, permissions: perms, acquisition, title: opts.title })
  manifest.ml = ml?.trace ?? { mode: 'off', options: undefined, models: [], decisions: [], fallbacks: ['no ML runtime provided by this host: rule-based planner only'], timingsMs: {}, counts: {} }
  const validation = validateMix(manifest, render)
  host.progress({ stage: 'validating', done: 1, total: 1, detail: validation.ok ? 'passed' : validation.failures.join('; ') })
  manifest.validation = validation
  host.progress({ stage: 'ready', done: 1, total: 1 })
  return { spec, pool: pool0, acquisition, analyses, order: ord.order, plan, render, manifest, validation, unavailable }
}

/** 16 kHz mono preview audio of a technique plan (stem routing + deck edits applied, cropped). */
function techPreview(p: TechniquePlan, a: PcmTrack, b: PcmTrack, sa?: { vocals: Float32Array[]; inst: Float32Array[] }, sb?: { vocals: Float32Array[]; inst: Float32Array[] }): CriticAudio {
  const tech = p.tech!
  let outDeck = a.channels
  let inDeck = b.channels
  if (tech.stems && sa && sb) {
    outDeck = routeStems(outDeck, sa, a.rate, p.outCueSec - 0.1, p.outCueSec + p.durationSec + 0.1, (t) => (t - p.outCueSec) / p.beatSec, tech.stems.out)
    inDeck = routeStems(inDeck, sb, b.rate, p.inCueSec - 0.1, p.inCueSec + p.durationSec * p.tempoRatio + 0.1, (t) => (t - p.inCueSec) / (p.beatSec * p.tempoRatio), tech.stems.in)
  }
  if (tech.deckEdits?.out?.length) outDeck = applyDeckEdits(outDeck, a.rate, tech.deckEdits.out)
  if (tech.deckEdits?.in?.length) inDeck = applyDeckEdits(inDeck, b.rate, tech.deckEdits.in)
  const crop = (ch: Float32Array[], rate: number, s0: number, s1: number) => {
    const i0 = Math.max(0, Math.floor(s0 * rate))
    const i1 = Math.min(ch[0].length, Math.ceil(s1 * rate))
    const m = new Float32Array(Math.max(0, i1 - i0))
    for (const c of ch) for (let k = 0; k < m.length; k++) m[k] += c[i0 + k] / ch.length
    return { mono: rate === 16000 ? m : resample(m, rate, 16000), start: i0 / rate }
  }
  const o = crop(outDeck, a.rate, p.outCueSec - 10, p.outCueSec + p.durationSec + 10)
  const i = crop(inDeck, b.rate, p.inCueSec - 1, p.inCueSec + p.durationSec * Math.max(1, p.tempoRatio) + 10)
  return { out: o.mono, in: i.mono, outStart: o.start, inStart: i.start }
}
