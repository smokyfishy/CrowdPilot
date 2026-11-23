/**
 * Autonomous music discovery. Builds a query plan from the spec (requested songs, artists,
 * genres, similar-artist and popularity signals), runs it against every configured
 * provider, normalizes results into TrackCandidates with provider-independent identity,
 * dedupes the same recording across providers, and cross-resolves YouTube discoveries to
 * authorized audio sources when the SAME recording exists there.
 *
 * Runs anywhere `fetch` exists (Cloudflare Worker, Node). API keys stay server-side.
 */
import { normalize, similarity } from '../providers/catalog/match'
import { ccLabel } from '../providers/catalog/jamendo'
import { parseIsoDuration } from '../providers/catalog/youtube'
import { makeIdentity, sameRecording, versionClues, youtubeIdentity } from './identity'
import type { ResolvedSpec } from './spec'
import type { SourceId, TrackCandidate } from './types'

export interface DiscoveryProvider {
  readonly id: SourceId
  searchTracks(q: DiscoveryQuery, signal?: AbortSignal): Promise<TrackCandidate[]>
}

export interface DiscoveryQuery {
  text?: string
  artist?: string
  genres?: string[]
  popular?: boolean
  vocals?: 'vocal' | 'instrumental'
  limit: number
  offset?: number
  /** YouTube: only Creative Commons (CC BY) licensed videos. */
  ccOnly?: boolean
  why: string
}

// ───────────────────────────── Jamendo ─────────────────────────────

const JAMENDO_TAG: Record<string, string[]> = {
  'tech house': ['techhouse', 'house'],
  'deep house': ['deephouse', 'house'],
  'progressive house': ['progressivehouse', 'progressive'],
  house: ['house'],
  edm: ['edm', 'electro', 'dance'],
  techno: ['techno'],
  'melodic techno': ['techno', 'melodic'],
  trance: ['trance'],
  'drum and bass': ['drumnbass', 'dnb'],
  dubstep: ['dubstep'],
  'nu disco': ['nudisco', 'disco'],
  disco: ['disco'],
  'future house': ['futurehouse', 'house'],
  'bass house': ['basshouse', 'house'],
  'electro house': ['electrohouse', 'electro'],
  'big room': ['bigroom', 'edm'],
  'afro house': ['afrohouse', 'house'],
  'hip hop': ['hiphop'],
  lofi: ['lofi', 'chillhop'],
  'lo-fi': ['lofi', 'chillhop'],
  ambient: ['ambient'],
  chillout: ['chillout', 'lounge'],
  downtempo: ['downtempo'],
  synthwave: ['synthwave'],
  pop: ['pop'],
  electronic: ['electronic'],
  'uk garage': ['ukgarage', 'garage'],
  minimal: ['minimal'],
  breakbeat: ['breakbeat'],
  funk: ['funk'],
}

interface JamendoTrackRaw {
  id?: string
  name?: string
  duration?: number
  artist_name?: string
  album_name?: string
  releasedate?: string
  license_ccurl?: string
  shareurl?: string
  image?: string
  album_image?: string
  audiodownload_allowed?: boolean
  musicinfo?: { vocalinstrumental?: string; tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] }; speed?: string }
  stats?: { rate_listened_total?: number; rate_downloads_total?: number; listened?: number; downloads?: number }
}

export function jamendoCandidate(t: JamendoTrackRaw, why: string): TrackCandidate | null {
  if (!t.id || !t.name || !/^\d{1,12}$/.test(String(t.id))) return null
  const lic = ccLabel(t.license_ccurl)
  const artist = t.artist_name ?? 'Unknown artist'
  const vc = versionClues(t.name)
  const listens = t.stats?.rate_listened_total ?? t.stats?.listened
  return {
    trackKey: `jamendo:${t.id}`,
    source: 'jamendo',
    sourceId: String(t.id),
    title: t.name.slice(0, 200),
    artist: artist.slice(0, 120),
    uploader: artist,
    durationSec: typeof t.duration === 'number' ? t.duration : undefined,
    url: t.shareurl,
    thumbnailUrl: (t.album_image ?? t.image)?.startsWith('https://') ? (t.album_image ?? t.image) : undefined,
    publishedAt: t.releasedate,
    genres: t.musicinfo?.tags?.genres ?? [],
    tags: [...(t.musicinfo?.tags?.vartags ?? []), ...(t.musicinfo?.tags?.instruments ?? [])],
    popularity: typeof listens === 'number' ? { source: 'jamendo', kind: 'jamendo_listens', value: listens } : { source: 'jamendo', kind: 'none', value: 0 },
    identity: makeIdentity(artist, t.name),
    versionClues: vc.clues,
    license: { basis: lic.basis, label: lic.label, url: t.license_ccurl },
    matchedBy: [why],
    official: true, // Jamendo uploads are by the artist account
    vocalTag: t.musicinfo?.vocalinstrumental === 'instrumental' ? 'instrumental' : t.musicinfo?.vocalinstrumental === 'vocal' ? 'vocal' : undefined,
  }
}

