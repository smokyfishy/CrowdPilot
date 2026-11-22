/**
 * Shared loaders for the ML data pipeline: cached analysis of the private evaluation corpora,
 * deterministic track-level splits, and a mono low-rate PCM cache.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTrack, summarize, type AnalysisSummary } from '../../src/dsp/analyze'
import { resample, toMono } from '../../src/dsp/resample'
import type { PlanTrack } from '../../src/dj/transitions'
import { readWav } from '../wav'

export const ROOT = 'C:/crowdpilot-data'
export const ML = join(ROOT, 'ml')
export const CORPORA = ['house_eval', 'jamendo_eval'] as const

export interface CachedTrack {
  key: string
  corpus: string
  id: number
  title: string
  artist: string
  licence: string
  wav: string
  split: 'train' | 'val' | 'test'
  summary: AnalysisSummary
  netBeats: number[]
}

/** Deterministic track-level split (hash of the track key): 65 / 15 / 20. */
export function splitOf(key: string): CachedTrack['split'] {
  const h = createHash('sha256').update(`cp-split-v1:${key}`).digest().readUInt32BE(0) / 2 ** 32
  return h < 0.65 ? 'train' : h < 0.8 ? 'val' : 'test'
}

export function loadAnalysisCache(): CachedTrack[] {
  const p = join(ML, 'cache', 'analysis.json')
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  mkdirSync(join(ML, 'cache'), { recursive: true })
  const out: CachedTrack[] = []
  const seen = new Set<string>()
  for (const corpus of CORPORA) {
    const dir = join(ROOT, 'raw', corpus)
    const list = JSON.parse(readFileSync(join(dir, 'corpus.json'), 'utf8')) as Array<{ id: number; title: string; artist: string; wav: string; licence: string }>
    const net = JSON.parse(readFileSync(join(dir, 'beatnet_ts.json'), 'utf8')) as Record<string, { beats: number[]; downbeats: number[] }>
    for (const c of list) {
      const key = `jamendo:${c.id}`
      if (seen.has(key) || !net[String(c.id)]) continue
      seen.add(key)
      const w = readWav(c.wav)
      const a = analyzeTrack({ channels: w.channels, sampleRate: w.rate, net: net[String(c.id)] })
      out.push({ key, corpus, id: c.id, title: c.title, artist: c.artist, licence: c.licence, wav: c.wav, split: splitOf(key), summary: summarize(a), netBeats: a.netBeats ?? [] })
      console.log(`analysed ${out.length}: ${c.artist} – ${c.title}`)
    }
  }
  writeFileSync(p, JSON.stringify(out))
  return out
}

export function planTrack(t: CachedTrack, itemId: string): PlanTrack {
  return { itemId, trackKey: t.key, title: t.title, mixable: true, summary: t.summary, durationSec: t.summary.durationSec }
}

/** Mono PCM at `rate`, LRU-cached (keeps the working set small when sharded by outgoing track). */
export class PcmCache {
  private map = new Map<string, Float32Array>()
  constructor(private rate: number, private max = 10) {}
  get(t: CachedTrack): Float32Array {
    const hit = this.map.get(t.key)
    if (hit) {
      this.map.delete(t.key)
      this.map.set(t.key, hit)
      return hit
    }
    const w = readWav(t.wav)
    const mono = resample(toMono(w.channels), w.rate, this.rate)
    this.map.set(t.key, mono)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
    return mono
  }
}
