import { describe, expect, it } from 'vitest'
import type { AnalysisSummary } from '../dsp/analyze'
import { candidateTransitions, DEFAULT_OPTIONS, type PlanTrack, type TransitionPlan } from '../dj/transitions'
import { renderTransition } from '../dj/render'
import { synthTrack } from '../dsp/synth'
import { applyStyleParams, applyTrajectories, constrainTrajectories, CTRL_CHANNELS, CTRL_POINTS, DEFAULT_PARAMS, planToTrajectories, type Trajectories } from './controls'
import { criticFeatures } from './critic-features'
import { applyTransitionNet, criticScore, mixgraphRank, transitionNetPredict } from './dj-brain'
import { gbdtPredict, gbdtRaw, type GbdtModel } from './gbdt'
import { mlpForward, type MlpModel } from './mlp'

function summary(over: Partial<AnalysisSummary> = {}): AnalysisSummary {
  const bpm = over.bpm ?? 124
  const barSec = (60 / bpm) * 4
  const dur = over.durationSec ?? 360
  const phrases: number[] = []
  for (let t = 0; t < dur - barSec; t += barSec * 8) phrases.push(Math.round(t * 1000) / 1000)
  return {
    v: 'test', bpm, bpmConf: 0.9, firstBeat: 0, downbeatPhase: 0, downbeatConf: 0.6, stable: true, key: 'A minor', camelot: '8A', keyConf: 0.6,
    lufs: -9, truePeak: -0.5, durationSec: dur, phrasesSec: phrases, cueIn: [0, barSec * 16], cueOut: phrases.filter((t) => t > dur * 0.7).slice(0, 3),
    introBars: 16, outroBars: 16, barSec, vocalIn: 0.1, vocalOut: 0.1, energyIn: -20, energyOut: -20, energyMean: -14, flags: [], ...over,
  }
}
const track = (id: string, s: Partial<AnalysisSummary> = {}): PlanTrack => ({ itemId: id, trackKey: `audius:${id}`, title: id, mixable: true, summary: summary(s), durationSec: s.durationSec ?? 360 })

// Vite globs (no Node APIs, so the file typechecks under the Workers/Vite tsconfig)
const FIX = import.meta.glob('./__fixtures__/*.json', { eager: true, import: 'default' }) as Record<string, unknown>
const MODELS = import.meta.glob('../../public/models/ml/*.json', { eager: true, import: 'default' }) as Record<string, unknown>
const load = <T>(dir: Record<string, unknown>, f: string): T | null => (Object.entries(dir).find(([k]) => k.endsWith('/' + f))?.[1] as T | undefined) ?? null

