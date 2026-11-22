import type { CollectionSchema } from 'deepspace/schema'
import { num, readOnly, text } from './columns'
import { C } from './names'

export const votesSchema: CollectionSchema = {
  name: C.votes,
  columns: [text('queueItemId', { required: true }), text('memberId', { required: true }), num('createdAt')],
  uniqueOn: ['queueItemId', 'memberId'],
  permissions: readOnly(true),
}
