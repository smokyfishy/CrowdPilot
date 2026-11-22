import type { Result } from '../../domain/types'

/** Phase 1 ships one provider; the union widens when another is approved (e.g. 'audius'). */
export type TrackSource = 'youtube'

export interface CatalogTrack {
  source: TrackSource
  sourceId: string
  /** Provider-namespaced id, e.g. `youtube:dQw4w9WgXcQ`. */
  trackKey: string
  title: string
  /** For YouTube this is the channel name — never presented as a canonical artist. */
  creatorLabel?: string
  thumbnailUrl?: string
  durationMs?: number
  canonicalUrl?: string
  playable: boolean | 'unknown'
}

export interface MusicCatalogProvider {
  search(query: string, signal?: AbortSignal): Promise<Result<CatalogTrack[]>>
  /** Authoritative metadata for one id; rejects ids that are missing or not playable here. */
  resolve(sourceId: string, signal?: AbortSignal): Promise<Result<CatalogTrack>>
}
