/**
 * Node acquisition adapters (research/processing worker). Each implements
 * AudioSourceProvider; every download goes through the central access policy decision
 * passed in by the pipeline and is refused without it.
 *
 *  - Jamendo: API re-resolve → lossless FLAC download when the track allows downloads,
 *    otherwise the highest-quality MP3 stream (mp32 VBR). Cached + deduplicated by sha256.
 *  - Audius: official stream endpoint (320 kbps MP3). Session-only (deleted at job end).
 *  - YouTube via yt-dlp: ONLY for videos/channels with an operator-recorded authorization
 *    grant. Refuses DRM-flagged formats and non-public/restricted availability; never
 *    passes cookies, never bypasses access controls. Best audio-only stream in its
 *    original container (Opus/WebM or AAC/M4A), no transcoding.
 */
import { spawn } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createJamendoDiscovery, createAudiusDiscovery, createYouTubeDiscovery, type DiscoveryQuery } from '../../src/mixgen/discovery'
import { AcquisitionError } from '../../src/mixgen/pipeline'
import type { AudioCapabilities, AudioSourceProvider, ResolvedTrack } from '../../src/mixgen/provider'
import type { AccessDecision, AcquiredAudio, TrackCandidate } from '../../src/mixgen/types'
import { decideAccess, type PolicyContext } from '../../src/mixgen/policy'
import { probe } from './ffmpeg'
import { dir, findByHash, readIndex, sha256File, writeIndexEntry, type IndexEntry } from './storage'

const UA = 'CrowdPilot-research/1.0 (noncommercial)'

/** Resumable HTTP download (Range on an existing .part), with content checks. */
export async function download(url: string, finalPath: string, opts: { minBytes?: number; timeoutMs?: number } = {}): Promise<void> {
  const part = finalPath + '.part'
  const have = existsSync(part) ? statSync(part).size : 0
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow', signal: ctrl.signal })
    if (!res.ok && res.status !== 206) await res.body?.cancel().catch(() => undefined) // never leave a body unconsumed (undici)
    if (res.status === 404 || res.status === 410) throw new AcquisitionError(`source returned ${res.status} (recording unavailable)`, 'unavailable')
    if (res.status === 401 || res.status === 403) throw new AcquisitionError(`source refused access (${res.status})`, 'not_permitted')
    if (!res.ok && res.status !== 206) throw new AcquisitionError(`HTTP ${res.status}`, 'network')
    const append = res.status === 206 && have > 0
    if (!append && have) unlinkSync(part)
    const ws = createWriteStream(part, { flags: append ? 'a' : 'w' })
    const reader = res.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!ws.write(value)) await new Promise<void>((r) => ws.once('drain', () => r()))
    }
    await new Promise<void>((r, j) => ws.end((e?: Error | null) => (e ? j(e) : r())))
    const size = statSync(part).size
    const expected = Number(res.headers.get('content-length') ?? 0) + (append ? have : 0)
    if (expected && size < expected) throw new AcquisitionError(`truncated download (${size}/${expected} bytes)`, 'network')
    if (size < (opts.minBytes ?? 200_000)) throw new AcquisitionError(`file too small (${size} bytes)`, 'invalid_audio')
    // Identify by content, not by the (sometimes wrong) Content-Type header.
    const fmt = sniffAudio(part)
    if (!fmt) {
      unlinkSync(part)
      throw new AcquisitionError(`downloaded bytes are not a recognized audio container (content-type ${res.headers.get('content-type')})`, 'unavailable')
    }
    renameSync(part, finalPath)
  } catch (e) {
    if (e instanceof AcquisitionError) throw e
    throw new AcquisitionError(`download failed: ${(e as Error).message}`, 'network')
  } finally {
    clearTimeout(timer)
  }
}

