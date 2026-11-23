import type { Result } from '../../domain/types'

/**
 * Catalog sources. YouTube = discovery + official embedded playback only (no audio
 * access). Audius / Jamendo = authorized full-audio streams the host browser can
 * decode for analysis and mixing (see docs/DJ_AI_ARCHITECTURE.md for the rights basis).
 */
export type TrackSource = 'youtube' | 'audius' | 'jamendo'

/** How a track can be played in CrowdPilot. */
export type Mixability = 'mixable' | 'embed_only' | 'unavailable'

export interface RightsInfo {
  /** Machine-readable basis, e.g. 'audius-oml', 'cc-by-nc-sa-3.0', 'youtube-embed'. */
  basis: string
  /** Human-readable licence label from the provider. */
  label?: string
  licenseUrl?: string
  /** Audius: uploader is a verified artist account. */
  uploaderVerified?: boolean
  /** True when live mixing under this basis still needs a human rights review. */
  mixingNeedsReview?: boolean
}

export interface CatalogTrack {
  source: TrackSource
  sourceId: string
  /** Provider-namespaced id, e.g. `youtube:dQw4w9WgXcQ`, `audius:bVrd2zW`, `jamendo:1886257`. */
  trackKey: string
  title: string
  /** For YouTube this is the channel name — never presented as a canonical artist. */
  creatorLabel?: string
  thumbnailUrl?: string
  durationMs?: number
  canonicalUrl?: string
  playable: boolean | 'unknown'
  mixability?: Mixability
  rights?: RightsInfo
  /** Provider-supplied tempo/key (NOT measured by CrowdPilot; display-only, labelled as such). */
  providerBpm?: number
  providerKey?: string
  isrc?: string
}

export interface MusicCatalogProvider {
  search(query: string, signal?: AbortSignal): Promise<Result<CatalogTrack[]>>
  /** Authoritative metadata for one id; rejects ids that are missing or not playable here. */
  resolve(sourceId: string, signal?: AbortSignal): Promise<Result<CatalogTrack>>
}

export function sourceOf(trackKey: string): TrackSource | null {
  const p = trackKey.split(':', 1)[0]
  return p === 'youtube' || p === 'audius' || p === 'jamendo' ? p : null
}

/** Sources whose audio the host browser may decode (subject to per-track rights). */
export function isWaveformSource(trackKey: string): boolean {
  const s = sourceOf(trackKey)
  return s === 'audius' || s === 'jamendo'
}
