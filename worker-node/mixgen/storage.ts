/**
 * Private research storage (default C:\crowdpilot-data\mixgen; override with CP_DATA_ROOT).
 * Never in git, never on DeepSpace storage. Layout:
 *   acquired/<source>/   original encoded recordings (content-hashed, deduplicated)
 *   decoded/             PCM cache (f32le 44.1 kHz stereo) keyed by sha256
 *   analysis/            analysis JSON keyed by sha256 + analyzer version
 *   embeddings/          cached embeddings (reserved; none computed in the MVP)
 *   previews/            transition previews (WAV)
 *   renders/             rendered mixes (WAV master) + manifest
 *   exports/             MP3 exports
 *   jobs/                job manifests (progress, stage outputs) for resume
 *   logs/                per-job logs
 *   index.json           acquisition index: trackKey → AcquiredAudio (+ provenance)
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcquiredAudio } from '../../src/mixgen/types'

export const DATA_ROOT = process.env.CP_DATA_ROOT ?? 'C:/crowdpilot-data'
export const MIXGEN_ROOT = join(DATA_ROOT, 'mixgen')
export const DIRS = ['acquired', 'decoded', 'analysis', 'embeddings', 'previews', 'renders', 'exports', 'jobs', 'logs', 'session'] as const
export type Dir = (typeof DIRS)[number]

export function dir(d: Dir, ...sub: string[]): string {
  const p = join(MIXGEN_ROOT, d, ...sub)
  mkdirSync(p, { recursive: true })
  return p
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

export interface IndexEntry extends AcquiredAudio {
  path: string // server-side only; never sent to clients
  provenance: { url: string; license: string; policyVersion: string; reason: string }
}

const INDEX = () => join(dir('acquired'), 'index.json')

export function readIndex(): Record<string, IndexEntry> {
  try {
    return JSON.parse(readFileSync(INDEX(), 'utf8')) as Record<string, IndexEntry>
  } catch {
    return {}
  }
}

export function writeIndexEntry(e: IndexEntry): void {
  const idx = readIndex()
  idx[e.trackKey] = e
  const tmp = INDEX() + '.tmp'
  writeFileSync(tmp, JSON.stringify(idx, null, 1))
  renameSync(tmp, INDEX())
}

export function findByHash(sha: string): IndexEntry | undefined {
  return Object.values(readIndex()).find((e) => e.sha256 === sha && existsSync(e.path))
}

/** Storage monitoring: bytes and file counts per directory. */
export function storageReport(): Record<string, { files: number; bytes: number }> {
  const out: Record<string, { files: number; bytes: number }> = {}
  const walk = (p: string): { files: number; bytes: number } => {
    let files = 0
    let bytes = 0
    if (!existsSync(p)) return { files, bytes }
    for (const name of readdirSync(p)) {
      const q = join(p, name)
      const st = statSync(q)
      if (st.isDirectory()) {
        const r = walk(q)
        files += r.files
        bytes += r.bytes
      } else {
        files++
        bytes += st.size
      }
    }
    return { files, bytes }
  }
  for (const d of DIRS) out[d] = walk(join(MIXGEN_ROOT, d))
  return out
}

/**
 * Cleanup policy. No research storage cap is imposed; this removes only regenerable or
 * policy-restricted data:
 *  - session/ (Audius and other session-only audio) — always, at job end;
 *  - decoded/ PCM older than `decodedMaxAgeDays` (re-decodable from acquired/);
 *  - *.part files older than 2 days (abandoned resumable downloads).
 */
export function cleanup(opts: { decodedMaxAgeDays?: number; sessionOnly?: boolean } = {}): { removed: number; bytes: number } {
  let removed = 0
  let bytes = 0
  const rm = (p: string) => {
    try {
      bytes += statSync(p).size
      unlinkSync(p)
      removed++
    } catch {
      /* already gone */
    }
  }
  const sess = join(MIXGEN_ROOT, 'session')
  if (existsSync(sess)) for (const f of readdirSync(sess)) rm(join(sess, f))
  if (opts.sessionOnly) return { removed, bytes }
  const now = Date.now()
  const maxAge = (opts.decodedMaxAgeDays ?? 14) * 86400_000
  const dec = join(MIXGEN_ROOT, 'decoded')
  if (existsSync(dec)) for (const f of readdirSync(dec)) if (now - statSync(join(dec, f)).mtimeMs > maxAge) rm(join(dec, f))
  const acq = join(MIXGEN_ROOT, 'acquired')
  if (existsSync(acq))
    for (const s of readdirSync(acq)) {
      const p = join(acq, s)
      if (!statSync(p).isDirectory()) continue
      for (const f of readdirSync(p)) if (f.endsWith('.part') && now - statSync(join(p, f)).mtimeMs > 2 * 86400_000) rm(join(p, f))
    }
  return { removed, bytes }
}

/** JSON with typed-array support (for analysis caching). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val instanceof Float32Array) return { __ta: 'f32', d: Array.from(val) }
    if (val instanceof Float64Array) return { __ta: 'f64', d: Array.from(val) }
    return val
  })
}
export function fromJson<T>(s: string): T {
  return JSON.parse(s, (_k, val) => {
    if (val && typeof val === 'object' && '__ta' in val) return val.__ta === 'f32' ? Float32Array.from(val.d) : Float64Array.from(val.d)
    return val
  }) as T
}
