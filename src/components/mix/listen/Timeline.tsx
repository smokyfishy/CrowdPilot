/**
 * Mix timeline: the RENDERED audio's own peaks (manifest.waveform), with the two deck lanes
 * (which deck holds which track, and where they overlap), transition regions labelled with the
 * executed technique, cue points, drops mapped to mix time through the performance evaluator,
 * and — when zoomed — the bar grid of the audible deck. The static layer is drawn once per size /
 * zoom; only the playhead moves per frame (via `setPlayhead`).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { MixManifest } from '@/mixgen/manifest'
import type { PerformanceEvaluator } from '@/mixgen/performance'
import { fmtTime } from './mapping'

export interface TimelineHandle {
  setPlayhead(t: number): void
}

const H = 156
const LANE_A = 12
const LANE_B = 30
const WAVE_TOP = 52
const DECK_A = '#92c9bd'
const DECK_B = '#bbacd7'
const OVERLAP = '#e8b04a'
const DROP = '#f08074'

/** Mix times where each track's drops actually play (found on the evaluated deck positions). */
function dropTimes(ev: PerformanceEvaluator): Array<{ t: number; track: number }> {
  const out: Array<{ t: number; track: number }> = []
  const perf = ev.perf
  perf.tracks.forEach((tr, i) => {
    if (!tr.drops.length) return
    const start = ev.trackStart(i)
    const end = perf.transitions[i] ? perf.transitions[i].mixStartSec + perf.transitions[i].durationSec : perf.durationSec
    let prev: number | null = null
    for (let t = start; t <= end; t += 0.25) {
      const st = ev.evaluate(t).deck[tr.deck]
      if (st.track !== i || !st.playing) {
        prev = null
        continue
      }
      if (prev != null) for (const d of tr.drops) if (prev < d && st.pos >= d && st.pos - prev < 1) out.push({ t, track: i })
      prev = st.pos
    }
  })
  return out
}

