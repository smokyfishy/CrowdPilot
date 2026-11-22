import type { CollectionSchema } from 'deepspace/schema'
import { num, readOnly, text } from './columns'
import { C } from './names'

export const reactionsSchema: CollectionSchema = {
  name: C.reactions,
  columns: [
    text('memberId', { required: true }),
    text('memberName', { maxLength: 32 }),
    text('emoji', { required: true, maxLength: 8 }),
    num('createdAt'),
  ],
  permissions: readOnly(true),
}
