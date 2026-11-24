import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize, type AnalysisSummary } from '../dsp/analyze'
import { synthTrack } from '../dsp/synth'
import { curveAt } from '../dj/automation'
import { renderTransition } from '../dj/render'
import { automationFor, type TransitionPlan } from '../dj/transitions'
import { buildProfile, cueCandidates, overlapCompat, type TrackProfile } from './profile'
import { buildPerformance, feasibleStrategies } from './longform'
import { planSet, narrativeFor, edgeSig, type SetTrack } from './setplan'
import { evaluateTransition } from './audio-quality'
import { closedLoop, renderPreviewCropped, type PreviewEvaluator, PREVIEW_RATE } from './closedloop'
import { validPlan, monoAt } from './ml'
import { resolveSpec, MixSpec } from './spec'
import { avoided, matchesAny } from './technique-match'

/** Synthetic profile: per-bar arrays from simple descriptions. */
function profile(n: number, f: Partial<Record<'bass' | 'vocal' | 'mid' | 'perc', (k: number) => number>> & { chroma?: (k: number) => number[]; phrase?: number } = {}): TrackProfile {
  const arr = (g?: (k: number) => number, d = 1) => Array.from({ length: n }, (_, k) => (g ? g(k) : d))
  const ch = (k: number) => {
    const c = f.chroma ? f.chroma(k) : [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]
    const norm = Math.sqrt(c.reduce((p, q) => p + q * q, 0)) || 1
    return c.map((v) => v / norm)
  }
  return {
    barSec: 2,
    barStart: 0,
    nBars: n,
    bass: arr(f.bass),
    mid: arr(f.mid),
    high: arr(undefined, 0.8),
    perc: arr(f.perc, 0.6),
    vocal: arr(f.vocal, 0),
    vocalSource: 'heuristic',
    energy: arr(undefined, -12),
    chroma: Array.from({ length: n }, (_, k) => ch(k)),
    region: Array.from({ length: n }, (_, k) => (k < 16 ? 'intro' : k >= n - 16 ? 'outro' : 'body')),
    phraseBars: Array.from({ length: Math.ceil(n / (f.phrase ?? 8)) }, (_, i) => i * (f.phrase ?? 8)),
    vocalPhrases: [],
    groove: [0.5, 0.5, 0.5, 0.5, 0.5, 0],
    camelot: arr(undefined, 0).map(() => '8A'),
    durationSec: n * 2,
  }
}

function basePlan(bars: number, outCueSec = 200, inCueSec = 0): TransitionPlan {
  const beats = bars * 4
  const auto = automationFor('long_blend', beats)
  return {
    fromItemId: 'a', toItemId: 'b', style: 'long_blend', outCueSec, inCueSec, overlapBars: bars, tempoRatio: 1, tempoRecoveryBars: 0, beatSec: 0.5, durationSec: beats * 0.5,
    handoffBeat: auto.handoffBeat, out: auto.out, in: auto.in,
    costs: { tempo: 0, key: 0, energy: 0, vocals: 0, confidence: 0, truncation: 0, variety: 0, total: 0 }, risks: [], reasons: [],
  }
}

describe('bar-level profile and overlap compatibility', () => {
  it('places the bass swap where the incoming bassline is present, on a phrase bar', () => {
    const pa = profile(160)
    const pb = profile(160, { bass: (k) => (k >= 12 ? 1 : 0) }) // incoming bass enters at bar 12
    const c = overlapCompat(pa, pb, 120 * 2, 0, 32)
    expect(c.bassSwapBar).toBeGreaterThanOrEqual(12)
    expect(c.bassSwapBar % 4).toBe(0)
  })
  it('finds a vocal handoff when the outgoing vocal ends before the incoming one starts, and flags overlapping vocals', () => {
    const pa = profile(160, { vocal: (k) => (k >= 120 && k < 130 ? 1 : 0) })
    const pb = profile(160, { vocal: (k) => (k >= 20 && k < 30 ? 1 : 0) })
    const c = overlapCompat(pa, pb, 120 * 2, 0, 32)
    expect(c.vocalHandoffBar).not.toBeNull()
    expect(c.vocalHandoffBar!).toBeGreaterThanOrEqual(10)
    expect(c.vocalHandoffBar!).toBeLessThanOrEqual(20)
    const both = overlapCompat(profile(160, { vocal: () => 1 }), profile(160, { vocal: () => 1 }), 240, 0, 32)
    expect(both.vocalHandoffBar).toBeNull()
    expect(both.vocalClash).toBeGreaterThan(0.5)
    expect(both.cost).toBeGreaterThan(c.cost)
  })
  it('detects harmonic clash from chroma', () => {
    const pa = profile(160, { chroma: () => [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0] })
    const ok = overlapCompat(pa, profile(160, { chroma: () => [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0] }), 240, 0, 32)
    const clash = overlapCompat(pa, profile(160, { chroma: () => [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0] }), 240, 0, 32)
    expect(ok.harmonicClash).toBe(0)
    expect(clash.harmonicClash).toBeGreaterThan(0.8)
    expect(clash.melodicLayerOk).toBe(false)
  })
  it('offers several phrase-aligned, region-tagged cues per role', () => {
    const p = profile(160)
    const outs = cueCandidates(p, 'out')
    const ins = cueCandidates(p, 'in')
    expect(outs.length).toBeGreaterThanOrEqual(6)
    expect(ins.length).toBeGreaterThanOrEqual(6)
    expect(outs.every((c) => c.bar % 8 === 0 || p.region[c.bar] !== p.region[c.bar - 1])).toBe(true)
    expect(outs[0].region).toBe('outro')
    expect(ins[0].region).toBe('intro')
  })
})

