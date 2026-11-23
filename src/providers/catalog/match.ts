/**
 * YouTube → authorized mixable source matching. YouTube results carry no ISRC and
 * we cannot hear YouTube audio, so a match is metadata-only: artist + title +
 * duration. It is deliberately conservative: an Audius candidate qualifies only if
 * the uploader is a VERIFIED account whose name matches the parsed artist (this
 * excludes the many third-party re-uploads of mainstream songs, whose OML grant
 * would be void), the core titles match, and durations agree within 4 s. The host
 * sees every auto-match and can reject it.
 */
import type { CatalogTrack } from './types'

export interface ParsedTitle {
  artist: string | null
  title: string
}

const NOISE = /\s*[([](official( music)?( video| audio| visualizer| lyric video)?|lyrics?( video)?|audio|hd|hq|4k|visualizer|video( oficial)?|music video|explicit|clean)[)\]]/gi

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(NOISE, ' ')
    .replace(/\b(feat|ft|featuring)\.?\b.*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function parseYouTubeTitle(title: string, channel?: string): ParsedTitle {
  const cleaned = title.replace(NOISE, '').trim()
  const m = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(cleaned)
  if (m) return { artist: m[1].trim(), title: m[2].trim() }
  const ch = channel?.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim()
  return { artist: ch || null, title: cleaned }
}

function tokenSet(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter(Boolean))
}

/** Jaccard similarity of normalized token sets. */
export function similarity(a: string, b: string): number {
  const A = tokenSet(a)
  const B = tokenSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

export interface MatchResult {
  candidate: CatalogTrack
  confidence: number
  reasons: string[]
}

export function bestMixableMatch(yt: { title: string; creatorLabel?: string; durationMs?: number }, candidates: CatalogTrack[]): MatchResult | null {
  const parsed = parseYouTubeTitle(yt.title, yt.creatorLabel)
  if (!parsed.artist) return null
  let best: MatchResult | null = null
  for (const c of candidates) {
    if (c.mixability !== 'mixable') continue
    const reasons: string[] = []
    if (c.source === 'audius' && !c.rights?.uploaderVerified) continue
    const artistSim = similarity(parsed.artist, c.creatorLabel ?? '')
    if (artistSim < 0.6) continue
    // Remixes/edits are different recordings: require the same remix tag presence.
    const ytRemix = /remix|edit|bootleg|rework|vip/i.test(parsed.title)
    const cRemix = /remix|edit|bootleg|rework|vip/i.test(c.title)
    if (ytRemix !== cRemix) continue
    const titleSim = similarity(parsed.title, c.title.replace(new RegExp(`^${escapeRe(c.creatorLabel ?? '')}\\s*[-–—]\\s*`, 'i'), ''))
    if (titleSim < 0.7) continue
    if (yt.durationMs === undefined || c.durationMs === undefined) continue
    const dd = Math.abs(yt.durationMs - c.durationMs) / 1000
    if (dd > 4) continue
    reasons.push(`verified uploader "${c.creatorLabel}"`, `title match ${(titleSim * 100).toFixed(0)}%`, `duration Δ ${dd.toFixed(1)} s`)
    const confidence = Math.min(1, 0.4 * artistSim + 0.4 * titleSim + 0.2 * (1 - dd / 4))
    if (!best || confidence > best.confidence) best = { candidate: c, confidence, reasons }
  }
  return best
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
