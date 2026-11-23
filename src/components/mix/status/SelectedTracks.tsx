/** Compact preview of the tracks genuinely chosen for the set (artwork, artist, title). */
import { useState } from 'react'
import { Artwork } from '@/components/ui'
import type { SelectionRow } from '@/mixgen/browser/job'

export function SelectedTracks({ rows, limit = 5, onReplace, busy, testId = 'mix-selection' }: { rows: SelectionRow[]; limit?: number; onReplace?: (key: string) => void; busy?: boolean; testId?: string }) {
  const [all, setAll] = useState(false)
  const selected = rows.filter((r) => r.selected).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  if (!selected.length) return null
  const shown = all || onReplace ? selected : selected.slice(0, limit)
  return (
    <div className="grid gap-2">
      <ol className="grid gap-1" data-testid={testId}>
        {shown.map((r, i) => (
          <li key={r.trackKey} className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
            <Artwork src={r.artwork} title={r.title} className="size-9 rounded" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{r.title}</p>
              <p className="truncate text-xs text-muted-foreground">{r.artist}</p>
            </div>
            {onReplace && (
              <button type="button" disabled={busy} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => onReplace(r.trackKey)} aria-label={`Replace ${r.title}`}>
                Replace
              </button>
            )}
          </li>
        ))}
      </ol>
      {!onReplace && selected.length > limit && (
        <button type="button" className="justify-self-start px-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `+ ${selected.length - limit} more`}
        </button>
      )}
    </div>
  )
}
