/**
 * DJ performance effects shared by the live engine and the offline renderer.
 *
 * "Performance" moves change WHICH audio plays (loop roll, vinyl brake, spinback, baby
 * scratch). They are rendered here as a PCM segment in pure TypeScript; the live engine
 * switches the deck to this segment at the exact beat, so live and offline output are the
 * same samples. Continuous effects (bipolar filter knob, echo send) run as native Web Audio
 * nodes live; `applyFilterAndEcho` is the offline equivalent.
 */

export type PerfOp =
  /** Beat-repeat roll: repeat the slice starting at `atBeat` with shrinking sizes (beats). */
  | { kind: 'roll'; atBeat: number; sizes: number[]; stepBeats: number }
  /** Vinyl brake: playback speed falls to 0 over `beats`, then silence. */
  | { kind: 'brake'; atBeat: number; beats: number }
  /** Spinback: audio before `atBeat` plays backwards, fast then slowing, over `beats`. */
  | { kind: 'spinback'; atBeat: number; beats: number }
  /** Baby scratch on the slice at `atBeat` (forward/back strokes), `beats` long. */
  | { kind: 'scratch'; atBeat: number; beats: number; strokes: number }

export interface Performance {
  /** Track second at which the performance segment starts (beat 0 of `ops`). */
  startSec: number
  beatSec: number
  /** Total beats the segment covers; normal playback outside ops. */
  beats: number
  ops: PerfOp[]
}

function readAt(x: Float32Array, pos: number): number {
  const i = Math.floor(pos)
  if (i < 0 || i + 1 >= x.length) return 0
  const f = pos - i
  return x[i] * (1 - f) + x[i + 1] * f
}

/** Renders `perf.beats` of audio starting at `perf.startSec` with the performance ops applied. */
export function renderPerformance(channels: Float32Array[], rate: number, perf: Performance): Float32Array[] {
  const B = perf.beatSec * rate
  const n = Math.round(perf.beats * B)
  const s0 = perf.startSec * rate
  const ops = [...perf.ops].sort((a, b) => a.atBeat - b.atBeat)
  return channels.map((src) => {
    const out = new Float32Array(n)
    // default: straight playback
    for (let i = 0; i < n; i++) out[i] = readAt(src, s0 + i)
    for (const op of ops) {
      const o0 = Math.round(op.atBeat * B)
      if (op.kind === 'roll') {
        let t = o0
        const sliceStart = s0 + o0
        for (const size of op.sizes) {
          const len = Math.max(32, Math.round(size * B))
          const until = Math.min(n, t + Math.round(op.stepBeats * B))
          for (let i = t; i < until; i++) {
            const k = (i - t) % len
            // 3 ms fades at slice edges avoid clicks
            const edge = Math.min(1, k / 132, (len - k) / 132)
            out[i] = readAt(src, sliceStart + k) * edge
          }
          t = until
        }
        // after the roll, silence until the incoming drop (the roll is the transition)
        for (let i = t; i < n; i++) out[i] = 0
      } else if (op.kind === 'brake') {
        const len = Math.round(op.beats * B)
        let pos = s0 + o0
        for (let i = 0; i < n - o0; i++) {
          const u = i / len
          const speed = u < 1 ? Math.max(0, 1 - u) ** 1.6 : 0
          out[o0 + i] = speed > 0 ? readAt(src, pos) * Math.min(1, speed * 4) : 0
          pos += speed
        }
      } else if (op.kind === 'spinback') {
        const len = Math.round(op.beats * B)
        let pos = s0 + o0
        for (let i = 0; i < n - o0; i++) {
          const u = i / len
          const speed = u < 1 ? 3 * (1 - u) ** 1.3 : 0
          out[o0 + i] = speed > 0 ? readAt(src, pos) * Math.min(1, (1 - u) * 3) : 0
          pos -= speed
        }
      } else if (op.kind === 'scratch') {
        const len = Math.round(op.beats * B)
        const stroke = len / Math.max(1, op.strokes)
        const sliceLen = 0.25 * B
        for (let i = 0; i < Math.min(len, n - o0); i++) {
          const k = i % stroke
          const ph = k / stroke // 0..1 within a stroke: forward half, back half
          // record position follows a smooth forward-then-back motion over the slice
          const p = ph < 0.5 ? Math.sin(ph * Math.PI) : Math.sin(ph * Math.PI)
          const dir = ph < 0.5 ? 1 : -1
          const pos = s0 + o0 + p * sliceLen
          const gain = 0.85 * Math.min(1, Math.abs(Math.cos(ph * Math.PI)) * 3 + 0.15)
          out[o0 + i] = readAt(src, pos) * gain * (dir > 0 ? 1 : 0.9)
        }
      }
    }
    return out
  })
}

