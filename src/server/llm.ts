/**
 * LLM clients for prompt interpretation. Primary: an open-weight model on a free OpenAI-compatible
 * endpoint — gpt-oss-120b (Apache-2.0) on Groq's free tier, JSON-schema output. Backup: Claude through
 * DeepSpace AI (mixgen-routes.ts). The conservative heuristic is the last fallback.
 */
export interface LlmCall {
  name: string
  call: (system: string, prompt: string, schema?: { name: string; schema: Record<string, unknown> }) => Promise<string>
}

export const OPEN_LLM_DEFAULT_BASE = 'https://api.groq.com/openai/v1'
/** Open-weight (Apache-2.0); reasoning kept low (interpretation is extraction, not long reasoning). */
export const OPEN_LLM_DEFAULT_MODEL = 'openai/gpt-oss-120b'

export function openLlmClient(opts: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number; fetchFn?: typeof fetch }): LlmCall {
  const base = (opts.baseUrl ?? OPEN_LLM_DEFAULT_BASE).replace(/\/+$/, '')
  const model = opts.model ?? OPEN_LLM_DEFAULT_MODEL
  const f = opts.fetchFn ?? fetch
  return {
    name: model,
    async call(system, prompt, schema) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45_000)
      try {
        const r = await f(`${base}/chat/completions`, {
          method: 'POST',
          signal: ctl.signal,
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            reasoning_effort: 'low',
            // reasoning tokens count against this cap
            max_completion_tokens: 8192,
            ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema } } } : {}),
          }),
        })
        if (!r.ok) {
          const e = ((await r.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null)?.error
          throw new Error(`HTTP ${r.status}${e?.code ? ` ${e.code}` : ''}${e?.message ? `: ${e.message.slice(0, 160)}` : ''}`)
        }
        const j = (await r.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }> }
        const c = j.choices?.[0]
        const text = c?.message?.content
        if (!text) throw new Error(`no content (finish_reason ${c?.finish_reason ?? 'unknown'})`)
        return text
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
