/**
 * Structured mix specification: the validated contract between the natural-language
 * prompt (interpreted by an LLM on the server) and the deterministic pipeline.
 *
 * Rules:
 *  - Only what the user actually said is set. Everything else stays `null`/empty and
 *    the pipeline applies documented defaults (`resolveSpec`), never invented constraints.
 *  - `explicit` lists the fields the user stated, so the review screen can show
 *    "you asked for" vs "default".
 */
import { z } from 'zod'

export const ENERGY_CURVES = [
  'constant_high',
  'gradual_build',
  'gradual_build_to_peak',
  'multiple_peaks',
  'chill_to_energetic',
  'festival_climax',
  'groovy_then_harder',
  'high_then_relaxed',
  'steady',
] as const
export type EnergyCurve = (typeof ENERGY_CURVES)[number]

export const TRANSITION_STYLES = ['smooth', 'smooth_creative', 'creative', 'energetic', 'minimal'] as const

/** DJ techniques a user can ask for (or ban) by name. */
export const TECHNIQUE_NAMES = ['drop_swap', 'loop_roll', 'echo_out', 'bass_swap', 'filter_sweep', 'long_blend', 'cut', 'scratch', 'brake', 'spinback', 'acapella', 'mashup', 'double_drop', 'reverb_wash', 'beat_juggle', 'stabs'] as const
export type TechniqueName = (typeof TECHNIQUE_NAMES)[number]

/** Phrases that name a technique (deterministic detection, used by the guard and the heuristic). */
export const TECHNIQUE_PHRASES: Array<[TechniqueName, RegExp]> = [
  ['drop_swap', /drop[- ]?swaps?|build(?:s|ing)?(?: up)? (?:in)?to (?:the |a )?drops?|swap(?:ping)? on the drops?/],
  ['loop_roll', /loop[- ]?rolls?|beat[- ]?rolls?/],
  ['echo_out', /echo[- ]?outs?/],
  ['bass_swap', /bass[- ]?swaps?/],
  ['filter_sweep', /filter[- ]?sweeps?/],
  ['long_blend', /long blends?/],
  ['cut', /hard cuts?|quick cuts?/],
  ['scratch', /scratch(?:es|ing)?|turntablism/],
  ['brake', /vinyl brakes?|brake stops?/],
  ['spinback', /spin[- ]?backs?/],
  ['acapella', /acapellas?|a cappellas?/],
  ['mashup', /mash[- ]?ups?/],
  ['double_drop', /double[- ]?drops?/],
  ['reverb_wash', /reverb (?:wash|tails?)/],
  ['beat_juggle', /beat[- ]?juggl(?:e|es|ing)/],
  ['stabs', /(?:sample )?stabs?/],
]

