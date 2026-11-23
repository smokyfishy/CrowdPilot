/**
 * Virtual two-deck DJ controller — a READ-ONLY visual replay of the rendered performance.
 *
 * React renders the board once per deck/track change. Every animation frame, ControllerAnimator
 * writes the evaluated performance state (src/mixgen/performance.ts, evaluated at the audio
 * element's time) straight into CSS custom properties / attributes / canvases. No control here
 * changes the audio, so none of them are interactive form controls; screen readers get a live
 * summary instead (see ListenView).
 */
import { memo, useEffect, useRef } from 'react'
import { decode63, type ControllerState, type DeckId, type PerfTrack, type PerformanceManifest } from '@/mixgen/performance'
import { eqAngle, faderPos, filterAngle, fmtClock, fmtPct, KNOB_SWEEP, meterFill, platterAngle, sendAngle, tempoPos, trimAngle } from './mapping'
import './controller.css'

// ───────────────────────── markup ─────────────────────────

function arcPath(a0: number, a1: number, r = 24, c = 25): string {
  if (Math.abs(a1 - a0) < 0.5) return ''
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180
    return `${(c + r * Math.cos(rad)).toFixed(2)} ${(c + r * Math.sin(rad)).toFixed(2)}`
  }
  const [s, e] = a0 < a1 ? [a0, a1] : [a1, a0]
  return `M ${p(s)} A ${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${p(e)}`
}

function Knob({ k, label }: { k: string; label: string }) {
  return (
    <div className="cp-knobcell">
      <div className="cp-knob" data-k={k}>
        <svg viewBox="0 0 50 50" aria-hidden>
          <path className="arc-bg" d={arcPath(-KNOB_SWEEP, KNOB_SWEEP)} fill="none" strokeWidth="2.5" strokeLinecap="round" />
          <path className="arc" d="" fill="none" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="cp-cap" />
      </div>
      <span className="cp-silk">{label}</span>
    </div>
  )
}

const DeckHead = memo(function DeckHead({ track, deck }: { track: PerfTrack | null; deck: DeckId }) {
  return (
    <div className="cp-trackhead cp-span">
      <div className="cp-art" style={track?.artworkUrl ? { backgroundImage: `url("${track.artworkUrl}")` } : undefined} aria-hidden>
        {!track?.artworkUrl && deck}
      </div>
      <div className="min-w-0">
        <div className="cp-title">{track ? track.title : 'No track loaded'}</div>
        <div className="cp-artist">{track ? track.artist : `Deck ${deck}`}</div>
        <div className="cp-role" data-k={`${deck}.role`} />
      </div>
      <div className="cp-readout">
        <div className="cp-bpm" data-k={`${deck}.bpm`} />
        <div className="cp-key">{track ? `${track.camelot} · ${track.musicalKey}` : ''}</div>
      </div>
    </div>
  )
})

