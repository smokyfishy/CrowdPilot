/**
 * Research-mode discovery (local only): finds recordings on YouTube with the Data API and
 * groups uploads by recording identity.
 *  - Prefers the official upload: "<Artist> - Topic", VEVO or the artist's own channel.
 *  - Rejects covers, sped-up/slowed/nightcore edits, live recordings, lyric re-uploads,
 *    compilations and DJ mixes unless the user asked for that version.
 *  - Keeps the other verified uploads of the SAME recording (same identity, duration within 4 s)
 *    as ordered fallbacks for acquisition.
 */
import { createYouTubeDiscovery, type DiscoveryProvider } from '../../src/mixgen/discovery'
import { matchesSongRequest, sameRecording } from '../../src/mixgen/identity'
import { isContinuousMix } from '../../src/mixgen/select'
import type { ResolvedSpec } from '../../src/mixgen/spec'
import type { TrackCandidate } from '../../src/mixgen/types'
import { ytdlpSearch } from './ytdlp-search'

export interface ResearchPool {
  pool: TrackCandidate[]
  alternates: Map<string, TrackCandidate[]>
  rejected: Array<{ title: string; uploader?: string; reason: string }>
  queries: number
  /** Search failures (API quota/rate limit/auth, yt-dlp search errors) — reported, never hidden. */
  apiErrors: string[]
}

const LYRIC = /\b(lyrics?|lyric video|letra|paroles)\b/i
const LIVE = /\b(live|live at|live from|live in|concert|festival set|boiler room)\b/i
const COMPILATION = /\b(top \d+|best of|full album|compilation|playlist|hour|hours|mixtape|megamix|\d+ songs)\b/i

export function rejectReason(c: TrackCandidate, spec: ResolvedSpec): string | null {
  const requested = spec.songs.some((s) => matchesSongRequest(s, c))
  const raw = c.rawTitle ?? c.title // the published upload title, before cleaning
  if (isContinuousMix(c) || isContinuousMix({ ...c, title: raw })) return 'DJ mix / long-form upload'
  if (COMPILATION.test(raw)) return 'compilation'
  if (requested) return null
  if (c.versionClues.some((v) => v.startsWith('variant:'))) return `variant (${c.versionClues.find((v) => v.startsWith('variant:'))!.slice(9)})`
  if (/\bcover\b/i.test(raw) || /\bcover\b/i.test(c.identity.version)) return 'cover'
  if (LIVE.test(c.identity.version) || / - live\b|\(live\)|\[live\]/i.test(raw)) return 'live recording'
  if (LYRIC.test(raw) && !c.official) return 'lyric re-upload'
  if (/\s@\s|\b(burning man|boiler room|tomorrowland|ultra music festival|coachella|edc|cercle|dj set|live set|b2b)\b/i.test(raw)) return 'live/DJ-set recording'
  if ((c.durationSec ?? 0) < 100) return 'too short (clip/teaser)'
  return null
}

const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Genres the upload itself claims (title, tags, channel), restricted to the requested genres. */
export function genreEvidence(c: TrackCandidate, spec: ResolvedSpec): string[] {
  const text = squash([c.rawTitle ?? c.title, c.uploader ?? '', ...c.tags].join(' '))
  return spec.genres.filter((g) => text.includes(squash(g)))
}

/** Ranking of uploads of one recording: official first, then requested version, then views. */
function uploadRank(c: TrackCandidate): number {
  const topic = /\s-\sTopic$/i.test(c.uploader ?? '') ? 3 : 0
  const vevo = /vevo$/i.test(c.uploader ?? '') ? 2 : 0
  const official = c.official ? 2 : 0
  const views = c.popularity.kind === 'youtube_views' ? Math.log10(1 + c.popularity.value) / 10 : 0
  return topic + vevo + official + views
}

/**
 * Scene seeds per genre (labels/scene terms an interpreter would use) — discovery hints only,
 * never constraints; every result still has to pass identity checks and genre evidence.
 */
const GENRE_SEEDS: Record<string, string[]> = {
  'tech house': ['Toolroom tech house', 'Hot Creations tech house', 'Solid Grooves', 'Repopulate Mars', 'Defected tech house', 'Catch & Release tech house'],
  house: ['Defected Records house', 'Glasgow Underground house', 'Toolroom house'],
  'deep house': ['Anjunadeep deep house', 'Defected deep house', 'Stil vor Talent'],
  'melodic techno': ['Afterlife melodic techno', 'Anjunadeep melodic', 'Diynamic melodic techno'],
  techno: ['Drumcode techno', 'Afterlife techno', 'KNTXT techno'],
  edm: ['Spinnin Records', 'STMPD RCRDS', 'Musical Freedom'],
  'drum and bass': ['Hospital Records drum and bass', 'UKF drum and bass', 'RAM Records'],
  'progressive house': ['Anjunabeats progressive house', 'Size Records', 'Armada progressive house'],
  'afro house': ['Keinemusik afro house', 'MoBlack afro house'],
  trance: ['Anjunabeats trance', 'Armada trance'],
}

