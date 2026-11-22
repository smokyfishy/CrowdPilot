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

export interface ResearchPool {
  pool: TrackCandidate[]
  alternates: Map<string, TrackCandidate[]>
  rejected: Array<{ title: string; uploader?: string; reason: string }>
  queries: number
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
  if (spec.artists.length && spec.artistMatching !== 'only_these') q.push({ text: `${genres[0]} ${spec.artists.slice(0, 2).join(' ')} type track`, why: `similar:${spec.artists.slice(0, 2).join('+')}`, popular: true })
  return q
}

export async function discoverResearch(spec: ResolvedSpec, apiKey: string | undefined, yt: DiscoveryProvider = createYouTubeDiscovery(apiKey)): Promise<ResearchPool> {
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is required for research discovery')
  const queries = researchQueries(spec)
  const all: TrackCandidate[] = []
  for (const q of queries) all.push(...(await yt.searchTracks({ text: q.text, popular: q.popular, limit: 25, why: q.why })))
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
  return { pool, alternates, rejected, queries: queries.length }
}