export function createJamendoDiscovery(clientId: string | undefined, fetchImpl: typeof fetch = fetch): DiscoveryProvider {
  return {
    id: 'jamendo',
    async searchTracks(q, signal) {
      if (!clientId) return []
      const p = new URLSearchParams({ client_id: clientId, format: 'json', limit: String(Math.min(200, q.limit)), include: 'musicinfo stats licenses', groupby: 'artist_id' })
      if (q.offset) p.set('offset', String(q.offset))
      if (q.text) p.set('search', q.text)
      if (q.artist) p.set('artist_name', q.artist)
      if (q.genres?.length) {
        const tags = [...new Set(q.genres.flatMap((g) => JAMENDO_TAG[g.toLowerCase()] ?? [normalize(g).replace(/\s+/g, '')]))]
        p.set('fuzzytags', tags.join(' '))
      }
      if (q.vocals) p.set('vocalinstrumental', q.vocals)
      p.set('order', q.popular ? 'popularity_total' : q.text || q.artist ? 'relevance' : 'popularity_month')
      // The API intermittently answers an empty page under load: retry before accepting "no results".
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt))
          const res = await fetchImpl(`https://api.jamendo.com/v3.0/tracks/?${p.toString()}`, { signal })
          if (!res.ok) {
            await res.body?.cancel().catch(() => undefined)
            continue
          }
          const body = (await res.json()) as { headers?: { status?: string }; results?: JamendoTrackRaw[] }
          if (body.headers?.status && body.headers.status !== 'success') continue
          const out = (body.results ?? []).map((t) => jamendoCandidate(t, q.why)).filter((c): c is TrackCandidate => !!c)
          if (out.length || attempt === 2) return out
        } catch (e) {
          if (signal?.aborted) throw e
        }
      }
      return []
    },
  }
}

// ───────────────────────────── Audius ─────────────────────────────

interface AudiusRaw {
  id?: string
  title?: string
  duration?: number
  genre?: string
  mood?: string
  tags?: string | null
  bpm?: number | null
  license?: string | null
  permalink?: string
  play_count?: number
  release_date?: string
  is_streamable?: boolean
  is_stream_gated?: boolean
  is_delete?: boolean
  is_available?: boolean
  is_unlisted?: boolean
  access?: { stream?: boolean }
  artwork?: Record<string, string | undefined> | null
  user?: { name?: string; is_verified?: boolean; is_deactivated?: boolean }
}

const AUDIUS_GENRE: Record<string, string> = {
  'tech house': 'Tech House',
  'deep house': 'Deep House',
  'progressive house': 'Progressive House',
  house: 'House',
  techno: 'Techno',
  trance: 'Trance',
  'drum and bass': 'Drum & Bass',
  dubstep: 'Dubstep',
  edm: 'Electronic',
  electronic: 'Electronic',
  'future house': 'Future House',
  'hip hop': 'Hip-Hop/Rap',
  ambient: 'Ambient',
  downtempo: 'Downtempo',
  disco: 'Disco',
  lofi: 'Lo-Fi',
}

