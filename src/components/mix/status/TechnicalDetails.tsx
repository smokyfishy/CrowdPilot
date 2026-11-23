/** Collapsed debugging view: every raw pipeline stage with its real counts and detail text. */
import { Activity, Check, Circle, LoaderCircle } from 'lucide-react'
import { MixDisclosure } from '../MixDisclosure'
import { STAGES, STAGE_LABEL } from '@/mixgen/types'
import type { StageEvents } from '../generation-progress'

export function TechnicalDetails({ events, stage, pass, error, extra }: { events: StageEvents; stage?: string; pass: string; error?: string; extra?: Array<[string, string]> }) {
  const cur = STAGES.indexOf((stage ?? 'understanding') as (typeof STAGES)[number])
  return (
    <MixDisclosure title="View technical details" icon={<Activity className="size-4" />} testId="mix-tech-details">
      <div className="grid min-w-0 gap-3 text-xs">
        <ol className="grid min-w-0 gap-1" data-testid="mix-progress">
          {STAGES.map((s, i) => {
            const e = events[s]
            const done = i < cur || stage === 'ready'
            const active = !done && i === cur
            const Status = done ? Check : active ? LoaderCircle : Circle
            return (
              <li key={s} aria-current={active ? 'step' : undefined} className={`grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 ${active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'}`}>
                <Status aria-hidden className={`size-3.5 ${done || active ? 'text-primary' : 'opacity-50'} ${active ? 'motion-safe:animate-spin' : ''}`} />
                <span className="min-w-0 [overflow-wrap:anywhere]">{STAGE_LABEL[s]}</span>
                {e && e.total > 1 && <span className="rounded bg-background px-1.5 py-0.5 tabular-nums">{e.done} / {e.total}</span>}
                {e?.detail && <span className="col-span-2 col-start-2 text-muted-foreground [overflow-wrap:anywhere]">{e.detail}</span>}
              </li>
            )
          })}
        </ol>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-2 text-muted-foreground">
          <dt>Pass</dt>
          <dd className="text-foreground">{pass}</dd>
          {extra?.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd className="[overflow-wrap:anywhere] text-foreground">{v}</dd>
            </div>
          ))}
          {error && (
            <>
              <dt>Error</dt>
              <dd className="[overflow-wrap:anywhere] font-mono text-destructive">{error}</dd>
            </>
          )}
        </dl>
      </div>
    </MixDisclosure>
  )
}
