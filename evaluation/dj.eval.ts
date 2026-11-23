/**
 * Real-audio DJ evaluation harness (runs the SAME TypeScript the browser uses).
 *
 *   EVAL_TAG=A npx vitest run -c vitest.eval.config.ts
 *
 * Inputs : C:\crowdpilot-data\raw\jamendo_eval\corpus.json (+ .wav) and beatthis_ref.json
 * Outputs: C:\crowdpilot-data\eval\<TAG>\results.json and <pair>.wav (private; never committed)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyzeTrack, summarize, type TrackAnalysis } from '../src/dsp/analyze'
import { measureLoudness } from '../src/dsp/loudness'
import { encodeWav, renderTransition } from '../src/dj/render'
import { bestTransition, DEFAULT_OPTIONS, type PlanTrack, type TransitionPlan, type TransitionStyle } from '../src/dj/transitions'
import { trimDbFor } from '../src/dj/engine/deck-engine'
import { f1, readWav } from './wav'
import { phaseNudge, refineWithLocalBeats } from '../src/dj/phase'
import { robustKickLagMs } from './metrics'

const ROOT = process.env.CP_DATA_ROOT ?? 'C:/crowdpilot-data'
const CORPUS = join(ROOT, 'raw', process.env.EVAL_CORPUS ?? 'jamendo_eval')
const TAG = process.env.EVAL_TAG ?? 'A'
const OUT = join(ROOT, 'eval', TAG)

function gridBeats(a: TrackAnalysis): { beats: number[]; downbeats: number[] } {
  const g = a.grid
  const beats: number[] = []
  const downbeats: number[] = []
  for (let i = 0; i < g.beatCount; i++) {
    const t = g.firstBeatSec + i * g.periodSec
    beats.push(t)
    if ((((i - g.downbeatPhase) % 4) + 4) % 4 === 0) downbeats.push(t)
  }
  return { beats, downbeats }
}

/** Band RMS (dB) of a mono signal over [a, b) seconds with a simple 2nd-order low-pass (bass). */
function bassDb(x: Float32Array, rate: number, a: number, b: number): number {
  const w = (2 * Math.PI * 150) / rate
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const c = Math.cos(w)
  const a0 = 1 + alpha
  const b0 = (1 - c) / 2 / a0
  const b1 = (1 - c) / a0
  const a1 = (-2 * c) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, s = 0, n = 0
  for (let i = Math.max(0, Math.floor(a * rate)); i < Math.min(x.length, Math.floor(b * rate)); i++) {
    const y = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y
    s += y * y; n++
  }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12)
}

function windowDb(x: Float32Array, a: number, b: number): number {
  let s = 0
  for (let i = a; i < b; i++) s += x[i] * x[i]
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12)
}

