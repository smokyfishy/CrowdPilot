/**
 * Bar-level musical profile for set planning and long-form transitions.
 *
 * The planner previously saw only `AnalysisSummary` (32-bar means). Long, layered transitions need
 * to know what is playing IN EVERY BAR of a 16–64-bar overlap: is there a bassline, a vocal, a
 * busy percussion layer, which harmony? This module derives that from the existing analysis
 * (`TrackAnalysis.bars`, sections, phrases, local keys) and — when the local worker separated
 * stems — from the vocal stem. Nothing here is learned:
 *   - bass / mid / high activity: each bar's band energy relative to the track's own loud bars;
 *   - percussion: onset density relative to the track;
 *   - vocals: vocal-stem level when stems exist, else the analyzer's HEURISTIC vocal likelihood
 *     (flagged in `vocalSource`);
 *   - regions: intro / outro / breakdown / drop from the analyzer, plus "build" = the bars that lead
 *     into a detected drop;
 *   - groove: a coarse rhythm-texture vector (proxy; not a learned groove embedding).
 */
import type { TrackAnalysis } from '../dsp/analyze'
import type { StemInfo } from './techniques'

export type RegionKind = 'intro' | 'outro' | 'breakdown' | 'build' | 'drop' | 'body'

export interface TrackProfile {
  barSec: number
  /** Track time (s) of bar 0. */
  barStart: number
  nBars: number
  /** 0..1 activity per bar. */
  bass: number[]
  mid: number[]
  high: number[]
  perc: number[]
  vocal: number[]
  vocalSource: 'stems' | 'heuristic'
  /** Mean bar energy (dB). */
  energy: number[]
  /** Normalised 12-bin chroma per bar. */
  chroma: number[][]
  region: RegionKind[]
  /** Bar indices of phrase starts (analyzer phrase boundaries, measured or grid). */
  phraseBars: number[]
  /** [startBar, endBar) runs of vocal activity, snapped to the 4-bar grid. */
  vocalPhrases: Array<[number, number]>
  /** Coarse rhythm texture (see grooveSimilarity). */
  groove: number[]
  /** Local key per bar as Camelot code ('' when unknown). */
  camelot: string[]
  durationSec: number
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
}

/** Activity relative to the track's loud bars: 0 at `rangeLog10` (log10 units) below its 95th percentile. */
function relActivity(vals: number[], rangeLog10: number): number[] {
  const top = quantile(vals, 0.95)
  return vals.map((v) => clamp01(1 - (top - v) / rangeLog10))
}

function median3(xs: number[]): number[] {
  return xs.map((_, i) => {
    const w = [xs[i - 1] ?? xs[i], xs[i], xs[i + 1] ?? xs[i]].sort((a, b) => a - b)
    return w[1]
  })
}

