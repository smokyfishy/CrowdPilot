/**
 * Beat This! (CPJKU, MIT licence; small0 checkpoint) in TypeScript: exact log-mel front-end,
 * chunked ONNX inference and the reference "minimal" postprocessor, plus a hybrid grid
 * builder that turns network beats/downbeats into a DJ-usable constant grid with separate
 * confidences. The ONNX session is injected so the same code runs with onnxruntime-web
 * (browser worker) and onnxruntime-node (validation tests).
 *
 * Reference (Python): beat_this.preprocessing.LogMelSpect, inference.split_predict_aggregate,
 * model.postprocessor.Postprocessor(type="minimal").
 */
import { fft, hann } from './fft'

export const BEATNET_SR = 22050
export const BEATNET_FPS = 50
const N_FFT = 1024
const HOP = 441
const CHUNK = 1500
const BORDER = 6

export interface MelBank {
  n_mels: number
  window_norm: number
  log_multiplier: number
  fb: number[][] // n_mels × (N_FFT/2+1)
}

/** torchaudio MelSpectrogram(center=True, pad_mode="reflect", power=1, normalized="frame_length") → log1p(1000·x). */
export function logMel(x: Float32Array, bank: MelBank): { data: Float32Array; frames: number } {
  const pad = N_FFT / 2
  const n = x.length
  const at = (i: number) => {
    // reflect padding (no edge repeat), as torch.stft(center=True, pad_mode="reflect")
    let j = i
    if (j < 0) j = -j
    if (j >= n) j = 2 * (n - 1) - j
    return x[Math.max(0, Math.min(n - 1, j))]
  }
  const frames = Math.floor(n / HOP) + 1
  const win = hann(N_FFT)
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  const bins = N_FFT / 2 + 1
  const mag = new Float64Array(bins)
  const M = bank.n_mels
  const out = new Float32Array(frames * M)
  const fb = bank.fb.map((r) => Float64Array.from(r))
  const nz = fb.map((r) => {
    let a = 0
    while (a < bins && r[a] === 0) a++
    let b = bins - 1
    while (b > a && r[b] === 0) b--
    return [a, b] as const
  })
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - pad
    for (let i = 0; i < N_FFT; i++) {
      re[i] = at(start + i) * win[i]
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]) / bank.window_norm
    for (let m = 0; m < M; m++) {
      const [a, b] = nz[m]
      let s = 0
      for (let k = a; k <= b; k++) s += fb[m][k] * mag[k]
      out[f * M + m] = Math.log1p(bank.log_multiplier * s)
    }
  }
  return { data: out, frames }
}

/** Minimal ONNX session interface (onnxruntime-web / onnxruntime-node both satisfy it via an adapter). */
export type BeatNetRunner = (spect: Float32Array, frames: number, mels: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>

/** split_predict_aggregate(chunk_size=1500, border_size=6, avoid_short_end=True). */
export async function predictFrames(spect: Float32Array, frames: number, mels: number, run: BeatNetRunner): Promise<{ beat: Float32Array; downbeat: Float32Array }> {
  const starts: number[] = []
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s)
  if (frames > CHUNK - 2 * BORDER && starts.length) starts[starts.length - 1] = frames - (CHUNK - BORDER)
  const beat = new Float32Array(frames).fill(-1000)
  const down = new Float32Array(frames).fill(-1000)
  for (const start of starts) {
    const a = Math.max(start, 0)
    const b = Math.min(start + CHUNK, frames)
    const left = Math.max(0, -start)
    const right = Math.max(0, Math.min(BORDER, start + CHUNK - frames))
    const len = left + (b - a) + right
    const chunk = new Float32Array(len * mels) // zero padding left/right
    chunk.set(spect.subarray(a * mels, b * mels), left * mels)
    const p = await run(chunk, len, mels)
    // discard BORDER frames on both sides; write into [start+BORDER, start+len-BORDER)
    for (let i = BORDER; i < len - BORDER; i++) {
      const t = start + i
      if (t < 0 || t >= frames) continue
      beat[t] = p.beat[i]
      down[t] = p.downbeat[i]
    }
  }
  return { beat, downbeat: down }
}

