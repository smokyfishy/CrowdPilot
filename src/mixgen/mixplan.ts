/**
 * Whole-set transition planning and timeline.
 *
 * For each adjacent pair the MixGraph transition layer (src/dj/transitions.ts) enumerates
 * region-level candidates (cue pairs × techniques × overlap lengths) with explicit costs.
 * This module adds the set-level decisions the live engine never needed:
 *  - technique preference from the requested style and features (smooth / creative /
 *    big drops / festival closer / scratching), with variety across the set;
 *  - duration fitting: a dynamic program over each pair's top candidates chooses cue
 *    points so the finished mix lands near the requested length (musically: phrase-aligned
 *    edits only — tracks are shortened by leaving earlier at a phrase boundary or entering
 *    later at a phrase boundary, never by cutting mid-phrase);
 *  - an exact mix timeline (track entry/exit in each track's own time and in mix time,
 *    including the tempo-recovery ramp after beat-matched blends).
 */
import type { AnalysisSummary } from '../dsp/analyze'
import { BEATMATCHED, candidateTransitions, DEFAULT_OPTIONS, SLAM, tempoMatch, type PlannerOptions, type PlanTrack, type TransitionPlan, type TransitionStyle } from '../dj/transitions'
import { energyDirection } from './energy'
import { refineWithLocalBeats } from '../dj/phase'
import { beatmatchable } from '../dj/transitions'
import { genrePreference, techniqueCandidates, type StemInfo, type TechniquePlan } from './techniques'
import type { ResolvedSpec } from './spec'

export interface PlannedTrack {
  key: string
  title: string
  summary: AnalysisSummary
  /** Loudness trim (dB) to the set's target level. */
  trimDb: number
  /** Beat This! beat times (s) — used to refine cue points and tempo ratio locally. */
  netBeats?: number[]
}

export interface TimelineTrack {
  key: string
  /** Track-time (s) where this track's audio first enters the mix. */
  entrySec: number
  /** Track-time (s) where it has fully left the mix. */
  exitSec: number
  /** Mix-time (s) where it first becomes audible and where it is gone. */
  mixInSec: number
  mixOutSec: number
  /** Mix-time (s) when it is the main track (after the incoming overlap). */
  mixMainSec: number
  trimDb: number
}

export interface TimelineTransition {
  index: number
  plan: TransitionPlan
  mixStartSec: number
  mixEndSec: number
  /** Incoming track-time when the overlap ends, and after tempo recovery. */
  inEndSec: number
  recoverySec: number
  recoveryTrackSec: number
}

export interface MixPlan {
  tracks: TimelineTrack[]
  transitions: TimelineTransition[]
  durationSec: number
  targetDurationSec: number
  totalCost: number
  notes: string[]
  /** Per-pair candidate lists as seen by the duration DP (after any learned ranking). */
  candidates: TransitionPlan[][]
}

const MIN_SOLO_BARS = 8

function abruptHandoff(plan: TransitionPlan): boolean {
  return plan.style === 'cut' || SLAM.has(plan.style)
}

