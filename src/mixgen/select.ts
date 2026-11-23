/**
 * Track selection and ordering.
 *
 * 1. `preselect` (metadata only, before any audio is acquired): scores the candidate
 *    pool against the spec and picks the tracks to acquire — the requested size plus
 *    spares, so failed acquisitions or unmixable analyses can be replaced.
 * 2. `orderSet` (after analysis): beam search over subsets AND orders, jointly scoring
 *    preference, tempo/harmonic compatibility, the target energy arc, variety and
 *    the requested closing features. Not a BPM sort.
 */
import { camelotDistance } from '../dsp/key'
import { normalize, similarity } from '../providers/catalog/match'
import { tempoMatch } from '../dj/transitions'
import { artistMatches, matchesSongRequest } from './identity'
import { targetEnergy } from './energy'
import type { ResolvedSpec } from './spec'
import type { TrackCandidate, Unavailability } from './types'

export interface ScoredCandidate {
  candidate: TrackCandidate
  score: number
  reasons: string[]
  requestedSong: boolean
  requestedArtist: boolean
}

/** Source-specific popularity percentile (views are only compared with views, etc.). */
function popularityPercentiles(pool: TrackCandidate[]): Map<string, number> {
  const out = new Map<string, number>()
  const bySource = new Map<string, TrackCandidate[]>()
  for (const c of pool) bySource.set(c.popularity.kind, [...(bySource.get(c.popularity.kind) ?? []), c])
  for (const [kind, list] of bySource) {
    if (kind === 'none') {
      list.forEach((c) => out.set(c.trackKey, 0.5))
      continue
    }
    const sorted = [...list].sort((a, b) => a.popularity.value - b.popularity.value)
    sorted.forEach((c, i) => out.set(c.trackKey, sorted.length > 1 ? i / (sorted.length - 1) : 0.5))
  }
  return out
}

function genreOverlap(spec: ResolvedSpec, c: TrackCandidate): number {
  const tags = [...c.genres, ...c.tags].map((t) => normalize(t).replace(/\s+/g, ''))
  let hits = 0
  for (const g of spec.genres) {
    const gn = normalize(g).replace(/\s+/g, '')
    if (tags.some((t) => t === gn || t.includes(gn) || (gn.includes(t) && t.length >= 4))) hits++
  }
  return spec.genres.length ? hits / spec.genres.length : 0
}

/** Continuous DJ mixes / mixtapes / long-form uploads are not single recordings to mix. */
export function isContinuousMix(c: TrackCandidate): boolean {
  if ((c.durationSec ?? 0) >= 540) return true
  return /(dj[ -]?mix|mixtape|mix ?tape|megamix|continuous mix|live set|dj set|podcast|radio show|episode|full album|mixed by)|^mix/i.test(c.title)
}

export function isExcluded(spec: ResolvedSpec, c: TrackCandidate): boolean {
  if (spec.excludedArtists.some((a) => artistMatches(a, c))) return true
  return spec.excludedSongs.some((s) => similarity(normalize(s), c.identity.title) >= 0.75 || similarity(normalize(s), normalize(`${c.artist} ${c.title}`)) >= 0.75)
}

export function scoreCandidate(spec: ResolvedSpec, c: TrackCandidate, pop: number): ScoredCandidate {
  const reasons: string[] = []
  let score = 0
  const requestedSong = spec.songs.some((s) => matchesSongRequest(s, c))
  const requestedArtist = spec.artists.some((a) => artistMatches(a, c))
  if (requestedSong) {
    score += 6
    reasons.push('requested song')
  }
  if (requestedArtist) {
    score += 3
    reasons.push('requested artist')
  } else if (spec.artistMatching === 'only_these' && spec.artists.length) {
    score -= 8
  } else if (c.matchedBy.some((m) => m.startsWith('similar:'))) {
    score += 1
    reasons.push('similar artist')
  }
  const g = genreOverlap(spec, c)
  if (g > 0) {
    score += 2 * g
    reasons.push(`genre match ${(g * 100).toFixed(0)}%`)
  }
  const popW = spec.popularity === 'high' ? 1.5 : spec.popularity === 'underground' ? -1.0 : 0.4
  score += popW * pop
  if (c.official) {
    score += 0.4
    reasons.push('official upload')
  }
  if (c.versionClues.some((v) => v.startsWith('variant:')) && !requestedSong) score -= 4
  if (spec.vocals !== 'mixed' && c.vocalTag) score += c.vocalTag === spec.vocals ? 0.8 : -0.8
  if (spec.bpmRange && c.providerBpm) {
    const [lo, hi] = spec.bpmRange
    const b = c.providerBpm
    const inRange = [b, b * 2, b / 2].some((x) => x >= lo - 1 && x <= hi + 1)
    score += inRange ? 0.6 : -2
  }
  const d = c.durationSec ?? 0
  if (d && (d < 100 || d > 720)) score -= 2
  return { candidate: c, score, reasons, requestedSong, requestedArtist }
}

