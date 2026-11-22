/** Small typed client for /api/mixgen/* and a per-tab registry of running jobs. */
import { getAuthToken } from 'deepspace'
import type { EditOp, MixSpec, ResolvedSpec } from '../spec'
import type { BrowserMixJob, PreparedMix } from './job'

export async function authHeaders(): Promise<Record<string, string>> {
  const t = await getAuthToken().catch(() => null)
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { ...(await authHeaders()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(json.error?.message ?? `Request failed (${res.status})`)
  return json
}

export interface InterpretResult {
  spec: MixSpec
  resolved: ResolvedSpec
  source: 'llm' | 'heuristic'
  editOps: EditOp[]
  warning?: string
}

export const mixApi = {
  interpret: (prompt: string) => post<InterpretResult>('/api/mixgen/interpret', { prompt }),
  refine: (current: MixSpec, edit: string) => post<InterpretResult>('/api/mixgen/interpret', { prompt: '', current, edit }),
  create: (b: { prompt: string; spec: MixSpec; specSource: string; parentId?: string; editPrompt?: string; title?: string }) => post<{ id: string; version: number; rootId: string }>('/api/mixgen/mixes', b),
  remove: async (id: string) => {
    const res = await fetch(`/api/mixgen/mixes/${id}`, { method: 'DELETE', headers: await authHeaders() })
    if (!res.ok) throw new Error(`Delete failed (${res.status})`)
  },
}

export function fileUrl(key: string): string {
  return `/api/files/${key.split('/').map(encodeURIComponent).join('/')}?scope=self`
}

/** Jobs survive in-app navigation (not reloads; a reload resumes from cached analyses). */
export interface LiveJob {
  job: BrowserMixJob
  prepared?: PreparedMix
  running: boolean
  error?: string
  events: Record<string, { done: number; total: number; detail?: string }>
  stage?: string
  localAudioUrl?: string
  listeners: Set<() => void>
  /** Edit instructions carried into a refined version. */
  carry?: { exclude?: string[]; include?: string[]; fixedOrder?: string[] }
}
export const liveJobs = new Map<string, LiveJob>()

export function notify(id: string): void {
  liveJobs.get(id)?.listeners.forEach((f) => f())
}