/** Techniques named in a prompt: [prefer, avoid] ("no loop rolls" / "without echo outs" → avoid). */
export function detectTechniques(prompt: string): { prefer: TechniqueName[]; avoid: TechniqueName[] } {
  const p = prompt.toLowerCase()
  const prefer: TechniqueName[] = []
  const avoid: TechniqueName[] = []
  for (const [name, re] of TECHNIQUE_PHRASES) {
    const m = new RegExp(re.source, 'g')
    for (let mm = m.exec(p); mm; mm = m.exec(p)) {
      const before = p.slice(Math.max(0, mm.index - 24), mm.index)
      if (/\b(no|not|without|avoid|never|don'?t (?:use|do|want)|stop|less)\b[^,.;]*$/.test(before)) {
        if (!avoid.includes(name)) avoid.push(name)
      } else if (!prefer.includes(name) && !avoid.includes(name)) prefer.push(name)
    }
  }
  return { prefer: prefer.filter((t) => !avoid.includes(t)), avoid }
}
export type TransitionStylePref = (typeof TRANSITION_STYLES)[number]

export const SongRef = z.object({
  artist: z.string().trim().min(1).max(120).nullable(),
  title: z.string().trim().min(1).max(200),
  /** Version the user asked for ("extended mix", "Fisher remix"), if any. */
  version: z.string().trim().max(120).nullable().default(null),
})
export type SongRef = z.infer<typeof SongRef>

export const MixSpec = z.object({
  title: z.string().trim().max(120).nullable().default(null),
  automation_model: z.enum(['standard', 'transitionnet', 'transitionnet-only']).optional(),
  genres: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  artists: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  artist_matching: z.enum(['only_these', 'similar_artists_allowed', 'any']).nullable().default(null),
  songs: z.array(SongRef).max(30).default([]),
  excluded_artists: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  excluded_songs: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  popularity: z.enum(['high', 'mixed', 'underground']).nullable().default(null),
  song_count: z.number().int().min(2).max(30).nullable().default(null),
  target_duration_minutes: z.number().min(5).max(180).nullable().default(null),
  bpm_range: z
    .tuple([z.number().min(60).max(200), z.number().min(60).max(200)])
    .refine(([a, b]) => a <= b, 'bpm_range must be [min, max]')
    .nullable()
    .default(null),
  energy_curve: z.enum(ENERGY_CURVES).nullable().default(null),
  /** 0..1 overall intensity, if stated ("chill" ≈ 0.3, "peak time" ≈ 0.9). */
  intensity: z.number().min(0).max(1).nullable().default(null),
  moods: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  era: z.string().trim().max(40).nullable().default(null),
  vocals: z.enum(['vocal', 'instrumental', 'mixed']).nullable().default(null),
  transition_style: z.enum(TRANSITION_STYLES).nullable().default(null),
  /** Musical moments the user explicitly asked for. */
  features: z.array(z.enum(['big_drops', 'drop_sections', 'festival_closer', 'strong_basslines', 'breakdowns', 'long_blends', 'scratching', 'filter_fx', 'echo_fx'])).max(9).default([]),
  /** Transition techniques the user named: use these where the music allows / never use these. */
  techniques: z.object({ prefer: z.array(z.enum(TECHNIQUE_NAMES)).max(16).default([]), avoid: z.array(z.enum(TECHNIQUE_NAMES)).max(16).default([]) }).default({ prefer: [], avoid: [] }),
  allow_reordering: z.boolean().nullable().default(null),
  allow_song_substitutions: z.boolean().nullable().default(null),
  /** Fields the user explicitly stated (names of the keys above). */
  explicit: z.array(z.string()).max(40).default([]),
  /** One-line human summary of the interpretation (shown on the review screen). */
  summary: z.string().trim().max(400).default(''),
  /** Which interpreter produced this spec and what the deterministic guard corrected (recorded with the mix). */
  interpretation: z.object({ model: z.string().max(80), corrections: z.array(z.string().max(200)).max(20).default([]), attempts: z.array(z.string().max(200)).max(10).default([]) }).optional(),
})
export type MixSpec = z.infer<typeof MixSpec>

/** Fully resolved spec used by the pipeline: defaults applied, every field concrete. */
export interface ResolvedSpec {
  title: string
  genres: string[]
  artists: string[]
  artistMatching: 'only_these' | 'similar_artists_allowed' | 'any'
  songs: SongRef[]
  excludedArtists: string[]
  excludedSongs: string[]
  popularity: 'high' | 'mixed' | 'underground'
  songCount: number
  targetDurationSec: number
  bpmRange: [number, number] | null
  energyCurve: EnergyCurve
  intensity: number
  moods: string[]
  /** Era the user asked for ("90s", "2010s", "current"), or null. */
  era: string | null
  vocals: 'vocal' | 'instrumental' | 'mixed'
  transitionStyle: TransitionStylePref
  features: MixSpec['features']
  /** Named techniques to prefer / avoid. */
  techniques: { prefer: TechniqueName[]; avoid: TechniqueName[] }
  allowReordering: boolean
  allowSubstitutions: boolean
  /** Which values came from defaults (for honest display). */
  defaulted: string[]
  /** Interpreter model, guard corrections and failed attempts (from MixSpec.interpretation). */
  interpretation?: MixSpec['interpretation']
}

export const DEFAULTS = {
  songCount: 12,
  minutesPerSong: 3.6,
  energyCurve: 'gradual_build' as EnergyCurve,
  transitionStyle: 'smooth' as TransitionStylePref,
  popularity: 'mixed' as const,
  vocals: 'mixed' as const,
  intensity: 0.6,
}

export function resolveSpec(spec: MixSpec): ResolvedSpec {
  const defaulted: string[] = []
  const d = <T>(key: string, v: T | null | undefined, dflt: T): T => {
    if (v === null || v === undefined) {
      defaulted.push(key)
      return dflt
    }
    return v
  }
  let songCount = spec.song_count
  let minutes = spec.target_duration_minutes
  // Drop-focused sets play mostly each track's middle (build → drop), so each track is shorter.
  const perSong = spec.features.includes('drop_sections') ? 2.2 : DEFAULTS.minutesPerSong
  if (songCount == null && spec.songs.length) songCount = Math.min(30, Math.max(2, spec.songs.length))
  if (songCount == null && minutes != null) songCount = Math.max(4, Math.min(30, Math.round(minutes / perSong)))
  songCount = d('song_count', songCount, DEFAULTS.songCount)
  if (minutes == null) {
    defaulted.push('target_duration_minutes')
    minutes = Math.max(5, Math.round(songCount * perSong))
  }
  const genres = spec.genres.length ? spec.genres : (defaulted.push('genres'), ['electronic'])
  return {
    title: spec.title ?? defaultTitle(spec, genres),
    genres,
    artists: spec.artists,
    artistMatching: d('artist_matching', spec.artist_matching, spec.artists.length ? 'similar_artists_allowed' : 'any'),
    songs: spec.songs,
    excludedArtists: spec.excluded_artists,
    excludedSongs: spec.excluded_songs,
    popularity: d('popularity', spec.popularity, DEFAULTS.popularity),
    songCount,
    targetDurationSec: minutes * 60,
    bpmRange: spec.bpm_range,
    energyCurve: d('energy_curve', spec.energy_curve, DEFAULTS.energyCurve),
    intensity: d('intensity', spec.intensity, DEFAULTS.intensity),
    moods: spec.moods,
    era: spec.era,
    vocals: d('vocals', spec.vocals, DEFAULTS.vocals),
    // No stated style: high-energy / drop-focused requests get energetic transitions (effects, drop
    // swaps, loop rolls, tempo rides); everything else stays smooth.
    transitionStyle: d(
      'transition_style',
      spec.transition_style,
      (spec.techniques?.prefer ?? []).some((t) => t === 'drop_swap' || t === 'loop_roll' || t === 'echo_out' || t === 'scratch' || t === 'brake' || t === 'spinback') ? 'creative'
        : spec.energy_curve === 'constant_high' || spec.energy_curve === 'festival_climax' || (spec.intensity ?? 0) >= 0.8 || spec.features.includes('drop_sections') ? 'energetic' : DEFAULTS.transitionStyle,
    ),
    features: spec.features,
    techniques: spec.techniques ?? { prefer: [], avoid: [] },
    allowReordering: d('allow_reordering', spec.allow_reordering, true),
    allowSubstitutions: d('allow_song_substitutions', spec.allow_song_substitutions, true),
    defaulted,
    interpretation: spec.interpretation,
  }
}

function defaultTitle(spec: MixSpec, genres: string[]): string {
  const g = genres.slice(0, 2).map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase())).join(' & ')
  const m = spec.target_duration_minutes ? `${Math.round(spec.target_duration_minutes)}-minute ` : ''
  return `${m}${g} mix`.trim()
}

