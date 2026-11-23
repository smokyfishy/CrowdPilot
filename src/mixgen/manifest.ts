/**
 * Mix manifest: the single source of truth the player, tracklist and transition inspector
 * read. Every timestamp and curve comes from the renderer's actual output (RenderResult)
 * and the executed TransitionPlans — nothing is re-derived or decorative.
 */
import { summarize } from '../dsp/analyze'
import { STYLE_LABEL, type CurvePoint, type TransitionStyle } from '../dj/transitions'
import type { MixPlan } from './mixplan'
import type { RenderResult } from './mix-render'
import type { AnalyzedEntry } from './pipeline'
import type { ResolvedSpec } from './spec'
import type { Unavailability } from './types'
import type { ValidationReport } from './validate'
import type { MlTrace, ScoredPlan } from './ml'
import type { TechniquePlan } from './techniques'
import { buildPerformance, type PerformanceManifest } from './performance'

export const MANIFEST_VERSION = 1

export interface ManifestCurve {
  /** Seconds relative to the transition start. */
  t: number[]
  v: number[]
}

export interface ManifestTrack {
  index: number
  key: string
  source: string
  title: string
  artist: string
  url?: string
  thumbnailUrl?: string
  license: { label: string; url?: string }
  accessReason: string
  bpm: number
  bpmConfidence: number
  gridSource: string
  key_: string
  camelot: string
  keyConfidence: number
  durationSec: number
  entrySec: number
  exitSec: number
  mixInSec: number
  mixMainSec: number
  mixOutSec: number
  trimDb: number
  lufs: number
  energy: number
  drops: number[]
  transitionOut?: string
}

export interface ManifestTransition {
  index: number
  fromKey: string
  toKey: string
  fromTitle: string
  toTitle: string
  style: TransitionStyle
  /** Advanced technique executed on top of the base style (rule-selected; see techniques.ts). */
  technique?: { name: string; rationale: string[]; confidence: number }
  label: string
  mixStartSec: number
  mixEndSec: number
  overlapBars: number
  overlapSec: number
  outCueSec: number
  inCueSec: number
  incomingDropSec?: number
  mixDropSec?: number
  tempoRatio: number
  tempoAdjustPct: number
  tempoRecoverySec: number
  beatSec: number
  beatAlignment: { spliceLagMs: number; spliceCorrelation: number; outDownbeatConf: number; inDownbeatConf: number; outBpmConf: number; inBpmConf: number }
  curves: {
    out: { gain: ManifestCurve; low: ManifestCurve; mid: ManifestCurve; high: ManifestCurve; filter?: ManifestCurve }
    in: { gain: ManifestCurve; low: ManifestCurve; mid: ManifestCurve; high: ManifestCurve; filter?: ManifestCurve }
    echoSend?: ManifestCurve
    stems?: { outVocals: ManifestCurve; outInst: ManifestCurve; inVocals: ManifestCurve; inInst: ManifestCurve }
    reverbSend?: ManifestCurve
  }
  effects: Array<{ kind: string; startSec: number; endSec: number; detail: string }>
  reasons: string[]
  risks: string[]
  cost: number
  /** Who controlled this transition's automation, and MixGraph's predicted severity (lower = better). */
  control?: { automation: 'transitionnet' | 'rules'; mixgraphSeverity?: number }
}

export interface MixManifest {
  version: number
  /** 'research' = local-only research render (YouTube audio, not for distribution). */
  mode?: 'standard' | 'research'
  title: string
  description: string
  createdAt: string
  durationSec: number
  targetDurationSec: number
  sampleRate: number
  genres: string[]
  bpmRange: [number, number]
  spec: ResolvedSpec
  permissions: { persistRender: boolean; export: boolean; reason: string }
  tracks: ManifestTrack[]
  transitions: ManifestTransition[]
  /** Waveform of the rendered audio: min/max per bucket, quantized to −127..127. */
  waveform: { secPerBucket: number; min: number[]; max: number[] }
  energy: { secPerPoint: number; rmsDb: number[]; bassDb: number[] }
  metrics: {
    integratedLufs: number
    samplePeakDb: number
    clippedSamples: number
    silences: Array<{ startSec: number; durationSec: number }>
    maxLevelJumpDb: number
    masterLimiterMaxReductionDb: number
  }
  acquisition: Array<{ trackKey: string; title: string; artist: string; source: string; status: string; reason: string }>
  unavailable: Unavailability[]
  attribution: string[]
  planNotes: string[]
  validation?: ValidationReport
  /** Time-stamped two-deck performance (executed automation + renderer telemetry) replayed by the Listen page's controller. */
  performance?: PerformanceManifest
  /** Learned-DJ inference trace (models, inputs, predictions, decisions, DSP params, fallbacks). */
  ml?: Omit<MlTrace, 'options'> & { options?: MlTrace['options'] }
}