/** What the deck is doing `x` seconds into a performance segment — the read head of `renderPerformance`. */
export interface PerformanceState {
  /** Track second being read (the platter position). */
  pos: number
  /** Playback speed and direction (1 = normal, 0 = stopped, < 0 = reverse). */
  speed: number
  /** Active op, if any (`silent` = after a roll, the deck outputs nothing until the incoming drop). */
  op?: PerfOp['kind'] | 'silent'
  /** Active loop for a roll: start (track s) and length in beats. */
  loop?: { startSec: number; beats: number }
}

/**
 * Closed-form mirror of `renderPerformance`'s read position. Ops are applied in beat order and a
 * later op overwrites an earlier one where they overlap — exactly as the renderer writes them. The
 * renderer integrates brake/spinback speed sample by sample; these are the integrals of the same
 * speed laws (tested against the renderer with a ramp signal in fx.test.ts).
 */
export function performanceStateAt(perf: Performance, x: number): PerformanceState {
  const B = perf.beatSec
  const segEnd = perf.beats * B
  let st: PerformanceState = { pos: perf.startSec + x, speed: 1 }
  if (x < 0 || x >= segEnd) return st
  const ops = [...perf.ops].sort((a, b) => a.atBeat - b.atBeat)
  for (const op of ops) {
    const o0 = op.atBeat * B
    if (x < o0) continue
    const k = x - o0
    const at = perf.startSec + o0
    if (op.kind === 'roll') {
      const step = op.stepBeats * B
      const s = Math.floor(k / step)
      if (s < op.sizes.length) {
        const len = Math.max(32 / 44100, op.sizes[s] * B)
        st = { pos: at + ((k - s * step) % len), speed: 1, op: 'roll', loop: { startSec: at, beats: op.sizes[s] } }
      } else st = { pos: at, speed: 0, op: 'silent' }
    } else if (op.kind === 'brake') {
      const len = op.beats * B
      const u = Math.min(1, k / len)
      st = { pos: at + (len * (1 - (1 - u) ** 2.6)) / 2.6, speed: u < 1 ? (1 - u) ** 1.6 : 0, op: 'brake' }
    } else if (op.kind === 'spinback') {
      const len = op.beats * B
      const u = Math.min(1, k / len)
      st = { pos: at - (3 * len * (1 - (1 - u) ** 2.3)) / 2.3, speed: u < 1 ? -3 * (1 - u) ** 1.3 : 0, op: 'spinback' }
    } else if (op.kind === 'scratch') {
      const len = op.beats * B
      if (k >= len) continue
      const stroke = len / Math.max(1, op.strokes)
      const ph = (k % stroke) / stroke
      const slice = 0.25 * B
      st = { pos: at + Math.sin(ph * Math.PI) * slice, speed: ((Math.cos(ph * Math.PI) * Math.PI) / stroke) * slice, op: 'scratch' }
    }
  }
  return st
}

// ───────────────────────── offline filter knob + echo ─────────────────────────

/** Bipolar DJ filter knob: −1 = fully low-passed (≈120 Hz), 0 = off, +1 = fully high-passed (≈6 kHz). */
export function filterCutoffs(knob: number): { lp: number; hp: number } {
  const k = Math.max(-1, Math.min(1, knob))
  return { lp: k < 0 ? 20000 * Math.pow(120 / 20000, -k) : 20000, hp: k > 0 ? 20 * Math.pow(6000 / 20, k) : 20 }
}

export class OfflineBiquad {
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  private c = [1, 0, 0, 0, 0]
  set(type: 'lowpass' | 'highpass', f0: number, rate: number, q = 0.9): void {
    const w = (2 * Math.PI * Math.min(f0, rate * 0.45)) / rate
    const alpha = Math.sin(w) / (2 * q)
    const cos = Math.cos(w)
    const a0 = 1 + alpha
    this.c =
      type === 'lowpass'
        ? [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
        : [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
  }
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

/** Tempo-synced feedback delay (echo-out); state persists so tails ring past the dry signal. */
export class OfflineEcho {
  private buf: Float32Array
  private w = 0
  constructor(
    private readonly delaySamples: number,
    private readonly feedback: number,
  ) {
    this.buf = new Float32Array(Math.max(1, Math.round(delaySamples)) + 1)
  }
  /** send = signal fed into the echo; returns the wet output. */
  process(send: number): number {
    const L = this.buf.length
    const r = (this.w - Math.round(this.delaySamples) + L) % L
    const wet = this.buf[r]
    this.buf[this.w] = send + wet * this.feedback
    this.w = (this.w + 1) % L
    return wet
  }
}
