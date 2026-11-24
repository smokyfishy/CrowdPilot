/**
 * Long-form, multi-stage DJ performances (16–64 bars) compiled to executable controls.
 *
 * A performance is a sequence of five stages whose boundaries are SOLVED from the two recordings'
 * bar-level content (src/mixgen/profile.ts → overlapCompat), not copied from a template:
 *   1 introduce  incoming percussion/hats enter (lows killed, mids tucked)
 *   2 layer      rhythmic + harmonic layering (incoming mids only when the harmony fits)
 *   3 develop    strategy-specific: percussion build, filter ride, vocal handoff / echo-out, stem mashup
 *   4 transfer   bass handoff on a phrase bar where the incoming bass is present; melodic focus moves
 *   5 resolve    outgoing thins out (highs, high-pass ride, echo tail) and leaves via fader + crossfader
 *
 * Output is a TransitionPlan the renderer executes sample-accurately: per-deck channel faders,
 * crossfader, 3-band EQ, bipolar filters, echo sends on both decks, the incoming tempo lane, an
 * outgoing loop when the outgoing runs out of audio, cue triggers, and stem gain lanes when clean
 * stems exist (local worker). Continuous shape parameters (`LongformParams`) default to neutral
 * values; TransitionNet v2 (src/ml) predicts them and the strategy when its checkpoint is loaded.
 */
import { BEATMATCHED, type CurvePoint, type TransitionPlan, type StagedPerformanceInfo } from '../dj/transitions'
import { barAt, overlapCompat, type OverlapCompat, type TrackProfile } from './profile'
import { TECHNIQUE_LABEL, type StemInfo, type TechniquePlan } from './techniques'

export type Strategy = 'layered_blend' | 'percussion_build' | 'vocal_handoff' | 'filter_ride' | 'echo_handoff' | 'stem_mashup' | 'drop_lock'
export const STRATEGIES: Strategy[] = ['layered_blend', 'percussion_build', 'vocal_handoff', 'filter_ride', 'echo_handoff', 'stem_mashup', 'drop_lock']

/** Continuous shape parameters, each 0..1 (0.5 = neutral). */
export interface LongformParams {
  introLen: number
  swapShift: number
  hatsRamp: number
  midLayer: number
  outMidCut: number
  outHighFade: number
  headroom: number
  echoOut: number
  filterRide: number
  resolveLen: number
  bassLen: number
  xfader: number
}
export const PARAM_KEYS: Array<keyof LongformParams> = ['introLen', 'swapShift', 'hatsRamp', 'midLayer', 'outMidCut', 'outHighFade', 'headroom', 'echoOut', 'filterRide', 'resolveLen', 'bassLen', 'xfader']
export const NEUTRAL: LongformParams = { introLen: 0.5, swapShift: 0.5, hatsRamp: 0.5, midLayer: 0.5, outMidCut: 0.5, outHighFade: 0.5, headroom: 0.5, echoOut: 0.5, filterRide: 0.5, resolveLen: 0.5, bassLen: 0.5, xfader: 0.5 }

export interface LongformContext {
  /** A feasible beat-matched candidate: provides cue points, overlap, tempo ratio and beat period. */
  base: TransitionPlan
  pa: TrackProfile
  pb: TrackProfile
  /** Defaults to the first rule-feasible strategy for this window. */
  strategy?: Strategy
  params?: Partial<LongformParams>
  stems?: { a?: StemInfo; b?: StemInfo }
  /** Who chose strategy/params (trace + manifest honesty). */
  source?: 'transitionnet-v2' | 'rules'
  /** Precomputed compatibility for this window. */
  compat?: OverlapCompat
}

const KILL = -40
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const smooth = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}
const ampDb = (a: number) => (a <= 0.01 ? KILL : Math.max(KILL, 20 * Math.log10(a)))
const dbAmp = (d: number) => (d <= KILL ? 0 : 10 ** (d / 20))

