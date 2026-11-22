import type { CollectionSchema } from 'deepspace/schema'
import { num, readOnly, text } from './columns'
import { C } from './names'

/**
 * Claim rows. Creating a row with an existing `key` fails (uniqueOn), which is
 * the only atomic compare-and-set the platform offers; the command layer uses
 * it to serialize revisioned operations and idempotency keys. Never client-readable.
 */
export const commandReceiptsSchema: CollectionSchema = {
  name: C.receipts,
  columns: [text('key', { required: true, immutable: true, maxLength: 200 }), text('ref'), num('createdAt')],
  uniqueOn: ['key'],
  permissions: readOnly(false),
}
