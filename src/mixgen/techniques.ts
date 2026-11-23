/**
 * Advanced DJ techniques as STRUCTURED, time-stamped controls that the offline renderer executes as
 * real audio processing. Each technique extends a base TransitionPlan (whose fader/EQ/filter/echo/
 * tempo automation renderTransition already executes) with:
 *   - deck edits applied to a copy of a deck's PCM in that track's own time (stabs, juggle, tone play);
 *   - stem routing with gain automation (vocals / instrumental from a separation model);
 *   - a reverb send on the outgoing deck (post-fader wash-out tail);
 *   - performance ops that the base renderer already supports (spin-back).
 *
 * No learned model was trained for these techniques, so WHETHER and WHERE they are used is decided
 * from the music analysis (beats, drops, phrases, key, vocal activity from stems) plus explicit rules,
 * and DJCritic judges rendered previews against simpler alternatives. This is reported as such.
 */
import type { AnalysisSummary } from '../dsp/analyze'
import { camelotDistance } from '../dsp/key'
import type { RenderOutput } from '../dj/render'
import { curveAt } from '../dj/automation'
import { automationFor, BEATMATCHED, tempoMatch, type CurvePoint, type DeckAutomation, type TransitionPlan } from '../dj/transitions'
import type { ResolvedSpec } from './spec'

export type Technique = 'acapella_layer' | 'mashup_swap' | 'double_drop' | 'spinback' | 'stab_build' | 'beat_juggle' | 'tone_play' | 'reverb_wash'

export const TECHNIQUE_LABEL: Record<Technique, string> = {
  acapella_layer: 'Acapella layer (incoming vocal over outgoing instrumental)',
  mashup_swap: 'Mashup (outgoing vocal over incoming instrumental)',
  double_drop: 'Double drop',
  spinback: 'Spin-back',
  stab_build: 'Sample-stab build',
  beat_juggle: 'Beat juggle',
  tone_play: 'Tone play',
  reverb_wash: 'Reverb wash-out',
}

export type DeckEdit =
  /** Rhythmic stabs of a short slice (`sourceSec`, `hitBeats` long) at accelerating intervals; the rest ducked. */
  | { kind: 'stabs'; startSec: number; beats: number; beatSec: number; sourceSec: number; hitBeats: number; intervals: number[]; duck: number }
  /** Alternate live beats with a repeated earlier beat (`offsetBeats` back) following a pattern (1 = repeat). */
  | { kind: 'juggle'; startSec: number; beats: number; beatSec: number; offsetBeats: number; pattern: number[] }
  /** Re-triggered, re-pitched copies of a tonal hit on beats (semitone offsets from the hit's pitch). */
  | { kind: 'tone'; startSec: number; beats: number; beatSec: number; sourceSec: number; hitBeats: number; semitones: number[]; mix: number }

export interface StemRoute {
  /** Gain curves (0..1) over the transition (beats relative to its start) for each deck's stems. */
  out: { vocals: CurvePoint[]; inst: CurvePoint[] }
  in: { vocals: CurvePoint[]; inst: CurvePoint[] }
}

export interface TechniqueControls {
  technique: Technique
  label: string
  deckEdits?: { out?: DeckEdit[]; in?: DeckEdit[] }
  stems?: StemRoute
  reverb?: { send: CurvePoint[]; decaySec: number; wet: number }
  rationale: string[]
  /** Analysis confidence the decision relied on (0..1). */
  confidence: number
}

export type TechniquePlan = TransitionPlan & { tech?: TechniqueControls }

// ───────────────────────── DSP: deck edits, stems, reverb ─────────────────────────

const read = (x: Float32Array, pos: number) => {
  const i = Math.floor(pos)
  if (i < 0 || i + 1 >= x.length) return 0
  const f = pos - i
  return x[i] * (1 - f) + x[i + 1] * f
}

/** Beats (from the edit start) at which a stab edit fires its slice — shared by the renderer and the UI. */
export function stabHitBeats(e: { beats: number; intervals: number[] }): number[] {
  const times: number[] = []
  let t = 0
  for (const iv of e.intervals) {
    // each interval value is used for one bar's worth of beats (4 beats), accelerating into the drop
    for (let k = 0; k < Math.max(1, Math.round(4 / iv)); k++) {
      if (t >= e.beats) break
      times.push(t)
      t += iv
    }
  }
  return times
}

