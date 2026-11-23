/**
 * Capability-aware audio source adapter for the HOST browser. Only authorized
 * waveform sources resolve to a fetchable URL; YouTube never does (its iframe
 * player exposes no audio). Decoded audio lives in a small session-only LRU
 * (Audius/Jamendo terms allow session caching only) and is never persisted.
 */
import { audiusStreamUrl } from '../../providers/catalog/audius'
import { sourceOf } from '../../providers/catalog/types'

export interface SourceCapabilities {
  waveformAccess: boolean
  mixingAllowed: boolean
  trainingAllowed: boolean
  publicDemoAllowed: boolean
  reason: string
}

export function capabilitiesOf(trackKey: string, opts: { allowOmlMixing: boolean; mixingNeedsReview?: boolean }): SourceCapabilities {
  const src = sourceOf(trackKey)
  if (src === 'youtube') {
    return { waveformAccess: false, mixingAllowed: false, trainingAllowed: false, publicDemoAllowed: false, reason: 'YouTube embedded player: standard playback only (no audio access).' }
  }
  if (src === 'audius') {
    const mixing = opts.allowOmlMixing || opts.mixingNeedsReview === false
    return {
      waveformAccess: true,
      mixingAllowed: mixing,
      trainingAllowed: false, // Audius API Terms prohibit ML training on content
      publicDemoAllowed: false,
      reason: mixing ? 'Audius stream (Open Music License); session-only, no training.' : 'Host disabled mixing of OML-only Audius uploads pending rights review.',
    }
  }
  if (src === 'jamendo') {
    return { waveformAccess: true, mixingAllowed: opts.mixingNeedsReview !== true, trainingAllowed: false, publicDemoAllowed: false, reason: 'Jamendo Creative Commons track (non-commercial API use).' }
  }
  return { waveformAccess: false, mixingAllowed: false, trainingAllowed: false, publicDemoAllowed: false, reason: 'Unknown source.' }
}

export interface AudioFetchContext {
  roomId: string
  authHeaders: () => Promise<Record<string, string>>
}

export function audioUrlFor(trackKey: string, ctx: AudioFetchContext): string | null {
  const src = sourceOf(trackKey)
  const id = trackKey.slice((src?.length ?? 0) + 1)
  if (src === 'audius') return audiusStreamUrl(id)
  if (src === 'jamendo') return `/api/audio/jamendo/${encodeURIComponent(id)}?roomId=${encodeURIComponent(ctx.roomId)}`
  return null
}

export class AudioLoadError extends Error {
  constructor(
    message: string,
    readonly code: 901 | 902,
  ) {
    super(message)
  }
}

const MAX_BYTES = 80 * 1024 * 1024

/** Session LRU of decoded buffers (keyed by trackKey). */
export class DecodedCache {
  private readonly map = new Map<string, Promise<AudioBuffer>>()
  constructor(private readonly capacity = 4) {}

  get(key: string, load: () => Promise<AudioBuffer>): Promise<AudioBuffer> {
    const hit = this.map.get(key)
    if (hit) {
      this.map.delete(key)
      this.map.set(key, hit)
      return hit
    }
    const p = load()
    this.map.set(key, p)
    p.catch(() => this.map.delete(key))
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as string)
    return p
  }

  clear(): void {
    this.map.clear()
  }
}

export async function fetchAndDecode(ctx: BaseAudioContext, trackKey: string, fetchCtx: AudioFetchContext, signal?: AbortSignal): Promise<AudioBuffer> {
  const url = audioUrlFor(trackKey, fetchCtx)
  if (!url) throw new AudioLoadError('This source has no authorized audio access.', 901)
  const headers = url.startsWith('/') ? await fetchCtx.authHeaders() : {}
  let res: Response
  try {
    res = await fetch(url, { signal, headers, credentials: url.startsWith('/') ? 'include' : 'omit' })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new AudioLoadError('The authorized audio stream could not be loaded.', 901)
  }
  if (!res.ok) throw new AudioLoadError(`The authorized audio stream could not be loaded (${res.status}).`, 901)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new AudioLoadError('This audio file is too large to mix.', 901)
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength > MAX_BYTES) throw new AudioLoadError('This audio file is too large to mix.', 901)
  try {
    return await ctx.decodeAudioData(bytes)
  } catch {
    throw new AudioLoadError('This audio file could not be decoded.', 902)
  }
}

/** Mono 22.05 kHz analysis copy via OfflineAudioContext (native anti-aliased resampling). */
export async function analysisCopy(buffer: AudioBuffer, rate = 22050): Promise<Float32Array> {
  const length = Math.ceil(buffer.duration * rate)
  const off = new OfflineAudioContext(1, length, rate)
  const src = off.createBufferSource()
  src.buffer = buffer
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0).slice()
}
