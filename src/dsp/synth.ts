/**
 * Deterministic synthetic 4/4 dance-track generator with KNOWN ground truth
 * (tempo, first beat, downbeats, key, sections). Used ONLY for unit tests,
 * benchmarks of analyzer mechanics and engine smoke tests — never presented as
 * real music, and never counted as real-world accuracy.
 */

export interface SynthSpec {
  bpm: number
  bars: number
  sampleRate: number
  /** Silence before the first downbeat (seconds). */
  offsetSec?: number
  /** Tonic pitch class (0 = C) and mode for the chord progression. */
  tonic?: number
  mode?: 'major' | 'minor'
  /** Bars [start, end) without kick and bass (a breakdown). */
  breakdown?: [number, number]
  /** Bars at the start with drums only (intro). */
  introBars?: number
  outroBars?: number
  seed?: number
  /** Per-bar accent crash on downbeats. */
  crash?: boolean
}

export interface SynthTruth {
  bpm: number
  firstDownbeatSec: number
  beatTimes: number[]
  downbeatTimes: number[]
  tonic: number
  mode: 'major' | 'minor'
  breakdown?: [number, number]
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) / 4294967296) * 2 - 1
  }
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]

export function synthTrack(spec: SynthSpec): { channels: Float32Array[]; sampleRate: number; truth: SynthTruth } {
  const { bpm, bars, sampleRate } = spec
  const offset = spec.offsetSec ?? 0
  const tonic = spec.tonic ?? 9
  const mode = spec.mode ?? 'minor'
  const beat = 60 / bpm
  const total = offset + bars * 4 * beat + 1
  const n = Math.ceil(total * sampleRate)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const rand = rng(spec.seed ?? 7)
  const scale = mode === 'major' ? MAJOR : MINOR
  // i–VI–III–VII in minor; I–V–vi–IV in major (scale degrees, 0-based)
  const prog = mode === 'minor' ? [0, 5, 2, 6] : [0, 4, 5, 3]
  const add = (buf: Float32Array, start: number, data: (i: number) => number, len: number, gain: number) => {
    const s0 = Math.round(start * sampleRate)
    for (let i = 0; i < len && s0 + i < n; i++) if (s0 + i >= 0) buf[s0 + i] += data(i) * gain
  }
  const beatTimes: number[] = []
  const downbeatTimes: number[] = []
  const intro = spec.introBars ?? 0
  const outro = spec.outroBars ?? 0
  for (let bar = 0; bar < bars; bar++) {
    const inBreak = !!spec.breakdown && bar >= spec.breakdown[0] && bar < spec.breakdown[1]
    const drumsOnly = bar < intro || bar >= bars - outro
    const degree = prog[Math.floor(bar / 2) % 4]
    const chordRoot = tonic + scale[degree]
    const chord = [0, 2, 4].map((k) => tonic + scale[(degree + k) % 7] + (degree + k >= 7 ? 12 : 0))
    for (let b = 0; b < 4; b++) {
      const t = offset + (bar * 4 + b) * beat
      beatTimes.push(t)
      if (b === 0) downbeatTimes.push(t)
      if (!inBreak) {
        // kick: exponential pitch sweep 110 → 45 Hz
        const kl = Math.round(0.25 * sampleRate)
        const kick = (i: number) => {
          const tt = i / sampleRate
          const f = 45 + 65 * Math.exp(-tt * 30)
          return Math.sin(2 * Math.PI * f * tt - 0) * Math.exp(-tt * 9)
        }
        add(L, t, kick, kl, 0.55)
        add(R, t, kick, kl, 0.55)
      }
      // off-beat hat
      const hl = Math.round(0.04 * sampleRate)
      const hat = (i: number) => rand() * Math.exp(-(i / sampleRate) * 90)
      add(L, t + beat / 2, hat, hl, 0.12)
      add(R, t + beat / 2, hat, hl, 0.12)
      // bass on the off-beat, root note
      if (!inBreak && !drumsOnly) {
        const f = 440 * 2 ** ((chordRoot - 9) / 12 - 2)
        const bl = Math.round(beat * 0.45 * sampleRate)
        const bass = (i: number) => Math.sin((2 * Math.PI * f * i) / sampleRate) * Math.min(1, i / 200) * Math.exp(-(i / sampleRate) * 4)
        add(L, t + beat / 2, bass, bl, 0.3)
        add(R, t + beat / 2, bass, bl, 0.3)
      }
    }
    // crash on downbeat every 8 bars (phrase marker) or each bar if requested
    if (spec.crash || bar % 8 === 0) {
      const cl = Math.round(0.6 * sampleRate)
      const crash = (i: number) => rand() * Math.exp(-(i / sampleRate) * 6)
      add(L, offset + bar * 4 * beat, crash, cl, 0.08)
      add(R, offset + bar * 4 * beat, crash, cl, 0.08)
    }
    // pad chord over the whole bar (not in drum-only sections)
    if (!drumsOnly) {
      const pl = Math.round(4 * beat * sampleRate)
      for (const note of chord) {
        const f = 440 * 2 ** ((note - 9) / 12)
        const pad = (i: number) => {
          const env = Math.min(1, i / 2000) * Math.min(1, (pl - i) / 2000)
          const ph = (2 * Math.PI * f * i) / sampleRate
          return env * (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph))
        }
        add(L, offset + bar * 4 * beat, pad, pl, inBreak ? 0.09 : 0.06)
        add(R, offset + bar * 4 * beat, pad, pl, inBreak ? 0.09 : 0.06)
      }
    }
  }
  return {
    channels: [L, R],
    sampleRate,
    truth: { bpm, firstDownbeatSec: offset, beatTimes, downbeatTimes, tonic, mode, breakdown: spec.breakdown },
  }
}
