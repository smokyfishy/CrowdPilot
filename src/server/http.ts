import { z } from 'zod'
import { fail, ok } from '../domain/types'
import type { ErrorCode, Result } from '../domain/types'
import type { RoomCommand } from './commands'

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401
    case 'FORBIDDEN':
    case 'KICKED':
    case 'NOT_CONTROLLER':
      return 403
    case 'NOT_FOUND':
      return 404
    case 'DUPLICATE':
    case 'STALE_REVISION':
      return 409
    case 'ROOM_CLOSED':
      return 410
    case 'RATE_LIMITED':
      return 429
    case 'PROVIDER_NOT_CONFIGURED':
    case 'QUOTA':
      return 503
    case 'UPSTREAM':
      return 502
    default:
      return 400
  }
}

const id = z.string().min(1).max(64)
const rev = z.number().int().min(0)
const controllerId = z.string().min(8).max(64)
const track = z.object({
  trackKey: z.string().max(80),
  title: z.string().min(1).max(300),
  creatorLabel: z.string().max(200).optional(),
  thumbnailUrl: z.string().max(600).optional(),
  durationMs: z.number().min(0).max(86_400_000).optional(),
})

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enqueue'), track, idempotencyKey: z.string().min(1).max(64) }),
  z.object({ type: z.literal('vote'), itemId: id }),
  z.object({ type: z.literal('unvote'), itemId: id }),
  z.object({ type: z.literal('remove'), itemId: id }),
  z.object({ type: z.literal('pin'), itemId: id }),
  z.object({ type: z.literal('unpin'), itemId: id }),
  z.object({
    type: z.literal('reorder'),
    itemId: id,
    beforeId: id.nullable(),
    afterId: id.nullable(),
    expectedQueueRevision: rev,
  }),
  z.object({ type: z.literal('react'), emoji: z.string().min(1).max(8) }),
  z.object({
    type: z.literal('play'),
    expectedRevision: rev,
    controllerId: controllerId.optional(),
    positionSec: z.number().min(0).max(86_400).optional(),
  }),
  z.object({
    type: z.literal('pause'),
    expectedRevision: rev,
    positionSec: z.number().min(0).max(86_400),
    controllerId: controllerId.optional(),
  }),
  z.object({ type: z.literal('blocked'), expectedRevision: rev, controllerId }),
  z.object({
    type: z.literal('advance'),
    reason: z.enum(['ended', 'skip', 'error']),
    expectedRevision: rev,
    controllerId: controllerId.optional(),
    errorCode: z.number().int().optional(),
  }),
  z.object({ type: z.literal('claimController'), controllerId, takeover: z.boolean() }),
  z.object({ type: z.literal('renewLease'), controllerId }),
  z.object({
    type: z.literal('updateSettings'),
    patch: z.object({
      name: z.string().max(80).optional(),
      perGuestLimit: z.number().int().optional(),
      guestRequestsEnabled: z.boolean().optional(),
      allowAnonymousGuests: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal('kick'), memberId: id }),
  z.object({ type: z.literal('closeRoom') }),
])

/** Strict parse; unknown keys are stripped so callers can't smuggle identity fields. */
export function parseCommand(body: unknown): Result<RoomCommand> {
  const parsed = commandSchema.safeParse(body)
  if (!parsed.success) return fail('INVALID', 'That request was not understood.')
  return ok(parsed.data as RoomCommand)
}
