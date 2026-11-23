/**
 * Sanity check of the closed-loop beat-alignment metric against Beat This! (independent network) on
 * synthetic-sweep windows: same window rendered with two strategies; compare the metric's offset with
 * Beat This! offsets on the two post-fader decks.
 *   npx vitest run -c vitest.eval.config.ts evaluation/ml/align_check.eval.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { summarize, type TrackAnalysis } from '../../src/dsp/analyze'
import { beatmatchable } from '../../src/dj/transitions'
import { buildProfile } from '../../src/mixgen/profile'
import { windowCandidates, type SetTrack } from '../../src/mixgen/setplan'
import { buildPerformance, NEUTRAL, type Strategy } from '../../src/mixgen/longform'
import { renderPreview } from '../../src/mixgen/closedloop'
import { evaluateTransition } from '../../src/mixgen/audio-quality'
import { trimFor } from '../../src/mixgen/pipeline'
import { resolveSpec, MixSpec } from '../../src/mixgen/spec'
import { resample, toMono } from '../../src/dsp/resample'
import { runBeatNet, BEATNET_SR } from '../../src/dsp/beatnet'
import { readWav } from '../wav'
import { nodeBeatNet } from '../beatnet-node'
import { ML } from './common'

it('alignment metric vs Beat This!', async () => {
  const tracks = JSON.parse(readFileSync(join(ML, 'cache', 'analysis_full_v2.json'), 'utf8'), (_k, v) => (v && typeof v === 'object' && '__f64' in v ? Float64Array.from(v.__f64) : v)) as Array<{ key: string; wav: string; analysis: TrackAnalysis }>
  const rows: Array<{ window: string; split: string; strategy: string; failures: string[] }> = []
  for (const f of readdirSync(join(ML, 'synth_v2')).filter((x) => x.endsWith('.jsonl'))) for (const l of readFileSync(join(ML, 'synth_v2', f), 'utf8').split('\n')) if (l) rows.push(JSON.parse(l))
  // windows where layered_blend failed on beat offset in the sweep
  const pick = [...new Set(rows.filter((r) => r.split === 'test' && r.strategy === 'layered_blend' && r.failures.some((x) => x.startsWith('beat offset'))).map((r) => r.window))].slice(0, Number(process.env.N ?? 12))
  const spec = resolveSpec(MixSpec.parse({ genres: ['house'], song_count: 8, target_duration_minutes: 30, transition_style: 'smooth' }))
  const bn = await nodeBeatNet()
  const mono = new Map<string, Float32Array>()
  const audio = async (k: string) => {
    if (!mono.has(k)) {
      const t = tracks.find((x) => x.key === k)!
      const w = readWav(t.wav)
      mono.set(k, resample(toMono(w.channels), w.rate, 16000))
    }
    return mono.get(k)!
  }
  const st = (k: string): SetTrack => {
    const t = tracks.find((x) => x.key === k)!
    const s = summarize(t.analysis)
    return { key: k, title: k, summary: s, trimDb: trimFor(s.lufs, s.truePeak), netBeats: t.analysis.netBeats, profile: buildProfile(t.analysis), energy: 0.5, dropStrength: 0, pref: 0, artist: k, genres: [], gridOk: beatmatchable(s) }
  }
  const out: Array<Record<string, unknown>> = []
  for (const w of pick) {
    const [ka, kb, o, i, bars] = w.split('|')
    const a = st(ka)
    const b = st(kb)
    const win = windowCandidates(a, b, spec, 5, 4).find((x) => x.plan.outCueSec.toFixed(1) === o && x.plan.inCueSec.toFixed(1) === i && String(x.plan.overlapBars) === bars)
    if (!win) continue
    for (const strategy of ['layered_blend', 'filter_ride'] as Strategy[]) {
      const plan = buildPerformance({ base: win.plan, pa: a.profile, pb: b.profile, strategy, params: NEUTRAL, compat: win.compat })
      const r = await renderPreview(plan, a, b, { audio })
      const q = evaluateTransition(r, { plan, pa: a.profile, pb: b.profile, beatsA: a.netBeats, beatsB: b.netBeats })
      const beats = async (x: Float32Array) => (await runBeatNet(resample(x, 16000, BEATNET_SR), bn.bank, bn.run)).beats
      const [ba, bb] = [await beats(r.stemA), await beats(r.stemB)]
      const t0 = r.t0 / 16000
      const t1 = r.t1 / 16000
      const offs = ba.filter((t) => t >= t0 && t <= t1).map((t) => Math.min(...bb.map((u) => Math.abs(u - t)))).filter((d) => d < plan.beatSec / 2 + 0.01).sort((x, y) => x - y)
      out.push({ window: w, strategy, gridMs: Math.round(q.metrics.beatOffsetMs), gridP90: Math.round(q.metrics.beatOffsetP90Ms), xcorrMs: Math.round(q.metrics.xcorrOffsetMs), beatThisMs: offs.length >= 3 ? Math.round(offs[Math.floor(offs.length / 2)] * 1000) : null, nBeats: offs.length })
      process.stderr.write(`${JSON.stringify(out[out.length - 1])}\n`)
    }
  }
  writeFileSync(join(ML, 'models', 'transitionnet_v2', 'align_check.json'), JSON.stringify(out, null, 1))
}, 3_600_000)
