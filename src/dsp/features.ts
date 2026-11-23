/**
 * Frame-level spectral features from a multi-resolution STFT (Hann windows,
 * shared hop). All three resolutions are centred on the same frame time
 * t = frame * hop / sampleRate, so features line up exactly.
 *
 *   1024  → onset envelope (log-compressed spectral flux): good time resolution
 *   2048  → band energies, centroid, flatness, waveform colouring
 *   4096  → chroma (pitch-class profile): ~5 Hz bins at 22.05 kHz
 */
import { MagnitudeSpectrum } from './fft'

export interface FrameFeatures {
  sampleRate: number
  hop: number
  frames: number
  /** Half-wave-rectified log spectral flux, one value per frame. */
  onset: Float32Array
  /** Low-band (< 150 Hz) flux: kick/bass onsets. */
  onsetLow: Float32Array
  /** High-band (> 5 kHz) flux: hats/cymbals. */
  onsetHigh: Float32Array
  /** Band energies (power sums, linear) per frame. */
  low: Float32Array
  mid: Float32Array
  high: Float32Array
  /** Spectral centroid in Hz. */
  centroid: Float32Array
  /** Spectral flatness 300–3400 Hz (0 tonal … 1 noisy). */
  flatnessMid: Float32Array
  /** 12 × frames chroma, row-major per frame (frame*12 + pc), each frame L1-normalised. */
  chroma: Float32Array
  /** Frame RMS of the time signal (over the 2048 window). */
  rms: Float32Array
}

export const LOW_HZ = 150
export const HIGH_HZ = 2500

export function frameFeatures(x: Float32Array, sampleRate: number, hop = 512): FrameFeatures {
  const frames = Math.max(1, Math.ceil(x.length / hop))
  const s1 = new MagnitudeSpectrum(1024)
  const s2 = new MagnitudeSpectrum(2048)
  const s4 = new MagnitudeSpectrum(4096)
  const m1 = new Float32Array(513)
  const prev1 = new Float32Array(513)
  const m2 = new Float32Array(1025)
  const m4 = new Float32Array(2049)

  const onset = new Float32Array(frames)
  const onsetLow = new Float32Array(frames)
  const onsetHigh = new Float32Array(frames)
  const low = new Float32Array(frames)
  const mid = new Float32Array(frames)
  const high = new Float32Array(frames)
  const centroid = new Float32Array(frames)
  const flatnessMid = new Float32Array(frames)
  const chroma = new Float32Array(frames * 12)
  const rms = new Float32Array(frames)

  const bin1 = sampleRate / 1024
  const bin2 = sampleRate / 2048
  const bin4 = sampleRate / 4096
  const lowBin1 = Math.max(1, Math.round(LOW_HZ / bin1))
  const highBin1 = Math.round(5000 / bin1)
  const lowBin2 = Math.round(LOW_HZ / bin2)
  const highBin2 = Math.round(HIGH_HZ / bin2)
  const fm0 = Math.round(300 / bin2)
  const fm1 = Math.round(3400 / bin2)

  // Chroma mapping for the 4096 spectrum: bins between ~55 Hz (A1) and 5 kHz.
  const cLo = Math.ceil(55 / bin4)
  const cHi = Math.min(2048, Math.floor(5000 / bin4))
  const pcOf = new Int8Array(2049).fill(-1)
  for (let k = cLo; k <= cHi; k++) {
    const midi = 69 + 12 * Math.log2((k * bin4) / 440)
    pcOf[k] = ((Math.round(midi) % 12) + 12) % 12
  }

  for (let f = 0; f < frames; f++) {
    const center = f * hop

    // ── onset (1024) ──
    s1.compute(x, center - 512, m1)
    let flux = 0
    let fluxLow = 0
    let fluxHigh = 0
    for (let k = 1; k < 513; k++) {
      const v = Math.log1p(100 * m1[k])
      const d = v - prev1[k]
      if (d > 0) {
        flux += d
        if (k <= lowBin1) fluxLow += d
        else if (k >= highBin1) fluxHigh += d
      }
      prev1[k] = v
    }
    onset[f] = f === 0 ? 0 : flux
    onsetLow[f] = f === 0 ? 0 : fluxLow
    onsetHigh[f] = f === 0 ? 0 : fluxHigh

    // ── bands / centroid / flatness (2048) ──
    s2.compute(x, center - 1024, m2)
    let lo = 0
    let md = 0
    let hi = 0
    let num = 0
    let den = 0
    for (let k = 1; k < 1025; k++) {
      const p = m2[k] * m2[k]
      if (k < lowBin2) lo += p
      else if (k < highBin2) md += p
      else hi += p
      num += k * bin2 * m2[k]
      den += m2[k]
    }
    low[f] = lo
    mid[f] = md
    high[f] = hi
    centroid[f] = den > 0 ? num / den : 0
    let logSum = 0
    let linSum = 0
    for (let k = fm0; k <= fm1; k++) {
      const p = m2[k] * m2[k] + 1e-12
      logSum += Math.log(p)
      linSum += p
    }
    const nb = fm1 - fm0 + 1
    flatnessMid[f] = Math.exp(logSum / nb) / (linSum / nb)

    // time-domain RMS over the same 2048 window
    let ss = 0
    let cnt = 0
    for (let i = center - 1024; i < center + 1024; i++) {
      if (i >= 0 && i < x.length) {
        ss += x[i] * x[i]
        cnt++
      }
    }
    rms[f] = cnt ? Math.sqrt(ss / cnt) : 0

    // ── chroma (4096) ──
    s4.compute(x, center - 2048, m4)
    const base = f * 12
    let tot = 0
    for (let k = cLo; k <= cHi; k++) {
      const pc = pcOf[k]
      const e = m4[k] * m4[k]
      chroma[base + pc] += e
      tot += e
    }
    if (tot > 0) for (let p = 0; p < 12; p++) chroma[base + p] /= tot
  }

  return { sampleRate, hop, frames, onset, onsetLow, onsetHigh, low, mid, high, centroid, flatnessMid, chroma, rms }
}

/** Subtract a moving average (window in frames) and half-wave rectify; then scale to unit max. */
export function normalizeOnset(env: Float32Array, win = 16): Float32Array {
  const n = env.length
  const out = new Float32Array(n)
  let acc = 0
  const q: number[] = []
  for (let i = 0; i < n; i++) {
    acc += env[i]
    q.push(env[i])
    if (q.length > win) acc -= q.shift() as number
    const mean = acc / q.length
    out[i] = Math.max(0, env[i] - mean)
  }
  let max = 0
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i]
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max
  return out
}
