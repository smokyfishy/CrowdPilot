import { describe, expect, it } from 'vitest'
import { signGuestToken, verifyGuestToken } from './guest-token'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = 1_700_000_000_000

describe('guest tokens', () => {
  it('round-trips roomId and memberId', async () => {
    const t = await signGuestToken(SECRET, { roomId: 'r1', memberId: 'm1', exp: NOW + 1000 })
    expect(await verifyGuestToken(SECRET, t, NOW)).toEqual({ roomId: 'r1', memberId: 'm1' })
  })

  it('rejects a tampered payload', async () => {
    const t = await signGuestToken(SECRET, { roomId: 'r1', memberId: 'm1', exp: NOW + 1000 })
    const [, sig] = t.split('.')
    const forged = `${btoa(JSON.stringify({ roomId: 'r1', memberId: 'host', exp: NOW + 1000 })).replace(/=+$/, '')}.${sig}`
    expect(await verifyGuestToken(SECRET, forged, NOW)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const t = await signGuestToken(SECRET, { roomId: 'r1', memberId: 'm1', exp: NOW - 1 })
    expect(await verifyGuestToken(SECRET, t, NOW)).toBeNull()
  })

  it('rejects a token signed with another secret and garbage input', async () => {
    const t = await signGuestToken('other-secret', { roomId: 'r1', memberId: 'm1', exp: NOW + 1000 })
    expect(await verifyGuestToken(SECRET, t, NOW)).toBeNull()
    expect(await verifyGuestToken(SECRET, 'not-a-token', NOW)).toBeNull()
  })
})
