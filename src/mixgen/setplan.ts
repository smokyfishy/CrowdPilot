/**
 * Global DJ set planning: track subset, order, cue points, overlap length and technique chosen
 * JOINTLY for the whole set.
 *
 * The legacy path ordered tracks with scalar pair costs and only then chose cues pair by pair. Here
 * a single beam search builds the set left to right where a search state carries the last track's
 * actual entry point (track time where it became the main track) and its tempo recovery. Expanding
 * the state to the next track picks a concrete transition edge whose exit cue leaves the current
 * track enough solo time after ITS entry — so each track's incoming and outgoing cues are planned
 * together and every transition constrains the next one (multi-track lookahead inside the state).
 *
 * Costs (planner units; heuristic, documented — not learned unless stated):
 *   narrative     per-slot target energy/tension from the prompt (opening, groove, build, peak,
 *                 breakdown/recovery, finale)
 *   set shape     BPM drift and zig-zag, genre coherence, groove similarity (proxy), vocal
 *                 distribution, key and technique variety, artist repeats, duration fit
 *   edges         rule cost of the cue/style candidate (src/dj/transitions.ts + mixplan.pairOptions)
 *                 + bar-level overlap compatibility (src/mixgen/profile.ts) + overlap-length prior
 *                 + MixGraph predicted severity when the model is loaded (TRAINED; logged separately)
 *                 + MEASURED closed-loop quality when the edge was rendered (src/mixgen/closedloop.ts)
 * The search returns several complete-set arrangements; the closed loop renders and re-plans.
 */
import { tempoMatch, BEATMATCHED, automationFor, beatmatchable, DEFAULT_OPTIONS, DEFAULT_WEIGHTS, transitionAllowed, steadyBpm, BEATMATCH_MAX_DEVIATION, type TransitionPlan } from '../dj/transitions'
import { camelotDistance } from '../dsp/key'
import { refineWithLocalBeats } from '../dj/phase'
import { energyDirection, targetEnergy } from './energy'
import { energyContinuity, localGrid, MIN_SOLO_BARS, musicEnd, musicStart, pairOptions, recovery, inTrackSpan, abruptHandoff, stylePreference, type PlannedTrack, type PlanMixOptions } from './mixplan'
import { genrePreference } from './techniques'
import { cueCandidates, grooveSimilarity, overlapCompat, type OverlapCompat, type TrackProfile } from './profile'
import { longformEligible } from './longform'
import { gridAlignment } from './audio-quality'
import { avoided, matchesAny } from './technique-match'
import type { TechniqueName } from './spec'
import type { TechniquePlan } from './techniques'
import type { ResolvedSpec } from './spec'

export interface SetTrack extends PlannedTrack {
  profile: TrackProfile
  /** Pool-relative energy 0..1 and drop strength (src/mixgen/energy.ts). */
  energy: number
  dropStrength: number
  /** Preference from selection (pinned tracks carry a large bonus). */
  pref: number
  artist: string
  genres: string[]
  gridOk: boolean
}

export interface Edge {
  plan: TransitionPlan
  /** Total planner cost of the edge (rule + compat + prior + learned + measured). */
  cost: number
  parts: { rule: number; compat: number; prior: number; learned: number; measured: number; request?: number }
  compat?: OverlapCompat
  kind: 'pair' | 'window'
  sig: string
  measured?: boolean
}

export interface SetPlanOptions {
  count: number
  /** Last resort (set by planSet itself): allow a 16+-bar non-beat-matched fade when no beat-matched order exists. */
  allowUnmatched?: boolean
  fixedOrder?: string[]
  beamWidth?: number
  topN?: number
  /** Next-track expansions per state and edges per expansion. */
  branch?: number
  edgesPerPair?: number
  /** Legacy pairOptions knobs (techniques, drop landings, MixGraph rank hook). */
  pairOpts?: PlanMixOptions
  /** Learned per-edge severity (MixGraph) — returns predicted severity or undefined. */
  learnedSeverity?: (edge: TransitionPlan, a: SetTrack, b: SetTrack) => number | undefined
  learnedWeight?: number
  /** Closed-loop feedback: measured edge costs/plans by edge slot signature, and per-pair penalties. */
  measured?: Map<string, { cost: number; plan: TransitionPlan }>
  pairPenalty?: Map<string, number>
  /** Allow long-form windows (16–64 bars) in addition to the legacy candidates. */
  longform?: boolean
  /** Pessimism for edges never rendered once measurements exist (closed-loop verification converges on rendered edges). */
  unmeasuredPenalty?: number
  /** Extra candidate edges per pair ("a|b"), e.g. refined variants found by the closed loop. */
  extraEdges?: Map<string, TransitionPlan[]>
  log?: (m: string) => void
}