/** System prompt for the LLM interpreter. The model must return JSON matching MixSpec. */
export const INTERPRET_SYSTEM = `You are the request interpreter of an AI DJ. Convert the user's DJ-mix request into ONE JSON object that matches the schema. Output ONLY the JSON object.

Golden rule: capture EVERYTHING the user asked for, and NOTHING they did not. When the user did not say something, use null or []. Never invent artists, songs, numbers or constraints.

Schema (every key required):
{
 "title": string|null,                 // only if the user named the mix
 "genres": string[],                   // genres/subgenres mentioned, lower case, e.g. "tech house", "melodic techno", "drum and bass"
 "artists": string[],                  // artists the user names as wanted/liked, spelled exactly as written
 "artist_matching": "only_these"|"similar_artists_allowed"|"any"|null,
 "songs": [{"artist": string|null, "title": string, "version": string|null}], // specific songs requested; version = "extended mix", "Fisher remix", …
 "excluded_artists": string[], "excluded_songs": string[],   // "no X", "without X", "avoid X"
 "popularity": "high"|"mixed"|"underground"|null,
 "song_count": integer|null,           // number of tracks if stated
 "target_duration_minutes": number|null, // total length if stated ("an hour" = 60, "1.5 hours" = 90, a range "30-40 min" = its middle)
 "bpm_range": [min,max]|null,          // only if BPM is stated; a single BPM "128 bpm" = [126,130]
 "energy_curve": "constant_high"|"gradual_build"|"gradual_build_to_peak"|"multiple_peaks"|"chill_to_energetic"|"festival_climax"|"groovy_then_harder"|"high_then_relaxed"|"steady"|null,
 "intensity": number 0..1|null,        // overall energy if stated: chill/lounge 0.3, warm-up 0.45, groovy 0.55, club 0.7, peak-time/banging 0.9
 "moods": string[],                    // adjectives about feel: "dark", "uplifting", "summery", "emotional", "groovy", "euphoric"
 "era": string|null,                   // "90s", "2000s", "2010s", "classic", "current/new" → "current"
 "vocals": "vocal"|"instrumental"|"mixed"|null,
 "transition_style": "smooth"|"smooth_creative"|"creative"|"energetic"|"minimal"|null,
 "features": ("big_drops"|"drop_sections"|"festival_closer"|"strong_basslines"|"breakdowns"|"long_blends"|"scratching"|"filter_fx"|"echo_fx")[],
 "techniques": {"prefer": T[], "avoid": T[]}, // transition techniques the user NAMES; T = "drop_swap"|"loop_roll"|"echo_out"|"bass_swap"|"filter_sweep"|"long_blend"|"cut"|"scratch"|"brake"|"spinback"|"acapella"|"mashup"|"double_drop"|"reverb_wash"|"beat_juggle"|"stabs"
 "allow_reordering": boolean|null,     // false when the user says "in this order"/"keep the order"
 "allow_song_substitutions": boolean|null, // false when the user says "only these songs"/"exactly these"
 "explicit": string[],                 // names of the keys above that the user explicitly stated
 "summary": string                     // one sentence restating the request faithfully
}

Mapping rules:
- popularity: "popular", "hits", "big tracks", "mainstream", "well-known", "familiar", "bangers everyone knows" → "high"; "underground", "deep cuts", "lesser-known", "obscure" → "underground".
- artist_matching: names + "and similar"/"artists like"/"in the style of" → "similar_artists_allowed"; "only"/"just"/"exclusively" + names → "only_these".
- energy_curve: "build up gradually"/"slow build" → "gradual_build"; "build to a peak"/"climax" → "gradual_build_to_peak"; "start chill/groovy then harder/increase" → "groovy_then_harder" (groovy) or "chill_to_energetic" (chill); "high energy throughout"/"non-stop bangers" → "constant_high"; "peaks and valleys"/"waves"/"ups and downs" → "multiple_peaks"; "end with a festival moment" → "festival_climax"; "start high, wind down"/"cool down at the end" → "high_then_relaxed"; "consistent/even energy" → "steady".
- transition_style: "smooth/seamless/long blends" → "smooth"; "smooth but creative" → "smooth_creative"; "creative/effects/tricks/like a real DJ/turntablism" → "creative"; "hard cuts/fast/high-energy switches" → "energetic"; "minimal/simple" → "minimal".
- features: "drops"/"big drops" → "big_drops"; "mix the drops"/"drop to drop"/"only the best parts/middle of the songs" → "drop_sections"; "festival closer"/"closing anthem" → "festival_closer"; "basslines"/"heavy bass" → "strong_basslines"; "breakdowns" → "breakdowns"; "long blends" → "long_blends"; "scratching"/"turntablism" → "scratching"; "filters" → "filter_fx"; "echo/delay" → "echo_fx".
- techniques: name-level requests go here and are binding. "drop swap", "build into the drop", "swap on the drop" → prefer "drop_swap" (NOT loop_roll); "loop roll(s)" → "loop_roll"; "echo out" → "echo_out"; "bass swap" → "bass_swap"; "no loop rolls"/"without echo outs" → avoid. Never add a technique the user did not name.
- vocals: "instrumental"/"no vocals"/"fewer vocals" → "instrumental"; "vocal tracks"/"sing-along"/"with vocals" → "vocal".
- "Title by Artist" lists are songs; keep each title and artist exactly as written.
- Put a key in "explicit" ONLY if the user stated it (directly or with the words above).

Example — "45-min tech house set, 12 tracks, start groovy then go harder, John Summit and Dom Dolla vibes, big drops, no vocals":
{"title":null,"genres":["tech house"],"artists":["John Summit","Dom Dolla"],"artist_matching":"similar_artists_allowed","songs":[],"excluded_artists":[],"excluded_songs":[],"popularity":null,"song_count":12,"target_duration_minutes":45,"bpm_range":null,"energy_curve":"groovy_then_harder","intensity":null,"moods":[],"era":null,"vocals":"instrumental","transition_style":null,"features":["big_drops"],"techniques":{"prefer":[],"avoid":[]},"allow_reordering":null,"allow_song_substitutions":null,"explicit":["genres","artists","artist_matching","song_count","target_duration_minutes","energy_curve","vocals","features"],"summary":"A 45-minute, 12-track tech house set in the style of John Summit and Dom Dolla that starts groovy and gets harder, with big drops and no vocals."}

Example — "5 minute electronic mix, drop swaps building into each drop, no loop rolls":
{"title":null,"genres":["electronic"],"artists":[],"artist_matching":null,"songs":[],"excluded_artists":[],"excluded_songs":[],"popularity":null,"song_count":null,"target_duration_minutes":5,"bpm_range":null,"energy_curve":null,"intensity":null,"moods":[],"era":null,"vocals":null,"transition_style":null,"features":["big_drops"],"techniques":{"prefer":["drop_swap"],"avoid":["loop_roll"]},"allow_reordering":null,"allow_song_substitutions":null,"explicit":["genres","target_duration_minutes","features","techniques"],"summary":"A 5-minute electronic mix that builds into each drop with drop swaps and never uses loop rolls."}

Example — "Mix Closure by D.O.D, Animals by Martin Garrix and Rattle by Bingo Players, in that order, 128 bpm":
{"title":null,"genres":[],"artists":["D.O.D","Martin Garrix","Bingo Players"],"artist_matching":null,"songs":[{"artist":"D.O.D","title":"Closure","version":null},{"artist":"Martin Garrix","title":"Animals","version":null},{"artist":"Bingo Players","title":"Rattle","version":null}],"excluded_artists":[],"excluded_songs":[],"popularity":null,"song_count":3,"target_duration_minutes":null,"bpm_range":[126,130],"energy_curve":null,"intensity":null,"moods":[],"era":null,"vocals":null,"transition_style":null,"features":[],"techniques":{"prefer":[],"avoid":[]},"allow_reordering":false,"allow_song_substitutions":null,"explicit":["songs","song_count","bpm_range","allow_reordering"],"summary":"Mix Closure (D.O.D), Animals (Martin Garrix) and Rattle (Bingo Players) in that order at about 128 BPM."}`

