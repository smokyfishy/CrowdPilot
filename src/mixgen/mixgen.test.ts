import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from '../dsp/analyze'
import { synthTrack } from '../dsp/synth'
import { extractJson, heuristicSpec, MixSpec, parseSpec, resolveSpec } from './spec'
import { decideAccess, mixPermissions, type PolicyContext } from './policy'
import { makeIdentity, matchesSongRequest, sameRecording, versionClues, youtubeIdentity } from './identity'
import { jamendoCandidate, youtubeCandidate, queryPlan } from './discovery'
import { orderSet, preselect, type OrderTrack } from './select'
import { targetEnergy } from './energy'
import { MasterLimiter, MixAnalyzer } from './meter'
import { OggOpusMuxer, oggCrc } from './browser/ogg-opus'
import { alignLag, incomingPosAt, renderMix } from './mix-render'
import { planMix, type PlannedTrack } from './mixplan'
import { heuristicEditOps, interpretPrompt, mergeHeuristicEdit } from '../server/mixgen-routes'
import type { TrackCandidate } from './types'

const TEST_PROMPT = 'Generate a 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines, and smooth transitions.'

describe('spec', () => {
  it('heuristic interpreter parses the acceptance prompt without inventing constraints', () => {
    const s = heuristicSpec(TEST_PROMPT)
    expect(s.genres).toContain('tech house')
    expect(s.song_count).toBe(12)
    expect(s.target_duration_minutes).toBe(40)
    expect(s.energy_curve).toBe('gradual_build')
    expect(s.transition_style).toBe('smooth')
    expect(s.features).toContain('strong_basslines')
    expect(s.bpm_range).toBeNull()
    expect(s.artists).toEqual([])
    expect(s.popularity).toBeNull()
  })
  it('reads artists and similar-artist intent', () => {
    const s = heuristicSpec('Create a 45-minute house and EDM mix with 12 popular tracks. I like John Summit, Dom Dolla, Fisher, Chris Lake, and similar artists. Start groovy, gradually increase the energy, include several big drops, and finish with a festival-style closing track.')
    expect(s.artists).toEqual(['John Summit', 'Dom Dolla', 'Fisher', 'Chris Lake'])
    expect(s.artist_matching).toBe('similar_artists_allowed')
    expect(s.popularity).toBe('high')
    expect(s.features).toEqual(expect.arrayContaining(['big_drops', 'festival_closer']))
  })
  it('resolveSpec records defaults and derives count from duration', () => {
    const r = resolveSpec(MixSpec.parse({ target_duration_minutes: 30 }))
    expect(r.songCount).toBe(8)
    expect(r.defaulted).toEqual(expect.arrayContaining(['energy_curve', 'genres']))
    expect(r.defaulted).not.toContain('song_count') // derived from the stated duration, not a default
    expect(r.targetDurationSec).toBe(1800)
  })
  it('validates model JSON strictly', () => {
    expect(() => parseSpec({ song_count: 500 })).toThrow(/song_count/)
    expect(() => parseSpec({ bpm_range: [140, 120] })).toThrow(/bpm_range/)
    const s = parseSpec(extractJson('```json\n{"genres":["house"],"explicit":["genres","bogus"],"summary":"x"}\n```'))
    expect(s.explicit).toEqual(['genres'])
  })
  it('LLM path falls back to the labelled heuristic when the model output is invalid', async () => {
    const r = await interpretPrompt(async () => 'not json', { prompt: TEST_PROMPT })
    expect(r.source).toBe('heuristic')
    expect(r.warning).toMatch(/AI interpreter failed/)
    const ok = await interpretPrompt(async () => JSON.stringify({ genres: ['tech house'], song_count: 12, target_duration_minutes: 40, explicit: ['genres'], summary: 's' }), { prompt: TEST_PROMPT })
    expect(ok.source).toBe('llm')
    expect(ok.spec.song_count).toBe(12)
  })
  it('heuristic edits', () => {
    const base = heuristicSpec(TEST_PROMPT)
    expect(mergeHeuristicEdit(base, 'Make this 30 minutes instead').target_duration_minutes).toBe(30)
    expect(mergeHeuristicEdit(base, 'Reduce the number of vocals').vocals).toBe('instrumental')
    expect(mergeHeuristicEdit(base, 'Make it more energetic').intensity).toBeCloseTo(0.8)
    expect(heuristicEditOps('Replace the third song')).toEqual([{ op: 'replace', position: 3 }])
    expect(heuristicEditOps('remove track 5')).toEqual([])
    expect(heuristicEditOps('remove the 5th track')).toEqual([{ op: 'remove', position: 5 }])
  })
})