function stylePreference(style: TransitionStyle, spec: ResolvedSpec, pos: number, n: number): number {
  const creative = new Set<TransitionStyle>(['filter_sweep', 'drop_swap', 'echo_out', 'loop_roll'])
  const blends = new Set<TransitionStyle>(['long_blend', 'bass_swap', 'percussion_led', 'short_fade'])
  let c = 0
  switch (spec.transitionStyle) {
    case 'smooth':
      // Smooth = long, layered blends; a 4-bar fade is acceptable but not preferred.
      if (style === 'long_blend') c -= 1.0
      else if (style === 'bass_swap' || style === 'percussion_led') c -= 0.7
      else if (style === 'short_fade') c -= 0.1
      if (style === 'brake' || style === 'loop_roll' || style === 'scratch_cut') c += 4
      if (style === 'echo_out') c += 0.6 // the smoothest option when tempos can't be matched
      if (style === 'cut') c += 2
      break
    case 'minimal':
      if (style === 'long_blend' || style === 'short_fade') c -= 0.8
      if (!blends.has(style)) c += 2
      break
    case 'smooth_creative':
      if (style === 'long_blend' || style === 'bass_swap' || style === 'percussion_led') c -= 0.5
      else if (style === 'short_fade') c -= 0.1
      if (creative.has(style)) c -= 0.35
      if (style === 'brake' || style === 'scratch_cut') c += 1.2
      if (style === 'loop_roll') c += 0.6 // a creative accent, not the default join in a smooth set
      break
    case 'creative':
      if (creative.has(style)) c -= 0.9
      if (style === 'brake') c -= 0.2
      break
    case 'energetic':
      if (style === 'drop_swap' || style === 'loop_roll' || style === 'short_fade') c -= 0.8
      if (style === 'long_blend') c += 0.6
      break
  }
  const f = spec.features
  if (f.includes('big_drops') && style === 'drop_swap') c -= 0.7
  // Drop-focused sets ("mix the drops / middle of the songs"): build into each next drop.
  if (f.includes('drop_sections')) {
    if (style === 'drop_swap') c -= 2.0
    else if (style === 'loop_roll' || style === 'short_fade' || style === 'bass_swap') c -= 0.4
    else if (style === 'long_blend' || style === 'percussion_led') c += 0.6
  }
  if (f.includes('festival_closer') && pos === n - 2 && style === 'drop_swap') c -= 1.2
  if (f.includes('long_blends') && style === 'long_blend') c -= 0.6
  if (f.includes('filter_fx') && style === 'filter_sweep') c -= 0.7
  if (f.includes('echo_fx') && style === 'echo_out') c -= 0.7
  if (style === 'scratch_cut' && !f.includes('scratching')) c += 50 // only when asked for
  if (f.includes('scratching') && style === 'scratch_cut') c -= 0.8
  return c
}

/** Mean phrase energy (dB) of the phrases overlapping [t0, t1) of a track. */
function energyBetween(s: AnalysisSummary, t0: number, t1: number): number | null {
  if (!s.phraseEnergy?.length) return null
  const vals: number[] = []
  for (let k = 0; k < s.phrasesSec.length; k++) {
    const a = s.phrasesSec[k]
    const b = s.phrasesSec[k + 1] ?? s.durationSec
    if (b > t0 && a < t1 && s.phraseEnergy[k] !== undefined) vals.push(s.phraseEnergy[k])
  }
  return vals.length ? vals.reduce((p, q) => p + q, 0) / vals.length : null
}

/**
 * Energy continuity: the incoming track should be in a full section right after the
 * outgoing is gone (not a breakdown, stop or quiet intro), and the outgoing should not
 * start leaving from inside its own breakdown. Penalty in planner cost units.
 */
function energyContinuity(p: TransitionPlan, outgoing: PlannedTrack, incoming: PlannedTrack): number {
  const a = outgoing.summary
  const b = incoming.summary
  let c = 0
  const inEnd = p.inCueSec + inTrackSpan(p)
  // (1) the incoming must carry the floor right after the outgoing is gone
  const after = energyBetween(b, inEnd, inEnd + 16 * b.barSec)
  if (after !== null && after < b.energyMean - 6) c += Math.min(5, (b.energyMean - 6 - after) * 0.6)
  // Compare the sections listeners actually hear before and after the blend, with
  // the same per-track trims the renderer uses. Weight cue-level matching separately
  // from each song's own energy contour so a locally quiet section remains detectable.
  const beforeJoin = energyBetween(a, Math.max(0, p.outCueSec - 30), p.outCueSec - 2)
  const afterJoin = energyBetween(b, inEnd + 2, inEnd + 30)
  if (beforeJoin !== null && afterJoin !== null) {
    const mismatch = Math.abs(beforeJoin + outgoing.trimDb - afterJoin - incoming.trimDb)
    c += Math.min(5, Math.max(0, mismatch - 3) * 0.6)
  }
  // (2) …and already during the second half of the overlap, while the outgoing fades out
  //     (a drop swap deliberately lands its drop at the overlap end, so it is exempt)
  if (p.style !== 'drop_swap' && p.durationSec > 0) {
    const late = energyBetween(b, p.inCueSec + inTrackSpan(p) / 2, inEnd)
    if (late !== null && late < b.energyMean - 8) c += Math.min(4, (b.energyMean - 8 - late) * 0.5)
  }
  // (3) the outgoing should not start leaving from inside its own breakdown
  const outAt = energyBetween(a, p.outCueSec, p.outCueSec + Math.max(4 * a.barSec, p.durationSec / 2))
  if (outAt !== null && outAt < a.energyMean - 8) c += Math.min(2, (a.energyMean - 8 - outAt) * 0.25)
  return c
}

