/**
 * DJ performance manifest — a time-stamped record of how the AI DJ played the mix on two decks,
 * and the evaluator the Listen page's virtual controller replays it with.
 *
 * Single source of truth: the lanes are the EXECUTED TransitionPlan / TechniquePlan objects that
 * `renderMix` passed to the DSP (curves stay in the plan's own beat units, unthinned), anchored to
 * the renderer's ACTUAL output timeline (transition start samples, incoming splice offset and lag,
 * limiter latency). Evaluation reuses the renderer's own functions — `curveAt` (src/dj/automation),
 * `incomingPosAt` (below; the renderer's WSOLA position law), `performanceStateAt` (src/dj/fx,
 * the read head of `renderPerformance`) and `stabHitBeats` (techniques) — so a control on screen
 * can only show a value that produced the audio.
 *
 * Nothing here is decorative: a control that the renderer does not have (the crossfader — this
 * engine mixes with channel faders, crossfader assign = THRU) is reported as not used, and mixes
 * rendered before this telemetry existed get a `reduced` manifest built only from what their mix
 * manifest recorded.
 */
import { curveAt } from '../dj/automation'
import { performanceStateAt, type PerfOp } from '../dj/fx'
import { BEATMATCHED, type CurvePoint, type TransitionPlan } from '../dj/transitions'
import { stabHitBeats, type DeckEdit, type TechniquePlan } from './techniques'

export const PERFORMANCE_VERSION = 1

// ───────────────────────── the renderer's position law (shared) ─────────────────────────

/** Incoming track-time reached `jSec` output seconds after the transition start (renderer's WSOLA schedule). */
export function incomingPosAt(plan: Pick<TransitionPlan, 'style' | 'tempoRatio' | 'durationSec' | 'tempoRecoveryBars' | 'beatSec' | 'inCueSec'>, jSec: number): number {
  const stretched = BEATMATCHED.has(plan.style) && Math.abs(plan.tempoRatio - 1) > 1e-4
  if (!stretched) return plan.inCueSec + jSec
  const r = plan.tempoRatio
  const ov = plan.durationSec
  const rec = plan.tempoRecoveryBars * 4 * plan.beatSec
  if (jSec <= ov) return plan.inCueSec + jSec * r
  let pos = plan.inCueSec + ov * r
  const k = jSec - ov
  if (rec > 0 && k <= rec) {
    // ratio goes linearly r → 1 over `rec`: ∫ = k·r + (1−r)·k²/(2·rec)
    return pos + k * r + ((1 - r) * k * k) / (2 * rec)
  }
  if (rec > 0) pos += (rec * (r + 1)) / 2
  return pos + (k - Math.max(0, rec))
}

/** Playback rate of the incoming deck at `jSec` (derivative of `incomingPosAt`). */
export function incomingRateAt(plan: Pick<TransitionPlan, 'style' | 'tempoRatio' | 'durationSec' | 'tempoRecoveryBars' | 'beatSec'>, jSec: number): number {
  const stretched = BEATMATCHED.has(plan.style) && Math.abs(plan.tempoRatio - 1) > 1e-4
  if (!stretched) return 1
  const r = plan.tempoRatio
  const ov = plan.durationSec
  const rec = plan.tempoRecoveryBars * 4 * plan.beatSec
  if (jSec <= ov) return r
  const k = jSec - ov
  if (rec > 0 && k <= rec) return r + ((1 - r) * k) / rec
  return 1
}

// ───────────────────────── manifest types ─────────────────────────

export type DeckId = 'A' | 'B'
export const deckOf = (trackIndex: number): DeckId => (trackIndex % 2 === 0 ? 'A' : 'B')

export interface PerfChannelLanes {
  gain: CurvePoint[]
  low: CurvePoint[]
  mid: CurvePoint[]
  high: CurvePoint[]
  filter?: CurvePoint[]
  /** Stem gains — present only when stems were actually routed by the renderer. */
  stems?: { vocals: CurvePoint[]; inst: CurvePoint[] }
}

export interface PerfTransition {
  index: number
  from: number
  to: number
  style: string
  label: string
  technique?: string
  /** Mix time (s, final audio timeline) of automation beat 0. */
  mixStartSec: number
  /** Crossfader lane of a long-form performance (−1 A … +1 B, dipless); folded into the displayed channel gains. */
  crossfader?: CurvePoint[]
  /** Multi-stage description of a long-form performance (stages, bass-swap bar, vocal mode). */
  performance?: TransitionPlan['performance']
  /** Automation beat unit (outgoing beat period). */
  beatSec: number
  overlapBars: number
  durationSec: number
  outCueSec: number
  inCueSec: number
  tempoRatio: number
  tempoRecoveryBars: number
  beatmatched: boolean
  /** Seconds after beat 0 where the renderer spliced back to the incoming track's plain audio. */
  spliceSec: number
  /** Correlation refinement (s) applied to the incoming position at that splice. */
  spliceLagSec: number
  out: PerfChannelLanes
  in: PerfChannelLanes
  echo?: { send: CurvePoint[]; delayBeats: number; feedback: number }
  reverb?: { send: CurvePoint[]; decaySec: number; wet: number }
  outPerf?: { startBeat: number; beats: number; ops: PerfOp[] }
  deckEdits?: { out?: DeckEdit[]; in?: DeckEdit[] }
  /** Who produced the automation (learned TransitionNet or rules) — only when recorded. */
  automation?: 'transitionnet' | 'rules'
}

