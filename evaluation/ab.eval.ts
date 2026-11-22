/**
 * Blind A/B listening set: the SAME track pairs rendered by the previously deployed algorithm
 * ("legacy": DSP grid + old planner + shelving EQ, code restored from commit 5859511) and the
 * current one ("v2": Beat This! grid + local refinement + new planner + LR4 isolator).
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ab.eval.ts
 *
 * Writes C:\crowdpilot-data\listening\ (private; never committed or deployed — the tracks'
 * licences do not allow redistribution): index.html, version_*.wav, key.json (label map,
 * kept out of the page), manifest.json (plans, hashes, versions).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyzeTrack, summarize } from '../src/dsp/analyze'
import { encodeWav, renderTransition } from '../src/dj/render'
import { bestTransition, DEFAULT_OPTIONS, type PlanTrack } from '../src/dj/transitions'
import { refineWithLocalBeats } from '../src/dj/phase'
import { trimDbFor } from '../src/dj/engine/deck-engine'
import { bestTransition as legacyBest, DEFAULT_OPTIONS as LEGACY_OPTS } from './legacy/transitions'
import { renderTransition as legacyRender } from './legacy/render'
import { readWav } from './wav'
import { page } from './ab-page'

const ROOT = 'C:/crowdpilot-data'
const OUT = join(ROOT, 'listening')

function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

it('build blind A/B listening set', () => {
  mkdirSync(OUT, { recursive: true })
  const corpus = JSON.parse(readFileSync(join(ROOT, 'raw/jamendo_eval/corpus.json'), 'utf8')) as Array<{ id: number; title: string; artist: string; wav: string; licence: string }>
  const net = JSON.parse(readFileSync(join(ROOT, 'raw/jamendo_eval/beatnet_ts.json'), 'utf8')) as Record<string, { beats: number[]; downbeats: number[] }>
  const tracks = corpus.map((c) => {
    const w = readWav(c.wav)
    const legacyA = analyzeTrack({ channels: w.channels, sampleRate: w.rate })
    const v2A = analyzeTrack({ channels: w.channels, sampleRate: w.rate, net: net[String(c.id)] })
    return { c, w, legacy: summarize(legacyA), v2: summarize(v2A), v2A }
  })
  // pair by the v2 (reference-quality) tempo so both algorithms get identical pairs
  const order = [...tracks].sort((a, b) => a.v2.bpm - b.v2.bpm)
  const rand = rng(20261122)
  const manifest: unknown[] = []
  const key: Record<string, Record<string, string>> = {}
  const items: Array<{ pair: string; a: string; b: string; title: string }> = []
  for (let k = 0; k + 1 < order.length; k++) {
    const A = order[k]
    const B = order[k + 1]
    const pid = `p${String(k).padStart(2, '0')}`
    const mk = (s: typeof A.v2, t: typeof A, id: string): PlanTrack => ({ itemId: id, trackKey: `jamendo:${t.c.id}`, title: t.c.title, mixable: true, summary: s, durationSec: s.durationSec })
    // legacy
    const lp = legacyBest(mk(A.legacy, A, 'a'), mk(B.legacy, B, 'b'), LEGACY_OPTS, 0).best
    const lr = lp.style === 'sequential' ? null : legacyRender({ rate: A.w.rate, out: A.w.channels, in: B.w.channels, plan: lp, outTrimDb: trimDbFor(A.legacy.lufs), inTrimDb: trimDbFor(B.legacy.lufs) })
    // v2
    let vp = bestTransition(mk(A.v2, A, 'a'), mk(B.v2, B, 'b'), DEFAULT_OPTIONS, 0).best
    if (vp.durationSec >= 4) vp = { ...vp, ...refineWithLocalBeats(vp, A.v2A.netBeats, B.v2A.netBeats) }
    const vr = vp.style === 'sequential' ? null : renderTransition({ rate: A.w.rate, out: A.w.channels, in: B.w.channels, plan: vp, outTrimDb: trimDbFor(A.v2.lufs, A.v2.truePeak), inTrimDb: trimDbFor(B.v2.lufs, B.v2.truePeak) })
    if (!lr || !vr) continue
    const flip = rand() < 0.5
    const files: Record<string, string> = {}
    for (const [label, render, algo] of [
      ['1', flip ? vr : lr, flip ? 'v2' : 'legacy'],
      ['2', flip ? lr : vr, flip ? 'legacy' : 'v2'],
    ] as const) {
      const wav = encodeWav(render.channels, render.rate)
      const f = `${pid}_version${label}.wav`
      writeFileSync(join(OUT, f), wav)
      files[label] = f
      ;(key[pid] ??= {})[label] = algo
      manifest.push({ pair: pid, label, file: f, sha256: createHash('sha256').update(wav).digest('hex') })
    }
    manifest.push({ pair: pid, a: A.c.id, b: B.c.id, legacy: { style: lp.style, outCue: lp.outCueSec, inCue: lp.inCueSec, ratio: lp.tempoRatio }, v2: { style: vp.style, outCue: vp.outCueSec, inCue: vp.inCueSec, ratio: vp.tempoRatio } })
    items.push({ pair: pid, a: files['1'], b: files['2'], title: `${A.c.artist} – ${A.c.title}  →  ${B.c.artist} – ${B.c.title}` })
  }
  writeFileSync(join(OUT, 'key.json'), JSON.stringify({ note: 'Do not open before rating. Maps pair → version label → algorithm.', algorithms: { legacy: 'deployed baseline (commit 5859511)', v2: 'Beat This! grid + local refinement + new planner + LR4 isolator' }, key }, null, 1))
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1))
  writeFileSync(join(OUT, 'index.html'), page(items))
  console.log(`listening set: ${items.length} pairs → ${OUT}\\index.html`)
}, 3_600_000)

