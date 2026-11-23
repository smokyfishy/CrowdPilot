/** Re-plan a finished job's tracks from cached analyses (fast check of planner changes). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { ANALYZER_VERSION, summarize, type TrackAnalysis } from '../src/dsp/analyze'
import { planMix } from '../src/mixgen/mixplan'
import { trimFor } from '../src/mixgen/pipeline'
import type { MixManifest } from '../src/mixgen/manifest'
import { fromJson, MIXGEN_ROOT, readIndex } from '../worker-node/mixgen/storage'

it('replan', () => {
  const m = JSON.parse(readFileSync(process.env.MIXGEN_MANIFEST ?? join(MIXGEN_ROOT, 'renders', `${process.env.MIXGEN_JOB ?? 'e2e-3'}.manifest.json`), 'utf8')) as MixManifest
  const idx = readIndex()
  const tracks = m.tracks.filter((t) => t.durationSec < 540 && idx[t.key]).map((t) => {
    const a = fromJson<TrackAnalysis>(readFileSync(join(MIXGEN_ROOT, 'analysis', `${idx[t.key].sha256}-${ANALYZER_VERSION}-bt.json`), 'utf8'))
    return { key: t.key, title: t.title, summary: summarize(a), trimDb: trimFor(a.loudness.integratedLufs, a.loudness.truePeakDbtp) }
  })
  const t0 = performance.now()
  const p = planMix(tracks, { ...m.spec, targetDurationSec: Number(process.env.MIXGEN_TARGET ?? m.spec.targetDurationSec) })
  process.stderr.write(['REPLAN', tracks.length, 'tracks; full', Math.round(tracks.reduce((s, t) => s + t.summary.durationSec, 0) / 60), 'min; planned', (p.durationSec / 60).toFixed(2), 'target', (p.targetDurationSec / 60).toFixed(2), 'ms', Math.round(performance.now() - t0), p.transitions.map((t) => t.plan.style).join(','), p.notes.join(' ')].join(' ') + String.fromCharCode(10))
})
