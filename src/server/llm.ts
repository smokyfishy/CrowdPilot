/**
 * LLM client shape for prompt interpretation. The interpreter is Claude (through DeepSpace AI, see
 * mixgen-routes.ts); the conservative heuristic is the fallback when it fails.
 */
export interface LlmCall {
  name: string
  call: (system: string, prompt: string, schema?: { name: string; schema: Record<string, unknown> }) => Promise<string>
}