const ctx: PolicyContext = { grants: [], ytDlpAvailable: true, allowAudiusSession: false }
const jam = (lic: string, id = '1') => jamendoCandidate({ id, name: 'Night Drive', artist_name: 'Some Artist', duration: 300, license_ccurl: lic }, 'genre:house')!
const yt = youtubeCandidate({ id: 'dQw4w9WgXcQ', snippet: { title: 'John Summit - Where You Are (Official Audio)', channelTitle: 'John Summit' }, contentDetails: { duration: 'PT3M30S' }, statistics: { viewCount: '1000' }, status: { license: 'youtube' } }, 'artist:John Summit')!

describe('source-access policy', () => {
  it('Jamendo non-ND is fully usable with attribution; ND is never mixed', () => {
    const a = decideAccess(jam('http://creativecommons.org/licenses/by-nc-sa/3.0/'), ctx)
    expect(a).toMatchObject({ acquire: true, mix: true, persistRender: true, export: true, attributionRequired: true, method: 'jamendo_api' })
    const nd = decideAccess(jam('http://creativecommons.org/licenses/by-nc-nd/3.0/'), ctx)
    expect(nd.mix).toBe(false)
    expect(nd.acquire).toBe(false)
  })
  it('public YouTube videos are NOT downloadable without a rights-holder grant', () => {
    const d = decideAccess(yt, ctx)
    expect(d.acquire).toBe(false)
    expect(d.reason).toMatch(/no download authorization/)
  })
  it('a recorded grant enables yt-dlp only where a download worker exists; expired grants are ignored', () => {
    const g = { scope: 'youtube_video' as const, id: 'dQw4w9WgXcQ', grantor: 'Label X', evidence: 'email 2026-11-01', allows: ['acquire', 'mix'] as Array<'acquire' | 'mix'> }
    expect(decideAccess(yt, { ...ctx, grants: [g] })).toMatchObject({ acquire: true, mix: true, persistRender: false, method: 'yt_dlp_authorized' })
    expect(decideAccess(yt, { ...ctx, grants: [g], ytDlpAvailable: false }).acquire).toBe(false)
    expect(decideAccess(yt, { ...ctx, grants: [{ ...g, expires: '2020-01-01' }] }).acquire).toBe(false)
  })
  it('mix permissions: strictest track wins', () => {
    const p = mixPermissions([decideAccess(jam('http://creativecommons.org/licenses/by/4.0/'), ctx), decideAccess(yt, { ...ctx, grants: [{ scope: 'youtube_video', id: yt.sourceId, grantor: 'x', evidence: 'y', allows: ['acquire', 'mix'] }] })])
    expect(p.export).toBe(false)
    expect(p.persistRender).toBe(false)
  })
})