/** Applies deck edits to a COPY of the channels (track time). Click-free: 3 ms ramps at every splice. */
export function applyDeckEdits(channels: Float32Array[], rate: number, edits: DeckEdit[]): Float32Array[] {
  if (!edits.length) return channels
  const out = channels.map((c) => c.slice())
  const ramp = Math.round(0.003 * rate)
  for (const e of edits) {
    const s0 = Math.round(e.startSec * rate)
    const n = Math.round(e.beats * e.beatSec * rate)
    const beat = e.beatSec * rate
    for (let ci = 0; ci < out.length; ci++) {
      const src = channels[ci]
      const dst = out[ci]
      if (e.kind === 'stabs') {
        const hit = Math.max(ramp * 4, Math.round(e.hitBeats * beat))
        const src0 = Math.round(e.sourceSec * rate)
        const times = stabHitBeats(e)
        for (let i = 0; i < n; i++) dst[s0 + i] = (src[s0 + i] ?? 0) * e.duck
        for (const tb of times) {
          const at = s0 + Math.round(tb * beat)
          for (let k = 0; k < hit && at + k < s0 + n; k++) {
            const env = Math.min(1, k / ramp) * Math.exp((-4 * k) / hit)
            dst[at + k] += (src[src0 + k] ?? 0) * env
          }
        }
      } else if (e.kind === 'juggle') {
        const off = Math.round(e.offsetBeats * beat)
        for (let i = 0; i < n; i++) {
          const b = Math.floor(i / beat)
          const repeat = e.pattern[b % e.pattern.length] === 1
          const k = i - b * beat // position within the beat
          const edge = Math.min(1, k / ramp, (beat - k) / ramp)
          const v = repeat ? (src[s0 + i - off] ?? 0) : (src[s0 + i] ?? 0)
          // crossfade with the live signal at slice edges (no clicks)
          dst[s0 + i] = repeat ? v * edge + (src[s0 + i] ?? 0) * (1 - edge) : v
        }
      } else {
        const hit = Math.round(e.hitBeats * beat)
        const src0 = e.sourceSec * rate
        for (let i = 0; i < n; i++) dst[s0 + i] = (src[s0 + i] ?? 0) * (1 - e.mix)
        e.semitones.forEach((semi, k) => {
          const ratio = 2 ** (semi / 12)
          const at = s0 + Math.round(k * beat)
          const len = Math.round(hit / ratio)
          for (let j = 0; j < len && at + j < s0 + n; j++) {
            const env = Math.min(1, j / ramp, (len - j) / ramp)
            dst[at + j] += read(src, src0 + j * ratio) * env * e.mix
          }
        })
      }
    }
  }
  return out
}

/** Stem gains default to 1 (unity) when a curve is empty. */
const stemGainAt = (c: CurvePoint[], beat: number) => curveAt(c, beat, 1)

/**
 * Stem routing for one deck: within [startSec, endSec) of the track, replaces the mixture with
 * vocals·gV + inst·gI (gains evaluated in transition beats via `beatAt(trackSec)`), crossfading
 * 50 ms at the window edges so the original mixture continues seamlessly outside it.
 */
export function routeStems(mix: Float32Array[], stems: { vocals: Float32Array[]; inst: Float32Array[] }, rate: number, startSec: number, endSec: number, beatAt: (trackSec: number) => number, gains: { vocals: CurvePoint[]; inst: CurvePoint[] }): Float32Array[] {
  const out = mix.map((c) => c.slice())
  const a = Math.max(0, Math.round(startSec * rate))
  const b = Math.min(mix[0].length, Math.round(endSec * rate))
  const xf = Math.round(0.05 * rate)
  for (let ci = 0; ci < out.length; ci++) {
    const v = stems.vocals[Math.min(ci, stems.vocals.length - 1)]
    const s = stems.inst[Math.min(ci, stems.inst.length - 1)]
    for (let i = a; i < b; i += 64) {
      const beat = beatAt(i / rate)
      const gv = stemGainAt(gains.vocals, beat)
      const gi = stemGainAt(gains.inst, beat)
      for (let k = i; k < Math.min(b, i + 64); k++) {
        const edge = Math.min(1, (k - a) / xf, (b - k) / xf)
        const routed = (v[k] ?? 0) * gv + (s[k] ?? 0) * gi
        out[ci][k] = routed * edge + mix[ci][k] * (1 - edge)
      }
    }
  }
  return out
}

