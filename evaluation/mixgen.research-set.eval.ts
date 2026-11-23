/**
 * Local research mix from a hand-picked list of ALREADY-DOWNLOADED recordings (no new downloads),
 * produced by the production pipeline with the professional DJ planner (global set planning →
 * long-form staged performances → closed-loop rendering/evaluation/re-planning). The planner chooses
 * the order. Outputs land where the local /research/<job> viewer reads them. Local only — never uploaded.
 *
 *   CP_RESEARCH_YOUTUBE=1 RESEARCH_SET=<json file: {keys, prompt, minutes, genres, style, curve, job}> \
 *   npx vitest run -c vitest.eval.config.ts evaluation/mixgen.research-set.eval.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeIdentity } from '../src/mixgen/identity'
import { runPipeline } from '../src/mixgen/pipeline'
import { MixSpec, resolveSpec } from '../src/mixgen/spec'
import type { TrackCandidate } from '../src/mixgen/types'
import { createEncoder, decodePcm } from '../worker-node/mixgen/ffmpeg'
import { makeAnalyzer } from '../worker-node/mixgen/host'
import { nodeMlRuntime } from '../worker-node/mixgen/ml-runtime'
import { RESEARCH_COMMENT, researchYouTubeEnabled } from '../worker-node/mixgen/research'
import { dir, readIndex } from '../worker-node/mixgen/storage'

const setFile = process.env.RESEARCH_SET
it.skipIf(!setFile)('research mix from cached recordings with the professional DJ planner', async () => {
  expect(researchYouTubeEnabled(), 'Run only on the local research machine (CP_RESEARCH_YOUTUBE=1)').toBe(true)
  const set = JSON.parse(readFileSync(setFile!, 'utf8')) as { job: string; prompt: string; minutes: number; genres: string[]; style: MixSpec['transition_style']; curve: MixSpec['energy_curve']; tracks: Array<{ key: string; artist: string; title: string }> }
  const index = readIndex()
  const pool: TrackCandidate[] = set.tracks.map((t) => {
    const e = index[t.key]
    expect(e, `${t.key} is not in the local cache`).toBeDefined()
    return {
      trackKey: t.key, source: 'youtube', sourceId: t.key.split(':')[1], title: t.title, artist: t.artist,
      genres: set.genres, tags: [], popularity: { source: 'youtube', kind: 'none', value: 0 },
      identity: makeIdentity(t.artist, t.title), versionClues: [], license: { basis: 'cached-research', label: 'Local research cache (not for distribution)' },
      matchedBy: ['hand-picked from the local research cache'], official: false,
    } as TrackCandidate
  })
  const spec = MixSpec.parse({
    prompt: set.prompt, genres: set.genres, song_count: pool.length, target_duration_minutes: set.minutes,
    transition_style: set.style, energy_curve: set.curve, explicit: ['genres', 'song_count', 'target_duration_minutes', 'transition_style', 'energy_curve'],
  })
  const resolved = resolveSpec(spec)
  const mp3Path = join(dir('exports', 'research'), `${set.job}.mp3`)
  const enc = createEncoder(mp3Path, 44100, { mp3Kbps: 320, metadata: { title: `CrowdPilot research mix ${set.job}`, comment: RESEARCH_COMMENT, copyright: 'Research only - not for distribution' } })
  const res = await runPipeline(spec, {
    providers: [],
    previous: { pool },
    policy: { environment: 'local', researchYouTube: true, ytDlpAvailable: true },
    acquire: async (c) => index[c.trackKey],
    decode: (audio) => decodePcm(index[audio.trackKey].path, 44100),
    analyze: makeAnalyzer(process.cwd()),
    sink: { write: (b) => enc.write(b) },
    ml: await nodeMlRuntime(process.cwd()),
    previewBudget: 200,
    log: (m) => process.stderr.write(`  ${m}\n`),
    progress: (e) => process.stderr.write(`${e.stage} ${e.done}/${e.total} ${e.detail ?? ''}\n`),
  }, { title: set.prompt })
  await enc.close()
  if ('planOnly' in res) throw new Error('unexpected plan-only result')
  res.manifest.mode = 'research'
  res.manifest.permissions = { persistRender: false, export: true, reason: 'Local research mode — not for distribution. Stored only on this machine.' }
  writeFileSync(join(dir('renders', 'research'), `${set.job}.manifest.json`), JSON.stringify(res.manifest))
  const pos = new Map(res.order.map((k, i) => [k, i]))
  const songs = pool.map((c) => {
    const e = res.analyses.get(c.trackKey)
    return { trackKey: c.trackKey, artist: c.artist, title: c.title, status: 'cached', usedSource: c.trackKey, selected: pos.has(c.trackKey), position: pos.get(c.trackKey), bpm: e ? Math.round(e.analysis.grid.bpm * 10) / 10 : undefined, key: e?.analysis.key.camelot, attempts: [{ key: c.trackKey, outcome: 'cached', reason: 'already downloaded (local research cache)' }] }
  }).sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
  writeFileSync(join(dir('renders', 'research'), `${set.job}.report.json`), JSON.stringify({ jobId: set.job, mode: 'research', prompt: set.prompt, specSource: 'hand-picked cached set', spec: resolved, durationSec: res.manifest.durationSec, validation: res.validation, songs, unavailable: [], notice: RESEARCH_COMMENT }, null, 1))
  process.stderr.write(`RESEARCH SET ${set.job}: ${(res.manifest.durationSec / 60).toFixed(1)} min, validation ${res.validation.ok ? 'passed' : res.validation.failures.join('; ')}\n`)
  for (const t of res.manifest.transitions) process.stderr.write(`  ${t.index + 1}. ${t.label} ${t.overlapBars} bars\n`)
}, 3_600_000)
