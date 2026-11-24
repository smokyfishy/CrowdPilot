/**
 * Listen: the rendered mix with a live replay of how the AI DJ performed it.
 *
 * Timing model: the <audio> element is the only clock. One requestAnimationFrame loop reads
 * PlaybackClock.now() (the media time being heard), evaluates the performance manifest at that
 * time, and hands the state to the controller animator, the timeline playhead and a few live
 * text nodes. React re-renders only when coarse facts change (deck track swap, transition
 * start/end, play/pause), never per frame.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { MixManifest, ManifestTransition } from '@/mixgen/manifest'
import { createEvaluator, performanceFor, type ControllerState } from '@/mixgen/performance'
import { PlaybackClock } from './clock'
import { ControllerAnimator, DjController, type DeckAssignment } from './DjController'
import { fmtTime } from './mapping'
import { Timeline, type TimelineHandle } from './Timeline'
import { TransitionInspector } from '../TransitionInspector'
import { MlDiagnostics } from '../MlDiagnostics'
import { QualityPanel } from '../QualityPanel'

interface Coarse {
  decks: DeckAssignment
  current: number
  incoming: number | null
  transition: number | null
  next: number | null
}

const SPEEDS = [0.75, 1, 1.25, 1.5]

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!q) return
    const on = () => setR(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return !!r
}

function coarseOf(s: ControllerState): Coarse {
  const roles = (['A', 'B'] as const).map((d) => s.deck[d])
  const incoming = roles.find((d) => d.role === 'incoming')?.track ?? null
  const main = roles.find((d) => d.role === 'outgoing' || d.role === 'solo')?.track
  return {
    decks: { A: s.deck.A.track, B: s.deck.B.track },
    current: main ?? incoming ?? s.deck.A.track ?? 0,
    incoming,
    transition: s.transition?.index ?? null,
    next: s.next?.index ?? null,
  }
}
const sameCoarse = (a: Coarse, b: Coarse) => a.decks.A === b.decks.A && a.decks.B === b.decks.B && a.current === b.current && a.incoming === b.incoming && a.transition === b.transition && a.next === b.next

export function ListenView({ manifest: m, audioSrc, downloadUrl, footer }: { manifest: MixManifest; audioSrc: string | null; downloadUrl?: string | null; footer?: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null)
  const perf = useMemo(() => performanceFor(m), [m])
  const ev = useMemo(() => createEvaluator(perf), [perf])
  const reduced = useReducedMotion()
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [coarse, setCoarse] = useState<Coarse>(() => coarseOf(ev.evaluate(0)))
  const [pick, setPick] = useState<ManifestTransition | null>(null)
  const [insightsOpen, setInsightsOpen] = useState(false)
  const coarseRef = useRef(coarse)
  const timeline = useRef<TimelineHandle>(null)
  const animator = useRef<ControllerAnimator | null>(null)
  const live = useRef<HTMLDivElement>(null)
  const dirty = useRef(true)

  const bindController = useCallback(
    (root: HTMLElement | null) => {
      animator.current?.dispose()
      animator.current = root ? new ControllerAnimator(root, perf, reduced) : null
      dirty.current = true
    },
    [perf, reduced],
  )

  // ── the frame loop: audio clock → evaluate → draw ──
  useEffect(() => {
    const a = audio.current
    const clock = a ? new PlaybackClock(a) : null
    let raf = 0
    let lastT = -1
    let lastDraw = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const t = clock ? clock.now() : 0
      // reduced motion: same state, sampled ~8×/s (no continuous spinning)
      if (reduced && now - lastDraw < 120 && !dirty.current) return
      if (t === lastT && !dirty.current) return
      lastT = t
      lastDraw = now
      dirty.current = false
      const s = ev.evaluate(t)
      animator.current?.apply(s)
      timeline.current?.setPlayhead(t)
      const root = live.current
      if (root) {
        const set = (k: string, v: string) => {
          const e = root.querySelector<HTMLElement>(`[data-lk="${k}"]`)
          if (e && e.textContent !== v) e.textContent = v
        }
        set('time', fmtTime(t))
        set('bar', s.transition ? (s.transition.phase === 'overlap' ? `Bar ${s.transition.bar} of ${s.transition.bars}` : 'Settling in') : '')
        set('countdown', s.next ? `in ${fmtTime(s.next.inSec)}` : '')
        const prog = root.querySelector<HTMLElement>('[data-lk="progress"]')
        if (prog) prog.style.transform = `scaleX(${s.transition ? s.transition.progress : 0})`
      }
      const c = coarseOf(s)
      if (!sameCoarse(c, coarseRef.current)) {
        coarseRef.current = c
        setCoarse(c)
      }
    }
    raf = requestAnimationFrame(frame)
    const wake = () => {
      clock?.reset()
      dirty.current = true
    }
    const onPlay = () => {
      setPlaying(true)
      wake()
    }
    const onPause = () => {
      setPlaying(false)
      wake()
    }
    a?.addEventListener('play', onPlay)
    a?.addEventListener('pause', onPause)
    a?.addEventListener('ended', onPause)
    a?.addEventListener('seeked', wake)
    a?.addEventListener('seeking', wake)
    a?.addEventListener('ratechange', wake)
    a?.addEventListener('waiting', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      cancelAnimationFrame(raf)
      a?.removeEventListener('play', onPlay)
      a?.removeEventListener('pause', onPause)
      a?.removeEventListener('ended', onPause)
      a?.removeEventListener('seeked', wake)
      a?.removeEventListener('seeking', wake)
      a?.removeEventListener('ratechange', wake)
      a?.removeEventListener('waiting', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [ev, audioSrc, reduced])

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed
  }, [speed])

  const seek = useCallback(
    (t: number) => {
      const a = audio.current
      if (a) a.currentTime = Math.max(0, Math.min(m.durationSec, t))
      dirty.current = true
    },
    [m.durationSec],
  )
  const toggle = useCallback(() => {
    const a = audio.current
    if (!a) return
    if (a.paused) void a.play().catch((e: Error) => setAudioError(`Playback could not start: ${e.message}`))
    else a.pause()
  }, [])

  // Space toggles playback anywhere on the page except in text fields and buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.code !== 'Space' || el.closest('input, textarea, select, button, [contenteditable="true"]')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const startOf = (i: number) => ev.trackStart(i)
  const cur = coarse.current
  const curTr = coarse.transition != null ? m.transitions[coarse.transition] : null
  const nextTr = coarse.next != null ? m.transitions[coarse.next] : null
  const nowTrack = m.tracks[cur]
  const genres = m.genres.filter(Boolean)

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-8 [overflow-wrap:anywhere]" ref={live}>
      {/* ── mix info + transport ── */}
      <header className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          <h1 className="font-display text-[clamp(2.25rem,5.5vw,3.75rem)] leading-[0.95] text-foreground">{m.title}</h1>
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
            {genres.length > 0 && <span className="text-foreground">{genres.join(', ')}</span>}
            <span>{m.tracks.length} tracks</span>
            <span>{fmtTime(m.durationSec)}</span>
            <span>{Math.round(m.bpmRange[0])}–{Math.round(m.bpmRange[1])} BPM</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {audioSrc ? (
            <audio ref={audio} src={audioSrc} preload="auto" onError={() => setAudioError('The mix audio could not be loaded.')} />
          ) : null}
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Previous track" className="grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => seek(startOf(Math.max(0, cur - 1)))}>
              <SkipBack className="size-4" />
            </button>
            <button
              type="button"
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!audioSrc}
              data-testid="mix-play"
              className="grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_8px_24px_-10px_rgba(232,176,74,0.7)] transition-transform hover:scale-[1.03] active:scale-95 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={toggle}
            >
              {playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
            </button>
            <button type="button" aria-label="Next track" className="grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => seek(startOf(Math.min(m.tracks.length - 1, cur + 1)))}>
              <SkipForward className="size-4" />
            </button>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">
              {nowTrack ? `${nowTrack.artist} – ${nowTrack.title}` : ''}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground" data-testid="mix-time">
              <span data-lk="time">0:00</span> / {fmtTime(m.durationSec)}
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="h-8 rounded-md border border-input bg-background px-2 text-foreground" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
          </label>
        </div>
        {!audioSrc && <p className="text-sm text-muted-foreground">Audio is not stored for this mix. {m.permissions.reason}</p>}
        {audioError && <p className="text-sm text-destructive">{audioError}</p>}
      </header>

      {/* ── the AI DJ's performance ── */}
      <section aria-label="AI DJ performance" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <div className="min-w-0">
          <DjController perf={perf} decks={coarse.decks} onReady={bindController} />
        </div>
        <p className="sr-only" aria-live="polite">
          {curTr ? `${curTr.label}: mixing into ${m.tracks[curTr.index + 1]?.title}` : nowTrack ? `Now playing ${nowTrack.title} by ${nowTrack.artist}` : ''}
        </p>
        <TechniqueStrip
          current={curTr}
          next={nextTr}
          m={m}
          open={insightsOpen}
          onToggle={() => setInsightsOpen((v) => !v)}
          onInspect={(t) => setPick(t)}
        />
        {perf.fidelity === 'reduced' && (
          <p className="text-xs text-muted-foreground">
            This mix was made before CrowdPilot recorded full performance data, so the board shows only what was saved: fader, EQ and filter moves, cue points and tempo. Not shown: {perf.missing.join(', ')}.
          </p>
        )}
      </section>

      <Timeline ref={timeline} m={m} ev={ev} onSeek={seek} onPickTransition={(i) => setPick(m.transitions[i])} />

      {pick && <TransitionInspector t={pick} onClose={() => setPick(null)} onSeek={seek} />}

      {/* ── tracklist ── */}
      <section aria-labelledby="tracklist" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <h2 id="tracklist" className="font-display text-3xl text-foreground">Tracklist</h2>
        <ol className="grid">
          {m.tracks.map((t, i) => {
            const now = i === cur
            const inc = i === coarse.incoming
            const tr = m.transitions[i]
            return (
              <li key={t.key} className={`group grid grid-cols-[3.25rem_2.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-lg px-2 py-2 sm:grid-cols-[3.5rem_2.75rem_minmax(0,1fr)_4.5rem_12rem] ${now ? 'bg-accent' : 'hover:bg-accent/50'}`} aria-current={now ? 'true' : undefined}>
                <button type="button" className="text-left text-sm tabular-nums text-muted-foreground group-hover:text-foreground" onClick={() => seek(startOf(i))} data-testid={`track-seek-${i}`} aria-label={`Play from ${t.title}`}>
                  {fmtTime(startOf(i))}
                </button>
                <span className="size-10 rounded-md bg-muted bg-cover bg-center" style={t.thumbnailUrl ? { backgroundImage: `url("${t.thumbnailUrl}")` } : undefined} aria-hidden />
                <button type="button" className="min-w-0 text-left" onClick={() => seek(startOf(i))}>
                  <span className={`block truncate text-sm ${now ? 'font-semibold text-foreground' : 'text-foreground'}`}>{t.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t.artist}
                    {now && <span className="ml-2 text-primary">Playing</span>}
                    {inc && <span className="ml-2 text-primary">Mixing in</span>}
                  </span>
                </button>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {t.bpm ? Math.round(t.bpm) : '—'} BPM
                  <span className="block">{t.camelot}</span>
                </span>
                {tr ? (
                  <button type="button" className="hidden truncate rounded-full px-3 py-1 text-left text-xs text-muted-foreground hover:bg-background hover:text-foreground sm:block" onClick={() => setPick(tr)} title={`Transition into track ${i + 2}`}>
                    {tr.label}
                  </button>
                ) : (
                  <span className="hidden px-3 text-xs text-muted-foreground sm:block">Closer</span>
                )}
              </li>
            )
          })}
        </ol>
      </section>

      {/* ── details ── */}
      <section aria-label="Mix details" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 text-sm text-muted-foreground">
        {footer}
        <QualityPanel m={m} downloadUrl={downloadUrl} />
        <MlDiagnostics m={m} />
      </section>
    </div>
  )
}