/** Piecewise automation lane builder (beats); ramps are sampled densely, values held between ramps. */
class Lane {
  private pts: CurvePoint[]
  constructor(
    private total: number,
    start: number,
    private db = false,
  ) {
    this.pts = [{ beat: 0, value: start }]
  }
  private get last() {
    return this.pts[this.pts.length - 1]
  }
  /** Ramp from the current value to `to` between beats b0..b1 (hold before b0). Amplitude-domain shaping for dB lanes. */
  ramp(b0: number, b1: number, to: number, shape: 'smooth' | 'linear' = 'smooth'): this {
    b0 = clamp(b0, this.last.beat, this.total)
    b1 = clamp(Math.max(b1, b0), b0, this.total)
    const from = this.last.value
    if (b0 > this.last.beat) this.pts.push({ beat: b0, value: from })
    if (b1 - b0 < 1e-6) {
      this.pts.push({ beat: b0 + 1e-3, value: to })
      return this
    }
    const n = Math.max(6, Math.ceil((b1 - b0) * 2))
    const fa = this.db ? dbAmp(from) : from
    const ta = this.db ? dbAmp(to) : to
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const f = shape === 'smooth' ? smooth(t) : t
      const v = fa + (ta - fa) * f
      this.pts.push({ beat: b0 + t * (b1 - b0), value: this.db ? ampDb(v) : v })
    }
    return this
  }
  done(): CurvePoint[] {
    if (this.last.beat < this.total) this.pts.push({ beat: this.total, value: this.last.value })
    return this.pts.map((p) => ({ beat: Math.round(p.beat * 1000) / 1000, value: Math.round(p.value * 10000) / 10000 }))
  }
}

const snap = (x: number, q = 2) => Math.round(x / q) * q

/** Strategies the music supports for this window, best-first by rules (the closed loop renders several). */
export function feasibleStrategies(compat: OverlapCompat, ctx: { stems?: { a?: StemInfo; b?: StemInfo }; dropAtEnd: boolean; want?: readonly Strategy[] }): Strategy[] {
  const out: Strategy[] = []
  const stemsClean = !!(ctx.stems?.a?.clean && ctx.stems?.b?.clean)
  const vocalsInPlay = compat.perBar.some((x) => x.vocA >= 0.5) && compat.perBar.some((x) => x.vocB >= 0.5)
  if (ctx.dropAtEnd) out.push('drop_lock')
  if (vocalsInPlay) {
    if (stemsClean) out.push('stem_mashup')
    out.push(compat.vocalHandoffBar !== null ? 'vocal_handoff' : 'echo_handoff')
  }
  if (compat.percOverload < 0.4) out.push('percussion_build')
  out.push('layered_blend')
  if (compat.harmonicClash >= 0.35) out.push('filter_ride')
  else out.push('filter_ride')
  if (!out.includes('echo_handoff') && (compat.outRunsOut > 0 || compat.vocalClash > 0.4)) out.push('echo_handoff')
  // a strategy the user asked for (echo handoff, filter ride) works on any window; it leads the list
  // (drop locks still need a drop, stem mashups clean stems)
  const want = (ctx.want ?? []).filter((w) => (w !== 'drop_lock' || ctx.dropAtEnd) && (w !== 'stem_mashup' || stemsClean) && (w !== 'vocal_handoff' || compat.vocalHandoffBar !== null))
  return [...new Set([...want, ...out])]
}

/**
 * Builds the staged performance for one window. Returns a `staged_blend` TechniquePlan (stems only
 * when clean stems exist on both decks) with every control lane populated.
 */
