/** Pure presentation helpers for the room UI (unit-tested; no React). */
import { ACTIVE } from '../../domain/queue'
import type { Actor, QueueItem, RoomEvent } from '../../domain/types'

export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function progressFraction(progressSec: number, durationMs: number | undefined): number {
  if (!durationMs || durationMs <= 0) return 0
  return Math.min(1, Math.max(0, (progressSec * 1000) / durationMs))
}

export function showRemove(actor: Actor | undefined, item: QueueItem): boolean {
  if (!actor || !ACTIVE.has(item.status)) return false
  if (actor.role === 'host') return true
  return item.requestedByMemberId === actor.memberId && item.status === 'queued'
}

export type AddState = 'add' | 'adding' | 'in-queue' | 'vote-instead'

export function addButtonState(trackKey: string, activeKeys: Set<string>, pending: 'adding' | string | undefined): AddState {
  if (pending === 'adding') return 'adding'
  if (activeKeys.has(trackKey)) return 'in-queue'
  if (pending === 'DUPLICATE') return 'vote-instead'
  return 'add'
}

export function announcementFor(e: RoomEvent): string {
  const title = typeof e.payload?.title === 'string' ? e.payload.title : 'a song'
  switch (e.type) {
    case 'enqueue':
      return `${e.actorName} added ${title}`
    case 'remove':
      return `${e.actorName} removed ${title}`
    case 'skip':
      return `${e.actorName} skipped a song`
    case 'now_playing':
      return 'Now playing changed'
    case 'join':
      return `${e.actorName} joined`
    case 'kick':
      return `${e.actorName} removed ${typeof e.payload?.name === 'string' ? e.payload.name : 'someone'} from the room`
    case 'settings':
      return `${e.actorName} changed the room settings`
    case 'closed':
      return `${e.actorName} ended the room`
    default:
      return ''
  }
}

/** Offset to add to Date.now() to approximate server time. */
export function clockOffset(serverNow: number, sentAt: number, receivedAt: number): number {
  return Math.round(serverNow - (sentAt + receivedAt) / 2)
}

export function onlineMemberIds(
  members: Array<{ id: string; identityKey: string }>,
  peers: Array<{ userId: string; state: Record<string, unknown> }>,
  selfMemberId?: string,
): Set<string> {
  const online = new Set<string>()
  const byUser = new Map(members.filter((m) => m.identityKey.startsWith('user:')).map((m) => [m.identityKey.slice(5), m.id]))
  for (const peer of peers) {
    if (typeof peer.state.memberId === 'string') online.add(peer.state.memberId)
    const viaUser = byUser.get(peer.userId)
    if (viaUser) online.add(viaUser)
  }
  if (selfMemberId) online.add(selfMemberId)
  return online
}
