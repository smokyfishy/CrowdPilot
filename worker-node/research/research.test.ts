import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideAccess, type PolicyContext } from '../../src/mixgen/policy'
import { jamendoCandidate, youtubeCandidate } from '../../src/mixgen/discovery'
import { heuristicSpec, resolveSpec } from '../../src/mixgen/spec'
import { assertNotResearch, RESEARCH_FLAG, researchYouTubeEnabled } from '../mixgen/research'
import { assertSafeYtDlpArgs, chooseAudioFormat, classifyYtDlpError, restrictionReason, YTDLP_SAFE_ARGS } from '../mixgen/acquire'
import { rejectReason } from './discover'
import { main as containerMain } from '../service/main'

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\./.test(f) ? [p] : []
  })

describe('research flag isolation', () => {
  it('the Cloudflare app and shared pipeline never read CP_RESEARCH_YOUTUBE', () => {
    const files = [...walk('src'), 'worker.ts']
    const readers = files.filter((f) => readFileSync(f, 'utf8').includes(RESEARCH_FLAG))
    expect(readers).toEqual([])
  })
  it('only worker-node/mixgen/research.ts reads the flag', () => {
    // reads only (the `npm run mixgen` launcher SETS it for its own local process)
    const reads = (src: string) => /env\[RESEARCH_FLAG\]/.test(src) || /process\.env\.CP_RESEARCH_YOUTUBE(?!\s*=[^=])/.test(src)
    const readers = walk('worker-node').filter((f) => reads(readFileSync(f, 'utf8')))
    expect(readers.map((f) => f.replace(/\\/g, '/'))).toEqual(['worker-node/mixgen/research.ts'])
  })
  it('flag parsing is strict', () => {
    expect(researchYouTubeEnabled({ CP_RESEARCH_YOUTUBE: '1' })).toBe(true)
    expect(researchYouTubeEnabled({ CP_RESEARCH_YOUTUBE: 'true' })).toBe(false)
    expect(researchYouTubeEnabled({})).toBe(false)
  })
  it('the container worker refuses to start when the flag is set (any value)', async () => {
    expect(() => assertNotResearch({ CP_RESEARCH_YOUTUBE: '0' })).toThrow(/Refusing to start/)
    expect(() => assertNotResearch({})).not.toThrow()
    const prev = process.env.CP_RESEARCH_YOUTUBE
    process.env.CP_RESEARCH_YOUTUBE = '1'
    try {
      await expect(containerMain()).rejects.toThrow(/local-only/)
    } finally {
      if (prev === undefined) delete process.env.CP_RESEARCH_YOUTUBE
      else process.env.CP_RESEARCH_YOUTUBE = prev
    }
  })
})

const yt = youtubeCandidate(
  { id: 'abcdefghijk', snippet: { title: 'John Summit - Where You Are (Official Audio)', channelTitle: 'John Summit' }, contentDetails: { duration: 'PT3M30S' }, statistics: { viewCount: '1000000' }, status: { license: 'youtube' } },
  'artist:John Summit',
)!
const base: PolicyContext = { grants: [], ytDlpAvailable: true, allowAudiusSession: false }

describe('policy research branch', () => {
  it('is off by default and in the cloud', () => {
    expect(decideAccess(yt, base).acquire).toBe(false)
    expect(decideAccess(yt, { ...base, researchYouTube: true }).acquire).toBe(false) // environment defaults to cloud
    expect(decideAccess(yt, { ...base, researchYouTube: true, environment: 'cloud' }).acquire).toBe(false)
    expect(decideAccess(yt, { ...base, researchYouTube: true, environment: 'local', ytDlpAvailable: false }).acquire).toBe(false)
  })
  it('local research: acquire/analyze/mix, never persisted, local-only export', () => {
    const d = decideAccess(yt, { ...base, researchYouTube: true, environment: 'local' })
    expect(d).toMatchObject({ acquire: true, analyze: true, mix: true, persistRender: false, export: true, exportScope: 'local', method: 'yt_dlp_research', reason: 'Local research mode — not for distribution' })
  })
  it('leaves Jamendo, ND exclusion and Audius unchanged', () => {
    const ctx: PolicyContext = { ...base, researchYouTube: true, environment: 'local' }
    const j = (lic: string) => jamendoCandidate({ id: '1', name: 'x', artist_name: 'y', duration: 300, license_ccurl: lic }, 'g')!
    expect(decideAccess(j('http://creativecommons.org/licenses/by-nd/3.0/'), ctx).mix).toBe(false)
    expect(decideAccess(j('http://creativecommons.org/licenses/by-sa/3.0/'), ctx).method).toBe('jamendo_api')
    const audius = { ...yt, source: 'audius' as const, trackKey: 'audius:x', license: { basis: 'audius-cc', label: 'CC' } }
    expect(decideAccess(audius, ctx).acquire).toBe(false)
  })
})

