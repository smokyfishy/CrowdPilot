/**
 * Typed client for CrowdPilot's worker routes. Identity is attached here:
 * the DeepSpace session JWT when signed in, otherwise the room's guest token.
 */
import { getAuthToken } from 'deepspace'
import { fail, ok } from '../domain/types'
import type { Actor, DomainError, Result } from '../domain/types'
import type { CatalogTrack } from '../providers/catalog/types'
import type { RoomCommand } from '../server/commands'
import { getGuestToken } from './guest-session'

export interface ApiInit {
  method?: string
  body?: unknown
  roomId?: string
  signal?: AbortSignal
}

const OFFLINE: DomainError = {
  code: 'UPSTREAM',
  message: "Can't reach CrowdPilot. Check your connection and try again.",
}

export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<Result<T>> {
  const headers = new Headers({ Accept: 'application/json' })
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  let token: string | null = null
  try {
    token = await getAuthToken()
  } catch {
    token = null
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)
  else if (init.roomId) {
    const guest = getGuestToken(init.roomId)
    if (guest) headers.set('X-Guest-Token', guest)
  }

  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return fail('UPSTREAM', 'Cancelled.')
    return { ok: false, error: OFFLINE }
  }

  type Envelope = { ok?: boolean; value?: T; error?: DomainError }
  let json: Envelope | null
  try {
    json = (await res.json()) as Envelope
  } catch {
    json = null
  }
  if (json?.ok === true) return ok(json.value as T)
  if (json?.error?.code) return { ok: false, error: json.error }
  return fail('UPSTREAM', res.ok ? 'Unexpected response from CrowdPilot.' : `CrowdPilot is having trouble (HTTP ${res.status}). Try again shortly.`)
}

export interface RoomPreview {
  roomId: string
  name: string
  hostName: string
  status: 'open' | 'closed' | 'expired'
  participantCount: number
  guestRequestsEnabled: boolean
  allowAnonymousGuests: boolean
  guestJoinAvailable: boolean
}

export const roomApi = {
  create: (name: string) => apiFetch<{ roomId: string; code: string }>('/api/rooms', { body: { name } }),
  byCode: (code: string) => apiFetch<{ roomId: string }>(`/api/rooms/by-code/${encodeURIComponent(code.trim().toUpperCase())}`),
  preview: (roomId: string) => apiFetch<RoomPreview>(`/api/rooms/${roomId}/preview`),
  join: (roomId: string, displayName: string) =>
    apiFetch<{ memberId: string; guestToken?: string }>(`/api/rooms/${roomId}/join`, { body: { displayName }, roomId }),
  me: (roomId: string) => apiFetch<Actor>(`/api/rooms/${roomId}/me`, { roomId }),
  command: (roomId: string, cmd: RoomCommand) =>
    apiFetch<{ serverNow: number; itemId?: string }>(`/api/rooms/${roomId}/commands`, { body: cmd, roomId }),
  search: (roomId: string, q: string, signal?: AbortSignal) =>
    apiFetch<CatalogTrack[]>(`/api/catalog/search?roomId=${roomId}&q=${encodeURIComponent(q)}`, { roomId, signal }),
  time: () => fetch('/api/time').then((r) => r.json() as Promise<{ serverNow: number }>),
}
