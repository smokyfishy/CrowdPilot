/**
 * Official YouTube IFrame Player API adapter. The player stays visible with
 * YouTube's own controls and branding; we never hide it, strip audio, or
 * alter the stream. https://developers.google.com/youtube/iframe_api_reference
 */
import type { PlaybackController } from './types'

export interface YTPlayerLike {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  setVolume(volume: number): void
  getCurrentTime(): number
  getPlayerState(): number
  destroy(): void
}

export interface YTPlayerOptions {
  width?: string | number
  height?: string | number
  playerVars?: Record<string, string | number>
  events: {
    onReady?: (e: { target: YTPlayerLike }) => void
    onStateChange?: (e: { data: number; target: YTPlayerLike }) => void
    onError?: (e: { data: number; target: YTPlayerLike }) => void
  }
}

export interface YTNamespace {
  Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayerLike
  PlayerState: { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTNamespace> | null = null

/** Loads https://www.youtube.com/iframe_api once per page. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT) resolve(window.YT)
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      apiPromise = null
      reject(new Error('The YouTube player could not load. Check your connection or content blockers.'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

export function createYouTubeIframeController(
  container: HTMLElement,
  loader: () => Promise<YTNamespace> = loadYouTubeApi,
): PlaybackController {
  const ended = new Set<() => void>()
  const errors = new Set<(code: number) => void>()
  const playing = new Set<() => void>()
  let player: YTPlayerLike | null = null
  let endedFired = false
  let destroyed = false

  const ready: Promise<YTPlayerLike> = loader().then(
    (YT) =>
      new Promise<YTPlayerLike>((resolve) => {
        const p = new YT.Player(container, {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: typeof location !== 'undefined' ? location.origin : '' },
          events: {
            onReady: (e) => {
              player = e.target
              resolve(e.target)
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED) {
                if (endedFired) return
                endedFired = true
                ended.forEach((h) => h())
              } else if (e.data === YT.PlayerState.PLAYING) {
                playing.forEach((h) => h())
              }
            },
            onError: (e) => errors.forEach((h) => h(e.data)),
          },
        })
        player = p
      }),
  )

  const sub = <T>(set: Set<T>, h: T) => {
    set.add(h)
    return () => void set.delete(h)
  }

  return {
    async load(videoId, startSec = 0) {
      const p = await ready
      if (destroyed) return
      endedFired = false
      p.loadVideoById({ videoId, startSeconds: Math.max(0, Math.floor(startSec)) })
    },
    play: () => player?.playVideo(),
    pause: () => player?.pauseVideo(),
    stop: () => player?.stopVideo(),
    setVolume: (v) => player?.setVolume(Math.max(0, Math.min(100, Math.round(v)))),
    currentTime: () => player?.getCurrentTime() ?? 0,
    onEnded: (h) => sub(ended, h),
    onError: (h) => sub(errors, h),
    onPlaying: (h) => sub(playing, h),
    destroy() {
      destroyed = true
      ended.clear()
      errors.clear()
      playing.clear()
      player?.destroy()
      player = null
    },
  }
}
