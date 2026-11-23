/**
 * Bar-synchronous structure analysis.
 *
 * - Bar features: log band energies, chroma, onset density, centroid.
 * - Novelty: Foote checkerboard kernel over the bar self-similarity matrix.
 * - Phrase boundaries: novelty peaks, with a prior favouring 8/16/32-bar spacing
 *   from the first downbeat (dance-music phrasing); grid-only boundaries are
 *   marked as such, so the UI never presents a guessed boundary as measured.
 * - Sections: intro/outro (drum-led, low harmonic energy), breakdown (sustained
 *   low-band drop of ≥ 6 dB for ≥ 8 bars), drop (low-band return after a
 *   breakdown). Labelled only when the energy evidence exists.
 * - Vocal activity: a HEURISTIC (mid-band tonality + centroid); flagged as such.
 */
import type { FrameFeatures } from './features'

export interface Bar {
  index: number
  startSec: number
  /** log10 band energies */
  low: number
  mid: number
  high: number
  onsetDensity: number
  centroid: number
  chroma: Float64Array
  /** Heuristic 0..1 */
  vocalLikelihood: number
  energy: number
}

export interface PhraseBoundary {
  bar: number
  sec: number
  novelty: number
  /** 'measured' = novelty peak; 'grid' = phrase-grid position without strong evidence. */
  evidence: 'measured' | 'grid'
}

export type SectionKind = 'intro' | 'body' | 'breakdown' | 'drop' | 'outro'

export interface Section {
  kind: SectionKind
  startBar: number
  endBar: number // exclusive
  startSec: number
  endSec: number
}

export interface CueCandidate {
  sec: number
  bar: number
  kind: 'mix_in' | 'mix_out'
  score: number
  reason: string
}

export interface Structure {
  bars: Bar[]
  barSec: number
  novelty: Float32Array
  phrases: PhraseBoundary[]
  sections: Section[]
  cues: CueCandidate[]
  vocalHeuristic: true
}

export function barFeatures(
  feats: FrameFeatures,
  onsetNorm: Float32Array,
  grid: { firstBeatSec: number; periodSec: number; downbeatPhase: number; beatCount: number },
): { bars: Bar[]; barSec: number } {
  const frameSec = feats.hop / feats.sampleRate
  const barSec = grid.periodSec * 4
  const firstDownbeat = grid.firstBeatSec + grid.downbeatPhase * grid.periodSec
  const bars: Bar[] = []
  const totalSec = feats.frames * frameSec
  for (let b = 0; ; b++) {
    const start = firstDownbeat + b * barSec
    const end = start + barSec
    if (end > totalSec + 1e-6) break
    const fa = Math.max(0, Math.round(start / frameSec))
    const fb = Math.min(feats.frames, Math.round(end / frameSec))
    if (fb <= fa) break
    let lo = 0
    let md = 0
    let hi = 0
    let on = 0
    let cen = 0
    let flat = 0
    let r = 0
    const chroma = new Float64Array(12)
    for (let f = fa; f < fb; f++) {
      lo += feats.low[f]
      md += feats.mid[f]
      hi += feats.high[f]
      on += onsetNorm[f]
      cen += feats.centroid[f]
      flat += feats.flatnessMid[f]
      r += feats.rms[f] * feats.rms[f]
      for (let p = 0; p < 12; p++) chroma[p] += feats.chroma[f * 12 + p]
    }
    const n = fb - fa
    const tonal = 1 - flat / n
    const midShare = md / Math.max(1e-12, lo + md + hi)
    const centroidHz = cen / n
    // Heuristic vocal likelihood: tonal mid band, centroid in the voice formant region.
    const formant = Math.exp(-0.5 * ((centroidHz - 1800) / 900) ** 2)
    bars.push({
      index: b,
      startSec: start,
      low: Math.log10(1e-10 + lo / n),
      mid: Math.log10(1e-10 + md / n),
      high: Math.log10(1e-10 + hi / n),
      onsetDensity: on / n,
      centroid: centroidHz,
      chroma: chroma.map((v) => v / n),
      vocalLikelihood: Math.max(0, Math.min(1, tonal * midShare * formant * 2.5)),
      energy: 10 * Math.log10(1e-12 + r / n),
    })
  }
  return { bars, barSec }
}

