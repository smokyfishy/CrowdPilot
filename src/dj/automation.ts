/**
 * Automation-curve evaluation shared by the offline DSP renderer (src/dj/render.ts) and the
 * Listen page's virtual DJ controller (src/mixgen/performance.ts). Both read the SAME executed
 * TransitionPlan curves through this one function, so a knob on screen can only show the value
 * the renderer applied at that beat.
 */
import type { CurvePoint } from './transitions'

/** Piecewise-linear value of `curve` at `beat`; holds the first/last value outside its range. Empty → `empty`. */
export function curveAt(curve: CurvePoint[] | undefined, beat: number, empty = 0): number {
  if (!curve?.length) return empty
  if (beat <= curve[0].beat) return curve[0].value
  for (let i = 1; i < curve.length; i++) {
    if (beat <= curve[i].beat) {
      const a = curve[i - 1]
      const b = curve[i]
      const span = b.beat - a.beat
      return span <= 0 ? b.value : a.value + ((b.value - a.value) * (beat - a.beat)) / span
    }
  }
  return curve[curve.length - 1].value
}
