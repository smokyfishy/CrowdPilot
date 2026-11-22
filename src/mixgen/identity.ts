/**
 * Provider-independent recording identity. Different sources describe the same
 * recording with different metadata ("Artist - Title (Extended Mix) [Official Audio]"
 * on YouTube, `name` + `artist_name` on Jamendo, ...). We normalize artist, base title,
 * version tag and featured artists, then match with duration agreement.
 *
 * Remixes, edits, live recordings, covers and sped-up/slowed edits are DIFFERENT
 * recordings: identity keys include the version tag and `sameRecording` never merges
 * an original with a remix.
 */
import { normalize, parseYouTubeTitle, similarity } from '../providers/catalog/match'
import type { RecordingIdentity } from './types'

const VERSION_RE =
  /[([]\s*([^)\]]*?\b(remix|mix|edit|bootleg|rework|vip|dub|version|remaster(?:ed)?|live|acoustic|instrumental|cover|sped up|slowed|nightcore|extended|radio|club|original)\b[^)\]]*)\s*[)\]]/gi
const BAD_VARIANT = /\b(sped up|speed up|slowed|reverb|nightcore|8d audio|bass boosted|karaoke|cover|tribute|live (at|from|in)|reaction|tutorial|lyrics? video)\b/i
const FEAT_RE = /\s*[([]?\b(?:feat|ft|featuring|with)\.?\s+([^)\]-]+)[)\]]?/i

export interface VersionClues {
  version: string
  clues: string[]
  /** True for variants that are not the requested recording unless asked for. */
  undesirable: boolean
}

export function versionClues(rawTitle: string): VersionClues {
  const clues: string[] = []
  let version = ''
  for (const m of rawTitle.matchAll(VERSION_RE)) {
    const tag = normalize(m[1])
    if (!tag || /^(official|audio|video|hd|lyrics?)$/.test(tag)) continue
    clues.push(tag)
    if (!/^(original mix|original|radio edit|official audio)$/.test(tag)) version = version ? `${version} ${tag}` : tag
  }
  // "Title - Fisher Remix" style suffix
  const dash = /\s[-–—]\s([^-–—]*\b(remix|edit|bootleg|vip|rework|extended mix|club mix)\b[^-–—]*)$/i.exec(rawTitle)
  if (dash) {
    const tag = normalize(dash[1])
    if (!clues.includes(tag)) {
      clues.push(tag)
      version = version ? `${version} ${tag}` : tag
    }
  }
  const undesirable = BAD_VARIANT.test(rawTitle)
  if (undesirable) clues.push('variant: ' + (BAD_VARIANT.exec(rawTitle)?.[0] ?? '').toLowerCase())
  return { version, clues, undesirable }
}

function stripVersion(title: string): string {
  return title.replace(VERSION_RE, ' ').replace(/\s[-–—]\s[^-–—]*\b(remix|edit|bootleg|vip|rework|extended mix|club mix)\b[^-–—]*$/i, ' ')
}

export function makeIdentity(artist: string, title: string): RecordingIdentity {
  const featM = FEAT_RE.exec(title) ?? FEAT_RE.exec(artist)
  const featured = featM ? featM[1].split(/,|&|\band\b/i).map((s) => normalize(s)).filter(Boolean) : []
  const v = versionClues(title)
  const baseTitle = normalize(stripVersion(title.replace(FEAT_RE, ' ')))
  const primary = normalize(artist.replace(FEAT_RE, ' ').split(/,|&| x |\band\b/i)[0] ?? artist)
  const version = v.version
  return { artist: primary, title: baseTitle, version, featured, key: `${primary}|${baseTitle}|${version}` }
}

/** Identity from a YouTube title + channel ("- Topic" and VEVO channels name the artist). */
export function youtubeIdentity(videoTitle: string, channel?: string): { identity: RecordingIdentity; official: boolean; artistLabel: string; titleLabel: string } {
  const parsed = parseYouTubeTitle(videoTitle, channel)
  const topic = !!channel && /\s-\sTopic$/i.test(channel)
  const vevo = !!channel && /vevo$/i.test(channel)
  const artistLabel = parsed.artist ?? channel?.replace(/\s*-\s*Topic$/i, '') ?? ''
  const chanNorm = normalize((channel ?? '').replace(/\s*-\s*Topic$/i, '').replace(/vevo$/i, ''))
  const official = topic || vevo || (!!chanNorm && similarity(chanNorm, artistLabel) >= 0.8)
  return { identity: makeIdentity(artistLabel, parsed.title), official, artistLabel, titleLabel: parsed.title }
}

export interface IdentityMatch {
  same: boolean
  confidence: number
  reasons: string[]
}

/**
 * Do two metadata records describe the same recording? Requires artist and base-title
 * agreement, identical version tags, and duration within `toleranceSec` when both known.
 */
export function sameRecording(
  a: { identity: RecordingIdentity; durationSec?: number },
  b: { identity: RecordingIdentity; durationSec?: number },
  toleranceSec = 4,
): IdentityMatch {
  const reasons: string[] = []
  const artistSim = similarity(a.identity.artist, b.identity.artist)
  const titleSim = similarity(a.identity.title, b.identity.title)
  if (artistSim < 0.6) return { same: false, confidence: 0, reasons: [`artist differs (${(artistSim * 100).toFixed(0)}%)`] }
  if (titleSim < 0.75) return { same: false, confidence: 0, reasons: [`title differs (${(titleSim * 100).toFixed(0)}%)`] }
  if (a.identity.version !== b.identity.version) return { same: false, confidence: 0, reasons: [`different version ("${a.identity.version || 'original'}" vs "${b.identity.version || 'original'}")`] }
  let durScore = 0.5
  if (a.durationSec !== undefined && b.durationSec !== undefined) {
    const dd = Math.abs(a.durationSec - b.durationSec)
    if (dd > toleranceSec) return { same: false, confidence: 0, reasons: [`duration differs by ${dd.toFixed(1)} s`] }
    durScore = 1 - dd / toleranceSec
    reasons.push(`duration Δ ${dd.toFixed(1)} s`)
  } else reasons.push('duration unknown on one side')
  reasons.unshift(`artist ${(artistSim * 100).toFixed(0)}%`, `title ${(titleSim * 100).toFixed(0)}%`)
  return { same: true, confidence: Math.min(1, 0.35 * artistSim + 0.45 * titleSim + 0.2 * durScore), reasons }
}

/** Does a candidate satisfy a user's song request ("artist - title [version]")? */
export function matchesSongRequest(
  req: { artist: string | null; title: string; version: string | null },
  cand: { identity: RecordingIdentity },
): boolean {
  const t = similarity(normalize(stripVersion(req.title)), cand.identity.title) >= 0.75
  const a = !req.artist || similarity(normalize(req.artist), cand.identity.artist) >= 0.6 || cand.identity.featured.some((f) => similarity(f, normalize(req.artist!)) >= 0.8)
  const v = !req.version || similarity(normalize(req.version), cand.identity.version) >= 0.5
  return t && a && v
}

export function artistMatches(name: string, cand: { identity: RecordingIdentity; artist: string }): boolean {
  const n = normalize(name)
  return similarity(n, cand.identity.artist) >= 0.7 || cand.identity.featured.some((f) => similarity(f, n) >= 0.8) || similarity(n, normalize(cand.artist)) >= 0.7
}
