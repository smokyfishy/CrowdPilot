import type { CollectionSchema } from 'deepspace/schema'
import { bool, num, readOnly, text } from './columns'
import { C } from './names'

/** Singleton (recordId 'state') per room scope; mirrors domain RoomState. */
export const roomStateSchema: CollectionSchema = {
  name: C.roomState,
  columns: [
    text('roomId', { required: true }),
    text('name', { required: true, maxLength: 60 }),
    text('hostUserId', { required: true }),
    text('hostName', { maxLength: 64 }),
    text('status', { interpretation: { kind: 'select', options: ['open', 'closed', 'expired'] } }),
    bool('guestRequestsEnabled', { default: true }),
    bool('allowAnonymousGuests', { default: true }),
    num('perGuestLimit', { default: 3 }),
    num('queueRevision', { default: 0 }),
    num('nextEnqueueSeq', { default: 1 }),
    num('lastActivityAt'),
  ],
  permissions: readOnly(true),
}
