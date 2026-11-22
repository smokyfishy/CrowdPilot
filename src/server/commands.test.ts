import { beforeEach, describe, expect, it } from 'vitest'
import { C, STATE_ID } from '../schemas/names'
import { createLimits, createRoom, executeCommand, joinRoom, loadActor } from './commands'
import type { CommandDeps, RoomCommand } from './commands'
import { createMemoryTools } from './testing/memory-tools'
import type { MemoryTools } from './testing/memory-tools'
import type { Actor, Result } from '../domain/types'

const T0 = 1_700_000_000_000
const track = (id: string) => ({ trackKey: `youtube:${id}`, title: `Song ${id}`, creatorLabel: 'Channel' })
const code = (r: Result<unknown>) => (r.ok ? 'OK' : r.error.code)

let app: MemoryTools
let room: MemoryTools
let deps: CommandDeps
let host: Actor
let ann: Actor
let bob: Actor
let roomId: string

async function join(identityKey: string, displayName: string, signedIn = false): Promise<Actor> {
  const r = await joinRoom(room, { identityKey, displayName, signedIn }, T0)
  if (!r.ok) throw new Error(r.error.message)
  const actor = await loadActor(room, r.value.memberId)
  if (!actor.ok) throw new Error(actor.error.message)
  return actor.value
}

const run = (actor: Actor, cmd: RoomCommand, now = T0) => executeCommand(room, actor, cmd, now, deps)
const queue = () => room.dump(C.queue).map((r) => ({ id: r.recordId, ...r.data }) as Record<string, unknown> & { id: string })
const playback = () => room.dump(C.playback).find((r) => r.recordId === STATE_ID)?.data as Record<string, unknown>
const roomState = () => room.dump(C.roomState).find((r) => r.recordId === STATE_ID)?.data as Record<string, unknown>

beforeEach(async () => {
  app = createMemoryTools()
  room = createMemoryTools()
  deps = { appTools: app, limits: createLimits() }
  const created = await createRoom(app, () => room, { userId: 'u-host', name: 'Hana' }, { name: 'Friday Night' }, T0)
  if (!created.ok) throw new Error(created.error.message)
  roomId = created.value.roomId
  host = await join('user:u-host', 'Hana', true)
  ann = await join('user:u-ann', 'Ann', true)
  bob = await join('guest:g-bob', 'Bob')
})

describe('rooms and membership', () => {
  it('createRoom creates the directory row, room_state, playback and host member', () => {
    const dir = app.dump(C.rooms)
    expect(dir).toHaveLength(1)
    expect(dir[0].recordId).toBe(roomId)
    expect(dir[0].data).toMatchObject({ hostUserId: 'u-host', name: 'Friday Night', status: 'open' })
    expect(String(dir[0].data.code)).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(roomState()).toMatchObject({ roomId, name: 'Friday Night', hostUserId: 'u-host', status: 'open', perGuestLimit: 3 })
    expect(playback()).toMatchObject({ state: 'idle', playbackRevision: 0, currentItemId: null })
    expect(host.role).toBe('host')
    expect(ann.role).toBe('guest')
  })

  it('join is idempotent for the same identityKey', async () => {
    const again = await joinRoom(room, { identityKey: 'user:u-ann', displayName: 'Ann', signedIn: true }, T0)
    expect(again.ok && again.value.memberId).toBe(ann.memberId)
    expect(room.dump(C.members)).toHaveLength(3)
  })

  it('rejects anonymous joins when the host disallows them', async () => {
    await run(host, { type: 'updateSettings', patch: { allowAnonymousGuests: false } })
    const r = await joinRoom(room, { identityKey: 'guest:new', displayName: 'Nina', signedIn: false }, T0)
    expect(code(r)).toBe('UNAUTHENTICATED')
  })

  it('kicked members have every command rejected and cannot rejoin', async () => {
    expect(code(await run(host, { type: 'kick', memberId: bob.memberId }))).toBe('OK')
    expect(code(await run(bob, { type: 'react', emoji: '🔥' }))).toBe('KICKED')
    const rejoin = await joinRoom(room, { identityKey: 'guest:g-bob', displayName: 'Bob', signedIn: false }, T0)
    expect(code(rejoin)).toBe('KICKED')
  })

  it('the host cannot be kicked', async () => {
    expect(code(await run(host, { type: 'kick', memberId: host.memberId }))).toBe('INVALID')
  })
})