it('real-audio DJ evaluation', () => {
  const ref0 = existsSync(join(CORPUS, 'beatthis_ref.json')) ? (JSON.parse(readFileSync(join(CORPUS, 'beatthis_ref.json'), 'utf8')) as Record<string, { final0: { beats: number[] } }>) : {}
  const bpmOf = (id: number) => {
    const b = ref0[String(id)]?.final0?.beats ?? []
    if (b.length < 16) return 0
    const d = b.slice(1).map((v, i) => v - b[i]).sort((x, y) => x - y)
    return 60 / d[Math.floor(d.length / 2)]
  }
  const lo = Number(process.env.EVAL_BPM_MIN ?? 0)
  const hi = Number(process.env.EVAL_BPM_MAX ?? 999)
  const corpus = (JSON.parse(readFileSync(join(CORPUS, 'corpus.json'), 'utf8')) as Array<{ id: number; title: string; artist: string; wav: string; licence: string }>).filter((c) => {
    const b = bpmOf(c.id)
    return b === 0 || (b >= lo && b <= hi)
  })
  const refPath = join(CORPUS, 'beatthis_ref.json')
  const ref = existsSync(refPath) ? (JSON.parse(readFileSync(refPath, 'utf8')) as Record<string, { final0: { beats: number[]; downbeats: number[] } }>) : {}
  mkdirSync(OUT, { recursive: true })
  // EVAL_NET=1: grid from the TypeScript Beat This! pipeline (cached by evaluation/beatnet.eval.ts)
  const netPath = join(CORPUS, 'beatnet_ts.json')
  const netBeats = process.env.EVAL_NET === '1' && existsSync(netPath) ? (JSON.parse(readFileSync(netPath, 'utf8')) as Record<string, { beats: number[]; downbeats: number[] }>) : null
  const tracks = corpus.map((c) => {
    const audio = readWav(c.wav)
    const t0 = performance.now()
    const a = analyzeTrack({ channels: audio.channels, sampleRate: audio.rate, net: netBeats?.[String(c.id)] })
    const ms = performance.now() - t0
    const g = gridBeats(a)
    const r = ref[String(c.id)]?.final0
    const refBpm = r && r.beats.length > 8 ? 60 / median(diff(r.beats)) : null
    return {
      c, audio, a, s: summarize(a), ms,
      vsRef: r ? {
        beatF1: f1(r.beats, g.beats), downbeatF1: f1(r.downbeats, g.downbeats), refBpm,
        bpmErrPct: refBpm ? (100 * Math.abs(a.grid.bpm - refBpm)) / refBpm : null,
        bpmErrOctavePct: refBpm ? (100 * Math.min(...[1, 2, 0.5].map((k) => Math.abs(a.grid.bpm - refBpm * k) / (refBpm * k)))) : null,
      } : null,
    }
  })
  // pair tracks with similar tempo: sort by measured BPM and pair neighbours
  const order = [...tracks].sort((x, y) => x.a.grid.bpm - y.a.grid.bpm)
  const pairs: Array<[typeof tracks[number], typeof tracks[number]]> = []
  for (let i = 0; i + 1 < order.length; i++) pairs.push([order[i], order[i + 1]])
  const recentStyles: TransitionStyle[] = []
  const results = pairs.map(([A, B], k) => {
    const pa: PlanTrack = { itemId: `a${A.c.id}`, trackKey: `jamendo:${A.c.id}`, title: A.c.title, mixable: true, summary: A.s, durationSec: A.s.durationSec }
    const pb: PlanTrack = { itemId: `b${B.c.id}`, trackKey: `jamendo:${B.c.id}`, title: B.c.title, mixable: true, summary: B.s, durationSec: B.s.durationSec }
    // simulate a set: recent styles carry over from pair to pair (variety rotation)
    const allowed = process.env.EVAL_STYLES === 'classic' ? (['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade'] as TransitionStyle[]) : undefined
    const { best, alternatives } = bestTransition(pa, pb, { ...DEFAULT_OPTIONS, recentStyles, allowedStyles: allowed }, 3)
    recentStyles.unshift(best.style)
    const row: Record<string, unknown> = { pair: k, a: A.c.id, b: B.c.id, bpmA: A.s.bpm, bpmB: B.s.bpm, style: best.style, overlapBars: best.overlapBars, tempoRatio: best.tempoRatio, outCue: best.outCueSec, inCue: best.inCueSec, costs: best.costs, risks: best.risks, alternatives: alternatives.map((p) => `${p.style}:${p.costs.total.toFixed(2)}`) }
    if (best.style === 'sequential') return row
    // local grid refinement (EVAL_LOCAL=0 disables, for ablation)
    if (best.durationSec >= 4 && process.env.EVAL_LOCAL !== '0') {
      const r = refineWithLocalBeats(best, A.a.netBeats, B.a.netBeats)
      Object.assign(best, { outCueSec: r.outCueSec, inCueSec: r.inCueSec, beatSec: r.beatSec, tempoRatio: r.tempoRatio, durationSec: r.durationSec })
      row.localRefined = r.localRefined
    }
    // automatic jog nudge for beat-matched styles (EVAL_NUDGE=1 enables, ablation)
    if (best.durationSec >= 4 && process.env.EVAL_NUDGE === '1') {
      const n = phaseNudge(A.audio.channels[0], B.audio.channels[0], A.audio.rate, best.outCueSec, best.inCueSec, best.beatSec, best.tempoRatio)
      row.nudgeMs = Math.round(n.deltaInSec * 1000 * 10) / 10
      row.nudgeStrength = Math.round(n.strength * 100) / 100
      if (n.applied) best.inCueSec = Math.max(0, best.inCueSec + n.deltaInSec)
    }
    const common = { rate: A.audio.rate, out: A.audio.channels, in: B.audio.channels, plan: best, outTrimDb: trimDbFor(A.s.lufs, A.s.truePeak), inTrimDb: trimDbFor(B.s.lufs, B.s.truePeak) }
    const r = renderTransition(common)
    const y = r.channels[0]
    const t0 = r.transitionStartSample / r.rate
    const tEnd = t0 + best.durationSec
    // loudness continuity: short-term LUFS (3 s) sampled each second around the transition
    const lr = measureLoudness(r.channels, r.rate).shortTermLufs
    let maxJump = 0
    for (let i = 1; i < lr.length; i++) if (Number.isFinite(lr[i]) && Number.isFinite(lr[i - 1])) maxJump = Math.max(maxJump, Math.abs(lr[i] - lr[i - 1]))
    // dropouts: minimum 0.5 s RMS inside [t0-2, tEnd+2] relative to the pre-roll level
    const pre = windowDb(y, Math.max(0, Math.round((t0 - 6) * r.rate)), Math.round((t0 - 1) * r.rate))
    let minWin = Infinity
    for (let s = Math.round((t0 - 2) * r.rate); s + r.rate / 2 < Math.min(y.length, Math.round((tEnd + 2) * r.rate)); s += r.rate / 4) minWin = Math.min(minWin, windowDb(y, s, s + r.rate / 2))
    // bass build-up: low-band level during overlap vs before
    const bassPre = bassDb(y, r.rate, Math.max(0, t0 - 6), t0 - 1)
    const bassOverlap = best.durationSec > 1 ? bassDb(y, r.rate, t0, tEnd) : bassPre
    // deck alignment: render each deck alone with flat gains, compare onset envelopes in the overlap
    let alignMs: number | null = null
    if (best.durationSec >= 4) {
      const flat = { gain: [{ beat: 0, value: 1 }, { beat: 1, value: 1 }], low: [{ beat: 0, value: 0 }], mid: [{ beat: 0, value: 0 }], high: [{ beat: 0, value: 0 }] }
      const mute = { ...flat, gain: [{ beat: 0, value: 0 }, { beat: 1, value: 0 }] }
      const onlyOut = renderTransition({ ...common, plan: { ...best, out: flat, in: mute } as TransitionPlan })
      const onlyIn = renderTransition({ ...common, plan: { ...best, out: mute, in: flat } as TransitionPlan })
      const s0 = onlyOut.transitionStartSample
      const s1 = s0 + Math.round(best.durationSec * r.rate)
      const al = robustKickLagMs(onlyOut.channels[0].subarray(s0, s1), onlyIn.channels[0].subarray(s0, s1), r.rate)
      alignMs = Number.isFinite(al.lagMs) ? al.lagMs : null
      row.alignWindows = al.windows
    }
    writeFileSync(join(OUT, `pair${String(k).padStart(2, '0')}_${A.c.id}_${B.c.id}.wav`), encodeWav(r.channels, r.rate))
    Object.assign(row, { clipped: r.clippedSamples, peak: r.peak, limiterGrDb: r.limiterGainReductionDb, loudnessMaxJumpLu: maxJump, dropoutDb: minWin - pre, bassBuildupDb: bassOverlap - bassPre, deckAlignMs: alignMs })
    return row
  })
  const analysis = tracks.map((t) => ({ id: t.c.id, title: t.c.title, bpm: t.s.bpm, bpmConf: t.s.bpmConf, downbeatConf: t.s.downbeatConf, stable: t.s.stable, key: t.s.camelot, lufs: t.s.lufs, flags: t.s.flags, analysisMs: Math.round(t.ms), vsRef: t.vsRef }))
  const count = (k: string) => results.filter((r) => r.style === k).length
  const vals = (k: string) => results.map((r) => r[k]).filter((v): v is number => typeof v === 'number')
  const summary = {
    tag: TAG,
    tracks: tracks.length,
    pairs: results.length,
    styles: Object.fromEntries(['cut', 'unmatched_fade', 'short_fade', 'bass_swap', 'percussion_led', 'long_blend', 'drop_swap', 'filter_sweep', 'echo_out', 'loop_roll', 'brake', 'scratch_cut', 'sequential'].map((s) => [s, count(s)]).filter(([, n]) => (n as number) > 0)),
    beatmatchedPct: (100 * results.filter((r) => ['short_fade', 'bass_swap', 'percussion_led', 'long_blend', 'drop_swap', 'filter_sweep'].includes(String(r.style))).length) / results.length,
    distinctStyles: new Set(results.map((r) => r.style)).size,
    analyzer: {
      beatF1_median: median(analysis.map((a) => a.vsRef?.beatF1 ?? NaN).filter(Number.isFinite)),
      downbeatF1_median: median(analysis.map((a) => a.vsRef?.downbeatF1 ?? NaN).filter(Number.isFinite)),
      bpmErrPct_median: median(analysis.map((a) => a.vsRef?.bpmErrPct ?? NaN).filter(Number.isFinite)),
      bpmOctaveCorrectedWithin2pct: analysis.filter((a) => (a.vsRef?.bpmErrOctavePct ?? 99) <= 2).length,
      beatmatchableTracks: analysis.filter((a) => a.bpmConf >= 0.35 && a.stable).length,
      downbeatConf_median: median(analysis.map((a) => a.downbeatConf)),
    },
    render: { clippedPairs: vals('clipped').filter((v) => v > 0).length, maxPeak: Math.max(...vals('peak')), loudnessJump_median: median(vals('loudnessMaxJumpLu')), dropoutDb_min: Math.min(...vals('dropoutDb')), bassBuildup_median: median(vals('bassBuildupDb')), deckAlignAbsMs_median: median(vals('deckAlignMs').map(Math.abs)) },
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ summary, analysis, results }, null, 1))
  console.log(JSON.stringify(summary, null, 1))
}, 3_600_000)

function diff(x: number[]): number[] {
  return x.slice(1).map((v, i) => v - x[i])
}
function median(x: number[]): number {
  if (!x.length) return NaN
  const s = [...x].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
