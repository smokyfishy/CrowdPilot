/** The user's mixes, newest first, with a plain status (never a raw pipeline stage). */
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useQuery } from 'deepspace'
import { Skeleton } from '@/components/ui'
import { fmtTime } from '../MixPlayer'
import { PHASES, summarizeProgress } from '../generation-progress'

interface MixRow {
  title: string
  status: string
  stage: string
  durationSec?: number
  trackCount?: number
  version?: number
}

function statusLine(r: MixRow): { text: string; tone: 'ready' | 'failed' | 'busy' } {
  if (r.status === 'ready') return { text: `${r.trackCount} tracks · ${fmtTime(Number(r.durationSec))}`, tone: 'ready' }
  if (r.status === 'failed') return { text: "Didn't finish — open to retry", tone: 'failed' }
  if (r.status === 'review') return { text: 'Tracks ready for review', tone: 'busy' }
  const s = summarizeProgress({ stage: r.stage, events: {}, pass: r.status === 'rendering' ? 'render' : 'prepare' })
  return { text: `In progress · ${PHASES[s.phase].label}`, tone: 'busy' }
}

export function RecentMixes() {
  const { records, status } = useQuery<MixRow>('mixes', { orderBy: 'updatedAt', orderDir: 'desc', limit: 50 })
  if (status === 'loading') return <Skeleton className="h-28 rounded-xl" />
  if (!records.length) return <p className="text-sm text-muted-foreground">Your mixes will appear here.</p>
  return (
    <ul className="grid gap-1" data-testid="recent-mixes">
      {records.map((r) => {
        const s = statusLine(r.data)
        return (
          <li key={r.recordId}>
            <Link to={`/mix/${r.recordId}`} className="group flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring">
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${s.tone === 'ready' ? 'bg-primary' : s.tone === 'failed' ? 'bg-destructive' : 'bg-foreground/30 motion-safe:animate-pulse'}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">
                  {r.data.title}
                  {Number(r.data.version) > 1 && <span className="font-normal text-muted-foreground"> · v{r.data.version}</span>}
                </p>
                <p className="truncate text-sm text-muted-foreground">{s.text}</p>
              </div>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
