/**
 * Routes Phase 1's single PlaybackController seam to the right output on the host:
 * waveform keys (`audius:x#itemId`, `jamendo:n#itemId`) → HostDj (Web Audio decks),
 * anything else → the official YouTube IFrame player (standard playback, unchanged).
 * Only events from the currently active output are forwarded to the agent.
 */
import type { PlaybackController } from '../../providers/playback/types'
import { WAVEFORM_KEY_SEP } from './host-dj'

export type OutputKind = 'youtube' | 'waveform'

export function outputFor(key: string): OutputKind {
  return key.includes(WAVEFORM_KEY_SEP) && /^(audius|jamendo):/.test(key) ? 'waveform' : 'youtube'
}

export function createRoutingController(youtube: PlaybackController, waveform: PlaybackController, onOutputChange: (k: OutputKind) => void): PlaybackController {
  let active: OutputKind = 'youtube'
  const cur = () => (active === 'youtube' ? youtube : waveform)
  const forward = <A extends unknown[]>(subscribe: (c: PlaybackController, h: (...a: A) => void) => () => void, kind: OutputKind, handler: (...a: A) => void) =>
    subscribe(kind === 'youtube' ? youtube : waveform, (...a: A) => {
      if (active === kind) handler(...a)
    })
  return {
    async load(key, startSec) {
      const next = outputFor(key)
      if (next !== active) {
        cur().stop()
        active = next
        onOutputChange(next)
      }
      await cur().load(key, startSec)
    },
    play: () => cur().play(),
    pause: () => cur().pause(),
    stop: () => cur().stop(),
    setVolume: (v) => {
      youtube.setVolume(v)
      waveform.setVolume(v)
    },
    currentTime: () => cur().currentTime(),
    onEnded(h) {
      const a = forward<[]>((c, f) => c.onEnded(f), 'youtube', h)
      const b = forward<[]>((c, f) => c.onEnded(f), 'waveform', h)
      return () => (a(), b())
    },
    onError(h) {
      const a = forward<[number]>((c, f) => c.onError(f), 'youtube', h)
      const b = forward<[number]>((c, f) => c.onError(f), 'waveform', h)
      return () => (a(), b())
    },
    onPlaying(h) {
      const a = forward<[]>((c, f) => c.onPlaying(f), 'youtube', h)
      const b = forward<[]>((c, f) => c.onPlaying(f), 'waveform', h)
      return () => (a(), b())
    },
    destroy() {
      youtube.destroy()
      waveform.destroy()
    },
  }
}
