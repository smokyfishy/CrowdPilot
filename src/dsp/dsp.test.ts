import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from './analyze'
import { fft } from './fft'
import { camelot, camelotDistance, keyFromChroma } from './key'
import { measureLoudness } from './loudness'
import { resample } from './resample'
import { synthTrack } from './synth'

const sine = (f: number, rate: number, sec: number, amp = 1) =>
  Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate))

describe('fft', () => {
  it('puts a pure tone in the right bin with the right magnitude', () => {
    const n = 1024
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 37 * i) / n)
    fft(re, im)
    expect(Math.hypot(re[37], im[37])).toBeCloseTo(n / 2, 6)
    expect(Math.hypot(re[36], im[36])).toBeLessThan(1e-6)
  })
})

describe('resample', () => {
  it('keeps in-band tones and removes tones above the new Nyquist', () => {
    const pass = resample(sine(1000, 44100, 0.5), 44100, 22050)
    const stop = resample(sine(15000, 44100, 0.5), 44100, 22050)
    const rms = (x: Float32Array) => Math.sqrt(x.slice(500, -500).reduce((a, b) => a + b * b, 0) / (x.length - 1000))
    expect(rms(pass)).toBeCloseTo(Math.SQRT1_2, 2)
    expect(20 * Math.log10(rms(stop) / Math.SQRT1_2)).toBeLessThan(-60)
  })
})

describe('loudness (BS.1770)', () => {
  it('reads a 0 dBFS 997 Hz sine in one channel as −3.01 LUFS', () => {
    for (const rate of [48000, 44100]) {
      const l = sine(997, rate, 5)
      const r = new Float32Array(l.length)
      const rep = measureLoudness([l, r], rate)
      expect(rep.integratedLufs).toBeGreaterThan(-3.11)
      expect(rep.integratedLufs).toBeLessThan(-2.91)
    }
  })
  it('tracks gain changes 1:1 and reports true peak ≥ sample peak', () => {
    const a = measureLoudness([sine(440, 44100, 4, 0.5)], 44100)
    const b = measureLoudness([sine(440, 44100, 4, 0.25)], 44100)
    expect(a.integratedLufs - b.integratedLufs).toBeCloseTo(6.02, 1)
    expect(a.truePeakDbtp).toBeGreaterThanOrEqual(a.samplePeakDb - 1e-9)
  })
})

describe('key', () => {
  it('maps Camelot codes correctly', () => {
    expect(camelot(0, 'major')).toBe('8B')
    expect(camelot(9, 'minor')).toBe('8A')
    expect(camelot(7, 'major')).toBe('9B')
    expect(camelot(4, 'minor')).toBe('9A')
    expect(camelotDistance('8A', '8B')).toBe(1)
    expect(camelotDistance('8A', '9A')).toBe(1)
    expect(camelotDistance('8A', '2A')).toBe(6)
  })
  it('recognises a C-major scale profile', () => {
    const prof = [1, 0, 0.6, 0, 0.8, 0.6, 0, 0.9, 0, 0.6, 0, 0.4]
    const k = keyFromChroma(prof)
    expect(k.camelot === '8B' || k.camelot === '8A').toBe(true)
  })
})

describe('analyzeTrack on synthetic ground truth', () => {
  const cases = [
    { bpm: 124, offsetSec: 0.37, tonic: 9, mode: 'minor' as const },
    { bpm: 128, offsetSec: 1.1, tonic: 7, mode: 'major' as const },
    { bpm: 118.5, offsetSec: 0.05, tonic: 2, mode: 'minor' as const },
  ]
  for (const c of cases) {
    it(`recovers ${c.bpm} BPM, beat phase, downbeat and key`, () => {
      const { channels, sampleRate, truth } = synthTrack({ ...c, bars: 48, sampleRate: 44100, breakdown: [24, 32], introBars: 8 })
      const a = analyzeTrack({ channels, sampleRate })
      expect(Math.abs(a.grid.bpm - c.bpm)).toBeLessThan(0.05)
      // nearest grid beat to the true first downbeat
      const k = Math.round((truth.firstDownbeatSec - a.grid.firstBeatSec) / a.grid.periodSec)
      const gridT = a.grid.firstBeatSec + k * a.grid.periodSec
      expect(Math.abs(gridT - truth.firstDownbeatSec)).toBeLessThan(0.015)
      // downbeat phase: the grid's downbeats coincide with true downbeats
      expect(((k % 4) + 4) % 4).toBe(a.grid.downbeatPhase)
      expect(a.grid.stable).toBe(true)
      const expected = camelot(c.tonic, c.mode)
      expect(camelotDistance(a.key.camelot, expected)).toBeLessThanOrEqual(1)
      expect(a.sections.some((s) => s.kind === 'breakdown' && Math.abs(s.startBar - 24) <= 1)).toBe(true)
      expect(a.cues.some((q) => q.kind === 'mix_in')).toBe(true)
      expect(a.cues.some((q) => q.kind === 'mix_out')).toBe(true)
      const s = summarize(a)
      expect(JSON.stringify(s).length).toBeLessThan(4000)
    }, 60_000)
  }

  it('flags silence instead of inventing a tempo', () => {
    const a = analyzeTrack({ channels: [new Float32Array(44100 * 40)], sampleRate: 44100 })
    expect(a.qc.mostlySilent).toBe(true)
    expect(a.flags.join(' ')).toMatch(/silent/)
    expect(a.grid.confidence).toBeLessThan(0.5)
  }, 60_000)
})
