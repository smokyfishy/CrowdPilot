/**
 * Host-side AI DJ controller.
 *
 * - Implements PlaybackController for authorized waveform items (Audius/Jamendo, or a
 *   YouTube request whose verified mixable match is accepted), so Phase 1's
 *   HostPlaybackAgent keeps driving load/play/pause/ended exactly as before.
 * - Analyzes the current and next mixable tracks in a Web Worker and syncs compact
 *   summaries to DeepSpace (derived features only, never audio).
 * - Autopilot: plans the next transition with MixGraph, shows it as `proposed`, commits
 *   it inside the commit window, schedules it in the DjEngine on the audio clock, and
 *   reports the handoff to the room (advance with nextItemId + position).
 * - Every failure degrades to standard playback at the track end ("safe fallback").
 */
import { analyzeTrack, summarize, type AnalysisSummary, type TrackAnalysis } from '../../dsp/analyze'
import { upNext } from '../../domain/queue'
import type { DjState, PlaybackState, QueueItem, TransitionSummary } from '../../domain/types'
import type { PlaybackController } from '../../providers/playback/types'
import { isWaveformSource } from '../../providers/catalog/types'
import type { RoomCommand } from '../../server/commands'
import { planQueue, type QueueCandidate } from '../queue-planner'
import { bestTransition, candidateTransitions, DEFAULT_WEIGHTS, type PlannerOptions, type PlanTrack, type TransitionPlan, type TransitionStyle } from '../transitions'
import { AudioLoadError, analysisCopy, DecodedCache, fetchAndDecode, type AudioFetchContext } from './audio-source'
import { DjEngine, stretchedMap, trimDbFor } from './deck-engine'
import { refineWithLocalBeats } from '../phase'
import type { WorkerRequest, WorkerResponse } from './analysis.worker'

export type TrackAnalysisStatus = 'analyzing' | 'ready' | 'low_confidence' | 'cannot_mix' | 'failed'

export interface HostDjSnapshot {
  analyses: Record<string, { status: TrackAnalysisStatus; summary?: AnalysisSummary; error?: string; ms?: number }>
  proposal: { plan: TransitionPlan; alternatives: TransitionPlan[]; startsInSec: number } | null
  committed: { plan: TransitionPlan; startsInSec: number } | null
  status: DjState['status']
  note: string
  meter: { peakDb: number; rmsDb: number; clipCount: number }
  activeItemId: string | null
  positionSec: number
}

type Send = (cmd: RoomCommand) => Promise<{ ok: boolean; error?: { code: string; message?: string } }>

interface Deps {
  roomId: string
  controllerId: string
  send: Send
  now: () => number
  fetchCtx: AudioFetchContext
  onChange: () => void
}

const COMMIT_WINDOW_SEC = 40
const MIN_PREP_SEC = 6
export const WAVEFORM_KEY_SEP = '#'

/** The playable audio key for a queue item, or null when it can only be embedded. */
export function audioKeyOf(item: QueueItem): string | null {
  if (isWaveformSource(item.trackKey)) return item.trackKey
  if (item.mixTrackKey && item.mixMatch && item.mixMatch.status !== 'rejected' && isWaveformSource(item.mixTrackKey)) return item.mixTrackKey
  return null
}

/** Key handed to the PlaybackController: `audius:xyz#<itemId>` for waveform items. */
export function playKeyOf(item: QueueItem): string | null {
  const k = audioKeyOf(item)
  return k ? `${k}${WAVEFORM_KEY_SEP}${item.id}` : null
}

const STYLE_SETS: Record<DjState['style'], TransitionStyle[]> = {
  balanced: ['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade'],
  smooth: ['long_blend', 'bass_swap', 'short_fade', 'unmatched_fade'],
  energetic: ['bass_swap', 'short_fade', 'cut', 'percussion_led', 'unmatched_fade'],
  creative: ['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade'],
}

