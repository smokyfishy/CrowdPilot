/**
 * Two-deck Web Audio DJ engine for the HOST browser.
 *
 * Signal chain per deck:  source → trim (loudness normalisation) → low shelf (250 Hz)
 *   → mid peak (1 kHz) → high shelf (4 kHz) → fader  ─┐
 * Master:  Σ decks → safety limiter (DynamicsCompressor, −1 dB, 20:1) → meter → output.
 *
 * All audible automation (gains, EQ, starts/stops) is scheduled on the AudioContext
 * clock with AudioParam ramps. UI timers are only used to *report* state changes
 * (handoff, end, silence) after they happen on the audio clock — never to make sound.
 * Tempo matching uses a pre-rendered WSOLA segment (pitch preserved); playbackRate is
 * never used for tempo (it would shift pitch).
 */
import type { CurvePoint, DeckAutomation, TransitionPlan } from '../transitions'
import { filterCutoffs, renderPerformance } from '../fx'

export type DeckId = 'A' | 'B'

export interface DeckTimeMap {
  /** Track seconds (original timeline) at a given buffer second. */
  toTrack: (bufSec: number) => number
  /** Buffer second at which a given track second plays. */
  toBuffer: (trackSec: number) => number
}

const IDENTITY: DeckTimeMap = { toTrack: (s) => s, toBuffer: (s) => s }

interface Deck {
  id: DeckId
  trim: GainNode
  /** Isolator band gains (linear amplitude, 1 = unity, 0 = kill). */
  low: GainNode
  mid: GainNode
  high: GainNode
  fader: GainNode
  /** Bipolar filter knob = low-pass + high-pass in series (after the isolator, before the fader). */
  lp: BiquadFilterNode
  hp: BiquadFilterNode
  /** Echo send (pre-fader, so tails ring after the fader closes). */
  echoSend: GainNode
  echoDelay: DelayNode
  echoFb: GainNode
  source: AudioBufferSourceNode | null
  itemId: string | null
  trackKey: string | null
  buffer: AudioBuffer | null
  map: DeckTimeMap
  startCtx: number
  startBufSec: number
  stoppedByEngine: boolean
}

export interface EngineEvents {
  onEnded?: (itemId: string) => void
  onHandoff?: (itemId: string, trackSec: number) => void
  onTransitionDone?: (fromItemId: string, toItemId: string) => void
  onSilence?: (itemId: string | null) => void
  onError?: (message: string) => void
}

export interface ScheduledTransition {
  plan: TransitionPlan
  startsAtCtx: number
  handoffAtCtx: number
  endsAtCtx: number
  incomingDeck: DeckId
  handedOff: boolean
}

export const TARGET_LUFS = -10
export const LOW_XOVER = 200
export const HIGH_XOVER = 2500

/** EQ curve value (dB, −40 = kill) → isolator band gain (linear). */
export function bandGain(db: number): number {
  return db <= -40 ? 0 : 10 ** (db / 20)
}
const MIN_LEAD_SEC = 1.0

/**
 * Loudness-normalising trim, capped by true-peak headroom: a quiet track is never
 * boosted above −1 dBTP (the limiter is a safety net, not a loudness tool).
 */
export function trimDbFor(lufs: number | undefined, truePeakDbtp?: number): number {
  if (lufs === undefined || !Number.isFinite(lufs) || lufs < -60) return 0
  let t = Math.max(-9, Math.min(6, TARGET_LUFS - lufs))
  if (truePeakDbtp !== undefined && Number.isFinite(truePeakDbtp)) t = Math.min(t, -1 - truePeakDbtp)
  return Math.max(-9, t)
}

/** Transparent below −1 dBFS; smoothly saturates above so the output can never exceed full scale. */
export function safetyCurve(n = 4096): Float32Array {
  const c = new Float32Array(n)
  const knee = 0.891 // −1 dBFS
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))
    c[i] = Math.sign(x) * Math.min(y, 0.999)
  }
  return c
}

