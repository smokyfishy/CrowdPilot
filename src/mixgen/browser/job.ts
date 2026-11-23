/**
 * Browser mix job: drives the environment-neutral pipeline in the signed-in user's
 * browser (the deployed processing worker). Discovery and policy run on the server;
 * audio is fetched through the server's policy-checked pass-through, decoded to PCM
 * (48 kHz), analyzed in the existing Beat This! analysis worker, rendered and encoded in
 * the render worker, then stored in the user's PRIVATE file storage. Progress is written
 * to the persistent `mixes` record after every real unit of work.
 *
 * Audio bytes are never persisted in the browser (provider terms); derived analyses are
 * cached in IndexedDB by content hash so regeneration skips re-analysis.
 */
import { ANALYZER_VERSION, type TrackAnalysis } from '../../dsp/analyze'
import type { WorkerRequest, WorkerResponse } from '../../dj/engine/analysis.worker'
import { decideAccess, mixPermissions } from '../policy'
import { AcquisitionError, runPipeline, type AnalyzedEntry, type PipelineHost } from '../pipeline'
import type { MixManifest } from '../manifest'
import type { MixSpec } from '../spec'
import type { AcquiredAudio, ProgressEvent, Stage, TrackCandidate } from '../types'
import type { RenderWorkerIn, RenderWorkerOut } from './render.worker'
import type { RenderResult } from '../mix-render'
import { createMlRuntime, type MlOptions, type MlRuntime } from '../ml'
import { loadDjModels, type Registry } from '../../ml/dj-brain'

export const RATE = 48000

export interface JobApi {
  authHeaders(): Promise<Record<string, string>>
  upload(blob: Blob, key: string, onProgress?: (sent: number, total: number) => void): Promise<{ key: string; url?: string }>
}

export interface SelectionRow {
  trackKey: string
  title: string
  artist: string
  source: string
  status: string
  reason: string
  bpm?: number
  camelot?: string
  durationSec?: number
  selected: boolean
  position?: number
  url?: string
  license?: string
  /** Album artwork from the provider, when it has one. */
  artwork?: string
}

export interface PreparedMix {
  pool: TrackCandidate[]
  analyses: Map<string, AnalyzedEntry>
  order: string[]
  selection: SelectionRow[]
  unavailable: Array<{ request: string; kind: string; reason: string }>
  durationSec: number
  notes: string[]
}

const DEPLOYED_POLICY = { grants: [], ytDlpAvailable: false, allowAudiusSession: false }

