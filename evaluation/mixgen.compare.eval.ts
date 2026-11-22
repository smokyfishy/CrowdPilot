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
import { ANALYZER_VERSION } from '../src/dsp/analyze'
import { runBeatNet, BEATNET_SR } from '../src/dsp/beatnet'
import { resample } from '../src/dsp/resample'
import { nodeBeatNet } from './beatnet-node'

const JOB = process.env.MIXGEN_JOB ?? 'e2e-3'

/** Objective transition metrics from post-fader deck stems. */
export function transitionMetrics(stemA: Float32Array, stemB: Float32Array, mix: Float32Array[], rate: number, startSample: number, overlap: number, beatSec: number) {
  const hop = Math.round(rate * 0.01)
  const lpA = Math.exp((-2 * Math.PI * 150) / rate)
  const env = (x: Float32Array, a: number, b: number) => {
    const bass: number[] = []
    const full: number[] = []
    let l1 = 0
    let l2 = 0
    let sb = 0
    let sf = 0
    let n = 0
    for (let i = a; i < b; i++) {
      const v = x[i] ?? 0
      l1 = l1 * lpA + v * (1 - lpA)
      l2 = l2 * lpA + l1 * (1 - lpA)
      sb += l2 * l2
      sf += v * v
      if (++n === hop) {
        bass.push(sb / hop)
        full.push(sf / hop)
        sb = sf = n = 0
      }
    }
    return { bass, full }
  }
  const a0 = startSample
  const a1 = startSample + Math.max(overlap, Math.round(rate * 0.5))
  const A = env(stemA, a0, a1)
  const B = env(stemB, a0, a1)
  // (1) bass doubling: share of overlap energy where BOTH decks carry bass (0 = clean handoff, 0.5 = full doubling)
  let both = 0
  let tot = 0
  for (let i = 0; i < A.bass.length; i++) {
    both += Math.min(A.bass[i], B.bass[i])
    tot += A.bass[i] + B.bass[i]
  }
  const bassDoubling = tot > 0 ? both / tot : 0
  // (2) beat alignment: onset-envelope cross-correlation lag (ms, folded to ±half beat) where both are audible
  const flux = (e: number[]) => e.map((v, i) => Math.max(0, Math.sqrt(v) - Math.sqrt(e[i - 1] ?? v)))
  // kick-band onsets: four-on-the-floor kicks coincide when two tracks are beat-matched
  const fa = flux(A.bass)
  const fb = flux(B.bass)
  const audible = A.full.map((v, i) => v > 1e-5 && B.full[i] > 1e-5 && A.bass[i] > 1e-7 && B.bass[i] > 1e-7)
  let best = { lag: 0, c: -1 }
  const maxLag = Math.round((beatSec / 2) * 100)
  if (audible.filter(Boolean).length > 100) {
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let c = 0
      for (let i = 0; i < fa.length; i++) if (audible[i] && audible[i + lag]) c += fa[i] * (fb[i + lag] ?? 0)
      if (c > best.c) best = { lag, c }
    }
  }
  const beatOffsetMs = audible.filter(Boolean).length > 100 ? Math.abs(best.lag * 10) : NaN
  // (3) level continuity: largest 400 ms RMS step of the mix inside the window (dB)
  const M = mix[0]
  const w = Math.round(rate * 0.4)
  let prev = NaN
  let maxStep = 0
  for (let i = Math.max(0, a0 - w * 5); i + w < Math.min(M.length, a1 + w * 5); i += w) {
    let s = 0
    for (let k = i; k < i + w; k++) s += M[k] * M[k]
    const db = 10 * Math.log10(s / w + 1e-12)
    if (Number.isFinite(prev) && db > -45 && prev > -45) maxStep = Math.max(maxStep, Math.abs(db - prev))
    prev = db
  }
  return { bassDoubling: Math.round(bassDoubling * 1000) / 1000, beatOffsetMs, maxLevelStepDb: Math.round(maxStep * 10) / 10, overlapSec: Math.round((overlap / rate) * 10) / 10 }
}

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