describe('long-form staged performance', () => {
  const pa = profile(200)
  const pb = profile(200, { bass: (k) => (k >= 8 ? 1 : 0) })
  for (const bars of [16, 32, 48, 64]) {
    it(`${bars} bars: five ordered stages, valid controls, no doubled bass, executable lanes`, () => {
      const p = buildPerformance({ base: basePlan(bars), pa, pb, strategy: 'layered_blend' })
      expect(p.style).toBe('staged_blend')
      expect(validPlan(p)).toBe(true)
      const st = p.performance!.stages
      expect(st.map((s) => s.kind)).toEqual(['introduce', 'layer', 'develop', 'transfer', 'resolve'])
      for (let i = 0; i < st.length; i++) {
        expect(st[i].endBar).toBeGreaterThanOrEqual(st[i].startBar)
        if (i) expect(st[i].startBar).toBe(st[i - 1].endBar)
      }
      expect(st[0].startBar).toBe(0)
      expect(st[4].endBar).toBe(bars)
      const amp = (db: number) => (db <= -40 ? 0 : 10 ** (db / 20))
      const B = bars * 4
      const swap = p.performance!.bassSwapBar * 4
      for (let beat = 0; beat <= B; beat += 0.25) {
        const lo = amp(curveAt(p.out.low, beat)) * curveAt(p.out.gain, beat)
        const li = amp(curveAt(p.in.low, beat)) * curveAt(p.in.gain, beat)
        expect(Math.min(lo, li)).toBeLessThanOrEqual(0.5 + 1e-6) // never two full basslines
        if (beat < swap - 5) expect(li).toBe(0) // incoming bass killed before the handoff
      }
      expect(p.crossfader!.length).toBeGreaterThan(2)
      expect(p.tempo!.length).toBeGreaterThanOrEqual(2)
      expect(p.cues![0]).toMatchObject({ deck: 'in', beat: 0 })
    })
  }
  it('stage timing follows the recordings (not a fixed template)', () => {
    const early = buildPerformance({ base: basePlan(32), pa, pb: profile(200, { bass: (k) => (k >= 8 ? 1 : 0) }), strategy: 'layered_blend' })
    const late = buildPerformance({ base: basePlan(32), pa, pb: profile(200, { bass: (k) => (k >= 24 ? 1 : 0) }), strategy: 'layered_blend' })
    expect(late.performance!.bassSwapBar).toBeGreaterThan(early.performance!.bassSwapBar)
  })
  it('vocal handoff keeps the incoming vocal masked until the outgoing vocal phrase ends', () => {
    const va = profile(200, { vocal: (k) => (k >= 100 && k < 112 ? 1 : 0) })
    const vb = profile(200, { vocal: (k) => (k >= 20 && k < 32 ? 1 : 0), bass: (k) => (k >= 8 ? 1 : 0) })
    const c = overlapCompat(va, vb, 200, 0, 32)
    expect(feasibleStrategies(c, { dropAtEnd: false })).toContain('vocal_handoff')
    const p = buildPerformance({ base: basePlan(32), pa: va, pb: vb, strategy: 'vocal_handoff', compat: c })
    const h = c.vocalHandoffBar! * 4
    expect(curveAt(p.in.mid, h - 6)).toBeLessThan(-10)
    expect(curveAt(p.out.mid, h + 1)).toBeLessThan(-10)
  })
  for (const bars of [16, 32, 48]) {
    it(`${bars}-bar drop lock is executable: the outgoing leaves on the drop and the plan validates`, () => {
      const base = { ...basePlan(bars), incomingDropSec: bars * 4 * 0.5 }
      const p = buildPerformance({ base, pa, pb, strategy: 'drop_lock' })
      expect(p.performance!.bassSwapBar).toBe(bars)
      expect(validPlan(p)).toBe(true)
      const B = bars * 4
      const eff = (beat: number) => curveAt(p.out.gain, beat) * Math.min(1, 1 - curveAt(p.crossfader!, beat, 0))
      expect(eff(B - 2)).toBeGreaterThan(0.5) // still playing a beat before the drop
      expect(eff(B)).toBeLessThanOrEqual(0.05) // gone on the drop
    })
  }
  it('loops the outgoing when it runs out of audio inside the window', () => {
    const shortA = profile(110)
    const p = buildPerformance({ base: basePlan(32, 100 * 2), pa: shortA, pb })
    expect(p.outLoop).toBeDefined()
    expect(validPlan(p)).toBe(true)
  })
})