export interface PlannedSet {
  order: string[]
  edges: Edge[]
  cost: number
  durationSec: number
  parts: Record<string, number>
  /** Track time where the LAST track ends (earlier than its musical end when the requested length needs it). */
  endSec?: number
  /** Track time where the FIRST track starts (short sets may open inside it). */
  startSec?: number
}

export interface SetPlanResult {
  sets: PlannedSet[]
  explored: number
  pairsEvaluated: number
  edgeLists: Map<string, Edge[]>
  /** True when no fully beat-matched arrangement existed and a fade had to be allowed. */
  relaxed?: boolean
}

/** Genres where long phrase-based blends are the norm (32-bar default). */
const LONG_FORM_GENRES = /house|techno|edm|trance|dance|electronic|garage|progressive|deep|melodic/i

export function edgeSig(a: string, b: string, p: TransitionPlan): string {
  return `${a}|${b}|${p.outCueSec.toFixed(1)}|${p.inCueSec.toFixed(1)}|${p.overlapBars}`
}

export interface Narrative {
  role: 'opening' | 'groove' | 'build' | 'peak' | 'recovery' | 'finale'
  energy: number
  tension: number
}

/**
 * Per-slot narrative targets from the prompt: the requested energy curve (targetEnergy) plus slot
 * roles. Peaks are where the target is at its maximum; a dip after a peak is a recovery; a rising
 * stretch before a peak is a build; the first slot opens and the last closes.
 */
export function narrativeFor(spec: ResolvedSpec, n: number): Narrative[] {
  const e = Array.from({ length: n }, (_, i) => targetEnergy(spec.energyCurve, n > 1 ? i / (n - 1) : 0.5, spec.intensity))
  const max = Math.max(...e)
  return e.map((v, i) => {
    let role: Narrative['role'] = 'groove'
    if (i === 0) role = 'opening'
    else if (i === n - 1) role = 'finale'
    else if (v >= max - 0.05) role = 'peak'
    else if (e[i + 1] !== undefined && e[i + 1] > v + 0.02) role = 'build'
    else if (e[i - 1] !== undefined && e[i - 1] > v + 0.05) role = 'recovery'
    const tension = role === 'build' ? 0.7 : role === 'peak' ? 1 : role === 'recovery' ? 0.2 : role === 'opening' ? 0.2 : role === 'finale' ? (spec.features.includes('festival_closer') ? 1 : 0.4) : 0.5
    return { role, energy: v, tension }
  })
}

function genreJaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0.5
  const A = new Set(a.map((x) => x.toLowerCase()))
  const B = new Set(b.map((x) => x.toLowerCase()))
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** Overlap-length prior (planner units): 32 bars default for house/techno/EDM; 48–64 only when compatible. */
/** Transition styles that perform the named techniques (staged performances are matched separately). */
const STYLE_FOR: Partial<Record<TechniqueName, TransitionPlan['style']>> = { cut: 'cut', echo_out: 'echo_out', filter_sweep: 'filter_sweep', bass_swap: 'bass_swap', drop_swap: 'drop_swap', loop_roll: 'loop_roll', long_blend: 'long_blend', scratch: 'scratch_cut', brake: 'brake' }
function requestedStyles(prefer: readonly TechniqueName[]): TransitionPlan['style'][] {
  return [...new Set(prefer.map((t) => STYLE_FOR[t]).filter((x): x is TransitionPlan['style'] => !!x))]
}

/** Short sets (little time per track): wide cue windows, short overlaps, early endings allowed. */
export function isShortSet(spec: ResolvedSpec): boolean {
  return spec.targetDurationSec / Math.max(1, spec.songCount) < 150
}

function lengthPrior(bars: number, compatCost: number, longGenre: boolean, spec: ResolvedSpec): number {
  if (isShortSet(spec)) return bars <= 8 ? -0.3 : bars === 16 ? -0.45 : bars === 32 ? 0.6 : 2.5
  if (!longGenre || spec.transitionStyle === 'energetic') return 0
  if (bars === 32) return -0.45
  if (bars === 16) return -0.15
  if (bars === 48) return compatCost < 0.7 ? -0.4 : 0.5
  if (bars === 64) return compatCost < 0.5 ? -0.35 : 0.8
  return 0
}

/**
 * Long-form windows for a pair: phrase-aligned exit × entry candidates (profile regions) ×
 * 16/32/48/64 bars, beat-matched within ±6 %. Each is scored by bar-level compatibility.
 */