function Deck({ deck, track, hasPeaks }: { deck: DeckId; track: PerfTrack | null; hasPeaks: boolean }) {
  return (
    <section className="cp-deck" data-deck={deck} aria-label={`Deck ${deck}`}>
      <DeckHead track={track} deck={deck} />
      <div className="cp-wave cp-span" data-k={`${deck}.wavebox`} data-empty={hasPeaks ? '0' : '1'}>
        {hasPeaks ? <canvas data-k={`${deck}.wave`} /> : <p className="grid h-full place-items-center px-3 text-center text-[11px] text-muted-foreground">Track waveform wasn't recorded for this mix</p>}
      </div>
      <div className="cp-overview cp-span">
        {hasPeaks && <canvas data-k={`${deck}.ov`} />}
        <i data-k={`${deck}.ovpos`} />
      </div>
      <div className="cp-jogwrap">
        <div className="cp-jog" data-k={`${deck}.jog`}>
          <div className="cp-progress" data-k={`${deck}.progress`} />
          <div className="cp-platter" data-k={`${deck}.platter`} />
          <div className="cp-hub">
            <span className="cp-hub-time" data-k={`${deck}.time`} />
            <span className="cp-beats" data-k={`${deck}.beats`} aria-hidden>
              <b />
              <b />
              <b />
              <b />
            </span>
          </div>
        </div>
      </div>
      <div className="cp-tempo" data-k={`${deck}.tempo`}>
        <span className="cp-silk">Tempo</span>
        <div className="cp-tempo-slot">
          <div className="cp-tempo-cap" />
        </div>
        <span className="cp-tempo-val" data-k={`${deck}.tempoval`} />
      </div>
      <div className="cp-controls cp-span">
        <div className="cp-transport">
          <div className="cp-btn" data-k={`${deck}.cue`}>CUE</div>
          <div className="cp-btn" data-k={`${deck}.play`} aria-hidden>
            <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M0 0l7 6-7 6z" /><rect x="10" y="0" width="2" height="12" /><rect x="14" y="0" width="2" height="12" /></svg>
          </div>
        </div>
        <div className="cp-toggles">
          <div className="cp-tog" data-k={`${deck}.sync`}>SYNC</div>
          <div className="cp-tog" data-k={`${deck}.keylock`}>KEY LOCK</div>
          <div className="cp-tog" data-k={`${deck}.loop`} />
        </div>
        <div className="cp-pads">
          <div className="cp-pads-head">
            <span className="cp-silk" data-k={`${deck}.padmode`} />
            <span className="cp-silk" data-k={`${deck}.padinfo`} />
          </div>
          <div className="cp-pad-grid" data-k={`${deck}.pads`}>
            <div className="cp-pad" />
            <div className="cp-pad" />
            <div className="cp-pad" />
            <div className="cp-pad" />
          </div>
        </div>
      </div>
    </section>
  )
}

function Channel({ ch, stems }: { ch: DeckId; stems: boolean }) {
  return (
    <div className="cp-ch" aria-label={`Channel ${ch === 'A' ? 1 : 2}`}>
      <span className="cp-silk" style={{ color: 'var(--bone)' }}>{ch === 'A' ? '1' : '2'}</span>
      <Knob k={`${ch}.trim`} label="Trim" />
      <Knob k={`${ch}.hi`} label="Hi" />
      <Knob k={`${ch}.mid`} label="Mid" />
      <Knob k={`${ch}.low`} label="Low" />
      <div className="cp-pair">
        <Knob k={`${ch}.filter`} label="Filter" />
        <Knob k={`${ch}.echo`} label="Echo" />
      </div>
      <div className="cp-leds">
        <span className="cp-led" data-k={`${ch}.ledecho`}>ECHO</span>
        <span className="cp-led" data-k={`${ch}.ledverb`}>VERB</span>
      </div>
      {stems && (
        <div className="cp-stems" data-k={`${ch}.stems`}>
          <span className="cp-silk">Voc</span>
          <span className="cp-stem"><i data-k={`${ch}.stemv`} /></span>
          <span className="cp-silk">Inst</span>
          <span className="cp-stem"><i data-k={`${ch}.stemi`} /></span>
        </div>
      )}
    </div>
  )
}

export interface DeckAssignment {
  A: number | null
  B: number | null
}

export function DjController({ perf, decks, onReady }: { perf: PerformanceManifest; decks: DeckAssignment; onReady: (root: HTMLElement | null) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const usesStems = perf.transitions.some((t) => t.in.stems || t.out.stems)
  const hasPeaks = !!perf.peaks
  const hasDeckLevels = !!perf.levels?.A
  useEffect(() => {
    onReady(root.current)
    return () => onReady(null)
    // re-register when the deck markup changes so the animator re-binds its elements
  }, [decks.A, decks.B, onReady])
  return (
    <div ref={root} className="cp-board" aria-hidden>
      <Deck deck="A" track={decks.A == null ? null : perf.tracks[decks.A]} hasPeaks={hasPeaks} />
      <section className="cp-mixer" aria-label="Mixer">
        <div className="cp-phase" data-k="phase">
          <div className="flex items-baseline justify-between">
            <span className="cp-silk">Beat phase</span>
            <span className="cp-silk" data-k="phaseinfo" />
          </div>
          <div className="cp-phase-row" data-k="A.ph"><span /><span /><span /><span /><i /></div>
          <div className="cp-phase-row" data-k="B.ph"><span /><span /><span /><span /><i /></div>
        </div>
        <Channel ch="A" stems={usesStems} />
        <div className="cp-mid">
          <span className="cp-silk">Master</span>
          <div className="cp-vu" data-k="M.vu" data-na={perf.levels ? '0' : '1'} style={{ height: 180 }} />
          <span className="cp-silk" data-k="M.db" />
        </div>
        <Channel ch="B" stems={usesStems} />
        <div className="cp-faderrow">
          <div className="cp-fadercell">
            <div className="cp-vu" data-k="A.vu" data-na={hasDeckLevels ? '0' : '1'} />
            <div className="cp-fader" data-k="A.fader"><div className="cp-ticks" /><div className="cp-fader-slot" /><div className="cp-fader-cap" /></div>
          </div>
          <span />
          <div className="cp-fadercell">
            <div className="cp-fader" data-k="B.fader"><div className="cp-ticks" /><div className="cp-fader-slot" /><div className="cp-fader-cap" /></div>
            <div className="cp-vu" data-k="B.vu" data-na={hasDeckLevels ? '0' : '1'} />
          </div>
        </div>
        <div className="cp-xf">
          <div className="cp-xf-slot"><div className="cp-xf-cap" /></div>
          <span className="cp-xf-note">Crossfader not used · both channels on THRU, mixed with the channel faders</span>
        </div>
      </section>
      <Deck deck="B" track={decks.B == null ? null : perf.tracks[decks.B]} hasPeaks={hasPeaks} />
    </div>
  )
}

// ───────────────────────── animator ─────────────────────────

interface Peaks {
  amp: Uint8Array
  low: Uint8Array
}

const LIVE_HOLD = 0.35 // s a control stays amber after it last moved

/**
 * Applies a ControllerState to the board's DOM. Keeps previous values to (a) skip DOM writes when
 * nothing changed and (b) light the controls that are moving now (amber) — movement is measured
 * on the evaluated values, so a control lights only when the rendered automation changed it.
 */
export class ControllerAnimator {
  private el = new Map<string, HTMLElement>()
  private prev = new Map<string, number | string>()
  private liveUntil = new Map<string, number>()
  private peaks = new Map<string, Peaks>()
  private canvasSize = new Map<HTMLCanvasElement, { w: number; h: number }>()
  private lastT = -1
  private ro: ResizeObserver | null = null
  private ovDrawn = new Map<DeckId, number | null>()

  constructor(
    private root: HTMLElement,
    private perf: PerformanceManifest,
    private reduced: boolean,
  ) {
    root.dataset.reduced = reduced ? '1' : '0'
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => this.el.set(e.dataset.k!, e))
    if (perf.peaks) for (const [k, v] of Object.entries(perf.peaks.tracks)) this.peaks.set(k, { amp: decode63(v.amp), low: decode63(v.low) })
    this.ro = new ResizeObserver(() => {
      this.canvasSize.clear()
      this.ovDrawn.clear()
      this.prev.clear()
    })
    this.ro.observe(root)
  }

  dispose(): void {
    this.ro?.disconnect()
  }

  private set(key: string, prop: string, value: number, digits = 3): boolean {
    const id = `${key}|${prop}`
    const v = Number(value.toFixed(digits))
    if (this.prev.get(id) === v) return false
    this.prev.set(id, v)
    this.el.get(key)?.style.setProperty(prop, String(v) + (prop === '--a' || prop === '--rot' ? 'deg' : ''))
    return true
  }
  private attr(key: string, name: string, value: string): void {
    const id = `${key}@${name}`
    if (this.prev.get(id) === value) return
    this.prev.set(id, value)
    this.el.get(key)?.setAttribute(name, value)
  }
  private text(key: string, value: string): void {
    const id = `${key}#`
    if (this.prev.get(id) === value) return
    this.prev.set(id, value)
    const e = this.el.get(key)
    if (e) e.textContent = value
  }
  /** Marks `key` live if its value moved by more than `eps` since the last frame. */
  private track(key: string, value: number, eps: number, t: number, seeking: boolean): boolean {
    const id = `${key}~`
    const p = this.prev.get(id) as number | undefined
    this.prev.set(id, value)
    if (!seeking && p !== undefined && Math.abs(value - p) > eps) this.liveUntil.set(key, t + LIVE_HOLD)
    const live = (this.liveUntil.get(key) ?? -1) > t
    this.attr(key, 'data-live', live ? '1' : '0')
    return live
  }

  private knob(key: string, angle: number, from: number, t: number, seeking: boolean, opts: { kill?: boolean; dead?: boolean } = {}) {
    this.set(key, '--a', angle, 1)
    this.track(key, angle, 0.04, t, seeking)
    const e = this.el.get(key)
    const arcId = `${key}|arc`
    const d = opts.dead ? '' : arcPath(from, angle)
    if (this.prev.get(arcId) !== d) {
      this.prev.set(arcId, d)
      e?.querySelector('.arc')?.setAttribute('d', d)
    }
    this.attr(key, 'data-kill', opts.kill ? '1' : '0')
    this.attr(key, 'data-dead', opts.dead ? '1' : '0')
  }

  apply(s: ControllerState): void {
    const t = s.t
    const seeking = this.lastT >= 0 && Math.abs(t - this.lastT) > 0.25
    this.lastT = t
    for (const d of ['A', 'B'] as const) this.applyDeck(d, s, seeking)
    this.applyMixer(s, seeking)
  }

  private applyDeck(d: DeckId, s: ControllerState, seeking: boolean) {
    const st = s.deck[d]
    const t = s.t
    const track = st.track == null ? null : this.perf.tracks[st.track]
    // jog wheel: rotation is the platter position itself (reverse spins run backwards)
    if (!this.reduced) this.set(`${d}.platter`, '--rot', track ? platterAngle(st.pos) : 0, 1)
    this.set(`${d}.progress`, '--prog', track ? Math.max(0, Math.min(1, st.pos / track.durationSec)) : 0, 4)
    this.attr(`${d}.jog`, 'data-playing', st.playing ? '1' : '0')
    const scratchy = st.perf === 'scratch' || st.perf === 'spinback' || st.perf === 'brake' || st.perf === 'roll' || st.perf === 'juggle'
    this.attr(`${d}.jog`, 'data-live', scratchy && st.playing ? '1' : '0')
    this.text(`${d}.time`, track ? fmtClock(-(track.durationSec - st.pos)) : '—')
    this.text(`${d}.role`, st.role === 'incoming' ? 'Mixing in' : st.role === 'outgoing' ? 'Mixing out' : st.role === 'cued' ? 'Cued' : st.role === 'solo' ? 'Playing' : track ? 'Stopped' : '')
    this.attr(`${d}.role`, 'data-role', st.role)
    this.text(`${d}.bpm`, st.bpm ? st.bpm.toFixed(1) : '—')
    // beat-in-bar dots from the track's own grid
    const beats = this.el.get(`${d}.beats`)
    if (beats) {
      const g = track?.grid
      const k = st.beat != null && g ? Math.floor(st.beat + 1e-6) : null
      const inBar = k != null && g ? (((k - g.downbeatPhase) % 4) + 4) % 4 : -1
      const key = `${d}.beats|v`
      const v = st.playing ? inBar : -1
      if (this.prev.get(key) !== v) {
        this.prev.set(key, v)
        beats.querySelectorAll('b').forEach((b, i) => b.setAttribute('data-on', i <= v && v >= 0 ? '1' : '0'))
      }
    }
    // tempo fader: the executed tempo-match ratio (incoming deck), pitch kept by key lock
    this.set(`${d}.tempo`, '--tp', -tempoPos(st.tempoPct), 4)
    this.track(`${d}.tempo`, st.tempoPct, 0.002, t, seeking)
    this.attr(`${d}.tempo`, 'data-shifted', Math.abs(st.tempoPct) > 0.01 ? '1' : '0')
    this.text(`${d}.tempoval`, fmtPct(st.tempoPct))
    this.attr(`${d}.play`, 'data-on', st.playing ? '1' : '0')
    this.attr(`${d}.cue`, 'data-on', st.role === 'cued' ? '1' : '0')
    this.attr(`${d}.cue`, 'data-live', st.pads.mode === 'hotcue' && st.pads.lit === 0 ? '1' : '0')
    this.attr(`${d}.sync`, 'data-on', st.sync ? '1' : '0')
    this.attr(`${d}.keylock`, 'data-on', st.keyLock ? '1' : '0')
    this.attr(`${d}.loop`, 'data-live', st.loop ? '1' : '0')
    this.text(`${d}.loop`, st.loop ? `LOOP ${st.loop.beats >= 1 ? st.loop.beats : `1/${Math.round(1 / st.loop.beats)}`}` : 'LOOP')
    // performance pads
    const modeName = { hotcue: 'Hot cue', roll: 'Beat roll', sampler: 'Sampler', pitch: 'Pitch play', juggle: 'Beat juggle' }[st.pads.mode]
    this.text(`${d}.padmode`, modeName)
    this.text(`${d}.padinfo`, st.semitones != null ? `${st.semitones > 0 ? '+' : ''}${st.semitones} st` : st.perf === 'brake' ? 'Brake' : st.perf === 'spinback' ? 'Spin-back' : st.perf === 'scratch' ? 'Scratch' : '')
    const pads = this.el.get(`${d}.pads`)
    if (pads) {
      const sig = `${st.pads.mode}|${st.pads.labels.join(',')}|${st.pads.lit}`
      const key = `${d}.pads|sig`
      if (this.prev.get(key) !== sig) {
        this.prev.set(key, sig)
        Array.from(pads.children).forEach((p, i) => {
          p.textContent = st.pads.labels[i] ?? ''
          p.setAttribute('data-on', i === st.pads.lit ? '1' : '0')
        })
      }
    }
    // waveforms
    if (track) {
      this.drawWave(d, track, st)
      this.drawOverview(d, track)
      this.set(`${d}.ovpos`, '--x', Math.max(0, Math.min(1, st.pos / track.durationSec)), 4)
    }
  }

  private applyMixer(s: ControllerState, seeking: boolean) {
    const t = s.t
    for (const d of ['A', 'B'] as const) {
      const c = s.ch[d]
      const loaded = s.deck[d].track != null
      this.knob(`${d}.trim`, trimAngle(c.trimDb), 0, t, seeking, { dead: !loaded })
      this.knob(`${d}.hi`, eqAngle(c.high), 0, t, seeking, { kill: c.high <= -39.9 })
      this.knob(`${d}.mid`, eqAngle(c.mid), 0, t, seeking, { kill: c.mid <= -39.9 })
      this.knob(`${d}.low`, eqAngle(c.low), 0, t, seeking, { kill: c.low <= -39.9 })
      this.knob(`${d}.filter`, filterAngle(c.filter), 0, t, seeking)
      this.knob(`${d}.echo`, sendAngle(c.echo ?? 0), -KNOB_SWEEP, t, seeking, { dead: c.echo == null })
      this.attr(`${d}.ledecho`, 'data-on', c.echo != null && c.echo > 0.001 ? '1' : c.echoTail ? 'tail' : '0')
      this.attr(`${d}.ledverb`, 'data-on', c.reverb != null && c.reverb > 0.001 ? '1' : '0')
      if (this.el.has(`${d}.stems`)) {
        this.set(`${d}.stemv`, '--v', c.stems ? c.stems.vocals : 0, 3)
        this.set(`${d}.stemi`, '--v', c.stems ? c.stems.inst : 0, 3)
        const lv = this.track(`${d}.stemv`, c.stems?.vocals ?? 0, 0.002, t, seeking)
        const li = this.track(`${d}.stemi`, c.stems?.inst ?? 0, 0.002, t, seeking)
        this.attr(`${d}.stems`, 'data-live', lv || li ? '1' : '0')
      }
      this.set(`${d}.fader`, '--p', faderPos(c.gain), 4)
      this.track(`${d}.fader`, c.gain, 0.0015, t, seeking)
      this.set(`${d}.vu`, '--l', meterFill(c.levelDb), 3)
    }
    this.set('M.vu', '--l', meterFill(s.masterDb), 3)
    this.text('M.db', s.masterDb == null ? '—' : `${Math.max(-60, Math.round(s.masterDb))} dB`)
    // beat phase: each deck's position within its bar (from its own beat grid). Locked = both
    // decks audible, beat-matched, and on the same beat phase within 1/16 beat.
    const ph = (d: DeckId) => {
      const st = s.deck[d]
      const g = st.track == null ? undefined : this.perf.tracks[st.track].grid
      if (st.beat == null || !g || !st.playing) return null
      return ((((st.beat - g.downbeatPhase) % 4) + 4) % 4) / 4
    }
    const pa = ph('A')
    const pb = ph('B')
    this.set('A.ph', '--ph', pa ?? 0, 4)
    this.set('A.ph', '--phop', pa == null ? 0 : 1, 1)
    this.set('B.ph', '--ph', pb ?? 0, 4)
    this.set('B.ph', '--phop', pb == null ? 0 : 1, 1)
    const both = pa != null && pb != null && s.ch.A.gain > 0.02 && s.ch.B.gain > 0.02
    const diffBeats = both ? (((pa! - pb!) * 4 + 6) % 4) - 2 : null // signed beats, −2..2
    const beatOff = diffBeats == null ? null : diffBeats - Math.round(diffBeats)
    const locked = beatOff != null && Math.abs(beatOff) < 1 / 16 && s.deck.A.sync && s.deck.B.sync
    this.attr('phase', 'data-locked', locked ? '1' : '0')
    this.text('phaseinfo', beatOff == null ? '' : locked ? 'Beats aligned' : `${beatOff > 0 ? '+' : ''}${Math.round(beatOff * 1000) / 1000} beat`)
  }

  private fit(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
    let sz = this.canvasSize.get(canvas)
    if (!sz) {
      const r = canvas.getBoundingClientRect()
      if (r.width < 4) return null
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      sz = { w: Math.round(r.width), h: Math.round(r.height) }
      canvas.width = sz.w * dpr
      canvas.height = sz.h * dpr
      canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.canvasSize.set(canvas, sz)
    }
    return { g: canvas.getContext('2d')!, w: sz.w, h: sz.h }
  }

  /** Scrolling zoomed waveform around the needle: beat grid, cue/out points, loop region, drops. */
  private drawWave(d: DeckId, track: PerfTrack, st: ControllerState['deck'][DeckId]) {
    const canvas = this.el.get(`${d}.wave`) as HTMLCanvasElement | undefined
    const pk = this.peaks.get(track.key)
    if (!canvas || !pk || !this.perf.peaks) return
    const sig = `${track.key}|${st.pos.toFixed(3)}|${st.loop?.startSec ?? ''}`
    const key = `${d}.wave|sig`
    if (this.prev.get(key) === sig) return
    this.prev.set(key, sig)
    const f = this.fit(canvas)
    if (!f) return
    const { g, w, h } = f
    const span = w < 300 ? 6 : 9 // seconds visible
    const t0 = st.pos - span / 2
    const sec = this.perf.peaks.secPerBucket
    const x = (ts: number) => ((ts - t0) / span) * w
    g.clearRect(0, 0, w, h)
    // loop region
    if (st.loop) {
      const lb = this.perf.tracks[st.track!].grid?.beatSec ?? 0.5
      g.fillStyle = 'rgba(232,176,74,0.16)'
      g.fillRect(x(st.loop.startSec), 0, Math.max(2, (st.loop.beats * lb * w) / span), h)
    }
    // beat grid
    const gr = track.grid
    if (gr) {
      const k0 = Math.ceil((t0 - gr.firstBeatSec) / gr.beatSec)
      const k1 = Math.floor((t0 + span - gr.firstBeatSec) / gr.beatSec)
      for (let k = k0; k <= k1; k++) {
        const bar = (((k - gr.downbeatPhase) % 4) + 4) % 4 === 0
        g.fillStyle = bar ? 'rgba(236,230,220,0.28)' : 'rgba(236,230,220,0.09)'
        g.fillRect(Math.round(x(gr.firstBeatSec + k * gr.beatSec)), bar ? 0 : h * 0.8, 1, bar ? h : h * 0.2)
      }
    }
    // waveform bars, coloured by low-band share (warm = bass-heavy)
    const mid = h / 2
    const step = w < 300 ? 2 : 1.5
    for (let px = 0; px < w; px += step) {
      const ts = t0 + (px / w) * span
      const b = Math.floor(ts / sec)
      if (b < 0 || b >= pk.amp.length) continue
      const a = (pk.amp[b] / 63) * (mid - 3)
      const lo = pk.low[b] / 63
      const played = ts < st.pos
      const r = Math.round(236 - lo * 20)
      const gg = Math.round(230 - lo * 70)
      const bb = Math.round(220 - lo * 160)
      g.fillStyle = `rgba(${r},${gg},${bb},${played ? 0.45 : 0.92})`
      g.fillRect(px, mid - a, step - 0.5, a * 2)
    }
    // markers: cue (where this deck started), mix-out point, drops
    const mark = (ts: number | null, color: string, label: string) => {
      if (ts == null) return
      const mx = x(ts)
      if (mx < -20 || mx > w + 20) return
      g.fillStyle = color
      g.fillRect(Math.round(mx), 0, 1.5, h)
      g.beginPath()
      g.moveTo(mx - 4, 0)
      g.lineTo(mx + 4, 0)
      g.lineTo(mx, 6)
      g.fill()
      g.font = '600 9px "Inter Tight", system-ui, sans-serif'
      g.fillText(label, mx + 4, h - 4)
    }
    mark(st.cueSec, '#e8b04a', 'CUE')
    mark(st.outCueSec, '#ece6dc', 'MIX OUT')
    for (const dr of track.drops) mark(dr, '#e5604d', 'DROP')
  }

  private drawOverview(d: DeckId, track: PerfTrack) {
    if (this.ovDrawn.get(d) === track.index) return
    const canvas = this.el.get(`${d}.ov`) as HTMLCanvasElement | undefined
    const pk = this.peaks.get(track.key)
    if (!canvas || !pk) return
    const f = this.fit(canvas)
    if (!f) return
    this.ovDrawn.set(d, track.index)
    const { g, w, h } = f
    g.clearRect(0, 0, w, h)
    const per = pk.amp.length / w
    for (let px = 0; px < w; px++) {
      let m = 0
      for (let b = Math.floor(px * per); b < Math.min(pk.amp.length, Math.floor((px + 1) * per)); b++) m = Math.max(m, pk.amp[b])
      const a = (m / 63) * h
      g.fillStyle = 'rgba(163,155,143,0.7)'
      g.fillRect(px, h - a, 1, a)
    }
  }
}
