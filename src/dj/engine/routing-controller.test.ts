import { describe, expect, it, vi } from 'vitest'
import type { PlaybackController } from '../../providers/playback/types'
import { createRoutingController, outputFor } from './routing-controller'

function fake(): PlaybackController & { fire: { ended: () => void } } {
  const ended = new Set<() => void>()
  return {
    load: vi.fn(async () => {}),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    setVolume: vi.fn(),
    currentTime: () => 0,
    onEnded: (h) => (ended.add(h), () => ended.delete(h)),
    onError: () => () => {},
    onPlaying: () => () => {},
    destroy: vi.fn(),
    fire: { ended: () => ended.forEach((h) => h()) },
  }
}

describe('routing controller', () => {
  it('classifies keys', () => {
    expect(outputFor('dQw4w9WgXcQ')).toBe('youtube')
    expect(outputFor('audius:abc#item1')).toBe('waveform')
    expect(outputFor('jamendo:42#item1')).toBe('waveform')
  })
  it('routes loads, stops the other output and forwards only active events', async () => {
    const yt = fake()
    const wf = fake()
    const changes: string[] = []
    const r = createRoutingController(yt, wf, (k) => changes.push(k))
    const ended = vi.fn()
    r.onEnded(ended)
    await r.load('vid1', 0)
    expect(yt.load).toHaveBeenCalledWith('vid1', 0)
    await r.load('audius:abc#i2', 12.5)
    expect(yt.stop).toHaveBeenCalled()
    expect(wf.load).toHaveBeenCalledWith('audius:abc#i2', 12.5)
    expect(changes).toEqual(['waveform'])
    yt.fire.ended()
    expect(ended).not.toHaveBeenCalled()
    wf.fire.ended()
    expect(ended).toHaveBeenCalledTimes(1)
  })
})