const nullable = (t: Record<string, unknown>) => ({ anyOf: [t, { type: 'null' }] })
const strArr = { type: 'array', items: { type: 'string' } }

/** JSON schema of MixSpec for structured LLM output (mirrors the Zod schema; Zod still validates). */
export const MIX_SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: nullable({ type: 'string' }),
    genres: strArr,
    artists: strArr,
    artist_matching: nullable({ type: 'string', enum: ['only_these', 'similar_artists_allowed', 'any'] }),
    songs: { type: 'array', items: { type: 'object', properties: { artist: nullable({ type: 'string' }), title: { type: 'string' }, version: nullable({ type: 'string' }) }, required: ['artist', 'title', 'version'] } },
    excluded_artists: strArr,
    excluded_songs: strArr,
    popularity: nullable({ type: 'string', enum: ['high', 'mixed', 'underground'] }),
    song_count: nullable({ type: 'integer' }),
    target_duration_minutes: nullable({ type: 'number' }),
    bpm_range: nullable({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }),
    energy_curve: nullable({ type: 'string', enum: [...ENERGY_CURVES] }),
    intensity: nullable({ type: 'number' }),
    moods: strArr,
    era: nullable({ type: 'string' }),
    vocals: nullable({ type: 'string', enum: ['vocal', 'instrumental', 'mixed'] }),
    transition_style: nullable({ type: 'string', enum: [...TRANSITION_STYLES] }),
    features: { type: 'array', items: { type: 'string', enum: ['big_drops', 'drop_sections', 'festival_closer', 'strong_basslines', 'breakdowns', 'long_blends', 'scratching', 'filter_fx', 'echo_fx'] } },
    techniques: { type: 'object', properties: { prefer: { type: 'array', items: { type: 'string', enum: [...TECHNIQUE_NAMES] } }, avoid: { type: 'array', items: { type: 'string', enum: [...TECHNIQUE_NAMES] } } }, required: ['prefer', 'avoid'] },
    allow_reordering: nullable({ type: 'boolean' }),
    allow_song_substitutions: nullable({ type: 'boolean' }),
    explicit: strArr,
    summary: { type: 'string' },
  },
  required: ['title', 'genres', 'artists', 'artist_matching', 'songs', 'excluded_artists', 'excluded_songs', 'popularity', 'song_count', 'target_duration_minutes', 'bpm_range', 'energy_curve', 'intensity', 'moods', 'era', 'vocals', 'transition_style', 'features', 'techniques', 'allow_reordering', 'allow_song_substitutions', 'explicit', 'summary'],
}

