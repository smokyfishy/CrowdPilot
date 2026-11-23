/**
 * Stem-separation measures shared by every host. The Azure stem job (infra/stems/job.py) and the
 * local worker (worker-node/mixgen/stems.ts) report the vocal-stem RMS envelope, the bass bleed into
 * the vocal stem and the stem-sum reconstruction residual; this turns them into the per-bar
 * StemInfo the planner and the long-form generator use, with one quality gate for all hosts.
 */
import type { TrackAnalysis } from '../dsp/analyze'
import type { StemInfo } from './techniques'

export interface StemServiceInfo {
  vocalRmsDb: number[]
  envRateHz: number
  bleed: number
  residualDb: number
  durationSec: number
  elements: Array<'vocals' | 'drums' | 'bass' | 'other'>
  model: string
  version: string
}

/**
 * Separation-quality gate (all hosts). htdemucs does not enforce that its stems sum back to the mix:
 * on 8 mastered tracks the aligned reconstruction residual was −12.1…−14.3 dB, so −10 dB keeps a margin
 * for normal output while rejecting failed separations. Heuristic, not a listening-validated threshold.
 */
export const RESIDUAL_GATE_DB = -10
export const stemsClean = (bleed: number, residualDb: number | undefined) => bleed < 0.25 && (residualDb === undefined || residualDb < RESIDUAL_GATE_DB)

export function stemInfoFromService(s: StemServiceInfo, a: TrackAnalysis): StemInfo {
  const barSec = a.barSec
  const start = a.bars[0]?.startSec ?? 0
  const nb = Math.max(1, Math.floor((s.durationSec - start) / barSec))
  const vocalDb: number[] = []
  for (let b = 0; b < nb; b++) {
    const i0 = Math.max(0, Math.floor((start + b * barSec) * s.envRateHz))
    const i1 = Math.min(s.vocalRmsDb.length, Math.ceil((start + (b + 1) * barSec) * s.envRateHz))
    let p = 0
    for (let i = i0; i < i1; i++) p += 10 ** (s.vocalRmsDb[i] / 10)
    vocalDb.push(i1 > i0 ? Math.round(10 * Math.log10(p / (i1 - i0) + 1e-12) * 10) / 10 : -90)
  }
  return { vocalDb, barStartSec: start, barSec, clean: stemsClean(s.bleed, s.residualDb), bleed: s.bleed, elements: s.elements, residualDb: s.residualDb }
}
