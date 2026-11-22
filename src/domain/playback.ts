/**
 * Host-authoritative playback state machine (Phase 1: sequential, no DJ logic).
 *
 * Every playback-changing plan requires the caller's `expectedRevision` to
 * equal the stored `playbackRevision` and bumps it by one, so a duplicate or
 * stale event (two ENDED callbacks, skip racing an ENDED) can win at most once.
 * The server additionally claims `playback:<revision>` before writing.
 */
import { upNext } from './queue'
import { fail, ok } from './types'
import type { Actor, PlaybackState, QueueItem, Result } from './types'

/** Phase-2 seam: a future AI DJ supplies a different selector. */
export interface NextTrackSelector {
  select(items: QueueItem[]): QueueItem | null
}

export const fifoSelector: NextTrackSelector = {
  select: (items) => upNext(items)[0] ?? null,
}

export const LEASE_MS = 90_000
export const RENEW_MS = 30_000
export const MAX_CONSECUTIVE_FAILURES = 3
export const UNAVAILABLE_ERROR_CODES = [2, 5, 100, 101, 150]

export type AdvanceReason = 'ended' | 'skip' | 'error'

export interface AdvanceInput {
  reason: AdvanceReason
  expectedRevision: number
  controllerId?: string
  errorCode?: number
  /**
   * Phase 2 mix handoff: the host's DJ engine already started this queued item under a
   * committed transition. Only honoured for reason 'ended' from the controller.
   */
  nextItemId?: string
  /** Position (s) the incoming item has already played when the handoff is reported. */
  startPositionSec?: number
}

export interface AdvancePlan {
  finished?: { itemId: string; status: 'played' | 'skipped' | 'unavailable'; failureReason?: string }
  startItemId: string | null
  next: PlaybackState
}

function requireHost(actor: Actor): Result<void> | null {
  return actor.role === 'host' ? null : fail('FORBIDDEN', 'Only the host controls playback.')
}

function requireRevision(s: PlaybackState, expected: number): Result<void> | null {
  return expected === s.playbackRevision
    ? null
    : fail('STALE_REVISION', 'Playback changed in the meantime — refreshing.')
}

function isController(s: PlaybackState, controllerId: string | undefined, now: number): boolean {
  return (
    !!controllerId &&
    s.controllerId === controllerId &&
    s.controllerLeaseUntil !== null &&
    s.controllerLeaseUntil > now
  )
}

export function failureReasonFor(code: number | undefined): string {
  switch (code) {
    case 2:
      return 'The video id was rejected by YouTube.'
    case 5:
      return 'This video could not be played in the browser.'
    case 100:
      return 'This video was removed or made private.'
    case 101:
    case 150:
      return 'The owner does not allow this video to be embedded.'
    default:
      return 'YouTube could not play this video.'
  }
}

function startOrIdle(
  base: PlaybackState,
  items: QueueItem[],
  selector: NextTrackSelector,
  now: number,
  handoff?: { itemId: string; positionSec: number },
): { startItemId: string | null; next: PlaybackState } {
  const forced = handoff ? items.find((i) => i.id === handoff.itemId && i.status === 'queued') : undefined
  const nextItem = forced ?? selector.select(items)
  const startedAt = forced && handoff ? now - Math.max(0, Math.min(handoff.positionSec, 3600)) * 1000 : now
  const common = { playbackRevision: base.playbackRevision + 1, updatedAt: now, pausedAtSec: null }
  if (!nextItem) {
    return {
      startItemId: null,
      next: { ...base, ...common, currentItemId: null, state: 'idle', startedAt: null },
    }
  }
  return {
    startItemId: nextItem.id,
    next: { ...base, ...common, currentItemId: nextItem.id, state: 'playing', startedAt, errorReason: null },
  }
}

export function planAdvance(
  s: PlaybackState,
  items: QueueItem[],
  actor: Actor,
  input: AdvanceInput,
  now: number,
  selector: NextTrackSelector = fifoSelector,
): Result<AdvancePlan> {
  const notHost = requireHost(actor)
  if (notHost) return notHost as Result<AdvancePlan>
  if (input.reason !== 'skip' && !isController(s, input.controllerId, now)) {
    return fail('NOT_CONTROLLER', 'Another device is playing for this room.')
  }
  const stale = requireRevision(s, input.expectedRevision)
  if (stale) return stale as Result<AdvancePlan>

  const remaining = items.filter((i) => i.id !== s.currentItemId)
  let finished: AdvancePlan['finished']
  let failures = s.consecutiveFailures

  if (s.currentItemId) {
    if (input.reason === 'ended') {
      finished = { itemId: s.currentItemId, status: 'played' }
      failures = 0
    } else if (input.reason === 'skip') {
      finished = { itemId: s.currentItemId, status: 'skipped' }
      failures = 0
    } else {
      finished = { itemId: s.currentItemId, status: 'unavailable', failureReason: failureReasonFor(input.errorCode) }
      failures += 1
    }
  }

  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    return ok({
      finished,
      startItemId: null,
      next: {
        ...s,
        currentItemId: null,
        state: 'error',
        startedAt: null,
        pausedAtSec: null,
        consecutiveFailures: failures,
        errorReason: `${failures} songs in a row could not be played. Press play to try the next one.`,
        playbackRevision: s.playbackRevision + 1,
        updatedAt: now,
      },
    })
  }

  const handoff =
    input.reason === 'ended' && input.nextItemId ? { itemId: input.nextItemId, positionSec: input.startPositionSec ?? 0 } : undefined
  const { startItemId, next } = startOrIdle({ ...s, consecutiveFailures: failures }, remaining, selector, now, handoff)
  return ok({ finished, startItemId, next })
}