describe('recording identity', () => {
  it('parses version clues and rejects undesirable variants', () => {
    expect(versionClues('Track (Extended Mix)').version).toBe('extended mix')
    expect(versionClues('Track - Fisher Remix').version).toBe('fisher remix')
    expect(versionClues('Track (sped up)').undesirable).toBe(true)
  })
  it('matches the same recording across providers, never an original with a remix', () => {
    const y = youtubeIdentity('Dom Dolla - Saving Up (Official Audio)', 'Dom Dolla')
    expect(y.official).toBe(true)
    const a = { identity: makeIdentity('Dom Dolla', 'Saving Up'), durationSec: 200 }
    expect(sameRecording({ identity: y.identity, durationSec: 201 }, a).same).toBe(true)
    expect(sameRecording({ identity: makeIdentity('Dom Dolla', 'Saving Up (Fisher Remix)'), durationSec: 200 }, a).same).toBe(false)
    expect(sameRecording({ identity: y.identity, durationSec: 230 }, a).same).toBe(false)
    expect(matchesSongRequest({ artist: 'Dom Dolla', title: 'Saving Up', version: null }, a)).toBe(true)
  })
  it('query plan covers songs, artists and genres', () => {
    const r = resolveSpec(heuristicSpec('45 minute house mix. I like John Summit, Fisher and similar artists'))
    const plan = queryPlan(r)
    expect(plan.some((p) => p.provider === 'youtube' && p.q.artist === 'John Summit')).toBe(true)
    expect(plan.some((p) => p.provider === 'jamendo' && p.q.genres?.includes('house'))).toBe(true)
  })
})

describe('selection and ordering', () => {
  it('reports requested artists without an authorized source instead of faking them', () => {
    const spec = resolveSpec(heuristicSpec('30 minute house mix. I like John Summit and similar artists'))
    const pool: TrackCandidate[] = [yt, ...Array.from({ length: 12 }, (_, i) => jam('http://creativecommons.org/licenses/by/4.0/', String(100 + i)))].map((c, i) => (c.source === 'jamendo' ? { ...c, artist: `Artist ${i}`, identity: makeIdentity(`Artist ${i}`, `Song ${i}`), genres: ['house'] } : c))
    const pre = preselect(spec, pool, (c) => decideAccess(c, ctx).mix)
    expect(pre.unavailable.map((u) => u.request)).toContain('John Summit')
    expect(pre.unavailable[0].reason).toMatch(/none has an authorized audio source/)
    expect(pre.toAcquire.every((s) => s.candidate.source === 'jamendo')).toBe(true)
  })
  it('beam search follows the energy arc rather than sorting by BPM', () => {
    const spec = resolveSpec(MixSpec.parse({ energy_curve: 'gradual_build', song_count: 5 }))
    const tracks: OrderTrack[] = [0.9, 0.1, 0.5, 0.3, 0.7].map((e, i) => ({ key: `t${i}`, pref: 0, bpm: 124 + (i % 2), bpmConf: 0.5, camelot: '8A', keyConf: 0.5, energy: e, dropStrength: 0, vocal: 0, artist: `a${i}`, durationSec: 300, gridOk: true }))
    const r = orderSet(tracks, spec, { count: 5 })
    const energies = r.order.map((k) => tracks.find((t) => t.key === k)!.energy)
    expect(energies).toEqual([...energies].sort((a, b) => a - b))
    expect(targetEnergy('gradual_build', 0)).toBeLessThan(targetEnergy('gradual_build', 1))
  })
})

describe('streaming meters', () => {
  it('limiter holds the −1 dBFS ceiling with look-ahead (no clipped samples)', () => {
    const rate = 44100
    const lim = new MasterLimiter(2, rate)
    const an = new MixAnalyzer(2, rate)
    for (let b = 0; b < 20; b++) {
      const blk = [new Float32Array(4410), new Float32Array(4410)]
      for (let i = 0; i < 4410; i++) blk[0][i] = blk[1][i] = 1.6 * Math.sin((2 * Math.PI * 440 * (b * 4410 + i)) / rate)
      lim.process(blk)
      an.push(blk)
    }
    const m = an.finish()
    expect(m.samplePeakDb).toBeLessThanOrEqual(-0.99)
    expect(m.clippedSamples).toBe(0)
    expect(lim.minGain).toBeLessThan(0.6)
  })
  it('detects silence gaps and measures loudness', () => {
    const rate = 22050
    const an = new MixAnalyzer(2, rate)
    const tone = (n: number, a: number) => {
      const x = new Float32Array(n)
      for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * 1000 * i) / rate)
      return [x, x]
    }
    an.push(tone(rate * 3, 0.5))
    an.push([new Float32Array(rate * 2), new Float32Array(rate * 2)])
    an.push(tone(rate * 3, 0.5))
    const m = an.finish()
    expect(m.silences.length).toBe(1)
    expect(m.silences[0].durationSec).toBeCloseTo(2, 1)
    expect(m.integratedLufs).toBeGreaterThan(-12)
    expect(m.integratedLufs).toBeLessThan(-3)
  })
})

