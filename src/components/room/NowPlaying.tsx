import type { ReactNode } from 'react'
import { Pause, Play, SkipForward } from 'lucide-react'
import { Artwork } from '@/components/ui'
import { cn } from '@/lib/utils'
import { estimateProgressSec } from '@/domain/playback'
import type { PlaybackState, QueueItem } from '@/domain/types'
import { useServerClock, useTicker } from '@/client/hooks'
import { formatTime, progressFraction } from './view-model'

interface NowPlayingProps {
  item?: QueueItem
  playback?: PlaybackState
  isHost: boolean
  queueEmpty: boolean
  busy: boolean
  onPlay: () => void
  onPause: () => void
  onSkip: () => void
  /** The host's official player (desktop) slots in here. */
  player?: ReactNode
  compact?: boolean
  /** Phone host view: the player is shown above the tabs, so skip the artwork here. */
  hideArtwork?: boolean
}

export function ProgressBar({ playback, item }: { playback?: PlaybackState; item?: QueueItem }) {
  const clock = useServerClock()
  useTicker(playback?.state === 'playing', 1000)
  const progress = playback ? estimateProgressSec(playback, clock.now()) : 0
  const duration = item?.durationMs
  const shown = duration ? Math.min(progress, duration / 1000) : progress
  const fraction = progressFraction(progress, duration)
  return (
    <div className="grid gap-1.5">
      <div
        className="h-[3px] overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label="Song progress (estimated)"
        aria-valuemin={0}
        aria-valuemax={duration ? Math.round(duration / 1000) : undefined}
        aria-valuenow={Math.round(shown)}
      >
        <div className="h-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{formatTime(shown)}</span>
        <span>{duration ? formatTime(duration / 1000) : '–:––'}</span>
      </div>
    </div>
  )
}

function statusLine(playback?: PlaybackState): string | null {
  if (!playback) return null
  if (playback.state === 'paused') return 'Paused'
  if (playback.state === 'blocked') return 'Waiting for the host to press play'
  if (playback.state === 'error') return playback.errorReason ?? 'Playback stopped'
  return null
}

export function NowPlaying({ item, playback, isHost, queueEmpty, busy, onPlay, onPause, onSkip, player, compact, hideArtwork }: NowPlayingProps) {
  const playing = playback?.state === 'playing'
  const line = statusLine(playback)

  if (!item) {
    return (
      <div className="grid gap-4">
        {player}
        <div className={cn('grid gap-3', !player && 'rounded-xl border border-dashed border-border p-6')}>
          <p className="font-display text-3xl leading-tight text-foreground">
            {queueEmpty ? 'Nothing queued yet' : 'Ready when you are'}
          </p>
          <p className="text-muted-foreground">
            {line && playback?.state === 'error'
              ? line
              : queueEmpty
                ? 'Search for a song and add it. The first one starts the night.'
                : isHost
                  ? 'Press play to start the first song in the queue.'
                  : 'The host will start the music soon.'}
          </p>
          {isHost && !queueEmpty && (
            <button
              type="button"
              onClick={onPlay}
              disabled={busy}
              className="inline-flex h-11 w-fit items-center gap-2 rounded-full bg-primary px-5 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="size-4" aria-hidden /> Start the music
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-5">
      {player ?? (hideArtwork ? null : (
        <Artwork src={item.thumbnailUrl} title={item.title} className={cn('w-full', compact ? 'max-w-[280px] justify-self-center' : 'max-w-[420px]')} />
      ))}
      <div className="min-w-0">
        <h2 className="font-display text-[clamp(1.9rem,4vw,2.75rem)] leading-[1.02] text-foreground [overflow-wrap:anywhere]">{item.title}</h2>
        <p className="mt-2 text-muted-foreground">
          {item.creatorLabel ? <>on {item.creatorLabel}&ensp;·&ensp;</> : null}requested by {item.requestedByName}
        </p>
        {line && <p className="mt-2 text-sm text-primary">{line}</p>}
      </div>
      <ProgressBar playback={playback} item={item} />
      {isHost && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={playing ? onPause : onPlay}
            disabled={busy}
            aria-label={playing ? 'Pause' : 'Play'}
            className="grid size-14 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {playing ? <Pause className="size-5" aria-hidden /> : <Play className="size-5 translate-x-px" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            aria-label="Skip to the next song"
            className="grid size-11 place-items-center rounded-full border border-input text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <SkipForward className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
