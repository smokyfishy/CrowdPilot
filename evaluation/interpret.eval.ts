/**
 * Request-interpretation accuracy: real LLM calls on a fixed set of varied mix requests with expected
 * fields. Compares
 *   gemini+guard   Gemini 3.8 Flash, new interpreter prompt + JSON schema + repair + deterministic guard
 *   gemini-old     Gemini 3.8 Flash with the previous interpreter prompt (no schema, no guard)
 *   heuristic      the rule-based fallback
 * Scoring: each expected field is right or wrong (numbers within tolerance, lists by case-insensitive
 * containment). Reports per-system accuracy and every miss.
 *
 *   GEMINI_API_KEY=… [GEMINI_BASE_URL=http://localhost:3001/v1] npx vitest run -c vitest.eval.config.ts evaluation/interpret.eval.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { interpretPrompt } from '../src/server/mixgen-routes'
import { geminiClient } from '../src/server/llm'
import { extractJson, heuristicSpec, MixSpec, parseSpec } from '../src/mixgen/spec'

type Exp = Partial<{
  genres: string[]
  artists: string[]
  artist_matching: MixSpec['artist_matching']
  songs: string[] // titles
  excluded_artists: string[]
  popularity: MixSpec['popularity']
  song_count: number
  target_duration_minutes: number
  bpm_range: [number, number]
  energy_curve: MixSpec['energy_curve'][]
  vocals: MixSpec['vocals']
  transition_style: MixSpec['transition_style'][]
  features: string[]
  era: string
  allow_reordering: boolean
  intensityMin: number
  intensityMax: number
}>

const CASES: Array<{ prompt: string; exp: Exp }> = [
  { prompt: 'Generate a 40-minute tech house mix with 12 tracks, a gradual energy build, strong basslines, and smooth transitions.', exp: { genres: ['tech house'], target_duration_minutes: 40, song_count: 12, energy_curve: ['gradual_build', 'gradual_build_to_peak'], transition_style: ['smooth'], features: ['strong_basslines'] } },
  { prompt: 'Create a 45-minute house and EDM mix with 12 popular tracks. I like John Summit, Dom Dolla, Fisher, Chris Lake, and similar artists. Start groovy, gradually increase the energy, include several big drops, and finish with a festival-style closing track.', exp: { genres: ['house', 'edm'], target_duration_minutes: 45, song_count: 12, popularity: 'high', artists: ['John Summit', 'Dom Dolla', 'Fisher', 'Chris Lake'], artist_matching: 'similar_artists_allowed', energy_curve: ['groovy_then_harder', 'gradual_build_to_peak', 'festival_climax'], features: ['big_drops', 'festival_closer'] } },
  { prompt: 'an hour of dark melodic techno, peak time, no vocals', exp: { genres: ['melodic techno'], target_duration_minutes: 60, vocals: 'instrumental', intensityMin: 0.75 } },
  { prompt: 'chill deep house for a sunday afternoon, about 30 min', exp: { genres: ['deep house'], target_duration_minutes: 30, intensityMax: 0.5 } },
  { prompt: 'Mix Closure by D.O.D, Animals by Martin Garrix and Rattle by Bingo Players in that order', exp: { songs: ['Closure', 'Animals', 'Rattle'], allow_reordering: false } },
  { prompt: '90s house classics, 10 tracks, keep it uplifting', exp: { genres: ['house'], song_count: 10, era: '90s' } },
  { prompt: 'drum and bass set 174 bpm, 25 minutes, lots of energy throughout', exp: { genres: ['drum and bass'], target_duration_minutes: 25, bpm_range: [172, 176], energy_curve: ['constant_high'] } },
  { prompt: 'make a 1.5 hour progressive house journey that builds to a big climax', exp: { genres: ['progressive house'], target_duration_minutes: 90, energy_curve: ['gradual_build_to_peak', 'festival_climax'] } },
  { prompt: 'Afro house, 120-124 BPM, 8 songs, smooth long blends, with vocals', exp: { genres: ['afro house'], bpm_range: [120, 124], song_count: 8, vocals: 'vocal', transition_style: ['smooth'], features: ['long_blends'] } },
  { prompt: 'tech house but no Fisher please, underground stuff only, 35 min', exp: { genres: ['tech house'], excluded_artists: ['Fisher'], popularity: 'underground', target_duration_minutes: 35 } },
  { prompt: 'a creative DJ mix with scratching and echo effects, hip hop, 20 minutes', exp: { genres: ['hip hop'], target_duration_minutes: 20, transition_style: ['creative'], features: ['scratching', 'echo_fx'] } },
  { prompt: 'start high energy and wind down at the end, trance, 50 min', exp: { genres: ['trance'], target_duration_minutes: 50, energy_curve: ['high_then_relaxed'] } },
  { prompt: '30-40 minute disco and nu disco mix of 10 to 12 popular tracks', exp: { genres: ['disco', 'nu disco'], target_duration_minutes: 35, song_count: 11, popularity: 'high' } },
  { prompt: 'Only songs by Chris Lake, 6 tracks', exp: { artists: ['Chris Lake'], artist_matching: 'only_these', song_count: 6 } },
  { prompt: 'mix only the drops of big EDM bangers, 15 minutes, energetic hard switches', exp: { genres: ['edm'], target_duration_minutes: 15, features: ['drop_sections'], transition_style: ['energetic'] } },
  { prompt: 'summer vibes, lofi and chillout, 45 mins, minimal transitions', exp: { genres: ['lofi', 'chillout'], target_duration_minutes: 45, transition_style: ['minimal'] } },
  { prompt: 'peaks and valleys, techno, 2 hours', exp: { genres: ['techno'], target_duration_minutes: 120, energy_curve: ['multiple_peaks'] } },
  { prompt: 'I want I Need You by TWOFACED, Define by Dom Dolla and then similar tech house, 30 minutes total', exp: { songs: ['I Need You', 'Define'], genres: ['tech house'], target_duration_minutes: 30 } },
  { prompt: 'a warm-up set of deep house with breakdowns, 128 bpm, 40 min', exp: { genres: ['deep house'], features: ['breakdowns'], bpm_range: [126, 130], target_duration_minutes: 40, intensityMax: 0.6 } },
  { prompt: 'current hits house mix, smooth but creative transitions, 12 songs', exp: { genres: ['house'], song_count: 12, popularity: 'high', era: 'current', transition_style: ['smooth_creative'] } },
  { prompt: 'bass house with heavy bass and filter sweeps, 20 min, 7 tracks', exp: { genres: ['bass house'], target_duration_minutes: 20, song_count: 7, features: ['strong_basslines', 'filter_fx'] } },
  { prompt: 'start chill then go energetic, melodic house, 1 hour, instrumental', exp: { genres: ['melodic house'], target_duration_minutes: 60, energy_curve: ['chill_to_energetic'], vocals: 'instrumental' } },
  { prompt: 'UK garage from the 2000s, 25 minutes', exp: { genres: ['uk garage'], target_duration_minutes: 25, era: '2000s' } },
  { prompt: 'steady groovy minimal techno for working, 3 hours', exp: { genres: ['minimal techno'], target_duration_minutes: 180, energy_curve: ['steady'] } },
]

const lc = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const containsAll = (have: string[], want: string[]) => want.every((w) => have.map(lc).some((h) => h === lc(w) || h.includes(lc(w)) || lc(w).includes(h)))

function score(spec: MixSpec, exp: Exp): { ok: number; total: number; misses: string[] } {
  const misses: string[] = []
  let ok = 0
  let total = 0
  const check = (name: string, pass: boolean, got: unknown) => {
    total++
    if (pass) ok++
    else misses.push(`${name}: got ${JSON.stringify(got)}`)
  }
  if (exp.genres) check('genres', containsAll(spec.genres, exp.genres), spec.genres)
  if (exp.artists) check('artists', containsAll(spec.artists, exp.artists), spec.artists)
  if (exp.artist_matching !== undefined) check('artist_matching', spec.artist_matching === exp.artist_matching, spec.artist_matching)
  if (exp.songs) check('songs', containsAll(spec.songs.map((s) => s.title), exp.songs), spec.songs.map((s) => s.title))
  if (exp.excluded_artists) check('excluded_artists', containsAll(spec.excluded_artists, exp.excluded_artists), spec.excluded_artists)
  if (exp.popularity !== undefined) check('popularity', spec.popularity === exp.popularity, spec.popularity)
  if (exp.song_count !== undefined) check('song_count', spec.song_count === exp.song_count, spec.song_count)
  if (exp.target_duration_minutes !== undefined) check('target_duration_minutes', spec.target_duration_minutes != null && Math.abs(spec.target_duration_minutes - exp.target_duration_minutes) <= 1, spec.target_duration_minutes)
  if (exp.bpm_range) check('bpm_range', !!spec.bpm_range && Math.abs(spec.bpm_range[0] - exp.bpm_range[0]) <= 2 && Math.abs(spec.bpm_range[1] - exp.bpm_range[1]) <= 2, spec.bpm_range)
  if (exp.energy_curve) check('energy_curve', exp.energy_curve.includes(spec.energy_curve), spec.energy_curve)
  if (exp.vocals !== undefined) check('vocals', spec.vocals === exp.vocals, spec.vocals)
  if (exp.transition_style) check('transition_style', exp.transition_style.includes(spec.transition_style), spec.transition_style)
  if (exp.features) check('features', exp.features.every((f) => spec.features.includes(f as MixSpec['features'][number])), spec.features)
  if (exp.era !== undefined) check('era', !!spec.era && lc(spec.era).includes(lc(exp.era).replace(/s$/, '')), spec.era)
  if (exp.allow_reordering !== undefined) check('allow_reordering', spec.allow_reordering === exp.allow_reordering, spec.allow_reordering)
  if (exp.intensityMin !== undefined) check('intensity≥', (spec.intensity ?? 0) >= exp.intensityMin, spec.intensity)
  if (exp.intensityMax !== undefined) check('intensity≤', spec.intensity !== null && spec.intensity <= exp.intensityMax, spec.intensity)
  return { ok, total, misses }
}

/** The interpreter prompt before this change (for the comparison). */
const OLD_SYSTEM = `You convert a DJ-mix request into a JSON object. Output ONLY JSON, no prose.
Schema (all keys required; use null or [] when the user did not say it — NEVER invent constraints):
{ "title": string|null, "genres": string[], "artists": string[], "artist_matching": "only_these"|"similar_artists_allowed"|"any"|null,
 "songs": [{"artist": string|null, "title": string, "version": string|null}], "excluded_artists": string[], "excluded_songs": string[],
 "popularity": "high"|"mixed"|"underground"|null, "song_count": integer|null, "target_duration_minutes": number|null, "bpm_range": [min,max]|null,
 "energy_curve": "constant_high"|"gradual_build"|"gradual_build_to_peak"|"multiple_peaks"|"chill_to_energetic"|"festival_climax"|"groovy_then_harder"|"high_then_relaxed"|"steady"|null,
 "intensity": number 0..1|null, "moods": string[], "era": string|null, "vocals": "vocal"|"instrumental"|"mixed"|null,
 "transition_style": "smooth"|"smooth_creative"|"creative"|"energetic"|"minimal"|null,
 "features": ("big_drops"|"festival_closer"|"strong_basslines"|"breakdowns"|"long_blends"|"scratching"|"filter_fx"|"echo_fx")[],
 "allow_reordering": boolean|null, "allow_song_substitutions": boolean|null, "explicit": string[], "summary": string }`

