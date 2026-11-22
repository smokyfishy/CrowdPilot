/**
 * In-memory ActionTools for unit tests only. Mirrors the RecordRoom semantics
 * the command layer relies on:
 *  - `create` without recordId mints one; with recordId it upserts (merge).
 *  - every write enforces the collection's `uniqueOn` atomically and fails
 *    with "Duplicate: ..." like the real Durable Object.
 *  - each call yields to the event loop first, so Promise.all interleaves
 *    concurrent commands at every await, like concurrent worker requests.
 */
import type { ActionResult, ActionTools } from 'deepspace/worker'
import { schemas } from '../../schemas'

type Row = { recordId: string; data: Record<string, unknown>; createdBy: string; createdAt: string; updatedAt: string }

const uniqueOnByCollection = new Map(schemas.map((s) => [s.name, s.uniqueOn ?? null]))

export interface MemoryTools extends ActionTools {
  dump(collection: string): Row[]
}

export function createMemoryTools(actingUserId = 'system'): MemoryTools {
  const store = new Map<string, Map<string, Row>>()
  let counter = 0
  const tick = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve()
  }
  const table = (c: string) => {
    if (!uniqueOnByCollection.has(c)) throw new Error(`Schema not registered for collection: ${c}`)
    let t = store.get(c)
    if (!t) store.set(c, (t = new Map()))
    return t
  }
  const violatesUnique = (c: string, recordId: string, data: Record<string, unknown>) => {
    const keys = uniqueOnByCollection.get(c)
    if (!keys) return false
    for (const row of table(c).values()) {
      if (row.recordId === recordId) continue
      if (keys.every((k) => row.data[k] === data[k])) return true
    }
    return false
  }
  const dup = (c: string): ActionResult<never> => ({
    success: false,
    error: `Duplicate: a record with these values already exists in ${c}`,
  })

  const tools: MemoryTools = {
    async create(collection, data, recordId) {
      await tick()
      const t = table(collection)
      const id = recordId ?? `rec_${++counter}`
      const existing = t.get(id)
      const merged = { ...(existing?.data ?? {}), ...data }
      if (violatesUnique(collection, id, merged)) return dup(collection)
      const now = new Date().toISOString()
      t.set(id, { recordId: id, data: merged, createdBy: existing?.createdBy ?? actingUserId, createdAt: existing?.createdAt ?? now, updatedAt: now })
      return { success: true, data: { recordId: id } }
    },
    async update(collection, recordId, data) {
      await tick()
      const t = table(collection)
      const existing = t.get(recordId)
      if (!existing) return { success: false, error: `Record not found: ${recordId}` }
      const merged = { ...existing.data, ...data }
      if (violatesUnique(collection, recordId, merged)) return dup(collection)
      t.set(recordId, { ...existing, data: merged, updatedAt: new Date().toISOString() })
      return { success: true, data: { recordId } }
    },
    async remove(collection, recordId) {
      await tick()
      table(collection).delete(recordId)
      return { success: true, data: { recordId } }
    },
    async deleteWhere(collection, where, limit = 100) {
      await tick()
      const t = table(collection)
      let deleted = 0
      for (const row of [...t.values()]) {
        if (deleted >= limit) break
        if (Object.entries(where).every(([k, v]) => (k === 'recordId' ? row.recordId : row.data[k]) === v)) {
          t.delete(row.recordId)
          deleted++
        }
      }
      return { success: true, data: { deleted } }
    },
    async get(collection, recordId) {
      await tick()
      const row = table(collection).get(recordId)
      if (!row) return { success: false, error: 'Record not found', code: 'RECORD_NOT_FOUND' }
      return { success: true, data: { record: structuredClone(row) } } as never
    },
    async query(collection, options = {}) {
      await tick()
      let rows = [...table(collection).values()]
      if (options.where) {
        rows = rows.filter((r) =>
          Object.entries(options.where ?? {}).every(([k, v]) => (k === 'recordId' ? r.recordId : r.data[k]) === v),
        )
      }
      if (options.orderBy) {
        const key = options.orderBy
        const dir = options.orderDir === 'desc' ? -1 : 1
        rows.sort((a, b) => {
          const av = a.data[key] as number | string
          const bv = b.data[key] as number | string
          return av === bv ? 0 : av > bv ? dir : -dir
        })
      }
      const limited = rows.slice(0, options.limit ?? 50)
      return { success: true, data: { records: structuredClone(limited), count: limited.length } } as never
    },
    async integration() {
      return { success: false, error: 'integrations unavailable in memory tools' }
    },
    async registerUser() {
      return { success: false, error: 'registerUser unavailable in memory tools' }
    },
    dump(collection) {
      return [...table(collection).values()].map((r) => structuredClone(r))
    },
  } as MemoryTools
  return tools
}
