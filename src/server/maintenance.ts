/** Hourly housekeeping: expire idle rooms and keep per-room collections bounded. */
import type { ActionTools } from 'deepspace/worker'
import { C, STATE_ID } from '../schemas/names'
import { ACTIVE } from '../domain/queue'
import { ABANDONED_CLAIM_MS } from './claims'
import { RoomRepo } from './repo'

export const ROOM_IDLE_MS = 24 * 60 * 60 * 1000
const KEEP_EVENTS = 200
const REACTION_TTL_MS = 60_000
const RECEIPT_TTL_MS = 60 * 60 * 1000

export async function expireIdleRooms(
  appTools: ActionTools,
  roomToolsFor: (roomId: string) => ActionTools,
  now: number,
): Promise<number> {
  const r = await appTools.query(C.rooms, { where: { status: 'open' }, limit: 500 })
  if (!r.success) return 0
  let expired = 0
  for (const row of r.data.records) {
    const tools = roomToolsFor(row.recordId)
    const state = await new RoomRepo(tools).roomState()
    const last = Math.max(Number(row.data.lastActivityAt ?? 0), state?.lastActivityAt ?? 0)
    if (now - last <= ROOM_IDLE_MS) {
      if (state && state.lastActivityAt > Number(row.data.lastActivityAt ?? 0)) {
        await appTools.update(C.rooms, row.recordId, { lastActivityAt: state.lastActivityAt })
      }
      continue
    }
    await appTools.update(C.rooms, row.recordId, { status: 'expired' })
    if (state) await tools.update(C.roomState, STATE_ID, { status: 'expired' })
    const pb = await new RoomRepo(tools).playback()
    if (pb) {
      await tools.update(C.playback, STATE_ID, {
        state: 'idle',
        startedAt: null,
        playbackRevision: pb.playbackRevision + 1,
        updatedAt: now,
      })
    }
    expired++
  }
  return expired
}

export async function pruneRoom(tools: ActionTools, now: number): Promise<void> {
  const events = await tools.query(C.events, { orderBy: 'createdAt', orderDir: 'desc', limit: 500 })
  if (events.success) {
    for (const row of events.data.records.slice(KEEP_EVENTS)) await tools.remove(C.events, row.recordId)
  }
  const reactions = await tools.query(C.reactions, { limit: 500 })
  if (reactions.success) {
    for (const row of reactions.data.records) {
      if (now - Number(row.data.createdAt ?? 0) > REACTION_TTL_MS) await tools.remove(C.reactions, row.recordId)
    }
  }
  const receipts = await tools.query(C.receipts, { limit: 500 })
  if (receipts.success) {
    for (const row of receipts.data.records) {
      const key = String(row.data.key ?? '')
      if (key.startsWith('active:')) {
        // Reconcile duplicate-guard claims: keep only those still pointing at a queued/playing item.
        if (now - Number(row.data.createdAt ?? 0) <= ABANDONED_CLAIM_MS) continue
        const ref = String(row.data.ref ?? '')
        const item = ref ? await new RoomRepo(tools).item(ref) : undefined
        if (!item || !ACTIVE.has(item.status)) await tools.remove(C.receipts, row.recordId)
        continue
      }
      if (now - Number(row.data.createdAt ?? 0) > RECEIPT_TTL_MS) await tools.remove(C.receipts, row.recordId)
    }
  }
}

export async function runMaintenance(
  appTools: ActionTools,
  roomToolsFor: (roomId: string) => ActionTools,
  now: number,
): Promise<{ expired: number; pruned: number }> {
  const expired = await expireIdleRooms(appTools, roomToolsFor, now)
  const open = await appTools.query(C.rooms, { where: { status: 'open' }, limit: 500 })
  let pruned = 0
  if (open.success) {
    for (const row of open.data.records) {
      await pruneRoom(roomToolsFor(row.recordId), now)
      pruned++
    }
  }
  return { expired, pruned }
}
