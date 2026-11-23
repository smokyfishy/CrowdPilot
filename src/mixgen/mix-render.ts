/**
 * Offline full-set renderer: produces ONE continuous stereo performance from a MixPlan.
 *
 * Structure of the output stream:   body₀ │ T₀ │ body₁ │ T₁ │ … │ body_{n−1}
 *  - Transitions Tᵢ are rendered by the same `renderTransition` that the live engine's
 *    plans are verified with (isolator EQ, fader curves, WSOLA tempo match + recovery,
 *    filter knob, echo send, loop roll / brake / scratch performance segments).
 *  - Bodies are the original PCM with the track's loudness trim.
 *  - Splices are sample-aligned: the outgoing side is exact (outgoing audio is never
 *    stretched); the incoming side is located by the closed-form WSOLA position plus a
 *    ±25 ms normalized cross-correlation refinement, then crossfaded over 25 ms.
 *  - Everything streams through a look-ahead master limiter and the MixAnalyzer, so memory
 *    stays at ~2 decoded tracks regardless of set length.
 *
 * The renderer returns a manifest of what it ACTUALLY did (emitted sample positions,
 * splice lags, per-transition limiter reduction), which the player and inspector use.
 */
import { renderTransition } from '../dj/render'
import { BEATMATCHED, type TransitionPlan } from '../dj/transitions'
import { MasterLimiter, MixAnalyzer, type MixMetrics } from './meter'
import { applyDeckEdits, reverb, routeStems, type TechniquePlan } from './techniques'
import { curveAt } from '../dj/automation'

import type { MixPlan } from './mixplan'
import { deckOf, incomingPosAt, LevelRecorder, trackPeaks, type DeckId, type RenderTelemetry } from './performance'

export interface PcmTrack {
  channels: Float32Array[]
  rate: number
}

export interface TrackLoader {
  load(key: string): Promise<PcmTrack>
  release?(key: string): void
  /** Vocal / instrumental stems at the mix rate (local worker with a separation model), or null. */
  loadStems?(key: string): Promise<{ vocals: Float32Array[]; inst: Float32Array[] } | null>
}

export interface AudioSink {
  write(block: Float32Array[]): Promise<void> | void
}

export interface RenderedTransition {
  index: number
  fromKey: string
  toKey: string
  /** Actual mix-time (s) where the transition's automation starts and ends. */
  mixStartSec: number
  mixEndSec: number
  /** Splice refinement (ms) applied at the incoming side. */
  spliceLagMs: number
  spliceCorrelation: number
  peak: number
  limiterReductionDb: number
}

export interface RenderedTrack {
  key: string
  /** Actual mix-time (s) where its audio begins / ends and where it becomes the main track. */
  mixInSec: number
  mixMainSec: number
  mixOutSec: number
  entrySec: number
  exitSec: number
}

export interface RenderResult {
  rate: number
  channels: number
  tracks: RenderedTrack[]
  transitions: RenderedTransition[]
  metrics: MixMetrics
  masterLimiterMaxReductionDb: number
  /** What the renderer actually did, for the Listen page's DJ controller (levels, deck peaks, splices). */
  telemetry?: RenderTelemetry
}

export interface RenderProgress {
  (done: number, total: number, detail: string): void
}

const PRE = 1.0 // s of outgoing pre-roll inside each transition render (filter warm-up)
const SPLICE_IN = 0.5 // s into the render where the body→render crossfade happens
const XF = 0.025 // s crossfade length
const SEARCH = 0.025 // s correlation search radius at the incoming splice
const TAIL_PAD = 2.0 // s after overlap/recovery the render continues before splicing back

/** The renderer's incoming position law lives in performance.ts so the Listen controller replays the same function. */
export { incomingPosAt }

function mono(ch: Float32Array[], from: number, len: number): Float32Array {
  const out = new Float32Array(len)
  for (const c of ch) for (let i = 0; i < len; i++) out[i] += (c[from + i] ?? 0) / ch.length
  return out
}

/** Best lag (samples) of `src` around `center` matching `ref`, by normalized cross-correlation. */
export function alignLag(ref: Float32Array, src: Float32Array[], center: number, radius: number): { lag: number; corr: number } {
  const len = ref.length
  const seg = mono(src, Math.max(0, center - radius), len + 2 * radius)
  const offset = center - radius < 0 ? center - radius : 0
  let refE = 0
  for (let i = 0; i < len; i++) refE += ref[i] * ref[i]
  let best = { lag: 0, corr: -2 }
  for (let lag = -radius; lag <= radius; lag += 1) {
    const s0 = lag + radius + offset
    if (s0 < 0 || s0 + len > seg.length) continue
    let dot = 0
    let e = 0
    for (let i = 0; i < len; i += 2) {
      const v = seg[s0 + i]
      dot += ref[i] * v
      e += v * v
    }
    const corr = dot / Math.sqrt((refE / 2) * e + 1e-12)
    if (corr > best.corr) best = { lag, corr }
  }
  return best
}

