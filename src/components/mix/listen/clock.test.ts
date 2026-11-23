import { describe, expect, it } from 'vitest'
import { PlaybackClock, type MediaLike } from './clock'

function setup() {
  const media: MediaLike = { currentTime: 0, paused: true, ended: false, seeking: false, playbackRate: 1, readyState: 4 }
  let wall = 100
  const clock = new PlaybackClock(media, () => wall)
  return {
    media,
    clock,
    advance(dt: number, mediaUpdate = true) {
      wall += dt
      if (!media.paused && mediaUpdate) media.currentTime += dt * media.playbackRate
    },
  }
}

describe('PlaybackClock — audio element is the source of truth', () => {
  it('paused: returns exactly currentTime, no matter how much wall time passes', () => {
    const s = setup()
    s.media.currentTime = 42.5
    s.advance(10)
    expect(s.clock.now()).toBe(42.5)
  })
  it('playing: extrapolates between coarse currentTime updates, then re-anchors', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    expect(s.clock.now()).toBe(10)
    s.advance(0.016, false) // media did not tick yet
    expect(s.clock.now()).toBeCloseTo(10.016, 6)
    s.advance(0.234) // media ticks (to 10.234: it missed the first 16 ms)
    const t = s.clock.now()
    expect(t).toBeGreaterThan(10.234 - 1e-9)
    expect(t).toBeLessThan(10.25 + 1e-9)
  })
  it('seek snaps immediately (both directions)', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    s.clock.now()
    s.advance(0.1)
    s.media.currentTime = 300
    expect(s.clock.now()).toBe(300)
    s.advance(0.05)
    s.media.currentTime = 5
    expect(s.clock.now()).toBe(5)
  })
  it('pause freezes on the heard position', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    s.clock.now()
    s.advance(0.5)
    s.clock.now()
    s.media.paused = true
    const t = s.clock.now()
    s.advance(3)
    expect(s.clock.now()).toBe(t)
    expect(t).toBe(s.media.currentTime)
  })
  it('playback-rate changes stay in sync', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    s.clock.now()
    s.media.playbackRate = 2
    for (let i = 0; i < 60; i++) {
      s.advance(1 / 60)
      s.clock.now()
    }
    expect(Math.abs(s.clock.now() - s.media.currentTime)).toBeLessThan(0.02)
  })
  it('background-tab throttling (no frames for 30 s) does not leave a permanent offset', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    s.clock.now()
    s.advance(30) // tab hidden: no reads, media kept playing
    expect(s.clock.now()).toBeCloseTo(40, 6)
  })
  it('a stalled element (currentTime stuck) cannot run the animation ahead', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    s.clock.now()
    for (let i = 0; i < 120; i++) {
      s.advance(1 / 60, false)
      expect(s.clock.now()).toBeLessThanOrEqual(10 + 0.12 + 1e-9)
    }
  })
  it('small jitter never moves time backwards while playing', () => {
    const s = setup()
    s.media.paused = false
    s.media.currentTime = 10
    let prev = s.clock.now()
    for (let i = 0; i < 200; i++) {
      s.advance(1 / 60, i % 7 === 0)
      if (i % 7 === 0) s.media.currentTime += (i % 2 ? 1 : -1) * 0.01
      const t = s.clock.now()
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
  })
})