function curveSec(c: CurvePoint[] | undefined, beatSec: number): ManifestCurve | undefined {
  if (!c?.length) return undefined
  // thin dense curves (every 1/4 beat) to ≤ 64 points for display
  const step = Math.max(1, Math.ceil(c.length / 64))
  const pts = c.filter((_, i) => i % step === 0 || i === c.length - 1)
  return { t: pts.map((p) => Math.round(p.beat * beatSec * 1000) / 1000), v: pts.map((p) => Math.round(p.value * 1000) / 1000) }
}

function downsampleWave(w: { secPerBucket: number; min: number[]; max: number[] }, maxBuckets = 12000) {
  const f = Math.max(1, Math.ceil(w.min.length / maxBuckets))
  const min: number[] = []
  const max: number[] = []
  for (let i = 0; i < w.min.length; i += f) {
    let lo = 1
    let hi = -1
    for (let k = i; k < Math.min(w.min.length, i + f); k++) {
      lo = Math.min(lo, w.min[k])
      hi = Math.max(hi, w.max[k])
    }
    min.push(Math.round(Math.max(-1, lo) * 127))
    max.push(Math.round(Math.min(1, hi) * 127))
  }
  return { secPerBucket: w.secPerBucket * f, min, max }
}

export function buildManifest(input: {
  spec: ResolvedSpec
  plan: MixPlan
  render: RenderResult
  analyses: Map<string, AnalyzedEntry>
  order: string[]
  unavailable: Unavailability[]
  permissions: { persistRender: boolean; export: boolean; reason: string }
  acquisition: MixManifest['acquisition']
  title?: string
}): MixManifest {
  const { spec, plan, render, analyses, order } = input
  const scoresByKey = new Map<string, number>()
  const tracks: ManifestTrack[] = order.map((key, i) => {
    const e = analyses.get(key)!
    const s = summarize(e.analysis)
    const rt = render.tracks[i]
    const pt = plan.tracks[i]
    scoresByKey.set(key, i)
    return {
      index: i,
      key,
      source: e.candidate.source,
      title: e.candidate.title,
      artist: e.candidate.artist,
      url: e.candidate.url,
      thumbnailUrl: e.candidate.thumbnailUrl,
      license: { label: e.candidate.license.label, url: e.candidate.license.url },
      accessReason: e.access.reason,
      bpm: s.bpm,
      bpmConfidence: s.bpmConf,
      gridSource: s.gridSource ?? 'dsp',
      key_: s.key,
      camelot: s.camelot,
      keyConfidence: s.keyConf,
      durationSec: s.durationSec,
      entrySec: rt?.entrySec ?? pt.entrySec,
      exitSec: rt?.exitSec ?? pt.exitSec,
      mixInSec: rt?.mixInSec ?? pt.mixInSec,
      mixMainSec: rt?.mixMainSec ?? pt.mixMainSec,
      mixOutSec: rt?.mixOutSec ?? pt.mixOutSec,
      trimDb: pt.trimDb,
      lufs: Math.round(e.analysis.loudness.integratedLufs * 10) / 10,
      energy: Math.round(e.energy.onsetDensity * 100) / 100,
      drops: e.analysis.sections.filter((x) => x.kind === 'drop').map((x) => Math.round(x.startSec * 10) / 10),
      transitionOut: plan.transitions[i] ? STYLE_LABEL[plan.transitions[i].plan.style] : undefined,
    }
  })
  const transitions: ManifestTransition[] = plan.transitions.map((tt, i) => {
    const p = tt.plan
    const rt = render.transitions[i]
    const a = analyses.get(order[i])!
    const b = analyses.get(order[i + 1])!
    const sa = summarize(a.analysis)
    const sb = summarize(b.analysis)
    const effects: ManifestTransition['effects'] = []
    const t0 = rt?.mixStartSec ?? tt.mixStartSec
    const tech = (p as TechniquePlan).tech
    if (tech?.stems) effects.push({ kind: 'stems', startSec: t0, endSec: t0 + p.durationSec, detail: 'stem routing (vocals / instrumental) with gain automation' })
    for (const e of [...(tech?.deckEdits?.out ?? []), ...(tech?.deckEdits?.in ?? [])]) {
      const s0 = t0 + (e.startSec - (tech?.deckEdits?.out?.includes(e) ? p.outCueSec : p.inCueSec)) / (tech?.deckEdits?.out?.includes(e) ? 1 : p.tempoRatio)
      const detail = e.kind === 'stabs' ? `sample stabs at ${e.intervals.join('→')}-beat intervals` : e.kind === 'juggle' ? `beat juggle, pattern ${e.pattern.join('')} (copy ${e.offsetBeats} beats back)` : `tone play ${e.semitones.map((x) => (x >= 0 ? '+' : '') + x).join(' ')} semitones`
      effects.push({ kind: e.kind, startSec: s0, endSec: s0 + e.beats * e.beatSec, detail })
    }
    if (tech?.reverb) effects.push({ kind: 'reverb', startSec: t0, endSec: t0 + p.durationSec + tech.reverb.decaySec, detail: `reverb wash, decay ${tech.reverb.decaySec}s` })
    if (p.filter?.out || p.filter?.in) effects.push({ kind: 'filter', startSec: t0, endSec: t0 + p.durationSec, detail: 'bipolar DJ filter sweep' })
    if (p.echo) effects.push({ kind: 'echo', startSec: t0, endSec: t0 + p.durationSec + p.echo.delayBeats * p.beatSec * 6, detail: `echo ${p.echo.delayBeats} beat(s), feedback ${p.echo.feedback}` })
    if (p.outPerf) {
      for (const op of p.outPerf.ops) {
        const s0 = t0 + (p.outPerf.startBeat + op.atBeat) * p.beatSec
        const len = op.kind === 'roll' ? op.sizes.length * op.stepBeats : op.beats
        effects.push({ kind: op.kind, startSec: s0, endSec: s0 + len * p.beatSec, detail: op.kind === 'roll' ? `loop roll ${op.sizes.join('→')} beats` : op.kind })
      }
    }
    if (Math.abs(p.tempoRatio - 1) > 1e-4) effects.push({ kind: 'tempo', startSec: t0, endSec: t0 + p.durationSec + tt.recoverySec, detail: `incoming at ${((p.tempoRatio - 1) * 100).toFixed(2)}% (pitch preserved), recovers over ${tt.recoverySec.toFixed(1)} s` })
    return {
      index: i,
      fromKey: order[i],
      toKey: order[i + 1],
      fromTitle: `${a.candidate.artist} – ${a.candidate.title}`,
      toTitle: `${b.candidate.artist} – ${b.candidate.title}`,
      style: p.style,
      label: tech ? tech.label : STYLE_LABEL[p.style],
      technique: tech ? { name: tech.technique, rationale: tech.rationale, confidence: Math.round(tech.confidence * 100) / 100 } : undefined,
      mixStartSec: t0,
      mixEndSec: rt?.mixEndSec ?? tt.mixEndSec,
      overlapBars: p.overlapBars,
      overlapSec: Math.round(p.durationSec * 1000) / 1000,
      outCueSec: p.outCueSec,
      inCueSec: p.inCueSec,
      ...(p.incomingDropSec !== undefined ? { incomingDropSec: p.incomingDropSec, mixDropSec: t0 + (p.incomingDropOffsetSec ?? p.durationSec) } : {}),
      tempoRatio: Math.round(p.tempoRatio * 10000) / 10000,
      tempoAdjustPct: Math.round((p.tempoRatio - 1) * 10000) / 100,
      tempoRecoverySec: Math.round(tt.recoverySec * 10) / 10,
      beatSec: p.beatSec,
      beatAlignment: {
        spliceLagMs: Math.round((rt?.spliceLagMs ?? 0) * 100) / 100,
        spliceCorrelation: rt?.spliceCorrelation ?? 0,
        outDownbeatConf: sa.downbeatConf,
        inDownbeatConf: sb.downbeatConf,
        outBpmConf: sa.bpmConf,
        inBpmConf: sb.bpmConf,
      },
      curves: {
        out: { gain: curveSec(p.out.gain, p.beatSec)!, low: curveSec(p.out.low, p.beatSec)!, mid: curveSec(p.out.mid, p.beatSec)!, high: curveSec(p.out.high, p.beatSec)!, filter: curveSec(p.filter?.out, p.beatSec) },
        in: { gain: curveSec(p.in.gain, p.beatSec)!, low: curveSec(p.in.low, p.beatSec)!, mid: curveSec(p.in.mid, p.beatSec)!, high: curveSec(p.in.high, p.beatSec)!, filter: curveSec(p.filter?.in, p.beatSec) },
        echoSend: curveSec(p.echo?.send, p.beatSec),
        stems: tech?.stems ? { outVocals: curveSec(tech.stems.out.vocals, p.beatSec)!, outInst: curveSec(tech.stems.out.inst, p.beatSec)!, inVocals: curveSec(tech.stems.in.vocals, p.beatSec)!, inInst: curveSec(tech.stems.in.inst, p.beatSec)! } : undefined,
        reverbSend: curveSec(tech?.reverb?.send, p.beatSec),
      },
      effects,
      reasons: p.reasons,
      risks: p.risks,
      cost: Math.round(p.costs.total * 100) / 100,
      control: { automation: (p as ScoredPlan).mlSource === 'transitionnet' ? 'transitionnet' : 'rules', mixgraphSeverity: (p as ScoredPlan).mlSeverity !== undefined ? Math.round((p as ScoredPlan).mlSeverity! * 10000) / 10000 : undefined },
    }
  })
  const performance = render.telemetry
    ? buildPerformance({
        plans: plan.transitions.map((t) => t.plan),
        transitionStarts: transitions.map((t) => t.mixStartSec),
        labels: transitions.map((t) => t.label),
        automation: transitions.map((t) => t.control?.automation),
        telemetry: render.telemetry,
        durationSec: render.metrics.durationSec,
        tracks: order.map((key, i) => {
          const s = summarize(analyses.get(key)!.analysis)
          const t = tracks[i]
          return {
            key,
            title: t.title,
            artist: t.artist,
            artworkUrl: t.thumbnailUrl,
            bpm: t.bpm,
            musicalKey: t.key_,
            camelot: t.camelot,
            durationSec: t.durationSec,
            trimDb: t.trimDb,
            entrySec: plan.tracks[i].entrySec,
            drops: t.drops,
            grid: s.bpm > 0 && Number.isFinite(s.firstBeat) ? { firstBeatSec: s.firstBeat, beatSec: 60 / s.bpm, downbeatPhase: s.downbeatPhase } : undefined,
          }
        }),
      })
    : undefined
  const bpms = tracks.map((t) => t.bpm).filter((b) => b > 0)
  const m = render.metrics
  const styles = [...new Set(transitions.map((t) => t.label.toLowerCase()))]
  const description = `${tracks.length} tracks, ${Math.round(m.durationSec / 60)} minutes, ${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))} BPM. Energy profile: ${spec.energyCurve.replace(/_/g, ' ')}. Transitions: ${styles.slice(0, 5).join(', ')}.`
  return {
    version: MANIFEST_VERSION,
    title: input.title ?? spec.title,
    description,
    createdAt: new Date().toISOString(),
    durationSec: Math.round(m.durationSec * 100) / 100,
    targetDurationSec: spec.targetDurationSec,
    sampleRate: render.rate,
    genres: spec.genres,
    bpmRange: [Math.round(Math.min(...bpms) * 10) / 10, Math.round(Math.max(...bpms) * 10) / 10],
    spec,
    permissions: input.permissions,
    tracks,
    transitions,
    waveform: downsampleWave(m.waveform),
    energy: m.energy,
    metrics: {
      integratedLufs: m.integratedLufs,
      samplePeakDb: m.samplePeakDb,
      clippedSamples: m.clippedSamples,
      silences: m.silences,
      maxLevelJumpDb: m.maxLevelJumpDb,
      masterLimiterMaxReductionDb: render.masterLimiterMaxReductionDb,
    },
    acquisition: input.acquisition,
    unavailable: input.unavailable,
    attribution: tracks.map((t) => `"${t.title}" by ${t.artist} — ${t.license.label}${t.license.url ? ` (${t.license.url})` : ''}${t.url ? ` — ${t.url}` : ''}`),
    planNotes: plan.notes,
    ...(performance ? { performance } : {}),
  }
}
