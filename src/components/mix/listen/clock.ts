/**
 * The audio element is the clock. `PlaybackClock.now()` returns the media time of what is being
 * heard, smoothed between the element's coarse `currentTime` updates (browsers update it every
 * ~15–250 ms) by extrapolating with the element's playbackRate from the last reading — never by
 * running an independent timer:
 *   - paused / seeking / ended → exactly `currentTime` (animation freezes on the frame you hear);
 *   - every read re-anchors to `currentTime` when it moves; a deviation > `snapSec` (seek, stall,
 *     background-tab throttling, playback-rate change) snaps immediately, smaller jitter is
 *     slewed out so the controls never jump backwards on a normal frame.
 */
export interface MediaLike {
  currentTime: number
  paused: boolean
  ended: boolean
  seeking: boolean
  playbackRate: number
  readyState: number
}

export class PlaybackClock {
  private anchorMedia = 0
  private anchorWall = 0
  private lastRaw = -1
  private lastOut = 0
  constructor(
    private readonly media: MediaLike,
    private readonly wall: () => number = () => performance.now() / 1000,
    private readonly snapSec = 0.12,
  ) {}

  /** Forget smoothing state (seek, src change, rate change). */
  reset(): void {
    this.lastRaw = -1
  }

  now(): number {
    const m = this.media
    const raw = m.currentTime
    const w = this.wall()
    if (m.paused || m.ended || m.seeking || m.readyState < 3) {
      this.lastRaw = raw
      this.anchorMedia = raw
      this.anchorWall = w
      this.lastOut = raw
      return raw
    }
    const rate = m.playbackRate || 1
    if (this.lastRaw < 0) {
      this.lastRaw = raw
      this.anchorMedia = raw
      this.anchorWall = w
      this.lastOut = raw
      return raw
    }
    const predicted = this.anchorMedia + (w - this.anchorWall) * rate
    if (raw !== this.lastRaw) {
      this.lastRaw = raw
      const err = raw - predicted
      if (Math.abs(err) > this.snapSec) {
        this.anchorMedia = raw
        this.anchorWall = w
        this.lastOut = raw
        return raw
      }
      // slew a quarter of the error per update: keeps motion smooth, converges in a few updates
      this.anchorMedia = predicted + err * 0.25
      this.anchorWall = w
    }
    let t = this.anchorMedia + (w - this.anchorWall) * rate
    // never run more than one snap window ahead of the media (e.g. a stall without a 'waiting' event)
    if (t > raw + this.snapSec) {
      this.anchorMedia = raw
      this.anchorWall = w
      t = raw
    }
    // monotonic while playing forward
    if (rate > 0 && t < this.lastOut && this.lastOut - t < this.snapSec) t = this.lastOut
    this.lastOut = t
    return t
  }
}
