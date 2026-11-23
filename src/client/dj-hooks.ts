/** Live AI DJ records (render inside the room's RecordScope). */
import { useMemo } from 'react'
import { useQuery } from 'deepspace'
import type { AnalysisSummary } from '../dsp/analyze'
import type { DjState } from '../domain/types'
import { toDjState } from '../server/repo'
import { C, STATE_ID } from '../schemas/names'

export interface FeatureRow {
  trackKey: string
  status: 'ready' | 'low_confidence' | 'cannot_mix' | 'failed'
  analyzerVersion: string
  summary: AnalysisSummary | null
  corrections: { bpm?: number; firstBeat?: number; downbeatPhase?: number; note?: string } | null
  failure: string
  analyzedAt: number
}

export function useDjData(): { dj: DjState; features: Map<string, FeatureRow> } {
  const djQ = useQuery<Record<string, unknown>>(C.dj)
  const fQ = useQuery<Record<string, unknown>>(C.features, { orderBy: 'analyzedAt', orderDir: 'desc', limit: 300 })
  return useMemo(() => {
    const row = djQ.records?.find((r) => r.recordId === STATE_ID)
    const features = new Map<string, FeatureRow>()
    for (const r of fQ.records ?? []) {
      const d = r.data
      const key = String(d.trackKey ?? '')
      if (!key || features.has(key)) continue
      features.set(key, {
        trackKey: key,
        status: (d.status as FeatureRow['status']) ?? 'failed',
        analyzerVersion: String(d.analyzerVersion ?? ''),
        summary: d.summary && typeof d.summary === 'object' ? (d.summary as AnalysisSummary) : null,
        corrections: d.corrections && typeof d.corrections === 'object' ? (d.corrections as FeatureRow['corrections']) : null,
        failure: String(d.failure ?? ''),
        analyzedAt: Number(d.analyzedAt ?? 0),
      })
    }
    return { dj: toDjState(row?.data), features }
  }, [djQ.records, fQ.records])
}
