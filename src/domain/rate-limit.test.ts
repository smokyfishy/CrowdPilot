import { describe, expect, it } from 'vitest'
import { TokenBucket } from './rate-limit'

describe('TokenBucket', () => {
  it('allows capacity then RATE_LIMITED with retryAfterMs > 0', () => {
    const bucket = new TokenBucket(5, 5 / 60_000)
    for (let i = 0; i < 5; i++) expect(bucket.take('m1', 0).ok).toBe(true)
    const r = bucket.take('m1', 0)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('RATE_LIMITED')
      expect(r.error.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('refills over time', () => {
    const bucket = new TokenBucket(5, 5 / 60_000)
    for (let i = 0; i < 5; i++) bucket.take('m1', 0)
    expect(bucket.take('m1', 1_000).ok).toBe(false)
    expect(bucket.take('m1', 12_000).ok).toBe(true)
  })

  it('tracks keys independently', () => {
    const bucket = new TokenBucket(1, 1 / 2_000)
    expect(bucket.take('a', 0).ok).toBe(true)
    expect(bucket.take('b', 0).ok).toBe(true)
    expect(bucket.take('a', 0).ok).toBe(false)
  })
})
