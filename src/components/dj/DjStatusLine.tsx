/** Room-wide AI DJ status (everyone sees it; synced from dj_state). */
import { Disc3 } from 'lucide-react'
import type { DjState, QueueItem } from '@/domain/types'
import { STYLE_LABEL, type TransitionStyle } from '@/dj/transitions'
import { useServerClock, useTicker } from '@/client/hooks'

const STATUS_TEXT: Record<DjState['status'], string> = {
  idle: 'AI DJ off',
  analyzing: 'Analyzing audio…',
  ready: 'AI DJ ready',
  proposed: 'Next transition proposed',
  committed: 'Next transition locked in',
  mixing: 'Mixing now',
  safe_fallback: 'Standard playback (safe fallback)',
  failed: 'Mix failed — playing safely',
}

export function DjStatusLine({ dj, items }: { dj: DjState; items: QueueItem[] }) {
  const clock = useServerClock()
  useTicker(dj.status === 'committed', 1000)
  if (!dj.autopilot && dj.status === 'idle') return null
  const t = dj.transition
  const to = t ? items.find((i) => i.id === t.toItemId) : undefined
  const startsIn = t?.startsAt ? Math.max(0, Math.round((t.startsAt - clock.now()) / 1000)) : null
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm" role="status">
      <Disc3 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0">
        <p className="text-foreground">
          {STATUS_TEXT[dj.status]}
          {t && (dj.status === 'proposed' || dj.status === 'committed') && (
            <>
              {' '}
              · {STYLE_LABEL[t.style as TransitionStyle] ?? t.style}
              {to ? ` into “${to.title}”` : ''}
              {startsIn !== null && dj.status === 'committed' ? ` in ${startsIn}s` : ''}
            </>
          )}
        </p>
        {dj.statusNote && dj.status !== 'proposed' && dj.status !== 'committed' && <p className="truncate text-xs text-muted-foreground">{dj.statusNote}</p>}
      </div>
    </div>
  )
}