export class HostDj implements PlaybackController {
  private engine: DjEngine | null = null
  private worker: Worker | null = null
  private reqId = 0
  private readonly pending = new Map<number, (r: WorkerResponse) => void>()
  private readonly cache = new DecodedCache(4)
  private readonly analyses = new Map<string, { status: TrackAnalysisStatus; analysis?: TrackAnalysis; summary?: AnalysisSummary; error?: string; ms?: number; promise?: Promise<void> }>()
  private readonly endedHandlers = new Set<() => void>()
  private readonly errorHandlers = new Set<(code: number) => void>()
  private readonly playingHandlers = new Set<() => void>()
  private loadToken = 0
  private pb: PlaybackState | null = null
  private items: QueueItem[] = []
  private dj: DjState | null = null
  private savedFeatures = new Set<string>()
  private proposal: HostDjSnapshot['proposal'] = null
  private committed: { plan: TransitionPlan; toItemId: string } | null = null
  private override: { fromItemId: string; toItemId: string; kind: 'skip' | 'style'; style?: TransitionStyle } | null = null
  private recentStyles: TransitionStyle[] = []
  private status: DjState['status'] = 'idle'
  private note = ''
  private lastProposalKey = ''
  private preparing = false
  private volume = 0.8
  private disposed = false

  private readonly tickTimer: ReturnType<typeof setInterval>

  constructor(private readonly deps: Deps) {
    // Re-evaluate once per second so proposals/commit windows track the playhead.
    // (Scheduling itself happens on the AudioContext clock inside DjEngine.)
    this.tickTimer = setInterval(() => this.evaluate(), 1000)
  }

  // ───────────────────────── engine plumbing ─────────────────────────

