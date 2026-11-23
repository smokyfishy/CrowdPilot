/**
 * Stem separation for local mixes (Demucs htdemucs, MIT, CPU): 4 stems (vocals, drums, bass, other)
 * per recording — the instrumental is their sum (older two-stem caches stay usable),
 * cached by content hash under C:\crowdpilot-data\mixgen\stems\<sha256>\. Also derives per-bar vocal
 * activity and a separation-artifact check (bass bleed into the vocal stem) used to decide whether
 * layering is safe. Local research worker only (too heavy for the browser).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TrackAnalysis } from '../../src/dsp/analyze'
import type { StemInfo, StemPcm } from '../../src/mixgen/techniques'
import { stemsClean } from '../../src/mixgen/stems-shared'
import { decodePcm, ffmpegPath } from './ffmpeg'
import { dir } from './storage'

function run(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? 1, err }))
  })
}

export interface StemFiles {
  vocals: string
  /** Two-stem cache: the instrumental file. 4-stem caches derive it from drums + bass + other. */
  inst?: string
  drums?: string
  bass?: string
  other?: string
}

/**
 * Separates (or returns cached) stems for an audio file. New separations are 4-stem (htdemucs computes
 * all four sources either way); an existing two-stem cache is reused unless CP_STEMS4=1.
 */
export async function separate(audioPath: string, sha: string): Promise<StemFiles> {
  const out = dir('stems', sha)
  const four = { vocals: join(out, 'vocals.wav'), drums: join(out, 'drums.wav'), bass: join(out, 'bass.wav'), other: join(out, 'other.wav') }
  if (Object.values(four).every((f) => existsSync(f))) return four
  const two = { vocals: join(out, 'vocals.wav'), inst: join(out, 'no_vocals.wav') }
  if (existsSync(two.vocals) && existsSync(two.inst) && process.env.CP_STEMS4 !== '1') return two
  const tmp = join(out, 'input.wav')
  const dec = await run(ffmpegPath(), ['-hide_banner', '-v', 'error', '-y', '-i', audioPath, '-ac', '2', '-ar', '44100', tmp])
  if (dec.code !== 0) throw new Error(`stem prep failed: ${dec.err.slice(0, 200)}`)
  const work = join(out, 'work')
  const r = await run(process.env.PYTHON ?? 'python', ['-m', 'demucs', '-n', 'htdemucs', '--float32', '-o', work, '--filename', '{stem}.{ext}', tmp])
  if (r.code !== 0) throw new Error(`demucs failed: ${r.err.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(-2).join(' | ').slice(0, 300) || r.err.slice(-300)}`)
  const found = (name: string): string | null => {
    const walk = (d: string): string | null => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) {
          const x = walk(p)
          if (x) return x
        } else if (f === name) return p
      }
      return null
    }
    return walk(work)
  }
  for (const [k, dst] of Object.entries(four)) {
    const src = found(`${k}.wav`)
    if (!src) throw new Error(`demucs produced no ${k} stem`)
    renameSync(src, dst)
  }
  rmSync(work, { recursive: true, force: true })
  rmSync(tmp, { force: true })
  return four
}

export async function loadStems(files: StemFiles, rate = 44100): Promise<StemPcm> {
  const v = await decodePcm(files.vocals, rate)
  if (files.drums && files.bass && files.other) {
    const [d, b, o] = await Promise.all([decodePcm(files.drums, rate), decodePcm(files.bass, rate), decodePcm(files.other, rate)])
    const inst = d.channels.map((c, ci) => {
      const x = new Float32Array(c.length)
      const bc = b.channels[Math.min(ci, b.channels.length - 1)]
      const oc = o.channels[Math.min(ci, o.channels.length - 1)]
      for (let i = 0; i < x.length; i++) x[i] = c[i] + (bc[i] ?? 0) + (oc[i] ?? 0)
      return x
    })
    return { vocals: v.channels, inst, drums: d.channels, bass: b.channels, other: o.channels }
  }
  const i = await decodePcm(files.inst!, rate)
  return { vocals: v.channels, inst: i.channels }
}

