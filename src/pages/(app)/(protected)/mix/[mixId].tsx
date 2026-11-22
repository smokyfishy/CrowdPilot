/**
 * /mix/:mixId — generation progress (real units of work), track review with optional
 * replacements, render, the finished mix player, natural-language refinement and versions.
 */
import { useEffect, useMemo, useReducer, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useR2Files, useUser } from 'deepspace'
import { Button, Skeleton, useToast } from '@/components/ui'
import { MixPlayer, fmtTime } from '@/components/mix/MixPlayer'
import { authHeaders, fileUrl, liveJobs, mixApi, notify, type LiveJob } from '@/mixgen/browser/client'
import { BrowserMixJob, type SelectionRow } from '@/mixgen/browser/job'
import type { MixManifest } from '@/mixgen/manifest'
import { STAGES, STAGE_LABEL } from '@/mixgen/types'
import type { MixSpec } from '@/mixgen/spec'

interface MixData {
  title: string
  prompt: string
  editPrompt?: string
  spec: MixSpec
  specSource: string
  status: 'draft' | 'working' | 'review' | 'rendering' | 'ready' | 'failed'
  stage: string
  progress?: Record<string, { done: number; total: number; detail?: string }>
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

function Progress({ events, stage }: { events: Record<string, { done: number; total: number; detail?: string }>; stage?: string }) {
  const cur = STAGES.indexOf((stage ?? 'understanding') as (typeof STAGES)[number])
  return (
    <ol className="grid gap-1.5" data-testid="mix-progress">
      {STAGES.map((s, i) => {
        const e = events[s]
        const done = i < cur || (e && e.total > 0 && e.done >= e.total && i <= cur && s !== stage) || (s === 'ready' && stage === 'ready')
        const active = s === stage && !done
        return (
          <li key={s} className={`grid grid-cols-[1.25rem_12rem_1fr] items-baseline gap-2 text-sm ${active ? 'text-foreground' : done ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
            <span aria-hidden>{done ? '✓' : active ? '●' : '○'}</span>
            <span className={active ? 'font-semibold' : ''}>{STAGE_LABEL[s]}</span>
            <span className="truncate tabular-nums text-xs">
              {e && e.total > 1 ? `${e.done} / ${e.total}` : ''} {e?.detail ?? ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function SelectionTable({ rows, onReplace, busy }: { rows: SelectionRow[]; onReplace?: (key: string) => void; busy: boolean }) {
  const selected = rows.filter((r) => r.selected).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const others = rows.filter((r) => !r.selected)
  return (
    <div className="grid gap-4">
      <ol className="divide-y divide-border rounded-xl border border-border" data-testid="mix-selection">
        {selected.map((r, i) => (
          <li key={r.trackKey} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 px-4 py-2.5">
            <span className="font-semibold tabular-nums text-primary">{i + 1}</span>
            <div className="min-w-0">
              <p className="truncate text-foreground">{r.artist} – {r.title}</p>
              <p className="text-xs text-muted-foreground">
                {r.bpm ? `${r.bpm} BPM · ${r.camelot}` : ''} {r.durationSec ? `· ${fmtTime(r.durationSec)}` : ''} · {r.source} · {r.status === 'cached' ? 'audio ready (cached)' : 'audio acquired'} · {r.license}
              </p>
            </div>
            {onReplace && (
              <button type="button" disabled={busy} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-40" onClick={() => onReplace(r.trackKey)}>
                Replace
              </button>
            )}
          </li>
        ))}
      </ol>
      {others.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer text-foreground">Other candidates ({others.length})</summary>
          <ul className="mt-2 grid gap-1">
            {others.map((r) => (
              <li key={r.trackKey}>
                {r.artist} – {r.title}: <span className={r.status === 'acquired' || r.status === 'cached' ? '' : 'text-amber-400'}>{r.status === 'acquired' || r.status === 'cached' ? `available, not chosen${r.bpm ? ` (${r.bpm} BPM ${r.camelot})` : ''}` : `${r.status} — ${r.reason}`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export default function MixPage() {
  const { mixId = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useUser()
  const { upload } = useR2Files()
  const toast = useToast()
  const { records, status } = useQuery<MixData>('mixes', { orderBy: 'updatedAt', orderDir: 'desc', limit: 100 })
  const rec = records.find((r) => r.recordId === mixId)
  const versions = useMemo(() => (rec ? records.filter((r) => r.data.rootId === rec.data.rootId).sort((a, b) => Number(a.data.version) - Number(b.data.version)) : []), [records, rec])
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const [manifest, setManifest] = useState<MixManifest | null>(null)
  const [refine, setRefine] = useState('')
  const [refining, setRefining] = useState(false)
  const live = liveJobs.get(mixId)

  useEffect(() => {
    const l = liveJobs.get(mixId)
    if (!l) return
    l.listeners.add(rerender)
    return () => void l.listeners.delete(rerender)
  }, [mixId, live])

  function ensureJob(): LiveJob {
    let l = liveJobs.get(mixId)
    if (l) return l
    const quality = (sessionStorage.getItem(`mix-quality:${mixId}`) as 'high' | 'lossless' | null) ?? 'high'
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
    const carry = sessionStorage.getItem(`mix-carry:${mixId}`)
    l = { job, running: false, events: {}, listeners: new Set([rerender]), carry: carry ? JSON.parse(carry) : undefined }
    liveJobs.set(mixId, l)
    return l
  }

  async function prepare(opts: { exclude?: string[]; include?: string[] } = {}) {
    if (!rec) return
    const l = ensureJob()
    if (l.running) return
    l.running = true
    l.error = undefined
    notify(mixId)
    try {
      const prev = l.prepared
      const exclude = [...(l.carry?.exclude ?? []), ...(opts.exclude ?? [])]
      const include = opts.include ?? l.carry?.include
      l.prepared = await l.job.prepare(rec.data.spec, { exclude, include, pool: prev?.pool, analyses: prev?.analyses })
      if (opts.exclude?.length) l.carry = { ...(l.carry ?? {}), exclude }
    } catch (e) {
      l.error = (e as Error).message
      await l.job.patch({ status: 'failed', error: l.error.slice(0, 1000) }).catch(() => undefined)
    } finally {
      l.running = false
      notify(mixId)
    }
  }

  async function render() {
    if (!rec || !user) return
    const l = ensureJob()
    if (!l.prepared) return prepare()
    l.running = true
    l.error = undefined
    notify(mixId)
    try {
      const m = await l.job.render(rec.data.spec, l.prepared, l.prepared.order, user.id, rec.data.title)
      l.localAudioUrl = l.job.audioUrl() ?? undefined
      setManifest(m)
    } catch (e) {
      l.error = (e as Error).message
      await l.job.patch({ status: 'failed', error: l.error.slice(0, 1000) }).catch(() => undefined)
    } finally {
      l.running = false
      notify(mixId)
    }
  }

  // Auto-start / resume preparation for fresh or interrupted jobs (analyses are cached).
  useEffect(() => {
    if (!rec || !user) return
    const l = liveJobs.get(mixId)
    if ((rec.data.status === 'draft' || rec.data.status === 'working') && !l?.running && !l?.error && !l?.prepared) void prepare()
  }, [rec?.data.status, user?.id, mixId])

  // Load the stored manifest for ready mixes.
  useEffect(() => {
    if (!rec || rec.data.status !== 'ready' || manifest || !rec.data.manifestKey) return
    let cancel = false
    fetch(fileUrl(rec.data.manifestKey), { credentials: 'include', headers: {} })
      .then(async (r) => {
        if (!r.ok) {
          const h = await authHeaders()
          return fetch(fileUrl(rec.data.manifestKey!), { headers: h })
        }
        return r
      })
      .then((r) => (r.ok ? (r.json() as Promise<MixManifest>) : Promise.reject(new Error(`manifest ${r.status}`))))
      .then((m: MixManifest) => !cancel && setManifest(m))
      .catch((e: Error) => toast.error('Could not load the mix', e.message))
    return () => {
      cancel = true
    }
  }, [rec?.data.status, rec?.data.manifestKey])

  async function submitRefine() {
    if (!rec || !refine.trim()) return
    setRefining(true)
    try {
      const r = await mixApi.refine(rec.data.spec, refine.trim())
      const carry: { exclude: string[]; include: string[] } = { exclude: [], include: [] }
      const tracks = manifest?.tracks ?? []
      let spec = r.spec
      for (const op of r.editOps) {
        const idx = Math.min(tracks.length, op.position === 99 ? tracks.length : op.position) - 1
        const t = tracks[idx]
        if (!t) continue
        carry.exclude.push(t.key)
        if (op.op === 'replace') carry.include = tracks.filter((x) => x.key !== t.key).map((x) => x.key)
        if (op.op === 'remove') spec = { ...spec, song_count: Math.max(2, tracks.length - 1) }
      }
      const created = await mixApi.create({ prompt: rec.data.prompt, spec, specSource: r.source, parentId: mixId, editPrompt: refine.trim(), title: rec.data.title })
      sessionStorage.setItem(`mix-carry:${created.id}`, JSON.stringify(carry))
      const q = sessionStorage.getItem(`mix-quality:${mixId}`)
      if (q) sessionStorage.setItem(`mix-quality:${created.id}`, q)
      setRefine('')
      navigate(`/mix/${created.id}`)
    } catch (e) {
      toast.error('Could not refine the mix', (e as Error).message)
    } finally {
      setRefining(false)
    }
  }

  if (status === 'loading' && !rec) return <div className="mx-auto max-w-4xl p-10"><Skeleton className="h-40" /></div>
  if (!rec) return <div className="mx-auto max-w-4xl p-10 text-muted-foreground">This mix doesn't exist or isn't yours. <Link to="/mix" className="underline">Back</Link></div>

  const d = rec.data
  const events = { ...(d.progress ?? {}), ...(live?.events ?? {}) }
  const stage = live?.stage ?? d.stage
  const running = !!live?.running
  const err = live?.error ?? (d.status === 'failed' ? d.error : undefined)
  const selection = live?.prepared?.selection ?? d.selection ?? []
  const audioSrc = live?.localAudioUrl ?? (d.audioKey ? fileUrl(d.audioKey) : null)

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 px-[max(16px,env(safe-area-inset-left))] py-8">
      <title>{`${d.title} · CrowdPilot`}</title>
      <nav className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link to="/mix" className="hover:text-foreground">← Your mixes</Link>
        {versions.length > 1 && (
          <span className="flex flex-wrap items-center gap-1">
            · Versions:
            {versions.map((v) => (
              <Link key={v.recordId} to={`/mix/${v.recordId}`} className={`rounded-full px-2 py-0.5 ${v.recordId === mixId ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`} title={v.data.editPrompt || v.data.prompt}>
                v{v.data.version}
              </Link>
            ))}
          </span>
        )}
      </nav>

      {d.status === 'ready' && manifest ? (
        <>
          <MixPlayer manifest={manifest} audioSrc={audioSrc} downloadUrl={d.permissions?.export ? audioSrc : null} />
          <section aria-labelledby="refine" className="grid gap-3 rounded-xl border border-border bg-card p-5">
            <h2 id="refine" className="font-display text-2xl text-foreground">Refine this mix</h2>
            <p className="text-sm text-muted-foreground">Try "make it more energetic", "replace the third song", "make the transitions smoother" or "make this 30 minutes instead". Cached audio analysis is reused.</p>
            <div className="flex flex-wrap gap-2">
              <input value={refine} onChange={(e) => setRefine(e.target.value)} maxLength={1000} placeholder="Make the ending more dramatic" className="h-11 min-w-0 flex-1 basis-72 rounded-lg border border-input bg-background px-3 text-foreground" data-testid="mix-refine" onKeyDown={(e) => e.key === 'Enter' && void submitRefine()} />
              <Button onClick={submitRefine} loading={refining} disabled={!refine.trim()}>Create new version</Button>
            </div>
          </section>
        </>
      ) : (
        <section className="grid gap-6">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-primary">{d.version && d.version > 1 ? `Version ${d.version}` : 'New mix'}</p>
            <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-none text-foreground">{d.title}</h1>
            <p className="mt-2 max-w-[75ch] text-muted-foreground">{d.editPrompt ? `Edit: “${d.editPrompt}”` : d.prompt}</p>
          </header>
          <div className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
            <div className="rounded-xl border border-border bg-card p-4">
              <Progress events={events} stage={stage} />
              {running && <p className="mt-3 text-xs text-muted-foreground">Working in this tab. Keep it open; if it closes, reopening this page resumes from cached analysis.</p>}
            </div>
            <div className="grid content-start gap-3">
              {err && (
                <div className="rounded-xl border border-destructive/50 p-4 text-sm">
                  <p className="font-medium text-destructive">Something went wrong</p>
                  <p className="mt-1 text-muted-foreground">{err}</p>
                  <Button className="mt-3" variant="outline" onClick={() => { const l = ensureJob(); l.error = undefined; void prepare() }}>Retry</Button>
                </div>
              )}
              {(d.status === 'review' || live?.prepared) && selection.length > 0 && (
                <>
                  <h2 className="font-display text-2xl text-foreground">Selected tracks</h2>
                  <p className="text-sm text-muted-foreground">
                    Planned length {fmtTime(live?.prepared?.durationSec ?? d.summary?.estDurationSec ?? 0)} for {Math.round((rec.data.spec.target_duration_minutes ?? 0) || 0) ? `${rec.data.spec.target_duration_minutes} min requested` : 'your request'}. Every track below has audio that is licensed for mixing and has been analyzed.
                  </p>
                  {(live?.prepared?.unavailable ?? d.summary?.unavailable ?? []).length > 0 && (
                    <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">Not available for mixing</p>
                      <ul className="mt-1 list-disc pl-5">
                        {(live?.prepared?.unavailable ?? d.summary?.unavailable ?? []).map((u) => (
                          <li key={u.request}><span className="text-foreground">{u.request}</span>: {u.reason}</li>
                        ))}
                      </ul>
                      <p className="mt-1">{rec.data.spec.allow_song_substitutions === false ? 'Substitutions are off, so the mix uses only what was found.' : 'Similar tracks from licensed catalogs were chosen instead.'}</p>
                    </div>
                  )}
                  <SelectionTable rows={selection} busy={running} onReplace={live?.prepared ? (key) => void prepare({ exclude: [key], include: selection.filter((s) => s.selected && s.trackKey !== key).map((s) => s.trackKey) }) : undefined} />
                  <div className="flex flex-wrap gap-2">
                    {live?.prepared ? (
                      <Button size="lg" onClick={render} loading={running} data-testid="mix-render">Generate the mix</Button>
                    ) : (
                      <Button size="lg" onClick={() => void prepare()} loading={running}>Continue (reload cached analysis)</Button>
                    )}
                  </div>
                </>
              )}
              {d.status === 'rendering' && !running && !live?.prepared && (
                <div className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
                  The render was interrupted (the tab closed). <Button variant="outline" className="ml-2" onClick={() => void prepare()}>Resume</Button>
                </div>
              )}
              {d.status === 'ready' && !manifest && <Skeleton className="h-40" />}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