  private ensureEngine(): DjEngine {
    if (!this.engine) {
      this.engine = new DjEngine({
        onEnded: () => this.endedHandlers.forEach((h) => h()),
        onHandoff: (itemId, trackSec) => void this.reportHandoff(itemId, trackSec),
        onTransitionDone: (_from, _to) => {
          this.committed = null
          this.setStatus('ready', '')
        },
        onSilence: () => this.setStatus('failed', 'Unexpected silence detected on the host output.'),
      })
      this.engine.setMasterVolume(this.volume)
    }
    return this.engine
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const cb = this.pending.get(ev.data.id)
        if (cb) {
          this.pending.delete(ev.data.id)
          cb(ev.data)
        }
      }
    }
    return this.worker
  }

  private call(msg: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const w = this.ensureWorker()
    return new Promise((resolve) => {
      this.pending.set(msg.id, resolve)
      w.postMessage(msg, transfer)
    })
  }

  private decode(audioKey: string): Promise<AudioBuffer> {
    const ctx = this.ensureEngine().ctx
    return this.cache.get(audioKey, () => fetchAndDecode(ctx, audioKey, this.deps.fetchCtx))
  }

  // ───────────────────────── PlaybackController ─────────────────────────

  async load(playKey: string, startSec = 0): Promise<void> {
    const [audioKey, itemId] = playKey.split(WAVEFORM_KEY_SEP)
    const token = ++this.loadToken
    const engine = this.ensureEngine()
    if (engine.activeItemId === itemId || engine.pendingTransition?.plan.toItemId === itemId) {
      // adopt: the item is already audible on a deck (mix handoff)
      const buf = await this.decode(audioKey).catch(() => null)
      if (buf) engine.play(itemId, audioKey, buf, startSec, this.analyses.get(audioKey)?.summary?.lufs, this.analyses.get(audioKey)?.summary?.truePeak)
      return
    }
    try {
      const buf = await this.decode(audioKey)
      if (token !== this.loadToken || this.disposed) return
      engine.play(itemId, audioKey, buf, startSec, this.analyses.get(audioKey)?.summary?.lufs, this.analyses.get(audioKey)?.summary?.truePeak)
      if (engine.state !== 'running') await engine.suspend()
      void this.ensureAnalysis(audioKey)
    } catch (e) {
      if (token !== this.loadToken) return
      const code = e instanceof AudioLoadError ? e.code : 901
      this.errorHandlers.forEach((h) => h(code))
    }
  }

  play(): void {
    const engine = this.ensureEngine()
    void engine.resume().then((running) => {
      if (running) this.playingHandlers.forEach((h) => h())
    })
  }

  pause(): void {
    void this.engine?.suspend()
  }

  stop(): void {
    this.engine?.stopAll()
    this.committed = null
    this.proposal = null
  }

  setVolume(volume: number): void {
    this.volume = volume / 100
    this.engine?.setMasterVolume(this.volume)
  }

  currentTime(): number {
    return this.engine?.trackPosition() ?? 0
  }

  onEnded(h: () => void) {
    this.endedHandlers.add(h)
    return () => this.endedHandlers.delete(h)
  }

  onError(h: (code: number) => void) {
    this.errorHandlers.add(h)
    return () => this.errorHandlers.delete(h)
  }

  onPlaying(h: () => void) {
    this.playingHandlers.add(h)
    return () => this.playingHandlers.delete(h)
  }

  destroy(): void {
    this.disposed = true
    clearInterval(this.tickTimer)
    this.engine?.dispose()
    this.worker?.terminate()
    this.cache.clear()
  }

  // ───────────────────────── analysis ─────────────────────────

  ensureAnalysis(audioKey: string): Promise<void> {
    const cur = this.analyses.get(audioKey)
    if (cur?.promise) return cur.promise
    if (cur && cur.status !== 'failed') return Promise.resolve()
    const entry: { status: TrackAnalysisStatus; promise?: Promise<void>; analysis?: TrackAnalysis; summary?: AnalysisSummary; error?: string; ms?: number } = { status: 'analyzing' }
    this.analyses.set(audioKey, entry)
    this.deps.onChange()
    entry.promise = (async () => {
      try {
        const buf = await this.decode(audioKey)
        const mono = await analysisCopy(buf)
        const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice())
        const res = await this.call({ type: 'analyze', id: ++this.reqId, channels, sampleRate: buf.sampleRate, analysisMono: mono }, [...channels.map((c) => c.buffer), mono.buffer])
        if (res.type !== 'analysis' || !res.analysis) throw new Error(res.type === 'analysis' ? res.error ?? 'analysis failed' : 'bad worker reply')
        entry.analysis = res.analysis
        entry.summary = summarize(res.analysis)
        entry.ms = res.ms
        const s = entry.summary
        entry.status = s.bpm > 0 && s.bpmConf >= 0.35 && s.stable ? 'ready' : s.bpm > 0 ? 'low_confidence' : 'cannot_mix'
        await this.saveFeatures(audioKey, entry.status, s)
      } catch (e) {
        entry.status = 'failed'
        entry.error = e instanceof Error ? e.message : String(e)
        await this.deps.send({ type: 'saveAnalysis', trackKey: audioKey, status: 'failed', analyzerVersion: 'cp-dsp-1.0.0', failure: entry.error.slice(0, 200) }).catch(() => undefined)
      } finally {
        entry.promise = undefined
        this.deps.onChange()
        this.evaluate()
      }
    })()
    return entry.promise
  }

  private async saveFeatures(audioKey: string, status: TrackAnalysisStatus, s: AnalysisSummary): Promise<void> {
    const key = `${audioKey}@${s.v}`
    if (this.savedFeatures.has(key)) return
    const r = await this.deps.send({ type: 'saveAnalysis', trackKey: audioKey, status: status === 'analyzing' ? 'ready' : status, analyzerVersion: s.v, summary: s as unknown as Record<string, unknown> })
    if (r.ok) this.savedFeatures.add(key)
  }

  /** Test hook / research page: analyze PCM directly (no network). */
  static analyzePcm(channels: Float32Array[], sampleRate: number): TrackAnalysis {
    return analyzeTrack({ channels, sampleRate })
  }

  // ───────────────────────── autopilot ─────────────────────────

  sync(pb: PlaybackState, items: QueueItem[], dj: DjState): void {
    this.pb = pb
    this.items = items
    this.dj = dj
    // a committed transition whose target left the queue / whose source stopped must be cancelled
    if (this.committed && (pb.currentItemId !== this.committed.plan.fromItemId || !items.some((i) => i.id === this.committed!.toItemId && i.status === 'queued'))) {
      if (pb.currentItemId !== this.committed.plan.toItemId) {
        this.engine?.cancelTransition()
        this.committed = null
      }
    }
    this.evaluate()
  }

  private nextCandidate(): QueueItem | null {
    const pb = this.pb
    const dj = this.dj
    if (!pb) return null
    const queued = upNext(this.items)
    if (!queued.length) return null
    if (!dj?.aiReorder) return queued[0]
    // AI reordering (host opt-in): pick the planner's first item among unlocked requests.
    const cur = this.items.find((i) => i.id === pb.currentItemId)
    const curTrack = cur ? this.planTrack(cur) : null
    const cands: QueueCandidate[] = queued.map((i, k) => ({
      track: this.planTrack(i),
      fifoIndex: k,
      pinned: i.pinnedAt !== null,
      lockedIndex: i.locked ? k : undefined,
      targetStartAt: i.targetStartAt,
      votes: i.voteCount,
    }))
    const plan = planQueue({ now: this.deps.now(), current: curTrack, currentRemainingSec: curTrack ? Math.max(0, curTrack.durationSec - this.currentTime()) : 0, items: cands, aiReorder: true, transition: this.plannerOptions() })
    return queued.find((i) => i.id === plan.order[0]) ?? queued[0]
  }

  private planTrack(item: QueueItem): PlanTrack {
    const key = audioKeyOf(item)
    const a = key ? this.analyses.get(key) : undefined
    const mixable = !!key && (a?.status === 'ready' || a?.status === 'low_confidence') && !!a.summary && this.mixingAllowed(key, item)
    return { itemId: item.id, trackKey: key ?? item.trackKey, title: item.title, mixable, summary: mixable ? a?.summary : undefined, durationSec: a?.summary?.durationSec ?? (item.durationMs ?? 240_000) / 1000 }
  }

  private mixingAllowed(audioKey: string, item?: QueueItem): boolean {
    // Sources whose licence needs a human rights review for live mixing (OML-only Audius uploads,
    // Jamendo ND/unknown licences) are mixable only while the host allows it.
    const needsReview = item?.rights ? item.rights.needsReview : audioKey.startsWith('audius:')
    return !(needsReview && this.dj && !this.dj.allowOmlMixing)
  }

  private plannerOptions(): PlannerOptions {
    const dj = this.dj
    return {
      maxTempoDeviation: (dj?.maxTempoPct ?? 6) / 100,
      weights: dj?.style === 'creative' ? { ...DEFAULT_WEIGHTS, variety: 1.2, key: 0.6 } : dj?.style === 'smooth' ? { ...DEFAULT_WEIGHTS, key: 1.4, vocals: 1.6 } : DEFAULT_WEIGHTS,
      recentStyles: this.recentStyles,
      energyDirection: dj?.style === 'energetic' ? 1 : 0,
      allowedStyles: STYLE_SETS[dj?.style ?? 'balanced'],
    }
  }

  private setStatus(status: DjState['status'], note: string): void {
    if (this.status === status && this.note === note) return
    this.status = status
    this.note = note
    this.deps.onChange()
  }

  private evaluate(): void {
    const pb = this.pb
    const dj = this.dj
    const engine = this.engine
    if (!pb || !dj || !engine || this.disposed) return
    const cur = this.items.find((i) => i.id === pb.currentItemId)
    const curKey = cur ? audioKeyOf(cur) : null
    if (curKey) void this.ensureAnalysis(curKey)
    const next = this.nextCandidate()
    const nextKey = next ? audioKeyOf(next) : null
    if (nextKey) void this.ensureAnalysis(nextKey) // preload + analyze the next track early
    if (!dj.autopilot || pb.state !== 'playing' || !cur || !curKey || engine.activeItemId !== cur.id) {
      this.proposal = null
      return
    }
    if (this.committed) return
    if (!next) {
      this.proposal = null
      this.setStatus('ready', 'Nothing queued after this song.')
      return
    }
    const a = this.planTrack(cur)
    const b = this.planTrack(next)
    if (!a.mixable || !b.mixable) {
      const why = !nextKey ? 'Next song is YouTube-only: standard playback (no mix).' : 'Waiting for analysis…'
      this.proposal = null
      this.setStatus(nextKey ? 'analyzing' : 'safe_fallback', why)
      return
    }
    if (this.override?.fromItemId === cur.id && this.override.toItemId === next.id && this.override.kind === 'skip') {
      this.proposal = null
      this.setStatus('safe_fallback', 'Host chose standard playback for this change.')
      return
    }
    const pos = engine.trackPosition()
    const opts = this.plannerOptions()
    let all = candidateTransitions(a, b, opts).filter((p) => p.style !== 'sequential' && p.outCueSec - pos > MIN_PREP_SEC)
    if (this.override?.kind === 'style' && this.override.fromItemId === cur.id && this.override.toItemId === next.id) {
      const forced = all.filter((p) => p.style === this.override!.style)
      if (forced.length) all = forced
    }
    if (!all.length) {
      this.proposal = null
      this.setStatus('safe_fallback', 'Too late in the track for a planned mix — standard playback.')
      return
    }
    const best = all[0]
    const seen = new Set([best.style])
    const alternatives = all.filter((p) => !seen.has(p.style) && (seen.add(p.style), true)).slice(0, 3)
    const startsInSec = best.outCueSec - pos
    this.proposal = { plan: best, alternatives, startsInSec }
    const key = `${best.fromItemId}>${best.toItemId}:${best.style}:${best.outCueSec.toFixed(1)}`
    if (startsInSec > COMMIT_WINDOW_SEC) {
      if (key !== this.lastProposalKey) {
        this.lastProposalKey = key
        this.setStatus('proposed', `${best.style.replace('_', ' ')} in ${Math.round(startsInSec)} s`)
        void this.deps.send({ type: 'djStatus', status: 'proposed', note: this.note, transition: summaryOf(best, alternatives), expectedPlaybackRevision: pb.playbackRevision, controllerId: this.deps.controllerId })
      }
      return
    }
    void this.commit(best, alternatives, next)
  }

  /** Host override: commit now (earliest feasible phrase), pick an alternative style, or skip mixing for this change. */
  overrideNext(kind: 'mix_now' | 'skip' | 'style', style?: TransitionStyle): void {
    const pb = this.pb
    const cur = this.items.find((i) => i.id === pb?.currentItemId)
    const next = this.nextCandidate()
    if (!cur || !next) return
    if (this.committed) this.engine?.cancelTransition()
    this.committed = null
    this.lastProposalKey = ''
    if (kind === 'skip') this.override = { fromItemId: cur.id, toItemId: next.id, kind: 'skip' }
    else if (kind === 'style') this.override = { fromItemId: cur.id, toItemId: next.id, kind: 'style', style }
    else {
      this.override = null
      const a = this.planTrack(cur)
      const b = this.planTrack(next)
      const pos = this.engine?.trackPosition() ?? 0
      const soon = candidateTransitions(a, b, this.plannerOptions())
        .filter((p) => p.style !== 'sequential' && p.outCueSec - pos > MIN_PREP_SEC)
        .sort((p, q) => p.outCueSec - q.outCueSec || p.costs.total - q.costs.total)[0]
      if (soon) {
        void this.commit(soon, [], next)
        return
      }
    }
    this.evaluate()
  }

  private async commit(planIn: TransitionPlan, alternatives: TransitionPlan[], next: QueueItem): Promise<void> {
    if (this.preparing || this.committed) return
    const pb = this.pb
    const engine = this.engine
    const nextKey = audioKeyOf(next)
    if (!pb || !engine || !nextKey) return
    // Local beat refinement: snap cues to the network's beats and derive the tempo ratio from the
    // two tracks' LOCAL beat periods over the overlap (a global grid can drift over a blend).
    const curKey = engine.activeTrackKey
    const plan: TransitionPlan =
      planIn.durationSec >= 4 && curKey
        ? (() => {
            const r = refineWithLocalBeats(planIn, this.analyses.get(curKey)?.analysis?.netBeats, this.analyses.get(nextKey)?.analysis?.netBeats, (this.dj?.maxTempoPct ?? 6) / 100)
            const { localRefined: _l, ...rest } = r
            void _l
            return rest as TransitionPlan
          })()
        : planIn
    this.preparing = true
    try {
      const buf = await this.decode(nextKey)
      const lufs = this.analyses.get(nextKey)?.summary?.lufs
      const truePeak = this.analyses.get(nextKey)?.summary?.truePeak
      let incoming: { buffer: AudioBuffer; map?: ReturnType<typeof stretchedMap> } = { buffer: buf }
      if (Math.abs(plan.tempoRatio - 1) > 1e-4) incoming = await this.prerenderStretch(buf, plan)
      const scheduled = engine.scheduleTransition(plan, { itemId: next.id, trackKey: nextKey, buffer: incoming.buffer, map: incoming.map, lufs, truePeak })
      this.committed = { plan, toItemId: next.id }
      this.recentStyles = [plan.style, ...this.recentStyles].slice(0, 5)
      const startsAt = Math.round(this.deps.now() + (scheduled.startsAtCtx - engine.ctx.currentTime) * 1000)
      this.setStatus('committed', `${plan.style.replace('_', ' ')} committed`)
      const r = await this.deps.send({ type: 'djStatus', status: 'committed', note: this.note, transition: { ...summaryOf(plan, alternatives), startsAt }, expectedPlaybackRevision: pb.playbackRevision, controllerId: this.deps.controllerId })
      if (!r.ok && r.error?.code === 'STALE_REVISION') {
        engine.cancelTransition()
        this.committed = null
        this.setStatus('ready', 'Queue changed — replanning.')
      }
    } catch (e) {
      this.committed = null
      this.setStatus('safe_fallback', `Mix failed safely: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200))
      void this.deps.send({ type: 'djStatus', status: 'safe_fallback', note: this.note, transition: null, expectedPlaybackRevision: pb.playbackRevision, controllerId: this.deps.controllerId })
    } finally {
      this.preparing = false
      this.deps.onChange()
    }
  }

  private async prerenderStretch(buf: AudioBuffer, plan: TransitionPlan): Promise<{ buffer: AudioBuffer; map: ReturnType<typeof stretchedMap> }> {
    const rate = buf.sampleRate
    const overlap = Math.round(plan.durationSec * rate)
    const recovery = Math.round(plan.tempoRecoveryBars * 4 * plan.beatSec * rate)
    const outLength = overlap + recovery + Math.round(0.5 * rate)
    const startSample = Math.round(plan.inCueSec * rate)
    const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice())
    const knots: Array<[number, number]> = [
      [0, plan.tempoRatio],
      [overlap, plan.tempoRatio],
      [overlap + Math.max(1, recovery), 1],
    ]
    const res = await this.call({ type: 'stretch', id: ++this.reqId, channels, sampleRate: rate, startSample, outLength, knots }, channels.map((c) => c.buffer))
    if (res.type !== 'stretched' || !res.channels || !res.anchors || !res.hop || res.inputEnd === undefined) throw new Error(res.type === 'stretched' ? res.error ?? 'stretch failed' : 'bad worker reply')
    const inputEnd = Math.round(res.inputEnd)
    const tail = Math.max(0, buf.length - inputEnd)
    const out = this.ensureEngine().ctx.createBuffer(res.channels.length, outLength + tail, rate)
    const xf = 256
    for (let c = 0; c < res.channels.length; c++) {
      const dst = out.getChannelData(c)
      dst.set(res.channels[c].subarray(0, outLength), 0)
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
      // short crossfade at the splice from the stretched segment back to the original audio
      for (let i = 0; i < tail; i++) {
        const v = src[inputEnd + i]
        if (i < xf) {
          const g = i / xf
          dst[outLength - xf + i] = dst[outLength - xf + i] * (1 - g) + (src[inputEnd - xf + i] ?? 0) * g
        }
        dst[outLength + i] = v
      }
    }
    return { buffer: out, map: stretchedMap(rate, res.anchors, res.hop, outLength, inputEnd) }
  }

  private async reportHandoff(itemId: string, trackSec: number): Promise<void> {
    const pb = this.pb
    if (!pb) return
    this.setStatus('mixing', 'Mixing…')
    await this.deps.send({ type: 'advance', reason: 'ended', expectedRevision: pb.playbackRevision, controllerId: this.deps.controllerId, nextItemId: itemId, startPositionSec: Math.max(0, trackSec) })
  }

  snapshot(): HostDjSnapshot {
    const analyses: HostDjSnapshot['analyses'] = {}
    for (const [k, v] of this.analyses) analyses[k] = { status: v.status, summary: v.summary, error: v.error, ms: v.ms }
    const engine = this.engine
    const committed = this.committed && engine?.pendingTransition ? { plan: this.committed.plan, startsInSec: engine.pendingTransition.startsAtCtx - engine.ctx.currentTime } : null
    return {
      analyses,
      proposal: this.proposal,
      committed,
      status: this.status,
      note: this.note,
      meter: { peakDb: engine?.peakDb ?? -Infinity, rmsDb: engine?.rmsDb ?? -Infinity, clipCount: engine?.clipCount ?? 0 },
      activeItemId: engine?.activeItemId ?? null,
      positionSec: engine?.trackPosition() ?? 0,
    }
  }

  analysisFor(audioKey: string): TrackAnalysis | undefined {
    return this.analyses.get(audioKey)?.analysis
  }
}

export function summaryOf(p: TransitionPlan, alts: TransitionPlan[]): TransitionSummary {
  const r = (x: number) => Math.round(x * 100) / 100
  return {
    fromItemId: p.fromItemId,
    toItemId: p.toItemId,
    style: p.style,
    outCueSec: r(p.outCueSec),
    inCueSec: r(p.inCueSec),
    overlapBars: p.overlapBars,
    tempoRatio: Math.round(p.tempoRatio * 10000) / 10000,
    cost: r(p.costs.total),
    costs: Object.fromEntries(Object.entries(p.costs).map(([k, v]) => [k, r(v)])),
    risks: p.risks.slice(0, 6).map((s) => s.slice(0, 80)),
    reasons: p.reasons.slice(0, 6).map((s) => s.slice(0, 80)),
    alternatives: alts.slice(0, 4).map((a) => ({ style: a.style, cost: r(a.costs.total) })),
  }
}

export { trimDbFor, bestTransition }