export const Timeline = forwardRef<TimelineHandle, { m: MixManifest; ev: PerformanceEvaluator; onSeek: (t: number) => void; onPickTransition: (i: number) => void }>(function Timeline({ m, ev, onSeek, onPickTransition }, ref) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const played = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null)
  const timeRef = useRef(0)
  const drops = useMemo(() => dropTimes(ev), [ev])
  const view = zoom ?? { start: 0, end: m.durationSec }
  const span = Math.max(1, view.end - view.start)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useImperativeHandle(ref, () => ({
    setPlayhead(t: number) {
      timeRef.current = t
      if (zoom && (t < zoom.start || t > zoom.start + (zoom.end - zoom.start) * 0.85)) {
        const len = zoom.end - zoom.start
        const s = Math.max(0, Math.min(m.durationSec - len, t - len * 0.25))
        setZoom({ start: s, end: s + len })
        return
      }
      const x = ((t - view.start) / span) * 100
      head.current?.style.setProperty('left', `${Math.max(0, Math.min(100, x))}%`)
      played.current?.style.setProperty('width', `${Math.max(0, Math.min(100, x))}%`)
    },
  }), [zoom, view.start, span, m.durationSec])

  useEffect(() => {
    const cv = canvas.current
    if (!cv || !width) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = width * dpr
    cv.height = H * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, H)
    const x = (t: number) => ((t - view.start) / span) * width
    const perf = ev.perf
    // deck lanes: each track occupies its deck from first audible to splice-out
    perf.tracks.forEach((tr, i) => {
      const a = x(ev.trackStart(i))
      const tout = perf.transitions[i]
      const b = x(tout ? tout.mixStartSec + tout.durationSec : perf.durationSec)
      if (b < 0 || a > width) return
      const y = tr.deck === 'A' ? LANE_A : LANE_B
      g.fillStyle = tr.deck === 'A' ? DECK_A : DECK_B
      g.beginPath()
      g.roundRect(a, y, Math.max(2, b - a - 2), 12, 4)
      g.fill()
      if (b - a > 60) {
        g.fillStyle = '#151413'
        g.font = '600 8.5px "Inter Tight", system-ui, sans-serif'
        const label = `${i + 1}  ${tr.title}`
        g.save()
        g.beginPath()
        g.rect(a + 4, y, b - a - 8, 12)
        g.clip()
        g.fillText(label, a + 5, y + 9)
        g.restore()
      }
    })
    g.fillStyle = 'rgba(163,155,143,0.8)'
    g.font = '600 8px "Inter Tight", system-ui, sans-serif'
    // overlaps (transition regions)
    for (const tt of perf.transitions) {
      const a = x(tt.mixStartSec)
      const b = x(tt.mixStartSec + tt.durationSec)
      if (b < 0 || a > width) continue
      g.fillStyle = '#e8b04a22'
      g.fillRect(a, WAVE_TOP - 4, Math.max(2, b - a), H - WAVE_TOP + 4)
    }
    // rendered waveform
    const w = m.waveform
    const per = w.secPerBucket
    const mid = WAVE_TOP + (H - WAVE_TOP - 18) / 2
    const amp = (H - WAVE_TOP - 18) / 2
    g.fillStyle = '#ffffff13'
    g.fillRect(0, Math.round(mid), width, 1)
    const wavePaint = g.createLinearGradient(0, WAVE_TOP, 0, H - 18)
    wavePaint.addColorStop(0, '#c2b196')
    wavePaint.addColorStop(0.5, '#eee1c9')
    wavePaint.addColorStop(1, '#8d7f6c')
    for (let px = 0; px < width; px++) {
      const ta = view.start + (px / width) * span
      const tb = view.start + ((px + 1) / width) * span
      let lo = 0
      let hi = 0
      for (let k = Math.max(0, Math.floor(ta / per)); k < Math.min(w.min.length, Math.ceil(tb / per)); k++) {
        if (w.min[k] < lo) lo = w.min[k]
        if (w.max[k] > hi) hi = w.max[k]
      }
      g.fillStyle = wavePaint
      const y0 = mid - (hi / 127) * amp
      const y1 = mid - (lo / 127) * amp
      g.fillRect(px, y0, 1, Math.max(1, y1 - y0))
    }
    // bar grid of the audible deck (zoomed views only)
    if (zoom && span <= 120) {
      let lastBar: number | null = null
      for (let t = view.start; t < view.end; t += 0.02) {
        const s = ev.evaluate(t)
        const d = s.ch.A.gain >= s.ch.B.gain ? 'A' : 'B'
        const st = s.deck[d]
        const g0 = st.track == null ? undefined : perf.tracks[st.track].grid
        if (st.beat == null || !g0 || !st.playing) {
          lastBar = null
          continue
        }
        const bar = Math.floor((st.beat - g0.downbeatPhase) / 4)
        if (lastBar != null && bar !== lastBar) {
          g.fillStyle = bar % 4 === 0 ? 'rgba(236,230,220,0.30)' : 'rgba(236,230,220,0.10)'
          g.fillRect(Math.round(x(t)), WAVE_TOP, 1, H - WAVE_TOP - 18)
        }
        lastBar = bar
      }
    }
    // transition cue markers + technique labels
    g.font = '600 9.5px "Inter Tight", system-ui, sans-serif'
    let labelEnd = -Infinity
    for (const tt of perf.transitions) {
      const a = x(tt.mixStartSec)
      if (a < -100 || a > width + 10) continue
      g.fillStyle = OVERLAP
      g.fillRect(Math.round(a), WAVE_TOP - 4, 1, H - WAVE_TOP - 14)
      g.beginPath()
      g.moveTo(a - 4, WAVE_TOP - 4)
      g.lineTo(a + 4, WAVE_TOP - 4)
      g.lineTo(a, WAVE_TOP + 2)
      g.fill()
      const label = tt.label
      const lw = g.measureText(label).width
      if (a + 4 > labelEnd + 8 && a + 4 + lw < width) {
        g.fillStyle = 'rgba(236,230,220,0.85)'
        g.fillText(label, a + 4, H - 4)
        labelEnd = a + 4 + lw
      }
    }
    // drops
    for (const d of drops) {
      const a = x(d.t)
      if (a < 0 || a > width) continue
      g.fillStyle = DROP
      const y = mid + amp + 6
      g.beginPath()
      g.moveTo(a, y - 3)
      g.lineTo(a + 3, y)
      g.lineTo(a, y + 3)
      g.lineTo(a - 3, y)
      g.closePath()
      g.fill()
    }
  }, [m, ev, width, view.start, view.end, span, zoom, drops])

  const timeAt = useCallback(
    (clientX: number) => {
      const r = wrap.current!.getBoundingClientRect()
      return Math.max(0, Math.min(m.durationSec, view.start + ((clientX - r.left) / r.width) * span))
    },
    [m.durationSec, view.start, span],
  )

  return (
    <section aria-label="Waveform and deck timeline" className="grid min-w-0 gap-3 rounded-2xl border border-border bg-card p-2.5 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <ul aria-label="Timeline legend" className="flex min-w-0 flex-wrap gap-1.5 text-[11px] text-foreground sm:text-xs">
          {[
            ['Deck A', DECK_A],
            ['Deck B', DECK_B],
            ['Overlap', OVERLAP],
            ['Drop', DROP],
          ].map(([label, color]) => (
            <li key={label} className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-2 py-1 sm:px-2.5">
              <span aria-hidden className={label === 'Drop' ? 'size-1.5 rotate-45 rounded-[1px]' : 'h-1.5 w-2.5 rounded-full'} style={{ backgroundColor: color }} />
              {label}
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-pressed={!!zoom}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 text-xs font-medium text-foreground hover:border-primary/40 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            const t = timeRef.current
            const start = Math.max(0, Math.min(t - 15, m.durationSec - 60))
            setZoom(zoom ? null : { start, end: Math.min(m.durationSec, start + 60) })
          }}
        >
          {zoom ? <ZoomOut aria-hidden className="size-3.5" /> : <ZoomIn aria-hidden className="size-3.5" />}
          {zoom ? 'Show whole mix' : 'Zoom in'}
        </button>
      </div>
      <div
        ref={wrap}
        className="relative w-full min-w-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-[#100f0e] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height: H }}
        role="slider"
        tabIndex={0}
        aria-label="Mix timeline — click to seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(m.durationSec)}
        aria-valuetext={fmtTime(timeRef.current)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSeek(Math.min(m.durationSec, timeRef.current + 5))
          else if (e.key === 'ArrowLeft') onSeek(Math.max(0, timeRef.current - 5))
          else return
          e.preventDefault()
        }}
        onClick={(e) => {
          const t = timeAt(e.clientX)
          const r = wrap.current!.getBoundingClientRect()
          const y = e.clientY - r.top
          // clicking a technique label opens its details
          if (y > H - 16) {
            const hit = ev.perf.transitions.find((tt) => Math.abs(tt.mixStartSec - t) < span * 0.02 || (t >= tt.mixStartSec && t <= tt.mixStartSec + span * 0.08))
            if (hit) return onPickTransition(hit.index)
          }
          onSeek(t)
        }}
      >
        <div ref={played} className="pointer-events-none absolute inset-y-0 left-0 bg-[rgba(236,230,220,0.06)]" />
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
        <div ref={head} className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_8px_rgba(232,176,74,0.65)]" />
      </div>
      <div aria-hidden className="flex justify-between px-0.5 text-[11px] tabular-nums text-muted-foreground">
        {[0, 0.25, 0.5, 0.75, 1].map((position) => (
          <span key={position}>{fmtTime(view.start + position * (view.end - view.start))}</span>
        ))}
      </div>
    </section>
  )
})
