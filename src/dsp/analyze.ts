/**
 * Full-track analysis orchestrator. Input: decoded PCM (any rate, 1–2 channels)
 * of an authorized source. Output: measured features with confidence flags,
 * algorithm version and the analysis sample rate. No field is ever filled from
 * provider metadata: provider BPM/key, if shown, is labelled separately.
 */
import { frameFeatures, normalizeOnset } from './features'
import { keyFromChroma, meanChroma, type KeyEstimate } from './key'
import { measureLoudness, type LoudnessReport } from './loudness'
import { resample, toMono } from './resample'
import { barFeatures, cueCandidates, noveltyCurve, phraseBoundaries, sections, type Bar, type CueCandidate, type PhraseBoundary, type Section } from './structure'
import { estimateDownbeat, estimateGrid, type BeatGrid } from './tempo'
import { gridFromBeats } from './beatnet'

export const ANALYZER_VERSION = 'cp-dsp-1.0.0'
export const ANALYSIS_RATE = 22050

export interface QcReport {
  durationSec: number
  silentLeadSec: number
  silentTailSec: number
  clippedSamples: number
  clippingRatio: number
  mostlySilent: boolean
  issues: string[]
}

export interface TrackAnalysis {
  version: string
  analysisRate: number
  sourceRate: number
  channels: number
  qc: QcReport
  grid: BeatGrid
  key: KeyEstimate
  localKeys: Array<{ startSec: number; key: KeyEstimate }>
  loudness: LoudnessReport
  bars: Bar[]
  barSec: number
  phrases: PhraseBoundary[]
  sections: Section[]
  cues: CueCandidate[]
  /** Per-bar energy (dB) for energy trajectory planning. */
  energyCurve: number[]
  /** Waveform overview: per column [peak, low share, mid share, high share]. */
  overview: { columns: number; secPerColumn: number; peak: Float32Array; low: Float32Array; mid: Float32Array; high: Float32Array }
  flags: string[]
  timings: Record<string, number>
  /** Network beat/downbeat times (host-local only; used for local grid refinement at commit). */
  netBeats?: number[]
  netDownbeats?: number[]
}

export interface AnalyzeInput {
  channels: Float32Array[]
  sampleRate: number
  /** Optional pre-resampled mono analysis copy (e.g. from OfflineAudioContext). */
  analysisMono?: Float32Array
  overviewColumns?: number
  now?: () => number
  /** Beat This! network beats/downbeats (seconds). When present they define the grid. */
  net?: { beats: number[]; downbeats: number[] }
}

export function qcReport(channels: Float32Array[], rate: number): QcReport {
  const n = channels[0]?.length ?? 0
  const thr = 10 ** (-60 / 20)
  let lead = 0
  outerLead: for (; lead < n; lead++) for (const ch of channels) if (Math.abs(ch[lead]) > thr) break outerLead
  let tail = n - 1
  outerTail: for (; tail > lead; tail--) for (const ch of channels) if (Math.abs(ch[tail]) > thr) break outerTail
  let clipped = 0
  for (const ch of channels) for (let i = 0; i < n; i++) if (Math.abs(ch[i]) >= 0.999) clipped++
  const issues: string[] = []
  const durationSec = n / rate
  const mostlySilent = tail - lead < rate * 5
  if (durationSec < 30) issues.push('shorter than 30 s')
  if (mostlySilent) issues.push('mostly silent')
  const clippingRatio = clipped / Math.max(1, n * channels.length)
  if (clippingRatio > 1e-4) issues.push('audible clipping likely')
  return { durationSec, silentLeadSec: lead / rate, silentTailSec: (n - 1 - tail) / rate, clippedSamples: clipped, clippingRatio, mostlySilent, issues }
}

