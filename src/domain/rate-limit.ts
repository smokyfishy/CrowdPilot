import { fail, okVoid } from './types'
import type { Result } from './types'

const MAX_KEYS = 5_000

/** Token bucket keyed by caller. Clock injected so it is deterministic in tests. */
export class TokenBucket {
  private readonly state = new Map<string, { tokens: number; at: number }>()

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {}

  take(key: string, now: number): Result<void> {
    const prev = this.state.get(key) ?? { tokens: this.capacity, at: now }
    const tokens = Math.min(this.capacity, prev.tokens + Math.max(0, now - prev.at) * this.refillPerMs)
    if (tokens < 1) {
      this.state.set(key, { tokens, at: now })
      return fail('RATE_LIMITED', 'Slow down a little and try again.', {
        retryAfterMs: Math.ceil((1 - tokens) / this.refillPerMs),
      })
    }
    if (this.state.size >= MAX_KEYS && !this.state.has(key)) {
      const oldest = this.state.keys().next().value
      if (oldest !== undefined) this.state.delete(oldest)
    }
    this.state.set(key, { tokens: tokens - 1, at: now })
    return okVoid
  }
}
