/**
 * Energy descriptors and target energy arcs.
 *
 * Track energy is loudness-independent (every track is loudness-matched in the render):
 * percussive onset density, tempo, bass share and spectral brightness, each normalized
 * within the candidate pool to a 0..1 percentile, then combined. Drops are detected from
 * the section map. Targets are 0..1 curves over the set position.
 */
import type { TrackAnalysis } from '../dsp/analyze'
import type { EnergyCurve } from './spec'

export interface EnergyDescriptor {
  onsetDensity: number
  bpm: number
  /** log10 low-band minus mid-band energy (bass weight). */
  bassShare: number
  centroid: number
  /** Strongest drop: energy jump (dB) at a 'drop' section start, 0 when none. */
  dropStrength: number
  hasBreakdown: boolean
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export function describeEnergy(a: TrackAnalysis): EnergyDescriptor {
  // Use the loudest 60 % of bars (the "body"), so long ambient intros don't dominate.
  const bars = [...a.bars].sort((x, y) => y.energy - x.energy).slice(0, Math.max(1, Math.round(a.bars.length * 0.6)))
  let dropStrength = 0
  for (const s of a.sections) {
    if (s.kind !== 'drop') continue
    const before = mean(a.energyCurve.slice(Math.max(0, s.startBar - 8), s.startBar))
    const after = mean(a.energyCurve.slice(s.startBar, s.startBar + 8))
    dropStrength = Math.max(dropStrength, after - before)
  }
  return {
    onsetDensity: mean(bars.map((b) => b.onsetDensity)),
    bpm: a.grid.bpm,
    bassShare: mean(bars.map((b) => b.low - b.mid)),
    centroid: mean(bars.map((b) => b.centroid)),
    dropStrength,
    hasBreakdown: a.sections.some((s) => s.kind === 'breakdown'),
  }
}

function percentiles(xs: number[]): number[] {
  const sorted = [...xs].sort((a, b) => a - b)
  return xs.map((x) => {
    if (sorted.length <= 1) return 0.5
    let lo = 0
    while (lo < sorted.length && sorted[lo] < x) lo++
    let hi = lo
    while (hi < sorted.length && sorted[hi] === x) hi++
    return (lo + hi - 1) / 2 / (sorted.length - 1)
  })
}

/** Pool-relative 0..1 energy score per track. */
export function energyScores(ds: EnergyDescriptor[]): number[] {
  const on = percentiles(ds.map((d) => d.onsetDensity))
  const bpm = percentiles(ds.map((d) => d.bpm))
  const bass = percentiles(ds.map((d) => d.bassShare))
  const cen = percentiles(ds.map((d) => d.centroid))
  const drop = percentiles(ds.map((d) => d.dropStrength))
  return ds.map((_, i) => 0.32 * on[i] + 0.22 * bpm[i] + 0.18 * bass[i] + 0.13 * cen[i] + 0.15 * drop[i])
}

/** Target energy (0..1) at set position t ∈ [0, 1]. */
export function targetEnergy(curve: EnergyCurve, t: number, intensity = 0.6): number {
  const u = Math.max(0, Math.min(1, t))
  const base = (() => {
    switch (curve) {
      case 'constant_high':
        return 0.85
      case 'steady':
        return 0.55
      case 'gradual_build':
        return 0.25 + 0.65 * u
      case 'gradual_build_to_peak':
        return u < 0.85 ? 0.25 + 0.7 * (u / 0.85) : 0.95 - 0.15 * ((u - 0.85) / 0.15)
      case 'chill_to_energetic':
        return 0.1 + 0.85 * u * u
      case 'festival_climax':
        return u < 0.8 ? 0.4 + 0.4 * (u / 0.8) : 1.0
      case 'groovy_then_harder':
        return u < 0.3 ? 0.3 + 0.1 * (u / 0.3) : 0.4 + 0.55 * ((u - 0.3) / 0.7)
      case 'multiple_peaks':
        return 0.55 + 0.35 * Math.sin(u * Math.PI * 3 - Math.PI / 2) * (0.6 + 0.4 * u)
      case 'high_then_relaxed':
        return u < 0.6 ? 0.85 : 0.85 - 0.6 * ((u - 0.6) / 0.4)
    }
  })()
  // Overall intensity shifts the curve without changing its shape.
  return Math.max(0, Math.min(1, base + (intensity - 0.6) * 0.4))
}

/** Direction the energy should move at the transition after position i of n (+1 build / 0 / −1). */
export function energyDirection(curve: EnergyCurve, i: number, n: number, intensity?: number): number {
  if (n <= 1) return 0
  const a = targetEnergy(curve, i / (n - 1), intensity)
  const b = targetEnergy(curve, (i + 1) / (n - 1), intensity)
  return b - a > 0.03 ? 1 : b - a < -0.03 ? -1 : 0
}
