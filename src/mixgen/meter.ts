/**
 * Streaming output stage for long renders (constant memory):
 *  - MasterLimiter: look-ahead peak limiter (5 ms look-ahead, 150 ms release, −1 dBFS ceiling).
 *  - MixAnalyzer: BS.1770 integrated loudness (streaming 400 ms / 75 % blocks), sample peak,
 *    clipped-sample count, silence runs (unintended gaps), waveform peaks and an RMS/bass
 *    energy curve computed from the ACTUAL output samples (the player waveform comes from here).
 */
import { highPass, highShelf, type Biquad } from '../dsp/loudness'

export class MasterLimiter {
  private readonly look: number
  private readonly delay: Float32Array[]
  private w = 0
  private env = 1
  private readonly rel: number
  private t = 0
  // monotonic deque (sample index, peak) for the sliding look-ahead maximum
  private readonly dqIdx: Float64Array
  private readonly dqVal: Float32Array
  private head = 0
  private tail = 0
  minGain = 1
  constructor(
    readonly channels: number,
    readonly rate: number,
    readonly ceiling = 0.891,
  ) {
    this.look = Math.round(0.005 * rate)
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.look))
    this.rel = 1 / (0.15 * rate)
    this.dqIdx = new Float64Array(this.look + 2)
    this.dqVal = new Float32Array(this.look + 2)
  }
  /** Process in place; output is delayed by the look-ahead (call flush() at the end). */
  process(block: Float32Array[]): void {
    const n = block[0].length
    const cap = this.dqIdx.length
    for (let i = 0; i < n; i++) {
      let m = 0
      for (let c = 0; c < this.channels; c++) {
        const a = Math.abs(block[c][i])
        if (a > m) m = a
      }
      // push m; pop smaller values from the back; drop expired from the front
      while (this.tail !== this.head && this.dqVal[(this.tail - 1 + cap) % cap] <= m) this.tail = (this.tail - 1 + cap) % cap
      this.dqIdx[this.tail] = this.t
      this.dqVal[this.tail] = m
      this.tail = (this.tail + 1) % cap
      while (this.dqIdx[this.head] < this.t - this.look) this.head = (this.head + 1) % cap
      const wm = this.dqVal[this.head]
      const need = wm > this.ceiling ? this.ceiling / wm : 1
      this.env = need < this.env ? need : Math.min(need, this.env + (1 - this.env) * this.rel)
      if (this.env < this.minGain) this.minGain = this.env
      for (let c = 0; c < this.channels; c++) {
        const d = this.delay[c][this.w]
        this.delay[c][this.w] = block[c][i]
        let y = d * this.env
        if (y > this.ceiling) y = this.ceiling
        else if (y < -this.ceiling) y = -this.ceiling
        block[c][i] = y
      }
      this.w = (this.w + 1) % this.look
      this.t++
    }
  }
  /** Drain the look-ahead delay (returns the final `look` samples). */
  flush(): Float32Array[] {
    const tail = Array.from({ length: this.channels }, () => new Float32Array(this.look))
    this.process(tail)
    return tail
  }
  get latency(): number {
    return this.look
  }
}

class KFilter {
  private s = [0, 0, 0, 0]
  constructor(private readonly f: Biquad) {}
  run(x: number): number {
    const f = this.f
    const v = f.b0 * x + f.b1 * this.s[0] + f.b2 * this.s[1] - f.a1 * this.s[2] - f.a2 * this.s[3]
    this.s[1] = this.s[0]
    this.s[0] = x
    this.s[3] = this.s[2]
    this.s[2] = v
    return v
  }
}

export interface MixMetrics {
  samples: number
  durationSec: number
  integratedLufs: number
  samplePeakDb: number
  clippedSamples: number
  /** Silence runs (< −60 dBFS) longer than 1 s, in seconds of mix time. */
  silences: Array<{ startSec: number; durationSec: number }>
  /** Largest jump in 1-second short-term RMS between neighbouring seconds (dB), excluding silence. */
  maxLevelJumpDb: number
  waveform: { secPerBucket: number; min: number[]; max: number[] }
  /** Per-second energy: RMS dB and low-band (<150 Hz) RMS dB. */
  energy: { secPerPoint: number; rmsDb: number[]; bassDb: number[] }
}

