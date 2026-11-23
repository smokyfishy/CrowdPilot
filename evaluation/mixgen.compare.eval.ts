/**
 * Before/after comparison on REAL audio from a finished E2E job.
 *  BEFORE = the current CrowdPilot live engine as a room would use it: tracks in queue order
 *           (discovery ranking, no AI reordering) and the live planner's default best
 *           transition per pair (bestTransition with DEFAULT_OPTIONS), no set-level loudness plan.
 *  AFTER  = the AI mix generator: beam-searched order, style-aware + duration-fitted plans,
 *           loudness-matched trims (exactly what the job rendered).
 * Both are rendered by the same renderTransition and scored with the same objective metrics.
 * Writes WAV pairs + report.json to C:\crowdpilot-data\mixgen\compare\<job>.
 *   MIXGEN_JOB=e2e-3 npx vitest run -c vitest.eval.config.ts evaluation/mixgen.compare.eval.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { summarize, type TrackAnalysis } from '../src/dsp/analyze'
import { bestTransition, DEFAULT_OPTIONS, type PlanTrack, type TransitionPlan } from '../src/dj/transitions'
import { encodeWav, renderTransition } from '../src/dj/render'
import { trimFor } from '../src/mixgen/pipeline'
import type { MixManifest } from '../src/mixgen/manifest'
import { decodePcm } from '../worker-node/mixgen/ffmpeg'
import { fromJson, MIXGEN_ROOT, readIndex } from '../worker-node/mixgen/storage'
import { transitionMetrics } from './mixgen-metrics'
import { ANALYZER_VERSION } from '../src/dsp/analyze'
import { runBeatNet, BEATNET_SR } from '../src/dsp/beatnet'
import { resample } from '../src/dsp/resample'
import { nodeBeatNet } from './beatnet-node'

const JOB = process.env.MIXGEN_JOB ?? 'e2e-3'

it('before/after: live engine defaults vs AI mix generator', async () => {
  const manifest = JSON.parse(readFileSync(join(MIXGEN_ROOT, 'renders', `${JOB}.manifest.json`), 'utf8')) as MixManifest
  const idx = readIndex()
  const out = join(MIXGEN_ROOT, 'compare', JOB)
  mkdirSync(out, { recursive: true })
  const analysisOf = (key: string): TrackAnalysis => {
    const e = idx[key]
    return fromJson<TrackAnalysis>(readFileSync(join(MIXGEN_ROOT, 'analysis', `${e.sha256}-${ANALYZER_VERSION}-bt.json`), 'utf8'))
  }
  const after = manifest.tracks.map((t) => t.key)
  // BEFORE order: the generator's acquisition order = discovery ranking (what a queue would hold), same tracks.
  const ranking = manifest.acquisition.map((a) => a.trackKey).filter((k) => after.includes(k))
  const before = ranking.length === after.length ? ranking : after
  const pcmCache = new Map<string, Float32Array[]>()
  const pcm = async (k: string) => {
    if (!pcmCache.has(k)) {
      if (pcmCache.size > 3) pcmCache.delete(pcmCache.keys().next().value!)
      pcmCache.set(k, (await decodePcm(idx[k].path, 44100)).channels)
    }
    return pcmCache.get(k)!
  }
  const pt = (k: string): PlanTrack => {
    const s = summarize(analysisOf(k))
    return { itemId: k, trackKey: k, title: k, mixable: true, summary: s, durationSec: s.durationSec }
  }
  const rows: Array<Record<string, unknown>> = []
  const beatNetP = nodeBeatNet()
  const runSet = async (label: 'before' | 'after', order: string[], planFor: (i: number) => TransitionPlan, trims: (k: string) => number) => {
    for (let i = 0; i < order.length - 1; i++) {
      const plan = planFor(i)
      const a = await pcm(order[i])
      const b = await pcm(order[i + 1])
      const r = renderTransition({ rate: 44100, out: a, in: b, plan, preRollSec: 8, postRollSec: 8, outTrimDb: trims(order[i]), inTrimDb: trims(order[i + 1]), stems: true })
      const m = transitionMetrics(r.stemA!, r.stemB!, r.channels, 44100, r.transitionStartSample, Math.round(plan.durationSec * 44100), plan.beatSec)
      // Neural verification: Beat This! on each deck's post-fader stem; median |offset| of beats in the overlap.
      const bn = await beatNetP
      const beatsOf = async (x: Float32Array) => (await runBeatNet(resample(x, 44100, BEATNET_SR), bn.bank, bn.run)).beats
      const t0 = r.transitionStartSample / 44100
      const t1 = t0 + Math.max(plan.durationSec, 2)
      const [ba, bb] = [await beatsOf(r.stemA!), await beatsOf(r.stemB!)]
      const inWin = ba.filter((t) => t >= t0 && t <= t1)
      const offs = inWin.map((t) => Math.min(...bb.map((u) => Math.abs(u - t)))).filter((d) => d < plan.beatSec / 2 + 0.01).sort((p, q) => p - q)
      const nnBeatOffsetMs = offs.length >= 3 ? Math.round(offs[Math.floor(offs.length / 2)] * 1000) : NaN
      const file = `${label}_${String(i + 1).padStart(2, '0')}_${plan.style}.wav`
      writeFileSync(join(out, file), encodeWav(r.channels, 44100))
      rows.push({ set: label, pair: i + 1, style: plan.style, tempoPct: Math.round((plan.tempoRatio - 1) * 1000) / 10, clipped: r.clippedSamples, ...m, nnBeatOffsetMs, file })
    }
  }
  await runSet('before', before, (i) => bestTransition(pt(before[i]), pt(before[i + 1]), DEFAULT_OPTIONS).best, () => 0)
  const trimByKey = new Map(manifest.tracks.map((t) => [t.key, t.trimDb]))
  // AFTER uses the exact executed plans (rebuilt from the job's plan via the manifest order + cached analyses)
  const { planMix } = await import('../src/mixgen/mixplan')
  const plan = planMix(
    after.map((k) => {
      const a = analysisOf(k)
      return { key: k, title: k, summary: summarize(a), trimDb: trimFor(a.loudness.integratedLufs, a.loudness.truePeakDbtp) }
    }),
    manifest.spec,
  )
  await runSet('after', after, (i) => plan.transitions[i].plan, (k) => trimByKey.get(k) ?? 0)
  const agg = (set: string) => {
    const r = rows.filter((x) => x.set === set)
    const mean = (k: string) => {
      const v = r.map((x) => Number(x[k])).filter(Number.isFinite)
      return v.length ? Math.round((v.reduce((p, q) => p + q, 0) / v.length) * 1000) / 1000 : null
    }
    return {
      transitions: r.length,
      beatMatched: r.filter((x) => ['short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'drop_swap', 'filter_sweep'].includes(String(x.style))).length,
      cutsOrFx: r.filter((x) => ['cut', 'brake', 'loop_roll', 'scratch_cut', 'unmatched_fade'].includes(String(x.style))).length,
      meanOverlapSec: mean('overlapSec'),
      meanBassDoubling: mean('bassDoubling'),
      meanBeatOffsetMs: mean('beatOffsetMs'),
      medianNnBeatOffsetMs: (() => { const v = r.map((x) => Number(x.nnBeatOffsetMs)).filter(Number.isFinite).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null })(),
      pairsOver40ms: r.filter((x) => Number(x.nnBeatOffsetMs) > 40).length,
      meanMaxLevelStepDb: mean('maxLevelStepDb'),
      clippedSamples: r.reduce((p, x) => p + Number(x.clipped), 0),
    }
  }
  const report = { job: JOB, note: 'Objective proxies only; listening (the A/B WAVs in this folder) is the real test.', before: agg('before'), after: agg('after'), rows }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1))
  process.stderr.write('COMPARE ' + JSON.stringify({ before: report.before, after: report.after }) + String.fromCharCode(10))
}, 3_600_000)
