import { generateKeyBetween } from 'fractional-indexing'
import type { QueueItem, QueueStatus } from './types'

/** Statuses that occupy the queue (block duplicates, count toward limits). */
export const ACTIVE: ReadonlySet<QueueStatus> = new Set<QueueStatus>(['queued', 'playing'])

const FINISHED: ReadonlySet<QueueStatus> = new Set<QueueStatus>(['played', 'skipped', 'unavailable'])

function compareUpNext(a: QueueItem, b: QueueItem): number {
  const aPinned = a.pinnedAt !== null
  const bPinned = b.pinnedAt !== null
  if (aPinned !== bPinned) return aPinned ? -1 : 1
  if (aPinned && bPinned && a.pinnedAt !== b.pinnedAt) return (a.pinnedAt as number) - (b.pinnedAt as number)
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1
  return a.enqueueSeq - b.enqueueSeq
}

/** Items waiting to play, in authoritative order: pinned (oldest pin first), then sortKey, then enqueueSeq. */
export function upNext(items: QueueItem[]): QueueItem[] {
  return items.filter((i) => i.status === 'queued').sort(compareUpNext)
}

/** Finished items, newest first. */
export function history(items: QueueItem[], limit = 30): QueueItem[] {
  return items
    .filter((i) => FINISHED.has(i.status))
    .sort((a, b) => (b.finishedAt ?? b.enqueueSeq) - (a.finishedAt ?? a.enqueueSeq) || b.enqueueSeq - a.enqueueSeq)
    .slice(0, limit)
}

export function sortKeyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after)
}

/** A key that sorts after every existing item's key (new requests go to the end). */
export function sortKeyAfterLast(items: QueueItem[]): string {
  let max: string | null = null
  for (const i of items) if (max === null || i.sortKey > max) max = i.sortKey
  return generateKeyBetween(max, null)
}
