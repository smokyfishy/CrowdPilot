/**
 * Shared types for the prompt-to-mix pipeline. Environment-neutral: the same
 * modules run in the Cloudflare Worker (discovery), the browser render worker
 * (deployed generation) and Node (research worker + end-to-end tests).
 */
import type { AnalysisSummary } from '../dsp/analyze'

export type SourceId = 'youtube' | 'jamendo' | 'audius'

/** Normalized identity of a recording, provider-independent. */
export interface RecordingIdentity {
  /** Normalized primary artist ("john summit"). */
  artist: string
  /** Normalized base title without version/feat tags ("where you are"). */
  title: string
  /** Normalized version tag ("extended mix", "fisher remix", "" = original). */
  version: string
  featured: string[]
  /** Stable key used for dedupe across providers. */
  key: string
}

/** Provider-specific popularity signal — never presented as a universal score. */
export interface PopularitySignal {
  source: SourceId
  kind: 'youtube_views' | 'jamendo_listens' | 'jamendo_downloads' | 'audius_plays' | 'none'
  value: number
}

export interface TrackCandidate {
  trackKey: string // `${source}:${sourceId}`
  source: SourceId
  sourceId: string
  title: string
  artist: string
  /** Original upload title as published (YouTube), before cleaning. */
  rawTitle?: string
  /** Channel / uploader label as reported (YouTube: channel, never treated as artist). */
  uploader?: string
  durationSec?: number
  url?: string
  thumbnailUrl?: string
  publishedAt?: string
  genres: string[]
  tags: string[]
  popularity: PopularitySignal
  identity: RecordingIdentity
  /** Version clues found in the metadata. */
  versionClues: string[]
  /** Licence as stated by the provider. */
  license: { basis: string; label: string; url?: string }
  /** Why discovery returned it (artist query, genre query, similar artist…). */
  matchedBy: string[]
  /** Official upload (verified artist / official channel / "- Topic"). */
  official: boolean
  providerBpm?: number
  /** Provider vocal/instrumental tag when available (Jamendo). */
  vocalTag?: 'vocal' | 'instrumental'
}

/** Result of the central source-access policy for one candidate. */
export interface AccessDecision {
  acquire: boolean
  analyze: boolean
  mix: boolean
  /** May the rendered mix containing this track be stored server-side (private to the user)? */
  persistRender: boolean
  /** May the user download the rendered mix? */
  export: boolean
  /** May the decoded/acquired audio be cached across sessions? */
  cacheAudio: boolean
  attributionRequired: boolean
  /** Access method used when acquire = true. */
  method: 'jamendo_api' | 'audius_stream' | 'yt_dlp_authorized' | 'yt_dlp_research' | 'none'
  /** Where an allowed export may go: 'local' = the operator's machine only (research mode). */
  exportScope?: 'any' | 'local'
  reason: string
  policyVersion: string
  /** Why acquisition is allowed for YouTube: an operator grant, or a CC BY licence from the official channel. */
  basis?: 'grant' | 'official-cc-by'
}

export type AcquisitionStatus = 'pending' | 'acquired' | 'cached' | 'unavailable' | 'failed' | 'not_permitted'

export interface AcquiredAudio {
  trackKey: string
  /** Content hash (sha-256 hex) of the original encoded bytes. */
  sha256: string
  bytes: number
  container: string
  codec?: string
  sampleRate?: number
  channels?: number
  durationSec?: number
  /** How it was obtained (provenance). */
  method: AccessDecision['method']
  acquiredAt: string
  /** Opaque storage handle (never a filesystem path in client-visible data). */
  handle: string
  /** When a fallback upload/source was used: the trackKey actually downloaded. */
  sourceKey?: string
}

/** A requested artist/song the pipeline could not satisfy, reported honestly. */
export interface Unavailability {
  request: string
  kind: 'artist' | 'song'
  reason: string
  searched: SourceId[]
  substitutedWith?: string[]
}

export interface AnalyzedTrack {
  candidate: TrackCandidate
  access: AccessDecision
  audio: AcquiredAudio
  summary: AnalysisSummary
  /** Per-bar energy (dB) for energy-arc planning (length = bars). */
  barEnergy: number[]
  /** First bar start (s) and bar length (s) aligned with barEnergy. */
  barStartSec: number
  /** Section map for drops/breakdowns. */
  sections: Array<{ kind: string; startSec: number; endSec: number }>
  /** Low-band (bass) mean energy (dB), for bass-overlap decisions. */
  bassDb: number
}

export const STAGES = [
  'understanding',
  'discovering',
  'resolving',
  'acquiring',
  'analyzing',
  'selecting',
  'ordering',
  'transitions',
  'rendering',
  'validating',
  'ready',
] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABEL: Record<Stage, string> = {
  understanding: 'Understanding request',
  discovering: 'Discovering songs',
  resolving: 'Resolving audio sources',
  acquiring: 'Acquiring audio',
  analyzing: 'Analyzing recordings',
  selecting: 'Selecting songs',
  ordering: 'Planning track order',
  transitions: 'Generating transitions',
  rendering: 'Rendering mix',
  validating: 'Validating audio',
  ready: 'Ready to play',
}

/** Progress event: `done`/`total` are counts of real completed units in the stage. */
export interface ProgressEvent {
  stage: Stage
  done: number
  total: number
  detail?: string
}