export function buildProfile(a: TrackAnalysis, stems?: StemInfo): TrackProfile {
  const bars = a.bars
  const n = bars.length
  const barSec = a.barSec
  const barStart = bars[0]?.startSec ?? 0
  const bass = relActivity(bars.map((b) => b.low), 1.5)
  const mid = relActivity(bars.map((b) => b.mid), 1.5)
  const high = relActivity(bars.map((b) => b.high), 1.5)
  const onTop = Math.max(1e-6, quantile(bars.map((b) => b.onsetDensity), 0.95))
  const perc = bars.map((b) => clamp01(b.onsetDensity / onTop))
  let vocal: number[]
  let vocalSource: TrackProfile['vocalSource'] = 'heuristic'
  if (stems && stems.vocalDb.length) {
    const top = quantile(stems.vocalDb.filter((d) => d > -80), 0.95)
    vocal = bars.map((b) => {
      const k = Math.floor((b.startSec - stems.barStartSec) / stems.barSec + 1e-6)
      const db = stems.vocalDb[k] ?? -90
      return clamp01(1 - (top - db) / 18)
    })
    vocalSource = 'stems'
  } else {
    // The analyzer's vocal likelihood is noisy bar to bar: smooth and soften it.
    vocal = median3(bars.map((b) => clamp01(b.vocalLikelihood))).map((v) => clamp01((v - 0.25) / 0.6))
  }
  const chroma = bars.map((b) => {
    const c = Array.from(b.chroma ?? [])
    const norm = Math.sqrt(c.reduce((p, q) => p + q * q, 0)) || 1
    return c.length === 12 ? c.map((v) => v / norm) : new Array(12).fill(0)
  })
  const region: RegionKind[] = new Array(n).fill('body')
  for (const s of a.sections) for (let k = s.startBar; k < Math.min(n, s.endBar); k++) region[k] = s.kind
  // build = up to 8 bars leading into each detected drop
  for (const s of a.sections) {
    if (s.kind !== 'drop') continue
    for (let k = Math.max(0, s.startBar - 8); k < s.startBar; k++) if (region[k] === 'breakdown' || region[k] === 'body') region[k] = 'build'
  }
  const phraseBars = [...new Set(a.phrases.map((p) => p.bar))].filter((b) => b >= 0 && b < n).sort((x, y) => x - y)
  const vocalPhrases: Array<[number, number]> = []
  for (let k = 0; k < n; ) {
    if (vocal[k] < 0.5) {
      k++
      continue
    }
    let e = k
    while (e < n && vocal[e] >= 0.35) e++
    if (e - k >= 2) vocalPhrases.push([Math.floor(k / 4) * 4, Math.min(n, Math.ceil(e / 4) * 4)])
    k = e
  }
  // merge touching runs
  const merged: Array<[number, number]> = []
  for (const r of vocalPhrases) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0)
  const sd = (xs: number[]) => {
    const m = mean(xs)
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
  }
  const body = bars.map((_, k) => k).filter((k) => region[k] !== 'breakdown' && region[k] !== 'intro' && region[k] !== 'outro')
  const pick = (xs: number[]) => (body.length ? body.map((k) => xs[k]) : xs)
  const centroid = bars.map((b) => b.centroid)
  const groove = [
    mean(pick(bars.map((b) => b.onsetDensity))) / 0.08,
    sd(pick(bars.map((b) => b.onsetDensity))) / 0.03,
    mean(pick(high)),
    mean(pick(bass)),
    mean(pick(centroid)) / 4000,
    mean(pick(vocal)),
  ]
  const camelot: string[] = new Array(n).fill(a.key?.camelot ?? '')
  const lk = [...(a.localKeys ?? [])].sort((x, y) => x.startSec - y.startSec)
  for (let k = 0; k < n; k++) {
    const t = bars[k].startSec
    let cur: string | undefined
    for (const w of lk) if (w.startSec <= t + 1e-6 && w.key.confidence >= 0.15) cur = w.key.camelot
    if (cur) camelot[k] = cur
  }
  return {
    barSec,
    barStart,
    nBars: n,
    bass,
    mid,
    high,
    perc,
    vocal,
    vocalSource,
    energy: a.energyCurve.slice(0, n),
    chroma,
    region,
    phraseBars,
    vocalPhrases: merged,
    groove,
    camelot,
    durationSec: a.qc.durationSec,
  }
}

/** Bar index containing track time `t` (may be out of range). */
export function barAt(p: TrackProfile, t: number): number {
  return Math.floor((t - p.barStart) / p.barSec + 1e-6)
}

/** Track time of bar `k`. */
export function barTime(p: TrackProfile, k: number): number {
  return p.barStart + k * p.barSec
}

/** Groove similarity 0..1 between two tracks (1 = same rhythm texture). Proxy, not learned. */
export function grooveSimilarity(a: TrackProfile, b: TrackProfile): number {
  const w = [1.2, 0.6, 0.8, 0.8, 0.6, 0.3]
  let d = 0
  let tot = 0
  for (let i = 0; i < w.length; i++) {
    d += w[i] * Math.min(1, Math.abs((a.groove[i] ?? 0) - (b.groove[i] ?? 0)))
    tot += w[i]
  }
  return 1 - d / tot
}

export interface CueCandidate {
  sec: number
  bar: number
  region: RegionKind
  /** Mean vocal activity over the 8 bars from the cue. */
  vocal: number
  /** Preference (higher = better) for this role. */
  score: number
}

/**
 * Phrase-aligned entry (role 'in') or exit (role 'out') points with their musical region:
 * intros, outros, breakdowns, builds, drops, instrumental passages, vocal sections. More than the
 * analyzer's top-4 cues so the planner can trade arrangement against compatibility.
 */
