/**
 * Anti-aliased resampling with a Kaiser-windowed sinc kernel (tabulated, linear
 * interpolation between table points). Used for the downsampled *analysis copy*
 * only; playback always uses the original decode. In the browser the host uses
 * OfflineAudioContext for this; this version keeps the analyzer runnable and
 * testable in plain Node and in the Python cross-check.
 */

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 60; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

const TABLE_RES = 256

export function resample(input: Float32Array, fromRate: number, toRate: number, halfTaps = 16, beta = 8.6): Float32Array {
  if (fromRate === toRate) return input.slice()
  const ratio = toRate / fromRate
  const outLen = Math.floor(input.length * ratio)
  const out = new Float32Array(outLen)
  const cutoff = Math.min(1, ratio) * 0.94 // guard band below the new Nyquist
  const width = halfTaps / cutoff // kernel half-width in input samples
  // Kernel as a function of |t| in input samples, tabulated over [0, width].
  const tableLen = Math.ceil(width * TABLE_RES) + 2
  const table = new Float64Array(tableLen)
  const i0b = besselI0(beta)
  for (let i = 0; i < tableLen; i++) {
    const t = i / TABLE_RES
    const u = t / width
    if (u >= 1) continue
    const w = besselI0(beta * Math.sqrt(1 - u * u)) / i0b
    const arg = Math.PI * t * cutoff
    table[i] = w * (arg === 0 ? 1 : Math.sin(arg) / arg)
  }
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio
    const lo = Math.max(0, Math.ceil(center - width))
    const hi = Math.min(input.length - 1, Math.floor(center + width))
    let acc = 0
    let norm = 0
    for (let j = lo; j <= hi; j++) {
      const pos = Math.abs(j - center) * TABLE_RES
      const p0 = pos | 0
      const k = table[p0] + (table[p0 + 1] - table[p0]) * (pos - p0)
      acc += input[j] * k
      norm += k
    }
    out[i] = norm > 0 ? acc / norm : 0
  }
  return out
}

/** Average channels to mono. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const n = channels[0].length
  const out = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i]
  const g = 1 / channels.length
  for (let i = 0; i < n; i++) out[i] *= g
  return out
}
