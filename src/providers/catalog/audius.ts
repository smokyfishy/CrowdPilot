/**
 * Audius catalog provider (public REST API, no key). Streams are CORS-enabled MP3
 * served under the Audius API Terms + Open Music License (OML §1.2: Music Players may
 * "reproduce, … stream, and otherwise use in whole or part" in connection with their
 * service). API Terms: session-only caching; NO machine-learning training on content.
 * Tracks with gated streams, deleted, unavailable or API-opted-out are excluded.
 */
import { fail, ok } from '../../domain/types'
import type { Result } from '../../domain/types'
import type { CatalogTrack, MusicCatalogProvider } from './types'

export const AUDIUS_API = 'https://api.audius.co/v1'
export const AUDIUS_APP_NAME = 'CrowdPilot'

interface AudiusTrack {
  id?: string
  title?: string
  duration?: number
  genre?: string
  bpm?: number | null
  musical_key?: string | null
  isrc?: string | null
  license?: string | null
  permalink?: string
  is_streamable?: boolean
  is_stream_gated?: boolean
  is_delete?: boolean
  is_available?: boolean
  is_unlisted?: boolean
  access?: { stream?: boolean }
  artwork?: Record<string, string | string[] | undefined> | null
  user?: { name?: string; handle?: string; is_verified?: boolean; is_deactivated?: boolean }
}

export function audiusStreamUrl(id: string): string {
  return `${AUDIUS_API}/tracks/${encodeURIComponent(id)}/stream?app_name=${AUDIUS_APP_NAME}`
}

function isCc(license: string | null | undefined): boolean {
  return !!license && /creative commons|\bcc\b|attribution/i.test(license)
}

export function normalizeAudius(t: AudiusTrack): CatalogTrack | null {
  if (!t.id || !t.title) return null
  if (t.is_delete || t.is_available === false || t.is_unlisted) return null
  if (t.is_streamable === false || t.is_stream_gated || t.access?.stream === false) return null
  if (t.user?.is_deactivated) return null
  const art = t.artwork?.['150x150']
  const thumb = typeof art === 'string' && art.startsWith('https://') ? art : undefined
  const cc = isCc(t.license)
  return {
    source: 'audius',
    sourceId: t.id,
    trackKey: `audius:${t.id}`,
    title: t.title.slice(0, 200),
    creatorLabel: t.user?.name?.slice(0, 120),
    thumbnailUrl: thumb,
    durationMs: typeof t.duration === 'number' ? Math.round(t.duration * 1000) : undefined,
    canonicalUrl: t.permalink ? `https://audius.co${t.permalink}` : undefined,
    playable: true,
    mixability: 'mixable',
    rights: {
      basis: cc ? 'audius-cc' : 'audius-oml',
      label: t.license ?? 'Audius Open Music License (streaming grant)',
      uploaderVerified: !!t.user?.is_verified,
      // OML grants streaming/"otherwise use"; whether live overlap/EQ counts as permitted use for
      // "All rights reserved" uploads is a human rights-review question, surfaced in the UI.
      mixingNeedsReview: !cc,
    },
    providerBpm: typeof t.bpm === 'number' ? t.bpm : undefined,
    providerKey: t.musical_key ?? undefined,
    isrc: t.isrc ?? undefined,
  }
}

export function createAudiusProvider(fetchImpl: typeof fetch = fetch): MusicCatalogProvider {
  const get = async (path: string, signal?: AbortSignal): Promise<Result<unknown>> => {
    try {
      const sep = path.includes('?') ? '&' : '?'
      const res = await fetchImpl(`${AUDIUS_API}${path}${sep}app_name=${AUDIUS_APP_NAME}`, { signal, headers: { Accept: 'application/json' } })
      if (res.status === 404) return fail('NOT_FOUND', 'That Audius track is not available.')
      if (!res.ok) return fail('UPSTREAM', 'Audius is unavailable right now. Try again in a moment.')
      return ok(((await res.json()) as { data?: unknown }).data)
    } catch (e) {
      if (signal?.aborted) throw e
      return fail('UPSTREAM', 'Audius is unavailable right now. Try again in a moment.')
    }
  }
  return {
    async search(query, signal) {
      const r = await get(`/tracks/search?query=${encodeURIComponent(query)}&limit=20`, signal)
      if (!r.ok) return r
      const list = Array.isArray(r.value) ? (r.value as AudiusTrack[]) : []
      return ok(list.map(normalizeAudius).filter((t): t is CatalogTrack => !!t))
    },
    async resolve(sourceId, signal) {
      if (!/^[A-Za-z0-9]{1,24}$/.test(sourceId)) return fail('INVALID', 'That is not an Audius track id.')
      const r = await get(`/tracks/${sourceId}`, signal)
      if (!r.ok) return r
      const t = normalizeAudius((r.value ?? {}) as AudiusTrack)
      return t ? ok(t) : fail('INVALID', 'That Audius track cannot be streamed.')
    },
  }
}
