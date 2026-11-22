/**
 * The single mutation entry point for a room. Every write a client can cause
 * flows through executeCommand (or createRoom/joinRoom), which:
 *   1. re-loads the caller's membership (kicked/unknown callers are refused),
 *   2. validates with the pure rules in src/domain,
 *   3. serializes racing multi-record operations with uniqueOn claims,
 *   4. writes through RBAC-bypassing record tools scoped to `room:<roomId>`.
 */
import type { ActionTools } from 'deepspace/worker'
import { ACTIVE, sortKeyAfterLast, sortKeyBetween } from '../domain/queue'
import {
  fifoSelector,
  planAdvance,
  planBlocked,
  planClaimController,
  planPause,
  planPlay,
  planRenewLease,
} from '../domain/playback'
import type { AdvanceInput, AdvanceReason, NextTrackSelector } from '../domain/playback'
import { TokenBucket } from '../domain/rate-limit'
import { checkCanJoin, checkEnqueue, checkHost, checkRemove, checkRoomOpen, checkVote, sanitizeDisplayName } from '../domain/rules'
import { fail, ok } from '../domain/types'
import type { Actor, PlaybackState, QueueItem, Result, RoomEventType, RoomState, TrackRef } from '../domain/types'
import { C, STATE_ID } from '../schemas/names'
import { claim, isDuplicateError, readClaim, release, setClaimRef } from './claims'
import { RoomRepo } from './repo'

import { REACTION_EMOJI } from '../domain/reactions'

export { REACTION_EMOJI }

export type RoomCommand =
  | { type: 'enqueue'; track: TrackRef; idempotencyKey: string }
  | { type: 'vote' | 'unvote' | 'remove' | 'pin' | 'unpin'; itemId: string }
  | { type: 'reorder'; itemId: string; beforeId: string | null; afterId: string | null; expectedQueueRevision: number }
  | { type: 'react'; emoji: string }
  | { type: 'play'; expectedRevision: number; controllerId?: string; positionSec?: number }
  | { type: 'pause'; expectedRevision: number; positionSec: number; controllerId?: string }
  | { type: 'blocked'; expectedRevision: number; controllerId: string }
  | { type: 'advance'; reason: AdvanceReason; expectedRevision: number; controllerId?: string; errorCode?: number }
  | { type: 'claimController'; controllerId: string; takeover: boolean }
  | { type: 'renewLease'; controllerId: string }
  | {
      type: 'updateSettings'
      patch: Partial<Pick<RoomState, 'guestRequestsEnabled' | 'allowAnonymousGuests' | 'perGuestLimit' | 'name'>>
    }
  | { type: 'kick'; memberId: string }
  | { type: 'closeRoom' }

export type CommandResult = Result<{ serverNow: number; itemId?: string }>

export interface Limits {
  enqueue: TokenBucket
  react: TokenBucket
}

export function createLimits(): Limits {
  return { enqueue: new TokenBucket(5, 5 / 60_000), react: new TokenBucket(1, 1 / 2_000) }
}

/** Best-effort per-isolate limits (documented limitation: not global across isolates). */
const defaultLimits = createLimits()

