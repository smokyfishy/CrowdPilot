/**
 * Offline transition renderer (pure TypeScript, Node or browser). Renders the
 * SAME TransitionPlan the live Web Audio engine schedules: per-deck fader gains and
 * RBJ low-shelf / peaking / high-shelf EQ (same frequencies/Q as the engine),
 * WSOLA tempo matching for the incoming deck, loudness trim, and a simple
 * look-ahead-free safety limiter. Used for tests, benchmarks, A/B listening exports.
 */
import { wsola } from '../../src/dsp/stretch'
import type { CurvePoint, TransitionPlan } from './transitions'

export interface RenderInput {
  rate: number
  out: Float32Array[] // stereo or mono PCM of the outgoing track (original)
  in: Float32Array[] // incoming track (original)
  plan: TransitionPlan
  preRollSec?: number
  postRollSec?: number
  outTrimDb?: number
  inTrimDb?: number
}

export interface RenderOutput {
  channels: Float32Array[]
  rate: number
  /** Output sample at which the transition starts (= plan.outCueSec in the outgoing timeline). */
  transitionStartSample: number
  peak: number
  clippedSamples: number
  limiterGainReductionDb: number
}

function curveAt(curve: CurvePoint[], beat: number): number {
  if (!curve.length) return 0
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

type Coeffs = [number, number, number, number, number]

function shelf(type: 'low' | 'high', f0: number, gainDb: number, rate: number): Coeffs {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f0) / rate
  const cos = Math.cos(w0)
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2 // S = 1 (Web Audio shelf slope)
  const sq = 2 * Math.sqrt(A) * alpha
  if (type === 'low') {
    const a0 = A + 1 + (A - 1) * cos + sq
    return [(A * (A + 1 - (A - 1) * cos + sq)) / a0, (2 * A * (A - 1 - (A + 1) * cos)) / a0, (A * (A + 1 - (A - 1) * cos - sq)) / a0, (-2 * (A - 1 + (A + 1) * cos)) / a0, (A + 1 + (A - 1) * cos - sq) / a0]
  }
  const a0 = A + 1 - (A - 1) * cos + sq
  return [(A * (A + 1 + (A - 1) * cos + sq)) / a0, (-2 * A * (A - 1 + (A + 1) * cos)) / a0, (A * (A + 1 + (A - 1) * cos - sq)) / a0, (2 * (A - 1 - (A + 1) * cos)) / a0, (A + 1 - (A - 1) * cos - sq) / a0]
}

function peaking(f0: number, q: number, gainDb: number, rate: number): Coeffs {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f0) / rate
  const alpha = Math.sin(w0) / (2 * q)
  const cos = Math.cos(w0)
  const a0 = 1 + alpha / A
  return [(1 + alpha * A) / a0, (-2 * cos) / a0, (1 - alpha * A) / a0, (-2 * cos) / a0, (1 - alpha / A) / a0]
}

