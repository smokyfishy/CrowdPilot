/**
 * LLM clients for prompt interpretation.
 *
 * Primary: Gemini 3.8 Flash over the OpenAI-compatible Chat Completions API.
 *   - production: Google AI Studio directly (GEMINI_BASE_URL defaults to Google's endpoint), key in
 *     the GEMINI_API_KEY secret;
 *   - local: a self-hosted FreeLLMAPI router (GEMINI_BASE_URL=http://localhost:3001/v1,
 *     GEMINI_API_KEY=freellmapi-…) — the live site cannot reach a router on someone's machine.
 * Backup: Claude through DeepSpace AI (existing). Last resort: the deterministic heuristic.
 *
 * Gemini Flash spends hidden "thinking" tokens inside max_tokens, so the output cap is generous and
 * reasoning effort is set low; the reply must be JSON matching the MixSpec schema (structured output).
 */
export interface LlmCall {
  name: string
  call: (system: string, prompt: string, schema?: { name: string; schema: Record<string, unknown> }) => Promise<string>
}

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash'

export function geminiClient(opts: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number; fetchFn?: typeof fetch }): LlmCall {
  const base = (opts.baseUrl || GEMINI_DEFAULT_BASE).replace(/\/+$/, '')
  const model = opts.model || GEMINI_DEFAULT_MODEL
  const f = opts.fetchFn ?? fetch
  return {
    name: model,
    async call(system, prompt, schema) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45_000)
      try {
        const body: Record<string, unknown> = {
          model,
          temperature: 0,
          max_tokens: 8192, // thinking tokens count against this cap — never tiny
          reasoning_effort: 'low',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: false } } } : { response_format: { type: 'json_object' } }),
        }
        const r = await f(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        })
        if (!r.ok) throw new Error(`${model} HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
        const j = (await r.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }> }
        const c = j.choices?.[0]
        const text = c?.message?.content ?? ''
        if (!text.trim()) throw new Error(`${model} returned no content (finish_reason ${c?.finish_reason ?? 'unknown'})`)
        return text
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