/**
 * Deterministic cross-check of an LLM interpretation against facts that can be read unambiguously
 * from the prompt: stated duration, track count, BPM, genre keywords and "Title by Artist" songs.
 * Where the model contradicts or drops one of those, the stated value wins. Returns the corrected
 * spec and a list of corrections (recorded with the mix).
 */
export function guardSpec(prompt: string, spec: MixSpec): { spec: MixSpec; corrections: string[] } {
  const h = heuristicSpec(prompt)
  const p = prompt.toLowerCase()
  // ranges ("30-40 minutes", "10 to 12 tracks") are the model's job (it takes the middle); don't override them
  const durRange = /\d+\s*(?:-|–|to)\s*\d+\s*-?\s*(?:min|minute|hour)/.test(p)
  const cntRange = /\d+\s*(?:-|–|to)\s*\d+\s+(?:[a-z]+\s+)?(?:tracks|songs|records)/.test(p)
  if (durRange) h.target_duration_minutes = null
  if (cntRange) h.song_count = null
  // genre keywords with word boundaries ("popular" is not "pop")
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  h.genres = h.genres.filter((g) => new RegExp(`(^|[^a-z])${esc(g)}([^a-z]|$)`).test(p))
  const s: MixSpec = { ...spec, explicit: [...spec.explicit] }
  const corrections: string[] = []
  const mark = (k: string) => !s.explicit.includes(k) && s.explicit.push(k)
  if (h.target_duration_minutes != null && s.target_duration_minutes !== h.target_duration_minutes) {
    corrections.push(`duration ${s.target_duration_minutes ?? 'missing'} → ${h.target_duration_minutes} min (stated in the request)`)
    s.target_duration_minutes = h.target_duration_minutes
    mark('target_duration_minutes')
  }
  if (h.song_count != null && s.song_count !== h.song_count) {
    corrections.push(`track count ${s.song_count ?? 'missing'} → ${h.song_count} (stated in the request)`)
    s.song_count = h.song_count
    mark('song_count')
  }
  if (h.bpm_range && (!s.bpm_range || s.bpm_range[0] !== h.bpm_range[0] || s.bpm_range[1] !== h.bpm_range[1])) {
    corrections.push(`BPM ${s.bpm_range ? s.bpm_range.join('–') : 'missing'} → ${h.bpm_range.join('–')} (stated in the request)`)
    s.bpm_range = h.bpm_range
    mark('bpm_range')
  }
  const have = new Set(s.genres.map((g) => g.toLowerCase()))
  const missingGenres = h.genres.filter((g) => !have.has(g) && ![...have].some((x) => x.includes(g) || g.includes(x)))
  if (missingGenres.length) {
    corrections.push(`added genre(s) named in the request: ${missingGenres.join(', ')}`)
    s.genres = [...s.genres, ...missingGenres]
    mark('genres')
  }
  const named = detectTechniques(prompt)
  const prefer = new Set(s.techniques?.prefer ?? [])
  const avoid = new Set(s.techniques?.avoid ?? [])
  const addP = named.prefer.filter((t) => !prefer.has(t) && !avoid.has(t))
  const addA = named.avoid.filter((t) => !avoid.has(t))
  if (addP.length || addA.length) {
    corrections.push(`techniques named in the request: ${[...addP.map((t) => `+${t}`), ...addA.map((t) => `no ${t}`)].join(', ')}`)
    for (const t of addA) prefer.delete(t)
    s.techniques = { prefer: [...prefer, ...addP].filter((t) => !addA.includes(t)), avoid: [...avoid, ...addA] }
    mark('techniques')
  }
  if (!s.songs.length && h.songs.length) {
    corrections.push(`added ${h.songs.length} song(s) listed as "Title by Artist"`)
    s.songs = h.songs
    mark('songs')
  }
  return { spec: MixSpec.parse(s), corrections }
}

