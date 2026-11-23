/**
 * Performance manifest ⇄ rendered audio. These tests check that the controller's replay is the
 * performance that produced the audio, not a plausible animation:
 *  - deck positions: the final mix audio at time t must BE the source track at the evaluated
 *    position (cross-correlation, ±3 ms), across bodies, splices and the limiter latency;
 *  - mixer lanes: channel state equals the executed plan curves at every beat;
 *  - channel meters: recorded per-deck levels follow who is audible;
 *  - evaluation is a pure function of time (seek/restart reconstruct state);
 *  - older manifests degrade to `reduced` without inventing levels, waveforms or performance moves.
 */
import { describe, expect, it } from 'vitest'
import { analyzeTrack, summarize } from '../dsp/analyze'
import { synthTrack } from '../dsp/synth'
import { curveAt } from '../dj/automation'
import { renderMix } from './mix-render'
import { planMix, type PlannedTrack } from './mixplan'
import { buildPerformance, createEvaluator, deckOf, performanceFor, type PerformanceManifest } from './performance'
import { MixSpec, resolveSpec } from './spec'

const RATE = 22050

async function renderSynthMix() {
  const specs = [
    { bpm: 124, bars: 96, tonic: 9, seed: 11 },
    { bpm: 127, bars: 96, tonic: 4, seed: 12 },
    { bpm: 125, bars: 96, tonic: 9, seed: 13 },
  ]
  const tracks = specs.map((s) => synthTrack({ ...s, sampleRate: RATE, mode: 'minor', introBars: 16, outroBars: 16, breakdown: [40, 48] }))
  const sums = tracks.map((t) => summarize(analyzeTrack({ channels: t.channels, sampleRate: RATE })))
  const planned: PlannedTrack[] = sums.map((s, i) => ({ key: `k${i}`, title: `synth ${i}`, summary: s, trimDb: 0 }))
  const plan = planMix(planned, resolveSpec(MixSpec.parse({ song_count: 3, target_duration_minutes: 7, transition_style: 'smooth' })))
  const stereo = tracks.map((t) => [t.channels[0], t.channels[1] ?? t.channels[0]])
  const byKey = new Map(stereo.map((c, i) => [`k${i}`, { channels: c, rate: RATE }]))
  const out: Float32Array[] = []
  const r = await renderMix(plan, { load: async (k) => byKey.get(k)! }, { write: (b) => void out.push(b[0].slice()) })
  const total = out.reduce((s, b) => s + b.length, 0)
  const mix = new Float32Array(total)
  let o = 0
  for (const b of out) {
    mix.set(b, o)
    o += b.length
  }
  const perf = buildPerformance({
    plans: plan.transitions.map((t) => t.plan),
    transitionStarts: r.transitions.map((t) => t.mixStartSec),
    labels: plan.transitions.map((t) => t.plan.style),
    telemetry: r.telemetry!,
    durationSec: r.metrics.durationSec,
    tracks: sums.map((s, i) => ({ key: `k${i}`, title: `synth ${i}`, artist: 'synth', bpm: s.bpm, musicalKey: s.key, camelot: s.camelot, durationSec: s.durationSec, trimDb: 0, entrySec: plan.tracks[i].entrySec, drops: [], grid: { firstBeatSec: s.firstBeat, beatSec: 60 / s.bpm, downbeatPhase: s.downbeatPhase } })),
  })
  return { plan, r, perf, mix, src: stereo.map((c) => c[0]) }
}

/** Lag (s) of `src` around `pos` that best matches the mix at `t` (normalized cross-correlation). */
function lagAt(mix: Float32Array, src: Float32Array, t: number, pos: number, radiusSec = 0.05) {
  const len = 4096
  const m0 = Math.round(t * RATE)
  const s0 = Math.round(pos * RATE)
  const R = Math.round(radiusSec * RATE)
  let best = { lag: 0, corr: -2 }
  for (let lag = -R; lag <= R; lag++) {
    let dot = 0
    let ea = 0
    let eb = 0
    for (let i = 0; i < len; i += 2) {
      const a = mix[m0 + i] ?? 0
      const b = src[s0 + lag + i] ?? 0
      dot += a * b
      ea += a * a
      eb += b * b
    }
    const c = dot / Math.sqrt(ea * eb + 1e-12)
    if (c > best.corr) best = { lag, corr: c }
  }
  return { lagSec: best.lag / RATE, corr: best.corr }
}

