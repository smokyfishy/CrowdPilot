/**
 * CrowdPilot HTTP routes. All room mutations go through
 * POST /api/rooms/:roomId/commands; clients never write records directly.
 */
import type { Context, Hono } from 'hono'
import type { AppContext, Env } from '../../worker'
import { TokenBucket } from '../domain/rate-limit'
import { sanitizeDisplayName } from '../domain/rules'
import type { DomainError, Result } from '../domain/types'
import { C } from '../schemas/names'
import { identifyCaller, resolveActor, toolsForCaller } from './actor'
import type { ResolveAuth } from './actor'
import { createRoom, executeCommand, joinRoom } from './commands'
import { signGuestToken } from './guest-token'
import { httpStatusFor, parseCommand } from './http'
import { RoomRepo } from './repo'
import { appScope, createRoomTools, isRoomId, roomScope } from './room-tools'
import { createYouTubeProvider } from '../providers/catalog/youtube'
import type { CatalogTrack } from '../providers/catalog/types'

const MAX_BODY = 8 * 1024
const GUEST_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const codeLookups = new TokenBucket(20, 20 / 60_000)
const anonJoins = new TokenBucket(10, 10 / 60_000)
const roomCreates = new TokenBucket(5, 5 / 60_000)
const searches = new TokenBucket(20, 20 / 60_000)
const SEARCH_TTL_MS = 60_000
const searchCache = new Map<string, { at: number; tracks: CatalogTrack[] }>()

function cachedSearch(q: string, now: number): CatalogTrack[] | undefined {
  const hit = searchCache.get(q)
  if (hit && now - hit.at < SEARCH_TTL_MS) return hit.tracks
  if (hit) searchCache.delete(q)
  return undefined
}

function rememberSearch(q: string, tracks: CatalogTrack[], now: number): void {
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value as string)
  searchCache.set(q, { at: now, tracks })
}

function clientIp(c: Context<AppContext>): string {
  return c.req.header('CF-Connecting-IP') ?? 'local'
}

function errorResponse(c: Context<AppContext>, error: DomainError) {
  return c.json({ ok: false, error }, httpStatusFor(error.code) as 400)
}

function respond<T>(c: Context<AppContext>, r: Result<T>) {
  return r.ok ? c.json({ ok: true, value: r.value }) : errorResponse(c, r.error)
}

async function readJson(c: Context<AppContext>): Promise<unknown> {
  const text = await c.req.text()
  if (text.length > MAX_BODY) return Symbol.for('too-large')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return undefined
  }
}

const invalid = (message: string): DomainError => ({ code: 'INVALID', message })

