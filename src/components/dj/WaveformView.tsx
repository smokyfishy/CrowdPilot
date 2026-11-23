/**
 * Measured waveform overview with beat grid, downbeats, phrase boundaries and cue
 * markers. Everything drawn comes from the host's own analysis of the authorized
 * audio; low-confidence grids are drawn dashed and labelled.
 */
import { useEffect, useRef } from 'react'
import type { TrackAnalysis } from '@/dsp/analyze'

interface Props {
  analysis?: TrackAnalysis
  positionSec?: number
  cueInSec?: number
  cueOutSec?: number
  height?: number
  label: string
}

export function WaveformView({ analysis, positionSec, cueInSec, cueOutSec, height = 64, label }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    canvas.width = Math.max(1, Math.floor(w * dpr))
    canvas.height = Math.floor(height * dpr)
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    const css = getComputedStyle(canvas)
    const fg = css.getPropertyValue('--color-foreground').trim() || '#e8e2d6'
    const accent = css.getPropertyValue('--color-primary').trim() || '#e0a24a'
    const muted = css.getPropertyValue('--color-muted-foreground').trim() || '#8a857c'
    g.clearRect(0, 0, w, height)
    if (!analysis) {
      g.fillStyle = muted
      g.font = '12px sans-serif'
      g.fillText('No waveform (standard playback or not analyzed yet)', 8, height / 2 + 4)
      return
    }
    const dur = analysis.qc.durationSec
    const x = (sec: number) => (sec / dur) * w
    const ov = analysis.overview
    const mid = height / 2
    for (let c = 0; c < ov.columns; c++) {
      const px = (c / ov.columns) * w
      const amp = ov.peak[c] * (height / 2 - 2)
      // colour by dominant band: low = accent, mid = foreground, high = muted
      g.fillStyle = ov.low[c] > 0.55 ? accent : ov.high[c] > 0.3 ? muted : fg
      g.globalAlpha = 0.85
      g.fillRect(px, mid - amp, Math.max(1, w / ov.columns), amp * 2)
    }
    g.globalAlpha = 1
    const grid = analysis.grid
    if (grid.bpm > 0) {
      const lowConf = grid.confidence < 0.5 || !grid.stable
      g.setLineDash(lowConf ? [2, 3] : [])
      const pxPerBeat = (grid.periodSec / dur) * w
      for (let i = 0; i < grid.beatCount; i++) {
        const t = grid.firstBeatSec + i * grid.periodSec
        const isDown = (i - grid.downbeatPhase) % 4 === 0
        if (!isDown && pxPerBeat < 3) continue
        g.strokeStyle = isDown ? fg : muted
        g.globalAlpha = isDown ? 0.35 : 0.15
        g.beginPath()
        g.moveTo(x(t), isDown ? 0 : height * 0.8)
        g.lineTo(x(t), height)
        g.stroke()
      }
      g.setLineDash([])
      g.globalAlpha = 1
    }
    for (const p of analysis.phrases) {
      g.fillStyle = p.evidence === 'measured' ? accent : muted
      g.fillRect(x(p.sec), 0, 1.5, 6)
    }
    const marker = (sec: number | undefined, color: string, text: string) => {
      if (sec === undefined) return
      g.fillStyle = color
      g.fillRect(x(sec) - 1, 0, 2, height)
      g.font = '10px sans-serif'
      g.fillText(text, Math.min(w - 30, x(sec) + 3), 10)
    }
    marker(cueInSec, '#4fb3a9', 'IN')
    marker(cueOutSec, '#d96c5f', 'OUT')
    if (positionSec !== undefined) {
      g.fillStyle = fg
      g.fillRect(x(positionSec) - 1, 0, 2, height)
    }
  }, [analysis, positionSec, cueInSec, cueOutSec, height])
  return <canvas ref={ref} role="img" aria-label={label} className="block w-full rounded-md bg-card" style={{ height }} />
}
