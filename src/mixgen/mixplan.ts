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
import { BEATMATCHED, candidateTransitions, DEFAULT_OPTIONS, SLAM, type PlannerOptions, type PlanTrack, type TransitionPlan, type TransitionStyle } from '../dj/transitions'
import { energyDirection } from './energy'
import type { ResolvedSpec } from './spec'

export interface PlannedTrack {
  key: string
  title: string
  summary: AnalysisSummary
  /** Loudness trim (dB) to the set's target level. */
  trimDb: number
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
}

const MIN_SOLO_BARS = 8

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
function energyContinuity(p: TransitionPlan, a: AnalysisSummary, b: AnalysisSummary): number {
  let c = 0
  const inEnd = p.inCueSec + inTrackSpan(p)
  const after = energyBetween(b, inEnd, inEnd + 16 * b.barSec)
  if (after !== null && after < b.energyMean - 6) c += Math.min(3, (b.energyMean - 6 - after) * 0.4)
  const outAt = energyBetween(a, p.outCueSec, p.outCueSec + Math.max(4 * a.barSec, p.durationSec / 2))
  if (outAt !== null && outAt < a.energyMean - 8) c += Math.min(2, (a.energyMean - 8 - outAt) * 0.25)
  return c
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
}

export function planMix(tracks: PlannedTrack[], spec: ResolvedSpec, opts: PlanMixOptions = {}): MixPlan {
  const n = tracks.length
  const K = opts.candidatesPerPair ?? 18
  const notes: string[] = []
  if (n === 0) return { tracks: [], transitions: [], durationSec: 0, targetDurationSec: spec.targetDurationSec, totalCost: 0, notes: ['no tracks'] }
  const pt = (t: PlannedTrack, s = t.summary): PlanTrack => ({ itemId: t.key, trackKey: t.key, title: t.title, mixable: true, summary: s, durationSec: s.durationSec })

  // Candidate edges per pair (default cues ∪ shortened variants), styled and diversified.
  const options: TransitionPlan[][] = []
  const recent: TransitionStyle[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = tracks[i]
    const b = tracks[i + 1]
    const popt: PlannerOptions = { ...DEFAULT_OPTIONS, ...opts.planner, recentStyles: [...recent], energyDirection: energyDirection(spec.energyCurve, i, n, spec.intensity) }
    const raw = [
      ...candidateTransitions(pt(a), pt(b), popt),
      ...candidateTransitions(pt(a, withEarlyOuts(a.summary)), pt(b, withLateIns(b.summary)), popt),
      ...candidateTransitions(pt(a, withLateOuts(a.summary)), pt(b), popt),
    ]
    const scored = raw.map((p) => ({ p, c: p.costs.total + stylePreference(p.style, spec, i, n) + energyContinuity(p, a.summary, b.summary) }))
    scored.sort((x, y) => x.c - y.c)
    // Keep diverse candidates: distinct (style, outCue, inCue) and a spread of out cues.
    const keep: TransitionPlan[] = []
    const sig = new Set<string>()
    for (const { p, c } of scored) {
      const k = `${p.style}|${p.outCueSec.toFixed(1)}|${p.inCueSec.toFixed(1)}|${p.overlapBars}`
      if (sig.has(k)) continue
      sig.add(k)
      keep.push({ ...p, costs: { ...p.costs, total: c } })
      if (keep.length >= K) break
    }
    options.push(opts.rankCandidates && keep.length > 1 ? opts.rankCandidates(keep, a.summary, b.summary, i).slice(0, K) : keep)
    if (options[i][0]) recent.unshift(options[i][0].style)
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
        const cost = pc.cell.cost + p.costs.total
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
  return { tracks: tl, transitions: tt, durationSec, targetDurationSec: target, totalCost: bestPick.total, notes }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`
}
