/**
 * Control-surface mappings: how an executed parameter value is drawn on the virtual hardware.
 * These are display scales only — the values themselves come from the performance evaluator.
 */

/** Knob sweep: ±135° around 12 o'clock (300° travel like a real rotary pot, minus the dead zone). */
export const KNOB_SWEEP = 135

/** Isolator EQ knob: 0 dB at 12 o'clock, kill (≤ −40 dB, the renderer's KILL) fully left, +6 dB fully right. */
export function eqAngle(db: number): number {
  if (db >= 0) return Math.min(1, db / 6) * KNOB_SWEEP
  return -Math.min(1, Math.sqrt(Math.min(40, -db) / 40)) * KNOB_SWEEP
}

/** Bipolar filter knob: −1 (low-pass) fully left … 0 off … +1 (high-pass) fully right. */
export const filterAngle = (k: number): number => Math.max(-1, Math.min(1, k)) * KNOB_SWEEP

/** Trim knob: ±12 dB. */
export const trimAngle = (db: number): number => (Math.max(-12, Math.min(12, db)) / 12) * KNOB_SWEEP

/** Send knob (echo / reverb): 0..1 → fully left … fully right. */
export const sendAngle = (v: number): number => (Math.max(0, Math.min(1, v)) * 2 - 1) * KNOB_SWEEP

/** Channel fader position (0 bottom … 1 top) from the executed linear gain. */
export const faderPos = (gain: number): number => Math.max(0, Math.min(1, gain))

/** Tempo fader position (−1 … +1) for a ±8 % range (the renderer stays within ±10 %; clamp beyond). */
export const tempoPos = (pct: number): number => Math.max(-1, Math.min(1, pct / 8))

/** Meter fill (0..1) from dBFS: −48 dB → empty, 0 dB → full. */
export const meterFill = (db: number | null): number => (db == null ? 0 : Math.max(0, Math.min(1, (db + 48) / 48)))

/** 33⅓ rpm platter: degrees for a track position (s). Reverse playback rotates backwards automatically. */
export const platterAngle = (posSec: number): number => (posSec * (100 / 3 / 60) * 360) % 360

export function fmtClock(s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const neg = s < 0
  const a = Math.abs(s)
  const m = Math.floor(a / 60)
  const sec = Math.floor(a % 60)
  return `${neg ? '−' : ''}${m}:${String(sec).padStart(2, '0')}`
}

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export const fmtPct = (p: number): string => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`
