/**
 * Experiment 3 (part 1): pick held-out house pairs (≈ equal tempo), render CrowdPilot's 8-bar
 * bass swap for each, and write the cue specification that DJtransGAN's pretrained generator
 * receives for the SAME 8-bar region (ml/experiments/run_djtransgan.py renders its version).
 *
 *   npx vitest run -c vitest.eval.config.ts evaluation/ml/djtg_pairs.eval.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { toMono } from '../../src/dsp/resample'
import { encodeWav, renderTransition } from '../../src/dj/render'
import { candidateTransitions, DEFAULT_OPTIONS, tempoMatch } from '../../src/dj/transitions'
import { refineWithLocalBeats } from '../../src/dj/phase'
import { trimDbFor } from '../../src/dj/engine/deck-engine'
import { readWav } from '../wav'
import { loadAnalysisCache, ML, planTrack, ROOT } from './common'

it('DJtransGAN comparison pairs', () => {
  const out = join(ML, 'djtg')
  mkdirSync(out, { recursive: true })
  const tracks = loadAnalysisCache().filter((t) => t.split !== 'train')
  const net = Object.assign({}, ...['house_eval', 'jamendo_eval'].map((c) => JSON.parse(readFileSync(join(ROOT, 'raw', c, 'beatnet_ts.json'), 'utf8')))) as Record<string, { beats: number[]; downbeats: number[] }>
  const order = [...tracks].sort((a, b) => a.summary.bpm - b.summary.bpm)
  const specs: unknown[] = []
  for (let k = 0; k + 1 < order.length && specs.length < 10; k++) {
    const A = order[k]
    const B = order[k + 1]
    if (Math.abs(tempoMatch(A.summary.bpm, B.summary.bpm).ratio - 1) > 0.02) continue
    const plans = candidateTransitions(planTrack(A, 'a'), planTrack(B, 'b'), { ...DEFAULT_OPTIONS, allowedStyles: ['bass_swap'] }).filter((p) => p.overlapBars === 8)
    if (!plans.length) continue
    let p = plans[0]
    p = { ...p, ...refineWithLocalBeats(p, A.netBeats, B.netBeats) }
    const wa = readWav(A.wav)
    const wb = readWav(B.wav)
    const r = renderTransition({ rate: wa.rate, out: [toMono(wa.channels)], in: [toMono(wb.channels)], plan: p, outTrimDb: trimDbFor(A.summary.lufs, A.summary.truePeak), inTrimDb: trimDbFor(B.summary.lufs, B.summary.truePeak), preRollSec: 10, postRollSec: 10 })
    const id = `d${String(specs.length).padStart(2, '0')}`
    writeFileSync(join(out, `${id}_crowdpilot.wav`), encodeWav(r.channels, r.rate))
    const inEnd = p.inCueSec + p.durationSec * p.tempoRatio
    specs.push({
      id,
      a: A.key,
      b: B.key,
      prev_wav: A.wav,
      next_wav: B.wav,
      prev_beats: net[String(A.id)].beats,
      prev_downbeats: net[String(A.id)].downbeats,
      next_beats: net[String(B.id)].beats,
      next_downbeats: net[String(B.id)].downbeats,
      // DJtransGAN cue semantics: the END of the 8-bar cue region in each track
      prev_cue: p.outCueSec + p.durationSec,
      next_cue: inEnd,
      crowdpilot: { style: p.style, outCueSec: p.outCueSec, inCueSec: p.inCueSec, durationSec: p.durationSec, tempoRatio: p.tempoRatio, t0: r.transitionStartSample / r.rate, t1: r.transitionStartSample / r.rate + p.durationSec, beatSec: p.beatSec },
    })
  }
  writeFileSync(join(out, 'pairs.json'), JSON.stringify(specs, null, 1))
  console.log(`DJtransGAN pairs: ${specs.length}`)
}, 3_600_000)