// ───────────── IndexedDB analysis cache (derived data only) ─────────────
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('crowdpilot-mixgen', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('analysis')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
async function cacheGet(key: string): Promise<TrackAnalysis | undefined> {
  try {
    const db = await idb()
    return await new Promise((resolve) => {
      const q = db.transaction('analysis').objectStore('analysis').get(key)
      q.onsuccess = () => resolve(q.result as TrackAnalysis | undefined)
      q.onerror = () => resolve(undefined)
    })
  } catch {
    return undefined
  }
}
async function cachePut(key: string, a: TrackAnalysis): Promise<void> {
  try {
    const db = await idb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction('analysis', 'readwrite')
      tx.objectStore('analysis').put(a, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* cache is best effort */
  }
}

function sniff(b: Uint8Array): string | null {
  const s = String.fromCharCode(...b.slice(0, 4))
  if (s === 'fLaC') return 'flac'
  if (s === 'OggS') return 'ogg'
  if (s === 'RIFF') return 'wav'
  if (String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return 'mp4'
  if (s.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3'
  return null
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export class BrowserMixJob {
  /** Pool of analysis workers (each runs its own Beat This! session; WASM is single-threaded without isolation). */
  private analysisWorkers: Worker[] = []
  private busy: number[] = []
  private reqId = 0
  private readonly pendingAnalysis = new Map<number, (r: WorkerResponse) => void>()
  private readonly bytes = new Map<string, ArrayBuffer>()
  private progressTimer: ReturnType<typeof setTimeout> | null = null
  private progressBuf: Record<string, { done: number; total: number; detail?: string; at: number }> = {}
  private lastStage: Stage = 'understanding'
  aborted = false

  constructor(
    readonly mixId: string,
    readonly api: JobApi,
    readonly onProgress: (ev: ProgressEvent) => void,
    readonly quality: 'high' | 'lossless' = 'high',
  ) {}

  private async headers(): Promise<Record<string, string>> {
    return { ...(await this.api.authHeaders()), 'Content-Type': 'application/json' }
  }

  async patch(p: Record<string, unknown>): Promise<void> {
    const res = await fetch(`/api/mixgen/mixes/${this.mixId}`, { method: 'POST', headers: await this.headers(), body: JSON.stringify(p) })
    if (!res.ok) throw new Error(`Saving progress failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }

  private progress(ev: ProgressEvent): void {
    this.onProgress(ev)
    this.lastStage = ev.stage
    this.progressBuf[ev.stage] = { done: ev.done, total: ev.total, detail: ev.detail?.slice(0, 300), at: Date.now() }
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      const progress = this.progressBuf
      this.progressBuf = {}
      void this.patch({ stage: this.lastStage, progress }).catch(() => undefined)
    }, 1500)
  }

  private analysis(): { w: Worker; release: () => void } {
    const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))
    if (!this.analysisWorkers.length) {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('../../dj/engine/analysis.worker.ts', import.meta.url), { type: 'module' })
        w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const cb = this.pendingAnalysis.get(ev.data.id)
          this.pendingAnalysis.delete(ev.data.id)
          cb?.(ev.data)
        }
        this.analysisWorkers.push(w)
        this.busy.push(0)
      }
    }
    let k = 0
    for (let i = 1; i < this.busy.length; i++) if (this.busy[i] < this.busy[k]) k = i
    this.busy[k]++
    return { w: this.analysisWorkers[k], release: () => void (this.busy[k] = Math.max(0, this.busy[k] - 1)) }
  }

  /** `known`: the recording was already acquired once in this job, so a 404/5xx is treated as transient. */
  private async fetchAudio(c: { trackKey: string }, known = false): Promise<ArrayBuffer> {
    let last: AcquisitionError | null = null
    for (let attempt = 0; attempt < (known ? 4 : 2); attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt))
      let res: Response
      try {
        res = await fetch(`/api/mixgen/audio/${encodeURIComponent(c.trackKey)}?quality=${this.quality}`, { headers: await this.api.authHeaders() })
      } catch {
        last = new AcquisitionError('audio request failed (network)', 'network')
        continue
      }
      if (res.status === 403) throw new AcquisitionError(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? 'not permitted', 'not_permitted')
      if (res.ok) return res.arrayBuffer()
      await res.body?.cancel().catch(() => undefined)
      last = res.status === 404 ? new AcquisitionError('recording unavailable', 'unavailable') : new AcquisitionError(`audio request failed (${res.status})`, 'network')
      if (res.status === 404 && !known) break
    }
    throw last ?? new AcquisitionError('audio request failed', 'network')
  }

  private mlRuntime: Promise<MlRuntime> | null = null
  private lastMl: MlRuntime | null = null
  private orderingDecisions: { decisions: MlRuntime['trace']['decisions']; counts: Record<string, number>; timings: Record<string, number> } = { decisions: [], counts: {}, timings: {} }
  /** Learned-DJ options for this job (default: every model with weights). */
  mlOptions: Partial<MlOptions> = {}
  private ml(): Promise<MlRuntime> {
    this.mlRuntime ??= createMlRuntime(
      (mode) => loadDjModels(mode, '/models/ml/'),
      async () => (await (await fetch('/models/ml/registry.json')).json()) as Registry,
      this.mlOptions,
    )
    return this.mlRuntime
  }

  private async host(pool: TrackCandidate[], analyses?: Map<string, AnalyzedEntry>): Promise<PipelineHost> {
    const job = this
    const base = await this.ml()
    // A fresh trace per pipeline run (prepare and render each record their own decisions).
    // The render pass keeps the user-approved order, so the ordering decision made during the
    // prepare pass is carried over into the final trace.
    const carried = this.orderingDecisions
    const ml: MlRuntime = { ...base, trace: { ...base.trace, decisions: [...carried.decisions], counts: { ...carried.counts }, timingsMs: { load: base.trace.timingsMs.load ?? 0, ...carried.timings }, fallbacks: [...base.trace.fallbacks] } }
    this.lastMl = ml
    return {
      ml,
      providers: [],
      policy: DEPLOYED_POLICY,
      previous: { pool, analyses },
      concurrency: 3,
      async acquire(c, access): Promise<AcquiredAudio> {
        if (!access.acquire) throw new AcquisitionError(access.reason, 'not_permitted')
        const buf = await job.fetchAudio(c)
        const head = new Uint8Array(buf, 0, Math.min(16, buf.byteLength))
        const container = sniff(head)
        if (!container || buf.byteLength < 200_000) throw new AcquisitionError('downloaded bytes are not valid audio', 'invalid_audio')
        const sha = await sha256(buf)
        const handle = `mem:${c.trackKey}`
        job.bytes.set(handle, buf)
        return { trackKey: c.trackKey, sha256: sha, bytes: buf.byteLength, container, method: access.method, acquiredAt: new Date().toISOString(), handle }
      },
      async decode(audio) {
        let buf = job.bytes.get(audio.handle)
        job.bytes.delete(audio.handle) // never keep encoded audio around
        if (!buf) {
          buf = await job.fetchAudio(audio, true)
          const sha = await sha256(buf)
          if (sha !== audio.sha256) throw new Error(`audio for ${audio.trackKey} changed since analysis (hash mismatch)`)
        }
        const ctx = new OfflineAudioContext(2, 1, RATE)
        let ab: AudioBuffer
        try {
          ab = await ctx.decodeAudioData(buf)
        } catch {
          throw new AcquisitionError('audio could not be decoded', 'invalid_audio')
        }
        const ch = [ab.getChannelData(0).slice(), (ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)).slice()]
        return { channels: ch, rate: ab.sampleRate }
      },
      async analyze(audio, pcm) {
        const ck = `${audio.sha256}:${ANALYZER_VERSION}:${RATE}`
        const hit = await cacheGet(ck)
        if (hit) return hit
        // 22.05 kHz mono analysis copy (Beat This! model rate) via native resampling.
        const len = Math.ceil((pcm.channels[0].length / pcm.rate) * 22050)
        const off = new OfflineAudioContext(1, len, 22050)
        const b = off.createBuffer(2, pcm.channels[0].length, pcm.rate)
        b.copyToChannel(pcm.channels[0] as Float32Array<ArrayBuffer>, 0)
        b.copyToChannel(pcm.channels[1] as Float32Array<ArrayBuffer>, 1)
        const src = off.createBufferSource()
        src.buffer = b
        src.connect(off.destination)
        src.start()
        const mono = (await off.startRendering()).getChannelData(0).slice()
        const channels = pcm.channels.map((c) => c.slice())
        const id = ++job.reqId
        const slot = job.analysis()
        const res = await new Promise<WorkerResponse>((resolve) => {
          job.pendingAnalysis.set(id, resolve)
          const msg: WorkerRequest = { type: 'analyze', id, channels, sampleRate: pcm.rate, analysisMono: mono }
          slot.w.postMessage(msg, [...channels.map((c) => c.buffer), mono.buffer])
        }).finally(slot.release)
        if (res.type !== 'analysis' || !res.analysis) throw new Error(`analysis failed: ${'error' in res ? res.error : 'unknown'}`)
        await cachePut(ck, res.analysis)
        return res.analysis
      },
      sink: { write() {} },
      render: (plan, load, onProgress) => job.renderInWorker(plan, load, onProgress),
      progress: (ev) => job.progress(ev),
    }
  }

  private renderBlob: { blob: Blob; mime: string } | null = null

  private renderInWorker(plan: Parameters<NonNullable<PipelineHost['render']>>[0], load: (key: string) => Promise<{ channels: Float32Array[]; rate: number }>, onProgress: (d: number, t: number, detail: string) => void): Promise<RenderResult> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = async (ev: MessageEvent<RenderWorkerOut>) => {
        const m = ev.data
        if (m.type === 'load') {
          try {
            const pcm = await load(m.key)
            const reply: RenderWorkerIn = { type: 'pcm', id: m.id, channels: pcm.channels, rate: pcm.rate }
            w.postMessage(reply, pcm.channels.map((c) => c.buffer))
          } catch (e) {
            w.postMessage({ type: 'pcm', id: m.id, error: (e as Error).message } satisfies RenderWorkerIn)
          }
        } else if (m.type === 'progress') onProgress(m.done, m.total, m.detail)
        else if (m.type === 'done') {
          this.renderBlob = { blob: m.blob, mime: m.mime }
          w.terminate()
          resolve(m.result)
        } else if (m.type === 'error') {
          w.terminate()
          reject(new Error(m.message))
        }
      }
      w.onerror = (e) => {
        w.terminate()
        reject(new Error(e.message || 'render worker crashed'))
      }
      w.postMessage({ type: 'render', plan } satisfies RenderWorkerIn)
    })
  }

  /** Step 1–8 (review): discover → acquire → analyze → select → order → plan. */
  async prepare(spec: MixSpec, opts: { exclude?: string[]; include?: string[]; pool?: TrackCandidate[]; analyses?: Map<string, AnalyzedEntry> } = {}): Promise<PreparedMix> {
    await this.patch({ status: 'working', stage: 'discovering' })
    let pool = opts.pool
    if (!pool) {
      this.progress({ stage: 'discovering', done: 0, total: 1, detail: 'searching Jamendo, Audius and YouTube' })
      const res = await fetch('/api/mixgen/discover', { method: 'POST', headers: await this.headers(), body: JSON.stringify({ spec }) })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? `Discovery failed (${res.status})`)
      const body = (await res.json()) as { pool: Array<TrackCandidate & { access: unknown }>; queries: number; bySource: Record<string, number> }
      pool = body.pool.map(({ access: _a, ...c }) => c)
      this.progress({ stage: 'discovering', done: body.queries, total: body.queries, detail: `${pool.length} recordings (${Object.entries(body.bySource).map(([k, v]) => `${k} ${v}`).join(', ')})` })
    }
    this.orderingDecisions = { decisions: [], counts: {}, timings: {} }
    const out = await runPipeline(spec, await this.host(pool, opts.analyses), { planOnly: true, exclude: opts.exclude, include: opts.include })
    const t = this.lastMl?.trace
    if (t) {
      this.orderingDecisions = {
        decisions: t.decisions.filter((d) => d.stage === 'ordering'),
        counts: t.counts.ordering_pairs ? { ordering_pairs: t.counts.ordering_pairs } : {},
        timings: t.timingsMs.ordering ? { ordering: t.timingsMs.ordering } : {},
      }
    }
    if (!('planOnly' in out)) throw new Error('unexpected render')
    const pos = new Map(out.order.map((k, i) => [k, i]))
    const selection: SelectionRow[] = out.acquisition.map((a) => {
      const e = out.analyses.get(a.trackKey)
      const c = pool!.find((p) => p.trackKey === a.trackKey)
      return {
        trackKey: a.trackKey,
        title: a.title,
        artist: a.artist,
        source: a.source,
        status: a.status,
        reason: a.reason.replace(/sha256 \w+/, '').trim(),
        bpm: e ? Math.round(e.analysis.grid.bpm * 10) / 10 : undefined,
        camelot: e?.analysis.key.camelot,
        durationSec: e ? Math.round(e.analysis.qc.durationSec) : c?.durationSec,
        selected: pos.has(a.trackKey),
        position: pos.get(a.trackKey),
        url: c?.url,
        license: c?.license.label,
        artwork: c?.thumbnailUrl,
      }
    })
    selection.sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
    await this.patch({ status: 'review', stage: 'transitions', selection: selection.slice(0, 80) as unknown as Record<string, unknown>[], summary: { estDurationSec: Math.round(out.plan.durationSec), unavailable: out.unavailable.slice(0, 20), notes: out.plan.notes.slice(0, 5) } })
    return { pool: out.pool, analyses: out.analyses, order: out.order, selection, unavailable: out.unavailable, durationSec: out.plan.durationSec, notes: out.plan.notes }
  }

  /** Steps 9–11: render the approved order, validate, upload privately, mark ready. */
  async render(spec: MixSpec, prepared: PreparedMix, order: string[], userId: string, title: string): Promise<MixManifest> {
    await this.patch({ status: 'rendering', stage: 'rendering' })
    const res = await runPipeline(spec, await this.host(prepared.pool, prepared.analyses), { fixedOrder: order, include: order, title })
    if ('planOnly' in res) throw new Error('unexpected plan-only result')
    const blobInfo = this.renderBlob
    if (!blobInfo) throw new Error('render produced no audio')
    const perms = mixPermissions(order.map((k) => prepared.analyses.get(k)?.access ?? decideAccess(prepared.pool.find((p) => p.trackKey === k)!, DEPLOYED_POLICY)))
    let audioKey = ''
    let manifestKey = ''
    if (perms.persistRender) {
      const base = `mixes/${userId}/${this.mixId}`
      audioKey = (await this.api.upload(blobInfo.blob, `${base}/mix.opus`, (s, t) => this.onProgress({ stage: 'validating', done: s, total: t, detail: 'uploading audio' }))).key
      manifestKey = (await this.api.upload(new Blob([JSON.stringify(res.manifest)], { type: 'application/json' }), `${base}/manifest.json`)).key
    }
    await this.patch({
      status: 'ready',
      stage: 'ready',
      progress: { ready: { done: 1, total: 1, at: Date.now() } },
      audioKey: audioKey || undefined,
      manifestKey: manifestKey || undefined,
      audioMime: blobInfo.mime,
      durationSec: Math.round(res.manifest.durationSec * 10) / 10,
      trackCount: res.manifest.tracks.length,
      permissions: perms,
      title,
      summary: {
        tracks: res.manifest.tracks.map((t) => `${t.artist} – ${t.title}`),
        bpmRange: res.manifest.bpmRange,
        transitions: res.manifest.transitions.map((t) => t.label),
        lufs: res.manifest.metrics.integratedLufs,
        validation: res.validation.ok,
      },
    })
    return res.manifest
  }

  /** Local object URL of the last rendered audio (session playback, also when not persistable). */
  audioUrl(): string | null {
    return this.renderBlob ? URL.createObjectURL(this.renderBlob.blob) : null
  }

  dispose(): void {
    this.analysisWorkers.forEach((w) => w.terminate())
    this.analysisWorkers = []
    this.bytes.clear()
  }
}