describe('enqueue', () => {
  it('assigns increasing enqueueSeq and sortKey', async () => {
    await run(ann, { type: 'enqueue', track: track('aaa'), idempotencyKey: 'k1' })
    await run(bob, { type: 'enqueue', track: track('bbb'), idempotencyKey: 'k2' })
    const [a, b] = queue().sort((x, y) => Number(x.enqueueSeq) - Number(y.enqueueSeq))
    expect(Number(b.enqueueSeq)).toBeGreaterThan(Number(a.enqueueSeq))
    expect(String(b.sortKey) > String(a.sortKey)).toBe(true)
    expect(a).toMatchObject({ trackKey: 'youtube:aaa', requestedByName: 'Ann', status: 'queued', voteCount: 0 })
  })

  it('concurrent duplicate enqueue yields one item and DUPLICATE with existingItemId', async () => {
    const [r1, r2] = await Promise.all([
      run(ann, { type: 'enqueue', track: track('same'), idempotencyKey: 'a' }),
      run(bob, { type: 'enqueue', track: track('same'), idempotencyKey: 'b' }),
    ])
    const results = [r1, r2]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)
    expect(loser && !loser.ok && loser.error.code).toBe('DUPLICATE')
    expect(queue()).toHaveLength(1)
    expect(loser && !loser.ok && loser.error.existingItemId).toBe(queue()[0].id)
  })

  it('concurrent distinct enqueues get distinct enqueueSeq', async () => {
    await Promise.all([
      run(ann, { type: 'enqueue', track: track('one'), idempotencyKey: 'a' }),
      run(bob, { type: 'enqueue', track: track('two'), idempotencyKey: 'b' }),
      run(host, { type: 'enqueue', track: track('three'), idempotencyKey: 'c' }),
    ])
    const seqs = queue().map((q) => q.enqueueSeq)
    expect(new Set(seqs).size).toBe(3)
  })

  it('repeating an idempotencyKey returns the same itemId without a second item', async () => {
    const r1 = await run(ann, { type: 'enqueue', track: track('idem'), idempotencyKey: 'same-key' })
    const r2 = await run(ann, { type: 'enqueue', track: track('idem'), idempotencyKey: 'same-key' })
    expect(r1.ok && r2.ok).toBe(true)
    expect(r1.ok && r2.ok && r2.value.itemId).toBe(r1.ok ? r1.value.itemId : undefined)
    expect(queue()).toHaveLength(1)
  })

  it('a removed track can be requested again', async () => {
    const r1 = await run(ann, { type: 'enqueue', track: track('again'), idempotencyKey: 'x1' })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(code(await run(ann, { type: 'remove', itemId: r1.value.itemId as string }))).toBe('OK')
    expect(code(await run(bob, { type: 'enqueue', track: track('again'), idempotencyKey: 'x2' }))).toBe('OK')
  })

  it('locked requests reject guests', async () => {
    await run(host, { type: 'updateSettings', patch: { guestRequestsEnabled: false } })
    expect(code(await run(ann, { type: 'enqueue', track: track('lock'), idempotencyKey: 'l' }))).toBe('REQUESTS_LOCKED')
    expect(code(await run(host, { type: 'enqueue', track: track('lock'), idempotencyKey: 'l' }))).toBe('OK')
  })

  it('rate limits rapid enqueues per member', async () => {
    for (let i = 0; i < 5; i++) {
      await run(host, { type: 'enqueue', track: track(`r${i}`), idempotencyKey: `r${i}` })
    }
    expect(code(await run(host, { type: 'enqueue', track: track('r6'), idempotencyKey: 'r6' }))).toBe('RATE_LIMITED')
  })
})