export interface PerfTrack {
  index: number
  key: string
  deck: DeckId
  title: string
  artist: string
  artworkUrl?: string
  bpm: number
  musicalKey: string
  camelot: string
  durationSec: number
  trimDb: number
  /** Beat grid (track time): first beat, beat period, and which beat of the bar the first beat is. Absent = unknown. */
  grid?: { firstBeatSec: number; beatSec: number; downbeatPhase: number }
  drops: number[]
  /** Track second where the deck starts playing (its cue). */
  cueSec: number
}

/** Levels as compact strings: one char per frame, '0'..'~' style alphabet, value = dB above `floorDb`. */
export interface PerfLevels {
  secPerFrame: number
  floorDb: number
  /** Master = the final audio as written to the file. */
  master: string
  /** Per-deck post-fader channel signal (incl. its echo/reverb sends), pre-limiter. */
  A: string
  B: string
}

export interface PerfPeaks {
  secPerBucket: number
  /** Per track key: amplitude and low-band share per bucket, one char each (0..63). */
  tracks: Record<string, { amp: string; low: string }>
}

export interface PerformanceManifest {
  version: number
  /** 'full' = recorded by the renderer; 'reduced' = reconstructed from an older mix manifest. */
  fidelity: 'full' | 'reduced'
  durationSec: number
  latencySec: number
  /** No global crossfader widget: per-transition crossfader lanes (long-form performances) are folded into channel gains. */
  crossfader: null
  tracks: PerfTrack[]
  transitions: PerfTransition[]
  levels?: PerfLevels
  peaks?: PerfPeaks
  /** What is NOT available for this mix (shown to the user, never filled with invented data). */
  missing: string[]
}

// ───────────────────────── compact encodings ─────────────────────────

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'
const ALPHA_INV = (() => {
  const m = new Int8Array(128).fill(-1)
  for (let i = 0; i < ALPHA.length; i++) m[ALPHA.charCodeAt(i)] = i
  return m
})()
export const encode63 = (vals: ArrayLike<number>): string => {
  let s = ''
  for (let i = 0; i < vals.length; i++) s += ALPHA[Math.max(0, Math.min(63, Math.round(vals[i])))]
  return s
}
export const decode63 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = Math.max(0, ALPHA_INV[s.charCodeAt(i)] ?? 0)
  return out
}

// ───────────────────────── renderer telemetry recorders ─────────────────────────

const LEVEL_FRAME = 0.05
const LEVEL_FLOOR = -60

/** Accumulates mean-square energy per frame for the master and each deck, on sample positions. */
export class LevelRecorder {
  readonly frame: number
  private lanes: Record<'master' | DeckId, { sum: Float64Array; n: Uint32Array }>
  constructor(
    readonly rate: number,
    readonly frameSec = LEVEL_FRAME,
  ) {
    this.frame = Math.max(1, Math.round(rate * frameSec))
    const mk = () => ({ sum: new Float64Array(1024), n: new Uint32Array(1024) })
    this.lanes = { master: mk(), A: mk(), B: mk() }
  }
  private ensure(lane: 'master' | DeckId, frames: number) {
    const l = this.lanes[lane]
    if (frames <= l.sum.length) return l
    let cap = l.sum.length
    while (cap < frames) cap *= 2
    const sum = new Float64Array(cap)
    sum.set(l.sum)
    const n = new Uint32Array(cap)
    n.set(l.n)
    this.lanes[lane] = { sum, n }
    return this.lanes[lane]
  }
  /** Adds `len` samples of signal starting at sample `at` (channels averaged to mono power). */
  add(lane: 'master' | DeckId, at: number, chans: Float32Array[], from = 0, len = chans[0]?.length ?? 0, gain = 1): void {
    if (len <= 0 || !chans.length) return
    const l = this.ensure(lane, Math.floor((at + len) / this.frame) + 1)
    const g2 = gain * gain
    for (let i = 0; i < len; i++) {
      let p = 0
      for (const c of chans) {
        const v = c[from + i] ?? 0
        p += v * v
      }
      const f = Math.floor((at + i) / this.frame)
      l.sum[f] += (p / chans.length) * g2
      l.n[f]++
    }
  }
  /** Mono signal variant. */
  addMono(lane: 'master' | DeckId, at: number, x: Float32Array, from: number, len: number): void {
    this.add(lane, at, [x], from, len)
  }
  /** Marks samples as present (silence) so frame counts stay right for lanes with no signal. */
  finish(totalSamples: number, deckShiftSamples: number): PerfLevels {
    const frames = Math.ceil(totalSamples / this.frame)
    const enc = (lane: 'master' | DeckId, shift: number) => {
      const l = this.lanes[lane]
      const sf = Math.round(shift / this.frame)
      const v = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        const src = f - sf
        if (src < 0 || src >= l.sum.length) continue
        const ms = l.n[src] ? l.sum[src] / this.frame : 0
        const db = ms > 0 ? 10 * Math.log10(ms) : -120
        v[f] = Math.max(0, db - LEVEL_FLOOR)
      }
      return encode63(v)
    }
    return { secPerFrame: this.frame / this.rate, floorDb: LEVEL_FLOOR, master: enc('master', 0), A: enc('A', deckShiftSamples), B: enc('B', deckShiftSamples) }
  }
}

