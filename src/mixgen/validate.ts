/**
 * Output validation against the audio quality requirements. Every check reads the
 * renderer's measured output (MixAnalyzer metrics) and manifest — nothing is assumed.
 */
import type { MixManifest } from './manifest'
import type { RenderResult } from './mix-render'

export interface ValidationReport {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; value: string; limit: string }>
  failures: string[]
  warnings: string[]
}

export function validateMix(m: MixManifest, r: RenderResult): ValidationReport {
  const checks: ValidationReport['checks'] = []
  const add = (name: string, ok: boolean, value: string, limit: string) => checks.push({ name, ok, value, limit })
  const warnings: string[] = []
  const met = r.metrics
  // A track's own natural fade at the very end of the set is not a gap. A silence inside a track's
  // solo section (away from every transition) is part of that recording (a deliberate stop/break)
  // and is reported as a warning; silence at or around a transition is a mix defect.
  const nearTransition = (t0: number, t1: number) => m.transitions.some((t) => t1 >= t.mixStartSec - 2 && t0 <= t.mixEndSec + 2)
  const inSource: string[] = []
  const gaps = met.silences.filter((s) => {
    if (s.startSec >= met.durationSec - 3) return false
    if (s.startSec > 2 && !nearTransition(s.startSec, s.startSec + s.durationSec)) {
      const tr = m.tracks.find((t) => s.startSec >= t.mixMainSec && s.startSec <= t.mixOutSec)
      if (tr) {
        inSource.push(`${s.durationSec.toFixed(1)} s silence at ${s.startSec.toFixed(0)} s inside "${tr.title}" (in the source recording, away from transitions)`)
        return false
      }
    }
    return true
  })
  warnings.push(...inSource)
  add('continuous audio (no silence > 1 s)', gaps.length === 0, gaps.map((s) => `${s.startSec.toFixed(1)}s+${s.durationSec.toFixed(1)}s`).join(', ') || 'none', 'none')
  add('no clipped samples', met.clippedSamples === 0, String(met.clippedSamples), '0')
  add('sample peak ≤ −0.9 dBFS', met.samplePeakDb <= -0.9, `${met.samplePeakDb} dBFS`, '−0.9 dBFS')
  // Mix-induced level problems: (a) second-to-second jumps inside each transition window,
  // (b) loudness mismatch between the outgoing and incoming tracks around each transition.
  // Dynamics inside a track (breakdowns, drops) are the music, not a mix defect.
  const rms = met.energy.rmsDb
  const ABRUPT = new Set(['cut', 'brake', 'echo_out', 'loop_roll', 'scratch_cut'])
  let worstJump = 0
  let worstJumpAt = ''
  let worstMatch = 0
  let worstMatchAt = ''
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN)
  for (const t of m.transitions) {
    const a = Math.max(1, Math.floor(t.mixStartSec) - 1)
    const b = Math.min(rms.length - 1, Math.ceil(t.mixEndSec) + 2)
    const allowance = ABRUPT.has(t.style) ? 8 : 0
    for (let i = a; i <= b; i++) {
      if (rms[i] < -45 || rms[i - 1] < -45) continue
      const j = Math.abs(rms[i] - rms[i - 1]) - allowance
      if (j > worstJump) {
        worstJump = j
        worstJumpAt = `#${t.index + 1} at ${i}s`
      }
    }
    const before = med(rms.slice(Math.max(0, Math.floor(t.mixStartSec) - 30), Math.max(0, Math.floor(t.mixStartSec) - 2)).filter((v) => v > -45))
    const after = med(rms.slice(Math.ceil(t.mixEndSec) + 2, Math.ceil(t.mixEndSec) + 30).filter((v) => v > -45))
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) > worstMatch) {
      worstMatch = Math.abs(before - after)
      worstMatchAt = `#${t.index + 1}`
    }
  }
  add('no sudden volume jumps at transitions', worstJump <= 10, `${worstJump.toFixed(1)} dB${worstJumpAt ? ` (${worstJumpAt})` : ''}`, '10 dB/s (+8 for cuts/FX)')
  add('loudness matched across transitions', worstMatch <= 6, `${worstMatch.toFixed(1)} dB${worstMatchAt ? ` (${worstMatchAt})` : ''}`, '6 dB median level difference')
  add('integrated loudness in range', met.integratedLufs >= -16 && met.integratedLufs <= -8, `${met.integratedLufs} LUFS`, '−16…−8 LUFS')
  add('all tracks present', m.tracks.length === r.tracks.length && m.tracks.every((t) => t.mixOutSec > t.mixInSec), `${r.tracks.length}/${m.tracks.length}`, 'all')
  const monotone = m.tracks.every((t, i) => i === 0 || t.mixInSec >= m.tracks[i - 1].mixInSec)
  add('timeline monotone', monotone, monotone ? 'yes' : 'no', 'yes')
  const durErr = Math.abs(m.durationSec - m.targetDurationSec) / m.targetDurationSec
  add('duration near target', durErr <= 0.1, `${(m.durationSec / 60).toFixed(1)} min vs ${(m.targetDurationSec / 60).toFixed(1)} min`, '±10 %')
  const overlapping = m.transitions.filter((t) => t.overlapSec > 0).length
  add('real overlapping transitions', m.transitions.length === 0 || overlapping >= Math.ceil(m.transitions.length * 0.5), `${overlapping}/${m.transitions.length}`, '≥ 50 % overlap')
  const badSplice = r.transitions.filter((t) => t.spliceCorrelation < 0.5)
  add('sample-aligned splices', badSplice.length === 0, badSplice.length ? badSplice.map((t) => `#${t.index + 1}: r=${t.spliceCorrelation}`).join(', ') : 'all r ≥ 0.5', 'correlation ≥ 0.5')
  add('waveform matches length', Math.abs(m.waveform.min.length * m.waveform.secPerBucket - m.durationSec) < m.waveform.secPerBucket * 2 + 0.1, `${(m.waveform.min.length * m.waveform.secPerBucket).toFixed(1)} s`, `${m.durationSec.toFixed(1)} s`)
  for (const t of m.transitions) {
    if (Math.abs(t.tempoAdjustPct) > 6.0001) warnings.push(`transition ${t.index + 1}: tempo adjustment ${t.tempoAdjustPct}% exceeds ±6 %`)
    if (t.risks.length) warnings.push(`transition ${t.index + 1} (${t.label}): ${t.risks.join('; ')}`)
  }
  if (r.masterLimiterMaxReductionDb > 6) warnings.push(`master limiter reduced up to ${r.masterLimiterMaxReductionDb} dB`)
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.value} (limit ${c.limit})`)
  return { ok: failures.length === 0, checks, failures, warnings }
}
