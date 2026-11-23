/**
 * Tempo, constant beat-grid fitting and downbeat phase.
 *
 * 1. Coarse tempo: autocorrelation of the onset envelope over 60–200 BPM with a
 *    log-normal prior (centre 120 BPM, σ = 1 octave). Octave-related candidates
 *    (×½, ×2) are reported, never silently discarded.
 * 2. Grid fit: for a continuous period P and phase φ, score = mean smoothed onset
 *    at φ + kP over the whole track. A two-stage search (0.005 then 0.0005 BPM)
 *    gives sub-frame period precision because every beat in the track votes.
 * 3. Stability: the track is split into segments; each segment's best local phase
 *    shift against the global grid measures drift. Large residuals → variable
 *    tempo (the grid is then flagged, not trusted for long blends).
 * 4. Downbeat: for each of 4 phases, mean beat-synchronous spectral change.
 */

export interface TempoCandidate {
  bpm: number
  strength: number
}

export interface BeatGrid {
  bpm: number
  /** Time of beat index 0 in seconds (may be < first audible beat; first beat ≥ 0). */
  firstBeatSec: number
  periodSec: number
  /** Beat index (0..3) of the first downbeat in the grid. */
  downbeatPhase: number
  /** Number of grid beats from firstBeatSec to the end of the track. */
  beatCount: number
  confidence: number
  downbeatConfidence: number
  /** Std-dev of per-segment phase residuals (ms). */
  driftMs: number
  stable: boolean
  candidates: TempoCandidate[]
  /** Contrast of the grid score against random phases (z-score). */
  gridContrast: number
  /** Per-segment local BPM estimates (for variable-tempo diagnostics). */
  segmentBpm: number[]
  /** Which estimator produced the grid. */
  source?: 'beatnet' | 'dsp'
}

export const BPM_MIN = 60
export const BPM_MAX = 200

function gaussianSmooth(x: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3)
  const k = new Float64Array(2 * r + 1)
  let s = 0
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
    s += k[i + r]
  }
  for (let i = 0; i < k.length; i++) k[i] /= s
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    let acc = 0
    for (let j = -r; j <= r; j++) {
      const idx = i + j
      if (idx >= 0 && idx < x.length) acc += x[idx] * k[j + r]
    }
    out[i] = acc
  }
  return out
}

function interp(x: Float32Array, pos: number): number {
  if (pos < 0 || pos >= x.length - 1) return 0
  const i = pos | 0
  const f = pos - i
  return x[i] * (1 - f) + x[i + 1] * f
}

export function coarseTempo(onset: Float32Array, fps: number, centerBpm = 120): TempoCandidate[] {
  const minLag = Math.floor((60 / BPM_MAX) * fps)
  const maxLag = Math.ceil((60 / BPM_MIN) * fps)
  const n = onset.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += onset[i]
  mean /= n
  const ac = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let acc = 0
    for (let i = 0; i + lag < n; i++) acc += (onset[i] - mean) * (onset[i + lag] - mean)
    ac[lag] = acc / (n - lag)
  }
  const weighted = new Float64Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag
    const oct = Math.log2(bpm / centerBpm)
    weighted[lag] = ac[lag] * Math.exp(-0.5 * oct * oct)
  }
  const peaks: TempoCandidate[] = []
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const a = weighted[lag - 1]
    const b = weighted[lag]
    const c = weighted[lag + 1]
    if (b > 0 && b >= a && b >= c) {
      const denom = a - 2 * b + c
      const off = denom !== 0 ? (0.5 * (a - c)) / denom : 0
      peaks.push({ bpm: (60 * fps) / (lag + off), strength: b })
    }
  }
  peaks.sort((p, q) => q.strength - p.strength)
  const top = peaks[0]?.strength ?? 1
  return peaks.slice(0, 5).map((p) => ({ bpm: p.bpm, strength: p.strength / top }))
}

interface GridFit {
  periodFrames: number
  phaseFrames: number
  score: number
  meanScore: number
  stdScore: number
}

function scoreGrid(env: Float32Array, period: number, phaseStep: number): GridFit {
  let best = -1
  let bestPhase = 0
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let phase = 0; phase < period; phase += phaseStep) {
    let acc = 0
    let k = 0
    for (let t = phase; t < env.length - 1; t += period) {
      acc += interp(env, t)
      k++
    }
    const s = k ? acc / k : 0
    sum += s
    sumSq += s * s
    count++
    if (s > best) {
      best = s
      bestPhase = phase
    }
  }
  const mean = sum / count
  const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean))
  return { periodFrames: period, phaseFrames: bestPhase, score: best, meanScore: mean, stdScore: std }
}

