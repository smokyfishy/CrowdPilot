import { describe, expect, it } from 'vitest'
import { createAudiusProvider, normalizeAudius } from './audius'
import { ccLabel, createJamendoProvider, normalizeJamendo } from './jamendo'
import { bestMixableMatch, parseYouTubeTitle } from './match'
import type { CatalogTrack } from './types'

const audiusRow = (over: Record<string, unknown> = {}) => ({
  id: 'abc123',
  title: 'Night Drive',
  duration: 312,
  license: 'All rights reserved',
  permalink: '/artist/night-drive',
  is_streamable: true,
  access: { stream: true },
  artwork: { '150x150': 'https://audius-creator-1.example.xyz/content/x/150x150.jpg' },
  user: { name: 'Some Artist', is_verified: true },
  ...over,
})

describe('audius provider', () => {
  it('normalizes streamable tracks and flags OML mixing for review', () => {
    const t = normalizeAudius(audiusRow())!
    expect(t.trackKey).toBe('audius:abc123')
    expect(t.mixability).toBe('mixable')
    expect(t.rights?.basis).toBe('audius-oml')
    expect(t.rights?.mixingNeedsReview).toBe(true)
    expect(t.durationMs).toBe(312_000)
  })
  it('treats CC-licensed uploads as licence-based', () => {
    const t = normalizeAudius(audiusRow({ license: 'Attribution-NonCommercial CC BY-NC' }))!
    expect(t.rights?.basis).toBe('audius-cc')
    expect(t.rights?.mixingNeedsReview).toBe(false)
  })
  it('excludes gated, deleted, unavailable and non-streamable tracks', () => {
    expect(normalizeAudius(audiusRow({ is_stream_gated: true }))).toBeNull()
    expect(normalizeAudius(audiusRow({ is_delete: true }))).toBeNull()
    expect(normalizeAudius(audiusRow({ is_available: false }))).toBeNull()
    expect(normalizeAudius(audiusRow({ access: { stream: false } }))).toBeNull()
  })
  it('searches via the public API with app_name and maps errors', async () => {
    let url = ''
    const fake = (async (u: string) => {
      url = String(u)
      return new Response(JSON.stringify({ data: [audiusRow(), audiusRow({ id: 'g', is_stream_gated: true })] }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await createAudiusProvider(fake).search('night drive')
    expect(url).toContain('app_name=CrowdPilot')
    expect(r.ok && r.value.length).toBe(1)
    const down = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
    const e = await createAudiusProvider(down).search('x')
    expect(!e.ok && e.error.code).toBe('UPSTREAM')
  })
})

describe('jamendo provider', () => {
  it('parses CC licence urls and flags ND licences for review', () => {
    expect(ccLabel('http://creativecommons.org/licenses/by-nc-sa/3.0/').basis).toBe('cc-by-nc-sa-3.0')
    expect(ccLabel('https://creativecommons.org/licenses/by-nd/4.0/').ndOrUnknown).toBe(true)
    const t = normalizeJamendo({ id: '42', name: 'Song', duration: 200, artist_name: 'A', license_ccurl: 'http://creativecommons.org/licenses/by/3.0/' })!
    expect(t.trackKey).toBe('jamendo:42')
    expect(t.rights?.mixingNeedsReview).toBe(false)
  })
  it('reports not-configured without a client id', async () => {
    const r = await createJamendoProvider(undefined).search('house')
    expect(!r.ok && r.error.code).toBe('PROVIDER_NOT_CONFIGURED')
  })
})

describe('youtube → mixable matching', () => {
  const cand = (over: Partial<CatalogTrack>): CatalogTrack => ({
    source: 'audius',
    sourceId: 'x',
    trackKey: 'audius:x',
    title: 'Night Drive',
    creatorLabel: 'Some Artist',
    durationMs: 312_000,
    playable: true,
    mixability: 'mixable',
    rights: { basis: 'audius-oml', uploaderVerified: true },
    ...over,
  })
  it('parses "Artist - Title (Official Video)"', () => {
    expect(parseYouTubeTitle('Some Artist - Night Drive (Official Video)')).toEqual({ artist: 'Some Artist', title: 'Night Drive' })
    expect(parseYouTubeTitle('Night Drive', 'Some Artist - Topic')).toEqual({ artist: 'Some Artist', title: 'Night Drive' })
  })
  it('matches a verified uploader with matching title and duration', () => {
    const m = bestMixableMatch({ title: 'Some Artist - Night Drive (Official Audio)', durationMs: 313_500 }, [cand({})])
    expect(m?.candidate.trackKey).toBe('audius:x')
  })
  it('rejects unverified re-uploads, remix mismatches and duration mismatches', () => {
    const yt = { title: 'Some Artist - Night Drive', durationMs: 312_000 }
    expect(bestMixableMatch(yt, [cand({ rights: { basis: 'audius-oml', uploaderVerified: false } })])).toBeNull()
    expect(bestMixableMatch(yt, [cand({ title: 'Night Drive (Bob Remix)' })])).toBeNull()
    expect(bestMixableMatch(yt, [cand({ durationMs: 330_000 })])).toBeNull()
    expect(bestMixableMatch(yt, [cand({ creatorLabel: 'Other Person' })])).toBeNull()
  })
})
