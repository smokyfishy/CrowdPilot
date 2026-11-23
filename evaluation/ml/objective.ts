/**
 * Objective (non-perceptual) transition quality from the rendered STEMS plus known controls.
 * This is the supervision target for DJCritic (which only sees the mix) and the selection
 * criterion for TransitionNet's render-and-verify teacher. It measures technical defects; it is
 * NOT a model of human taste.
 */
import type { CriticFeatures } from '../../src/ml/critic-features'

export interface Defect {
  kind: 'offset' | 'tempo' | 'abrupt' | 'bass' | 'phrase' | 'stretch' | 'echo' | 'loop' | 'scratch' | 'clip'
  /** Known severity of the injected control error, 0–1. */
  sev: number
  detail?: number
}

function lowEnv(x: Float32Array, rate: number, a: number, b: number, win: number): Float32Array {
  // 2nd-order low-pass at 150 Hz, then RMS per window
  const w = (2 * Math.PI * 150) / rate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const n = Math.max(0, Math.floor((b - a) / win))
  const out = new Float32Array(n)
  let k = 0
  let s = 0
  let c = 0
  for (let i = a; i < a + n * win; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v
    s += v * v
    if (++c === win) { out[k++] = Math.sqrt(s / win); s = 0; c = 0 }
  }
  return out
}

function bandEnv(x: Float32Array, rate: number, a: number, b: number, hz: number, type: 'low' | 'high', hop: number): Float32Array {
  const w = (2 * Math.PI * hz) / rate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const [b0, b1, b2] = type === 'low' ? [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0] : [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0]
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const n = Math.floor((b - a) / hop)
  const e = new Float32Array(n)
  let prev = 0
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let i = a + k * hop; i < a + (k + 1) * hop; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v
      s += v * v
    }
    const lv = Math.log1p(1e4 * s)
    e[k] = Math.max(0, lv - prev)
    prev = lv
  }
  return e
}

/**
 * Deck alignment (ms; + = incoming early, − = incoming late) from the two stems over [a, b): onset envelopes in the
 * kick band (< 150 Hz) and the hat band (> 2.5 kHz), 3 s windows / 1.5 s hop, mean-removed
 * normalised cross-correlation within ±60 ms. A window counts when either band has both decks
 * clearly present and correlated (r > 0.3, peak not at the search edge). Median over windows.
 */
export function stemLagMs(sa: Float32Array, sb: Float32Array, rate: number, a: number, b: number): { lagMs: number; windows: number } {
  const hop = Math.max(16, Math.round(rate / 250)) // ≈ 4 ms
  const maxLag = Math.round((0.06 * rate) / hop)
  const envs = (['low', 'high'] as const).map((t) => [bandEnv(sa, rate, a, b, t === 'low' ? 150 : 2500, t, hop), bandEnv(sb, rate, a, b, t === 'low' ? 150 : 2500, t, hop)])
  const win = Math.round((3 * rate) / hop)
  const step = Math.round((1.5 * rate) / hop)
  const lags: number[] = []
  const n = envs[0][0].length
  for (let s0 = 0; s0 + win <= n; s0 += step) {
    let best: { lag: number; r: number } | null = null
    for (const [ea, eb] of envs) {
      const seg = (e: Float32Array) => {
        const v = e.subarray(s0, s0 + win)
        const m = v.reduce((p, q) => p + q, 0) / v.length
        return Array.from(v, (q) => q - m)
      }
      const xa = seg(ea)
      const xb = seg(eb)
      const na = Math.sqrt(xa.reduce((p, q) => p + q * q, 0))
      const nb = Math.sqrt(xb.reduce((p, q) => p + q * q, 0))
      if (na < 1e-6 || nb < 1e-6) continue
      let bl = 0
      let bv = -Infinity
      for (let l = -maxLag; l <= maxLag; l++) {
        let s = 0
        for (let k = maxLag; k < win - maxLag; k++) s += xa[k] * xb[k + l]
        if (s > bv) { bv = s; bl = l }
      }
      const r = bv / (na * nb)
      if (r > 0.3 && Math.abs(bl) < maxLag && (!best || r > best.r)) best = { lag: bl, r }
    }
    if (best) lags.push((best.lag * hop * 1000) / rate)
  }
  if (!lags.length) return { lagMs: NaN, windows: 0 }
  lags.sort((x, y) => x - y)
  return { lagMs: lags[Math.floor(lags.length / 2)], windows: lags.length }
}

export interface Objective {
  lagMs: number
  lagWindows: number
  lowCollision: number
  sevAlign: number
  sevLow: number
  sevLevel: number
  sevSilence: number
  sevKnown: number
  sObj: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function objective(stemA: Float32Array, stemB: Float32Array, rate: number, t0: number, t1: number, f: CriticFeatures, defects: Defect[], beatmatched: boolean, slam = false, beatSec = 0.5): Objective {
  // deck alignment over the overlap (only where both decks have kicks)
  let lagMs = NaN
  let lagWindows = 0
  if (beatmatched && t1 - t0 > 4 * rate) {
    const r = stemLagMs(stemA, stemB, rate, t0, t1)
    lagMs = r.lagMs
    lagWindows = r.windows
  }
  // bass collision: fraction of overlap where both decks carry strong low end
  let lowCollision = 0
  if (t1 - t0 > rate) {
    const win = Math.round(0.1 * rate)
    const la = lowEnv(stemA, rate, t0, t1, win)
    const lb = lowEnv(stemB, rate, t0, t1, win)
    const ref = Math.max(1e-6, ...la, ...lb)
    let both = 0
    for (let k = 0; k < la.length; k++) if (la[k] > 0.35 * ref && lb[k] > 0.35 * ref) both++
    lowCollision = la.length ? both / la.length : 0
  }
  const offsetKnown = defects.find((d) => d.kind === 'offset' || d.kind === 'loop')
  const sevAlign = lagWindows >= 2 ? clamp01((Math.abs(lagMs) - 8) / 40) : offsetKnown ? offsetKnown.sev : 0
  const sevLow = clamp01((lowCollision - 0.25) / 0.4) * 0.6
  // Slam techniques (echo-out, roll, brake, scratch) drop the outgoing on purpose: their dip is
  // intended and up to ~1.5 beats of air is part of the move; only bumps and longer gaps count.
  const sevLevel = 1 - (1 - (slam ? 0 : clamp01((f.dipDb - 3) / 9) * 0.8)) * (1 - clamp01((f.bumpDb - 2) / 6) * 0.6)
  const sevSilence = clamp01((f.silenceSec - 0.3 - (slam ? 1.5 * beatSec : 0)) / 1.2)
  // known severities of control errors not already measured above
  const measured = new Set<Defect['kind']>(lagWindows >= 2 ? ['offset', 'loop'] : [])
  const sevKnown = 1 - defects.filter((d) => !measured.has(d.kind)).reduce((p, d) => p * (1 - d.sev), 1)
  const sObj = 1 - [sevAlign, sevLow, sevLevel, sevSilence, sevKnown].reduce((p, s) => p * (1 - s), 1)
  return { lagMs, lagWindows, lowCollision, sevAlign, sevLow, sevLevel, sevSilence, sevKnown, sObj }
}