const PEAK_BUCKET = 0.05

/** Per-track overview waveform for the deck display: peak amplitude and low-band (< ~150 Hz) share per bucket. */
export function trackPeaks(channels: Float32Array[], rate: number, secPerBucket = PEAK_BUCKET): { amp: string; low: string } {
  const per = Math.max(1, Math.round(rate * secPerBucket))
  const n = channels[0]?.length ?? 0
  const buckets = Math.ceil(n / per)
  const amp = new Float32Array(buckets)
  const low = new Float32Array(buckets)
  const a = 1 - Math.exp((-2 * Math.PI * 150) / rate)
  let lp = 0
  for (let b = 0; b < buckets; b++) {
    let pk = 0
    let eAll = 0
    let eLow = 0
    const end = Math.min(n, (b + 1) * per)
    for (let i = b * per; i < end; i++) {
      let x = 0
      for (const c of channels) x += c[i]
      x /= channels.length
      lp += a * (x - lp)
      const ax = Math.abs(x)
      if (ax > pk) pk = ax
      eAll += x * x
      eLow += lp * lp
    }
    amp[b] = Math.sqrt(Math.min(1, pk)) * 63
    low[b] = eAll > 0 ? Math.min(1, Math.sqrt(eLow / eAll)) * 63 : 0
  }
  return { amp: encode63(amp), low: encode63(low) }
}

/** Telemetry the renderer records while producing the audio. */
export interface RenderTelemetry {
  latencySec: number
  levels: PerfLevels
  peaks: PerfPeaks
  /** Per transition (by index): where the incoming deck resumed plain playback, and whether technique controls ran. */
  splices: Array<{ spliceSec: number; spliceLagSec: number; stemsApplied: boolean; reverbApplied: boolean; deckEditsApplied: boolean }>
}

// ───────────────────────── builder (full fidelity) ─────────────────────────

export interface PerfTrackInfo {
  key: string
  title: string
  artist: string
  artworkUrl?: string
  bpm: number
  musicalKey: string
  camelot: string
  durationSec: number
  trimDb: number
  entrySec: number
  drops: number[]
  grid?: PerfTrack['grid']
}

/**
 * Builds the performance manifest from the plan the renderer executed and its telemetry.
 * `transitionStarts` are the renderer's actual mix times of each transition's beat 0.
 */
