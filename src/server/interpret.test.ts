import { describe, expect, it } from 'vitest'
import { interpretPrompt } from './mixgen-routes'
import { geminiClient, type LlmCall } from './llm'
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

describe('prompt interpretation chain (Gemini → Claude → heuristic)', () => {
  const prompt = 'A 45-minute tech house mix with 12 tracks'
  it('uses Gemini when it returns a valid spec, and records the model', async () => {
    const g = fake('gemini-3.8-flash', [valid()])
    const c = fake('claude-sonnet-5-5', [valid()])
    const r = await interpretPrompt([g, c], { prompt })
    expect(r.source).toBe('llm')
    expect(r.model).toBe('gemini-3.8-flash')
    expect(r.spec.interpretation?.model).toBe('gemini-3.8-flash')
    expect(c.calls).toBe(0)
  })
  it('falls back to Claude when Gemini fails, then to the heuristic when both fail', async () => {
    const r1 = await interpretPrompt([fake('gemini-3.8-flash', [new Error('HTTP 429')]), fake('claude-sonnet-5-5', [valid()])], { prompt })
    expect(r1.model).toBe('claude-sonnet-5-5')
    expect(r1.attempts.join()).toMatch(/gemini-3.8-flash: HTTP 429/)
    const r2 = await interpretPrompt([fake('gemini-3.8-flash', [new Error('down')]), fake('claude-sonnet-5-5', ['not json'])], { prompt })
    expect(r2.source).toBe('heuristic')
    expect(r2.spec.target_duration_minutes).toBe(45)
  })
  it('repairs an invalid reply once with the validation errors', async () => {
    const g = fake('gemini-3.8-flash', [JSON.stringify({ song_count: 500 }), valid()])
    const r = await interpretPrompt([g], { prompt })
    expect(r.model).toBe('gemini-3.8-flash')
    expect(g.calls).toBe(2)
  })
  it('the guard enforces stated numbers and genres the model got wrong', async () => {
    const wrong = valid({ target_duration_minutes: 30, song_count: 8, genres: [] })
    const r = await interpretPrompt([fake('gemini-3.8-flash', [wrong])], { prompt: 'Make a 45-minute tech house mix with 12 tracks at 124-128 bpm' })
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
    const r = await interpretPrompt([fake('gemini-3.8-flash', [modelIgnoredIt])], { prompt: p })
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

describe('Gemini client (OpenAI-compatible API)', () => {
  it('sends structured-output requests with a generous token cap and low reasoning effort', async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string } | null = null
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const g = geminiClient({ apiKey: 'k', fetchFn })
    const out = await g.call('sys', 'prompt', { name: 'mix_spec', schema: { type: 'object' } })
    expect(out).toBe('{"ok":true}')
    expect(seen!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(seen!.auth).toBe('Bearer k')
    expect(seen!.body.model).toBe('gemini-3.8-flash')
    expect(seen!.body.max_tokens).toBe(8192)
    expect(seen!.body.reasoning_effort).toBe('low')
    expect((seen!.body.response_format as { type: string }).type).toBe('json_schema')
    const local = geminiClient({ apiKey: 'freellmapi-x', baseUrl: 'http://localhost:3001/v1/', fetchFn })
    await local.call('s', 'p')
    expect(seen!.url).toBe('http://localhost:3001/v1/chat/completions')
  })
  it('reports an empty reply (e.g. thinking used up the token cap) as an error', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 })) as unknown as typeof fetch
    await expect(geminiClient({ apiKey: 'k', fetchFn }).call('s', 'p')).rejects.toThrow(/no content \(finish_reason length\)/)
  })
})
