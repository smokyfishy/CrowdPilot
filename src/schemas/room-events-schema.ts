import type { CollectionSchema } from 'deepspace/schema'
import { json, num, readOnly, text } from './columns'
import { C } from './names'

export const roomEventsSchema: CollectionSchema = {
  name: C.events,
  columns: [
    text('type', { required: true }),
    text('actorName', { maxLength: 32 }),
    text('queueItemId'),
    json('payload'),
    num('createdAt'),
  ],
  permissions: readOnly(true),
}
