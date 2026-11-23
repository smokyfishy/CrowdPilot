import { describe, expect, it } from 'vitest'
import {
  checkCanJoin,
  checkEnqueue,
  checkHost,
  checkRemove,
  checkRoomOpen,
  checkVote,
  sanitizeDisplayName,
} from './rules'
import type { Actor, QueueItem, Result, RoomState } from './types'

const host: Actor = { memberId: 'h', identityKey: 'user:h', role: 'host', displayName: 'Host', signedIn: true }
const guest: Actor = { memberId: 'g', identityKey: 'guest:g', role: 'guest', displayName: 'Gus', signedIn: false }

function room(p: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 'r',
    name: 'Room',
    hostUserId: 'h',
    hostName: 'Host',
    status: 'open',
    guestRequestsEnabled: true,
    allowAnonymousGuests: true,
    perGuestLimit: 3,
    queueRevision: 0,
    nextEnqueueSeq: 1,
    lastActivityAt: 0,
    ...p,
  }
}

let n = 0
function item(p: Partial<QueueItem> = {}): QueueItem {
  n += 1
  return {
    id: `i${n}`,
    trackKey: `youtube:v${n}`,
    title: 't',
    requestedByMemberId: 'g',
    requestedByName: 'Gus',
    enqueueSeq: n,
    sortKey: `a${n}`,
    pinnedAt: null,
    status: 'queued',
    voteCount: 0,
    createdAt: n,
    ...p,
  }
}

const code = (r: Result<unknown>) => (r.ok ? 'OK' : r.error.code)

describe('checkRoomOpen', () => {
  it('rejects closed and expired rooms', () => {
    expect(code(checkRoomOpen(room()))).toBe('OK')
    expect(code(checkRoomOpen(room({ status: 'closed' })))).toBe('ROOM_CLOSED')
    expect(code(checkRoomOpen(room({ status: 'expired' })))).toBe('ROOM_CLOSED')
  })
})

describe('checkEnqueue', () => {
  it('rejects when room closed (ROOM_CLOSED)', () => {
    expect(code(checkEnqueue(guest, room({ status: 'closed' }), [], 'youtube:x'))).toBe('ROOM_CLOSED')
  })

  it('rejects guest when guestRequestsEnabled=false but allows host', () => {
    const r = room({ guestRequestsEnabled: false })
    expect(code(checkEnqueue(guest, r, [], 'youtube:x'))).toBe('REQUESTS_LOCKED')
    expect(code(checkEnqueue(host, r, [], 'youtube:x'))).toBe('OK')
  })

  it('rejects duplicate active trackKey with existingItemId', () => {
    const existing = item({ trackKey: 'youtube:dup', status: 'playing', requestedByMemberId: 'other' })
    const r = checkEnqueue(guest, room(), [existing], 'youtube:dup')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('DUPLICATE')
      expect(r.error.existingItemId).toBe(existing.id)
    }
  })

  it('allows re-adding a track that was played', () => {
    const played = item({ trackKey: 'youtube:again', status: 'played' })
    expect(code(checkEnqueue(guest, room(), [played], 'youtube:again'))).toBe('OK')
  })

  it('rejects guest at perGuestLimit=3 queued items, host unlimited', () => {
    const mine = [item(), item(), item()]
    expect(code(checkEnqueue(guest, room(), mine, 'youtube:new'))).toBe('LIMIT_REACHED')
    const hostItems = [1, 2, 3, 4].map(() => item({ requestedByMemberId: 'h' }))
    expect(code(checkEnqueue(host, room(), hostItems, 'youtube:new'))).toBe('OK')
  })

  it('does not count played or playing items toward the guest limit', () => {
    const mine = [item(), item(), item({ status: 'played' }), item({ status: 'playing' })]
    expect(code(checkEnqueue(guest, room(), mine, 'youtube:new'))).toBe('OK')
  })

  it('rejects malformed track keys', () => {
    expect(code(checkEnqueue(guest, room(), [], 'spotify:abc'))).toBe('INVALID')
    expect(code(checkEnqueue(guest, room(), [], 'youtube:'))).toBe('INVALID')
  })
})

describe('checkVote', () => {
  it('allows voting on queued or playing items only', () => {
    expect(code(checkVote(guest, item()))).toBe('OK')
    expect(code(checkVote(guest, item({ status: 'playing' })))).toBe('OK')
    expect(code(checkVote(guest, item({ status: 'played' })))).toBe('INVALID')
    expect(code(checkVote(guest, undefined))).toBe('NOT_FOUND')
  })
})

describe('checkRemove', () => {
  it('guest may remove own queued item, not own playing item, not others', () => {
    expect(code(checkRemove(guest, item()))).toBe('OK')
    expect(code(checkRemove(guest, item({ status: 'playing' })))).toBe('FORBIDDEN')
    expect(code(checkRemove(guest, item({ requestedByMemberId: 'x' })))).toBe('FORBIDDEN')
  })

  it('host may remove any queued or playing item', () => {
    expect(code(checkRemove(host, item({ requestedByMemberId: 'x' })))).toBe('OK')
    expect(code(checkRemove(host, item({ status: 'playing' })))).toBe('OK')
    expect(code(checkRemove(host, item({ status: 'played' })))).toBe('INVALID')
    expect(code(checkRemove(host, undefined))).toBe('NOT_FOUND')
  })
})

describe('checkHost', () => {
  it('rejects guest FORBIDDEN', () => {
    expect(code(checkHost(guest))).toBe('FORBIDDEN')
    expect(code(checkHost(host))).toBe('OK')
  })
})

describe('checkCanJoin', () => {
  it('rejects kicked, anonymous when disabled, and closed/expired rooms', () => {
    expect(code(checkCanJoin(room(), true, true))).toBe('KICKED')
    expect(code(checkCanJoin(room({ allowAnonymousGuests: false }), false, false))).toBe('UNAUTHENTICATED')
    expect(code(checkCanJoin(room({ allowAnonymousGuests: false }), true, false))).toBe('OK')
    expect(code(checkCanJoin(room({ status: 'closed' }), true, false))).toBe('ROOM_CLOSED')
    expect(code(checkCanJoin(room({ status: 'expired' }), true, false))).toBe('ROOM_CLOSED')
    expect(code(checkCanJoin(room(), false, false))).toBe('OK')
  })
})

describe('sanitizeDisplayName', () => {
  it('trims and collapses whitespace', () => {
    const r = sanitizeDisplayName('  Ada   Lovelace ')
    expect(r.ok && r.value).toBe('Ada Lovelace')
  })

  it('strips control characters', () => {
    const r = sanitizeDisplayName('Ad\u0000a\u001f')
    expect(r.ok && r.value).toBe('Ada')
  })

  it('rejects empty and names longer than 32 characters', () => {
    expect(code(sanitizeDisplayName('   '))).toBe('INVALID')
    expect(code(sanitizeDisplayName('x'.repeat(33)))).toBe('INVALID')
    expect(code(sanitizeDisplayName('x'.repeat(32)))).toBe('OK')
  })
})
