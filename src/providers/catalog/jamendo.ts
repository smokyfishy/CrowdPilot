/**
 * Jamendo catalog provider (API v3, needs JAMENDO_CLIENT_ID; free for
 * non-commercial use per Jamendo API Terms §3.3). Every track carries its own
 * Creative Commons licence (returned as license_ccurl). Jamendo's audio storage
 * does not send CORS headers, so the host browser fetches audio through the
 * worker's narrowly allowlisted pass-through (`/api/audio/jamendo/:id`), which
 * streams without storing (API Terms: no caching beyond operation).
 */
import { fail, ok } from '../../domain/types'
import type { Result } from '../../domain/types'
import type { CatalogTrack, MusicCatalogProvider } from './types'

const API = 'https://api.jamendo.com/v3.0'

interface JamendoTrack {
  id?: string
  name?: string
  duration?: number
  artist_name?: string
  image?: string
  shareurl?: string
  license_ccurl?: string
  audio?: string
}

export function jamendoAudioUpstream(id: string): string {
  return `https://prod-1.storage.jamendo.com/?trackid=${encodeURIComponent(id)}&format=mp31`
}

export function ccLabel(url: string | undefined): { basis: string; label: string; ndOrUnknown: boolean } {
  const m = url ? /creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i.exec(url) : null
  if (!m) return { basis: 'jamendo-unknown-license', label: 'Licence not stated', ndOrUnknown: true }
  const code = m[1].toLowerCase()
  return { basis: `cc-${code}-${m[2]}`, label: `CC ${code.toUpperCase()} ${m[2]}`, ndOrUnknown: code.includes('nd') }
}

export function normalizeJamendo(t: JamendoTrack): CatalogTrack | null {
  if (!t.id || !t.name || !/^\d{1,12}$/.test(String(t.id))) return null
  const lic = ccLabel(t.license_ccurl)
  return {
    source: 'jamendo',
    sourceId: String(t.id),
    trackKey: `jamendo:${t.id}`,
    title: t.name.slice(0, 200),
    creatorLabel: t.artist_name?.slice(0, 120),
    thumbnailUrl: t.image && t.image.startsWith('https://') ? t.image : undefined,
    durationMs: typeof t.duration === 'number' ? t.duration * 1000 : undefined,
    canonicalUrl: t.shareurl,
    playable: true,
    mixability: 'mixable',
    // ND ("no derivatives") licences: analysis is fine, but rendering a mix is an adaptation.
    rights: { basis: lic.basis, label: lic.label, licenseUrl: t.license_ccurl, mixingNeedsReview: lic.ndOrUnknown },
  }
}

export function createJamendoProvider(clientId: string | undefined, fetchImpl: typeof fetch = fetch): MusicCatalogProvider {
  const notConfigured = () => fail<never>('PROVIDER_NOT_CONFIGURED', 'Jamendo search is not set up (the host needs a free Jamendo client id).')
  const get = async (params: string, signal?: AbortSignal): Promise<Result<JamendoTrack[]>> => {
    if (!clientId) return notConfigured()
    try {
      const res = await fetchImpl(`${API}/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&${params}`, { signal })
      if (!res.ok) return fail('UPSTREAM', 'Jamendo is unavailable right now.')
      const body = (await res.json()) as { headers?: { status?: string; code?: number }; results?: JamendoTrack[] }
      if (body.headers?.status && body.headers.status !== 'success') {
        return body.headers.code === 5 ? notConfigured() : fail('UPSTREAM', 'Jamendo is unavailable right now.')
      }
      return ok(body.results ?? [])
    } catch (e) {
      if (signal?.aborted) throw e
      return fail('UPSTREAM', 'Jamendo is unavailable right now.')
    }
  }
  return {
    async search(query, signal) {
      const r = await get(`limit=20&search=${encodeURIComponent(query)}&audioformat=mp31`, signal)
      return r.ok ? ok(r.value.map(normalizeJamendo).filter((t): t is CatalogTrack => !!t)) : r
    },
    async resolve(sourceId, signal) {
      if (!/^\d{1,12}$/.test(sourceId)) return fail('INVALID', 'That is not a Jamendo track id.')
      const r = await get(`id=${sourceId}`, signal)
      if (!r.ok) return r
      const t = r.value[0] ? normalizeJamendo(r.value[0]) : null
      return t ? ok(t) : fail('NOT_FOUND', 'That Jamendo track is not available.')
    },
  }
}
