import { describe, expect, it } from 'vitest'
import { fft } from './fft'
import { inputPosAt, outputPosOf, wsola } from './stretch'

const RATE = 44100

function peakHz(x: Float32Array, from: number): number {
  const n = 16384
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
  fft(re, im)
  let best = 0
  let bi = 0
  for (let k = 1; k < n / 2; k++) {
    const m = Math.hypot(re[k], im[k])
    if (m > best) {
      best = m
      bi = k
    }
  }
  return (bi * RATE) / n
}

describe('wsola time stretch', () => {
  it('keeps pitch while changing tempo by +5%', () => {
    const x = Float32Array.from({ length: RATE * 4 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / RATE))
    const out = RATE * 3
    const r = wsola([x], 0, out, () => 1.05)
    expect(Math.abs(peakHz(r.channels[0], RATE) - 440)).toBeLessThan(3)
    expect(r.inputEnd).toBeCloseTo(out * 1.05, -3)
  })

  it('moves click onsets onto the new tempo grid', () => {
    const inBpm = 120
    const outBpm = 126
    const period = (60 / inBpm) * RATE
    const x = new Float32Array(RATE * 12)
    for (let b = 0; b * period < x.length - 200; b++) for (let i = 0; i < 200; i++) x[Math.round(b * period) + i] = Math.exp(-i / 30) * (i % 2 ? 1 : -1)
    const ratio = outBpm / inBpm
    const r = wsola([x], 0, RATE * 10, () => ratio)
    // predicted output position of input beat 8 vs measured energy peak
    const inBeat = 8 * period
    const predicted = outputPosOf(r, inBeat)
    expect(predicted).toBeCloseTo(inBeat / ratio, -2)
    let best = 0
    let bi = 0
    for (let i = Math.round(predicted - 2000); i < predicted + 2000; i++) {
      const v = Math.abs(r.channels[0][i])
      if (v > best) {
        best = v
        bi = i
      }
    }
    expect(Math.abs(bi - predicted) / RATE).toBeLessThan(0.012)
    expect(inputPosAt(r, predicted)).toBeCloseTo(inBeat, -2)
  })

  it('supports a ratio ramp back to 1.0', () => {
    const x = Float32Array.from({ length: RATE * 8 }, (_, i) => Math.sin((2 * Math.PI * 330 * i) / RATE))
    const out = RATE * 6
    const r = wsola([x], 0, out, (s) => (s < RATE * 2 ? 1.04 : s < RATE * 4 ? 1.04 - 0.04 * ((s - RATE * 2) / (RATE * 2)) : 1))
    expect(r.inputEnd).toBeGreaterThan(out)
    expect(r.inputEnd).toBeLessThan(out * 1.04)
    expect(Math.abs(peakHz(r.channels[0], RATE * 4) - 330)).toBeLessThan(3)
  })
})
