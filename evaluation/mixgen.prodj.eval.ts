/**
 * Controlled comparison of the professional DJ upgrade on the SAME real recordings (cached audio and
 * analyses of a finished research set):
 *   1 existing        production as deployed: beam order (+MixGraph) → per-pair cue DP (+MixGraph,
 *                     TransitionNet v1 — the UI forces it on) → DJCritic same-slot selection
 *   2 global          global set planner, existing transition controls (templates / techniques)
 *   3 longform        existing planner, long-form staged performances on eligible transitions
 *   4 global+longform
 *   5 full            global + long-form + closed-loop render/evaluate/refine/re-plan
 *
 * Each transition is rendered at 44.1 kHz with the production renderer, 8 bars before → overlap → 8
 * bars after, and measured. Two metric families are reported separately:
 *   - closed-loop metrics (src/mixgen/audio-quality.ts) — variant 5 OPTIMISES these (circular for 5);
 *   - independent checks it does not optimise: Beat This! beat offsets on each deck, the legacy
 *     objective proxies (evaluation/mixgen-metrics.ts), level change 8 bars before/after, DJCritic
 *     as a fixed referee (partly circular for 5, which uses it as a capped term).
 * Listening (WAVs, full mixes, blind A/B page) is the real test.
 *
 *   MIXGEN_REPORT=C:/crowdpilot-data/mixgen/renders/research/research-techhouse-4.report.json \
 *   [PRODJ_VARIANTS=existing,full] [PRODJ_TAG=x] [PRODJ_FULLMIX=existing,full] [PRODJ_BUDGET=160] \
 *   npx vitest run -c vitest.eval.config.ts evaluation/mixgen.prodj.eval.ts
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { ANALYZER_VERSION, summarize, type TrackAnalysis } from '../src/dsp/analyze'
import { runBeatNet, BEATNET_SR } from '../src/dsp/beatnet'
import { resample } from '../src/dsp/resample'
import { encodeWav, renderTransition } from '../src/dj/render'
import { candidateTransitions, DEFAULT_OPTIONS, beatmatchable, type PlanTrack, type TransitionPlan } from '../src/dj/transitions'
import { describeEnergy, energyScores } from '../src/mixgen/energy'
import { buildAlternatives, criticSelect, monoAt, pairSeverity, rankCandidatesWith, traceAutomation, type ScoredPlan } from '../src/mixgen/ml'
import { buildTimeline, planMix, type MixPlan, type PlannedTrack } from '../src/mixgen/mixplan'
import { buildPerformance, longformEligible } from '../src/mixgen/longform'
import { applyDeckEdits, applyReverbWash, routeStems, type StemInfo, type TechniquePlan } from '../src/mixgen/techniques'
import { trimFor } from '../src/mixgen/pipeline'
import { orderSet, type OrderTrack } from '../src/mixgen/select'
import type { ResolvedSpec } from '../src/mixgen/spec'
import { criticScore } from '../src/ml/dj-brain'
import { planProDj, type ProDjModes, type ProDjTrace } from '../src/mixgen/prodj'
import { evaluateTransition } from '../src/mixgen/audio-quality'
import { buildProfile, type TrackProfile } from '../src/mixgen/profile'
import { PREVIEW_RATE } from '../src/mixgen/closedloop'
import { renderMix } from '../src/mixgen/mix-render'
import { createEncoder, decodePcm } from '../worker-node/mixgen/ffmpeg'
import { nodeMlRuntime } from '../worker-node/mixgen/ml-runtime'
import { fromJson, MIXGEN_ROOT, readIndex } from '../worker-node/mixgen/storage'
import { stemInfo, loadStems } from '../worker-node/mixgen/stems'
import { nodeBeatNet } from './beatnet-node'
import { transitionMetrics } from './mixgen-metrics'
import { page } from './ab-page'

type VariantName = 'existing' | 'global' | 'longform' | 'global+longform' | 'full'
const VARIANTS: Array<{ name: VariantName; modes?: ProDjModes }> = [
  { name: 'existing' },
  { name: 'global', modes: { global: true, longform: false, closedLoop: false } },
  { name: 'longform', modes: { global: false, longform: true, closedLoop: false } },
  { name: 'global+longform', modes: { global: true, longform: true, closedLoop: false } },
  { name: 'full', modes: { global: true, longform: true, closedLoop: true } },
]

const R = 44100

it('professional DJ upgrade: controlled comparison on real recordings', async () => {
  const reportPath = process.env.MIXGEN_REPORT ?? join(MIXGEN_ROOT, 'renders', 'research', 'research-techhouse-4.report.json')
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { jobId?: string; spec: ResolvedSpec; songs: Array<{ trackKey: string; usedSource?: string; status: string; title: string; artist?: string }> }
  const jobId = report.jobId ?? reportPath.split(/[\\/]/).pop()!.replace('.report.json', '')
  const tag = process.env.PRODJ_TAG ?? jobId
  const idx = readIndex()
  const out = join(MIXGEN_ROOT, 'prodj', tag)
  mkdirSync(out, { recursive: true })
  const pool = report.songs.filter((s) => (s.status === 'downloaded' || s.status === 'cached') && idx[s.usedSource ?? s.trackKey])
  const seenSha = new Set<string>()
  const entries = pool
    .map((s) => {
      const e = idx[s.usedSource ?? s.trackKey]
      const p = join(MIXGEN_ROOT, 'analysis', `${e.sha256}-${ANALYZER_VERSION}-bt.json`)
      if (!existsSync(p) || seenSha.has(e.sha256)) return null
      seenSha.add(e.sha256)
      const a = fromJson<TrackAnalysis>(readFileSync(p, 'utf8'))
      return { key: s.trackKey, title: s.title, artist: s.artist ?? s.title, path: e.path, sha: e.sha256, analysis: a, summary: summarize(a), energy: describeEnergy(a) }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  const spec = report.spec
  const songCount = Math.min(Number(process.env.PRODJ_SONGS ?? spec.songCount), entries.length)
  const byKey = new Map(entries.map((e) => [e.key, e]))
  // stems: cached separations only (MIXGEN_STEMS=1); none → EQ-based element control
  const stems = new Map<string, StemInfo>()
  const stemPcm = new Map<string, { vocals: Float32Array[]; inst: Float32Array[] }>()
  if (process.env.MIXGEN_STEMS === '1') {
    for (const e of entries) {
      const dir = join(MIXGEN_ROOT, 'stems', e.sha)
      if (!existsSync(join(dir, 'vocals.wav'))) continue
      const s = await loadStems({ vocals: join(dir, 'vocals.wav'), inst: join(dir, 'no_vocals.wav') }, R)
      stems.set(e.key, stemInfo(s.vocals, R, e.analysis))
      stemPcm.set(e.key, s)
    }
  }
  process.stderr.write(`PRODJ ${tag}: ${entries.length} analysed recordings, ${songCount} per set, stems for ${stems.size}\n`)
  // audio caches
  const pcm = new Map<string, Float32Array[]>()
  const load = async (k: string) => {
    if (!pcm.has(k)) pcm.set(k, (await decodePcm(byKey.get(k)!.path, R)).channels)
    return pcm.get(k)!
  }
  const mono16 = new Map<string, Float32Array>()
  const audio16 = async (k: string) => {
    if (!mono16.has(k)) mono16.set(k, monoAt(await load(k), R, PREVIEW_RATE))
    return mono16.get(k)!
  }
  const stems16 = async (k: string) => {
    const s = stemPcm.get(k)
    return s ? { vocals: monoAt(s.vocals, R, PREVIEW_RATE), inst: monoAt(s.inst, R, PREVIEW_RATE) } : null
  }
  const profiles = new Map<string, TrackProfile>(entries.map((e) => [e.key, buildProfile(e.analysis, stems.get(e.key))]))
  const bn = await nodeBeatNet()
  const referee = (await nodeMlRuntime(process.cwd())).models.critic!
  const trims = new Map(entries.map((e) => [e.key, trimFor(e.analysis.loudness.integratedLufs, e.analysis.loudness.truePeakDbtp)]))
  const pt = (s: ReturnType<typeof summarize>, k: string): PlanTrack => ({ itemId: k, trackKey: k, title: k, mixable: true, summary: s, durationSec: s.durationSec })
  const results: Array<Record<string, unknown>> = []
  const requested = process.env.PRODJ_VARIANTS?.split(',').map((x) => x.trim())
  const variants = requested ? VARIANTS.filter((v) => requested.includes(v.name)) : VARIANTS
  const fullMix = new Set((process.env.PRODJ_FULLMIX ?? 'existing,full').split(',').map((x) => x.trim()))
  const wavs: Record<string, string[]> = {}

  let legacyCache: { order: string[]; planned: PlannedTrack[]; plan: MixPlan } | undefined
  /** The existing production planner (beam order + MixGraph, cue DP + MixGraph/TransitionNet v1, DJCritic). */
  const legacyPlan = async () => {
    if (legacyCache) return { ...legacyCache, plan: { ...legacyCache.plan, transitions: legacyCache.plan.transitions.map((t) => ({ ...t })) } }
    const ml = await nodeMlRuntime(process.cwd(), { transitionNet: true })
    const scores = energyScores(entries.map((e) => e.energy))
    const orderTracks: OrderTrack[] = entries.map((e, i) => ({ key: e.key, pref: 1, bpm: e.summary.bpm, bpmConf: e.summary.bpmConf, camelot: e.summary.camelot, keyConf: e.summary.keyConf, energy: scores[i], dropStrength: e.energy.dropStrength, vocal: (e.summary.vocalIn + e.summary.vocalOut) / 2, artist: e.artist, durationSec: e.summary.durationSec, gridOk: beatmatchable(e.summary) }))
    const summaries = new Map(entries.map((e) => [e.key, e.summary]))
    const sev = pairSeverity(ml, [...summaries.keys()], summaries, (sa, sb) => candidateTransitions(pt(sa, 'a'), pt(sb, 'b'), DEFAULT_OPTIONS))
    const order = orderSet(orderTracks, spec, { count: songCount, pairExtra: sev.size ? (a, b) => ml.options.orderWeight * (sev.get(`${a.key}|${b.key}`) ?? 0.05) : undefined }).order
    const planned: PlannedTrack[] = order.map((k) => {
      const e = byKey.get(k)!
      return { key: k, title: e.title, summary: e.summary, trimDb: trims.get(k)!, netBeats: e.analysis.netBeats }
    })
    const plan = planMix(planned, spec, { rankCandidates: rankCandidatesWith(ml), preferLongDropBlends: true, techniques: { enabled: true, stems } })
    const lively = spec.transitionStyle === 'creative' || spec.transitionStyle === 'energetic'
    for (const [i, tr] of plan.transitions.entries()) {
      const alts = buildAlternatives(ml, tr.plan as ScoredPlan, planned[i].summary, planned[i + 1].summary, (s) => !(s === 'filter_sweep' && spec.transitionStyle === 'smooth'))
      if (alts.length) tr.plan = criticSelect(ml, tr.plan as ScoredPlan, alts, { out: await audio16(planned[i].key), in: await audio16(planned[i + 1].key) }, { out: planned[i].trimDb, in: planned[i + 1].trimDb }, `${i + 1}→${i + 2}`, lively)
      traceAutomation(ml, tr.plan, `${i + 1}→${i + 2}`)
    }
    legacyCache = { order, planned, plan }
    return legacyPlan()
  }

  for (const v of variants) {
    const t0 = Date.now()
    let order: string[]
    let plan: MixPlan
    let planned: PlannedTrack[]
    let trace: ProDjTrace | undefined
    // production ML options (UI sends automation_model 'transitionnet' → TransitionNet v1 on)
    const ml = await nodeMlRuntime(process.cwd(), v.name === 'existing' ? { transitionNet: true } : { transitionNet: false })
    if (v.name === 'existing' || v.name === 'longform') {
      const legacy = await legacyPlan()
      order = legacy.order
      planned = legacy.planned
      plan = legacy.plan
      if (v.name === 'longform') {
        // long-form alone: the EXISTING order, cues and overlap lengths; only eligible transitions are
        // re-performed by the staged generator (rule solver)
        const plans = plan.transitions.map((tr, i) => {
          const p = tr.plan
          if (!longformEligible(p)) return p
          const pa = profiles.get(planned[i].key)!
          const pb = profiles.get(planned[i + 1].key)!
          return buildPerformance({ base: p, pa, pb, stems: { a: stems.get(planned[i].key), b: stems.get(planned[i + 1].key) } })
        })
        const tl = buildTimeline(planned, plans)
        plan = { ...plan, tracks: tl.tracks, transitions: tl.transitions, durationSec: tl.durationSec }
      }
    } else {
      const res = await planProDj({
        entries: entries.map((e) => ({ key: e.key, title: e.title, artist: e.artist, genres: spec.genres, analysis: e.analysis, energy: e.energy, pref: 1, trimDb: trims.get(e.key)! })),
        spec,
        count: songCount,
        ml,
        stems,
        audio: { audio: audio16, stems: stems16 },
        modes: v.modes!,
        budget: Number(process.env.PRODJ_BUDGET ?? 160),
        log: (m) => process.stderr.write(`  [${v.name}] ${m}\n`),
      })
      order = res.order
      plan = res.plan
      planned = res.planned
      trace = res.trace
    }
    const planMs = Date.now() - t0
    // ── render + measure every transition ──
    const rows: Array<Record<string, unknown>> = []
    const vdir = join(out, v.name)
    mkdirSync(vdir, { recursive: true })
    wavs[v.name] = []
    for (const [i, tr] of plan.transitions.entries()) {
      const p = tr.plan as TechniquePlan
      const ka = planned[i].key
      const kb = planned[i + 1].key
      let a = await load(ka)
      let b = await load(kb)
      const tech = p.tech
      if (tech?.stems && stemPcm.get(ka) && stemPcm.get(kb)) {
        a = routeStems(a, stemPcm.get(ka)!, R, p.outCueSec - 0.1, p.outCueSec + p.durationSec + 0.1, (t) => (t - p.outCueSec) / p.beatSec, tech.stems.out)
        b = routeStems(b, stemPcm.get(kb)!, R, p.inCueSec - 0.1, p.inCueSec + p.durationSec * p.tempoRatio + 0.1, (t) => (t - p.inCueSec) / (p.beatSec * p.tempoRatio), tech.stems.in)
      }
      if (tech?.deckEdits?.out?.length) a = applyDeckEdits(a, R, tech.deckEdits.out)
      if (tech?.deckEdits?.in?.length) b = applyDeckEdits(b, R, tech.deckEdits.in)
      const barA = planned[i].summary.barSec
      const r = renderTransition({ rate: R, out: a, in: b, plan: p, preRollSec: 8 * barA, postRollSec: 8 * barA, outTrimDb: planned[i].trimDb, inTrimDb: planned[i + 1].trimDb, stems: true })
      if (tech?.reverb) applyReverbWash(r, p.beatSec, tech.reverb)
      const ts = r.transitionStartSample
      const te = ts + Math.round(p.durationSec * R)
      const mono = r.channels.length > 1 ? r.channels[0].map((x, k) => (x + r.channels[1][k]) / 2) : r.channels[0]
      const q = evaluateTransition({ mix: mono, stemA: r.stemA!, stemB: r.stemB!, rate: R, t0: ts, t1: te, clippedSamples: r.clippedSamples, peak: r.peak, limiterGainReductionDb: r.limiterGainReductionDb }, { plan: p, pa: profiles.get(ka), pb: profiles.get(kb), stems: { a: stems.get(ka), b: stems.get(kb) } })
      const m = transitionMetrics(r.stemA!, r.stemB!, r.channels, R, ts, Math.round(p.durationSec * R), p.beatSec)
      const tA = ts / R
      const tB = tA + Math.max(p.durationSec, 2)
      const beats = async (x: Float32Array) => (await runBeatNet(resample(x, R, BEATNET_SR), bn.bank, bn.run)).beats
      const [ba, bb] = [await beats(r.stemA!), await beats(r.stemB!)]
      const offs = ba.filter((t) => t >= tA && t <= tB).map((t) => Math.min(...bb.map((u) => Math.abs(u - t)))).filter((d) => d < p.beatSec / 2 + 0.01).sort((x, y) => x - y)
      const rmsDb = (s0: number, s1: number) => {
        let e = 0
        for (let k = Math.max(0, s0); k < Math.min(mono.length, s1); k++) e += mono[k] ** 2
        return 10 * Math.log10(e / Math.max(1, s1 - s0) + 1e-12)
      }
      const ctx8 = Math.round(8 * barA * R)
      const levelChange = Math.abs(rmsDb(ts - ctx8, ts) - rmsDb(te, te + ctx8))
      const crit = criticScore(referee, p, await audio16(ka), 0, await audio16(kb), 0, PREVIEW_RATE, { out: planned[i].trimDb, in: planned[i + 1].trimDb })
      const label = p.performance ? `staged-${p.performance.strategy}` : tech ? `${tech.technique}-${p.style}` : p.style
      const file = `${String(i + 1).padStart(2, '0')}_${p.overlapBars}bar_${label}.wav`
      writeFileSync(join(vdir, file), encodeWav(r.channels, R))
      wavs[v.name].push(join(v.name, file))
      rows.push({
        pair: i + 1,
        from: byKey.get(ka)!.title,
        to: byKey.get(kb)!.title,
        style: label,
        control: p.performance ? p.performance.source : (p as ScoredPlan).mlSource === 'transitionnet' ? 'transitionnet-v1' : 'template',
        overlapBars: p.overlapBars,
        overlapSec: Math.round(p.durationSec * 10) / 10,
        stages: p.performance?.stages.map((s) => `${s.kind}:${s.startBar}-${s.endBar}`).join(' '),
        quality: Math.round(q.score * 1000) / 1000,
        hardFail: q.hardFail,
        failures: q.failures.join('; '),
        components: q.components,
        vocalClash: Math.round(q.metrics.vocalClash * 1000) / 1000,
        harmonicCorr: Math.round(q.metrics.harmonicCorr * 1000) / 1000,
        nnBeatOffsetMs: offs.length >= 3 ? Math.round(offs[Math.floor(offs.length / 2)] * 1000) : -1,
        bassDoubling: m.bassDoubling,
        maxLevelStepDb: m.maxLevelStepDb,
        levelChange8barDb: Math.round(levelChange * 10) / 10,
        dipDb: Math.round(q.metrics.dipDb * 10) / 10,
        clipped: r.clippedSamples,
        criticQuality: Math.round(crit.quality * 10000) / 10000,
        criticArtifact: Math.round(crit.artifact * 1000) / 1000,
        file,
      })
    }
    // ── full continuous mix (listening) ──
    let fullMixFile: string | undefined
    if (fullMix.has(v.name)) {
      fullMixFile = join(vdir, `${tag}_${v.name}.mp3`)
      const enc = createEncoder(fullMixFile!, R, { mp3Kbps: 192, metadata: { title: `${tag} ${v.name}` } })
      await renderMix(plan, { load: async (k) => ({ channels: await load(k), rate: R }), release: () => {}, loadStems: async (k) => stemPcm.get(k) ?? null }, { write: (bufs) => enc.write(bufs) }, () => {})
      await enc.close()
    }
    const num = (k: string) => rows.map((r) => Number(r[k])).filter((x) => Number.isFinite(x) && x >= 0)
    const med = (k: string) => {
      const x = num(k).sort((p, q) => p - q)
      return x.length ? x[Math.floor(x.length / 2)] : null
    }
    const mean = (k: string) => Math.round((num(k).reduce((s, x) => s + x, 0) / Math.max(1, num(k).length)) * 1000) / 1000
    const summary = {
      variant: v.name,
      order: order.map((k) => byKey.get(k)!.title),
      durationMin: Math.round((plan.durationSec / 60) * 100) / 100,
      targetMin: Math.round((spec.targetDurationSec / 60) * 100) / 100,
      planSeconds: Math.round(planMs / 100) / 10,
      overlapBars: rows.map((r) => r.overlapBars).join(','),
      meanOverlapBars: mean('overlapBars'),
      styles: rows.map((r) => r.style).join(','),
      meanQuality: mean('quality'),
      medianQuality: med('quality'),
      hardFails: rows.filter((r) => r.hardFail).length,
      meanVocalClash: mean('vocalClash'),
      medianBeatOffsetMs: med('nnBeatOffsetMs'),
      pairsOver40ms: rows.filter((r) => Number(r.nnBeatOffsetMs) > 40).length,
      meanBassDoubling: mean('bassDoubling'),
      meanMaxLevelStepDb: mean('maxLevelStepDb'),
      meanLevelChange8barDb: mean('levelChange8barDb'),
      meanDipDb: mean('dipDb'),
      clippedSamples: rows.reduce((s, r) => s + Number(r.clipped), 0),
      meanCriticQuality: mean('criticQuality'),
      meanCriticArtifact: mean('criticArtifact'),
      fullMix: fullMixFile,
    }
    results.push({ ...summary, rows, prodjTrace: trace, mlTrace: { counts: ml.trace.counts, fallbacks: ml.trace.fallbacks, decisions: ml.trace.decisions.length } })
    process.stderr.write(`PRODJ ${v.name}: ${JSON.stringify({ ...summary, order: undefined })}\n`)
    writeFileSync(join(out, 'prodj.json'), JSON.stringify({ job: jobId, tag, spec: { genres: spec.genres, style: spec.transitionStyle, curve: spec.energyCurve, songCount, targetSec: spec.targetDurationSec }, note: 'quality/hardFail/vocalClash are the closed-loop metrics (optimised by variant full → circular for it); nnBeatOffsetMs, bassDoubling, maxLevelStepDb, levelChange8barDb, critic* are independent checks (critic partly circular for full). Listening is the real test.', results }, null, 1))
  }
  // blind A/B page: existing vs full, and global+longform vs full (same pair index = different transitions; compared as whole performances)
  const pairs: Array<{ pair: string; a: string; b: string; title: string }> = []
  const key: Record<string, { a: string; b: string }> = {}
  for (const [x, y] of [['existing', 'full'], ['global+longform', 'full']] as const) {
    if (!wavs[x] || !wavs[y]) continue
    const n = Math.min(wavs[x].length, wavs[y].length)
    for (let i = 0; i < n; i++) {
      const flip = Math.random() < 0.5
      const id = `${x}-vs-${y}-${i + 1}`
      pairs.push({ pair: id, a: flip ? wavs[y][i] : wavs[x][i], b: flip ? wavs[x][i] : wavs[y][i], title: `Transition ${i + 1}` })
      key[id] = { a: flip ? y : x, b: flip ? x : y }
    }
  }
  if (pairs.length) {
    writeFileSync(join(out, 'index.html'), page(pairs, `cp_ab_prodj_${tag}`))
    mkdirSync(join(out, '..', 'keys'), { recursive: true })
    writeFileSync(join(out, '..', 'keys', `${tag}.key.json`), JSON.stringify(key, null, 1))
  }
}, 7_200_000)