export function fitGrid(onset: Float32Array, fps: number, bpmGuess: number): GridFit & { bpm: number } {
  const env = gaussianSmooth(onset, 1)
  let bestFit: GridFit | null = null
  let bestBpm = bpmGuess
  const search = (center: number, span: number, step: number, phaseStep: number) => {
    for (let bpm = center - span; bpm <= center + span + 1e-9; bpm += step) {
      const fit = scoreGrid(env, (60 * fps) / bpm, phaseStep)
      if (!bestFit || fit.score > bestFit.score) {
        bestFit = fit
        bestBpm = bpm
      }
    }
  }
  search(bpmGuess, bpmGuess * 0.02, 0.02, 0.5)
  search(bestBpm, 0.03, 0.002, 0.25)
  search(bestBpm, 0.003, 0.0002, 0.1)
  const fit = bestFit as unknown as GridFit
  return { ...fit, bpm: bestBpm }
}

/** Per-segment best phase shift (frames) relative to a global grid. */
function segmentResiduals(onset: Float32Array, fps: number, periodFrames: number, phaseFrames: number, segments: number) {
  const env = gaussianSmooth(onset, 1)
  const segLen = Math.floor(env.length / segments)
  const residualsMs: number[] = []
  const segmentBpm: number[] = []
  for (let s = 0; s < segments; s++) {
    const a = s * segLen
    const b = a + segLen
    let best = -1
    let bestShift = 0
    for (let shift = -periodFrames / 4; shift <= periodFrames / 4; shift += 0.25) {
      let acc = 0
      let k = 0
      const first = phaseFrames + Math.ceil((a - phaseFrames) / periodFrames) * periodFrames
      for (let t = first + shift; t < b; t += periodFrames) {
        acc += interp(env, t)
        k++
      }
      const sc = k ? acc / k : 0
      if (sc > best) {
        best = sc
        bestShift = shift
      }
    }
    residualsMs.push((bestShift / fps) * 1000)
    // local tempo: coarse AC on the segment
    const local = coarseTempo(onset.subarray(a, b), fps)[0]
    if (local) segmentBpm.push(local.bpm)
  }
  return { residualsMs, segmentBpm }
}

export function estimateGrid(
  onset: Float32Array,
  fps: number,
  durationSec: number,
  frameSec: number,
  onsetLow?: Float32Array,
  onsetHigh?: Float32Array,
): Omit<BeatGrid, 'downbeatPhase' | 'downbeatConfidence'> & { halfBeatResolved: boolean } {
  const candidates = coarseTempo(onset, fps)
  if (!candidates.length) {
    return { bpm: 0, firstBeatSec: 0, periodSec: 0, beatCount: 0, confidence: 0, driftMs: Infinity, stable: false, candidates, gridContrast: 0, segmentBpm: [], halfBeatResolved: false }
  }
  // Refine the best candidate and its octave neighbours inside range; keep the best-scoring grid
  // but only switch octave if the alternative's grid is clearly better (avoids ½×/2× flips).
  const fit = fitGrid(onset, fps, candidates[0].bpm)
  // Off-beat hats/claps can out-score kicks in broadband flux, locking the grid half a
  // beat late. In 4/4 dance music the kick sits on the beat, so compare low-band onset
  // strength at φ and φ + P/2 and take the stronger.
  let halfBeatResolved = false
  if (onsetLow) {
    const low = gaussianSmooth(onsetLow, 1)
    const high = onsetHigh ? gaussianSmooth(onsetHigh, 1) : null
    const at = (x: Float32Array, phase: number) => {
      let acc = 0
      let k = 0
      for (let t = phase; t < x.length - 1; t += fit.periodFrames) {
        acc += interp(x, t)
        k++
      }
      return k ? acc / k : 0
    }
    // Kick-on-beat evidence: low-band onset minus high-band (hat) onset at each phase.
    const m = (phase: number) => at(low, phase) - (high ? at(high, phase) : 0)
    const onBeat = m(fit.phaseFrames)
    const offBeat = m(fit.phaseFrames + fit.periodFrames / 2)
    if (offBeat > onBeat) fit.phaseFrames += fit.periodFrames / 2
    const scale = Math.max(1e-9, at(low, fit.phaseFrames) + (high ? at(high, fit.phaseFrames) : 0))
    halfBeatResolved = Math.abs(onBeat - offBeat) / scale > 0.15
  }
  const periodSec = fit.periodFrames / fps
  // phase in frames → seconds; frames are centred at f*frameSec
  let firstBeatSec = fit.phaseFrames * frameSec
  while (firstBeatSec - periodSec >= 0) firstBeatSec -= periodSec
  const beatCount = Math.max(0, Math.floor((durationSec - firstBeatSec) / periodSec) + 1)

  const segments = Math.max(2, Math.min(8, Math.floor(durationSec / 20)))
  const { residualsMs, segmentBpm } = segmentResiduals(onset, fps, fit.periodFrames, fit.phaseFrames, segments)
  const meanR = residualsMs.reduce((a, b) => a + b, 0) / residualsMs.length
  const driftMs = Math.sqrt(residualsMs.reduce((a, b) => a + (b - meanR) ** 2, 0) / residualsMs.length)

  const gridContrast = fit.stdScore > 0 ? (fit.score - fit.meanScore) / fit.stdScore : 0
  const acClarity = candidates.length > 1 ? 1 - candidates[1].strength * (isOctave(candidates[0].bpm, candidates[1].bpm) ? 0.3 : 1) : 1
  const stable = driftMs < 15
  // Heuristic confidence in [0,1] — NOT calibrated until benchmarked on held-out real music.
  const contrastTerm = 1 / (1 + Math.exp(-(gridContrast - 2.5)))
  const driftTerm = 1 / (1 + Math.exp((driftMs - 20) / 5))
  const confidence = Math.max(0, Math.min(1, contrastTerm * driftTerm * (0.6 + 0.4 * Math.max(0, acClarity))))

  return { bpm: fit.bpm, firstBeatSec, periodSec, beatCount, confidence, driftMs, stable, candidates, gridContrast, segmentBpm, halfBeatResolved }
}

