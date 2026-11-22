/// <reference lib="webworker" />
/**
 * Off-main-thread DSP: full-track analysis and WSOLA pre-rendering of tempo-matched
 * transition segments. Receives PCM copies (never fetches audio itself).
 */
import { analyzeTrack } from '../../dsp/analyze'
import { wsola } from '../../dsp/stretch'

export type WorkerRequest =
  | { type: 'analyze'; id: number; channels: Float32Array[]; sampleRate: number; analysisMono: Float32Array }
  | {
      type: 'stretch'
      id: number
      channels: Float32Array[]
      sampleRate: number
      startSample: number
      outLength: number
      /** Piecewise-linear ratio: [outSample, ratio] knots, ratio held after the last knot. */
      knots: Array<[number, number]>
    }

export type WorkerResponse =
  | { type: 'analysis'; id: number; analysis?: ReturnType<typeof analyzeTrack>; error?: string; ms: number }
  | { type: 'stretched'; id: number; channels?: Float32Array[]; anchors?: Float64Array; hop?: number; inputEnd?: number; error?: string; ms: number }

function ratioFrom(knots: Array<[number, number]>) {
  return (s: number) => {
    if (s <= knots[0][0]) return knots[0][1]
    for (let i = 1; i < knots.length; i++) {
      const [x1, y1] = knots[i]
      const [x0, y0] = knots[i - 1]
      if (s <= x1) return y0 + ((y1 - y0) * (s - x0)) / Math.max(1, x1 - x0)
    }
    return knots[knots.length - 1][1]
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  const t0 = performance.now()
  if (msg.type === 'analyze') {
    try {
      const analysis = analyzeTrack({ channels: msg.channels, sampleRate: msg.sampleRate, analysisMono: msg.analysisMono, now: () => performance.now() })
      const res: WorkerResponse = { type: 'analysis', id: msg.id, analysis, ms: performance.now() - t0 }
      ;(self as unknown as Worker).postMessage(res)
    } catch (e) {
      ;(self as unknown as Worker).postMessage({ type: 'analysis', id: msg.id, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 })
    }
    return
  }
  if (msg.type === 'stretch') {
    try {
      const r = wsola(msg.channels, msg.startSample, msg.outLength, ratioFrom(msg.knots), { frame: msg.sampleRate >= 44100 ? 2048 : 1024 })
      const res: WorkerResponse = { type: 'stretched', id: msg.id, channels: r.channels, anchors: r.anchors, hop: r.hop, inputEnd: r.inputEnd, ms: performance.now() - t0 }
      ;(self as unknown as Worker).postMessage(res, [...r.channels.map((c) => c.buffer), r.anchors.buffer] as Transferable[])
    } catch (e) {
      ;(self as unknown as Worker).postMessage({ type: 'stretched', id: msg.id, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 })
    }
  }
}