/** Max tempo change for short transitions in energetic/creative sets (pitch-preserving WSOLA). */
export const RIDE_LIMIT = 0.1

/**
 * If a track's global grid was rejected (tempo confidence < 0.3 or unstable) but its Beat This! beats
 * are regular in the region a transition uses, return a summary with the LOCAL tempo and a usable
 * confidence, so the pair can be beat-matched there. Otherwise the summary is returned unchanged.
 */
export function localGrid(s: AnalysisSummary, beats: number[] | undefined, role: 'in' | 'out'): AnalysisSummary {
  if ((s.bpmConf >= 0.3 && s.stable) || !beats || beats.length < 64) return s
  const lo = role === 'out' ? s.durationSec * 0.6 : 0
  const hi = role === 'out' ? s.durationSec : s.durationSec * 0.4
  const seg = beats.filter((t) => t >= lo && t <= hi)
  if (seg.length < 32) return s
  const ibi = seg.slice(1).map((t, k) => t - seg[k]).sort((x, y) => x - y)
  const med = ibi[Math.floor(ibi.length / 2)]
  const mean = ibi.reduce((p, q) => p + q, 0) / ibi.length
  const cv = Math.sqrt(ibi.reduce((p, q) => p + (q - mean) ** 2, 0) / ibi.length) / mean
  const bpm = 60 / med
  if (!(cv < 0.06) || bpm < 70 || bpm > 200) return s
  return { ...s, bpm: Math.round(bpm * 100) / 100, bpmConf: 0.35, stable: true, firstBeat: seg[0], flags: [...s.flags, `local grid (${role}) from Beat This! beats, IBI CV ${(cv * 100).toFixed(1)}%`] }
}

/** Summary copy with earlier phrase boundaries offered as mix-out cues (for shortening). */
function withEarlyOuts(s: AnalysisSummary): AnalysisSummary {
  const early = s.phrasesSec.filter((t) => t >= s.durationSec * 0.3 && t < s.durationSec * 0.55)
  return { ...s, cueOut: [...early, ...s.cueOut] }
}
/** Summary copy offering only LATE phrase boundaries as mix-out cues (for lengthening). */
function withLateOuts(s: AnalysisSummary): AnalysisSummary {
  const late = s.phrasesSec.filter((t) => t >= s.durationSec * 0.7)
  return late.length ? { ...s, cueOut: late, phrasesSec: s.phrasesSec.filter((t) => t < s.durationSec * 0.55 || t >= s.durationSec * 0.7) } : s
}
/** Summary copy with later phrase boundaries offered as mix-in cues. */
function withLateIns(s: AnalysisSummary): AnalysisSummary {
  const late = s.phrasesSec.filter((t) => t > s.durationSec * 0.1 && t <= s.durationSec * 0.45)
  return { ...s, cueIn: [...s.cueIn, ...late] }
}

function inTrackSpan(p: TransitionPlan): number {
  return p.durationSec * (BEATMATCHED.has(p.style) ? p.tempoRatio : 1)
}
function recovery(p: TransitionPlan): { mix: number; track: number } {
  if (!BEATMATCHED.has(p.style) || p.tempoRecoveryBars <= 0 || Math.abs(p.tempoRatio - 1) < 1e-4) return { mix: 0, track: 0 }
  const mix = p.tempoRecoveryBars * 4 * p.beatSec
  return { mix, track: (mix * (p.tempoRatio + 1)) / 2 }
}