/** Magic-byte sniffing for supported containers. */
export function sniffAudio(path: string): string | null {
  const fd = openSync(path, 'r')
  const b = Buffer.alloc(16)
  try {
    readSync(fd, b, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  const s4 = b.toString('latin1', 0, 4)
  if (s4 === 'fLaC') return 'flac'
  if (s4 === 'OggS') return 'ogg'
  if (s4 === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav'
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  if (s4.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm'
  return null
}

/** Probe + hash + dedupe + index a downloaded file. */
async function finalize(c: TrackCandidate, path: string, access: AccessDecision, url: string, session: boolean): Promise<AcquiredAudio> {
  let info
  try {
    info = await probe(path)
  } catch (e) {
    unlinkSync(path)
    throw new AcquisitionError((e as Error).message, 'invalid_audio')
  }
  if (info.durationSec < 30) throw new AcquisitionError(`audio too short (${info.durationSec.toFixed(1)} s)`, 'invalid_audio')
  if (c.durationSec && Math.abs(info.durationSec - c.durationSec) > Math.max(6, c.durationSec * 0.05)) {
    throw new AcquisitionError(`duration mismatch: file ${info.durationSec.toFixed(1)} s vs metadata ${c.durationSec.toFixed(1)} s (wrong or partial recording)`, 'integrity')
  }
  const sha = await sha256File(path)
  const dup = findByHash(sha)
  const entry: IndexEntry = {
    trackKey: c.trackKey,
    sha256: sha,
    bytes: statSync(path).size,
    container: info.container,
    codec: info.codec,
    sampleRate: info.sampleRate,
    channels: info.channels,
    durationSec: Math.round(info.durationSec * 100) / 100,
    method: access.method,
    acquiredAt: new Date().toISOString(),
    handle: `sha256:${sha}`,
    path: dup && dup.path !== path ? dup.path : path,
    provenance: { url: url.replace(/client_id=[^&]+/, 'client_id=…'), license: c.license.label, policyVersion: access.policyVersion, reason: access.reason },
  }
  if (dup && dup.path !== path) unlinkSync(path) // identical bytes already stored under another key
  if (!session) writeIndexEntry(entry)
  const { path: _p, provenance: _v, ...pub } = entry
  return { ...pub, handle: entry.handle }
}

export interface NodeSources {
  providers: AudioSourceProvider[]
  acquire(c: TrackCandidate, access: AccessDecision): Promise<AcquiredAudio>
  pathOf(audio: AcquiredAudio): string
}

export function createNodeSources(env: { jamendoClientId?: string; youtubeApiKey?: string; policy: PolicyContext }): NodeSources {
  const paths = new Map<string, string>()
  const jamDisc = createJamendoDiscovery(env.jamendoClientId)
  const audDisc = createAudiusDiscovery()
  const ytDisc = createYouTubeDiscovery(env.youtubeApiKey)
  const cachedHit = (c: TrackCandidate): AcquiredAudio | null => {
    const e = readIndex()[c.trackKey]
    if (e && existsSync(e.path)) {
      paths.set(e.handle, e.path)
      const { path: _p, provenance: _v, ...pub } = e
      return pub
    }
    return null
  }
  const register = (a: AcquiredAudio, p: string) => {
    paths.set(a.handle, readIndex()[a.trackKey]?.path ?? p)
    return a
  }

  const jamendo: AudioSourceProvider = {
    id: 'jamendo',
    searchTracks: (q: DiscoveryQuery) => jamDisc.searchTracks(q),
    async resolveTrack(c) {
      if (!env.jamendoClientId) return { candidate: c, available: false, reason: 'Jamendo not configured' }
      const p = new URLSearchParams({ client_id: env.jamendoClientId, format: 'json', id: c.sourceId, audioformat: 'mp32', audiodlformat: 'flac', include: 'licenses' })
      // The API intermittently answers 0 results under load; retry before calling it unavailable.
      let t: { audio?: string; audiodownload?: string; audiodownload_allowed?: boolean; license_ccurl?: string } | undefined
      for (let attempt = 0; attempt < 4 && !t; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt))
        const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${p.toString()}`).catch(() => null)
        const body = (await res?.json().catch(() => ({}))) as { results?: Array<NonNullable<typeof t>> } | undefined
        t = body?.results?.[0]
      }
      if (!t) return { candidate: c, available: false, reason: 'track not returned by the Jamendo API after 4 attempts (removed or temporarily unavailable)' }
      const url = t.audiodownload_allowed && t.audiodownload ? t.audiodownload : t.audio
      if (!url) return { candidate: c, available: false, reason: 'no audio URL' }
      return { candidate: { ...c, url: c.url }, available: true, bestFormat: t.audiodownload_allowed && t.audiodownload ? `flac|${url}` : `mp3-vbr|${url}` }
    },
    async getCapabilities(t): Promise<AudioCapabilities> {
      return { access: decideAccess(t.candidate, env.policy), formats: t.bestFormat ? [t.bestFormat.split('|')[0]] : [], delivery: 'download' }
    },
    async acquireAudio(t, access) {
      if (!access.acquire || access.method !== 'jamendo_api') throw new AcquisitionError(access.reason, 'not_permitted')
      if (!t.available || !t.bestFormat) throw new AcquisitionError(t.reason ?? 'unavailable', 'unavailable')
      const [fmt, url] = [t.bestFormat.split('|')[0], t.bestFormat.slice(t.bestFormat.indexOf('|') + 1)]
      const path = join(dir('acquired', 'jamendo'), `${t.candidate.sourceId}.${fmt === 'flac' ? 'flac' : 'mp3'}`)
      try {
        await download(url, path, { minBytes: 300_000 })
      } catch (e) {
        // FLAC endpoint occasionally refuses; fall back to the MP3 stream once.
        if (fmt !== 'flac' || !(e instanceof AcquisitionError)) throw e
        const p = new URLSearchParams({ client_id: env.jamendoClientId!, format: 'json', id: t.candidate.sourceId, audioformat: 'mp32' })
        const r = (await (await fetch(`https://api.jamendo.com/v3.0/tracks/?${p.toString()}`)).json()) as { results?: Array<{ audio?: string }> }
        const alt = r.results?.[0]?.audio
        if (!alt) throw e
        const mp3 = path.replace(/\.flac$/, '.mp3')
        await download(alt, mp3, { minBytes: 300_000 })
        return register(await finalize(t.candidate, mp3, access, alt, false), mp3)
      }
      return register(await finalize(t.candidate, path, access, url, false), path)
    },
  }

  const audius: AudioSourceProvider = {
    id: 'audius',
    searchTracks: (q: DiscoveryQuery) => audDisc.searchTracks(q),
    async resolveTrack(c) {
      const res = await fetch(`https://api.audius.co/v1/tracks/${encodeURIComponent(c.sourceId)}?app_name=CrowdPilot`)
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return { candidate: c, available: false, reason: `Audius ${res.status}` }
      }
      const t = ((await res.json()) as { data?: { is_streamable?: boolean; is_stream_gated?: boolean; is_delete?: boolean } }).data
      if (!t || t.is_delete || t.is_streamable === false || t.is_stream_gated) return { candidate: c, available: false, reason: 'not streamable (gated, deleted or unavailable)' }
      return { candidate: c, available: true, bestFormat: 'mp3-320' }
    },
    async getCapabilities(t) {
      return { access: decideAccess(t.candidate, env.policy), formats: ['mp3-320'], delivery: 'stream' }
    },
    async acquireAudio(t, access) {
      if (!access.acquire || access.method !== 'audius_stream') throw new AcquisitionError(access.reason, 'not_permitted')
      if (!t.available) throw new AcquisitionError(t.reason ?? 'unavailable', 'unavailable')
      // Session-only (API Terms): stored under session/ and deleted when the job ends.
      const path = join(dir('session'), `audius_${t.candidate.sourceId}.mp3`)
      const url = `https://api.audius.co/v1/tracks/${encodeURIComponent(t.candidate.sourceId)}/stream?app_name=CrowdPilot`
      await download(url, path, { minBytes: 300_000 })
      const a = await finalize(t.candidate, path, access, url, true)
      paths.set(a.handle, path)
      return a
    },
  }

  const youtube: AudioSourceProvider = {
    id: 'youtube',
    searchTracks: (q: DiscoveryQuery) => ytDisc.searchTracks(q),
    async resolveTrack(c) {
      return { candidate: c, available: true }
    },
    async getCapabilities(t) {
      const access = decideAccess(t.candidate, env.policy)
      return { access, formats: access.acquire ? ['bestaudio (original container)'] : [], delivery: access.acquire ? 'download' : 'none' }
    },
    async acquireAudio(t, access) {
      // Hard gate: an explicit authorization grant (policy) AND a yt-dlp-capable environment.
      if (!access.acquire || access.method !== 'yt_dlp_authorized') throw new AcquisitionError(access.reason, 'not_permitted')
      return register(...(await ytDlpAcquire(t.candidate, access)))
    },
  }

  const byId = { jamendo, audius, youtube }
  return {
    providers: [jamendo, audius, youtube],
    async acquire(c, access) {
      const hit = cachedHit(c)
      if (hit) return hit
      const p = byId[c.source]
      const t = await p.resolveTrack(c)
      if (!t.available) throw new AcquisitionError(t.reason ?? 'unavailable', 'unavailable')
      return p.acquireAudio(t, access)
    },
    pathOf(audio) {
      const p = paths.get(audio.handle) ?? Object.values(readIndex()).find((e) => e.handle === audio.handle)?.path
      if (!p) throw new Error(`no stored file for ${audio.trackKey}`)
      return p
    },
  }
}

// ───────────────────────── yt-dlp adapter ─────────────────────────

function runYtDlp(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('python', ['-m', 'yt_dlp', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }))
  })
}

