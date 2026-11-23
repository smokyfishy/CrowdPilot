/** Shared objective transition metrics for the mixgen evaluations. */
/** Objective transition metrics from post-fader deck stems. */
export function transitionMetrics(stemA: Float32Array, stemB: Float32Array, mix: Float32Array[], rate: number, startSample: number, overlap: number, beatSec: number) {
  const hop = Math.round(rate * 0.01)
  const lpA = Math.exp((-2 * Math.PI * 150) / rate)
  const env = (x: Float32Array, a: number, b: number) => {
    const bass: number[] = []
    const full: number[] = []
    let l1 = 0
    let l2 = 0
    let sb = 0
    let sf = 0
    let n = 0
    for (let i = a; i < b; i++) {
      const v = x[i] ?? 0
      l1 = l1 * lpA + v * (1 - lpA)
      l2 = l2 * lpA + l1 * (1 - lpA)
      sb += l2 * l2
      sf += v * v
      if (++n === hop) {
        bass.push(sb / hop)
        full.push(sf / hop)
        sb = sf = n = 0
      }
    }
    return { bass, full }
  }
  const a0 = startSample
  const a1 = startSample + Math.max(overlap, Math.round(rate * 0.5))
  const A = env(stemA, a0, a1)
  const B = env(stemB, a0, a1)
  // (1) bass doubling: share of overlap energy where BOTH decks carry bass (0 = clean handoff, 0.5 = full doubling)
  let both = 0
  let tot = 0
  for (let i = 0; i < A.bass.length; i++) {
    both += Math.min(A.bass[i], B.bass[i])
    tot += A.bass[i] + B.bass[i]
  }
  const bassDoubling = tot > 0 ? both / tot : 0
  // (2) beat alignment: onset-envelope cross-correlation lag (ms, folded to ±half beat) where both are audible
  const flux = (e: number[]) => e.map((v, i) => Math.max(0, Math.sqrt(v) - Math.sqrt(e[i - 1] ?? v)))
  // kick-band onsets: four-on-the-floor kicks coincide when two tracks are beat-matched
  const fa = flux(A.bass)
  const fb = flux(B.bass)
  const audible = A.full.map((v, i) => v > 1e-5 && B.full[i] > 1e-5 && A.bass[i] > 1e-7 && B.bass[i] > 1e-7)
  let best = { lag: 0, c: -1 }
  const maxLag = Math.round((beatSec / 2) * 100)
  if (audible.filter(Boolean).length > 100) {
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let c = 0
      for (let i = 0; i < fa.length; i++) if (audible[i] && audible[i + lag]) c += fa[i] * (fb[i + lag] ?? 0)
      if (c > best.c) best = { lag, c }
    }
  }
  const beatOffsetMs = audible.filter(Boolean).length > 100 ? Math.abs(best.lag * 10) : NaN
  // (3) level continuity: largest 400 ms RMS step of the mix inside the window (dB)
  const M = mix[0]
  const w = Math.round(rate * 0.4)
  let prev = NaN
  let maxStep = 0
  for (let i = Math.max(0, a0 - w * 5); i + w < Math.min(M.length, a1 + w * 5); i += w) {
    let s = 0
    for (let k = i; k < i + w; k++) s += M[k] * M[k]
    const db = 10 * Math.log10(s / w + 1e-12)
    if (Number.isFinite(prev) && db > -45 && prev > -45) maxStep = Math.max(maxStep, Math.abs(db - prev))
    prev = db
  }
  return { bassDoubling: Math.round(bassDoubling * 1000) / 1000, beatOffsetMs, maxLevelStepDb: Math.round(maxStep * 10) / 10, overlapSec: Math.round((overlap / rate) * 10) / 10 }
}

