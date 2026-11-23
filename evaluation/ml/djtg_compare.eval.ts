/**
 * Experiment 3 (part 2): compare DJtransGAN's pretrained output with CrowdPilot's bass swap on the
 * same held-out pairs and 8-bar cue regions, using mix-only measures (DJCritic features + the
 * current DJCritic scores). Also builds a blind listening page (private).
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ml/djtg_compare.eval.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { resample, toMono } from '../../src/dsp/resample'
import { criticFeatures, featureVector } from '../../src/ml/critic-features'
import { gbdtPredict, type GbdtModel } from '../../src/ml/gbdt'
import { readWav } from '../wav'
import { page } from '../ab-page'
import { ML, ROOT } from './common'

it('DJtransGAN vs CrowdPilot (mix-only measures)', () => {
  const dir = join(ML, 'djtg')
  const pairs = JSON.parse(readFileSync(join(dir, 'pairs.json'), 'utf8')) as Array<{ id: string; a: string; b: string; crowdpilot: { t0: number; t1: number; beatSec: number; style: string } }>
  const q = JSON.parse(readFileSync('public/models/ml/critic_quality.json', 'utf8')) as GbdtModel
  const art = JSON.parse(readFileSync('public/models/ml/critic_artifact.json', 'utf8')) as GbdtModel
  const rows: unknown[] = []
  const items: Array<{ pair: string; a: string; b: string; title: string }> = []
  const key: Record<string, Record<string, string>> = {}
  const L = join(ROOT, 'listening_djtg')
  mkdirSync(L, { recursive: true })
  for (const variant of ['minmax', 'least_square']) {
    const resPath = join(dir, `djtransgan_${variant}_results.json`)
    if (!existsSync(resPath)) continue
    const res = JSON.parse(readFileSync(resPath, 'utf8')) as Array<{ id: string; file?: string; t0?: number; t1?: number; error?: string }>
    for (const r of res) {
      const p = pairs.find((x) => x.id === r.id)!
      const score = (wavPath: string, t0: number, t1: number) => {
        const w = readWav(wavPath)
        const mono = resample(toMono(w.channels), w.rate, 16000)
        const f = criticFeatures({ mix: mono, rate: 16000, t0: Math.round(t0 * 16000), t1: Math.round(t1 * 16000), beatSec: p.crowdpilot.beatSec })
        const x = [...featureVector(f), 0, 1, 8]
        return { dipDb: f.dipDb, bumpDb: f.bumpDb, flamExcess: f.flamExcess, lowBumpDb: f.lowBumpDb, silenceSec: f.silenceSec, criticQuality: gbdtPredict(q, x), criticArtifact: gbdtPredict(art, x) }
      }
      const cp = score(join(dir, `${p.id}_crowdpilot.wav`), p.crowdpilot.t0, p.crowdpilot.t1)
      const dg = r.file && r.t0 !== undefined ? score(r.file, r.t0, r.t1!) : null
      rows.push({ id: p.id, variant, crowdpilot: cp, djtransgan: dg, error: r.error })
      if (variant === 'minmax' && dg) {
        const flip = p.id.charCodeAt(2) % 2 === 0
        const fa = `${p.id}_version1.wav`
        const fb = `${p.id}_version2.wav`
        copyFileSync(flip ? r.file! : join(dir, `${p.id}_crowdpilot.wav`), join(L, fa))
        copyFileSync(flip ? join(dir, `${p.id}_crowdpilot.wav`) : r.file!, join(L, fb))
        key[p.id] = { '1': flip ? 'djtransgan' : 'crowdpilot', '2': flip ? 'crowdpilot' : 'djtransgan' }
        items.push({ pair: p.id, a: fa, b: fb, title: `${p.a} → ${p.b} (8-bar region)` })
      }
    }
  }
  const mean = (sel: (x: Record<string, number>) => number, who: 'crowdpilot' | 'djtransgan', variant: string) => {
    const v = (rows as Array<Record<string, unknown>>).filter((x) => x.variant === variant && x[who]).map((x) => sel(x[who] as Record<string, number>))
    return v.reduce((s, y) => s + y, 0) / Math.max(1, v.length)
  }
  const summary: Record<string, unknown> = {}
  for (const variant of ['minmax', 'least_square']) {
    summary[variant] = Object.fromEntries(
      (['dipDb', 'bumpDb', 'flamExcess', 'lowBumpDb', 'silenceSec', 'criticQuality', 'criticArtifact'] as const).map((k) => [k, { crowdpilot: mean((x) => x[k], 'crowdpilot', variant), djtransgan: mean((x) => x[k], 'djtransgan', variant) }]),
    )
  }
  writeFileSync(join(dir, 'compare.json'), JSON.stringify({ summary, rows }, null, 1))
  writeFileSync(join(L, 'key.json'), JSON.stringify({ note: 'Do not open before rating.', key }, null, 1))
  writeFileSync(join(L, 'index.html'), page(items, 'cp_ab_djtg'))
  console.log(JSON.stringify(summary, null, 1))
}, 3_600_000)
