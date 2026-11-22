/**
 * Provider adapter contract (environment-neutral). Discovery runs anywhere; acquisition
 * is implemented per environment (Node research worker: files on disk; browser render
 * worker: in-memory bytes from authorized streams).
 */
import type { DiscoveryQuery } from './discovery'
import type { AccessDecision, AcquiredAudio, SourceId, TrackCandidate } from './types'

export interface ResolvedTrack {
  candidate: TrackCandidate
  /** Authoritative, freshly re-resolved metadata (availability checked now). */
  available: boolean
  reason?: string
  /** Best available encoded format (e.g. 'flac', 'mp3-320', 'opus-160'). */
  bestFormat?: string
}

export interface AudioCapabilities {
  access: AccessDecision
  formats: string[]
  /** Audio is a downloadable file vs. a licensed stream. */
  delivery: 'download' | 'stream' | 'none'
}

export interface AudioSourceProvider {
  readonly id: SourceId
  searchTracks(query: DiscoveryQuery): Promise<TrackCandidate[]>
  resolveTrack(candidate: TrackCandidate): Promise<ResolvedTrack>
  getCapabilities(track: ResolvedTrack): Promise<AudioCapabilities>
  acquireAudio(track: ResolvedTrack, access: AccessDecision): Promise<AcquiredAudio>
}
