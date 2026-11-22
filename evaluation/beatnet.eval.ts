/** Validates the TypeScript Beat This! pipeline against the official Python implementation. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { runBeatNet, BEATNET_SR } from '../src/dsp/beatnet'
import { resample, toMono } from '../src/dsp/resample'
import { nodeBeatNet } from './beatnet-node'
import { readWav, f1 } from './wav'

const CORPUS = join(process.env.CP_DATA_ROOT ?? 'C:/crowdpilot-data', 'raw', 'jamendo_eval')

it('TS Beat This! matches Python on the eval corpus', async () => {
  const corpus = JSON.parse(readFileSync(join(CORPUS, 'corpus.json'), 'utf8')) as Array<{ id: number; wav: string }>
  const ref = JSON.parse(readFileSync(join(CORPUS, 'beatthis_ref.json'), 'utf8')) as Record<string, Record<string, { beats: number[]; downbeats: number[] }>>
  const { run, bank } = await nodeBeatNet()
  const rows = []
  const cache: Record<string, { beats: number[]; downbeats: number[] }> = {}
  for (const c of corpus) {
    const w = readWav(c.wav)
    const mono = resample(toMono(w.channels), w.rate, BEATNET_SR)
    const t0 = performance.now()
    const r = await runBeatNet(mono, bank, run)
    const ms = performance.now() - t0
    cache[String(c.id)] = { beats: r.beats, downbeats: r.downbeats }
    const py = ref[String(c.id)]
    rows.push({ id: c.id, ms: Math.round(ms), beatF1_vs_pySmall: f1(py.small0.beats, r.beats), downF1_vs_pySmall: f1(py.small0.downbeats, r.downbeats), beatF1_vs_pyFinal: f1(py.final0.beats, r.beats), downF1_vs_pyFinal: f1(py.final0.downbeats, r.downbeats) })
  }
  writeFileSync(join(CORPUS, 'beatnet_ts.json'), JSON.stringify(cache))
  const med = (k: string) => { const v = rows.map((r) => (r as Record<string, number>)[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
  const min = (k: string) => Math.min(...rows.map((r) => (r as Record<string, number>)[k]))
  const summary = { tracks: rows.length, beatF1_vs_pySmall_median: med('beatF1_vs_pySmall'), beatF1_vs_pySmall_min: min('beatF1_vs_pySmall'), downF1_vs_pySmall_median: med('downF1_vs_pySmall'), downF1_vs_pySmall_min: min('downF1_vs_pySmall'), beatF1_vs_pyFinal_median: med('beatF1_vs_pyFinal'), downF1_vs_pyFinal_median: med('downF1_vs_pyFinal'), node_ms_per_track_median: med('ms') }
  writeFileSync(join(CORPUS, 'beatnet_validation.json'), JSON.stringify({ summary, rows }, null, 1))
  console.log(JSON.stringify(summary, null, 1))
}, 3_600_000)