/** One line under the board: what the AI DJ is doing now, what's next, and an optional detail panel. */
function TechniqueStrip({ current, next, m, open, onToggle, onInspect }: { current: ManifestTransition | null; next: ManifestTransition | null; m: MixManifest; open: boolean; onToggle: () => void; onInspect: (t: ManifestTransition) => void }) {
  const t = current ?? next
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-xl bg-card px-4 py-3 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`size-2 shrink-0 rounded-full ${current ? 'bg-primary shadow-[0_0_10px_rgba(232,176,74,0.8)]' : 'bg-muted-foreground/40'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          {current ? (
            <p className="text-sm text-foreground sm:truncate">
              <span className="font-semibold">{current.label}</span>
              <span className="text-muted-foreground"> into {m.tracks[current.index + 1]?.title}</span>
            </p>
          ) : next ? (
            <p className="text-sm text-muted-foreground sm:truncate">
              Next: <span className="text-foreground">{next.label}</span> into {m.tracks[next.index + 1]?.title} <span className="tabular-nums" data-lk="countdown" />
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Final track — no more transitions</p>
          )}
          {current && (
            <div className="mt-1.5 flex items-center gap-3">
              <span className="relative h-0.5 w-32 overflow-hidden rounded bg-muted">
                <span data-lk="progress" className="absolute inset-0 origin-left bg-primary" style={{ transform: 'scaleX(0)' }} />
              </span>
              <span className="text-xs tabular-nums text-muted-foreground" data-lk="bar" />
            </div>
          )}
        </div>
        {t && (
          <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            AI DJ insights
            <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {open && t && <Insights t={t} onInspect={onInspect} />}
    </div>
  )
}

function Insights({ t, onInspect }: { t: ManifestTransition; onInspect: (t: ManifestTransition) => void }) {
  const facts: Array<[string, string]> = [
    ['Technique', t.label],
    ['Length', `${t.overlapBars} bars (${t.overlapSec.toFixed(1)} s)`],
    ['Tempo', Math.abs(t.tempoAdjustPct) > 0.005 ? `Incoming track ${t.tempoAdjustPct > 0 ? 'sped up' : 'slowed'} ${Math.abs(t.tempoAdjustPct).toFixed(2)}%, pitch kept${t.tempoRecoverySec ? `, eased back over ${t.tempoRecoverySec.toFixed(0)} s` : ''}` : 'No tempo change needed'],
    ['Beat alignment', `Spliced within ${Math.abs(t.beatAlignment.spliceLagMs).toFixed(1)} ms (match ${t.beatAlignment.spliceCorrelation.toFixed(2)})`],
    ['Automation', t.control?.automation === 'transitionnet' ? 'TransitionNet (learned controls)' : 'Rule-based controls'],
    ...(t.control?.mixgraphSeverity !== undefined ? [['Candidate ranking', 'MixGraph (ML)'] as [string, string]] : []),
  ]
  if (t.technique) facts.push(['Confidence', `${Math.round(t.technique.confidence * 100)}% (analysis it relied on)`])
  if (t.control?.mixgraphSeverity != null) facts.push(['MixGraph risk score', String(t.control.mixgraphSeverity)])
  const why = [...(t.technique?.rationale ?? []), ...t.reasons].slice(0, 4)
  return (
    <div className="grid gap-4 border-t border-border pt-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid content-start gap-2">
        {why.length > 0 && (
          <>
            <p className="text-muted-foreground">Why this transition</p>
            <ul className="grid gap-1 text-foreground">
              {why.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
        {t.risks.length > 0 && <p className="text-xs text-muted-foreground">Watch-outs: {t.risks.slice(0, 2).join('; ')}</p>}
        <button type="button" className="justify-self-start text-xs text-primary hover:underline" onClick={() => onInspect(t)}>
          Show automation curves
        </button>
      </div>
    </div>
  )
}