export const REFINE_SYSTEM = `You update an existing DJ-mix JSON specification according to the user's edit request.
Return the COMPLETE updated JSON object using the same schema as the input, changing only what the edit implies
(e.g. "make it more energetic" → raise intensity and/or set energy_curve; "30 minutes instead" → target_duration_minutes 30;
"reduce vocals" → vocals "instrumental"; "smoother transitions" → transition_style "smooth"). Add changed keys to "explicit".
If the edit refers to a specific track position (e.g. "replace the third song"), keep the spec and put the instruction into
"edit_ops" as {"op":"replace","position":3}. Output ONLY JSON: {"spec": <spec>, "edit_ops": [...]}`

/** Year range of an era phrase ("90s", "2010s", "early 2000s", "classic", "current"), or null. */
export function eraYears(era: string | null | undefined, now = new Date().getFullYear()): [number, number] | null {
  if (!era) return null
  const e = era.toLowerCase()
  if (/current|new|latest|recent|modern|this year/.test(e)) return [now - 2, now]
  if (/classic|old ?school|throwback/.test(e)) return [1985, 2009]
  const dec = /(?:19|20)?(\d)0'?s/.exec(e)
  if (dec) {
    const full = /((?:19|20)\d0)s/.exec(e)
    const start = full ? Number(full[1]) : Number(dec[1]) >= 5 ? 1900 + Number(dec[1]) * 10 : 2000 + Number(dec[1]) * 10
    const half = /early/.test(e) ? [0, 4] : /late/.test(e) ? [5, 9] : [0, 9]
    return [start + half[0], start + half[1]]
  }
  const yr = /(19|20)\d\d/.exec(e)
  return yr ? [Number(yr[0]) - 1, Number(yr[0]) + 1] : null
}

export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace'), position: z.number().int().min(1).max(30) }),
  z.object({ op: z.literal('remove'), position: z.number().int().min(1).max(30) }),
])
export type EditOp = z.infer<typeof EditOp>

