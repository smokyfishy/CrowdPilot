/** 2nd-order low-pass at 150 Hz (kick band). */
function lowpass(x: Float32Array, rate: number): Float32Array {
  const w = (2 * Math.PI * 150) / rate
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const c = Math.cos(w)
  const a0 = 1 + alpha
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}

/** Kick-band onset-envelope lag (ms) between two decks, searched within ±60 ms. */
export function kickLagMs(aIn: Float32Array, bIn: Float32Array, rate: number): number {
  const a = lowpass(aIn, rate)
  const b = lowpass(bIn, rate)
  const hop = 64
  const env = (x: Float32Array) => {
    const n = Math.floor(x.length / hop)
    const e = new Float32Array(n)
    let prev = 0
    for (let k = 0; k < n; k++) {
      let s = 0
      for (let i = k * hop; i < (k + 1) * hop; i++) s += x[i] * x[i]
      const v = Math.log1p(1000 * s)
      e[k] = Math.max(0, v - prev)
      prev = v
    }
    return e
  }
  const ea = env(a)
  const eb = env(b)
  const maxLag = Math.round((0.06 * rate) / hop)
  let best = 0
  let bestV = -Infinity
  for (let l = -maxLag; l <= maxLag; l++) {
    let s = 0
    for (let k = maxLag; k < Math.min(ea.length, eb.length) - maxLag; k++) s += ea[k] * eb[k + l]
    if (s > bestV) { bestV = s; best = l }
  }
  return (best * hop * 1000) / rate
}


/**
 * Robust deck alignment: kick-band lag measured in 3 s windows (hop 1.5 s); only windows where
 * both decks have clear, correlated kicks count (breakdowns without kicks would give noise).
 * Returns the median lag (ms) and the number of usable windows; NaN if none.
 */
export function robustKickLagMs(a: Float32Array, b: Float32Array, rate: number): { lagMs: number; windows: number } {
  const win = Math.round(3 * rate)
  const hop = Math.round(1.5 * rate)
  const lags: number[] = []
  for (let s = 0; s + win <= Math.min(a.length, b.length); s += hop) {
    const wa = a.subarray(s, s + win)
    const wb = b.subarray(s, s + win)
    const r = kickLagStrength(wa, wb, rate)
    if (r.strength > 0.35 && r.edge === false) lags.push(r.lagMs)
  }
  if (!lags.length) return { lagMs: NaN, windows: 0 }
  lags.sort((x, y) => x - y)
  return { lagMs: lags[Math.floor(lags.length / 2)], windows: lags.length }
}

function kickLagStrength(aIn: Float32Array, bIn: Float32Array, rate: number): { lagMs: number; strength: number; edge: boolean } {
  const a = lowpass(aIn, rate)
  const b = lowpass(bIn, rate)
  const hop = 64
  const env = (x: Float32Array) => {
    const n = Math.floor(x.length / hop)
    const e = new Float32Array(n)
    let prev = 0
    for (let k = 0; k < n; k++) {
      let s = 0
      for (let i = k * hop; i < (k + 1) * hop; i++) s += x[i] * x[i]
      const v = Math.log1p(1e4 * s)
      e[k] = Math.max(0, v - prev)
      prev = v
    }
    return e
  }
  const ea = env(a)
  const eb = env(b)
  const maxLag = Math.round((0.06 * rate) / hop)
  const na = Math.sqrt(ea.reduce((s, v) => s + v * v, 0)) || 1
  const nb = Math.sqrt(eb.reduce((s, v) => s + v * v, 0)) || 1
  let best = 0
  let bestV = -Infinity
  for (let l = -maxLag; l <= maxLag; l++) {
    let s = 0
    for (let k = maxLag; k < Math.min(ea.length, eb.length) - maxLag; k++) s += ea[k] * eb[k + l]
    if (s > bestV) {
      bestV = s
      best = l
    }
  }
  return { lagMs: (best * hop * 1000) / rate, strength: bestV / (na * nb), edge: Math.abs(best) >= maxLag }
}