export function analyzeTrack(input: AnalyzeInput): TrackAnalysis {
  const now = input.now ?? (() => Date.now())
  const timings: Record<string, number> = {}
  let t0 = now()
  const mark = (k: string) => {
    const t = now()
    timings[k] = t - t0
    t0 = t
  }
  const { channels, sampleRate } = input
  const qc = qcReport(channels, sampleRate)
  const mono = input.analysisMono ?? resample(toMono(channels), sampleRate, ANALYSIS_RATE)
  mark('resample')
  const feats = frameFeatures(mono, ANALYSIS_RATE)
  mark('stft')
  const frameSec = feats.hop / ANALYSIS_RATE
  const fps = 1 / frameSec
  const onset = normalizeOnset(feats.onset)
  const onsetLow = normalizeOnset(feats.onsetLow)
  const onsetHigh = normalizeOnset(feats.onsetHigh)
  const durationSec = mono.length / ANALYSIS_RATE
  const { halfBeatResolved, ...g } = estimateGrid(onset, fps, durationSec, frameSec, onsetLow, onsetHigh)
  const db = g.bpm > 0 ? estimateDownbeat(g, frameSec, { ...feats, onsetLow }) : { phase: 0, confidence: 0 }
  let grid: BeatGrid = { ...g, downbeatPhase: db.phase, downbeatConfidence: db.confidence, source: 'dsp' }
  const ng = input.net ? gridFromBeats(input.net.beats, input.net.downbeats, durationSec) : null
  if (ng) {
    grid = {
      ...grid,
      bpm: ng.bpm,
      periodSec: ng.periodSec,
      firstBeatSec: ng.firstBeatSec,
      beatCount: ng.beatCount,
      downbeatPhase: ng.downbeatPhase,
      confidence: Math.min(ng.tempoConfidence, ng.beatConfidence),
      downbeatConfidence: ng.downbeatConfidence,
      driftMs: ng.driftMs,
      stable: ng.stable,
      source: 'beatnet',
    }
  }
  mark('tempo')

  // Key: weight frames by tonality (1 - flatness) to downweight drums.
  const weights = new Float32Array(feats.frames)
  for (let f = 0; f < feats.frames; f++) weights[f] = Math.max(0, 1 - feats.flatnessMid[f]) * Math.sqrt(feats.mid[f] + feats.low[f])
  const key = keyFromChroma(meanChroma(feats.chroma, 0, feats.frames, weights))
  const localKeys: TrackAnalysis['localKeys'] = []
  const win = Math.round(30 / frameSec)
  for (let a = 0; a + win / 2 < feats.frames; a += win) {
    localKeys.push({ startSec: a * frameSec, key: keyFromChroma(meanChroma(feats.chroma, a, Math.min(feats.frames, a + win), weights)) })
  }
  mark('key')

  const loudness = measureLoudness(channels, sampleRate)
  mark('loudness')

  const flags: string[] = [...qc.issues]
  let bars: Bar[] = []
  let barSec = 0
  let phrases: PhraseBoundary[] = []
  let secs: Section[] = []
  let cues: CueCandidate[] = []
  if (grid.bpm > 0 && grid.confidence > 0.05) {
    const bf = barFeatures(feats, onset, grid)
    bars = bf.bars
    barSec = bf.barSec
    const nov = noveltyCurve(bars)
    phrases = phraseBoundaries(bars, nov)
    secs = sections(bars, barSec)
    cues = cueCandidates(bars, phrases, secs, barSec)
  } else {
    flags.push('no reliable beat grid')
  }
  if (grid.source === 'dsp' && grid.bpm > 0 && !halfBeatResolved) flags.push('beat vs off-beat phase ambiguous')
  if (!grid.stable) flags.push('tempo drifts — long beat-matched blends disabled')
  if (grid.confidence < 0.5) flags.push('low tempo confidence')
  if (grid.source === 'dsp') flags.push('beat grid from DSP fallback (no network beats)')
  if (grid.downbeatConfidence < 0.15) flags.push('downbeat uncertain')
  if (key.confidence < 0.2) flags.push('key uncertain')
  if (key.relativeAmbiguous) flags.push('relative major/minor ambiguous')
  mark('structure')

  const columns = input.overviewColumns ?? 1200
  const overview = waveformOverview(mono, ANALYSIS_RATE, columns, feats)
  mark('overview')

  return {
    version: ANALYZER_VERSION,
    analysisRate: ANALYSIS_RATE,
    sourceRate: sampleRate,
    channels: channels.length,
    qc,
    grid,
    key,
    localKeys,
    loudness,
    bars,
    barSec,
    phrases,
    sections: secs,
    cues,
    energyCurve: bars.map((b) => b.energy),
    overview,
    flags,
    timings,
    netBeats: input.net?.beats,
    netDownbeats: input.net?.downbeats,
  }
}