describe('votes', () => {
  it('voting twice keeps voteCount 1; unvote returns it to 0', async () => {
    const r = await run(ann, { type: 'enqueue', track: track('v'), idempotencyKey: 'v' })
    const itemId = r.ok ? (r.value.itemId as string) : ''
    await run(bob, { type: 'vote', itemId })
    await run(bob, { type: 'vote', itemId })
    expect(queue()[0].voteCount).toBe(1)
    await run(host, { type: 'vote', itemId })
    expect(queue()[0].voteCount).toBe(2)
    await run(bob, { type: 'unvote', itemId })
    expect(queue()[0].voteCount).toBe(1)
  })
})

describe('moderation permissions', () => {
  it('guests cannot moderate', async () => {
    const r = await run(ann, { type: 'enqueue', track: track('m'), idempotencyKey: 'm' })
    const itemId = r.ok ? (r.value.itemId as string) : ''
    const guestCommands: RoomCommand[] = [
      { type: 'advance', reason: 'skip', expectedRevision: 0 },
      { type: 'kick', memberId: ann.memberId },
      { type: 'reorder', itemId, beforeId: null, afterId: null, expectedQueueRevision: 0 },
      { type: 'pin', itemId },
      { type: 'updateSettings', patch: { perGuestLimit: 9 } },
      { type: 'closeRoom' },
      { type: 'play', expectedRevision: 0 },
      { type: 'claimController', controllerId: 'evil', takeover: true },
    ]
    for (const cmd of guestCommands) expect([cmd.type, code(await run(bob, cmd))]).toEqual([cmd.type, 'FORBIDDEN'])
  })

  it('a guest removes their own queued item but not someone else’s', async () => {
    const mine = await run(ann, { type: 'enqueue', track: track('own'), idempotencyKey: 'o' })
    const theirs = await run(bob, { type: 'enqueue', track: track('theirs'), idempotencyKey: 't' })
    expect(code(await run(ann, { type: 'remove', itemId: theirs.ok ? (theirs.value.itemId as string) : '' }))).toBe('FORBIDDEN')
    expect(code(await run(ann, { type: 'remove', itemId: mine.ok ? (mine.value.itemId as string) : '' }))).toBe('OK')
    expect(queue().find((q) => q.trackKey === 'youtube:own')?.status).toBe('removed')
  })

  it('reorder with a stale queueRevision is STALE_REVISION', async () => {
    const a = await run(ann, { type: 'enqueue', track: track('ra'), idempotencyKey: 'ra' })
    const b = await run(ann, { type: 'enqueue', track: track('rb'), idempotencyKey: 'rb' })
    const aId = a.ok ? (a.value.itemId as string) : ''
    const bId = b.ok ? (b.value.itemId as string) : ''
    const ok1 = await run(host, { type: 'reorder', itemId: bId, beforeId: null, afterId: aId, expectedQueueRevision: 0 })
    expect(code(ok1)).toBe('OK')
    const stale = await run(host, { type: 'reorder', itemId: aId, beforeId: null, afterId: bId, expectedQueueRevision: 0 })
    expect(code(stale)).toBe('STALE_REVISION')
    const ordered = queue().sort((x, y) => (String(x.sortKey) < String(y.sortKey) ? -1 : 1))
    expect(ordered.map((q) => q.id)).toEqual([bId, aId])
    expect(roomState().queueRevision).toBe(1)
  })

  it('closeRoom blocks later enqueues with ROOM_CLOSED', async () => {
    expect(code(await run(host, { type: 'closeRoom' }))).toBe('OK')
    expect(code(await run(ann, { type: 'enqueue', track: track('late'), idempotencyKey: 'late' }))).toBe('ROOM_CLOSED')
    expect(app.dump(C.rooms)[0].data.status).toBe('closed')
  })
})

