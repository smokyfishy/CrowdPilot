/**
 * /lab — DJ Lab: audition the real engine on real authorized audio without a room.
 * Loads two Audius tracks, analyzes them in the browser worker, plans the transition
 * with MixGraph and plays it through the two-deck Web Audio engine (starting a few
 * seconds before the planned cue). Also runs a small real-music tempo check against
 * artist-declared Audius BPM (a weak, explicitly labelled reference — not ground truth).
 * Session-only: no audio is stored; nothing here is used for training.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { analyzeTrack, summarize, type TrackAnalysis } from '@/dsp/analyze'
import { createAudiusProvider } from '@/providers/catalog/audius'
import type { CatalogTrack } from '@/providers/catalog/types'
import { analysisCopy, fetchAndDecode } from '@/dj/engine/audio-source'
import { DjEngine, stretchedMap } from '@/dj/engine/deck-engine'
import { bestTransition, STYLE_LABEL, type PlanTrack, type TransitionPlan, type TransitionStyle } from '@/dj/transitions'
import { wsola } from '@/dsp/stretch'
import { WaveformView } from '@/components/dj/WaveformView'
import type { WorkerRequest, WorkerResponse } from '@/dj/engine/analysis.worker'

interface Loaded {
  track: CatalogTrack
  buffer: AudioBuffer
  analysis: TrackAnalysis
  ms: number
}

declare global {
  interface Window {
    __djLab?: {
      state: string
      log: string[]
      plan?: TransitionPlan
      rmsDb?: number
      peakDb?: number
      clipCount?: number
      transition?: { handedOff: boolean; done: boolean; startedAtCtx?: number }
      bench?: unknown
      a?: ReturnType<typeof summarize>
      b?: ReturnType<typeof summarize>
    }
  }
}

const lab = () => (window.__djLab ??= { state: 'idle', log: [] })

function analyzeInWorker(buffer: AudioBuffer, mono: Float32Array): Promise<{ analysis: TrackAnalysis; ms: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../../dj/engine/analysis.worker.ts', import.meta.url), { type: 'module' })
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice())
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      w.terminate()
      if (ev.data.type === 'analysis' && ev.data.analysis) resolve({ analysis: ev.data.analysis, ms: ev.data.ms })
      else reject(new Error(ev.data.type === 'analysis' ? ev.data.error : 'bad reply'))
    }
    const msg: WorkerRequest = { type: 'analyze', id: 1, channels, sampleRate: buffer.sampleRate, analysisMono: mono }
    w.postMessage(msg, [...channels.map((c) => c.buffer), mono.buffer])
  })
}

export default function LabPage() {
  const [q, setQ] = useState('deep house')
  const [results, setResults] = useState<CatalogTrack[]>([])
  const [a, setA] = useState<Loaded | null>(null)
  const [b, setB] = useState<Loaded | null>(null)
  const [plan, setPlan] = useState<{ best: TransitionPlan; alternatives: TransitionPlan[] } | null>(null)
  const [style, setStyle] = useState<TransitionStyle | ''>('')
  const [log, setLog] = useState<string[]>([])
  const [pos, setPos] = useState(0)
  const engineRef = useRef<DjEngine | null>(null)
  const say = (s: string) => {
    lab().log.push(s)
    setLog((l) => [...l.slice(-30), s])
  }

  useEffect(() => () => engineRef.current?.dispose(), [])
  useEffect(() => {
    const id = setInterval(() => {
      const e = engineRef.current
      if (!e) return
      setPos(e.trackPosition())
      const L = lab()
      L.rmsDb = e.rmsDb
      L.peakDb = e.peakDb
      L.clipCount = e.clipCount
    }, 250)
    return () => clearInterval(id)
  }, [])

  const engine = () => {
    if (!engineRef.current) {
      engineRef.current = new DjEngine({
        onHandoff: (id, t) => {
          say(`handoff → ${id} at ${t.toFixed(2)} s (room state would switch here)`)
          const L = lab()
          L.transition = { ...(L.transition ?? { done: false }), handedOff: true }
        },
        onTransitionDone: () => {
          say('transition complete; incoming deck is now the master')
          const L = lab()
          L.transition = { ...(L.transition ?? { handedOff: true }), done: true }
          lab().state = 'done'
        },
        onSilence: () => say('WARNING: unexpected silence'),
      })
    }
    return engineRef.current
  }

  async function search() {
    const r = await createAudiusProvider().search(q)
    // Single tracks only: skip DJ mixes / very long uploads (> 12 min) and snippets.
    if (r.ok) setResults(r.value.filter((t) => (t.durationMs ?? 0) >= 90_000 && (t.durationMs ?? 0) <= 720_000).slice(0, 12))
    else say(`search failed: ${r.error.message}`)
  }

  async function load(track: CatalogTrack, slot: 'a' | 'b') {
    lab().state = `loading-${slot}`
    say(`loading ${track.title} (${track.trackKey})…`)
    const e = engine()
    let buffer: AudioBuffer
    let analysis: TrackAnalysis
    let ms: number
    try {
      buffer = await fetchAndDecode(e.ctx, track.trackKey, { roomId: '', authHeaders: async () => ({}) })
      const mono = await analysisCopy(buffer)
      ;({ analysis, ms } = await analyzeInWorker(buffer, mono))
    } catch (err) {
      say(`load failed: ${err instanceof Error ? err.message : String(err)}`)
      lab().state = `failed-${slot}`
      return
    }
    const s = summarize(analysis)
    say(`${slot.toUpperCase()}: ${s.bpm} BPM (conf ${s.bpmConf}), ${s.key} ${s.camelot} (conf ${s.keyConf}), ${s.lufs} LUFS — ${(ms / 1000).toFixed(1)} s analysis${track.providerBpm ? ` · Audius-declared BPM ${track.providerBpm}` : ''}`)
    const loaded = { track, buffer, analysis, ms }
    lab()[slot] = s
    lab().state = `loaded-${slot}`
    if (slot === 'a') setA(loaded)
    else setB(loaded)
  }

  function makePlan(): { best: TransitionPlan; alternatives: TransitionPlan[] } | null {
    if (!a || !b) return null
    const pa: PlanTrack = { itemId: 'A', trackKey: a.track.trackKey, title: a.track.title, mixable: true, summary: summarize(a.analysis), durationSec: a.analysis.qc.durationSec }
    const pb: PlanTrack = { itemId: 'B', trackKey: b.track.trackKey, title: b.track.title, mixable: true, summary: summarize(b.analysis), durationSec: b.analysis.qc.durationSec }
    const p = bestTransition(pa, pb, { maxTempoDeviation: 0.06, weights: { tempo: 0.25, key: 1, energy: 0.08, vocals: 1.2, confidence: 1, truncation: 0.02, variety: 0.4 }, recentStyles: [], energyDirection: 0, allowedStyles: style ? [style] : undefined }, 3)
    setPlan(p)
    lab().plan = p.best
    say(`plan: ${STYLE_LABEL[p.best.style]} ${p.best.overlapBars} bars, out ${p.best.outCueSec.toFixed(2)} s → in ${p.best.inCueSec.toFixed(2)} s, tempo ×${p.best.tempoRatio.toFixed(4)}, cost ${p.best.costs.total.toFixed(2)}${p.best.risks.length ? `; risks: ${p.best.risks.join(', ')}` : ''}`)
    return p
  }

  async function audition() {
    const p = plan ?? makePlan()
    if (!p || !a || !b) return
    const e = engine()
    await e.resume()
    const best = p.best
    if (best.style === 'sequential') return say('No mixable plan.')
    const lead = 8
    const startAt = Math.max(0, best.outCueSec - lead)
    e.play('A', a.track.trackKey, a.buffer, startAt, summarize(a.analysis).lufs, summarize(a.analysis).truePeak)
    let incoming: { buffer: AudioBuffer; map?: ReturnType<typeof stretchedMap> } = { buffer: b.buffer }
    if (Math.abs(best.tempoRatio - 1) > 1e-4) {
      const rate = b.buffer.sampleRate
      const overlap = Math.round(best.durationSec * rate)
      const rec = Math.round(best.tempoRecoveryBars * 4 * best.beatSec * rate)
      const outLength = overlap + rec + Math.round(0.5 * rate)
      const chans = Array.from({ length: Math.min(2, b.buffer.numberOfChannels) }, (_, c) => b.buffer.getChannelData(c))
      const t0 = performance.now()
      const st = wsola(chans, Math.round(best.inCueSec * rate), outLength, (s) => (s <= overlap ? best.tempoRatio : rec > 0 && s < overlap + rec ? best.tempoRatio + (1 - best.tempoRatio) * ((s - overlap) / rec) : 1))
      const inputEnd = Math.round(st.inputEnd)
      const tail = Math.max(0, b.buffer.length - inputEnd)
      const buf = e.ctx.createBuffer(chans.length, outLength + tail, rate)
      for (let c = 0; c < chans.length; c++) {
        buf.getChannelData(c).set(st.channels[c].subarray(0, outLength), 0)
        buf.getChannelData(c).set(chans[c].subarray(inputEnd), outLength)
      }
      incoming = { buffer: buf, map: stretchedMap(rate, st.anchors, st.hop, outLength, inputEnd) }
      say(`pre-rendered tempo-matched incoming segment (WSOLA, pitch preserved) in ${(performance.now() - t0).toFixed(0)} ms`)
    }
    // give the deck a moment to start before scheduling relative to it
    await new Promise((r) => setTimeout(r, 200))
    const sched = e.scheduleTransition(best, { itemId: 'B', trackKey: b.track.trackKey, buffer: incoming.buffer, map: incoming.map, lufs: summarize(b.analysis).lufs, truePeak: summarize(b.analysis).truePeak })
    lab().transition = { handedOff: false, done: false, startedAtCtx: sched.startsAtCtx }
    lab().state = 'transition-scheduled'
    say(`transition scheduled on the audio clock at ctx ${sched.startsAtCtx.toFixed(3)} s (in ${(sched.startsAtCtx - e.ctx.currentTime).toFixed(1)} s)`)
  }

  async function benchmark() {
    // Real-music tempo check vs. artist-declared Audius BPM (weak reference; octave-aware).
    const out: Array<{ id: string; title: string; declared: number; measured: number; conf: number; acc1: boolean; acc2: boolean }> = []
    lab().state = 'bench'
    for (const query of ['tech house', 'techno', 'deep house', 'house music']) {
      const r = await createAudiusProvider().search(query)
      if (!r.ok) continue
      for (const t of r.value) {
        if (out.length >= 20) break
        if (!t.providerBpm || t.providerBpm < 100 || t.providerBpm > 150 || out.some((o) => o.id === t.trackKey)) continue
        try {
          const buffer = await fetchAndDecode(engine().ctx, t.trackKey, { roomId: '', authHeaders: async () => ({}) })
          if (buffer.duration > 600) continue
          const mono = await analysisCopy(buffer)
          const { analysis } = await analyzeInWorker(buffer, mono)
          const m = analysis.grid.bpm
          const d = t.providerBpm
          const acc1 = Math.abs(m - d) / d <= 0.04
          const acc2 = [1, 2, 0.5, 3, 1 / 3].some((k) => Math.abs(m - d * k) / (d * k) <= 0.04)
          out.push({ id: t.trackKey, title: t.title, declared: d, measured: Math.round(m * 100) / 100, conf: Math.round(analysis.grid.confidence * 100) / 100, acc1, acc2 })
          say(`bench ${out.length}: declared ${d} · measured ${m.toFixed(2)} · ${acc1 ? 'Acc1 ✓' : acc2 ? 'octave' : '✗'}`)
        } catch (e) {
          say(`bench skip ${t.trackKey}: ${e instanceof Error ? e.message : e}`)
        }
      }
    }
    const n = out.length
    const summary = { n, acc1: n ? out.filter((o) => o.acc1).length / n : 0, acc2: n ? out.filter((o) => o.acc2).length / n : 0, reference: 'Audius bpm field (artist-declared or Audius-computed; weak reference, not ground truth)', rows: out }
    lab().bench = summary
    lab().state = 'bench-done'
    say(`bench done: n=${n}, Acc1 ${(summary.acc1 * 100).toFixed(0)}%, Acc2 ${(summary.acc2 * 100).toFixed(0)}%`)
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-5 px-4 py-8">
      <header className="grid gap-1">
        <h1 className="font-display text-4xl text-foreground">DJ Lab</h1>
        <p className="text-sm text-muted-foreground">Audition the AI DJ engine on real Audius audio in this browser. Analysis and mixing are measured here; nothing is stored or used for training.</p>
      </header>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Audius" />
        <Button type="submit">Search Audius</Button>
      </form>
      <ul className="grid gap-1 text-sm">
        {results.map((t) => (
          <li key={t.trackKey} className="flex items-center justify-between gap-2" data-testid="lab-result">
            <span className="truncate">
              {t.title} <span className="text-muted-foreground">· {t.creatorLabel}</span>
            </span>
            <span className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => void load(t, 'a')}>
                Deck A
              </Button>
              <Button size="sm" variant="outline" onClick={() => void load(t, 'b')}>
                Deck B
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {a && <WaveformView label="Deck A" analysis={a.analysis} positionSec={engineRef.current?.activeItemId === 'A' ? pos : undefined} cueOutSec={plan?.best.outCueSec} />}
      {b && <WaveformView label="Deck B" analysis={b.analysis} positionSec={engineRef.current?.activeItemId === 'B' ? pos : undefined} cueInSec={plan?.best.inCueSec} height={48} />}
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded border border-input bg-background px-2 py-1.5 text-sm" value={style} onChange={(e) => setStyle(e.target.value as TransitionStyle | '')} aria-label="Force style">
          <option value="">Best style (planner)</option>
          {(['long_blend', 'bass_swap', 'percussion_led', 'short_fade', 'cut', 'unmatched_fade'] as TransitionStyle[]).map((s) => (
            <option key={s} value={s}>
              {STYLE_LABEL[s]}
            </option>
          ))}
        </select>
        <Button variant="outline" disabled={!a || !b} onClick={() => makePlan()}>
          Plan
        </Button>
        <Button disabled={!a || !b} onClick={() => void audition()}>
          Audition transition
        </Button>
        <Button variant="ghost" onClick={() => engineRef.current?.stopAll()}>
          Stop
        </Button>
        <Button variant="ghost" onClick={() => void benchmark()}>
          Tempo check (20 tracks)
        </Button>
      </div>
      {plan && (
        <p className="text-sm text-foreground">
          {STYLE_LABEL[plan.best.style]} · {plan.best.reasons.join(' · ')} {plan.best.risks.length > 0 && <span className="text-warning">· risks: {plan.best.risks.join(', ')}</span>}
        </p>
      )}
      <pre className="max-h-80 overflow-auto rounded-lg bg-card p-3 text-xs text-muted-foreground" data-testid="lab-log">
        {log.join('\n')}
      </pre>
    </div>
  )
}

export { analyzeTrack }