/** Extract the first JSON object from model text (tolerates code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in model output')
  return JSON.parse(body.slice(start, end + 1))
}

/** Validate (and coerce) a model's JSON into a MixSpec. Throws a readable error. */
export function parseSpec(raw: unknown): MixSpec {
  const r = MixSpec.safeParse(raw)
  if (!r.success) throw new Error(`Spec validation failed: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const s = r.data
  // Drop "explicit" names that are not real keys.
  const keys = new Set(Object.keys(MixSpec.shape))
  s.explicit = s.explicit.filter((k) => keys.has(k))
  return s
}

// ───────────── deterministic fallback interpreter (used only when the LLM is unavailable) ─────────────

const GENRE_WORDS = [
  'tech house', 'deep house', 'progressive house', 'afro house', 'melodic techno', 'future house', 'bass house', 'electro house',
  'drum and bass', 'drum & bass', 'dnb', 'liquid', 'uk garage', 'garage', 'dubstep', 'trance', 'psytrance', 'techno', 'house',
  'edm', 'disco', 'nu disco', 'funk', 'hip hop', 'lofi', 'lo-fi', 'ambient', 'chillout', 'downtempo', 'synthwave', 'pop', 'electronic',
  'big room', 'hardstyle', 'breakbeat', 'minimal',
]

/**
 * Keyword interpreter. Deliberately conservative: it only sets what it can read
 * unambiguously and marks itself in `summary`, so the UI can show "basic interpretation".
 */
export function heuristicSpec(prompt: string): MixSpec {
  const p = prompt.toLowerCase()
  const explicit: string[] = []
  const genres: string[] = []
  let rest = p
  for (const g of GENRE_WORDS) {
    // whole words only ("popular" is not "pop", "housed" is not "house")
    const at = rest.indexOf(g)
    const wordOk = at >= 0 && !/[a-z]/.test(rest[at - 1] ?? ' ') && !/[a-z]/.test(rest[at + g.length] ?? ' ')
    if (wordOk) {
      genres.push(g === 'drum & bass' || g === 'dnb' ? 'drum and bass' : g)
      rest = rest.split(g).join(' ')
    }
  }
  if (genres.length) explicit.push('genres')
  const num = (re: RegExp) => {
    const m = re.exec(p)
    return m ? Number(m[1]) : null
  }
  const minutes = num(/(\d{1,3})\s*-?\s*(?:min|minute)/) ?? (num(/(\d(?:\.\d)?)\s*-?\s*hours?/) != null ? num(/(\d(?:\.\d)?)\s*-?\s*hours?/)! * 60 : null)
  const count = num(/(\d{1,2})\s+(?:popular\s+|big\s+|great\s+)?(?:tracks|songs|records)/)
  if (minutes != null) explicit.push('target_duration_minutes')
  if (count != null) explicit.push('song_count')
  const bpm = /(\d{2,3})\s*(?:-|to|–)\s*(\d{2,3})\s*bpm/.exec(p)
  if (bpm) explicit.push('bpm_range')
  let energy: EnergyCurve | null = null
  if (/festival/.test(p) && /(clos|finish|end)/.test(p)) energy = 'festival_climax'
  if (/(start|open)\w*\s+(groovy|chill|slow)/.test(p) && /(increase|build|harder|ramp)/.test(p)) energy = 'groovy_then_harder'
  else if (/gradual(ly)?\s+(energy\s+)?(build|increase)|build(s)?\s+up|gradual energy build/.test(p)) energy = energy ?? 'gradual_build'
  else if (/multiple peaks|several peaks|waves/.test(p)) energy = 'multiple_peaks'
  else if (/(high|peak)[- ]energy (all|throughout|the whole)/.test(p) || /\b(high|peak)[- ]energy\b/.test(p)) energy = 'constant_high'
  else if (/(wind|cool)\s*down|relaxed ending|chill ending/.test(p)) energy = 'high_then_relaxed'
  if (energy) explicit.push('energy_curve')
  let transition: TransitionStylePref | null = null
  if (/creative/.test(p) && /smooth/.test(p)) transition = 'smooth_creative'
  else if (/smooth/.test(p)) transition = 'smooth'
  else if (/creative|effects|\bfx\b|like (an? |actual |real )?dj|turntabl/.test(p)) transition = 'creative'
  if (transition) explicit.push('transition_style')
  const features: MixSpec['features'] = []
  if (/drops?/.test(p)) features.push('big_drops')
  if (/beat ?drops?|the drops?\b|middle of (the )?(songs?|tracks?)|drop[- ]to[- ]drop|only the drops?/.test(p)) features.push('drop_sections')
  if (/festival[- ]style (closing|closer|finish|ending)|festival closer|closing track/.test(p)) features.push('festival_closer')
  if (/basslines?|bass-heavy|heavy bass/.test(p)) features.push('strong_basslines')
  if (/breakdowns?/.test(p)) features.push('breakdowns')
  if (/scratch/.test(p)) features.push('scratching')
  if (features.length) explicit.push('features')
  let popularity: MixSpec['popularity'] = null
  if (/popular|hits|familiar|well[- ]known|mainstream/.test(p)) popularity = 'high'
  else if (/underground|deep cuts|obscure|lesser[- ]known/.test(p)) popularity = 'underground'
  if (popularity) explicit.push('popularity')
  let vocals: MixSpec['vocals'] = null
  if (/instrumental|no vocals|fewer vocals|less vocals/.test(p)) vocals = 'instrumental'
  else if (/vocal(s)? (heavy|tracks)|with vocals|sing-?along/.test(p)) vocals = 'vocal'
  if (vocals) explicit.push('vocals')
  // Specific songs: "Title by Artist" items in a list ("…songs of I Need You by TWOFACED, Closure by D.O.D, and …").
  const songs = parseSongList(prompt)
  if (songs.length) explicit.push('songs')
  const onlyThese = songs.length > 0 && /\b(specifically|only|exactly|just these|these songs|these tracks)\b/.test(p)
  // Artists: "I like A, B, C, and D" / "artists like A, B" / "by A" (not used when songs were parsed).
  const artists: string[] = [...new Set(songs.map((x) => x.artist).filter((x): x is string => !!x))]
  const am = songs.length ? null : /(?:i like|i love|artists? like|such as|in the style of|sounds? like|by)\s+([^.!?;]+)/i.exec(prompt)
  if (am) {
    for (const part of am[1].split(/,|\band\b|&/i)) {
      const name = part.replace(/\b(and\s+)?similar artists?\b|\bsimilar\b|\betc\.?|\bother\b/gi, '').trim()
      if (name && name.length <= 60 && /^[\p{L}\d .'$!-]+$/u.test(name) && /[A-Z\d]/.test(name[0])) artists.push(name)
    }
  }
  if (artists.length) explicit.push('artists')
  const similar = /similar artists|artists like|and similar|and others like/.test(p)
  const spec: MixSpec = MixSpec.parse({
    genres,
    artists,
    songs,
    artist_matching: onlyThese ? 'only_these' : artists.length ? (similar ? 'similar_artists_allowed' : null) : null,
    allow_song_substitutions: onlyThese ? false : null,
    intensity: energy === 'constant_high' ? 0.9 : null,
    popularity,
    song_count: count,
    target_duration_minutes: minutes,
    bpm_range: bpm ? [Math.min(+bpm[1], +bpm[2]), Math.max(+bpm[1], +bpm[2])] : null,
    energy_curve: energy,
    vocals,
    transition_style: transition,
    features,
    techniques: detectTechniques(prompt),
    explicit: [...explicit, ...(detectTechniques(prompt).prefer.length || detectTechniques(prompt).avoid.length ? ['techniques'] : []), ...(similar && artists.length ? ['artist_matching'] : []), ...(onlyThese ? ['artist_matching', 'allow_song_substitutions'] : [])],
    summary: `Basic interpretation (AI interpreter unavailable): ${prompt.slice(0, 300)}`,
  })
  return spec
}

const NOT_A_TITLE = /\b(inspired|influenced|produced|made|followed|led|curated|played|performed|created|mixed|composed|written|backed|accompanied)$/i
const LEAD_IN = /^.*?\b(?:songs?|tracks?|records?|mixing|mix of|mix|including|featuring|like|with|of|are|is)\s*[:\-–]?\s+/i

/** "Title by Artist" items from a list in the prompt (deterministic, conservative). */
export function parseSongList(prompt: string): Array<{ artist: string | null; title: string; version: string | null }> {
  const out: Array<{ artist: string | null; title: string; version: string | null }> = []
  for (const raw of prompt.split(/,|;|\band then\b|\s+and\s+(?=[^,]*\bby\b)|\n/i)) {
    const m = /^(.*\S)\s+by\s+(\S.*)$/i.exec(raw.trim())
    if (!m) continue
    let title = m[1].trim()
    // drop a lead-in like "specifically mixing the beatdrops/middle of the songs of": cut through the
    // LAST lead-in word (songs/tracks/records/mixing/including/featuring) and a following "of/like/:".
    const lead = /\b(?:songs?|tracks?|records?|mixing|including|featuring)\b(?:\s+(?:of|like|by|from))?\s*:?\s*/gi
    let cut = -1
    for (let mm = lead.exec(title); mm; mm = lead.exec(title)) cut = mm.index + mm[0].length
    if (cut > 0 && cut < title.length) title = title.slice(cut)
    else if (title.split(/\s+/).length > 6) title = title.replace(LEAD_IN, '')
    title = title.replace(/^(and|the song|song|track)\s+/i, '').replace(/^["“'‘]|["”'’]$/g, '').trim()
    let artist = m[2].trim().replace(/^["“'‘]|["”'’]$/g, '')
    if (!/(\b\w\.){2,}$/.test(artist)) artist = artist.replace(/[.?;:]+$/, '')
    artist = artist.trim()
    if (!title || !artist || NOT_A_TITLE.test(title)) continue
    if (title.split(/\s+/).length > 8 || title.length > 80 || artist.split(/\s+/).length > 5 || artist.length > 50) continue
    const v = /\(([^)]*\b(remix|mix|edit|version|vip|bootleg)\b[^)]*)\)/i.exec(title)
    out.push({ artist, title: v ? title.replace(v[0], '').trim() : title, version: v ? v[1].trim() : null })
  }
  return out.slice(0, 30)
}