describe('playback', () => {
  async function startPlaying() {
    await run(ann, { type: 'enqueue', track: track('p1'), idempotencyKey: 'p1' })
    await run(bob, { type: 'enqueue', track: track('p2'), idempotencyKey: 'p2' })
    expect(code(await run(host, { type: 'claimController', controllerId: 'tabA', takeover: false }))).toBe('OK')
    expect(code(await run(host, { type: 'play', expectedRevision: 0, controllerId: 'tabA' }))).toBe('OK')
  }

  it('play starts the first queued item and marks it playing', async () => {
    await startPlaying()
    const pb = playback()
    const first = queue().find((q) => q.trackKey === 'youtube:p1')
    expect(pb).toMatchObject({ state: 'playing', currentItemId: first?.id, playbackRevision: 1 })
    expect(first?.status).toBe('playing')
  })

  it('advance is idempotent per revision under concurrency (two ENDED → one advance)', async () => {
    await startPlaying()
    const cmd: RoomCommand = { type: 'advance', reason: 'ended', expectedRevision: 1, controllerId: 'tabA' }
    const [r1, r2] = await Promise.all([run(host, cmd, T0 + 1000), run(host, cmd, T0 + 1000)])
    expect(r1.ok || r2.ok).toBe(true)
    expect(playback().playbackRevision).toBe(2)
    const statuses = Object.fromEntries(queue().map((q) => [q.trackKey, q.status]))
    expect(statuses).toEqual({ 'youtube:p1': 'played', 'youtube:p2': 'playing' })
  })

  it('advance from a non-controller tab is rejected', async () => {
    await startPlaying()
    const r = await run(host, { type: 'advance', reason: 'ended', expectedRevision: 1, controllerId: 'tabB' })
    expect(code(r)).toBe('NOT_CONTROLLER')
    expect(playback().playbackRevision).toBe(1)
  })

  it('enqueue restarts playback when the queue had run dry', async () => {
    await run(ann, { type: 'enqueue', track: track('solo'), idempotencyKey: 's' })
    await run(host, { type: 'claimController', controllerId: 'tabA', takeover: false })
    await run(host, { type: 'play', expectedRevision: 0, controllerId: 'tabA' })
    await run(host, { type: 'advance', reason: 'ended', expectedRevision: 1, controllerId: 'tabA' })
    expect(playback().state).toBe('idle')
    await run(bob, { type: 'enqueue', track: track('next'), idempotencyKey: 'n' })
    expect(playback()).toMatchObject({ state: 'playing' })
    expect(queue().find((q) => q.trackKey === 'youtube:next')?.status).toBe('playing')
  })

  it('removing the playing item as host skips to the next song', async () => {
    await startPlaying()
    const current = String(playback().currentItemId)
    expect(code(await run(host, { type: 'remove', itemId: current }))).toBe('OK')
    expect(queue().find((q) => q.id === current)?.status).toBe('removed')
    expect(queue().find((q) => q.trackKey === 'youtube:p2')?.status).toBe('playing')
  })
})

describe('reactions and activity', () => {
  it('rate limits reactions to one per two seconds per member', async () => {
    expect(code(await run(ann, { type: 'react', emoji: '🔥' }, T0))).toBe('OK')
    expect(code(await run(ann, { type: 'react', emoji: '🔥' }, T0 + 500))).toBe('RATE_LIMITED')
    expect(code(await run(ann, { type: 'react', emoji: '🔥' }, T0 + 2_100))).toBe('OK')
    expect(code(await run(ann, { type: 'react', emoji: '💩' }, T0 + 9_000))).toBe('INVALID')
  })

  it('records activity events for joins and requests', async () => {
    await run(ann, { type: 'enqueue', track: track('ev'), idempotencyKey: 'ev' })
    const types = room.dump(C.events).map((e) => e.data.type)
    expect(types).toContain('join')
    expect(types).toContain('enqueue')
  })
})