export function buildPerformance(input: {
  plans: Array<TransitionPlan | TechniquePlan>
  transitionStarts: number[]
  tracks: PerfTrackInfo[]
  telemetry: RenderTelemetry
  durationSec: number
  labels: string[]
  automation?: Array<'transitionnet' | 'rules' | undefined>
}): PerformanceManifest {
  const { plans, telemetry } = input
  const tracks: PerfTrack[] = input.tracks.map((t, i) => ({
    index: i,
    key: t.key,
    deck: deckOf(i),
    title: t.title,
    artist: t.artist,
    artworkUrl: t.artworkUrl,
    bpm: t.bpm,
    musicalKey: t.musicalKey,
    camelot: t.camelot,
    durationSec: t.durationSec,
    trimDb: t.trimDb,
    grid: t.grid,
    drops: t.drops,
    cueSec: i === 0 ? t.entrySec : plans[i - 1].inCueSec,
  }))
  const transitions: PerfTransition[] = plans.map((p, i) => {
    const tech = (p as TechniquePlan).tech
    const sp = telemetry.splices[i]
    const lanes = (d: TransitionPlan['out'], filter: CurvePoint[] | undefined, stems: { vocals: CurvePoint[]; inst: CurvePoint[] } | undefined): PerfChannelLanes => ({
      gain: d.gain,
      low: d.low,
      mid: d.mid,
      high: d.high,
      ...(filter ? { filter } : {}),
      ...(stems && sp?.stemsApplied ? { stems } : {}),
    })
    return {
      index: i,
      from: i,
      to: i + 1,
      style: p.style,
      label: input.labels[i] ?? p.style,
      technique: tech && (sp?.stemsApplied || !tech.stems) ? tech.technique : undefined,
      mixStartSec: input.transitionStarts[i],
      beatSec: p.beatSec,
      overlapBars: p.overlapBars,
      durationSec: p.durationSec,
      outCueSec: p.outCueSec,
      inCueSec: p.inCueSec,
      tempoRatio: p.tempoRatio,
      tempoRecoveryBars: p.tempoRecoveryBars,
      beatmatched: BEATMATCHED.has(p.style),
      spliceSec: sp?.spliceSec ?? p.durationSec,
      spliceLagSec: sp?.spliceLagSec ?? 0,
      out: lanes(p.out, p.filter?.out, tech?.stems?.out),
      in: lanes(p.in, p.filter?.in, tech?.stems?.in),
      ...(p.echo ? { echo: p.echo } : {}),
      ...(p.crossfader ? { crossfader: p.crossfader } : {}),
      ...(p.performance ? { performance: p.performance } : {}),
      ...(tech?.reverb && sp?.reverbApplied ? { reverb: tech.reverb } : {}),
      ...(p.outPerf ? { outPerf: p.outPerf } : {}),
      ...(tech?.deckEdits && sp?.deckEditsApplied ? { deckEdits: tech.deckEdits } : {}),
      ...(input.automation?.[i] ? { automation: input.automation[i] } : {}),
    }
  })
  const missing: string[] = []
  if (tracks.some((t) => !t.grid)) missing.push('beat grid for some tracks')
  return {
    version: PERFORMANCE_VERSION,
    fidelity: 'full',
    durationSec: input.durationSec,
    latencySec: telemetry.latencySec,
    crossfader: null,
    tracks,
    transitions,
    levels: telemetry.levels,
    peaks: telemetry.peaks,
    missing,
  }
}

// ───────────────────────── reduced fidelity (older mixes) ─────────────────────────

/** Minimal structural view of the mix manifest (kept structural to avoid an import cycle). */
export interface ManifestLike {
  durationSec: number
  tracks: Array<{ key: string; title: string; artist: string; thumbnailUrl?: string; bpm: number; key_: string; camelot: string; durationSec: number; trimDb: number; entrySec: number; drops: number[] }>
  transitions: Array<{
    style: string
    label: string
    technique?: { name: string }
    mixStartSec: number
    overlapBars: number
    overlapSec: number
    outCueSec: number
    inCueSec: number
    tempoRatio: number
    tempoRecoverySec: number
    beatSec: number
    beatAlignment: { spliceLagMs: number }
    curves: {
      out: { gain: { t: number[]; v: number[] }; low: { t: number[]; v: number[] }; mid: { t: number[]; v: number[] }; high: { t: number[]; v: number[] }; filter?: { t: number[]; v: number[] } }
      in: { gain: { t: number[]; v: number[] }; low: { t: number[]; v: number[] }; mid: { t: number[]; v: number[] }; high: { t: number[]; v: number[] }; filter?: { t: number[]; v: number[] } }
      echoSend?: { t: number[]; v: number[] }
    }
    effects: Array<{ kind: string; startSec: number; endSec: number; detail: string }>
    control?: { automation: 'transitionnet' | 'rules' }
  }>
  energy?: { secPerPoint: number; rmsDb: number[] }
  performance?: PerformanceManifest
}

/** Renderer constants needed to place the splice for mixes that did not record it (mix-render.ts). */
const LEGACY_TAIL_PAD = 2.0
const LEGACY_XF = 0.025

/**
 * Performance manifest for a mix: the recorded one when present, otherwise a `reduced` one built
 * strictly from what the mix manifest recorded (display-thinned automation curves, cue points,
 * tempo ratio, splice lag). Performance moves are NOT modelled for reduced mixes (their op
 * parameters were not stored); their time windows are still shown as FX indicators.
 */
