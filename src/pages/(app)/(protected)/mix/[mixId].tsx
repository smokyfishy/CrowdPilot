/**
 * /mix/:mixId — one mix, in exactly one of three states:
 *   generating (or reviewing tracks, when asked for) → failed with recovery → ready to listen.
 * All job orchestration (auto-start, resume, single-runner lock, retry) lives in useMixJob.
 */
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useQuery } from 'deepspace'
import { Button, Skeleton, useToast } from '@/components/ui'
import { MixPlayer } from '@/components/mix/MixPlayer'
import { mixApi } from '@/mixgen/browser/client'
import { specFacts } from '@/components/mix/labels'
import { useMixJob, type MixData } from '@/components/mix/useMixJob'
import { GeneratingView } from '@/components/mix/status/GeneratingView'
import { GenerationError } from '@/components/mix/status/GenerationError'
import { ElsewhereNotice } from '@/components/mix/status/ElsewhereNotice'
import { TrackReview } from '@/components/mix/status/TrackReview'
import { TechnicalDetails } from '@/components/mix/status/TechnicalDetails'

const page = 'mx-auto grid w-full max-w-5xl gap-8 px-[max(16px,env(safe-area-inset-left))] pb-16 pt-6 sm:pt-8'

function RefineMix({ mixId, d, tracks }: { mixId: string; d: MixData; tracks: Array<{ key: string }> }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [refine, setRefine] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!refine.trim()) return
    setBusy(true)
    try {
      const r = await mixApi.refine(d.spec, refine.trim())
      const carry: { exclude: string[]; include: string[] } = { exclude: [], include: [] }
      let spec = r.spec
      for (const op of r.editOps) {
        const idx = Math.min(tracks.length, op.position === 99 ? tracks.length : op.position) - 1
        const t = tracks[idx]
        if (!t) continue
        carry.exclude.push(t.key)
        if (op.op === 'replace') carry.include = tracks.filter((x) => x.key !== t.key).map((x) => x.key)
        if (op.op === 'remove') spec = { ...spec, song_count: Math.max(2, tracks.length - 1) }
      }
      const created = await mixApi.create({ prompt: d.prompt, spec, specSource: r.source, parentId: mixId, editPrompt: refine.trim(), title: d.title })
      sessionStorage.setItem(`mix-carry:${created.id}`, JSON.stringify(carry))
      sessionStorage.setItem(`mix-runner:${created.id}`, '1')
      const q = sessionStorage.getItem(`mix-quality:${mixId}`)
      if (q) sessionStorage.setItem(`mix-quality:${created.id}`, q)
      setRefine('')
      navigate(`/mix/${created.id}`)
    } catch (e) {
      toast.error('Could not refine the mix', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="refine" className="grid gap-3 rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
      <div>
        <h2 id="refine" className="font-semibold text-foreground">Refine this mix</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Describe a change — “more energy at the end”, “replace the third song”, “make it 30 minutes”. You'll get a new version; this one stays.</p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="mix-refine" className="sr-only">Describe a change</label>
        <input id="mix-refine" value={refine} onChange={(e) => setRefine(e.target.value)} maxLength={1000} placeholder="Make the ending more dramatic" className="h-11 min-w-0 flex-1 basis-64 rounded-full border border-input bg-background px-4 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-ring" data-testid="mix-refine" />
        <Button type="submit" loading={busy} disabled={!refine.trim()}>Create new version</Button>
      </form>
    </section>
  )
}

export default function MixPage() {
  const { mixId = '' } = useParams()
  const { records, status } = useQuery<MixData>('mixes', { orderBy: 'updatedAt', orderDir: 'desc', limit: 100 })
  const rec = records.find((r) => r.recordId === mixId)
  const job = useMixJob(mixId, rec)
  const versions = rec ? records.filter((r) => r.data.rootId === rec.data.rootId).sort((a, b) => Number(a.data.version) - Number(b.data.version)) : []

  if (status === 'loading' && !rec) return <div className={page}><Skeleton className="mx-auto h-72 w-full max-w-2xl rounded-2xl" /></div>
  if (!rec)
    return (
      <div className={`${page} justify-items-center text-center`}>
        <p className="text-muted-foreground">This mix doesn't exist or isn't yours.</p>
        <Link to="/mix" className="text-sm text-primary underline-offset-4 hover:underline">Create a new mix</Link>
      </div>
    )

  const d = rec.data
  const facts = specFacts(d.spec)

  return (
    <div className={page}>
      <title>{`${d.title} · CrowdPilot`}</title>
      <nav className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground" aria-label="Mix navigation">
        <Link to="/mix" className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ArrowLeft aria-hidden className="size-4" /> Your mixes
        </Link>
        {versions.length > 1 && (
          <span className="flex flex-wrap items-center gap-1" aria-label="Versions">
            {versions.map((v) => (
              <Link
                key={v.recordId}
                to={`/mix/${v.recordId}`}
                aria-current={v.recordId === mixId ? 'page' : undefined}
                className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${v.recordId === mixId ? 'bg-primary text-primary-foreground' : 'hover:bg-accent hover:text-foreground'}`}
                title={v.data.editPrompt || v.data.prompt}
              >
                v{v.data.version}
              </Link>
            ))}
          </span>
        )}
      </nav>

      {job.view === 'ready' ? (
        job.manifest ? (
          <>
            <MixPlayer manifest={job.manifest} audioSrc={job.audioSrc} downloadUrl={d.permissions?.export ? job.audioSrc : null} />
            <RefineMix mixId={mixId} d={d} tracks={job.manifest.tracks} />
          </>
        ) : job.manifestError ? (
          <GenerationError error={job.manifestError} onRetry={() => window.location.reload()} prepared={false} />
        ) : (
          <Skeleton className="h-72 rounded-2xl" />
        )
      ) : job.view === 'failed' ? (
        <section className="mx-auto grid w-full max-w-2xl gap-6">
          <header className="grid gap-2 text-center">
            <h1 className="text-balance font-display text-[clamp(2rem,6vw,3.25rem)] leading-[1.02] text-foreground">{d.title}</h1>
            <p className="text-sm text-muted-foreground">{facts.join(' · ')}</p>
          </header>
          <GenerationError error={job.error ?? ''} onRetry={job.retry} prepared={job.prepared} />
          <TechnicalDetails events={job.events} stage={job.stage} pass={job.pass} error={job.error} />
        </section>
      ) : job.view === 'review' ? (
        <TrackReview
          title={d.title}
          facts={facts}
          selection={job.selection}
          unavailable={job.unavailable}
          plannedSec={job.plannedSec}
          substitutions={d.spec.allow_song_substitutions !== false}
          prepared={job.prepared}
          busy={job.running}
          onReplace={job.replace}
          onCreate={job.prepared ? job.renderNow : job.retry}
        />
      ) : (
        <GeneratingView
          title={d.title}
          facts={facts}
          prompt={d.prompt}
          editPrompt={d.editPrompt}
          events={job.events}
          stage={job.stage}
          pass={job.pass}
          running={job.running || job.view === 'elsewhere'}
          resuming={job.resuming && job.view !== 'elsewhere'}
          selection={job.selection}
          notice={job.view === 'elsewhere' && job.elsewhere ? <ElsewhereNotice where={job.elsewhere} onContinueHere={job.continueHere} /> : undefined}
        />
      )}
    </div>
  )
}