export interface Preselection {
  toAcquire: ScoredCandidate[]
  ranked: ScoredCandidate[]
  unavailable: Unavailability[]
}

/**
 * Rank mixable candidates and choose which to acquire. `mixable(c)` is the policy check.
 * Requested artists/songs without any mixable recording are reported, never faked.
 */
export function preselect(spec: ResolvedSpec, pool: TrackCandidate[], mixable: (c: TrackCandidate) => boolean, spares = 0.5): Preselection {
  const pop = popularityPercentiles(pool)
  const all = pool.filter((c) => !isExcluded(spec, c) && (!isContinuousMix(c) || spec.songs.some((s) => matchesSongRequest(s, c)))).map((c) => scoreCandidate(spec, c, pop.get(c.trackKey) ?? 0.5))
  // Exact song list without substitutions: only the requested recordings are eligible.
  const exactSongs = !spec.allowSubstitutions && spec.songs.length > 0
  const ranked = all.filter((s) => mixable(s.candidate) && (!exactSongs || s.requestedSong)).sort((a, b) => b.score - a.score)
  const unavailable: Unavailability[] = []
  const searched = [...new Set(pool.map((c) => c.source))]
  for (const a of spec.artists) {
    if (!ranked.some((s) => artistMatches(a, s.candidate))) {
      const seenOnly = all.filter((s) => artistMatches(a, s.candidate))
      unavailable.push({
        request: a,
        kind: 'artist',
        searched,
        reason: seenOnly.length
          ? `Found ${seenOnly.length} recording(s) (${[...new Set(seenOnly.map((s) => s.candidate.source))].join(', ')}), but none has an authorized audio source for mixing.`
          : 'No recordings found in the searched catalogs.',
      })
    }
  }
  for (const s of spec.songs) {
    if (!ranked.some((r) => matchesSongRequest(s, r.candidate))) {
      const seen = all.find((r) => matchesSongRequest(s, r.candidate))
      unavailable.push({
        request: `${s.artist ? s.artist + ' – ' : ''}${s.title}${s.version ? ` (${s.version})` : ''}`,
        kind: 'song',
        searched,
        reason: seen ? `Found on ${seen.candidate.source}, but no authorized audio source permits mixing it.` : 'Recording not found in the searched catalogs.',
      })
    }
  }
  // Diversity: at most 2 tracks per artist unless the user asked for that artist.
  const perArtist = new Map<string, number>()
  const want = Math.ceil(spec.songCount * (1 + spares))
  const picked: ScoredCandidate[] = []
  for (const s of ranked) {
    if (picked.length >= want) break
    const a = s.candidate.identity.artist
    const cap = s.requestedArtist ? 4 : 2
    if ((perArtist.get(a) ?? 0) >= cap) continue
    if (picked.some((p) => p.candidate.identity.key === s.candidate.identity.key)) continue
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1)
    picked.push(s)
  }
  return { toAcquire: picked, ranked, unavailable }
}

// ───────────────────────── ordering (after analysis) ─────────────────────────

export interface OrderTrack {
  key: string
  pref: number
  bpm: number
  bpmConf: number
  camelot: string
  keyConf: number
  energy: number // pool-relative 0..1
  dropStrength: number
  vocal: number // 0..1 heuristic
  artist: string
  durationSec: number
  /** Beat grid reliable enough for beat-matched blends. */
  gridOk: boolean
  pinnedIndex?: number
}

export interface OrderOptions {
  count: number
  beamWidth?: number
  maxTempoDeviation?: number
  /** Keep this exact order (no reordering requested). */
  fixedOrder?: string[]
  /** Extra learned pair cost (e.g. MixGraph predicted transition severity), added to the rule pair cost. */
  pairExtra?: (a: OrderTrack, b: OrderTrack) => number
}

export interface OrderResult {
  order: string[]
  cost: number
  parts: { tempo: number; key: number; energy: number; pref: number; variety: number; learned: number }
  explored: number
}

export function pairCost(a: OrderTrack, b: OrderTrack, maxDev: number): { tempo: number; key: number } {
  const { ratio } = tempoMatch(a.bpm, b.bpm)
  const dev = Math.abs(ratio - 1)
  // Beyond the ±6 % stretch limit the pair can still be joined (echo-out / cut), but it costs.
  const tempo = dev <= maxDev ? dev * 25 : 2.5 + (dev - maxDev) * 30
  const kd = a.keyConf >= 0.1 && b.keyConf >= 0.1 ? camelotDistance(a.camelot, b.camelot) : 2
  const key = Math.max(0, kd - 1) * 0.45
  // Unreliable grids force un-matched transitions (fades/cuts): costly for smooth sets.
  const grid = a.gridOk && b.gridOk ? 0 : 1.2
  return { tempo: tempo + grid, key }
}

/**
 * Beam search over (subset, order). Cost = Σ pair costs + energy-arc error + variety
 * − preference. The closing slot rewards strong drops when a festival closer is requested.
 */
