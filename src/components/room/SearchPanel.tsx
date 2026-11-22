import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Loader2, Search } from 'lucide-react'
import { Artwork, Skeleton } from '@/components/ui'
import { roomApi } from '@/client/api'
import type { CatalogTrack } from '@/providers/catalog/types'
import type { DomainError, RoomState } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'
import { addButtonState, enqueueKey, formatTime } from './view-model'

interface SearchPanelProps {
  roomId: string
  room: RoomState
  isHost: boolean
  activeKeys: Set<string>
  run: (cmd: RoomCommand, opts?: { silent?: boolean }) => Promise<{ ok: boolean; error?: DomainError } & Record<string, unknown>>
  onVoteExisting: (trackKey: string) => void
  autoFocus?: boolean
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; tracks: CatalogTrack[] }
  | { kind: 'error'; error: DomainError }

export function SearchPanel({ roomId, room, isHost, activeKeys, run, onVoteExisting, autoFocus }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const [pending, setPending] = useState<Record<string, string>>({})
  const [source, setSource] = useState<'youtube' | 'audius' | 'jamendo'>('youtube')
  const abortRef = useRef<AbortController | null>(null)
  const lastQuery = useRef('')
  const locked = !isHost && !room.guestRequestsEnabled

  async function search(q: string) {
    const trimmed = q.trim()
    const tag = `${source}:${trimmed}`
    if (trimmed.length < 2 || tag === lastQuery.current) return
    lastQuery.current = tag
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ kind: 'loading' })
    const r = await roomApi.search(roomId, trimmed, controller.signal, source)
    if (controller.signal.aborted) return
    setState(r.ok ? { kind: 'results', tracks: r.value } : { kind: 'error', error: r.error })
    if (!r.ok) lastQuery.current = ''
  }

  // Debounced search after typing stops; Enter searches immediately.
  useEffect(() => {
    const id = setTimeout(() => void search(query), 450)
    return () => clearTimeout(id)
  }, [query, source])

  useEffect(() => () => abortRef.current?.abort(), [])

  function submit(e: FormEvent) {
    e.preventDefault()
    lastQuery.current = ''
    void search(query)
  }

  async function add(track: CatalogTrack) {
    setPending((p) => ({ ...p, [track.trackKey]: 'adding' }))
    const r = await run(
      {
        type: 'enqueue',
        idempotencyKey: enqueueKey(track.trackKey),
        track: {
          trackKey: track.trackKey,
          title: track.title,
          creatorLabel: track.creatorLabel,
          thumbnailUrl: track.thumbnailUrl,
          durationMs: track.durationMs,
        },
      },
      { silent: true },
    )
    setPending((p) => {
      const next = { ...p }
      if (r.ok) delete next[track.trackKey]
      else if (r.error?.code === 'DUPLICATE') next[track.trackKey] = 'DUPLICATE'
      else next[track.trackKey] = r.error?.message ?? "Couldn't add that song. Try again."
      return next
    })
  }

  return (
    <section aria-labelledby="search-heading" className="grid gap-4">
      <h2 id="search-heading" className="sr-only">
        Find songs
      </h2>
      {locked && (
        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground" role="status">
          The host has paused requests. You can still vote on songs already in the queue.
        </p>
      )}
      <div role="radiogroup" aria-label="Song source" className="flex flex-wrap gap-1.5 text-xs">
        {(
          [
            ['youtube', 'YouTube', 'Standard playback (embedded player)'],
            ['audius', 'Audius · AI mix', 'Full audio: beat-matched AI mixing'],
            ['jamendo', 'Jamendo · AI mix', 'Creative Commons full audio: AI mixing'],
          ] as const
        ).map(([id, label, hint]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={source === id}
            title={hint}
            onClick={() => setSource(id)}
            className={source === id ? 'rounded-full border border-primary px-3 py-1 font-semibold text-primary' : 'rounded-full border border-input px-3 py-1 text-muted-foreground hover:text-foreground'}
          >
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} role="search" className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <label htmlFor="song-search" className="sr-only">
          Search YouTube for a song
        </label>
        <input
          id="song-search"
          type="search"
          value={query}
          autoFocus={autoFocus}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search songs or artists"
          className="h-12 w-full rounded-full border border-input bg-card pl-11 pr-4 text-foreground placeholder:text-muted-foreground"
        />
      </form>

      <div aria-live="polite" aria-busy={state.kind === 'loading'}>
        {state.kind === 'idle' && (
          <p className="text-sm text-muted-foreground">
            {source === 'youtube'
              ? 'Results come from YouTube and play in its embedded player (no beat-matching). Type at least two letters.'
              : 'Results stream full authorized audio, so the AI DJ can analyze and mix them. Type at least two letters.'}
          </p>
        )}

        {state.kind === 'loading' && (
          <ul className="grid gap-3" aria-label="Loading results">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-3">
                <Skeleton className="aspect-square w-[52px]" />
                <div className="grid gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {state.kind === 'error' && (
          <div className="grid gap-2 rounded-lg border border-border bg-card p-4 text-sm">
            <p className="font-semibold text-foreground">
              {state.error.code === 'PROVIDER_NOT_CONFIGURED'
                ? 'Song search is not set up'
                : state.error.code === 'QUOTA'
                  ? 'Search is resting for today'
                  : state.error.code === 'RATE_LIMITED'
                    ? 'Too many searches'
                    : "Search didn't work"}
            </p>
            <p className="text-muted-foreground">{state.error.message}</p>
            {state.error.code === 'PROVIDER_NOT_CONFIGURED' && isHost && (
              <p className="text-muted-foreground">
                Add a YouTube Data API key with <code className="rounded bg-secondary px-1">npx deepspace secrets set YOUTUBE_API_KEY</code>, then redeploy.
              </p>
            )}
          </div>
        )}

        {state.kind === 'results' && state.tracks.length === 0 && (
          <p className="text-sm text-muted-foreground">No playable songs found for “{query.trim()}”. Try the artist and title together.</p>
        )}

        {state.kind === 'results' && state.tracks.length > 0 && (
          <ul className="grid gap-1">
            {state.tracks.map((track) => {
              const status = addButtonState(track.trackKey, activeKeys, pending[track.trackKey])
              const failure = pending[track.trackKey] && !['adding', 'DUPLICATE'].includes(pending[track.trackKey]) ? pending[track.trackKey] : null
              return (
                <li key={track.trackKey} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-1 py-1.5">
                  <Artwork src={track.thumbnailUrl} title={track.title} className="w-[52px]" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground" title={track.title}>
                      {track.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {track.creatorLabel ? `${track.source === 'youtube' ? 'on ' : ''}${track.creatorLabel}` : 'YouTube'}
                      {track.rights?.uploaderVerified ? ' ✓' : ''}
                      {track.durationMs ? ` · ${formatTime(track.durationMs / 1000)}` : ''}
                    </p>
                    {track.source !== 'youtube' && (
                      <p className="truncate text-[11px] text-muted-foreground" title={track.rights?.mixingNeedsReview ? 'Mixing rights under this licence need a human review; the host can disable it.' : undefined}>
                        <span className="text-primary">AI mix</span> · {track.rights?.label ?? 'licence unknown'}
                        {track.rights?.mixingNeedsReview ? ' · rights review' : ''}
                      </p>
                    )}
                    {failure && <p className="text-xs text-destructive">{failure}</p>}
                  </div>
                  {status === 'in-queue' ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                      <Check className="size-3.5" aria-hidden /> In queue
                    </span>
                  ) : status === 'vote-instead' ? (
                    <button type="button" onClick={() => onVoteExisting(track.trackKey)} className="rounded-full border border-primary px-3 py-1.5 text-xs font-semibold text-primary">
                      Vote instead
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={locked || status === 'adding'}
                      onClick={() => void add(track)}
                      aria-label={`Add ${track.title} to the queue`}
                      className="inline-flex min-w-16 items-center justify-center rounded-full border border-primary px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                    >
                      {status === 'adding' ? <Loader2 className="size-3.5 animate-spin" aria-label="Adding" /> : 'Add'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
