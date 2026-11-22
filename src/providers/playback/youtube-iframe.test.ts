import { describe, expect, it, vi } from 'vitest'
import { createYouTubeIframeController } from './youtube-iframe'
import type { YTNamespace, YTPlayerOptions } from './youtube-iframe'

function fakeYT() {
  let options: YTPlayerOptions | undefined
  const player = {
    loadVideoById: vi.fn(),
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    stopVideo: vi.fn(),
    setVolume: vi.fn(),
    getCurrentTime: vi.fn(() => 12.5),
    getPlayerState: vi.fn(() => -1),
    destroy: vi.fn(),
  }
  const YT: YTNamespace = {
    Player: vi.fn(function (this: unknown, _el: unknown, opts: YTPlayerOptions) {
      options = opts
      queueMicrotask(() => opts.events.onReady?.({ target: player }))
      return player
    }) as unknown as YTNamespace['Player'],
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  }
  const emitState = (data: number) => options?.events.onStateChange?.({ data, target: player })
  const emitError = (data: number) => options?.events.onError?.({ data, target: player })
  return { YT, player, emitState, emitError, getOptions: () => options }
}

const container = {} as HTMLElement

describe('YouTube IFrame controller', () => {
  it('load calls loadVideoById with startSeconds after the player is ready', async () => {
    const f = fakeYT()
    const c = createYouTubeIframeController(container, async () => f.YT)
    await c.load('dQw4w9WgXcQ', 42)
    expect(f.player.loadVideoById).toHaveBeenCalledWith({ videoId: 'dQw4w9WgXcQ', startSeconds: 42 })
    expect(f.getOptions()?.playerVars).toMatchObject({ playsinline: 1, rel: 0 })
  })

  it('fires onEnded once per loaded video even if ENDED repeats', async () => {
    const f = fakeYT()
    const c = createYouTubeIframeController(container, async () => f.YT)
    const ended = vi.fn()
    c.onEnded(ended)
    await c.load('aaaaaaaaaaa')
    f.emitState(0)
    f.emitState(0)
    expect(ended).toHaveBeenCalledTimes(1)
    await c.load('bbbbbbbbbbb')
    f.emitState(0)
    expect(ended).toHaveBeenCalledTimes(2)
  })

  it('surfaces player error codes such as 150', async () => {
    const f = fakeYT()
    const c = createYouTubeIframeController(container, async () => f.YT)
    const onError = vi.fn()
    c.onError(onError)
    await c.load('aaaaaaaaaaa')
    f.emitError(150)
    expect(onError).toHaveBeenCalledWith(150)
  })

  it('reports playing and exposes current time and volume', async () => {
    const f = fakeYT()
    const c = createYouTubeIframeController(container, async () => f.YT)
    const playing = vi.fn()
    c.onPlaying(playing)
    await c.load('aaaaaaaaaaa')
    f.emitState(1)
    expect(playing).toHaveBeenCalledTimes(1)
    expect(c.currentTime()).toBe(12.5)
    c.setVolume(140)
    expect(f.player.setVolume).toHaveBeenCalledWith(100)
  })

  it('unsubscribes handlers', async () => {
    const f = fakeYT()
    const c = createYouTubeIframeController(container, async () => f.YT)
    const ended = vi.fn()
    const off = c.onEnded(ended)
    off()
    await c.load('aaaaaaaaaaa')
    f.emitState(0)
    expect(ended).not.toHaveBeenCalled()
  })
})