function peaks(logits: Float32Array): number[] {
  const out: number[] = []
  for (let t = 0; t < logits.length; t++) {
    let m = -Infinity
    for (let k = Math.max(0, t - 3); k <= Math.min(logits.length - 1, t + 3); k++) m = Math.max(m, logits[k])
    if (logits[t] === m && logits[t] > 0) out.push(t)
  }
  // deduplicate_peaks(width=1): average runs of adjacent frames
  const res: number[] = []
  let p = out[0]
  let c = 1
  for (let i = 1; i < out.length; i++) {
    if (out[i] - p <= 1) {
      c++
      p += (out[i] - p) / c
    } else {
      res.push(p)
      p = out[i]
      c = 1
    }
  }
  if (out.length) res.push(p)
  return res
}

/** Postprocessor(type="minimal"): peaks → seconds; downbeats snapped to the nearest beat, unique. */
export function postprocess(beatLogits: Float32Array, downLogits: Float32Array): { beats: number[]; downbeats: number[] } {
  const beats = peaks(beatLogits).map((f) => f / BEATNET_FPS)
  let downbeats = peaks(downLogits).map((f) => f / BEATNET_FPS)
  if (beats.length) {
    downbeats = downbeats.map((d) => {
      let best = beats[0]
      for (const b of beats) if (Math.abs(b - d) < Math.abs(best - d)) best = b
      return best
    })
    downbeats = [...new Set(downbeats)].sort((a, b) => a - b)
  }
  return { beats, downbeats }
}

export async function runBeatNet(mono22050: Float32Array, bank: MelBank, run: BeatNetRunner): Promise<{ beats: number[]; downbeats: number[]; frames: number }> {
  const { data, frames } = logMel(mono22050, bank)
  const p = await predictFrames(data, frames, bank.n_mels, run)
  return { ...postprocess(p.beat, p.downbeat), frames }
}

// ───────────────────────── hybrid grid from network beats ─────────────────────────

export interface NetGrid {
  bpm: number
  periodSec: number
  firstBeatSec: number
  beatCount: number
  downbeatPhase: number
  tempoConfidence: number
  beatConfidence: number
  downbeatConfidence: number
  driftMs: number
  stable: boolean
  /** Fraction of the track where the network found beats (breakdowns lower this). */
  coverage: number
}

/**
 * Constant DJ grid from network beats: period from the median inter-beat interval of the
 * steady region, refined by least squares on integer beat indices; residuals → drift/stability.
 * Breakdowns without beats do not corrupt the grid (indices bridge gaps by rounding).
 * Downbeat phase = majority beat-index class (mod 4) of network downbeats.
 */