/** Track-time where the first audible content starts / ends. */
function musicStart(s: AnalysisSummary): number {
  return Math.max(0, (s.silentLeadSec ?? 0) - 0.02)
}
function musicEnd(s: AnalysisSummary): number {
  return s.durationSec - Math.max(0, (s.silentTailSec ?? 0) - 0.05)
}

export interface PlanMixOptions {
  /** Favor long drop-aligned blends on smooth briefs with learned automation. */
  preferLongDropBlends?: boolean
  candidatesPerPair?: number
  planner?: Partial<PlannerOptions>
  /** Tolerance (fraction of target) with no duration penalty. */
  durationTolerance?: number
  /**
   * Learned-model hook (src/ml): receives the pair's styled candidates (best first, `costs.total`
   * already includes style/energy terms) and returns them re-ranked and/or with learned automation
   * applied. The returned order and `costs.total` feed the duration DP. Must be pure and fast.
   */
  rankCandidates?: (cands: TransitionPlan[], a: AnalysisSummary, b: AnalysisSummary, pairIndex: number) => TransitionPlan[]
  /** Advanced techniques (src/mixgen/techniques.ts); stems enable layering/mashups when present. */
  techniques?: { enabled: boolean; stems?: Map<string, StemInfo> }
}

export function planMix(tracks: PlannedTrack[], spec: ResolvedSpec, opts: PlanMixOptions = {}): MixPlan {
  const n = tracks.length
  const K = opts.candidatesPerPair ?? 18
  const notes: string[] = []
  const preferLongDropBlends = opts.preferLongDropBlends
    && (spec.transitionStyle === 'smooth' || spec.transitionStyle === 'smooth_creative')
  const longDropBlend = (p: TransitionPlan) => p.style === 'long_blend' && p.incomingDropSec !== undefined
  if (n === 0) return { tracks: [], transitions: [], durationSec: 0, targetDurationSec: spec.targetDurationSec, totalCost: 0, notes: ['no tracks'], candidates: [] }
  const pt = (t: PlannedTrack, s = t.summary): PlanTrack => ({ itemId: t.key, trackKey: t.key, title: t.title, mixable: true, summary: s, durationSec: s.durationSec })

  // Candidate edges per pair (default cues ∪ shortened variants), styled and diversified.
  const options: TransitionPlan[][] = []
  const recent: TransitionStyle[] = []
  const recentTech: string[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = tracks[i]
    const b = tracks[i + 1]
    // Energetic/creative sets may ride the tempo further for SHORT transitions (as DJs ride the pitch
    // fader with key lock); long blends stay inside ±6 % (see the post-filter below).
    const ride = spec.transitionStyle === 'energetic' || spec.transitionStyle === 'creative' ? RIDE_LIMIT : DEFAULT_OPTIONS.maxTempoDeviation
    const popt: PlannerOptions = {
      ...DEFAULT_OPTIONS,
      maxTempoDeviation: ride,
      preferDropLandings: !!preferLongDropBlends || spec.features.includes('big_drops') || spec.features.includes('drop_sections'),
      ...opts.planner,
      recentStyles: [...recent],
      energyDirection: energyDirection(spec.energyCurve, i, n, spec.intensity),
    }
    // Tracks whose GLOBAL grid was rejected can still be beat-matched where Beat This! beats are
    // regular around the mix point (outgoing: its last 40 %, incoming: its first 40 %).
    const sa = localGrid(a.summary, a.netBeats, 'out')
    const sb = localGrid(b.summary, b.netBeats, 'in')
    const raw = [
      ...candidateTransitions(pt(a, sa), pt(b, sb), popt),
      ...candidateTransitions(pt(a, withEarlyOuts(sa)), pt(b, withLateIns(sb)), popt),
      ...candidateTransitions(pt(a, withLateOuts(sa)), pt(b, sb), popt),
    ].filter((p) => !BEATMATCHED.has(p.style) || Math.abs(p.tempoRatio - 1) <= DEFAULT_OPTIONS.maxTempoDeviation + 1e-9 || p.overlapBars <= 8)
    for (const p of raw) if (BEATMATCHED.has(p.style) && Math.abs(p.tempoRatio - 1) > DEFAULT_OPTIONS.maxTempoDeviation + 1e-9) p.risks = [...p.risks, `tempo ride ${((p.tempoRatio - 1) * 100).toFixed(1)}% over ${p.overlapBars} bars (key lock)`]
    // Local refinement with the tracks' Beat This! beats (cue snap + local tempo ratio), as the
    // learned models were trained on refined plans and it tightens beat alignment for everyone.
    for (let k = 0; k < raw.length; k++) {
      if (!BEATMATCHED.has(raw[k].style)) continue
      const r = refineWithLocalBeats(raw[k], a.netBeats, b.netBeats, ride)
      if (r.localRefined) {
        const { localRefined: _l, ...plan } = r
        raw[k] = plan
      }
    }
    if (opts.techniques?.enabled) {
      raw.push(
        ...techniqueCandidates(raw, { spec, a: sa, b: sb, stemsA: opts.techniques.stems?.get(a.key), stemsB: opts.techniques.stems?.get(b.key), gridA: beatmatchable(sa), gridB: beatmatchable(sb), maxTempo: ride }),
      )
    }
    const variety = (p: TransitionPlan) => {
      const t = (p as TechniquePlan).tech?.technique
      return t && recentTech[0] === t ? 0.8 : t && recentTech.slice(0, 3).includes(t) ? 0.3 : 0
    }
    // On a smooth creative brief, an abrupt handoff needs a musical payoff
    // when the grids support a blend at a similar tempo.
    const blendFeasibility = beatmatchable(sa) && beatmatchable(sb)
      ? Math.max(0, 1 - Math.abs(tempoMatch(sa.bpm, sb.bpm).ratio - 1) / 0.05)
      : 0
    const scored = raw.map((p) => {
      const abruptCost = spec.transitionStyle === 'smooth_creative' && abruptHandoff(p)
        ? (p.incomingDropSec === undefined ? 2 * blendFeasibility : 0.35)
        : 0
      return {
        p,
        c: p.costs.total + stylePreference(p.style, spec, i, n) + energyContinuity(p, a, b)
          + genrePreference(p.style, (p as TechniquePlan).tech?.technique, spec) + variety(p) + abruptCost
          - (preferLongDropBlends && longDropBlend(p) ? 2 : 0),
      }
    })
    scored.sort((x, y) => x.c - y.c)
    // Keep diverse candidates. Pass 1: the cheapest candidate for each distinct (out cue, in cue)
    // region, so the duration DP can choose earlier exits / later entries even when they cost a
    // little more. Pass 2: fill the remaining slots by cost (distinct style/cue/overlap).
    const keep: TransitionPlan[] = []
    const sig = new Set<string>()
    const push = (p: TransitionPlan, c: number) => {
      const k = `${p.style}|${(p as TechniquePlan).tech?.technique ?? ''}|${p.outCueSec.toFixed(1)}|${p.inCueSec.toFixed(1)}|${p.overlapBars}`
      if (sig.has(k)) return
      sig.add(k)
      keep.push({ ...p, ruleCost: p.costs.total, costs: { ...p.costs, total: c } } as TransitionPlan)
    }
    const region = new Set<string>()
    for (const { p, c } of scored) {
      const r = `${Math.round(p.outCueSec / (16 * a.summary.barSec))}|${Math.round(p.inCueSec / (16 * b.summary.barSec))}`
      if (region.has(r)) continue
      region.add(r)
      push(p, c)
      if (keep.length >= Math.ceil(K * 0.6)) break
    }
    if (preferLongDropBlends && keep.length < K && !keep.some(longDropBlend)) {
      const drop = scored.find(({ p }) => longDropBlend(p))
      if (drop) push(drop.p, drop.c)
    }
    // Keep a choice of continuity and creative accents for the set-level search.
    if (spec.transitionStyle === 'smooth_creative') {
      for (const abrupt of [false, true]) {
        if (keep.some((p) => abruptHandoff(p) === abrupt) || keep.length >= K) continue
        const best = scored.find(({ p }) => abruptHandoff(p) === abrupt)
        if (best) push(best.p, best.c)
      }
    }
    for (const { p, c } of scored) {
      if (keep.length >= K) break
      push(p, c)
    }
    keep.sort((x, y) => x.costs.total - y.costs.total)
    options.push(opts.rankCandidates && keep.length > 1 ? opts.rankCandidates(keep, a.summary, b.summary, i).slice(0, K) : keep)
    if (options[i][0]) {
      recent.unshift(options[i][0].style)
      recentTech.unshift((options[i][0] as TechniquePlan).tech?.technique ?? '')
    }
  }

  // DP over pairs: state = chosen candidate of the previous pair; value tracks duration buckets.
  const BUCKET = 2 // seconds
  const target = spec.targetDurationSec
  const tol = (opts.durationTolerance ?? 0.03) * target
  interface Cell {
    cost: number
    dur: number
    back: number // index into previous layer's cell list
    choice: number
  }
  // Layer 0: no transition chosen yet; track 0 enters at its music start.
  const start0 = musicStart(tracks[0].summary)
  type Layer = Map<number, Map<number, Cell>> // choice -> bucket -> cell
  const layers: Array<{ cells: Cell[]; byChoice: Layer }> = []
  // Represent each partial path by (choice, bucket). Duration counts mix time up to the start of transition i.
  let prevCells: Array<{ choice: number; cell: Cell; entry: number; mixEntry: number; recTrack: number; recMix: number }> = [
    { choice: -1, cell: { cost: 0, dur: 0, back: -1, choice: -1 }, entry: start0, mixEntry: 0, recTrack: 0, recMix: 0 },
  ]
  const history: Array<typeof prevCells> = [prevCells]
  for (let i = 0; i < n - 1; i++) {
    const a = tracks[i]
    const minSolo = MIN_SOLO_BARS * a.summary.barSec
    const next = new Map<string, (typeof prevCells)[number]>()
    prevCells.forEach((pc, pIdx) => {
      options[i].forEach((p, cIdx) => {
        // Outgoing must have finished its own tempo recovery and played ≥ MIN_SOLO_BARS alone.
        if (p.outCueSec < pc.entry + pc.recTrack + minSolo) return
        const solo = pc.recMix + (p.outCueSec - pc.entry - pc.recTrack)
        const dur = pc.cell.dur + solo + p.durationSec
        if (dur > target * 1.6) return
        const rec = recovery(p)
        const entryNext = p.inCueSec + inTrackSpan(p)
        const bucket = Math.round(dur / BUCKET)
        const key = `${cIdx}|${bucket}`
        const prior = i > 0 ? options[i - 1][pc.choice] : undefined
        const consecutiveAccents = spec.transitionStyle === 'smooth_creative'
          && prior && abruptHandoff(prior) && abruptHandoff(p)
        const accentCost = consecutiveAccents ? (prior.style === p.style ? 2.5 : 1.5) : 0
        const cost = pc.cell.cost + p.costs.total + accentCost
        const ex = next.get(key)
        if (!ex || cost < ex.cell.cost) {
          next.set(key, { choice: cIdx, cell: { cost, dur, back: pIdx, choice: cIdx }, entry: entryNext, mixEntry: dur, recTrack: rec.track, recMix: rec.mix })
        }
      })
    })
    prevCells = [...next.values()]
    if (!prevCells.length) {
      notes.push(`pair ${i + 1}→${i + 2}: no candidate satisfied the solo-length constraint; relaxed`)
      // Relax: take the cheapest candidate of each previous state regardless of solo length.
      const relaxed: typeof prevCells = []
      history[history.length - 1].forEach((pc, pIdx) => {
        const p = options[i].reduce((best, q) => (q.outCueSec > best.outCueSec ? q : best), options[i][0])
        if (!p) return
        const solo = Math.max(0, pc.recMix + (p.outCueSec - pc.entry - pc.recTrack))
        const dur = pc.cell.dur + solo + p.durationSec
        const rec = recovery(p)
        relaxed.push({ choice: options[i].indexOf(p), cell: { cost: pc.cell.cost + p.costs.total + 5, dur, back: pIdx, choice: options[i].indexOf(p) }, entry: p.inCueSec + inTrackSpan(p), mixEntry: dur, recTrack: rec.track, recMix: rec.mix })
      })
      prevCells = relaxed
    }
    // Prune by cost + deviation from the expected pace (target share of the set completed so far),
    // so shorter/longer edits survive until the final duration penalty can be applied.
    if (prevCells.length > 600) {
      const expected = target * ((i + 1) / n)
      const score = (x: (typeof prevCells)[number]) => x.cell.cost + (Math.max(0, Math.abs(x.cell.dur - expected) - tol) / 60) * 3.5
      prevCells = prevCells.sort((x, y) => score(x) - score(y)).slice(0, 600)
    }
    history.push(prevCells)
  }
  void layers
  // Close: last track plays to its musical end.
  const last = tracks[n - 1]
  const lastEnd = musicEnd(last.summary)
  let best: { idx: number; total: number; dur: number } | null = null
  prevCells.forEach((pc, idx) => {
    const tail = pc.recMix + Math.max(0, lastEnd - pc.entry - pc.recTrack)
    const dur = pc.cell.dur + tail
    const err = Math.max(0, Math.abs(dur - target) - tol)
    const total = pc.cell.cost + (err / 60) * 3.5
    if (!best || total < best.total) best = { idx, total, dur }
  })
  if (!best) throw new Error('mix planning failed: no feasible path')
  const bestPick = best as { idx: number; total: number; dur: number }
  // Backtrack choices.
  const choices: number[] = new Array(n - 1)
  let idx = bestPick.idx
  for (let i = n - 2; i >= 0; i--) {
    const pc = history[i + 1][idx]
    choices[i] = pc.choice
    idx = pc.cell.back
  }
  const plans = choices.map((c, i) => options[i][c])

  // Build the exact timeline.
  const tl: TimelineTrack[] = []
  const tt: TimelineTransition[] = []
  let entry = start0
  let mixIn = 0
  let mixMain = 0
  let recTrack = 0
  let recMix = 0
  let mixCursor = 0 // mix time at `entry`
  for (let i = 0; i < n; i++) {
    const t = tracks[i]
    const p = plans[i] // outgoing transition of track i (undefined for last)
    if (!p) {
      const tail = recMix + Math.max(0, lastEnd - entry - recTrack)
      tl.push({ key: t.key, entrySec: tl.length ? tt[i - 1].plan.inCueSec : start0, exitSec: lastEnd, mixInSec: mixIn, mixOutSec: mixCursor + tail, mixMainSec: mixMain, trimDb: t.trimDb })
      mixCursor += tail
      break
    }
    const solo = recMix + Math.max(0, p.outCueSec - entry - recTrack)
    const mixStart = mixCursor + solo
    const mixEnd = mixStart + p.durationSec
    const rec = recovery(p)
    tt.push({ index: i, plan: p, mixStartSec: mixStart, mixEndSec: mixEnd, inEndSec: p.inCueSec + inTrackSpan(p), recoverySec: rec.mix, recoveryTrackSec: rec.track })
    tl.push({ key: t.key, entrySec: i === 0 ? start0 : tt[i - 1].plan.inCueSec, exitSec: p.outCueSec + p.durationSec, mixInSec: mixIn, mixOutSec: mixEnd, mixMainSec: mixMain, trimDb: t.trimDb })
    mixIn = mixStart
    mixMain = mixEnd
    entry = p.inCueSec + inTrackSpan(p)
    recTrack = rec.track
    recMix = rec.mix
    mixCursor = mixEnd
  }
  const durationSec = mixCursor
  if (Math.abs(durationSec - target) > tol) {
    notes.push(
      `Duration ${fmt(durationSec)} vs requested ${fmt(target)}: ${durationSec < target ? 'the selected recordings are not long enough even with long blends' : 'the shortest musically clean edits are still longer'}.`,
    )
  }
  return { tracks: tl, transitions: tt, durationSec, targetDurationSec: target, totalCost: bestPick.total, notes, candidates: options }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`
}
