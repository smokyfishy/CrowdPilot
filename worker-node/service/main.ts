/**
 * CrowdPilot mix worker (Azure Container Apps job, one execution per queue message).
 *
 *  1. Receives one job from the Azure Storage queue (REST + SAS; message hidden for 2 h).
 *  2. phase "prepare": discovery → policy → acquisition (Jamendo / authorized YouTube via yt-dlp)
 *     → analysis → selection → plan. Reports the selection for the user's review.
 *     phase "render": re-runs with the approved order (audio + analyses come from the cache on
 *     the mounted Azure Files share), renders the continuous mix, encodes MP3, validates,
 *     uploads mix.mp3 + manifest.json to private blob storage.
 *  3. Every real unit of progress is POSTed to CrowdPilot (HMAC-signed callback).
 *  4. The message is deleted when the phase finishes or fails permanently.
 *
 * Env: QUEUE_URL, QUEUE_SAS, BLOB_URL, BLOB_SAS, CALLBACK_URL, WORKER_SECRET, JAMENDO_CLIENT_ID,
 *      YOUTUBE_API_KEY, CP_DATA_ROOT (/data), FFMPEG_PATH, PYTHON, APP_ROOT (/app).
 */
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpec } from '../../src/mixgen/spec'
import type { TrackCandidate } from '../../src/mixgen/types'
import { runNodeJob } from '../mixgen/host'
import { dir, storageReport } from '../mixgen/storage'
import { assertNotResearch } from '../mixgen/research'

export interface WorkerJob {
  mixId: string
  userId: string
  phase: 'prepare' | 'render'
  spec: unknown
  title?: string
  exclude?: string[]
  include?: string[]
  fixedOrder?: string[]
  attempt?: number
}

const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`missing env ${k}`)
  return v
}

// ───────────── Azure Storage REST (SAS) ─────────────
interface QueueMsg {
  id: string
  popReceipt: string
  text: string
  dequeueCount: number
}
const tag = (xml: string, t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml)?.[1] ?? ''

export async function receive(visibilitySec = 7200): Promise<QueueMsg | null> {
  const res = await fetch(`${env('QUEUE_URL')}/messages?numofmessages=1&visibilitytimeout=${visibilitySec}&${env('QUEUE_SAS')}`)
  if (!res.ok) throw new Error(`queue receive ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const xml = await res.text()
  if (!xml.includes('<QueueMessage>')) return null
  return {
    id: tag(xml, 'MessageId'),
    popReceipt: tag(xml, 'PopReceipt'),
    text: Buffer.from(tag(xml, 'MessageText'), 'base64').toString('utf8'),
    dequeueCount: Number(tag(xml, 'DequeueCount') || 1),
  }
}

export async function remove(m: QueueMsg): Promise<void> {
  const res = await fetch(`${env('QUEUE_URL')}/messages/${m.id}?popreceipt=${encodeURIComponent(m.popReceipt)}&${env('QUEUE_SAS')}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`queue delete ${res.status}`)
  await res.body?.cancel().catch(() => undefined)
}

async function putBlob(path: string, body: Buffer, type: string): Promise<void> {
  const res = await fetch(`${env('BLOB_URL')}/${path.split('/').map(encodeURIComponent).join('/')}?${env('BLOB_SAS')}`, {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': type, 'x-ms-blob-cache-control': 'private, max-age=31536000, immutable' },
    body,
  })
  if (!res.ok) throw new Error(`blob put ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`)
}

// ───────────── signed callback to CrowdPilot ─────────────
export function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