export function cueCandidates(p: TrackProfile, role: 'in' | 'out', max = 10, range?: { outFrom?: number; inTo?: number }): CueCandidate[] {
  const outFrom = range?.outFrom ?? 0.45
  const inTo = range?.inTo ?? 0.5
  const n = p.nBars
  const grid = new Set(p.phraseBars)
  for (let k = 0; k < n; k += 8) grid.add(k)
  // region starts are always candidates
  for (let k = 1; k < n; k++) if (p.region[k] !== p.region[k - 1]) grid.add(k)
  const out: CueCandidate[] = []
  for (const k of [...grid].sort((x, y) => x - y)) {
    const pos = k / Math.max(1, n)
    if (role === 'out' && (pos < outFrom || k > n - 8)) continue
    if (role === 'in' && (pos > inTo || k < 0)) continue
    const vocal = avg(p.vocal, k, k + 8)
    const r = p.region[k] ?? 'body'
    let s = 0
    if (role === 'out') {
      s += r === 'outro' ? 1.2 : r === 'breakdown' ? 0.5 : r === 'body' ? 0.4 : r === 'drop' ? -0.3 : r === 'build' ? -0.6 : 0
      s += 0.8 * pos // later is a more natural exit
      s += 0.6 * (1 - vocal) // instrumental exits layer more freely
    } else {
      s += r === 'intro' ? 1.2 : r === 'body' ? 0.4 : r === 'breakdown' ? 0.2 : r === 'build' ? 0.3 : r === 'drop' ? 0.1 : 0
      s += 0.6 * (1 - pos * 2)
      s += 0.6 * (1 - vocal)
    }
    if (p.phraseBars.includes(k)) s += 0.2
    out.push({ sec: barTime(p, k), bar: k, region: r, vocal, score: s })
  }
  out.sort((x, y) => y.score - x.score)
  return out.slice(0, max)
}

function avg(xs: number[], a: number, b: number): number {
  let s = 0
  let c = 0
  for (let k = Math.max(0, a); k < Math.min(xs.length, b); k++) {
    s += xs[k]
    c++
  }
  return c ? s / c : 0
}

export interface OverlapCompat {
  bars: number
  /** Penalties 0..1 (0 = compatible). */
  bassConflict: number
  vocalClash: number
  harmonicClash: number
  percOverload: number
  energyMismatch: number
  /** Bars at the end of the window where the outgoing has no audio left / incoming runs past 80 %. */
  outRunsOut: number
  inRunsOut: number
  /** Best bar (relative to the transition start) for the bass handoff, and where vocals can change hands. */
  bassSwapBar: number
  vocalHandoffBar: number | null
  /** Harmonic layering of melodic material is safe before the bass swap. */
  melodicLayerOk: boolean
  /** Weighted total (planner cost units, ~0..4). */
  cost: number
  /** Per-bar detail (for the long-form performance generator). */
  perBar: Array<{ bassA: number; bassB: number; vocA: number; vocB: number; percA: number; percB: number; harm: number; midA: number; midB: number; regionA: RegionKind; regionB: RegionKind }>
}

const at = (xs: number[], k: number) => (k >= 0 && k < xs.length ? xs[k] : 0)