function waveformOverview(mono: Float32Array, rate: number, columns: number, feats: ReturnType<typeof frameFeatures>) {
  const per = Math.max(1, Math.floor(mono.length / columns))
  const cols = Math.ceil(mono.length / per)
  const peak = new Float32Array(cols)
  const low = new Float32Array(cols)
  const mid = new Float32Array(cols)
  const high = new Float32Array(cols)
  for (let c = 0; c < cols; c++) {
    let p = 0
    for (let i = c * per; i < Math.min(mono.length, (c + 1) * per); i++) p = Math.max(p, Math.abs(mono[i]))
    peak[c] = p
    const fa = Math.floor((c * per) / feats.hop)
    const fb = Math.max(fa + 1, Math.floor(((c + 1) * per) / feats.hop))
    let lo = 0
    let md = 0
    let hi = 0
    for (let f = fa; f < Math.min(fb, feats.frames); f++) {
      lo += feats.low[f]
      md += feats.mid[f]
      hi += feats.high[f]
    }
    const tot = lo + md + hi || 1
    low[c] = lo / tot
    mid[c] = md / tot
    high[c] = hi / tot
  }
  return { columns: cols, secPerColumn: per / rate, peak, low, mid, high }
}

/** Compact, JSON-safe summary that is small enough to sync through DeepSpace (< 4 KB). */
export interface AnalysisSummary {
  v: string
  bpm: number
  bpmConf: number
  /** 'beatnet' (Beat This! network) or 'dsp' (fallback). */
  gridSource?: 'beatnet' | 'dsp'
  firstBeat: number
  downbeatPhase: number
  downbeatConf: number
  stable: boolean
  key: string
  camelot: string
  keyConf: number
  lufs: number
  truePeak: number
  durationSec: number
  phrasesSec: number[]
  cueIn: number[]
  cueOut: number[]
  /** Bars of measured intro / outro (0 when no evidence). */
  introBars: number
  outroBars: number
  barSec: number
  /** Heuristic vocal likelihood in the first / last 32 bars (0..1, flagged heuristic). */
  vocalIn: number
  vocalOut: number
  /** Mean bar energy (dB) of first / last 16 bars and of the whole track. */
  energyIn: number
  energyOut: number
  energyMean: number
  /** Mean bar energy (dB) of the 8 bars starting at each phrase boundary (aligned with phrasesSec). */
  phraseEnergy?: number[]
  flags: string[]
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

export function summarize(a: TrackAnalysis): AnalysisSummary {
  return {
    v: a.version,
    bpm: Math.round(a.grid.bpm * 100) / 100,
    bpmConf: Math.round(a.grid.confidence * 100) / 100,
    gridSource: a.grid.source,
    firstBeat: r3(a.grid.firstBeatSec),
    downbeatPhase: a.grid.downbeatPhase,
    downbeatConf: Math.round(a.grid.downbeatConfidence * 100) / 100,
    stable: a.grid.stable,
    key: a.key.name,
    camelot: a.key.camelot,
    keyConf: Math.round(a.key.confidence * 100) / 100,
    lufs: Number.isFinite(a.loudness.integratedLufs) ? Math.round(a.loudness.integratedLufs * 10) / 10 : -99,
    truePeak: Math.round(a.loudness.truePeakDbtp * 10) / 10,
    durationSec: Math.round(a.qc.durationSec * 10) / 10,
    phrasesSec: a.phrases.slice(0, 48).map((p) => r3(p.sec)),
    cueIn: a.cues.filter((c) => c.kind === 'mix_in').slice(0, 4).map((c) => r3(c.sec)),
    cueOut: a.cues.filter((c) => c.kind === 'mix_out').slice(0, 4).map((c) => r3(c.sec)),
    introBars: sectionBars(a, 'intro'),
    outroBars: sectionBars(a, 'outro'),
    barSec: r3(a.barSec),
    vocalIn: r2(mean(a.bars.slice(0, 32).map((b) => b.vocalLikelihood))),
    vocalOut: r2(mean(a.bars.slice(-32).map((b) => b.vocalLikelihood))),
    energyIn: r2(mean(a.energyCurve.slice(0, 16))),
    energyOut: r2(mean(a.energyCurve.slice(-16))),
    energyMean: r2(mean(a.energyCurve)),
    phraseEnergy: a.phrases.slice(0, 48).map((p) => r2(mean(a.energyCurve.slice(p.bar, p.bar + 8)))),
    flags: a.flags.slice(0, 8),
  }
}

const r2 = (x: number) => Math.round(x * 100) / 100
const mean = (xs: number[]) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0)
function sectionBars(a: TrackAnalysis, kind: 'intro' | 'outro'): number {
  const s = kind === 'intro' ? a.sections[0] : a.sections[a.sections.length - 1]
  return s && s.kind === kind ? s.endBar - s.startBar : 0
}