class Biquad {
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  c: Coeffs = [1, 0, 0, 0, 0]
  process(x: number): number {
    const [b0, b1, b2, a1, a2] = this.c
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

const BLOCK = 128

export function renderTransition(input: RenderInput): RenderOutput {
  const { rate, plan } = input
  const pre = input.preRollSec ?? 8
  const post = input.postRollSec ?? 8
  const nch = Math.max(input.out.length, input.in.length)
  const ch = (bufs: Float32Array[], c: number) => bufs[Math.min(c, bufs.length - 1)]
  const outStart = Math.max(0, Math.round((plan.outCueSec - pre) * rate))
  const tStart = Math.round(plan.outCueSec * rate) - outStart // transition start in output samples
  const overlap = Math.round(plan.durationSec * rate)
  const total = tStart + overlap + Math.round(post * rate)

  // Incoming deck audio from its cue, tempo-matched with WSOLA if needed.
  const inCue = Math.round(plan.inCueSec * rate)
  const needLen = total - tStart
  let incoming: Float32Array[]
  if (Math.abs(plan.tempoRatio - 1) > 1e-4) {
    const rec = plan.tempoRecoveryBars * 4 * plan.beatSec * rate
    const r = plan.tempoRatio
    const st = wsola(input.in, inCue, needLen, (s) => (s <= overlap ? r : rec > 0 ? (s >= overlap + rec ? 1 : r + (1 - r) * ((s - overlap) / rec)) : r))
    incoming = st.channels
  } else {
    incoming = input.in.map((c) => c.subarray(inCue, inCue + needLen))
  }

  const out = Array.from({ length: nch }, () => new Float32Array(total))
  const eqA = { low: [] as Biquad[], mid: [] as Biquad[], high: [] as Biquad[] }
  const eqB = { low: [] as Biquad[], mid: [] as Biquad[], high: [] as Biquad[] }
  for (let c = 0; c < nch; c++) for (const eq of [eqA, eqB]) for (const k of ['low', 'mid', 'high'] as const) eq[k].push(new Biquad())
  const trimA = 10 ** ((input.outTrimDb ?? 0) / 20)
  const trimB = 10 ** ((input.inTrimDb ?? 0) / 20)
  const beatOf = (i: number) => (i - tStart) / rate / plan.beatSec
  let peak = 0
  let clipped = 0
  let env = 1
  let minEnv = 1
  for (let blk = 0; blk < total; blk += BLOCK) {
    const beat = beatOf(blk + BLOCK / 2)
    const inTransition = blk + BLOCK > tStart
    const gA = inTransition ? curveAt(plan.out.gain, beat) : 1
    const gB = inTransition ? curveAt(plan.in.gain, beat) : 0
    const set = (eq: typeof eqA, d: TransitionPlan['out']) => {
      const lo = inTransition ? curveAt(d.low, beat) : 0
      const md = inTransition ? curveAt(d.mid, beat) : 0
      const hi = inTransition ? curveAt(d.high, beat) : 0
      for (let c = 0; c < nch; c++) {
        eq.low[c].c = shelf('low', 250, lo, rate)
        eq.mid[c].c = peaking(1000, 0.7, md, rate)
        eq.high[c].c = shelf('high', 4000, hi, rate)
      }
    }
    set(eqA, plan.out)
    set(eqB, plan.in)
    const end = Math.min(total, blk + BLOCK)
    for (let i = blk; i < end; i++) {
      const aIdx = outStart + i
      const bIdx = i - tStart
      for (let c = 0; c < nch; c++) {
        const srcA = ch(input.out, c)
        let a = aIdx < srcA.length && gA > 0 ? srcA[aIdx] * trimA : 0
        a = eqA.high[c].process(eqA.mid[c].process(eqA.low[c].process(a)))
        let b = 0
        if (bIdx >= 0 && gB > 0) {
          const srcB = ch(incoming, c)
          b = bIdx < srcB.length ? srcB[bIdx] * trimB : 0
        }
        b = eqB.high[c].process(eqB.mid[c].process(eqB.low[c].process(b)))
        out[c][i] = a * gA + b * gB
      }
      // safety limiter: instant attack, 100 ms release, ceiling −1 dBFS
      let m = 0
      for (let c = 0; c < nch; c++) m = Math.max(m, Math.abs(out[c][i]))
      const ceiling = 0.891
      const need = m * env > ceiling ? ceiling / m : 1
      env = need < env ? need : env + (1 - env) * (1 / (0.1 * rate))
      minEnv = Math.min(minEnv, env)
      for (let c = 0; c < nch; c++) {
        out[c][i] *= env
        const v = Math.abs(out[c][i])
        if (v > peak) peak = v
        if (v >= 0.999) clipped++
      }
    }
  }
  return { channels: out, rate, transitionStartSample: tStart, peak, clippedSamples: clipped, limiterGainReductionDb: -20 * Math.log10(minEnv) }
}

/** 16-bit PCM WAV encoder (for A/B listening exports). */
export function encodeWav(channels: Float32Array[], rate: number): Uint8Array {
  const n = channels[0].length
  const nch = channels.length
  const buf = new ArrayBuffer(44 + n * nch * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  w(0, 'RIFF')
  v.setUint32(4, 36 + n * nch * 2, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, nch, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * nch * 2, true)
  v.setUint16(32, nch * 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, n * nch * 2, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return new Uint8Array(buf)
}