it('request interpretation accuracy (real LLM)', async () => {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('set GEMINI_API_KEY (Google AI Studio key, or a FreeLLMAPI key with GEMINI_BASE_URL)')
  const g = geminiClient({ apiKey: key, baseUrl: process.env.GEMINI_BASE_URL, model: process.env.GEMINI_MODEL })
  const systems: Record<string, (p: string) => Promise<MixSpec>> = {
    'gemini+guard': async (p) => (await interpretPrompt([g], { prompt: p })).spec,
    'gemini-old': async (p) => parseSpec(extractJson(await g.call(OLD_SYSTEM, p))),
    heuristic: async (p) => heuristicSpec(p),
  }
  const report: Record<string, { ok: number; total: number; failures: number; misses: string[] }> = {}
  for (const [name, run] of Object.entries(systems)) {
    const r = { ok: 0, total: 0, failures: 0, misses: [] as string[] }
    for (const c of CASES) {
      try {
        const spec = await run(c.prompt)
        const s = score(spec, c.exp)
        r.ok += s.ok
        r.total += s.total
        r.misses.push(...s.misses.map((m) => `"${c.prompt.slice(0, 50)}…" ${m}`))
      } catch (e) {
        r.failures++
        r.total += Object.keys(c.exp).length
        r.misses.push(`"${c.prompt.slice(0, 50)}…" FAILED: ${(e as Error).message.slice(0, 100)}`)
      }
      await new Promise((res) => setTimeout(res, 400)) // stay under free-tier rate limits
    }
    report[name] = r
    process.stderr.write(`INTERPRET ${name}: ${r.ok}/${r.total} fields correct (${Math.round((100 * r.ok) / Math.max(1, r.total))}%), ${r.failures} failed calls\n`)
  }
  mkdirSync('C:/crowdpilot-data/eval', { recursive: true })
  writeFileSync('C:/crowdpilot-data/eval/interpret-accuracy.json', JSON.stringify({ model: g.name, cases: CASES.length, report }, null, 1))
  for (const [name, r] of Object.entries(report)) for (const m of r.misses.slice(0, 40)) process.stderr.write(`  [${name}] ${m}\n`)
}, 900_000)
