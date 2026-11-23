/// <reference lib="webworker" />
/**
 * Off-main-thread DSP: full-track analysis and WSOLA pre-rendering of tempo-matched
 * transition segments. Receives PCM copies (never fetches audio itself).
 */
import { analyzeTrack } from '../../dsp/analyze'
import { wsola } from '../../dsp/stretch'
import { runBeatNet, type BeatNetRunner, type MelBank } from '../../dsp/beatnet'
import { resample } from '../../dsp/resample'
import { criticScore, type DjModels } from '../../ml/dj-brain'
import type { TransitionPlan } from '../transitions'

// ── Beat This! (CPJKU, MIT) via ONNX Runtime Web: WebGPU when available, WASM otherwise ──
let beatNet: Promise<{ run: BeatNetRunner; bank: MelBank; backend: string } | null> | null = null

function loadBeatNet() {
  beatNet ??= (async () => {
    try {
      const ort = await import('onnxruntime-web/webgpu')
      ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm', mjs: '/ort/ort-wasm-simd-threaded.jsep.js' }
      ort.env.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
      const [model, bank] = await Promise.all([
        fetch('/models/beat_this_small0.onnx').then((r) => r.arrayBuffer()),
        fetch('/models/beat_this_melfb.json').then((r) => r.json() as Promise<MelBank>),
      ])
      const hasGpu = 'gpu' in navigator
      let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>
      let backend = 'wasm'
      try {
        session = await ort.InferenceSession.create(model, { executionProviders: hasGpu ? ['webgpu', 'wasm'] : ['wasm'] })
        backend = hasGpu ? 'webgpu|wasm' : 'wasm'
      } catch {
        session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
      }
      const run: BeatNetRunner = async (spect, frames, mels) => {
        const out = await session.run({ spect: new ort.Tensor('float32', spect, [1, frames, mels]) })
        return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array }
      }
      return { run, bank, backend }
    } catch (e) {
      console.warn('[beatnet] unavailable, using DSP grid fallback', e)
      return null
    }
  })()
  return beatNet
}

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
  | {
      /** DJCritic: render each candidate's preview from mono deck crops and score it. */
      type: 'critic'
      id: number
      plans: TransitionPlan[]
      out: Float32Array
      outStartSec: number
      in: Float32Array
      inStartSec: number
      sampleRate: number
      inSampleRate: number
      trims: { out: number; in: number }
      models: NonNullable<DjModels['critic']>
    }

export type WorkerResponse =
  | { type: 'analysis'; id: number; analysis?: ReturnType<typeof analyzeTrack>; error?: string; ms: number }
  | { type: 'stretched'; id: number; channels?: Float32Array[]; anchors?: Float64Array; hop?: number; inputEnd?: number; error?: string; ms: number }
  | { type: 'critic'; id: number; scores?: Array<{ quality: number; artifact: number; ms: number }>; error?: string; ms: number }

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

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  const t0 = performance.now()
  if (msg.type === 'analyze') {
    try {
      let net: { beats: number[]; downbeats: number[] } | undefined
      let netMs = 0
      let backend = 'none'
      const bn = await loadBeatNet()
      if (bn) {
        try {
          const tn = performance.now()
          const r = await runBeatNet(msg.analysisMono, bn.bank, bn.run) // analysis copy is 22.05 kHz mono = model rate
          net = { beats: r.beats, downbeats: r.downbeats }
          netMs = performance.now() - tn
          backend = bn.backend
        } catch (e) {
          console.warn('[beatnet] inference failed, DSP fallback', e)
        }
      }
      const analysis = analyzeTrack({ channels: msg.channels, sampleRate: msg.sampleRate, analysisMono: msg.analysisMono, now: () => performance.now(), net })
      analysis.timings.beatnet = netMs
      if (net) analysis.flags.push(`beat model: Beat This! small0 (${backend})`)
      const res: WorkerResponse = { type: 'analysis', id: msg.id, analysis, ms: performance.now() - t0 }
      ;(self as unknown as Worker).postMessage(res)
    } catch (e) {
      ;(self as unknown as Worker).postMessage({ type: 'analysis', id: msg.id, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 })
    }
    return
  }
  if (msg.type === 'critic') {
    try {
      const RATE = 16000 // previews at the rate DJCritic was trained on
      const out = resample(msg.out, msg.sampleRate, RATE)
      const inn = resample(msg.in, msg.inSampleRate, RATE)
      const scores = msg.plans.map((p) => criticScore(msg.models, p, out, msg.outStartSec, inn, msg.inStartSec, RATE, msg.trims))
      const res: WorkerResponse = { type: 'critic', id: msg.id, scores, ms: performance.now() - t0 }
      ;(self as unknown as Worker).postMessage(res)
    } catch (e) {
      ;(self as unknown as Worker).postMessage({ type: 'critic', id: msg.id, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 })
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
