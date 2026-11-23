import { describe, expect, it } from 'vitest'
import { C, STATE_ID } from '../schemas/names'
import { expireIdleRooms, pruneRoom, ROOM_IDLE_MS } from './maintenance'
import { createMemoryTools } from './testing/memory-tools'
import type { MemoryTools } from './testing/memory-tools'

const NOW = 1_800_000_000_000

async function seedRoom(app: MemoryTools, room: MemoryTools, id: string, lastActivityAt: number, status = 'open') {
  await app.create(C.rooms, { code: id.slice(0, 6).toUpperCase(), hostUserId: 'h', name: id, status, lastActivityAt, createdAt: 0 }, id)
  await room.create(C.roomState, { roomId: id, name: id, hostUserId: 'h', status, lastActivityAt }, STATE_ID)
  await room.create(C.playback, { state: 'playing', currentItemId: 'x', playbackRevision: 3 }, STATE_ID)
}

describe('expireIdleRooms', () => {
  it('expires only open rooms idle for more than 24 hours', async () => {
    const app = createMemoryTools()
    const rooms = new Map([
      ['idleroom', createMemoryTools()],
      ['busyroom', createMemoryTools()],
      ['oldclosed', createMemoryTools()],
    ])
    await seedRoom(app, rooms.get('idleroom') as MemoryTools, 'idleroom', NOW - ROOM_IDLE_MS - 1)
    await seedRoom(app, rooms.get('busyroom') as MemoryTools, 'busyroom', NOW - 1000)
    await seedRoom(app, rooms.get('oldclosed') as MemoryTools, 'oldclosed', NOW - ROOM_IDLE_MS * 3, 'closed')

    const expired = await expireIdleRooms(app, (id) => rooms.get(id) as MemoryTools, NOW)
    expect(expired).toBe(1)
    const status = Object.fromEntries(app.dump(C.rooms).map((r) => [r.recordId, r.data.status]))
    expect(status).toEqual({ idleroom: 'expired', busyroom: 'open', oldclosed: 'closed' })
    const idle = rooms.get('idleroom') as MemoryTools
    expect(idle.dump(C.roomState)[0].data.status).toBe('expired')
    expect(idle.dump(C.playback)[0].data).toMatchObject({ state: 'idle', playbackRevision: 4 })
  })
})

describe('pruneRoom', () => {
  it('keeps the newest 200 events, drops reactions older than a minute, keeps active claims', async () => {
    const room = createMemoryTools()
    for (let i = 0; i < 205; i++) await room.create(C.events, { type: 'join', actorName: 'x', createdAt: NOW - i * 1000 })
    await room.create(C.reactions, { memberId: 'm', emoji: '🔥', createdAt: NOW - 120_000 })
    await room.create(C.reactions, { memberId: 'm', emoji: '🔥', createdAt: NOW - 5_000 })
    const live = await room.create(C.queue, { trackKey: 'youtube:abc', title: 'Abc', status: 'queued', enqueueSeq: 1, sortKey: 'a0', requestedByMemberId: 'm' })
    await room.create(C.receipts, { key: 'active:youtube:abc', ref: live.success ? live.data.recordId : '', createdAt: NOW - 10 * 3_600_000 })
    await room.create(C.receipts, { key: 'playback:3', ref: '', createdAt: NOW - 10 * 3_600_000 })
    await room.create(C.receipts, { key: 'playback:4', ref: '', createdAt: NOW - 60_000 })

    await pruneRoom(room, NOW)

    const events = room.dump(C.events)
    expect(events).toHaveLength(200)
    expect(Math.min(...events.map((e) => Number(e.data.createdAt)))).toBe(NOW - 199_000)
    expect(room.dump(C.reactions)).toHaveLength(1)
    expect(room.dump(C.receipts).map((r) => r.data.key).sort()).toEqual(['active:youtube:abc', 'playback:4'])
  })
})

describe('pruneRoom active claims', () => {
  it('drops abandoned or finished active claims and keeps live ones', async () => {
    const room = createMemoryTools()
    const live = await room.create(C.queue, { trackKey: 'youtube:live', title: 'Live', status: 'queued', enqueueSeq: 1, sortKey: 'a0', requestedByMemberId: 'm' })
    const done = await room.create(C.queue, { trackKey: 'youtube:done', title: 'Done', status: 'played', enqueueSeq: 2, sortKey: 'a1', requestedByMemberId: 'm' })
    await room.create(C.receipts, { key: 'active:youtube:live', ref: live.success ? live.data.recordId : '', createdAt: NOW - 5 * 3_600_000 })
    await room.create(C.receipts, { key: 'active:youtube:done', ref: done.success ? done.data.recordId : '', createdAt: NOW - 5 * 3_600_000 })
    await room.create(C.receipts, { key: 'active:youtube:orphan', ref: '', createdAt: NOW - 5 * 3_600_000 })
    await pruneRoom(room, NOW)
    expect(room.dump(C.receipts).map((r) => r.data.key)).toEqual(['active:youtube:live'])
  })
})