export function audiusCandidate(t: AudiusRaw, why: string): TrackCandidate | null {
  if (!t.id || !t.title || t.is_delete || t.is_available === false || t.is_unlisted) return null
  if (t.is_streamable === false || t.is_stream_gated || t.access?.stream === false || t.user?.is_deactivated) return null
  const artist = t.user?.name ?? 'Unknown artist'
  const cc = !!t.license && /creative commons|attribution/i.test(t.license)
  const art = t.artwork?.['480x480'] ?? t.artwork?.['150x150']
  return {
    trackKey: `audius:${t.id}`,
    source: 'audius',
    sourceId: t.id,
    title: t.title.slice(0, 200),
    artist: artist.slice(0, 120),
    uploader: artist,
    durationSec: t.duration,
    url: t.permalink ? `https://audius.co${t.permalink}` : undefined,
    thumbnailUrl: art?.startsWith('https://') ? art : undefined,
    publishedAt: t.release_date,
    genres: t.genre ? [t.genre] : [],
    tags: (t.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    popularity: typeof t.play_count === 'number' ? { source: 'audius', kind: 'audius_plays', value: t.play_count } : { source: 'audius', kind: 'none', value: 0 },
    identity: makeIdentity(artist, t.title),
    versionClues: versionClues(t.title).clues,
    license: { basis: cc ? 'audius-cc' : 'audius-oml', label: t.license ?? 'Audius Open Music License (streaming grant)' },
    matchedBy: [why],
    official: !!t.user?.is_verified,
    providerBpm: typeof t.bpm === 'number' && t.bpm > 0 ? t.bpm : undefined,
  }
}

export function createAudiusDiscovery(fetchImpl: typeof fetch = fetch): DiscoveryProvider {
  const API = 'https://api.audius.co/v1'
  return {
    id: 'audius',
    async searchTracks(q, signal) {
      try {
        let url: string
        if (q.text || q.artist) url = `${API}/tracks/search?query=${encodeURIComponent(q.text ?? q.artist!)}&limit=${Math.min(50, q.limit)}&app_name=CrowdPilot`
        else if (q.genres?.length) {
          const g = AUDIUS_GENRE[q.genres[0].toLowerCase()] ?? 'Electronic'
          url = `${API}/tracks/trending?genre=${encodeURIComponent(g)}&time=allTime&app_name=CrowdPilot`
        } else return []
        const res = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } })
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          return []
        }
        const body = (await res.json()) as { data?: AudiusRaw[] }
        return (body.data ?? []).slice(0, q.limit).map((t) => audiusCandidate(t, q.why)).filter((c): c is TrackCandidate => !!c)
      } catch (e) {
        if (signal?.aborted) throw e
        return []
      }
    },
  }
}

// ───────────────────────────── YouTube (metadata only) ─────────────────────────────

interface YtVideo {
  id?: string
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string; tags?: string[]; thumbnails?: Record<string, { url?: string } | undefined> }
  contentDetails?: { duration?: string; licensedContent?: boolean }
  statistics?: { viewCount?: string }
  status?: { license?: string; embeddable?: boolean; privacyStatus?: string }
}

