import { beforeEach, describe, expect, it } from 'vitest'
import { C, STATE_ID } from '../schemas/names'
import { createLimits, createRoom, executeCommand, joinRoom, loadActor } from './commands'
import type { CommandDeps, RoomCommand } from './commands'
import { parseCommand } from './http'
import { createMemoryTools } from './testing/memory-tools'
import type { MemoryTools } from './testing/memory-tools'
import type { Actor, Result } from '../domain/types'

const T0 = 1_700_000_000_000
const CTRL = 'controller-0001'
const code = (r: Result<unknown>) => (r.ok ? 'OK' : r.error.code)
const audius = (id: string) => ({ trackKey: `audius:${id}`, title: `Track ${id}`, creatorLabel: 'Artist', durationMs: 300_000 })

let room: MemoryTools
let deps: CommandDeps
let host: Actor
let guest: Actor

async function join(identityKey: string, displayName: string): Promise<Actor> {
  const r = await joinRoom(room, { identityKey, displayName, signedIn: true }, T0)
  if (!r.ok) throw new Error(r.error.message)
  const a = await loadActor(room, r.value.memberId)
  if (!a.ok) throw new Error(a.error.message)
  return a.value
}

const run = (actor: Actor, cmd: RoomCommand, now = T0) => executeCommand(room, actor, cmd, now, deps)
const playback = () => room.dump(C.playback).find((r) => r.recordId === STATE_ID)?.data as Record<string, unknown>
const dj = () => room.dump(C.dj).find((r) => r.recordId === STATE_ID)?.data as Record<string, unknown> | undefined
const queue = () => room.dump(C.queue).map((r) => ({ id: r.recordId, ...r.data }) as Record<string, unknown> & { id: string })

const summary = {
  v: 'cp-dsp-1.0.0', bpm: 124, bpmConf: 0.9, firstBeat: 0.1, downbeatPhase: 0, downbeatConf: 0.5, stable: true, key: 'A minor', camelot: '8A', keyConf: 0.6,
  lufs: -9, truePeak: -0.4, durationSec: 300, phrasesSec: [0, 15.5], cueIn: [0], cueOut: [240], introBars: 16, outroBars: 16, barSec: 1.935,
  vocalIn: 0.1, vocalOut: 0.1, energyIn: -20, energyOut: -20, energyMean: -14, flags: [],
}

beforeEach(async () => {
  const app = createMemoryTools()
  room = createMemoryTools()
  deps = { appTools: app, limits: createLimits() }
  const created = await createRoom(app, () => room, { userId: 'u-host', name: 'Hana' }, { name: 'Club' }, T0)
  if (!created.ok) throw new Error(created.error.message)
  host = await join('user:u-host', 'Hana')
  guest = await join('user:u-g', 'Gus')
  expect(code(await run(host, { type: 'claimController', controllerId: CTRL, takeover: false }))).toBe('OK')
})

