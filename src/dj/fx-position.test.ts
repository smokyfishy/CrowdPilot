/**
 * The controller's jog-wheel/platter position during performance moves must be the position the
 * renderer actually READ. Trick: render a ramp signal (sample value = sample index) and a ones
 * signal through `renderPerformance`; their ratio is the renderer's read head, independent of the
 * op's gain envelope. `performanceStateAt` must agree with it.
 */
import { describe, expect, it } from 'vitest'
import { performanceStateAt, renderPerformance, type PerfOp, type Performance } from './fx'

const RATE = 8000
const N = RATE * 60
const ramp = new Float32Array(N).map((_, i) => i / RATE) // value = track seconds
const ones = new Float32Array(N).fill(1)

function check(perf: Performance, tolSec: number) {
  const [y] = renderPerformance([ramp], RATE, perf)
  const [w] = renderPerformance([ones], RATE, perf)
  let compared = 0
  let worst = 0
  for (let i = 0; i < y.length; i += 37) {
    if (Math.abs(w[i]) < 0.2) continue // op envelope ~silent: position not observable
    const actual = y[i] / w[i]
    const st = performanceStateAt(perf, i / RATE)
    worst = Math.max(worst, Math.abs(st.pos - actual))
    compared++
  }
  expect(compared).toBeGreaterThan(50)
  expect(worst).toBeLessThan(tolSec)
}

describe('performanceStateAt mirrors renderPerformance read head', () => {
  const beatSec = 0.48
  const base = (ops: PerfOp[], beats = 8): Performance => ({ startSec: 20, beatSec, beats, ops })
  it('loop roll (shrinking slices) incl. reported loop', () => {
    const p = base([{ kind: 'roll', atBeat: 1, sizes: [1, 0.5, 0.25], stepBeats: 2 }])
    check(p, 0.002)
    const st = performanceStateAt(p, (1 + 2.3) * beatSec)
    expect(st.op).toBe('roll')
    expect(st.loop).toEqual({ startSec: 20 + beatSec, beats: 0.5 })
    expect(performanceStateAt(p, 7.9 * beatSec).op).toBe('silent')
  })
  it('vinyl brake', () => check(base([{ kind: 'brake', atBeat: 2, beats: 4 }]), 0.002))
  it('spinback runs backwards', () => {
    const p = base([{ kind: 'spinback', atBeat: 2, beats: 2 }])
    check(p, 0.002)
    expect(performanceStateAt(p, 2.5 * beatSec).speed).toBeLessThan(0)
  })
  it('baby scratch strokes', () => check(base([{ kind: 'scratch', atBeat: 0, beats: 4, strokes: 4 }]), 0.002))
  it('normal playback outside ops', () => {
    const p = base([{ kind: 'scratch', atBeat: 4, beats: 2, strokes: 2 }])
    expect(performanceStateAt(p, 1).pos).toBeCloseTo(21, 9)
    expect(performanceStateAt(p, 1).speed).toBe(1)
  })
})