export interface CommandDeps {
  /** App-scope tools, needed to mirror name/status into the rooms directory. */
  appTools?: ActionTools
  limits?: Limits
  selector?: NextTrackSelector
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

async function logEvent(
  tools: ActionTools,
  type: RoomEventType,
  actorName: string,
  now: number,
  extra: { queueItemId?: string; payload?: Record<string, unknown> } = {},
): Promise<void> {
  await tools.create(C.events, {
    type,
    actorName,
    queueItemId: extra.queueItemId ?? '',
    payload: extra.payload ?? {},
    createdAt: now,
  })
}

// ───────────────────────────── rooms & membership ─────────────────────────────

export async function createRoom(
  appTools: ActionTools,
  roomToolsFor: (roomId: string) => ActionTools,
  host: { userId: string; name: string },
  input: { name: string },
  now: number,
): Promise<Result<{ roomId: string; code: string }>> {
  const name = input.name.replace(/\s+/g, ' ').trim()
  if (name.length < 1 || name.length > 60) return fail('INVALID', 'Room names must be 1–60 characters.')
  const hostName = sanitizeDisplayName(host.name)
  const displayName = hostName.ok ? hostName.value : 'Host'
  const roomId = crypto.randomUUID()

  let code = ''
  for (let attempt = 0; attempt < 6 && !code; attempt++) {
    const candidate = randomCode()
    const r = await appTools.create(
      C.rooms,
      { code: candidate, hostUserId: host.userId, name, status: 'open', lastActivityAt: now, createdAt: now },
      roomId,
    )
    if (r.success) code = candidate
    else if (!isDuplicateError(r.error)) throw new Error(`createRoom failed: ${r.error}`)
  }
  if (!code) return fail('UPSTREAM', 'Could not allocate a room code — please try again.')

  const tools = roomToolsFor(roomId)
  await tools.create(
    C.roomState,
    {
      roomId,
      code,
      name,
      hostUserId: host.userId,
      hostName: displayName,
      status: 'open',
      guestRequestsEnabled: true,
      allowAnonymousGuests: true,
      perGuestLimit: 3,
      queueRevision: 0,
      nextEnqueueSeq: 1,
      lastActivityAt: now,
    },
    STATE_ID,
  )
  await tools.create(
    C.playback,
    {
      currentItemId: null,
      state: 'idle',
      startedAt: null,
      pausedAtSec: null,
      playbackRevision: 0,
      controllerId: null,
      controllerLeaseUntil: null,
      errorReason: null,
      consecutiveFailures: 0,
      updatedAt: now,
    },
    STATE_ID,
  )
  const joined = await joinRoom(tools, { identityKey: `user:${host.userId}`, displayName, signedIn: true }, now)
  if (!joined.ok) return joined
  return ok({ roomId, code })
}

export async function joinRoom(
  tools: ActionTools,
  who: { identityKey: string; displayName: string; signedIn: boolean },
  now: number,
): Promise<Result<{ memberId: string }>> {
  const repo = new RoomRepo(tools)
  const room = await repo.roomState()
  if (!room) return fail('NOT_FOUND', 'This room does not exist.')
  const existing = await repo.memberByIdentity(who.identityKey)
  const allowed = checkCanJoin(room, who.signedIn, existing?.status === 'kicked')
  if (!allowed.ok) return allowed
  if (existing) return ok({ memberId: existing.id })

  const name = sanitizeDisplayName(who.displayName)
  if (!name.ok) return name
  const role = who.identityKey === `user:${room.hostUserId}` ? 'host' : 'guest'
  const created = await tools.create(C.members, {
    identityKey: who.identityKey,
    displayName: name.value,
    role,
    status: 'active',
    signedIn: who.signedIn,
    joinedAt: now,
  })
  if (!created.success) {
    if (!isDuplicateError(created.error)) throw new Error(`join failed: ${created.error}`)
    const raced = await repo.memberByIdentity(who.identityKey)
    if (!raced) return fail('UPSTREAM', 'Could not join — please try again.')
    return ok({ memberId: raced.id })
  }
  await logEvent(tools, 'join', name.value, now)
  await tools.update(C.roomState, STATE_ID, { lastActivityAt: now })
  return ok({ memberId: created.data.recordId })
}

export async function loadActor(tools: ActionTools, memberId: string): Promise<Result<Actor>> {
  const member = await new RoomRepo(tools).member(memberId)
  if (!member) return fail('UNAUTHENTICATED', 'Join the room first.')
  if (member.status === 'kicked') return fail('KICKED', 'The host removed you from this room.')
  return ok({
    memberId: member.id,
    identityKey: member.identityKey,
    role: member.role,
    displayName: member.displayName,
    signedIn: member.signedIn,
  })
}

// ───────────────────────────── commands ─────────────────────────────

function validTrack(t: TrackRef): Result<TrackRef> {
  const title = String(t.title ?? '').trim().slice(0, 200)
  if (!title) return fail('INVALID', 'That track has no title.')
  const thumb = t.thumbnailUrl && /^https:\/\/[a-z0-9.-]+\.(ytimg|ggpht|googleusercontent)\.com\//i.test(t.thumbnailUrl) ? t.thumbnailUrl.slice(0, 500) : undefined
  const duration = typeof t.durationMs === 'number' && t.durationMs >= 0 && t.durationMs <= 86_400_000 ? Math.round(t.durationMs) : undefined
  return ok({
    trackKey: String(t.trackKey),
    title,
    creatorLabel: t.creatorLabel ? String(t.creatorLabel).trim().slice(0, 120) : undefined,
    thumbnailUrl: thumb,
    durationMs: duration,
  })
}

async function writePlayback(tools: ActionTools, next: PlaybackState): Promise<void> {
  await tools.update(C.playback, STATE_ID, { ...next })
}

async function finishItem(
  tools: ActionTools,
  itemId: string,
  status: QueueItem['status'],
  now: number,
  failureReason?: string,
): Promise<void> {
  const item = await new RoomRepo(tools).item(itemId)
  await tools.update(C.queue, itemId, { status, finishedAt: now, failureReason: failureReason ?? '' })
  if (item) await release(tools, `active:${item.trackKey}`)
}

/** Shared by advance and host-removal of the playing item. */
async function doAdvance(
  tools: ActionTools,
  actor: Actor,
  input: AdvanceInput,
  now: number,
  selector: NextTrackSelector,
  finishedStatusOverride?: QueueItem['status'],
): Promise<Result<void>> {
  const repo = new RoomRepo(tools)
  const [pb, items] = await Promise.all([repo.playback(), repo.activeItems()])
  if (!pb) return fail('NOT_FOUND', 'Playback state missing.')
  const plan = planAdvance(pb, items, actor, input, now, selector)
  if (!plan.ok) return plan
  // Exactly one racer wins this revision; a duplicate ENDED is a harmless no-op.
  if (!(await claim(tools, `playback:${pb.playbackRevision}`, '', now))) return ok(undefined)
  const { finished, startItemId, next } = plan.value
  if (finished) await finishItem(tools, finished.itemId, finishedStatusOverride ?? finished.status, now, finished.failureReason)
  if (startItemId) await tools.update(C.queue, startItemId, { status: 'playing' })
  await writePlayback(tools, next)
  if (input.reason === 'skip') await logEvent(tools, 'skip', actor.displayName, now, { queueItemId: finished?.itemId })
  if (startItemId) await logEvent(tools, 'now_playing', actor.displayName, now, { queueItemId: startItemId })
  return ok(undefined)
}

/** When the queue had run dry while a host device is connected, a new request starts playing. */
async function startIfIdle(tools: ActionTools, now: number, selector: NextTrackSelector): Promise<void> {
  const repo = new RoomRepo(tools)
  const pb = await repo.playback()
  if (!pb || pb.state !== 'idle' || pb.currentItemId || pb.playbackRevision === 0) return
  if (!pb.controllerLeaseUntil || pb.controllerLeaseUntil <= now) return
  const system: Actor = { memberId: 'system', identityKey: 'system', role: 'host', displayName: 'CrowdPilot', signedIn: true }
  const plan = planPlay(pb, await repo.activeItems(), system, { expectedRevision: pb.playbackRevision }, now, selector)
  if (!plan.ok || !plan.value.startItemId) return
  if (!(await claim(tools, `playback:${pb.playbackRevision}`, '', now))) return
  await tools.update(C.queue, plan.value.startItemId, { status: 'playing' })
  await writePlayback(tools, plan.value.next)
  await logEvent(tools, 'now_playing', 'CrowdPilot', now, { queueItemId: plan.value.startItemId })
}

async function enqueue(
  tools: ActionTools,
  actor: Actor,
  room: RoomState,
  cmd: Extract<RoomCommand, { type: 'enqueue' }>,
  now: number,
  limits: Limits,
  selector: NextTrackSelector,
): Promise<Result<{ itemId?: string }>> {
  const track = validTrack(cmd.track)
  if (!track.ok) return track
  const idemKey = `idem:${actor.memberId}:${String(cmd.idempotencyKey).slice(0, 64)}`
  const prior = await readClaim(tools, idemKey)
  if (prior) return ok({ itemId: prior.ref || undefined })

  const limited = limits.enqueue.take(actor.memberId, now)
  if (!limited.ok) return limited

  const repo = new RoomRepo(tools)
  const items = await repo.activeItems()
  const allowed = checkEnqueue(actor, room, items, track.value.trackKey)
  if (!allowed.ok) return allowed

  const activeKey = `active:${track.value.trackKey}`
  if (!(await claim(tools, activeKey, '', now))) {
    // Someone holds this track. If their item has since left the queue, the claim is stale.
    const holder = await readHolder(tools, activeKey)
    const holderItem = holder?.ref ? await repo.item(holder.ref) : undefined
    if (holderItem && !ACTIVE.has(holderItem.status)) {
      await release(tools, activeKey)
      if (!(await claim(tools, activeKey, '', now))) return fail('DUPLICATE', 'That song was just added — vote for it instead.')
    } else {
      return fail('DUPLICATE', 'That song is already in the queue — vote for it instead.', {
        existingItemId: holder?.ref || items.find((i) => i.trackKey === track.value.trackKey)?.id,
      })
    }
  }
  if (!(await claim(tools, idemKey, '', now))) {
    await release(tools, activeKey)
    const again = await readClaim(tools, idemKey)
    return ok({ itemId: again?.ref || undefined })
  }

  let seq = Math.max(room.nextEnqueueSeq, (await repo.maxEnqueueSeq()) + 1)
  let itemId = ''
  for (let attempt = 0; attempt < 8 && !itemId; attempt++) {
    const r = await tools.create(C.queue, {
      ...track.value,
      creatorLabel: track.value.creatorLabel ?? '',
      thumbnailUrl: track.value.thumbnailUrl ?? '',
      durationMs: track.value.durationMs ?? null,
      requestedByMemberId: actor.memberId,
      requestedByName: actor.displayName,
      enqueueSeq: seq,
      sortKey: sortKeyAfterLast(items),
      pinnedAt: null,
      status: 'queued',
      voteCount: 0,
      createdAt: now,
    })
    if (r.success) itemId = r.data.recordId
    else if (isDuplicateError(r.error)) seq += 1
    else throw new Error(`enqueue failed: ${r.error}`)
  }
  if (!itemId) {
    await release(tools, activeKey)
    await release(tools, idemKey)
    return fail('UPSTREAM', 'The queue is busy — please try again.')
  }
  await tools.update(C.roomState, STATE_ID, { nextEnqueueSeq: seq + 1 })
  await setClaimRef(tools, activeKey, itemId)
  await setClaimRef(tools, idemKey, itemId)
  await logEvent(tools, 'enqueue', actor.displayName, now, { queueItemId: itemId, payload: { title: track.value.title } })
  await startIfIdle(tools, now, selector)
  return ok({ itemId })
}

/** The winner sets the claim's ref right after creating its item; give it a moment. */
async function readHolder(tools: ActionTools, key: string): Promise<{ recordId: string; ref: string } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const holder = await readClaim(tools, key)
    if (!holder || holder.ref) return holder
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
  }
  return readClaim(tools, key)
}