export function buildPerformance(ctx: LongformContext): TechniquePlan {
  const { base, pa, pb } = ctx
  const P: LongformParams = { ...NEUTRAL, ...ctx.params }
  const bars = base.overlapBars
  const B = bars * 4
  const compat = ctx.compat ?? overlapCompat(pa, pb, base.outCueSec, base.inCueSec, bars)
  const dropAtEnd = base.incomingDropSec !== undefined && Math.abs((base.incomingDropOffsetSec ?? base.durationSec) - base.durationSec) < 0.05
  const strategy: Strategy = ctx.strategy ?? feasibleStrategies(compat, { stems: ctx.stems, dropAtEnd })[0]
  // ── stage boundaries (bars), solved from the recordings ──
  let swap = compat.bassSwapBar + snap((P.swapShift - 0.5) * 8)
  if (strategy === 'drop_lock' || dropAtEnd) swap = bars // bass arrives exactly on the incoming drop
  swap = clamp(swap, Math.min(4, bars - 1), bars)
  const s1 = clamp(snap(swap * (0.2 + 0.3 * P.introLen)), 2, Math.max(2, swap - 2))
  const s2 = clamp(snap(swap * 0.65), s1 + 1, Math.max(s1 + 1, swap - 1))
  const post = bars - swap
  const s4 = clamp(swap + Math.max(2, snap(post * 0.3)), swap, bars)
  const fadeBars = Math.max(2, Math.round(post * (0.35 + 0.5 * P.resolveLen)))
  // drop lock: the outgoing leaves ON the drop (last bar), never after the window
  const fadeStart = swap >= bars ? bars - 1 : clamp(bars - fadeBars, swap, bars - 1)
  const headroom = 0.82 + 0.1 * P.headroom // both decks at full level → −1…−1.7 dB each
  const bassBeats = strategy === 'drop_lock' || dropAtEnd ? 1 + 2 * P.bassLen : 1 + 7 * P.bassLen
  const swapBeat = swap * 4
  const hatsBars = 1 + Math.round(7 * P.hatsRamp)
  const melodicOk = compat.melodicLayerOk
  const midLayerDb = melodicOk ? -18 + 15 * P.midLayer : -22 + 6 * P.midLayer
  const outMidDb = -24 + 21 * (1 - P.outMidCut)
  const actions: Record<string, string[]> = { introduce: [], layer: [], develop: [], transfer: [], resolve: [] }

  // ── incoming deck ──
  const inGain = new Lane(B, 0).ramp(0, s1 * 4, headroom)
  const inLow = new Lane(B, KILL, true)
  const inMid = new Lane(B, -26, true)
  const inHigh = new Lane(B, KILL, true).ramp(0, hatsBars * 4, 0)
  actions.introduce.push(`incoming hats/percussion in over ${hatsBars} bars (lows killed, mids −26 dB)`)
  inMid.ramp(s1 * 4, s2 * 4, midLayerDb)
  actions.layer.push(melodicOk ? `incoming mids layered to ${midLayerDb.toFixed(0)} dB (harmony compatible)` : `incoming mids held at ${midLayerDb.toFixed(0)} dB (harmony clash risk)`)
  // ── outgoing deck ──
  const outGain = new Lane(B, 1).ramp(0, s1 * 4, headroom)
  const outLow = new Lane(B, 0, true)
  const outMid = new Lane(B, 0, true)
  const outHigh = new Lane(B, 0, true)
  const filterOut = new Lane(B, 0)
  const filterIn = new Lane(B, 0)
  // incoming hats over outgoing hats: tuck the outgoing highs so the two hat patterns don't flam
  const tuck = compat.percOverload > 0.3 ? -6 : -3
  outHigh.ramp(s1 * 4 - 4, s1 * 4 + 4, tuck)
  actions.layer.push(`outgoing highs tucked ${tuck} dB to make room for the incoming percussion`)
  let echo: TransitionPlan['echo']
  let echoIn: TransitionPlan['echoIn']
  let outLoop: TransitionPlan['outLoop']
  let stemRoute: TechniquePlan['tech'] | undefined
  let vocalMode = 'none'

  // ── develop (strategy-specific) ──
  const vocalBar = compat.vocalHandoffBar
  switch (strategy) {
    case 'percussion_build':
      outMid.ramp(s2 * 4, swapBeat, -6)
      inHigh.ramp(s2 * 4, s2 * 4 + 4, 1.5)
      actions.develop.push('percussion build: incoming highs +1.5 dB, outgoing mids eased −6 dB toward the swap')
      break
    case 'filter_ride':
      filterOut.ramp(s2 * 4, swapBeat, 0.15 + 0.35 * P.filterRide)
      filterIn.ramp(0, 1, -0.45).ramp(s1 * 4, swapBeat, 0)
      actions.develop.push(`filter ride: outgoing high-pass rises to ${(0.15 + 0.35 * P.filterRide).toFixed(2)}, incoming low-pass opens by the swap`)
      break
    case 'vocal_handoff': {
      const h = clamp(vocalBar ?? swap, 1, bars - 1)
      // outgoing vocal (mid band) leaves at the end of its phrase; the incoming vocal is unmasked after it
      outMid.ramp(h * 4 - 4, h * 4, Math.min(outMidDb, -14))
      inMid.ramp(Math.max(h * 4, s2 * 4), Math.max(h * 4, s2 * 4) + 4, 0)
      vocalMode = `handoff at bar ${h}`
      actions.develop.push(`vocal handoff on bar ${h}: outgoing vocal phrase ends, incoming vocal unmasked`)
      break
    }
    case 'echo_handoff': {
      const h = clamp(vocalBar ?? s2, 2, bars - 2)
      const send = 0.35 + 0.5 * P.echoOut
      echo = { send: new Lane(B, 0).ramp(h * 4 - 2, h * 4 - 0.5, send).ramp(h * 4, h * 4 + 0.5, 0).done(), delayBeats: 0.75, feedback: 0.5 }
      outMid.ramp(h * 4 - 0.5, h * 4 + 1, -30)
      vocalMode = `echo-out at bar ${h}`
      actions.develop.push(`echo-out of the outgoing vocal on bar ${h} (send ${send.toFixed(2)}, ¾-beat delay), outgoing mids cut`)
      break
    }
    case 'stem_mashup': {
      // acapella-over-instrumental: outgoing vocal rides the incoming instrumental; incoming vocal held back
      const lastA = Math.max(0, compat.perBar.reduce((m, x, k) => (x.vocA >= 0.5 ? k : m), -1))
      const end = clamp(Math.ceil((lastA + 1) / 4) * 4, swap, bars)
      const route = {
        out: { vocals: new Lane(B, 1).ramp(end * 4 - 2, end * 4, 0).done(), inst: new Lane(B, 1).ramp(swapBeat - 2, swapBeat + 2, 0, 'linear').done() },
        in: { vocals: new Lane(B, 0).ramp(end * 4, end * 4 + 4, 1).done(), inst: new Lane(B, 1).done() },
      }
      stemRoute = { technique: 'stem_handoff', label: TECHNIQUE_LABEL.stem_handoff, stems: route, rationale: ['clean vocal/instrumental stems on both decks', `outgoing vocal over the incoming instrumental until bar ${end}`], confidence: 0.6 }
      vocalMode = `stems: outgoing acapella until bar ${end}`
      actions.develop.push(`stem mashup: outgoing acapella over incoming instrumental until bar ${end}, incoming vocal after`)
      break
    }
    case 'drop_lock':
      filterIn.ramp(0, 1, -0.6).ramp(s1 * 4, B - 2, 0)
      actions.develop.push('incoming build under the outgoing (lows killed, low-pass opening) — drop lands on the final bar')
      break
    case 'layered_blend':
      outMid.ramp(s2 * 4, swapBeat, -3)
      actions.develop.push('layered blend: outgoing mids eased −3 dB')
      break
  }
  // Vocal safety for non-vocal strategies: if both vocals would play in the layered zone, tuck the incoming mids until the outgoing vocal ends.
  if (strategy !== 'vocal_handoff' && strategy !== 'echo_handoff' && strategy !== 'stem_mashup' && compat.vocalClash > 0.3) {
    const lastA = compat.perBar.reduce((m, x, k) => (x.vocA >= 0.5 ? k : m), -1)
    if (lastA >= 0) actions.develop.push(`incoming mids held under the outgoing vocal until bar ${Math.ceil((lastA + 1) / 4) * 4}`)
  }

  // ── transfer: bass handoff (linear amplitude, summed low band stays ≈ constant) ──
  const b0 = clamp(swapBeat - bassBeats / 2, 0, B)
  const b1 = clamp(swapBeat + bassBeats / 2, 0, B)
  if (swap >= bars) {
    // drop lock: hard-ish handoff on the drop downbeat (bassBeats/2 before it)
    outLow.ramp(B - bassBeats, B, KILL, 'linear')
    inLow.ramp(B - bassBeats, B, 0, 'linear')
  } else {
    outLow.ramp(b0, b1, KILL, 'linear')
    inLow.ramp(b0, b1, 0, 'linear')
  }
  actions.transfer.push(`bass handoff on bar ${swap} over ${bassBeats.toFixed(1)} beats${compat.perBar[Math.min(bars - 1, swap)]?.regionB === 'drop' ? ' (incoming drop)' : ''}`)
  const midT = Math.min(B, swapBeat + 8)
  inMid.ramp(swapBeat, midT, 0)
  inHigh.ramp(swapBeat, midT, 0)
  inGain.ramp(swapBeat, Math.min(B, swapBeat + 8), 1)
  if (strategy !== 'vocal_handoff' && strategy !== 'echo_handoff') outMid.ramp(swapBeat, Math.min(B, swapBeat + 16), outMidDb)
  actions.transfer.push(`melodic focus moves to the incoming (incoming mids 0 dB, outgoing mids ${outMidDb.toFixed(0)} dB)`)

  // ── resolve: outgoing thins out and leaves at a phrase boundary ──
  const hfStart = clamp(swapBeat + (fadeStart * 4 - swapBeat) * P.outHighFade, swapBeat, fadeStart * 4)
  outHigh.ramp(hfStart, B, -14)
  const ride = strategy === 'filter_ride' ? 0.5 + 0.2 * P.filterRide : 0.25 * P.filterRide
  if (ride > 0.02) filterOut.ramp(fadeStart * 4, B, Math.min(0.75, ride))
  outGain.ramp(swap >= bars ? B - 1 : fadeStart * 4, B, 0.25, 'smooth')
  const xStart = swap >= bars ? B - 1 : clamp(B - Math.max(4, (B - fadeStart * 4) * (0.3 + 0.5 * P.xfader)), fadeStart * 4, B - 1)
  const crossfader = new Lane(B, 0).ramp(xStart, B, 1).done()
  actions.resolve.push(`outgoing fades from bar ${fadeStart} (highs from beat ${hfStart.toFixed(0)}${ride > 0.02 ? `, high-pass ride to ${Math.min(0.75, ride).toFixed(2)}` : ''}); crossfader to the incoming over the last ${((B - xStart) / 4).toFixed(1)} bars`)
  // Echo tail on an outgoing vocal still present in the last bars.
  const vocalTail = compat.perBar.slice(-4).some((x) => x.vocA >= 0.5)
  if (!echo && vocalTail && P.echoOut > 0.2) {
    const send = 0.25 + 0.45 * P.echoOut
    echo = { send: new Lane(B, 0).ramp(B - 6, B - 1, send).ramp(B - 0.5, B, 0).done(), delayBeats: 0.75, feedback: 0.45 }
    actions.resolve.push(`echo tail on the outgoing vocal (send ${send.toFixed(2)})`)
  }
  // Incoming vocal stab echo-in is reserved for drop-lock builds with a vocal in the build.
  if (strategy === 'drop_lock' && compat.perBar.slice(-8, -4).some((x) => x.vocB >= 0.5)) {
    echoIn = { send: new Lane(B, 0).ramp(B - 18, B - 16, 0.3).ramp(B - 12, B - 10, 0).done(), delayBeats: 0.5, feedback: 0.4 }
    actions.develop.push('echo on the incoming build vocal (½-beat)')
  }
  // Outgoing runs out of audio inside the window → loop its last full 4-bar phrase (instrumental).
  if (compat.outRunsOut > 0) {
    const avail = Math.max(4, bars - compat.outRunsOut - 1)
    const loopStartBar = Math.max(4, Math.floor(avail / 4) * 4)
    outLoop = { startBeat: loopStartBar * 4, lengthBeats: 16, endBeat: B + 32 }
    actions.resolve.push(`outgoing loops its 4-bar phrase from bar ${loopStartBar - 4} (outgoing audio ends inside the blend)`)
  }

  // ── element-level stems (local worker, clean 4-stem separations on both decks) ──
  const four = (x?: StemInfo) => !!(x?.clean && x.elements?.includes('drums') && x.elements.includes('other'))
  if (!stemRoute && four(ctx.stems?.a) && four(ctx.stems?.b)) {
    const vIn = clamp((vocalBar ?? swap) * 4, 0, B)
    const otherLayer = melodicOk ? dbAmp(midLayerDb + 6) : 0.15
    const route = {
      in: {
        vocals: new Lane(B, 0).ramp(vIn, Math.min(B, vIn + 4), 1).done(),
        inst: [],
        drums: new Lane(B, 1).done(),
        bass: new Lane(B, 1).done(),
        other: new Lane(B, 0).ramp(s1 * 4, s2 * 4, otherLayer).ramp(swapBeat, Math.min(B, swapBeat + 8), 1).done(),
      },
      out: {
        vocals: strategy === 'vocal_handoff' || strategy === 'echo_handoff' ? new Lane(B, 1).ramp(Math.max(0, vIn - 4), vIn, 0).done() : new Lane(B, 1).done(),
        inst: [],
        drums: new Lane(B, 1).done(),
        bass: new Lane(B, 1).done(),
        other: new Lane(B, 1).ramp(fadeStart * 4, B, 0.4).done(),
      },
    }
    stemRoute = { technique: 'stem_handoff', label: TECHNIQUE_LABEL.stem_handoff, stems: route, rationale: ['clean 4-stem separations on both decks', 'incoming drums first, melody (other) layered when the harmony fits, incoming vocal after the outgoing one'], confidence: 0.6 }
    actions.introduce.push('stems: incoming drums only (melody and vocal stems muted)')
    actions.layer.push(`stems: incoming melody stem to ${(20 * Math.log10(Math.max(1e-3, otherLayer))).toFixed(0)} dB`)
    if (vocalMode === 'none') vocalMode = `stems: incoming vocal from bar ${Math.round(vIn / 4)}`
  }

  // ── tempo lane: tempo-matched over the overlap, then returns to the incoming's own tempo ──
  const r = base.tempoRatio
  const recBars = Math.abs(r - 1) > 0.002 ? base.tempoRecoveryBars || 16 : 0
  const tempo: CurvePoint[] = recBars ? [{ beat: 0, value: r }, { beat: B, value: r }, { beat: B + recBars * 4, value: 1 }] : [{ beat: 0, value: r }, { beat: B, value: r }]
  const cues: NonNullable<TransitionPlan['cues']> = [{ deck: 'in', beat: 0, trackSec: base.inCueSec, label: `incoming starts (${pb.region[barAt(pb, base.inCueSec)] ?? 'body'})` }]
  if (base.incomingDropSec !== undefined) cues.push({ deck: 'in', beat: (base.incomingDropOffsetSec ?? base.durationSec) / base.beatSec, trackSec: base.incomingDropSec, label: 'incoming drop' })
  if (outLoop) cues.push({ deck: 'out', beat: outLoop.startBeat, trackSec: base.outCueSec + (outLoop.startBeat - outLoop.lengthBeats) * base.beatSec, label: 'loop in' })

  const performance: StagedPerformanceInfo = {
    source: ctx.source ?? 'rules',
    strategy,
    bassSwapBar: swap,
    vocalMode,
    stages: [
      { kind: 'introduce', startBar: 0, endBar: s1, actions: actions.introduce },
      { kind: 'layer', startBar: s1, endBar: s2, actions: actions.layer },
      { kind: 'develop', startBar: s2, endBar: Math.max(s2, Math.min(swap, bars)), actions: actions.develop },
      { kind: 'transfer', startBar: Math.min(swap, bars), endBar: Math.max(Math.min(swap, bars), s4), actions: actions.transfer },
      { kind: 'resolve', startBar: Math.max(Math.min(swap, bars), s4), endBar: bars, actions: actions.resolve },
    ],
    params: Object.fromEntries(PARAM_KEYS.map((k) => [k, Math.round(P[k] * 1000) / 1000])),
  }
  const plan: TechniquePlan = {
    ...base,
    style: 'staged_blend',
    tempoRecoveryBars: recBars,
    handoffBeat: Math.min(B, swapBeat),
    out: { gain: outGain.done(), low: outLow.done(), mid: outMid.done(), high: outHigh.done() },
    in: { gain: inGain.done(), low: inLow.done(), mid: inMid.done(), high: inHigh.done() },
    filter: { out: filterOut.done(), in: filterIn.done() },
    crossfader,
    tempo,
    cues,
    performance,
    reasons: [...base.reasons.filter((x) => !x.startsWith('Long-form')), `Long-form ${bars}-bar ${strategy.replace('_', ' ')} (${performance.source === 'transitionnet-v2' ? 'TransitionNet v2' : 'rule solver'}): bass swap bar ${swap}${vocalMode !== 'none' ? `, ${vocalMode}` : ''}`],
  }
  delete plan.outPerf
  if (echo) plan.echo = echo
  else delete plan.echo
  if (echoIn) plan.echoIn = echoIn
  if (outLoop) plan.outLoop = outLoop
  if (stemRoute) plan.tech = stemRoute
  else delete plan.tech
  return plan
}

/** Can this candidate host a long-form performance (beat-matched, ≥ 16 bars)? */
export function longformEligible(p: TransitionPlan): boolean {
  return BEATMATCHED.has(p.style) && p.overlapBars >= 16 && p.durationSec > 0 && p.style !== 'drop_swap'
}
