/**
 * TransitionNet v2 held-out verdict: on TEST-split windows (tracks never seen in training), render
 *   rules   the rule solver (first rule-feasible strategy, neutral parameters, planner cue)
 *   v2      the TransitionNet v2 proposal (strategy + parameters, planner cue)
 *   v2cue   the v2 proposal with its proposed incoming cue shift (only where it proposes one)
 *   oracle  the best render found in the synthetic sweep for that window (upper bound)
 * and compare with the closed-loop metrics (what v2 was trained to improve → not independent) and
 * DJCritic as a referee (trained on different synthetic data; also not human taste).
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ml/v2_holdout.eval.ts
 *   → C:/crowdpilot-data/ml/models/transitionnet_v2/holdout.json
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { summarize, type TrackAnalysis } from '../../src/dsp/analyze'
import { beatmatchable } from '../../src/dj/transitions'
import { buildProfile } from '../../src/mixgen/profile'
import { windowCandidates, type SetTrack } from '../../src/mixgen/setplan'
import { buildPerformance, feasibleStrategies, NEUTRAL } from '../../src/mixgen/longform'
import { renderPreview } from '../../src/mixgen/closedloop'
import { evaluateTransition } from '../../src/mixgen/audio-quality'
import { trimFor } from '../../src/mixgen/pipeline'
import { resolveSpec, MixSpec } from '../../src/mixgen/spec'
import { longformFeatures, transitionNetV2Predict } from '../../src/ml/transitionnet-v2'
import type { MlpModel } from '../../src/ml/mlp'
import { criticFromMix } from '../../src/ml/dj-brain'
import { resample, toMono } from '../../src/dsp/resample'
import { nodeMlRuntime } from '../../worker-node/mixgen/ml-runtime'
import { readWav } from '../wav'
import { ML } from './common'

it('TransitionNet v2 held-out rendered comparison', async () => {
  const model = JSON.parse(readFileSync(join(process.cwd(), 'public', 'models', 'ml', 'transitionnet_v2.json'), 'utf8')) as MlpModel
  const tracks = JSON.parse(readFileSync(join(ML, 'cache', 'analysis_full_v2.json'), 'utf8'), (_k, v) => (v && typeof v === 'object' && '__f64' in v ? Float64Array.from(v.__f64) : v)) as Array<{ key: string; split: string; wav: string; analysis: TrackAnalysis }>
  const rows: Array<{ window: string; split: string; score: number; hardFail: boolean }> = []
  for (const f of readdirSync(join(ML, process.env.V2_DIR ?? 'synth_v2')).filter((x) => x.endsWith('.jsonl'))) for (const l of readFileSync(join(ML, process.env.V2_DIR ?? 'synth_v2', f), 'utf8').split('\n')) if (l) rows.push(JSON.parse(l))
  const split = process.env.V2_SPLIT ?? 'test'
  const windows = [...new Set(rows.filter((r) => r.split === split).map((r) => r.window))]
  const oracle = new Map<string, number>()
  for (const r of rows) if (r.split === split) oracle.set(r.window, Math.min(oracle.get(r.window) ?? 1e9, r.score + (r.hardFail ? 100 : 0)))
  const spec = resolveSpec(MixSpec.parse({ genres: ['house'], song_count: 8, target_duration_minutes: 30, transition_style: 'smooth' }))
  const critic = (await nodeMlRuntime(process.cwd())).models.critic!
  const mono = new Map<string, Float32Array>()
  const audio = async (k: string) => {
    if (!mono.has(k)) {
      const t = tracks.find((x) => x.key === k)!
      const w = readWav(t.wav)
      mono.set(k, resample(toMono(w.channels), w.rate, 16000))
      if (mono.size > 8) mono.delete(mono.keys().next().value!)
    }
    return mono.get(k)!
  }
  const st = new Map<string, SetTrack>()
  const track = (k: string): SetTrack => {
    if (!st.has(k)) {
      const t = tracks.find((x) => x.key === k)!
      const s = summarize(t.analysis)
      st.set(k, { key: k, title: k, summary: s, trimDb: trimFor(s.lufs, s.truePeak), netBeats: t.analysis.netBeats, profile: buildProfile(t.analysis), energy: 0.5, dropStrength: 0, pref: 0, artist: k, genres: ['house'], gridOk: beatmatchable(s) })
    }
    return st.get(k)!
  }
  const out: Array<Record<string, unknown>> = []
  for (const w of windows) {
    // window id: '<outgoing key>|<incoming key>|<out cue>|<in cue>|<bars>' (keys are 'jamendo:<id>')
    const [ka, kb, outS, inS, bars] = w.split('|')
    const a = track(ka)
    const b = track(kb)
    const win = windowCandidates(a, b, spec, 5, 4).find((x) => x.plan.outCueSec.toFixed(1) === outS && x.plan.inCueSec.toFixed(1) === inS && String(x.plan.overlapBars) === bars)
    if (!win) continue
    const feas = feasibleStrategies(win.compat, { dropAtEnd: win.plan.incomingDropSec !== undefined })
    const measure = async (plan: ReturnType<typeof buildPerformance>) => {
      const r = await renderPreview(plan, a, b, { audio })
      const q = evaluateTransition(r, { plan, pa: a.profile, pb: b.profile, beatsA: a.netBeats, beatsB: b.netBeats })
      const c = criticFromMix(critic, plan, r.mix, r.rate, r.t0, r.t1)
      return { score: Math.round(q.score * 1000) / 1000, hardFail: q.hardFail, critic: Math.round(c.quality * 10000) / 10000, artifact: Math.round(c.artifact * 1000) / 1000 }
    }
    const rules = await measure(buildPerformance({ base: win.plan, pa: a.profile, pb: b.profile, strategy: feas[0], params: NEUTRAL, compat: win.compat }))
    const p = transitionNetV2Predict(model, longformFeatures(a.summary, b.summary, win.plan, win.compat), feas)
    const v2 = await measure(buildPerformance({ base: win.plan, pa: a.profile, pb: b.profile, strategy: p.strategy, params: p.params, compat: win.compat, source: 'transitionnet-v2' }))
    let v2cue: Awaited<ReturnType<typeof measure>> | undefined
    if (p.cueShift) {
      const inCueSec = win.plan.inCueSec + p.cueShift * b.summary.barSec
      if (inCueSec >= 0 && inCueSec + win.plan.durationSec * win.plan.tempoRatio <= b.summary.durationSec * 0.8) {
        const base = { ...win.plan, inCueSec }
        delete base.incomingDropSec
        v2cue = await measure(buildPerformance({ base, pa: a.profile, pb: b.profile, strategy: p.strategy, params: p.params, source: 'transitionnet-v2' }))
      }
    }
    out.push({ window: w, bars: win.plan.overlapBars, ruleStrategy: feas[0], v2Strategy: p.strategy, cueShift: p.cueShift, rules, v2, v2cue, oracle: oracle.get(w) })
    process.stderr.write(`v2 holdout ${out.length}/${windows.length}: rules ${rules.score}${rules.hardFail ? '!' : ''} v2 ${v2.score}${v2.hardFail ? '!' : ''}${v2cue ? ` v2cue ${v2cue.score}` : ''} oracle ${oracle.get(w)}\n`)
  }
  const rank = (x: { score: number; hardFail: boolean }) => x.score + (x.hardFail ? 100 : 0)
  const mean = (f: (r: Record<string, unknown>) => number) => Math.round((out.reduce((s, r) => s + f(r), 0) / Math.max(1, out.length)) * 1000) / 1000
  type M = { score: number; hardFail: boolean; critic: number; artifact: number }
  const summary = {
    split,
    windows: out.length,
    meanScore: { rules: mean((r) => (r.rules as M).score), v2: mean((r) => (r.v2 as M).score) },
    hardFails: { rules: out.filter((r) => (r.rules as M).hardFail).length, v2: out.filter((r) => (r.v2 as M).hardFail).length },
    v2Wins: out.filter((r) => rank(r.v2 as M) < rank(r.rules as M) - 1e-3).length,
    rulesWins: out.filter((r) => rank(r.rules as M) < rank(r.v2 as M) - 1e-3).length,
    meanCritic: { rules: mean((r) => (r.rules as M).critic), v2: mean((r) => (r.v2 as M).critic) },
    cueHead: { proposed: out.filter((r) => r.v2cue).length, better: out.filter((r) => r.v2cue && rank(r.v2cue as M) < rank(r.v2 as M) - 1e-3).length },
    note: 'Scores are the closed-loop explicit metrics (lower = better) that v2 was trained to improve; DJCritic is a referee trained on different synthetic data. Neither is human preference.',
  }
  const dir = join(ML, 'models', 'transitionnet_v2')
  if (existsSync(dir)) writeFileSync(join(dir, `holdout_${split}.json`), JSON.stringify({ summary, rows: out }, null, 1))
  process.stderr.write(`V2 HOLDOUT ${JSON.stringify(summary)}\n`)
}, 7_200_000)
