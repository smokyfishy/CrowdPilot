import { describe, expect, it } from 'vitest'
import { httpStatusFor, parseCommand } from './http'

describe('httpStatusFor', () => {
  it('maps domain error codes to HTTP statuses', () => {
    expect(httpStatusFor('UNAUTHENTICATED')).toBe(401)
    expect(httpStatusFor('FORBIDDEN')).toBe(403)
    expect(httpStatusFor('KICKED')).toBe(403)
    expect(httpStatusFor('NOT_CONTROLLER')).toBe(403)
    expect(httpStatusFor('NOT_FOUND')).toBe(404)
    expect(httpStatusFor('DUPLICATE')).toBe(409)
    expect(httpStatusFor('STALE_REVISION')).toBe(409)
    expect(httpStatusFor('ROOM_CLOSED')).toBe(410)
    expect(httpStatusFor('RATE_LIMITED')).toBe(429)
    expect(httpStatusFor('PROVIDER_NOT_CONFIGURED')).toBe(503)
    expect(httpStatusFor('QUOTA')).toBe(503)
    expect(httpStatusFor('UPSTREAM')).toBe(502)
    expect(httpStatusFor('INVALID')).toBe(400)
  })
})

describe('parseCommand', () => {
  it('accepts a valid enqueue command', () => {
    const r = parseCommand({ type: 'enqueue', idempotencyKey: 'k', track: { trackKey: 'youtube:abc', title: 'Song' } })
    expect(r.ok).toBe(true)
  })

  it('rejects unknown command types and extra privileged fields', () => {
    expect(parseCommand({ type: 'becomeHost' }).ok).toBe(false)
    const r = parseCommand({ type: 'vote', itemId: 'x', memberId: 'someone-else' })
    expect(r.ok && 'memberId' in r.value).toBe(false)
  })

  it('rejects oversized strings and wrong types', () => {
    expect(parseCommand({ type: 'react', emoji: 'x'.repeat(50) }).ok).toBe(false)
    expect(parseCommand({ type: 'reorder', itemId: 'a', beforeId: null, afterId: null, expectedQueueRevision: 'one' }).ok).toBe(false)
    expect(parseCommand(null).ok).toBe(false)
  })
})
