/**
 * Owns the lifecycle of one mix job on /mix/:id.
 *
 * The pipeline runs in the browser tab that started it (BrowserMixJob). This hook:
 *  - starts a fresh job automatically and resumes an interrupted one (analyses are cached
 *    in IndexedDB, so a resume skips re-analysis),
 *  - never runs the same mix twice: a Web Lock blocks a second tab of this browser, and a
 *    recently-updated record that this tab did not start is treated as running elsewhere
 *    (another device), with an explicit "continue here" escape,
 *  - goes straight from preparing to rendering unless the user asked to review tracks first,
 *  - warns before the tab is closed while work is in flight,
 *  - keeps progress from real events only: this tab's live events while it runs, otherwise
 *    the progress the running tab persisted to the record.
 */
import { useEffect, useReducer, useState } from 'react'
import { useR2Files, useUser } from 'deepspace'
import { authHeaders, fileUrl, heldElsewhere, liveJobs, notify, runExclusive, tabRunner, type LiveJob } from '@/mixgen/browser/client'
import { BrowserMixJob, type SelectionRow } from '@/mixgen/browser/job'
import type { MixManifest } from '@/mixgen/manifest'
import type { MixSpec } from '@/mixgen/spec'
import type { Pass, StageEvents } from './generation-progress'

export interface MixData {
  title: string
  prompt: string
  editPrompt?: string
  spec: MixSpec
  specSource: string
  status: 'draft' | 'working' | 'review' | 'rendering' | 'ready' | 'failed'
  stage: string
  progress?: StageEvents
  selection?: SelectionRow[]
  summary?: { estDurationSec?: number; unavailable?: Array<{ request: string; reason: string }>; notes?: string[] }
  manifestKey?: string
  audioKey?: string
  durationSec?: number
  trackCount?: number
  permissions?: { persistRender: boolean; export: boolean; reason: string }
  error?: string
  version?: number
  rootId?: string
  parentId?: string
  updatedAt: number
}

/** A record updated this recently, by a tab that is not this one, is assumed to be running there. */
const ELSEWHERE_MS = 90_000

export type JobView = 'generating' | 'elsewhere' | 'review' | 'failed' | 'ready'

/**
 * Set once the page is being torn down (reload, close, external navigation). The tab's
 * in-flight requests are then aborted; those errors are the unload, not a failed mix, so
 * they must not be written to the record (the reopened page resumes instead).
 */
let unloading = false
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => (unloading = true))
  window.addEventListener('pageshow', () => (unloading = false))
}

const flag = (k: string) => {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}