describe('performance manifest replays the rendered mix', () => {
  let fx: Awaited<ReturnType<typeof renderSynthMix>>
  it('renders (setup)', async () => {
    fx = await renderSynthMix()
    expect(fx.perf.fidelity).toBe('full')
    expect(fx.perf.transitions).toHaveLength(2)
    expect(fx.perf.crossfader).toBeNull()
  }, 180_000)

  it('deck position = the audio actually heard (bodies, after splices, after limiter latency)', () => {
    const ev = createEvaluator(fx.perf)
    let checked = 0
    for (let t = 2; t < fx.perf.durationSec - 4; t += 3.7) {
      const s = ev.evaluate(t)
      // only where exactly one deck is audible at unity with a flat EQ (the plain body)
      const live = (['A', 'B'] as const).filter((d) => s.ch[d].gain > 0.001)
      if (live.length !== 1) continue
      const d = live[0]
      const c = s.ch[d]
      if (c.gain < 0.999 || c.low || c.mid || c.high || c.filter || s.transition) continue
      const st = s.deck[d]
      const { lagSec, corr } = lagAt(fx.mix, fx.src[st.track!], t, st.pos)
      expect(corr, `t=${t.toFixed(1)} deck ${d}`).toBeGreaterThan(0.9)
      expect(Math.abs(lagSec), `t=${t.toFixed(1)} deck ${d} lag`).toBeLessThan(0.003)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('incoming deck position holds through the tempo-recovery tail (before the splice)', () => {
    const ev = createEvaluator(fx.perf)
    let checked = 0
    for (const tt of fx.perf.transitions) {
      // after the overlap the outgoing fader is closed: the mix is the incoming (stretched) deck
      for (let j = tt.durationSec + 0.5; j < tt.spliceSec - 0.3; j += 0.9) {
        const t = tt.mixStartSec + j
        const s = ev.evaluate(t)
        const d = deckOf(tt.to)
        if (s.ch[deckOf(tt.from)].gain > 0.001 || s.ch[d].low < -1) continue
        const { lagSec, corr } = lagAt(fx.mix, fx.src[tt.to], t, s.deck[d].pos, 0.06)
        // periodic synthetic loops give weak false peaks; compare only confident matches. WSOLA frame
        // jitter + isolator phase leave a few ms between the nominal law and the heard audio.
        if (corr < 0.85) continue
        expect(Math.abs(lagSec), `transition ${tt.index} j=${j.toFixed(1)}`).toBeLessThan(0.015)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('channel faders / EQ / filter equal the executed plan curves at every beat', () => {
    const ev = createEvaluator(fx.perf)
    for (const [k, tt] of fx.plan.transitions.entries()) {
      const p = tt.plan
      const t0 = fx.perf.transitions[k].mixStartSec
      for (let beat = 0; beat <= p.overlapBars * 4; beat += 0.5) {
        const s = ev.evaluate(t0 + beat * p.beatSec)
        const out = s.ch[deckOf(k)]
        const inc = s.ch[deckOf(k + 1)]
        expect(out.gain).toBeCloseTo(curveAt(p.out.gain, beat), 9)
        expect(out.low).toBeCloseTo(curveAt(p.out.low, beat), 9)
        expect(out.high).toBeCloseTo(curveAt(p.out.high, beat), 9)
        expect(inc.gain).toBeCloseTo(curveAt(p.in.gain, beat), 9)
        expect(inc.low).toBeCloseTo(curveAt(p.in.low, beat), 9)
        expect(inc.mid).toBeCloseTo(curveAt(p.in.mid, beat), 9)
        expect(out.filter).toBeCloseTo(p.filter?.out ? curveAt(p.filter.out, beat) : 0, 9)
        expect(s.transition?.index).toBe(k)
      }
      // tempo fader shows the applied ratio during the overlap (pitch preserved)
      const mid = ev.evaluate(t0 + p.durationSec / 2)
      const inc = mid.deck[deckOf(k + 1)]
      expect(inc.role).toBe('incoming')
      expect(inc.tempoPct).toBeCloseTo((p.tempoRatio - 1) * 100, 6)
      expect(inc.keyLock).toBe(Math.abs(p.tempoRatio - 1) > 1e-4)
    }
  })

  it('channel meters follow who is audible; master follows the file', () => {
    const ev = createEvaluator(fx.perf)
    const first = fx.perf.transitions[0]
    const solo = ev.evaluate(first.mixStartSec / 2)
    expect(solo.ch.A.levelDb!).toBeGreaterThan(-30)
    expect(solo.ch.B.levelDb!).toBeLessThan(-55)
    expect(solo.masterDb!).toBeGreaterThan(-30)
    const after = ev.evaluate(fx.perf.transitions[1].mixStartSec - 5)
    expect(after.ch.B.levelDb!).toBeGreaterThan(-30)
    expect(after.ch.A.levelDb!).toBeLessThan(-55)
    // master meter = RMS of the written file: at a frame centre it is exactly that frame's RMS (1 dB quantization)
    const F = Math.round(fx.perf.levels!.secPerFrame * RATE)
    let compared = 0
    for (let k = 20; k * F < fx.mix.length - F; k += 97) {
      let e = 0
      for (let i = k * F; i < (k + 1) * F; i++) e += fx.mix[i] * fx.mix[i]
      const db = 10 * Math.log10(e / F)
      if (!(db > -55)) continue // digital silence: the meter sits at its floor
      expect(Math.abs(ev.evaluate((k + 0.5) * fx.perf.levels!.secPerFrame).masterDb! - db), `frame ${k}`).toBeLessThan(0.51)
      compared++
    }
    expect(compared).toBeGreaterThan(20)
  })

  it('evaluation is a pure function of time (seek / restart / any order)', () => {
    const ev = createEvaluator(fx.perf)
    const ts = [5, 200, 60.5, fx.perf.transitions[1].mixStartSec + 3, 0, 5]
    const a = ts.map((t) => JSON.stringify(ev.evaluate(t)))
    const b = createEvaluator(fx.perf)
    expect(JSON.stringify(b.evaluate(5))).toBe(a[0])
    expect(a[5]).toBe(a[0])
    // restart: nothing is playing before the first audio sample except deck A cued
    const z = ev.evaluate(0)
    expect(z.deck.A.track).toBe(0)
    expect(z.deck.B.track).toBe(1)
    expect(z.deck.B.role).toBe('cued')
    expect(z.deck.B.playing).toBe(false)
  })

  it('decks swap tracks only after the previous occupant is released', () => {
    const ev = createEvaluator(fx.perf)
    const t1 = fx.perf.transitions[1]
    const during = ev.evaluate(t1.mixStartSec + 1)
    expect(during.deck.A.track).toBe(2) // track 2 was loaded onto A after track 0's transition spliced out
    expect(during.deck.B.track).toBe(1)
    expect(during.deck.B.role).toBe('outgoing')
  })
})

describe('evaluator with performance moves and technique edits', () => {
  const base: PerformanceManifest = {
    version: 1,
    fidelity: 'full',
    durationSec: 200,
    latencySec: 0,
    crossfader: null,
    missing: [],
    tracks: [0, 1].map((i) => ({ index: i, key: `k${i}`, deck: deckOf(i), title: `t${i}`, artist: 'a', bpm: 125, musicalKey: 'Am', camelot: '8A', durationSec: 300, trimDb: 0, drops: [], cueSec: i ? 32 : 0, grid: { firstBeatSec: 0, beatSec: 0.48, downbeatPhase: 0 } })),
    transitions: [
      {
        index: 0, from: 0, to: 1, style: 'loop_roll', label: 'Loop roll', mixStartSec: 100, beatSec: 0.48, overlapBars: 2, durationSec: 3.84, outCueSec: 100, inCueSec: 32, tempoRatio: 1, tempoRecoveryBars: 0, beatmatched: false, spliceSec: 5.8, spliceLagSec: 0,
        out: { gain: [{ beat: 0, value: 1 }, { beat: 8, value: 0 }], low: [], mid: [], high: [] },
        in: { gain: [{ beat: 0, value: 0 }, { beat: 8, value: 1 }], low: [], mid: [], high: [] },
        outPerf: { startBeat: 0, beats: 8, ops: [{ kind: 'roll', atBeat: 0, sizes: [1, 0.5, 0.25, 0.125], stepBeats: 2 }] },
        deckEdits: { in: [{ kind: 'juggle', startSec: 32, beats: 4, beatSec: 0.48, offsetBeats: 2, pattern: [0, 1] }] },
      },
    ],
  }
  it('roll: loop region, pad lit for the active size, platter loops', () => {
    const ev = createEvaluator(base)
    const s = ev.evaluate(100 + 2.5 * 0.48) // second step → 1/2-beat roll
    expect(s.deck.A.loop).toEqual({ startSec: 100, beats: 0.5 })
    expect(s.deck.A.pads.mode).toBe('roll')
    expect(s.deck.A.pads.labels[s.deck.A.pads.lit]).toBe('1/2')
    expect(s.deck.A.pos).toBeGreaterThanOrEqual(100)
    expect(s.deck.A.pos).toBeLessThan(100 + 0.24 + 1e-9)
  })
  it('juggle: repeat beats jump back, live beats play through', () => {
    const ev = createEvaluator(base)
    const live = ev.evaluate(100 + 0.2) // incoming beat 0 = live
    expect(live.deck.B.pads).toMatchObject({ mode: 'juggle', lit: 0 })
    expect(live.deck.B.pos).toBeCloseTo(32.2, 6)
    const rep = ev.evaluate(100 + 0.48 + 0.2) // beat 1 = repeat of 2 beats back
    expect(rep.deck.B.pads.lit).toBe(1)
    expect(rep.deck.B.pos).toBeCloseTo(32.68 - 0.96, 6)
  })
  it('no echo / reverb / stems reported when the plan had none', () => {
    const s = createEvaluator(base).evaluate(101)
    expect(s.ch.A.echo).toBeNull()
    expect(s.ch.A.reverb).toBeNull()
    expect(s.ch.A.stems).toBeNull()
  })
})

describe('older manifests degrade without inventing telemetry', () => {
  it('reduced fidelity: no deck meters or waveforms, curves converted from seconds to beats', () => {
    const curve = (v0: number, v1: number) => ({ t: [0, 7.68], v: [v0, v1] })
    const m = {
      durationSec: 300,
      tracks: [0, 1].map((i) => ({ key: `k${i}`, title: `t${i}`, artist: 'a', bpm: 125, key_: 'Am', camelot: '8A', durationSec: 200, trimDb: -1, entrySec: 0, drops: [] })),
      transitions: [{ style: 'long_blend', label: 'Long phrase blend', mixStartSec: 150, overlapBars: 4, overlapSec: 7.68, outCueSec: 150, inCueSec: 16, tempoRatio: 1.01, tempoRecoverySec: 7.68, beatSec: 0.48, beatAlignment: { spliceLagMs: 2 }, curves: { out: { gain: curve(1, 0), low: curve(0, -40), mid: curve(0, 0), high: curve(0, 0) }, in: { gain: curve(0, 1), low: curve(-40, 0), mid: curve(0, 0), high: curve(0, 0) } }, effects: [{ kind: 'roll', startSec: 151, endSec: 152, detail: 'loop roll' }] }],
      energy: { secPerPoint: 1, rmsDb: Array(300).fill(-14) },
    }
    const perf = performanceFor(m)
    expect(perf.fidelity).toBe('reduced')
    expect(perf.peaks).toBeUndefined()
    expect(perf.missing.join(' ')).toMatch(/per-deck levels/)
    const ev = createEvaluator(perf)
    const s = ev.evaluate(150 + 3.84)
    expect(s.ch.A.gain).toBeCloseTo(0.5, 6)
    expect(s.ch.B.low).toBeCloseTo(-20, 6)
    expect(s.ch.A.levelDb).toBeNull()
    expect(s.masterDb).toBeCloseTo(-14, 6)
    expect(s.deck.A.loop).toBeNull() // performance move parameters were not recorded: indicator only
    expect(createEvaluator(perf).evaluate(151.5).fxIndicators).toEqual(['roll'])
  })
})
