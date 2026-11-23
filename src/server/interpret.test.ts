import { describe, expect, it } from 'vitest'
import { interpretPrompt } from './mixgen-routes'
import type { LlmCall } from './llm'
import { detectTechniques, eraYears, guardSpec, heuristicSpec, MixSpec, resolveSpec } from '../mixgen/spec'

const valid = (over: Partial<MixSpec> = {}) => JSON.stringify(MixSpec.parse({ genres: ['tech house'], song_count: 12, target_duration_minutes: 45, explicit: ['genres', 'song_count', 'target_duration_minutes'], summary: 's', ...over }))
const fake = (name: string, replies: Array<string | Error>): LlmCall & { calls: number } => {
  const f = {
    name,
    calls: 0,
    async call() {
      const r = replies[Math.min(f.calls, replies.length - 1)]
      f.calls++
      if (r instanceof Error) throw r
      return r
    },
  }
  return f
}

describe('prompt interpretation chain (LLM chain → heuristic)', () => {
  const prompt = 'A 45-minute tech house mix with 12 tracks'
  it('uses the first interpreter when it returns a valid spec, and records the model', async () => {
    const g = fake('primary-llm', [valid()])
    const c = fake('backup-llm', [valid()])
    const r = await interpretPrompt([g, c], { prompt })
    expect(r.source).toBe('llm')
    expect(r.model).toBe('primary-llm')
    expect(r.spec.interpretation?.model).toBe('primary-llm')
    expect(c.calls).toBe(0)
  })
  it('falls back to the next interpreter when one fails, then to the heuristic', async () => {
    const r1 = await interpretPrompt([fake('primary-llm', [new Error('HTTP 429')]), fake('backup-llm', [valid()])], { prompt })
    expect(r1.model).toBe('backup-llm')
    expect(r1.attempts.join()).toMatch(/primary-llm: HTTP 429/)
    const r2 = await interpretPrompt([fake('primary-llm', [new Error('down')]), fake('backup-llm', ['not json'])], { prompt })
    expect(r2.source).toBe('heuristic')
    expect(r2.spec.target_duration_minutes).toBe(45)
  })
  it('repairs an invalid reply once with the validation errors', async () => {
    const g = fake('primary-llm', [JSON.stringify({ song_count: 500 }), valid()])
    const r = await interpretPrompt([g], { prompt })
    expect(r.model).toBe('primary-llm')
    expect(g.calls).toBe(2)
  })
  it('the guard enforces stated numbers and genres the model got wrong', async () => {
    const wrong = valid({ target_duration_minutes: 30, song_count: 8, genres: [] })
    const r = await interpretPrompt([fake('primary-llm', [wrong])], { prompt: 'Make a 45-minute tech house mix with 12 tracks at 124-128 bpm' })
    expect(r.spec.target_duration_minutes).toBe(45)
    expect(r.spec.song_count).toBe(12)
    expect(r.spec.bpm_range).toEqual([124, 128])
    expect(r.spec.genres).toContain('tech house')
    expect(r.corrections.length).toBeGreaterThanOrEqual(4)
  })
  it('the guard leaves ranges to the model and does not read "popular" as the genre pop', () => {
    const spec = MixSpec.parse({ target_duration_minutes: 35, song_count: 11, popularity: 'high', genres: ['house'] })
    const g = guardSpec('A 30-40 minute house mix of 10 to 12 popular tracks', spec)
    expect(g.spec.target_duration_minutes).toBe(35)
    expect(g.spec.song_count).toBe(11)
    expect(g.spec.genres).toEqual(['house'])
    expect(heuristicSpec('popular house tracks').genres).toEqual(['house'])
  })
  it('named techniques are binding: "drop swap build into drop" → prefer drop_swap (even if the model drops it)', async () => {
    const p = '5 minute electronic mix with drop swap build into drop, no loop rolls'
    expect(detectTechniques(p)).toEqual({ prefer: ['drop_swap'], avoid: ['loop_roll'] })
    const modelIgnoredIt = valid({ genres: ['electronic'], target_duration_minutes: 5, song_count: null, features: ['drop_sections'] })
    const r = await interpretPrompt([fake('primary-llm', [modelIgnoredIt])], { prompt: p })
    expect(r.spec.techniques).toEqual({ prefer: ['drop_swap'], avoid: ['loop_roll'] })
    expect(r.spec.target_duration_minutes).toBe(5)
    // a named creative technique no longer defaults the style to loop-roll-heavy "energetic"
    expect(resolveSpec(r.spec).transitionStyle).toBe('creative')
    expect(heuristicSpec('build into the drop every time').techniques.prefer).toEqual(['drop_swap'])
  })
  it('era phrases map to year ranges', () => {
    expect(eraYears('90s')).toEqual([1990, 1999])
    expect(eraYears('2010s')).toEqual([2010, 2019])
    expect(eraYears('early 2000s')).toEqual([2000, 2004])
    expect(eraYears(null)).toBeNull()
  })
})
