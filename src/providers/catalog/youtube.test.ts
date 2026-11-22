import { describe, expect, it, vi } from 'vitest'
import { createYouTubeProvider, parseIsoDuration } from './youtube'

const searchBody = {
  items: [
    {
      id: { videoId: 'aaaaaaaaaaa' },
      snippet: {
        title: 'Daft Punk &amp; Friends &#39;One More Time&#39;',
        channelTitle: 'Daft Punk',
        thumbnails: { default: { url: 'https://i.ytimg.com/vi/a/default.jpg' }, high: { url: 'https://i.ytimg.com/vi/a/hq.jpg' } },
      },
    },
    {
      id: { videoId: 'bbbbbbbbbbb' },
      snippet: { title: 'Not embeddable', channelTitle: 'Label', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/b/mq.jpg' } } },
    },
  ],
}

const videosBody = {
  items: [
    { id: 'aaaaaaaaaaa', contentDetails: { duration: 'PT5M20S' }, status: { embeddable: true } },
    { id: 'bbbbbbbbbbb', contentDetails: { duration: 'PT3M' }, status: { embeddable: false } },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function okFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/search?')) return jsonResponse(searchBody)
    if (u.includes('/videos?')) return jsonResponse(videosBody)
    throw new Error(`unexpected ${u}`)
  })
}

describe('YouTube catalog provider', () => {
  it('normalizes search + videos into CatalogTrack with trackKey youtube:<id>', async () => {
    const fetchImpl = okFetch()
    const r = await createYouTubeProvider('KEY', fetchImpl as unknown as typeof fetch).search('daft punk')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]).toEqual({
      source: 'youtube',
      sourceId: 'aaaaaaaaaaa',
      trackKey: 'youtube:aaaaaaaaaaa',
      title: "Daft Punk & Friends 'One More Time'",
      creatorLabel: 'Daft Punk',
      thumbnailUrl: 'https://i.ytimg.com/vi/a/hq.jpg',
      durationMs: 320_000,
      canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      playable: true,
    })
    const searchUrl = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      videoCategoryId: '10',
      maxResults: '12',
      q: 'daft punk',
      key: 'KEY',
    })
  })

  it('filters out non-embeddable videos', async () => {
    const r = await createYouTubeProvider('KEY', okFetch() as unknown as typeof fetch).search('x')
    expect(r.ok && r.value.map((t) => t.sourceId)).toEqual(['aaaaaaaaaaa'])
  })

  it('returns PROVIDER_NOT_CONFIGURED without calling fetch when no key is set', async () => {
    const fetchImpl = okFetch()
    const r = await createYouTubeProvider(undefined, fetchImpl as unknown as typeof fetch).search('x')
    expect(!r.ok && r.error.code).toBe('PROVIDER_NOT_CONFIGURED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps quotaExceeded to QUOTA', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, 403))
    const r = await createYouTubeProvider('KEY', fetchImpl as unknown as typeof fetch).search('x')
    expect(!r.ok && r.error.code).toBe('QUOTA')
  })

  it('maps other upstream failures to UPSTREAM', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 500 } }, 500))
    const r = await createYouTubeProvider('KEY', fetchImpl as unknown as typeof fetch).search('x')
    expect(!r.ok && r.error.code).toBe('UPSTREAM')
  })

  it('maps an invalid key to PROVIDER_NOT_CONFIGURED', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 400, errors: [{ reason: 'keyInvalid' }] } }, 400))
    const r = await createYouTubeProvider('KEY', fetchImpl as unknown as typeof fetch).search('x')
    expect(!r.ok && r.error.code).toBe('PROVIDER_NOT_CONFIGURED')
  })

  it('returns an empty list when search finds nothing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }))
    const r = await createYouTubeProvider('KEY', fetchImpl as unknown as typeof fetch).search('zzzz')
    expect(r.ok && r.value).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('parseIsoDuration', () => {
  it('handles hours, minutes, seconds and zero', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3_723_000)
    expect(parseIsoDuration('PT45S')).toBe(45_000)
    expect(parseIsoDuration('P0D')).toBe(0)
    expect(parseIsoDuration('garbage')).toBeUndefined()
  })
})

describe('YouTube resolve (server-side enqueue validation)', () => {
  const video = (embeddable: boolean) => ({
    items: [
      {
        id: 'aaaaaaaaaaa',
        snippet: { title: 'Real &amp; True', channelTitle: 'Chan', thumbnails: { high: { url: 'https://i.ytimg.com/vi/a/hq.jpg' } } },
        contentDetails: { duration: 'PT3M' },
        status: { embeddable, privacyStatus: 'public' },
      },
    ],
  })

  it('returns authoritative metadata for an embeddable video in one videos.list call', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse(video(true)))
    const r = await createYouTubeProvider('KEY', fetchImpl as unknown as typeof fetch).resolve('aaaaaaaaaaa')
    expect(r.ok && r.value).toMatchObject({ trackKey: 'youtube:aaaaaaaaaaa', title: 'Real & True', creatorLabel: 'Chan', durationMs: 180_000 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('part=snippet%2CcontentDetails%2Cstatus')
  })

  it('rejects videos that cannot be embedded or do not exist', async () => {
    const blocked = await createYouTubeProvider('KEY', (async () => jsonResponse(video(false))) as unknown as typeof fetch).resolve('aaaaaaaaaaa')
    expect(!blocked.ok && blocked.error.code).toBe('INVALID')
    const missing = await createYouTubeProvider('KEY', (async () => jsonResponse({ items: [] })) as unknown as typeof fetch).resolve('aaaaaaaaaaa')
    expect(!missing.ok && missing.error.code).toBe('INVALID')
  })

  it('reports PROVIDER_NOT_CONFIGURED without a key', async () => {
    const r = await createYouTubeProvider(undefined).resolve('aaaaaaaaaaa')
    expect(!r.ok && r.error.code).toBe('PROVIDER_NOT_CONFIGURED')
  })
})
