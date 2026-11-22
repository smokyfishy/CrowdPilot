/**
 * Node PipelineHost + job runner for the research/processing worker.
 * Persistent job manifest (jobs/<id>.json) records every stage's real progress, the
 * acquisition table and the final outputs, so an interrupted job can be resumed: acquired
 * audio and analyses are cached by content hash and reused.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { analyzeTrack, ANALYSIS_RATE, ANALYZER_VERSION, type TrackAnalysis } from '../../src/dsp/analyze'
import { runBeatNet, type BeatNetRunner, type MelBank } from '../../src/dsp/beatnet'
import { resample, toMono } from '../../src/dsp/resample'
import { createAudiusDiscovery, createJamendoDiscovery, createYouTubeDiscovery } from '../../src/mixgen/discovery'
import { runPipeline, type PipelineHost, type PipelineResult, type RunOptions } from '../../src/mixgen/pipeline'
import type { TrackCandidate } from '../../src/mixgen/types'
import { unlinkSync } from 'node:fs'
import type { AuthorizationGrant } from '../../src/mixgen/policy'
import type { MixSpec } from '../../src/mixgen/spec'
import { STAGES, type ProgressEvent } from '../../src/mixgen/types'
import { createNodeSources } from './acquire'
import { createEncoder, decodePcm } from './ffmpeg'
import { cleanup, DATA_ROOT, dir, fromJson, storageReport, toJson } from './storage'

let beat: Promise<{ run: BeatNetRunner; bank: MelBank }> | null = null
function beatNet(root: string) {
  beat ??= (async () => {
    const session = await ort.InferenceSession.create(join(root, 'public/models/beat_this_small0.onnx'), { executionProviders: ['cpu'] })
    const bank = JSON.parse(readFileSync(join(root, 'public/models/beat_this_melfb.json'), 'utf8')) as MelBank
    const run: BeatNetRunner = async (spect, frames, mels) => {
      const out = await session.run({ spect: new ort.Tensor('float32', spect, [1, frames, mels]) })
      return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array }
    }
    return { run, bank }
  })()
  return beat
}

export interface JobFile {
  id: string
  prompt?: string
  spec: MixSpec
  status: 'running' | 'done' | 'failed'
  stages: Record<string, { done: number; total: number; detail?: string; at: string }>
  current?: string
  error?: string
  outputs?: { mp3?: string; manifest?: string }
  startedAt: string
  finishedAt?: string
}

export function readGrants(): AuthorizationGrant[] {
  const p = join(DATA_ROOT, 'mixgen', 'grants.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf8')) as AuthorizationGrant[]
}

export function readSecrets(repoRoot: string): { jamendo?: string; youtube?: string } {
  const out: { jamendo?: string; youtube?: string } = { jamendo: process.env.JAMENDO_CLIENT_ID, youtube: process.env.YOUTUBE_API_KEY }
  for (const f of ['.dev.vars', '../CrowdPilot/.dev.vars']) {
    const p = join(repoRoot, f)
    if (!existsSync(p)) continue
    const txt = readFileSync(p, 'utf8')
    out.jamendo ??= /^JAMENDO_CLIENT_ID=(.*)$/m.exec(txt)?.[1]?.replace(/"/g, '').trim()
    out.youtube ??= /^YOUTUBE_API_KEY=(.*)$/m.exec(txt)?.[1]?.replace(/"/g, '').trim()
  }
  return out
}

export interface NodeRunOptions extends RunOptions {
  jobId: string
  prompt?: string
  repoRoot: string
  providers?: Array<'jamendo' | 'audius' | 'youtube'>
  allowAudiusSession?: boolean
  /** Write a WAV master in addition to the MP3 export. */
  wav?: boolean
  /** Output MP3 path (default exports/<jobId>.mp3). */
  mp3Path?: string
  /** Reuse a candidate pool from a previous phase (skips discovery). */
  previousPool?: TrackCandidate[]
  onProgress?: (ev: ProgressEvent) => void
}

export type NodeJobResult = Awaited<ReturnType<typeof runPipeline>>

