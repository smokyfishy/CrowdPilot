import { describe, expect, it } from 'vitest'
import { automationFor, type TransitionPlan } from '../transitions'
import { safetyCurve, trimDbFor, validatePlan } from './deck-engine'

const plan = (over: Partial<TransitionPlan> = {}): TransitionPlan => ({
  fromItemId: 'a', toItemId: 'b', style: 'bass_swap', outCueSec: 100, inCueSec: 0, overlapBars: 16, tempoRatio: 1.02, tempoRecoveryBars: 16, beatSec: 0.48,
  durationSec: 30.72, ...automationFor('bass_swap', 64), costs: { tempo: 0, key: 0, energy: 0, vocals: 0, confidence: 0, truncation: 0, variety: 0, total: 0 }, risks: [], reasons: [], ...over,
})

describe('engine safety', () => {
  it('normalises loudness but never boosts above −1 dBTP', () => {
    expect(trimDbFor(-15)).toBe(5)
    expect(trimDbFor(-15, -3.1)).toBeCloseTo(2.1, 9)
    expect(trimDbFor(-6, 0.3)).toBe(-4)
    expect(trimDbFor(undefined)).toBe(0)
  })
  it('safety curve is transparent below −1 dBFS and bounded below full scale', () => {
    const c = safetyCurve(4097)
    const at = (x: number) => c[Math.round(((x + 1) / 2) * 4096)]
    expect(at(0.5)).toBeCloseTo(0.5, 3)
    expect(at(-0.8)).toBeCloseTo(-0.8, 3)
    expect(Math.max(...c)).toBeLessThan(1)
    expect(at(1)).toBeLessThan(1)
  })
  it('rejects unsafe plans', () => {
    expect(validatePlan(plan())).toEqual([])
    expect(validatePlan(plan({ tempoRatio: 1.09 }))).toContain('tempo ratio beyond ±6%')
    expect(validatePlan(plan({ overlapBars: 0 }))).toContain('zero-length crossfade')
    expect(validatePlan(plan({ in: { ...plan().in, gain: [{ beat: 0, value: 0 }, { beat: 4, value: 1.5 }] } })).join()).toMatch(/gain out of/)
    expect(validatePlan(plan({ out: { ...plan().out, low: [{ beat: 4, value: 0 }, { beat: 2, value: -40 }] } })).join()).toMatch(/backwards/)
  })
})
