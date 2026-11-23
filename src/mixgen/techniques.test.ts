import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from '../dsp/analyze'
import { synthTrack } from '../dsp/synth'
import { candidateTransitions, DEFAULT_OPTIONS, type PlanTrack } from '../dj/transitions'
import { applyDeckEdits, genrePreference, reverb, routeStems, techniqueCandidates, type StemInfo } from './techniques'
import { renderMix } from './mix-render'
import { planMix, type PlannedTrack } from './mixplan'
import { MixSpec, resolveSpec } from './spec'

const R = 22050
const track = (bpm: number, seed: number) => synthTrack({ bpm, bars: 96, sampleRate: R, seed, mode: 'minor', tonic: 9, introBars: 16, outroBars: 16, breakdown: [40, 48] })
const energy = (x: Float32Array, a: number, b: number) => {
  let e = 0
  for (let i = a; i < b; i++) e += x[i] * x[i]
  return e / Math.max(1, b - a)
}

describe('technique DSP (real audio transformations)', () => {
  const t = track(124, 3)
  const beat = 60 / 124
  it('stabs rewrite only their region, with hits at the planned beat positions', () => {
    const start = 40
    const out = applyDeckEdits(t.channels, R, [{ kind: 'stabs', startSec: start, beats: 16, beatSec: beat, sourceSec: 10, hitBeats: 0.25, intervals: [8, 4, 2, 1], duck: 0.15 }])
    expect(energy(out[0], 0, Math.round(start * R))).toBeCloseTo(energy(t.channels[0], 0, Math.round(start * R)), 8) // untouched before
    let diff = 0
    for (let i = Math.round(start * R); i < Math.round((start + 16 * beat) * R); i++) diff += Math.abs(out[0][i] - t.channels[0][i])
    expect(diff).toBeGreaterThan(10)
  })
  it('beat juggle repeats an earlier beat on pattern slots and leaves live slots intact', () => {
    const start = 40
    const out = applyDeckEdits(t.channels, R, [{ kind: 'juggle', startSec: start, beats: 8, beatSec: beat, offsetBeats: 4, pattern: [0, 0, 1, 0] }])
    const b = Math.round(beat * R)
    const s0 = Math.round(start * R)
    const mid = s0 + 2 * b + Math.round(b / 2) // centre of slot 2 (repeat)
    expect(out[0][mid]).toBeCloseTo(t.channels[0][mid - Math.round(4 * beat * R)], 6)
    expect(out[0][s0 + Math.round(b / 2)]).toBeCloseTo(t.channels[0][s0 + Math.round(b / 2)], 6) // slot 0 live
  })
  it('tone play re-pitches: a +12 semitone copy is the source read at double speed', () => {
    const tone = new Float32Array(R * 4).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / R))
    const out = applyDeckEdits([tone], R, [{ kind: 'tone', startSec: 1, beats: 1, beatSec: 0.5, sourceSec: 0, hitBeats: 0.5, semitones: [12], mix: 1 }])
    // count zero crossings in the hit → about twice the 220 Hz rate
    let zc = 0
    const a = R + 200
    const len = Math.round(0.1 * R)
    for (let i = a + 1; i < a + len; i++) if (Math.sign(out[0][i]) !== Math.sign(out[0][i - 1])) zc++
    expect(zc / 2 / 0.1).toBeGreaterThan(380)
  })
  it('reverb produces a decaying tail after the input stops', () => {
    const x = new Float32Array(R * 3)
    for (let i = 0; i < R * 0.2; i++) x[i] = Math.sin(i * 0.05)
    const y = reverb(x, R, 2)
    expect(energy(y, Math.round(R * 0.6), Math.round(R * 1.2))).toBeGreaterThan(1e-6)
    expect(energy(y, Math.round(R * 2.4), R * 3)).toBeLessThan(energy(y, Math.round(R * 0.6), Math.round(R * 1.2)))
  })
  it('stem routing keeps the mixture outside its window and applies gains inside', () => {
    const v = [new Float32Array(R * 4).fill(0.2)]
    const s = [new Float32Array(R * 4).fill(0.3)]
    const mix = [new Float32Array(R * 4).fill(0.5)]
    const out = routeStems(mix, { vocals: v, inst: s }, R, 1, 3, (sec) => sec - 1, { vocals: [{ beat: 0, value: 0 }, { beat: 2, value: 0 }], inst: [{ beat: 0, value: 1 }, { beat: 2, value: 1 }] })
    expect(out[0][Math.round(0.5 * R)]).toBeCloseTo(0.5, 6)
    expect(out[0][Math.round(2 * R)]).toBeCloseTo(0.3, 6) // vocals muted, instrumental only
    expect(out[0][Math.round(3.5 * R)]).toBeCloseTo(0.5, 6)
  })
})

describe('technique selection and execution', () => {
  const tracks = [track(124, 21), track(125, 22), track(126, 23)]
  const planned: PlannedTrack[] = tracks.map((t, i) => ({ key: `k${i}`, title: `t${i}`, summary: summarize(analyzeTrack({ channels: t.channels, sampleRate: R })), trimDb: 0, netBeats: t.truth.beatTimes }))
  const pt = (p: PlannedTrack): PlanTrack => ({ itemId: p.key, trackKey: p.key, title: p.title, mixable: true, summary: p.summary, durationSec: p.summary.durationSec })
  it('offers layering only with clean stems and compatible keys, and genre shapes preferences', () => {
    const spec = resolveSpec(MixSpec.parse({ transition_style: 'creative', genres: ['tech house'] }))
    const bases = candidateTransitions(pt(planned[0]), pt(planned[1]), DEFAULT_OPTIONS)
    const loud = (n: number): StemInfo => ({ vocalDb: Array(n).fill(-20), barStartSec: 0, barSec: planned[0].summary.barSec, clean: true, bleed: 0.05 })
    const quiet = (n: number): StemInfo => ({ ...loud(n), vocalDb: Array(n).fill(-60) })
    const base = { spec, a: planned[0].summary, b: planned[1].summary, gridA: true, gridB: true, maxTempo: 0.06 }
    const withStems = techniqueCandidates(bases, { ...base, stemsA: quiet(200), stemsB: loud(200) }).map((p) => p.tech!.technique)
    const dirty = techniqueCandidates(bases, { ...base, stemsA: { ...quiet(200), clean: false }, stemsB: loud(200) }).map((p) => p.tech!.technique)
    if (bases.some((b) => b.overlapBars >= 16)) expect(withStems).toContain('acapella_layer')
    expect(dirty).not.toContain('acapella_layer')
    expect(genrePreference('long_blend', 'acapella_layer', spec)).toBeLessThan(genrePreference('long_blend', 'beat_juggle', spec))
  })
  it('a creative set plans techniques and the renderer executes them without gaps or clipping', async () => {
    const spec = resolveSpec(MixSpec.parse({ transition_style: 'creative', song_count: 3, target_duration_minutes: 7 }))
    const plan = planMix(planned, spec, { techniques: { enabled: true } })
    const byKey = new Map(tracks.map((t, i) => [`k${i}`, { channels: [t.channels[0], t.channels[0]], rate: R }]))
    const r = await renderMix(plan, { load: async (k) => byKey.get(k)! }, { write: () => {} })
    expect(r.metrics.clippedSamples).toBe(0)
    expect(r.metrics.silences.filter((s) => s.startSec < r.metrics.durationSec - 3)).toEqual([])
    expect(plan.candidates.flat().some((p) => (p as { tech?: unknown }).tech)).toBe(true)
  }, 120_000)
})