describe('Ogg Opus muxer', () => {
  it('CRC matches the Ogg reference value and pages are well formed', () => {
    expect(oggCrc(new TextEncoder().encode('OggS'))).toBe(0x5fb0a94f)
    const mx = new OggOpusMuxer(2, 48000)
    for (let i = 0; i < 120; i++) mx.addPacket(new Uint8Array(100 + (i % 7)), 960)
    return mx.finish(120 * 960 - 100).arrayBuffer().then((buf) => {
      const b = new Uint8Array(buf)
      let o = 0
      let pages = 0
      let lastFlags = 0
      while (o < b.length) {
        expect(String.fromCharCode(...b.slice(o, o + 4))).toBe('OggS')
        const segs = b[o + 26]
        let body = 0
        for (let k = 0; k < segs; k++) body += b[o + 27 + k]
        const page = b.slice(o, o + 27 + segs + body)
        const stored = new DataView(page.buffer).getUint32(22, true)
        new DataView(page.buffer).setUint32(22, 0, true)
        expect(oggCrc(page)).toBe(stored)
        lastFlags = b[o + 5]
        o += 27 + segs + body
        pages++
      }
      expect(pages).toBeGreaterThan(3)
      expect(lastFlags & 4).toBe(4)
    })
  })
})

describe('full-mix renderer on synthetic tracks (mechanics only, not a quality claim)', () => {
  it('renders a continuous 3-track mix with aligned splices, correct timeline and no gaps', async () => {
    const rate = 22050
    const specs = [
      { bpm: 124, bars: 96, tonic: 9, seed: 1 },
      { bpm: 126, bars: 96, tonic: 4, seed: 2 },
      { bpm: 125, bars: 96, tonic: 9, seed: 3 },
    ]
    const tracks = specs.map((s) => synthTrack({ ...s, sampleRate: rate, mode: 'minor', introBars: 16, outroBars: 16, breakdown: [40, 48] }))
    const planned: PlannedTrack[] = tracks.map((t, i) => {
      const a = analyzeTrack({ channels: t.channels, sampleRate: rate })
      return { key: `k${i}`, title: `synth ${i}`, summary: summarize(a), trimDb: 0 }
    })
    const spec = resolveSpec(MixSpec.parse({ song_count: 3, target_duration_minutes: 7, transition_style: 'smooth' }))
    const plan = planMix(planned, spec)
    expect(plan.transitions).toHaveLength(2)
    expect(plan.transitions.every((t) => t.plan.durationSec > 0)).toBe(true)
    const byKey = new Map(tracks.map((t, i) => [`k${i}`, { channels: [t.channels[0], t.channels[1] ?? t.channels[0]], rate }]))
    let samples = 0
    const r = await renderMix(plan, { load: async (k) => byKey.get(k)! }, { write: (b) => void (samples += b[0].length) })
    expect(r.metrics.silences).toEqual([])
    expect(r.metrics.clippedSamples).toBe(0)
    expect(Math.abs(r.metrics.durationSec - plan.durationSec)).toBeLessThan(0.5)
    expect(samples).toBe(r.metrics.samples)
    for (const t of r.transitions) {
      expect(Math.abs(t.spliceLagMs)).toBeLessThan(15)
      expect(t.spliceCorrelation).toBeGreaterThan(0.8)
    }
    // renderer timestamps agree with the planned timeline within a few ms
    r.transitions.forEach((t, i) => expect(Math.abs(t.mixStartSec - plan.transitions[i].mixStartSec)).toBeLessThan(0.05))
  }, 120_000)
  it('incoming position integrates the tempo ramp', () => {
    const p = { style: 'long_blend', tempoRatio: 1.02, durationSec: 30, tempoRecoveryBars: 4, beatSec: 0.5, inCueSec: 10 } as unknown as Parameters<typeof incomingPosAt>[0]
    expect(incomingPosAt(p, 30)).toBeCloseTo(10 + 30 * 1.02, 6)
    expect(incomingPosAt(p, 38)).toBeCloseTo(10 + 30.6 + 8 * 1.01, 6)
    expect(incomingPosAt(p, 40)).toBeCloseTo(10 + 30.6 + 8 * 1.01 + 2, 6)
    const x = new Float32Array(8000).map((_, i) => Math.sin(i * 0.05) + Math.sin(i * 0.31))
    expect(alignLag(x.slice(3000, 5000), [x], 3010, 40).lag).toBe(-10)
  })
})

