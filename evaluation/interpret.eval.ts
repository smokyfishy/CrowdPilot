/**
 * Request-interpretation accuracy: real LLM calls on a fixed set of varied mix requests with expected
 * fields. Compares
 *   claude+guard   Claude, new interpreter prompt + repair + deterministic guard
 *   claude-old     Claude with the previous interpreter prompt (no guard)
 *   heuristic      the rule-based fallback
 * Scoring: each expected field is right or wrong (numbers within tolerance, lists by case-insensitive
 * containment). Reports per-system accuracy and every miss.
 *
 *   ANTHROPIC_API_KEY=… npx vitest run -c vitest.eval.config.ts evaluation/interpret.eval.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { interpretPrompt } from '../src/server/mixgen-routes'
import { OPEN_LLM_SECOND_MODEL, openLlmClient, type LlmCall } from '../src/server/llm'
import { extractJson, heuristicSpec, MixSpec, parseSpec } from '../src/mixgen/spec'

import { CASES, score } from './interpret-cases'
/** The interpreter prompt before this change (for the comparison). */
const OLD_SYSTEM = `You convert a DJ-mix request into a JSON object. Output ONLY JSON, no prose.
Schema (all keys required; use null or [] when the user did not say it — NEVER invent constraints):
{ "title": string|null, "genres": string[], "artists": string[], "artist_matching": "only_these"|"similar_artists_allowed"|"any"|null,
 "songs": [{"artist": string|null, "title": string, "version": string|null}], "excluded_artists": string[], "excluded_songs": string[],
 "popularity": "high"|"mixed"|"underground"|null, "song_count": integer|null, "target_duration_minutes": number|null, "bpm_range": [min,max]|null,
 "energy_curve": "constant_high"|"gradual_build"|"gradual_build_to_peak"|"multiple_peaks"|"chill_to_energetic"|"festival_climax"|"groovy_then_harder"|"high_then_relaxed"|"steady"|null,
 "intensity": number 0..1|null, "moods": string[], "era": string|null, "vocals": "vocal"|"instrumental"|"mixed"|null,
 "transition_style": "smooth"|"smooth_creative"|"creative"|"energetic"|"minimal"|null,
 "features": ("big_drops"|"festival_closer"|"strong_basslines"|"breakdowns"|"long_blends"|"scratching"|"filter_fx"|"echo_fx")[],
 "allow_reordering": boolean|null, "allow_song_substitutions": boolean|null, "explicit": string[], "summary": string }`

it('request interpretation accuracy (real LLM)', async () => {
  const key = process.env.ANTHROPIC_API_KEY ?? ''
  if (!key && !process.env.GROQ_API_KEY) throw new Error('set GROQ_API_KEY (free open-weight interpreter) or ANTHROPIC_API_KEY')
  const model = process.env.MIXGEN_MODEL ?? 'claude-sonnet-5-5'
  const g: LlmCall = {
    name: model,
    async call(system, prompt) {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 2500, system, messages: [{ role: 'user', content: prompt }] }) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { content?: Array<{ type: string; text?: string }> }
      return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    },
  }
  let llmFallbacks = 0
  const only = process.env.INTERP_SYSTEMS?.split(',')
  const open = process.env.GROQ_API_KEY ? openLlmClient({ apiKey: process.env.GROQ_API_KEY, baseUrl: process.env.OPEN_LLM_BASE_URL, model: process.env.OPEN_LLM_MODEL }) : null
  const systems: Record<string, (p: string) => Promise<MixSpec>> = !key && open ? {
    'open+guard': async (p) => {
      // production chain: gpt-oss-120b, then gpt-oss-20b (separate free quota)
      const r = await interpretPrompt([open, openLlmClient({ apiKey: process.env.GROQ_API_KEY!, model: OPEN_LLM_SECOND_MODEL })], { prompt: p })
      if (r.source !== 'llm') llmFallbacks++
      return r.spec
    },
    'open-old': async (p) => parseSpec(extractJson(await open.call(OLD_SYSTEM, p))),
    heuristic: async (p) => heuristicSpec(p),
  } : {
    'claude+guard': async (p) => (await interpretPrompt([g], { prompt: p })).spec,
    'claude-old': async (p) => parseSpec(extractJson(await g.call(OLD_SYSTEM, p))),
    heuristic: async (p) => heuristicSpec(p),
  }
  const report: Record<string, { ok: number; total: number; failures: number; misses: string[] }> = {}
  for (const [name, run] of Object.entries(systems).filter(([n]) => !only || only.includes(n))) {
    const r = { ok: 0, total: 0, failures: 0, misses: [] as string[] }
    for (const c of CASES) {
      try {
        const spec = await run(c.prompt)
        const s = score(spec, c.exp)
        r.ok += s.ok
        r.total += s.total
        r.misses.push(...s.misses.map((m) => `"${c.prompt.slice(0, 50)}…" ${m}`))
      } catch (e) {
        r.failures++
        r.total += Object.keys(c.exp).length
        r.misses.push(`"${c.prompt.slice(0, 50)}…" FAILED: ${(e as Error).message.slice(0, 100)}`)
      }
      await new Promise((res) => setTimeout(res, name === 'heuristic' ? 0 : Number(process.env.INTERP_PACE_MS ?? 400))) // stay under free-tier rate limits
    }
    report[name] = r
    process.stderr.write(`INTERPRET ${name}: ${r.ok}/${r.total} fields correct (${Math.round((100 * r.ok) / Math.max(1, r.total))}%), ${r.failures} failed calls\n`)
  }
  mkdirSync('C:/crowdpilot-data/eval', { recursive: true })
  writeFileSync('C:/crowdpilot-data/eval/interpret-accuracy.json', JSON.stringify({ model: g.name, cases: CASES.length, report }, null, 1))
  for (const [name, r] of Object.entries(report)) for (const m of r.misses.slice(0, 40)) process.stderr.write(`  [${name}] ${m}\n`)
}, 900_000)
