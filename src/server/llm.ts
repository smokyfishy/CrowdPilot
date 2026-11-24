/**
 * LLM clients for prompt interpretation. Primary: Meta Model API ("Muse", OpenAI-compatible Chat
 * Completions, JSON-schema constrained decoding). Backup: Claude through DeepSpace AI (mixgen-routes.ts).
 * The conservative heuristic is the last fallback.
 */
export interface LlmCall {
  name: string
  call: (system: string, prompt: string, schema?: { name: string; schema: Record<string, unknown> }) => Promise<string>
}

export const MUSE_DEFAULT_BASE = 'https://api.meta.ai/v1'
/** Meta's recommended text model; reasoning kept low (interpretation is extraction, not long reasoning). */
export const MUSE_DEFAULT_MODEL = 'muse-spark-1.3'

export function museClient(opts: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number; fetchFn?: typeof fetch }): LlmCall {
  const base = (opts.baseUrl ?? MUSE_DEFAULT_BASE).replace(/\/+$/, '')
  const model = opts.model ?? MUSE_DEFAULT_MODEL
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
