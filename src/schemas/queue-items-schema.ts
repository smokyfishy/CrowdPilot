import type { CollectionSchema } from 'deepspace/schema'
import { num, readOnly, text } from './columns'
import { C } from './names'

export const queueItemsSchema: CollectionSchema = {
  name: C.queue,
  columns: [
    text('trackKey', { required: true, immutable: true }),
    text('title', { required: true, maxLength: 200 }),
    text('creatorLabel', { maxLength: 120 }),
    text('thumbnailUrl', { maxLength: 500 }),
    num('durationMs'),
    text('requestedByMemberId', { required: true }),
    text('requestedByName', { maxLength: 32 }),
    num('enqueueSeq', { required: true, immutable: true }),
    text('sortKey', { required: true }),
    num('pinnedAt'),
    text('status', {
      interpretation: { kind: 'select', options: ['queued', 'playing', 'played', 'skipped', 'removed', 'unavailable'] },
    }),
    num('voteCount', { default: 0 }),
    num('createdAt'),
    num('finishedAt'),
    text('failureReason', { maxLength: 200 }),
  ],
  uniqueOn: ['enqueueSeq'],
  permissions: readOnly(true),
}
