/** Collapsed debugging view: every raw pipeline stage with its real counts and detail text. */
import { STAGES, STAGE_LABEL } from '@/mixgen/types'
import type { StageEvents } from '../generation-progress'

export function TechnicalDetails({ events, stage, pass, error, extra }: { events: StageEvents; stage?: string; pass: string; error?: string; extra?: Array<[string, string]> }) {
  const cur = STAGES.indexOf((stage ?? 'understanding') as (typeof STAGES)[number])
  return (
    <details className="group text-sm" data-testid="mix-tech-details">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-xs transition-transform group-open:rotate-90">▸</span>
        View technical details
      </summary>
      <div className="mt-3 grid gap-3 rounded-lg border border-border bg-background/40 p-3 text-xs">
        <ol className="grid gap-1" data-testid="mix-progress">
          {STAGES.map((s, i) => {
            const e = events[s]
            const state = i < cur || s === 'ready' ? (i < cur ? 'done' : stage === 'ready' ? 'done' : 'todo') : i === cur ? 'active' : 'todo'
            return (
              <li key={s} className={`grid grid-cols-[1rem_minmax(0,10rem)_minmax(0,1fr)] items-baseline gap-2 ${state === 'active' ? 'text-foreground' : state === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                <span aria-hidden>{state === 'done' ? '✓' : state === 'active' ? '•' : '·'}</span>
                <span className="truncate">{STAGE_LABEL[s]}</span>
                <span className="break-words tabular-nums">
                  {e && e.total > 1 ? `${e.done} / ${e.total} ` : ''}
                  {e?.detail ?? ''}
                </span>
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
              <dd className="break-words text-foreground">{v}</dd>
            </div>
          ))}
          {error && (
            <>
              <dt>Error</dt>
              <dd className="break-words font-mono text-destructive">{error}</dd>
            </>
          )}
        </dl>
      </div>
    </details>
  )
}
