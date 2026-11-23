/**
 * Global and local key from chroma: correlation with rotated Krumhansl–Kessler
 * major/minor profiles. Confidence is the normalised margin between the best and
 * the runner-up key, excluding the best key's relative major/minor (which share
 * the same pitch set and are a known source of ambiguity — reported separately).
 */

export const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export interface KeyEstimate {
  tonic: number // 0 = C
  mode: 'major' | 'minor'
  name: string // e.g. "A minor"
  camelot: string // e.g. "8A"
  correlation: number
  confidence: number
  /** True when the relative major/minor scored within 10% of the winner. */
  relativeAmbiguous: boolean
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, rot: number): number {
  let ma = 0
  let mb = 0
  for (let i = 0; i < 12; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= 12
  mb /= 12
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
}

/** Camelot wheel code: major keys "B", minor keys "A". */
export function camelot(tonic: number, mode: 'major' | 'minor'): string {
  // Camelot number for major keys by tonic (C=8B, G=9B, ...): n = (7*tonic) mod 12 → map.
  const majorNum = ((7 * tonic) % 12 + 12) % 12 // C→0, G→7*7=49%12=1 …
  const n = ((majorNum + 7) % 12) + 1 // C→8
  if (mode === 'major') return `${n}B`
  // relative major of a minor key is tonic+3
  const rel = (tonic + 3) % 12
  const relNum = (((7 * rel) % 12) + 7) % 12 + 1
  return `${relNum}A`
}

export function keyFromChroma(profile: ArrayLike<number>): KeyEstimate {
  const scores: Array<{ tonic: number; mode: 'major' | 'minor'; r: number }> = []
  for (let t = 0; t < 12; t++) {
    scores.push({ tonic: t, mode: 'major', r: pearson(profile, KK_MAJOR, t) })
    scores.push({ tonic: t, mode: 'minor', r: pearson(profile, KK_MINOR, t) })
  }
  scores.sort((a, b) => b.r - a.r)
  const best = scores[0]
  const relTonic = best.mode === 'major' ? (best.tonic + 9) % 12 : (best.tonic + 3) % 12
  const relMode = best.mode === 'major' ? 'minor' : 'major'
  const rel = scores.find((s) => s.tonic === relTonic && s.mode === relMode)
  const other = scores.find((s) => s !== best && s !== rel) ?? scores[1]
  const confidence = best.r > 0 ? Math.max(0, Math.min(1, (best.r - other.r) / Math.max(1e-6, best.r) * 3)) : 0
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${PITCH[best.tonic]} ${best.mode}`,
    camelot: camelot(best.tonic, best.mode),
    correlation: best.r,
    confidence,
    relativeAmbiguous: !!rel && rel.r > best.r * 0.9,
  }
}

/** Mean chroma over frames [a, b), weighting frames by their tonal (non-flat) energy. */
export function meanChroma(chroma: Float32Array, a: number, b: number, weights?: Float32Array): Float64Array {
  const out = new Float64Array(12)
  let tot = 0
  for (let f = a; f < b; f++) {
    const w = weights ? weights[f] : 1
    for (let p = 0; p < 12; p++) out[p] += chroma[f * 12 + p] * w
    tot += w
  }
  if (tot > 0) for (let p = 0; p < 12; p++) out[p] /= tot
  return out
}

/** Distance on the Camelot wheel: 0 same, 1 adjacent / relative, 2+ further. */
export function camelotDistance(a: string, b: string): number {
  const pa = /^(\d+)([AB])$/.exec(a)
  const pb = /^(\d+)([AB])$/.exec(b)
  if (!pa || !pb) return 6
  const na = Number(pa[1])
  const nb = Number(pb[1])
  const ring = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12)
  if (pa[2] === pb[2]) return ring
  return ring === 0 ? 1 : ring + 1
}