/** Validate a plan's automation before it can touch audio (audio-safety gate). */
export function validatePlan(plan: TransitionPlan): string[] {
  const errs: string[] = []
  const beats = plan.overlapBars * 4
  if (plan.style !== 'cut' && plan.style !== 'sequential' && beats <= 0) errs.push('zero-length crossfade')
  if (!(plan.beatSec > 0.2 && plan.beatSec < 2)) errs.push('implausible beat period')
  if (!(plan.tempoRatio >= 0.94 - 1e-9 && plan.tempoRatio <= 1.06 + 1e-9)) errs.push('tempo ratio beyond ±6%')
  const check = (d: DeckAutomation, who: string) => {
    for (const [name, curve] of Object.entries(d) as Array<[string, CurvePoint[]]>) {
      for (let i = 0; i < curve.length; i++) {
        const p = curve[i]
        if (!Number.isFinite(p.beat) || !Number.isFinite(p.value)) errs.push(`${who}.${name}: non-finite point`)
        if (i && p.beat < curve[i - 1].beat) errs.push(`${who}.${name}: time goes backwards`)
        if (name === 'gain' && (p.value < 0 || p.value > 1)) errs.push(`${who}.gain out of [0,1]`)
        if (name !== 'gain' && (p.value > 6 || p.value < -40)) errs.push(`${who}.${name} EQ out of range`)
      }
    }
  }
  check(plan.out, 'out')
  check(plan.in, 'in')
  for (const [who, c] of [['out', plan.filter?.out], ['in', plan.filter?.in]] as const) {
    if (c?.some((p) => !Number.isFinite(p.value) || p.value < -1 || p.value > 1)) errs.push(`${who}.filter out of [-1,1]`)
  }
  if (plan.echo && (plan.echo.feedback < 0 || plan.echo.feedback > 0.85 || plan.echo.delayBeats * plan.beatSec > 3.9)) errs.push('unsafe echo settings')
  if (plan.echo?.send.some((p) => p.value < 0 || p.value > 1)) errs.push('echo send out of [0,1]')
  if (plan.outPerf && (plan.outPerf.beats <= 0 || plan.outPerf.beats > 16)) errs.push('performance segment length out of range')
  return errs
}

export class DjEngine {
  readonly ctx: AudioContext
  private readonly decks: Record<DeckId, Deck>
  private readonly limiter: DynamicsCompressorNode
  private readonly safety: WaveShaperNode
  private readonly master: GainNode
  readonly analyser: AnalyserNode
  private active: DeckId = 'A'
  private transition: ScheduledTransition | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private silentSince: number | null = null
  private readonly meterBuf: Float32Array
  peakDb = -Infinity
  rmsDb = -Infinity
  clipCount = 0

