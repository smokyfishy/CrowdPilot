/**
 * TransitionNet v2 training data: synthetic KNOWN-CONTROL long-form performances.
 *
 * For beat-matchable pairs of the private evaluation corpora (track-level splits from common.ts —
 * train/val/test never share a track), long-form windows (16–64 bars) are taken from the global
 * planner's window generator. Each window is performed with several strategies × shape-parameter
 * vectors (neutral + random) and incoming cue shifts, rendered at 16 kHz with the production
 * renderer, and measured with the closed-loop audio metrics (src/mixgen/audio-quality.ts). Because
 * every control value is known, the rows supervise the controller directly.
 *
 *   SHARD=0 NSHARDS=4 [V2_PAIRS=110] npx vitest run -c vitest.eval.config.ts evaluation/ml/synth_v2.eval.ts
 *   → C:/crowdpilot-data/ml/synth_v2/shard<k>.jsonl
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyzeTrack, summarize, type TrackAnalysis } from '../../src/dsp/analyze'
import { beatmatchable, tempoMatch } from '../../src/dj/transitions'
import { buildProfile, overlapCompat, type TrackProfile } from '../../src/mixgen/profile'
import { windowCandidates, type SetTrack } from '../../src/mixgen/setplan'
import { buildPerformance, feasibleStrategies, NEUTRAL, PARAM_KEYS, type LongformParams } from '../../src/mixgen/longform'
import { renderPreview } from '../../src/mixgen/closedloop'
import { evaluateTransition } from '../../src/mixgen/audio-quality'
import { trimFor } from '../../src/mixgen/pipeline'
import { validPlan } from '../../src/mixgen/ml'
import { longformFeatures } from '../../src/ml/transitionnet-v2'
import { resolveSpec, MixSpec } from '../../src/mixgen/spec'
import { resample, toMono } from '../../src/dsp/resample'
import { readWav } from '../wav'
import { ML, ROOT, CORPORA, splitOf } from './common'

const RATE = 16000

interface Track {
  key: string
  split: 'train' | 'val' | 'test'
  wav: string
  analysis: TrackAnalysis
}

function loadTracks(): Track[] {
  const cache = join(ML, 'cache', 'analysis_full_v2.json')
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'), (_k, v) => (v && typeof v === 'object' && '__f64' in v ? Float64Array.from(v.__f64) : v))
  const out: Track[] = []
  const seen = new Set<string>()
  for (const corpus of CORPORA) {
    const dir = join(ROOT, 'raw', corpus)
    const list = JSON.parse(readFileSync(join(dir, 'corpus.json'), 'utf8')) as Array<{ id: number; wav: string }>
    const net = JSON.parse(readFileSync(join(dir, 'beatnet_ts.json'), 'utf8')) as Record<string, { beats: number[]; downbeats: number[] }>
    for (const c of list) {
      const key = `jamendo:${c.id}`
      if (seen.has(key) || !net[String(c.id)]) continue
      seen.add(key)
      const w = readWav(c.wav)
      out.push({ key, split: splitOf(key), wav: c.wav, analysis: analyzeTrack({ channels: w.channels, sampleRate: w.rate, net: net[String(c.id)] }) })
      process.stderr.write(`analysed ${out.length}\n`)
    }
  }
  writeFileSync(cache, JSON.stringify(out, (_k, v) => (v instanceof Float64Array || v instanceof Float32Array ? { __f64: Array.from(v) } : v)))
  return out
}

/** Deterministic PRNG. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

it('TransitionNet v2 synthetic known-control data', async () => {
  const shard = Number(process.env.SHARD ?? 0)
  const nShards = Number(process.env.NSHARDS ?? 1)
  const pairsPerSplit: Record<string, number> = { train: Number(process.env.V2_PAIRS ?? 110), val: 18, test: 30 }
  const tracks = loadTracks()
  const spec = resolveSpec(MixSpec.parse({ genres: ['house'], song_count: 8, target_duration_minutes: 30, transition_style: 'smooth' }))
  const outDir = join(ML, 'synth_v2')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `shard${shard}.jsonl`)
  const done = new Set<string>()
  if (existsSync(outFile)) for (const l of readFileSync(outFile, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).window)
  const mono = new Map<string, Float32Array>()
  const audio = async (k: string) => {
    if (!mono.has(k)) {
      const t = tracks.find((x) => x.key === k)!
      const w = readWav(t.wav)
      mono.set(k, resample(toMono(w.channels), w.rate, RATE))
      if (mono.size > 8) mono.delete(mono.keys().next().value!)
    }
    return mono.get(k)!
  }
  const set = new Map<string, SetTrack>()
  const profiles = new Map<string, TrackProfile>()
  const st = (t: Track): SetTrack => {
    const hit = set.get(t.key)
    if (hit) return hit
    const s = summarize(t.analysis)
    const p = buildProfile(t.analysis)
    profiles.set(t.key, p)
    const v: SetTrack = { key: t.key, title: t.key, summary: s, trimDb: trimFor(s.lufs, s.truePeak), netBeats: t.analysis.netBeats, profile: p, energy: 0.5, dropStrength: 0, pref: 0, artist: t.key, genres: ['house'], gridOk: beatmatchable(s) }
    set.set(t.key, v)
    return v
  }
  let rows = 0
  for (const split of ['train', 'val', 'test'] as const) {
    const pool = tracks.filter((t) => t.split === split && beatmatchable(summarize(t.analysis)))
    const r = rng(split === 'train' ? 11 : split === 'val' ? 23 : 37)
    const pairs: Array<[Track, Track]> = []
    for (let tries = 0; pairs.length < pairsPerSplit[split] && tries < 20000; tries++) {
      const a = pool[Math.floor(r() * pool.length)]
      const b = pool[Math.floor(r() * pool.length)]
      if (!a || !b || a === b) continue
      const { ratio } = tempoMatch(summarize(a.analysis).bpm, summarize(b.analysis).bpm)
      if (Math.abs(ratio - 1) > 0.06) continue
      if (pairs.some(([x, y]) => x === a && y === b)) continue
      pairs.push([a, b])
    }
    for (const [pi, [ta, tb]] of pairs.entries()) {
      if (pi % nShards !== shard) continue
      const a = st(ta)
      const b = st(tb)
      const wins = windowCandidates(a, b, spec, 5, 4)
      if (!wins.length) continue
      // up to 2 windows per pair, preferring different lengths
      wins.sort((x, y) => x.compat.cost - y.compat.cost)
      const picked = [wins[0], wins.find((w) => w.plan.overlapBars !== wins[0].plan.overlapBars) ?? wins[1]].filter(Boolean)
      for (const w of picked) {
        const wkey = `${a.key}|${b.key}|${w.plan.outCueSec.toFixed(1)}|${w.plan.inCueSec.toFixed(1)}|${w.plan.overlapBars}`
        if (done.has(wkey)) continue
        const variants: Array<{ strategy: string; params: LongformParams; cueShift: number }> = []
        const feas = feasibleStrategies(w.compat, { dropAtEnd: w.plan.incomingDropSec !== undefined })
        const strategies = [...new Set([...feas.slice(0, 4), 'layered_blend', 'percussion_build'])] as typeof feas
        for (const s of strategies) {
          variants.push({ strategy: s, params: NEUTRAL, cueShift: 0 })
          for (let k = 0; k < 2; k++) variants.push({ strategy: s, params: Object.fromEntries(PARAM_KEYS.map((p) => [p, Math.round(r() * 100) / 100])) as unknown as LongformParams, cueShift: 0 })
        }
        for (const shift of [-8, 8]) variants.push({ strategy: feas[0], params: NEUTRAL, cueShift: shift })
        const out: string[] = []
        for (const v of variants) {
          let base = w.plan
          if (v.cueShift) {
            const inCueSec = base.inCueSec + v.cueShift * b.summary.barSec
            if (inCueSec < 0 || inCueSec + base.durationSec * base.tempoRatio > b.summary.durationSec * 0.8) continue
            base = { ...base, inCueSec }
            delete base.incomingDropSec
          }
          const compat = v.cueShift ? overlapCompat(a.profile, b.profile, base.outCueSec, base.inCueSec, base.overlapBars) : w.compat
          const plan = buildPerformance({ base, pa: a.profile, pb: b.profile, strategy: v.strategy as never, params: v.params, compat })
          if (!validPlan(plan)) continue
          const prev = await renderPreview(plan, a, b, { audio })
          const q = evaluateTransition(prev, { plan, pa: a.profile, pb: b.profile })
          out.push(JSON.stringify({
            split, window: wkey, pair: `${a.key}|${b.key}`, bars: plan.overlapBars,
            x: longformFeatures(a.summary, b.summary, w.plan, w.compat),
            feasible: feas, strategy: v.strategy, params: PARAM_KEYS.map((k) => v.params[k]), cueShift: v.cueShift,
            score: Math.round(q.score * 10000) / 10000, hardFail: q.hardFail, failures: q.failures, components: q.components,
          }))
          rows++
        }
        appendFileSync(outFile, out.join('\n') + '\n')
        process.stderr.write(`[shard ${shard}] ${split} pair ${pi} window ${w.plan.overlapBars} bars: ${out.length} variants (rows ${rows})\n`)
      }
    }
  }
}, 14_400_000)
