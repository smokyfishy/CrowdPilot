/**
 * Mix player: the waveform is drawn from the RENDERED audio's own peaks (manifest.waveform,
 * measured by the renderer's MixAnalyzer on the exact output samples). Track segments,
 * overlap regions, transition boundaries, cue markers, energy curve and the playhead are
 * all positioned from the renderer's manifest timestamps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { MixManifest, ManifestTransition } from '@/mixgen/manifest'
import { TransitionInspector } from './TransitionInspector'
import { MlDiagnostics } from './MlDiagnostics'

const SEG_COLORS = ['#c9842e', '#7f9c8a', '#b5654a', '#8a87b8', '#c2a35a', '#5f8fa8', '#a8708f', '#8fa35f']

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function Waveform({ m, time, onSeek, onPickTransition, zoom }: { m: MixManifest; time: number; onSeek: (t: number) => void; onPickTransition: (t: ManifestTransition) => void; zoom: { start: number; end: number } }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const H = 168
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const span = zoom.end - zoom.start
  const x = useCallback((t: number) => ((t - zoom.start) / span) * width, [zoom.start, span, width])
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = H * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, H)
    const mid = 92
    const amp = 62
    // track segment bands (main region) and overlap regions
    m.tracks.forEach((t, i) => {
      const a = x(t.mixInSec)
      const b = x(t.mixOutSec)
      if (b < 0 || a > width) return
      g.fillStyle = SEG_COLORS[i % SEG_COLORS.length] + '1f'
      g.fillRect(a, 18, b - a, H - 18)
      g.fillStyle = SEG_COLORS[i % SEG_COLORS.length]
      g.fillRect(a, 8, Math.max(1, b - a), 4)
    })
    for (const tr of m.transitions) {
      const a = x(tr.mixStartSec)
      const b = x(tr.mixEndSec)
      if (b < 0 || a > width) continue
      g.fillStyle = 'rgba(232,211,168,0.10)'
      g.fillRect(a, 18, Math.max(2, b - a), H - 18)
    }
    // waveform from rendered peaks
    const w = m.waveform
    const per = w.secPerBucket
    const i0 = Math.max(0, Math.floor(zoom.start / per))
    const i1 = Math.min(w.min.length, Math.ceil(zoom.end / per))
    const playedX = x(time)
    for (let px = 0; px < width; px++) {
      const ta = zoom.start + (px / width) * span
      const tb = zoom.start + ((px + 1) / width) * span
      let lo = 0
      let hi = 0
      for (let k = Math.max(i0, Math.floor(ta / per)); k < Math.min(i1, Math.ceil(tb / per)); k++) {
        if (w.min[k] < lo) lo = w.min[k]
        if (w.max[k] > hi) hi = w.max[k]
      }
      g.fillStyle = px < playedX ? '#e8d3a8' : '#8b847a'
      const y0 = mid - (hi / 127) * amp
      const y1 = mid - (lo / 127) * amp
      g.fillRect(px, y0, 1, Math.max(1, y1 - y0))
    }
    // energy curve (measured RMS per second of the render)
    const e = m.energy.rmsDb
    if (e.length > 1) {
      g.strokeStyle = 'rgba(201,132,46,0.9)'
      g.lineWidth = 1.5
      g.beginPath()
      let started = false
      for (let s = Math.max(0, Math.floor(zoom.start)); s < Math.min(e.length, Math.ceil(zoom.end)); s++) {
        const y = H - 6 - Math.max(0, Math.min(1, (e[s] + 40) / 34)) * 34
        if (!started) {
          g.moveTo(x(s + 0.5), y)
          started = true
        } else g.lineTo(x(s + 0.5), y)
      }
      g.stroke()
    }
    // transition boundaries + cue markers
    for (const tr of m.transitions) {
      const a = x(tr.mixStartSec)
      const b = x(tr.mixEndSec)
      g.fillStyle = '#e8d3a8'
      g.fillRect(a, 18, 1, H - 18)
      if (b - a > 3) g.fillRect(b, 18, 1, H - 18)
      // cue triangles
      g.beginPath()
      g.moveTo(a - 5, 18)
      g.lineTo(a + 5, 18)
      g.lineTo(a, 26)
      g.closePath()
      g.fill()
      for (const fx of tr.effects) {
        if (fx.kind === 'tempo') continue
        g.fillStyle = 'rgba(181,101,74,0.85)'
        g.fillRect(x(fx.startSec), H - 46, Math.max(2, x(fx.endSec) - x(fx.startSec)), 3)
      }
    }
    // track start labels
    g.font = '11px Inter Tight, system-ui, sans-serif'
    m.tracks.forEach((t, i) => {
      const a = x(i === 0 ? t.mixInSec : t.mixMainSec)
      if (a < -40 || a > width) return
      g.fillStyle = '#d9d2c5'
      g.fillText(String(i + 1), a + 3, 32)
    })
    // playhead
    g.fillStyle = '#ffffff'
    g.fillRect(playedX - 0.5, 0, 2, H)
  }, [m, time, width, x, span, zoom.start, zoom.end])

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(m.durationSec, zoom.start + ((clientX - r.left) / r.width) * span))
  }
  return (
    <div ref={wrap} className="relative w-full select-none">
      <canvas
        ref={ref}
        style={{ width: '100%', height: H }}
        className="cursor-pointer rounded-lg bg-[#171513]"
        role="slider"
        aria-label="Mix waveform — click to seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(m.durationSec)}
        aria-valuenow={Math.round(time)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSeek(Math.min(m.durationSec, time + 5))
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, time - 5))
        }}
        onClick={(e) => {
          const t = timeAt(e.clientX)
          const hit = m.transitions.find((tr) => e.nativeEvent.offsetY < 30 && Math.abs(x(tr.mixStartSec) - e.nativeEvent.offsetX) < 8)
          if (hit) onPickTransition(hit)
          else onSeek(t)
        }}
      />
    </div>
  )
}

export function MixPlayer({ manifest: m, audioSrc, downloadUrl }: { manifest: MixManifest; audioSrc: string | null; downloadUrl?: string | null }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pick, setPick] = useState<ManifestTransition | null>(null)
  const [zoomed, setZoomed] = useState<{ start: number; end: number } | null>(null)
  const [audioError, setAudioError] = useState<string | null>(null)
  useEffect(() => {
    const a = audio.current
    if (!a) return
    let raf = 0
    const tick = () => {
      setTime(a.currentTime)
      raf = requestAnimationFrame(tick)
    }
    const on = () => {
      setPlaying(true)
      raf = requestAnimationFrame(tick)
    }
    const off = () => {
      setPlaying(false)
      cancelAnimationFrame(raf)
      setTime(a.currentTime)
    }
    a.addEventListener('play', on)
    a.addEventListener('pause', off)
    a.addEventListener('ended', off)
    a.addEventListener('seeked', () => setTime(a.currentTime))
    return () => {
      cancelAnimationFrame(raf)
      a.removeEventListener('play', on)
      a.removeEventListener('pause', off)
      a.removeEventListener('ended', off)
    }
  }, [audioSrc])
  const seek = (t: number) => {
    const a = audio.current
    if (a) a.currentTime = t
    setTime(t)
  }
  const currentIdx = useMemo(() => {
    let k = 0
    m.tracks.forEach((t, i) => {
      if (time >= (i === 0 ? 0 : t.mixMainSec - (t.mixMainSec - t.mixInSec) / 2)) k = i
    })
    return k
  }, [m, time])
  const startOf = (i: number) => (i === 0 ? 0 : (m.tracks[i].mixInSec + m.tracks[i].mixMainSec) / 2)
  const zoom = zoomed ?? { start: 0, end: m.durationSec }
  const bpms = m.bpmRange
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="font-display text-[clamp(2rem,5vw,3.25rem)] leading-none text-foreground">{m.title}</h1>
        <p className="max-w-[75ch] text-muted-foreground">{m.description}</p>
        <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div><dt className="inline">Duration </dt><dd className="inline font-semibold tabular-nums text-foreground">{fmtTime(m.durationSec)}</dd></div>
          <div><dt className="inline">Tracks </dt><dd className="inline font-semibold text-foreground">{m.tracks.length}</dd></div>
          <div><dt className="inline">BPM </dt><dd className="inline font-semibold tabular-nums text-foreground">{bpms[0]}–{bpms[1]}</dd></div>
          <div><dt className="inline">Genres </dt><dd className="inline font-semibold text-foreground">{m.genres.join(', ')}</dd></div>
          <div><dt className="inline">Loudness </dt><dd className="inline font-semibold tabular-nums text-foreground">{m.metrics.integratedLufs} LUFS</dd></div>
        </dl>
      </header>

      <section aria-label="Player" className="grid gap-3 rounded-xl border border-border bg-card p-4">
        {audioSrc ? (
          <audio ref={audio} src={audioSrc} preload="auto" onError={() => setAudioError('The mix audio could not be loaded.')} />
        ) : (
          <p className="text-sm text-muted-foreground">Audio is not stored for this mix (see download permissions below).</p>
        )}
        {audioError && <p className="text-sm text-destructive">{audioError}</p>}
        <Waveform m={m} time={time} onSeek={seek} onPickTransition={setPick} zoom={zoom} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" aria-label="Previous track" className="grid size-10 place-items-center rounded-full border border-border hover:bg-accent" onClick={() => seek(startOf(Math.max(0, currentIdx - (time - startOf(currentIdx) > 3 ? 0 : 1))))}>
            <SkipBack className="size-4" />
          </button>
          <button
            type="button"
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!audioSrc}
            data-testid="mix-play"
            className="grid size-12 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
          >
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <button type="button" aria-label="Next track" className="grid size-10 place-items-center rounded-full border border-border hover:bg-accent" onClick={() => seek(startOf(Math.min(m.tracks.length - 1, currentIdx + 1)))}>
            <SkipForward className="size-4" />
          </button>
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={m.durationSec}
            step={0.1}
            value={time}
            onChange={(e) => seek(Number(e.target.value))}
            className="min-w-40 flex-1 accent-[var(--color-primary,#c9842e)]"
          />
          <span className="tabular-nums text-sm text-muted-foreground" data-testid="mix-time">
            {fmtTime(time)} / {fmtTime(m.durationSec)}
          </span>
          <button type="button" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-accent" onClick={() => setZoomed(zoomed ? null : { start: Math.max(0, time - 45), end: Math.min(m.durationSec, time + 45) })}>
            {zoomed ? 'Full mix' : 'Zoom ±45 s'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Now: <span className="text-foreground">{m.tracks[currentIdx]?.artist} – {m.tracks[currentIdx]?.title}</span>. Shaded areas are overlaps; ▼ marks a transition (click it to inspect). The orange line is the measured loudness of the render.
        </p>
      </section>

      {pick && <TransitionInspector t={pick} onClose={() => setPick(null)} onSeek={(s) => seek(s)} />}

      <section aria-labelledby="tracklist">
        <h2 id="tracklist" className="font-display text-2xl text-foreground">Tracklist</h2>
        <ol className="mt-3 divide-y divide-border rounded-xl border border-border">
          {m.tracks.map((t, i) => {
            const tr = m.transitions[i]
            return (
              <li key={t.key} className={`grid gap-1 px-4 py-3 sm:grid-cols-[3.5rem_1fr_auto] sm:items-center ${i === currentIdx ? 'bg-accent/50' : ''}`}>
                <button type="button" className="text-left font-semibold tabular-nums text-primary hover:underline" onClick={() => seek(startOf(i))} data-testid={`track-seek-${i}`}>
                  {fmtTime(startOf(i))}
                </button>
                <div className="min-w-0">
                  <button type="button" className="block max-w-full truncate text-left font-medium text-foreground hover:underline" onClick={() => seek(startOf(i))}>
                    {i + 1}. {t.artist} – {t.title}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {t.bpm} BPM{t.bpmConfidence < 0.3 ? ' (low confidence)' : ''} · {t.key_} ({t.camelot}) · {t.source}
                    {t.url && (
                      <>
                        {' · '}
                        <a href={t.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">source</a>
                      </>
                    )}{' '}
                    · {t.license.label}
                  </p>
                </div>
                {tr ? (
                  <button type="button" className="justify-self-start rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent sm:justify-self-end" onClick={() => setPick(tr)}>
                    → {tr.label}
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground sm:justify-self-end">closer</span>
                )}
              </li>
            )
          })}
        </ol>
      </section>

      <section aria-labelledby="quality" className="grid gap-2 text-sm text-muted-foreground">
        <h2 id="quality" className="font-display text-2xl text-foreground">Audio checks</h2>
        <ul className="grid gap-1 sm:grid-cols-2">
          {m.validation?.checks.map((c) => (
            <li key={c.name}>
              <span className={c.ok ? 'text-emerald-400' : 'text-destructive'}>{c.ok ? '✓' : '✗'}</span> {c.name}: <span className="tabular-nums text-foreground">{c.value}</span>
            </li>
          ))}
        </ul>
        {m.unavailable.length > 0 && (
          <div className="mt-2 rounded-lg border border-border p-3">
            <p className="font-medium text-foreground">Requested but not available for mixing</p>
            <ul className="mt-1 list-disc pl-5">
              {m.unavailable.map((u) => (
                <li key={u.request}>
                  <span className="text-foreground">{u.request}</span>: {u.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {downloadUrl && m.permissions.export ? (
            <a href={downloadUrl} download={`${m.title}.opus`} className="inline-flex h-10 items-center rounded-full bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90">
              Download mix
            </a>
          ) : null}
          <span>{m.permissions.reason}</span>
        </div>
        <MlDiagnostics m={m} />
        <details className="mt-2">
          <summary className="cursor-pointer text-foreground">Attribution</summary>
          <ul className="mt-2 grid gap-1">
            {m.attribution.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  )
}