describe('yt-dlp hard safety rules (all modes)', () => {
  it('refuses private, members-only, premium, login-required, age-restricted and live videos', () => {
    for (const availability of ['private', 'subscriber_only', 'premium_only', 'needs_auth']) expect(restrictionReason({ id: 'x', availability })).toMatch(/never acquired/)
    expect(restrictionReason({ id: 'x', availability: 'public', age_limit: 18 })).toMatch(/age-restricted/)
    expect(restrictionReason({ id: 'x', availability: 'public', live_status: 'is_live' })).toMatch(/live/)
    expect(restrictionReason({ id: 'x', availability: 'public', live_status: 'is_upcoming' })).toMatch(/live/)
    expect(restrictionReason({ id: 'x', availability: 'public', live_status: 'was_live' })).toBeNull()
    expect(restrictionReason({ id: 'x', availability: 'unlisted' })).toBeNull()
  })
  it('never selects DRM formats', () => {
    expect(chooseAudioFormat({ id: 'x', formats: [{ format_id: '1', acodec: 'opus', vcodec: 'none', abr: 160, has_drm: true }] })).toBeNull()
    expect(chooseAudioFormat({ id: 'x', formats: [{ format_id: '1', acodec: 'opus', vcodec: 'none', abr: 160, has_drm: true }, { format_id: '2', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128 }] })?.format_id).toBe('2')
  })
  it('never passes cookies or credentials and ignores config files', () => {
    expect(YTDLP_SAFE_ARGS).toEqual(expect.arrayContaining(['--ignore-config', '--no-cookies', '--no-cookies-from-browser']))
    for (const a of ['--cookies', '--cookies=c.txt', '--cookies-from-browser', '--username', '--password', '--netrc', '--video-password']) expect(() => assertSafeYtDlpArgs([a, 'x'])).toThrow(/never used/)
    expect(() => assertSafeYtDlpArgs([...YTDLP_SAFE_ARGS, '-f', '251'])).not.toThrow()
  })
  it('classifies access-control errors as not permitted (never worked around)', () => {
    expect(classifyYtDlpError('ERROR: Sign in to confirm your age')).toBe('not_permitted')
    expect(classifyYtDlpError("ERROR: Sign in to confirm you're not a bot")).toBe('not_permitted')
    expect(classifyYtDlpError('ERROR: Join this channel to get access to members-only content')).toBe('not_permitted')
    expect(classifyYtDlpError('ERROR: Video unavailable')).toBe('unavailable')
    expect(classifyYtDlpError('ERROR: Unable to download webpage: timed out')).toBe('network')
  })
})

describe('research discovery filters', () => {
  const spec = resolveSpec(heuristicSpec('45 minute house mix. I like John Summit and similar artists'))
  const mk = (title: string, channel = 'Someone', dur = 'PT3M30S') => youtubeCandidate({ id: 'abcdefghijk', snippet: { title, channelTitle: channel }, contentDetails: { duration: dur } }, 'genre:house')!
  it('rejects covers, edits, live, lyric re-uploads and DJ mixes', () => {
    expect(rejectReason(mk('Artist - Song (sped up)'), spec)).toMatch(/variant/)
    expect(rejectReason(mk('Artist - Song (Cover)'), spec)).toMatch(/cover/)
    expect(rejectReason(mk('Artist - Song (Live)'), spec)).toMatch(/live/)
    expect(rejectReason(mk('Artist - Song (Lyrics)'), spec)).toMatch(/lyric/)
    expect(rejectReason(mk('House Mix 2026', 'DJ X', 'PT58M'), spec)).toMatch(/DJ mix/)
    expect(rejectReason(mk('John Summit - Where You Are (Official Audio)', 'John Summit'), spec)).toBeNull()
  })
})

describe('genre evidence', () => {
  it('counts a genre only when the upload mentions it', async () => {
    const { genreEvidence } = await import('./discover')
    const spec = resolveSpec(heuristicSpec('40 minute tech house mix'))
    const a = youtubeCandidate({ id: 'abcdefghijk', snippet: { title: 'Artist - Groove (Original Mix)', channelTitle: 'Label', tags: ['Tech House', 'club'] }, contentDetails: { duration: 'PT6M' } }, 'genre:tech house')!
    const b = youtubeCandidate({ id: 'bcdefghijkl', snippet: { title: 'Pop Star - Radio Hit (Official Audio)', channelTitle: 'Pop Star' }, contentDetails: { duration: 'PT3M' } }, 'genre:tech house')!
    expect(genreEvidence(a, spec)).toEqual(['tech house'])
    expect(genreEvidence(b, spec)).toEqual([])
  })
})

describe('live set detection', () => {
  it('rejects DJ-set / festival recordings', async () => {
    const { rejectReason: rr } = await import('./discover')
    const spec = resolveSpec(heuristicSpec('40 minute tech house mix'))
    const c = youtubeCandidate({ id: 'abcdefghijk', snippet: { title: "Carl Cox @ Burning Man 2024 - Tony Romera, Crusy - 'The Unknown'", channelTitle: 'Toolroom Records' }, contentDetails: { duration: 'PT5M' } }, 'genre:tech house')!
    expect(rr(c, spec)).toMatch(/live\/DJ-set/)
  })
})
