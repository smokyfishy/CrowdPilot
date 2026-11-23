/**
 * Experiment 4 — synthetic known-control transition dataset (render-and-verify).
 *
 * For track pairs drawn WITHIN each track-level split, the live planner proposes region-level
 * candidates (cue pair × technique). Every candidate is rendered several times with recorded
 * controls:
 *   - `template`: the hand-designed automation (baseline),
 *   - `variant`:  musically constrained control variants (TransitionNet search space: time-warped
 *                 fader/EQ/filter trajectories; echo/roll/brake/scratch/drop-swap parameters),
 *   - `defect`:   the template with 1–2 injected control errors of known severity
 *                 (offset, tempo drift, abrupt gain, bass overload, phrase misalignment,
 *                 degraded stretch, runaway echo, mistimed loop release, incoherent scratch, clipping).
 * For each render we store the exact controls, mix-only DJCritic features, stem-based objective
 * metrics and the objective severity label. Audio: mono, 16 kHz (training only).
 *
 *   ML_STEP=cache  npx vitest run -c vitest.eval.config.ts evaluation/ml/synth.eval.ts
 *   SHARD=i NSHARDS=n npx vitest run -c vitest.eval.config.ts evaluation/ml/synth.eval.ts
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { renderTransition } from '../../src/dj/render'
import { BEATMATCHED, candidateTransitions, DEFAULT_OPTIONS, SLAM, type TransitionPlan, type TransitionStyle } from '../../src/dj/transitions'
import { refineWithLocalBeats } from '../../src/dj/phase'
import { trimDbFor } from '../../src/dj/engine/deck-engine'
import { criticFeatures, featureVector } from '../../src/ml/critic-features'
import { edgeFeatures } from '../../src/ml/edge-features'
import { applyStyleParams, applyTrajectories, DEFAULT_PARAMS, perturbParams, perturbTrajectories, planToTrajectories, rng, TRAJECTORY_STYLES, type ParamVector, type Trajectories } from '../../src/ml/controls'
import { loadAnalysisCache, ML, PcmCache, planTrack, type CachedTrack } from './common'
import { objective, type Defect } from './objective'

const RATE = 16000
const OUT = join(ML, 'synth')

function pickPairs(tracks: CachedTrack[], perTrack: number, seed: number): Array<[CachedTrack, CachedTrack]> {
  const r = rng(seed)
  const pairs: Array<[CachedTrack, CachedTrack]> = []
  for (const a of tracks) {
    const pool = tracks.filter((b) => b.key !== a.key && b.split === a.split)
    const byTempo = [...pool].sort((x, y) => Math.abs(x.summary.bpm - a.summary.bpm) - Math.abs(y.summary.bpm - a.summary.bpm))
    const chosen = new Set<string>()
    for (const b of byTempo.slice(0, Math.ceil(perTrack / 2))) chosen.add(b.key)
    let guard = 0
    while (chosen.size < Math.min(perTrack, pool.length) && guard++ < 100) chosen.add(pool[Math.floor(r() * pool.length)].key)
    for (const k of chosen) pairs.push([a, pool.find((b) => b.key === k)!])
  }
  return pairs
}

function diverseCandidates(all: TransitionPlan[], k: number): TransitionPlan[] {
  const out: TransitionPlan[] = []
  const seen = new Set<TransitionStyle>()
  for (const p of all) if (!seen.has(p.style) && p.style !== 'sequential') { seen.add(p.style); out.push(p) }
  // plus a second cue pair for the best style (cue-ranking data)
  const alt = all.find((p) => p.style === all[0].style && (p.outCueSec !== all[0].outCueSec || p.inCueSec !== all[0].inCueSec))
  return [...out.slice(0, k - (alt ? 1 : 0)), ...(alt ? [alt] : [])]
}

function injectDefects(plan: TransitionPlan, inBeat: number, r: () => number): { plan: TransitionPlan; defects: Defect[]; stretchBad: boolean; clip: boolean } {
  const kinds: Defect['kind'][] = []
  const blend = TRAJECTORY_STYLES.has(plan.style)
  const matched = BEATMATCHED.has(plan.style)
  kinds.push('offset', 'clip')
  if (matched && plan.overlapBars >= 4) kinds.push('tempo', 'phrase')
  if (blend) kinds.push('abrupt', 'bass')
  if (Math.abs(plan.tempoRatio - 1) > 0.005) kinds.push('stretch')
  if (plan.echo) kinds.push('echo')
  if (plan.style === 'loop_roll') kinds.push('loop')
  if (plan.style === 'scratch_cut') kinds.push('scratch')
  const n = r() < 0.65 ? 1 : 2
  const picked = new Set<Defect['kind']>()
  while (picked.size < Math.min(n, kinds.length)) picked.add(kinds[Math.floor(r() * kinds.length)])
  let p: TransitionPlan = { ...plan }
  const defects: Defect[] = []
  let stretchBad = false
  let clip = false
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  for (const k of picked) {
    if (k === 'offset') {
      const ms = [12, 25, 45, 80, 120][Math.floor(r() * 5)] * (r() < 0.5 ? -1 : 1)
      p = { ...p, inCueSec: Math.max(0, p.inCueSec + ms / 1000) }
      defects.push({ kind: k, sev: clamp01((Math.abs(ms) - 8) / 40), detail: ms })
    } else if (k === 'tempo') {
      const e = [0.004, 0.008, 0.015][Math.floor(r() * 3)] * (r() < 0.5 ? -1 : 1)
      p = { ...p, tempoRatio: p.tempoRatio * (1 + e) }
      const driftMs = Math.abs(e) * p.durationSec * 1000 * 0.5
      defects.push({ kind: k, sev: clamp01((driftMs - 10) / 60), detail: e })
    } else if (k === 'abrupt') {
      const h = p.handoffBeat
      const B = p.overlapBars * 4
      p = { ...p, out: { ...p.out, gain: [{ beat: 0, value: 1 }, { beat: h, value: 1 }, { beat: h + 0.01, value: 0 }, { beat: B, value: 0 }] }, in: { ...p.in, gain: [{ beat: 0, value: 0 }, { beat: Math.max(0, h * 0.3), value: 0 }, { beat: Math.max(0.01, h * 0.3 + 0.01), value: 1 }, { beat: B, value: 1 }] } }
      defects.push({ kind: k, sev: 0.5 })
    } else if (k === 'bass') {
      const B = p.overlapBars * 4
      p = { ...p, out: { ...p.out, low: [{ beat: 0, value: 0 }, { beat: B, value: 0 }] }, in: { ...p.in, low: [{ beat: 0, value: 0 }, { beat: B, value: 0 }] } }
      defects.push({ kind: k, sev: 0.55 })
    } else if (k === 'phrase') {
      const beats = r() < 0.5 ? 1 : 2
      p = { ...p, inCueSec: Math.max(0, p.inCueSec + (r() < 0.5 ? -1 : 1) * beats * inBeat) }
      defects.push({ kind: k, sev: 0.35, detail: beats })
    } else if (k === 'stretch') {
      stretchBad = true
      defects.push({ kind: k, sev: 0.4 })
    } else if (k === 'echo') {
      p = { ...p, echo: { ...p.echo!, feedback: 0.93, send: p.echo!.send.map((q) => ({ ...q, value: q.value > 0 ? 1 : 0 })) } }
      defects.push({ kind: k, sev: 0.5 })
    } else if (k === 'loop') {
      p = { ...p, inCueSec: p.inCueSec + 0.5 * inBeat }
      defects.push({ kind: k, sev: 0.6 })
    } else if (k === 'scratch') {
      const op = p.outPerf!.ops[0]
      if (op.kind === 'scratch') p = { ...p, outPerf: { ...p.outPerf!, ops: [{ ...op, atBeat: op.atBeat + 0.37, strokes: 9 }] } }
      defects.push({ kind: k, sev: 0.4 })
    } else if (k === 'clip') {
      clip = true
      defects.push({ kind: k, sev: 0.7 })
    }
  }
  return { plan: p, defects, stretchBad, clip }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

it('synthetic known-control dataset', () => {
  const tracks = loadAnalysisCache()
  if (process.env.ML_STEP === 'cache') {
    console.log(`analysis cache: ${tracks.length} tracks; splits ${JSON.stringify(tracks.reduce((m, t) => ({ ...m, [t.split]: (m[t.split] ?? 0) + 1 }), {} as Record<string, number>))}`)
    return
  }
  const shard = Number(process.env.SHARD ?? 0)
  const nShards = Number(process.env.NSHARDS ?? 1)
  const perTrack = Number(process.env.PER_TRACK ?? 8)
  mkdirSync(OUT, { recursive: true })
  const pairs = pickPairs(tracks, perTrack, 7).filter((_, i) => i % nShards === shard)
  const file = join(OUT, `shard${shard}.jsonl`)
  writeFileSync(file, '')
  const pcm = new PcmCache(RATE, 12)
  const r = rng(1000 + shard)
  let n = 0
  const t0all = Date.now()
  for (const [A, B] of pairs) {
    const pa = planTrack(A, 'a')
    const pb = planTrack(B, 'b')
    const recent = r() < 0.5 ? [] : [(['bass_swap', 'short_fade', 'long_blend', 'echo_out'] as TransitionStyle[])[Math.floor(r() * 4)]]
    const all = candidateTransitions(pa, pb, { ...DEFAULT_OPTIONS, recentStyles: recent })
    if (all[0].style === 'sequential') continue
    const cands = diverseCandidates(all, 6)
    const xa = pcm.get(A)
    const xb = pcm.get(B)
    const inBeat = 60 / Math.max(1, B.summary.bpm)
    const trimA = trimDbFor(A.summary.lufs, A.summary.truePeak)
    const trimB = trimDbFor(B.summary.lufs, B.summary.truePeak)
    cands.forEach((c0, ci) => {
      const c = c0.durationSec >= 4 ? { ...c0, ...refineWithLocalBeats(c0, A.netBeats, B.netBeats) } : c0
      const rank = all.indexOf(c0)
      const edge = edgeFeatures(A.summary, B.summary, c)
      const baseTraj = planToTrajectories(c)
      type V = { kind: 'template' | 'variant' | 'defect'; plan: TransitionPlan; traj: Trajectories | null; params: ParamVector | null; defects: Defect[]; stretchBad: boolean; clip: boolean }
      const vs: V[] = [{ kind: 'template', plan: c, traj: TRAJECTORY_STYLES.has(c.style) ? baseTraj : null, params: SLAM.has(c.style) || c.style === 'drop_swap' ? { ...DEFAULT_PARAMS } : null, defects: [], stretchBad: false, clip: false }]
      if (c.style !== 'cut') {
        for (let k = 0; k < 3; k++) {
          if (TRAJECTORY_STYLES.has(c.style)) {
            const traj = perturbTrajectories(baseTraj, c.style, r)
            vs.push({ kind: 'variant', plan: applyTrajectories(c, traj), traj, params: null, defects: [], stretchBad: false, clip: false })
          } else {
            const params = perturbParams(r)
            vs.push({ kind: 'variant', plan: applyStyleParams(c, params), traj: null, params, defects: [], stretchBad: false, clip: false })
          }
        }
      }
      for (let k = 0; k < 2; k++) {
        const d = injectDefects(c, inBeat, r)
        vs.push({ kind: 'defect', plan: d.plan, traj: null, params: null, defects: d.defects, stretchBad: d.stretchBad, clip: d.clip })
      }
      for (const v of vs) {
        const out = renderTransition({ rate: RATE, out: [xa], in: [xb], plan: v.plan, outTrimDb: trimA, inTrimDb: trimB, preRollSec: 8, postRollSec: 8, stems: true, ...(v.stretchBad ? { stretch: { frame: 2048, tolerance: 0 } } : {}) })
        let mix = out.channels[0]
        if (v.clip) {
          mix = mix.map((s) => Math.max(-1, Math.min(1, s * 2.8)))
        }
        const ts = out.transitionStartSample
        const te = ts + Math.round(v.plan.durationSec * RATE)
        const f = criticFeatures({ mix, rate: RATE, t0: ts, t1: te, beatSec: v.plan.beatSec })
        const obj = objective(out.stemA!, out.stemB!, RATE, ts, te, f, v.defects, BEATMATCHED.has(v.plan.style), SLAM.has(v.plan.style), v.plan.beatSec)
        const rec = {
          pair: `${A.key}>${B.key}`,
          a: A.key,
          b: B.key,
          split: A.split,
          cand: ci,
          rank,
          style: c.style,
          overlapBars: c.overlapBars,
          outCue: r3(c.outCueSec),
          inCue: r3(c.inCueSec),
          ruleCost: r3(c.costs.total),
          kind: v.kind,
          defects: v.defects,
          traj: v.traj ? Object.fromEntries(Object.entries(v.traj).map(([k2, a]) => [k2, a.map(r3)])) : null,
          params: v.params,
          edge: edge.map(r3),
          critic: featureVector(f).map(r3),
          obj: { ...obj, lagMs: Number.isFinite(obj.lagMs) ? r3(obj.lagMs) : null },
          clipped: out.clippedSamples,
        }
        appendFileSync(file, JSON.stringify(rec) + '\n')
        n++
      }
    })
    if (n % 50 < 12) console.log(`[shard ${shard}] ${n} renders, ${((Date.now() - t0all) / 1000).toFixed(0)} s`)
  }
  console.log(`[shard ${shard}] done: ${n} renders from ${pairs.length} pairs in ${((Date.now() - t0all) / 1000).toFixed(0)} s`)
}, 24 * 3_600_000)
