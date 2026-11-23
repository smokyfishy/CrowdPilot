/**
 * Offline transition renderer (pure TypeScript, Node or browser). Renders the
 * SAME TransitionPlan the live Web Audio engine schedules: per-deck fader gains and
 * 3-band Linkwitz–Riley isolator EQ (same crossovers as the engine),
 * WSOLA tempo matching for the incoming deck, loudness trim, and a simple
 * look-ahead-free safety limiter. Used for tests, benchmarks, A/B listening exports.
 */
import { type StretchOptions, wsola } from '../dsp/stretch'
import { curveAt } from './automation'
import { filterCutoffs, OfflineBiquad, OfflineEcho, renderPerformance } from './fx'
import type { TransitionPlan } from './transitions'

export interface RenderInput {
  rate: number
  out: Float32Array[] // stereo or mono PCM of the outgoing track (original)
  in: Float32Array[] // incoming track (original)
  plan: TransitionPlan
  preRollSec?: number
  postRollSec?: number
  outTrimDb?: number
  inTrimDb?: number
  /** Also return each deck's post-fader signal (mono, pre-limiter); used by objective metrics / training. */
  stems?: boolean
  /** WSOLA options (default: 2048-sample frames at ≥ 44.1 kHz, scaled down for lower rates). */
  stretch?: StretchOptions
}

export interface RenderOutput {
  channels: Float32Array[]
  rate: number
  /** Output sample at which the transition starts (= plan.outCueSec in the outgoing timeline). */
  transitionStartSample: number
  peak: number
  clippedSamples: number
  limiterGainReductionDb: number
  /** Mono post-fader deck signals (outgoing incl. its echo) when `stems` was requested. */
  stemA?: Float32Array
  stemB?: Float32Array
}

type Coeffs = [number, number, number, number, number]

