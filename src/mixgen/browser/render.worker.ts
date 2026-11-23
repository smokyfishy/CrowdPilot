/// <reference lib="webworker" />
/**
 * Browser render worker (the deployed "processing worker"): runs the full offline mix
 * renderer off the main thread and encodes the continuous output to Ogg Opus with
 * WebCodecs as it is produced (constant memory: ~2 decoded tracks + the encoded file).
 * PCM is requested from the main thread one track at a time (decodeAudioData is not
 * available in workers) and released after use.
 */
import { renderMix, type PcmTrack, type RenderResult } from '../mix-render'
import type { MixPlan } from '../mixplan'
import { OggOpusMuxer } from './ogg-opus'

export type RenderWorkerIn =
  | { type: 'render'; plan: MixPlan; bitrate?: number }
  | { type: 'pcm'; id: number; channels?: Float32Array[]; rate?: number; error?: string }

export type RenderWorkerOut =
  | { type: 'load'; id: number; key: string }
  | { type: 'progress'; done: number; total: number; detail: string }
  | { type: 'done'; result: RenderResult; blob: Blob; mime: string }
  | { type: 'error'; message: string }

const post = (m: RenderWorkerOut) => (self as unknown as Worker).postMessage(m)
const waiting = new Map<number, { resolve: (p: PcmTrack) => void; reject: (e: Error) => void }>()
let nextId = 1

function requestPcm(key: string): Promise<PcmTrack> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    post({ type: 'load', id, key })
  })
}

async function render(plan: MixPlan, bitrate: number): Promise<void> {
  if (typeof AudioEncoder === 'undefined') throw new Error('This browser cannot encode audio (WebCodecs AudioEncoder missing). Use a current Chrome, Edge or Firefox.')
  const RATE = 48000
  const support = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: 2, bitrate })
  if (!support.supported) throw new Error('Opus encoding is not supported in this browser.')
  let muxer: OggOpusMuxer | null = null
  let encErr: Error | null = null
  const enc = new AudioEncoder({
    output(chunk, meta) {
      if (!muxer) {
        // Use the encoder's own pre-skip when it provides an OpusHead description.
        const desc = meta?.decoderConfig?.description
        let preSkip = 312
        if (desc) {
          const b = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array((desc as ArrayBufferView).buffer, (desc as ArrayBufferView).byteOffset, (desc as ArrayBufferView).byteLength)
          if (b.length >= 12 && String.fromCharCode(...b.slice(0, 8)) === 'OpusHead') preSkip = b[10] | (b[11] << 8)
        }
        muxer = new OggOpusMuxer(2, RATE, preSkip)
      }
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      muxer.addPacket(buf, Math.round(((chunk.duration ?? 20000) * RATE) / 1e6))
    },
    error(e) {
      encErr = e instanceof Error ? e : new Error(String(e))
    },
  })
  enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 2, bitrate })
  let frames = 0
  const sink = {
    async write(block: Float32Array[]) {
      if (encErr) throw encErr
      const n = block[0].length
      if (!n) return
      const data = new Float32Array(n * 2)
      data.set(block[0], 0)
      data.set(block[1] ?? block[0], n)
      const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((frames / RATE) * 1e6), data })
      enc.encode(ad)
      ad.close()
      frames += n
      while (enc.encodeQueueSize > 32) await new Promise<void>((r) => enc.addEventListener('dequeue', () => r(), { once: true }))
    },
  }
  const result = await renderMix(plan, { load: requestPcm }, sink, (done, total, detail) => post({ type: 'progress', done, total, detail }))
  if (result.rate !== RATE) throw new Error(`render rate ${result.rate} ≠ ${RATE}`)
  await enc.flush()
  enc.close()
  if (encErr) throw encErr
  if (!muxer) throw new Error('encoder produced no output')
  const blob = (muxer as OggOpusMuxer).finish(frames)
  post({ type: 'done', result, blob, mime: 'audio/ogg; codecs=opus' })
}

self.onmessage = (ev: MessageEvent<RenderWorkerIn>) => {
  const m = ev.data
  if (m.type === 'pcm') {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (!w) return
    if (m.error || !m.channels || !m.rate) w.reject(new Error(m.error ?? 'no PCM'))
    else w.resolve({ channels: m.channels, rate: m.rate })
    return
  }
  if (m.type === 'render') {
    render(m.plan, m.bitrate ?? 192000).catch((e: unknown) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
  }
}
