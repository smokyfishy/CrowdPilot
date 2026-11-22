import { ACTIVE } from './queue'
import { fail, ok, okVoid } from './types'
import type { Actor, QueueItem, Result, RoomState } from './types'

const TRACK_KEY = /^youtube:[A-Za-z0-9_-]{1,64}$/

export function checkRoomOpen(room: RoomState): Result<void> {
  if (room.status !== 'open') return fail('ROOM_CLOSED', 'This room has ended.')
  return okVoid
}

export function checkHost(actor: Actor): Result<void> {
  if (actor.role !== 'host') return fail('FORBIDDEN', 'Only the host can do that.')
  return okVoid
}

export function checkEnqueue(actor: Actor, room: RoomState, items: QueueItem[], trackKey: string): Result<void> {
  const open = checkRoomOpen(room)
  if (!open.ok) return open
  if (!TRACK_KEY.test(trackKey)) return fail('INVALID', 'That track cannot be added.')
  if (actor.role !== 'host' && !room.guestRequestsEnabled) {
    return fail('REQUESTS_LOCKED', 'The host has paused song requests.')
  }
  const duplicate = items.find((i) => i.trackKey === trackKey && ACTIVE.has(i.status))
  if (duplicate) {
    return fail('DUPLICATE', 'That song is already in the queue — vote for it instead.', {
      existingItemId: duplicate.id,
    })
  }
  if (actor.role !== 'host') {
    const mine = items.filter((i) => i.requestedByMemberId === actor.memberId && i.status === 'queued').length
    if (mine >= room.perGuestLimit) {
      return fail('LIMIT_REACHED', `You can have up to ${room.perGuestLimit} songs waiting at a time.`)
    }
  }
  return okVoid
}

export function checkVote(_actor: Actor, item: QueueItem | undefined): Result<void> {
  if (!item) return fail('NOT_FOUND', 'That song is no longer in the queue.')
  if (!ACTIVE.has(item.status)) return fail('INVALID', 'You can only vote on queued or playing songs.')
  return okVoid
}

export function checkRemove(actor: Actor, item: QueueItem | undefined): Result<void> {
  if (!item) return fail('NOT_FOUND', 'That song is no longer in the queue.')
  if (!ACTIVE.has(item.status)) return fail('INVALID', 'That song has already finished.')
  if (actor.role === 'host') return okVoid
  if (item.requestedByMemberId !== actor.memberId || item.status !== 'queued') {
    return fail('FORBIDDEN', 'You can only remove your own songs before they play.')
  }
  return okVoid
}

export function checkCanJoin(room: RoomState, signedIn: boolean, kicked: boolean): Result<void> {
  const open = checkRoomOpen(room)
  if (!open.ok) return open
  if (kicked) return fail('KICKED', 'The host removed you from this room.')
  if (!signedIn && !room.allowAnonymousGuests) {
    return fail('UNAUTHENTICATED', 'This room requires signing in to join.')
  }
  return okVoid
}

export function sanitizeDisplayName(raw: string): Result<string> {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  if (cleaned.length < 1 || cleaned.length > 32) {
    return fail('INVALID', 'Display names must be 1–32 characters.')
  }
  return ok(cleaned)
}