/** Apply the same post-fader wash to a preview and to the continuous render. */
export function applyReverbWash(
  render: RenderOutput,
  beatSec: number,
  controls: NonNullable<NonNullable<TechniquePlan['tech']>['reverb']>,
): void {
  const { stemA, rate, channels, transitionStartSample } = render
  if (!stemA) return
  const send = new Float32Array(stemA.length)
  for (let i = transitionStartSample; i < send.length; i++) {
    send[i] = stemA[i] * curveAt(controls.send, (i - transitionStartSample) / rate / beatSec)
  }
  const wet = reverb(send, rate, controls.decaySec)
  const fadeEnd = stemA.length - Math.round(0.75 * rate)
  const fadeStart = fadeEnd - rate
  for (let i = 0; i < fadeEnd; i++) {
    const fade = i < fadeStart ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (i - fadeStart) / rate)
    const sample = wet[i] * controls.wet * fade
    for (const channel of channels) channel[i] += sample
    stemA[i] += sample
  }
}

/** Small Schroeder/Freeverb-style reverb (4 combs + 2 all-passes), mono in → mono wet out. */
export function reverb(input: Float32Array, rate: number, decaySec: number): Float32Array {
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round((d * rate) / 44100))
  const aps = [225, 556].map((d) => Math.round((d * rate) / 44100))
  const out = new Float32Array(input.length)
  const fb = combs.map((d) => 10 ** ((-3 * d) / (rate * Math.max(0.3, decaySec))))
  const cb = combs.map((d) => new Float32Array(d))
  const ci = combs.map(() => 0)
  const lp = combs.map(() => 0)
  const ab = aps.map((d) => new Float32Array(d))
  const ai = aps.map(() => 0)
  for (let n = 0; n < input.length; n++) {
    let acc = 0
    for (let k = 0; k < combs.length; k++) {
      const y = cb[k][ci[k]]
      lp[k] = y * 0.8 + lp[k] * 0.2 // damping
      cb[k][ci[k]] = input[n] + lp[k] * fb[k]
      ci[k] = (ci[k] + 1) % combs[k]
      acc += y
    }
    let x = acc / combs.length
    for (let k = 0; k < aps.length; k++) {
      const y = ab[k][ai[k]]
      ab[k][ai[k]] = x + y * 0.5
      ai[k] = (ai[k] + 1) % aps[k]
      x = y - x * 0.5
    }
    out[n] = x
  }
  return out
}

// ───────────────────────── analysis inputs for decisions ─────────────────────────

export interface StemInfo {
  /** Mean vocal-stem RMS (dB) per bar and the bar grid it is on. */
  vocalDb: number[]
  barStartSec: number
  barSec: number
  /** Separation passed the artifact check (low bass bleed into the vocal stem). */
  clean: boolean
  bleed: number
}

const vocalAt = (s: StemInfo, t0: number, t1: number) => {
  const b0 = Math.max(0, Math.floor((t0 - s.barStartSec) / s.barSec))
  const b1 = Math.min(s.vocalDb.length, Math.ceil((t1 - s.barStartSec) / s.barSec))
  if (b1 <= b0) return -90
  return s.vocalDb.slice(b0, b1).reduce((p, q) => p + q, 0) / (b1 - b0)
}

// ───────────────────────── technique builders ─────────────────────────

const flat = (B: number, v: number): CurvePoint[] => [{ beat: 0, value: v }, { beat: B, value: v }]
const lin = (pts: Array<[number, number]>): CurvePoint[] => pts.map(([beat, value]) => ({ beat, value }))

function based(base: TransitionPlan, tech: TechniqueControls, patch: Partial<TransitionPlan> = {}): TechniquePlan {
  return { ...base, ...patch, tech, reasons: [...base.reasons, `${tech.label}: ${tech.rationale.join('; ')}`] }
}