export function planPlay(
  s: PlaybackState,
  items: QueueItem[],
  actor: Actor,
  input: { expectedRevision: number; controllerId?: string; positionSec?: number },
  now: number,
  selector: NextTrackSelector = fifoSelector,
): Result<{ startItemId: string | null; next: PlaybackState }> {
  const notHost = requireHost(actor)
  if (notHost) return notHost as Result<never>
  const stale = requireRevision(s, input.expectedRevision)
  if (stale) return stale as Result<never>

  if (s.currentItemId) {
    const position = input.positionSec ?? s.pausedAtSec ?? (s.startedAt ? (now - s.startedAt) / 1000 : 0)
    return ok({
      startItemId: null,
      next: {
        ...s,
        state: 'playing',
        startedAt: now - Math.max(0, position) * 1000,
        pausedAtSec: null,
        errorReason: null,
        playbackRevision: s.playbackRevision + 1,
        updatedAt: now,
      },
    })
  }

  const started = startOrIdle({ ...s, consecutiveFailures: 0 }, items, selector, now)
  if (!started.startItemId) return fail('INVALID', 'The queue is empty — add a song first.')
  return ok(started)
}

export function planPause(
  s: PlaybackState,
  actor: Actor,
  input: { expectedRevision: number; positionSec: number; controllerId?: string },
  now: number,
): Result<PlaybackState> {
  const notHost = requireHost(actor)
  if (notHost) return notHost as Result<never>
  const stale = requireRevision(s, input.expectedRevision)
  if (stale) return stale as Result<never>
  if (!s.currentItemId) return fail('INVALID', 'Nothing is playing.')
  return ok({
    ...s,
    state: 'paused',
    pausedAtSec: Math.max(0, input.positionSec),
    startedAt: null,
    playbackRevision: s.playbackRevision + 1,
    updatedAt: now,
  })
}

export function planBlocked(
  s: PlaybackState,
  actor: Actor,
  input: { expectedRevision: number; controllerId: string },
  now: number,
): Result<PlaybackState> {
  const notHost = requireHost(actor)
  if (notHost) return notHost as Result<never>
  if (!isController(s, input.controllerId, now)) return fail('NOT_CONTROLLER', 'Another device is playing for this room.')
  const stale = requireRevision(s, input.expectedRevision)
  if (stale) return stale as Result<never>
  return ok({ ...s, state: 'blocked', playbackRevision: s.playbackRevision + 1, updatedAt: now })
}

export function planClaimController(
  s: PlaybackState,
  actor: Actor,
  input: { controllerId: string; takeover: boolean },
  now: number,
): Result<PlaybackState> {
  const notHost = requireHost(actor)
  if (notHost) return notHost as Result<never>
  const free = !s.controllerId || s.controllerLeaseUntil === null || s.controllerLeaseUntil <= now
  if (!free && s.controllerId !== input.controllerId && !input.takeover) {
    return fail('FORBIDDEN', 'Music is playing on another of your devices.')
  }
  return ok({ ...s, controllerId: input.controllerId, controllerLeaseUntil: now + LEASE_MS, updatedAt: now })
}

export function planRenewLease(s: PlaybackState, actor: Actor, controllerId: string, now: number): Result<PlaybackState> {
  const notHost = requireHost(actor)
  if (notHost) return notHost as Result<never>
  if (s.controllerId !== controllerId) return fail('NOT_CONTROLLER', 'Another device took over playback.')
  return ok({ ...s, controllerLeaseUntil: now + LEASE_MS })
}

export function estimateProgressSec(s: PlaybackState, serverNow: number): number {
  if (!s.currentItemId) return 0
  if (s.state === 'playing' && s.startedAt !== null) return Math.max(0, (serverNow - s.startedAt) / 1000)
  return s.pausedAtSec ?? 0
}
