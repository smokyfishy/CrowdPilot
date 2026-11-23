import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const token = { value: null as string | null }
vi.mock('deepspace', () => ({ getAuthToken: async () => token.value }))

import { apiFetch } from './api'
import { setGuestToken } from './guest-session'

const store = new Map<string, string>()

beforeEach(() => {
  token.value = null
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

const headersOf = (fn: ReturnType<typeof mockFetch>) => new Headers(fn.mock.calls[0][1]?.headers)

describe('apiFetch', () => {
  it('uses the Bearer token when signed in', async () => {
    token.value = 'jwt-123'
    const fn = mockFetch(200, { ok: true, value: { a: 1 } })
    const r = await apiFetch<{ a: number }>('/api/x', { roomId: 'room-1' })
    expect(r).toEqual({ ok: true, value: { a: 1 } })
    expect(headersOf(fn).get('Authorization')).toBe('Bearer jwt-123')
    expect(headersOf(fn).get('X-Guest-Token')).toBeNull()
  })

  it('uses X-Guest-Token for the room when anonymous', async () => {
    setGuestToken('room-1', 'guest-abc')
    const fn = mockFetch(200, { ok: true, value: null })
    await apiFetch('/api/x', { roomId: 'room-1' })
    expect(headersOf(fn).get('X-Guest-Token')).toBe('guest-abc')
    expect(headersOf(fn).get('Authorization')).toBeNull()
  })

  it('maps a 409 DUPLICATE body to a DomainError', async () => {
    mockFetch(409, { ok: false, error: { code: 'DUPLICATE', message: 'Already queued', existingItemId: 'i1' } })
    const r = await apiFetch('/api/x', { method: 'POST', body: {} })
    expect(r).toEqual({ ok: false, error: { code: 'DUPLICATE', message: 'Already queued', existingItemId: 'i1' } })
  })

  it('turns a network failure into UPSTREAM with a retry message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const r = await apiFetch('/api/x', {})
    expect(!r.ok && r.error.code).toBe('UPSTREAM')
    expect(!r.ok && r.error.message).toMatch(/connection/i)
  })

  it('treats a non-JSON error page as UPSTREAM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
    const r = await apiFetch('/api/x', {})
    expect(!r.ok && r.error.code).toBe('UPSTREAM')
  })
})