describe('controls', () => {
  it('offers drop-aligned landings at both short and long blend lengths', () => {
    const drop = 94
    const styles = ['short_fade', 'long_blend'] as const
    const plans = candidateTransitions(track('a'), track('b', { dropsSec: [drop] }), { ...DEFAULT_OPTIONS, preferDropLandings: true, allowedStyles: [...styles] })
    for (const style of styles) {
      const plan = plans.find((p) => p.style === style && p.reasons.includes('incoming drop lands at the end of the blend'))
      expect(plan, style).toBeDefined()
      expect(plan!.inCueSec + plan!.durationSec * plan!.tempoRatio).toBeCloseTo(drop, 5)
    }
    const uncertain = candidateTransitions(track('a'), track('b', { dropsSec: [drop], downbeatConf: 0.1 }), { ...DEFAULT_OPTIONS, preferDropLandings: true, allowedStyles: [...styles] })
    expect(uncertain.some((p) => p.reasons.includes('incoming drop lands at the end of the blend'))).toBe(false)
  })

  it('round-trips template automation through beat-aligned trajectories', () => {
    for (const p of candidateTransitions(track('a'), track('b'), DEFAULT_OPTIONS).filter((q) => ['bass_swap', 'long_blend', 'short_fade'].includes(q.style)).slice(0, 3)) {
      const t = planToTrajectories(p)
      const back = planToTrajectories(applyTrajectories(p, t))
      for (const c of CTRL_CHANNELS) for (let k = 0; k < CTRL_POINTS; k++) expect(Math.abs(back[c][k] - t[c][k])).toBeLessThan(0.02)
    }
  })

  it('projects arbitrary predictions onto valid, continuous, bounded control states', () => {
    const wild = Object.fromEntries(CTRL_CHANNELS.map((c) => [c, Array.from({ length: CTRL_POINTS }, (_, k) => (k % 2 ? 9 : -9))])) as unknown as Trajectories
    const t = constrainTrajectories(wild)
    for (const c of CTRL_CHANNELS) {
      for (const v of t[c]) expect(v).toBeGreaterThanOrEqual(c.startsWith('filter') ? -1 : 0)
      for (const v of t[c]) expect(v).toBeLessThanOrEqual(1)
    }
    for (const c of ['outGain', 'inGain', 'outLow', 'inLow'] as const) for (let k = 1; k < CTRL_POINTS; k++) expect(Math.abs(t[c][k] - t[c][k - 1])).toBeLessThanOrEqual(0.5 + 1e-9)
    expect(t.outGain[0]).toBe(1)
    expect(t.inGain[CTRL_POINTS - 1]).toBe(1)
    for (let k = 0; k < CTRL_POINTS; k++) expect(t.outGain[k] + t.inGain[k]).toBeLessThanOrEqual(1.8 + 1e-9)
  })

  it('technique parameters change the rendered audio (echo, roll, brake, scratch)', () => {
    const rate = 8000
    const a = synthTrack({ bpm: 124, bars: 21, sampleRate: rate, seed: 1 }).channels
    const b = synthTrack({ bpm: 124, bars: 21, sampleRate: rate, seed: 2 }).channels
    const all = candidateTransitions(track('a', { durationSec: 40 }), track('b', { durationSec: 40 }), DEFAULT_OPTIONS)
    for (const style of ['echo_out', 'loop_roll', 'brake', 'scratch_cut'] as const) {
      const p = all.find((q) => q.style === style)
      if (!p) continue
      const v = { ...DEFAULT_PARAMS, echoFeedback: 0.8, echoDelayBeats: 0.5, rollPattern: 2, rollFilter: 0.2, brakeBeats: 3, brakeAt: 0, scratchStrokes: 9, scratchAt: 0.5 }
      const r0 = renderTransition({ rate, out: a, in: b, plan: p })
      const r1 = renderTransition({ rate, out: a, in: b, plan: applyStyleParams(p, v) })
      let d = 0
      for (let i = 0; i < Math.min(r0.channels[0].length, r1.channels[0].length); i++) d += Math.abs(r0.channels[0][i] - r1.channels[0][i])
      expect(d, style).toBeGreaterThan(1)
    }
  })
})

describe('critic features', () => {
  it('measures level continuity and gaps around the transition', () => {
    const rate = 16000
    const a = synthTrack({ bpm: 124, bars: 31, sampleRate: rate, seed: 3 }).channels
    const p = candidateTransitions(track('a', { durationSec: 60 }), track('b', { durationSec: 60 }), { ...DEFAULT_OPTIONS, allowedStyles: ['short_fade'] })[0]
    const render = (plan: TransitionPlan) => {
      const r = renderTransition({ rate, out: a, in: a, plan })
      return criticFeatures({ mix: r.channels[0], rate, t0: r.transitionStartSample, t1: r.transitionStartSample + Math.round(plan.durationSec * rate), beatSec: plan.beatSec })
    }
    const clean = render(p)
    // a 2.5-beat hole in the middle of the blend (both faders down) must show as a dip and a gap
    const B = p.overlapBars * 4
    const holedPlan = { ...p, out: { ...p.out, gain: [{ beat: 0, value: 1 }, { beat: B / 2 - 2, value: 1 }, { beat: B / 2 - 1.98, value: 0 }, { beat: B, value: 0 }] }, in: { ...p.in, gain: [{ beat: 0, value: 0 }, { beat: B / 2 + 0.5, value: 0 }, { beat: B / 2 + 0.52, value: 1 }, { beat: B, value: 1 }] } }
    const holed = render(holedPlan)
    expect(clean.silenceSec).toBeLessThan(0.2)
    expect(holed.silenceSec).toBeGreaterThan(0.4)
    expect(holed.dipDb).toBeGreaterThan(clean.dipDb)
    const models = { quality: load<GbdtModel>(MODELS, 'critic_quality.json')!, artifact: load<GbdtModel>(MODELS, 'critic_artifact.json')! }
    const score = criticScore(models, holedPlan, a[0], 0, a[0], 0, rate, { out: -4, in: -4 })
    expect(score.previewDefects).toContain('gap of at least 1 second')
  })
})

