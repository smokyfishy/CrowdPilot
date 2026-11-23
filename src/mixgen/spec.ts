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
  allow_reordering: z.boolean().nullable().default(null),
  allow_song_substitutions: z.boolean().nullable().default(null),
  /** Fields the user explicitly stated (names of the keys above). */
  explicit: z.array(z.string()).max(40).default([]),
  /** One-line human summary of the interpretation (shown on the review screen). */
  summary: z.string().trim().max(400).default(''),
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
  vocals: 'vocal' | 'instrumental' | 'mixed'
  transitionStyle: TransitionStylePref
  features: MixSpec['features']
  allowReordering: boolean
  allowSubstitutions: boolean
  /** Which values came from defaults (for honest display). */
  defaulted: string[]
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
    vocals: d('vocals', spec.vocals, DEFAULTS.vocals),
    // No stated style: high-energy / drop-focused requests get energetic transitions (effects, drop
    // swaps, loop rolls, tempo rides); everything else stays smooth.
    transitionStyle: d(
      'transition_style',
      spec.transition_style,
      spec.energy_curve === 'constant_high' || spec.energy_curve === 'festival_climax' || (spec.intensity ?? 0) >= 0.8 || spec.features.includes('drop_sections') ? 'energetic' : DEFAULTS.transitionStyle,
    ),
    features: spec.features,
    allowReordering: d('allow_reordering', spec.allow_reordering, true),
    allowSubstitutions: d('allow_song_substitutions', spec.allow_song_substitutions, true),
    defaulted,
  }
}

function defaultTitle(spec: MixSpec, genres: string[]): string {
  const g = genres.slice(0, 2).map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase())).join(' & ')
  const m = spec.target_duration_minutes ? `${Math.round(spec.target_duration_minutes)}-minute ` : ''
  return `${m}${g} mix`.trim()
}

/** System prompt for the LLM interpreter. The model must return JSON matching MixSpec. */
export const INTERPRET_SYSTEM = `You convert a DJ-mix request into a JSON object. Output ONLY JSON, no prose.
Schema (all keys required; use null or [] when the user did not say it — NEVER invent constraints):
{
 "title": string|null,                      // only if the user named the mix
 "genres": string[],                        // genres/subgenres mentioned, lower case
 "artists": string[],                       // artists the user likes/requests
 "artist_matching": "only_these"|"similar_artists_allowed"|"any"|null,
 "songs": [{"artist": string|null, "title": string, "version": string|null}],  // specific songs requested
 "excluded_artists": string[], "excluded_songs": string[],
 "popularity": "high"|"mixed"|"underground"|null,   // "popular/hits/familiar" → high; "underground/deep cuts" → underground
 "song_count": integer|null, "target_duration_minutes": number|null,
 "bpm_range": [min,max]|null,               // only if BPM stated
 "energy_curve": "constant_high"|"gradual_build"|"gradual_build_to_peak"|"multiple_peaks"|"chill_to_energetic"|"festival_climax"|"groovy_then_harder"|"high_then_relaxed"|"steady"|null,
 "intensity": number 0..1|null,
 "moods": string[], "era": string|null,
 "vocals": "vocal"|"instrumental"|"mixed"|null,
 "transition_style": "smooth"|"smooth_creative"|"creative"|"energetic"|"minimal"|null,
 "features": ("big_drops"|"festival_closer"|"strong_basslines"|"breakdowns"|"long_blends"|"scratching"|"filter_fx"|"echo_fx")[],
 "allow_reordering": boolean|null, "allow_song_substitutions": boolean|null,
 "explicit": string[],                      // names of the keys above that the user explicitly stated
 "summary": string                          // one sentence restating the request
}
"similar artists" / "and artists like them" → artist_matching "similar_artists_allowed".
"start groovy, gradually increase the energy" → "groovy_then_harder" or "gradual_build_to_peak" (pick the closest).
"finish with a festival-style closing track" → features includes "festival_closer".`

export const REFINE_SYSTEM = `You update an existing DJ-mix JSON specification according to the user's edit request.
Return the COMPLETE updated JSON object using the same schema as the input, changing only what the edit implies
(e.g. "make it more energetic" → raise intensity and/or set energy_curve; "30 minutes instead" → target_duration_minutes 30;
"reduce vocals" → vocals "instrumental"; "smoother transitions" → transition_style "smooth"). Add changed keys to "explicit".
If the edit refers to a specific track position (e.g. "replace the third song"), keep the spec and put the instruction into
"edit_ops" as {"op":"replace","position":3}. Output ONLY JSON: {"spec": <spec>, "edit_ops": [...]}`

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
    if (rest.includes(g)) {
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
    explicit: [...explicit, ...(similar && artists.length ? ['artist_matching'] : []), ...(onlyThese ? ['artist_matching', 'allow_song_substitutions'] : [])],
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