export async function runNodeJob(spec: MixSpec, o: NodeRunOptions & { planOnly: true }): Promise<Extract<NodeJobResult, { planOnly: true }>>
export async function runNodeJob(spec: MixSpec, o: NodeRunOptions): Promise<PipelineResult>
export async function runNodeJob(spec: MixSpec, o: NodeRunOptions): Promise<NodeJobResult> {
  const jobPath = join(dir('jobs'), `${o.jobId}.json`)
  const logPath = join(dir('logs'), `${o.jobId}.log`)
  const job: JobFile = { id: o.jobId, prompt: o.prompt, spec, status: 'running', stages: {}, startedAt: new Date().toISOString() }
  const save = () => writeFileSync(jobPath, JSON.stringify(job, null, 1))
  const log = (m: string) => appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
  save()
  const secrets = readSecrets(o.repoRoot)
  const policy = { grants: readGrants(), ytDlpAvailable: true, allowAudiusSession: o.allowAudiusSession ?? false }
  const sources = createNodeSources({ jamendoClientId: secrets.jamendo, youtubeApiKey: secrets.youtube, policy })
  const want = new Set(o.providers ?? ['jamendo', 'audius', 'youtube'])
  const providers = [
    want.has('jamendo') ? createJamendoDiscovery(secrets.jamendo) : null,
    want.has('audius') ? createAudiusDiscovery() : null,
    want.has('youtube') ? createYouTubeDiscovery(secrets.youtube) : null,
  ].filter((p): p is NonNullable<typeof p> => !!p)
  const mp3Path = o.mp3Path ?? join(dir('exports'), `${o.jobId}.mp3`)
  const encoders = [createEncoder(mp3Path, 44100, { mp3Kbps: 320, metadata: { title: o.title ?? 'CrowdPilot AI mix', comment: 'Rendered by CrowdPilot (noncommercial research). Track licences in the manifest.' } })]
  if (o.wav) encoders.push(createEncoder(join(dir('renders'), `${o.jobId}.wav`), 44100))
  const host: PipelineHost = {
    providers,
    policy,
    acquire: (c, access) => sources.acquire(c, access),
    async decode(audio) {
      return decodePcm(sources.pathOf(audio), 44100)
    },
    async analyze(audio, pcm) {
      const cachePath = join(dir('analysis'), `${audio.sha256}-${ANALYZER_VERSION}-bt.json`)
      if (existsSync(cachePath)) return fromJson<TrackAnalysis>(readFileSync(cachePath, 'utf8'))
      const mono = resample(toMono(pcm.channels), pcm.rate, ANALYSIS_RATE)
      let net: { beats: number[]; downbeats: number[] } | undefined
      try {
        const bn = await beatNet(o.repoRoot)
        const r = await runBeatNet(mono, bn.bank, bn.run)
        net = { beats: r.beats, downbeats: r.downbeats }
      } catch (e) {
        log(`Beat This! failed for ${audio.trackKey}: ${(e as Error).message} — DSP grid fallback`)
      }
      const a = analyzeTrack({ channels: pcm.channels, sampleRate: pcm.rate, analysisMono: mono, net })
      if (net) a.flags.push('beat model: Beat This! small0 (onnxruntime-node cpu)')
      writeFileSync(cachePath, toJson(a))
      return a
    },
    sink: {
      async write(block) {
        for (const e of encoders) await e.write(block)
      },
    },
    progress(ev) {
      job.stages[ev.stage] = { done: ev.done, total: ev.total, detail: ev.detail, at: new Date().toISOString() }
      job.current = ev.stage
      save()
      o.onProgress?.(ev)
    },
    log,
    concurrency: 3,
    previous: o.previousPool ? { pool: o.previousPool } : undefined,
  }
  try {
    const res = await runPipeline(spec, host, o)
    if ('planOnly' in res) {
      for (const e of encoders) await e.close().catch(() => {})
      try {
        unlinkSync(mp3Path)
      } catch {
        /* nothing written */
      }
      job.status = 'done'
      job.finishedAt = new Date().toISOString()
      save()
      return res
    }
    for (const e of encoders) await e.close()
    const manifestPath = join(dir('renders'), `${o.jobId}.manifest.json`)
    writeFileSync(manifestPath, JSON.stringify(res.manifest))
    job.status = 'done'
    job.outputs = { mp3: mp3Path, manifest: manifestPath }
    job.finishedAt = new Date().toISOString()
    save()
    log(`done: ${JSON.stringify(res.validation.checks.map((c) => [c.name, c.ok, c.value]))}`)
    log(`storage: ${JSON.stringify(storageReport())}`)
    return res
  } catch (e) {
    job.status = 'failed'
    job.error = (e as Error).message
    save()
    log(`FAILED: ${(e as Error).stack}`)
    for (const enc of encoders) await enc.close().catch(() => {})
    throw e
  } finally {
    cleanup({ sessionOnly: true }) // session-only audio (Audius) never outlives the job
  }
}

export { STAGES }
