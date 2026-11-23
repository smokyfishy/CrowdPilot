/**
 * Integration tests for the learned-DJ wiring, using the REAL exported checkpoints in
 * public/models/ml (no mocks). Synthetic tracks are used only to drive mechanics.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from '../../src/dsp/analyze'
import { synthTrack } from '../../src/dsp/synth'
import { renderTransition } from '../../src/dj/render'
import { candidateTransitions, DEFAULT_OPTIONS, type PlanTrack } from '../../src/dj/transitions'
import { buildAlternatives, criticSelect, monoAt, pairSeverity, rankCandidatesWith, validPlan, type ScoredPlan } from '../../src/mixgen/ml'
import { planMix, type PlannedTrack } from '../../src/mixgen/mixplan'
import { MixSpec, resolveSpec } from '../../src/mixgen/spec'
import { nodeMlRuntime } from './ml-runtime'

const RATE = 22050
const tracks = [
  { bpm: 124, tonic: 9, seed: 11 },
  { bpm: 125, tonic: 4, seed: 12 },
  { bpm: 126, tonic: 9, seed: 13 },
].map((s) => synthTrack({ ...s, bars: 96, sampleRate: RATE, mode: 'minor', introBars: 16, outroBars: 16, breakdown: [40, 48] }))
const analyses = tracks.map((t) => analyzeTrack({ channels: t.channels, sampleRate: RATE }))
const planned: PlannedTrack[] = analyses.map((a, i) => ({ key: `k${i}`, title: `synth ${i}`, summary: summarize(a), trimDb: 0, netBeats: tracks[i].truth.beatTimes }))
const spec = resolveSpec(MixSpec.parse({ song_count: 3, target_duration_minutes: 7, transition_style: 'smooth' }))
const pt = (s: PlannedTrack): PlanTrack => ({ itemId: s.key, trackKey: s.key, title: s.title, mixable: true, summary: s.summary, durationSec: s.summary.durationSec })

describe('learned-DJ integration (real checkpoints)', () => {
  it('loads the real exported weights and records their provenance', async () => {
    const rt = await nodeMlRuntime(process.cwd(), { transitionNet: true })
    expect(rt.on).toEqual({ mixgraph: true, transitionNet: true, critic: true, ordering: true, transitionNetV2: false })
    const reg = JSON.parse(readFileSync('public/models/ml/registry.json', 'utf8')) as Record<string, { file: string; sha256: string }>
    for (const m of rt.trace.models) {
      const file = readFileSync(`public/models/ml/${reg[m.name].file}`)
      expect(createHash('sha256').update(file).digest('hex')).toBe(m.sha256) // the file the runtime reports is the real checkpoint
      expect(m.loaded).toBe(true)
    }
    expect(rt.models.mixgraph!.quality.alpha).toBe(4) // held-out validated weights
    expect(rt.trace.models.find((m) => m.name === 'mixgraph_human_cue')!.used).toBe(false)
  }, 60_000)

  it('MixGraph + TransitionNet run inside planning and change the executed plan', async () => {
    const ml = await nodeMlRuntime(process.cwd(), { transitionNet: true })
    const rules = planMix(planned, spec)
    const learned = planMix(planned, spec, { rankCandidates: rankCandidatesWith(ml) })
    expect(ml.trace.counts.mixgraph_candidates).toBeGreaterThan(0)
    expect(ml.trace.decisions.filter((d) => d.stage === 'ranking')).toHaveLength(2)
    const tn = learned.transitions.filter((t) => (t.plan as ScoredPlan).mlSource === 'transitionnet')
    expect(tn.length).toBeGreaterThan(0)
    expect(learned.transitions.every((t) => (t.plan as ScoredPlan).mlSeverity !== undefined)).toBe(true)
    // learned automation differs from the rule templates for the same pair
    const sig = (p: typeof rules) => JSON.stringify(p.transitions.map((t) => [t.plan.style, t.plan.outCueSec, t.plan.out.gain.map((x) => Math.round(x.value * 100))]))
    expect(sig(learned)).not.toBe(sig(rules))
    expect(learned.transitions.every((t) => validPlan(t.plan))).toBe(true)
  }, 120_000)

  it('the renderer executes the predicted controls (different audio for different predictions)', async () => {
    const ml = await nodeMlRuntime(process.cwd(), { transitionNet: true })
    const cands = candidateTransitions(pt(planned[0]), pt(planned[1]), DEFAULT_OPTIONS).filter((p) => p.style === 'long_blend')
    const [learned] = rankCandidatesWith(ml)(cands.slice(0, 3), planned[0].summary, planned[1].summary, 0) as ScoredPlan[]
    expect(learned.mlSource).toBe('transitionnet')
    const template = cands.find((p) => p.outCueSec === learned.outCueSec && p.inCueSec === learned.inCueSec && p.overlapBars === learned.overlapBars && p.style === learned.style)!
    const a = renderTransition({ rate: RATE, out: tracks[0].channels, in: tracks[1].channels, plan: learned })
    const b = renderTransition({ rate: RATE, out: tracks[0].channels, in: tracks[1].channels, plan: template })
    let diff = 0
    const t0 = a.transitionStartSample
    for (let i = t0; i < t0 + Math.round(learned.durationSec * RATE); i++) diff += Math.abs(a.channels[0][i] - b.channels[0][i])
    expect(diff / (learned.durationSec * RATE)).toBeGreaterThan(1e-3)
  }, 120_000)

  it('DJCritic scores rendered previews and records the choice', async () => {
    const ml = await nodeMlRuntime(process.cwd(), { transitionNet: true })
    const plan = planMix(planned, spec, { rankCandidates: rankCandidatesWith(ml) })
    const chosen = plan.transitions[0].plan as ScoredPlan
    const alts = buildAlternatives(ml, chosen, planned[0].summary, planned[1].summary, () => true)
    expect(alts.length).toBeGreaterThan(0)
    const pick = criticSelect(ml, chosen, alts, { out: monoAt(tracks[0].channels, RATE), in: monoAt(tracks[1].channels, RATE) }, { out: 0, in: 0 }, '1→2')
    const d = ml.trace.decisions.find((x) => x.stage === 'selection')!
    expect(d).toBeTruthy()
    expect(Object.keys(d.prediction).some((k) => k.endsWith('quality'))).toBe(true)
    expect(pick.outCueSec).toBe(chosen.outCueSec) // timeline unchanged
    expect(pick.durationSec).toBe(chosen.durationSec)
    expect(ml.trace.counts.critic_previews).toBeGreaterThanOrEqual(2)
  }, 120_000)

  it('MixGraph pair severities feed the ordering', async () => {
    const ml = await nodeMlRuntime(process.cwd(), { transitionNet: true })
    const summaries = new Map(planned.map((p) => [p.key, p.summary]))
    const sev = pairSeverity(ml, [...summaries.keys()], summaries, (sa, sb) => candidateTransitions({ ...pt(planned[0]), summary: sa }, { ...pt(planned[1]), summary: sb }, DEFAULT_OPTIONS))
    expect(sev.size).toBe(6)
    for (const v of sev.values()) expect(Number.isFinite(v)).toBe(true)
  }, 120_000)

  it('defaults follow the ablation: MixGraph + DJCritic on, TransitionNet off (logged)', async () => {
    const d = await nodeMlRuntime(process.cwd())
    expect(d.on).toEqual({ mixgraph: true, transitionNet: false, critic: true, ordering: true, transitionNetV2: false })
    expect(d.trace.models.find((m) => m.name === 'transitionnet')).toMatchObject({ loaded: true, used: false })
  })

  it('mode off runs rules only and says so', async () => {
    const off = await nodeMlRuntime(process.cwd(), { mode: 'off' })
    expect(off.on).toEqual({ mixgraph: false, transitionNet: false, critic: false, ordering: false, transitionNetV2: false })
    expect(off.trace.fallbacks.join(' ')).toMatch(/off/)
  })

  it('rejects invalid model outputs before execution', () => {
    const base = candidateTransitions(pt(planned[0]), pt(planned[1]), DEFAULT_OPTIONS)[0]
    expect(validPlan(base)).toBe(true)
    expect(validPlan({ ...base, out: { ...base.out, gain: [{ beat: 0, value: 1 }, { beat: 4, value: 1.7 }] } })).toBe(false)
    expect(validPlan({ ...base, tempoRatio: 1.2 })).toBe(false)
    expect(validPlan({ ...base, in: { ...base.in, gain: [{ beat: 0, value: 0 }, { beat: 4, value: 0.2 }] } })).toBe(false)
  })
})