export function parseYouTubeId(input: string): string | null {
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input
  try {
    const u = new URL(input)
    if (/(^|\.)youtube\.com$/.test(u.hostname)) return u.searchParams.get('v') ?? (/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[2] ?? null)
    if (u.hostname === 'youtu.be') return /^\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1] ?? null
  } catch {
    /* not a URL */
  }
  return null
}

interface YtInfo {
  id: string
  availability?: string
  age_limit?: number
  is_live?: boolean
  formats?: Array<{ format_id: string; acodec?: string; vcodec?: string; abr?: number; ext?: string; has_drm?: boolean | string }>
}

/** Pick the best audio-only, non-DRM format (highest bitrate; Opus preferred at equal bitrate). */
export function chooseAudioFormat(info: YtInfo): { format_id: string; ext: string; abr: number; acodec: string } | null {
  const fs = (info.formats ?? []).filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && !f.has_drm)
  if (!fs.length) return null
  fs.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0) || (b.acodec?.startsWith('opus') ? 1 : 0) - (a.acodec?.startsWith('opus') ? 1 : 0))
  const f = fs[0]
  return { format_id: f.format_id, ext: f.ext ?? 'webm', abr: f.abr ?? 0, acodec: f.acodec ?? '' }
}

async function ytDlpAcquire(c: TrackCandidate, access: AccessDecision): Promise<[AcquiredAudio, string]> {
  const id = parseYouTubeId(c.sourceId) ?? parseYouTubeId(c.url ?? '')
  if (!id) throw new AcquisitionError('not a YouTube video id or URL', 'invalid_audio')
  const url = `https://www.youtube.com/watch?v=${id}`
  const meta = await runYtDlp(['--dump-single-json', '--no-playlist', '--no-warnings', url])
  if (meta.code !== 0) {
    const msg = meta.err.split('\n').find((l) => l.includes('ERROR')) ?? meta.err.slice(0, 200)
    throw new AcquisitionError(`yt-dlp: ${msg.trim()}`, /unavailable|private|removed|not available/i.test(msg) ? 'unavailable' : 'network')
  }
  const info = JSON.parse(meta.out) as YtInfo
  if (info.availability && info.availability !== 'public' && info.availability !== 'unlisted') throw new AcquisitionError(`video availability "${info.availability}" — access-restricted content is never acquired`, 'not_permitted')
  if ((info.age_limit ?? 0) > 0) throw new AcquisitionError('age-restricted video (requires sign-in) — not acquired', 'not_permitted')
  if (info.is_live) throw new AcquisitionError('live stream — not a recording', 'unavailable')
  const fmt = chooseAudioFormat(info)
  if (!fmt) throw new AcquisitionError('no DRM-free audio-only format available', 'not_permitted')
  const outPath = join(dir('acquired', 'youtube'), `${id}.${fmt.ext}`)
  if (!existsSync(outPath)) {
    const r = await runYtDlp(['-f', fmt.format_id, '--no-playlist', '--continue', '--retries', '3', '--fragment-retries', '3', '--no-mtime', '-o', outPath, url])
    if (r.code !== 0 || !existsSync(outPath)) throw new AcquisitionError(`yt-dlp download failed: ${r.err.split('\n').filter((l) => l.includes('ERROR')).join(' ').slice(0, 200)}`, 'network')
  }
  const a = await finalize(c, outPath, access, url, false)
  return [a, outPath]
}