describe('song-list prompts', () => {
  it('parses an exact list of "Title by Artist" requests', () => {
    const s = heuristicSpec('Create a high energy mix, specifically mixing the beatdrops/middle of the songs of I Need You by TWOFACED, Closure by D.O.D, Love somebody by cutback!, and Play Hard by David Guetta.')
    expect(s.songs.map((x) => [x.title, x.artist])).toEqual([['I Need You', 'TWOFACED'], ['Closure', 'D.O.D'], ['Love somebody', 'cutback!'], ['Play Hard', 'David Guetta']])
    expect(s.allow_song_substitutions).toBe(false)
    expect(s.energy_curve).toBe('constant_high')
    expect(s.features).toEqual(expect.arrayContaining(['big_drops', 'drop_sections']))
    expect(resolveSpec(s).songCount).toBe(4)
  })
  it('keeps "of" inside real titles and ignores non-song "by" phrases', () => {
    const s = heuristicSpec('Mix these songs: Edge of Seventeen by Stevie Nicks and Titanium by David Guetta')
    expect(s.songs.map((x) => x.title)).toEqual(['Edge of Seventeen', 'Titanium'])
    expect(heuristicSpec('A mix inspired by 90s rave').songs).toEqual([])
  })
})

describe('featured artists with hyphens', () => {
  it('matches "Play Hard ft. Ne-Yo, Akon" to the requested "Play Hard"', () => {
    const y = youtubeIdentity('David Guetta - Play Hard ft. Ne-Yo, Akon (Official Video)', 'David Guetta')
    expect(y.identity.title).toBe('play hard')
    expect(y.identity.featured).toEqual(expect.arrayContaining(['ne yo', 'akon']))
    expect(matchesSongRequest({ artist: 'David Guetta', title: 'Play Hard', version: null }, y)).toBe(true)
  })
})

describe('creativity defaults and local grids', () => {
  it('high-energy / drop-focused requests default to energetic transitions; "cool effects" → creative', () => {
    expect(resolveSpec(heuristicSpec('a high energy mix of big drops')).transitionStyle).toBe('energetic')
    expect(resolveSpec(heuristicSpec('a mix with cool effects like a DJ')).transitionStyle).toBe('creative')
    expect(resolveSpec(heuristicSpec('a relaxed deep house mix')).transitionStyle).toBe('smooth')
  })
  it('localGrid recovers a usable tempo from regular Beat This! beats when the global grid failed', async () => {
    const { localGrid } = await import('./mixplan')
    const base = summarize(analyzeTrack({ ...synthTrack({ bpm: 141, bars: 64, sampleRate: 22050 }), sampleRate: 22050 }))
    const failed = { ...base, bpmConf: 0, stable: false }
    const beats = Array.from({ length: 300 }, (_, k) => 0.2 + (k * 60) / 141)
    const g = localGrid(failed, beats, 'out')
    expect(g.stable).toBe(true)
    expect(g.bpm).toBeCloseTo(141, 0)
    const irregular = beats.map((t, k) => t + (k % 3) * 0.06)
    expect(localGrid(failed, irregular, 'out').stable).toBe(false)
  })
})
