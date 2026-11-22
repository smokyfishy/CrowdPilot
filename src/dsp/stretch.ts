/**
 * Pitch-preserving time-scale modification: WSOLA (waveform-similarity
 * overlap-add) with a time-varying tempo ratio. Written for this project (no
 * GPL dependency). Quality is good for percussive dance music at small ratios
 * (±6 %); it is NOT a phase-vocoder/transient-preserving stretcher, and long
 * sustained pads can show mild phasiness. Listening tests are required before
 * relying on larger ratios.
 *
 * ratio r = input samples consumed per output sample (r > 1 → faster tempo).
 * Beat-time mapping: `inputPosAt(outSample)` returns the nominal input sample,
 * which tracks the integrated ratio exactly (the similarity search jitter of
 * ±tolerance samples never accumulates).
 */
import { hann } from './fft'

export interface StretchOptions {
  frame?: number
  tolerance?: number
}

export interface StretchResult {
  channels: Float32Array[]
  /** Nominal input sample at each output hop boundary (hop = frame/2). */
  anchors: Float64Array
  hop: number
  /** Input sample where the stretched output ends (nominal). */
  inputEnd: number
}

/**
 * Stretch `channels` starting at input sample `start`, producing `outLength`
 * samples, with ratio `ratioAt(outSample)`.
 */
export function wsola(
  channels: Float32Array[],
  start: number,
  outLength: number,
  ratioAt: (outSample: number) => number,
  opts: StretchOptions = {},
): StretchResult {
  const N = opts.frame ?? 2048
  const Hs = N / 2
  const tol = opts.tolerance ?? 256
  const win = hann(N)
  const inLen = channels[0].length
  const mono = channels.length === 1 ? channels[0] : null
  const sim = (i: number) => (mono ? mono[i] : 0.5 * (channels[0][i] + channels[1][i]))
  const frames = Math.ceil(outLength / Hs) + 1
  const out = channels.map(() => new Float32Array(outLength + N))
  const norm = new Float32Array(outLength + N)
  const anchors = new Float64Array(frames + 1)

  let nominal = start
  let prevActual = start - Hs // so the first "natural continuation" is start
  for (let m = 0; m < frames; m++) {
    anchors[m] = nominal
    const outPos = m * Hs
    // natural continuation of the previous frame
    const natural = prevActual + Hs
    let best = 0
    let bestScore = -Infinity
    if (m > 0) {
      for (let d = -tol; d <= tol; d += 2) {
        const cand = Math.round(nominal) + d
        if (cand < 0 || cand + N >= inLen) continue
        let acc = 0
        for (let i = 0; i < N; i += 8) {
          const a = natural + i
          if (a < 0 || a >= inLen) continue
          acc += sim(a) * sim(cand + i)
        }
        if (acc > bestScore) {
          bestScore = acc
          best = d
        }
      }
    }
    const actual = Math.round(nominal) + best
    if (actual >= inLen) break
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c]
      const dst = out[c]
      for (let i = 0; i < N; i++) {
        const idx = actual + i
        if (idx >= inLen) break
        dst[outPos + i] += src[idx] * win[i]
      }
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += win[i]
    prevActual = actual
    nominal += Hs * ratioAt(outPos + Hs / 2)
  }
  anchors[frames] = nominal
  const result = out.map((buf) => {
    const o = new Float32Array(outLength)
    for (let i = 0; i < outLength; i++) o[i] = norm[i] > 1e-3 ? buf[i] / norm[i] : 0
    return o
  })
  return { channels: result, anchors, hop: Hs, inputEnd: anchors[Math.floor(outLength / Hs)] }
}

/** Nominal input sample position for an output sample (linear between hop anchors). */
export function inputPosAt(r: StretchResult, outSample: number): number {
  const k = outSample / r.hop
  const i = Math.min(r.anchors.length - 2, Math.max(0, Math.floor(k)))
  const f = k - i
  return r.anchors[i] + (r.anchors[i + 1] - r.anchors[i]) * f
}

/** Output sample at which a given input sample is played (inverse of inputPosAt; monotone). */
export function outputPosOf(r: StretchResult, inSample: number): number {
  const a = r.anchors
  let lo = 0
  let hi = a.length - 1
  if (inSample <= a[0]) return 0
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (a[mid] <= inSample) lo = mid
    else hi = mid
  }
  const span = a[hi] - a[lo] || 1
  return (lo + (inSample - a[lo]) / span) * r.hop
}