export function performanceFor(m: ManifestLike): PerformanceManifest {
  if (m.performance?.version === PERFORMANCE_VERSION) return m.performance
  const toCurve = (c: { t: number[]; v: number[] } | undefined, beatSec: number): CurvePoint[] | undefined => (c && c.t.length ? c.t.map((t, i) => ({ beat: t / beatSec, value: c.v[i] })) : undefined)
  const transitions: PerfTransition[] = m.transitions.map((t, i) => {
    const B = t.beatSec
    const recBars = t.tempoRecoverySec > 0 ? t.tempoRecoverySec / (4 * B) : 0
    const stretched = Math.abs(t.tempoRatio - 1) > 1e-4
    const ch = (c: ManifestLike['transitions'][number]['curves']['out']): PerfChannelLanes => ({
      gain: toCurve(c.gain, B) ?? [],
      low: toCurve(c.low, B) ?? [],
      mid: toCurve(c.mid, B) ?? [],
      high: toCurve(c.high, B) ?? [],
      ...(c.filter ? { filter: toCurve(c.filter, B) } : {}),
    })
    return {
      index: i,
      from: i,
      to: i + 1,
      style: t.style,
      label: t.label,
      technique: t.technique?.name,
      mixStartSec: t.mixStartSec,
      beatSec: B,
      overlapBars: t.overlapBars,
      durationSec: t.overlapSec,
      outCueSec: t.outCueSec,
      inCueSec: t.inCueSec,
      tempoRatio: t.tempoRatio,
      tempoRecoveryBars: recBars,
      beatmatched: BEATMATCHED.has(t.style as TransitionPlan['style']),
      spliceSec: t.overlapSec + (stretched ? t.tempoRecoverySec : 0) + LEGACY_TAIL_PAD - LEGACY_XF,
      spliceLagSec: t.beatAlignment.spliceLagMs / 1000,
      out: ch(t.curves.out),
      in: ch(t.curves.in),
      ...(t.curves.echoSend ? { echo: { send: toCurve(t.curves.echoSend, B)!, delayBeats: 0, feedback: 0 } } : {}),
      ...(t.control ? { automation: t.control.automation } : {}),
    }
  })
  const tracks: PerfTrack[] = m.tracks.map((t, i) => ({
    index: i,
    key: t.key,
    deck: deckOf(i),
    title: t.title,
    artist: t.artist,
    artworkUrl: t.thumbnailUrl,
    bpm: t.bpm,
    musicalKey: t.key_,
    camelot: t.camelot,
    durationSec: t.durationSec,
    trimDb: t.trimDb,
    drops: t.drops,
    cueSec: i === 0 ? t.entrySec : m.transitions[i - 1].inCueSec,
  }))
  const levels: PerfLevels | undefined = m.energy?.rmsDb.length
    ? { secPerFrame: m.energy.secPerPoint, floorDb: LEVEL_FLOOR, master: encode63(m.energy.rmsDb.map((d) => Math.max(0, d - LEVEL_FLOOR))), A: '', B: '' }
    : undefined
  const legacyFx = m.transitions.flatMap((t, i) => t.effects.filter((e) => ['roll', 'brake', 'spinback', 'scratch', 'stabs', 'juggle', 'tone', 'stems', 'reverb'].includes(e.kind)).map((e) => ({ ...e, transition: i })))
  return {
    version: PERFORMANCE_VERSION,
    fidelity: 'reduced',
    durationSec: m.durationSec,
    latencySec: 0,
    crossfader: null,
    tracks,
    transitions,
    levels,
    missing: [
      'per-deck levels',
      'deck waveforms',
      'beat grids',
      'full-resolution automation (display-thinned curves are used)',
      ...(legacyFx.length ? ['performance-move positions (loop/brake/scratch shown as indicators only)'] : []),
    ],
    legacyFx,
  } as PerformanceManifest & { legacyFx: typeof legacyFx }
}

// ───────────────────────── evaluation (the controller's replay) ─────────────────────────

export type PadMode = 'hotcue' | 'roll' | 'sampler' | 'pitch' | 'juggle'

export interface DeckState {
  track: number | null
  /** Track second under the needle. */
  pos: number
  /** Playback speed and direction (0 stopped, < 0 reverse). */
  speed: number
  playing: boolean
  role: 'idle' | 'cued' | 'solo' | 'outgoing' | 'incoming'
  /** Tempo fader as % (incoming deck's tempo-match ratio; pitch preserved). */
  tempoPct: number
  bpm: number | null
  keyLock: boolean
  sync: boolean
  /** Beat position (track beats from the first beat) — null when the grid is unknown. */
  beat: number | null
  loop: { startSec: number; beats: number } | null
  perf: string | null
  pads: { mode: PadMode; labels: string[]; lit: number }
  semitones: number | null
  /** Cue marker shown on the deck's waveform (track s). */
  cueSec: number | null
  /** The mix-out point on this deck (track s), when it has an outgoing transition. */
  outCueSec: number | null
}

export interface ChannelState {
  gain: number
  low: number
  mid: number
  high: number
  filter: number
  trimDb: number
  echo: number | null
  echoTail: boolean
  reverb: number | null
  stems: { vocals: number; inst: number } | null
  levelDb: number | null
}