  constructor(
    private readonly events: EngineEvents = {},
    ctx?: AudioContext,
  ) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'playback' })
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.8
    this.limiter = this.ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.12
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.meterBuf = new Float32Array(this.analyser.fftSize)
    this.safety = this.ctx.createWaveShaper()
    this.safety.curve = safetyCurve() as Float32Array<ArrayBuffer>
    this.safety.oversample = '4x'
    this.master.connect(this.limiter)
    this.limiter.connect(this.safety)
    this.safety.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
    this.decks = { A: this.makeDeck('A'), B: this.makeDeck('B') }
    this.timer = setInterval(() => this.tick(), 100)
  }

  private makeDeck(id: DeckId): Deck {
    const c = this.ctx
    const trim = c.createGain()
    // 3-band isolator: Linkwitz–Riley 4th-order crossovers (two cascaded Butterworth biquads)
    // at 200 Hz and 2.5 kHz. The band outputs sum flat, so unity band gains are transparent and a
    // band at 0 truly removes it (unlike a shelving "kill").
    const bq = (type: BiquadFilterType, f: number) => {
      const b = c.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = Math.SQRT1_2
      return b
    }
    const chain = (...nodes: AudioNode[]) => {
      for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i])
      return nodes[nodes.length - 1]
    }
    const low = c.createGain()
    const mid = c.createGain()
    const high = c.createGain()
    const fader = c.createGain()
    fader.gain.value = 0
    chain(trim, bq('lowpass', LOW_XOVER), bq('lowpass', LOW_XOVER), low)
    chain(trim, bq('highpass', LOW_XOVER), bq('highpass', LOW_XOVER), bq('lowpass', HIGH_XOVER), bq('lowpass', HIGH_XOVER), mid)
    chain(trim, bq('highpass', LOW_XOVER), bq('highpass', LOW_XOVER), bq('highpass', HIGH_XOVER), bq('highpass', HIGH_XOVER), high)
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 20000
    lp.Q.value = 0.9
    const hp = c.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 20
    hp.Q.value = 0.9
    for (const g of [low, mid, high]) g.connect(lp)
    lp.connect(hp).connect(fader)
    fader.connect(this.master)
    const echoSend = c.createGain()
    echoSend.gain.value = 0
    const echoDelay = c.createDelay(4)
    const echoFb = c.createGain()
    echoFb.gain.value = 0
    hp.connect(echoSend).connect(echoDelay)
    echoDelay.connect(echoFb).connect(echoDelay)
    echoDelay.connect(this.master)
    return { id, trim, low, mid, high, fader, lp, hp, echoSend, echoDelay, echoFb, source: null, itemId: null, trackKey: null, buffer: null, map: IDENTITY, startCtx: 0, startBufSec: 0, stoppedByEngine: false }
  }

  get state(): AudioContextState {
    return this.ctx.state
  }

  get activeItemId(): string | null {
    return this.decks[this.active].itemId
  }

  get activeTrackKey(): string | null {
    return this.decks[this.active].trackKey
  }

  get pendingTransition(): ScheduledTransition | null {
    return this.transition
  }

  setMasterVolume(v: number): void {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05)
  }

  async resume(): Promise<boolean> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined)
    return this.ctx.state === 'running'
  }

  async suspend(): Promise<void> {
    if (this.ctx.state === 'running') await this.ctx.suspend()
  }

  /** Current position (seconds on the ORIGINAL track timeline) of a deck. */
  trackPosition(id: DeckId = this.active): number {
    const d = this.decks[id]
    if (!d.buffer) return 0
    const bufSec = d.source ? d.startBufSec + Math.max(0, this.ctx.currentTime - d.startCtx) : d.startBufSec
    return d.map.toTrack(Math.min(bufSec, d.buffer.duration))
  }

  /** Context time at which the active deck reaches `trackSec`. */
  ctxTimeOf(trackSec: number, id: DeckId = this.active): number {
    const d = this.decks[id]
    return d.startCtx + (d.map.toBuffer(trackSec) - d.startBufSec)
  }

  /** Start (or adopt) an item on the active deck at a track position. */
  play(itemId: string, trackKey: string, buffer: AudioBuffer, atTrackSec: number, lufs?: number, truePeak?: number): void {
    const cur = this.decks[this.active]
    if (cur.itemId === itemId && cur.source) return // already playing (e.g. after a mix handoff)
    // If the incoming deck of a scheduled/finished transition holds this item, adopt it.
    const other = this.decks[this.active === 'A' ? 'B' : 'A']
    if (other.itemId === itemId && other.source) {
      this.active = other.id
      return
    }
    this.cancelTransition()
    this.stopDeck(cur)
    this.stopDeck(other)
    this.startDeck(cur, itemId, trackKey, buffer, IDENTITY, Math.max(0, Math.min(atTrackSec, buffer.duration - 0.05)), this.ctx.currentTime + 0.05, lufs, truePeak)
    const t = this.ctx.currentTime + 0.05
    this.resetEq(cur, t)
    cur.fader.gain.cancelScheduledValues(t)
    cur.fader.gain.setValueAtTime(0, t)
    cur.fader.gain.linearRampToValueAtTime(1, t + 0.03)
  }

  stopAll(): void {
    this.cancelTransition()
    this.stopDeck(this.decks.A)
    this.stopDeck(this.decks.B)
  }

  private startDeck(d: Deck, itemId: string, trackKey: string, buffer: AudioBuffer, map: DeckTimeMap, bufSec: number, when: number, lufs?: number, truePeak?: number): void {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(d.trim)
    d.trim.gain.setValueAtTime(10 ** (trimDbFor(lufs, truePeak) / 20), when)
    d.source = src
    d.itemId = itemId
    d.trackKey = trackKey
    d.buffer = buffer
    d.map = map
    d.startCtx = when
    d.startBufSec = bufSec
    d.stoppedByEngine = false
    src.onended = () => {
      if (d.source !== src) return
      const natural = !d.stoppedByEngine
      d.source = null
      if (natural && d.id === this.active && !this.transition && d.itemId) this.events.onEnded?.(d.itemId)
    }
    src.start(when, bufSec)
  }

  private stopDeck(d: Deck, when?: number): void {
    if (d.source) {
      d.stoppedByEngine = true
      try {
        d.source.stop(when ?? 0)
      } catch {
        // already stopped
      }
      if (when === undefined) d.source = null
    }
    if (when === undefined) {
      d.itemId = null
      d.trackKey = null
      d.buffer = null
    }
  }

  private resetFx(d: Deck, t: number): void {
    d.lp.frequency.cancelScheduledValues(t)
    d.lp.frequency.setValueAtTime(20000, t)
    d.hp.frequency.cancelScheduledValues(t)
    d.hp.frequency.setValueAtTime(20, t)
    d.echoSend.gain.cancelScheduledValues(t)
    d.echoSend.gain.setValueAtTime(0, t)
  }

  /** Bipolar filter-knob curve → scheduled low-pass/high-pass cutoffs (dense points, linear ramps). */
  private applyFilter(d: Deck, curve: CurvePoint[] | undefined, t0: number, beatSec: number): void {
    if (!curve?.length) return
    d.lp.frequency.cancelScheduledValues(t0)
    d.hp.frequency.cancelScheduledValues(t0)
    curve.forEach((p, i) => {
      const { lp, hp } = filterCutoffs(p.value)
      const t = t0 + p.beat * beatSec
      if (i === 0) {
        d.lp.frequency.setValueAtTime(lp, t)
        d.hp.frequency.setValueAtTime(hp, t)
      } else {
        d.lp.frequency.linearRampToValueAtTime(lp, t)
        d.hp.frequency.linearRampToValueAtTime(hp, t)
      }
    })
  }

  private resetEq(d: Deck, t: number): void {
    for (const f of [d.low, d.mid, d.high]) {
      f.gain.cancelScheduledValues(t)
      f.gain.setValueAtTime(1, t)
    }
  }

  /** Schedules a curve; EQ curves are in dB and are applied as linear isolator band gains. */
  private applyCurve(param: AudioParam, curve: CurvePoint[], t0: number, beatSec: number, isDb = false): void {
    if (!curve.length) return
    const v = (x: number) => (isDb ? bandGain(x) : x)
    param.cancelScheduledValues(t0)
    param.setValueAtTime(v(curve[0].value), t0 + curve[0].beat * beatSec)
    for (let i = 1; i < curve.length; i++) param.linearRampToValueAtTime(v(curve[i].value), t0 + curve[i].beat * beatSec)
  }

  /**
   * Schedule a committed transition. `incoming.buffer` is either the original track
   * (tempoRatio ≈ 1; played from plan.inCueSec) or a pre-rendered stretched buffer whose
   * t=0 is the incoming cue, with `incoming.map` translating to the original timeline.
   */
  scheduleTransition(plan: TransitionPlan, incoming: { itemId: string; trackKey: string; buffer: AudioBuffer; map?: DeckTimeMap; lufs?: number; truePeak?: number }): ScheduledTransition {
    const errs = validatePlan(plan)
    if (errs.length) throw new Error(`Unsafe transition plan: ${errs.join('; ')}`)
    const out = this.decks[this.active]
    if (!out.source || out.itemId !== plan.fromItemId) throw new Error('The outgoing deck is not playing the planned track.')
    const startsAtCtx = this.ctxTimeOf(plan.outCueSec)
    if (startsAtCtx < this.ctx.currentTime + MIN_LEAD_SEC) throw new Error('Too late to schedule this transition.')
    this.cancelTransition()
    const inc = this.decks[this.active === 'A' ? 'B' : 'A']
    this.stopDeck(inc)
    const map = incoming.map ?? IDENTITY
    const bufStart = incoming.map ? 0 : plan.inCueSec
    this.resetEq(inc, this.ctx.currentTime)
    inc.fader.gain.cancelScheduledValues(this.ctx.currentTime)
    inc.fader.gain.setValueAtTime(0, this.ctx.currentTime)
    this.startDeck(inc, incoming.itemId, incoming.trackKey, incoming.buffer, map, bufStart, startsAtCtx, incoming.lufs, incoming.truePeak)
    const b = plan.beatSec
    this.applyCurve(out.fader.gain, plan.out.gain, startsAtCtx, b)
    this.applyCurve(out.low.gain, plan.out.low, startsAtCtx, b, true)
    this.applyCurve(out.mid.gain, plan.out.mid, startsAtCtx, b, true)
    this.applyCurve(out.high.gain, plan.out.high, startsAtCtx, b, true)
    this.applyCurve(inc.fader.gain, plan.in.gain, startsAtCtx, b)
    this.applyCurve(inc.low.gain, plan.in.low, startsAtCtx, b, true)
    this.applyCurve(inc.mid.gain, plan.in.mid, startsAtCtx, b, true)
    this.applyCurve(inc.high.gain, plan.in.high, startsAtCtx, b, true)
    // ── creative FX: filter knobs, echo send, performance segment ──
    this.resetFx(out, this.ctx.currentTime)
    this.resetFx(inc, this.ctx.currentTime)
    this.applyFilter(out, plan.filter?.out, startsAtCtx, b)
    this.applyFilter(inc, plan.filter?.in, startsAtCtx, b)
    if (plan.echo) {
      out.echoDelay.delayTime.setValueAtTime(Math.min(3.9, plan.echo.delayBeats * b), this.ctx.currentTime)
      out.echoFb.gain.setValueAtTime(Math.min(0.85, plan.echo.feedback), this.ctx.currentTime)
      this.applyCurve(out.echoSend.gain, plan.echo.send, startsAtCtx, b)
      // let the tail decay, then close the feedback loop
      out.echoFb.gain.setValueAtTime(0, startsAtCtx + (plan.handoffBeat + 16) * b)
    }
    if (plan.outPerf && out.buffer) {
      const chans = Array.from({ length: out.buffer.numberOfChannels }, (_, c) => out.buffer!.getChannelData(c))
      const perfStartTrack = plan.outCueSec + plan.outPerf.startBeat * b
      const data = renderPerformance(chans, out.buffer.sampleRate, { startSec: perfStartTrack, beatSec: b, beats: plan.outPerf.beats, ops: plan.outPerf.ops })
      const pbuf = this.ctx.createBuffer(data.length, data[0].length, out.buffer.sampleRate)
      data.forEach((d, c) => pbuf.getChannelData(c).set(d))
      const when = startsAtCtx + plan.outPerf.startBeat * b
      const ps = this.ctx.createBufferSource()
      ps.buffer = pbuf
      ps.connect(out.trim)
      // switch sample-accurately: the main source stops exactly when the performance starts
      if (out.source) {
        out.stoppedByEngine = true
        out.source.stop(when)
      }
      ps.start(when)
      ps.stop(when + pbuf.duration)
    }
    const lastBeat = Math.max(...[plan.out.gain, plan.in.gain].map((c) => c[c.length - 1]?.beat ?? 0))
    const endsAtCtx = startsAtCtx + lastBeat * b + 0.05
    if (!plan.outPerf) this.stopDeck(out, endsAtCtx + 0.02)
    this.transition = { plan, startsAtCtx, handoffAtCtx: startsAtCtx + plan.handoffBeat * b, endsAtCtx, incomingDeck: inc.id, handedOff: false }
    return this.transition
  }

  /** Abort a pending (not yet started) transition and restore the outgoing deck. */
  cancelTransition(): boolean {
    const t = this.transition
    if (!t) return false
    const now = this.ctx.currentTime
    if (now >= t.startsAtCtx) return false // already audible: let it finish safely
    const inc = this.decks[t.incomingDeck]
    this.stopDeck(inc)
    const out = this.decks[this.active]
    out.fader.gain.cancelScheduledValues(now)
    out.fader.gain.setValueAtTime(1, now)
    this.resetEq(out, now)
    if (out.source && out.buffer) {
      // re-arm natural end: recreate nothing; just clear the scheduled stop by restarting the source at its position
      const pos = out.startBufSec + (now - out.startCtx)
      const { itemId, trackKey, buffer, map } = out
      out.stoppedByEngine = true
      try {
        out.source.stop()
      } catch {
        // ignore
      }
      out.source = null
      if (itemId && trackKey && buffer) this.startDeck(out, itemId, trackKey, buffer, map, pos, now + 0.01)
    }
    this.transition = null
    return true
  }

  private tick(): void {
    const now = this.ctx.currentTime
    const t = this.transition
    if (t) {
      if (!t.handedOff && now >= t.handoffAtCtx) {
        t.handedOff = true
        const inc = this.decks[t.incomingDeck]
        if (inc.itemId) this.events.onHandoff?.(inc.itemId, this.trackPosition(inc.id))
      }
      if (now >= t.endsAtCtx) {
        const from = t.plan.fromItemId
        const to = t.plan.toItemId
        const out = this.decks[this.active]
        out.source = null
        out.itemId = null
        out.trackKey = null
        out.buffer = null
        this.active = t.incomingDeck
        this.transition = null
        this.events.onTransitionDone?.(from, to)
      }
    }
    // meter + watchdogs
    this.analyser.getFloatTimeDomainData(this.meterBuf as Float32Array<ArrayBuffer>)
    let peak = 0
    let ss = 0
    for (const v of this.meterBuf) {
      const a = Math.abs(v)
      if (a > peak) peak = a
      ss += v * v
    }
    this.peakDb = 20 * Math.log10(Math.max(peak, 1e-9))
    this.rmsDb = 10 * Math.log10(Math.max(ss / this.meterBuf.length, 1e-12))
    if (peak >= 0.999) this.clipCount++
    const playing = this.ctx.state === 'running' && !!this.decks[this.active].source
    if (playing && this.rmsDb < -70) {
      this.silentSince ??= now
      if (now - this.silentSince > 6) {
        this.silentSince = null
        this.events.onSilence?.(this.activeItemId)
      }
    } else this.silentSince = null
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.stopAll()
    void this.ctx.close().catch(() => undefined)
  }
}

/** Build a time map for a buffer = [stretched segment starting at the incoming cue] + [original tail]. */
export function stretchedMap(rate: number, anchors: Float64Array, hop: number, stretchedLen: number, inputEndSample: number): DeckTimeMap {
  const inAt = (outSample: number) => {
    const k = outSample / hop
    const i = Math.min(anchors.length - 2, Math.max(0, Math.floor(k)))
    return anchors[i] + (anchors[i + 1] - anchors[i]) * (k - i)
  }
  const stretchedSec = stretchedLen / rate
  const tailStartTrackSec = inputEndSample / rate
  return {
    toTrack: (bufSec) => (bufSec < stretchedSec ? inAt(bufSec * rate) / rate : tailStartTrackSec + (bufSec - stretchedSec)),
    toBuffer: (trackSec) => {
      if (trackSec >= tailStartTrackSec) return stretchedSec + (trackSec - tailStartTrackSec)
      const target = trackSec * rate
      let lo = 0
      let hi = anchors.length - 1
      if (target <= anchors[0]) return 0
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1
        if (anchors[m] <= target) lo = m
        else hi = m
      }
      return ((lo + (target - anchors[lo]) / Math.max(1e-9, anchors[hi] - anchors[lo])) * hop) / rate
    },
  }
}