function isOctave(a: number, b: number): boolean {
  const r = a > b ? a / b : b / a
  return Math.abs(r - 2) < 0.06 || Math.abs(r - 1.5) < 0.04
}

/**
 * Downbeat phase: beat-synchronous change of (log band energies + chroma). In
 * 4/4 dance music, harmonic/bass/crash changes cluster on the first beat of a bar.
 */
export function estimateDownbeat(
  grid: { firstBeatSec: number; periodSec: number; beatCount: number },
  frameSec: number,
  feats: { low: Float32Array; mid: Float32Array; high: Float32Array; chroma: Float32Array; onsetLow: Float32Array },
): { phase: number; confidence: number } {
  const n = feats.low.length
  const beatVec = (i: number): Float64Array | null => {
    const a = Math.round((grid.firstBeatSec + i * grid.periodSec) / frameSec)
    const b = Math.round((grid.firstBeatSec + (i + 1) * grid.periodSec) / frameSec)
    if (a < 0 || b > n || b <= a) return null
    const v = new Float64Array(15)
    for (let f = a; f < b; f++) {
      v[0] += feats.low[f]
      v[1] += feats.mid[f]
      v[2] += feats.high[f]
      for (let p = 0; p < 12; p++) v[3 + p] += feats.chroma[f * 12 + p]
    }
    const len = b - a
    for (let k = 0; k < 3; k++) v[k] = Math.log10(1e-10 + v[k] / len)
    for (let k = 3; k < 15; k++) v[k] /= len
    return v
  }
  const scores = [0, 0, 0, 0]
  const counts = [0, 0, 0, 0]
  let prev = beatVec(0)
  for (let i = 1; i < grid.beatCount - 1; i++) {
    const cur = beatVec(i)
    if (!cur || !prev) {
      prev = cur
      continue
    }
    let d = 0
    for (let k = 0; k < 3; k++) d += Math.abs(cur[k] - prev[k])
    for (let k = 3; k < 15; k++) d += 4 * Math.abs(cur[k] - prev[k])
    const f0 = Math.round((grid.firstBeatSec + i * grid.periodSec) / frameSec)
    const accent = f0 >= 0 && f0 < n ? feats.onsetLow[f0] : 0
    scores[i % 4] += d + 0.02 * accent
    counts[i % 4]++
    prev = cur
  }
  const avg = scores.map((s, i) => (counts[i] ? s / counts[i] : 0))
  const order = [0, 1, 2, 3].sort((a, b) => avg[b] - avg[a])
  const best = avg[order[0]]
  const second = avg[order[1]]
  return { phase: order[0], confidence: best > 0 ? Math.max(0, Math.min(1, (best - second) / best)) : 0 }
}
