import { describe, expect, it } from 'vitest'
import type { AnalysisSummary } from '../dsp/analyze'
import { bruteForceQueue, planQueue, type QueueCandidate } from './queue-planner'
import { automationFor, bestTransition, candidateTransitions, tempoMatch, type PlanTrack } from './transitions'

function summary(over: Partial<AnalysisSummary> = {}): AnalysisSummary {
  const bpm = over.bpm ?? 124
  const barSec = (60 / bpm) * 4
  const dur = over.durationSec ?? 360
  const phrases: number[] = []
  for (let t = 0; t < dur - barSec; t += barSec * 8) phrases.push(Math.round(t * 1000) / 1000)
  return {
    v: 'test',
    bpm,
    bpmConf: 0.9,
    firstBeat: 0,
    downbeatPhase: 0,
    downbeatConf: 0.6,
    stable: true,
    key: 'A minor',
    camelot: '8A',
    keyConf: 0.6,
    lufs: -9,
    truePeak: -0.5,
    durationSec: dur,
    phrasesSec: phrases,
    cueIn: [0, barSec * 16],
    cueOut: phrases.filter((t) => t > dur * 0.7).slice(0, 3),
    introBars: 16,
    outroBars: 16,
    barSec,
    vocalIn: 0.1,
    vocalOut: 0.1,
    energyIn: -20,
    energyOut: -20,
    energyMean: -14,
    flags: [],
    ...over,
  }
}

const track = (id: string, s?: Partial<AnalysisSummary> | null, mixable = true): PlanTrack => ({
  itemId: id,
  trackKey: `audius:${id}`,
  title: id,
  mixable,
  summary: s === null ? undefined : summary(s ?? {}),
  durationSec: s?.durationSec ?? 360,
})

describe('transitions', () => {
  it('beat-matches compatible tracks with a blend and stays within ±6%', () => {
    const { best, alternatives } = bestTransition(track('a'), track('b', { bpm: 126, camelot: '9A' }))
    expect(['long_blend', 'bass_swap', 'percussion_led', 'short_fade']).toContain(best.style)
    expect(Math.abs(best.tempoRatio - 124 / 126)).toBeLessThan(1e-9)
    expect(best.outCueSec + best.durationSec).toBeLessThanOrEqual(360)
    expect(alternatives.every((p) => p.style !== best.style)).toBe(true)
    expect(best.reasons.length).toBeGreaterThan(0)
  })

  it('never beat-matches beyond the tempo limit', () => {
    const plans = candidateTransitions(track('a', { bpm: 124 }), track('b', { bpm: 140 }))
    expect(plans.every((p) => p.style === 'cut' || p.style === 'unmatched_fade')).toBe(true)
  })

  it('handles half/double-time candidates', () => {
    expect(tempoMatch(124, 62).ratio).toBeCloseTo(1, 9)
    expect(tempoMatch(124, 62).octave).toBe(2)
  })

  it('falls back to standard playback for non-mixable sources', () => {
    const plans = candidateTransitions(track('a'), track('yt', null, false))
    expect(plans).toHaveLength(1)
    expect(plans[0].style).toBe('sequential')
  })

  it('refuses beat-matched styles when the grid is unstable', () => {
    const plans = candidateTransitions(track('a'), track('b', { stable: false }))
    expect(plans.every((p) => p.style === 'cut' || p.style === 'unmatched_fade')).toBe(true)
  })

  it('produces bounded, monotone-time automation curves for every style', () => {
    for (const style of ['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade'] as const) {
      const a = automationFor(style, 64)
      for (const deck of [a.out, a.in]) {
        for (const curve of [deck.gain, deck.low, deck.mid, deck.high]) {
          for (let i = 1; i < curve.length; i++) expect(curve[i].beat).toBeGreaterThanOrEqual(curve[i - 1].beat)
        }
        for (const p of deck.gain) expect(p.value).toBeGreaterThanOrEqual(0)
        for (const p of deck.gain) expect(p.value).toBeLessThanOrEqual(1)
        for (const p of [...deck.low, ...deck.mid, ...deck.high]) expect(p.value).toBeLessThanOrEqual(0)
      }
      // equal-power sum at the handoff is ≈ constant power for fades
      if (style === 'short_fade') {
        const mid = a.out.gain[8].value ** 2 + a.in.gain[8].value ** 2
        expect(mid).toBeCloseTo(1, 6)
      }
    }
  })
})