export function windowCandidates(a: SetTrack, b: SetTrack, spec: ResolvedSpec, maxOut = 7, maxIn = 6): Array<{ plan: TransitionPlan; compat: OverlapCompat }> {
  const sa = localGrid(a.summary, a.netBeats, 'out')
  const sb = localGrid(b.summary, b.netBeats, 'in')
  // whole-track grids beat-match directly; otherwise each window is beat-matched on the steady beats
  // inside it (as a DJ mixes on a section with a steady drum pattern), or not offered at all
  const wholeGrid = beatmatchable(sa) && beatmatchable(sb)
  if (!wholeGrid && (!a.netBeats?.length || !b.netBeats?.length)) return []
  const globalRatio = wholeGrid ? tempoMatch(sa.bpm, sb.bpm).ratio : 1
  if (wholeGrid && Math.abs(globalRatio - 1) > BEATMATCH_MAX_DEVIATION + 1e-9) return []
  const short = isShortSet(spec)
  const outs0 = cueCandidates(a.profile, 'out', short ? maxOut + 4 : maxOut, short ? { outFrom: 0.2 } : undefined)
  // likewise, an outgoing track without a steady whole-track grid is mixed out of a steady drum section
  const outs = !beatmatchable(sa) && a.netBeats?.length
    ? [...outs0, ...a.profile.phraseBars
        .map((k) => ({ k, sec: a.profile.barStart + k * a.profile.barSec }))
        .filter(({ sec }) => sec >= (short ? 0.2 : 0.4) * sa.durationSec && !outs0.some((c) => Math.abs(c.sec - sec) < 1) && steadyBpm(a.netBeats, sec, sec + 16 * a.profile.barSec) !== null)
        .map(({ k, sec }) => ({ sec, bar: k, region: a.profile.region[k] ?? 'body', vocal: 0, score: 0 }) as (typeof outs0)[number])]
    : outs0
  // an incoming track whose early part has no steady beat (half-time intro, beatless vocal section)
  // is brought in later, on its steady section — as a DJ would
  const lateIn = !beatmatchable(sb) || !steadyBpm(b.netBeats, b.summary.durationSec * 0.1, b.summary.durationSec * 0.45)
  const ins0 = cueCandidates(b.profile, 'in', short || lateIn ? maxIn + 6 : maxIn, short || lateIn ? { inTo: lateIn ? 0.75 : 0.7 } : undefined)
  // a track without a steady whole-track grid: also offer every phrase start inside a steady drum
  // section (16 bars of steady beats from the cue), where a DJ would bring it in
  const ins = !beatmatchable(sb) && b.netBeats?.length
    ? [...ins0, ...b.profile.phraseBars
        .map((k) => ({ k, sec: b.profile.barStart + k * b.profile.barSec }))
        .filter(({ sec }) => sec <= 0.75 * sb.durationSec && !ins0.some((c) => Math.abs(c.sec - sec) < 1) && steadyBpm(b.netBeats, sec, sec + 16 * b.profile.barSec) !== null)
        .map(({ k, sec }) => ({ sec, bar: k, region: b.profile.region[k] ?? 'body', vocal: 0, score: 0 }) as (typeof ins0)[number])]
    : ins0
  const tailA = musicEnd(sa)
  const leadB = Math.max(0, (sb.silentLeadSec ?? 0) - 0.05)
  const keyDist = sa.keyConf >= 0.1 && sb.keyConf >= 0.1 ? camelotDistance(sa.camelot, sb.camelot) : 3
  const res: Array<{ plan: TransitionPlan; compat: OverlapCompat }> = []
  const dbg = { outs: outs.length, ins: ins.length, noOutBpm: 0, noInBpm: 0, tempo: 0, tooLate: 0, other: 0 }
  for (const bars of short ? [16, 32] : [16, 32, 48, 64]) {
    const beats = bars * 4
    for (const o of outs) {
      // outgoing tempo in this window (whole-track grid, or the steady beats inside the window)
      const outBpm = wholeGrid ? sa.bpm : steadyBpm(a.netBeats, o.sec, o.sec + beats * (60 / sa.bpm))
      if (!outBpm) {
        dbg.noOutBpm++
        continue
      }
      const beatSec = 60 / outBpm
      const overlapSec = beats * beatSec
      // allow up to 8 bars past the outgoing's end (bridged by an outgoing loop), never more
      if (o.sec + overlapSec > tailA + 8 * 4 * beatSec) continue
      if (o.sec < sa.durationSec * (short ? 0.15 : 0.35)) continue
      for (const i of ins) {
        if (i.sec < leadB) continue
        let ratio = globalRatio
        if (!wholeGrid) {
          const guess = tempoMatch(outBpm, sb.bpm || outBpm).ratio
          const inBpm = steadyBpm(b.netBeats, i.sec, i.sec + overlapSec * guess)
          if (!inBpm) {
            dbg.noInBpm++
            continue
          }
          ratio = tempoMatch(outBpm, inBpm).ratio
          if (Math.abs(ratio - 1) > BEATMATCH_MAX_DEVIATION + 1e-9) {
            dbg.tempo++
            continue
          }
        }
        if (i.sec + overlapSec * ratio > (lateIn ? 0.95 : 0.8) * sb.durationSec) {
          dbg.tooLate++
          continue
        }
        const compat = overlapCompat(a.profile, b.profile, o.sec, i.sec, bars)
        if (compat.outRunsOut > 8) continue
        const auto = automationFor('long_blend', beats)
        const tempo = 0.25 * Math.abs(ratio - 1) * 100
        const key = 1.0 * Math.min(1.5, bars / 16 + 0.3) * Math.max(0, keyDist - 1) * 0.6
        const conf = 0.6 * (1 - Math.min(1, (wholeGrid ? Math.min(sa.bpmConf, sb.bpmConf) : 0.4) / 0.6)) + 0.35 * (1 - Math.min(1, Math.min(sa.downbeatConf, sb.downbeatConf) / 0.3)) * Math.min(1, bars / 16)
        let plan: TransitionPlan = {
          fromItemId: a.key,
          toItemId: b.key,
          style: 'long_blend',
          outCueSec: o.sec,
          inCueSec: i.sec,
          overlapBars: bars,
          tempoRatio: ratio,
          tempoRecoveryBars: Math.abs(ratio - 1) > 0.002 ? 16 : 0,
          beatSec,
          durationSec: overlapSec,
          handoffBeat: auto.handoffBeat,
          out: auto.out,
          in: auto.in,
          costs: { tempo, key, energy: 0, vocals: 0, confidence: conf, truncation: 0, variety: 0, total: tempo + key + conf },
          risks: keyDist >= 3 ? [`key clash risk (${sa.camelot} → ${sb.camelot})`] : [],
          reasons: [`${bars}-bar window: out ${o.region} (bar ${o.bar}), in ${b.profile.region[i.bar] ?? 'body'} (bar ${i.bar})`, `beat-matched at ${outBpm.toFixed(1)} BPM (${((ratio - 1) * 100).toFixed(1)}%)${wholeGrid ? '' : ' on the steady beats of both windows'}`],
        }
        // incoming drop exactly at the window end → drop-locked candidate
        const drop = (sb.dropsSec ?? []).find((d) => Math.abs(d - (i.sec + overlapSec * ratio)) < beatSec * 0.6)
        if (drop !== undefined && sb.downbeatConf >= 0.3) plan.incomingDropSec = drop
        const r = refineWithLocalBeats(plan, a.netBeats, b.netBeats, BEATMATCH_MAX_DEVIATION)
        if (r.localRefined) {
          const { localRefined: _l, ...rest } = r
          plan = rest
        }
        res.push({ plan, compat })
      }
    }
  }
  if (typeof process !== 'undefined' && process.env?.WINDOW_DEBUG) process.stderr.write(`WIN ${a.key}->${b.key} whole=${wholeGrid} lateIn=${lateIn} ${JSON.stringify(dbg)} windows=${res.length}
`)
  return res
}

