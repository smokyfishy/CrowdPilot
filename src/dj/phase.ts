/**
 * Automatic "jog nudge": fine beat-phase alignment of the incoming track at commit time.
 *
 * Beat grids (even from Beat This!) can be 20–40 ms apart from where the KICKS actually hit,
 * because a beat label and a kick's audible attack differ by track (sub-heavy kicks peak late).
 * A DJ fixes this by ear; here we cross-correlate kick-band (< 150 Hz) onset envelopes of
 * both tracks over the first beats of the overlap (incoming warped by the tempo ratio) and
 * shift the incoming cue by the best lag within ±60 ms. Used by the live engine and the
 * offline renderer/evaluation alike.
 */

const HOP = 64
const MAX_LAG_SEC = 0.06

function kickEnv(ch: Float32Array, rate: number, startSec: number, durSec: number): Float32Array {
  const w = (2 * Math.PI * 150) / rate
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const c = Math.cos(w)
  const a0 = 1 + alpha
  const b0 = (1 - c) / 2 / a0
  const b1 = (1 - c) / a0
  const a1 = (-2 * c) / a0
  const a2 = (1 - alpha) / a0
  const s0 = Math.max(0, Math.floor(startSec * rate))
  const s1 = Math.min(ch.length, Math.floor((startSec + durSec) * rate))
  const n = Math.max(0, Math.floor((s1 - s0) / HOP))
  const env = new Float32Array(n)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  let prev = 0
  for (let k = 0; k < n; k++) {
    let e = 0
    for (let i = s0 + k * HOP; i < s0 + (k + 1) * HOP; i++) {
      const y = b0 * ch[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = ch[i]
      y2 = y1
      y1 = y
      e += y * y
    }
    const v = Math.log1p(1e4 * e)
    env[k] = Math.max(0, v - prev)
    prev = v
  }
  return env
}

export interface Nudge {
  /** Seconds to ADD to the incoming cue (in the incoming track's own timeline). */
  deltaInSec: number
  /** Normalised correlation peak (0..1); the nudge is only applied when this is meaningful. */
  strength: number
  applied: boolean
}

export function phaseNudge(outCh: Float32Array, inCh: Float32Array, rate: number, outCueSec: number, inCueSec: number, beatSec: number, tempoRatio: number, beats = 16): Nudge {
  const win = Math.max(4, beats) * beatSec
  const a = kickEnv(outCh, rate, outCueSec, win)
  const bRaw = kickEnv(inCh, rate, inCueSec, win * tempoRatio)
  // warp the incoming envelope onto the outgoing timeline (incoming plays at tempoRatio)
  const b = new Float32Array(a.length)
  for (let k = 0; k < a.length; k++) {
    const src = k * tempoRatio
    const i = Math.floor(src)
    const f = src - i
    b[k] = i + 1 < bRaw.length ? bRaw[i] * (1 - f) + bRaw[i + 1] * f : 0
  }
  const maxLag = Math.round((MAX_LAG_SEC * rate) / HOP)
  const norm = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0)) || 1
  const na = norm(a)
  const nb = norm(b)
  let best = 0
  let bestV = -Infinity
  for (let l = -maxLag; l <= maxLag; l++) {
    let s = 0
    for (let k = maxLag; k < a.length - maxLag; k++) s += a[k] * b[k + l]
    if (s > bestV) {
      bestV = s
      best = l
    }
  }
  const strength = Math.max(0, bestV / (na * nb))
  // lag > 0: incoming kicks arrive late → start the incoming that much further in
  const deltaOut = (best * HOP) / rate
  const applied = strength > 0.15 && Math.abs(best) < maxLag
  return { deltaInSec: applied ? deltaOut * tempoRatio : 0, strength, applied }
}

// ───────────────────────── local grid refinement ─────────────────────────

/** Local beat period (s) from network beats inside [t, t + span] (least squares on cumulative indices). */
export function localPeriod(beats: number[], t: number, span: number, fallback: number): number {
  const xs = beats.filter((b) => b >= t - 0.05 && b <= t + span)
  if (xs.length < 8) return fallback
  const ks: number[] = [0]
  for (let i = 1; i < xs.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((xs[i] - xs[i - 1]) / fallback)))
  const n = xs.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sx += ks[i]
    sy += xs[i]
    sxx += ks[i] * ks[i]
    sxy += ks[i] * xs[i]
  }
  const den = n * sxx - sx * sx
  const p = den ? (n * sxy - sx * sy) / den : fallback
  return Math.abs(p - fallback) / fallback < 0.03 ? p : fallback
}

export function snapToBeat(beats: number[], t: number, maxDist: number): number {
  let best = t
  let d = maxDist
  for (const b of beats) {
    const e = Math.abs(b - t)
    if (e < d) {
      d = e
      best = b
    }
  }
  return best
}

/**
 * Refine a beat-matched plan with LOCAL beat information: cues snapped to the network's actual
 * beats near them, and the tempo ratio from the two tracks' local beat periods over the overlap
 * (a global grid can be 0.02–0.1 % off or the track may drift, which flams over a 16-bar blend).
 */
export function refineWithLocalBeats<T extends { outCueSec: number; inCueSec: number; beatSec: number; tempoRatio: number; durationSec: number; incomingDropSec?: number; incomingDropOffsetSec?: number }>(
  plan: T,
  outBeats: number[] | undefined,
  inBeats: number[] | undefined,
  maxTempoDeviation = 0.06,
): T & { localRefined: boolean } {
  if (!outBeats?.length || !inBeats?.length || plan.durationSec < 1) return { ...plan, localRefined: false }
  const outCue = snapToBeat(outBeats, plan.outCueSec, plan.beatSec * 0.3)
  const inCue = snapToBeat(inBeats, plan.inCueSec, (plan.beatSec * plan.tempoRatio) * 0.3)
  const pa = localPeriod(outBeats, outCue, plan.durationSec, plan.beatSec)
  const pb = localPeriod(inBeats, inCue, plan.durationSec * plan.tempoRatio, plan.beatSec * plan.tempoRatio)
  let ratio = pb / pa
  if (Math.abs(ratio - 1) > maxTempoDeviation) ratio = plan.tempoRatio
  const durationSec = (plan.durationSec / plan.beatSec) * pa
  // A drop is the endpoint of the blend, so the local tempo fit must move the
  // cue backwards from that endpoint instead of letting the endpoint drift.
  const dropOffset = (plan.incomingDropOffsetSec ?? plan.durationSec) / plan.beatSec * pa
  const anchoredCue = plan.incomingDropSec === undefined ? inCue : plan.incomingDropSec - dropOffset * ratio
  if (anchoredCue < 0) return { ...plan, localRefined: false }
  return { ...plan, outCueSec: outCue, inCueSec: anchoredCue, ...(plan.incomingDropSec !== undefined ? { incomingDropOffsetSec: dropOffset } : {}), beatSec: pa, tempoRatio: ratio, durationSec, localRefined: true }
}
