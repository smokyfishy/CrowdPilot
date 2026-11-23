import { describe, expect, it } from 'vitest'
import { mlpForward, type MlpModel } from './mlp'
import { transitionNetV2Predict } from './transitionnet-v2'

const FIX = import.meta.glob('./__fixtures__/transitionnet_v2_parity.json', { eager: true, import: 'default' }) as Record<string, unknown>
const MODELS = import.meta.glob('../../public/models/ml/transitionnet_v2.json', { eager: true, import: 'default' }) as Record<string, unknown>
const model = Object.values(MODELS)[0] as MlpModel | undefined
const fx = Object.values(FIX)[0] as { x: number[]; strategy: number[]; params: number[]; cueShift: number[] } | undefined

describe.skipIf(!model || !fx)('TransitionNet v2 runtime', () => {
  it('matches the PyTorch forward pass (parity fixture)', () => {
    const o = mlpForward(model!, fx!.x)
    o.strategy.forEach((v, i) => expect(v).toBeCloseTo(fx!.strategy[i], 3))
    o.params.forEach((v, i) => expect(v).toBeCloseTo(fx!.params[i], 3))
    o.cueShift.forEach((v, i) => expect(v).toBeCloseTo(fx!.cueShift[i], 3))
  })
  it('never proposes a strategy the window does not support', () => {
    for (const feasible of [['layered_blend'], ['filter_ride', 'percussion_build'], ['drop_lock', 'layered_blend']] as const) {
      const p = transitionNetV2Predict(model!, fx!.x, [...feasible])
      expect(feasible).toContain(p.strategy)
      expect(Object.values(p.params).every((v) => v >= 0 && v <= 1)).toBe(true)
    }
  })
})
