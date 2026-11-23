/**
 * Local research-mode mix generation (CP_RESEARCH_YOUTUBE=1, operator's machine only).
 * YouTube discovery → verified acquisition with fallbacks → the standard analysis / selection /
 * transitions / render pipeline → research-marked MP3 + manifest + report under
 * C:\crowdpilot-data\mixgen\{exports,renders}\research\. Nothing is uploaded anywhere.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJamendoDiscovery } from '../../src/mixgen/discovery'
import { artistMatches, sameRecording } from '../../src/mixgen/identity'
import { AcquisitionError, runPipeline, type PipelineHost, type PipelineResult } from '../../src/mixgen/pipeline'
import { decideAccess, type PolicyContext } from '../../src/mixgen/policy'
import { resolveSpec, type MixSpec } from '../../src/mixgen/spec'
import type { AcquiredAudio, ProgressEvent, TrackCandidate } from '../../src/mixgen/types'
import { createNodeSources } from '../mixgen/acquire'
import { createEncoder, decodePcm } from '../mixgen/ffmpeg'
import { makeAnalyzer, readGrants, readSecrets } from '../mixgen/host'
import { RESEARCH_COMMENT, researchYouTubeEnabled } from '../mixgen/research'
import { cleanup, dir } from '../mixgen/storage'
import { discoverResearch } from './discover'
import { loadStems, separate, stemInfo } from '../mixgen/stems'
import type { MlOptions } from '../../src/mixgen/ml'
import { nodeMlRuntime } from '../mixgen/ml-runtime'

export interface Attempt {
  key: string
  uploader?: string
  outcome: 'downloaded' | 'cached' | 'failed'
  reason: string
}

export interface SongReport {
  trackKey: string
  artist: string
  title: string
  status: 'downloaded' | 'cached' | 'unavailable' | 'failed' | 'not attempted'
  usedSource?: string
  selected: boolean
  position?: number
  bpm?: number
  key?: string
  attempts: Attempt[]
}

export interface ResearchResult {
  jobId: string
  mp3Path: string
  manifestPath: string
  reportPath: string
  result: PipelineResult
  songs: SongReport[]
  rejected: Array<{ title: string; uploader?: string; reason: string }>
}

export async function runResearch(spec: MixSpec, o: { jobId: string; repoRoot: string; prompt: string; specSource: string; ml?: Partial<MlOptions>; stems?: boolean; onProgress?: (e: ProgressEvent) => void }): Promise<ResearchResult> {
  if (!researchYouTubeEnabled()) throw new Error('Research mode requires CP_RESEARCH_YOUTUBE=1 (local machine only).')
  const logPath = join(dir('logs'), `${o.jobId}.log`)
  const log = (m: string) => appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
  const secrets = readSecrets(o.repoRoot)
  const policy: PolicyContext = { grants: readGrants(), ytDlpAvailable: true, allowAudiusSession: false, researchYouTube: true, environment: 'local' }
  const sources = createNodeSources({ jamendoClientId: secrets.jamendo, youtubeApiKey: secrets.youtube, policy })
  const jamendo = createJamendoDiscovery(secrets.jamendo)
  const resolved = resolveSpec(spec)
  o.onProgress?.({ stage: 'discovering', done: 0, total: 1, detail: 'YouTube Data API' })
  const disc = await discoverResearch(resolved, secrets.youtube)
  // Genre purity: when enough uploads explicitly claim a requested genre, use only those (plus
  // recordings by requested artists); otherwise keep everything and let scoring decide.
  const evidenced = disc.pool.filter((c) => c.genres.length || resolved.artists.some((ar) => artistMatches(ar, c)))
  if (resolved.genres.length && evidenced.length >= resolved.songCount + 2) {
    for (const c of disc.pool) if (!evidenced.includes(c)) disc.rejected.push({ title: c.rawTitle ?? c.title, uploader: c.uploader, reason: `no ${resolved.genres.join('/')} evidence in title/tags/channel` })
    disc.pool = evidenced
  }
  for (const e of disc.apiErrors) log(`search problem: ${e}`)
  log(`discovery: ${disc.queries} queries → ${disc.pool.length} recordings, ${disc.rejected.length} uploads rejected`)
  o.onProgress?.({ stage: 'discovering', done: disc.queries, total: disc.queries, detail: `${disc.pool.length} verified recordings (${disc.rejected.length} uploads rejected)${disc.apiErrors.length ? `; search problems: ${disc.apiErrors.slice(0, 2).join(' | ')}` : ''}` })

  const jobStart = Date.now()
  const attempts = new Map<string, Attempt[]>()
  const note = (k: string, a: Attempt) => attempts.set(k, [...(attempts.get(k) ?? []), a])
  const tryOne = async (owner: TrackCandidate, c: TrackCandidate): Promise<AcquiredAudio | null> => {
    const access = decideAccess(c, policy)
    if (!access.acquire) {
      note(owner.trackKey, { key: c.trackKey, uploader: c.uploader, outcome: 'failed', reason: access.reason })
      return null
    }
    try {
      const a = await sources.acquire(c, access)
      const cached = Date.parse(a.acquiredAt) < jobStart
      note(owner.trackKey, { key: c.trackKey, uploader: c.uploader, outcome: cached ? 'cached' : 'downloaded', reason: `${a.container}/${a.codec ?? '?'} ${a.sampleRate ?? '?'} Hz, ${(a.bytes / 1e6).toFixed(1)} MB` })
      return { ...a, trackKey: owner.trackKey, sourceKey: c.trackKey }
    } catch (e) {
      note(owner.trackKey, { key: c.trackKey, uploader: c.uploader, outcome: 'failed', reason: (e as Error).message.slice(0, 200) })
      return null
    }
  }

  const host: PipelineHost = {
    providers: [],
    policy,
    previous: { pool: disc.pool },
    concurrency: 2, // yt-dlp itself is serialized with a gap between downloads
    previewBudget: Number(process.env.MIXGEN_PREVIEW_BUDGET ?? 200),
    async acquire(c) {
      // 1) best verified upload, 2) other verified uploads of the same recording, 3) Jamendo same recording
      for (const cand of [c, ...(disc.alternates.get(c.trackKey) ?? [])]) {
        const a = await tryOne(c, cand)
        if (a) return a
      }
      const jam = (await jamendo.searchTracks({ text: `${c.artist} ${c.title}`.slice(0, 100), limit: 10, why: 'fallback' })).find((j) => sameRecording(c, j).same)
      if (jam) {
        const a = await tryOne(c, jam)
        if (a) return a
      } else note(c.trackKey, { key: 'jamendo', outcome: 'failed', reason: 'same recording not found on Jamendo' })
      const tried = attempts.get(c.trackKey) ?? []
      const permitted = tried.some((t) => /not_permitted|restricted|sign-in|members|age/i.test(t.reason))
      throw new AcquisitionError(`all ${tried.length} sources failed: ${tried.map((t) => `${t.key}: ${t.reason}`).join(' | ').slice(0, 600)}`, permitted ? 'not_permitted' : 'unavailable')
    },
    decode: (audio) => decodePcm(sources.pathOf(audio), 44100), // looked up by content handle
    analyze: makeAnalyzer(o.repoRoot, log),
    sink: { write: async () => {} },
    progress: (e) => o.onProgress?.(e),
    log,
    ml: await nodeMlRuntime(o.repoRoot, o.ml),
    // Stem separation (Demucs, ~0.6× real time on CPU): default on for short sets.
    stems: (o.stems ?? resolved.songCount <= 8)
      ? async (audio, analysis) => {
          const files = await separate(sources.pathOf(audio), audio.sha256)
          const st = await loadStems(files)
          const mix = await decodePcm(sources.pathOf(audio), 44100)
          return { info: stemInfo(st.vocals, 44100, analysis, { stems: st, mix: mix.channels }), load: () => loadStems(files) }
        }
      : undefined,
  }
  const mp3Path = join(dir('exports', 'research'), `${o.jobId}.mp3`)
  const enc = createEncoder(mp3Path, 44100, { mp3Kbps: 320, metadata: { title: `CrowdPilot research mix ${o.jobId}`, comment: RESEARCH_COMMENT, copyright: 'Research only - not for distribution' } })
  host.sink = { write: (b) => enc.write(b) }
  let res
  try {
    res = await runPipeline(spec, host, { title: resolved.title })
    if ('planOnly' in res) throw new Error('unexpected plan-only result')
    await enc.close()
  } catch (e) {
    await enc.close().catch(() => {})
    throw e
  } finally {
    cleanup({ sessionOnly: true })
  }
  res.manifest.mode = 'research'
  res.manifest.permissions = { persistRender: false, export: true, reason: 'Local research mode — not for distribution. Stored only on this machine.' }
  const manifestPath = join(dir('renders', 'research'), `${o.jobId}.manifest.json`)
  writeFileSync(manifestPath, JSON.stringify(res.manifest))
  const pos = new Map(res.order.map((k, i) => [k, i]))
  const songs: SongReport[] = disc.pool
    .filter((c) => attempts.has(c.trackKey) || pos.has(c.trackKey))
    .map((c) => {
      const tried = attempts.get(c.trackKey) ?? []
      const ok = tried.find((t) => t.outcome === 'downloaded' || t.outcome === 'cached')
      const row = res.acquisition.find((a) => a.trackKey === c.trackKey)
      const e = res.analyses.get(c.trackKey)
      return {
        trackKey: c.trackKey,
        artist: c.artist,
        title: c.title,
        status: ok ? (ok.outcome === 'cached' ? 'cached' : 'downloaded') : row ? (row.status === 'not_permitted' ? 'unavailable' : (row.status as SongReport['status'])) : 'not attempted',
        usedSource: ok?.key,
        selected: pos.has(c.trackKey),
        position: pos.get(c.trackKey),
        bpm: e ? Math.round(e.analysis.grid.bpm * 10) / 10 : undefined,
        key: e?.analysis.key.camelot,
        attempts: tried,
      }
    })
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
  const reportPath = join(dir('renders', 'research'), `${o.jobId}.report.json`)
  writeFileSync(
    reportPath,
    JSON.stringify(
      { jobId: o.jobId, mode: 'research', prompt: o.prompt, specSource: o.specSource, searchProblems: disc.apiErrors, spec: resolved, durationSec: res.manifest.durationSec, validation: res.validation, songs, rejectedUploads: disc.rejected.slice(0, 200), unavailable: res.unavailable, notice: RESEARCH_COMMENT },
      null,
      1,
    ),
  )
  return { jobId: o.jobId, mp3Path, manifestPath, reportPath, result: res, songs, rejected: disc.rejected }
}
