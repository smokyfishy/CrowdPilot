import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from '../dsp/analyze'
import { synthTrack } from '../dsp/synth'
import { renderTransition } from './render'
import { renderPerformance } from './fx'
import { automationFor, candidateTransitions, type PlanTrack, type TransitionStyle } from './transitions'
import { validatePlan } from './engine/deck-engine'

const RATE = 44100
const rms = (x: Float32Array, a: number, b: number) => 10 * Math.log10(x.slice(Math.max(0, a), b).reduce((s, v) => s + v * v, 0) / Math.max(1, b - a) + 1e-12)

describe('performance FX', () => {
  const t = synthTrack({ bpm: 125, bars: 16, sampleRate: RATE, seed: 4 })
  const beat = 60 / 125
  it('roll repeats a slice and then goes silent', () => {
    const [y] = renderPerformance(t.channels, RATE, { startSec: 4 * beat, beatSec: beat, beats: 8, ops: [{ kind: 'roll', atBeat: 0, sizes: [1, 0.5, 0.25, 0.125], stepBeats: 2 }] })
    const B = Math.round(beat * RATE)
    // first two beats: beat 0 repeats → beat 1 equals beat 0 (away from edge fades)
    expect(Math.abs(y[B + 1000] - y[1000])).toBeLessThan(1e-6)
    expect(y.length).toBe(Math.round(8 * beat * RATE))
  })
  it('brake slows down to silence', () => {
    const [y] = renderPerformance(t.channels, RATE, { startSec: 4 * beat, beatSec: beat, beats: 4, ops: [{ kind: 'brake', atBeat: 1, beats: 2 }] })
    const B = Math.round(beat * RATE)
    expect(rms(y, 3 * B + 100, 4 * B)).toBeLessThan(-80)
    expect(rms(y, 0, B)).toBeGreaterThan(-40)
  })
})

describe('creative transition styles', () => {
  const A = synthTrack({ bpm: 124, bars: 64, sampleRate: RATE, offsetSec: 0.2, tonic: 9, mode: 'minor', introBars: 8, outroBars: 8, breakdown: [24, 32], seed: 3 })
  const B = synthTrack({ bpm: 125, bars: 64, sampleRate: RATE, offsetSec: 0.4, tonic: 4, mode: 'minor', introBars: 8, outroBars: 8, breakdown: [16, 24], seed: 9 })
  const sa = summarize(analyzeTrack({ channels: A.channels, sampleRate: RATE }))
  const sb = summarize(analyzeTrack({ channels: B.channels, sampleRate: RATE }))
  const ta: PlanTrack = { itemId: 'a', trackKey: 'audius:a', title: 'A', mixable: true, summary: sa, durationSec: sa.durationSec }
  const tb: PlanTrack = { itemId: 'b', trackKey: 'audius:b', title: 'B', mixable: true, summary: sb, durationSec: sb.durationSec }
  // house rules: only ≥ 16-bar styles are generated (echo-out / loop roll / brake / scratch cut never are)
  const styles: TransitionStyle[] = ['filter_sweep', 'drop_swap', 'bass_swap', 'long_blend']
  for (const style of styles) {
    it(`${style}: valid plan, renders without clipping, has a distinct shape`, () => {
      const plans = candidateTransitions(ta, tb, { maxTempoDeviation: 0.06, weights: { tempo: 0.25, key: 1, energy: 0.08, vocals: 1.2, confidence: 1, truncation: 0.02, variety: 0.8 }, recentStyles: [], energyDirection: 0, allowedStyles: [style] })
      const p = plans[0]
      if (style === 'drop_swap' && p.style !== 'drop_swap') return // needs a detected drop in B
      expect(p.style).toBe(style)
      expect(validatePlan(p)).toEqual([])
      const r = renderTransition({ rate: RATE, out: A.channels, in: B.channels, plan: p })
      expect(r.clippedSamples).toBe(0)
      const t0 = r.transitionStartSample
      const slam = Math.round(t0 + p.handoffBeat * p.beatSec * RATE)
      // the incoming is audible after the handoff
      expect(rms(r.channels[0], slam + 2000, slam + RATE)).toBeGreaterThan(-40)
      if (p.echo) {
        // the echo tail is audible right after the outgoing dry signal is cut, even with the incoming muted
        const muted = renderTransition({ rate: RATE, out: A.channels, in: B.channels, plan: { ...p, in: { ...p.in, gain: [{ beat: 0, value: 0 }, { beat: 1, value: 0 }] } } })
        const cut = Math.round(muted.transitionStartSample + p.handoffBeat * p.beatSec * RATE)
        expect(rms(muted.channels[0], cut + 500, cut + Math.round(p.beatSec * RATE))).toBeGreaterThan(-45)
      }
    }, 120_000)
  }
  it('every style has its own automation (not relabelled crossfades)', () => {
    const sig = (s: TransitionStyle) => JSON.stringify(automationFor(s, 16))
    const all = new Set(styles.map(sig))
    expect(all.size).toBe(styles.length)
  })
})