describe('renderer executes the new lanes', () => {
  const rate = 8000
  const tone = (hz: number, sec: number) => [Float32Array.from({ length: sec * rate }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / rate))]
  const flat = (v: number) => [{ beat: 0, value: v }, { beat: 64, value: v }]
  const plan = (extra: Partial<TransitionPlan>): TransitionPlan => ({
    ...basePlan(16, 10, 0),
    out: { gain: flat(1), low: flat(0), mid: flat(0), high: flat(0) },
    in: { gain: flat(1), low: flat(0), mid: flat(0), high: flat(0) },
    ...extra,
  })
  it('crossfader at +1 silences the outgoing deck (dipless curve)', () => {
    const r = renderTransition({ rate, out: tone(220, 60), in: tone(330, 60), plan: plan({ crossfader: flat(1) }), stems: true, preRollSec: 1, postRollSec: 1 })
    const t0 = r.transitionStartSample
    let ea = 0
    let eb = 0
    for (let i = t0 + rate; i < t0 + 5 * rate; i++) {
      ea += r.stemA![i] ** 2
      eb += r.stemB![i] ** 2
    }
    expect(ea).toBeLessThan(1e-6)
    expect(eb).toBeGreaterThan(1)
  })
  it('gain ramps are interpolated per sample (no 128-sample zipper steps)', () => {
    const dc = [new Float32Array(60 * rate).fill(0.5)]
    const p = plan({ out: { gain: [{ beat: 0, value: 1 }, { beat: 0.5, value: 0 }], low: flat(0), mid: flat(0), high: flat(0) }, in: { gain: flat(0), low: flat(0), mid: flat(0), high: flat(0) } })
    const r = renderTransition({ rate, out: dc, in: dc, plan: p, stems: true, preRollSec: 2, postRollSec: 1 })
    const t0 = r.transitionStartSample
    let maxStep = 0
    // the isolator EQ passes DC through the low band; measure the post-fader deck signal step size during the ramp
    for (let i = t0 + 10; i < t0 + Math.round(0.25 * rate); i++) maxStep = Math.max(maxStep, Math.abs(r.stemA![i] - r.stemA![i - 1]))
    expect(maxStep).toBeLessThan(0.01)
  })
  it('outgoing loop repeats the preceding beats', () => {
    const ramp = [Float32Array.from({ length: 60 * rate }, (_, i) => (i % rate) / rate - 0.5)]
    const p = plan({ outLoop: { startBeat: 8, lengthBeats: 4, endBeat: 24 }, in: { gain: flat(0), low: flat(0), mid: flat(0), high: flat(0) } })
    const r = renderTransition({ rate, out: ramp, in: ramp, plan: p, stems: true, preRollSec: 2, postRollSec: 1 })
    const from = r.transitionStartSample + 8 * 0.5 * rate
    const len = 4 * 0.5 * rate
    // two passes of the loop are identical (away from the seam)
    let diff = 0
    for (let k = 200; k < len - 200; k++) diff = Math.max(diff, Math.abs(r.stemA![from + k] - r.stemA![from + len + k]))
    expect(diff).toBeLessThan(1e-3)
  })
})

