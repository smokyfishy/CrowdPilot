/**
 * Blind A/B set #2 (house, 118–132 BPM): v2 = current live planner restricted to the classic
 * blend styles; v3 = the same + creative techniques (drop swap, filter sweep, echo-out, loop roll,
 * brake, scratch). Both use the in-browser Beat This! grid + local refinement. Pairs are rendered
 * in set order so the variety rotation (recent styles) applies, as in a real set.
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ab_house.eval.ts
 *
 * Output (private): C:\crowdpilot-data\listening_house\
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyzeTrack, summarize } from '../src/dsp/analyze'
import { encodeWav, renderTransition } from '../src/dj/render'
import { bestTransition, DEFAULT_OPTIONS, type PlanTrack, type TransitionPlan, type TransitionStyle } from '../src/dj/transitions'
import { refineWithLocalBeats } from '../src/dj/phase'
import { trimDbFor } from '../src/dj/engine/deck-engine'
import { readWav } from './wav'
import { page } from './ab-page'

const ROOT = 'C:/crowdpilot-data'
const CORPUS = join(ROOT, 'raw', 'house_eval')
const OUT = join(ROOT, 'listening_house')
const CLASSIC: TransitionStyle[] = ['cut', 'short_fade', 'long_blend', 'bass_swap', 'percussion_led', 'unmatched_fade']

function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

it('build house blind A/B set (v2 vs v3 creative)', () => {
  mkdirSync(OUT, { recursive: true })
  const ref = JSON.parse(readFileSync(join(CORPUS, 'beatthis_ref.json'), 'utf8')) as Record<string, { final0: { beats: number[] } }>
  const bpmOf = (id: number) => {
    const b = ref[String(id)]?.final0?.beats ?? []
    const d = b.slice(1).map((v, i) => v - b[i]).sort((x, y) => x - y)
    return d.length ? 60 / d[Math.floor(d.length / 2)] : 0
  }
  const corpus = (JSON.parse(readFileSync(join(CORPUS, 'corpus.json'), 'utf8')) as Array<{ id: number; title: string; artist: string; wav: string }>).filter((c) => bpmOf(c.id) >= 118 && bpmOf(c.id) <= 132)
  const net = JSON.parse(readFileSync(join(CORPUS, 'beatnet_ts.json'), 'utf8')) as Record<string, { beats: number[]; downbeats: number[] }>
  const tracks = corpus.map((c) => {
    const w = readWav(c.wav)
    const a = analyzeTrack({ channels: w.channels, sampleRate: w.rate, net: net[String(c.id)] })
    return { c, w, a, s: summarize(a) }
  })
  const order = [...tracks].sort((a, b) => a.s.bpm - b.s.bpm)
  const rand = rng(1122)
  const recent: Record<'v2' | 'v3', TransitionStyle[]> = { v2: [], v3: [] }
  const key: Record<string, Record<string, string>> = {}
  const manifest: unknown[] = []
  const items: Array<{ pair: string; a: string; b: string; title: string }> = []
  for (let k = 0; k + 1 < order.length && items.length < 24; k++) {
    const A = order[k]
    const B = order[k + 1]
    const pid = `h${String(k).padStart(2, '0')}`
    const mk = (t: typeof A, id: string): PlanTrack => ({ itemId: id, trackKey: `jamendo:${t.c.id}`, title: t.c.title, mixable: true, summary: t.s, durationSec: t.s.durationSec })
    const plan = (ver: 'v2' | 'v3'): TransitionPlan => {
      let p = bestTransition(mk(A, 'a'), mk(B, 'b'), { ...DEFAULT_OPTIONS, recentStyles: recent[ver], allowedStyles: ver === 'v2' ? CLASSIC : undefined }, 0).best
      if (p.durationSec >= 4) p = { ...p, ...refineWithLocalBeats(p, A.a.netBeats, B.a.netBeats) }
      recent[ver].unshift(p.style)
      return p
    }
    const p2 = plan('v2')
    const p3 = plan('v3')
    if (p2.style === 'sequential' || p3.style === 'sequential') continue
    const render = (p: TransitionPlan) => renderTransition({ rate: A.w.rate, out: A.w.channels, in: B.w.channels, plan: p, outTrimDb: trimDbFor(A.s.lufs, A.s.truePeak), inTrimDb: trimDbFor(B.s.lufs, B.s.truePeak), preRollSec: 10, postRollSec: 10 })
    const r2 = render(p2)
    const r3 = render(p3)
    const flip = rand() < 0.5
    const files: Record<string, string> = {}
    for (const [label, r, algo] of [
      ['1', flip ? r3 : r2, flip ? 'v3' : 'v2'],
      ['2', flip ? r2 : r3, flip ? 'v2' : 'v3'],
    ] as const) {
      const wav = encodeWav(r.channels, r.rate)
      const f = `${pid}_version${label}.wav`
      writeFileSync(join(OUT, f), wav)
      files[label] = f
      ;(key[pid] ??= {})[label] = algo
      manifest.push({ pair: pid, label, file: f, sha256: createHash('sha256').update(wav).digest('hex'), clipped: r.clippedSamples })
    }
    manifest.push({ pair: pid, a: A.c.id, b: B.c.id, v2: { style: p2.style, bars: p2.overlapBars }, v3: { style: p3.style, bars: p3.overlapBars } })
    items.push({ pair: pid, a: files['1'], b: files['2'], title: `${A.c.artist} – ${A.c.title}  →  ${B.c.artist} – ${B.c.title}` })
  }
  writeFileSync(join(OUT, 'key.json'), JSON.stringify({ note: 'Do not open before rating.', algorithms: { v2: 'live planner, classic blend styles (Beat This! grid + refinement)', v3: 'v2 + creative techniques (drop swap, filter sweep, echo-out, loop roll, brake, scratch)' }, key }, null, 1))
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1))
  writeFileSync(join(OUT, 'index.html'), page(items, 'cp_ab_house'))
  console.log(`house listening set: ${items.length} pairs; v3 styles: ${JSON.stringify(recent.v3)}`)
  void existsSync
}, 3_600_000)
