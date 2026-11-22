/**
 * YouTube Data API v3 catalog provider (server-side only — the key never
 * reaches the browser). A search result is NOT a playback entitlement: the
 * host's official IFrame player reports real availability at play time.
 */
import { fail, ok } from '../../domain/types'
import type { Result } from '../../domain/types'
import type { CatalogTrack, MusicCatalogProvider } from './types'

const API = 'https://www.googleapis.com/youtube/v3'

type Thumbs = Record<string, { url?: string } | undefined>
interface SearchItem {
  id?: { videoId?: string }
  snippet?: { title?: string; channelTitle?: string; thumbnails?: Thumbs }
}
interface VideoItem {
  id?: string
  snippet?: { title?: string; channelTitle?: string; thumbnails?: Thumbs }
  contentDetails?: { duration?: string }
  status?: { embeddable?: boolean; privacyStatus?: string }
}

export function parseIsoDuration(iso: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso)
  if (!m) return undefined
  const [, d, h, min, s] = m.map((v) => Number(v ?? 0))
  return (((d * 24 + h) * 60 + min) * 60 + s) * 1000
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (e) => ENTITIES[e] ?? e)
}

async function upstreamError(res: Response): Promise<Result<never>> {
  let reason = ''
  try {
    const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } }
    reason = body.error?.errors?.[0]?.reason ?? ''
  } catch {
    // non-JSON error body
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') {
    return fail('QUOTA', 'Song search is over its daily YouTube quota. Try again later.')
  }
  if (reason === 'keyInvalid' || reason === 'keyExpired' || reason === 'accessNotConfigured' || reason === 'forbidden') {
    return fail('PROVIDER_NOT_CONFIGURED', 'The YouTube API key is invalid or the API is not enabled.')
  }
  return fail('UPSTREAM', 'YouTube search is unavailable right now. Try again in a moment.')
}

export function createYouTubeProvider(apiKey: string | undefined, fetchImpl: typeof fetch = fetch): MusicCatalogProvider {
  return {
    async resolve(sourceId, signal) {
      if (!apiKey) return fail('PROVIDER_NOT_CONFIGURED', 'Song search is not set up yet. The host needs to add a YouTube API key.')
      try {
        const url = new URL(`${API}/videos`)
        url.search = new URLSearchParams({ part: 'snippet,contentDetails,status', id: sourceId, key: apiKey }).toString()
        const res = await fetchImpl(url.toString(), { signal })
        if (!res.ok) return upstreamError(res)
        const body = (await res.json()) as { items?: VideoItem[] }
        const v = body.items?.[0]
        if (!v || v.id !== sourceId) return fail('INVALID', "That video isn't available on YouTube.")
        if (v.status?.embeddable === false) return fail('INVALID', "The owner doesn't allow this video to be played here.")
        if (v.status?.privacyStatus === 'private') return fail('INVALID', 'That video is private.')
        const thumbs = v.snippet?.thumbnails ?? {}
        return ok({
          source: 'youtube',
          sourceId,
          trackKey: `youtube:${sourceId}`,
          title: decodeEntities(v.snippet?.title ?? 'Untitled'),
          creatorLabel: v.snippet?.channelTitle ? decodeEntities(v.snippet.channelTitle) : undefined,
          thumbnailUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url,
          durationMs: v.contentDetails?.duration ? parseIsoDuration(v.contentDetails.duration) : undefined,
          canonicalUrl: `https://www.youtube.com/watch?v=${sourceId}`,
          playable: v.status?.embeddable === true ? true : 'unknown',
        })
      } catch {
        return fail('UPSTREAM', 'YouTube is unavailable right now. Try again in a moment.')
      }
    },

    async search(query, signal) {
      if (!apiKey) return fail('PROVIDER_NOT_CONFIGURED', 'Song search is not set up yet. The host needs to add a YouTube API key.')
      try {
        const searchUrl = new URL(`${API}/search`)
        searchUrl.search = new URLSearchParams({
          part: 'snippet',
          type: 'video',
          videoEmbeddable: 'true',
          videoCategoryId: '10',
          maxResults: '12',
          safeSearch: 'none',
          q: query,
          key: apiKey,
        }).toString()
        const searchRes = await fetchImpl(searchUrl.toString(), { signal })
        if (!searchRes.ok) return upstreamError(searchRes)
        const search = (await searchRes.json()) as { items?: SearchItem[] }
        const items = (search.items ?? []).filter((i) => i.id?.videoId)
        if (items.length === 0) return ok([])

        const videosUrl = new URL(`${API}/videos`)
        videosUrl.search = new URLSearchParams({
          part: 'contentDetails,status',
          id: items.map((i) => i.id?.videoId).join(','),
          key: apiKey,
        }).toString()
        const videosRes = await fetchImpl(videosUrl.toString(), { signal })
        if (!videosRes.ok) return upstreamError(videosRes)
        const videos = (await videosRes.json()) as { items?: VideoItem[] }
        const details = new Map((videos.items ?? []).map((v) => [v.id, v]))

        const tracks: CatalogTrack[] = []
        for (const item of items) {
          const videoId = item.id?.videoId as string
          const detail = details.get(videoId)
          if (detail?.status?.embeddable === false) continue
          const thumbs = item.snippet?.thumbnails ?? {}
          tracks.push({
            source: 'youtube',
            sourceId: videoId,
            trackKey: `youtube:${videoId}`,
            title: decodeEntities(item.snippet?.title ?? 'Untitled'),
            creatorLabel: item.snippet?.channelTitle ? decodeEntities(item.snippet.channelTitle) : undefined,
            thumbnailUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url,
            durationMs: detail?.contentDetails?.duration ? parseIsoDuration(detail.contentDetails.duration) : undefined,
            canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
            playable: detail?.status?.embeddable === true ? true : 'unknown',
          })
        }
        return ok(tracks)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return fail('UPSTREAM', 'Search cancelled.')
        return fail('UPSTREAM', 'YouTube search is unavailable right now. Try again in a moment.')
      }
    },
  }
}