describe('closed-loop quality measurement', () => {
  const rate = 16000
  const bars = (n: number) => Math.round(n * 2 * rate)
  function noise(seed: number, n: number, lowpass = false) {
    let s = seed
    const x = new Float32Array(n)
    let lp = 0
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) % 4294967296
      const v = (s / 4294967296 - 0.5) * 0.4
      lp = lp * 0.995 + v * 0.005
      x[i] = lowpass ? lp * 20 : v
    }
    return x
  }
  const ctx = (overlapBars: number) => ({ plan: { ...basePlan(overlapBars), style: 'staged_blend' as const } })
  it('length earns nothing: the same clean handoff scores the same at 16 and 64 bars; doubled bass hard-fails', () => {
    const mk = (ov: number, doubled: boolean) => {
      const n = bars(8 + ov + 8)
      const t0 = bars(8)
      const t1 = t0 + bars(ov)
      const bassA = noise(1, n, true)
      const bassB = noise(2, n, true)
      const stemA = new Float32Array(n)
      const stemB = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const f = Math.min(1, Math.max(0, (i - t0) / (t1 - t0)))
        // clean: A's bass leaves exactly as B's arrives at the midpoint; doubled: both full throughout
        stemA[i] = bassA[i] * (doubled ? (i < t1 ? 1 : 0) : f < 0.5 ? 1 : 0)
        stemB[i] = bassB[i] * (doubled ? (i >= t0 ? 1 : 0) : f >= 0.5 ? 1 : 0)
      }
      const mix = stemA.map((v, i) => v + stemB[i])
      return evaluateTransition({ mix, stemA, stemB, rate, t0, t1, clippedSamples: 0, peak: 0.5, limiterGainReductionDb: 0 }, ctx(ov))
    }
    const c16 = mk(16, false)
    const c64 = mk(64, false)
    const d64 = mk(64, true)
    expect(Math.abs(c16.score - c64.score)).toBeLessThan(0.35)
    expect(d64.hardFail).toBe(true)
    expect(d64.failures.join()).toMatch(/bass doubling/)
    expect(c16.score).toBeLessThan(d64.score)
  }, 60_000)
})

