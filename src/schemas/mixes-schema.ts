import type { CollectionSchema } from 'deepspace/schema'
import { json, num, readOnly, text } from './columns'

/**
 * Generated AI mixes (app scope, recordId = mix id). Each row is one VERSION; refinements
 * create a new row with `parentId`/`rootId` (version history). Owners read only their own
 * rows; every write goes through /api/mixgen/* (server-validated). Audio and the full
 * manifest live in the owner's private file storage (`self` scope); this row stores keys.
 */
export const mixesSchema: CollectionSchema = {
  name: 'mixes',
  columns: [
    text('ownerUserId', { required: true }),
    text('rootId', { maxLength: 40 }),
    text('parentId', { maxLength: 40 }),
    num('version'),
    text('title', { maxLength: 120 }),
    text('prompt', { maxLength: 2000 }),
    text('editPrompt', { maxLength: 1000 }),
    json('spec'),
    text('specSource', { interpretation: { kind: 'select', options: ['llm', 'heuristic', 'user'] } }),
    text('status', { interpretation: { kind: 'select', options: ['draft', 'working', 'review', 'rendering', 'ready', 'failed'] } }),
    text('stage', { maxLength: 30 }),
    /** { [stage]: { done, total, detail, at } } — real completed work only. */
    json('progress'),
    /** Review step: selected tracks with acquisition/mixability status. */
    json('selection'),
    /** Small summary for lists (track titles, BPM range, duration, transitions). */
    json('summary'),
    text('manifestKey', { maxLength: 300 }),
    text('audioKey', { maxLength: 300 }),
    text('audioMime', { maxLength: 60 }),
    num('durationSec'),
    num('trackCount'),
    json('permissions'),
    text('error', { maxLength: 1000 }),
    num('createdAt'),
    num('updatedAt'),
  ],
  ownerField: 'ownerUserId',
  permissions: { ...readOnly(false), member: { read: 'own', create: false, update: false, delete: false }, admin: { read: 'own', create: false, update: false, delete: false } },
}
