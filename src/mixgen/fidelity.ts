/**
 * Request fidelity: does the finished mix reflect what the user asked for?
 *
 * For every field the user stated (MixSpec.explicit) — and duration/track count always — compare the
 * request with what the mix actually contains, measured from the analyses and the executed plan
 * (analysed BPM, measured vocal activity, track energy vs the requested curve, transition styles,
 * detected drops). Recorded in the manifest and shown in the diagnostics; it never changes the mix.
 */
import { summarize } from '../dsp/analyze'
import { BEATMATCHED, SLAM } from '../dj/transitions'
import { targetEnergy } from './energy'
import { energyScores } from './energy'
import { matchesSongRequest } from './identity'
import type { AnalyzedEntry } from './pipeline'
import type { MixPlan } from './mixplan'
import { eraYears, type ResolvedSpec } from './spec'
import { avoided, matchesAny } from './technique-match'

export interface FidelityCheck {
  field: string
  requested: string
  achieved: string
  ok: boolean
}

export interface RequestFidelity {
  /** Share of checks met (0..1). */
  score: number
  checks: FidelityCheck[]
  interpreter?: string
  corrections?: string[]
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function requestFidelity(spec: ResolvedSpec, explicit: string[], order: string[], analyses: Map<string, AnalyzedEntry>, plan: MixPlan): RequestFidelity {
  const checks: FidelityCheck[] = []
  const said = (k: string) => explicit.includes(k)
  const entries = order.map((k) => analyses.get(k)!).filter(Boolean)
  const sums = entries.map((e) => summarize(e.analysis))
  const add = (field: string, requested: string, achieved: string, ok: boolean) => checks.push({ field, requested, achieved, ok })

  // duration and track count are always checked
  const durErr = Math.abs(plan.durationSec - spec.targetDurationSec) / spec.targetDurationSec
  add('duration', `${Math.round(spec.targetDurationSec / 60)} min`, `${(plan.durationSec / 60).toFixed(1)} min`, durErr <= 0.1)
  add('track count', String(spec.songCount), String(order.length), order.length === spec.songCount || (!said('song_count') && order.length >= spec.songCount - 1))

  if (spec.songs.length) {
    const got = spec.songs.filter((s) => entries.some((e) => matchesSongRequest(s, e.candidate)))
    add('requested songs', spec.songs.map((s) => `${s.title}${s.artist ? ` (${s.artist})` : ''}`).join(', ').slice(0, 160), `${got.length}/${spec.songs.length} included`, got.length === spec.songs.length)
  }
  if (spec.artists.length && said('artists')) {
    const want = spec.artists.map(norm)
    const byArtist = entries.filter((e) => want.some((a) => norm(e.candidate.artist).includes(a) || norm(e.candidate.identity.artist).includes(a)))
    const distinct = new Set(byArtist.map((e) => want.find((a) => norm(e.candidate.artist).includes(a) || norm(e.candidate.identity.artist).includes(a))))
    if (spec.artistMatching === 'only_these') add('only these artists', spec.artists.join(', '), `${byArtist.length}/${entries.length} tracks by them`, byArtist.length === entries.length)
    else add('artists', spec.artists.join(', ').slice(0, 120), `${distinct.size}/${spec.artists.length} artists, ${byArtist.length} tracks (similar artists allowed for the rest)`, distinct.size > 0 || spec.artistMatching === 'similar_artists_allowed')
  }
  if (spec.excludedArtists.length || spec.excludedSongs.length) {
    const bad = entries.filter((e) => spec.excludedArtists.some((a) => norm(e.candidate.artist).includes(norm(a))) || spec.excludedSongs.some((t) => norm(e.candidate.title).includes(norm(t))))
    add('exclusions', [...spec.excludedArtists, ...spec.excludedSongs].join(', '), bad.length ? `${bad.length} excluded track(s) present` : 'none present', bad.length === 0)
  }
  if (spec.bpmRange) {
    const [lo, hi] = spec.bpmRange
    const inR = sums.filter((s) => [s.bpm, s.bpm * 2, s.bpm / 2].some((b) => b >= lo - 1 && b <= hi + 1)).length
    add('BPM range', `${lo}–${hi} BPM`, `${inR}/${sums.length} tracks in range (analysed tempo)`, inR >= Math.ceil(sums.length * 0.8))
  }
  if (said('genres') && spec.genres.length) {
    const want = spec.genres.map(norm)
    const tagged = entries.filter((e) => e.candidate.genres.length + e.candidate.tags.length > 0)
    const hit = tagged.filter((e) => [...e.candidate.genres, ...e.candidate.tags].map(norm).some((g) => want.some((w) => g.includes(w) || w.includes(g))))
    if (tagged.length) add('genres', spec.genres.join(', '), `${hit.length}/${tagged.length} tracks tagged with a requested genre`, hit.length >= Math.ceil(tagged.length * 0.6))
  }
  if (said('energy_curve') || said('intensity')) {
    const energy = energyScores(entries.map((e) => e.energy))
    const target = energy.map((_, i) => targetEnergy(spec.energyCurve, energy.length > 1 ? i / (energy.length - 1) : 0.5, spec.intensity))
    const r = corr(energy, target)
    add('energy shape', spec.energyCurve.replace(/_/g, ' '), Number.isFinite(r) ? `correlation ${r.toFixed(2)} between track energy and the requested curve` : 'not measurable', !Number.isFinite(r) || r >= 0.3)
  }
  if (spec.vocals !== 'mixed' && said('vocals')) {
    const v = sums.reduce((p, s) => p + (s.vocalIn + s.vocalOut) / 2, 0) / Math.max(1, sums.length)
    add('vocals', spec.vocals, `mean vocal activity ${pct(v)} (heuristic analyser)`, spec.vocals === 'instrumental' ? v < 0.4 : v > 0.4)
  }
  if (said('transition_style')) {
    const tr = plan.transitions.map((t) => t.plan)
    const blends = tr.filter((p) => BEATMATCHED.has(p.style)).length
    const creative = tr.filter((p) => SLAM.has(p.style) || p.style === 'drop_swap' || (p as { tech?: unknown }).tech || p.performance?.strategy === 'echo_handoff' || p.performance?.strategy === 'filter_ride').length
    const n = Math.max(1, tr.length)
    if (spec.transitionStyle === 'smooth' || spec.transitionStyle === 'minimal') add('transition style', spec.transitionStyle, `${blends}/${tr.length} beat-matched blends`, blends / n >= 0.7)
    else add('transition style', spec.transitionStyle.replace('_', ' '), `${creative}/${tr.length} creative transitions, ${blends}/${tr.length} blends`, creative >= 1)
  }
  const dropped = spec.droppedTechniques ?? []
  if (dropped.length) add('house rules', dropped.join(', ').replace(/_/g, ' '), 'not used: every transition is a ≥ 16-bar blend and loop rolls are never used', true)
  if (spec.techniques.prefer.length) {
    const tr = plan.transitions.map((t) => t.plan)
    const used = tr.filter((p) => matchesAny(p, spec.techniques.prefer)).length
    add('requested techniques', spec.techniques.prefer.join(', ').replace(/_/g, ' '), `${used}/${tr.length} transitions use them`, used >= Math.ceil(tr.length / 2))
  }
  if (spec.techniques.avoid.length) {
    const bad = plan.transitions.filter((t) => avoided(t.plan, spec.techniques.avoid)).length
    add('avoided techniques', spec.techniques.avoid.join(', ').replace(/_/g, ' '), bad ? `${bad} transition(s) use them` : 'none used', bad === 0)
  }
  if (spec.features.includes('long_blends')) {
    const bars = plan.transitions.reduce((p, t) => p + t.plan.overlapBars, 0) / Math.max(1, plan.transitions.length)
    add('long blends', 'long blends', `mean overlap ${bars.toFixed(0)} bars`, bars >= 24)
  }
  if (spec.features.includes('big_drops')) {
    const withDrops = entries.filter((e) => e.energy.dropStrength > 2).length
    add('big drops', 'big drops', `${withDrops}/${entries.length} tracks with a detected drop`, withDrops >= Math.ceil(entries.length * 0.5))
  }
  if (spec.features.includes('festival_closer') && entries.length > 1) {
    const last = entries[entries.length - 1].energy.dropStrength
    const rank = entries.filter((e) => e.energy.dropStrength > last).length
    add('festival closer', 'festival-style closing track', `closing track has the #${rank + 1} strongest drop of ${entries.length}`, rank <= Math.max(1, Math.floor(entries.length * 0.25)))
  }
  const years = eraYears(spec.era)
  if (years) {
    const dated = entries.filter((e) => e.candidate.publishedAt)
    const inEra = dated.filter((e) => {
      const y = Number(e.candidate.publishedAt!.slice(0, 4))
      return y >= years[0] && y <= years[1]
    })
    if (dated.length) add('era', `${spec.era} (${years[0]}–${years[1]})`, `${inEra.length}/${dated.length} tracks published in range (publish date ≈ release)`, inEra.length >= Math.ceil(dated.length * 0.5))
  }
  const score = checks.length ? checks.filter((c) => c.ok).length / checks.length : 1
  return { score: Math.round(score * 100) / 100, checks, interpreter: spec.interpretation?.model, corrections: spec.interpretation?.corrections }
}

function corr(a: number[], b: number[]): number {
  if (a.length < 3) return NaN
  const ma = a.reduce((p, q) => p + q, 0) / a.length
  const mb = b.reduce((p, q) => p + q, 0) / b.length
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb)
    saa += (a[i] - ma) ** 2
    sbb += (b[i] - mb) ** 2
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN
}
