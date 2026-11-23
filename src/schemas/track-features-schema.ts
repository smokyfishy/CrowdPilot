import type { CollectionSchema } from 'deepspace/schema'
import { json, num, readOnly, text } from './columns'
import { C } from './names'

/**
 * Measured analysis summaries per waveform source (recordId derived from trackKey).
 * Only derived features (< 4 KB) are stored — never audio. Written by the host's
 * browser analyzer through the command route; host corrections kept separately.
 */
export const trackFeaturesSchema: CollectionSchema = {
  name: C.features,
  columns: [
    text('trackKey', { required: true, maxLength: 80 }),
    text('status', { interpretation: { kind: 'select', options: ['ready', 'low_confidence', 'cannot_mix', 'failed'] } }),
    text('analyzerVersion', { maxLength: 40 }),
    json('summary'),
    /** Host corrections: { bpm?, firstBeat?, downbeatPhase?, note? }. */
    json('corrections'),
    text('failure', { maxLength: 200 }),
    num('analyzedAt'),
  ],
  uniqueOn: ['trackKey'],
  permissions: readOnly(true),
}