export function orderSet(tracks: OrderTrack[], spec: ResolvedSpec, opts: OrderOptions): OrderResult {
  const maxDev = opts.maxTempoDeviation ?? 0.06
  const n = Math.min(opts.count, tracks.length)
  const W = opts.beamWidth ?? 96
  const byKey = new Map(tracks.map((t) => [t.key, t]))
  const closer = spec.features.includes('festival_closer')
  // Tempo coherence: distance (octave-folded) from the preference-weighted median tempo of the pool.
  const ranked = [...tracks].sort((a, b) => b.pref - a.pref).slice(0, Math.max(n, Math.ceil(tracks.length * 0.6)))
  const bpms = ranked.map((t) => t.bpm).filter((b) => b > 0).sort((a, b) => a - b)
  const center = bpms.length ? bpms[Math.floor(bpms.length / 2)] : 0
  const tempoOutlier = (t: OrderTrack) => {
    if (!center || !t.bpm) return 0
    const dev = Math.min(...[t.bpm, t.bpm * 2, t.bpm / 2].map((b) => Math.abs(b / center - 1)))
    return dev > 0.05 ? (dev - 0.05) * 25 : 0
  }
  const drops = spec.features.includes('big_drops')
  const stepEnergy = (t: OrderTrack, pos: number) => {
    const target = targetEnergy(spec.energyCurve, n > 1 ? pos / (n - 1) : 0.5, spec.intensity)
    let c = Math.abs(t.energy - target) * 3
    if (closer && pos === n - 1) c -= Math.min(1.5, t.dropStrength / 4) + t.energy
    if (drops && pos >= n * 0.4) c -= Math.min(0.6, t.dropStrength / 8)
    if (spec.vocals === 'instrumental') c += t.vocal * 0.8
    if (!t.gridOk) c += 1.5
    c += tempoOutlier(t)
    return c
  }
  if (opts.fixedOrder) {
    const order = opts.fixedOrder.filter((k) => byKey.has(k)).slice(0, n)
    return { order, ...scoreOrder(order.map((k) => byKey.get(k)!), maxDev, stepEnergy, opts.pairExtra), explored: 1 }
  }
  interface Node {
    seq: OrderTrack[]
    used: Set<string>
    cost: number
    artists: Map<string, number>
  }
  let beam: Node[] = [{ seq: [], used: new Set(), cost: 0, artists: new Map() }]
  let explored = 0
  for (let pos = 0; pos < n; pos++) {
    const next: Node[] = []
    for (const node of beam) {
      for (const t of tracks) {
        if (node.used.has(t.key)) continue
        if (t.pinnedIndex !== undefined && t.pinnedIndex !== pos) continue
        explored++
        let c = node.cost - t.pref + stepEnergy(t, pos)
        const prev = node.seq[node.seq.length - 1]
        if (prev) {
          const pc = pairCost(prev, t, maxDev)
          c += pc.tempo + pc.key + (opts.pairExtra?.(prev, t) ?? 0)
          if (prev.artist === t.artist) c += 1.2 // same artist back-to-back
        }
        c += (node.artists.get(t.artist) ?? 0) * 0.5
        const artists = new Map(node.artists)
        artists.set(t.artist, (artists.get(t.artist) ?? 0) + 1)
        next.push({ seq: [...node.seq, t], used: new Set([...node.used, t.key]), cost: c, artists })
      }
    }
    // Required pinned tracks must eventually appear: drop nodes that skipped a pin slot.
    next.sort((a, b) => a.cost - b.cost)
    const seen = new Set<string>()
    beam = []
    for (const nd of next) {
      // dedupe identical (set, last) states
      const sig = [...nd.used].sort().join(',') + '|' + nd.seq[nd.seq.length - 1].key
      if (seen.has(sig)) continue
      seen.add(sig)
      beam.push(nd)
      if (beam.length >= W) break
    }
    if (!beam.length) break
  }
  const best = beam[0]
  const order = best ? best.seq.map((t) => t.key) : []
  return { order, ...scoreOrder(best?.seq ?? [], maxDev, stepEnergy, opts.pairExtra), explored }
}

function scoreOrder(seq: OrderTrack[], maxDev: number, stepEnergy: (t: OrderTrack, pos: number) => number, pairExtra?: (a: OrderTrack, b: OrderTrack) => number) {
  const parts = { tempo: 0, key: 0, energy: 0, pref: 0, variety: 0, learned: 0 }
  seq.forEach((t, i) => {
    parts.energy += stepEnergy(t, i)
    parts.pref -= t.pref
    if (i > 0) {
      const pc = pairCost(seq[i - 1], t, maxDev)
      parts.tempo += pc.tempo
      parts.key += pc.key
      parts.learned += pairExtra?.(seq[i - 1], t) ?? 0
      if (seq[i - 1].artist === t.artist) parts.variety += 1.2
    }
  })
  return { cost: parts.tempo + parts.key + parts.energy + parts.pref + parts.variety + parts.learned, parts }
}