export async function renderMix(plan: MixPlan, loader: TrackLoader, sink: AudioSink, onProgress?: RenderProgress): Promise<RenderResult> {
  const n = plan.tracks.length
  if (!n) throw new Error('empty plan')
  const first = await loader.load(plan.tracks[0].key)
  const rate = first.rate
  const nch = 2
  const limiter = new MasterLimiter(nch, rate)
  const analyzer = new MixAnalyzer(nch, rate)
  let emitted = 0 // samples written into the limiter (pre-latency)
  let written = 0 // samples written to the sink (= the audio file timeline)
  const levels = new LevelRecorder(rate)
  const peaks: RenderTelemetry['peaks'] = { secPerBucket: 0.05, tracks: {} }
  const splices: RenderTelemetry['splices'] = []
  const notePeaks = (key: string, t: PcmTrack) => {
    if (!peaks.tracks[key]) peaks.tracks[key] = trackPeaks(t.channels, t.rate)
  }
  notePeaks(plan.tracks[0].key, first)
  /** Deck whose signal the next emitted body samples belong to (null = transition render; its stems are metered instead). */
  let lane: DeckId | null = deckOf(0)
  const BLOCK = 8192
  const emit = async (block: Float32Array[]) => {
    for (let o = 0; o < block[0].length; o += BLOCK) {
      const chunk = block.map((c) => c.slice(o, Math.min(c.length, o + BLOCK)))
      if (lane) levels.add(lane, emitted, chunk)
      emitted += chunk[0].length
      limiter.process(chunk)
      levels.add('master', written, chunk)
      written += chunk[0].length
      // drop the limiter's initial latency so mix time 0 = first audio sample
      analyzer.push(chunk)
      await sink.write(chunk)
    }
  }
  const stereo = (t: PcmTrack): Float32Array[] => (t.channels.length >= 2 ? t.channels.slice(0, 2) : [t.channels[0], t.channels[0]])
  const gain = (db: number) => 10 ** (db / 20)

  /** Emit `len` samples of track `t` from sample `from` with linear gain `g`, plus optional crossfade into `xfTo`. */
  const emitBody = async (t: PcmTrack, from: number, to: number, g: number) => {
    const ch = stereo(t)
    for (let s = Math.max(0, from); s < to; s += 65536) {
      const e = Math.min(to, s + 65536)
      await emit(ch.map((c) => {
        const out = new Float32Array(e - s)
        for (let i = 0; i < out.length; i++) out[i] = (c[s + i] ?? 0) * g
        return out
      }))
    }
  }

  const renderedTracks: RenderedTrack[] = []
  const renderedTransitions: RenderedTransition[] = []
  const tracks: PcmTrack[] = [first]
  const xf = Math.round(XF * rate)
  // `cursor`: next sample of the current track to emit (track-time samples).
  let cur = first
  let cursor = Math.round(plan.tracks[0].entrySec * rate)
  let pendingXf: Float32Array[] | null = null // last xf samples of a render, to crossfade into the next body
  let mixMain = 0
  let mixIn = 0
  for (let i = 0; i < n; i++) {
    const tl = plan.tracks[i]
    const g = gain(tl.trimDb)
    const tr = plan.transitions[i]
    onProgress?.(i, n, `track ${i + 1}/${n}`)
    lane = deckOf(i)
    if (!tr) {
      // Last track: body to its musical end with a gentle 1.5 s fade (no truncated tail).
      const end = Math.min(cur.channels[0].length, Math.round(tl.exitSec * rate))
      if (pendingXf) {
        await emit(crossfadeInto(pendingXf, stereo(cur), cursor, xf, g))
        cursor += xf
        pendingXf = null
      }
      const fadeLen = Math.round(1.5 * rate)
      await emitBody(cur, cursor, end - fadeLen, g)
      const ch = stereo(cur)
      await emit(ch.map((c) => {
        const out = new Float32Array(Math.max(0, fadeLen))
        for (let k = 0; k < out.length; k++) out[k] = (c[end - fadeLen + k] ?? 0) * g * Math.cos((Math.PI / 2) * (k / fadeLen))
        return out
      }))
      renderedTracks.push({ key: tl.key, mixInSec: mixIn, mixMainSec: mixMain, mixOutSec: emitted / rate, entrySec: tl.entrySec, exitSec: tl.exitSec })
      break
    }
    // Load the incoming track (keep at most two decoded).
    const next = await loader.load(plan.tracks[i + 1].key)
    notePeaks(plan.tracks[i + 1].key, next)
    tracks[i + 1] = next
    const nextTl = plan.tracks[i + 1]
    const p = tr.plan
    // Render the transition with pre-roll and enough post-roll to finish the tempo recovery.
    const recSec = BEATMATCHED.has(p.style) && Math.abs(p.tempoRatio - 1) > 1e-4 ? p.tempoRecoveryBars * 4 * p.beatSec : 0
    const post = recSec + TAIL_PAD
    // Technique controls (stems, deck edits, reverb) are executed here, around renderTransition.
    const tech = (p as TechniquePlan).tech
    let outDeck = stereo(cur)
    let inDeck = stereo(next)
    let stemsApplied = false
    if (tech?.stems && loader.loadStems) {
      const [so, si] = await Promise.all([loader.loadStems(tl.key), loader.loadStems(nextTl.key)])
      if (so && si) {
        const span = p.durationSec
        outDeck = routeStems(outDeck, so, rate, p.outCueSec - 0.1, p.outCueSec + span + 0.1, (t) => (t - p.outCueSec) / p.beatSec, tech.stems.out)
        inDeck = routeStems(inDeck, si, rate, p.inCueSec - 0.1, p.inCueSec + span * p.tempoRatio + 0.1, (t) => (t - p.inCueSec) / (p.beatSec * p.tempoRatio), tech.stems.in)
        stemsApplied = true
      }
    }
    if (tech?.deckEdits?.out?.length) outDeck = applyDeckEdits(outDeck, rate, tech.deckEdits.out)
    if (tech?.deckEdits?.in?.length) inDeck = applyDeckEdits(inDeck, rate, tech.deckEdits.in)
    const r = renderTransition({
      rate,
      out: outDeck,
      in: inDeck,
      plan: p,
      preRollSec: PRE,
      postRollSec: post,
      outTrimDb: tl.trimDb,
      inTrimDb: nextTl.trimDb,
      // per-deck post-fader signals: the reverb send taps deck A, and the controller's channel meters read both
      stems: true,
    })
    const rch = r.channels.length >= 2 ? r.channels : [r.channels[0], r.channels[0]]
    if (tech?.reverb && r.stemA) {
      // post-fader reverb send on the outgoing deck: its tail keeps ringing after the fader closes
      const send = new Float32Array(r.stemA.length)
      for (let k = 0; k < send.length; k++) {
        const beat = (k - r.transitionStartSample) / rate / p.beatSec
        send[k] = r.stemA[k] * (beat < 0 ? 0 : curveAt(tech.reverb.send, beat))
      }
      const wet = reverb(send, rate, tech.reverb.decaySec)
      for (const ch of rch) for (let k = 0; k < ch.length; k++) ch[k] += wet[k] * tech.reverb.wet
      for (let k = 0; k < r.stemA.length; k++) r.stemA[k] += wet[k] * tech.reverb.wet // the wash belongs to the outgoing channel
    }
    const renderStartTrack = Math.round(p.outCueSec * rate) - r.transitionStartSample // outgoing sample at render offset 0
    // 1) body of the current track up to the splice-in point (+ crossfade into the render)
    const spliceIn = Math.round(SPLICE_IN * rate)
    if (pendingXf) {
      await emit(crossfadeInto(pendingXf, stereo(cur), cursor, xf, g))
      cursor += xf
      pendingXf = null
    }
    await emitBody(cur, cursor, renderStartTrack + spliceIn, g)
    // crossfade body → render over xf samples
    const bodyTail = stereo(cur).map((c) => {
      const out = new Float32Array(xf)
      for (let k = 0; k < xf; k++) out[k] = (c[renderStartTrack + spliceIn + k] ?? 0) * g
      return out
    })
    await emit(bodyTail.map((b, c) => {
      const out = new Float32Array(xf)
      for (let k = 0; k < xf; k++) {
        const w = k / xf
        out[k] = b[k] * (1 - w) + rch[c][spliceIn + k] * w
      }
      return out
    }))
    const tStartEmitted = emitted + (r.transitionStartSample - spliceIn - xf)
    // 2) the render itself, minus the final xf samples (kept for the crossfade into the next body)
    const renderEnd = rch[0].length - xf
    lane = null
    if (r.stemA && r.stemB) {
      levels.addMono(deckOf(i), emitted, r.stemA, spliceIn + xf, renderEnd - spliceIn - xf)
      levels.addMono(deckOf(i + 1), emitted, r.stemB, spliceIn + xf, renderEnd - spliceIn - xf)
    }
    await emit(rch.map((c) => c.slice(spliceIn + xf, renderEnd)))
    // 3) locate the incoming position at the render's end and refine by correlation
    const jSec = (renderEnd - r.transitionStartSample) / rate
    const est = Math.round(incomingPosAt(p, jSec) * rate)
    const refLen = Math.min(4096, renderEnd)
    const ref = mono(rch, renderEnd - refLen, refLen)
    const nextG = gain(nextTl.trimDb)
    for (let k = 0; k < ref.length; k++) ref[k] /= nextG || 1
    let { lag, corr } = alignLag(ref, stereo(next), est - refLen, Math.round(SEARCH * rate))
    if (corr < 0.6) {
      // WSOLA position can drift further after a long tempo-recovery ramp: widen the search
      // (±80 ms) with a longer reference before accepting a weak match.
      const refLen2 = Math.min(16384, renderEnd)
      const ref2 = mono(rch, renderEnd - refLen2, refLen2)
      for (let k = 0; k < ref2.length; k++) ref2[k] /= nextG || 1
      const wide = alignLag(ref2, stereo(next), est - refLen2, Math.round(0.08 * rate))
      if (wide.corr > corr) ({ lag, corr } = wide)
    }
    const nextCursor = est + lag
    pendingXf = rch.map((c) => c.slice(renderEnd, renderEnd + xf))
    const mixStart = tStartEmitted / rate
    splices.push({ spliceSec: jSec, spliceLagSec: lag / rate, stemsApplied, reverbApplied: !!(tech?.reverb && r.stemA), deckEditsApplied: !!(tech?.deckEdits?.out?.length || tech?.deckEdits?.in?.length) })
    renderedTransitions.push({
      index: i,
      fromKey: tl.key,
      toKey: nextTl.key,
      mixStartSec: mixStart,
      mixEndSec: mixStart + p.durationSec,
      spliceLagMs: (lag / rate) * 1000,
      spliceCorrelation: Math.round(corr * 1000) / 1000,
      peak: r.peak,
      limiterReductionDb: r.limiterGainReductionDb,
    })
    renderedTracks.push({ key: tl.key, mixInSec: mixIn, mixMainSec: mixMain, mixOutSec: mixStart + p.durationSec, entrySec: tl.entrySec, exitSec: p.outCueSec + p.durationSec })
    mixIn = mixStart
    mixMain = mixStart + p.durationSec
    loader.release?.(tl.key)
    tracks[i] = undefined as unknown as PcmTrack
    cur = next
    cursor = nextCursor
  }
  // drain limiter latency; drop nothing (latency is constant, timestamps refer to limiter input)
  const tail = limiter.flush()
  levels.add('master', written, tail)
  written += tail[0]?.length ?? 0
  analyzer.push(tail)
  await sink.write(tail)
  onProgress?.(n, n, 'rendered')
  const metrics = analyzer.finish()
  // Shift reported mix times by the limiter latency (output is delayed by it).
  const lat = limiter.latency / rate
  for (const t of renderedTracks) {
    t.mixInSec += t.mixInSec > 0 ? lat : 0
    t.mixMainSec += t.mixMainSec > 0 ? lat : 0
    t.mixOutSec += lat
  }
  for (const t of renderedTransitions) {
    t.mixStartSec += lat
    t.mixEndSec += lat
  }
  const telemetry: RenderTelemetry = { latencySec: lat, levels: levels.finish(written, limiter.latency), peaks, splices }
  return { rate, channels: nch, tracks: renderedTracks, transitions: renderedTransitions, metrics, masterLimiterMaxReductionDb: Math.round(-20 * Math.log10(limiter.minGain) * 100) / 100, telemetry }
}

/** Crossfade the saved render tail into the raw body of `track` starting at `from`. */
function crossfadeInto(tail: Float32Array[], track: Float32Array[], from: number, xf: number, g: number): Float32Array[] {
  return tail.map((t, c) => {
    const out = new Float32Array(xf)
    const src = track[c]
    for (let k = 0; k < xf; k++) {
      const w = k / xf
      out[k] = t[k] * (1 - w) + (src[from + k] ?? 0) * g * w
    }
    return out
  })
}