export class MixAnalyzer {
  private n = 0
  private readonly hs: KFilter[]
  private readonly hp: KFilter[]
  private readonly blockLen: number
  private readonly step: number
  // ring of 100 ms sub-block mean squares (4 per 400 ms block)
  private subMs = 0
  private subCount = 0
  private readonly subs: number[] = []
  private readonly blocks: number[] = []
  private peak = 0
  private clipped = 0
  private silentRun = 0
  private silentStart = 0
  readonly silences: MixMetrics['silences'] = []
  private readonly bucketLen: number
  private bMin = 0
  private bMax = 0
  private bCount = 0
  readonly wMin: number[] = []
  readonly wMax: number[] = []
  private secSq = 0
  private secBass = 0
  private secCount = 0
  readonly rmsDb: number[] = []
  readonly bassDb: number[] = []
  private lp1 = 0
  private lp2 = 0
  private readonly lpA: number
  constructor(
    readonly channels: number,
    readonly rate: number,
    readonly secPerBucket = 0.05,
  ) {
    this.hs = Array.from({ length: channels }, () => new KFilter(highShelf(rate)))
    this.hp = Array.from({ length: channels }, () => new KFilter(highPass(rate)))
    this.blockLen = Math.round(0.4 * rate)
    this.step = Math.round(0.1 * rate)
    this.bucketLen = Math.max(1, Math.round(secPerBucket * rate))
    this.lpA = Math.exp((-2 * Math.PI * 150) / rate)
  }

  push(block: Float32Array[]): void {
    const nch = this.channels
    const len = block[0].length
    for (let i = 0; i < len; i++) {
      let kSum = 0
      let mono = 0
      for (let c = 0; c < nch; c++) {
        const x = block[c][i]
        const a = Math.abs(x)
        if (a > this.peak) this.peak = a
        if (a >= 0.999) this.clipped++
        mono += x
        const k = this.hp[c].run(this.hs[c].run(x))
        kSum += k * k
      }
      mono /= nch
      // streaming BS.1770: 100 ms sub-blocks, 400 ms blocks with 75 % overlap
      this.subMs += kSum
      if (++this.subCount === this.step) {
        this.subs.push(this.subMs / this.step)
        this.subMs = 0
        this.subCount = 0
        if (this.subs.length >= 4) {
          const s = this.subs.slice(-4)
          this.blocks.push((s[0] + s[1] + s[2] + s[3]) / 4)
          if (this.subs.length > 8) this.subs.splice(0, this.subs.length - 4)
        }
      }
      // waveform buckets
      if (this.bCount === 0) {
        this.bMin = mono
        this.bMax = mono
      } else {
        if (mono < this.bMin) this.bMin = mono
        if (mono > this.bMax) this.bMax = mono
      }
      if (++this.bCount === this.bucketLen) {
        this.wMin.push(Math.round(this.bMin * 1000) / 1000)
        this.wMax.push(Math.round(this.bMax * 1000) / 1000)
        this.bCount = 0
      }
      // energy per second (+ simple 2-pole low-pass for the bass band)
      this.lp1 = this.lp1 * this.lpA + mono * (1 - this.lpA)
      this.lp2 = this.lp2 * this.lpA + this.lp1 * (1 - this.lpA)
      this.secSq += mono * mono
      this.secBass += this.lp2 * this.lp2
      if (++this.secCount === this.rate) {
        this.rmsDb.push(Math.round(10 * Math.log10(this.secSq / this.rate + 1e-12) * 10) / 10)
        this.bassDb.push(Math.round(10 * Math.log10(this.secBass / this.rate + 1e-12) * 10) / 10)
        this.secSq = 0
        this.secBass = 0
        this.secCount = 0
      }
      // silence runs
      const loud = Math.abs(mono) > 0.001
      if (!loud) {
        if (this.silentRun === 0) this.silentStart = this.n
        this.silentRun++
      } else {
        this.endSilence()
      }
      this.n++
    }
  }

  private endSilence(): void {
    // a run counts only if no sample exceeded −60 dBFS for > 1 s
    if (this.silentRun > this.rate) this.silences.push({ startSec: this.silentStart / this.rate, durationSec: this.silentRun / this.rate })
    this.silentRun = 0
  }

  finish(): MixMetrics {
    this.endSilence()
    if (this.bCount > 0) {
      this.wMin.push(this.bMin)
      this.wMax.push(this.bMax)
    }
    const lufs = (ms: number) => -0.691 + 10 * Math.log10(ms + 1e-15)
    const abs = this.blocks.filter((ms) => lufs(ms) > -70)
    let integrated = -Infinity
    if (abs.length) {
      const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
      const gated = abs.filter((ms) => lufs(ms) > rel)
      if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length)
    }
    let maxJump = 0
    for (let i = 1; i < this.rmsDb.length; i++) {
      if (this.rmsDb[i] < -45 || this.rmsDb[i - 1] < -45) continue
      maxJump = Math.max(maxJump, Math.abs(this.rmsDb[i] - this.rmsDb[i - 1]))
    }
    return {
      samples: this.n,
      durationSec: this.n / this.rate,
      integratedLufs: Math.round(integrated * 10) / 10,
      samplePeakDb: Math.round(20 * Math.log10(Math.max(this.peak, 1e-9)) * 100) / 100,
      clippedSamples: this.clipped,
      silences: this.silences,
      maxLevelJumpDb: Math.round(maxJump * 10) / 10,
      waveform: { secPerBucket: this.bucketLen / this.rate, min: this.wMin, max: this.wMax },
      energy: { secPerPoint: 1, rmsDb: this.rmsDb, bassDb: this.bassDb },
    }
  }
}