export function useMixJob(mixId: string, rec: { recordId: string; data: MixData } | undefined) {
  const { user } = useUser()
  const { upload } = useR2Files()
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const [elsewhere, setElsewhere] = useState<null | 'tab' | 'device'>(null)
  const [force, setForce] = useState(false)
  const [poll, setPoll] = useState(0)
  const [storedManifest, setStoredManifest] = useState<{ id: string; m: MixManifest } | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const live = liveJobs.get(mixId)
  const reviewFirst = flag(`mix-review:${mixId}`) === '1'

  // Re-render on this tab's live progress events (jobs survive in-app navigation).
  useEffect(() => {
    const l = liveJobs.get(mixId)
    if (!l) return
    l.listeners.add(rerender)
    return () => void l.listeners.delete(rerender)
  }, [mixId, live])

  function ensureJob(): LiveJob {
    let l = liveJobs.get(mixId)
    if (l) return l
    const quality = (flag(`mix-quality:${mixId}`) as 'high' | 'lossless' | null) ?? 'high'
    const job = new BrowserMixJob(
      mixId,
      {
        authHeaders,
        async upload(blob, key, onProgress) {
          const r = await upload(blob, key.split('/').pop(), { key, onProgress })
          if (!r.success || !r.key) throw new Error(r.error ?? 'upload failed')
          return { key: r.key, url: r.url }
        },
      },
      (ev) => {
        const lj = liveJobs.get(mixId)!
        lj.events[ev.stage] = { done: ev.done, total: ev.total, detail: ev.detail }
        lj.stage = ev.stage
        notify(mixId)
      },
      quality,
    )
    const automationModel = rec?.data.spec.automation_model
    if (automationModel === 'transitionnet') job.mlOptions = { transitionNet: true }
    if (automationModel === 'transitionnet-only') job.mlOptions = { transitionNet: true, mixgraph: false, ordering: false, critic: false }
    const carry = flag(`mix-carry:${mixId}`)
    l = { job, running: false, events: {}, listeners: new Set([rerender]), carry: carry ? JSON.parse(carry) : undefined }
    liveJobs.set(mixId, l)
    return l
  }

  /**
   * Run whatever is left: prepare (unless already prepared and not re-planning), then render
   * (unless the user wants to review tracks first and has not approved them yet).
   */
  async function run(opts: { exclude?: string[]; include?: string[]; render?: boolean } = {}) {
    if (!rec || !user) return
    const l = ensureJob()
    if (l.running) return
    tabRunner.mark(mixId)
    l.running = true
    l.error = undefined
    setElsewhere(null)
    notify(mixId)
    const replan = !!opts.exclude?.length
    const res = await runExclusive(mixId, async () => {
      try {
        if (!l.prepared || replan) {
          l.pass = 'prepare'
          l.events = {}
          l.stage = 'understanding'
          notify(mixId)
          const prev = l.prepared
          const exclude = [...(l.carry?.exclude ?? []), ...(opts.exclude ?? [])]
          const include = opts.include ?? l.carry?.include
          l.prepared = await l.job.prepare(rec.data.spec, { exclude, include, pool: prev?.pool, analyses: prev?.analyses })
          if (replan) l.carry = { ...(l.carry ?? {}), exclude }
        }
        if (reviewFirst && !opts.render) return
        l.pass = 'render'
        for (const s of ['rendering', 'validating', 'ready']) delete l.events[s]
        notify(mixId)
        const m = await l.job.render(rec.data.spec, l.prepared, l.prepared.order, user.id, rec.data.title)
        l.localAudioUrl = l.job.audioUrl() ?? undefined
        l.manifest = m
        l.job.dispose()
      } catch (e) {
        if (unloading) return
        l.error = (e as Error).message || 'Unknown error'
        await l.job.patch({ status: 'failed', error: l.error.slice(0, 1000) }).catch(() => undefined)
      }
    })
    l.running = false
    if (!res.ran) setElsewhere('tab')
    notify(mixId)
  }

  const status = rec?.data.status
  const updatedAt = rec?.data.updatedAt ?? 0

  // Auto-start fresh jobs and resume interrupted ones, unless they are running elsewhere.
  useEffect(() => {
    if (!rec || !user || !status) return
    const l = liveJobs.get(mixId)
    if (l?.running || l?.error) return
    if (status === 'ready' || status === 'failed') return
    if (status === 'review' && (reviewFirst || l?.prepared)) return // waiting for the user
    let cancelled = false
    void (async () => {
      if (await heldElsewhere(mixId)) return !cancelled && setElsewhere('tab')
      const recent = Date.now() - updatedAt < ELSEWHERE_MS
      if (status !== 'review' && recent && !tabRunner.owns(mixId) && !force) return !cancelled && setElsewhere('device')
      if (!cancelled) void run()
    })()
    return () => {
      cancelled = true
    }
  }, [status, user?.id, mixId, force, poll])

  // While another tab/device has it, re-check periodically so this tab can take over once it stops.
  useEffect(() => {
    if (!elsewhere) return
    const t = setInterval(() => setPoll((p) => p + 1), 5000)
    return () => clearInterval(t)
  }, [elsewhere])
  useEffect(() => {
    if (status === 'ready' || status === 'failed') setElsewhere(null)
  }, [status])

  // Closing the tab pauses generation, so ask first.
  const running = !!live?.running
  useEffect(() => {
    if (!running) return
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [running])

  // Load the stored manifest for ready mixes that were not rendered in this tab.
  const manifestKey = rec?.data.manifestKey
  useEffect(() => {
    if (status !== 'ready' || !manifestKey || live?.manifest || storedManifest?.id === mixId) return
    let cancel = false
    setManifestError(null)
    void (async () => {
      try {
        let r = await fetch(fileUrl(manifestKey), { credentials: 'include' })
        if (!r.ok) r = await fetch(fileUrl(manifestKey), { headers: await authHeaders() })
        if (!r.ok) throw new Error(`The mix details could not be loaded (${r.status}).`)
        const m = (await r.json()) as MixManifest
        if (!cancel) setStoredManifest({ id: mixId, m })
      } catch (e) {
        if (!cancel) setManifestError((e as Error).message)
      }
    })()
    return () => {
      cancel = true
    }
  }, [status, manifestKey, mixId, live?.manifest, storedManifest?.id])

  const d = rec?.data
  const error = live?.error ?? (status === 'failed' ? (d?.error ?? 'Unknown error') : undefined)
  const prepared = live?.prepared
  const view: JobView = error && !running ? 'failed' : status === 'ready' && !running ? 'ready' : elsewhere && !running ? 'elsewhere' : !running && status === 'review' && (reviewFirst || prepared) ? 'review' : 'generating'
  // This tab's own events are the truth while it runs; otherwise show what the running tab persisted.
  const useLive = !!live && (running || !!live.pass)
  const events: StageEvents = useLive ? live!.events : (d?.progress ?? {})
  const stage = useLive ? live!.stage : d?.stage
  const pass: Pass = useLive ? (live!.pass ?? 'prepare') : status === 'rendering' ? 'render' : 'prepare'

  return {
    view,
    elsewhere,
    running,
    resuming: !running && !live && (status === 'working' || status === 'rendering'),
    reviewFirst,
    error,
    events,
    stage,
    pass,
    selection: prepared?.selection ?? d?.selection ?? [],
    unavailable: prepared?.unavailable ?? d?.summary?.unavailable ?? [],
    plannedSec: prepared?.durationSec ?? d?.summary?.estDurationSec,
    prepared: !!prepared,
    manifest: live?.manifest ?? (storedManifest?.id === mixId ? storedManifest.m : null),
    manifestError,
    audioSrc: live?.localAudioUrl ?? (d?.audioKey ? fileUrl(d.audioKey) : null),
    /** Retry after a failure: re-renders when tracks are already prepared, otherwise prepares again (cached analyses reused). */
    retry: () => {
      const l = ensureJob()
      l.error = undefined
      void run({ render: !!l.prepared })
    },
    continueHere: () => setForce(true),
    replace: (key: string) => void run({ exclude: [key], include: (prepared?.selection ?? []).filter((s) => s.selected && s.trackKey !== key).map((s) => s.trackKey) }),
    renderNow: () => void run({ render: true }),
  }
}