interface State {
  order: string[]
  used: Set<string>
  /** Track time where the FIRST track starts (later than its music start in short sets). */
  start?: number
  entry: number
  recTrack: number
  recMix: number
  dur: number
  cost: number
  edges: Edge[]
  styles: string[]
  parts: Record<string, number>
}

export function planSet(tracks: SetTrack[], spec: ResolvedSpec, opts: SetPlanOptions): SetPlanResult {
  const res = planSetOnce(tracks, spec, opts)
  // every transition must be beat-matched; only when no fully beat-matched arrangement exists at all
  // (e.g. a requested song has no steady beat anywhere) is a 16+-bar fade allowed, with a high cost
  if (!res.sets.length && !opts.allowUnmatched) {
    const relaxed = planSetOnce(tracks, spec, { ...opts, allowUnmatched: true })
    return { ...relaxed, relaxed: true }
  }
  return res
}

function planSetOnce(tracks: SetTrack[], spec: ResolvedSpec, opts: SetPlanOptions): SetPlanResult {
  const n = Math.min(opts.count, tracks.length)
  const W = opts.beamWidth ?? 40
  const topN = opts.topN ?? 5
  const branch = opts.branch ?? 7
  const E = opts.edgesPerPair ?? 4
  const byKey = new Map(tracks.map((t) => [t.key, t]))
  const narrative = narrativeFor(spec, n)
  const target = spec.targetDurationSec
  const tol = 0.03 * target
  const longGenre = LONG_FORM_GENRES.test(spec.genres.join(' ')) || tracks.some((t) => t.genres.some((g) => LONG_FORM_GENRES.test(g)))
  const learnedWeight = opts.learnedWeight ?? 4
  const edgeLists = new Map<string, Edge[]>()
  let pairsEvaluated = 0

  /** Position-independent edge list of a pair (memoised). */
  const edgesFor = (a: SetTrack, b: SetTrack): Edge[] => {
    const k = `${a.key}|${b.key}`
    const hit = edgeLists.get(k)
    if (hit) return hit
    pairsEvaluated++
    const list: Edge[] = []
    const seen = new Set<string>()
    const push = (plan: TransitionPlan, rule: number, kind: Edge['kind'], compat?: OverlapCompat) => {
      const sig = edgeSig(a.key, b.key, plan) + `|${plan.style}|${(plan as TechniquePlan).tech?.technique ?? ''}`
      if (seen.has(sig)) return
      seen.add(sig)
      // house rules (beat-matched, ≥ 16-bar overlap, no loop rolls), then techniques the user named: never an avoided one.
      // Last resort only (no fully beat-matched order exists): a 16+-bar fade, flagged.
      if (!transitionAllowed(plan) && !(opts.allowUnmatched && plan.style === 'unmatched_fade' && plan.overlapBars >= 16)) return
      if (avoided(plan, spec.techniques.avoid)) return
      const wanted = spec.techniques.prefer
      const request = wanted.length ? (matchesAny(plan, wanted) ? -5 : 0.6) : 0
      const beatmatched = BEATMATCHED.has(plan.style) && plan.overlapBars >= 8
      const c = compat ?? (beatmatched ? overlapCompat(a.profile, b.profile, plan.outCueSec, plan.inCueSec, plan.overlapBars) : undefined)
      const compatCost = c ? c.cost : 0
      const prior = beatmatched ? lengthPrior(plan.overlapBars, compatCost, longGenre, spec) : abruptHandoff(plan) && longGenre && spec.transitionStyle !== 'energetic' && spec.transitionStyle !== 'creative' ? 0.6 : 0
      let learned = 0
      if (opts.learnedSeverity) {
        const sev = opts.learnedSeverity(plan, a, b)
        if (sev !== undefined && Number.isFinite(sev)) learned = learnedWeight * sev
      }
      // beat alignment predicted from the Beat This! grids through the edge's cue/tempo controls
      let align = 0
      if (BEATMATCHED.has(plan.style) && plan.durationSec > 1) {
        const g = gridAlignment(plan, a.netBeats, b.netBeats)
        if (Number.isFinite(g.medianMs)) {
          if (g.medianMs > 60) {
            if (typeof process !== 'undefined' && process.env?.WINDOW_DEBUG) process.stderr.write(`ALIGN-REJECT ${a.key}->${b.key} ${plan.style} ${plan.overlapBars} median=${g.medianMs.toFixed(0)}ms
`)
            return // would audibly flam: not a candidate
          }
          align = 2 * Math.min(1, Math.max(0, (g.medianMs - 12) / 40)) + Math.min(1, Math.max(0, (g.p90Ms - 30) / 60))
        }
      }
      list.push({ plan, cost: rule + compatCost + prior + learned + align + request, parts: { rule, compat: compatCost + align, prior, learned, measured: 0, request }, compat: c, kind, sig: edgeSig(a.key, b.key, plan) })
    }
    // legacy candidate family (all styles/techniques; position-neutral scoring)
    // short sets: leaving a track early is the point, so no truncation cost and a wider shortlist
    const shortSet = isShortSet(spec)
    const pairBase = { ...opts.pairOpts, rankCandidates: undefined, candidatesPerPair: shortSet ? 28 : 14, ...(shortSet ? { planner: { weights: { ...DEFAULT_WEIGHTS, truncation: 0 } } } : {}) }
    for (const p of pairOptions(a, b, Math.floor(n / 2), n, spec, pairBase)) push(p, p.costs.total, 'pair')
    // requested techniques get their own shortlist, so a costly style the user asked for (a hard cut)
    // is never pruned before its request bonus applies
    const wantedStyles = requestedStyles(spec.techniques.prefer)
    if (wantedStyles.length) {
      for (const p of pairOptions(a, b, Math.floor(n / 2), n, spec, { ...pairBase, candidatesPerPair: 6, planner: { ...(pairBase.planner ?? {}), allowedStyles: wantedStyles } })) push(p, p.costs.total, 'pair')
    }
    // long-form windows (16–64 bars)
    if (opts.longform !== false) {
      const wins = windowCandidates(a, b, spec)
      wins.sort((x, y) => x.compat.cost + x.plan.costs.total - (y.compat.cost + y.plan.costs.total))
      const regions = new Set<string>()
      let kept = 0
      for (const w of wins) {
        const r = `${Math.round(w.plan.outCueSec / (16 * a.summary.barSec))}|${Math.round(w.plan.inCueSec / (16 * b.summary.barSec))}|${w.plan.overlapBars}`
        if (regions.has(r)) continue
        regions.add(r)
        // the same style / energy / genre terms the legacy candidates carry (fair comparison)
        const dropBonus = opts.pairOpts?.preferLongDropBlends && (spec.transitionStyle === 'smooth' || spec.transitionStyle === 'smooth_creative') && w.plan.incomingDropSec !== undefined ? 2 : 0
        const styled = w.plan.costs.total + stylePreference('long_blend', spec, Math.floor(n / 2), n) + energyContinuity(w.plan, a, b) + genrePreference('long_blend', undefined, spec) - dropBonus
        push(w.plan, styled, 'window', w.compat)
        if (++kept >= 16) break
      }
    }
    for (const p of opts.extraEdges?.get(k) ?? []) push(p, p.costs.total, BEATMATCHED.has(p.style) && p.overlapBars >= 16 ? 'window' : 'pair')
    // An abrupt handoff is intentional when this pair has no clean beat-matched option left (tempo, grid,
    // or predicted beat alignment > 60 ms rejected them): say so, for the manifest and the validator.
    if (!list.some((e) => BEATMATCHED.has(e.plan.style) && e.plan.overlapBars >= 4)) {
      for (const e of list) if (abruptHandoff(e.plan)) e.plan = { ...e.plan, reasons: [...e.plan.reasons, 'no clean beat-matched window for this pair (tempo, grid or predicted beat alignment)'] }
    }
    list.sort((x, y) => x.cost - y.cost)
    edgeLists.set(k, list)
    return list
  }

  const pairKey = (a: string, b: string) => `${a}|${b}`
  // an energy shape the user asked for weighs as much as a requested technique (a −5 edge bonus)
  const energyWeight = spec.defaulted?.includes('energy_curve') === false ? 9 : 3
  const slotCost = (t: SetTrack, pos: number): number => {
    const nv = narrative[pos]
    let c = energyWeight * Math.abs(t.energy - nv.energy)
    if (nv.role === 'peak' || (nv.role === 'finale' && spec.features.includes('festival_closer'))) c -= Math.min(1.2, t.dropStrength / 5)
    if (nv.role === 'opening') c += 0.5 * Math.max(0, t.energy - 0.6) + 0.3 * avgVocal(t)
    if (nv.role === 'recovery') c += 0.5 * Math.max(0, t.energy - nv.energy - 0.1)
    if (spec.features.includes('big_drops') && pos >= n * 0.4) c -= Math.min(0.6, t.dropStrength / 8)
    if (spec.vocals === 'instrumental') c += 0.8 * avgVocal(t)
    if (spec.vocals === 'vocal') c -= 0.6 * avgVocal(t)
    // requested BPM range, on the ANALYSED tempo (octave-folded): 0.15 per % outside the range
    if (spec.bpmRange && t.summary.bpm > 0) {
      const [lo, hi] = spec.bpmRange
      const off = Math.min(...[t.summary.bpm, t.summary.bpm * 2, t.summary.bpm / 2].map((b) => (b < lo ? (lo - b) / lo : b > hi ? (b - hi) / hi : 0)))
      c += 15 * off
    }
    if (!t.gridOk) c += 1.5
    return c - t.pref
  }
  const transitionCost = (st: State, a: SetTrack, b: SetTrack, e: Edge, pos: number): { cost: number; parts: Record<string, number> } => {
    const parts: Record<string, number> = {}
    const m = opts.measured?.get(e.sig)
    parts.edge = m ? m.cost : e.cost + (opts.unmeasuredPenalty ?? 0)
    // position-dependent energy direction (the edge list is position-neutral)
    const dir = energyDirection(spec.energyCurve, pos - 1, n, spec.intensity)
    parts.direction = 0.16 * Math.max(0, -(b.summary.energyMean - a.summary.energyMean) * dir)
    // BPM drift: smooth progression; avoid zig-zag
    const step = Math.log(b.summary.bpm / a.summary.bpm) * 100
    const prevStep = st.order.length >= 2 ? Math.log(a.summary.bpm / byKey.get(st.order[st.order.length - 2])!.summary.bpm) * 100 : 0
    parts.bpm = Math.max(0, Math.abs(step) - 3) * 0.12 + (prevStep * step < 0 && Math.abs(step) > 1 && Math.abs(prevStep) > 1 ? 0.3 : 0)
    parts.genre = 0.6 * (1 - genreJaccard(a.genres, b.genres))
    parts.groove = 1.0 * (1 - grooveSimilarity(a.profile, b.profile))
    const va = avgVocal(a)
    const vb = avgVocal(b)
    const vPrev = st.order.length >= 2 ? avgVocal(byKey.get(st.order[st.order.length - 2])!) : 0
    parts.vocals = (va > 0.5 && vb > 0.5 ? 0.4 : 0) + (vPrev > 0.5 && va > 0.5 && vb > 0.5 ? 0.4 : 0)
    const prevKey = st.order.length >= 2 ? byKey.get(st.order[st.order.length - 2])!.summary.camelot : ''
    parts.keyVariety = prevKey && prevKey === a.summary.camelot && a.summary.camelot === b.summary.camelot ? 0.2 : 0
    parts.artist = (a.artist && a.artist === b.artist ? 1.2 : 0) + 0.5 * st.order.filter((k) => byKey.get(k)!.artist === b.artist).length
    const tech = (e.plan as TechniquePlan).tech?.technique ?? e.plan.style
    // variety of non-blend techniques: a repeated slam/creative move gets stale fast (dev-set tuning)
    const recent3 = st.styles.slice(0, 3).filter((x) => x === tech).length
    // variety never overrides a technique the user asked for
    parts.techVariety = BEATMATCHED.has(e.plan.style) || matchesAny(e.plan, spec.techniques.prefer) ? 0 : (st.styles[0] === tech ? 1.2 : 0) + 0.6 * recent3
    parts.accent = spec.transitionStyle === 'smooth_creative' && st.edges.length && abruptHandoff(st.edges[st.edges.length - 1].plan) && abruptHandoff(e.plan) ? 1.5 : 0
    if (spec.features.includes('festival_closer') && pos === n - 1 && e.plan.style === 'drop_swap') parts.closer = -1.2
    parts.pairPenalty = opts.pairPenalty?.get(pairKey(a.key, b.key)) ?? 0
    return { cost: Object.values(parts).reduce((p, q) => p + q, 0), parts }
  }

  const fixed = opts.fixedOrder?.filter((k) => byKey.has(k)).slice(0, n)
  let beam: State[] = []
  for (const t of fixed ? [byKey.get(fixed[0])!] : tracks) {
    beam.push({ order: [t.key], used: new Set([t.key]), entry: musicStart(t.summary), recTrack: 0, recMix: 0, dur: 0, cost: slotCost(t, 0), edges: [], styles: [], parts: { slot: slotCost(t, 0) } })
    // short sets may open inside the first track (a phrase start before ~60 %), with a fade-in
    if (isShortSet(spec)) {
      for (const c of cueCandidates(t.profile, 'in', 6, { inTo: 0.6 }).filter((x) => x.sec > musicStart(t.summary) + 8 * t.summary.barSec)) {
        beam.push({ order: [t.key], used: new Set([t.key]), start: c.sec, entry: c.sec, recTrack: 0, recMix: 0, dur: 0, cost: slotCost(t, 0) + 0.3, edges: [], styles: [], parts: { slot: slotCost(t, 0), lateStart: 0.3 } })
      }
    }
  }
  beam.sort((x, y) => x.cost - y.cost)
  beam = beam.slice(0, W)
  let explored = 0
  for (let pos = 1; pos < n; pos++) {
    const next = new Map<string, State>()
    for (const st of beam) {
      const a = byKey.get(st.order[st.order.length - 1])!
      // rank next tracks by a cheap look (slot + best edge) and expand the best few
      const cands = (fixed ? [byKey.get(fixed[pos])!] : tracks.filter((t) => !st.used.has(t.key)))
        .map((b) => ({ b, look: slotCost(b, pos) + (edgesFor(a, b)[0]?.cost ?? 5) + (opts.pairPenalty?.get(pairKey(a.key, b.key)) ?? 0) }))
        .sort((x, y) => x.look - y.look)
        .slice(0, fixed ? 1 : branch)
      for (const { b } of cands) {
        const minSolo = MIN_SOLO_BARS * a.summary.barSec
        const feasible = edgesFor(a, b).filter((e) => e.plan.outCueSec >= st.entry + st.recTrack + minSolo)
        // measured overrides re-rank the pair's edges
        const ranked = feasible
          .map((e) => ({ e, c: opts.measured?.get(e.sig)?.cost ?? e.cost }))
          .sort((x, y) => x.c - y.c)
          .slice(0, E)
        for (const { e } of ranked) {
          explored++
          const tc = transitionCost(st, a, b, e, pos)
          const plan = opts.measured?.get(e.sig)?.plan ?? e.plan
          const solo = st.recMix + (plan.outCueSec - st.entry - st.recTrack)
          const dur = st.dur + solo + plan.durationSec
          if (dur > target * 1.6) continue
          const rec = recovery(plan)
          const slot = slotCost(b, pos)
          const used = new Set(st.used)
          used.add(b.key)
          const ns: State = {
            order: [...st.order, b.key],
            used,
            start: st.start,
            entry: plan.inCueSec + inTrackSpan(plan),
            recTrack: rec.track,
            recMix: rec.mix,
            dur,
            cost: st.cost + tc.cost + slot,
            edges: [...st.edges, { ...e, plan, measured: !!opts.measured?.get(e.sig) }],
            styles: [(plan as TechniquePlan).tech?.technique ?? plan.style, ...st.styles],
            parts: addParts(st.parts, { ...tc.parts, slot }),
          }
          const sig = `${[...used].sort().join(',')}|${b.key}|${Math.round(ns.entry / 8)}|${Math.round(dur / 20)}`
          const ex = next.get(sig)
          if (!ex || ns.cost < ex.cost) next.set(sig, ns)
        }
      }
    }
    const expected = target * (pos / Math.max(1, n - 1)) * 0.92
    const pace = (s: State) => s.cost + (Math.max(0, Math.abs(s.dur - expected) - tol) / 60) * 2.5
    beam = [...next.values()].sort((x, y) => pace(x) - pace(y)).slice(0, W)
    if (!beam.length) break
  }
  // close: last track plays to its musical end; duration fit
  const finals = beam.map((st) => {
    const last = byKey.get(st.order[st.order.length - 1])!
    const fullEnd = musicEnd(last.summary)
    // the last track normally plays to its end; when the requested length needs it, it may end at a
    // phrase boundary (≥ 16 bars after it became the main track) with a fade-out
    const minEnd = st.entry + st.recTrack + 16 * last.summary.barSec
    const ends = [fullEnd, ...last.profile.phraseBars.map((k) => last.profile.barStart + k * last.profile.barSec).filter((t) => t >= minEnd && t < fullEnd - 8 * last.summary.barSec)]
    let bestEnd = { endSec: fullEnd, durationSec: 0, durCost: Infinity }
    for (const endSec of ends) {
      const durationSec = st.dur + st.recMix + Math.max(0, endSec - st.entry - st.recTrack)
      const err = Math.max(0, Math.abs(durationSec - target) - tol)
      // the mix validator fails a set more than 10 % off the requested length: treat > 9 % as near-hard
      const rel = Math.abs(durationSec - target) / target
      const durCost = (err / 60) * 3.5 + (rel > 0.09 ? 10 + 100 * (rel - 0.09) : 0) + (endSec < fullEnd ? 0.6 : 0)
      if (durCost < bestEnd.durCost) bestEnd = { endSec, durationSec, durCost }
    }
    return { order: st.order, edges: st.edges, cost: st.cost + bestEnd.durCost, durationSec: bestEnd.durationSec, endSec: bestEnd.endSec < fullEnd ? bestEnd.endSec : undefined, startSec: st.start, parts: { ...st.parts, duration: bestEnd.durCost } }
  })
  finals.sort((x, y) => x.cost - y.cost)
  const sets: PlannedSet[] = []
  const seenSets = new Set<string>()
  for (const f of finals) {
    const s = f.order.join('>') + '#' + f.edges.map((e) => e.sig).join(',')
    if (seenSets.has(s)) continue
    seenSets.add(s)
    sets.push(f)
    if (sets.length >= topN) break
  }
  opts.log?.(`setplan: ${explored} expansions, ${pairsEvaluated} pairs, ${sets.length} complete sets (best ${sets[0]?.cost.toFixed(2)})`)
  return { sets, explored, pairsEvaluated, edgeLists }
}

function avgVocal(t: SetTrack): number {
  return (t.summary.vocalIn + t.summary.vocalOut) / 2
}

function addParts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const o = { ...a }
  for (const [k, v] of Object.entries(b)) o[k] = (o[k] ?? 0) + v
  return o
}

export { longformEligible }
