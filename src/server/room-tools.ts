/**
 * Record tools for an arbitrary RecordRoom scope. Same wire contract as the
 * scaffold's createActionTools (src/server/action-routes.ts): a worker-internal
 * fetch to the DO with `X-App-Action: true`, which turns per-record RBAC OFF.
 * Callers MUST authorize before using these tools — see src/server/commands.ts.
 */
import type { ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isRoomId(id: string): boolean {
  return ROOM_ID.test(id)
}

export function roomScope(roomId: string): string {
  return `room:${roomId}`
}

export function appScope(env: Env): string {
  return `app:${env.DEEPSPACE_APP_ID}`
}

export function createRoomTools(env: Env, scopeId: string, actingUserId: string): ActionTools {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(scopeId))

  async function execTool<TData>(tool: string, params: Record<string, unknown>): Promise<ActionResult<TData>> {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': actingUserId, 'X-App-Action': 'true' },
        body: JSON.stringify({ tool, params }),
      }),
    )
    return res.json() as Promise<ActionResult<TData>>
  }

  return {
    create: (collection, data, recordId) => execTool('records.create', { collection, data, recordId }),
    update: (collection, recordId, data) => execTool('records.update', { collection, recordId, data }),
    remove: (collection, recordId) => execTool('records.delete', { collection, recordId }),
    deleteWhere: (collection, where, limit) => execTool('records.deleteWhere', { collection, where, limit }),
    get: (collection, recordId) => execTool('records.get', { collection, recordId }),
    query: (collection, options) => execTool('records.query', { collection, ...options }),
    integration: async () => ({ success: false, error: 'Integrations are not used by room tools.' }),
    registerUser: (options) => execTool('users.register', { ...options }),
  }
}