export function registerRoomRoutes(app: Hono<AppContext>, resolveAuth: ResolveAuth): void {
  app.get('/api/time', (c) => c.json({ serverNow: Date.now() }))

  app.get('/api/catalog/search', async (c) => {
    const roomId = c.req.query('roomId') ?? ''
    const q = (c.req.query('q') ?? '').replace(/\s+/g, ' ').trim()
    if (!isRoomId(roomId)) return errorResponse(c, { code: 'NOT_FOUND', message: 'This room does not exist.' })
    if (q.length < 2 || q.length > 100) return errorResponse(c, invalid('Search for 2–100 characters.'))
    const who = await resolveActor(c.env, c.req.raw, roomId, resolveAuth)
    if (!who.ok) return errorResponse(c, who.error)
    const roomState = await new RoomRepo(who.value.tools).roomState()
    if (!roomState || roomState.status !== 'open') return errorResponse(c, { code: 'ROOM_CLOSED', message: 'This room has ended.' })
    const now = Date.now()
    const key = q.toLowerCase()
    const cached = cachedSearch(key, now)
    if (cached) return c.json({ ok: true, value: cached })
    const limited = searches.take(who.value.actor.memberId, now)
    if (!limited.ok) return errorResponse(c, limited.error)
    const r = await createYouTubeProvider(c.env.YOUTUBE_API_KEY).search(q, c.req.raw.signal)
    if (r.ok) rememberSearch(key, r.value, now)
    return respond(c, r)
  })

  app.post('/api/rooms', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return errorResponse(c, { code: 'UNAUTHENTICATED', message: 'Sign in to create a room.' })
    const limited = roomCreates.take(auth.userId, Date.now())
    if (!limited.ok) return errorResponse(c, limited.error)
    const body = (await readJson(c)) as { name?: unknown } | undefined
    if (!body || typeof body !== 'object' || typeof body.name !== 'string') return errorResponse(c, invalid('Give the room a name.'))
    const hostName = auth.claims.name || (auth.claims.email ? String(auth.claims.email).split('@')[0] : 'Host')
    const env = c.env
    const result = await createRoom(
      createRoomTools(env, appScope(env), auth.userId),
      (roomId) => createRoomTools(env, roomScope(roomId), auth.userId),
      { userId: auth.userId, name: hostName },
      { name: body.name },
      Date.now(),
    )
    return respond(c, result)
  })

  app.get('/api/rooms/by-code/:code', async (c) => {
    const limited = codeLookups.take(clientIp(c), Date.now())
    if (!limited.ok) return errorResponse(c, limited.error)
    const code = c.req.param('code').toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(code)) return errorResponse(c, { code: 'NOT_FOUND', message: 'No room uses that code.' })
    const tools = createRoomTools(c.env, appScope(c.env), c.env.OWNER_USER_ID)
    const r = await tools.query(C.rooms, { where: { code }, limit: 1 })
    const row = r.success ? r.data.records[0] : undefined
    if (!row) return errorResponse(c, { code: 'NOT_FOUND', message: 'No room uses that code.' })
    return c.json({ ok: true, value: { roomId: row.recordId } })
  })

  app.get('/api/rooms/:roomId/preview', async (c) => {
    const roomId = c.req.param('roomId')
    if (!isRoomId(roomId)) return errorResponse(c, { code: 'NOT_FOUND', message: 'This room does not exist.' })
    const repo = new RoomRepo(createRoomTools(c.env, roomScope(roomId), c.env.OWNER_USER_ID))
    const room = await repo.roomState()
    if (!room) return errorResponse(c, { code: 'NOT_FOUND', message: 'This room does not exist.' })
    return c.json({
      ok: true,
      value: {
        roomId,
        name: room.name,
        hostName: room.hostName,
        status: room.status,
        participantCount: await repo.countMembers(),
        guestRequestsEnabled: room.guestRequestsEnabled,
        allowAnonymousGuests: room.allowAnonymousGuests,
        guestJoinAvailable: !!c.env.GUEST_TOKEN_SECRET,
      },
    })
  })

  app.post('/api/rooms/:roomId/join', async (c) => {
    const env: Env = c.env
    const roomId = c.req.param('roomId')
    if (!isRoomId(roomId)) return errorResponse(c, { code: 'NOT_FOUND', message: 'This room does not exist.' })
    const body = (await readJson(c)) as { displayName?: unknown } | undefined
    const rawName = body && typeof body === 'object' && typeof body.displayName === 'string' ? body.displayName : ''

    if (c.req.header('Authorization')?.startsWith('Bearer ')) {
      const caller = await identifyCaller(env, c.req.raw, roomId, resolveAuth)
      if (!caller || caller.kind !== 'user') return errorResponse(c, { code: 'UNAUTHENTICATED', message: 'Your session expired — sign in again.' })
      const tools = toolsForCaller(env, roomId, caller)
      const r = await joinRoom(tools, { identityKey: `user:${caller.userId}`, displayName: rawName || caller.name || 'Guest', signedIn: true }, Date.now())
      return respond(c, r)
    }

    if (!env.GUEST_TOKEN_SECRET) {
      return errorResponse(c, { code: 'PROVIDER_NOT_CONFIGURED', message: 'Guest access is not set up yet — sign in to join.' })
    }
    const limited = anonJoins.take(clientIp(c), Date.now())
    if (!limited.ok) return errorResponse(c, limited.error)
    const name = sanitizeDisplayName(rawName)
    if (!name.ok) return errorResponse(c, name.error)
    const tools = createRoomTools(env, roomScope(roomId), env.OWNER_USER_ID)
    const r = await joinRoom(tools, { identityKey: `guest:${crypto.randomUUID()}`, displayName: name.value, signedIn: false }, Date.now())
    if (!r.ok) return errorResponse(c, r.error)
    const guestToken = await signGuestToken(env.GUEST_TOKEN_SECRET, {
      roomId,
      memberId: r.value.memberId,
      exp: Date.now() + GUEST_TOKEN_TTL_MS,
    })
    return c.json({ ok: true, value: { memberId: r.value.memberId, guestToken } })
  })

  app.get('/api/rooms/:roomId/me', async (c) => {
    const roomId = c.req.param('roomId')
    if (!isRoomId(roomId)) return errorResponse(c, { code: 'NOT_FOUND', message: 'This room does not exist.' })
    const r = await resolveActor(c.env, c.req.raw, roomId, resolveAuth)
    return respond(c, r.ok ? { ok: true as const, value: r.value.actor } : r)
  })

  app.post('/api/rooms/:roomId/commands', async (c) => {
    const roomId = c.req.param('roomId')
    if (!isRoomId(roomId)) return errorResponse(c, { code: 'NOT_FOUND', message: 'This room does not exist.' })
    const body = await readJson(c)
    const cmd = parseCommand(body)
    if (!cmd.ok) return errorResponse(c, cmd.error)
    const who = await resolveActor(c.env, c.req.raw, roomId, resolveAuth)
    if (!who.ok) return errorResponse(c, who.error)
    const appTools = createRoomTools(c.env, appScope(c.env), c.env.OWNER_USER_ID)
    const provider = createYouTubeProvider(c.env.YOUTUBE_API_KEY)
    // Enqueue never trusts client metadata: resolve the video id server-side (1 quota unit).
    const resolveTrack = async (trackKey: string) => {
      const r = await provider.resolve(trackKey.replace(/^youtube:/, ''))
      return r.ok ? { ok: true as const, value: r.value } : r
    }
    const r = await executeCommand(who.value.tools, who.value.actor, cmd.value, Date.now(), { appTools, resolveTrack })
    return respond(c, r)
  })
}
