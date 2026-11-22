import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostPlaybackAgent } from './host-agent'
import type { PlaybackController } from '@/providers/playback/types'
import type { PlaybackState, QueueItem } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'

const NOW = 1_000_000

function fakePlayer() {
  const handlers = { ended: [] as Array<() => void>, error: [] as Array<(c: number) => void>, playing: [] as Array<() => void> }
  const player: PlaybackController & { fire: typeof fire } = {
    load: vi.fn(async () => {}),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    setVolume: vi.fn(),
    currentTime: vi.fn(() => 33),
    onEnded: (h) => (handlers.ended.push(h), () => {}),
    onError: (h) => (handlers.error.push(h), () => {}),
    onPlaying: (h) => (handlers.playing.push(h), () => {}),
    destroy: vi.fn(),
    fire: undefined as never,
  }
  const fire = {
    ended: () => handlers.ended.forEach((h) => h()),
    error: (c: number) => handlers.error.forEach((h) => h(c)),
    playing: () => handlers.playing.forEach((h) => h()),
  }
  player.fire = fire
  return player
}

const item = (id: string): QueueItem => ({
  id, trackKey: `youtube:${id}vid`, title: id, requestedByMemberId: 'm', requestedByName: 'M', enqueueSeq: 1,
  sortKey: 'a', pinnedAt: null, status: 'playing', voteCount: 0, createdAt: 0,
})

const pb = (p: Partial<PlaybackState> = {}): PlaybackState => ({
  currentItemId: 'i1', state: 'playing', startedAt: NOW - 20_000, pausedAtSec: null, playbackRevision: 7,
  controllerId: 'tabA', controllerLeaseUntil: NOW + 60_000, errorReason: null, consecutiveFailures: 0, updatedAt: NOW, ...p,
})

let sent: RoomCommand[]
let player: ReturnType<typeof fakePlayer>
let agent: HostPlaybackAgent

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  player = fakePlayer()
  agent = new HostPlaybackAgent({
    controllerId: 'tabA',
    player,
    now: () => NOW,
    send: async (cmd) => {
      sent.push(cmd)
      return { ok: true }
    },
  })
})

afterEach(() => {
  agent.dispose()
  vi.useRealTimers()
})

describe('HostPlaybackAgent', () => {
  it('loads the current item at the estimated position and plays it', async () => {
    await agent.sync(pb(), [item('i1')])
    expect(player.load).toHaveBeenCalledWith('i1vid', 20)
    expect(player.play).toHaveBeenCalled()
  })

  it('sends advance once per revision even if ENDED fires twice', async () => {
    await agent.sync(pb(), [item('i1')])
    player.fire.ended()
    player.fire.ended()
    expect(sent).toEqual([{ type: 'advance', reason: 'ended', expectedRevision: 7, controllerId: 'tabA' }])
  })

  it('forwards player errors as an error advance with the code', async () => {
    await agent.sync(pb(), [item('i1')])
    player.fire.error(150)
    expect(sent).toEqual([{ type: 'advance', reason: 'error', expectedRevision: 7, controllerId: 'tabA', errorCode: 150 }])
  })

  it('reports blocked when playback does not start within the timeout', async () => {
    await agent.sync(pb(), [item('i1')])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sent).toContainEqual({ type: 'blocked', expectedRevision: 7, controllerId: 'tabA' })
  })

  it('does not report blocked once the player starts', async () => {
    await agent.sync(pb(), [item('i1')])
    player.fire.playing()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sent).toEqual([])
  })

  it('pauses the player when the room is paused and does not reload the same item', async () => {
    await agent.sync(pb(), [item('i1')])
    await agent.sync(pb({ state: 'paused', pausedAtSec: 21, startedAt: null, playbackRevision: 8 }), [item('i1')])
    expect(player.pause).toHaveBeenCalled()
    expect(player.load).toHaveBeenCalledTimes(1)
  })

  it('stops and ignores events when another tab holds the lease', async () => {
    await agent.sync(pb(), [item('i1')])
    await agent.sync(pb({ controllerId: 'tabB' }), [item('i1')])
    expect(player.stop).toHaveBeenCalled()
    player.fire.ended()
    expect(sent).toEqual([])
  })

  it('stops the player when the room goes idle', async () => {
    await agent.sync(pb(), [item('i1')])
    await agent.sync(pb({ state: 'idle', currentItemId: null, startedAt: null, playbackRevision: 8 }), [])
    expect(player.stop).toHaveBeenCalled()
  })
})
