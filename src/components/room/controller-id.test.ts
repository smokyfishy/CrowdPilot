import { describe, expect, it } from 'vitest'
import { acquireControllerId, type LockManagerLike } from './controller-id'

/** In-memory Web Locks with `ifAvailable` semantics, shared by "tabs" in a test. */
function fakeLocks(): LockManagerLike {
  const held = new Set<string>()
  return {
    request(name, _opts, cb) {
      if (held.has(name)) return Promise.resolve(cb(null))
      held.add(name)
      return Promise.resolve(cb({ name })).finally(() => held.delete(name))
    },
  }
}

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), copy: () => new Map(m) }
}

let n = 0
const newId = () => `id-${++n}`

describe('acquireControllerId', () => {
  it('reuses the stored id after a reload when no other tab holds it', async () => {
    const locks = fakeLocks()
    const storage = memoryStorage()
    const first = await acquireControllerId('r1', { storage, locks, newId })
    first.release()
    await Promise.resolve()
    const reloaded = await acquireControllerId('r1', { storage, locks, newId })
    expect(reloaded.id).toBe(first.id)
  })

  it('mints a new id when a duplicated tab finds the copied id still held', async () => {
    const locks = fakeLocks()
    const storage = memoryStorage()
    const original = await acquireControllerId('r1', { storage, locks, newId })
    // Duplicate tab: sessionStorage is copied, the original tab is still alive and holds the lock.
    const duplicate = await acquireControllerId('r1', { storage, locks, newId })
    expect(duplicate.id).not.toBe(original.id)
    original.release()
    duplicate.release()
  })

  it('falls back to a fresh id per tab when Web Locks are unavailable', async () => {
    const storage = memoryStorage()
    const a = await acquireControllerId('r1', { storage, locks: undefined, newId })
    const b = await acquireControllerId('r1', { storage, locks: undefined, newId })
    expect(a.id).not.toBe(b.id)
  })
})