export interface TechniqueContext {
  spec: ResolvedSpec
  a: AnalysisSummary
  b: AnalysisSummary
  stemsA?: StemInfo
  stemsB?: StemInfo
  /** Beat-grid reliable enough for beat-synchronous edits on each side. */
  gridA: boolean
  gridB: boolean
  maxTempo: number
}

/**
 * Builds the technique candidates that the music supports for this pair, each derived from a
 * feasible base plan (same cue points/overlap). Aggressive techniques require reliable grids.
 */
export function techniqueCandidates(bases: TransitionPlan[], ctx: TechniqueContext): TechniquePlan[] {
  const out: TechniquePlan[] = []
  const { a, b } = ctx
  const keyDist = a.keyConf >= 0.1 && b.keyConf >= 0.1 ? camelotDistance(a.camelot, b.camelot) : 3
  const matched = bases.filter((p) => BEATMATCHED.has(p.style))
  // ── stem layering (acapella over instrumental / mashup) ──
  if (ctx.stemsA?.clean && ctx.stemsB?.clean && ctx.gridA && ctx.gridB && keyDist <= 1) {
    for (const base of matched.filter((p) => p.overlapBars >= 16).slice(0, 3)) {
      const B = base.overlapBars * 4
      const inVoc = vocalAt(ctx.stemsB, base.inCueSec, base.inCueSec + base.durationSec * base.tempoRatio)
      const outVoc = vocalAt(ctx.stemsA, base.outCueSec, base.outCueSec + base.durationSec)
      const half = Math.round(B / 2)
      if (inVoc > -32 && outVoc < inVoc - 3) {
        // incoming vocal over the outgoing instrumental, then the beds swap at the midpoint
        const stems: StemRoute = {
          out: { vocals: lin([[0, 1], [4, 0], [B, 0]]), inst: lin([[0, 1], [half, 1], [half + 4, 0], [B, 0]]) },
          in: { vocals: lin([[0, 0], [4, 1], [B, 1]]), inst: lin([[0, 0], [half, 0], [half + 4, 1], [B, 1]]) },
        }
        const auto: { out: DeckAutomation; in: DeckAutomation } = {
          out: { gain: lin([[0, 1], [half + 4, 1], [B, 0]]), low: lin([[0, 0], [half, 0], [half + 2, -40], [B, -40]]), mid: flat(B, 0), high: flat(B, 0) },
          in: { gain: lin([[0, 0], [2, 0.95], [B, 1]]), low: lin([[0, -40], [half, -40], [half + 2, 0], [B, 0]]), mid: flat(B, 0), high: flat(B, 0) },
        }
        out.push(
          based(base, { technique: 'acapella_layer', label: TECHNIQUE_LABEL.acapella_layer, stems, rationale: [`keys ${a.camelot}→${b.camelot}`, `incoming vocal ${inVoc.toFixed(0)} dB vs outgoing ${outVoc.toFixed(0)} dB in the overlap`, 'beds swap on the midpoint with a bass handoff'], confidence: Math.min(a.bpmConf, b.bpmConf, 1) }, { ...auto, handoffBeat: half, style: base.style }),
        )
      }
      if (outVoc > -32 && inVoc < outVoc - 3) {
        const stems: StemRoute = {
          out: { vocals: lin([[0, 1], [B - 4, 1], [B, 0]]), inst: lin([[0, 1], [4, 0], [B, 0]]) },
          in: { vocals: lin([[0, 0], [B - 4, 0], [B, 1]]), inst: lin([[0, 0], [4, 1], [B, 1]]) },
        }
        const auto = {
          out: { gain: lin([[0, 1], [B - 4, 1], [B, 0]]), low: lin([[0, 0], [2, -40], [B, -40]]), mid: flat(B, 0), high: flat(B, 0) },
          in: { gain: lin([[0, 0], [2, 1], [B, 1]]), low: lin([[0, -40], [2, 0], [B, 0]]), mid: flat(B, 0), high: flat(B, 0) },
        }
        out.push(based(base, { technique: 'mashup_swap', label: TECHNIQUE_LABEL.mashup_swap, stems, rationale: [`keys ${a.camelot}→${b.camelot}`, 'outgoing vocal rides the incoming instrumental'], confidence: Math.min(a.bpmConf, b.bpmConf) }, { ...auto, handoffBeat: 2 }))
      }
    }
  }
  // ── double drop: both drops land together, only one bassline ──
  if (ctx.gridA && ctx.gridB && a.dropsSec?.length && b.dropsSec?.length) {
    const { ratio } = tempoMatch(a.bpm, b.bpm)
    if (Math.abs(ratio - 1) <= ctx.maxTempo) {
      const beatA = 60 / a.bpm
      const dropA = a.dropsSec.filter((d) => d > a.durationSec * 0.45 && d < a.durationSec - 32 * beatA).at(-1)
      const dropB = b.dropsSec.find((d) => d > 16 * beatA * ratio && d < b.durationSec * 0.7)
      const template = matched[0]
      if (dropA !== undefined && dropB !== undefined && template) {
        const pre = 32 // beats of shared build before the drops
        const B = 64
        const outCue = dropA - pre * beatA
        const inCue = dropB - pre * beatA * ratio
        if (outCue > 0 && inCue > 0 && outCue + B * beatA < a.durationSec - 1) {
          const auto = {
            out: { gain: lin([[0, 1], [pre + 16, 1], [B, 0]]), low: lin([[0, 0], [pre + 16, 0], [pre + 18, -40], [B, -40]]), mid: lin([[0, 0], [pre + 16, 0], [B, -6]]), high: flat(B, 0) },
            in: { gain: lin([[0, 0], [pre - 16, 0.6], [pre, 0.95], [B, 1]]), low: lin([[0, -40], [pre + 16, -40], [pre + 18, 0], [B, 0]]), mid: lin([[0, -12], [pre, 0], [B, 0]]), high: flat(B, 0) },
          }
          out.push(
            based(
              template,
              { technique: 'double_drop', label: TECHNIQUE_LABEL.double_drop, rationale: [`drops aligned at ${dropA.toFixed(1)}s / ${dropB.toFixed(1)}s`, '16 bars of shared drop, incoming lows held back, then a bass swap'], confidence: Math.min(a.downbeatConf, b.downbeatConf, 1) },
              { style: 'bass_swap', outCueSec: outCue, inCueSec: inCue, incomingDropSec: undefined, overlapBars: B / 4, durationSec: B * beatA, beatSec: beatA, tempoRatio: ratio, tempoRecoveryBars: Math.abs(ratio - 1) > 0.002 ? 16 : 0, handoffBeat: pre + 16, ...auto, filter: undefined, echo: undefined, outPerf: undefined },
            ),
          )
        }
      }
    }
  }
  // ── creative cuts built on slam styles (no beat-match needed for the incoming) ──
  for (const base of bases.filter((p) => p.style === 'brake').slice(0, 1)) {
    const perf = base.outPerf ? { ...base.outPerf, ops: base.outPerf.ops.map((o) => (o.kind === 'brake' ? { kind: 'spinback' as const, atBeat: o.atBeat, beats: Math.min(o.beats, 2) } : o)) } : undefined
    if (perf) out.push(based(base, { technique: 'spinback', label: TECHNIQUE_LABEL.spinback, rationale: ['backspin out of the outgoing phrase, incoming lands on its downbeat'], confidence: 1 }, { outPerf: perf }))
  }
  if (ctx.gridA) {
    for (const base of bases.filter((p) => p.style === 'drop_swap' || p.style === 'short_fade' || p.style === 'bass_swap').slice(0, 1)) {
      const beatA = base.beatSec
      const B = base.overlapBars * 4
      if (B < 16) continue
      // stab build: the outgoing's last bars become stabs of its downbeat hit, accelerating into the drop
      out.push(
        based(base, {
          technique: 'stab_build',
          label: TECHNIQUE_LABEL.stab_build,
          deckEdits: { out: [{ kind: 'stabs', startSec: base.outCueSec + (B - 16) * beatA, beats: 16, beatSec: beatA, sourceSec: base.outCueSec, hitBeats: 0.25, intervals: [8, 4, 2, 1], duck: 0.15 }] },
          rationale: ['outgoing stab on the downbeat at 8 → 4 → 2 → 1-beat intervals over the last 4 bars'],
          confidence: a.bpmConf,
        }),
      )
      // beat juggle: the outgoing's last 2 bars alternate with a copy one bar back (A A B A | A B A B)
      out.push(
        based(base, {
          technique: 'beat_juggle',
          label: TECHNIQUE_LABEL.beat_juggle,
          deckEdits: { out: [{ kind: 'juggle', startSec: base.outCueSec + Math.max(0, B / 2 - 8) * beatA, beats: 8, beatSec: beatA, offsetBeats: 4, pattern: [0, 0, 1, 0, 0, 1, 0, 1] }] },
          rationale: ['two synchronized copies of the outgoing deck alternate on the beat before the handoff'],
          confidence: a.bpmConf,
        }),
      )
      // tone play: the outgoing's downbeat hit re-pitched along its key (minor-pentatonic steps)
      const scale = /m$|minor|A$/.test(a.camelot) ? [0, 3, 5, 7, 10, 7, 5, 3] : [0, 2, 4, 7, 9, 7, 4, 2]
      out.push(
        based(base, {
          technique: 'tone_play',
          label: TECHNIQUE_LABEL.tone_play,
          deckEdits: { out: [{ kind: 'tone', startSec: base.outCueSec + Math.max(0, B / 2 - 8) * beatA, beats: 8, beatSec: beatA, sourceSec: base.outCueSec, hitBeats: 0.5, semitones: scale, mix: 0.55 }] },
          rationale: [`hit re-pitched to ${a.camelot} scale steps on the beat`],
          confidence: Math.min(a.bpmConf, a.keyConf + 0.3),
        }),
      )
    }
  }
  for (const base of bases.filter((p) => p.style === 'echo_out' || p.style === 'unmatched_fade').slice(0, 1)) {
    const B = Math.max(4, base.overlapBars * 4)
    out.push(based(base, { technique: 'reverb_wash', label: TECHNIQUE_LABEL.reverb_wash, reverb: { send: lin([[0, 0], [B * 0.5, 0.6], [B, 1]]), decaySec: 3.5, wet: 0.5 }, rationale: ['outgoing washes into a long reverb tail as the incoming enters'], confidence: 1 }))
  }
  return out
}

