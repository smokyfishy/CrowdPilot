import type { CollectionSchema } from 'deepspace/schema'
import { bool, num, readOnly, text } from './columns'
import { C } from './names'

/** Durable room membership. identityKey = `user:<userId>` | `guest:<uuid>`. No emails stored. */
export const roomMembersSchema: CollectionSchema = {
  name: C.members,
  columns: [
    text('identityKey', { required: true, immutable: true }),
    text('displayName', { required: true, maxLength: 32 }),
    text('role', { interpretation: { kind: 'select', options: ['host', 'guest'] } }),
    text('status', { interpretation: { kind: 'select', options: ['active', 'kicked'] } }),
    bool('signedIn'),
    num('joinedAt'),
  ],
  uniqueOn: ['identityKey'],
  permissions: readOnly(true),
}