async function recountVotes(tools: ActionTools, itemId: string): Promise<void> {
  const r = await tools.query(C.votes, { where: { queueItemId: itemId }, limit: 500 })
  if (r.success) await tools.update(C.queue, itemId, { voteCount: r.data.records.length })
}

function validSettingsPatch(
  patch: Extract<RoomCommand, { type: 'updateSettings' }>['patch'],
): Result<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = String(patch.name).replace(/\s+/g, ' ').trim()
    if (name.length < 1 || name.length > 60) return fail('INVALID', 'Room names must be 1–60 characters.')
    out.name = name
  }
  if (patch.perGuestLimit !== undefined) {
    const n = Number(patch.perGuestLimit)
    if (!Number.isInteger(n) || n < 1 || n > 10) return fail('INVALID', 'The request limit must be between 1 and 10.')
    out.perGuestLimit = n
  }
  if (patch.guestRequestsEnabled !== undefined) out.guestRequestsEnabled = !!patch.guestRequestsEnabled
  if (patch.allowAnonymousGuests !== undefined) out.allowAnonymousGuests = !!patch.allowAnonymousGuests
  if (Object.keys(out).length === 0) return fail('INVALID', 'Nothing to change.')
  return ok(out)
}

export async function executeCommand(
  tools: ActionTools,
  caller: Actor,
  cmd: RoomCommand,
  now: number,
  deps: CommandDeps = {},
): Promise<CommandResult> {
  const limits = deps.limits ?? defaultLimits
  const selector = deps.selector ?? fifoSelector
  const repo = new RoomRepo(tools)

  const actorResult = await loadActor(tools, caller.memberId)
  if (!actorResult.ok) return actorResult
  const actor = actorResult.value

  const room = await repo.roomState()
  if (!room) return fail('NOT_FOUND', 'This room does not exist.')
  if (cmd.type !== 'closeRoom') {
    const open = checkRoomOpen(room)
    if (!open.ok) return open
  }

  const done = (itemId?: string): CommandResult => ok({ serverNow: now, ...(itemId ? { itemId } : {}) })
  let result: Result<{ itemId?: string } | void>

  switch (cmd.type) {
    case 'enqueue':
      result = await enqueue(tools, actor, room, cmd, now, limits, selector)
      break

    case 'vote': {
      const item = await repo.item(cmd.itemId)
      const allowed = checkVote(actor, item)
      if (!allowed.ok) return allowed
      const r = await tools.create(C.votes, { queueItemId: cmd.itemId, memberId: actor.memberId, createdAt: now })
      if (!r.success && !isDuplicateError(r.error)) throw new Error(`vote failed: ${r.error}`)
      await recountVotes(tools, cmd.itemId)
      result = ok(undefined)
      break
    }

    case 'unvote': {
      await tools.deleteWhere(C.votes, { queueItemId: cmd.itemId, memberId: actor.memberId }, 10)
      await recountVotes(tools, cmd.itemId)
      result = ok(undefined)
      break
    }

    case 'remove': {
      const item = await repo.item(cmd.itemId)
      const allowed = checkRemove(actor, item)
      if (!allowed.ok) return allowed
      const pb = await repo.playback()
      if (item?.status === 'playing' && pb?.currentItemId === item.id) {
        result = await doAdvance(tools, actor, { reason: 'skip', expectedRevision: pb.playbackRevision }, now, selector, 'removed')
      } else {
        await finishItem(tools, cmd.itemId, 'removed', now)
        await logEvent(tools, 'remove', actor.displayName, now, { queueItemId: cmd.itemId, payload: { title: item?.title } })
        result = ok(undefined)
      }
      break
    }

    case 'pin':
    case 'unpin': {
      const host = checkHost(actor)
      if (!host.ok) return host
      const item = await repo.item(cmd.itemId)
      if (!item) return fail('NOT_FOUND', 'That song is no longer in the queue.')
      if (item.status !== 'queued') return fail('INVALID', 'Only waiting songs can be pinned.')
      await tools.update(C.queue, cmd.itemId, { pinnedAt: cmd.type === 'pin' ? now : null })
      result = ok(undefined)
      break
    }

    case 'reorder': {
      const host = checkHost(actor)
      if (!host.ok) return host
      if (room.queueRevision !== cmd.expectedQueueRevision) return fail('STALE_REVISION', 'The queue changed — refreshing.')
      const item = await repo.item(cmd.itemId)
      if (!item || item.status !== 'queued') return fail('NOT_FOUND', 'That song is no longer waiting.')
      const neighbour = async (id: string | null) => {
        if (!id) return null
        const n = await repo.item(id)
        return n && n.status === 'queued' && n.pinnedAt === null ? n.sortKey : null
      }
      const [beforeKey, afterKey] = await Promise.all([neighbour(cmd.beforeId), neighbour(cmd.afterId)])
      let sortKey: string
      try {
        sortKey = sortKeyBetween(beforeKey, afterKey)
      } catch {
        return fail('INVALID', 'That position is no longer valid — refreshing.')
      }
      if (!(await claim(tools, `queue:${cmd.expectedQueueRevision}`, '', now))) {
        return fail('STALE_REVISION', 'The queue changed — refreshing.')
      }
      await tools.update(C.queue, cmd.itemId, { sortKey, pinnedAt: null })
      await tools.update(C.roomState, STATE_ID, { queueRevision: cmd.expectedQueueRevision + 1 })
      result = ok(undefined)
      break
    }

    case 'react': {
      if (!(REACTION_EMOJI as readonly string[]).includes(cmd.emoji)) return fail('INVALID', 'Unsupported reaction.')
      const limited = limits.react.take(actor.memberId, now)
      if (!limited.ok) return limited
      await tools.create(C.reactions, { memberId: actor.memberId, memberName: actor.displayName, emoji: cmd.emoji, createdAt: now })
      result = ok(undefined)
      break
    }

    case 'play': {
      const [pb, items] = await Promise.all([repo.playback(), repo.activeItems()])
      if (!pb) return fail('NOT_FOUND', 'Playback state missing.')
      const plan = planPlay(pb, items, actor, cmd, now, selector)
      if (!plan.ok) return plan
      if (!(await claim(tools, `playback:${pb.playbackRevision}`, '', now))) return fail('STALE_REVISION', 'Playback changed — refreshing.')
      if (plan.value.startItemId) await tools.update(C.queue, plan.value.startItemId, { status: 'playing' })
      await writePlayback(tools, plan.value.next)
      if (plan.value.startItemId) await logEvent(tools, 'now_playing', actor.displayName, now, { queueItemId: plan.value.startItemId })
      result = ok(undefined)
      break
    }

    case 'pause':
    case 'blocked': {
      const pb = await repo.playback()
      if (!pb) return fail('NOT_FOUND', 'Playback state missing.')
      const plan = cmd.type === 'pause' ? planPause(pb, actor, cmd, now) : planBlocked(pb, actor, cmd, now)
      if (!plan.ok) return plan
      if (!(await claim(tools, `playback:${pb.playbackRevision}`, '', now))) return fail('STALE_REVISION', 'Playback changed — refreshing.')
      await writePlayback(tools, plan.value)
      result = ok(undefined)
      break
    }

    case 'advance':
      result = await doAdvance(tools, actor, cmd, now, selector)
      break

    case 'claimController':
    case 'renewLease': {
      const pb = await repo.playback()
      if (!pb) return fail('NOT_FOUND', 'Playback state missing.')
      const plan =
        cmd.type === 'claimController'
          ? planClaimController(pb, actor, cmd, now)
          : planRenewLease(pb, actor, cmd.controllerId, now)
      if (!plan.ok) return plan
      await tools.update(C.playback, STATE_ID, {
        controllerId: plan.value.controllerId,
        controllerLeaseUntil: plan.value.controllerLeaseUntil,
        updatedAt: now,
      })
      return done()
    }

    case 'updateSettings': {
      const host = checkHost(actor)
      if (!host.ok) return host
      const patch = validSettingsPatch(cmd.patch)
      if (!patch.ok) return patch
      await tools.update(C.roomState, STATE_ID, patch.value)
      if (patch.value.name && deps.appTools) await deps.appTools.update(C.rooms, room.roomId, { name: patch.value.name })
      await logEvent(tools, 'settings', actor.displayName, now, { payload: patch.value })
      result = ok(undefined)
      break
    }

    case 'kick': {
      const host = checkHost(actor)
      if (!host.ok) return host
      const target = await repo.member(cmd.memberId)
      if (!target) return fail('NOT_FOUND', 'That person is not in this room.')
      if (target.role === 'host') return fail('INVALID', 'The host cannot be removed.')
      await tools.update(C.members, target.id, { status: 'kicked' })
      await logEvent(tools, 'kick', actor.displayName, now, { payload: { name: target.displayName } })
      result = ok(undefined)
      break
    }

    case 'closeRoom': {
      const host = checkHost(actor)
      if (!host.ok) return host
      await tools.update(C.roomState, STATE_ID, { status: 'closed' })
      const pb = await repo.playback()
      if (pb) await writePlayback(tools, { ...pb, state: 'idle', startedAt: null, playbackRevision: pb.playbackRevision + 1, updatedAt: now })
      if (deps.appTools) await deps.appTools.update(C.rooms, room.roomId, { status: 'closed', lastActivityAt: now })
      await logEvent(tools, 'closed', actor.displayName, now)
      return done()
    }

    default:
      return fail('INVALID', 'Unknown command.')
  }

  if (!result.ok) return result
  await tools.update(C.roomState, STATE_ID, { lastActivityAt: now })
  const itemId = result.value && typeof result.value === 'object' ? result.value.itemId : undefined
  return done(itemId)
}