export function gridFromBeats(beats: number[], downbeats: number[], durationSec: number): NetGrid | null {
  if (beats.length < 16) return null
  const ibi = beats.slice(1).map((b, i) => b - beats[i])
  const plaus = ibi.filter((d) => d > 0.3 && d < 1.0).sort((a, b) => a - b)
  if (plaus.length < 8) return null
  let period = plaus[Math.floor(plaus.length / 2)]
  // steady beats: both neighbouring intervals within ±6 % of the period (drops sparse intro
  // detections, fills and breakdown edges, which would otherwise corrupt the fit)
  const steady = (P: number) =>
    beats.filter((_, i) => {
      const l = i > 0 ? beats[i] - beats[i - 1] : NaN
      const r = i + 1 < beats.length ? beats[i + 1] - beats[i] : NaN
      return [l, r].some((d) => Number.isFinite(d) && Math.abs(d - P) / P < 0.06)
    })
  let st = steady(period)
  if (st.length < 12) return null
  // phase by circular mean (robust to gaps — no index rounding across breakdowns)
  const circ = (P: number, xs: number[]) => {
    let c = 0
    let s2 = 0
    for (const b of xs) {
      const ang = (2 * Math.PI * (b % P)) / P
      c += Math.cos(ang)
      s2 += Math.sin(ang)
    }
    return { phase: ((Math.atan2(s2, c) / (2 * Math.PI)) * P + P) % P, r: Math.hypot(c, s2) / xs.length }
  }
  // Cumulative beat indexing: k_i = k_{i−1} + round(Δt / P). Unlike rounding (t − t0)/P, this
  // stays correct over a whole track (tiny period errors don't accumulate into index errors)
  // and across breakdown gaps. Then least squares with outlier rejection, iterated.
  let t0 = circ(period, st).phase
  for (let pass = 0; pass < 3; pass++) {
    const ks: number[] = [0]
    for (let i = 1; i < st.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((st[i] - st[i - 1]) / period)))
    let keep = st.map((_, i) => i)
    for (let it2 = 0; it2 < 3; it2++) {
      const n = keep.length
      if (n < 12) break
      let sx = 0, sy = 0, sxx = 0, sxy = 0
      for (const i of keep) {
        sx += ks[i]
        sy += st[i]
        sxx += ks[i] * ks[i]
        sxy += ks[i] * st[i]
      }
      const den = n * sxx - sx * sx
      if (den === 0) break
      period = (n * sxy - sx * sy) / den
      t0 = (sy - period * sx) / n
      keep = keep.filter((i) => Math.abs(st[i] - (t0 + ks[i] * period)) < period / 6)
    }
    st = steady(period)
  }
  const firstBeat = ((t0 % period) + period) % period
  const resid = st.map((b) => {
    const k = Math.round((b - firstBeat) / period)
    return b - (firstBeat + k * period)
  })
  const absRes = resid.map(Math.abs).sort((a, b) => a - b)
  const medRes = absRes.length ? absRes[Math.floor(absRes.length / 2)] : 1
  // drift: circular phase per quarter of the track vs the global grid
  const seg: number[] = []
  for (let q = 0; q < 4; q++) {
    const xs = st.filter((b) => b >= (q * durationSec) / 4 && b < ((q + 1) * durationSec) / 4)
    if (xs.length >= 8) {
      let d = circ(period, xs).phase - firstBeat
      if (d > period / 2) d -= period
      if (d < -period / 2) d += period
      seg.push(d)
    }
  }
  const driftMs = seg.length > 1 ? (Math.max(...seg) - Math.min(...seg)) * 1000 : 0
  const inTol = ibi.filter((d) => Math.abs(d - period) / period < 0.05).length / ibi.length
  const counts = [0, 0, 0, 0]
  for (const d of downbeats) {
    const k = Math.round((d - firstBeat) / period)
    if (Math.abs(d - (firstBeat + k * period)) < period / 4) counts[((k % 4) + 4) % 4]++
  }
  const total = counts.reduce((x, y) => x + y, 0)
  const order = [0, 1, 2, 3].sort((x, y) => counts[y] - counts[x])
  const coverage = Math.min(1, (st.length * period) / Math.max(1, durationSec))
  return {
    bpm: 60 / period,
    periodSec: period,
    firstBeatSec: firstBeat,
    beatCount: Math.max(0, Math.floor((durationSec - firstBeat) / period) + 1),
    downbeatPhase: order[0],
    tempoConfidence: Math.max(0, Math.min(1, inTol / 0.8)),
    beatConfidence: Math.max(0, Math.min(1, 1 - medRes / 0.035)) * Math.min(1, coverage / 0.6),
    downbeatConfidence: total >= 4 ? (counts[order[0]] / total) * Math.min(1, total / 16) : 0,
    driftMs,
    stable: driftMs < 40 && medRes < 0.03,
    coverage,
  }
}