/** Per-bar vocal activity and a bass-bleed artifact check from the vocal stem. */
export function stemInfo(vocals: Float32Array[], rate: number, a: TrackAnalysis, extra?: { stems?: StemPcm; mix?: Float32Array[] }): StemInfo {
  const m = vocals[0]
  const r = vocals[1] ?? vocals[0]
  const barSec = a.barSec
  const start = a.bars[0]?.startSec ?? 0
  const nb = Math.max(1, Math.floor((m.length / rate - start) / barSec))
  const vocalDb: number[] = []
  let lowE = 0
  let allE = 0
  let lp1 = 0
  let lp2 = 0
  const k = Math.exp((-2 * Math.PI * 120) / rate)
  for (let b = 0; b < nb; b++) {
    const s0 = Math.round((start + b * barSec) * rate)
    const s1 = Math.min(m.length, Math.round((start + (b + 1) * barSec) * rate))
    let e = 0
    for (let i = s0; i < s1; i++) {
      const x = (m[i] + r[i]) / 2
      e += x * x
      lp1 = lp1 * k + x * (1 - k)
      lp2 = lp2 * k + lp1 * (1 - k)
      lowE += lp2 * lp2
      allE += x * x
    }
    vocalDb.push(Math.round(10 * Math.log10(e / Math.max(1, s1 - s0) + 1e-12) * 10) / 10)
  }
  const bleed = allE > 0 ? lowE / allE : 0
  const st = extra?.stems
  const elements: StemInfo['elements'] = st?.drums && st.bass && st.other ? ['vocals', 'drums', 'bass', 'other'] : ['vocals']
  // reconstruction check: the stems must sum back to the original (large residual = separation artifacts)
  let residualDb: number | undefined
  if (st && extra?.mix) {
    // Different decoders add different start delays (encoder priming), so align before comparing:
    // find the lag (±50 ms) that best matches stems-sum to the mix on a 20 s excerpt, then measure.
    const mix = extra.mix[0]
    const sum = (i: number) => (st.vocals[0][i] ?? 0) + (st.inst[0][i] ?? 0)
    const n = Math.min(mix.length, st.vocals[0].length, st.inst[0].length)
    const c0 = Math.min(Math.max(0, Math.floor(n / 3)), Math.max(0, n - 20 * rate))
    const c1 = Math.min(n, c0 + 20 * rate)
    let bestLag = 0
    let best = -Infinity
    const maxLag = Math.round(0.05 * rate)
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let c = 0
      for (let i = c0; i < c1; i += 8) c += mix[i] * sum(i + lag)
      if (c > best) {
        best = c
        bestLag = lag
      }
    }
    // refine at full resolution around the decimated estimate (aliasing can shift it by a few samples)
    const coarse = bestLag
    best = -Infinity
    for (let lag = coarse - 8; lag <= coarse + 8; lag++) {
      let c = 0
      for (let i = c0; i < c1; i++) c += mix[i] * sum(i + lag)
      if (c > best) {
        best = c
        bestLag = lag
      }
    }
    let e = 0
    let m = 0
    for (let i = Math.max(0, -bestLag); i < n - Math.max(0, bestLag); i += 4) {
      const d = mix[i] - sum(i + bestLag)
      e += d * d
      m += mix[i] * mix[i]
    }
    residualDb = Math.round(10 * Math.log10(e / Math.max(1e-12, m) + 1e-12) * 10) / 10
  }
  const clean = stemsClean(bleed, residualDb)
  return { vocalDb, barStartSec: start, barSec, clean, bleed: Math.round(bleed * 1000) / 1000, elements, ...(residualDb !== undefined ? { residualDb } : {}) }
}

export { decodePcm }
