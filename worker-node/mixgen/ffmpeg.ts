/**
 * FFmpeg backend: probe (container/codec/rate/channels/duration + integrity), decode any
 * supported format (MP3, WAV, FLAC, AAC/M4A, Opus, Ogg Vorbis, WebM) to float PCM at the mix
 * rate, and stream-encode the finished mix. Decoding goes original → PCM directly; nothing is
 * transcoded to an intermediate lossy format.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

let cached: string | null = null
export function ffmpegPath(): string {
  if (cached) return cached
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return (cached = process.env.FFMPEG_PATH)
  try {
    const p = execFileSync('python', ['-c', 'import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim()
    if (p && existsSync(p)) return (cached = p)
  } catch {
    /* fall through */
  }
  return (cached = 'ffmpeg')
}

export interface ProbeInfo {
  container: string
  codec: string
  sampleRate: number
  channels: number
  durationSec: number
  bitrateKbps?: number
}

/** Probe + full integrity decode (errors anywhere in the stream fail the check). */
export function probe(path: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-v', 'info', '-xerror', '-i', path, '-map', '0:a:0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => {
      const input = /Input #0, ([^,]+)/.exec(err)
      const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err)
      const audio = /Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: ([^,\s]+)[^,]*, (\d+) Hz, ([^,]+)/.exec(err)
      const br = /bitrate: (\d+) kb\/s/.exec(err)
      if (code !== 0 || !audio || !dur) return reject(new Error(`invalid or corrupt audio (ffmpeg exit ${code}): ${err.split('\n').filter((l) => /error|invalid/i.test(l)).slice(-2).join(' | ') || 'no audio stream'}`))
      const ch = audio[3].includes('stereo') ? 2 : audio[3].includes('mono') ? 1 : Number(/(\d+) channels/.exec(audio[3])?.[1] ?? 2)
      resolve({
        container: input?.[1] ?? 'unknown',
        codec: audio[1],
        sampleRate: Number(audio[2]),
        channels: ch,
        durationSec: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
        bitrateKbps: br ? Number(br[1]) : undefined,
      })
    })
  })
}

/** Decode to de-interleaved float32 PCM, `rate` Hz, 2 channels (high-quality swresample: 64-tap, phase_shift 10). */
export function decodePcm(path: string, rate = 44100): Promise<{ channels: Float32Array[]; rate: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '2', '-af', `aresample=${rate}:filter_size=64:phase_shift=10:cutoff=0.97`, '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`decode failed: ${err.trim().slice(0, 300)}`))
      const buf = Buffer.concat(chunks)
      const n = Math.floor(buf.length / 8)
      const f = new Float32Array(buf.buffer, buf.byteOffset, n * 2)
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        L[i] = f[2 * i]
        R[i] = f[2 * i + 1]
      }
      resolve({ channels: [L, R], rate })
    })
  })
}

/** Streaming encoder: write float blocks, get an encoded file. Format from extension (.mp3 / .flac / .wav / .opus). */
export function createEncoder(outPath: string, rate: number, opts: { mp3Kbps?: number; metadata?: Record<string, string> } = {}) {
  const ext = outPath.split('.').pop()!.toLowerCase()
  const codec = ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${opts.mp3Kbps ?? 320}k`] : ext === 'flac' ? ['-c:a', 'flac'] : ext === 'opus' ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']
  const meta = Object.entries(opts.metadata ?? {}).flatMap(([k, v]) => ['-metadata', `${k}=${v}`])
  const p = spawn(ffmpegPath(), ['-hide_banner', '-v', 'error', '-y', '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', '-', ...codec, ...meta, outPath], { stdio: ['pipe', 'ignore', 'pipe'] })
  let err = ''
  p.stderr.on('data', (d) => (err += d.toString()))
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`encode failed: ${err.slice(0, 300)}`))))
  })
  return {
    async write(block: Float32Array[]): Promise<void> {
      const n = block[0].length
      const inter = new Float32Array(n * 2)
      const R = block[1] ?? block[0]
      for (let i = 0; i < n; i++) {
        inter[2 * i] = block[0][i]
        inter[2 * i + 1] = R[i]
      }
      const ok = p.stdin.write(Buffer.from(inter.buffer))
      if (!ok) await new Promise<void>((r) => p.stdin.once('drain', () => r()))
    },
    async close(): Promise<void> {
      p.stdin.end()
      await done
    },
  }
}
