import { describe, expect, it } from 'vitest'
import {
  addButtonState,
  announcementFor,
  clockOffset,
  formatTime,
  onlineMemberIds,
  progressFraction,
  showRemove,
} from './view-model'
import type { Actor, QueueItem } from '../../domain/types'

const guest: Actor = { memberId: 'g', identityKey: 'guest:g', role: 'guest', displayName: 'Gus', signedIn: false }
const host: Actor = { memberId: 'h', identityKey: 'user:h', role: 'host', displayName: 'Hana', signedIn: true }
const item = (p: Partial<QueueItem> = {}): QueueItem => ({
  id: 'i', trackKey: 'youtube:x', title: 'Song', requestedByMemberId: 'g', requestedByName: 'Gus', enqueueSeq: 1,
  sortKey: 'a0', pinnedAt: null, status: 'queued', voteCount: 0, createdAt: 0, ...p,
})

describe('formatTime', () => {
  it('formats minutes and seconds, and hours when needed', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(102.7)).toBe('1:42')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(-5)).toBe('0:00')
  })
})

describe('progressFraction', () => {
  it('clamps to [0, 1] and is 0 without a known duration', () => {
    expect(progressFraction(30, 120_000)).toBeCloseTo(0.25)
    expect(progressFraction(500, 120_000)).toBe(1)
    expect(progressFraction(30, undefined)).toBe(0)
  })
})

describe('showRemove', () => {
  it('shows remove only on the guest’s own queued items, and on any active item for the host', () => {
    expect(showRemove(guest, item())).toBe(true)
    expect(showRemove(guest, item({ requestedByMemberId: 'other' }))).toBe(false)
    expect(showRemove(guest, item({ status: 'playing' }))).toBe(false)
    expect(showRemove(host, item({ requestedByMemberId: 'other', status: 'playing' }))).toBe(true)
    expect(showRemove(undefined, item())).toBe(false)
  })
})

describe('addButtonState', () => {
  it('maps queue state and errors to the add button', () => {
    expect(addButtonState('youtube:x', new Set(['youtube:x']), undefined)).toBe('in-queue')
    expect(addButtonState('youtube:y', new Set(), 'DUPLICATE')).toBe('vote-instead')
    expect(addButtonState('youtube:y', new Set(), 'adding')).toBe('adding')
    expect(addButtonState('youtube:y', new Set(), undefined)).toBe('add')
  })
})

describe('announcementFor', () => {
  it('describes queue events for screen readers', () => {
    expect(announcementFor({ id: 'e', type: 'enqueue', actorName: 'Ann', payload: { title: 'Nightcall' }, createdAt: 0 })).toBe('Ann added Nightcall')
    expect(announcementFor({ id: 'e', type: 'skip', actorName: 'Hana', createdAt: 0 })).toBe('Hana skipped a song')
    expect(announcementFor({ id: 'e', type: 'join', actorName: 'Sam', createdAt: 0 })).toBe('Sam joined')
  })
})

describe('clockOffset', () => {
  it('estimates server minus client time at the request midpoint', () => {
    expect(clockOffset(10_500, 10_000, 10_200)).toBe(400)
  })
})

describe('onlineMemberIds', () => {
  it('collects member ids from presence state and signed-in user ids', () => {
    const members = [
      { id: 'm1', identityKey: 'user:u1' },
      { id: 'm2', identityKey: 'guest:x' },
      { id: 'm3', identityKey: 'user:u3' },
    ]
    const peers = [
      { userId: 'u1', state: {} },
      { userId: 'anon-1', state: { memberId: 'm2' } },
    ]
    expect([...onlineMemberIds(members, peers, 'm3')].sort()).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('final-review UI fixes', () => {
  it('moveBounds uses the position among unpinned items', async () => {
    const { moveBounds } = await import('./view-model')
    const unpinned = [item({ id: 'u1' }), item({ id: 'u2' })]
    expect(moveBounds('u1', unpinned)).toEqual({ canUp: false, canDown: true })
    expect(moveBounds('u2', unpinned)).toEqual({ canUp: true, canDown: false })
    expect(moveBounds('pinned', unpinned)).toEqual({ canUp: false, canDown: false })
  })

  it('enqueueKey is unique per add attempt so remove-then-re-add works', async () => {
    const { enqueueKey } = await import('./view-model')
    expect(enqueueKey('youtube:x')).not.toBe(enqueueKey('youtube:x'))
  })

  it('pruneFloating removes expired reaction floaters regardless of re-renders', async () => {
    const { pruneFloating } = await import('./view-model')
    const list = [{ id: 'a', expiresAt: 100 }, { id: 'b', expiresAt: 300 }]
    expect(pruneFloating(list, 200).map((r) => r.id)).toEqual(['b'])
  })
})
