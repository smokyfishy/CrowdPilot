/** Control: mix a track into itself (same grid, different bar). Correct analysis+render ⇒ ~0 ms. */
import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { analyzeTrack, summarize } from '../src/dsp/analyze'
import { renderTransition } from '../src/dj/render'
import { automationFor, type TransitionPlan } from '../src/dj/transitions'
import { readWav } from './wav'
import { kickLagMs } from './metrics'

it('self-mix control', () => {
  const corpus = JSON.parse(readFileSync('C:/crowdpilot-data/raw/jamendo_eval/corpus.json', 'utf8')) as Array<{ id: number; wav: string }>
  const net = JSON.parse(readFileSync('C:/crowdpilot-data/raw/jamendo_eval/beatnet_ts.json', 'utf8'))
  for (const c of corpus.slice(0, 6)) {
    const w = readWav(c.wav)
    const a = analyzeTrack({ channels: w.channels, sampleRate: w.rate, net: net[String(c.id)] })
    const s = summarize(a)
    const P = a.grid.periodSec
    const first = a.grid.firstBeatSec + a.grid.downbeatPhase * P
    const inCue = first + 16 * P * 4 // bar 16
    const outCue = first + 64 * P * 4 // bar 64
    const auto = automationFor('short_fade', 64)
    const plan = { fromItemId: 'a', toItemId: 'b', style: 'short_fade', outCueSec: outCue, inCueSec: inCue, overlapBars: 16, tempoRatio: Number(process.env.SELF_RATIO ?? 1), tempoRecoveryBars: 0, beatSec: P, durationSec: 64 * P, handoffBeat: 32, ...auto, costs: { tempo: 0, key: 0, energy: 0, vocals: 0, confidence: 0, truncation: 0, variety: 0, total: 0 }, risks: [], reasons: [] } as TransitionPlan
    const flat = { gain: [{ beat: 0, value: 1 }, { beat: 1, value: 1 }], low: [{ beat: 0, value: 0 }], mid: [{ beat: 0, value: 0 }], high: [{ beat: 0, value: 0 }] }
    const mute = { ...flat, gain: [{ beat: 0, value: 0 }, { beat: 1, value: 0 }] }
    const o = renderTransition({ rate: w.rate, out: w.channels, in: w.channels, plan: { ...plan, out: flat, in: mute } as TransitionPlan })
    const i = renderTransition({ rate: w.rate, out: w.channels, in: w.channels, plan: { ...plan, out: mute, in: flat } as TransitionPlan })
    const s0 = o.transitionStartSample
    const half = Math.round(32 * P * w.rate)
    console.log(c.id, 'bpm', s.bpm, 'src', a.grid.source, 'lag first half', kickLagMs(o.channels[0].subarray(s0, s0 + half), i.channels[0].subarray(s0, s0 + half), w.rate).toFixed(1), 'second half', kickLagMs(o.channels[0].subarray(s0 + half, s0 + 2 * half), i.channels[0].subarray(s0 + half, s0 + 2 * half), w.rate).toFixed(1))
  }
}, 600_000)