describe('AI DJ commands', () => {
  it('validates DJ commands strictly at the HTTP boundary', () => {
    expect(parseCommand({ type: 'djSettings', patch: { maxTempoPct: 9 } }).ok).toBe(false)
    expect(parseCommand({ type: 'saveAnalysis', trackKey: 'audius:abc', status: 'ready', analyzerVersion: 'x', summary }).ok).toBe(true)
    expect(parseCommand({ type: 'saveAnalysis', trackKey: 'spotify:abc', status: 'ready', analyzerVersion: 'x' }).ok).toBe(false)
    expect(parseCommand({ type: 'advance', reason: 'ended', expectedRevision: 1, nextItemId: 'x', startPositionSec: 12.5 }).ok).toBe(true)
  })

  it('only the host changes DJ settings; AI reordering stays off by default', async () => {
    expect(code(await run(guest, { type: 'djSettings', patch: { autopilot: true } }))).toBe('FORBIDDEN')
    expect(code(await run(host, { type: 'djSettings', patch: { autopilot: true } }))).toBe('OK')
    expect(dj()).toMatchObject({ autopilot: true, aiReorder: false, maxTempoPct: 6 })
  })

  it('stores analysis summaries only for waveform sources, host only', async () => {
    expect(code(await run(guest, { type: 'saveAnalysis', trackKey: 'audius:a1', status: 'ready', analyzerVersion: 'v', summary }))).toBe('FORBIDDEN')
    expect(code(await run(host, { type: 'saveAnalysis', trackKey: 'youtube:abc', status: 'ready', analyzerVersion: 'v', summary }))).toBe('INVALID')
    expect(code(await run(host, { type: 'saveAnalysis', trackKey: 'audius:a1', status: 'ready', analyzerVersion: 'v', summary }))).toBe('OK')
    expect(code(await run(host, { type: 'saveAnalysis', trackKey: 'audius:a1', status: 'low_confidence', analyzerVersion: 'v', summary }))).toBe('OK')
    const rows = room.dump(C.features)
    expect(rows).toHaveLength(1)
    expect(rows[0].data.status).toBe('low_confidence')
  })

  it('commits a transition only against the current playback revision and from the controller', async () => {
    await run(host, { type: 'enqueue', track: audius('a'), idempotencyKey: 'k1' })
    await run(host, { type: 'enqueue', track: audius('b'), idempotencyKey: 'k2' })
    await run(host, { type: 'play', expectedRevision: Number(playback().playbackRevision), controllerId: CTRL })
    const pb = playback()
    const [a, b] = queue().sort((x, y) => Number(x.enqueueSeq) - Number(y.enqueueSeq))
    expect(pb.currentItemId).toBe(a.id)
    const transition = { fromItemId: a.id, toItemId: b.id, style: 'bass_swap', outCueSec: 240, inCueSec: 0, overlapBars: 16, tempoRatio: 1 }
    const rev = Number(pb.playbackRevision)
    expect(code(await run(host, { type: 'djStatus', status: 'committed', transition, expectedPlaybackRevision: rev - 1, controllerId: CTRL }))).toBe('STALE_REVISION')
    expect(code(await run(host, { type: 'djStatus', status: 'committed', transition, expectedPlaybackRevision: rev, controllerId: 'other-device-1' }))).toBe('NOT_CONTROLLER')
    expect(code(await run(host, { type: 'djStatus', status: 'committed', transition: { ...transition, fromItemId: b.id }, expectedPlaybackRevision: rev, controllerId: CTRL }))).toBe('STALE_REVISION')
    expect(code(await run(host, { type: 'djStatus', status: 'committed', transition, expectedPlaybackRevision: rev, controllerId: CTRL }))).toBe('OK')
    expect(dj()).toMatchObject({ status: 'committed', basedOnPlaybackRevision: rev })
  })

  it('mix handoff starts the committed item at the reported position (not FIFO, not position 0)', async () => {
    await run(host, { type: 'enqueue', track: audius('a'), idempotencyKey: 'k1' })
    await run(host, { type: 'enqueue', track: audius('b'), idempotencyKey: 'k2' })
    await run(host, { type: 'enqueue', track: audius('c'), idempotencyKey: 'k3' })
    await run(host, { type: 'play', expectedRevision: Number(playback().playbackRevision), controllerId: CTRL })
    const items = queue().sort((x, y) => Number(x.enqueueSeq) - Number(y.enqueueSeq))
    const c = items[2]
    const rev = Number(playback().playbackRevision)
    const now = T0 + 60_000
    const r = await run(host, { type: 'advance', reason: 'ended', expectedRevision: rev, controllerId: CTRL, nextItemId: c.id, startPositionSec: 31 }, now)
    expect(code(r)).toBe('OK')
    const pb = playback()
    expect(pb.currentItemId).toBe(c.id)
    expect(pb.startedAt).toBe(now - 31_000)
    // a duplicate report of the same revision is a no-op
    expect(code(await run(host, { type: 'advance', reason: 'ended', expectedRevision: rev, controllerId: CTRL, nextItemId: items[1].id }, now))).toBe('STALE_REVISION')
  })

  it('a handoff to an item that left the queue falls back to the normal next song', async () => {
    await run(host, { type: 'enqueue', track: audius('a'), idempotencyKey: 'k1' })
    await run(host, { type: 'enqueue', track: audius('b'), idempotencyKey: 'k2' })
    await run(host, { type: 'play', expectedRevision: Number(playback().playbackRevision), controllerId: CTRL })
    const items = queue().sort((x, y) => Number(x.enqueueSeq) - Number(y.enqueueSeq))
    const rev = Number(playback().playbackRevision)
    expect(code(await run(host, { type: 'advance', reason: 'ended', expectedRevision: rev, controllerId: CTRL, nextItemId: 'gone-item-id', startPositionSec: 20 }))).toBe('OK')
    expect(playback().currentItemId).toBe(items[1].id)
  })

  it('host can lock and schedule queued items; guests cannot', async () => {
    await run(host, { type: 'enqueue', track: audius('a'), idempotencyKey: 'k1' })
    await run(host, { type: 'enqueue', track: audius('b'), idempotencyKey: 'k2' })
    const b = queue().find((i) => i.trackKey === 'audius:b')!
    expect(code(await run(guest, { type: 'lockItem', itemId: b.id, locked: true }))).toBe('FORBIDDEN')
    expect(code(await run(host, { type: 'lockItem', itemId: b.id, locked: true }))).toBe('OK')
    expect(code(await run(host, { type: 'scheduleItem', itemId: b.id, targetStartAt: T0 + 48 * 3_600_000 }))).toBe('INVALID')
    expect(code(await run(host, { type: 'scheduleItem', itemId: b.id, targetStartAt: T0 + 600_000 }))).toBe('OK')
    expect(queue().find((i) => i.id === b.id)).toMatchObject({ locked: true, targetStartAt: T0 + 600_000 })
  })

  it('attaches a conservative mixable match to YouTube requests without blocking enqueue', async () => {
    deps.findMixable = async () => ({ trackKey: 'audius:zz', confidence: 0.9, reasons: ['verified uploader'] })
    expect(code(await run(guest, { type: 'enqueue', track: { trackKey: 'youtube:abc', title: 'Artist - Song' }, idempotencyKey: 'y1' }))).toBe('OK')
    const item = queue().find((i) => i.trackKey === 'youtube:abc')!
    expect(item).toMatchObject({ mixTrackKey: 'audius:zz', mixMatch: { status: 'auto' } })
    expect(code(await run(host, { type: 'setMixSource', itemId: item.id, action: 'reject' }))).toBe('OK')
    expect(queue().find((i) => i.id === item.id)?.mixMatch).toMatchObject({ status: 'rejected' })
    deps.findMixable = async () => {
      throw new Error('audius down')
    }
    expect(code(await run(guest, { type: 'enqueue', track: { trackKey: 'youtube:def', title: 'Artist - Other' }, idempotencyKey: 'y2' }))).toBe('OK')
  })
})