/** Genre- and intent-adaptive preference for techniques and base styles (negative = preferred). */
export function genrePreference(style: string, technique: Technique | undefined, spec: ResolvedSpec): number {
  const g = spec.genres.join(' ').toLowerCase()
  const lively = spec.transitionStyle === 'creative' || spec.transitionStyle === 'energetic'
  let c = 0
  const is = (re: RegExp) => re.test(g)
  if (is(/tech house|house|melodic|deep/)) {
    if (style === 'long_blend' || style === 'bass_swap' || style === 'percussion_led') c -= 0.3
    if (technique === 'acapella_layer' || technique === 'mashup_swap') c -= 0.4
  }
  if (is(/edm|festival|big room|electro|dubstep|future/)) {
    if (style === 'drop_swap' || technique === 'double_drop') c -= 0.5
    if (technique === 'stab_build' || style === 'loop_roll') c -= 0.3
  }
  if (is(/techno/)) {
    if (style === 'long_blend' || style === 'filter_sweep') c -= 0.4
    if (technique === 'stab_build' || technique === 'spinback') c += 0.6
  }
  if (is(/hip ?hop|rap|trap/)) {
    if (style === 'cut' || style === 'scratch_cut' || technique === 'beat_juggle' || technique === 'spinback') c -= 0.6
    if (style === 'long_blend') c += 0.5
  }
  if (is(/drum and bass|dnb/)) {
    if (technique === 'double_drop') c -= 0.7
    if (style === 'short_fade' || style === 'bass_swap') c -= 0.3
  }
  // A creative brief asks for techniques; an energetic one tolerates them; otherwise the simpler
  // transition must win unless a technique is clearly better (DJCritic still guards every choice).
  const s = spec.transitionStyle
  if (technique) c += s === 'creative' ? -0.4 : s === 'energetic' ? 0 : s === 'smooth_creative' ? 0.3 : 1.2
  if (technique === 'beat_juggle' || technique === 'tone_play') c += s === 'creative' ? 0.2 : lively ? 0.5 : 1.5
  if (technique === 'spinback') c += s === 'creative' ? 0 : 1.0
  return c
}

/** Default technique automation helper for tests and alternates (base template of a style). */
export function baseTemplate(style: TransitionPlan['style'], beats: number) {
  return automationFor(style, beats)
}
