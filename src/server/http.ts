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

const finite = z.number().finite()
const secs = z.number().min(0).max(7200)
const trackKey = z.string().regex(/^(youtube|audius|jamendo):[A-Za-z0-9_-]{1,40}$/)
const summary = z.object({
  v: z.string().max(40),
  bpm: z.number().min(0).max(300),
  bpmConf: z.number().min(0).max(1),
  gridSource: z.enum(['beatnet', 'dsp']).optional(),
  firstBeat: secs,
  downbeatPhase: z.number().int().min(0).max(3),
  downbeatConf: z.number().min(0).max(1),
  stable: z.boolean(),
  key: z.string().max(20),
  camelot: z.string().max(4),
  keyConf: z.number().min(0).max(1),
  lufs: z.number().min(-100).max(10),
  truePeak: z.number().min(-100).max(20),
  durationSec: secs,
  phrasesSec: z.array(secs).max(48),
  cueIn: z.array(secs).max(4),
  cueOut: z.array(secs).max(4),
  introBars: z.number().int().min(0).max(512),
  outroBars: z.number().int().min(0).max(512),
  barSec: z.number().min(0).max(10),
  vocalIn: z.number().min(0).max(1),
  vocalOut: z.number().min(0).max(1),
  energyIn: z.number().min(-200).max(50),
  energyOut: z.number().min(-200).max(50),
  energyMean: z.number().min(-200).max(50),
  phraseEnergy: z.array(z.number().min(-200).max(50)).max(48).optional(),
  flags: z.array(z.string().max(80)).max(8),
})
const transition = z.object({
  fromItemId: id,
  toItemId: id,
  style: z.string().max(24),
  outCueSec: secs,
  inCueSec: secs,
  overlapBars: z.number().int().min(0).max(64),
  tempoRatio: z.number().min(0.9).max(1.1),
  startsAt: z.number().int().optional(),
  cost: finite.optional(),
  costs: z.record(z.string().max(16), finite).optional(),
  risks: z.array(z.string().max(80)).max(6).optional(),
  reasons: z.array(z.string().max(80)).max(6).optional(),
  alternatives: z.array(z.object({ style: z.string().max(24), cost: finite })).max(4).optional(),
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
    nextItemId: id.optional(),
    startPositionSec: z.number().min(0).max(3600).optional(),
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
  // ── Phase 2 AI DJ ──
  z.object({
    type: z.literal('djSettings'),
    patch: z.object({
      autopilot: z.boolean().optional(),
      aiReorder: z.boolean().optional(),
      maxTempoPct: z.number().min(0).max(6).optional(),
      style: z.enum(['balanced', 'smooth', 'energetic', 'creative']).optional(),
      allowOmlMixing: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('djStatus'),
    status: z.enum(['idle', 'analyzing', 'ready', 'proposed', 'committed', 'mixing', 'safe_fallback', 'failed']),
    note: z.string().max(200).optional(),
    transition: transition.nullable().optional(),
    expectedPlaybackRevision: rev,
    controllerId,
  }),
  z.object({
    type: z.literal('saveAnalysis'),
    trackKey,
    status: z.enum(['ready', 'low_confidence', 'cannot_mix', 'failed']),
    analyzerVersion: z.string().min(1).max(40),
    summary: summary.optional(),
    failure: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('correctAnalysis'),
    trackKey,
    corrections: z
      .object({
        bpm: z.number().min(40).max(250).optional(),
        firstBeat: secs.optional(),
        downbeatPhase: z.number().int().min(0).max(3).optional(),
        note: z.string().max(120).optional(),
      })
      .nullable(),
  }),
  z.object({ type: z.literal('setMixSource'), itemId: id, action: z.enum(['accept', 'reject']) }),
  z.object({ type: z.literal('scheduleItem'), itemId: id, targetStartAt: z.number().int().nullable() }),
  z.object({ type: z.literal('lockItem'), itemId: id, locked: z.boolean() }),
])

/** Strict parse; unknown keys are stripped so callers can't smuggle identity fields. */
export function parseCommand(body: unknown): Result<RoomCommand> {
  const parsed = commandSchema.safeParse(body)
  if (!parsed.success) return fail('INVALID', 'That request was not understood.')
  return ok(parsed.data as RoomCommand)
}