export interface ControllerState {
  t: number
  deck: Record<DeckId, DeckState>
  ch: Record<DeckId, ChannelState>
  masterDb: number | null
  transition: { index: number; label: string; technique?: string; phase: 'overlap' | 'tail'; progress: number; bar: number; bars: number } | null
  next: { index: number; inSec: number } | null
  /** Indicator-only FX windows for reduced manifests (no positions were recorded). */
  fxIndicators: string[]
}

const neutralChannel = (trimDb = 0, levelDb: number | null = null): ChannelState => ({ gain: 0, low: 0, mid: 0, high: 0, filter: 0, trimDb, echo: null, echoTail: false, reverb: null, stems: null, levelDb })

const HOTCUE: DeckState['pads'] = { mode: 'hotcue', labels: ['CUE', 'IN', 'OUT', 'DROP'], lit: -1 }

function idleDeck(): DeckState {
  return { track: null, pos: 0, speed: 0, playing: false, role: 'idle', tempoPct: 0, bpm: null, keyLock: false, sync: false, beat: null, loop: null, perf: null, pads: HOTCUE, semitones: null, cueSec: null, outCueSec: null }
}

/** Per-track mix-time anchors derived once. */
interface Slot {
  start: number
  end: number
  release: number
  load: number
}

export interface PerformanceEvaluator {
  perf: PerformanceManifest
  evaluate(t: number): ControllerState
  /** Mix time where track `i` starts playing. */
  trackStart(i: number): number
}

