/**
 * Claims: the platform has no transactions or compare-and-set, but `uniqueOn`
 * is enforced atomically in the RecordRoom DO. Creating a command_receipts row
 * with a given `key` succeeds for exactly one caller — that is our lock.
 * Rows are created WITHOUT a recordId (an explicit id would upsert).
 */
import type { ActionTools } from 'deepspace/worker'
import { C } from '../schemas/names'

export function isDuplicateError(error: string | undefined): boolean {
  return !!error && /duplicate/i.test(error)
}

export async function claim(tools: ActionTools, key: string, ref = '', now = Date.now()): Promise<boolean> {
  const r = await tools.create(C.receipts, { key, ref, createdAt: now })
  if (r.success) return true
  if (isDuplicateError(r.error)) return false
  throw new Error(`claim ${key} failed: ${r.error}`)
}

export async function readClaim(tools: ActionTools, key: string): Promise<{ recordId: string; ref: string } | null> {
  const r = await tools.query<{ key: string; ref?: string }>(C.receipts, { where: { key }, limit: 1 })
  if (!r.success || r.data.records.length === 0) return null
  const row = r.data.records[0]
  return { recordId: row.recordId, ref: String(row.data.ref ?? '') }
}

export async function setClaimRef(tools: ActionTools, key: string, ref: string): Promise<void> {
  const existing = await readClaim(tools, key)
  if (existing) await tools.update(C.receipts, existing.recordId, { ref })
}

export async function release(tools: ActionTools, key: string): Promise<void> {
  await tools.deleteWhere(C.receipts, { key }, 10)
}
