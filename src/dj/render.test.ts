import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from '../dsp/analyze'
import { synthTrack } from '../dsp/synth'
import { encodeWav, renderTransition } from './render'
import { automationFor, bestTransition, type PlanTrack, type TransitionPlan } from './transitions'

const RATE = 44100

function planFor() {
  const A = synthTrack({ bpm: 124, bars: 64, sampleRate: RATE, offsetSec: 0.2, tonic: 9, mode: 'minor', introBars: 8, outroBars: 8, seed: 3 })
  const B = synthTrack({ bpm: 127, bars: 64, sampleRate: RATE, offsetSec: 0.5, tonic: 4, mode: 'minor', introBars: 8, outroBars: 8, seed: 9 })
  const sa = summarize(analyzeTrack({ channels: A.channels, sampleRate: RATE }))
  const sb = summarize(analyzeTrack({ channels: B.channels, sampleRate: RATE }))
  const ta: PlanTrack = { itemId: 'a', trackKey: 'audius:a', title: 'A', mixable: true, summary: sa, durationSec: sa.durationSec }
  const tb: PlanTrack = { itemId: 'b', trackKey: 'audius:b', title: 'B', mixable: true, summary: sb, durationSec: sb.durationSec }
  return { A, B, sa, sb, ...bestTransition(ta, tb, { maxTempoDeviation: 0.06, weights: { tempo: 0.25, key: 1, energy: 0.08, vocals: 1.2, confidence: 1, truncation: 0.02, variety: 0.4 }, recentStyles: [], energyDirection: 0, allowedStyles: ['bass_swap'] }) }
}

function windowRmsDb(x: Float32Array, a: number, b: number): number {
  let s = 0
  for (let i = a; i < b; i++) s += x[i] * x[i]
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-12)
}

describe('offline transition render (same plan as the live engine)', () => {
  it('renders a beat-matched bass swap without clipping, gaps, or beat drift', () => {
    const { A, B, best } = planFor()
    expect(best.style).toBe('bass_swap')
    expect(best.tempoRatio).toBeCloseTo(124 / 127, 2)
    const r = renderTransition({ rate: RATE, out: A.channels, in: B.channels, plan: best })
    expect(r.clippedSamples).toBe(0)
    expect(r.peak).toBeLessThan(0.95)
    // no dropouts: every beat-length (0.5 s) window from 2 s before to the end of the overlap is
    // audible (the synthetic intro is drums-only, so shorter windows can be legitimately silent)
    const t0 = r.transitionStartSample
    const end = t0 + Math.round(best.durationSec * RATE)
    for (let i = t0 - 2 * RATE; i < end; i += RATE / 4) expect(windowRmsDb(r.channels[0], i, i + RATE / 2)).toBeGreaterThan(-35)

    // beat alignment: render ONLY the incoming deck and check its kicks land on the outgoing grid
    const silentOut: TransitionPlan = { ...best, out: { ...best.out, gain: [{ beat: 0, value: 0 }, { beat: 1, value: 0 }] }, in: { ...automationFor('short_fade', best.overlapBars * 4).in, gain: [{ beat: 0, value: 1 }, { beat: 1, value: 1 }] } }
    const onlyB = renderTransition({ rate: RATE, out: A.channels, in: B.channels, plan: silentOut, preRollSec: 0 })
    const outBeat = 60 / 124
    // true outgoing beat times relative to the transition start: outCue is on the analyzed grid
    const errs: number[] = []
    for (let k = 4; k < best.overlapBars * 4 - 2; k += 4) {
      const center = Math.round(k * outBeat * RATE)
      let bestI = center
      let bestV = 0
      for (let i = center - Math.round(0.06 * RATE); i < center + Math.round(0.06 * RATE); i++) {
        const v = Math.abs(onlyB.channels[0][i] ?? 0)
        if (v > bestV) {
          bestV = v
          bestI = i
        }
      }
      errs.push(Math.abs(bestI - center) / RATE)
    }
    const median = [...errs].sort((a, b) => a - b)[Math.floor(errs.length / 2)]
    expect(median).toBeLessThan(0.03)
  }, 120_000)

  it('encodes a valid 16-bit WAV', () => {
    const wav = encodeWav([new Float32Array([0, 0.5, -0.5])], 44100)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(wav.length).toBe(44 + 6)
  })
})
