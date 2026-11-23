/** Final-review fixes: ENDED/error reports are retried, and a false "blocked" is cleared once playback starts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostPlaybackAgent } from './host-agent'
import type { PlaybackController } from '@/providers/playback/types'
import type { DomainError, PlaybackState, QueueItem } from '@/domain/types'
import type { RoomCommand } from '@/server/commands'

const NOW = 1_000_000

function fakePlayer() {
  const h = { ended: [] as Array<() => void>, error: [] as Array<(c: number) => void>, playing: [] as Array<() => void> }
  const player: PlaybackController = {
    load: vi.fn(async () => {}),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    setVolume: vi.fn(),
    currentTime: vi.fn(() => 41),
    onEnded: (f) => (h.ended.push(f), () => {}),
    onError: (f) => (h.error.push(f), () => {}),
    onPlaying: (f) => (h.playing.push(f), () => {}),
    destroy: vi.fn(),
  }
  return { player, fire: { ended: () => h.ended.forEach((f) => f()), playing: () => h.playing.forEach((f) => f()) } }
}

const item: QueueItem = {
  id: 'i1', trackKey: 'youtube:abcdefghijk', title: 't', requestedByMemberId: 'm', requestedByName: 'M', enqueueSeq: 1,
  sortKey: 'a', pinnedAt: null, status: 'playing', voteCount: 0, createdAt: 0,
}
const pb = (p: Partial<PlaybackState> = {}): PlaybackState => ({
  currentItemId: 'i1', state: 'playing', startedAt: NOW, pausedAtSec: null, playbackRevision: 3,
  controllerId: 'tabA', controllerLeaseUntil: NOW + 60_000, errorReason: null, consecutiveFailures: 0, updatedAt: NOW, ...p,
})

type Reply = { ok: true } | { ok: false; error: DomainError }
let replies: Reply[]
let sent: RoomCommand[]
let f: ReturnType<typeof fakePlayer>
let agent: HostPlaybackAgent

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  replies = []
  f = fakePlayer()
  agent = new HostPlaybackAgent({
    controllerId: 'tabA',
    player: f.player,
    now: () => NOW,
    send: async (cmd) => {
      sent.push(cmd)
      return replies.shift() ?? { ok: true }
    },
  })
})

afterEach(() => {
  agent.dispose()
  vi.useRealTimers()
})

const fail = (code: DomainError['code']): Reply => ({ ok: false, error: { code, message: code } })

describe('report retries', () => {
  it('retries a song-ended report after a network failure', async () => {
    await agent.sync(pb(), [item])
    f.fire.playing()
    replies = [fail('UPSTREAM'), fail('UPSTREAM')]
    f.fire.ended()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent.filter((c) => c.type === 'advance')).toHaveLength(3)
  })

  it('re-claims the controller lease and retries on NOT_CONTROLLER', async () => {
    await agent.sync(pb(), [item])
    f.fire.playing()
    replies = [fail('NOT_CONTROLLER')]
    f.fire.ended()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent.map((c) => c.type)).toEqual(['advance', 'claimController', 'advance'])
  })

  it('stops retrying on STALE_REVISION or once the revision moves on', async () => {
    await agent.sync(pb(), [item])
    f.fire.playing()
    replies = [fail('STALE_REVISION')]
    f.fire.ended()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent.filter((c) => c.type === 'advance')).toHaveLength(1)
  })
})

describe('false blocked', () => {
  it('sends play with the real position when playback starts after "blocked" was reported', async () => {
    await agent.sync(pb(), [item])
    await vi.advanceTimersByTimeAsync(4_000) // slow buffering → blocked reported
    expect(sent.map((c) => c.type)).toEqual(['blocked'])
    await agent.sync(pb({ state: 'blocked', playbackRevision: 4 }), [item])
    f.fire.playing()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent[1]).toEqual({ type: 'play', expectedRevision: 4, controllerId: 'tabA', positionSec: 41 })
  })
})
