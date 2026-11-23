/**
 * Experiments 5 (render verification) and 9 — the learned DJ vs the rule-based DJ on HELD-OUT
 * songs (test-split tracks never used to train any CrowdPilot model), six configurations:
 *
 *   1 original      — the previously deployed rule-based DJ (commit 5859511: DSP grid, old
 *                     planner, shelving EQ); mix-only metrics (its renderer has no stems)
 *   2 rules         — improved deterministic DSP/planner (current production before ML)
 *   3 mg            — MixGraph re-ranking, hand-designed automation
 *   4 tn            — rule choice, TransitionNet controls
 *   5 mg_tn         — MixGraph + TransitionNet
 *   6 mg_tn_critic  — MixGraph top-3 → TransitionNet → rendered previews → DJCritic picks
 *
 * Pairs are played as a set (recent styles carry over, as live). Objective metrics come from the
 * rendered stems (alignment, bass collision, level dips/bumps, gaps → severity sObj), plus
 * control smoothness, technique diversity and inference latency. Severity is an OBJECTIVE
 * technical measure, not a human preference score. Writes a blind before/after listening set
 * (rules vs full learned pipeline) to C:\crowdpilot-data\listening_ml (private).
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ml/pipeline.eval.ts
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyzeTrack, summarize } from '../../src/dsp/analyze'
import { toMono } from '../../src/dsp/resample'
import { encodeWav, renderTransition } from '../../src/dj/render'
import { BEATMATCHED, candidateTransitions, DEFAULT_OPTIONS, SLAM, type TransitionPlan, type TransitionStyle } from '../../src/dj/transitions'
import { refineWithLocalBeats } from '../../src/dj/phase'
import { trimDbFor } from '../../src/dj/engine/deck-engine'
import { planToTrajectories, roughness, TRAJECTORY_STYLES } from '../../src/ml/controls'
import { criticFeatures, featureVector } from '../../src/ml/critic-features'
import { applyTransitionNet, criticScore, loadDjModels, mixgraphRank, transitionNetPredict, type DjModels } from '../../src/ml/dj-brain'
import { gbdtPredict } from '../../src/ml/gbdt'
import { bestTransition as legacyBest, DEFAULT_OPTIONS as LEGACY_OPTS } from '../legacy/transitions'
import { renderTransition as legacyRender } from '../legacy/render'
import { readWav } from '../wav'
import { page } from '../ab-page'
import { loadAnalysisCache, ML, PcmCache, planTrack, ROOT, type CachedTrack } from './common'
import { objective } from './objective'

const RATE = 16000
const CONFIGS = ['original', 'rules', 'mg', 'tn', 'mg_tn', 'mg_tn_critic'] as const
type Config = (typeof CONFIGS)[number]

const fileFetch = (async (url: string) => {
  const p = join('public', 'models', 'ml', url.replace(/^\/models\/ml\//, ''))
  const body = readFileSync(p, 'utf8')
  return { json: async () => JSON.parse(body) } as Response
}) as unknown as typeof fetch

function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

it('learned DJ ablation on held-out songs', async () => {
  const mode = (process.env.ML_MODE as 'experimental' | 'promoted') ?? 'experimental'
  const models: DjModels = await loadDjModels(mode, '/models/ml/', fileFetch)
  const tracks = loadAnalysisCache().filter((t) => t.split === (process.env.EVAL_SPLIT ?? 'test'))
  // set order: tempo-sorted walk + random hops (difficult tempo differences included)
  const r = rng(99)
  const order = [...tracks].sort((a, b) => a.summary.bpm - b.summary.bpm)
  const pairs: Array<[CachedTrack, CachedTrack]> = []
  for (let k = 0; k + 1 < order.length; k++) pairs.push([order[k], order[k + 1]])
  for (let k = 0; k < order.length; k++) {
    const j = Math.floor(r() * order.length)
    if (j !== k) pairs.push([order[k], order[j]])
  }
  const pcm = new PcmCache(RATE, 16)
  const legacySummary = new Map<string, ReturnType<typeof summarize>>()
  const recent: Record<Config, TransitionStyle[]> = Object.fromEntries(CONFIGS.map((c) => [c, []])) as unknown as Record<Config, TransitionStyle[]>
  const rows: Array<Record<string, unknown>> = []
  const lat = { mixgraphMsPerCandidate: [] as number[], transitionNetMs: [] as number[], criticPreviewMs: [] as number[] }
  const listen: Array<{ pid: string; A: CachedTrack; B: CachedTrack; rules: TransitionPlan; learned: TransitionPlan }> = []

  for (const [A, B] of pairs) {
    const pa = planTrack(A, 'a')
    const pb = planTrack(B, 'b')
    const xa = pcm.get(A)
    const xb = pcm.get(B)
    const trims = { out: trimDbFor(A.summary.lufs, A.summary.truePeak), in: trimDbFor(B.summary.lufs, B.summary.truePeak) }
    const refine = (p: TransitionPlan) => (p.durationSec >= 4 ? { ...p, ...refineWithLocalBeats(p, A.netBeats, B.netBeats) } : p)
    const tn = (p: TransitionPlan) => {
      if (!models.transitionNet) return p
      const t0 = performance.now()
      const o = transitionNetPredict(models.transitionNet, A.summary, B.summary, p)
      lat.transitionNetMs.push(performance.now() - t0)
      return applyTransitionNet(p, o)
    }
    const measure = (cfg: Config, plan: TransitionPlan, extra: Record<string, unknown> = {}) => {
      const out = renderTransition({ rate: RATE, out: [xa], in: [xb], plan, outTrimDb: trims.out, inTrimDb: trims.in, preRollSec: 8, postRollSec: 8, stems: true })
      const ts = out.transitionStartSample
      const te = ts + Math.round(plan.durationSec * RATE)
      const f = criticFeatures({ mix: out.channels[0], rate: RATE, t0: ts, t1: te, beatSec: plan.beatSec })
      const obj = objective(out.stemA!, out.stemB!, RATE, ts, te, f, [], BEATMATCHED.has(plan.style), SLAM.has(plan.style), plan.beatSec)
      const cq = models.critic ? gbdtPredict(models.critic.quality, [...featureVector(f), SLAM.has(plan.style) ? 1 : 0, BEATMATCHED.has(plan.style) ? 1 : 0, plan.overlapBars]) : null
      recent[cfg].unshift(plan.style)
      rows.push({
        cfg, a: A.key, b: B.key, style: plan.style, bars: plan.overlapBars, outCue: plan.outCueSec, inCue: plan.inCueSec,
        sObj: obj.sObj, lagMs: Number.isFinite(obj.lagMs) ? obj.lagMs : null, lowCollision: obj.lowCollision, sevLevel: obj.sevLevel, sevSilence: obj.sevSilence,
        dipDb: f.dipDb, bumpDb: f.bumpDb, silenceSec: f.silenceSec, flamExcess: f.flamExcess, criticQuality: cq, clipped: out.clippedSamples,
        roughness: TRAJECTORY_STYLES.has(plan.style) ? roughness(planToTrajectories(plan)) : null, ...extra,
      })
    }
    // 1 original (legacy algorithm on the legacy DSP-only analysis)
    for (const t of [A, B]) {
      if (!legacySummary.has(t.key)) {
        const w = readWav(t.wav)
        legacySummary.set(t.key, summarize(analyzeTrack({ channels: w.channels, sampleRate: w.rate })))
      }
    }
    {
      const la = legacySummary.get(A.key)!
      const lb = legacySummary.get(B.key)!
      const lp = legacyBest({ ...pa, summary: la } as never, { ...pb, summary: lb } as never, LEGACY_OPTS, 0).best
      if (lp.style !== 'sequential') {
        const out = legacyRender({ rate: RATE, out: [xa], in: [xb], plan: lp, outTrimDb: trimDbFor(la.lufs), inTrimDb: trimDbFor(lb.lufs) })
        const ts = out.transitionStartSample
        const te = ts + Math.round(lp.durationSec * RATE)
        const f = criticFeatures({ mix: out.channels[0], rate: RATE, t0: ts, t1: te, beatSec: lp.beatSec })
        const cq = models.critic ? gbdtPredict(models.critic.quality, [...featureVector(f), 0, ['short_fade', 'long_blend', 'bass_swap', 'percussion_led'].includes(lp.style) ? 1 : 0, lp.overlapBars]) : null
        rows.push({ cfg: 'original', a: A.key, b: B.key, style: lp.style, bars: lp.overlapBars, dipDb: f.dipDb, bumpDb: f.bumpDb, silenceSec: f.silenceSec, flamExcess: f.flamExcess, criticQuality: cq, clipped: out.clippedSamples })
      }
    }
    // 2–6
    const cands = (cfg: Config) => candidateTransitions(pa, pb, { ...DEFAULT_OPTIONS, recentStyles: recent[cfg] }).filter((p) => p.style !== 'sequential')
    const c2 = cands('rules')
    if (!c2.length) continue
    const rulesPlan = refine(c2[0])
    measure('rules', rulesPlan)
    const rank = (cfg: Config) => {
      const c = cands(cfg)
      if (!models.mixgraph) return c.map((plan) => ({ plan, score: plan.costs.total }))
      const t0 = performance.now()
      const ranked = mixgraphRank(c, A.summary, B.summary, models.mixgraph)
      lat.mixgraphMsPerCandidate.push((performance.now() - t0) / Math.max(1, c.length))
      return ranked
    }
    measure('mg', refine(rank('mg')[0].plan))
    measure('tn', tn(refine(cands('tn')[0])))
    measure('mg_tn', tn(refine(rank('mg_tn')[0].plan)))
    // 6: bounded candidate evaluation — top-3 MixGraph candidates with distinct (style, cue) → TN → preview → critic
    const top: TransitionPlan[] = []
    for (const x of rank('mg_tn_critic')) {
      if (top.length >= 3) break
      if (!top.some((p) => p.style === x.plan.style && Math.abs(p.outCueSec - x.plan.outCueSec) < 1)) top.push(tn(refine(x.plan)))
    }
    let chosen = top[0]
    let chosenScore: Record<string, unknown> = {}
    if (models.critic && top.length > 1) {
      const scored = top.map((p, i) => {
        const s = criticScore(models.critic!, p, xa, 0, xb, 0, RATE, trims)
        lat.criticPreviewMs.push(s.ms)
        return { p, s, key: s.quality + 0.02 * i + (s.artifact > 0.8 ? 1 : 0) }
      })
      scored.sort((x, y) => x.key - y.key)
      chosen = scored[0].p
      chosenScore = { criticPick: top.indexOf(chosen), previews: scored.length }
    }
    measure('mg_tn_critic', chosen, chosenScore)
    if (listen.length < 12 && A.corpus === 'house_eval' && B.corpus === 'house_eval') listen.push({ pid: `m${String(listen.length).padStart(2, '0')}`, A, B, rules: rulesPlan, learned: chosen })
  }

  // ── summary ──
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN)
  const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))] : NaN)
  const summary: Record<string, unknown> = {}
  for (const cfg of CONFIGS) {
    const rs = rows.filter((x) => x.cfg === cfg)
    const num = (k: string) => rs.map((x) => x[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    const styles: Record<string, number> = {}
    for (const x of rs) styles[String(x.style)] = (styles[String(x.style)] ?? 0) + 1
    summary[cfg] = {
      transitions: rs.length,
      meanSeverity: mean(num('sObj')),
      p90Severity: pct(num('sObj'), 0.9),
      meanAbsLagMs: mean(num('lagMs').map(Math.abs)),
      meanLowCollision: mean(num('lowCollision')),
      meanDipDb: mean(num('dipDb')),
      meanBumpDb: mean(num('bumpDb')),
      gapsOver300ms: rs.filter((x) => (x.silenceSec as number) > 0.3).length,
      clippedRenders: rs.filter((x) => (x.clipped as number) > 0).length,
      meanCriticQuality: mean(num('criticQuality')),
      meanRoughness: mean(num('roughness')),
      distinctStyles: Object.keys(styles).length,
      styles,
    }
  }
  const latency = { mixgraphMsPerCandidate: mean(lat.mixgraphMsPerCandidate), transitionNetMs: mean(lat.transitionNetMs), criticPreviewMsAt16k: mean(lat.criticPreviewMs), criticPreviewP90Ms: pct(lat.criticPreviewMs, 0.9) }
  const outDir = join(ML, 'eval')
  mkdirSync(outDir, { recursive: true })
  const tag = process.env.EVAL_TAG ?? 'ablation'
  writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ mode, active: models.active, split: process.env.EVAL_SPLIT ?? 'test', tracks: tracks.length, pairs: pairs.length, summary, latency, rows }, null, 1))
  console.log(JSON.stringify({ active: models.active, summary, latency }, null, 1))

  // ── blind before/after listening set (full quality: original rate, stereo) ──
  if (process.env.EVAL_LISTEN !== '0') {
    const L = join(ROOT, 'listening_ml')
    mkdirSync(L, { recursive: true })
    const rr = rng(2026)
    const key: Record<string, Record<string, string>> = {}
    const items: Array<{ pair: string; a: string; b: string; title: string }> = []
    const manifest: unknown[] = []
    for (const it2 of listen) {
      const wa = readWav(it2.A.wav)
      const wb = readWav(it2.B.wav)
      const flip = rr() < 0.5
      const files: Record<string, string> = {}
      for (const [label, plan, algo] of [
        ['1', flip ? it2.learned : it2.rules, flip ? 'learned' : 'rules'],
        ['2', flip ? it2.rules : it2.learned, flip ? 'rules' : 'learned'],
      ] as const) {
        const out = renderTransition({ rate: wa.rate, out: wa.channels, in: wb.channels, plan, outTrimDb: trimDbFor(it2.A.summary.lufs, it2.A.summary.truePeak), inTrimDb: trimDbFor(it2.B.summary.lufs, it2.B.summary.truePeak), preRollSec: 10, postRollSec: 10 })
        const wav = encodeWav(out.channels, out.rate)
        const f = `${it2.pid}_version${label}.wav`
        writeFileSync(join(L, f), wav)
        files[label] = f
        ;(key[it2.pid] ??= {})[label] = algo
        manifest.push({ pair: it2.pid, label, file: f, sha256: createHash('sha256').update(wav).digest('hex'), style: plan.style, bars: plan.overlapBars })
      }
      items.push({ pair: it2.pid, a: files['1'], b: files['2'], title: `${it2.A.artist} – ${it2.A.title}  →  ${it2.B.artist} – ${it2.B.title}` })
    }
    writeFileSync(join(L, 'key.json'), JSON.stringify({ note: 'Do not open before rating.', algorithms: { rules: 'deterministic planner + hand templates', learned: 'MixGraph + TransitionNet + DJCritic' }, key }, null, 1))
    writeFileSync(join(L, 'manifest.json'), JSON.stringify(manifest, null, 1))
    writeFileSync(join(L, 'index.html'), page(items, 'cp_ab_ml'))
  }
  void toMono
}, 24 * 3_600_000)
