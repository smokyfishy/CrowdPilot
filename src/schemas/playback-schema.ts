import type { CollectionSchema } from 'deepspace/schema'
import { num, readOnly, text } from './columns'
import { C } from './names'

/** Singleton (recordId 'state') per room scope; mirrors domain PlaybackState. */
export const playbackSchema: CollectionSchema = {
  name: C.playback,
  columns: [
    text('currentItemId'),
    text('state', { interpretation: { kind: 'select', options: ['idle', 'playing', 'paused', 'blocked', 'error'] } }),
    num('startedAt'),
    num('pausedAtSec'),
    num('playbackRevision', { default: 0 }),
    text('controllerId'),
    num('controllerLeaseUntil'),
    text('errorReason', { maxLength: 200 }),
    num('consecutiveFailures', { default: 0 }),
    num('updatedAt'),
  ],
  permissions: readOnly(true),
}
