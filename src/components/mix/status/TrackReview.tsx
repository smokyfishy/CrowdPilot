/** Optional review step (only when "Review tracks before mixing" was chosen): swap tracks, then mix. */
import { Button } from '@/components/ui'
import type { SelectionRow } from '@/mixgen/browser/job'
import { fmtTime } from '../MixPlayer'
import { Disclosure } from './GeneratingView'
import { SelectedTracks } from './SelectedTracks'

export function TrackReview({ title, facts, selection, unavailable, plannedSec, substitutions, prepared, busy, onReplace, onCreate }: {
  title: string
  facts: string[]
  selection: SelectionRow[]
  unavailable: Array<{ request: string; reason: string }>
  plannedSec?: number
  substitutions: boolean
  prepared: boolean
  busy: boolean
  onReplace: (key: string) => void
  onCreate: () => void
}) {
  return (
    <section className="mx-auto grid w-full max-w-2xl gap-6" aria-labelledby="review-title" data-testid="mix-review">
      <header className="grid gap-2 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">Review your tracks</p>
        <h1 id="review-title" className="text-balance font-display text-[clamp(2rem,6vw,3.25rem)] leading-[1.02] text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {facts.join(' · ')}
          {plannedSec ? ` · plays ${fmtTime(plannedSec)}` : ''}
        </p>
      </header>
      <div className="grid gap-4 rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
        <SelectedTracks rows={selection} onReplace={prepared ? onReplace : undefined} busy={busy} />
        {unavailable.length > 0 && (
          <Disclosure summary={`${unavailable.length} requested ${unavailable.length === 1 ? 'track isn’t' : 'tracks aren’t'} available for mixing`}>
            <ul className="grid gap-1 text-muted-foreground">
              {unavailable.map((u) => (
                <li key={u.request}>
                  <span className="text-foreground">{u.request}</span> — {u.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">{substitutions ? 'Similar tracks that are licensed for mixing were chosen instead.' : 'Substitutions are off, so the mix uses only what was found.'}</p>
          </Disclosure>
        )}
      </div>
      <div className="flex justify-center">
        <Button size="lg" onClick={onCreate} loading={busy} data-testid="mix-render">
          {prepared ? 'Create the mix' : 'Load tracks'}
        </Button>
      </div>
    </section>
  )
}