function barVector(b: Bar): number[] {
  return [b.low, b.mid, b.high, b.onsetDensity * 10, b.centroid / 2000, ...Array.from(b.chroma, (v) => v * 4)]
}

export function noveltyCurve(bars: Bar[], half = 4): Float32Array {
  const n = bars.length
  const vecs = bars.map(barVector)
  // z-normalise each dimension
  const d = vecs[0]?.length ?? 0
  for (let k = 0; k < d; k++) {
    let m = 0
    for (const v of vecs) m += v[k]
    m /= n || 1
    let s = 0
    for (const v of vecs) s += (v[k] - m) ** 2
    s = Math.sqrt(s / (n || 1)) || 1
    for (const v of vecs) v[k] = (v[k] - m) / s
  }
  const sim = (i: number, j: number) => {
    let acc = 0
    for (let k = 0; k < d; k++) acc += (vecs[i][k] - vecs[j][k]) ** 2
    return Math.exp(-acc / (2 * d))
  }
  const nov = new Float32Array(n)
  for (let c = 0; c < n; c++) {
    let acc = 0
    for (let i = -half; i < half; i++) {
      for (let j = -half; j < half; j++) {
        const a = c + i
        const b = c + j
        if (a < 0 || b < 0 || a >= n || b >= n) continue
        const sign = (i < 0) === (j < 0) ? 1 : -1
        const w = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * (half / 2) ** 2))
        acc += sign * w * sim(a, b)
      }
    }
    nov[c] = Math.max(0, acc)
  }
  let max = 0
  for (const v of nov) max = Math.max(max, v)
  if (max > 0) for (let i = 0; i < n; i++) nov[i] /= max
  return nov
}

export function phraseBoundaries(bars: Bar[], novelty: Float32Array): PhraseBoundary[] {
  const out: PhraseBoundary[] = []
  const n = bars.length
  const peaks = new Set<number>()
  for (let i = 1; i < n - 1; i++) {
    if (novelty[i] >= 0.25 && novelty[i] >= novelty[i - 1] && novelty[i] >= novelty[i + 1]) {
      // snap to the nearest 4-bar boundary if within 1 bar (phrase prior)
      const snapped = Math.round(i / 4) * 4
      peaks.add(Math.abs(snapped - i) <= 1 ? snapped : i)
    }
  }
  for (let b = 0; b < n; b += 8) {
    const measured = peaks.has(b)
    out.push({ bar: b, sec: bars[b].startSec, novelty: novelty[b] ?? 0, evidence: measured ? 'measured' : 'grid' })
    peaks.delete(b)
  }
  for (const p of peaks) if (p < n) out.push({ bar: p, sec: bars[p].startSec, novelty: novelty[p], evidence: 'measured' })
  return out.sort((a, b) => a.bar - b.bar)
}

