import type { CollectionSchema } from 'deepspace/schema'
import { bool, json, num, readOnly, text } from './columns'
import { C } from './names'

/**
 * Singleton (recordId 'state') per room: AI DJ settings and the current
 * proposed/committed transition. Written only by the host's command route.
 */
export const djStateSchema: CollectionSchema = {
  name: C.dj,
  columns: [
    bool('autopilot', { default: false }),
    /** AI queue reordering of unlocked requests; OFF by default (host decision). */
    bool('aiReorder', { default: false }),
    /** Maximum tempo deviation in percent (0–6). */
    num('maxTempoPct', { default: 6 }),
    text('style', { interpretation: { kind: 'select', options: ['balanced', 'smooth', 'energetic', 'creative'] } }),
    /** Allow live mixing of Audius uploads whose basis is the OML streaming grant (rights under review). */
    bool('allowOmlMixing', { default: true }),
    text('status', {
      interpretation: { kind: 'select', options: ['idle', 'analyzing', 'ready', 'proposed', 'committed', 'mixing', 'safe_fallback', 'failed'] },
    }),
    text('statusNote', { maxLength: 200 }),
    /** Compact transition summary (from/to item ids, style, cues, overlap, tempo ratio, costs, risks). */
    json('transition'),
    num('planRevision', { default: 0 }),
    /** playbackRevision the transition was planned against (stale plans are rejected). */
    num('basedOnPlaybackRevision'),
    num('updatedAt'),
  ],
  permissions: readOnly(true),
}
