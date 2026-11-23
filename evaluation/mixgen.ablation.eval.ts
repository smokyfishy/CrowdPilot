/**
 * ML-enabled vs ML-disabled ablation on the SAME real recordings (cached audio + analyses of a
 * finished job). For each variant: order (beam search) → plan (duration DP) → DJCritic → render every
 * transition with deck stems → objective measurements. WAVs per transition for listening.
 *   MIXGEN_REPORT=C:/crowdpilot-data/mixgen/renders/research/research-techhouse-4.report.json \
 *   npx vitest run -c vitest.eval.config.ts evaluation/mixgen.ablation.eval.ts
 * Metrics are objective proxies; the critic score is reported but is partly circular for variants
 * that use the critic. Listening (the WAVs) is the real test.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { ANALYZER_VERSION, summarize, type TrackAnalysis } from '../src/dsp/analyze'
import { runBeatNet, BEATNET_SR } from '../src/dsp/beatnet'
import { resample } from '../src/dsp/resample'
import { encodeWav, renderTransition } from '../src/dj/render'
import { automationFor, candidateTransitions, DEFAULT_OPTIONS, beatmatchable, type PlanTrack, type TransitionPlan } from '../src/dj/transitions'
import { describeEnergy, energyScores } from '../src/mixgen/energy'
import { buildAlternatives, criticSelect, monoAt, pairSeverity, rankCandidatesWith, type MlOptions, type ScoredPlan } from '../src/mixgen/ml'
import { planMix, type PlannedTrack } from '../src/mixgen/mixplan'
import { applyDeckEdits, type TechniquePlan } from '../src/mixgen/techniques'
import { trimFor } from '../src/mixgen/pipeline'
import { orderSet, type OrderTrack } from '../src/mixgen/select'
import type { ResolvedSpec } from '../src/mixgen/spec'
import { criticScore } from '../src/ml/dj-brain'
import { decodePcm } from '../worker-node/mixgen/ffmpeg'
import { nodeMlRuntime } from '../worker-node/mixgen/ml-runtime'
import { fromJson, MIXGEN_ROOT, readIndex } from '../worker-node/mixgen/storage'
import { nodeBeatNet } from './beatnet-node'
import { transitionMetrics } from './mixgen-metrics'

const VARIANTS: Array<{ name: string; ml: Partial<MlOptions>; crossfade?: boolean; techniques?: boolean }> = [
  // baseline: same order and cue points as 'rules', every transition replaced by a plain 8-bar equal-power crossfade (no beatmatch)
  { name: 'crossfade', ml: { mode: 'off' }, crossfade: true },
  { name: 'rules', ml: { mode: 'off' } },
  { name: 'rules+techniques', ml: { mode: 'off' }, techniques: true },
  { name: 'mixgraph', ml: { transitionNet: false, critic: false } },
  { name: 'mixgraph+critic', ml: { transitionNet: false } },
  { name: 'all', ml: {} },
  { name: 'all+techniques', ml: {}, techniques: true },
  { name: 'transitionnet-only', ml: { mixgraph: false, ordering: false, critic: false } },
]

it('ML ablation on real recordings', async () => {
  const reportPath = process.env.MIXGEN_REPORT ?? join(MIXGEN_ROOT, 'renders', 'research', 'research-techhouse-4.report.json')
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { jobId: string; spec: ResolvedSpec; songs: Array<{ trackKey: string; usedSource?: string; status: string; title: string }> }
  const idx = readIndex()
  const out = join(MIXGEN_ROOT, 'ablation', report.jobId)
  mkdirSync(out, { recursive: true })
  const pool = report.songs.filter((s) => (s.status === 'downloaded' || s.status === 'cached') && idx[s.usedSource ?? s.trackKey])
  const entries = pool.map((s) => {
    const e = idx[s.usedSource ?? s.trackKey]
    const a = fromJson<TrackAnalysis>(readFileSync(join(MIXGEN_ROOT, 'analysis', `${e.sha256}-${ANALYZER_VERSION}-bt.json`), 'utf8'))
    return { key: s.trackKey, title: s.title, path: e.path, analysis: a, summary: summarize(a) }
  })
  const scores = energyScores(entries.map((e) => describeEnergy(e.analysis)))
  const orderTracks: OrderTrack[] = entries.map((e, i) => ({ key: e.key, pref: 1, bpm: e.summary.bpm, bpmConf: e.summary.bpmConf, camelot: e.summary.camelot, keyConf: e.summary.keyConf, energy: scores[i], dropStrength: describeEnergy(e.analysis).dropStrength, vocal: (e.summary.vocalIn + e.summary.vocalOut) / 2, artist: e.title, durationSec: e.summary.durationSec, gridOk: beatmatchable(e.summary) }))
  const byKey = new Map(entries.map((e) => [e.key, e]))
  const pt = (s: ReturnType<typeof summarize>, k: string): PlanTrack => ({ itemId: k, trackKey: k, title: k, mixable: true, summary: s, durationSec: s.durationSec })
  const pcm = new Map<string, Float32Array[]>()
  const load = async (k: string) => {
    if (!pcm.has(k)) {
      if (pcm.size > 4) pcm.delete(pcm.keys().next().value!)
      pcm.set(k, (await decodePcm(byKey.get(k)!.path, 44100)).channels)
    }
    return pcm.get(k)!
  }
  const bn = await nodeBeatNet()
  const referee = (await nodeMlRuntime(process.cwd())).models.critic! // scores every variant identically (circular for critic variants)
  const results: Array<Record<string, unknown>> = []
  for (const v of VARIANTS) {
    const ml = await nodeMlRuntime(process.cwd(), v.ml)
    const summaries = new Map(entries.map((e) => [e.key, e.summary]))
    const sev = ml.on.ordering ? pairSeverity(ml, [...summaries.keys()], summaries, (sa, sb) => candidateTransitions(pt(sa, 'a'), pt(sb, 'b'), DEFAULT_OPTIONS)) : new Map<string, number>()
    const ord = orderSet(orderTracks, report.spec, { count: report.spec.songCount, pairExtra: sev.size ? (a, b) => ml.options.orderWeight * (sev.get(`${a.key}|${b.key}`) ?? 0.05) : undefined })
    const planned: PlannedTrack[] = ord.order.map((k) => {
      const e = byKey.get(k)!
      return { key: k, title: e.title, summary: e.summary, trimDb: trimFor(e.analysis.loudness.integratedLufs, e.analysis.loudness.truePeakDbtp), netBeats: e.analysis.netBeats }
    })
    const plan = planMix(planned, report.spec, { ...(ml.on.mixgraph || ml.on.transitionNet ? { rankCandidates: rankCandidatesWith(ml) } : {}), techniques: { enabled: !!v.techniques } })
    const rows: Array<Record<string, number | string>> = []
    for (const [i, tr] of plan.transitions.entries()) {
      const a = await load(planned[i].key)
      const b = await load(planned[i + 1].key)
      let p: TransitionPlan = tr.plan
      if (v.crossfade) {
        const B = 32
        const auto = automationFor('unmatched_fade', B)
        p = { ...p, style: 'unmatched_fade', overlapBars: 8, durationSec: B * p.beatSec, tempoRatio: 1, tempoRecoveryBars: 0, out: auto.out, in: auto.in, handoffBeat: auto.handoffBeat, filter: undefined, echo: undefined, outPerf: undefined }
        delete (p as TechniquePlan).tech
      }
      if (ml.on.critic && !v.crossfade) {
        const alts = buildAlternatives(ml, p as ScoredPlan, planned[i].summary, planned[i + 1].summary, (s) => !(s === 'filter_sweep' && report.spec.transitionStyle === 'smooth'))
        if (alts.length) p = criticSelect(ml, p as ScoredPlan, alts, { out: monoAt(a, 44100), in: monoAt(b, 44100) }, { out: planned[i].trimDb, in: planned[i + 1].trimDb }, `${i + 1}→${i + 2}`)
      }
      // technique deck edits are executed as in renderMix (stems/reverb need the full worker; not in this offline ablation)
      const tech = (p as TechniquePlan).tech
      const ea = tech?.deckEdits?.out?.length ? applyDeckEdits(a, 44100, tech.deckEdits.out) : a
      const eb = tech?.deckEdits?.in?.length ? applyDeckEdits(b, 44100, tech.deckEdits.in) : b
      const r = renderTransition({ rate: 44100, out: ea, in: eb, plan: p, preRollSec: 8, postRollSec: 8, outTrimDb: planned[i].trimDb, inTrimDb: planned[i + 1].trimDb, stems: true })
      const m = transitionMetrics(r.stemA!, r.stemB!, r.channels, 44100, r.transitionStartSample, Math.round(p.durationSec * 44100), p.beatSec)
      // Beat This! on each deck's post-fader stem: median |offset| of beats inside the overlap
      const t0 = r.transitionStartSample / 44100
      const t1 = t0 + Math.max(p.durationSec, 2)
      const beats = async (x: Float32Array) => (await runBeatNet(resample(x, 44100, BEATNET_SR), bn.bank, bn.run)).beats
      const [ba, bb] = [await beats(r.stemA!), await beats(r.stemB!)]
      const offs = ba.filter((t) => t >= t0 && t <= t1).map((t) => Math.min(...bb.map((u) => Math.abs(u - t)))).filter((d) => d < p.beatSec / 2 + 0.01).sort((x, y) => x - y)
      // loudness consistency: |RMS dB| 4 s before vs 4 s after the transition window
      const rmsDb = (s0: number, s1: number) => {
        let e = 0
        for (let k = Math.max(0, s0); k < Math.min(r.channels[0].length, s1); k++) e += r.channels[0][k] ** 2
        return 10 * Math.log10(e / Math.max(1, s1 - s0) + 1e-12)
      }
      const ts = r.transitionStartSample
      const te = ts + Math.round(p.durationSec * 44100)
      const levelChange = Math.abs(rmsDb(ts - 4 * 44100, ts) - rmsDb(te, te + 4 * 44100))
      const mono16 = { out: monoAt(a, 44100), in: monoAt(b, 44100) }
      const crit = criticScore(referee, p, mono16.out, 0, mono16.in, 0, 16000, { out: planned[i].trimDb, in: planned[i + 1].trimDb })
      const file = `${v.name}_${String(i + 1).padStart(2, '0')}_${p.style}.wav`
      writeFileSync(join(out, file), encodeWav(r.channels, 44100))
      rows.push({
        pair: i + 1,
        style: tech ? `${tech.technique}/${p.style}` : p.style,
        control: (p as ScoredPlan).mlSource === 'transitionnet' ? 'TN' : 'template',
        overlapSec: m.overlapSec,
        nnBeatOffsetMs: offs.length >= 3 ? Math.round(offs[Math.floor(offs.length / 2)] * 1000) : -1,
        bassDoubling: m.bassDoubling,
        maxLevelStepDb: m.maxLevelStepDb,
        levelChangeDb: Math.round(levelChange * 10) / 10,
        clipped: r.clippedSamples,
        criticQuality: Math.round(crit.quality * 10000) / 10000,
        criticArtifact: Math.round(crit.artifact * 1000) / 1000,
        file,
      })
    }
    const med = (k: string) => {
      const x = rows.map((r) => Number(r[k])).filter((n) => n >= 0).sort((p, q) => p - q)
      return x.length ? x[Math.floor(x.length / 2)] : null
    }
    const mean = (k: string) => Math.round((rows.reduce((s, r) => s + Number(r[k]), 0) / Math.max(1, rows.length)) * 1000) / 1000
    results.push({
      variant: v.name,
      order: ord.order.map((k) => byKey.get(k)!.title),
      durationMin: Math.round((plan.durationSec / 60) * 100) / 100,
      styles: rows.map((r) => r.style).join(','),
      tnTransitions: rows.filter((r) => r.control === 'TN').length,
      medianBeatOffsetMs: med('nnBeatOffsetMs'),
      pairsOver40ms: rows.filter((r) => Number(r.nnBeatOffsetMs) > 40).length,
      meanBassDoubling: mean('bassDoubling'),
      meanMaxLevelStepDb: mean('maxLevelStepDb'),
      meanLevelChangeDb: mean('levelChangeDb'),
      clippedSamples: rows.reduce((s, r) => s + Number(r.clipped), 0),
      meanCriticQuality: mean('criticQuality'),
      meanCriticArtifact: mean('criticArtifact'),
      mlCounts: ml.trace.counts,
      rows,
    })
    process.stderr.write(`ABLATION ${v.name}: ${JSON.stringify({ ...results[results.length - 1], rows: undefined, order: undefined })}\n`)
  }
  writeFileSync(join(out, 'ablation.json'), JSON.stringify({ job: report.jobId, note: 'Objective proxies on identical recordings; critic score is circular for critic variants; listening is the real test.', results }, null, 1))
}, 3_600_000)
