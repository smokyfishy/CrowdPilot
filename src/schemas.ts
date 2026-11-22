/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * CrowdPilot collections are read-only to every client role; all writes go
 * through the worker's room command route (src/server/room-routes.ts).
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { roomsSchema } from './schemas/rooms-schema'
import { roomStateSchema } from './schemas/room-state-schema'
import { roomMembersSchema } from './schemas/room-members-schema'
import { queueItemsSchema } from './schemas/queue-items-schema'
import { votesSchema } from './schemas/votes-schema'
import { playbackSchema } from './schemas/playback-schema'
import { roomEventsSchema } from './schemas/room-events-schema'
import { reactionsSchema } from './schemas/reactions-schema'
import { commandReceiptsSchema } from './schemas/command-receipts-schema'

/** Collections that live in the app scope (`app:<APP_ID>`). */
export const appSchemas: CollectionSchema[] = [usersSchema, settingsSchema, roomsSchema]

/** Collections that live in each room's scope (`room:<roomId>`). */
export const roomSchemas: CollectionSchema[] = [
  roomStateSchema,
  roomMembersSchema,
  queueItemsSchema,
  votesSchema,
  playbackSchema,
  roomEventsSchema,
  reactionsSchema,
  commandReceiptsSchema,
]

/** Every RecordRoom DO registers all schemas; clients register per scope (avoids name collisions). */
export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  roomsSchema,
  roomStateSchema,
  roomMembersSchema,
  queueItemsSchema,
  votesSchema,
  playbackSchema,
  roomEventsSchema,
  reactionsSchema,
  commandReceiptsSchema,
]