/** RBJ 2nd-order Butterworth (Q = 1/√2) low/high-pass — same as Web Audio BiquadFilterNode. */
function butter(type: 'low' | 'high', f0: number, rate: number): Coeffs {
  const w0 = (2 * Math.PI * f0) / rate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  if (type === 'low') return [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
  return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
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
  const dropSample = plan.incomingDropSec === undefined ? undefined : Math.round(plan.incomingDropSec * rate)
  const needLen = total - tStart
  let incoming: Float32Array[]
  const dropOutputSample = Math.round((plan.incomingDropOffsetSec ?? plan.durationSec) * rate)
  const needsDropAnchor = dropSample !== undefined && dropOutputSample > 0 && inCue + dropOutputSample !== dropSample
  if (Math.abs(plan.tempoRatio - 1) > 1e-4 || needsDropAnchor) {
    const rec = plan.tempoRecoveryBars * 4 * plan.beatSec * rate
    const r = plan.tempoRatio
    const frame = rate >= 44100 ? 2048 : 2 * Math.round((2048 * rate) / 44100 / 2)
    const st = wsola(input.in, inCue, needLen, (s) => (s <= overlap ? r : rec > 0 ? (s >= overlap + rec ? 1 : r + (1 - r) * ((s - overlap) / rec)) : r), {
      frame, tolerance: Math.round(frame / 8), ...input.stretch,
      ...(dropSample !== undefined ? { anchor: { outputSample: dropOutputSample, inputSample: dropSample } } : {}),
    })
    incoming = st.channels
  } else {
    incoming = input.in.map((c) => c.subarray(inCue, inCue + needLen))
  }

  const out = Array.from({ length: nch }, () => new Float32Array(total))
  // 3-band LR4 isolator per deck and channel (matches DjEngine): low = LP·LP @200,
  // mid = HP·HP @200 → LP·LP @2500, high = HP·HP @200 → HP·HP @2500.
  const makeIso = () => {
    const mk = (t: 'low' | 'high', f: number) => {
      const q = new Biquad()
      q.c = butter(t, f, rate)
      return q
    }
    return { l: [mk('low', 200), mk('low', 200)], m: [mk('high', 200), mk('high', 200), mk('low', 2500), mk('low', 2500)], h: [mk('high', 200), mk('high', 200), mk('high', 2500), mk('high', 2500)] }
  }
  const isoA = Array.from({ length: nch }, makeIso)
  const isoB = Array.from({ length: nch }, makeIso)
  const run = (chain: Biquad[], x: number) => chain.reduce((v, q) => q.process(v), x)
  const band = (db: number) => (db <= -40 ? 0 : 10 ** (db / 20))
  const trimA = 10 ** ((input.outTrimDb ?? 0) / 20)
  const trimB = 10 ** ((input.inTrimDb ?? 0) / 20)
  const beatOf = (i: number) => (i - tStart) / rate / plan.beatSec
  // Performance segment (roll/brake/scratch) replaces the outgoing audio in its window.
  const perf = plan.outPerf
    ? { from: tStart + Math.round(plan.outPerf.startBeat * plan.beatSec * rate), data: renderPerformance(input.out, rate, { startSec: plan.outCueSec + plan.outPerf.startBeat * plan.beatSec, beatSec: plan.beatSec, beats: plan.outPerf.beats, ops: plan.outPerf.ops }) }
    : null
  // Bipolar filter knob per deck (low-pass + high-pass in series) and the outgoing echo send.
  const mkF = () => ({ lp: new OfflineBiquad(), hp: new OfflineBiquad() })
  const fA = Array.from({ length: nch }, mkF)
  const fB = Array.from({ length: nch }, mkF)
  const echo = plan.echo ? Array.from({ length: nch }, () => new OfflineEcho(plan.echo!.delayBeats * plan.beatSec * rate, plan.echo!.feedback)) : null
  const stemA = input.stems ? new Float32Array(total) : undefined
  const stemB = input.stems ? new Float32Array(total) : undefined
  let peak = 0
  let clipped = 0
  let env = 1
  let minEnv = 1
  for (let blk = 0; blk < total; blk += BLOCK) {
    const beat = beatOf(blk + BLOCK / 2)
    const inTransition = blk + BLOCK > tStart
    const gA = inTransition ? curveAt(plan.out.gain, beat) : 1
    const gB = inTransition ? curveAt(plan.in.gain, beat) : 0
    const bandsOf = (d: TransitionPlan['out']) => (inTransition ? [band(curveAt(d.low, beat)), band(curveAt(d.mid, beat)), band(curveAt(d.high, beat))] : [1, 1, 1])
    const [aL, aM, aH] = bandsOf(plan.out)
    const [bL, bM, bH] = bandsOf(plan.in)
    const knobA = inTransition && plan.filter?.out ? curveAt(plan.filter.out, beat) : 0
    const knobB = inTransition && plan.filter?.in ? curveAt(plan.filter.in, beat) : 0
    for (const [fs, k] of [[fA, knobA], [fB, knobB]] as const) {
      if (k === 0) continue
      const cut = filterCutoffs(k)
      for (const f of fs) {
        f.lp.set('lowpass', cut.lp, rate)
        f.hp.set('highpass', cut.hp, rate)
      }
    }
    const send = inTransition && plan.echo ? curveAt(plan.echo.send, beat) : 0
    const end = Math.min(total, blk + BLOCK)
    for (let i = blk; i < end; i++) {
      const aIdx = outStart + i
      const bIdx = i - tStart
      const pIdx = perf ? i - perf.from : -1
      for (let c = 0; c < nch; c++) {
        const srcA = ch(input.out, c)
        let xa = aIdx < srcA.length ? srcA[aIdx] * trimA : 0
        if (perf && pIdx >= 0 && pIdx < perf.data[0].length) xa = ch(perf.data, c)[pIdx] * trimA
        const ia = isoA[c]
        let a = run(ia.l, xa) * aL + run(ia.m, xa) * aM + run(ia.h, xa) * aH
        if (knobA !== 0) a = fA[c].hp.process(fA[c].lp.process(a))
        let xb = 0
        if (bIdx >= 0) {
          const srcB = ch(incoming, c)
          xb = bIdx < srcB.length ? srcB[bIdx] * trimB : 0
        }
        const ib = isoB[c]
        let b = run(ib.l, xb) * bL + run(ib.m, xb) * bM + run(ib.h, xb) * bH
        if (knobB !== 0) b = fB[c].hp.process(fB[c].lp.process(b))
        const wet = echo ? echo[c].process(a * send) : 0
        out[c][i] = a * gA + b * gB + wet
        if (stemA) {
          stemA[i] += (a * gA + wet) / nch
          stemB![i] += (b * gB) / nch
        }
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
  return { channels: out, rate, transitionStartSample: tStart, peak, clippedSamples: clipped, limiterGainReductionDb: -20 * Math.log10(minEnv), ...(stemA ? { stemA, stemB } : {}) }
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