function chromaCorr(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b) return 0.5
  let s = 0
  for (let i = 0; i < 12; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

/**
 * Bar-by-bar compatibility of a beat-matched overlap of `bars` bars (outgoing from `outSec`,
 * incoming from `inSec`): bass, vocals, percussion density, harmony (chroma correlation of the bars
 * that would play together) and energy trajectory. Returns penalties plus the handoff bars the
 * performance generator uses.
 */
export function overlapCompat(pa: TrackProfile, pb: TrackProfile, outSec: number, inSec: number, bars: number): OverlapCompat {
  const a0 = barAt(pa, outSec)
  const b0 = barAt(pb, inSec)
  const perBar: OverlapCompat['perBar'] = []
  let outRunsOut = 0
  let inRunsOut = 0
  for (let k = 0; k < bars; k++) {
    const ia = a0 + k
    const ib = b0 + k
    if (ia >= pa.nBars) outRunsOut++
    if (ib >= pb.nBars * 0.8) inRunsOut++
    perBar.push({
      bassA: at(pa.bass, ia),
      bassB: at(pb.bass, ib),
      vocA: at(pa.vocal, ia),
      vocB: at(pb.vocal, ib),
      percA: at(pa.perc, ia),
      percB: at(pb.perc, ib),
      midA: at(pa.mid, ia),
      midB: at(pb.mid, ib),
      harm: chromaCorr(pa.chroma[ia], pb.chroma[ib]),
      regionA: pa.region[ia] ?? 'outro',
      regionB: pb.region[ib] ?? 'body',
    })
  }
  // Layering weight: both decks are mostly audible in the middle of the window.
  const w = (k: number) => {
    const t = (k + 0.5) / bars
    return Math.max(0, 1 - Math.abs(t - 0.5) * 2) // triangle
  }
  // Bass handoff: candidate bars on the 4-bar grid (phrase-aligned), 25–80 % of the window.
  const phraseB = new Set(pb.phraseBars.map((x) => x - b0))
  const phraseA = new Set(pa.phraseBars.map((x) => x - a0))
  let best = { k: Math.round(bars / 2 / 4) * 4, c: Infinity }
  const lo = Math.max(4, Math.floor((bars * 0.25) / 4) * 4)
  const hi = Math.min(bars - 4, Math.ceil((bars * 0.8) / 4) * 4)
  for (let k = lo; k <= Math.max(lo, hi); k += 4) {
    // incoming must carry bass after the swap; outgoing should still carry it before
    let missIn = 0
    let missOut = 0
    for (let j = k; j < bars; j++) missIn += 1 - perBar[j].bassB
    for (let j = Math.max(0, k - 4); j < k; j++) missOut += 1 - perBar[j].bassA
    missIn /= Math.max(1, bars - k)
    missOut /= 4
    let c = 1.5 * missIn + 0.5 * missOut + 0.3 * Math.abs(k / bars - 0.5)
    if (phraseB.has(k)) c -= 0.25
    if (phraseA.has(k)) c -= 0.1
    if (perBar[k]?.regionB === 'drop') c -= 0.35
    if (c < best.c) best = { k, c }
  }
  const bassSwapBar = best.k
  const bassConflict = clamp01(best.c)
  // Vocals: clash = both vocals audible where both decks are layered; a handoff bar exists when the
  // outgoing vocal ends before the incoming's starts (within the window).
  let vocalClash = 0
  let wsum = 0
  for (let k = 0; k < bars; k++) {
    vocalClash += w(k) * perBar[k].vocA * perBar[k].vocB
    wsum += w(k)
  }
  vocalClash = wsum ? clamp01((vocalClash / wsum) * 2.2) : 0
  let vocalHandoffBar: number | null = null
  const lastA = lastIndex(perBar, (x) => x.vocA >= 0.5)
  const firstB = perBar.findIndex((x) => x.vocB >= 0.5)
  if (lastA >= 0 || firstB >= 0) {
    if (lastA < 0) vocalHandoffBar = Math.max(0, Math.floor(firstB / 4) * 4)
    else if (firstB < 0) vocalHandoffBar = Math.min(bars, Math.ceil((lastA + 1) / 4) * 4)
    else if (lastA < firstB) vocalHandoffBar = Math.ceil((lastA + 1) / 4) * 4
    else vocalHandoffBar = null // overlapping vocal phrases → needs a mute / echo-out / stems
  }
  // Harmony: chroma correlation over the bars both decks carry melodic content.
  let hsum = 0
  let hw = 0
  for (let k = 0; k < bars; k++) {
    const m = w(k) * Math.min(perBar[k].midA, perBar[k].midB)
    hsum += m * perBar[k].harm
    hw += m
  }
  const harmMean = hw > 1e-6 ? hsum / hw : 0.7
  const harmonicClash = clamp01((0.8 - harmMean) / 0.5)
  let perc = 0
  for (let k = 0; k < bars; k++) perc += w(k) * Math.max(0, perBar[k].percA + perBar[k].percB - 1.5)
  const percOverload = wsum ? clamp01((perc / wsum) * 2) : 0
  // Energy: incoming should arrive at a level that carries the floor after the outgoing leaves.
  const eA = avg(pa.energy, a0 - 8, a0)
  const eB = avg(pb.energy, b0 + bars, b0 + bars + 8)
  const energyMismatch = clamp01((Math.abs(eA - eB) - 3) / 9)
  const cost =
    1.2 * bassConflict +
    1.6 * vocalClash +
    1.0 * harmonicClash +
    0.4 * percOverload +
    0.5 * energyMismatch +
    0.25 * outRunsOut +
    0.25 * inRunsOut
  return {
    bars,
    bassConflict,
    vocalClash,
    harmonicClash,
    percOverload,
    energyMismatch,
    outRunsOut,
    inRunsOut,
    bassSwapBar,
    vocalHandoffBar,
    melodicLayerOk: harmonicClash < 0.35,
    cost,
    perBar,
  }
}

function lastIndex<T>(xs: T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i])) return i
  return -1
}