async function callback(mixId: string, patch: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(patch)
  const ts = String(Date.now())
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${env('CALLBACK_URL')}/api/mixgen/worker/${mixId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CP-Timestamp': ts, 'X-CP-Signature': sign(env('WORKER_SECRET'), ts, body) },
        body,
      })
      if (res.ok) return
      if (res.status >= 400 && res.status < 500) {
        console.error('callback rejected', res.status, (await res.text()).slice(0, 200))
        return
      }
    } catch (e) {
      console.error('callback error', (e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
  }
}

function throttled(mixId: string) {
  let pending: Record<string, { done: number; total: number; detail?: string; at: number }> = {}
  let stage = ''
  let timer: NodeJS.Timeout | null = null
  const flush = async () => {
    timer = null
    const progress = pending
    pending = {}
    if (Object.keys(progress).length) await callback(mixId, { stage, progress })
  }
  return {
    push(s: string, done: number, total: number, detail?: string) {
      stage = s
      pending[s] = { done, total, detail: detail?.slice(0, 300), at: Date.now() }
      timer ??= setTimeout(() => void flush(), 2000)
    },
    async drain() {
      if (timer) clearTimeout(timer)
      await flush()
    },
  }
}

// ───────────── job execution ─────────────
export async function runJob(job: WorkerJob): Promise<void> {
  const spec = parseSpec(job.spec)
  const appRoot = process.env.APP_ROOT ?? process.cwd()
  const prog = throttled(job.mixId)
  const preparedPath = join(dir('jobs'), `${job.mixId}.prepared.json`)
  if (job.phase === 'prepare') {
    await callback(job.mixId, { status: 'working', stage: 'discovering' })
    const res = await runNodeJob(spec, {
      jobId: `${job.mixId}-prepare`,
      repoRoot: appRoot,
      planOnly: true,
      exclude: job.exclude,
      include: job.include,
      onProgress: (e) => prog.push(e.stage, e.done, e.total, e.detail),
    })
    await prog.drain()
    writeFileSync(preparedPath, JSON.stringify({ pool: res.pool, order: res.order, at: Date.now() }))
    const pos = new Map(res.order.map((k, i) => [k, i]))
    const selection = res.acquisition.map((a) => {
      const e = res.analyses.get(a.trackKey)
      const c = res.pool.find((p) => p.trackKey === a.trackKey)
      return {
        trackKey: a.trackKey,
        title: a.title,
        artist: a.artist,
        source: a.source,
        status: a.status,
        reason: a.reason.replace(/, sha256 \w+/, ''),
        bpm: e ? Math.round(e.analysis.grid.bpm * 10) / 10 : undefined,
        camelot: e?.analysis.key.camelot,
        durationSec: e ? Math.round(e.analysis.qc.durationSec) : c?.durationSec,
        selected: pos.has(a.trackKey),
        position: pos.get(a.trackKey),
        url: c?.url,
        license: c?.license.label,
      }
    })
    selection.sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
    await callback(job.mixId, {
      status: 'review',
      stage: 'transitions',
      selection: selection.slice(0, 80),
      summary: { estDurationSec: Math.round(res.plan.durationSec), unavailable: res.unavailable.slice(0, 20), notes: res.plan.notes.slice(0, 5) },
    })
    return
  }
  // render
  await callback(job.mixId, { status: 'rendering', stage: 'rendering' })
  const prepared = existsSync(preparedPath) ? (JSON.parse(readFileSync(preparedPath, 'utf8')) as { pool: TrackCandidate[]; order: string[] }) : null
  const order = job.fixedOrder ?? prepared?.order
  const mp3Path = join(dir('exports'), `${job.mixId}.mp3`)
  const res = await runNodeJob(spec, {
    jobId: `${job.mixId}-render`,
    repoRoot: appRoot,
    previousPool: prepared?.pool,
    fixedOrder: order,
    include: order,
    exclude: job.exclude,
    title: job.title,
    mp3Path,
    onProgress: (e) => prog.push(e.stage, e.done, e.total, e.detail),
  })
  await prog.drain()
  const m = res.manifest
  const base = `${job.userId}/${job.mixId}`
  const persist = m.permissions.persistRender
  if (persist) {
    await putBlob(`${base}/mix.mp3`, readFileSync(mp3Path), 'audio/mpeg')
    await putBlob(`${base}/manifest.json`, Buffer.from(JSON.stringify(m)), 'application/json')
  }
  await callback(job.mixId, {
    status: 'ready',
    stage: 'ready',
    progress: { ready: { done: 1, total: 1, at: Date.now() } },
    audioKey: persist ? `blob:${base}/mix.mp3` : undefined,
    manifestKey: persist ? `blob:${base}/manifest.json` : undefined,
    audioMime: 'audio/mpeg',
    durationSec: Math.round(m.durationSec * 10) / 10,
    trackCount: m.tracks.length,
    permissions: m.permissions,
    title: m.title,
    summary: {
      tracks: m.tracks.map((t) => `${t.artist} – ${t.title}`),
      bpmRange: m.bpmRange,
      transitions: m.transitions.map((t) => t.label),
      lufs: m.metrics.integratedLufs,
      validation: res.validation.ok,
      bytes: statSync(mp3Path).size,
    },
  })
}

export async function main(): Promise<void> {
  assertNotResearch() // research mode is local-only: the cloud worker refuses to start with the flag set
  const msg = await receive()
  if (!msg) {
    console.log('no job in queue')
    return
  }
  let job: WorkerJob
  try {
    job = JSON.parse(msg.text) as WorkerJob
    if (!/^[0-9a-f-]{36}$/.test(job.mixId) || !job.userId || (job.phase !== 'prepare' && job.phase !== 'render')) throw new Error('bad job')
  } catch (e) {
    console.error('discarding malformed job', (e as Error).message)
    await remove(msg)
    return
  }
  console.log(`job ${job.mixId} ${job.phase} (dequeue ${msg.dequeueCount})`)
  const t0 = Date.now()
  try {
    await runJob(job)
    await remove(msg)
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(storageReport()))
  } catch (e) {
    const err = e as Error
    console.error('job failed', err.stack)
    // Transient failures get one more delivery (message reappears after the visibility timeout);
    // permanent ones are reported and removed.
    const transient = /ECONN|ETIMEDOUT|fetch failed|socket|5\d\d/.test(err.message) && msg.dequeueCount < 2
    await callback(job.mixId, transient ? { error: `retrying after: ${err.message.slice(0, 300)}` } : { status: 'failed', error: err.message.slice(0, 1000) })
    if (!transient) await remove(msg)
    process.exitCode = 1
  }
}

