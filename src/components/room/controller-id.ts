/**
 * Per-tab controller identity. The id lives in sessionStorage so a reload keeps
 * the lease, but browsers copy sessionStorage into duplicated tabs — so each id is
 * also guarded by a Web Lock that only one live tab can hold. A tab that finds its
 * copied id already held mints a fresh one, so two tabs can never both be "the player".
 */

export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown | null) => Promise<void> | void): Promise<unknown>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface Deps {
  storage: StorageLike | undefined
  locks: LockManagerLike | undefined
  newId: () => string
}

/** Try to hold `name` until released. Resolves to a release function, or null if another tab holds it. */
function tryHold(locks: LockManagerLike, name: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null)
        return
      }
      return new Promise<void>((release) => resolve(() => release()))
    })
  })
}

export async function acquireControllerId(roomId: string, deps: Deps): Promise<{ id: string; release: () => void }> {
  const key = `crowdpilot:controller:${roomId}`
  const save = (id: string) => {
    try {
      deps.storage?.setItem(key, id)
    } catch {
      // storage blocked: id lives for this page only
    }
  }
  if (!deps.locks) return { id: deps.newId(), release: () => {} }

  let stored: string | null = null
  try {
    stored = deps.storage?.getItem(key) ?? null
  } catch {
    stored = null
  }
  if (stored) {
    const release = await tryHold(deps.locks, `crowdpilot-controller-${stored}`)
    if (release) return { id: stored, release }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = deps.newId()
    const release = await tryHold(deps.locks, `crowdpilot-controller-${fresh}`)
    if (release) {
      save(fresh)
      return { id: fresh, release }
    }
  }
  return { id: deps.newId(), release: () => {} }
}
