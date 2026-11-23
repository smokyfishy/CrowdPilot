/**
 * Stem separation for local mixes (Demucs htdemucs, MIT, CPU): vocals / instrumental per recording,
 * cached by content hash under C:\crowdpilot-data\mixgen\stems\<sha256>\. Also derives per-bar vocal
 * activity and a separation-artifact check (bass bleed into the vocal stem) used to decide whether
 * layering is safe. Local research worker only (too heavy for the browser).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TrackAnalysis } from '../../src/dsp/analyze'
import type { StemInfo } from '../../src/mixgen/techniques'
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
  inst: string
}

/** Separates (or returns cached) vocals / instrumental WAVs for an audio file. */
export async function separate(audioPath: string, sha: string): Promise<StemFiles> {
  const out = dir('stems', sha)
  const files = { vocals: join(out, 'vocals.wav'), inst: join(out, 'no_vocals.wav') }
  if (existsSync(files.vocals) && existsSync(files.inst)) return files
  const tmp = join(out, 'input.wav')
  const dec = await run(ffmpegPath(), ['-hide_banner', '-v', 'error', '-y', '-i', audioPath, '-ac', '2', '-ar', '44100', tmp])
  if (dec.code !== 0) throw new Error(`stem prep failed: ${dec.err.slice(0, 200)}`)
  const work = join(out, 'work')
  const r = await run(process.env.PYTHON ?? 'python', ['-m', 'demucs', '--two-stems', 'vocals', '-n', 'htdemucs', '-o', work, '--filename', '{stem}.{ext}', tmp])
  if (r.code !== 0) throw new Error(`demucs failed: ${r.err.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(-2).join(' | ').slice(0, 300) || r.err.slice(-300)}`)
  // demucs writes <work>/htdemucs/{vocals,no_vocals}.wav
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
  const v = found('vocals.wav')
  const i = found('no_vocals.wav')
  if (!v || !i) throw new Error('demucs produced no stems')
  renameSync(v, files.vocals)
  renameSync(i, files.inst)
  rmSync(work, { recursive: true, force: true })
  rmSync(tmp, { force: true })
  return files
}

export async function loadStems(files: StemFiles, rate = 44100): Promise<{ vocals: Float32Array[]; inst: Float32Array[] }> {
  const [v, i] = await Promise.all([decodePcm(files.vocals, rate), decodePcm(files.inst, rate)])
  return { vocals: v.channels, inst: i.channels }
}

/** Per-bar vocal activity and a bass-bleed artifact check from the vocal stem. */
export function stemInfo(vocals: Float32Array[], rate: number, a: TrackAnalysis): StemInfo {
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
  return { vocalDb, barStartSec: start, barSec, clean: bleed < 0.25, bleed: Math.round(bleed * 1000) / 1000 }
}

export { decodePcm }
