/**
 * Per-queue-item playback tier + measured analysis badges. Tiers:
 *   AI mix          — authorized waveform source (Audius/Jamendo, or an accepted verified match)
 *   Standard        — YouTube embedded playback only (no audio access)
 *   Couldn't play   — unavailable from any authorized source
 * BPM/key appear only when measured by CrowdPilot's analyzer (never provider metadata).
 */
import type { FeatureRow } from '@/client/dj-hooks'
import type { QueueItem } from '@/domain/types'
import { audioKeyOf } from '@/dj/engine/host-dj'
import { cn } from '@/lib/utils'

export type Tier = 'mixable' | 'embed_only' | 'unavailable'

export function tierOf(item: QueueItem): Tier {
  if (item.status === 'unavailable') return 'unavailable'
  return audioKeyOf(item) ? 'mixable' : 'embed_only'
}

const TIER_LABEL: Record<Tier, string> = { mixable: 'AI mix', embed_only: 'Standard playback', unavailable: "Couldn't play" }

export function TrackBadges({ item, feature }: { item: QueueItem; feature?: FeatureRow }) {
  const tier = tierOf(item)
  const s = feature?.summary
  const matched = !!item.mixTrackKey && item.trackKey.startsWith('youtube:') && item.mixMatch?.status !== 'rejected'
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-none">
      <span
        className={cn(
          'rounded-full border px-1.5 py-0.5',
          tier === 'mixable' ? 'border-primary/60 text-primary' : tier === 'unavailable' ? 'border-destructive/60 text-destructive' : 'border-border text-muted-foreground',
        )}
        title={tier === 'embed_only' ? 'YouTube only allows its embedded player: no audio access, so no beat-matching or EQ.' : undefined}
      >
        {TIER_LABEL[tier]}
        {matched ? ' · Audius match' : ''}
      </span>
      {item.locked && <span className="text-muted-foreground">locked</span>}
      {item.targetStartAt && <span className="text-muted-foreground">at {new Date(item.targetStartAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      {feature?.status === 'failed' && <span className="text-destructive">analysis failed</span>}
      {s && s.bpm > 0 && (
        <span className={cn('tabular-nums', feature?.status === 'low_confidence' ? 'text-warning' : 'text-muted-foreground')}>
          {s.bpm.toFixed(1)} BPM · {s.camelot}
          {feature?.status === 'low_confidence' ? ' · low confidence' : ''}
        </span>
      )}
    </span>
  )
}