const ENT: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const dec = (s: string) => s.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&(amp|quot|#39|lt|gt);/g, (e) => ENT[e] ?? e)

export function youtubeCandidate(v: YtVideo, why: string): TrackCandidate | null {
  if (!v.id || !v.snippet?.title) return null
  if (v.status?.privacyStatus === 'private') return null
  const title = dec(v.snippet.title)
  const channel = v.snippet.channelTitle ? dec(v.snippet.channelTitle) : undefined
  const yi = youtubeIdentity(title, channel)
  const thumbs = v.snippet.thumbnails ?? {}
  const dur = v.contentDetails?.duration ? parseIsoDuration(v.contentDetails.duration) : undefined
  return {
    trackKey: `youtube:${v.id}`,
    source: 'youtube',
    sourceId: v.id,
    title: yi.titleLabel,
    artist: yi.artistLabel,
    rawTitle: title,
    uploader: channel,
    durationSec: dur !== undefined ? dur / 1000 : undefined,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    thumbnailUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url,
    publishedAt: v.snippet.publishedAt,
    genres: [],
    tags: v.snippet.tags?.slice(0, 20) ?? [],
    popularity: v.statistics?.viewCount ? { source: 'youtube', kind: 'youtube_views', value: Number(v.statistics.viewCount) } : { source: 'youtube', kind: 'none', value: 0 },
    identity: yi.identity,
    versionClues: versionClues(title).clues,
    license: { basis: v.status?.license === 'creativeCommon' ? 'youtube-cc-by' : 'youtube-standard', label: v.status?.license === 'creativeCommon' ? 'YouTube Creative Commons (CC BY)' : 'Standard YouTube License' },
    matchedBy: [why],
    official: yi.official,
  }
}

/** `onError` receives API failures (quota/rate limit/auth) so callers can report them instead of "not found". */
export function createYouTubeDiscovery(apiKey: string | undefined, fetchImpl: typeof fetch = fetch, onError?: (status: number, reason: string) => void): DiscoveryProvider {
  const API = 'https://www.googleapis.com/youtube/v3'
  return {
    id: 'youtube',
    async searchTracks(q, signal) {
      if (!apiKey) return []
      const text = q.text ?? (q.artist ? `${q.artist} official audio` : q.genres?.length ? `${q.genres[0]} ${q.popular ? 'top tracks' : 'track'}` : '')
      if (!text) return []
      try {
        const sp = new URLSearchParams({ part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: String(Math.min(25, q.limit)), q: text, key: apiKey })
        if (q.popular) sp.set('order', 'viewCount')
        if (q.ccOnly) sp.set('videoLicense', 'creativeCommon')
        const sr = await fetchImpl(`${API}/search?${sp.toString()}`, { signal })
        if (!sr.ok) {
          const reason = ((await sr.json().catch(() => null)) as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors?.[0]?.reason ?? `HTTP ${sr.status}`
          onError?.(sr.status, reason)
          return []
        }
        const ids = (((await sr.json()) as { items?: Array<{ id?: { videoId?: string } }> }).items ?? []).map((i) => i.id?.videoId).filter(Boolean)
        if (!ids.length) return []
        const vr = await fetchImpl(`${API}/videos?${new URLSearchParams({ part: 'snippet,contentDetails,statistics,status', id: ids.join(','), key: apiKey }).toString()}`, { signal })
        if (!vr.ok) {
          await vr.body?.cancel().catch(() => undefined)
          return []
        }
        const items = ((await vr.json()) as { items?: YtVideo[] }).items ?? []
        return items
          .map((v) => youtubeCandidate(v, q.why))
          .filter((c): c is TrackCandidate => !!c && (c.durationSec ?? 0) >= 90 && (c.durationSec ?? 0) <= 900)
      } catch (e) {
        if (signal?.aborted) throw e
        return []
      }
    },
  }
}

// ───────────────────────────── query plan + pool ─────────────────────────────

export function queryPlan(spec: ResolvedSpec): Array<{ provider: SourceId | '*'; q: DiscoveryQuery }> {
  const plan: Array<{ provider: SourceId | '*'; q: DiscoveryQuery }> = []
  const popular = spec.popularity === 'high'
  const vocals = spec.vocals === 'mixed' ? undefined : spec.vocals
  for (const s of spec.songs.slice(0, 12)) {
    const text = `${s.artist ? s.artist + ' ' : ''}${s.title}${s.version ? ' ' + s.version : ''}`
    plan.push({ provider: '*', q: { text, limit: 8, why: `song:${text}` } })
  }
  for (const a of spec.artists.slice(0, 8)) {
    plan.push({ provider: 'youtube', q: { artist: a, popular, limit: 10, why: `artist:${a}` } })
    plan.push({ provider: 'youtube', q: { artist: a, ccOnly: true, limit: 10, why: `artist:${a}` } })
    plan.push({ provider: 'audius', q: { text: a, limit: 15, why: `artist:${a}` } })
    plan.push({ provider: 'jamendo', q: { artist: a, limit: 15, why: `artist:${a}` } })
  }
  // Genre pools on the authorized catalogs (several pages of depth for a 30–60 track pool).
  const genres = spec.genres.length ? spec.genres : ['electronic']
  for (const offset of [0, 200]) plan.push({ provider: 'jamendo', q: { genres, popular, vocals, limit: 200, offset, why: `genre:${genres.join('+')}` } })
  for (const g of genres.slice(0, 3)) {
    plan.push({ provider: 'jamendo', q: { genres: [g], popular, vocals, limit: 100, why: `genre:${g}` } })
    plan.push({ provider: 'jamendo', q: { text: g, vocals, limit: 100, why: `genre:${g}` } })
    plan.push({ provider: 'audius', q: { genres: [g], limit: 30, why: `genre:${g}` } })
  }
  // Creative Commons uploads on YouTube (acquirable only from the artist's official channel).
  for (const g of genres.slice(0, 2)) plan.push({ provider: 'youtube', q: { genres: [g], ccOnly: true, limit: 25, why: `genre:${g}` } })
  if (spec.moods.length) plan.push({ provider: 'jamendo', q: { text: spec.moods.join(' '), genres, limit: 30, why: `mood:${spec.moods.join('+')}` } })
  // era the user asked for ("90s house", "2010s EDM"): era-qualified searches
  if (spec.era) {
    for (const g of genres.slice(0, 2)) {
      plan.push({ provider: 'youtube', q: { text: `${spec.era} ${g}`, popular, limit: 15, why: `era:${spec.era}` } })
      plan.push({ provider: 'jamendo', q: { text: `${spec.era} ${g}`, limit: 30, why: `era:${spec.era}` } })
    }
  }
  if (spec.artists.length && spec.artistMatching !== 'only_these') {
    // "similar artists": genre-scoped search on YouTube to surface the scene, popular-first.
    plan.push({ provider: 'youtube', q: { genres, popular: true, limit: 15, why: `similar:${spec.artists.slice(0, 3).join('+')}` } })
  }
  return plan
}

export interface DiscoveryResult {
  pool: TrackCandidate[]
  /** YouTube recordings for which the same recording was found on an authorized source. */
  crossResolved: Array<{ youtubeKey: string; matchKey: string; confidence: number; reasons: string[] }>
  queries: number
  bySource: Record<string, number>
}

/** Merge candidates for the same recording across queries; keep all `matchedBy` reasons. */
function dedupe(cands: TrackCandidate[]): TrackCandidate[] {
  const byKey = new Map<string, TrackCandidate>()
  for (const c of cands) {
    const ex = byKey.get(c.trackKey)
    if (ex) ex.matchedBy = [...new Set([...ex.matchedBy, ...c.matchedBy])]
    else byKey.set(c.trackKey, { ...c, matchedBy: [...c.matchedBy] })
  }
  return [...byKey.values()]
}

export async function discover(spec: ResolvedSpec, providers: DiscoveryProvider[], opts: { signal?: AbortSignal; onQuery?: (done: number, total: number) => void } = {}): Promise<DiscoveryResult> {
  const plan = queryPlan(spec).filter((p) => p.provider === '*' || providers.some((pr) => pr.id === p.provider))
  const tasks = plan.flatMap((p) => (p.provider === '*' ? providers : providers.filter((pr) => pr.id === p.provider)).map((pr) => ({ pr, q: p.q })))
  let done = 0
  const results = await Promise.all(
    tasks.map(async ({ pr, q }) => {
      const r = await pr.searchTracks(q, opts.signal)
      opts.onQuery?.(++done, tasks.length)
      return r
    }),
  )
  const pool = dedupe(results.flat())
  // Cross-resolve YouTube discoveries to authorized sources holding the SAME recording.
  const crossResolved: DiscoveryResult['crossResolved'] = []
  const authorized = pool.filter((c) => c.source !== 'youtube')
  for (const y of pool.filter((c) => c.source === 'youtube')) {
    let best: { c: TrackCandidate; conf: number; reasons: string[] } | null = null
    for (const a of authorized) {
      if (a.source === 'audius' && !a.official) continue // unverified re-uploads carry no valid grant
      const m = sameRecording(y, a)
      if (m.same && (!best || m.confidence > best.conf)) best = { c: a, conf: m.confidence, reasons: m.reasons }
    }
    if (best) {
      crossResolved.push({ youtubeKey: y.trackKey, matchKey: best.c.trackKey, confidence: best.conf, reasons: best.reasons })
      best.c.matchedBy = [...new Set([...best.c.matchedBy, ...y.matchedBy])]
      if (y.popularity.kind === 'youtube_views') best.c.tags = [...best.c.tags, `youtube-views:${y.popularity.value}`]
    }
  }
  const bySource: Record<string, number> = {}
  for (const c of pool) bySource[c.source] = (bySource[c.source] ?? 0) + 1
  return { pool, crossResolved, queries: tasks.length, bySource }
}

/** Light relevance filter: drops results that match no genre, artist or song signal at all. */
export function relevant(spec: ResolvedSpec, c: TrackCandidate): boolean {
  if (c.matchedBy.some((m) => m.startsWith('song:') || m.startsWith('artist:'))) {
    // artist queries on fuzzy catalogs return unrelated names; require the artist to match
    return c.matchedBy.some((m) => m.startsWith('song:')) || spec.artists.some((a) => similarity(normalize(a), c.identity.artist) >= 0.6) || c.matchedBy.some((m) => m.startsWith('genre:'))
  }
  return true
}