export function researchQueries(spec: ResolvedSpec): Array<{ text: string; why: string; popular: boolean }> {
  const q: Array<{ text: string; why: string; popular: boolean }> = []
  for (const s of spec.songs) q.push({ text: `${s.artist ?? ''} ${s.title} ${s.version ?? ''}`.trim(), why: `song:${s.title}`, popular: false })
  for (const a of spec.artists.slice(0, 8)) q.push({ text: `${a} official audio`, why: `artist:${a}`, popular: spec.popularity === 'high' })
  for (const a of spec.artists.slice(0, 8)) q.push({ text: `${a} - Topic`, why: `artist:${a}`, popular: true })
  const genres = spec.genres.length ? spec.genres : ['electronic']
  for (const g of genres.slice(0, 3)) {
    q.push({ text: `${g} official audio`, why: `genre:${g}`, popular: true })
    q.push({ text: `${g} original mix`, why: `genre:${g}`, popular: false })
  }
  for (const g of genres.slice(0, 2)) for (const seed of (GENRE_SEEDS[g.toLowerCase()] ?? []).slice(0, spec.artists.length ? 2 : 6)) q.push({ text: seed, why: `genre:${g}`, popular: true })
  if (spec.artists.length && spec.artistMatching !== 'only_these') q.push({ text: `${genres[0]} ${spec.artists.slice(0, 2).join(' ')} type track`, why: `similar:${spec.artists.slice(0, 2).join('+')}`, popular: true })
  return q
}

export async function discoverResearch(
  spec: ResolvedSpec,
  apiKey: string | undefined,
  yt?: DiscoveryProvider,
  search: (query: string, n: number, why: string) => Promise<TrackCandidate[]> = ytdlpSearch,
): Promise<ResearchPool> {
  const apiErrors: string[] = []
  const provider = yt ?? createYouTubeDiscovery(apiKey, fetch, (status, reason) => apiErrors.push(`YouTube Data API ${status} ${reason}`))
  const queries = researchQueries(spec)
  const all: TrackCandidate[] = []
  let apiDown = !apiKey
  for (const q of queries) {
    // Exact song requests use yt-dlp's public search (no API quota); everything else tries the Data
    // API first and falls back to yt-dlp search once the API fails (quota / rate limit / auth).
    if (q.why.startsWith('song:') || apiDown) {
      try {
        all.push(...(await search(q.text, q.why.startsWith('song:') ? 10 : 15, q.why)))
      } catch (e) {
        apiErrors.push(`yt-dlp search "${q.text}": ${(e as Error).message}`)
      }
      continue
    }
    const before = apiErrors.length
    const got = await provider.searchTracks({ text: q.text, popular: q.popular, limit: 25, why: q.why })
    all.push(...got)
    if (apiErrors.length > before) {
      apiDown = true
      try {
        all.push(...(await search(q.text, 15, q.why)))
      } catch (e) {
        apiErrors.push(`yt-dlp search "${q.text}": ${(e as Error).message}`)
      }
    }
  }
  // merge duplicates of the same video
  const byKey = new Map<string, TrackCandidate>()
  for (const c of all) {
    const ex = byKey.get(c.trackKey)
    if (ex) ex.matchedBy = [...new Set([...ex.matchedBy, ...c.matchedBy])]
    // A search hit is NOT evidence of genre: only count it when the upload itself says so
    // (title, tags or channel name mention the genre).
    else byKey.set(c.trackKey, { ...c, genres: genreEvidence(c, spec) })
  }
  const rejected: ResearchPool['rejected'] = []
  const kept: TrackCandidate[] = []
  for (const c of byKey.values()) {
    const r = rejectReason(c, spec)
    if (r) rejected.push({ title: c.title, uploader: c.uploader, reason: r })
    else kept.push(c)
  }
  // group uploads of the same recording
  const groups: TrackCandidate[][] = []
  for (const c of kept.sort((a, b) => uploadRank(b) - uploadRank(a))) {
    const g = groups.find((grp) => sameRecording(grp[0], c, 4).same)
    if (g) g.push(c)
    else groups.push([c])
  }
  const pool: TrackCandidate[] = []
  const alternates = new Map<string, TrackCandidate[]>()
  for (const g of groups) {
    const [best, ...rest] = g
    best.matchedBy = [...new Set(g.flatMap((x) => x.matchedBy))]
    best.genres = [...new Set(g.flatMap((x) => x.genres))]
    pool.push(best)
    alternates.set(best.trackKey, rest)
  }
  return { pool, alternates, rejected, queries: queries.length, apiErrors: [...new Set(apiErrors)] }
}
