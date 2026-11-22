/** Typed reads over ActionTools records, mapping envelopes → domain objects. */
import type { ActionTools } from 'deepspace/worker'
import type { Member, PlaybackState, QueueItem, RoomState } from '../domain/types'
import { C, STATE_ID } from '../schemas/names'

type Row = { recordId: string; data: Record<string, unknown> }

const bool = (v: unknown, fallback = false) => (v === undefined || v === null ? fallback : v === true || v === 1 || v === '1' || v === 'true')
const numOr = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : v == null || v === '' ? fallback : Number(v))
const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const strOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v))

export function toRoomState(d: Record<string, unknown>): RoomState {
  return {
    roomId: String(d.roomId),
    code: d.code ? String(d.code) : undefined,
    name: String(d.name ?? ''),
    hostUserId: String(d.hostUserId ?? ''),
    hostName: String(d.hostName ?? ''),
    status: (d.status as RoomState['status']) ?? 'open',
    guestRequestsEnabled: bool(d.guestRequestsEnabled, true),
    allowAnonymousGuests: bool(d.allowAnonymousGuests, true),
    perGuestLimit: numOr(d.perGuestLimit, 3),
    queueRevision: numOr(d.queueRevision, 0),
    nextEnqueueSeq: numOr(d.nextEnqueueSeq, 1),
    lastActivityAt: numOr(d.lastActivityAt, 0),
  }
}

export function toPlayback(d: Record<string, unknown>): PlaybackState {
  return {
    currentItemId: strOrNull(d.currentItemId),
    state: (d.state as PlaybackState['state']) ?? 'idle',
    startedAt: numOrNull(d.startedAt),
    pausedAtSec: numOrNull(d.pausedAtSec),
    playbackRevision: numOr(d.playbackRevision, 0),
    controllerId: strOrNull(d.controllerId),
    controllerLeaseUntil: numOrNull(d.controllerLeaseUntil),
    errorReason: strOrNull(d.errorReason),
    consecutiveFailures: numOr(d.consecutiveFailures, 0),
    updatedAt: numOr(d.updatedAt, 0),
  }
}

export function toQueueItem(r: Row): QueueItem {
  const d = r.data
  return {
    id: r.recordId,
    trackKey: String(d.trackKey),
    title: String(d.title ?? ''),
    creatorLabel: d.creatorLabel ? String(d.creatorLabel) : undefined,
    thumbnailUrl: d.thumbnailUrl ? String(d.thumbnailUrl) : undefined,
    durationMs: d.durationMs == null || d.durationMs === '' ? undefined : Number(d.durationMs),
    requestedByMemberId: String(d.requestedByMemberId ?? ''),
    requestedByName: String(d.requestedByName ?? ''),
    enqueueSeq: numOr(d.enqueueSeq, 0),
    sortKey: String(d.sortKey ?? ''),
    pinnedAt: numOrNull(d.pinnedAt),
    status: (d.status as QueueItem['status']) ?? 'queued',
    voteCount: numOr(d.voteCount, 0),
    createdAt: numOr(d.createdAt, 0),
    finishedAt: d.finishedAt == null || d.finishedAt === '' ? undefined : Number(d.finishedAt),
    failureReason: d.failureReason ? String(d.failureReason) : undefined,
  }
}

export function toMember(r: Row): Member {
  const d = r.data
  return {
    id: r.recordId,
    identityKey: String(d.identityKey),
    displayName: String(d.displayName ?? ''),
    role: d.role === 'host' ? 'host' : 'guest',
    status: d.status === 'kicked' ? 'kicked' : 'active',
    joinedAt: numOr(d.joinedAt, 0),
    signedIn: bool(d.signedIn),
  }
}

export class RoomRepo {
  constructor(readonly tools: ActionTools) {}

  async roomState(): Promise<RoomState | null> {
    const r = await this.tools.get(C.roomState, STATE_ID)
    return r.success ? toRoomState(r.data.record.data) : null
  }

  async playback(): Promise<PlaybackState | null> {
    const r = await this.tools.get(C.playback, STATE_ID)
    return r.success ? toPlayback(r.data.record.data) : null
  }

  async item(id: string): Promise<QueueItem | undefined> {
    const r = await this.tools.get(C.queue, id)
    return r.success ? toQueueItem(r.data.record) : undefined
  }

  /** Queued + playing items (the active set). */
  async activeItems(): Promise<QueueItem[]> {
    const [queued, playing] = await Promise.all([
      this.tools.query(C.queue, { where: { status: 'queued' }, limit: 500 }),
      this.tools.query(C.queue, { where: { status: 'playing' }, limit: 10 }),
    ])
    const rows = [...(queued.success ? queued.data.records : []), ...(playing.success ? playing.data.records : [])]
    return rows.map(toQueueItem)
  }

  async maxEnqueueSeq(): Promise<number> {
    const r = await this.tools.query(C.queue, { orderBy: 'enqueueSeq', orderDir: 'desc', limit: 1 })
    return r.success && r.data.records[0] ? Number(r.data.records[0].data.enqueueSeq) : 0
  }

  async member(id: string): Promise<Member | undefined> {
    const r = await this.tools.get(C.members, id)
    return r.success ? toMember(r.data.record) : undefined
  }

  async memberByIdentity(identityKey: string): Promise<Member | undefined> {
    const r = await this.tools.query(C.members, { where: { identityKey }, limit: 1 })
    return r.success && r.data.records[0] ? toMember(r.data.records[0]) : undefined
  }

  async countMembers(): Promise<number> {
    const r = await this.tools.query(C.members, { where: { status: 'active' }, limit: 500 })
    return r.success ? r.data.records.length : 0
  }
}
