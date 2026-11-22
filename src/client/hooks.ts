/**
 * Room hooks. Must render inside <RecordScope roomId={`room:${roomId}`}>.
 * Records are read live via useQuery; writes go through roomApi.command.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth, useQuery } from 'deepspace'
import { history, upNext } from '../domain/queue'
import type { Actor, DomainError, Member, PlaybackState, QueueItem, Reaction, Result, RoomEvent, RoomState } from '../domain/types'
import { toMember, toPlayback, toQueueItem, toRoomState } from '../server/repo'
import { C, STATE_ID } from '../schemas/names'
import type { RoomCommand } from '../server/commands'
import { clockOffset } from '../components/room/view-model'
import { roomApi } from './api'
import { clearGuestToken, setGuestToken } from './guest-session'

// ───────────── server clock ─────────────

let offsetMs = 0
let lastSync = 0
let syncing: Promise<void> | null = null

async function syncClock(): Promise<void> {
  const sentAt = Date.now()
  try {
    const { serverNow } = await roomApi.time()
    offsetMs = clockOffset(serverNow, sentAt, Date.now())
    lastSync = Date.now()
  } catch {
    // keep the previous offset; progress is approximate by design
  }
}

export function useServerClock(): { now: () => number } {
  useEffect(() => {
    const refresh = () => {
      if (Date.now() - lastSync > 5 * 60_000 && !syncing) syncing = syncClock().finally(() => (syncing = null))
    }
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => clearInterval(id)
  }, [])
  return useMemo(() => ({ now: () => Date.now() + offsetMs }), [])
}

/** Re-renders every `ms` while `active` (for progress bars). */
export function useTicker(active: boolean, ms = 1000): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return tick
}

// ───────────── live room data ─────────────

export interface RoomData {
  status: 'loading' | 'ready' | 'error'
  room?: RoomState
  playback?: PlaybackState
  members: Member[]
  upNext: QueueItem[]
  nowPlaying?: QueueItem
  history: QueueItem[]
  activeKeys: Set<string>
  events: RoomEvent[]
  reactions: Reaction[]
}

export function useRoomData(): RoomData {
  const roomQ = useQuery<Record<string, unknown>>(C.roomState)
  const playbackQ = useQuery<Record<string, unknown>>(C.playback)
  const membersQ = useQuery<Record<string, unknown>>(C.members, { limit: 500 })
  const queueQ = useQuery<Record<string, unknown>>(C.queue, { orderBy: 'enqueueSeq', orderDir: 'desc', limit: 400 })
  const eventsQ = useQuery<Record<string, unknown>>(C.events, { orderBy: 'createdAt', orderDir: 'desc', limit: 30 })
  const reactionsQ = useQuery<Record<string, unknown>>(C.reactions, { orderBy: 'createdAt', orderDir: 'desc', limit: 20 })

  return useMemo(() => {
    const statuses = [roomQ.status, playbackQ.status, membersQ.status, queueQ.status]
    const status = statuses.includes('error') ? 'error' : statuses.includes('loading') ? 'loading' : 'ready'
    const roomRow = roomQ.records.find((r) => r.recordId === STATE_ID)
    const playbackRow = playbackQ.records.find((r) => r.recordId === STATE_ID)
    const items = queueQ.records.map((r) => toQueueItem(r))
    const playback = playbackRow ? toPlayback(playbackRow.data) : undefined
    const nowPlaying = playback?.currentItemId ? items.find((i) => i.id === playback.currentItemId) : undefined
    const activeKeys = new Set(items.filter((i) => i.status === 'queued' || i.status === 'playing').map((i) => i.trackKey))
    return {
      status,
      room: roomRow ? toRoomState(roomRow.data) : undefined,
      playback,
      members: membersQ.records.map((r) => toMember(r)),
      upNext: upNext(items),
      nowPlaying,
      history: history(items, 20),
      activeKeys,
      events: eventsQ.records.map((r) => ({
        id: r.recordId,
        type: r.data.type as RoomEvent['type'],
        actorName: String(r.data.actorName ?? ''),
        queueItemId: r.data.queueItemId ? String(r.data.queueItemId) : undefined,
        payload: (typeof r.data.payload === 'object' && r.data.payload ? r.data.payload : undefined) as RoomEvent['payload'],
        createdAt: Number(r.data.createdAt ?? 0),
      })),
      reactions: reactionsQ.records.map((r) => ({
        id: r.recordId,
        memberId: String(r.data.memberId ?? ''),
        memberName: String(r.data.memberName ?? ''),
        emoji: String(r.data.emoji ?? ''),
        createdAt: Number(r.data.createdAt ?? 0),
      })),
    }
  }, [roomQ.records, roomQ.status, playbackQ.records, playbackQ.status, membersQ.records, membersQ.status, queueQ.records, queueQ.status, eventsQ.records, reactionsQ.records])
}

/** Ids of queue items the given member has voted for. */
export function useMyVotes(memberId?: string): Set<string> {
  const q = useQuery<Record<string, unknown>>(C.votes, { where: { memberId: memberId ?? '__none__' }, limit: 500 })
  return useMemo(() => new Set(q.records.map((r) => String(r.data.queueItemId))), [q.records])
}

// ───────────── membership ─────────────

export type ActorStatus = 'loading' | 'needs-join' | 'joined' | 'kicked' | 'error'

export function useActor(roomId: string) {
  const { isLoaded, isSignedIn } = useAuth()
  const [status, setStatus] = useState<ActorStatus>('loading')
  const [actor, setActor] = useState<Actor | undefined>()
  const [error, setError] = useState<DomainError | undefined>()

  const refresh = useCallback(async () => {
    const r = await roomApi.me(roomId)
    if (r.ok) {
      setActor(r.value)
      setStatus('joined')
      return
    }
    setActor(undefined)
    if (r.error.code === 'UNAUTHENTICATED') {
      if (!isSignedIn) clearGuestToken(roomId)
      setStatus('needs-join')
    } else if (r.error.code === 'KICKED') setStatus('kicked')
    else {
      setError(r.error)
      setStatus('error')
    }
  }, [roomId, isSignedIn])

  useEffect(() => {
    if (isLoaded) void refresh()
  }, [isLoaded, refresh])

  const join = useCallback(
    async (displayName: string): Promise<Result<void>> => {
      const r = await roomApi.join(roomId, displayName)
      if (!r.ok) {
        if (r.error.code === 'KICKED') setStatus('kicked')
        return r
      }
      if (r.value.guestToken) setGuestToken(roomId, r.value.guestToken)
      await refresh()
      return { ok: true, value: undefined }
    },
    [roomId, refresh],
  )

  return { status, actor, error, join, refresh }
}

// ───────────── commands ─────────────

export function useRoomCommand(roomId: string, onError: (e: DomainError) => void) {
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  return useCallback(
    async (cmd: RoomCommand, opts: { silent?: boolean } = {}) => {
      const r = await roomApi.command(roomId, cmd)
      if (!r.ok && !opts.silent) onErrorRef.current(r.error)
      return r
    },
    [roomId],
  )
}
