import { describe, expect, it } from 'vitest'
import { history, sortKeyAfterLast, sortKeyBetween, upNext } from './queue'
import type { QueueItem } from './types'

let seq = 0
function item(partial: Partial<QueueItem> = {}): QueueItem {
  seq += 1
  return {
    id: `i${seq}`,
    trackKey: `youtube:v${seq}`,
    title: `Track ${seq}`,
    requestedByMemberId: 'm1',
    requestedByName: 'Ann',
    enqueueSeq: seq,
    sortKey: `a${seq}`,
    pinnedAt: null,
    status: 'queued',
    voteCount: 0,
    createdAt: seq,
    ...partial,
  }
}

describe('upNext', () => {
  it('orders pinned first by pinnedAt, then sortKey, then enqueueSeq', () => {
    const a = item({ id: 'a', sortKey: 'a2', enqueueSeq: 1 })
    const b = item({ id: 'b', sortKey: 'a1', enqueueSeq: 2 })
    const c = item({ id: 'c', sortKey: 'a1', enqueueSeq: 3 })
    const p2 = item({ id: 'p2', sortKey: 'a9', pinnedAt: 200 })
    const p1 = item({ id: 'p1', sortKey: 'a8', pinnedAt: 100 })
    expect(upNext([a, b, c, p2, p1]).map((i) => i.id)).toEqual(['p1', 'p2', 'b', 'c', 'a'])
  })

  it('excludes playing, played and removed items', () => {
    const q = item({ id: 'q' })
    const items = [
      q,
      item({ status: 'playing' }),
      item({ status: 'played' }),
      item({ status: 'removed' }),
      item({ status: 'skipped' }),
      item({ status: 'unavailable' }),
    ]
    expect(upNext(items).map((i) => i.id)).toEqual(['q'])
  })
})

describe('sort keys', () => {
  it('sortKeyAfterLast sorts after every existing key', () => {
    const items = [item({ sortKey: sortKeyBetween(null, null) })]
    items.push(item({ sortKey: sortKeyAfterLast(items) }))
    items.push(item({ sortKey: sortKeyAfterLast(items) }))
    const next = sortKeyAfterLast(items)
    for (const i of items) expect(next > i.sortKey).toBe(true)
  })

  it('sortKeyAfterLast works on an empty queue', () => {
    expect(typeof sortKeyAfterLast([])).toBe('string')
  })

  it('sortKeyBetween(a, b) yields a < k < b and handles open ends', () => {
    const a = sortKeyBetween(null, null)
    const b = sortKeyBetween(a, null)
    const k = sortKeyBetween(a, b)
    expect(a < k && k < b).toBe(true)
    expect(sortKeyBetween(null, a) < a).toBe(true)
  })
})

describe('history', () => {
  it('returns finished items newest first and caps at limit', () => {
    const items = [
      item({ id: 'old', status: 'played', enqueueSeq: 1 }),
      item({ id: 'mid', status: 'skipped', enqueueSeq: 2 }),
      item({ id: 'new', status: 'unavailable', enqueueSeq: 3 }),
      item({ id: 'q', status: 'queued', enqueueSeq: 4 }),
      item({ id: 'r', status: 'removed', enqueueSeq: 5 }),
    ]
    expect(history(items).map((i) => i.id)).toEqual(['new', 'mid', 'old'])
    expect(history(items, 2).map((i) => i.id)).toEqual(['new', 'mid'])
  })

  it('prefers finishedAt over enqueueSeq when present', () => {
    const items = [
      item({ id: 'a', status: 'played', enqueueSeq: 1, finishedAt: 50 }),
      item({ id: 'b', status: 'played', enqueueSeq: 2, finishedAt: 10 }),
    ]
    expect(history(items).map((i) => i.id)).toEqual(['a', 'b'])
  })
})