describe('global set planning + closed loop on synthetic recordings', () => {
  const RATE = 22050
  const mk = (bpm: number, seed: number, tonic: number) => {
    const t = synthTrack({ bpm, bars: 96, sampleRate: RATE, offsetSec: 0.25, tonic, mode: 'minor', introBars: 16, outroBars: 16, seed, breakdown: [40, 48] })
    const a = analyzeTrack({ channels: t.channels, sampleRate: RATE })
    return { t, a, s: summarize(a) }
  }
  const tracks = [mk(124, 1, 9), mk(125, 2, 4), mk(124, 3, 11), mk(126, 4, 9)]
  const spec = resolveSpec(MixSpec.parse({ genres: ['tech house'], song_count: 3, target_duration_minutes: 7, transition_style: 'smooth', energy_curve: 'gradual_build' }))
  const set: SetTrack[] = tracks.map((x, i) => ({
    key: `t${i}`, title: `T${i}`, summary: x.s as AnalysisSummary, trimDb: 0, netBeats: undefined, profile: buildProfile(x.a), energy: i / 3, dropStrength: 2, pref: 0, artist: `A${i}`, genres: ['tech house'], gridOk: true,
  }))
  it('plans order and cues jointly: every track enters before it exits, with solo time', () => {
    const res = planSet(set, spec, { count: 3, topN: 3 })
    expect(res.sets.length).toBeGreaterThan(0)
    const best = res.sets[0]
    expect(best.order.length).toBe(3)
    for (let i = 1; i < best.edges.length; i++) {
      const prevIn = best.edges[i - 1].plan
      const entry = prevIn.inCueSec + prevIn.durationSec * prevIn.tempoRatio
      expect(best.edges[i].plan.outCueSec).toBeGreaterThanOrEqual(entry + 8 * set[0].summary.barSec - 0.5)
    }
    expect(narrativeFor(spec, 3).map((x) => x.role)[0]).toBe('opening')
  })
  it('requested techniques are honoured and a short requested length is met', () => {
    const want = resolveSpec(MixSpec.parse({ genres: ['tech house'], song_count: 3, target_duration_minutes: 5, techniques: { prefer: ['drop_swap'], avoid: ['loop_roll'] }, features: ['big_drops'] }))
    const res = planSet(set, want, { count: 3 })
    const best = res.sets[0]
    expect(best.edges.every((e) => !avoided(e.plan, ['loop_roll']))).toBe(true)
    expect(best.edges.some((e) => matchesAny(e.plan, ['drop_swap']))).toBe(true)
    expect(Math.abs(best.durationSec - 300) / 300).toBeLessThanOrEqual(0.1)
  })
  it('measured feedback changes the planner: a penalised edge is replaced', () => {
    const res = planSet(set, spec, { count: 3 })
    const e = res.sets[0].edges[0]
    const measured = new Map([[e.sig, { cost: 50, plan: e.plan }]])
    const again = planSet(set, spec, { count: 3, measured })
    expect(again.sets[0].edges.map((x) => x.sig)).not.toContain(e.sig)
    const pen = new Map([[`${e.plan.fromItemId}|${e.plan.toItemId}`, 50]])
    const reordered = planSet(set, spec, { count: 3, pairPenalty: pen })
    const pairs = reordered.sets[0].edges.map((x) => `${x.plan.fromItemId}|${x.plan.toItemId}`)
    expect(pairs).not.toContain(`${e.plan.fromItemId}|${e.plan.toItemId}`)
    expect(edgeSig('a', 'b', e.plan)).toContain('a|b|')
  })
  it('off-thread preview measurement (worker pool path) picks exactly what the in-page path picks', async () => {
    const mono = new Map(set.map((t, i) => [t.key, monoAt(tracks[i].t.channels, RATE, PREVIEW_RATE)]))
    const opts = { budget: 24, rounds: 2, candidatesPerEdge: 2, strategiesPerCandidate: 2, refinements: 1 }
    const local = await closedLoop(set, spec, { count: 3 }, { audio: async (k) => mono.get(k)! }, opts)
    let calls = 0
    const evaluator: PreviewEvaluator = async (job) => {
      calls++
      // what a worker does: structured copies of everything, render from crops, measure
      const j = structuredClone(job)
      const r = renderPreviewCropped(j.plan, j.a, j.b, j.crops)
      return evaluateTransition(r, { plan: j.plan, pa: j.a.profile, pb: j.b.profile, beatsA: j.a.netBeats, beatsB: j.b.netBeats, stems: j.stems })
    }
    const pooled = await closedLoop(set, spec, { count: 3 }, { audio: async (k) => mono.get(k)! }, { ...opts, evaluator })
    expect(calls).toBeGreaterThan(0)
    expect(pooled.set.order).toEqual(local.set.order)
    expect(pooled.chosen.map((c) => [c.label, c.score])).toEqual(local.chosen.map((c) => [c.label, c.score]))
    expect(pooled.previews).toBe(local.previews)
  }, 60_000)
  it('closed loop renders candidates, rejects/refines, and returns a measured set', async () => {
    const mono = new Map(set.map((t, i) => [t.key, monoAt(tracks[i].t.channels, RATE, PREVIEW_RATE)]))
    const r = await closedLoop(set, spec, { count: 3 }, { audio: async (k) => mono.get(k)! }, { budget: 24, rounds: 2, candidatesPerEdge: 2, strategiesPerCandidate: 2, refinements: 1 })
    expect(r.previews).toBeGreaterThan(0)
    expect(r.previews).toBeLessThanOrEqual(24)
    expect(r.evaluated.length).toBe(r.evaluated.length)
    expect(r.set.order.length).toBe(3)
    expect(r.chosen.some((c) => c.score !== undefined)).toBe(true)
    expect(r.replans.length).toBeGreaterThanOrEqual(1)
  }, 120_000)
  it('every learned model hook produces candidates that are rendered, measured and counted', async () => {
    const mono = new Map(set.map((t, i) => [t.key, monoAt(tracks[i].t.channels, RATE, PREVIEW_RATE)]))
    const r = await closedLoop(set, spec, { count: 3 }, { audio: async (k) => mono.get(k)! }, {
      budget: 40, rounds: 1, candidatesPerEdge: 3, strategiesPerCandidate: 1, refinements: 0,
      propose: () => ({ strategy: 'layered_blend', params: { headroom: 0.7 }, source: 'transitionnet-v2' }),
      tnV1: (p) => ({ ...p, out: { ...p.out, high: [{ beat: 0, value: -3 }, { beat: 4, value: -3 }] }, mlSource: 'transitionnet' }) as TransitionPlan,
      humanPick: (list) => list[list.length - 1] ?? null,
      critic: () => ({ quality: 0.3, artifact: 0.1 }),
    })
    expect(r.modelUse.transitionnetV2.proposals).toBeGreaterThan(0)
    expect(r.modelUse.transitionnetV2.rendered).toBeGreaterThan(0)
    expect(r.modelUse.humanCue.candidates).toBeGreaterThan(0)
    expect(r.modelUse.critic.scored).toBe(r.previews)
    expect(r.evaluated.some((e) => e.source === 'transitionnet-v2')).toBe(true)
  }, 120_000)
})