describe('inference runtimes (parity with the Python training code)', () => {
  for (const name of ['critic_quality', 'critic_artifact', 'mixgraph_quality', 'mixgraph_human_cue']) {
    it(`${name}: TypeScript GBDT matches LightGBM`, () => {
      const m = load<GbdtModel>(MODELS, `${name}.json`)
      const fx = load<{ X: number[][]; y: number[] }>(FIX, `${name}.json`)
      expect(m, name).not.toBeNull()
      expect(fx, name).not.toBeNull()
      expect(m).not.toBeNull()
    expect(fx).not.toBeNull()
    if (!m || !fx) return
      fx.X.forEach((x, i) => {
        const v = name === 'mixgraph_human_cue' ? gbdtRaw(m, x)[0] : gbdtPredict(m, x)
        expect(Math.abs(v - fx.y[i])).toBeLessThan(1e-4)
      })
    })
  }
  it('TransitionNet: TypeScript MLP matches PyTorch', () => {
    const m = load<MlpModel>(MODELS, 'transitionnet.json')
    const fx = load<{ X: number[][]; params: number[][]; echoSub: number[][] }>(FIX, 'transitionnet.json')
    expect(m).not.toBeNull()
    expect(fx).not.toBeNull()
    if (!m || !fx) return
    fx.X.forEach((x, i) => {
      const o = mlpForward(m, x)
      o.params.forEach((v, k) => expect(Math.abs(v - fx.params[i][k])).toBeLessThan(1e-3))
      o.echoSub.forEach((v, k) => expect(Math.abs(v - fx.echoSub[i][k])).toBeLessThan(1e-3))
    })
  })
})

describe('learned decisions reach the planner and the mixer', () => {
  const sa = summary()
  const sb = summary({ bpm: 125, camelot: '9A' })
  const cands = candidateTransitions(track('a'), track('b', { bpm: 125, camelot: '9A' }), DEFAULT_OPTIONS).filter((p) => p.style !== 'sequential')
  // a one-feature model: predicted severity = 1 for one style, 0 for the rest
  const styleModel = (styleIdx: number): GbdtModel & { alpha: number; beta: number } => ({
    kind: 'gbdt', name: 't', version: 't', objective: 'regression', numClass: 1, features: [], alpha: 10, beta: 0,
    trees: [{ f: [39 + styleIdx], t: [0.5], l: [~0], r: [~1], v: [0, 1] }],
  })
  const zero: GbdtModel = { kind: 'gbdt', name: 'h', version: 'h', objective: 'binary', numClass: 1, features: [], trees: [{ f: [], t: [], l: [], r: [], v: [0] }] }

  it('changing the learned score changes the selected transition', () => {
    const ruleBest = cands[0]
    const idx = ['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade', 'drop_swap', 'filter_sweep', 'echo_out', 'loop_roll', 'brake', 'scratch_cut'].indexOf(ruleBest.style)
    const neutral = mixgraphRank(cands, sa, sb, { quality: { ...styleModel(idx), alpha: 0 }, human: zero })
    expect(neutral[0].plan).toBe(ruleBest)
    const penalised = mixgraphRank(cands, sa, sb, { quality: styleModel(idx), human: zero })
    expect(penalised[0].plan.style).not.toBe(ruleBest.style)
  })

  it('TransitionNet output changes the fader/EQ automation the engine receives', () => {
    const m = load<MlpModel & { echoSubs: number[] }>(MODELS, 'transitionnet.json')
    if (!m) return
    const p = cands.find((q) => q.style === 'bass_swap' || q.style === 'long_blend')!
    const q = applyTransitionNet(p, transitionNetPredict(m, sa, sb, p))
    expect(JSON.stringify(q.out.gain)).not.toBe(JSON.stringify(p.out.gain))
    expect(q.reasons.some((x) => x.includes('TransitionNet'))).toBe(true)
  })
})