export function createEvaluator(perf: PerformanceManifest): PerformanceEvaluator {
  const T = perf.transitions
  const n = perf.tracks.length
  const slots: Slot[] = perf.tracks.map((tr, i) => {
    const tin = T[i - 1]
    const tout = T[i]
    const start = tin ? tin.mixStartSec : tout ? tout.mixStartSec - (tout.outCueSec - tr.cueSec) : perf.latencySec
    const end = tout ? tout.mixStartSec + tout.durationSec : perf.durationSec
    const release = tout ? tout.mixStartSec + Math.max(tout.durationSec, tout.spliceSec) : perf.durationSec
    return { start, end, release, load: 0 }
  })
  slots.forEach((s, i) => (s.load = i >= 2 ? slots[i - 2].release : 0))
  const lv = perf.levels
  const levels = lv ? { master: decode63(lv.master), A: decode63(lv.A), B: decode63(lv.B) } : null
  const levelAt = (lane: Uint8Array | undefined, t: number): number | null => {
    if (!lv || !lane || !lane.length) return null
    const f = t / lv.secPerFrame - 0.5
    const i = Math.max(0, Math.min(lane.length - 1, Math.floor(f)))
    const j = Math.min(lane.length - 1, i + 1)
    const u = Math.max(0, Math.min(1, f - i))
    return lv.floorDb + lane[i] * (1 - u) + lane[j] * u
  }
  const legacyFx = (perf as PerformanceManifest & { legacyFx?: Array<{ kind: string; startSec: number; endSec: number; detail: string }> }).legacyFx ?? []

  /** Track occupying deck `d` at time t (the most recently loaded one). */
  const trackOn = (d: DeckId, t: number): number | null => {
    let found: number | null = null
    for (let i = d === 'A' ? 0 : 1; i < n; i += 2) if (t >= slots[i].load) found = i
    return found
  }

  /** Plain (pre-edit) playback position, speed and role of track i at time t. */
  function motion(i: number, t: number): { pos: number; speed: number; playing: boolean; role: DeckState['role']; tin?: PerfTransition; tout?: PerfTransition; perf?: ReturnType<typeof performanceStateAt> } {
    const tr = perf.tracks[i]
    const tin = T[i - 1]
    const tout = T[i]
    const s = slots[i]
    if (t < s.start) return { pos: tr.cueSec, speed: 0, playing: false, role: 'cued', tin, tout }
    if (tin && t < tin.mixStartSec + tin.spliceSec) {
      const j = t - tin.mixStartSec
      return { pos: incomingPosAt(planLike(tin), j), speed: incomingRateAt(planLike(tin), j), playing: true, role: 'incoming', tin, tout }
    }
    if (tout) {
      const j = t - tout.mixStartSec
      const stopped = t > s.end
      const jj = stopped ? s.end - tout.mixStartSec : j
      let pos = tout.outCueSec + jj
      let speed = stopped ? 0 : 1
      let pst: ReturnType<typeof performanceStateAt> | undefined
      if (tout.outPerf && perf.fidelity === 'full') {
        const x = jj - tout.outPerf.startBeat * tout.beatSec
        if (x >= 0 && x < tout.outPerf.beats * tout.beatSec) {
          pst = performanceStateAt({ startSec: tout.outCueSec + tout.outPerf.startBeat * tout.beatSec, beatSec: tout.beatSec, beats: tout.outPerf.beats, ops: tout.outPerf.ops }, x)
          pos = pst.pos
          speed = stopped ? 0 : pst.speed
        }
      }
      return { pos, speed, playing: !stopped, role: j >= 0 && !stopped ? 'outgoing' : stopped ? 'idle' : 'solo', tin, tout, perf: pst }
    }
    // last track after its incoming splice (or a single-track mix): plain playback to the end
    if (tin) {
      const resume = tin.mixStartSec + tin.spliceSec
      const p0 = incomingPosAt(planLike(tin), tin.spliceSec) + tin.spliceLagSec
      const stopped = t > s.end
      return { pos: p0 + (Math.min(t, s.end) - resume), speed: stopped ? 0 : 1, playing: !stopped, role: stopped ? 'idle' : 'solo', tin }
    }
    const stopped = t > s.end
    return { pos: tr.cueSec + (Math.min(t, s.end) - s.start), speed: stopped ? 0 : 1, playing: !stopped, role: stopped ? 'idle' : 'solo' }
  }

  function deckState(i: number, t: number): DeckState {
    const tr = perf.tracks[i]
    const m = motion(i, t)
    let pos = m.pos
    let pads: DeckState['pads'] = HOTCUE
    let semitones: number | null = null
    let perfOp: string | null = m.perf?.op ?? null
    let loop = m.perf?.loop ?? null
    // deck edits act in this track's own time (the renderer applied them to the deck's PCM)
    const edits = m.role === 'incoming' ? m.tin?.deckEdits?.in : m.tout?.deckEdits?.out
    if (m.playing && edits) {
      for (const e of edits) {
        const rel = m.pos - e.startSec
        if (rel < 0 || rel >= e.beats * e.beatSec) continue
        const b = rel / e.beatSec
        if (e.kind === 'juggle') {
          const k = Math.floor(b)
          const repeat = e.pattern[k % e.pattern.length] === 1
          if (repeat) pos = m.pos - e.offsetBeats * e.beatSec
          pads = { mode: 'juggle', labels: ['LIVE', 'BACK'], lit: repeat ? 1 : 0 }
          perfOp = 'juggle'
          loop = repeat ? { startSec: e.startSec + (k - e.offsetBeats) * e.beatSec, beats: 1 } : loop
        } else if (e.kind === 'stabs') {
          const hits = stabHitBeats(e)
          const hit = hits.findIndex((h) => b >= h && b < h + Math.max(e.hitBeats, 0.125))
          pads = { mode: 'sampler', labels: ['STAB', '', '', ''], lit: hit >= 0 ? 0 : -1 }
          perfOp = 'stabs'
        } else if (e.kind === 'tone') {
          const k = Math.floor(b)
          const on = k < e.semitones.length && b - k < e.hitBeats / 2 ** (e.semitones[k] / 12)
          const uniq = [...new Set(e.semitones)].sort((x, y) => x - y)
          pads = { mode: 'pitch', labels: uniq.map((s) => (s > 0 ? `+${s}` : String(s))), lit: on ? uniq.indexOf(e.semitones[k]) : -1 }
          semitones = on ? e.semitones[k] : null
          perfOp = 'tone'
        }
      }
    }
    if (m.perf?.op === 'roll' && loop) {
      const sizes = (m.tout?.outPerf?.ops.find((o) => o.kind === 'roll') as Extract<PerfOp, { kind: 'roll' }> | undefined)?.sizes ?? []
      pads = { mode: 'roll', labels: sizes.map((s) => (s >= 1 ? String(s) : `1/${Math.round(1 / s)}`)), lit: sizes.indexOf(loop.beats) }
    } else if (pads === HOTCUE && m.tin && m.role === 'incoming' && t - m.tin.mixStartSec < 0.6) {
      pads = { ...HOTCUE, lit: 0 } // the cue the incoming deck started from
    }
    const g = tr.grid
    const beat = g ? (pos - g.firstBeatSec) / g.beatSec : null
    const keyLock = m.role === 'incoming' && !!m.tin && Math.abs(m.tin.tempoRatio - 1) > 1e-4
    const sync = (m.role === 'incoming' || m.role === 'outgoing') && !!(m.role === 'incoming' ? m.tin?.beatmatched : m.tout?.beatmatched)
    return {
      track: i,
      pos,
      speed: m.speed,
      playing: m.playing,
      role: m.role,
      tempoPct: m.playing ? (m.speed !== 0 && m.perf == null ? (m.speed - 1) * 100 : 0) : 0,
      bpm: tr.bpm > 0 ? tr.bpm * (m.perf == null && m.speed > 0 ? m.speed : 1) : null,
      keyLock,
      sync,
      beat,
      loop,
      perf: perfOp,
      pads,
      semitones,
      cueSec: m.tin ? m.tin.inCueSec : tr.cueSec,
      outCueSec: m.tout ? m.tout.outCueSec : null,
    }
  }

  function channelState(i: number, d: DeckId, t: number): ChannelState {
    const tr = perf.tracks[i]
    const tin = T[i - 1]
    const tout = T[i]
    const s = slots[i]
    const lvl = levels ? levelAt(levels[d], t) : null
    const c = neutralChannel(tr.trimDb, lvl)
    if (t < s.start) return c // renderer: incoming fader 0 before its transition starts
    // incoming side of tin (until the splice back to plain audio)
    if (tin && t < tin.mixStartSec + tin.spliceSec) {
      const beat = (t - tin.mixStartSec) / tin.beatSec
      return lanesAt(c, tin.in, beat, tin, false)
    }
    // outgoing side of tout (from beat 0 through its splice)
    if (tout && t >= tout.mixStartSec) {
      const beat = (t - tout.mixStartSec) / tout.beatSec
      return lanesAt(c, tout.out, beat, tout, true)
    }
    // plain body: the renderer emits the raw track with its trim
    c.gain = 1
    return c
  }

  function lanesAt(c: ChannelState, l: PerfChannelLanes, beat: number, tt: PerfTransition, outgoing: boolean): ChannelState {
    // the renderer multiplies the channel fader by the dipless crossfader curve; show the level it applies
    const xf = tt.crossfader ? curveAt(tt.crossfader, beat, 0) : 0
    c.gain = curveAt(l.gain, beat) * Math.min(1, outgoing ? 1 - xf : 1 + xf)
    c.low = curveAt(l.low, beat)
    c.mid = curveAt(l.mid, beat)
    c.high = curveAt(l.high, beat)
    c.filter = l.filter ? curveAt(l.filter, beat) : 0
    if (l.stems) c.stems = { vocals: curveAt(l.stems.vocals, beat, 1), inst: curveAt(l.stems.inst, beat, 1) }
    if (outgoing && tt.echo) {
      const send = curveAt(tt.echo.send, beat)
      c.echo = send
      // tail: the delay line keeps ringing after the send closes (until the renderer's splice)
      const lastOpen = [...tt.echo.send].reverse().find((p) => p.value > 0.001)
      const decayBeats = tt.echo.feedback > 0 ? tt.echo.delayBeats * Math.min(32, Math.log(0.01) / Math.log(tt.echo.feedback)) : tt.echo.delayBeats
      c.echoTail = send <= 0.001 && !!lastOpen && beat > lastOpen.beat && beat < lastOpen.beat + decayBeats
    }
    if (outgoing && tt.reverb) c.reverb = curveAt(tt.reverb.send, beat)
    return c
  }

  return {
    perf,
    trackStart: (i) => slots[i]?.start ?? 0,
    evaluate(t: number): ControllerState {
      const deck = { A: idleDeck(), B: idleDeck() }
      const ch = { A: neutralChannel(), B: neutralChannel() }
      for (const d of ['A', 'B'] as const) {
        const i = trackOn(d, t)
        if (i == null) {
          ch[d].levelDb = levels ? levelAt(levels[d], t) : null
          continue
        }
        deck[d] = deckState(i, t)
        ch[d] = channelState(i, d, t)
      }
      let transition: ControllerState['transition'] = null
      let next: ControllerState['next'] = null
      for (const tt of T) {
        const j = t - tt.mixStartSec
        if (j >= 0 && j < tt.spliceSec) {
          const bars = Math.max(1, tt.overlapBars)
          const inOverlap = j < tt.durationSec
          transition = { index: tt.index, label: tt.label, technique: tt.technique, phase: inOverlap ? 'overlap' : 'tail', progress: Math.min(1, j / Math.max(0.001, tt.durationSec)), bar: Math.min(bars, Math.floor(j / (4 * tt.beatSec)) + 1), bars }
        } else if (j < 0 && !next) next = { index: tt.index, inSec: -j }
      }
      const fxIndicators = legacyFx.filter((e) => t >= e.startSec && t < e.endSec).map((e) => e.kind)
      return { t, deck, ch, masterDb: levels ? levelAt(levels.master, t) : null, transition, next, fxIndicators }
    },
  }
}

function planLike(t: PerfTransition) {
  return { style: t.style as TransitionPlan['style'], tempoRatio: t.tempoRatio, durationSec: t.durationSec, tempoRecoveryBars: t.tempoRecoveryBars, beatSec: t.beatSec, inCueSec: t.inCueSec }
}
