/**
 * YouTube search through yt-dlp (public search results; no Data API key or quota). Used by local
 * research mode for song requests and as the fallback when the Data API is rate-limited. Search only:
 * every download still goes through the adapter's restriction checks.
 */
import { youtubeCandidate } from '../../src/mixgen/discovery'
import type { TrackCandidate } from '../../src/mixgen/types'
import { runYtDlp } from '../mixgen/acquire'

const iso = (sec: number) => `PT${Math.floor(sec / 60)}M${Math.round(sec % 60)}S`

export async function ytdlpSearch(query: string, n: number, why: string): Promise<TrackCandidate[]> {
  const r = await runYtDlp(['--flat-playlist', '--dump-json', '--no-warnings', `ytsearch${Math.min(20, Math.max(1, n))}:${query}`])
  if (r.code !== 0 && !r.out.trim()) throw new Error(`yt-dlp search failed: ${r.err.split(/\r?\n/).find((l) => l.includes('ERROR')) ?? r.err.slice(0, 200)}`)
  const out: TrackCandidate[] = []
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim()) continue
    let v: { id?: string; title?: string; channel?: string; uploader?: string; duration?: number; view_count?: number; live_status?: string }
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (!v.id || !v.title || !v.duration || v.live_status === 'is_live' || v.live_status === 'is_upcoming') continue
    const c = youtubeCandidate(
      { id: v.id, snippet: { title: v.title, channelTitle: v.channel ?? v.uploader }, contentDetails: { duration: iso(v.duration) }, statistics: v.view_count != null ? { viewCount: String(v.view_count) } : undefined },
      why,
    )
    if (c && (c.durationSec ?? 0) >= 90 && (c.durationSec ?? 0) <= 900) out.push(c)
  }
  return out
}
