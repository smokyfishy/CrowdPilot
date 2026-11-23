/**
 * End-to-end prompt → mix test on REAL audio (needs network + C:\crowdpilot-data).
 *   npx vitest run -c vitest.eval.config.ts evaluation/mixgen.e2e.eval.ts
 * Env: MIXGEN_PROMPT (default: the spec's test prompt), MIXGEN_JOB (job id), MIXGEN_SPEC_JSON (path to an
 * LLM-interpreted spec; otherwise the deterministic interpreter is used and labelled as such).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { expect, it } from 'vitest'
import { heuristicSpec, parseSpec } from '../src/mixgen/spec'
import { runNodeJob } from '../worker-node/mixgen/host'
import { decodePcm, probe } from '../worker-node/mixgen/ffmpeg'

const PROMPT = process.env.MIXGEN_PROMPT ?? 'Generate a 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines, and smooth transitions.'

it('prompt → discovery → acquisition → analysis → selection → mix → validated audio', async () => {
  const spec = process.env.MIXGEN_SPEC_JSON ? parseSpec(JSON.parse(readFileSync(process.env.MIXGEN_SPEC_JSON, 'utf8'))) : heuristicSpec(PROMPT)
  console.log('spec', JSON.stringify(spec))
  expect(spec.song_count).toBe(12)
  expect(spec.target_duration_minutes).toBe(40)
  const jobId = process.env.MIXGEN_JOB ?? `e2e-${Date.now()}`
  const t0 = Date.now()
  const res = await runNodeJob(spec, {
    jobId,
    prompt: PROMPT,
    repoRoot: process.cwd(),
    allowAudiusSession: process.env.MIXGEN_AUDIUS === '1',
    onProgress: (e) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${e.stage} ${e.done}/${e.total} ${e.detail ?? ''}`),
  })
  const m = res.manifest
  console.log(JSON.stringify({ title: m.title, durationMin: (m.durationSec / 60).toFixed(2), tracks: m.tracks.map((t) => `${t.artist} – ${t.title} [${t.bpm} ${t.camelot}] @${(t.mixInSec / 60).toFixed(2)}`), transitions: m.transitions.map((t) => `${t.label} ${t.overlapBars}b ${t.tempoAdjustPct}% lag=${t.beatAlignment.spliceLagMs}ms r=${t.beatAlignment.spliceCorrelation}`), metrics: m.metrics, validation: m.validation, unavailable: m.unavailable, acquisition: m.acquisition.filter((a) => a.status !== 'acquired') }, null, 1))
  // Output integrity: the exported file decodes and matches the manifest duration.
  const mp3 = `C:/crowdpilot-data/mixgen/exports/${jobId}.mp3`
  expect(existsSync(mp3)).toBe(true)
  const info = await probe(mp3)
  expect(Math.abs(info.durationSec - m.durationSec)).toBeLessThan(0.2)
  expect(statSync(mp3).size).toBeGreaterThan(1_000_000)
  const pcm = await decodePcm(mp3, 44100)
  expect(pcm.channels[0].length / 44100).toBeGreaterThan(m.durationSec - 0.2)
  expect(m.tracks.length).toBe(12)
  expect(m.transitions.filter((t) => t.overlapSec > 0).length).toBeGreaterThanOrEqual(6)
  expect(res.validation.failures).toEqual([])
}, 7_200_000)
