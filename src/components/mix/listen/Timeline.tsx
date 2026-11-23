/**
 * Mix timeline: the RENDERED audio's own peaks (manifest.waveform), with the two deck lanes
 * (which deck holds which track, and where they overlap), transition regions labelled with the
 * executed technique, cue points, drops mapped to mix time through the performance evaluator,
 * and — when zoomed — the bar grid of the audible deck. The static layer is drawn once per size /
 * zoom; only the playhead moves per frame (via `setPlayhead`).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { MixManifest } from '@/mixgen/manifest'
import type { PerformanceEvaluator } from '@/mixgen/performance'
import { fmtTime } from './mapping'

export interface TimelineHandle {
  setPlayhead(t: number): void
}

const H = 132
const LANE_A = 10
const LANE_B = 24
const WAVE_TOP = 40

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
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)))
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
      g.fillStyle = tr.deck === 'A' ? 'rgba(236,230,220,0.55)' : 'rgba(163,155,143,0.55)'
      g.beginPath()
      g.roundRect(a, y, Math.max(2, b - a - 1), 9, 3)
      g.fill()
      if (b - a > 60) {
        g.fillStyle = '#151413'
        g.font = '600 8.5px "Inter Tight", system-ui, sans-serif'
        const label = `${i + 1}  ${tr.title}`
        g.save()
        g.beginPath()
        g.rect(a + 4, y, b - a - 8, 9)
        g.clip()
        g.fillText(label, a + 5, y + 7.5)
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
      g.fillStyle = 'rgba(232,176,74,0.10)'
      g.fillRect(a, WAVE_TOP - 4, Math.max(2, b - a), H - WAVE_TOP + 4)
    }
    // rendered waveform
    const w = m.waveform
    const per = w.secPerBucket
    const mid = WAVE_TOP + (H - WAVE_TOP - 18) / 2
    const amp = (H - WAVE_TOP - 18) / 2
    for (let px = 0; px < width; px++) {
      const ta = view.start + (px / width) * span
      const tb = view.start + ((px + 1) / width) * span
      let lo = 0
      let hi = 0
      for (let k = Math.max(0, Math.floor(ta / per)); k < Math.min(w.min.length, Math.ceil(tb / per)); k++) {
        if (w.min[k] < lo) lo = w.min[k]
        if (w.max[k] > hi) hi = w.max[k]
      }
      g.fillStyle = 'rgba(163,155,143,0.75)'
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
      g.fillStyle = '#e8b04a'
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
      g.fillStyle = '#e5604d'
      g.beginPath()
      g.arc(a, mid + amp + 6, 2.5, 0, Math.PI * 2)
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
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-4 rounded-sm bg-[rgba(236,230,220,0.55)]" />Deck A</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-4 rounded-sm bg-[rgba(163,155,143,0.55)]" />Deck B</span>
          <span className="hidden items-center gap-1.5 sm:inline-flex"><i className="inline-block h-2 w-4 rounded-sm bg-[rgba(232,176,74,0.35)]" />Overlap</span>
          <span className="hidden items-center gap-1.5 sm:inline-flex"><i className="inline-block size-2 rounded-full bg-[#e5604d]" />Drop</span>
        </div>
        <button
          type="button"
          className="rounded-full px-3 py-1 text-foreground hover:bg-accent"
          onClick={() => {
            const t = timeRef.current
            setZoom(zoom ? null : { start: Math.max(0, t - 15), end: Math.min(m.durationSec, Math.max(0, t - 15) + 60) })
          }}
        >
          {zoom ? 'Show whole mix' : 'Zoom in'}
        </button>
      </div>
      <div
        ref={wrap}
        className="relative w-full cursor-pointer overflow-hidden rounded-xl bg-[#100f0e] outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div ref={head} className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground shadow-[0_0_8px_rgba(236,230,220,0.6)]" />
      </div>
      {zoom && (
        <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{fmtTime(view.start)}</span>
          <span>{fmtTime(view.end)}</span>
        </div>
      )}
    </div>
  )
})