export function sections(bars: Bar[], barSec: number): Section[] {
  const n = bars.length
  if (n < 8) return n ? [{ kind: 'body', startBar: 0, endBar: n, startSec: bars[0].startSec, endSec: bars[0].startSec + n * barSec }] : []
  const lows = bars.map((b) => b.low)
  const sorted = [...lows].sort((a, b) => a - b)
  const loudLow = sorted[Math.floor(0.8 * (n - 1))]
  const dropDb = 0.6 // 6 dB in log10 power units
  const isLowDip = lows.map((l) => l < loudLow - dropDb)
  const kinds: SectionKind[] = new Array(n).fill('body')
  // intro: leading bars where low band is weak or the harmonic content is low; stop at first full-energy bar
  let introEnd = 0
  while (introEnd < n && isLowDip[introEnd]) introEnd++
  // also treat drum-only intros: mid-band below median for the first phrases
  const mids = bars.map((b) => b.mid)
  const midMed = [...mids].sort((a, b) => a - b)[Math.floor(n / 2)]
  let drumIntro = 0
  while (drumIntro < Math.min(n, 64) && mids[drumIntro] < midMed - 0.3) drumIntro++
  introEnd = Math.max(introEnd, Math.floor(drumIntro / 8) * 8)
  for (let i = 0; i < introEnd; i++) kinds[i] = 'intro'
  let outroStart = n
  while (outroStart > introEnd && isLowDip[outroStart - 1]) outroStart--
  let drumOutro = n
  while (drumOutro > introEnd && n - drumOutro < 64 && mids[drumOutro - 1] < midMed - 0.3) drumOutro--
  outroStart = Math.min(outroStart, n - Math.floor((n - drumOutro) / 8) * 8)
  for (let i = outroStart; i < n; i++) kinds[i] = 'outro'
  // breakdowns: runs of ≥ 8 dip bars between intro and outro
  let i = introEnd
  while (i < outroStart) {
    if (!isLowDip[i]) {
      i++
      continue
    }
    let j = i
    while (j < outroStart && isLowDip[j]) j++
    if (j - i >= 8) {
      for (let k = i; k < j; k++) kinds[k] = 'breakdown'
      for (let k = j; k < Math.min(outroStart, j + 8); k++) kinds[k] = 'drop'
    }
    i = j
  }
  const out: Section[] = []
  let start = 0
  for (let b = 1; b <= n; b++) {
    if (b === n || kinds[b] !== kinds[start]) {
      out.push({ kind: kinds[start], startBar: start, endBar: b, startSec: bars[start].startSec, endSec: bars[start].startSec + (b - start) * barSec })
      start = b
    }
  }
  return out
}

/**
 * Cue candidates. Mix-in: phrase starts in the first ~35% of the track, preferring
 * the first downbeat and drum-led intros (low harmonic + vocal content). Mix-out:
 * phrase starts in the final ~40%, preferring the outro and leaving ≥ 16 bars.
 */
export function cueCandidates(bars: Bar[], phrases: PhraseBoundary[], secs: Section[], barSec: number): CueCandidate[] {
  const n = bars.length
  if (!n) return []
  const out: CueCandidate[] = []
  const kindAt = (bar: number) => secs.find((s) => bar >= s.startBar && bar < s.endBar)?.kind ?? 'body'
  const outroStart = secs.find((s) => s.kind === 'outro')?.startBar ?? n
  for (const p of phrases) {
    const frac = p.bar / n
    if (frac <= 0.35) {
      const k = kindAt(p.bar)
      const vocals = avg(bars.slice(p.bar, p.bar + 8).map((b) => b.vocalLikelihood))
      let score = 0.5 + (k === 'intro' ? 0.25 : 0) + (p.bar === 0 ? 0.15 : 0) + (p.evidence === 'measured' ? 0.1 : 0) - vocals * 0.3 - frac * 0.4
      score = clamp01(score)
      out.push({ sec: p.sec, bar: p.bar, kind: 'mix_in', score, reason: `${k}${p.evidence === 'measured' ? ', phrase change measured' : ', phrase grid'}${vocals > 0.4 ? ', vocal-like content (heuristic)' : ''}` })
    }
    if (frac >= 0.6 && n - p.bar >= 8) {
      const k = kindAt(p.bar)
      const nearOutro = p.bar >= outroStart - 8
      const remaining = (n - p.bar) * barSec
      let score = 0.45 + (k === 'outro' ? 0.3 : 0) + (nearOutro ? 0.1 : 0) + (p.evidence === 'measured' ? 0.1 : 0) - (k === 'breakdown' ? 0.2 : 0)
      score = clamp01(score)
      out.push({ sec: p.sec, bar: p.bar, kind: 'mix_out', score, reason: `${k}, ${Math.round(remaining)} s remain${p.evidence === 'measured' ? ', phrase change measured' : ''}` })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