function cands(n: number, opts: { keys?: string[]; bpms?: number[]; pinned?: number[]; votes?: number[] } = {}): QueueCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    track: track(`t${i}`, { bpm: opts.bpms?.[i] ?? 124, camelot: opts.keys?.[i] ?? '8A', durationSec: 300 }),
    fifoIndex: i,
    pinned: opts.pinned?.includes(i) ?? false,
    votes: opts.votes?.[i] ?? 0,
  }))
}

describe('queue planner', () => {
  const base = { now: 1_000_000, current: track('cur', { camelot: '8A' }), currentRemainingSec: 120 }

  it('keeps FIFO exactly when AI reorder is off', () => {
    const items = cands(5, { keys: ['3A', '8A', '1B', '9A', '8B'] })
    const plan = planQueue({ ...base, items, aiReorder: false })
    expect(plan.order).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(plan.reordered).toBe(false)
  })

  it('matches brute force on toy cases (beam = exhaustive optimum)', () => {
    const keySets = [
      ['3A', '8A', '1B', '9A', '8B', '2A'],
      ['8A', '8A', '8A', '8A', '8A', '8A'],
      ['12B', '5A', '8A', '6B', '9A', '7A'],
    ]
    for (const keys of keySets) {
      for (const maxDisplacement of [1, 2, 5]) {
        const items = cands(6, { keys, bpms: [124, 126, 122, 128, 124, 121], pinned: keys[0] === '12B' ? [3] : [], votes: [0, 2, 0, 5, 1, 0] })
        const input = { ...base, items, aiReorder: true, maxDisplacement, beamWidth: 5000, horizon: 6 }
        const beam = planQueue(input)
        const bf = bruteForceQueue(input)
        expect(bf).not.toBeNull()
        expect(beam.cost).toBeCloseTo(bf!.cost, 9)
        expect(beam.order).toEqual(bf!.order)
      }
    }
  })

  it('never violates hard constraints', () => {
    const items = cands(7, { keys: ['3A', '8A', '1B', '9A', '8B', '2A', '8A'], pinned: [5] })
    items[2].lockedIndex = 2
    const plan = planQueue({ ...base, items, aiReorder: true, maxDisplacement: 2, committedNextId: 't4' })
    expect(plan.order[0]).toBe('t4') // committed next stays first
    expect(plan.order[1]).toBe('t5') // pinned next
    expect(plan.order[2]).toBe('t2') // locked index
    // displacement is measured against the baseline: committed, pins, then FIFO
    const baseline = ['t4', 't5', 't0', 't1', 't2', 't3', 't6']
    plan.order.forEach((id, pos) => expect(pos - baseline.indexOf(id)).toBeLessThanOrEqual(2))
    expect(new Set(plan.order).size).toBe(7)
  })

  it('reports a conflict instead of jumping when a timed slot is unreachable', () => {
    const items = cands(4)
    items[3].targetStartAt = base.now + 10_000 // 10 s from now: impossible behind 2 min remaining + 3 songs
    const plan = planQueue({ ...base, items, aiReorder: false })
    expect(plan.conflicts.some((c) => c.itemId === 't3' && c.kind === 'timed_slot_unreachable')).toBe(true)
    expect(plan.order).toEqual(['t0', 't1', 't2', 't3'])
  })

  it('moves a timed item forward when reorder is on and that meets its slot', () => {
    const items = cands(4)
    // target: right after the current track (≈ 120 s); FIFO would start it ~1020 s later
    items[3].targetStartAt = base.now + 130_000
    const plan = planQueue({ ...base, items, aiReorder: true, maxDisplacement: 3, timedToleranceSec: 60 })
    expect(plan.order[0]).toBe('t3')
    expect(plan.conflicts).toHaveLength(0)
  })
})
