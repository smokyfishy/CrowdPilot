/**
 * Caller resolution for room routes. Identity comes ONLY from a verified
 * DeepSpace JWT (Authorization: Bearer) or an HMAC-signed guest token
 * (X-Guest-Token) bound to this room. Never from request bodies.
 */
import type { ActionTools, VerifyResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { fail, ok } from '../domain/types'
import type { Actor, Result } from '../domain/types'
import { loadActor } from './commands'
import { verifyGuestToken } from './guest-token'
import { RoomRepo } from './repo'
import { createRoomTools, roomScope } from './room-tools'

export type ResolveAuth = (req: Request, env: Env) => Promise<VerifyResult | null>

export interface Caller {
  kind: 'user' | 'guest'
  userId?: string
  memberId?: string
  name?: string
}

/** Who is calling, before room membership is considered. */
export async function identifyCaller(env: Env, req: Request, roomId: string, resolveAuth: ResolveAuth): Promise<Caller | null> {
  if (req.headers.get('Authorization')?.startsWith('Bearer ')) {
    const auth = await resolveAuth(req, env)
    if (!auth) return null
    const name = auth.claims.name || (auth.claims.email ? String(auth.claims.email).split('@')[0] : undefined)
    return { kind: 'user', userId: auth.userId, name }
  }
  const token = req.headers.get('X-Guest-Token')
  if (token && env.GUEST_TOKEN_SECRET) {
    const verified = await verifyGuestToken(env.GUEST_TOKEN_SECRET, token, Date.now())
    if (verified && verified.roomId === roomId) return { kind: 'guest', memberId: verified.memberId }
  }
  return null
}

export function toolsForCaller(env: Env, roomId: string, caller: Caller): ActionTools {
  return createRoomTools(env, roomScope(roomId), caller.userId ?? env.OWNER_USER_ID)
}

export async function resolveActor(
  env: Env,
  req: Request,
  roomId: string,
  resolveAuth: ResolveAuth,
): Promise<Result<{ actor: Actor; tools: ActionTools }>> {
  const caller = await identifyCaller(env, req, roomId, resolveAuth)
  if (!caller) return fail('UNAUTHENTICATED', 'Sign in or join the room first.')
  const tools = toolsForCaller(env, roomId, caller)
  let memberId = caller.memberId
  if (caller.kind === 'user') {
    const member = await new RoomRepo(tools).memberByIdentity(`user:${caller.userId}`)
    if (!member) return fail('UNAUTHENTICATED', 'Join the room first.')
    memberId = member.id
  }
  const actor = await loadActor(tools, memberId as string)
  if (!actor.ok) return actor
  return ok({ actor: actor.value, tools })
}
