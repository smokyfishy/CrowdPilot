/** Local A/B rerender of a research manifest using the same cached recordings and order. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeIdentity } from '../src/mixgen/identity'
import type { MixManifest } from '../src/mixgen/manifest'
import { runPipeline } from '../src/mixgen/pipeline'
import { heuristicSpec } from '../src/mixgen/spec'
import type { TrackCandidate } from '../src/mixgen/types'
import { createEncoder, decodePcm } from '../worker-node/mixgen/ffmpeg'
import { makeAnalyzer } from '../worker-node/mixgen/host'
import { nodeMlRuntime } from '../worker-node/mixgen/ml-runtime'
import { RESEARCH_COMMENT, researchYouTubeEnabled } from '../worker-node/mixgen/research'
import { dir, readIndex } from '../worker-node/mixgen/storage'

const source = process.env.MIXGEN_CACHED_MANIFEST
it.skipIf(!source)('replans and renders the same previously acquired research set', async () => {
  expect(researchYouTubeEnabled(), 'Run only on the local research machine').toBe(true)
  const original = JSON.parse(readFileSync(source!, 'utf8')) as MixManifest
  expect(original.mode).toBe('research')
  const index = readIndex()
  const pool = original.tracks.map((track): TrackCandidate => {
    expect(index[track.key], track.key).toBeDefined()
    return {
      trackKey: track.key, source: track.source, sourceId: track.key.split(':').slice(1).join(':'),
      title: track.title, artist: track.artist, durationSec: track.durationSec, url: track.url,
      genres: original.spec.genres, tags: [], popularity: { source: track.source, kind: 'none', value: 0 },
      identity: makeIdentity(track.artist, track.title), versionClues: [],
      license: { ...track.license, basis: 'cached-research' }, matchedBy: ['prior research mix'], official: false,
    }
  })
  const count = Number(process.env.MIXGEN_CACHED_SONGS ?? pool.length)
  if (!Number.isInteger(count) || count < 2 || count > pool.length) throw new Error('Invalid cached song count')
  pool.length = count
  const order = pool.map((track) => track.trackKey)
  const spec = heuristicSpec(original.title)
  spec.genres = original.spec.genres
  spec.song_count = order.length
  spec.target_duration_minutes = original.spec.targetDurationSec / 60 * count / original.tracks.length
  spec.transition_style = original.spec.transitionStyle
  spec.explicit = ['song_count', 'target_duration_minutes', 'transition_style']
  const id = `research-cached-quality-${Date.now()}`
  const output = join(dir('exports', 'research'), `${id}.mp3`)
  const encoder = createEncoder(output, 44100, { mp3Kbps: 320, metadata: { title: original.title, comment: RESEARCH_COMMENT } })
  const transitionNet = process.env.MIXGEN_TRANSITIONNET === '1'
  console.log('Research mix ID:', id)
  const ml = await nodeMlRuntime(process.cwd(), { transitionNet })
  if (transitionNet) expect(ml.on.transitionNet).toBe(true)
  try {
    const result = await runPipeline(spec, {
      providers: [],
      previous: { pool },
      policy: { environment: 'local', researchYouTube: true, ytDlpAvailable: true },
      acquire: async (candidate) => index[candidate.trackKey],
      decode: (audio) => decodePcm(index[audio.trackKey].path, 44100),
      analyze: makeAnalyzer(process.cwd()),
      sink: { write: (block) => encoder.write(block) },
      ml,
      progress: (event) => process.stderr.write(`${event.stage} ${event.done}/${event.total} ${event.detail ?? ''}\n`),
    }, { fixedOrder: order, include: order, title: transitionNet ? 'Tech House: TransitionNet Listening Test' : `${original.title} (transition quality benchmark)` })
    if ('planOnly' in result) throw new Error('Expected continuous audio')
    result.manifest.mode = 'research'
    writeFileSync(join(dir('renders', 'research'), `${id}.manifest.json`), JSON.stringify(result.manifest))
    console.log(JSON.stringify({
      id, tracks: result.manifest.tracks.length, durationSec: result.manifest.durationSec,
      transitions: result.manifest.transitions.map((t) => ({ style: t.label, startSec: t.mixStartSec })),
      validation: result.validation, ml: ml.trace.counts, learnedTransitions: result.manifest.transitions.filter((t) => t.control?.automation === 'transitionnet').length,
    }))
    expect(result.order).toEqual(order)
    expect(result.render.metrics.clippedSamples).toBe(0)
  } finally {
    await encoder.close()
  }
})
