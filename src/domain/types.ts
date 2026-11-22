/**
 * Pure domain types shared by the worker command layer and the client.
 * No SDK imports here — this module must stay runnable in plain Node tests.
 */

export type MemberRole = 'host' | 'guest'

export type QueueStatus = 'queued' | 'playing' | 'played' | 'skipped' | 'removed' | 'unavailable'

export interface Actor {
  memberId: string
  identityKey: string
  role: MemberRole
  displayName: string
  signedIn: boolean
}

export interface TrackRef {
  trackKey: string
  title: string
  creatorLabel?: string
  thumbnailUrl?: string
  durationMs?: number
  rights?: { basis: string; label?: string; needsReview: boolean }
}

export interface QueueItem extends TrackRef {
  id: string
  requestedByMemberId: string
  requestedByName: string
  enqueueSeq: number
  sortKey: string
  pinnedAt: number | null
  status: QueueStatus
  voteCount: number
  createdAt: number
  /** Server time the item left the active set (played/skipped/unavailable/removed). */
  finishedAt?: number
  failureReason?: string
  /** Phase 2: authorized waveform source used for mixing (e.g. a verified Audius match for a YouTube request). */
  mixTrackKey?: string
  mixMatch?: { confidence: number; reasons: string[]; status: 'auto' | 'accepted' | 'rejected' }
  /** Phase 2: host timed slot (epoch ms). */
  targetStartAt?: number
  /** Phase 2: host position lock against AI reordering. */
  locked?: boolean
  /** Phase 2: licence basis of the waveform source (server-resolved at enqueue). */
  rights?: { basis: string; label?: string; needsReview: boolean }
}

export type DjStatus = 'idle' | 'analyzing' | 'ready' | 'proposed' | 'committed' | 'mixing' | 'safe_fallback' | 'failed'
export type DjStyle = 'balanced' | 'smooth' | 'energetic' | 'creative'

/** Compact, synced description of the proposed/committed transition (the full plan stays in the host browser). */
export interface TransitionSummary {
  fromItemId: string
  toItemId: string
  style: string
  outCueSec: number
  inCueSec: number
  overlapBars: number
  tempoRatio: number
  /** Epoch ms (server clock) the transition is scheduled to start, when committed. */
  startsAt?: number
  cost?: number
  costs?: Record<string, number>
  risks?: string[]
  reasons?: string[]
  alternatives?: Array<{ style: string; cost: number }>
}

export interface DjState {
  autopilot: boolean
  aiReorder: boolean
  maxTempoPct: number
  style: DjStyle
  allowOmlMixing: boolean
  status: DjStatus
  statusNote: string
  transition: TransitionSummary | null
  planRevision: number
  basedOnPlaybackRevision: number | null
  updatedAt: number
}

export const DEFAULT_DJ_STATE: DjState = {
  autopilot: false,
  aiReorder: false,
  maxTempoPct: 6,
  style: 'balanced',
  allowOmlMixing: true,
  status: 'idle',
  statusNote: '',
  transition: null,
  planRevision: 0,
  basedOnPlaybackRevision: null,
  updatedAt: 0,
}

export interface RoomState {
  roomId: string
  code?: string
  name: string
  hostUserId: string
  hostName: string
  status: 'open' | 'closed' | 'expired'
  guestRequestsEnabled: boolean
  allowAnonymousGuests: boolean
  perGuestLimit: number
  queueRevision: number
  nextEnqueueSeq: number
  lastActivityAt: number
}

export type PlayerState = 'idle' | 'playing' | 'paused' | 'blocked' | 'error'

export interface PlaybackState {
  currentItemId: string | null
  state: PlayerState
  startedAt: number | null
  pausedAtSec: number | null
  playbackRevision: number
  controllerId: string | null
  controllerLeaseUntil: number | null
  errorReason: string | null
  consecutiveFailures: number
  updatedAt: number
}

export interface Member {
  id: string
  identityKey: string
  displayName: string
  role: MemberRole
  status: 'active' | 'kicked'
  joinedAt: number
  signedIn: boolean
}

export type RoomEventType =
  | 'join'
  | 'enqueue'
  | 'remove'
  | 'skip'
  | 'now_playing'
  | 'kick'
  | 'settings'
  | 'closed'
  | 'dj'

export interface RoomEvent {
  id: string
  type: RoomEventType
  actorName: string
  queueItemId?: string
  payload?: Record<string, unknown>
  createdAt: number
}

export interface Reaction {
  id: string
  memberId: string
  memberName: string
  emoji: string
  createdAt: number
}

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'KICKED'
  | 'ROOM_CLOSED'
  | 'REQUESTS_LOCKED'
  | 'DUPLICATE'
  | 'LIMIT_REACHED'
  | 'NOT_FOUND'
  | 'STALE_REVISION'
  | 'NOT_CONTROLLER'
  | 'RATE_LIMITED'
  | 'INVALID'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'QUOTA'
  | 'UPSTREAM'

export interface DomainError {
  code: ErrorCode
  message: string
  existingItemId?: string
  retryAfterMs?: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const okVoid: Result<void> = { ok: true, value: undefined }
export const fail = <T = never>(
  code: ErrorCode,
  message: string,
  extra: Partial<DomainError> = {},
): Result<T> => ({ ok: false, error: { code, message, ...extra } })
