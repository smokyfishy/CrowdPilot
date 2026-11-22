import type { CollectionSchema } from 'deepspace/schema'
import { num, readOnly, text } from './columns'
import { C } from './names'

/** App-scope directory of rooms (recordId = roomId). Hosts see only their own rows. */
export const roomsSchema: CollectionSchema = {
  name: C.rooms,
  columns: [
    text('code', { required: true, maxLength: 6 }),
    text('hostUserId', { required: true }),
    text('name', { required: true, maxLength: 60 }),
    text('status', { interpretation: { kind: 'select', options: ['open', 'closed', 'expired'] } }),
    num('lastActivityAt'),
    num('createdAt'),
  ],
  uniqueOn: ['code'],
  ownerField: 'hostUserId',
  permissions: { ...readOnly(false), member: { read: 'own', create: false, update: false, delete: false }, admin: { read: true, create: false, update: false, delete: false } },
}
